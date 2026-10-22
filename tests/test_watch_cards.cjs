const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const app=fs.readFileSync('app.js','utf8');
function page(dev=true){
 const dom=new JSDOM('<body data-page="watches"><div id="watches"></div><dialog id="dialog"></dialog>',{url:'https://ticketline.example/watches.html',runScripts:'outside-only'});
 const w=dom.window;w.matchSummary=()=> 'Home games';w.teamName=(category,slug)=>slug;
 w.eval(fs.readFileSync('tickets.js','utf8')+'\n'+fs.readFileSync('team-logos.js','utf8')+`;const IS_DEV=${dev};var state={watches:[],prices:[],scans:[],intelligence:[],eventMarkets:{},filter:'all'};`+app.slice(app.indexOf('function alertFrequencyLabel('),app.indexOf('async function builder(){'))+app.slice(app.indexOf('let watchPollTimer='),app.indexOf('async function watches(){')));
 return {w,close:()=>dom.window.close(),set:(name,value)=>w.eval('state.'+name+'='+JSON.stringify(value)),run:s=>w.eval(s)};
}
const watch={id:'vikings',kind:'team',active:true,label:'Vikings Home',qty:2,threshold_cents:7000,criteria_version:1,created_at:'2026-01-01',clubs:[],match:{slug:'minnesota-vikings',category:'nfl-football'}};
test('custom event alerts show the actual matchup and date while updating or paused',()=>{
 const {w,set,run,close}=page();try{
 const eventWatch={...watch,kind:'event',label:'Wild-Helen',match:{event_ids:['game'],event_date:'2026-11-01'}};
 set('eventMarkets',{game:{event_id:'game',name:'St. Louis Blues at Minnesota Wild',event_date:'2026-11-03',category:'nhl-hockey'}});
 for(const active of [true,false]){
  set('watches',[{...eventWatch,active}]);run('renderWatches()');
  const card=w.document.querySelector('.watch-card');
  assert.equal(card.querySelector('h2').textContent,'St. Louis Blues at Minnesota Wild');assert.equal(card.querySelector('.watch-personal-label').textContent,'Wild-Helen');
  assert.match(card.querySelector('.watch-event').textContent,/St. Louis Blues at Minnesota WildTue, Nov 3, 2026/);
  assert.equal(card.querySelector('.watch-event a').getAttribute('href'),'./event.html?event=game');
 }
 set('eventMarkets',{});run('renderWatches()');
 assert.match(w.document.querySelector('.watch-event').textContent,/Event details unavailableSun, Nov 1, 2026/);
 }finally{close();}
});
test('event details are escaped, include every selected game, and do not appear on team alerts',()=>{
 const {w,set,run,close}=page();try{
 set('watches',[{...watch,kind:'event',match:{event_ids:['one','two']}},watch]);
 set('eventMarkets',{one:{name:'<script>alert(1)</script>',event_date:'2027-01-02'},two:{name:'Wild at Blues',event_date:'2027-02-03'}});
 run('renderWatches()');
 const cards=w.document.querySelectorAll('.watch-card');
 assert.equal(cards[0].querySelectorAll('.watch-event').length,2);
 assert.equal(cards[0].querySelector('script'),null);
 assert.match(cards[0].textContent,/2027/);
 assert.equal(cards[1].querySelector('.watch-event-details'),null);
 }finally{close();}
});
test('Vikings and Wild use the correct team logos; unrelated custom labels cannot invent a team',()=>{
 const {run,close}=page();try{
 assert.equal(run(`watchTeamLogo(${JSON.stringify(watch)},null).name`),'Minnesota Vikings');
 assert.equal(run(`watchTeamLogo({kind:'event',label:'Wild-Helen',match:{}},{category:'nhl-hockey',slug:'st-louis-blues-at-minnesota-wild',name:'St. Louis Blues at Minnesota Wild'}).name`),'Minnesota Wild');
 assert.equal(run(`watchTeamLogo({kind:'event',label:'Vikings',match:{}},{category:'nhl-hockey',slug:'st-louis-blues-at-minnesota-wild',name:'St. Louis Blues at Minnesota Wild'}).name`),'Minnesota Wild');
 assert.equal(run(`watchTeamLogo({kind:'date',label:'Vikings',match:{}},null)`),null);
 assert.equal(run(`findTeamLogo('Tigers','college-basketball')`),null);
 }finally{close();}
});
test('an outdated card hides old prices, old matching counts, and old unavailable claims',()=>{
 const {w,set,run,close}=page();try{
 const old=new Date(Date.now()-3*3600000).toISOString();
 set('watches',[watch]);set('intelligence',[{watch_id:'vikings',criteria_version:1,last_checked_at:old,price_checked_at:old,scan_outcome:'ok',current_price_cents:12500,basis:'fees_included_tax_unknown',scan_detail:{matching_listings:201,available_lots:[1,2,3,4,5,6,7,8]}}]);
 set('prices',[{watch_id:'vikings',price_cents:12500,basis:'fees_included_tax_unknown',checked_at:old}]);
 run('renderWatches()');const card=w.document.querySelector('.watch-card');
 assert.match(card.textContent,/Updating prices/);assert.doesNotMatch(card.textContent,/\$125|201 listings|No 2-seat|Previous verified/);
 assert.match(card.querySelector('.watch-progress').textContent,/Last attempt 3 hr ago/);
 assert.equal(card.querySelector('.team-logo').alt,'Minnesota Vikings');
 card.querySelector('.team-logo').dispatchEvent(new w.Event('error'));
 assert.equal(card.querySelector('.team-logo'),null);assert.equal(card.querySelector('.sport-stamp').classList.contains('has-team-logo'),false);
 }finally{close();}
});
test('a fresh two-ticket match is shown and its quantity count is explicit',()=>{
 const {w,set,run,close}=page();try{
 const now=new Date().toISOString();
 set('watches',[watch]);set('intelligence',[{watch_id:'vikings',criteria_version:1,last_checked_at:now,price_checked_at:now,scan_outcome:'ok',current_price_cents:6500,basis:'fees_included_tax_unknown',scan_detail:{matching_listings:201,available_lots:[1,2,3,4]}}]);
 run('renderWatches()');const card=w.document.querySelector('.watch-card');assert.match(card.textContent,/\$65/);assert.match(card.textContent,/201 listings offered 2 tickets together/);assert.doesNotMatch(card.textContent,/No 2-seat|Updating prices/);
 }finally{close();}
});
test('fresh-check requests are bounded, skip paused alerts, and are not repeated on each poll',async()=>{
 const {w,set,run,close}=page(false);try{
 const requests=[];w.sbRpc=async(name,body)=>{requests.push({name,body});return {state:'queued'};};
 set('watches',[{...watch,id:'one',kind:'event',match:{event_ids:['event1']}},{...watch,id:'two',kind:'event',match:{event_ids:['event1']}},{...watch,id:'paused',active:false,kind:'event',match:{event_ids:['event2']}}]);
 await run('requestFreshWatchChecks()');assert.equal(requests.length,1);assert.deepEqual(Array.from(requests[0].body.p_event_ids),['event1']);assert.equal(requests[0].name,'tix_prioritize_search');
 await run('requestFreshWatchChecks()');assert.equal(requests.length,1);
 assert.equal(run('state.watchRefreshStates.one'),'queued');
 }finally{close();}
});
test('a failed refresh request produces an honest retry message instead of a current price',async()=>{
 const {w,set,run,close}=page(false);try{
 w.sbRpc=async()=>{throw Error('offline');};set('watches',[watch]);await run('requestFreshWatchChecks()');
 assert.match(run(`watchDiagnostic(${JSON.stringify(watch)},null,null,null)`),/Could not request current prices/);
 }finally{close();}
});

test('cards distinguish first checks, stale checks, successful empty scans and database failures',()=>{
 const {run,close}=page();try{
 const w=JSON.stringify(watch),now=new Date().toISOString();
 assert.equal(run(`watchStatus(${w},null,null,null,false,false)`),'First check pending');
 assert.equal(run(`watchStatus(${w},{last_checked_at:'2020-01-01'},null,null,false,false)`),'Check pending');
 assert.equal(run(`watchStatus(${w},{last_checked_at:'${now}',scan_outcome:'unavailable'},null,null,false,false)`),'No matching seats');
 assert.match(run(`watchDiagnostic(${w},{last_checked_at:'${now}',scan_outcome:'failed',scan_detail:{source:'database'}},null,null)`),/database save/);
 assert.match(run(`watchProgress(${w},{last_checked_at:'${now}',last_success_at:'${now}',criteria_version:1})`),/Last successful check/);
 assert.match(run(`watchGap(${w},{price_cents:9200,basis:'fees_included_tax_unknown'})`),/\$22 above your target/);
 assert.match(run(`watchGap(${w},{price_cents:9200,basis:'fees_included_tax_unknown'})`),/\$184 total for 2/);
 }finally{close();}
});
test('inline target edits save narrowly and show failures without losing input',async()=>{
 const {w,set,run,close}=page();try{
 w.toast=()=>{};let saved;
 w.sbRpc=async(name,body)=>{saved={name,body};return {...watch,threshold_cents:7500,criteria_version:2};};
 set('watches',[watch]);run('renderWatches()');w.document.querySelector('[data-action="target"]').click();
 const form=w.document.querySelector('.watch-target-editor');form.querySelector('input').value='75';await form.onsubmit({preventDefault(){}});
 assert.equal(saved.name,'tix_update_watch_controls');assert.equal(saved.body.p_threshold_cents,7500);assert.equal(saved.body.p_expected_version,1);assert.match(w.document.querySelector('.watch-score').textContent,/\$75/);
 w.sbRpc=async()=>{throw Error('Refresh before editing.');};w.document.querySelector('[data-action="target"]').click();const failed=w.document.querySelector('.watch-target-editor');failed.querySelector('input').value='80';await failed.onsubmit({preventDefault(){}});assert.match(failed.textContent,/Refresh before editing/);assert.equal(failed.querySelector('input').value,'80');
 }finally{close();}
});
test('team schedules show quantity-verified prices and save game exclusions',async()=>{
 const {w,set,run,close}=page();try{
 w.quickGameDate=g=>g.event_date;
 w.sbPublicRpc=async()=>[{event_id:'game1',name:'Colts at Vikings',event_date:'2027-11-01',is_home:true},{event_id:'away',name:'Vikings at Bears',event_date:'2027-11-02',is_home:false}];
 w.sbGet=async()=>[{event_id:'game1',checked_at:new Date().toISOString(),by_qty:{2:{low:6500,basis:'fees_included_tax_unknown'}}}];
 let saved;w.sbRpc=async(name,body)=>{saved=body;return {...watch,criteria_version:2,match:{...watch.match,team_id:'nflmin',home_away:'home',excluded_event_ids:body.p_excluded_event_ids}};};
 set('watches',[{...watch,match:{...watch.match,team_id:'nflmin',home_away:'home'}}]);run('renderWatches()');
 const details=w.document.querySelector('.watch-schedule');await run('loadWatchSchedule(state.watches[0],document.querySelector(".watch-schedule"))');
 assert.match(details.textContent,/Colts at Vikings/);assert.doesNotMatch(details.textContent,/Vikings at Bears/);assert.match(details.textContent,/\$65 per ticket · under your target/);
 const input=details.querySelector('input');input.checked=true;await input.onchange();assert.deepEqual(Array.from(saved.p_excluded_event_ids),['game1']);assert.equal(saved.p_expected_version,1);assert.match(details.textContent,/preferences saved/);
 }finally{close();}
});
