const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 await db.exec(fs.readFileSync('scripts/tickets_schema.sql','utf8'));
 for(const file of ['20260910_alert_reliability.sql','20260910_per_alert_destinations.sql','20260927_criteria_lifecycle.sql','20260927_ticket_intelligence.sql','20260928_public_discovery.sql','20260928_discovery_interest.sql','20260928_email_delivery.sql','20260928_provider_metadata.sql','20260928_signed_in_catalog.sql','20261007_hardening.sql','20261011_listing_fields.sql','20261012_guarded_history.sql']){
  process.stdout.write('Apply '+file+'\n');await db.exec(fs.readFileSync('scripts/'+file,'utf8').replace(/^.*(?:create extension.*pg_trgm|create index.*gin_trgm_ops).*$/gm,''));
 }
 await db.exec(fs.readFileSync('scripts/20261012_guarded_history.sql','utf8'));
 const rpc=async(name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const uid='00000000-0000-0000-0000-000000000001';
 const id='aaaaaaaaaaaaaaaaaaaaaaaa';
 await db.query('insert into auth.users(id) values($1)',[uid]);
 await db.query(`insert into tix_catalog(event_id,event_date,url)values($1,current_date+35,'https://gametime.co/events/'||$1)`,[id]);
 await db.exec(`set role authenticated;select set_config('test.uid','${uid}',false);`);
 assert.equal((await rpc('tix_request_capture',[id,true])).state,'queued');
 await assert.rejects(rpc('tix_claim_capture',[id,'edge']));
 await db.exec('reset role');
 assert.equal((await rpc('tix_claim_capture',[id,'edge'])).state,'suspended');
 await db.exec('update tix_provider_guard set enabled=true,expiry_enabled=true');
 const lease=await rpc('tix_claim_capture',[id,'edge']);assert.equal(lease.state,'checking');
 assert.equal((await rpc('tix_claim_capture',[id,'collector'])).reason,'provider_busy');
 for(let i=0;i<3;i++)assert.equal((await rpc('tix_admit_provider_http',[lease.token])).allowed,true);
 assert.equal((await rpc('tix_admit_provider_http',[lease.token])).allowed,false);
 const capture={meta:{event_id:id},state:'complete',format:'fixture',min_total:1200,coverage:{complete:true},groups:[],by_qty:{2:{low:1400,basis:'fees_included_tax_reported'}},listings:[{listing_id:'lot',price_cents:1400,basis:'fees_included_tax_reported',lots:[2,4],provider:{seats:['1','2','3','4'],extra:{retain:true}}}]};
 const observation=await rpc('tix_finish_capture',[lease.token,JSON.stringify(capture)]);
 assert.equal(typeof observation,'string');
 assert.deepEqual((await db.query('select seats,provider from tix_listing_observations')).rows[0].provider.extra,{retain:true});
 assert.equal((await db.query('select * from tix_event_listings($1,2,0)',[id])).rows.length,1);
 assert.equal((await db.query('select * from tix_event_listings($1,3,0)',[id])).rows.length,0);
 assert.equal((await db.query('select * from tix_event_price_history($1,0,$2)',[id,'provider_get_in_tax_quantity_unconfirmed'])).rows[0].price_cents,1200);
 assert.equal((await db.query('select * from tix_event_price_history($1,2,$2)',[id,'fees_included_tax_unknown'])).rows.length,0);
 assert.equal((await rpc('tix_claim_capture',[id,'edge'])).state,'cached');
 await db.exec("update tix_event_observations set checked_at=now()-interval '1 hour';update tix_capture_jobs set next_attempt_at=now()-interval '1 second';");
 const next=await rpc('tix_claim_capture',[id,'detail']);
 await rpc('tix_suspend_provider',[next.token,'HTTP_429']);await rpc('tix_release_capture',[next.token,'provider_suspended']);
 assert.equal((await rpc('tix_claim_capture',[id,'edge'])).state,'suspended');
 // Canary, horizon, hourly/day budgets and recovery never refund attempts.
 await db.exec("update tix_provider_guard set suspended_at=null,suspension_reason=null,canary_event_ids=array['other'];");
 assert.equal((await rpc('tix_claim_capture',[id,'edge'])).reason,'outside_canary');
 assert.equal((await rpc('tix_claim_capture',[null,'catalog'])).reason,'catalog_disabled');
 await db.exec("update tix_provider_guard set canary_event_ids='{}';update tix_capture_jobs set next_attempt_at=now()-interval '1 second';");
 await db.query("update tix_catalog set event_date=current_date+366 where event_id=$1",[id]);
 assert.equal((await rpc('tix_claim_capture',[id,'edge'])).state,'beyond_horizon');
 await db.query("update tix_catalog set event_date=current_date+365 where event_id=$1",[id]);
 for(const window of ['hour','day']){
  await db.exec(`update tix_provider_guard set hour_limit=${window==='hour'?1:30},day_limit=${window==='day'?1:100};update tix_provider_http set at=now()-interval '${window==='hour'?'2 minutes':'2 hours'}';update tix_capture_jobs set next_attempt_at=now()-interval '1 second';`);
  const claim=await rpc('tix_claim_capture',[id,'edge']);
  const admission=await rpc('tix_admit_provider_http',[claim.token]);assert.equal(admission.allowed,false);assert.equal(admission.reason,'request_limit');
  await rpc('tix_release_capture',[claim.token,'request_limit']);
 }
 await db.exec("update tix_provider_guard set hour_limit=30,day_limit=100;update tix_capture_jobs set next_attempt_at=now()-interval '1 second';");
 // A scheduled six-hour cadence must not suppress a stale on-demand refresh.
 await db.exec("update tix_capture_jobs set next_attempt_at=now()+interval '6 hours',reason=null;");
 const failed=await rpc('tix_claim_capture',[id,'edge']);assert.equal(failed.state,'checking');
 await rpc('tix_release_capture',[failed.token,'capture_failed']);
 assert.equal((await db.query("select count(*)::int n from tix_event_observations where state='failed'")).rows[0].n,1);
 // Failed and metadata samples cannot turn the latest exact-quantity set empty.
 assert.equal((await db.query('select * from tix_event_listings($1,2,0)',[id])).rows.length,1);
 await db.exec('set role anon');
 assert.equal((await db.query('select * from tix_event_listings($1,2,0)',[id])).rows.length,1);
 await assert.rejects(db.query('select * from tix_history_tracking'));
 await assert.rejects(rpc('tix_request_capture',[id,true]));
 await db.exec('reset role');
 await db.query(`insert into tix_watches(owner_id,label,kind,match,threshold_cents) values($1,'Keep settings','event',jsonb_build_object('event_ids',jsonb_build_array($2::text)),2000)`,[uid,id]);
 await db.query('update tix_catalog set event_date=current_date-3 where event_id=$1',[id]);
 const watch=(await db.query('select id from tix_watches')).rows[0].id;
 await db.query("insert into tix_prices(watch_id,event_id,club,qty,price_cents) values($1,$2,'Any section',2,1400)",[watch,id]);
 await db.query("insert into tix_scans(watch_id,event_id,outcome)values($1,$2,'ok')",[watch,id]);
 await db.query("insert into tix_alerts(watch_id,event_id,club,qty,price_cents,status)values($1,$2,'Any section',2,1400,'sent')",[watch,id]);
 await db.query("insert into tix_venue_clubs(venue_slug,clubs,sample_event_id)values('arena','[]',$1)",[id]);
 await db.query("insert into tix_event_changes(event_id,field,old_value,new_value)values($1,'venue','A','B')",[id]);
 // Authenticated owners may see only their tracking; public observations do
 // not expose requester identities or private alert history.
 await db.exec(`set role authenticated;select set_config('test.uid','${uid}',false);`);
 assert.equal((await db.query('select * from tix_history_tracking')).rows.length,1);
 await db.exec("select set_config('test.uid','00000000-0000-0000-0000-000000000099',false)");
 assert.equal((await db.query('select * from tix_history_tracking')).rows.length,0);
 await db.exec('reset role');
 // The same expiry transaction rolls back cleanly if the operator aborts it.
 await db.exec('begin');assert.equal(await rpc('tix_expire_event_storage',[100]),1);await db.exec('rollback');
 assert.equal((await db.query('select count(*)::int n from tix_event_observations')).rows[0].n,2);
 assert.equal(await rpc('tix_expire_event_storage',[100]),1);
 for(const table of ['tix_catalog','tix_event_observations','tix_listing_observations','tix_history_tracking','tix_capture_jobs','tix_event_changes','tix_prices','tix_alerts','tix_scans','tix_venue_clubs'])assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from tix_watches')).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from tix_provider_http')).rows[0].n,3);
 await db.close();console.log('Guard, exact lots, history, RLS and expiry tests passed.');
})().catch(e=>{console.error(e.message);process.exit(1)});
