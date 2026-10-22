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

RECOVERY_CHECKS = 3

def incident_state(previous, assessment):
    """One incident survives a single good poll between recurring failures.

    The latest assessment remains accurate; only notification history waits
    for three consecutive healthy polls before declaring recovery.
    """
    notified=list(previous.get('incident_reasons') or [])
    # Adopt an already-notified legacy incident when this update rolls out.
    if not notified and previous.get('status')=='error':
        notified=list(previous.get('critical') or [])
    critical=assessment['critical']
    healthy=0 if critical else min(RECOVERY_CHECKS,int(previous.get('healthy_checks') or 0)+1)
    new_reasons=[reason for reason in critical if reason not in notified]
    if healthy>=RECOVERY_CHECKS:
        notified=[]
    else:
        notified=list(dict.fromkeys(notified+critical))
    return {'incident_reasons':notified,'healthy_checks':healthy},new_reasons


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
    if health.get('overdue_alert_events',0): critical.append('Some active alert events have no successful check within 30 minutes.')
    if health.get('unresolved_alerts',0): warnings.append('Some active alerts have no resolved upcoming events after 30 minutes.')
    if health.get('delivery_uncertain',0): critical.append('A delivery needs review before it can safely be retried.')
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
    try:
        runtime=collect.sb('POST','rpc/tix_runtime_health',{})
        if isinstance(runtime,dict):
            health.update({k:runtime.get(k,0) for k in ('overdue_alert_events','unresolved_alerts','delivery_uncertain')})
    except urllib.error.HTTPError as error:
        if error.code!=404:raise
    previous_rows=collect.sb('GET','tix_state?k=eq.catalog_coverage_health&select=v&limit=1')
    previous=previous_rows[0].get('v') if previous_rows else {}
    if isinstance(previous,str):
        try: previous=json.loads(previous)
        except ValueError: previous={}
    previous=previous if isinstance(previous,dict) else {}
    assessment=assess(health)
    incident,new_reasons=incident_state(previous,assessment)
    recovered=bool(previous.get('incident_reasons')) and not incident['incident_reasons']
    result={**health,**assessment,**incident,'recovered_at':datetime.now(timezone.utc).isoformat() if recovered else previous.get('recovered_at')}
    if recovered:print('Coverage incident recovered after three consecutive healthy checks.')
    collect.write_state('catalog_coverage_health',result)
    print(json.dumps(result,indent=2,sort_keys=True))
    # Keep reporting the current outage, without a second email every time
    # one good collector run briefly interrupts the same ongoing failure.
    if new_reasons:
        raise RuntimeError('Catalog coverage alert: '+' '.join(new_reasons))

if __name__=='__main__': main()

