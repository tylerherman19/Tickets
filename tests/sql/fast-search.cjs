const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs'),assert=require('node:assert/strict');
// Applies the full migration chain plus 20261016_fast_search.sql (twice) and
// exercises the search, tracking, budget and history paths. No network.
(async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 await db.exec(fs.readFileSync('scripts/tickets_schema.sql','utf8'));
 for(const file of ['20260910_alert_reliability.sql','20260910_per_alert_destinations.sql','20260927_criteria_lifecycle.sql','20260927_ticket_intelligence.sql','20260928_public_discovery.sql','20260928_discovery_interest.sql','20260928_email_delivery.sql','20260928_provider_metadata.sql','20260928_signed_in_catalog.sql','20261007_hardening.sql','20261011_listing_fields.sql','20261012_guarded_history.sql','20261016_fast_search.sql','20261016_fast_search.sql'])
  await db.exec(fs.readFileSync('scripts/'+file,'utf8').replace(/^.*(?:create extension.*pg_trgm|create index.*gin_trgm_ops).*$/gm,''));
 const rpc=async(name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 const asUser=uid=>db.exec(`set role authenticated;select set_config('test.uid','${uid}',false);`);
 const hex=n=>n.toString(16).padStart(24,'0');
 const uid='00000000-0000-0000-0000-000000000001';
 await db.query('insert into auth.users(id) values($1)',[uid]);
 await db.exec(`insert into tix_catalog(event_id,event_date,url,city,state) select lpad(to_hex(g),24,'0'),current_date+5,'https://gametime.co/x/events/'||lpad(to_hex(g),24,'0'),'Minneapolis','MN' from generate_series(1,700) g;`);
 const capture=(id,state='metadata_only',min_total=1000)=>JSON.stringify({meta:{event_id:id},state,min_total,listings:[],coverage:{},by_qty:{},groups:[]});
 const finish=async(id,source,state,price)=>{const c=await rpc('tix_claim_capture',[id,source]);assert.equal(c.state,'checking',`${source} claim for ${id}: ${JSON.stringify(c)}`);return rpc('tix_finish_capture',[c.token,capture(id,state,price)]);};

 // Release settings: enabled at the approved 5,000/day budget.
 const guard=await one('select * from tix_provider_guard');
 assert.deepEqual([guard.enabled,guard.allow_catalog,guard.minute_limit,guard.hour_limit,guard.day_limit],[true,true,40,420,5000]);
 assert.equal((await rpc('tix_event_capture_status',['x'])).schema,20261016);

 // Background checks never become "requested" work or fill a queue.
 await finish(hex(1),'discovery','metadata_only',1000);
 assert.equal((await one('select detail_requested from tix_capture_jobs where event_id=$1',[hex(1)])).detail_requested,false);
 await db.exec("update tix_capture_jobs set next_attempt_at=now()-interval '1 second'");
 assert.equal((await one('select count(*)::int n from tix_capture_due(60)')).n,0);
 await db.exec(`insert into tix_capture_jobs(event_id) select lpad(to_hex(g),24,'0') from generate_series(2,601) g on conflict do nothing`);
 await asUser(uid);
 const tracked=await rpc('tix_request_capture',[hex(650),false]);
 assert.equal(tracked.tracked,true);assert.notEqual(tracked.reason,'queue_full');
 await db.exec('reset role');
 assert.deepEqual((await db.query('select event_id from tix_capture_due(60)')).rows.map(r=>r.event_id),[hex(650)]);

 // A tracked check saves history and moves to its cadence.
 await finish(hex(650),'tracked','metadata_only',4200);
 assert.equal((await one('select count(*)::int n from tix_capture_due(60)')).n,0);
 assert.equal((await one('select min_total from tix_catalog where event_id=$1',[hex(650)])).min_total,4200);

 // Long browsing sessions roll the oldest tracking off instead of failing.
 await db.exec(`insert into tix_history_tracking(owner_id,event_id,created_at) select '${uid}',lpad(to_hex(g),24,'0'),now()-interval '1 day'+g*interval '1 second' from generate_series(100,310) g on conflict do nothing`);
 await asUser(uid);
 const latest=await rpc('tix_request_capture',[hex(690),false]);
 assert.equal(latest.tracked,true);
 await db.exec('reset role');
 assert.equal((await one('select count(*)::int n from tix_history_tracking where owner_id=$1',[uid])).n,200);
 assert.equal((await one('select count(*)::int n from tix_history_tracking where event_id=$1',[hex(690)])).n,1);
 assert.equal((await one('select count(*)::int n from tix_history_tracking where event_id=$1',[hex(100)])).n,0);

 // A fresh saved price answers a search without a provider request.
 const cached=await rpc('tix_claim_capture',[hex(650),'edge']);
 assert.equal(cached.state,'cached');assert.equal(cached.min_total,4200);assert.ok(cached.checked_at);
 assert.equal((await one('select count(*)::int n from tix_capture_leases')).n,0);

 // Several events may be checked at once; one lease per event; bounded total.
 const a=await rpc('tix_claim_capture',[hex(10),'edge']),b=await rpc('tix_claim_capture',[hex(11),'edge']);
 assert.equal(a.state,'checking');assert.equal(b.state,'checking');
 assert.equal((await rpc('tix_claim_capture',[hex(10),'collector'])).reason,'provider_busy');
 await db.exec('update tix_provider_guard set max_concurrent=2');
 assert.equal((await rpc('tix_claim_capture',[hex(12),'edge'])).reason,'provider_busy');
 await db.exec('update tix_provider_guard set max_concurrent=6');

 // Background sources stop at their share; searches keep the reserve.
 await db.exec('update tix_provider_guard set minute_limit=4,background_share=0.75');
 const bg=await rpc('tix_claim_capture',[hex(13),'discovery']);
 for(let i=0;i<3;i++)assert.equal((await rpc('tix_admit_provider_http',[bg.token])).allowed,true);
 const denied=await rpc('tix_admit_provider_http',[bg.token]);
 assert.equal(denied.allowed,false);assert.equal(denied.reason,'request_limit');
 assert.equal((await rpc('tix_admit_provider_http',[a.token])).allowed,true);
 assert.equal((await rpc('tix_admit_provider_http',[b.token])).allowed,false);
 // A request-limit release retries within the minute, not after 15 minutes.
 await rpc('tix_release_capture',[b.token,'request_limit']);
 const retry=await one(`select next_attempt_at<now()+interval '2 minutes' soon,reason from tix_capture_jobs where event_id=$1`,[hex(11)]);
 assert.equal(retry.soon,true);assert.equal(retry.reason,'request_limit');
 await rpc('tix_release_capture',[a.token,'capture_failed']);await rpc('tix_release_capture',[bg.token,'request_limit']);
 await db.exec('update tix_provider_guard set minute_limit=40;delete from tix_provider_http');

 // Alert checks keep their own cadence; tracked history waits for its turn.
 await db.exec(`update tix_capture_jobs set next_attempt_at=now()+interval '6 hours',reason=null where event_id='${hex(20)}'`);
 await db.exec(`insert into tix_capture_jobs(event_id,next_attempt_at) values('${hex(20)}',now()+interval '6 hours') on conflict do nothing`);
 assert.equal((await rpc('tix_claim_capture',[hex(20),'tracked'])).state,'queued');
 const watch=await rpc('tix_claim_capture',[hex(20),'collector']);assert.equal(watch.state,'checking');
 await rpc('tix_release_capture',[watch.token,'capture_interrupted']);

 // A metadata page without a get-in amount keeps the saved price.
 await finish(hex(30),'edge','metadata_only',2500);
 await db.exec(`update tix_catalog set price_checked_at=now()-interval '1 hour' where event_id='${hex(30)}';update tix_event_observations set checked_at=now()-interval '1 hour' where event_id='${hex(30)}'`);
 await finish(hex(30),'edge','metadata_only',null);
 const kept=await one(`select min_total,price_checked_at<now()-interval '30 minutes' old from tix_catalog where event_id=$1`,[hex(30)]);
 assert.equal(kept.min_total,2500);assert.equal(kept.old,true);

 // Fallback one-off requests: one pending per event, cleared when saved, never tracked.
 await asUser(uid);
 assert.equal(await rpc('tix_request_price_check',[hex(40)]),true);
 assert.equal(await rpc('tix_request_price_check',[hex(40)]),false);
 assert.equal(await rpc('tix_request_price_check',['not-an-event']),false);
 await db.exec('reset role');
 assert.equal((await db.query('select event_id from tix_capture_due(60)')).rows[0].event_id,hex(40));
 assert.equal((await one('select count(*)::int n from tix_history_tracking where event_id=$1',[hex(40)])).n,0);
 await finish(hex(40),'tracked','metadata_only',3100);
 assert.equal((await one('select detail_requested from tix_capture_jobs where event_id=$1',[hex(40)])).detail_requested,false);

 // The optional browser detail worker only serves events someone opened.
 await finish(hex(70),'edge','metadata_only',1800);
 assert.equal(await rpc('tix_claim_detail_dispatch',[hex(70)]),false);
 await db.query('insert into tix_history_tracking(owner_id,event_id) values($1,$2)',[uid,hex(70)]);
 assert.equal(await rpc('tix_claim_detail_dispatch',[hex(70)]),true);
 assert.equal(await rpc('tix_claim_detail_dispatch',[hex(70)]),false);

 // Team/artist pages update existing events only, with bounded daily history.
 await db.exec(`update tix_catalog set event_date=current_date+90 where event_id in ('${hex(51)}','${hex(52)}')`);
 await db.query('insert into tix_history_tracking(owner_id,event_id) values($1,$2)',[uid,hex(52)]);
 const rows=[{event_id:hex(50),min_total:1500},{event_id:hex(51),min_total:1600},{event_id:hex(52),min_total:1700},{event_id:'f'.repeat(24),min_total:900},{event_id:hex(53),min_total:0},{event_id:hex(54),min_total:null}];
 assert.deepEqual(await rpc('tix_apply_get_in_prices',[JSON.stringify(rows),'catalog']),{updated:3,history:2});
 assert.equal((await one('select min_total,discovery_status from tix_catalog where event_id=$1',[hex(50)])).discovery_status,'metadata_only');
 assert.equal((await one('select count(*)::int n from tix_catalog where event_id=$1',['f'.repeat(24)])).n,0);
 assert.equal((await one('select count(*)::int n from tix_event_observations where event_id=$1',[hex(51)])).n,0);
 assert.deepEqual(await rpc('tix_apply_get_in_prices',[JSON.stringify(rows.slice(0,1)),'catalog']),{updated:1,history:0});
 const point=(await db.query("select * from tix_event_price_history($1,0,'provider_get_in_tax_quantity_unconfirmed')",[hex(50)])).rows;
 assert.equal(point.at(-1).price_cents,1500);
 await assert.rejects(rpc('tix_apply_get_in_prices',[JSON.stringify(rows),'edge']));

 // Discovery skips events priced by a team/artist page in the last day.
 assert.equal((await db.query('select event_id from tix_discovery_due(0,7,40)')).rows.some(r=>r.event_id===hex(50)),false);

 // Performer paths are validated, deduplicated and capped.
 assert.equal(await rpc('tix_note_performers',[['/minnesota-vikings-tickets/performers/nflmin','/nfl-football/vikings-tickets/performers/nflmin','/minnesota-vikings-tickets/performers/nflmin','/bad path/performers/x','javascript:alert(1)']]),2);
 assert.equal(await rpc('tix_note_performers',[['/minnesota-vikings-tickets/performers/nflmin']]),0);

 // Public and signed-in roles cannot write prices, performers or capture state.
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  await assert.rejects(rpc('tix_apply_get_in_prices',[JSON.stringify(rows),'catalog']));
  await assert.rejects(rpc('tix_note_performers',[['/a-tickets/performers/abc']]));
  await assert.rejects(rpc('tix_claim_capture',[hex(60),'edge']));
  await assert.rejects(db.query('select * from tix_performers'));
  assert.equal((await rpc('tix_event_capture_status',[hex(60)])).schema,20261016);
  await db.exec('reset role');
 }
 await db.exec('set role anon');
 await assert.rejects(rpc('tix_request_price_check',[hex(61)]));
 await assert.rejects(rpc('tix_request_capture',[hex(61),false]));
 await db.exec('reset role');
 await db.close();console.log('Fast search, tracking, budget share and directory history tests passed.');
})().catch(e=>{console.error(e);process.exit(1)});
