const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const code=fs.readFileSync('tickets.js','utf8');
const sandbox={URL,Intl,Date,Number,AbortSignal,console};vm.createContext(sandbox);vm.runInContext(code,sandbox);
function run(expr){return vm.runInContext(expr,sandbox);}
test('prices retain cents and unknown prices are not zero',()=>{assert.equal(run('money(10050)'),'$100.50');assert.equal(run('money(null)'),'—');});
test('listing links reject script and unrelated hosts',()=>{for(const s of ['javascript:alert(1)','https://evil.example/','https://gametime.co.evil.example',''])assert.equal(run(`safeUrl(${JSON.stringify(s)})`),'');assert.equal(run('safeUrl("/events/abc")'),'https://gametime.co/events/abc');});
test('date-only events keep their calendar date',()=>{assert.equal(run('dateObj("2026-09-13").getDate()'),13);});
test('phone numbers normalize and format safely',()=>{assert.equal(run('normalizeUSPhone("+1 (612) 555-0148")'),'6125550148');assert.equal(run('formatPhone("6125550148")'),'(612) 555-0148');assert.equal(run('normalizeUSPhone("123")'),'');});
test('Xfinity Mobile has a dedicated carrier label',()=>{assert.equal(run('carrierName("xfinity")'),'Xfinity Mobile');});
test('untrusted labels cannot create markup',()=>{assert.equal(run('esc("<img onerror=\\\"bad\\\">&")'),'&lt;img onerror=&quot;bad&quot;&gt;&amp;');});
const app=fs.readFileSync('app.js','utf8');const start=app.indexOf('function watchLatest(');const end=app.indexOf('function renderWatches(');vm.runInContext('const state={prices:[],scans:[]};'+app.slice(start,end),sandbox);
test('watch prices stay isolated even for the same event',()=>{run(`state.prices=[{watch_id:'other',event_id:'e',club:'Any section',price_cents:100,qty:2,checked_at:new Date().toISOString()},{watch_id:'mine',event_id:'e',club:'Any section',price_cents:200,qty:2,checked_at:new Date().toISOString()}]`);assert.equal(run(`watchLatest({id:'mine',qty:2,created_at:'2020-01-01'})[0].price_cents`),200);});
test('an unavailable latest scan hides an older listing',()=>{run(`state.scans=[{watch_id:'mine',event_id:'e',outcome:'unavailable',checked_at:new Date().toISOString()}]`);assert.equal(run(`watchLatest({id:'mine',qty:2,created_at:'2020-01-01'}).length`),0);});
test('changed criteria never display earlier prices',()=>{run(`state.scans=[]`);assert.equal(run(`watchLatest({id:'mine',qty:2,criteria_updated_at:new Date(Date.now()+1000).toISOString()}).length`),0);});
test('marketplace links are encoded search links',()=>{assert.equal(run('eventSearchUrl("tickpick","Packers at Vikings")'),'https://www.tickpick.com/search?q=Packers%20at%20Vikings');});
test('price context explains its time basis',()=>{const now=Date.now();run(`var rows=[{price_cents:15000,checked_at:new Date(${now}-172800000).toISOString()},{price_cents:14600,checked_at:new Date(${now}).toISOString()}]`);assert.match(run('priceContext(rows)'),/down \$4 since yesterday/);assert.match(run('priceContext(rows)'),/lowest in 2 days/);});
