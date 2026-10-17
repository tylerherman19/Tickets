const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs'),assert=require('node:assert/strict');
// Full chain, idempotency, public/private boundaries and missing-data safety.
(async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 await db.exec(fs.readFileSync('scripts/tickets_schema.sql','utf8'));
 for(const file of ['20260910_alert_reliability.sql','20260910_per_alert_destinations.sql','20260927_criteria_lifecycle.sql','20260927_ticket_intelligence.sql','20260928_public_discovery.sql','20260928_discovery_interest.sql','20260928_email_delivery.sql','20260928_provider_metadata.sql','20260928_signed_in_catalog.sql','20261007_hardening.sql','20261011_listing_fields.sql','20261012_guarded_history.sql','20261016_fast_search.sql','20261017_moved_events.sql','20261017_catalog_reliability.sql','20261017_catalog_reliability.sql'])
  await db.exec(fs.readFileSync('scripts/'+file,'utf8').replace(/^.*(?:create extension.*pg_trgm|create index.*gin_trgm_ops).*$/gm,''));
 const rpc=async(name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const rows=async(name,args=[]) => (await db.query(`select * from public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args)).rows;
 const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 const id=n=>n.toString(16).padStart(24,'0'),uid='00000000-0000-0000-0000-000000000001';
 const auth=()=>db.exec(`set role authenticated;select set_config('test.uid','${uid}',false);`);
 await db.query('insert into auth.users(id) values($1)',[uid]);
 await db.exec(`insert into tix_catalog(event_id,event_date,url,category,min_total,price_checked_at,name)
 select lpad(to_hex(g),24,'0'),current_date+case when g=4 then 364 when g=5 then 366 else 5 end,'https://gametime.co/x/events/'||lpad(to_hex(g),24,'0'),'college-basketball',case when g=1 then 1000 else null end,case when g=1 then now() else null end,'Game '||g from generate_series(1,6) g;`);
 const team=(code,label,aliases)=>({team_id:code,label,aliases,category:'college-basketball',path:'/team-'+code+'/performers/'+code});
 assert.equal(await rpc('tix_upsert_teams',[JSON.stringify([team('cbbwis','Wisconsin Badgers Basketball',['Wisconsin','Badgers','UW']),team('cbbwash','Washington Huskies Basketball',['Washington','Huskies','UW']),team('cbbnc','North Carolina Bulldogs',['Bulldogs']),team('cbbga','Georgia Bulldogs',['Bulldogs']),{...team('wrong','Bad path',[]),path:'/wrong/performers/other'}])]),4);
 assert.deepEqual((await rows('tix_resolve_teams',['UW','college-basketball',12])).map(x=>x.team_id).sort(),['cbbwash','cbbwis']);
 assert.deepEqual((await rows('tix_resolve_teams',['Badgers','college-basketball',12])).map(x=>x.team_id),['cbbwis']);
 assert.equal((await rows('tix_resolve_teams',['','college-basketball',1200])).length,4);
 assert.equal((await rows('tix_resolve_teams',['cbbwis','college-basketball',12]))[0].team_id,'cbbwis');
 assert.equal(await rpc('tix_link_team_events',['cbbwis',JSON.stringify([{event_id:id(1),is_home:true},{event_id:id(2),is_home:false},{event_id:id(4),is_home:null},{event_id:id(5),is_home:true}]),true]),3);
 const schedule=await rows('tix_search_team_events',['cbbwis',200]);
 assert.deepEqual(schedule.map(x=>[x.event_id,x.is_home]),[[id(1),true],[id(2),false],[id(4),null]]);
 assert.equal(schedule[0].name,'Game 1');
 await db.exec('set role anon');
 assert.equal((await rpc('tix_catalog_health',[null])).events,5);
 assert.equal((await rpc('tix_catalog_health',[null])).unpriced,4);
 for(const table of ['tix_teams','tix_team_events','tix_team_demand','tix_search_request_limits'])await assert.rejects(db.query('select * from '+table));
 await assert.rejects(rpc('tix_upsert_teams',['[]']));await assert.rejects(rpc('tix_prioritize_search',['UW','college-basketball',null,[]]));
 await db.exec('reset role');await auth();
 const priority=await rpc('tix_prioritize_search',['','college-basketball','cbbwis',[id(6)]]);
 assert.equal(priority.state,'queued');assert.equal(priority.teams,1);assert.equal(priority.events,3);
 await db.exec('reset role');
 // Foreground demand covers an entire 365-day season; recent directory prices do not need per-event duplicate work.
 assert.deepEqual((await rows('tix_team_refresh_due',[null,12])).map(x=>x.team_id),[],'freshly inspected teams are not fetched again inside fifteen minutes');
 await db.exec("update tix_teams set checked_at=now()-interval '1 hour' where team_id='cbbwis'");
 assert.deepEqual((await rows('tix_team_refresh_due',[null,12])).map(x=>x.team_id),['cbbwis']);
 assert.deepEqual((await db.query('select event_id from tix_capture_due(60)')).rows.map(x=>x.event_id).sort(),[id(2),id(4),id(6)]);
 await rpc('tix_link_team_events',['cbbwis','[]',true]);assert.deepEqual(await rows('tix_team_refresh_due',[null,12]),[]);
 // User activity does not clear provider backoff or suspensions.
 await db.exec(`update tix_capture_jobs set reason='redirected',next_attempt_at=now()+interval '1 day' where event_id='${id(2)}';update tix_provider_guard set suspended_at=now(),suspension_reason='HTTP_429'`);
 await auth();await rpc('tix_prioritize_search',['','college-basketball','cbbwis',[]]);await db.exec('reset role');
 assert.ok((await one('select next_attempt_at>now()+interval \'23 hours\' safe from tix_capture_jobs where event_id=$1',[id(2)])).safe);
 assert.equal((await rpc('tix_catalog_health',[null])).provider_paused,true);
 // Demand volume is bounded per owner, regardless of team chosen.
 await auth();for(let n=0;n<8;n++)await rpc('tix_prioritize_search',['','college-basketball','cbbwis',[]]);
 assert.equal((await rpc('tix_prioritize_search',['','college-basketball','cbbwis',[]])).state,'rate_limited');
 await db.exec('reset role');
 // Saved listings: two known bases, an unknown lot, a 4-seat lot that does
 // not permit splitting into pairs, and another event/section must not mix.
 const obs=await one(`insert into tix_event_observations(event_id,source,state,checked_at,min_total,listing_count,coverage) values($1,'detail','partial',now()-interval '1 day',500,6,'{"complete":false,"unknown_lots":1}') returning id`,[id(1)]);
 const listings=[
  ['known-pair',1200,'fees_included_tax_reported',[2],['1','2'],'Club','A',null],
  ['unknown-tax',1000,'fees_included_tax_unknown',[2],['3','4'],'Upper','B',null],
  ['unknown-lots',100,'fees_included_tax_reported',null,['5','6'],'Club','A',null],
  ['nondivisible-four',200,'fees_included_tax_reported',[4],['7','8','9','10'],'Club','A',null],
  ['unknown-basis',50,'opaque',[2],['11','12'],'Club','A',null],
  ['verified-dom',1500,'fees_included_tax_reported',null,null,'Club','C',2]];
 for(let i=0;i<listings.length;i++){const [lid,price,basis,lots,seats,group,section,qty]=listings[i];await db.query(`insert into tix_listing_observations(observation_id,ordinal,listing_id,price_cents,basis,lots,seats,section_group,section,verified_quantity,provider) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}')`,[obs.id,i+1,lid,price,basis,lots,seats==null?null:JSON.stringify(seats),group,section,qty]);}
 const exact=(await rows('tix_search_quantity_prices',[[id(1),id(2)],2]));
 assert.equal(exact[0].price_cents,1000);assert.equal(exact[0].basis,'fees_included_tax_unknown');assert.equal(exact[0].listing_count,1);
 assert.equal(exact[1].price_cents,null);assert.equal(exact[1].state,'unconfirmed');
 const club=await rows('tix_event_comparable_history',[id(1),2,'fees_included_tax_reported','Club']);
 assert.equal(club.length,1);assert.equal(club[0].price_cents,1200);assert.equal(club[0].listing_count,2);assert.equal(club[0].section,'Club');
 assert.equal((await rows('tix_event_comparable_history',[id(1),2,'fees_included_tax_unknown','Club'])).length,0);
 assert.equal((await rows('tix_event_comparable_history',[id(1),2,'fees_included_tax_reported','C']))[0].price_cents,1500);
 assert.equal((await rows('tix_event_comparable_history',[id(1),4,'fees_included_tax_reported','Club']))[0].price_cents,200);
 assert.equal((await rows('tix_event_comparable_history',[id(2),2,'fees_included_tax_reported','Club'])).length,0);
 assert.equal((await rows('tix_event_comparable_history',[id(1),0,'provider_get_in_tax_quantity_unconfirmed','Club'])).length,0);
 // New directory metadata cannot freshen or erase older quantity evidence.
 await rpc('tix_apply_get_in_prices',[JSON.stringify([{event_id:id(1),min_total:999}]),'catalog']);
 assert.ok(new Date((await rows('tix_search_quantity_prices',[[id(1)],2]))[0].checked_at)<new Date(Date.now()-23*3600000));
 // All public output stays aggregate/market-only; private request users never leak.
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  const health=await rpc('tix_catalog_health',[null]);assert.equal(JSON.stringify(health).includes(uid),false);assert.equal(JSON.stringify(health).includes('HTTP_429'),false);
  assert.equal((await rows('tix_search_quantity_prices',[[id(1)],2]))[0].price_cents,1000);
  await assert.rejects(rpc('tix_team_refresh_due',[null,12]));await assert.rejects(rpc('tix_team_check_failed',['cbbwis','error']));
  await db.exec('reset role');
 }

 // A multi-game alert keeps simultaneous samples for every comparable series.
 const watch=await one(`insert into tix_watches(owner_id,label,kind,match,qty,threshold_cents) values($1,'Team watch','team','{"slug":"badgers"}',2,2000) returning id`,[uid]);
 const samplePairs=[[id(1),'Club',2,'fees_included_tax_reported'],[id(2),'Club',2,'fees_included_tax_reported'],[id(1),'Upper',2,'fees_included_tax_reported'],[id(1),'Club',4,'fees_included_tax_reported'],[id(1),'Club',2,'fees_included_tax_unknown']];
 for(const [eid,club,qty,basis] of samplePairs){for(const price of [1300,1200])await db.query(`insert into tix_prices(watch_id,event_id,club,qty,basis,price_cents,checked_at) values($1,$2,$3,$4,$5,$6,date_trunc('hour',now())-interval '1 hour'+case when $6=1200 then interval '2 minutes' else interval '1 minute' end)`,[watch.id,eid,club,qty,basis,price]);}
 await auth();const activity=await rows('tix_alert_history',[watch.id,'7d',null]);await db.exec('reset role');
 assert.equal(activity.length,5);assert.ok(activity.every(r=>r.price_cents===1200));
 await db.exec('set role anon');await assert.rejects(rows('tix_alert_history',[watch.id,'7d',null]));await db.exec('reset role');
 assert.equal((await one('select expiry_enabled from tix_provider_guard')).expiry_enabled,false);
 await db.close();console.log('Catalog identities, demand, coverage, exact quantities and comparable history tests passed.');
})().catch(e=>{console.error(e);process.exit(1)});
