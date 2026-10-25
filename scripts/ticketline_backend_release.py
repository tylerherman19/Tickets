#!/usr/bin/env python3
"""Apply reviewed additive migrations and publish the exact bundled quote source.
Requires an owner-supplied Supabase Management API token; never reads browser login.
"""
import json,os,sys,time,urllib.request,urllib.error,uuid
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
        try:
            with urllib.request.urlopen(request,timeout=90) as response:return json.load(response)
        except urllib.error.HTTPError as error:
            # Surface the SQL/permission diagnosis, never request headers,
            # credentials, or a response containing private row values.
            try:
                detail=json.load(error)
                message=str(detail.get('message') or detail.get('error') or detail.get('code') or 'No diagnostic message')
            except (ValueError,AttributeError):message='No JSON diagnostic message'
            message=message.replace(token,'[redacted]')[:600]
            raise RuntimeError(f'Supabase release request failed (HTTP {error.code}): {message}') from None
    def sql(query):return api('/database/query',json.dumps({'query':query}).encode())
    if '--coverage-fix' in sys.argv:
        database=sql("select current_setting('default_transaction_read_only') read_only,pg_database_size(current_database()) database_bytes")[0]
        print('Database capacity:',json.dumps(database),flush=True)
        if database['read_only']=='on':
            sizes=sql("select schemaname,relname,pg_total_relation_size(relid) total_bytes,n_live_tup,n_dead_tup from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 15")
            print('Largest database relations:',json.dumps(sizes),flush=True)
            try:print('Database WAL:',json.dumps(sql('select sum(size) wal_bytes from pg_ls_waldir()')),flush=True)
            except RuntimeError as error:print('WAL size unavailable:',str(error),flush=True)
            raise RuntimeError('Database is in read-only mode; reclaim existing free space before applying migrations. No stored history was deleted.')
        # Explain the repaired query, never re-run the baseline that exhausted
        # temporary disk. Report plan shape/timing, never private row values.
        def explain(file):
            query=(ROOT/'scripts'/file).read_text().split('$health$')[1].strip().replace('$1','null::text')
            rows=sql("set local statement_timeout='8s'; explain (analyze, buffers, format json) "+query)
            plan=next(row['QUERY PLAN'][0] for row in rows if 'QUERY PLAN' in row)
            def nodes(node):
                return [{'node':node['Node Type'],'relation':node.get('Relation Name'),'rows':node.get('Actual Rows'),'loops':node.get('Actual Loops'),'temp_written':node.get('Temp Written Blocks',0)}]+[row for child in node.get('Plans',[]) for row in nodes(child)]
            print(json.dumps({'query':file,'execution_ms':plan['Execution Time'],'plan':nodes(plan['Plan'])}))
        sql((ROOT/'scripts/20261023_coverage_monitor.sql').read_text())
        sql((ROOT/'scripts/20261023_collector_cadence.sql').read_text())
        sql((ROOT/'scripts/20261025_bounded_catalog_queries.sql').read_text())
        explain('20261025_bounded_catalog_queries.sql')
        for _ in range(3):
            started=time.monotonic()
            rows=sql("set local statement_timeout='8s'; select public.tix_catalog_health(null) health")
            sample=next(row['health'] for row in rows if 'health' in row)
            if not sample.get('events'):raise RuntimeError('Coverage verification returned no catalog events')
            print('Live coverage query verified:',sample['events'],'events;',round(time.monotonic()-started,3),'seconds including transport')
        for start,end in ((0,7),(8,30)):
            started=time.monotonic()
            rows=sql("set local statement_timeout='8s'; select count(*) selected from public.tix_discovery_due("+str(start)+','+str(end)+',40)')
            selected=next(row['selected'] for row in rows if 'selected' in row)
            if not 0<=selected<=40:raise RuntimeError('Discovery selection exceeded its batch limit')
            print('Live discovery query verified:',start,end,'days;',selected,'events;',round(time.monotonic()-started,3),'seconds including transport')
        runtime=sql('select public.tix_runtime_health() health')[0]['health']
        if not isinstance(runtime.get('overdue_alert_progress'),dict):raise RuntimeError('Per-event progress migration is unavailable')
        if not sql('select version from public.tix_schema_versions where version=20261029'):
            raise RuntimeError('Bounded catalog query migration is unavailable')
        print('Verified catalog query schema 20261029; overdue alert count:',runtime['overdue_alert_events'])
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
    for version,name in [(20261020,'20261020_runtime_reliability.sql'),(20261021,'20261020_delivery_health.sql'),(20261022,'20261020_quote_priority.sql'),(20261023,'20261020_quick_latency.sql'),(20261024,'20261020_storage_policy.sql'),(20261025,'20261021_capture_write_performance.sql'),(20261026,'20261021_alert_streamlining.sql'),(20261027,'20261023_coverage_monitor.sql'),(20261028,'20261023_collector_cadence.sql'),(20261029,'20261025_bounded_catalog_queries.sql')]:
        if version not in versions:
            sql((ROOT/'scripts'/name).read_text());print('Applied reviewed schema',version)
    boundary='ticketline-'+uuid.uuid4().hex
    metadata={'name':'ticketline-prices','entrypoint_path':'index.ts','verify_jwt':True}
    body=(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'+json.dumps(metadata)+f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/typescript\r\n\r\n'+bundle()+f'\r\n--{boundary}--\r\n').encode()
    result=api('/functions/deploy?slug=ticketline-prices',body,'multipart/form-data; boundary='+boundary)
    if result.get('status')!='ACTIVE':raise RuntimeError('Function did not report ACTIVE')
    print('Published quote function version',result.get('version'))
    if sql('select max(version) version from public.tix_schema_versions')[0]['version']<20261029:raise RuntimeError('Schema verification failed')

if __name__=='__main__':main()

