const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 await db.exec(fs.readFileSync('scripts/tickets_schema.sql','utf8'));
 for(const file of ['20260910_alert_reliability.sql','20260910_per_alert_destinations.sql','20260927_criteria_lifecycle.sql','20260927_ticket_intelligence.sql','20260928_public_discovery.sql','20260928_discovery_interest.sql','20260928_email_delivery.sql','20260928_provider_metadata.sql','20260928_signed_in_catalog.sql','20261007_hardening.sql','20261011_listing_fields.sql','20261012_guarded_history.sql','20261016_fast_search.sql','20261017_moved_events.sql','20261017_catalog_reliability.sql','20261017_coverage_query.sql','20261017_admin.sql','20261018_general_search.sql','20261018_search_activity.sql','20261020_runtime_reliability.sql','20261020_runtime_reliability.sql','20261020_delivery_health.sql','20261020_quote_priority.sql','20261020_quick_latency.sql','20261020_storage_policy.sql','20261020_storage_policy.sql'])
 await db.exec(fs.readFileSync('scripts/'+file,'utf8').replace(/^.*(?:create extension.*pg_trgm|create index.*gin_trgm_ops).*$/gm,''));
 const rpc=async(name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
 const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 const event='a'.repeat(24);
 await db.query("insert into tix_catalog(event_id,event_date,url) values($1,current_date+1,$2)",[event,'https://gametime.co/events/'+event]);
 const lease=await rpc('tix_claim_capture',[event,'interactive']);
 const item=(price,section,qty=[2,4])=>({provider:{seats:['1','2','3','4'],availableLots:qty},listing_id:section,price_cents:price,basis:'fees_included_tax_unknown',lots:qty,section,section_group:'Club'});
 await rpc('tix_finish_capture',[lease.token,JSON.stringify({meta:{event_id:event},state:'complete',min_total:3000,listings:[item(3200,'C1'),item(3500,'C2',[2])],by_qty:{2:{low:3200,basis:'fees_included_tax_unknown'}},coverage:{complete:true},groups:[]})]);
 await db.exec("update tix_event_observations set checked_at=now()-interval '25 hours'");
 const history=async(section=null)=> (await db.query('select * from tix_event_comparable_history($1,2,$2,$3)',[event,'fees_included_tax_unknown',section])).rows;
 const before=await history(),club=await history('Club'),c1=await history('C1');assert.equal(before[0].price_cents,3200);assert.equal(Number(club[0].listing_count),2);assert.equal(Number(c1[0].listing_count),1);
 assert.equal((await rpc('tix_prune_listing_copies',[false,5000])).eligible_rows,2);
 await assert.rejects(rpc('tix_prune_listing_copies',[true,5000]),/approval/);
 await db.exec('set role anon');await assert.rejects(rpc('tix_prune_listing_copies',[true,5000]));assert.equal((await history())[0].price_cents,3200);await db.exec('reset role');
 await db.exec('update tix_storage_policy set listing_retention_enabled=true');assert.equal((await rpc('tix_prune_listing_copies',[null,5000])).eligible_rows,2,'null is preview only');
 assert.equal((await rpc('tix_prune_listing_copies',[true,5000])).deleted,2);
 assert.deepEqual(await history(),before);assert.deepEqual(await history('Club'),club);assert.deepEqual(await history('C1'),c1);assert.equal((await one('select count(*)::int n from tix_event_observations')).n,1);
 await db.close();console.log('Storage policy: disabled by default, explicit approval required, section and quantity history survives raw-listing cleanup.');
})().catch(e=>{console.error({message:e.message,position:e.position,internalQuery:e.internalQuery});process.exitCode=1;});
