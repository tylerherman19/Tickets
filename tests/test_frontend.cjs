const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const code=fs.readFileSync('tickets.js','utf8');
const sandbox={URL,Intl,Date,Number,AbortSignal,console};vm.createContext(sandbox);vm.runInContext(code,sandbox);
function run(expr){return vm.runInContext(expr,sandbox);}
test('prices retain cents and unknown prices are not zero',()=>{assert.equal(run('money(10050)'),'$100.50');assert.equal(run('money(null)'),'—');});
test('total budget maps to a seller-supported per-ticket threshold without overspending',()=>{
 assert.equal(run('perTicketTargetCents("400",4,"total")'),10000);
 assert.equal(run('perTicketTargetCents("400",3,"total")'),13333);
 assert.equal(run('perTicketTargetCents("100",4,"per")'),10000);
});
test('listing links reject script and unrelated hosts',()=>{for(const s of ['javascript:alert(1)','https://evil.example/','https://gametime.co.evil.example',''])assert.equal(run(`safeUrl(${JSON.stringify(s)})`),'');assert.equal(run('safeUrl("/events/abc")'),'https://gametime.co/events/abc');});
test('date-only events keep their calendar date',()=>{assert.equal(run('dateObj("2026-09-13").getDate()'),13);});
test('phone numbers normalize and format safely',()=>{assert.equal(run('normalizeUSPhone("+1 (612) 555-0148")'),'6125550148');assert.equal(run('formatPhone("6125550148")'),'(612) 555-0148');assert.equal(run('normalizeUSPhone("123")'),'');});
test('Xfinity Mobile has a dedicated carrier label',()=>{assert.equal(run('carrierName("xfinity")'),'Xfinity Mobile');});
test('untrusted labels cannot create markup',()=>{assert.equal(run('esc("<img onerror=\\\"bad\\\">&")'),'&lt;img onerror=&quot;bad&quot;&gt;&amp;');});
const app=fs.readFileSync('app.js','utf8');const start=app.indexOf('function watchLatest(');const end=app.indexOf('function renderWatches(');vm.runInContext('const state={prices:[],scans:[]};'+app.slice(start,end),sandbox);
const queryStart=app.indexOf('function catalogQuery('),queryEnd=app.indexOf('async function loadEvents(');
vm.runInContext(app.slice(queryStart,queryEnd),sandbox);
test('homepage pagination retains one order and advances by displayed rows',()=>{
 run('Object.assign(state,{category:"",date:"",search:"",place:"",maxPrice:"",offset:0})');
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
 run('Object.assign(state,{cheapOnly:true,maxPrice:"",within:"",date:"",offset:0})');
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
test('watch prices stay isolated even for the same event',()=>{run(`state.prices=[{watch_id:'other',event_id:'e',club:'Any section',price_cents:100,qty:2,checked_at:new Date().toISOString()},{watch_id:'mine',event_id:'e',club:'Any section',price_cents:200,qty:2,checked_at:new Date().toISOString()}]`);assert.equal(run(`watchLatest({id:'mine',qty:2,created_at:'2020-01-01'})[0].price_cents`),200);});
test('an unavailable latest scan hides an older listing',()=>{run(`state.scans=[{watch_id:'mine',event_id:'e',outcome:'unavailable',checked_at:new Date().toISOString()}]`);assert.equal(run(`watchLatest({id:'mine',qty:2,created_at:'2020-01-01'}).length`),0);});
test('changed criteria never display earlier prices',()=>{run(`state.scans=[]`);assert.equal(run(`watchLatest({id:'mine',qty:2,criteria_updated_at:new Date(Date.now()+1000).toISOString()}).length`),0);});
test('marketplace links are encoded search links',()=>{assert.equal(run('eventSearchUrl("tickpick","Packers at Vikings")'),'https://www.tickpick.com/search?q=Packers%20at%20Vikings');});
test('price context explains its time basis',()=>{const now=Date.now();run(`var rows=[{price_cents:15000,checked_at:new Date(${now}-172800000).toISOString()},{price_cents:14600,checked_at:new Date(${now}).toISOString()}]`);assert.match(run('priceContext(rows)'),/down \$4 since yesterday/);assert.match(run('priceContext(rows)'),/lowest in 2 days/);});
vm.runInContext(fs.readFileSync('calendar.js','utf8'),sandbox);
test('calendar export preserves event date and escapes labels',()=>{
 const event={event_id:'e',event_date:'2026-10-04',name:'A, B; Show',venue:'Arena',city:'Minneapolis',state:'MN'};
 sandbox.calendarEvent=event;
 const ics=run('makeICS(calendarEvent,"https://example.test/alert")');
 assert.match(ics,/DTSTART;VALUE=DATE:20261004/);
 assert.match(ics,/DTEND;VALUE=DATE:20261005/);
 assert.match(ics,/SUMMARY:A\\, B\\; Show/);
});
