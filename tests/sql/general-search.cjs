const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,created_at timestamptz default now(),last_sign_in_at timestamptz,encrypted_password text,raw_app_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
await db.exec(fs.readFileSync('scripts/tickets_schema.sql','utf8'));
for(const file of ['20260910_alert_reliability.sql','20260910_per_alert_destinations.sql','20260927_criteria_lifecycle.sql','20260927_ticket_intelligence.sql','20260928_public_discovery.sql','20260928_discovery_interest.sql','20260928_email_delivery.sql','20260928_provider_metadata.sql','20260928_signed_in_catalog.sql','20261007_hardening.sql','20261011_listing_fields.sql','20261012_guarded_history.sql','20261016_fast_search.sql','20261017_moved_events.sql','20261017_catalog_reliability.sql','20261017_coverage_query.sql','20261017_admin.sql','20261018_general_search.sql'])await db.exec(fs.readFileSync('scripts/'+file,'utf8').replace(/^.*(?:create extension.*pg_trgm|create index.*gin_trgm_ops).*$/gm,''));
const rpc=async(name,args=[]) => (await db.query(`select * from public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args)).rows;
const id=n=>n.toString(16).padStart(24,'0');
for(const [code,category,label] of [['cbbwis','college-basketball','Wisconsin Basketball'],['cfbwis','college-football','Wisconsin Football'],['mlbmil','mlb-baseball','Milwaukee Brewers'],['nbamil','nba-basketball','Milwaukee Bucks'],['nflgnb','nfl-football','Green Bay Packers'],['cbbspringhill','college-basketball','Spring Hill Badgers'],['nflmin','nfl-football','Minnesota Vikings']])await db.query(`insert into tix_teams(team_id,category,label,path,aliases) values($1,$2,$3,'/team/performers/'||$1,ARRAY[$3])`,[code,category,label]);
await db.exec(fs.readFileSync('scripts/20261018_general_search.sql','utf8'));
const events=[
 ['college-basketball','Wisconsin Badgers at Nebraska','NE','cbbwis'],
 ['college-football','Wisconsin Badgers at Iowa','IA','cfbwis'],
 ['mlb-baseball','Brewers at Cardinals','MO','mlbmil'],
 ['nba-basketball','Bucks at Celtics','MA','nbamil'],
 ['nfl-football','Packers at Vikings','MN','nflgnb'],
 ['concert','John Mayer','WI',null],
 ['concert','John Mulaney','NY',null],
 ['college-basketball','Spring Hill Badgers at Other','AL','cbbspringhill']];
for(let i=0;i<events.length;i++){let [cat,name,state,team]=events[i];await db.query(`insert into tix_catalog(event_id,event_date,url,category,name,slug,state,city,min_total,price_checked_at) values($1,current_date+3,'https://gametime.co/events/'||$1,$2,$3,$4,$5,'Test City',case when $6 then 2500 else null end,case when $6 then now() else null end)`,[id(i+1),cat,name,name.toLowerCase().replaceAll(' ','-'),state,i!==1]);if(team)await db.query('insert into tix_team_events(team_id,event_id,is_home) values($1,$2,false)',[team,id(i+1)]);}
await db.query(`insert into tix_catalog(event_id,event_date,url,category,name,state) values($1,current_date+3,'x','pwhl','Professional womens hockey','MN')`,[id(11)]);
await db.exec('set role anon');
const search=async(q,cat=null,region=null,offset=0,limit=100)=>rpc('tix_general_search',[q,cat,region,null,null,null,null,null,null,false,offset,limit]);
assert.deepEqual((await search('Wisconsin',null,'WI')).map(x=>x.event_id),[1,2,3,4,5,6].map(id));
assert.deepEqual((await search('Badgers')).map(x=>x.event_id),[1,2].map(id),'UW sports, not Spring Hill or other Wisconsin campuses');
assert.deepEqual((await search('john m')).map(x=>x.event_id),[6,7].map(id));
assert.deepEqual((await search('concerts')).map(x=>x.event_id),[6,7].map(id));
assert.equal((await search('', 'all-sports')).length,7);assert.equal((await search('Wisconsin','all-sports','WI')).length,5);
assert.deepEqual((await search('Wisconsin','nfl-football','WI')).map(x=>x.event_id),[id(5)]);
assert.deepEqual((await search('Wisconsin',null,'WI',2,2)).map(x=>x.event_id),[3,4].map(id));
assert.equal((await rpc('tix_general_search',['Wisconsin',null,'WI','WI'])).length,1,'Explicit location narrows a regional team search to games in that place');
assert.equal((await rpc('tix_general_search',['Badgers',null,null,null,null,null,null,2000])).length,0);
assert.equal((await rpc('tix_general_search',['Badgers',null,null,null,null,null,null,null,new Date().toISOString()])).length,0);
assert.equal((await search('x\';drop table auth.users;--')).length,0);
await assert.rejects(db.query('select * from tix_admins'));await assert.rejects(db.query('select * from tix_watches'));
await db.exec('reset role');
// Confirmed home-state evidence generalizes beyond the curated Wisconsin associations.
await db.query(`insert into tix_catalog(event_id,event_date,url,category,name,state) values($1,current_date+3,'x','nfl-football','Vikings home','MN')`,[id(10)]);
await db.query('insert into tix_team_events(team_id,event_id,is_home) values($1,$2,true)',['nflmin',id(10)]);
assert.ok((await rpc('tix_match_search_teams',['Minnesota',null,'MN',100])).some(x=>x.team_id==='nflmin'));
// No duplicate events when several matching teams play one another.
await db.query('insert into tix_team_events(team_id,event_id,is_home) values($1,$2,true)',['nflgnb',id(1)]);
assert.equal((await search('Wisconsin',null,'WI')).length,6);
await db.close();console.log('General search: regional home/away teams, UW aliases, artists, sports/categories, pagination, budgets, location, injection and private-data isolation passed.');
})().catch(e=>{console.error(e);process.exit(1)});
