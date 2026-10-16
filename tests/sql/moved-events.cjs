const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs'),assert=require('node:assert/strict');
// Applies the full migration chain plus 20261017_moved_events.sql (twice) and
// exercises moved event links and redirect back-off. No network.
(async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 await db.exec(fs.readFileSync('scripts/tickets_schema.sql','utf8'));
 for(const file of ['20260910_alert_reliability.sql','20260910_per_alert_destinations.sql','20260927_criteria_lifecycle.sql','20260927_ticket_intelligence.sql','20260928_public_discovery.sql','20260928_discovery_interest.sql','20260928_email_delivery.sql','20260928_provider_metadata.sql','20260928_signed_in_catalog.sql','20261007_hardening.sql','20261011_listing_fields.sql','20261012_guarded_history.sql','20261016_fast_search.sql','20261017_moved_events.sql','20261017_moved_events.sql'])
  await db.exec(fs.readFileSync('scripts/'+file,'utf8').replace(/^.*(?:create extension.*pg_trgm|create index.*gin_trgm_ops).*$/gm,''));
 const rpc=async(name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 const hex=n=>n.toString(16).padStart(24,'0');
 const link=(id,date='11-9-2026')=>`https://gametime.co/nfl-football/bills-at-vikings-tickets/${date}-minneapolis-mn-u-s-bank-stadium/events/${id}`;
 await db.exec(`insert into tix_catalog(event_id,event_date,url,city,state) select lpad(to_hex(g),24,'0'),current_date+20,
  'https://gametime.co/nfl-football/bills-at-vikings-tickets/11-9-2026-minneapolis-mn-u-s-bank-stadium/events/'||lpad(to_hex(g),24,'0'),'Minneapolis','MN' from generate_series(1,40) g;`);
 const claim=async(id,source='edge')=>{const c=await rpc('tix_claim_capture',[id,source]);assert.equal(c.state,'checking',`${source} claim for ${id}: ${JSON.stringify(c)}`);return c.token;};
 const capture=id=>JSON.stringify({meta:{event_id:id},state:'metadata_only',min_total:1000,listings:[],coverage:{},by_qty:{},groups:[]});
 const job=id=>one(`select state,reason,redirects,round(extract(epoch from next_attempt_at-now())/3600) hours from tix_capture_jobs where event_id=$1`,[id]);
 const url=async id=>(await one('select url from tix_catalog where event_id=$1',[id])).url;
 const leases=async()=>(await one('select count(*)::int n from tix_capture_leases')).n;
 // Each test step runs as a later transaction; move redirect times into the past.
 const later=()=>db.exec(`update tix_capture_jobs set redirected_at=redirected_at-interval '1 minute';update tix_event_observations set checked_at=checked_at-interval '1 minute'`);

 // A redirect to the same event's page saves the new link; it can be re-checked at once.
 const a=hex(1);
 const moved=await rpc('tix_note_redirect',[await claim(a),link(a,'11-8-2026')]);
 assert.deepEqual([moved.state,moved.reason],['queued','url_moved']);assert.ok(moved.next_attempt_at);
 assert.equal(await url(a),link(a,'11-8-2026'));
 assert.deepEqual(await job(a),{state:'queued',reason:'url_moved',redirects:1,hours:'0'});
 assert.equal(await leases(),0);
 assert.equal((await one(`select count(*)::int n from tix_event_observations where event_id=$1`,[a])).n,0);
 // The re-check uses the new link and resets the streak once a page is read.
 await later();
 await rpc('tix_finish_capture',[await claim(a),capture(a)]);
 await later();
 assert.equal((await rpc('tix_note_redirect',[await claim(a,'collector'),link(a,'11-7-2026')])).reason,'url_moved');
 assert.equal((await job(a)).redirects,1);

 // Anything that is not this event on gametime.co backs off and keeps the link.
 const elsewhere=['https://evil.test/events/'+hex(2),link(hex(3)),link(hex(2))+'?quantity=2','https://gametime.co/a/../events/'+hex(2),
  'https://gametime.co:8443/events/'+hex(2),'http://gametime.co/events/'+hex(2),'https://gametime.co/minnesota-vikings-tickets/performers/nflmin',
  link(hex(2)),'https://gametime.co/'+'x'.repeat(500)+'/events/'+hex(2),null];
 for(const location of elsewhere){
  const id=hex(2),before=await url(id);
  await db.exec(`update tix_capture_jobs set next_attempt_at=now()-interval '1 second',redirects=0,redirected_at=null where event_id='${id}'`);
  const result=await rpc('tix_note_redirect',[await claim(id),location]);
  assert.deepEqual([result.state,result.reason],['failed','redirected'],String(location));
  assert.equal(await url(id),before,String(location));
  assert.deepEqual(await job(id),{state:'failed',reason:'redirected',redirects:1,hours:'6'},String(location));
 }
 assert.equal(await leases(),0);
 const b=hex(2);
 assert.ok((await one(`select discovery_attempt_at>now()-interval '1 minute' recent from tix_catalog where event_id=$1`,[b])).recent);
 assert.equal((await one(`select count(*)::int n from tix_event_observations where event_id=$1 and state='failed' and meta->>'reason'='redirected'`,[b])).n,elsewhere.length);
 // Searches, alert checks and tracked history all respect the back-off: no lease, no request.
 for(const source of ['edge','collector','tracked','discovery']){
  const deferred=await rpc('tix_claim_capture',[b,source]);
  assert.deepEqual([deferred.state,deferred.reason],['queued','redirected'],source);
 }
 assert.equal(await leases(),0);

 // Repeated redirects back off longer, up to a week.
 const c=hex(4),hours=[];
 for(let i=0;i<7;i++){
  await db.exec(`update tix_capture_jobs set next_attempt_at=now()-interval '1 second' where event_id='${c}'`);
  await rpc('tix_note_redirect',[await claim(c),null]);hours.push((await job(c)).hours);await later();
 }
 assert.deepEqual(hours,['6','12','24','48','96','168','168']);

 // A link that keeps moving without ever loading stops being followed after two moves.
 const d=hex(5),results=[];
 for(let i=0;i<3;i++){
  await db.exec(`update tix_capture_jobs set next_attempt_at=now()-interval '1 second' where event_id='${d}'`);
  results.push((await rpc('tix_note_redirect',[await claim(d,'collector'),link(d,i%2?'11-8-2026':'11-7-2026')])).reason);await later();
  // A team-page price is not a successful read of this event's page.
  if(!i)assert.equal((await rpc('tix_apply_get_in_prices',[JSON.stringify([{event_id:d,min_total:1500}]),'catalog'])).history,1);
 }
 assert.deepEqual(results,['url_moved','url_moved','redirected']);
 assert.equal(await url(d),link(d,'11-8-2026'));
 assert.equal((await job(d)).hours,'24');

 // A new link from the sitemap refresh clears the back-off; an unchanged link does not.
 const sitemap=(id,u)=>db.query('insert into tix_catalog(event_id,url) values($1,$2) on conflict(event_id) do update set url=excluded.url',[id,u]);
 await sitemap(c,await url(c));
 assert.equal((await rpc('tix_claim_capture',[c,'edge'])).reason,'redirected');
 await sitemap(c,link(c,'11-8-2026'));
 assert.deepEqual(await job(c),{state:'failed',reason:'redirected',redirects:0,hours:'0'});
 await rpc('tix_release_capture',[await claim(c),'capture_interrupted']);
 // Other events keep their own schedule when their link is refreshed.
 await db.exec(`update tix_capture_jobs set next_attempt_at=now()+interval '3 hours',reason='capture_failed' where event_id='${a}'`);
 await sitemap(a,link(a,'11-6-2026'));
 assert.equal((await job(a)).hours,'3');

 // Only a live lease can report a redirect; public roles cannot call it.
 await assert.rejects(rpc('tix_note_redirect',['00000000-0000-0000-0000-000000000000',link(hex(6))]),/lease expired/);
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  await assert.rejects(rpc('tix_note_redirect',['00000000-0000-0000-0000-000000000000',link(hex(6))]));
  await db.exec('reset role');
 }
 console.log('Moved event links and redirect back-off tests passed.');
})().catch(error=>{console.error(error);process.exit(1);});
