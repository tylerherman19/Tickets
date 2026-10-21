#!/usr/bin/env python3
"""Apply reviewed additive migrations and publish the exact bundled quote source.
Requires an owner-supplied Supabase Management API token; never reads browser login.
"""
import json,os,urllib.request,uuid
from pathlib import Path
PROJECT='aahqagqztanltejsqjom'
ROOT=Path(__file__).resolve().parents[1]

def bundle():
    provider=(ROOT/'supabase/functions/_shared/provider.mjs').read_text().replace('export ','')
    function=(ROOT/'supabase/functions/ticketline-prices/index.ts').read_text()
    if not function.startswith("import { captureFromPage,"):raise RuntimeError('Review changed function imports before bundling')
    return provider+'\n'+function.split('\n',1)[1]

def main():
    if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Backend release is hosted-only')
    token=os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:raise RuntimeError('Add SUPABASE_ACCESS_TOKEN to repository Actions secrets to enable backend releases')
    def api(path,body,content_type='application/json'):
        request=urllib.request.Request('https://api.supabase.com/v1/projects/'+PROJECT+path,data=body,method='POST',headers={'Authorization':'Bearer '+token,'Content-Type':content_type})
        with urllib.request.urlopen(request,timeout=90) as response:return json.load(response)
    def sql(query):return api('/database/query',json.dumps({'query':query}).encode())
    existing=sql('select version from public.tix_schema_versions')
    versions={row['version'] for row in existing}
    for version,name in [(20261020,'20261020_runtime_reliability.sql'),(20261021,'20261020_delivery_health.sql'),(20261022,'20261020_quote_priority.sql'),(20261023,'20261020_quick_latency.sql'),(20261024,'20261020_storage_policy.sql')]:
        if version not in versions:
            sql((ROOT/'scripts'/name).read_text());print('Applied reviewed schema',version)
    boundary='ticketline-'+uuid.uuid4().hex
    metadata={'name':'ticketline-prices','entrypoint_path':'index.ts','verify_jwt':True}
    body=(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'+json.dumps(metadata)+f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/typescript\r\n\r\n'+bundle()+f'\r\n--{boundary}--\r\n').encode()
    result=api('/functions/deploy?slug=ticketline-prices',body,'multipart/form-data; boundary='+boundary)
    if result.get('status')!='ACTIVE':raise RuntimeError('Function did not report ACTIVE')
    print('Published quote function version',result.get('version'))
    if sql('select max(version) version from public.tix_schema_versions')[0]['version']<20261022:raise RuntimeError('Schema verification failed')

if __name__=='__main__':main()
