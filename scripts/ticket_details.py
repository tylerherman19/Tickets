#!/usr/bin/env python3
"""Hosted history-only detail worker. Never sends email or SMS."""
import os
import re
import sys
import tickets_collect as collect
from ticketline_guard import CaptureDeferred

def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Detail collection is hosted-only')
    collect.expire_event_storage()
    event_id=os.environ.get('TIX_DETAIL_EVENT_ID','')
    if not re.fullmatch(r'[a-f0-9]{24}',event_id):
        raise ValueError('Invalid event ID')
    rows=collect.sb('GET',f'tix_events_v?event_id=eq.{event_id}&select=*&limit=1')
    jobs=collect.sb('GET',f'tix_capture_jobs?event_id=eq.{event_id}&select=requested_quantities,warm_quantities&limit=1')
    quantities=set((jobs[0].get('requested_quantities') or jobs[0].get('warm_quantities') or [2]) if jobs else [2])
    if not rows: return
    try:
        with collect.GUARD.capture(event_id,'detail'):
            status,meta,listings=collect.fetch_provider_page(rows[0]['url'])
            if not meta or status=='parser_failure':
                raise ValueError('parser_failure')
            if status=='metadata_only':
                # Use the requested seat counts. DOM cards never imply complete
                # coverage of the event inventory.
                richer=collect.rendered_quantity_listings(rows[0]['url'],quantities)
                if richer:
                    listings=richer
                    status='partial' if any(l.get('verified_quantity') for l in richer) else 'ok'
            collect.record_event_market(rows[0],meta,listings,collect.datetime.now(collect.timezone.utc).isoformat(),status)
    except CaptureDeferred as error:
        print(f'Detail check deferred: {error}')

if __name__=='__main__': main()
