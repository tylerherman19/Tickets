#!/usr/bin/env python3
"""Keep requested seat quotes warm. No notification credentials or sends."""
import os
import time
from datetime import datetime, timezone
import tickets_collect as collect
from ticketline_guard import CaptureDeferred


def capture(job):
    event_id=job['event_id']
    quantities=set(job.get('requested_quantities') or job.get('warm_quantities') or [2])
    quantities={q for q in quantities if type(q) is int and 1<=q<=8}
    source='detail' if job.get('detail_requested') else 'warm'
    with collect.GUARD.capture(event_id,source):
        try:age=(datetime.now(timezone.utc)-datetime.fromisoformat(job.get('price_checked_at','').replace('Z','+00:00'))).total_seconds()
        except (ValueError,TypeError):age=900
        fresh_metadata=0<=age<900 and job.get('min_total',0)>0
        if fresh_metadata:
            # Skip a second metadata fetch; only the real browser can refresh it.
            meta={k:job.get(k) for k in ('event_id','name','venue','datetime_local','category','url')};meta['min_total']=None
            status,listings='metadata_only',[]
        else:status,meta,listings=collect.fetch_provider_page(job['url'])
        if not meta or status=='parser_failure':raise ValueError('parser_failure')
        if status=='metadata_only':
            richer=collect.rendered_quantity_listings(job['url'],quantities,meta_out=meta) if fresh_metadata else collect.rendered_quantity_listings(job['url'],quantities)
            if richer:
                listings=richer;status='partial' if any(l.get('verified_quantity') for l in richer) else 'ok'
        collect.record_event_market(job,meta,listings,datetime.now(timezone.utc).isoformat(),status)


def main():
    if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Quote worker is hosted-only')
    deadline=time.monotonic()+min(840,max(1,int(os.environ.get('TIX_QUOTE_WORKER_SECONDS','840'))))
    health_at=0;checked=failed=deferred=0
    while time.monotonic()<deadline:
        if deadline-time.monotonic()<80:break # Give an admitted browser capture time to finish.
        jobs=collect.sb('POST','rpc/tix_quick_due',{'p_limit':1})
        for job in jobs:
            try:capture(job);checked+=1
            except CaptureDeferred as error:
                deferred+=1
                if error.state=='suspended':
                    print('Quote worker: provider paused; stopping.');return
            except Exception as error:
                failed+=1;print('Quote worker capture failed:',type(error).__name__)
            if time.monotonic()>=deadline-80:break
        if time.monotonic()-health_at>=60:
            collect.write_state('quote_worker_health',{'checked_at':datetime.now(timezone.utc).isoformat(),'status':'degraded' if failed else 'ok','checked_events':checked,'failed_events':failed,'deferred_events':deferred})
            health_at=time.monotonic()
        time.sleep(0.25 if jobs else 1)
    print(f'Quote worker: checked {checked}, failed {failed}, deferred {deferred}.')

if __name__=='__main__':main()
