const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const shared=fs.readFileSync('tickets.js','utf8'),app=fs.readFileSync('app.js','utf8');
const event={event_id:'fixture',name:'Panthers at Vikings',slug:'panthers-at-vikings',category:'nfl-football',event_date:'2026-12-20',venue:'U.S. Bank Stadium',city:'Minneapolis',state:'MN',discovery_status:'ok'};
const team={team_id:'vikings-source',label:'Minnesota Vikings',category:'nfl-football',event_count:8};
const tick=()=>new Promise(r=>setImmediate(r));
function setup(page='explore',search=''){
 const dom=new JSDOM('<body data-page="'+page+'"><main id="main"></main></body>',{url:'https://example.test/'+(page==='new'?'new':'index')+'.html'+search,runScripts:'outside-only'});
 const w=dom.window;w.requests=[];w.saved=[];w.scrollTo=()=>{};
 w.mockGet=async path=>{w.requests.push(path);return path.includes('tix_event_market')?[{checked_at:new Date().toISOString(),by_qty:{2:{low:11791,basis:'fees_included_tax_unknown'},4:{low:12500,basis:'fees_included_tax_reported'}}}]:path.includes('tix_events_v')?[event]:[];};
 w.mockRpc=async(name,body)=>{w.requests.push({name,body});return name==='tix_resolve_teams'?[team]:name==='tix_general_search'?[event]:[];};
 w.mockSave=async(name,body)=>{w.saved.push({name,body});return {};};
 w.eval(shared+';chrome=()=>{};sbGet=window.mockGet;sbPublicRpc=window.mockRpc;sbRpc=window.mockSave;const IS_DEV=true,session=null;async function requireSession(){return true;}'+app);
 return {dom,w,d:w.document,close:()=>w.close()};
}
test('hero event search, exact-seat gap, delivery and review/save work as one flow',async()=>{
 const h=setup();try{
 await tick();const {w,d}=h;let next;w.captureNavigation=url=>next=url;w.eval('goToWatchSetup=window.captureNavigation');
 const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.Event('input'));input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();
 assert.equal(d.querySelectorAll('[data-quick-result]').length,1);d.querySelector('[data-quick-result]').click();await tick();
 const price=d.querySelector('#quick-price');price.value='75';price.dispatchEvent(new w.Event('input'));
 assert.match(d.querySelector('#quick-gap').textContent,/\$42.91 above your price/);assert.match(d.querySelector('#quick-gap').textContent,/\$235.82 total/);
 assert.match(d.querySelector('#quick-gap').textContent,/tax may be added/);
 d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));
 assert.ok(next);const params=new URL(next,'https://example.test').searchParams;assert.equal(params.get('event'),'fixture');assert.equal(params.get('qty'),'2');assert.equal(params.get('price'),'75');
 const b=setup('new','?'+params);try{await tick();assert.match(b.d.querySelector('.review-list').textContent,/2 tickets together/);assert.match(b.d.querySelector('.review-list').textContent,/\$150 total/);b.d.querySelector('#save-alert').click();await tick();const save=b.w.saved.find(x=>x.name==='tix_save_alert');assert.equal(save.body.p_watch.threshold_cents,7500);assert.equal(save.body.p_watch.qty,2);assert.equal(save.body.p_watch.match.event_ids[0],'fixture');assert.match(b.d.querySelector('h1').textContent,/on the list/);}finally{b.close();}
 }finally{h.close();}
});
test('hero quantity changes recalculate the gap and old samples never show a price',async()=>{
 const h=setup();try{await tick();const {d,w}=h;const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();d.querySelector('[data-quick-result]').click();await tick();d.querySelector('[data-quick-qty="4"]').click();d.querySelector('#quick-price').value='100';d.querySelector('#quick-price').dispatchEvent(new w.Event('input'));assert.match(d.querySelector('#quick-gap').textContent,/\$500 total/);assert.match(d.querySelector('#quick-gap').textContent,/\$25 above/);
 const html=w.eval('quickGapMarkup({checked_at:new Date(Date.now()-16*60000).toISOString(),by_qty:{2:{low:11791,basis:"fees_included_tax_reported"}}},2,7500)');assert.doesNotMatch(html,/117|42.91/);assert.match(html,/fresh price.*not available/);
 d.querySelector('[data-quick-qty="5"]').click();assert.equal(d.querySelector('#quick-more-qty').hidden,false);
 }finally{h.close();}
});
test('team and date choices carry identity, budget and text preference into setup',async()=>{
 const h=setup();try{await tick();const {d,w}=h;let next;w.captureNavigation=url=>next=url;w.eval('goToWatchSetup=window.captureNavigation');d.querySelector('[data-quick-kind="team"]').click();const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();d.querySelector('[data-quick-result]').click();d.querySelector('#quick-price').value='80';d.querySelector('#quick-text').checked=true;d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));const params=new URL(next,'https://example.test').searchParams;assert.equal(params.get('team'),'vikings-source');
 const b=setup('new','?'+params);try{await tick();assert.equal(b.d.querySelector('#target').value,'80');assert.equal(b.d.querySelector('#sms-enabled').checked,true);assert.equal(b.d.querySelector('#phone').required,true);assert.match(b.d.querySelector('.panel-heading').textContent,/Minnesota Vikings/);}finally{b.close();}
 d.querySelector('[data-quick-kind="date"]').click();d.querySelector('#quick-text').checked=false;d.querySelector('#quick-date').value='2026-12-20';d.querySelector('#quick-city').value='Minneapolis';d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));const day=setup('new',new URL(next,'https://example.test').search);try{await tick();assert.match(day.d.querySelector('.review-list').textContent,/Minneapolis/);day.d.querySelector('#save-alert').click();await tick();const saved=day.w.saved.find(x=>x.name==='tix_save_alert').body.p_watch;assert.equal(saved.kind,'date');assert.equal(saved.match.date,'2026-12-20');assert.equal(saved.match.city,'Minneapolis');}finally{day.close();}
 }finally{h.close();}
});
test('hero requires a real search choice and a delivery method; outdated search replies are ignored',async()=>{
 const h=setup();try{await tick();const {d,w}=h;d.querySelector('#quick-price').value='75';d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.match(d.querySelector('#quick-error').textContent,/Choose an event/);
 let resolve;w.deferSearch=()=>new Promise(r=>resolve=r);w.eval('sbPublicRpc=window.deferSearch');const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));d.querySelector('[data-quick-kind="team"]').click();resolve([event]);await tick();assert.equal(d.querySelector('#quick-options').hidden,true);assert.equal(d.querySelectorAll('[data-quick-result]').length,0);
 }finally{h.close();}
});
test('invalid quick-link budgets cannot bypass the normal setup',async()=>{
 const h=setup('new','?quick=1&event=fixture&qty=99&price=-5&sms=0');try{await tick();assert.equal(h.d.querySelector('#qty').value,'2');assert.equal(h.d.querySelector('#target').value,'');assert.equal(h.d.querySelector('#save-alert'),null);}finally{h.close();}
});
test('the event list keeps category search, pagination and quantity-aware setup links working',async()=>{
 const h=setup();try{await tick();const {d,w}=h;
 w.pagedSearch=async(name,body)=>name==='tix_general_search'?Array.from({length:body.p_offset?2:13},(_,i)=>({...event,event_id:'game-'+((body.p_offset||0)+i)})):[];
 w.pagedGet=async path=>{if(!path.includes('tix_events_v'))return [];const offset=Number(new URL(path,'https://example.test').searchParams.get('offset')||0);return Array.from({length:offset?2:13},(_,i)=>({...event,event_id:'game-'+(offset+i)}));};w.eval('sbPublicRpc=window.pagedSearch;sbGet=window.pagedGet');d.querySelector('[data-category="theater"]').click();await tick();assert.equal(d.querySelector('#category').value,'theater');assert.equal(d.querySelectorAll('#events .event-row').length,12);assert.equal(d.querySelector('#more-events').hidden,false);d.querySelector('#more-events').click();await tick();assert.equal(d.querySelectorAll('#events .event-row').length,14);assert.equal(d.querySelector('#more-events').hidden,true);
 d.querySelector('#search-qty').value='4';d.querySelector('#search-qty').dispatchEvent(new w.Event('change'));await tick();assert.match(d.querySelector('.alert-button').href,/qty=4/);assert.match(d.querySelector('.alert-button').textContent,/Set my price/);
 }finally{h.close();}
});

test('nickname suggestions retain exact identities and do not cut off the pro team',async()=>{
 const h=setup();try{await tick();h.w.eval('window.rankTeams=rankQuickTeams');const colleges=Array.from({length:7},(_,i)=>({team_id:'college-'+i,label:'College '+i,category:'college-football',aliases:['Vikings']}));const rows=h.w.rankTeams([...colleges,team],'Vikings');assert.equal(rows[0].team_id,'vikings-source');assert.equal(new Set(rows.map(t=>t.team_id)).size,8);
 }finally{h.close();}
});
