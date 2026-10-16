#!/usr/bin/env python3
"""Keep the existing hosted collector until the new schema is available.

Only an explicit missing-RPC response selects the pinned prior collector.
Authentication, transient network errors and unexpected payloads fail closed.
This preflight never contacts Gametime or enables the guarded feature.
"""
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request

PREVIOUS_COLLECTOR = 'c035c809ed8ab933cde61d8bc6305e5c8bb8181c'
# The current collector, performer sweep and Edge search need this migration.
REQUIRED_SCHEMA = 20261016

def schema_ready():
    base=os.environ['SUPABASE_URL'].rstrip('/')
    key=os.environ['SUPABASE_SERVICE_KEY']
    req=urllib.request.Request(base+'/rest/v1/rpc/tix_event_capture_status',
        data=json.dumps({'p_event_id':'rollout-preflight'}).encode(),method='POST',
        headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=10) as response:
            result=json.load(response)
        if not isinstance(result,dict) or type(result.get('guard_enabled')) is not bool:
            raise RuntimeError('Unexpected capture schema response')
        # 20261012 alone predates the RPCs the current collector calls.
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
    if schema_ready():
        path=Path(__file__).with_name('tickets_collect.py')
        path.write_text(preserve_college_categories(path.read_text()))
        print('Guarded schema available; using current collector.')
        return
    # Existing collection continues unchanged while schema/function deployment
    # is unavailable. Once the RPC exists, all collection switches to shared
    # admission automatically; the new feature never uses this fallback.
    subprocess.run(['git','fetch','--depth=1','origin',PREVIOUS_COLLECTOR],check=True)
    prior=subprocess.check_output(['git','show',PREVIOUS_COLLECTOR+':scripts/tickets_collect.py'])
    Path(__file__).with_name('tickets_collect.py').write_text(preserve_college_categories(prior.decode()))
    print('Schema deployment pending; using pinned existing collector.')

if __name__=='__main__':main()
