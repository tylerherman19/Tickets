#!/usr/bin/env python3
"""Check public-safe catalog coverage and fail Actions on actionable outages.

The scheduled workflow's normal failure notifications reach repository owners;
this worker never sends customer mail or includes watch/search-owner data.
Missing additive RPCs are reported as not deployed rather than bad coverage.
"""
import json
import os
import time
import urllib.error
from datetime import datetime, timezone, timedelta
import tickets_collect as collect

RECOVERY_CHECKS = 3
ALERT_DELAY_CONFIRM_MINUTES = 10

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
    healthy=0 if critical or assessment.get('overdue_since') else min(RECOVERY_CHECKS,int(previous.get('healthy_checks') or 0)+1)
    new_reasons=[reason for reason in critical if reason not in notified]
    if healthy>=RECOVERY_CHECKS:
        notified=[]
    else:
        notified=list(dict.fromkeys(notified+critical))
    return {'incident_reasons':notified,'healthy_checks':healthy},new_reasons


def assess(health,now=None,previous=None):
    now=now or datetime.now(timezone.utc)
    critical=[];warnings=[]
    overdue_since=None
    pending={}
    progress=health.get('overdue_alert_progress')
    if health.get('overdue_alert_events',0):
        # Follow the same event AND last-success timestamp. A count alone can
        # stay nonzero while different events recover on successive sweeps.
        old=(previous or {}).get('overdue_progress') or {}
        if isinstance(progress,dict):
            for key,success in progress.items():
                prior=old.get(key) or {}
                since=prior.get('since') if prior.get('success')==success else None
                pending[key]={'success':success,'since':valid_since(since,now).isoformat()}
            starts=[datetime.fromisoformat(v['since']) for v in pending.values()]
            since=min(starts) if starts else now
        else:
            # Compatibility before the additive runtime migration is deployed.
            since=valid_since((previous or {}).get('overdue_since'),now)
        overdue_since=since.isoformat()
        if now-since>=timedelta(minutes=ALERT_DELAY_CONFIRM_MINUTES):
            critical.append('Some active alert events remain overdue across coverage checks.')
        else:
            warnings.append('Some alert checks are late; waiting for the collector to finish before confirming an outage.')
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
    if health.get('unresolved_alerts',0): warnings.append('Some active alerts have no resolved upcoming events after 30 minutes.')
    if health.get('delivery_uncertain',0): critical.append('A delivery needs review before it can safely be retried.')
    if health.get('failed_checks',0): warnings.append('Some event checks failed; saved samples remain available.')
    return {'status':'error' if critical else 'warning' if warnings else 'ok','critical':critical,'warnings':warnings,'overdue_since':overdue_since,'overdue_progress':pending}


def valid_since(value,now):
    try:
        since=datetime.fromisoformat(str(value).replace('Z','+00:00'))
        return since if since.tzinfo is not None and since<=now else now
    except (ValueError,TypeError): return now


def read_health(path,body):
    """Retry only read-only RPCs, never provider requests or uncertain writes."""
    for attempt in range(3):
        try: return collect.sb('POST',path,body)
        except (urllib.error.URLError,TimeoutError) as error:
            transient=not isinstance(error,urllib.error.HTTPError) or error.code in (502,503,504) or (error.code==500 and getattr(error,'postgres_code',None)=='57014')
            if not transient or attempt==2: raise
            print('Health read temporarily unavailable; retrying read-only RPC.')
            time.sleep(2*(attempt+1))


def main():
    if os.environ.get('GITHUB_ACTIONS')!='true': raise RuntimeError('Coverage monitoring is hosted-only')
    previous_rows=collect.sb('GET','tix_state?k=eq.catalog_coverage_health&select=v&limit=1')
    previous=previous_rows[0].get('v') if previous_rows else {}
    if isinstance(previous,str):
        try: previous=json.loads(previous)
        except ValueError: previous={}
    previous=previous if isinstance(previous,dict) else {}
    try:
        health=read_health('rpc/tix_catalog_health',{'p_category':None})
        try:
            runtime=read_health('rpc/tix_runtime_health',{})
            if isinstance(runtime,dict):
                health.update({k:runtime.get(k,0) for k in ('overdue_alert_events','unresolved_alerts','delivery_uncertain')})
                if 'overdue_alert_progress' in runtime:health['overdue_alert_progress']=runtime['overdue_alert_progress']
        except urllib.error.HTTPError as error:
            if error.code!=404:raise
        assessment=assess(health,previous=previous)
        health.pop('overdue_alert_progress',None)
        health['last_successful_health_at']=datetime.now(timezone.utc).isoformat()
    except (urllib.error.URLError,TimeoutError) as error:
        if isinstance(error,urllib.error.HTTPError) and error.code==404:
            print('Catalog reliability schema is not deployed; coverage monitoring is pending deployment.')
            return
        # Preserve the last sample, explicitly marked unavailable, and never
        # count an unreadable poll as recovery or lose the incident history.
        health={k:v for k,v in previous.items() if k not in ('critical','warnings','status')}
        assessment={'status':'error','critical':['Coverage health could not be read after bounded retries.'],
                    'warnings':['Saved coverage is the last known sample; current health is unavailable.'],
                    'overdue_since':previous.get('overdue_since'),'overdue_progress':previous.get('overdue_progress',{})}
        health['health_read_error']=getattr(error,'postgres_code',None) or type(error).__name__
    incident,new_reasons=incident_state(previous,assessment)
    recovered=bool(previous.get('incident_reasons')) and not incident['incident_reasons']
    result={**health,**assessment,**incident,'recovered_at':datetime.now(timezone.utc).isoformat() if recovered else previous.get('recovered_at')}
    if recovered:print('Coverage incident recovered after three consecutive healthy checks.')
    collect.write_state('catalog_coverage_health',result)
    # Progress keys are private operational correlation data, never job logs.
    print(json.dumps({k:v for k,v in result.items() if k!='overdue_progress'},indent=2,sort_keys=True))
    if new_reasons:
        raise RuntimeError('Catalog coverage alert: '+' '.join(new_reasons))

if __name__=='__main__': main()
