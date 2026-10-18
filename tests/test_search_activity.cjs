const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('fs');
const tick=()=>new Promise(r=>setTimeout(r,20));
function setup(url='https://example.test/index.html?q=Badgers'){
 const dom=new JSDOM('<body data-page="explore"><main id="main"></main></body>',{url,runScripts:'outside-only'}),w=dom.window,calls=[];
 w.mockGet=async()=>[];w.mockRpc=async()=>[];w.logActivity=async body=>{calls.push(body);return false;};
 w.eval(fs.readFileSync('tickets.js','utf8')+';chrome=()=>{};sbGet=window.mockGet;sbPublicRpc=window.mockRpc;recordSearchActivity=window.logActivity;const IS_DEV=true,session=null;'+fs.readFileSync('app.js','utf8'));
 return {dom,w,calls};
}
test('opened and submitted searches record once; filters, pagination and refresh do not add searches',async()=>{
 const {dom,w,calls}=setup();await tick();assert.equal(calls.length,1);assert.equal(calls[0].p_source,'link');assert.equal(calls[0].p_outcome,'no_results');
 w.document.querySelector('#event-search').value='Wisconsin';w.document.querySelector('#search-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(calls.length,2);assert.equal(calls[1].p_source,'submit');assert.notEqual(calls[0].p_search_id,calls[1].p_search_id);
 w.document.querySelector('[data-category="all-sports"]').click();await tick();await w.loadEvents(true);await w.loadEvents();assert.equal(calls.length,2);dom.window.close();
});
test('aborted searches are not logged and a failed search logs once before retry',async()=>{
 const {dom,w,calls}=setup('https://example.test/index.html');await tick();w.sbGet=async()=>{throw new Error('offline')};w.sbPublicRpc=async()=>{throw new Error('offline')};
 w.document.querySelector('#event-search').value='missing';w.document.querySelector('#search-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(calls.length,1);assert.equal(calls[0].p_outcome,'failed');assert.match(w.document.querySelector('#results-count').textContent,/could not load/);await w.loadEvents();assert.equal(calls.length,1);dom.window.close();
});
test('logging is best effort, has no persistent identifier and uses the signed-in token only when available',async()=>{
 const dom=new JSDOM('',{url:'https://example.test',runScripts:'outside-only'}),w=dom.window,calls=[];w.fetch=async(url,opts)=>{calls.push({url,opts});throw new Error('unavailable')};
 w.eval(fs.readFileSync('tickets.js','utf8')+';const IS_DEV=false;accessToken=async()=>null;');
 const attempt=w.newSearchActivity('submit','Badgers');assert.equal(await w.recordSearchActivity({...attempt,p_result_count:0,p_has_more:false,p_outcome:'no_results'}),false);assert.equal(calls.length,1);assert.equal(w.localStorage.length,0);assert.match(calls[0].url,/tix_record_search$/);assert.equal(w.newSearchActivity('submit','  '),null);dom.window.close();
});
test('superseded searches are ignored and visible first-page results are counted',async()=>{
 const {dom,w,calls}=setup('https://example.test/index.html');await tick();let release;
 w.sbGet=async()=>new Promise(r=>{release=r});
 const form=w.document.querySelector('#search-form'),input=w.document.querySelector('#event-search');input.value='old search';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(typeof release,'function');
 w.sbGet=async()=>[{event_id:'new',name:'Badgers game',category:'college-basketball',event_date:'2026-12-01',city:'Madison',state:'WI',venue:'Kohl Center'}];
 input.value='Badgers';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();release([]);await tick();assert.equal(calls.length,1);assert.equal(calls[0].p_query,'Badgers');assert.equal(calls[0].p_result_count,1);assert.equal(calls[0].p_outcome,'results');assert.equal(w.document.querySelectorAll('.event-row').length,1);dom.window.close();
});
