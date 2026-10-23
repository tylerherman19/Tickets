#!/usr/bin/env python3
"""Apply reviewed additive migrations and publish the exact bundled quote source.
Requires an owner-supplied Supabase Management API token; never reads browser login.
"""
import json,os,sys,time,urllib.request,uuid
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
    if '--coverage-fix' in sys.argv:
        # Explain the actual query, not just the PL/pgSQL wrapper. Report plan
        # shape/timing only; no watch, owner, event or destination values.
        def explain(file):
            query=(ROOT/'scripts'/file).read_text().split('$health$')[1].strip().replace('$1','null::text')
            plan=sql('explain (analyze, buffers, format json) '+query)[0]['QUERY PLAN'][0]
            def nodes(node):
                return [{'node':node['Node Type'],'relation':node.get('Relation Name'),'rows':node.get('Actual Rows'),'loops':node.get('Actual Loops')}]+[row for child in node.get('Plans',[]) for row in nodes(child)]
            print(json.dumps({'query':file,'execution_ms':plan['Execution Time'],'plan':nodes(plan['Plan'])}))
        try:explain('20261017_coverage_query.sql')
        except Exception as error:print('Baseline coverage query unavailable:',type(error).__name__)
        sql((ROOT/'scripts/20261023_coverage_monitor.sql').read_text())
        explain('20261023_coverage_monitor.sql')
        for _ in range(3):
            started=time.monotonic()
            rows=sql("set local statement_timeout='8s'; select public.tix_catalog_health(null) health")
            sample=next(row['health'] for row in rows if 'health' in row)
            if not sample.get('events'):raise RuntimeError('Coverage verification returned no catalog events')
            print('Live coverage query verified:',sample['events'],'events;',round(time.monotonic()-started,3),'seconds including transport')
        runtime=sql('select public.tix_runtime_health() health')[0]['health']
        if not isinstance(runtime.get('overdue_alert_progress'),dict):raise RuntimeError('Per-event progress migration is unavailable')
        print('Verified coverage schema 20261027; overdue alert count:',runtime['overdue_alert_events'])
        return
    existing=sql('select version from public.tix_schema_versions')
    versions={row['version'] for row in existing}
    if '--capture-write-fix' in sys.argv or '--schema-only' in sys.argv:
        if 20261024 not in versions:
            raise RuntimeError('Apply the existing storage-policy release before the capture-write repair')
        if 20261025 not in versions:
            sql((ROOT/'scripts/20261021_capture_write_performance.sql').read_text())
        if not sql('select version from public.tix_schema_versions where version=20261025'):
            raise RuntimeError('Capture-write repair verification failed')
        if '--schema-only' in sys.argv:
            if 20261026 not in versions:
                sql((ROOT/'scripts/20261021_alert_streamlining.sql').read_text())
            if not sql('select version from public.tix_schema_versions where version=20261026'):
                raise RuntimeError('Alert controls schema verification failed')
            print('Verified alert controls schema 20261026')
        print('Verified capture-write repair 20261025; quote service unchanged')
        return
    for version,name in [(20261020,'20261020_runtime_reliability.sql'),(20261021,'20261020_delivery_health.sql'),(20261022,'20261020_quote_priority.sql'),(20261023,'20261020_quick_latency.sql'),(20261024,'20261020_storage_policy.sql'),(20261025,'20261021_capture_write_performance.sql'),(20261026,'20261021_alert_streamlining.sql'),(20261027,'20261023_coverage_monitor.sql')]:
        if version not in versions:
            sql((ROOT/'scripts'/name).read_text());print('Applied reviewed schema',version)
    boundary='ticketline-'+uuid.uuid4().hex
    metadata={'name':'ticketline-prices','entrypoint_path':'index.ts','verify_jwt':True}
    body=(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'+json.dumps(metadata)+f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/typescript\r\n\r\n'+bundle()+f'\r\n--{boundary}--\r\n').encode()
    result=api('/functions/deploy?slug=ticketline-prices',body,'multipart/form-data; boundary='+boundary)
    if result.get('status')!='ACTIVE':raise RuntimeError('Function did not report ACTIVE')
    print('Published quote function version',result.get('version'))
    if sql('select max(version) version from public.tix_schema_versions')[0]['version']<20261027:raise RuntimeError('Schema verification failed')

if __name__=='__main__':main()

