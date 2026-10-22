#!/usr/bin/env python3
"""Check that the hosted database supports this release.

Missing or older schema stops the job before provider and email work.
Authentication, transient network errors and unexpected payloads fail closed.
This preflight never contacts Gametime or enables the guarded feature.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

# The current collector, performer sweep and Edge search need this migration.
REQUIRED_SCHEMA = 20261026

def schema_ready():
    base=os.environ['SUPABASE_URL'].rstrip('/')
    key=os.environ['SUPABASE_SERVICE_KEY']
    req=urllib.request.Request(base+'/rest/v1/rpc/tix_runtime_health',
        data=b'{}',method='POST',
        headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=10) as response:
            result=json.load(response)
        if not isinstance(result,dict):
            raise RuntimeError('Unexpected capture schema response')
        # The delivery and quote workers require the full reliability migration.
        return type(result.get('schema')) is int and result['schema']>=REQUIRED_SCHEMA
    except urllib.error.HTTPError as error:
        try: code=json.load(error).get('code')
        except (ValueError,AttributeError): code=None
        if error.code==404 and code=='PGRST202': return False
        raise RuntimeError(f'Capture preflight failed: HTTP {error.code}') from None

def preserve_college_categories(source):
    """Keep provider-verified college categories when the sitemap says sports."""
    if 'college_category_ids = set()' in source: return source
    anchor = '    rows = {}\n    for sm in SITEMAPS:'
    replacement = "    rows = {}\n    college_category_ids = set()\n    offset = 0\n    while True:\n        existing = sb('GET', 'tix_catalog?category=eq.college-basketball&select=event_id&order=event_id&limit=1000&offset='+str(offset))\n        college_category_ids.update(row['event_id'] for row in existing)\n        if len(existing) < 1000: break\n        offset += len(existing)\n    for sm in SITEMAPS:"
    row_anchor = '            if r: rows[r["event_id"]] = r'
    row_replacement = "            if r:\n                if r['event_id'] in college_category_ids and r['category'] in ('sports','basketball'):\n                    r['category'] = 'college-basketball'\n                rows[r['event_id']] = r"
    if source.count(anchor)!=1 or source.count(row_anchor)!=1:
        raise RuntimeError('Collector catalog format changed; refusing an unsafe compatibility patch')
    return source.replace(anchor,replacement).replace(row_anchor,row_replacement)

def main():
    if os.environ.get('GITHUB_ACTIONS')!='true':
        raise RuntimeError('Release preflight is hosted-only')
    # A merge starts schema publication and workers independently. Allow the
    # additive release to finish before reporting a genuinely missing migration.
    ready=False
    for attempt in range(21):
        if schema_ready():
            ready=True
            break
        if attempt<20:
            print('Waiting for the reviewed database release before any provider or email work.',flush=True)
            time.sleep(15)
    if ready:
        path=Path(__file__).with_name('tickets_collect.py')
        path.write_text(preserve_college_categories(path.read_text()))
        print('Guarded schema available; using current collector.')
        return
    raise RuntimeError('Ticketline database update is missing. Stopping before any provider or email work.')

if __name__=='__main__':main()

