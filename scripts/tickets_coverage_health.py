#!/usr/bin/env python3
"""Check public-safe catalog coverage and fail Actions on actionable outages.

The scheduled workflow's normal failure notifications reach repository owners;
this worker never sends customer mail or includes watch/search-owner data.
Missing additive RPCs are reported as not deployed rather than bad coverage.
"""
import json
import os
import urllib.error
from datetime import datetime, timezone, timedelta
import tickets_collect as collect


def assess(health,now=None):
    now=now or datetime.now(timezone.utc)
    critical=[];warnings=[]
    if health.get('collector_state')=='failed': critical.append('The latest collector run reported a failure.')
    if health.get('provider_paused'): critical.append('Provider checks are paused; saved prices remain available.')
    if not health.get('events'): critical.append('No upcoming catalog events are available.')
    elif not health.get('priced'): critical.append('No upcoming events have a saved price.')
    checked=health.get('last_collector_at')
    try: age=now-datetime.fromisoformat(str(checked).replace('Z','+00:00'))
    except (ValueError,TypeError): age=timedelta.max
    if age>timedelta(hours=2): critical.append('The collector has no successful heartbeat within two hours.')
    if health.get('teams_checked',0)<health.get('teams',0): warnings.append('Some provider-listed teams have not completed an inspection.')
    if health.get('teams_failed',0): warnings.append('Some team pages failed their latest inspection.')
    if health.get('unpriced',0): warnings.append('Some event get-in prices are unconfirmed.')
    if health.get('stale',0)>max(100,health.get('priced',0)//2): warnings.append('More than half of saved get-in prices are older than 24 hours.')
    if health.get('failed_checks',0): warnings.append('Some event checks failed; saved samples remain available.')
    return {'status':'error' if critical else 'warning' if warnings else 'ok','critical':critical,'warnings':warnings}


def main():
    if os.environ.get('GITHUB_ACTIONS')!='true': raise RuntimeError('Coverage monitoring is hosted-only')
    try: health=collect.sb('POST','rpc/tix_catalog_health',{'p_category':None})
    except urllib.error.HTTPError as error:
        if error.code==404:
            print('Catalog reliability schema is not deployed; coverage monitoring is pending deployment.')
            return
        raise
    previous_rows=collect.sb('GET','tix_state?k=eq.catalog_coverage_health&select=v&limit=1')
    previous=previous_rows[0].get('v') if previous_rows else {}
    if isinstance(previous,str):
        try: previous=json.loads(previous)
        except ValueError: previous={}
    previous=previous if isinstance(previous,dict) else {}
    assessment=assess(health)
    result={**health,**assessment}
    changed=previous.get('status')!='error' or previous.get('critical')!=assessment['critical']
    collect.write_state('catalog_coverage_health',result)
    print(json.dumps(result,indent=2,sort_keys=True))
    # Alert only when a new outage appears or its actionable reasons change.
    # Repeated monitor runs retain the red dashboard state without repeated mail.
    if assessment['critical'] and changed:
        raise RuntimeError('Catalog coverage alert: '+' '.join(assessment['critical']))

if __name__=='__main__': main()
