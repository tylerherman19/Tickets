const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const shared=fs.readFileSync('tickets.js','utf8'),app=fs.readFileSync('app.js','utf8');
const event={event_id:'fixture',name:'Panthers at Vikings',slug:'panthers-at-vikings',category:'nfl-football',event_date:'2026-12-20',venue:'U.S. Bank Stadium',city:'Minneapolis',state:'MN',discovery_status:'ok'};
const team={team_id:'vikings-source',label:'Minnesota Vikings',category:'nfl-football',event_count:8};
const tick=()=>new Promise(r=>setImmediate(r));
function setup(page='explore',search='',signedIn=false){
 const dom=new JSDOM('<body data-page="'+page+'"><main id="main"></main></body>',{url:'https://example.test/'+(page==='new'?'new':'index')+'.html'+search,runScripts:'outside-only'});
 const w=dom.window;w.requests=[];w.saved=[];w.scrollTo=()=>{};w.testSession=signedIn?{access_token:'fixture-user'}:null;w.captureCalls=[];w.mockCapture=async id=>{w.captureCalls.push(id);return {event_id:id,min_total:10000,checked_at:new Date().toISOString(),state:'metadata_only'};};
 w.mockGet=async path=>{w.requests.push(path);return path.includes('tix_event_market')?[{checked_at:new Date().toISOString(),by_qty:{2:{low:11791,basis:'fees_included_tax_unknown'},4:{low:12500,basis:'fees_included_tax_reported'}}}]:path.includes('tix_events_v')?[event]:[];};
 w.mockRpc=async(name,body)=>{w.requests.push({name,body});return name==='tix_resolve_teams'?[team]:name==='tix_general_search'||name==='tix_search_team_events'?[event]:[];};
 w.mockSave=async(name,body)=>{w.saved.push({name,body});return {};};
 w.eval(shared+';chrome=()=>{};sbGet=window.mockGet;sbPublicRpc=window.mockRpc;sbRpc=window.mockSave;captureEventPrice=window.mockCapture;const IS_DEV=true,session=window.testSession;async function requireSession(){return true;}'+app);
 return {dom,w,d:w.document,close:()=>w.close()};
}
test('hero event search, exact-seat gap, delivery and review/save work as one flow',async()=>{
 const h=setup();try{
 await tick();const {w,d}=h;let next;w.captureNavigation=url=>next=url;w.eval('goToWatchSetup=window.captureNavigation');
 const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.Event('input'));input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();
 assert.equal(d.querySelectorAll('[data-quick-game]').length,1);d.querySelector('[data-quick-game]').click();await tick();
 const price=d.querySelector('#quick-price');price.value='75';price.dispatchEvent(new w.Event('input'));
 assert.match(d.querySelector('#quick-gap').textContent,/\$42.91 above your price/);assert.match(d.querySelector('#quick-gap').textContent,/\$235.82 total/);
 assert.match(d.querySelector('#quick-gap').textContent,/tax may be added/);
 d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));
 assert.ok(next);const params=new URL(next,'https://example.test').searchParams;assert.equal(params.get('event'),'fixture');assert.equal(params.get('qty'),'2');assert.equal(params.get('price'),'75');
 const b=setup('new','?'+params);try{await tick();assert.match(b.d.querySelector('.review-list').textContent,/2 tickets together/);assert.match(b.d.querySelector('.review-list').textContent,/\$150 total/);b.d.querySelector('#save-alert').click();await tick();const save=b.w.saved.find(x=>x.name==='tix_save_alert');assert.equal(save.body.p_watch.threshold_cents,7500);assert.equal(save.body.p_watch.qty,2);assert.equal(save.body.p_watch.match.event_ids[0],'fixture');assert.match(b.d.querySelector('h1').textContent,/on the list/);}finally{b.close();}
 }finally{h.close();}
});
test('hero quantity changes recalculate the gap and old samples never show a price',async()=>{
 const h=setup();try{await tick();const {d,w}=h;const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();d.querySelector('[data-quick-game]').click();await tick();d.querySelector('[data-quick-qty="4"]').click();d.querySelector('#quick-price').value='100';d.querySelector('#quick-price').dispatchEvent(new w.Event('input'));assert.match(d.querySelector('#quick-gap').textContent,/\$500 total/);assert.match(d.querySelector('#quick-gap').textContent,/\$25 above/);
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
 const resolvers=[];w.deferSearch=()=>new Promise(r=>resolvers.push(r));w.eval('sbPublicRpc=window.deferSearch');const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));d.querySelector('[data-quick-kind="date"]').click();resolvers.forEach(resolve=>resolve([event]));await tick();assert.equal(d.querySelector('#quick-options').hidden,true);assert.equal(d.querySelectorAll('[data-quick-result]').length,0);
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

test('Badger football resolves the source football identity, shows its schedule and filters opponents, dates and locations',async()=>{
 const h=setup();try{await tick();const {w,d}=h;let next;w.captureNavigation=url=>next=url;w.eval('goToWatchSetup=window.captureNavigation');
 const wis={team_id:'cfbwis',label:'Wisconsin Football',category:'college-football'};
 const games=[{...event,event_id:'gopher-game',name:'Minnesota Golden Gophers at Wisconsin Badgers',event_date:'2026-11-27',venue:'Camp Randall Stadium',city:'Madison',state:'WI'},{...event,event_id:'trojan-game',name:'Wisconsin Badgers at USC Trojans',event_date:'2026-12-01',venue:'Memorial Coliseum',city:'Los Angeles',state:'CA'}];
 w.searchTeams=async(name,body)=>{
  w.requests.push({name,body});if(name==='tix_general_search')return [];
  if(name==='tix_search_team_events'){assert.equal(body.p_team_id,'cfbwis');return games;}
  if(body.p_query==='badger')return [{team_id:'cbbwis',label:'Wisconsin Basketball',category:'college-basketball',aliases:['Badgers']},{team_id:'cbbspringhill',label:'Spring Hill College Basketball',category:'college-basketball',aliases:['Badgers']}];
  return body.p_query==='Wisconsin'&&body.p_category==='college-football'?[wis]:[];
 };w.eval('sbPublicRpc=window.searchTeams');
 const input=d.querySelector('#quick-search');input.value='badger football';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();await tick();
 assert.equal(d.querySelector('#quick-opponent'),null);assert.equal(d.querySelector('#quick-schedule'),null);
 assert.equal(d.querySelectorAll('#quick-options [data-quick-game]').length,2);assert.match(d.querySelector('#quick-options').textContent,/Nov 27/);assert.match(d.querySelector('#quick-options').textContent,/Camp Randall Stadium.*Madison, WI/);
 input.value='Wisconsin Football gophers';input.dispatchEvent(new w.Event('input'));assert.equal(d.querySelectorAll('[data-quick-game]').length,1);assert.match(d.querySelector('[data-quick-game]').textContent,/Minnesota/);
 input.value='Wisconsin Football Los Angeles';input.dispatchEvent(new w.Event('input'));assert.match(d.querySelector('[data-quick-game]').textContent,/USC/);
 input.value='Wisconsin Football 2026-11-27';input.dispatchEvent(new w.Event('input'));d.querySelector('[data-quick-game]').click();await tick();assert.match(input.value,/Minnesota.*Wisconsin/);assert.equal(d.querySelector('#quick-options').hidden,true);assert.match(d.querySelector('#quick-search-status').textContent,/Nov 27.*Madison/);
 d.querySelector('#quick-price').value='90';d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(new URL(next,'https://example.test').searchParams.get('event'),'gopher-game');
 next=undefined;input.value='Wisconsin Football Trojans';input.dispatchEvent(new w.Event('input'));d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(next,undefined);assert.match(d.querySelector('#quick-error').textContent,/Choose a game/);
 d.querySelector('[data-quick-kind=team]').click();d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(new URL(next,'https://example.test').searchParams.get('team'),'cfbwis');assert.equal(new URL(next,'https://example.test').searchParams.get('category'),'college-football');
 }finally{h.close();}
});
test('a replacement team rejects a late schedule, and empty schedules still allow following the team',async()=>{
 const h=setup();try{await tick();const {w,d}=h;let finishBucks;const twins={team_id:'mlbmin',label:'Minnesota Twins',category:'mlb-baseball'},bucks={team_id:'nbamil',label:'Milwaukee Bucks',category:'nba-basketball'};
 w.scheduleRpc=async(name,body)=>{if(name==='tix_general_search')return [];if(name==='tix_resolve_teams')return [body.p_query==='Bucks'.toLowerCase()?bucks:twins];if(body.p_team_id==='nbamil')return new Promise(r=>finishBucks=r);return [];};w.eval('sbPublicRpc=window.scheduleRpc');
 const input=d.querySelector('#quick-search');input.value='Bucks';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();
 input.value='Twins';input.dispatchEvent(new w.Event('input'));input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();finishBucks([{...event,name:'Bucks at Celtics'}]);await tick();
 assert.match(d.querySelector('#quick-options').textContent,/Minnesota Twins games/);assert.doesNotMatch(d.querySelector('#quick-options').textContent,/Celtics/);assert.match(d.querySelector('#quick-options').textContent,/No upcoming games/);
 let next;w.captureNavigation=url=>next=url;w.eval('goToWatchSetup=window.captureNavigation');d.querySelector('#quick-price').value='50';d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(next,undefined);assert.match(d.querySelector('#quick-error').textContent,/Choose a game/);d.querySelector('[data-quick-kind=team]').click();d.querySelector('#quick-watch-form').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(new URL(next,'https://example.test').searchParams.get('team'),'mlbmin');
 }finally{h.close();}
});
test('Minnesota first offers teams, then the same dropdown shows only Vikings games',async()=>{
 const h=setup();try{await tick();const {w,d}=h;const wolves={team_id:'nbamin',label:'Minnesota Timberwolves',category:'nba-basketball'};
 w.broadSearch=async(name,body)=>name==='tix_resolve_teams'?[wolves,team]:name==='tix_search_team_events'?[event,{...event,event_id:'lions',name:'Vikings at Lions',venue:'Ford Field',city:'Detroit',state:'MI'}]:[];w.eval('sbPublicRpc=window.broadSearch');
 const input=d.querySelector('#quick-search');input.value='Minnesota';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();assert.equal(d.querySelectorAll('[data-quick-result-type=team]').length,2);assert.equal(d.querySelectorAll('[data-quick-game]').length,0);
 const vikings=[...d.querySelectorAll('[data-quick-result]')].find(b=>b.textContent.includes('Minnesota Vikings'));vikings.click();await tick();
 assert.equal(d.querySelectorAll('[data-quick-result-type=team]').length,0);assert.equal(d.querySelectorAll('[data-quick-game]').length,2);assert.doesNotMatch(d.querySelector('#quick-options').textContent,/Timberwolves/);assert.match(d.querySelector('#quick-options').textContent,/Ford Field.*Detroit/);assert.equal(d.querySelectorAll('.quick-watch input[type=search]').length,1);
 input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown'}));assert.equal(d.activeElement.dataset.quickGame,'fixture');d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(d.querySelector('#quick-options').hidden,true);
 }finally{h.close();}
});
test('a full team name immediately opens its games in the original dropdown',async()=>{
 const h=setup();try{await tick();const {w,d}=h;const input=d.querySelector('#quick-search');input.value='Minnesota Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();
 assert.equal(d.querySelectorAll('[data-quick-result]').length,0);assert.match(d.querySelector('#quick-options').textContent,/Panthers at Vikings/);assert.match(d.querySelector('#quick-options').textContent,/U.S. Bank Stadium/);
 }finally{h.close();}
});
test('choosing a game triggers one instant pull and renders its fresh advertised price while exact seats are pending',async()=>{
 const h=setup('explore','',true);try{await tick();const {w,d}=h;const timers=[],originalTimeout=w.setTimeout.bind(w);w.setTimeout=(callback,ms,...args)=>ms===5000?(timers.push(callback),98765):originalTimeout(callback,ms,...args);
 let quote=null,market=[];w.readQuote=async path=>path.includes('tix_event_market')?market:path.includes('tix_events_v')?(quote?[quote]:[]):[];w.pullQuote=async id=>{w.captureCalls.push(id);quote={min_total:4500,price_checked_at:new Date().toISOString()};return {event_id:id,min_total:4500,checked_at:quote.price_checked_at,state:'metadata_only'};};w.eval('sbGet=window.readQuote;captureEventPrice=window.pullQuote');
 const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();d.querySelector('[data-quick-game]').click();await tick();await tick();
 assert.deepEqual(w.captureCalls,['fixture']);const detail=w.saved.find(r=>r.name==='tix_request_capture');assert.equal(detail.body.p_details,true);assert.equal(w.saved.some(r=>r.name==='tix_save_alert'),false);
 assert.match(d.querySelector('#quick-gap').textContent,/Lowest advertised ticket.*\$45/);assert.match(d.querySelector('#quick-gap').textContent,/Seat count and tax are not confirmed/);assert.doesNotMatch(d.querySelector('#quick-gap').textContent,/above your price|below your price/);assert.equal(timers.length,1);
 d.querySelector('#quick-refresh-price').click();await tick();assert.equal(w.captureCalls.length,1,'one provider request per event per minute');
 market=[{checked_at:new Date().toISOString(),by_qty:{2:{low:7420,listings:228,basis:'fees_included_tax_unknown'}}}];await timers.pop()();assert.match(d.querySelector('#quick-gap').textContent,/Current price · 2 tickets together/);assert.match(d.querySelector('#quick-gap').textContent,/\$74.20/);assert.match(d.querySelector('#quick-gap').textContent,/228 matching listings/);assert.equal(w.captureCalls.length,1);
 }finally{h.close();}
});
test('an old quick-pull result cannot overwrite the newly selected game',async()=>{
 const h=setup('explore','',true);try{await tick();const {w,d}=h;let firstResult;w.getQuotes=async()=>[];w.getGames=async(name)=>name==='tix_resolve_teams'?[team]:name==='tix_search_team_events'?[event,{...event,event_id:'second',name:'Vikings at Lions'}]:[];w.pullSelected=async id=>{w.captureCalls.push(id);if(id==='fixture')return new Promise(resolve=>firstResult=resolve);return {event_id:id,state:'metadata_only',min_total:9000,checked_at:new Date().toISOString()};};w.eval('sbGet=window.getQuotes;sbPublicRpc=window.getGames;captureEventPrice=window.pullSelected');
 const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();d.querySelector('[data-quick-game=fixture]').click();await tick();input.focus();d.querySelector('[data-quick-game=second]').click();await tick();firstResult({state:'metadata_only',min_total:1000,checked_at:new Date().toISOString()});await tick();assert.match(input.value,/Lions/);assert.match(d.querySelector('#quick-gap').textContent,/\$90/);assert.doesNotMatch(d.querySelector('#quick-gap').textContent,/\$10/);
 }finally{h.close();}
});
test('guests see a fresh saved exact-seat price without issuing an authenticated pull',async()=>{
 const h=setup();try{await tick();const {w,d}=h;const input=d.querySelector('#quick-search');input.value='Vikings';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));await tick();d.querySelector('[data-quick-game]').click();await tick();assert.match(d.querySelector('#quick-gap').textContent,/Current price · 2 tickets together/);assert.match(d.querySelector('#quick-gap').textContent,/\$117.91/);assert.equal(w.captureCalls.length,0);assert.equal(w.saved.some(r=>r.name==='tix_request_capture'),false);
 }finally{h.close();}
});
