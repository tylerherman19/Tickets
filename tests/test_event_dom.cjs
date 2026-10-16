const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const app=fs.readFileSync('app.js','utf8');
const eventCode=app.slice(app.indexOf('async function eventDetail(){'),app.indexOf('// Last-resort error page'));
test('event page renders comparable history and escaped seat details; quantity changes reload exact listings',async()=>{
 const dom=new JSDOM('<main id="main"></main>',{url:'http://localhost/event.html?event=fixture',runScripts:'outside-only'});
 const w=dom.window,requests=[];
 const prelude=`const main=document.querySelector('#main'),query=new URLSearchParams(location.search),session=null;
 ${app.slice(app.indexOf('function layout('),app.indexOf('function stadiumArt'))}`;
 w.mockGet=async path=> path.includes('tix_events_v')?[{event_id:'fixture',name:'Fixture event',venue:'Arena',event_date:'2026-11-15',min_total:1200,price_checked_at:new Date().toISOString(),url:'https://gametime.co/events/fixture'}]:path.includes('tix_event_market')?[{by_qty:{2:{low:1400,basis:'fees_included_tax_reported'}},groups:[],listing_count:1,checked_at:new Date().toISOString()}]:[];
 w.mockRpc=async(name,body)=>{
  requests.push({name,body});
  if(name==='tix_event_price_history')return [{checked_at:'2026-10-10T12:00:00Z',price_cents:1500},{checked_at:'2026-10-11T12:00:00Z',price_cents:1400}];
  if(name==='tix_event_listings')return [{listing_id:'lot',price_cents:1400,basis:'fees_included_tax_reported',lots:[2,4],seats:['1','2','<script>bad</script>','4'],section:'C1',row_label:'A',checked_at:new Date().toISOString(),coverage:{complete:true}}];
 };
 w.downloadICS=()=>{};w.googleCalendarUrl=()=> 'https://calendar.google.com/';
 w.eval(fs.readFileSync('tickets.js','utf8')+prelude+';sbGet=window.mockGet;sbPublicRpc=window.mockRpc;'+eventCode+';eventDetail()');
 await new Promise(r=>setImmediate(r));
 const d=w.document;
 assert.equal(d.querySelectorAll('#event-listings tbody tr').length,1);
 assert.equal(d.querySelectorAll('#event-listings script').length,0);
 assert.match(d.querySelector('#event-listings').textContent,/<script>bad<\/script>/);
 assert.match(d.querySelector('#event-history svg').getAttribute('aria-label'),/\$15.*\$14/);
 d.querySelector('#detail-qty').value='4';d.querySelector('#detail-qty').dispatchEvent(new w.Event('change'));
 await new Promise(r=>setImmediate(r));
 assert.equal(requests.filter(r=>r.name==='tix_event_listings').at(-1).body.p_qty,4);
 d.querySelector('#history-basis').value='fees_included_tax_reported';d.querySelector('#history-basis').dispatchEvent(new w.Event('change'));
 await new Promise(r=>setImmediate(r));
 const historyRequest=requests.filter(r=>r.name==='tix_event_price_history').at(-1);
 assert.equal(historyRequest.body.p_qty,4);assert.equal(historyRequest.body.p_basis,'fees_included_tax_reported');
 dom.window.close();
});

test('college football quick filter loads college games, syncs its URL, and links the selected event',async()=>{
 const dom=new JSDOM('<body data-page="explore"><main id="main"></main></body>',{url:'https://example.test/index.html',runScripts:'outside-only'});
 const w=dom.window,requests=[];
 w.mockGet=async path=>{
  requests.push(path);
  const category=new URL(path,'https://example.test').searchParams.get('category');
  return category==='eq.college-football'?[{event_id:'college-game',name:'Badgers at Gophers',category:'college-football',event_date:'2026-11-28',city:'Minneapolis',state:'MN',venue:'Huntington Bank Stadium',min_total:null,price_checked_at:null}]:[];
 };
 w.eval(fs.readFileSync('tickets.js','utf8')+';chrome=()=>{};sbGet=window.mockGet;const IS_DEV=true,session=null;'+app);
 await new Promise(r=>setImmediate(r));
 const d=w.document,button=d.querySelector('[data-category="college-football"]');
 assert.ok(button);assert.equal(button.textContent,'College football');
 button.click();await new Promise(r=>setImmediate(r));
 assert.equal(button.getAttribute('aria-pressed'),'true');
 assert.equal(d.querySelector('[data-category="nfl-football"]').getAttribute('aria-pressed'),'false');
 assert.equal(d.querySelector('#category').value,'college-football');
 assert.equal(new URL(w.location.href).searchParams.get('category'),'college-football');
 assert.equal(new URL(requests.at(-1),'https://example.test').searchParams.get('category'),'eq.college-football');
 assert.equal(d.querySelector('.event-category').textContent,'College football');
 assert.match(d.querySelector('.event-info h3 a').href,/event.html\?event=college-game$/);
 assert.match(d.querySelector('.alert-button').href,/new.html\?event=college-game$/);
 assert.equal(d.querySelector('.event-price').textContent,'Price not checked');
 d.querySelector('#category').value='nfl-football';
 d.querySelector('#category').dispatchEvent(new w.Event('change'));
 await new Promise(r=>setImmediate(r));
 assert.equal(button.getAttribute('aria-pressed'),'false');
 assert.equal(new URL(requests.at(-1),'https://example.test').searchParams.get('category'),'eq.nfl-football');
 dom.window.close();
});

test('college basketball quick filter loads college games, syncs its URL, and links the selected event',async()=>{
 const dom=new JSDOM('<body data-page="explore"><main id="main"></main></body>',{url:'https://example.test/index.html',runScripts:'outside-only'});
 const w=dom.window,requests=[];
 w.mockGet=async path=>{
  requests.push(path);
  const category=new URL(path,'https://example.test').searchParams.get('category');
  return category==='eq.college-basketball'?[{event_id:'college-game',name:'Badgers at Gophers',category:'college-basketball',event_date:'2026-12-01',city:'Minneapolis',state:'MN',venue:'Huntington Bank Stadium',min_total:null,price_checked_at:null}]:[];
 };
 w.eval(fs.readFileSync('tickets.js','utf8')+';chrome=()=>{};sbGet=window.mockGet;const IS_DEV=true,session=null;'+app);
 await new Promise(r=>setImmediate(r));
 const d=w.document,button=d.querySelector('[data-category="college-basketball"]');
 assert.ok(button);assert.equal(button.textContent,'College basketball');
 button.click();await new Promise(r=>setImmediate(r));
 assert.equal(button.getAttribute('aria-pressed'),'true');
 assert.equal(d.querySelector('[data-category="nfl-football"]').getAttribute('aria-pressed'),'false');
 assert.equal(d.querySelector('#category').value,'college-basketball');
 assert.equal(new URL(w.location.href).searchParams.get('category'),'college-basketball');
 assert.equal(new URL(requests.at(-1),'https://example.test').searchParams.get('category'),'eq.college-basketball');
 assert.equal(d.querySelector('.event-category').textContent,'College basketball');
 assert.match(d.querySelector('.event-info h3 a').href,/event.html\?event=college-game$/);
 assert.match(d.querySelector('.alert-button').href,/new.html\?event=college-game$/);
 assert.equal(d.querySelector('.event-price').textContent,'Price not checked');
 d.querySelector('#category').value='nfl-football';
 d.querySelector('#category').dispatchEvent(new w.Event('change'));
 await new Promise(r=>setImmediate(r));
 assert.equal(button.getAttribute('aria-pressed'),'false');
 assert.equal(new URL(requests.at(-1),'https://example.test').searchParams.get('category'),'eq.nfl-football');
 dom.window.close();
});

function explorePage(rows,{session=null,capture}={}){
 const dom=new JSDOM('<body data-page="explore"><main id="main"></main></body>',{url:'https://example.test/index.html?q=vikings&category=all',runScripts:'outside-only'});
 const w=dom.window;w.mockGet=async()=>rows.map(r=>({...r}));w.mockCapture=capture;w.session=session;
 w.eval(fs.readFileSync('tickets.js','utf8')+';chrome=()=>{};sbGet=window.mockGet;captureEventPrices=window.mockCapture;const IS_DEV=false,session=window.session;'+app);
 return w;
}
const soon=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
const searchRows=[
 {event_id:'fresh',name:'Packers at Vikings',category:'nfl-football',event_date:soon,city:'Minneapolis',state:'MN',venue:'Stadium',min_total:9900,price_checked_at:new Date().toISOString(),discovery_status:'metadata_only'},
 {event_id:'unpriced',name:'Bears at Vikings',category:'nfl-football',event_date:soon,city:'Minneapolis',state:'MN',venue:'Stadium',min_total:null,price_checked_at:null},
 {event_id:'limited',name:'Lions at Vikings',category:'nfl-football',event_date:soon,city:'Minneapolis',state:'MN',venue:'Stadium',min_total:7000,price_checked_at:new Date(Date.now()-86400000).toISOString(),discovery_status:'metadata_only'}];
test('a signed-in search prices its results right away and retries a rate-limited one once',async()=>{
 const calls=[];
 const w=explorePage(searchRows,{session:{user:{}},capture:async ids=>{
  calls.push([...ids]);
  if(calls.length===1)return [{event_id:'unpriced',state:'metadata_only',min_total:4500,checked_at:new Date().toISOString()},{event_id:'limited',state:'queued',reason:'request_limit',next_attempt_at:new Date(Date.now()+20).toISOString()}];
  return [{event_id:'limited',state:'metadata_only',min_total:6100,checked_at:new Date().toISOString()}];
 }});
 await new Promise(r=>setTimeout(r,250));
 const d=w.document,cell=id=>d.getElementById('price-'+id).textContent;
 // Nothing is checked during the short grace period after a search renders.
 assert.equal(calls.length,0);
 assert.match(cell('unpriced'),/Price not checked/);
 await new Promise(r=>setTimeout(r,300));
 assert.deepEqual(calls[0],['unpriced','limited']);
 assert.match(cell('unpriced'),/\$45.*Get-in only just now/);
 assert.match(cell('limited'),/Checking live price/);
 assert.match(cell('fresh'),/\$99/);
 await new Promise(r=>setTimeout(r,1300));
 assert.deepEqual(calls[1],['limited']);
 assert.match(cell('limited'),/\$61.*just now/);
 assert.doesNotMatch(cell('limited'),/Checking|queued/);
 assert.equal(d.querySelector('#price-request-status').textContent,'2 live prices updated.');
 w.close();
});
test('signed-out searches show saved prices and never start a live check',async()=>{
 let called=false;
 const w=explorePage(searchRows,{capture:async()=>{called=true;return [];}});
 await new Promise(r=>setTimeout(r,550));
 assert.equal(called,false);
 assert.match(w.document.querySelector('#price-request-status').textContent,/Sign in to load live prices/);
 assert.match(w.document.getElementById('price-unpriced').textContent,/Price not checked/);
 w.close();
});
test('rows left unanswered by a fallback queue settle back to their saved price',async()=>{
 const w=explorePage(searchRows,{session:{user:{}},capture:async ids=>[{event_id:ids[0],state:'scheduled'}]});
 await new Promise(r=>setTimeout(r,550));
 const d=w.document;
 assert.match(d.getElementById('price-unpriced').textContent,/Live check queued/);
 assert.match(d.getElementById('price-limited').textContent,/\$70/);
 assert.doesNotMatch(d.getElementById('price-limited').textContent,/Checking/);
 assert.match(d.querySelector('#price-request-status').textContent,/1 queued for the next scheduled check/);
 w.close();
});
test('opening an event while signed in prices it now and says it is tracked',async()=>{
 const dom=new JSDOM('<main id="main"></main>',{url:'http://localhost/event.html?event=fixture',runScripts:'outside-only'});
 const w=dom.window,captured=[];
 const prelude=`const main=document.querySelector('#main'),query=new URLSearchParams(location.search),session={user:{}};const IS_DEV=false;
 ${app.slice(app.indexOf('function layout('),app.indexOf('function stadiumArt'))}`;
 w.mockGet=async path=> path.includes('tix_events_v')?[{event_id:'fixture',name:'Fixture event',venue:'Arena',event_date:'2026-11-15',min_total:1200,price_checked_at:new Date(Date.now()-86400000).toISOString(),url:'https://gametime.co/events/fixture'}]:[];
 w.mockRpc=async()=>[];
 w.mockCapture=async id=>{captured.push(id);return {event_id:id,state:'metadata_only',min_total:1350,detail_worker:'not_needed'};};
 w.downloadICS=()=>{};w.googleCalendarUrl=()=> 'https://calendar.google.com/';
 w.eval(fs.readFileSync('tickets.js','utf8')+prelude+';sbGet=window.mockGet;sbPublicRpc=window.mockRpc;captureEventPrice=window.mockCapture;'+eventCode+';eventDetail()');
 await new Promise(r=>setTimeout(r,30));
 const d=w.document;
 assert.deepEqual(captured,['fixture']);
 assert.equal(d.querySelector('.detail-prices strong').textContent,'$13.50');
 assert.match(d.querySelector('.detail-prices > div > span').textContent,/Checked just now · get-in only/);
 assert.match(d.querySelector('#capture-status').textContent,/tracked/);
 dom.window.close();
});
test('a search replaced during the grace period never starts live checks',async()=>{
 const calls=[];
 const w=explorePage(searchRows,{session:{user:{}},capture:async ids=>{calls.push(ids);return [];}});
 await new Promise(r=>setTimeout(r,100));
 const d=w.document;d.querySelector('#category').value='nba-basketball';d.querySelector('#category').dispatchEvent(new w.Event('change'));
 await new Promise(r=>setTimeout(r,650));
 assert.equal(calls.length,1,'only the latest search is checked');
 w.close();
});
