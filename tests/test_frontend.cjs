const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const code=fs.readFileSync('tickets.js','utf8');
const sandbox={URL,URLSearchParams,Intl,Date,Number,AbortSignal,console};vm.createContext(sandbox);vm.runInContext(code,sandbox);
function run(expr){return vm.runInContext(expr,sandbox);}
test('prices retain cents and unknown prices are not zero',()=>{assert.equal(run('money(10050)'),'$100.50');assert.equal(run('money(null)'),'—');});
test('total budget maps to a seller-supported per-ticket threshold without overspending',()=>{
 assert.equal(run('perTicketTargetCents("400",4,"total")'),10000);
 assert.equal(run('perTicketTargetCents("400",3,"total")'),13333);
 assert.equal(run('perTicketTargetCents("100",4,"per")'),10000);
});
test('listing links reject script and unrelated hosts',()=>{for(const s of ['javascript:alert(1)','https://evil.example/','https://gametime.co.evil.example',''])assert.equal(run(`safeUrl(${JSON.stringify(s)})`),'');assert.equal(run('safeUrl("/events/abc")'),'https://gametime.co/events/abc');});
test('check ages read naturally',()=>{const at=d=>JSON.stringify(new Date(Date.now()-d*86400000).toISOString());assert.equal(run(`ago(${at(1.5)})`),'1 day ago');assert.equal(run(`ago(${at(3.2)})`),'3 days ago');});
test('date-only events keep their calendar date',()=>{assert.equal(run('dateObj("2026-09-13").getDate()'),13);});
test('phone numbers normalize and format safely',()=>{assert.equal(run('normalizeUSPhone("+1 (612) 555-0148")'),'6125550148');assert.equal(run('formatPhone("6125550148")'),'(612) 555-0148');assert.equal(run('normalizeUSPhone("123")'),'');});
test('Xfinity Mobile has a dedicated carrier label',()=>{assert.equal(run('carrierName("xfinity")'),'Xfinity Mobile');});
test('untrusted labels cannot create markup',()=>{assert.equal(run('esc("<img onerror=\\\"bad\\\">&")'),'&lt;img onerror=&quot;bad&quot;&gt;&amp;');});
const app=fs.readFileSync('app.js','utf8');const start=app.indexOf('function watchLatest(');const end=app.indexOf('function renderWatches(');vm.runInContext('const state={prices:[],scans:[]};'+app.slice(start,end),sandbox);
const queryStart=app.indexOf('function catalogQuery('),queryEnd=app.indexOf('async function loadEvents(');
vm.runInContext(app.slice(queryStart,queryEnd),sandbox);
test('clearing search cannot leave an invisible filter active',()=>{
 const controls=Object.fromEntries(['search-form','event-search','category','place','event-date','max-price','within','clear-filters'].map(id=>['#'+id,{value:''}]));
 sandbox.controls=controls;sandbox.document={querySelector:selector=>controls[selector],querySelectorAll:()=>[]};sandbox.loadCalls=0;
 vm.runInContext(app.slice(app.indexOf('function bindSearch('),queryStart),sandbox);
 run('state.search="old search";state.offset=12;bindSearch(()=>{loadCalls++});controls["#event-search"].oninput({target:controls["#event-search"]})');
 assert.equal(run('state.search'),'');assert.equal(run('state.offset'),0);assert.equal(sandbox.loadCalls,1);
 assert.doesNotMatch(run('catalogQuery()'),/&or=/);
});
test('homepage pagination retains one order and advances by displayed rows',()=>{
 run('Object.assign(state,{category:"",date:"",search:"",place:"",maxPrice:"",offset:0,catalogSnapshotAt:Date.now()})');
 const first=run('catalogQuery()');run('state.offset=12');const second=run('catalogQuery()');
 assert.match(first,/order=event_date,event_id&limit=13&offset=0/);
 assert.equal(second,first.replace('offset=0','offset=12'));
});
test('price discovery requires a real recent provider check',()=>{
 run('state.maxPrice="100"');const url=run('catalogQuery()');
 assert.match(url,/min_total=lte\.10000/);assert.match(url,/price_checked_at=gte\./);
 assert.doesNotMatch(url,/last_seen=gte\./);
});
test('anonymous cheap discovery uses stable price order and a short upcoming window',()=>{
 run('Object.assign(state,{cheapOnly:true,maxPrice:"",within:"",date:"",offset:0,catalogSnapshotAt:Date.now()})');
 const first=run('catalogQuery()');run('state.offset=12');const second=run('catalogQuery()');
 assert.match(first,/order=min_total,event_date,event_id&limit=13&offset=0/);
 assert.match(first,/min_total=not\.is\.null&price_checked_at=gte\./);
 assert.match(first,/event_date=lte\./);
 assert.equal(second,first.replace('offset=0','offset=12'));
});
test('price discovery can fall back to real catalog events without claiming an unchecked price',()=>{
 run('Object.assign(state,{cheapOnly:true,category:"mlb-baseball",date:"",within:"7",maxPrice:"75",offset:0})');
 const priced=run('catalogQuery()'),fallback=run('catalogQuery(13,true)');
 assert.match(priced,/min_total=lte\.7500/);
 assert.match(priced,/price_checked_at=gte\./);
 assert.doesNotMatch(fallback,/min_total=/);
 assert.doesNotMatch(fallback,/price_checked_at=/);
 assert.match(fallback,/category=eq\.mlb-baseball/);
 assert.match(fallback,/order=event_date,event_id&limit=13&offset=0/);
});
test('the city/state box understands state names, codes and "City, ST"',()=>{
 const place=s=>decodeURIComponent(run(`placeFilter(${JSON.stringify(s)})`));
 assert.equal(place('Wisconsin'),'&state=eq.WI');
 assert.equal(place('wi'),'&state=eq.WI');
 assert.equal(place('new  york'),'&state=eq.NY');
 assert.equal(place('Madison, WI'),'&state=eq.WI&city=ilike.*Madison*');
 assert.equal(place('Green Bay Wisconsin'),'&state=eq.WI&city=ilike.*Green Bay*');
 assert.equal(place('Kansas City'),'&city=ilike.*Kansas City*');
 assert.equal(place('Kansas City, Missouri'),'&state=eq.MO&city=ilike.*Kansas City*');
 assert.equal(place('St. Paul'),'&city=ilike.*St. Paul*');
 assert.equal(place('(*)'),'');
});
test('a state name in the search box also finds events in that state; short words stay name searches',()=>{
 run('Object.assign(state,{cheapOnly:false,category:"",date:"",within:"",maxPrice:"",place:"",offset:0})');
 run('state.search="Wisconsin"');assert.match(decodeURIComponent(run('catalogQuery()')),/&or=\(name\.ilike\."\*Wisconsin\*",slug\.ilike\."\*Wisconsin\*",state\.eq\.WI\)/);
 for(const s of ['LA','in','Vikings']){run(`state.search=${JSON.stringify(s)}`);assert.doesNotMatch(run('catalogQuery()'),/state\.eq/);}
 run('state.search=""');
});
test('searches price every visible stale or unpriced result within the year, once each',()=>{
 const now=new Date().toISOString(),old=new Date(Date.now()-3600000).toISOString(),future=new Date(Date.now()+35*86400000).toISOString().slice(0,10),past='2020-01-01',far=new Date(Date.now()+400*86400000).toISOString().slice(0,10);
 const rows=[{event_id:'a',event_date:future,price_checked_at:null},{event_id:'a',event_date:future,price_checked_at:null},{event_id:'b',event_date:future,min_total:900,price_checked_at:old},{event_id:'c',event_date:future,min_total:null,price_checked_at:now},{event_id:'old',event_date:past,price_checked_at:null},{event_id:'far',event_date:far,price_checked_at:null},{event_id:'fresh',event_date:future,min_total:1200,price_checked_at:now}];
 for(let n=0;n<20;n++)rows.push({event_id:'x'+n,event_date:future,price_checked_at:null});
 sandbox.priceRows=rows;
 const ids=Array.from(run('priceCheckCandidates(priceRows)'));
 assert.deepEqual(ids.slice(0,3),['a','b','c']);
 assert.equal(ids.length,12);
 assert.ok(!ids.includes('fresh')&&!ids.includes('old')&&!ids.includes('far'));
});
test('watch prices stay isolated even for the same event',()=>{run(`state.prices=[{watch_id:'other',event_id:'e',club:'Any section',price_cents:100,qty:2,checked_at:new Date().toISOString()},{watch_id:'mine',event_id:'e',club:'Any section',price_cents:200,qty:2,checked_at:new Date().toISOString(),basis:'fees_included_tax_unknown',criteria_version:1}];state.scans=[{watch_id:'mine',event_id:'e',outcome:'ok',criteria_version:1,checked_at:new Date().toISOString()}]`);assert.equal(run(`watchLatest({id:'mine',qty:2,criteria_version:1,created_at:'2020-01-01'})[0].price_cents`),200);});
test('an unavailable latest scan hides an older listing',()=>{run(`state.scans=[{watch_id:'mine',event_id:'e',outcome:'unavailable',checked_at:new Date().toISOString(),criteria_version:1}]`);assert.equal(run(`watchLatest({id:'mine',qty:2,criteria_version:1,created_at:'2020-01-01'}).length`),0);});
test('changed criteria never display earlier prices',()=>{run(`state.scans=[]`);assert.equal(run(`watchLatest({id:'mine',qty:2,criteria_updated_at:new Date(Date.now()+1000).toISOString()}).length`),0);});
test('marketplace links are encoded search links',()=>{assert.equal(run('eventSearchUrl("tickpick","Packers at Vikings")'),'https://www.tickpick.com/search?q=Packers%20at%20Vikings');});
test('price context explains its time basis',()=>{const now=Date.now();run(`var rows=[{price_cents:15000,basis:'fees_included_tax_unknown',checked_at:new Date(${now}-172800000).toISOString()},{price_cents:14600,basis:'fees_included_tax_unknown',checked_at:new Date(${now}).toISOString()}]`);assert.match(run('priceContext(rows)'),/down \$4 since yesterday/);assert.match(run('priceContext(rows)'),/lowest in 2 days/);});
vm.runInContext(fs.readFileSync('calendar.js','utf8'),sandbox);
test('calendar export preserves event date and escapes labels',()=>{
 const event={event_id:'e',event_date:'2026-10-04',name:'A, B; Show',venue:'Arena',city:'Minneapolis',state:'MN'};
 sandbox.calendarEvent=event;
 const ics=run('makeICS(calendarEvent,"https://example.test/alert")');
 assert.match(ics,/DTSTART;VALUE=DATE:20261004/);
 assert.match(ics,/DTEND;VALUE=DATE:20261005/);
 assert.match(ics,/SUMMARY:A\\, B\\; Show/);
});

const teamStart=app.indexOf('function teamPriceQuery('),teamEnd=app.indexOf('async function loadTeamPriceReference(');
vm.runInContext(app.slice(teamStart,teamEnd),sandbox);
test('team price context shows only recent real game checks',()=>{
 const now=Date.now();sandbox.teamRows=[
  {min_total:10600,price_checked_at:new Date(now-60000).toISOString(),discovery_status:'metadata_only'},
  {min_total:14000,price_checked_at:new Date(now-3600000).toISOString(),discovery_status:'ok'},
  {min_total:9900,price_checked_at:new Date(now-4*86400000).toISOString(),discovery_status:'ok'},
  {min_total:null,price_checked_at:null,discovery_status:'pending'}];
 const result=run('teamPriceSummary(teamRows)');
 assert.equal(result.total,4);assert.equal(result.count,2);assert.equal(result.low,10600);assert.equal(result.average,12300);
});

test('team market query follows the chosen home or away schedule',()=>{
 run('Object.assign(state,{selected:{team:"minnesota-vikings"},category:"nfl-football",homeAway:"home"})');
 assert.equal(new URL('https://example.test/'+run('teamPriceQuery()')).searchParams.get('slug'),'ilike.*-at-minnesota-vikings');
 run('state.homeAway="away"');
 assert.equal(new URL('https://example.test/'+run('teamPriceQuery()')).searchParams.get('slug'),'ilike.minnesota-vikings-at-*');
 run('state.homeAway="any"');
 assert.equal(new URL('https://example.test/'+run('teamPriceQuery()')).searchParams.get('or'),'(slug.ilike.*-at-minnesota-vikings,slug.ilike.minnesota-vikings-at-*)');
});
test('one historical price is not presented as a trend or seven-day low',()=>{
 run('var oneObservation=[{price_cents:10800,checked_at:new Date().toISOString()}]');
 assert.equal(run('priceContext(oneObservation)'),'');
});
test('incomplete provider response separates get-in from exact two-seat price',()=>{
 const watch={active:true,qty:2,threshold_cents:7000};
 const intel={last_checked_at:new Date().toISOString(),scan_outcome:'provider_incomplete'};
 const market={min_total:10800,price_checked_at:new Date().toISOString()};
 sandbox.w=watch;sandbox.intel=intel;sandbox.market=market;
 const message=run('watchDiagnostic(w,intel,null,market)');
 assert.match(message,/get-in is \$108/);
 assert.match(message,/does not verify 2 tickets together/);
 assert.doesNotMatch(message,/no matching tickets/i);
});
test('a newer incomplete scan keeps the previous verified lot labeled as historical',()=>{
 sandbox.watch={kind:'event',qty:2};
 sandbox.previous=[{price_cents:12000,basis:'fees_included_tax_unknown',checked_at:new Date(Date.now()-44*60000).toISOString()}];
 sandbox.scan={outcome:'provider_incomplete'};
 const display=run('watchPriceDisplay(watch,null,previous,scan)');
 assert.equal(display.price_cents,12000);
 assert.equal(display.label,'Previous verified lot');
 assert.match(display.detail,/not verified by the latest check/);
 const current=run('watchPriceDisplay(watch,{price_cents:11100,basis:\'fees_included_tax_unknown\',checked_at:new Date().toISOString()},previous,scan)');
 assert.equal(current.price_cents,11100);
 assert.equal(current.label,'Latest verified lot');
 const team=run('watchPriceDisplay({kind:"team",qty:2},null,previous,scan)');
 assert.equal(team.price_cents,null);
});
const htmlFiles=fs.readdirSync('.').filter(f=>f.endsWith('.html'));
test('every page has a real title, description, social card, CSP and favicon',()=>{
 for(const f of htmlFiles){const html=fs.readFileSync(f,'utf8');
  assert.match(html,/<title>[^<]+ · Ticketline<\/title>/,f);assert.doesNotMatch(html,/Vite|React App|Next\.js/,f);
  for(const re of [/name="description"/,/property="og:image"/,/Content-Security-Policy/,/rel="icon"/])assert.match(html,re,f);}
});
test('private pages are not indexed and public ones are canonical',()=>{
 for(const f of ['watches.html','new.html','ledger.html','notifications.html','404.html'])assert.match(fs.readFileSync(f,'utf8'),/name="robots" content="noindex"/,f);
 for(const f of ['index.html','event.html','privacy.html'])assert.match(fs.readFileSync(f,'utf8'),/rel="canonical"/,f);
});
test('local links and assets resolve to files in the repo',()=>{
 const sources=[...htmlFiles,'app.js','tickets.js','auth.js','manifest.webmanifest','service-worker.js'];
 for(const f of sources){const text=fs.readFileSync(f,'utf8');
  for(const [,ref] of text.matchAll(/(?:href|src)=["'`]\.\/([^"'`?#$]+)/g))assert.ok(fs.existsSync(ref),`${f} links to missing ./${ref}`);
  for(const [,ref] of text.matchAll(/"src":"\.\/([^"]+)"/g))assert.ok(fs.existsSync(ref),`${f} links to missing ./${ref}`);}
});
test('404 page resolves assets from the project root on nested paths',()=>{assert.match(fs.readFileSync('404.html','utf8'),/<base href="\/Tickets\/">/);});
test('removed hero tagline stays removed',()=>{assert.doesNotMatch(app,/For the love of being there/);});
test('reads retry transient failures but not client errors',async()=>{
 sandbox.setTimeout=(fn)=>setTimeout(fn,0);let calls=0;
 sandbox.fetch=async()=>{calls++;return {status:calls<3?503:200,ok:calls>=3};};
 const r=await run('fetchWithRetry("x",{},{tries:3})');assert.equal(r.status,200);assert.equal(calls,3);
 calls=0;sandbox.fetch=async()=>{calls++;return {status:404,ok:false};};
 await run('fetchWithRetry("x",{},{tries:3})');assert.equal(calls,1);
 calls=0;sandbox.fetch=async()=>{calls++;throw new TypeError('offline');};
 await assert.rejects(()=>run('fetchWithRetry("x",{},{tries:2})'));assert.equal(calls,2);
});
test('empty or null API bodies become safe values',async()=>{
 assert.equal(await run('readJson({text:async()=>""})'),null);
 await assert.rejects(()=>run('readJson({text:async()=>"<html>"})'),/unexpected response/);
});


test('price breakdown preserves zero tax and never invents missing tax',()=>{
 assert.equal(run("priceBreakdown({price_cents:15000,prefee_cents:12000,sales_tax_cents:1000,pre_tax_total_cents:14000,basis:'fees_included_tax_reported'})"),'$120 base + $20 fees + $10 tax = $150 all-in');
 assert.match(run("priceBreakdown({price_cents:15000,prefee_cents:12000,sales_tax_cents:0,basis:'fees_included_tax_reported'})"),/\$0 tax/);
 const missing=run("priceBreakdown({price_cents:15000,prefee_cents:12000,sales_tax_cents:null,basis:'fees_included_tax_unknown'})");
 assert.match(missing,/fees included, tax not confirmed/);assert.doesNotMatch(missing,/\$0 tax|all-in/);
 assert.match(run("priceBreakdown({price_cents:15000,prefee_cents:null,sales_tax_cents:null,basis:null})"),/price basis not confirmed/);
 assert.match(run("priceBreakdown({price_cents:15000,prefee_cents:14900,sales_tax_cents:1000,basis:'fees_included_tax_reported'})"),/tax not confirmed/);
});
test('legacy null basis cannot become a fresh watch hit from either reader',()=>{
 run("state.intelligence=[{watch_id:'legacy',criteria_version:1,current_price_cents:1000,scan_outcome:'ok',price_checked_at:new Date().toISOString(),basis:null}];state.prices=[{watch_id:'legacy',criteria_version:1,event_id:'e',qty:2,price_cents:1000,checked_at:new Date().toISOString(),basis:null}];state.scans=[{watch_id:'legacy',event_id:'e',criteria_version:1,outcome:'ok',checked_at:new Date().toISOString()}]");
 assert.equal(run("watchLatest({id:'legacy',qty:2,criteria_version:1,created_at:'2020-01-01'}).length"),0);
 run('state.intelligence=[]');
 assert.equal(run("watchLatest({id:'legacy',qty:2,criteria_version:1,created_at:'2020-01-01'}).length"),0);
 assert.equal(run("watchPriceDisplay({kind:'event'},null,state.prices,{}).label"),'Previous observed price');
});
test('group filters and partial samples cannot imply sold out',()=>{
 assert.match(run("lotFilterMarkup('groups')"),/Pairs \(2\)/);assert.match(run("lotFilterMarkup('groups')"),/Groups of 4/);
 assert.match(run("marketQuantityText({by_qty:{},coverage:null},4)"),/not confirmed/);
 assert.match(run("marketQuantityText({by_qty:{},coverage:{complete:false,quantities:[2]}},4)"),/not confirmed/);
 assert.match(run("marketQuantityText({by_qty:{},coverage:{complete:true,unknown_lots:1}},4)"),/not confirmed/);
 assert.match(run("marketQuantityText({by_qty:{},checked_at:new Date().toISOString(),coverage:{complete:true,unknown_lots:0}},4)"),/No seller-confirmed/);
 assert.match(run("marketQuantityText({by_qty:{'2':{low:10000,typical:11000,high:12000,listings:3,basis:'fees_included_tax_unknown'}},checked_at:new Date().toISOString()},2,true)"),/Prior sample/);
 assert.doesNotMatch(run("marketQuantityText({by_qty:{'2':{low:10000,typical:11000,high:12000,listings:3,basis:'fees_included_tax_unknown'}},checked_at:new Date().toISOString()},2)"),/all-in/);
});
test('opaque vendor history is never interpreted and own-history comparisons share basis',()=>{
 sandbox.proofCurrent={event_id:'e',qty:2,club:'Club',basis:'fees_included_tax_unknown',hist:{unknown_schema:{was:9999}},price_cents:14600};
 sandbox.proofRows=[{...sandbox.proofCurrent,checked_at:new Date(Date.now()-2*86400000).toISOString(),price_cents:15000},{...sandbox.proofCurrent,checked_at:new Date().toISOString()}];
 assert.match(run('priceProof(proofRows,proofCurrent)'),/Ticketline checks.*down \$4/);
 sandbox.proofRows[0].basis='fees_included_tax_reported';
 assert.equal(run('priceProof(proofRows,proofCurrent)'),'No history available');
 assert.equal(run('priceProof([],proofCurrent)'),'No history available');
});

test('search summary reports fresh, queued, limited and failed prices honestly',()=>{
 sandbox.summaryRows=[{state:'metadata_only'},{state:'cached'},{state:'queued'},{state:'failed'},{state:'scheduled'}];
 assert.equal(run('searchPriceSummary(summaryRows)'),'2 live prices updated · 1 queued for the next scheduled check · 1 waiting on the request limit · 1 could not be checked (saved prices shown).');
 assert.match(run("searchPriceSummary([{state:'suspended'},{state:'metadata_only'}])"),/paused/);
 assert.match(run("searchPriceSummary([{state:'sign_in_required'}])"),/Sign in/);
 assert.equal(run('searchPriceSummary([])'),'Showing saved prices.');
});
test('a search sends one batch without tracking; opening an event tracks it',async()=>{
 const bodies=[];
 sandbox.accessToken=async()=> 'user';sandbox.IS_DEV=false;sandbox.AbortSignal=AbortSignal;
 sandbox.fetch=async(url,options)=>{bodies.push(JSON.parse(options.body));const ids=JSON.parse(options.body).event_ids;return {status:200,ok:true,text:async()=>JSON.stringify({results:ids.map(event_id=>({event_id,state:'metadata_only',min_total:1500}))})};};
 const results=await run('captureEventPrices(["a","b"])');
 assert.deepEqual(bodies[0],{event_ids:['a','b'],track:false});assert.equal(results.length,2);
 assert.equal((await run('captureEventPrice("a")')).min_total,1500);
 assert.deepEqual(bodies[1],{event_ids:['a'],track:true});
 sandbox.fetch=async()=>({status:200,ok:true,text:async()=>JSON.stringify({results:[{event_id:'a',state:'failed'}]})});
 await assert.rejects(run('captureEventPrice("a")'),/saved price is still available/);
});
test('missing Edge route falls back to deployed discovery queue without hiding real errors',async()=>{
 const responses=[];
 sandbox.accessToken=async()=> 'user';sandbox.IS_DEV=false;
 sandbox.AbortSignal=AbortSignal;sandbox.fetch=async()=>responses.shift();
 sandbox.sbPublicRpc=async(name,body,options)=>{assert.equal(name,'tix_request_price_check');assert.equal(body.p_event_id,'college-game');assert.equal(options.token,'user');return true;};
 responses.push({status:404,ok:false,text:async()=>JSON.stringify({code:'NOT_FOUND'})});
 assert.equal((await run('captureEventPrice("college-game")')).state,'scheduled');
 responses.push({status:401,ok:false,text:async()=>JSON.stringify({code:'UNAUTHORIZED'})});
 await assert.rejects(run('captureEventPrice("college-game")'),/Could not refresh prices/);
});
vm.runInContext(app.slice(app.indexOf('const TEAM_NAMES='),app.indexOf('function selectionTitle(')),sandbox);
test('team picker finds schools but keeps nickname slugs as the stored value',()=>{
 const cbb='college-basketball';
 const hit=(slug,q)=>run(`teamMatches("${cbb}","${slug}",${JSON.stringify(q)})`);
 assert.equal(hit('orange','syracuse'),true);assert.equal(hit('orange','sy'),true);assert.equal(hit('orange','orange'),true);assert.equal(hit('orange','syc'),true);
 assert.equal(run(`teamName("${cbb}","orange")`),'Syracuse Orange');
 assert.equal(hit('tar-heels','north carolina'),true);assert.equal(hit('tar-heels','unc'),true);
 assert.equal(hit('sycamores','syracuse'),false);assert.equal(hit('orange','duke'),false);
 // Old behaviour is never narrowed: every nickname substring still matches, in every league.
 assert.equal(hit('orange','ora'),true);assert.equal(hit('tar-heels','heels'),true);
 assert.equal(run('teamMatches("nfl-football","minnesota-vikings","vik")'),true);assert.equal(run('teamMatches("nfl-football","minnesota-vikings","zzz")'),false);
 assert.equal(run('teamName("nfl-football","orange")'),'Orange');assert.equal(run('teamMatches("nfl-football","orange","syracuse")'),false);
 // Shared nicknames are never assigned to one school.
 assert.equal(run(`teamName("${cbb}","blue-devils")`),'Blue Devils');
 assert.equal(hit('blue-devils','duke'),true);assert.equal(hit('blue-devils','central connecticut'),true);
 assert.match(run(`teamSub("${cbb}","bulldogs","gonzaga")`),/^Shared nickname: Gonzaga,/);
 assert.equal(run(`teamSub("${cbb}","orange","")`),'');
 assert.equal(run(`teamInfo("${cbb}","constructor")`),null);
 assert.equal(run(`teamName("${cbb}","not-a-team")`),'Not A Team');
});

test('exact search prices require an observed seller lot and known price basis',()=>{
 sandbox.exactRow={price_cents:2200,basis:'fees_included_tax_unknown',checked_at:new Date().toISOString(),state:'partial'};
 assert.equal(run('exactSearchPrice(exactRow,4).price_cents'),2200);
 assert.equal(run('exactSearchPrice({...exactRow,state:"unconfirmed"},4)'),null);
 assert.equal(run('exactSearchPrice({...exactRow,basis:null},4)'),null);
 assert.equal(run('exactSearchPrice({...exactRow,price_cents:null},4)'),null);
 assert.equal(run('exactSearchPrice(null,4)'),null);
 assert.equal(run('exactSearchPrice({...exactRow,checked_at:null},4)'),null);
});
test('game chart preserves unknowns and exposes dates, games and check times in a table',()=>{
 sandbox.games=[{event_id:'a',name:'Visitors <A> at Wisconsin',event_date:'2027-01-03',min_total:1500,price_checked_at:new Date().toISOString()},{event_id:'b',name:'Visitors B at Wisconsin',event_date:'2027-01-05',min_total:null,price_checked_at:null}];
 const html=run('schedulePriceChart(games,{label:"Wisconsin"})');
 assert.equal((html.match(/class="schedule-bar"/g)||[]).length,1);
 assert.equal((html.match(/class="schedule-unknown"/g)||[]).length,1);
 assert.match(html,/Visitors &lt;A&gt; at Wisconsin/);assert.match(html,/Not confirmed/);assert.match(html,/Last check/);
 assert.doesNotMatch(html,/<A>/);
 assert.match(run('schedulePriceChart(games,{label:"Wisconsin",qty:4})'),/verified 4-ticket/);
 assert.equal((run('schedulePriceChart(games,{qty:4})').match(/class="schedule-bar"/g)||[]).length,0);
});
test('coverage does not fabricate zeros when the coverage response is absent',()=>{
 assert.match(run('coverageMarkup(null)'),/unavailable/);
 assert.match(run('coverageMarkup({events:null})'),/unavailable/);
 const html=run('coverageMarkup({events:18,priced:12,unpriced:6,horizon_days:365,provider_paused:true})');
 assert.match(html,/Live checks are paused/);assert.match(html,/Unknown/);assert.match(html,/>18</);
 assert.match(html,/exact ticket quantities/);
});
test('history groups never mix event, quantity, section or price basis',()=>{
 sandbox.historySamples=[
  {event_id:'a',qty:2,club:'Club',basis:'fees_included_tax_unknown',price_cents:2000,checked_at:'2026-10-01T00:00:00Z'},
  {event_id:'a',qty:2,club:'Club',basis:'fees_included_tax_unknown',price_cents:2200,checked_at:'2026-10-02T00:00:00Z'},
  {event_id:'b',qty:2,club:'Club',basis:'fees_included_tax_unknown',price_cents:1700,checked_at:'2026-10-02T00:00:00Z'},
  {event_id:'a',qty:4,club:'Club',basis:'fees_included_tax_unknown',price_cents:1700,checked_at:'2026-10-02T00:00:00Z'},
  {event_id:'a',qty:2,club:'Upper',basis:'fees_included_tax_unknown',price_cents:1700,checked_at:'2026-10-02T00:00:00Z'},
  {event_id:'a',qty:2,club:'Club',basis:'fees_included_tax_reported',price_cents:1700,checked_at:'2026-10-02T00:00:00Z'}];
 assert.equal(run('comparableHistoryGroups(historySamples).length'),5);
 assert.equal(run('comparableHistoryGroups(historySamples)[0].samples.length'),2);
});
test('quantity search budget never uses a get-in price to verify group affordability',()=>{
 run('Object.assign(state,{searchQty:4,cheapOnly:false,maxPrice:"20",quantityPrices:{},teamEventIds:null,exploreTeamId:"",search:""})');
 assert.doesNotMatch(run('catalogQuery()'),/min_total=lte/);
 assert.match(run('eventPriceCell({event_id:"unknown",min_total:500})'),/4-ticket price unverified/);
 assert.match(run('eventPriceCell({event_id:"unknown",min_total:500})'),/Get-in \$5 · any quantity/);
 run('state.searchQty=0;state.maxPrice=""');
});

test('exact quantity chart uses its older lot observation time instead of a new get-in timestamp',()=>{
 sandbox.quantityGames=[{event_id:'q',name:'A at B',event_date:'2027-01-03',min_total:900,price_checked_at:new Date().toISOString(),quantity_price:{price_cents:1600,basis:'fees_included_tax_unknown',state:'partial',checked_at:new Date(Date.now()-3*86400000).toISOString()}}];
 const html=run('schedulePriceChart(quantityGames,{qty:2})');
 assert.match(html,/Quantity check/);assert.match(html,/Saved price · 3 days ago/);
 assert.doesNotMatch(html,/Checked just now/);
});

test('coverage never calls a stale, failed or unknown collector running',()=>{
 for(const status of ['stale','failed','unknown']){const html=run(`coverageMarkup({events:4,collector_state:${JSON.stringify(status)},failed_checks:0,teams_failed:0})`);assert.doesNotMatch(html,/Collection is running/);}
 assert.match(run('coverageMarkup({events:4,collector_state:"stale"})'),/checks are delayed/);
 assert.match(run('coverageMarkup({events:4,collector_state:"unknown"})'),/status is unknown/);
});

test('comparable alert history excludes observations with unknown price basis',()=>{
 sandbox.unknownBasisSamples=[null,undefined,'unknown'].map(basis=>({event_id:'a',qty:2,club:'Club',basis,price_cents:1500,checked_at:new Date().toISOString()}));
 assert.equal(run('comparableHistoryGroups(unknownBasisSamples).length'),0);
 sandbox.unknownBasisSamples.push({event_id:'a',qty:2,club:'Club',basis:'fees_included_tax_unknown',price_cents:1600,checked_at:new Date().toISOString()});
 assert.equal(run('comparableHistoryGroups(unknownBasisSamples).length'),1);
 assert.equal(run('comparableHistoryGroups(unknownBasisSamples)[0].samples.length'),1);
});

test('alert history reads beyond the REST row cap with a stable watch, range and snapshot',async()=>{
 const requests=[],stamp=new Date().toISOString();
 const first=Array.from({length:1000},(_,i)=>({checked_at:stamp,event_id:'game-'+i,qty:2,club:'Club',basis:'fees_included_tax_unknown',price_cents:2000+i}));
 const older={checked_at:new Date(Date.now()-86400000).toISOString(),event_id:'older-game',qty:2,club:'Club',basis:'fees_included_tax_unknown',price_cents:1800};
 sandbox.sbGet=async path=>{requests.push(new URL(path,'https://example.test/'));return requests.length===1?first:[first[0],older];};
 const rows=await run('readAlertHistory("private watch/id","30d")');
 assert.equal(rows.length,1001);assert.equal(rows[0].event_id,'game-0');assert.equal(rows.at(-1).event_id,'older-game');
 assert.equal(requests.length,2);
 for(const u of requests){assert.equal(u.searchParams.get('p_watch_id'),'private watch/id');assert.equal(u.searchParams.get('p_range'),'30d');assert.equal(u.searchParams.get('limit'),'1000');assert.match(u.searchParams.get('order'),/^checked_at.desc,event_id.asc/);}
 assert.equal(requests[0].searchParams.get('offset'),'0');assert.equal(requests[1].searchParams.get('offset'),'1000');
 assert.equal(requests[0].searchParams.get('checked_at'),requests[1].searchParams.get('checked_at'));
 assert.match(requests[0].searchParams.get('checked_at'),/^lte\./);
});
test('alert history refuses a truncated result after ten full pages',async()=>{
 let calls=0;sandbox.sbGet=async()=>{calls++;return Array.from({length:1000},(_,i)=>({checked_at:new Date().toISOString(),event_id:'g'+calls+'-'+i,qty:2,club:'Club',basis:'fees_included_tax_unknown',price_cents:2000}));};
 await assert.rejects(run('readAlertHistory("mine","all")'),/too much price history.*Choose a shorter time range/);
 assert.equal(calls,10);
});

test('the literal fallback preserves the all-sports category union',()=>{
 run('Object.assign(state,{category:"all-sports",search:"Wisconsin",exploreTeamId:"",teamEventIds:null})');
 const q=run('catalogQuery()');assert.match(q,/category=in\.\(nfl-football/);assert.match(q,/,pwhl,sports\)/);assert.doesNotMatch(q,/category=eq\.all-sports/);
});
