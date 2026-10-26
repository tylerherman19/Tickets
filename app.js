'use strict';
const page=document.body.dataset.page;
chrome(page);
const main=$('#main');
const query=new URLSearchParams(location.search);
const state={events:[],category:query.get('category')==='all'?'':query.get('category')||'',search:(query.get('q')||'').slice(0,100),place:(query.get('place')||'').slice(0,60),date:/^\d{4}-\d{2}-\d{2}$/.test(query.get('date')||'')&&query.get('date')>=todayISO()?query.get('date'):'',within:['7','30','all'].includes(query.get('within'))?query.get('within'):'',cheapOnly:query.get('cheap')==='1',catalogFallback:false,catalogSnapshotAt:null,maxPrice:/^\d{1,5}$/.test(query.get('max')||'')?query.get('max'):'',offset:0,controller:null,kind:'event',selected:null,teams:[],step:1,qty:2,threshold:'',budgetMode:'per',clubLevel:false,clubs:[],clubOptions:[],homeAway:'home',alertStyle:'first',emailEnabled:true,smsEnabled:false,phone:'',provider:'',destinationConfigured:false,existingProvider:'',watches:[],prices:[],scans:[],intelligence:[],eventMarkets:{},filter:'all',activityKind:'alerts',activityWatch:'all',activitySort:'newest',spread:null,lotFilter:'any',searchQty:/^[1-8]$/.test(query.get('qty')||'')?Number(query.get('qty')):0,exploreTeamId:query.get('team')||'',exploreTeam:null,teamEventIds:null,teamGames:[],teamChoices:[],chartHome:true,quantityPrices:{},priorityKey:''};
state.pendingSearchActivity=page==='explore'?newSearchActivity('link',state.search):null;
const matchSummary=w=>w.kind==='team'?`${w.match.team_label||cap(w.match.slug)} · ${w.match.home_away==='any'?'Home & away':cap(w.match.home_away||'home')+' games'}`:w.kind==='date'?whenShort(w.match.date)+(w.match.city?` in ${w.match.city}`:w.match.state?` in ${w.match.state}`:''):w.label;
function layout(title,sub,body,action='') {main.innerHTML=`<div class="container page"><div class="page-heading"><div><h1>${title}</h1><p>${sub}</p></div>${action}</div>${body}</div>`;}
function heroCard(){return `<aside class="start-card quick-watch" aria-labelledby="start-title"><div class="start-card-head"><h2 id="start-title">Start a watch</h2><span>Your event. Your price.</span></div><form id="quick-watch-form"><label class="field-label" id="quick-search-label" for="quick-search">1 · What do you want to see?</label><div class="quick-search-box"><div class="search-input">${icon('search')}<input id="quick-search" type="search" autocomplete="off" maxlength="100" placeholder="Team, artist, show or city" aria-controls="quick-options" aria-describedby="quick-search-status"></div><div id="quick-options" class="quick-options" hidden></div></div><p id="quick-search-status" class="field-help" role="status">Search a team or event, then choose a match.</p><div class="quick-scopes" aria-label="What to watch"><button type="button" data-quick-kind="event" aria-pressed="true">This event</button><button type="button" data-quick-kind="team" aria-pressed="false">A whole team</button><button type="button" data-quick-kind="date" aria-pressed="false">Anything that day</button></div><div id="quick-day-fields" hidden><label class="field-label" for="quick-date">Event date</label><input id="quick-date" type="date" min="${todayISO()}" max="${todayISO(new Date(Date.now()+365*86400000))}"><label class="field-label" for="quick-city">City <span>optional</span></label><input id="quick-city" maxlength="60" placeholder="e.g. Minneapolis"></div><div class="quick-price-fields"><fieldset class="quick-quantity"><legend class="field-label">2 · Seats together</legend><div class="quick-seats">${[1,2,3,4,5].map(n=>`<button type="button" data-quick-qty="${n}" aria-pressed="${n===2}">${n===5?'5+':n}</button>`).join('')}</div><label class="sr-only" for="quick-more-qty">Exact number of tickets</label><select id="quick-more-qty" hidden>${[5,6,7,8].map(n=>`<option value="${n}">${n} tickets together</option>`).join('')}</select></fieldset><div class="quick-target"><label class="field-label" for="quick-price">3 · Your price, per ticket</label><div class="currency-input"><span>$</span><input id="quick-price" type="number" inputmode="decimal" min="1" max="400000" step="0.01" placeholder="75" required><small>fees included</small></div></div></div><div id="quick-gap" class="quick-gap" aria-live="polite"><strong>The gap right now</strong><p>Choose a team or event to get started.</p></div><div class="quick-bottom"><div class="quick-delivery"><label><input id="quick-email" type="checkbox" checked> Email</label><label><input id="quick-text" type="checkbox"> Text</label></div><button class="button primary" id="quick-submit" type="submit">Start watching ${icon('arrow')}</button></div><p id="quick-error" class="quick-error" role="alert" hidden></p><p class="quick-footnote">Review before saving. Text delivery needs a carrier and number. <a href="./privacy.html">Search privacy</a>.</p></form></aside>`;}
function goToWatchSetup(url){location.href=url;}
function quickWatchUrl(draft){
 const params=new URLSearchParams({quick:'1',qty:String(draft.qty),price:draft.price,email:draft.email?'1':'0',sms:draft.sms?'1':'0'});
 if(draft.kind==='event')params.set('event',draft.selected.event_id);
 else if(draft.kind==='team'){params.set('kind','team');params.set('team',draft.selected.team_id);params.set('category',draft.selected.category);}
 else{params.set('kind','date');params.set('date',draft.date);if(draft.city)params.set('city',draft.city);}
 return './new.html?'+params;
}
function quickExactPrice(sample,qty){
 const spread=sample?.by_qty?.[String(qty)],checkedAt=spread?.checked_at||sample?.checked_at,age=ageMinutes(checkedAt);
 return Number.isFinite(age)&&age<15&&new Date(checkedAt).getTime()<=Date.now()+60000&&knownPriceBasis(spread?.basis)&&Number.isInteger(spread?.low)&&spread.low>0?spread:null;
}
function quickGapMarkup(sample,qty,target,context={}){
 const spread=quickExactPrice(sample,qty);
 if(!spread){
  const quote=context.event,age=ageMinutes(quote?.price_checked_at),fresh=Number.isFinite(age)&&age<15&&new Date(quote.price_checked_at).getTime()<=Date.now()+60000&&Number.isInteger(quote.min_total)&&quote.min_total>0;
  const pending=['checking','queued'].includes(context.state);
  return (fresh?`<div class="quick-current-price"><small>Lowest advertised ticket</small><div><strong>${money(quote.min_total)}</strong><span>per ticket</span></div></div><p>Seat count and tax are not confirmed. ${pending?'Checking your '+esc(qty)+' tickets together.':'Your selected seats may cost more.'} Checked ${esc(ago(quote.price_checked_at).toLowerCase())}.</p>`:`<strong>Current ticket price</strong><p>${context.state==='checking'?'Pulling current prices…':pending?'The price check is queued. This card will update as results arrive.':'A fresh price for '+esc(qty)+' tickets together is not available yet. You can still set your alert.'}</p>`);
 }
 const current=spread.low,diff=current-target,valid=Number.isInteger(target)&&target>0,max=Math.max(current,valid?target:0)*1.25;
 const a=valid?Math.max(8,Math.min(88,target/max*100)):8,b=Math.max(8,Math.min(88,current/max*100));
 return `<div class="quick-current-price"><small>Current price · ${esc(qty)} tickets together</small><div><strong>${money(current)}</strong><span>per ticket</span></div></div><div class="quick-gap-heading"><strong>The gap right now</strong><span>${valid?(diff>0?money(diff)+' above your price':diff<0?money(-diff)+' below your price':'At your price'):'Enter your price to compare'}</span></div><div class="quick-gap-track" aria-hidden="true">${valid?`<span class="quick-gap-you" style="left:${a}%">You ${money(target)}</span><i class="quick-gap-distance" style="left:${Math.min(a,b)}%;width:${Math.abs(a-b)}%"></i>`:''}<span class="quick-gap-now" style="left:${b}%">Now ${money(current)}</span></div><p>${Number.isInteger(spread.listings)?esc(spread.listings)+' matching listings · ':''}${esc(qty)} tickets together · ${money(current)} per ticket · ${money(current*qty)} total. ${spread.basis==='fees_included_tax_reported'?'Fees and reported tax included.':'Fees included; tax may be added.'} Checked ${esc(ago(spread.checked_at||sample.checked_at).toLowerCase())}.</p>`;
}
async function quickPullEvent(eventId,qty){
 // Public quote checks never create alerts. The server safely records interest.
 return captureEventPrice(eventId,{qty});
}

function rankQuickTeams(rows,term){
 const normalize=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(),q=normalize(term);
 const score=t=>{const label=normalize(t.label),names=[label,...(t.aliases||[]).map(normalize)];return (names.includes(q)?100:label.endsWith(' '+q)?40:0)+(['nfl-football','nhl-hockey','nba-basketball','mlb-baseball','mls-soccer'].includes(t.category)?80:0);};
 return [...rows].sort((a,b)=>score(b)-score(a)||String(a.label).localeCompare(String(b.label)));
}
function parseQuickSearch(term){
 const words=String(term).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/);
 const sports={football:['nfl-football','college-football'],fb:['nfl-football','college-football'],basketball:['nba-basketball','college-basketball'],bb:['nba-basketball','college-basketball'],baseball:['mlb-baseball'],hockey:['nhl-hockey'],soccer:['mls-soccer'],nfl:['nfl-football'],nba:['nba-basketball'],nhl:['nhl-hockey'],mlb:['mlb-baseball'],mls:['mls-soccer'],ncaaf:['college-football'],ncaab:['college-basketball']};
 const explicit=words.find(w=>['nfl','nba','nhl','mlb','mls','ncaaf','ncaab'].includes(w)),sport=explicit||words.find(w=>sports[w]);
 let categories=sport?sports[sport]:null;if(categories&&words.includes('college'))categories=categories.filter(c=>c.startsWith('college-'));
 return {text:words.filter(w=>!sports[w]&&!['college','ncaa'].includes(w)).join(' '),categories};
}
function quickSchoolName(label){return String(label||'').replace(/\s+(?:Football|Basketball|Baseball|Hockey|Soccer)$/i,'').trim();}
async function quickTeamMatches(term){
 const parsed=parseQuickSearch(term),rows=await sbPublicRpc('tix_resolve_teams',{p_query:parsed.text||term,p_category:null,p_limit:100})||[];
 let matches=parsed.categories?rows.filter(t=>parsed.categories.includes(t.category)):rows;
 // Some source directories omit the football nickname. Resolve the same school
 // in the requested sport, then verify its school name before offering its ID.
 if(parsed.categories){
  const schools=[...new Set(rows.filter(t=>t.category.startsWith('college-')).map(t=>quickSchoolName(t.label)))].slice(0,4);
  const requests=schools.flatMap(school=>parsed.categories.filter(c=>c.startsWith('college-')).map(category=>({school,category})));
  const results=await Promise.allSettled(requests.map(r=>sbPublicRpc('tix_resolve_teams',{p_query:r.school,p_category:r.category,p_limit:20})));
  results.forEach((result,i)=>{if(result.status==='fulfilled')for(const team of result.value||[]){if(quickSchoolName(team.label).toLowerCase()===requests[i].school.toLowerCase()&&team.category===requests[i].category)matches.push(team);}});
 }
 return rankQuickTeams([...new Map(matches.map(t=>[t.team_id,t])).values()],parsed.text||term).slice(0,6).map(t=>({...t,_quickType:'team'}));
}
async function quickSearchMatches(kind,term){
 if(kind==='team')return quickTeamMatches(term);
 const results=await Promise.allSettled([
  quickTeamMatches(term),
  sbPublicRpc('tix_general_search',{p_query:term,p_limit:6,p_offset:0,p_through:todayISO(new Date(Date.now()+365*86400000))})
 ]);
 const teams=results[0].status==='fulfilled'?results[0].value:[];
 const events=results[1].status==='fulfilled'?(results[1].value||[]).map(e=>({...e,_quickType:'event'})):[];
 if(!teams.length&&!events.length&&results.every(r=>r.status==='rejected'))throw results[0].reason;
 return [...teams,...events].slice(0,8);
}
function quickGameLocation(game){return [game.venue||cap(game.venue_slug),[game.city,game.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')||'Venue to be confirmed';}
function quickGameDate(game){return whenShort(game.event_date)+(game.event_date?.slice(0,4)!==String(new Date().getFullYear())?' '+game.event_date?.slice(0,4):'');}
function filterQuickGames(games,term){
 const words=String(term).toLowerCase().trim().split(/\s+/).filter(Boolean);
 return games.filter(game=>{const text=[game.name,game.event_date,quickGameDate(game),quickGameLocation(game)].join(' ').toLowerCase();return words.every(word=>text.includes(word));});
}
function automaticQuickTeam(rows,term){
 const teams=rows.filter(row=>row._quickType==='team'),q=parseQuickSearch(term).text.toLowerCase();
 const normalize=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 const exact=teams.filter(t=>[t.label,...(t.aliases||[])].some(name=>normalize(name)===q));
 if(exact.length===1)return exact[0];
 const pro=teams.filter(t=>['nfl-football','nhl-hockey','nba-basketball','mlb-baseball','mls-soccer'].includes(t.category)&&normalize(t.label).endsWith(' '+q));
 if(q&&pro.length===1)return pro[0];
 return teams.length===1?teams[0]:null;
}
function bindQuickWatch(){
 const form=$('#quick-watch-form');if(!form)return;
 const draft={kind:'event',selected:null,qty:2,sample:null,rows:[],team:null,games:[],searchTerm:'',teamTerm:'',pullState:'',pullMessage:'',pullId:0};
 const pricePulls=new Map(),quoteCache=new Map();let pricePollTimer=null;
 const cacheQuote=row=>{if(row?.event_id)quoteCache.set(row.event_id+':'+draft.qty,{...row,loadedAt:Date.now()});};
 const prefetchQuotes=rows=>{const qty=draft.qty;return sbPublicRpc('tix_public_quotes',{p_event_ids:rows.slice(0,12).map(e=>e.event_id),p_qty:qty}).then(quotes=>(quotes||[]).forEach(row=>quoteCache.set(row.event_id+':'+qty,{...row,loadedAt:Date.now()}))).catch(()=>{});};
 const input=$('#quick-search'),options=$('#quick-options'),status=$('#quick-search-status'),gap=$('#quick-gap');
 let searchTimer,request=0,priceRequest=0,scheduleRequest=0,scheduleLoaded=false;
 const active=()=>typeof document!=='undefined'&&form.isConnected;
 const error=message=>{const box=$('#quick-error');box.textContent=message;box.hidden=!message;};
 const hideOptions=()=>{options.hidden=true;input.setAttribute('aria-expanded','false');};
 const showOptions=html=>{options.innerHTML=html;options.hidden=false;input.setAttribute('aria-expanded','true');};
 const syncScopes=()=>$$('[data-quick-kind]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.quickKind===draft.kind));
 const drawGap=()=>{
  gap.innerHTML=draft.kind==='event'&&draft.selected?quickGapMarkup(draft.sample,draft.qty,Math.round(Number($('#quick-price').value)*100),{event:draft.selected,state:draft.pullState}):`<strong>${draft.kind==='team'?'A price for every game':draft.kind==='date'?'An alert for your day out':'The gap right now'}</strong><p>${draft.kind==='team'?'Each game is checked against your price and seat count.':draft.kind==='date'?'We’ll watch events on your chosen date and in your chosen city.':draft.team?'Choose a game from the search dropdown to compare your price.':'Choose a team or event to get started.'}</p>`;
  if(draft.kind==='event'&&draft.selected){
   gap.insertAdjacentHTML('beforeend',`<div class="quick-price-actions"><span role="status">${esc(draft.pullMessage)}</span><button type="button" class="text-button" id="quick-refresh-price" ${draft.pullState==='checking'?'disabled':''}>${icon('refresh')} Refresh price</button></div>`);
   if($('#quick-refresh-price'))$('#quick-refresh-price').onclick=()=>pullCurrentPrice();
  }
  const price=Number($('#quick-price').value);$('#quick-submit').innerHTML=(price>0?'Start watching at '+money(Math.round(price*100)):'Start watching')+' '+icon('arrow');
 };
 const loadPrice=async(reset=true)=>{
  const event=draft.selected,id=++priceRequest;if(reset){const cached=quoteCache.get(event?.event_id+':'+draft.qty);draft.sample=cached&&Date.now()-cached.loadedAt<60000?cached.market:null;}drawGap();if(draft.kind!=='event'||!event)return;
  let quote;
  try{quote=(await sbPublicRpc('tix_public_quotes',{p_event_ids:[event.event_id],p_qty:draft.qty}))?.[0];}catch{}
  if(!active()||id!==priceRequest||event!==draft.selected||draft.kind!=='event')return;
  if(quote){cacheQuote(quote);draft.sample=quote.market||null;if(quote.min_total>0)Object.assign(event,{min_total:quote.min_total,price_checked_at:quote.checked_at});}
  else {
   // Compatibility while a release's database change is being installed.
   const results=await Promise.allSettled([sbGet('tix_event_market?event_id=eq.'+encodeURIComponent(event.event_id)+'&select=by_qty,checked_at,coverage&limit=1'),sbGet('tix_events_v?event_id=eq.'+encodeURIComponent(event.event_id)+'&select=min_total,price_checked_at&limit=1')]);
   if(!active()||id!==priceRequest||event!==draft.selected)return;
   if(results[0].status==='fulfilled')draft.sample=results[0].value[0]||null;
   if(results[1].status==='fulfilled'){const current=results[1].value[0];if(current?.min_total>0&&(!event.price_checked_at||new Date(current.price_checked_at)>=new Date(event.price_checked_at)))Object.assign(event,current);}
  }
  if(quickExactPrice(draft.sample,draft.qty)){draft.pullState='complete';draft.pullMessage='Current seat price loaded.';clearTimeout(pricePollTimer);}
  drawGap();
 };
 const pollPrice=(event,pullId,attempt=0)=>{
  clearTimeout(pricePollTimer);if(attempt>=40)return;
  pricePollTimer=setTimeout(async()=>{
   if(!active()||event!==draft.selected||draft.kind!=='event'||pullId!==draft.pullId)return;
   await loadPrice(false);
   if(!quickExactPrice(draft.sample,draft.qty))pollPrice(event,pullId,attempt+1);
  },1500);
 };
 const pullCurrentPrice=async()=>{
  const event=draft.selected;if(!event||draft.kind!=='event')return;
  const pullId=++draft.pullId;clearTimeout(pricePollTimer);
  draft.pullState='checking';draft.pullMessage='Pulling current prices…';drawGap();
  let entry=pricePulls.get(event.event_id+':'+draft.qty);
  if(!entry||Date.now()-entry.startedAt>=60000){entry={startedAt:Date.now(),promise:quickPullEvent(event.event_id,draft.qty)};pricePulls.set(event.event_id+':'+draft.qty,entry);}
  try{
   const result=await entry.promise;if(!active()||event!==draft.selected||draft.kind!=='event'||pullId!==draft.pullId)return;
   if(Number.isInteger(result.min_total)&&result.min_total>0&&result.checked_at&&(!event.price_checked_at||new Date(result.checked_at)>=new Date(event.price_checked_at))){event.min_total=result.min_total;event.price_checked_at=result.checked_at;}
   if(result.market){draft.sample=result.market;drawGap();}
   draft.pullState=['advertised','metadata_only','partial','cached','queued','scheduled','saved_only'].includes(result.state)?'queued':result.state;
   draft.pullMessage=result.state==='sign_in_required'?'Sign in to pull a new price.':result.state==='suspended'?'Live checks are paused. Try again later.':result.reason==='request_limit'?'The quick pull is at its limit. Waiting for the next available check.':draft.pullState==='queued'?'Waiting for fresh seat details. This card updates automatically.':'Price check finished.';
   await loadPrice(false);
   if(['queued','checking','complete','partial'].includes(draft.pullState)&&!quickExactPrice(draft.sample,draft.qty))pollPrice(event,pullId);
  }catch{if(active()&&event===draft.selected&&pullId===draft.pullId){draft.pullState='failed';draft.pullMessage='Could not refresh the price. Please try again.';pricePulls.delete(event.event_id+':'+draft.qty);drawGap();}}
 };
 const selectGame=game=>{draft.kind='event';draft.selected=game;request++;priceRequest++;syncScopes();input.value=cap(game.name);status.textContent=quickGameDate(game)+' · '+quickGameLocation(game);hideOptions();error('');draft.pullState='';draft.pullMessage='';loadPrice();pullCurrentPrice();};
 const followTeam=()=>{draft.kind='team';draft.selected=draft.team;input.value=draft.team.label;syncScopes();hideOptions();status.textContent='Every home game for '+draft.team.label;error('');drawGap();};
 const dropdownHead=()=>`<div class="quick-dropdown-head"><strong>${esc(draft.team.label)} games</strong><button type="button" class="text-button" id="quick-back-results">Back to search</button></div>`;
 const bindBack=()=>{$('#quick-back-results').onclick=()=>{scheduleRequest++;draft.team=null;draft.selected=null;draft.sample=null;input.value=draft.searchTerm;renderMatches();drawGap();};};
 const drawGames=(filter='')=>{
  const games=filterQuickGames(draft.games,filter);
  showOptions(dropdownHead()+`<div class="quick-dropdown-count">${games.length} ${games.length===1?'game':'games'}${draft.games.length===500?' (first 500 listed)':''}</div>`+(games.length?games.map(game=>`<button type="button" class="quick-game-option" data-quick-game="${esc(game.event_id)}"><strong>${esc(cap(game.name))}</strong><small>${esc(quickGameDate(game))} · ${esc(quickGameLocation(game))}</small></button>`).join(''):`<p class="quick-dropdown-message">${draft.games.length?'No games match. Edit your search to try another opponent, date or place.':'No upcoming games are listed for this team yet.'}</p>`)+`<button type="button" id="quick-follow-team" class="quick-follow-team">Follow all ${esc(draft.team.label)} home games</button>`);
  bindBack();$('#quick-follow-team').onclick=followTeam;
  $$('[data-quick-game]',options).forEach(button=>button.onclick=()=>{const game=draft.games.find(g=>g.event_id===button.dataset.quickGame);if(game)selectGame(game);});
 };
 const loadSchedule=async()=>{
  const team=draft.team,id=++scheduleRequest;scheduleLoaded=false;showOptions(dropdownHead()+'<p class="quick-dropdown-message">Loading games…</p>');bindBack();
  try{
   const rows=await sbPublicRpc('tix_search_team_events',{p_team_id:team.team_id,p_limit:500});if(!active()||id!==scheduleRequest||team!==draft.team||draft.kind!=='event')return;
   draft.games=(Array.isArray(rows)?rows:[]).filter(g=>g.event_date>=todayISO()).sort((a,b)=>String(a.event_date).localeCompare(String(b.event_date))||String(a.event_id).localeCompare(String(b.event_id)));scheduleLoaded=true;drawGames();prefetchQuotes(draft.games);status.textContent='Choose a '+team.label+' game from the dropdown.';
  }catch{if(!active()||id!==scheduleRequest||team!==draft.team||draft.kind!=='event')return;showOptions(dropdownHead()+'<p class="quick-dropdown-message">Games could not load.</p><button type="button" id="quick-retry-games">Try again</button>');bindBack();$('#quick-retry-games').onclick=loadSchedule;}
 };
 const chooseTeam=(team,term)=>{
  request++;scheduleRequest++;priceRequest++;clearTimeout(searchTimer);draft.team=team;draft.teamTerm=term||team.label;draft.selected=null;draft.sample=null;draft.games=[];input.value=team.label;error('');
  if(draft.kind==='team')followTeam();else{status.textContent='Loading '+team.label+' games…';drawGap();loadSchedule();}
 };
 const renderMatches=()=>{
  showOptions(draft.rows.map((row,i)=>`<button type="button" data-quick-result="${i}" data-quick-result-type="${row._quickType}"><strong>${esc(row._quickType==='team'?row.label:cap(row.name))}</strong><small>${esc(row._quickType==='team'?'Team · '+leagueName(row.category)+' · View games':quickGameDate(row)+' · '+quickGameLocation(row))}</small></button>`).join(''));
  if(!draft.rows.length)hideOptions();
  $$('[data-quick-result]',options).forEach(button=>button.onclick=()=>{const row=draft.rows[Number(button.dataset.quickResult)];if(row._quickType==='team')chooseTeam(row,row.label);else{draft.team=null;selectGame(row);}});
  status.textContent=draft.rows.length?'Choose a team to see its games, or choose an event.':'No matches. Try a team, school, artist or city.';
 };
 const search=async()=>{
  const term=input.value.trim(),id=++request,kind=draft.kind;hideOptions();if(term.length<2){status.textContent='Type at least two letters to search.';return;}status.textContent='Finding teams and events…';
  try{
   const rows=await quickSearchMatches(kind,term);if(!active()||id!==request||kind!==draft.kind||term!==input.value.trim())return;
   draft.rows=Array.isArray(rows)?rows:[];draft.searchTerm=term;const activity=newSearchActivity('submit',term);if(activity)recordSearchActivity({...activity,p_filters:{category:'',quantity:String(draft.qty)},p_result_count:draft.rows.length,p_has_more:draft.rows.length>=6,p_outcome:draft.rows.length?'results':'no_results'}).catch(()=>{});
   const team=kind==='event'?automaticQuickTeam(draft.rows,term):null;if(team)chooseTeam(team,term);else renderMatches();
  }catch{if(active()&&id===request)status.textContent='Search could not load. Try again, or browse the events below.';}
 };
 input.oninput=()=>{
  draft.selected=null;draft.sample=null;request++;priceRequest++;clearTimeout(searchTimer);error('');
  const value=input.value.trim().toLowerCase(),prefixes=draft.team?[draft.team.label,draft.teamTerm,...(draft.team.aliases||[])].filter(Boolean).sort((a,b)=>b.length-a.length):[];
  const prefix=prefixes.find(p=>value===p.toLowerCase()||value.startsWith(p.toLowerCase()+' '));
  if(prefix&&scheduleLoaded&&draft.kind==='event'){drawGames(value.slice(prefix.length).trim());drawGap();return;}
  draft.team=null;draft.games=[];scheduleLoaded=false;scheduleRequest++;hideOptions();drawGap();searchTimer=setTimeout(search,300);
 };
 input.onfocus=()=>{if(draft.kind==='event'&&draft.team&&scheduleLoaded)drawGames();};
 input.onkeydown=e=>{
  if(e.key==='ArrowDown'){if(options.hidden&&draft.team&&scheduleLoaded)drawGames();if(!options.hidden){e.preventDefault();(options.querySelector('[data-quick-game],[data-quick-result]')||options.querySelector('button'))?.focus();}}
  if(e.key==='Escape')hideOptions();
  if(e.key==='Enter'&&!draft.selected){e.preventDefault();clearTimeout(searchTimer);if(draft.team&&scheduleLoaded)drawGames();else search();}
 };
 options.onkeydown=e=>{const buttons=$$('button',options),index=buttons.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Escape'){input.focus();hideOptions();}};
 document.addEventListener('pointerdown',e=>{if(active()&&!input.closest('.quick-search-box').contains(e.target))hideOptions();});
 $$('[data-quick-kind]').forEach(button=>button.onclick=()=>{
  const old=draft.selected;draft.kind=button.dataset.quickKind;draft.selected=null;draft.sample=null;request++;priceRequest++;scheduleRequest++;clearTimeout(searchTimer);hideOptions();error('');syncScopes();
  input.closest('.quick-search-box').hidden=draft.kind==='date';$('#quick-search-label').hidden=draft.kind==='date';status.hidden=draft.kind==='date';$('#quick-day-fields').hidden=draft.kind!=='date';$('#quick-date').required=draft.kind==='date';
  if(draft.kind==='date'&&old?.event_date){$('#quick-date').value=old.event_date;$('#quick-city').value=old.city||'';}
  input.placeholder=draft.kind==='team'?'Team or school, e.g. Badger football':'Team, artist, show or city';
  if(draft.kind!=='date'&&draft.team){input.value=draft.team.label;if(draft.kind==='team')followTeam();else if(scheduleLoaded)drawGames();else loadSchedule();}
  else if(draft.kind!=='date'&&input.value.trim().length>=2)search();drawGap();
 });
 const quantityChanged=()=>{
  if(draft.kind==='event'&&draft.selected){
   const exact=quickExactPrice(draft.sample,draft.qty);draft.pullState=exact?'complete':'queued';draft.pullMessage=exact?'Current seat price loaded.':'Checking your selected seat count.';
   loadPrice(false);if(!exact)pullCurrentPrice();
  }else drawGap();
 };
 $$('[data-quick-qty]').forEach(button=>button.onclick=()=>{draft.qty=Number(button.dataset.quickQty);$('#quick-more-qty').hidden=draft.qty<5;$('#quick-more-qty').value=String(draft.qty);$$('[data-quick-qty]').forEach(b=>b.setAttribute('aria-pressed',b===button));quantityChanged();});
 $('#quick-more-qty').onchange=e=>{draft.qty=Number(e.target.value);quantityChanged();};$('#quick-price').oninput=drawGap;
 form.onsubmit=e=>{
  e.preventDefault();error('');if(draft.kind!=='date'&&!draft.selected){error(draft.team?'Choose a game from the search dropdown, or select A whole team.':'Choose an event or team from the search results first.');input.focus();return;}
  if(!$('#quick-email').checked&&!$('#quick-text').checked){error('Choose email, text, or both.');return;}if(!form.reportValidity())return;
  goToWatchSetup(quickWatchUrl({...draft,price:$('#quick-price').value,email:$('#quick-email').checked,sms:$('#quick-text').checked,date:$('#quick-date').value,city:$('#quick-city').value.trim()}));
 };
 setInterval(()=>{if(active()&&!document.hidden){if(draft.kind==='event'&&draft.selected)loadPrice(false);else drawGap();}},30000);
}
// Mirror the explore filters in the address bar so views can be shared, bookmarked and survive refresh/Back.
function syncExploreUrl(){
 if(page!=='explore')return;
 const p=new URLSearchParams();
 if(state.search)p.set('q',state.search);
 p.set('category',state.category||'all');
 if(state.place)p.set('place',state.place);
 if(state.date)p.set('date',state.date);
 if(state.within)p.set('within',state.within);
 if(state.maxPrice)p.set('max',state.maxPrice);
 if(state.cheapOnly)p.set('cheap','1');
 if(state.searchQty)p.set('qty',state.searchQty);
 if(state.exploreTeamId)p.set('team',state.exploreTeamId);
 const next=location.pathname+'?'+p.toString();
 if(next!==location.pathname+location.search)history.replaceState(null,'',next);
}
function explore(){
 main.innerHTML=`<div class="container"><section class="hero"><div class="hero-copy"><div class="season-label">Ticket price alerts · We watch, you buy</div><h1>Tell us your price. We’ll tell you when it’s&#160;there.</h1><p>Watch one game, every home game for your team, or anything on a day you’re free. Set the most you’ll pay per ticket, fees included. When enough seats together drop to it, we email you a link to the listing.</p><div class="hero-actions"><a class="button primary" href="#start-title">Set my price ${icon('arrow')}</a><a class="button secondary" href="./index.html?cheap=1">See what’s cheap</a></div><div class="hero-note"><span>${icon('check')} Fees counted in your price</span><span>${icon('check')} Seats together, or no alert</span></div></div>${heroCard()}</section><section class="explore-section" aria-labelledby="explore-title"><div class="section-heading"><div><h2 id="explore-title">${state.cheapOnly?'What’s cheap coming up.':'Or start from an event'}</h2><p>${state.cheapOnly?'Browse recently checked get-in prices. Enter a city or state to make it yours.':'Browse events and checked ticket prices before you name yours.'}</p></div><a class="text-link" href="./new.html?kind=team">Follow a whole team ${icon('arrow')}</a></div><div class="explore-layout"><div class="explore-main">${searchControls()}<div class="results-meta"><span id="results-count" role="status">Finding upcoming events…</span><span id="search-price-basis">${state.searchQty?`Per ticket · exactly ${state.searchQty} together when verified`:'Get-in per ticket · quantity and tax unconfirmed'}</span></div><p id="price-request-status" class="price-request-status" role="status" hidden></p><div id="team-search-context" aria-live="polite"></div><section id="team-schedule-panel" class="history-panel" hidden></section><div id="events">${loadingRows()}</div><button id="more-events" class="button secondary load-more" hidden>Show more events</button></div></div></section><section class="home-how" aria-labelledby="how-title"><div class="section-heading"><h2 id="how-title">Your price. Our lookout.</h2></div><ol class="home-how-steps"><li><span>01</span><h3>Choose what to watch</h3><p>One event, a whole team, or anything on a day you’re free.</p></li><li><span>02</span><h3>Name your price</h3><p>Set your price per ticket and the number of seats you need together.</p></li><li><span>03</span><h3>Get the heads-up</h3><p>An email with a link to the listing on Gametime. Add a carrier text if you like. You decide whether to buy.</p></li></ol><div class="start-card-checks"><span>Active alerts are scheduled for checks every 15 minutes.</span><span>Prices stay pending when a fresh check is unavailable.</span></div><div class="start-card-actions"><a class="button primary" href="./new.html">Watch one event ${icon('arrow')}</a><a class="button secondary" href="./new.html?kind=team">Follow a whole team</a></div></section></div>`;
 bindQuickWatch();bindSearch(loadEvents);$('#refresh-results').onclick=()=>refreshSearchResults();$('#more-events').onclick=()=>{state.offset+=12;loadEvents(true);};loadEvents();
}
function searchControls(builder=false){const markup=`<form class="search-bar" id="search-form" role="search"><label class="search-input">${icon('search')}<span class="sr-only">Search all teams, artists, events, or regions</span><input id="event-search" type="search" maxlength="100" autocomplete="off" placeholder="Team, artist, show or city" value="${esc(state.search)}"></label><button class="button primary search-submit" type="submit">Search</button></form><details class="browse-filters"><summary>More filters</summary><div class="filter-row"><label><span class="sr-only">League or category</span><select id="category"><option value="" ${!state.category?'selected':''}>All events</option>${!builder?`<option value="all-sports" ${state.category==='all-sports'?'selected':''}>All sports</option>`:''}${['nfl-football','mlb-baseball','nba-basketball','nhl-hockey','college-football','college-basketball','mls-soccer','concert','comedy','theater','sports'].map(c=>`<option value="${c}" ${state.category===c?'selected':''}>${leagueName(c)}</option>`).join('')}</select></label><label><span class="sr-only">City or state</span><input id="place" type="search" placeholder="City or state" value="${esc(state.place)}"></label><label><span class="sr-only">Ticket quantity</span><select id="search-qty"><option value="0">Any quantity · get-in</option>${Array.from({length:8},(_,i)=>`<option value="${i+1}" ${state.searchQty===i+1?'selected':''}>Exactly ${i+1} together</option>`).join('')}</select></label><label><span class="sr-only">${state.searchQty?'Per-ticket price under':'Get-in price under'}</span><input id="max-price" type="number" min="1" step="1" inputmode="numeric" placeholder="${state.searchQty?'Per ticket under $':'Get-in under $'}" value="${esc(state.maxPrice)}"></label><label><span class="sr-only">Upcoming range</span><select id="within"><option value="all" ${state.within==="all"?"selected":""}>Next year</option><option value="7" ${state.within==="7"||state.cheapOnly&&!state.within?"selected":""}>Next 7 days</option><option value="30" ${state.within==="30"?"selected":""}>Next 30 days</option></select></label><label><span class="sr-only">Event date</span><input id="event-date" type="date" aria-label="Event date" min="${todayISO()}" max="${todayISO(new Date(Date.now()+365*86400000))}" value="${esc(state.date)}"></label><button class="text-button" id="clear-filters" type="button">Reset</button></div></details>${!builder?`<div class="league-tabs" aria-label="Quick category filters">${['','nfl-football','nhl-hockey','nba-basketball','mlb-baseball','college-football','college-basketball','concert','theater','comedy','all-sports'].map(c=>`<button data-category="${c}" aria-pressed="${state.category===c}">${c==='all-sports'?'All sports':c?leagueName(c):'All'}</button>`).join('')}</div>`:''}`;if(builder)return markup;
 const filters=markup.indexOf('<details'),tabs=markup.indexOf('<div class="league-tabs"');
 const advanced=markup.slice(filters,tabs).replace('</details>',`<p class="field-help">Searches help improve event coverage. <a href="./privacy.html">Search privacy</a></p><div class="search-actions"><button class="text-button" id="refresh-results">${icon('refresh')} Refresh these results</button><a href="./coverage.html">Data coverage ${icon('arrow')}</a></div></details>`);
 return '<div class="browse-toolbar">'+markup.slice(0,filters)+markup.slice(tabs)+'</div>'+advanced;
}
function bindSearch(load){
 $('#event-search').oninput=e=>{state.search=e.target.value.trim();state.exploreTeamId='';state.exploreTeam=null;state.teamEventIds=null;if(!state.search){state.offset=0;load();}};
 $('#search-form').onsubmit=e=>{e.preventDefault();state.search=$('#event-search').value.trim().slice(0,100);state.pendingSearchActivity=page==='explore'?newSearchActivity('submit',state.search):null;state.exploreTeamId='';state.exploreTeam=null;state.teamEventIds=null;state.offset=0;load();};
 $('#category').onchange=e=>{state.category=e.target.value;state.exploreTeamId='';state.exploreTeam=null;state.teamEventIds=null;state.offset=0;$$('[data-category]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.category===state.category));load();};
 $('#place').oninput=e=>{state.place=e.target.value.trim();clearTimeout(state.placeTimer);state.placeTimer=setTimeout(()=>{state.offset=0;load();},400);};
 $('#event-date').onchange=e=>{state.date=e.target.value;state.offset=0;load();};
 $('#max-price').onchange=e=>{state.maxPrice=e.target.value;state.offset=0;load();};
 if($('#search-qty'))$('#search-qty').onchange=e=>{state.searchQty=Number(e.target.value);state.quantityPrices={};$('#max-price').placeholder=state.searchQty?'Per ticket under $':'Get-in under $';$('#max-price').previousElementSibling.textContent=state.searchQty?'Per-ticket price under':'Get-in price under';state.offset=0;load();};
 $('#within').onchange=e=>{state.within=e.target.value;state.offset=0;load();};
 $('#clear-filters').onclick=()=>{clearTimeout(state.placeTimer);state.search='';state.place='';state.date='';state.maxPrice='';state.within='';state.cheapOnly=false;state.category='';state.searchQty=0;state.exploreTeamId='';state.exploreTeam=null;state.teamEventIds=null;state.offset=0;$('#event-search').value='';$('#place').value='';$('#event-date').value='';$('#max-price').value='';$('#within').value='';$('#category').value='';if($('#search-qty'))$('#search-qty').value='0';$$('[data-category]').forEach(b=>b.setAttribute('aria-pressed','false'));load();};
 $$('[data-category]').forEach(b=>b.onclick=()=>{state.category=b.dataset.category;state.exploreTeamId='';state.exploreTeam=null;state.teamEventIds=null;$('#category').value=state.category;$$('[data-category]').forEach(x=>x.setAttribute('aria-pressed',x===b));state.offset=0;load();});
}
function catalogQuery(limit=13,includeUnpriced=state.catalogFallback){
 const priceOnly=!state.searchQty&&(state.cheapOnly||Number(state.maxPrice)>0)&&!includeUnpriced;
 const now=new Date(state.catalogSnapshotAt||Date.now());
 let q=`tix_events_v?select=*&event_date=${state.date?'eq.'+state.date:'gte.'+todayISO(now)}&order=${state.cheapOnly&&!includeUnpriced?'min_total,event_date,event_id':'event_date,event_id'}&limit=${limit}&offset=${state.offset}`;
 if(!state.date&&(state.within||state.cheapOnly)&&state.within!=='all'){const days=Number(state.within||7);const end=todayISO(new Date(now.getTime()+days*86400000));q+='&event_date=lte.'+end;}
 q+='&event_date=lte.'+todayISO(new Date(now.getTime()+365*86400000));
 if(state.category==='all-sports')q+='&category=in.(nfl-football,college-football,mlb-baseball,nba-basketball,college-basketball,nhl-hockey,mls-soccer,wnba,pwhl,sports)';
 else if(state.category)q+='&category=eq.'+encodeURIComponent(state.category);
 if(priceOnly&&Number(state.maxPrice)>0)q+='&min_total=lte.'+Math.round(Number(state.maxPrice)*100);
 if(priceOnly){q+='&min_total=not.is.null&price_checked_at=gte.'+encodeURIComponent(new Date(now.getTime()-72*3600000).toISOString());}
 // Strip PostgREST filter syntax, then quote each server-side search pattern.
 const clean=s=>s.replace(/[%*(),"\\]/g,' ').trim();
 // A full state name in the search box also finds events held in that state.
 if(state.exploreTeamId&&Array.isArray(state.teamEventIds))q+='&event_id=in.('+(state.teamEventIds.length?state.teamEventIds:['__no_team_events__']).map(encodeURIComponent).join(',')+')';
 else if(state.search){const term=clean(state.search),st=stateCode(term,false);if(term)q+='&or='+encodeURIComponent(`(name.ilike."*${term}*",slug.ilike."*${term.replace(/\s+/g,'-')}*"${st?',state.eq.'+st:''})`);}
 if(state.place)q+=placeFilter(state.place);
 return q;
}
const US_STATES={alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE','district of columbia':'DC','washington dc':'DC',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY'};
// "Wisconsin" or "WI" -> "WI". Two-letter codes only when allowCode, so a
// search like "LA" or "IN" stays a name search.
function stateCode(s,allowCode=true){const t=String(s||'').replace(/\./g,'').replace(/\s+/g,' ').trim().toLowerCase();if(US_STATES[t])return US_STATES[t];const u=t.toUpperCase();return allowCode&&Object.values(US_STATES).includes(u)?u:'';}
// The city/state box: "WI", "Wisconsin", "Madison", "Madison, WI" or "Green Bay Wisconsin".
function placeFilter(raw){
 const words=raw.replace(/[%*(),"\\]/g,' ').replace(/\s+/g,' ').trim();
 if(!words)return '';
 if(words.length===2)return '&state=eq.'+encodeURIComponent(words.toUpperCase());
 const whole=stateCode(words);if(whole)return '&state=eq.'+whole;
 const parts=words.split(' ');
 for(let k=Math.min(3,parts.length-1);k>=1;k--){const st=stateCode(parts.slice(-k).join(' '));if(st)return '&state=eq.'+st+'&city=ilike.'+encodeURIComponent('*'+parts.slice(0,-k).join(' ')+'*');}
 return '&city=ilike.'+encodeURIComponent('*'+words+'*');
}
// Every visible upcoming result without a price from the last 15 minutes.
function priceCheckCandidates(rows){const horizon=todayISO(new Date(Date.now()+365*86400000));return [...new Set(rows.filter(e=>e.event_date>=todayISO()&&e.event_date<=horizon&&(!e.min_total||!e.price_checked_at||ageMinutes(e.price_checked_at)>15)).map(e=>e.event_id))].slice(0,12);}
function eventPriceCell(e,note=''){
 const label={checking:'Checking live price…',queued:'Live check queued',failed:'Live check failed'}[note]||'';
 const exact=state.searchQty?exactSearchPrice(state.quantityPrices?.[e.event_id],state.searchQty):null;
 if(state.searchQty){const freshness=exact?ageMinutes(exact.checked_at)<=15?'Checked ':'Saved lot · ':'';return `${exact?`<strong>${money(exact.price_cents)}</strong><small>${freshness}${ago(exact.checked_at).toLowerCase()}</small><small>Exactly ${state.searchQty} together</small><small>${exact.basis==='fees_included_tax_reported'?'Tax reported':'Tax unconfirmed'}</small>`:`<span>${state.searchQty}-ticket price unverified</span>`}${e.min_total?`<small>Get-in ${money(e.min_total)} · any quantity</small>`:''}${label?`<small class="price-note">${label}</small>`:''}`;}
 if(e.min_total)return `<strong>${money(e.min_total)}</strong><small>${ageMinutes(e.price_checked_at)>15?'Saved · ':''}${e.discovery_status==='metadata_only'?'Get-in only':'Checked'} ${ago(e.price_checked_at).toLowerCase()}</small><small>Quantity and tax unconfirmed</small>${priceFreshness(e).state==='failed'?'<small class="price-note">Last check failed; saved price retained</small>':''}${label?`<small class="price-note">${label}</small>`:''}`;
 if(label)return `<span>${label}</span>`;
 return e.price_checked_at?'<span>Price unavailable at last check</span>':'<span>Price not checked</span>';
}
// Fold one live result into the shown row; a failed check keeps the saved price.
function applyPriceResult(result,final=true){
 const e=state.events.find(x=>x.event_id===result.event_id),el=document.getElementById('price-'+result.event_id);
 if(!e)return;
 if(Number.isInteger(result.min_total)&&result.min_total>0&&['advertised','metadata_only','complete','partial','cached'].includes(result.state)){
  e.min_total=result.min_total;e.price_checked_at=result.checked_at||new Date().toISOString();
  // Only a listing set confirms more than the provider's get-in price.
  e.discovery_status=['complete','partial'].includes(result.state)?'ok':'metadata_only';
 } else if(result.state==='empty'){e.min_total=null;e.price_checked_at=result.checked_at||new Date().toISOString();}
 const group=result.market?.by_qty?.[String(state.searchQty)];
 if(state.searchQty&&group?.low>0){state.quantityPrices[result.event_id]={requested_qty:state.searchQty,price_cents:group.low,basis:group.basis,checked_at:group.checked_at||result.market.checked_at,state:'verified'};}
 const note=result.state==='failed'?'failed':result.state==='queued'||result.state==='scheduled'?(final?'queued':'checking'):'';
 if(el)el.innerHTML=eventPriceCell(e,note);
 const game=state.teamGames?.find(x=>x.event_id===result.event_id);if(game&&e)Object.assign(game,e);
}
// Results the visitor clicks straight past are not checked: live checks start
// after a short pause, and a newer search cancels them.
const PRICE_CHECK_GRACE_MS=400;
async function queuePriceChecks(rows,ctrl,force=false){
 const status=$('#price-request-status');if(IS_DEV||!status)return;
 const ids=force?rows.map(e=>e.event_id).slice(0,12):priceCheckCandidates(rows);
 if(!ids.length){if(!rows.length){status.hidden=true;status.textContent='';return;}status.hidden=false;status.textContent=state.searchQty?'Get-in prices were checked within the last 15 minutes. Group prices remain unverified where seller lot sizes are missing.':'These saved prices were checked within the last 15 minutes.';return;}
 status.hidden=false;
 if(!force)await new Promise(resolve=>setTimeout(resolve,PRICE_CHECK_GRACE_MS));
 if(ctrl!==state.controller||ctrl.signal.aborted)return;
 for(const id of ids){const e=state.events.find(x=>x.event_id===id),el=document.getElementById('price-'+id);if(e&&el)el.innerHTML=eventPriceCell(e,'checking');}
 status.textContent=`Checking live prices for ${ids.length} ${ids.length===1?'event':'events'}…`;
 const latest=new Map();
 // Any row without an answer (replaced search, fallback limit) shows its saved price again.
 const settle=()=>{for(const id of ids){const r=latest.get(id);if(!r)applyPriceResult({event_id:id,state:'unchanged'});else if(r.state==='queued')applyPriceResult(r,true);}};
 try{
  let pending=ids;
  for(let round=0;round<2&&pending.length;round++){
   if(round){
    // Wait for the request window (at most about a minute), then retry once.
    const waitMs=Math.min(65000,Math.max(...pending.map(id=>new Date(latest.get(id)?.next_attempt_at||Date.now()).getTime()-Date.now()),1000));
    status.textContent=searchPriceSummary([...latest.values()])+` Retrying ${pending.length} shortly…`;
    await new Promise((resolve,reject)=>{const t=setTimeout(resolve,waitMs);ctrl.signal.addEventListener('abort',()=>{clearTimeout(t);reject(new DOMException('Aborted','AbortError'));},{once:true});});
    if(ctrl.signal.aborted)throw new DOMException('Aborted','AbortError');
   }
   const results=await captureEventPrices(pending,{signal:ctrl.signal,qty:state.searchQty||2,details:state.searchQty>0});
   pending=results.filter(r=>r.state==='queued'&&r.next_attempt_at&&new Date(r.next_attempt_at).getTime()-Date.now()<70000).map(r=>r.event_id);
   const last=round===1||!pending.length;
   for(const r of results){latest.set(r.event_id,r);applyPriceResult(r,last||!pending.includes(r.event_id));}
   if(ctrl!==state.controller){settle();return;}
  }
  settle();
  status.textContent=searchPriceSummary([...latest.values()])+(state.searchQty?` Group prices require seller-confirmed lots; a get-in update alone does not verify ${state.searchQty} together.`:'');
 }catch(e){
  if(e.name==='AbortError'||ctrl!==state.controller){settle();return;}
  for(const id of ids)if(!latest.has(id))applyPriceResult({event_id:id,state:'failed'});
  status.textContent=e.message;
 }
}
// Broad matching stays on the server: never clip a region to a client-side list of event IDs.
async function fetchSearchRows(limit,includeUnpriced,ctrl){
 const general=page==='explore'&&!state.exploreTeamId&&(state.search||state.category==='all-sports');
 if(state.generalSearchFallback||!general||typeof fetch!=='function'||(IS_DEV&&typeof devRpc!=='function'))return sbGet(catalogQuery(limit,includeUnpriced),{signal:ctrl.signal});
 const now=new Date(state.catalogSnapshotAt||Date.now()),priceOnly=!state.searchQty&&(state.cheapOnly||Number(state.maxPrice)>0)&&!includeUnpriced;
 const place=new URLSearchParams(placeFilter(state.place).replace(/^&/,''));
 const days=state.within!=='all'&&(state.within||state.cheapOnly)?Number(state.within||7):365;
 try{return await sbPublicRpc('tix_general_search',{p_query:state.search,p_category:state.category||null,p_region:stateCode(state.search,false)||null,p_place_state:place.get('state')?.replace(/^eq\./,'')||null,p_place_city:place.get('city')?.replace(/^ilike\.\*|\*$/g,'')||null,p_date:state.date||null,p_through:todayISO(new Date(now.getTime()+days*86400000)),p_max_cents:priceOnly&&Number(state.maxPrice)>0?Math.round(Number(state.maxPrice)*100):null,p_priced_since:priceOnly?new Date(now.getTime()-72*3600000).toISOString():null,p_cheap:state.cheapOnly&&!includeUnpriced,p_offset:state.offset,p_limit:limit},{signal:ctrl.signal})||[];}catch(e){if(e.name==='AbortError'||ctrl.signal.aborted||state.offset>0)throw e;state.generalSearchFallback=true;return sbGet(catalogQuery(limit,includeUnpriced),{signal:ctrl.signal});}
}
async function loadEvents(append=false){
 const activity=!append?state.pendingSearchActivity:null;state.pendingSearchActivity=null;
 if(activity)activity.p_filters={category:state.category,place:state.place,date:state.date,within:state.within,quantity:String(state.searchQty),max_price:state.maxPrice,team:state.exploreTeamId};
 let activityRecorded=false;
 const finishActivity=(count,hasMore,outcome)=>{if(activity&&!activityRecorded){activityRecorded=true;recordSearchActivity({...activity,p_result_count:count,p_has_more:hasMore,p_outcome:outcome}).catch(()=>{});}};
 state.controller?.abort();const ctrl=state.controller=new AbortController();const box=$('#events');if(!append){box.innerHTML=loadingRows();const status=$('#price-request-status');if(status){status.hidden=true;status.textContent='';}}
 const more=$('#more-events');if(more){more.disabled=true;more.textContent='Loading…';}
 try{
  if(!append){state.catalogFallback=false;state.generalSearchFallback=false;state.catalogSnapshotAt=Date.now();await loadSearchTeamContext(ctrl);if(ctrl!==state.controller)return;syncExploreUrl();}
  let rows=await fetchSearchRows(13,state.catalogFallback,ctrl);if(ctrl!==state.controller)return;
  if(!append&&!rows.length&&(state.cheapOnly||Number(state.maxPrice)>0)){
   rows=await fetchSearchRows(13,true,ctrl);if(ctrl!==state.controller)return;
   state.catalogFallback=rows.length>0;
  }
  const moreAvailable=rows.length>12;rows.length=Math.min(rows.length,12);await loadSearchQuantities(rows,ctrl);if(ctrl!==state.controller)return;state.events=append?[...state.events,...rows]:rows;
  if(!append)box.innerHTML='';
  // A short range (the cheap view starts at 7 days) is the usual reason for no results; say so.
  if(!state.events.length){const days=!state.date&&(state.within||state.cheapOnly)&&state.within!=='all'?Number(state.within||7):0;const heading=state.date?`No ${state.category?esc(leagueName(state.category))+' ':''}events listed for ${esc(whenShort(state.date))}.`:days?`Nothing in the next ${days} days matches.`:'No upcoming events match these filters.';box.innerHTML=`<div class="empty-state">${icon('search')}<h3>${heading}</h3><p>${state.date?'Try another date or see upcoming events.':days?`Only the next ${days} days are searched right now.`:'Try another category, city, or date.'}</p>${state.date?'<button class="button secondary" id="empty-upcoming">Show upcoming events</button>':''}${days?'<button class="button secondary" id="empty-year">Search the next year</button>':''}<button class="button secondary" id="empty-reset">Clear filters</button></div>`;}
  if(state.searchQty&&Number(state.maxPrice)>0&&!append)box.innerHTML=`<div class="notice subtle" role="status"><p>Only verified ${state.searchQty}-ticket prices at or below ${money(Math.round(Number(state.maxPrice)*100))} meet your budget. Unverified games remain visible so you can request a check.</p></div>`+box.innerHTML;
  if(state.generalSearchFallback&&!append)box.innerHTML='<p class="notice subtle" role="status">General matching is temporarily unavailable. Showing title and location matches only.</p>'+box.innerHTML;
  if(state.catalogFallback&&!append)box.innerHTML=`<div class="notice subtle" role="status"><strong>No recently checked prices match these filters.</strong><p>Showing real upcoming events. An event without a price has not been confirmed cheap${Number(state.maxPrice)>0?' or under your budget':''}.</p></div>`+box.innerHTML;
  rows.forEach(e=>{const el=document.createElement('article');el.className='event-row';el.dataset.eventId=e.event_id;el.innerHTML=`${dateBadge(e.event_date)}<div class="event-info"><span class="event-category">${esc(leagueName(e.category))}</span><h3><a href="./event.html?event=${encodeURIComponent(e.event_id)}">${esc(cap(e.name))}</a></h3><p>${esc(e.venue||cap(e.venue_slug))}<span class="event-place">${esc(e.city)}, ${esc(e.state)}</span></p></div><div class="event-price" id="price-${esc(e.event_id)}">${eventPriceCell(e)}</div><a class="button alert-button" href="./new.html?event=${encodeURIComponent(e.event_id)}${state.searchQty?'&qty='+state.searchQty:''}">${icon('ticket')}<span>Set my price</span><span class="sr-only"> for ${esc(cap(e.name))}</span></a>`;box.appendChild(el);});
  applyQuantityBudget();
  const visibleCount=$$('.event-row:not([hidden])',box).length;
  $('#results-count').textContent=state.events.length?`${visibleCount}${moreAvailable?'+':''} upcoming events${state.place?' in '+state.place:''}${state.catalogFallback?' · prices pending':''}`:state.date?'No events on this date':'No upcoming matches';
  if($('#search-price-basis'))$('#search-price-basis').textContent=state.searchQty?`Per ticket · exactly ${state.searchQty} together when verified`:'Get-in per ticket · quantity and tax unconfirmed';
  renderTeamSchedule();
  if(more){more.hidden=!moreAvailable;more.disabled=false;more.textContent='Show more events';}
  if($('#empty-reset'))$('#empty-reset').onclick=()=>$('#clear-filters').click();
  if($('#empty-upcoming'))$('#empty-upcoming').onclick=()=>{state.date='';state.offset=0;$('#event-date').value='';loadEvents();};
  if($('#empty-year'))$('#empty-year').onclick=()=>{state.within='all';state.offset=0;$('#within').value='all';loadEvents();};
  finishActivity(visibleCount,moreAvailable,visibleCount?'results':'no_results');
  prioritizeSearch(rows,ctrl).catch(()=>{});
  queuePriceChecks(rows,ctrl).then(()=>loadSearchQuantities(state.events,ctrl,true)).catch(()=>{});
 }catch(e){if(e.name==='AbortError')return;if(ctrl!==state.controller)return;finishActivity(0,false,'failed');box.innerHTML=errorBox(e.message);$('#retry').onclick=()=>loadEvents();$('#results-count').textContent='Events could not load';if(more)more.hidden=true;}
}
// Resolve source identities before matching events. Shared nicknames require a choice.
async function loadSearchTeamContext(ctrl){
 const box=$('#team-search-context');if(!box)return;
 state.teamGames=[];state.teamEventIds=null;state.teamChoices=[];
 if((IS_DEV&&typeof devRpc!=='function')||typeof fetch!=='function'||(!state.search&&!state.exploreTeamId)){box.innerHTML='';state.exploreTeam=null;return;}
 try{
  const teams=await sbPublicRpc(state.exploreTeamId?'tix_resolve_teams':'tix_match_search_teams',{p_query:state.exploreTeamId||state.search,p_category:state.category==='all-sports'?null:state.category||null,...(!state.exploreTeamId?{p_region:stateCode(state.search,false)||null}:{}),p_limit:100},{signal:ctrl.signal});
  if(ctrl!==state.controller)return;
  state.teamChoices=Array.isArray(teams)?teams:[];
  const chosen=state.teamChoices.find(t=>t.team_id===state.exploreTeamId)||(state.category&&state.category!=='all-sports'&&state.teamChoices.length===1?state.teamChoices[0]:null);
  state.exploreTeam=chosen;state.exploreTeamId=chosen?.team_id||'';
  if(chosen){
   const games=await sbPublicRpc('tix_search_team_events',{p_team_id:chosen.team_id,p_limit:200},{signal:ctrl.signal})||[];
   if(ctrl!==state.controller)return;
   state.teamGames=games;
   state.teamEventIds=state.teamGames.map(e=>e.event_id);
   box.innerHTML=`<div class="team-match"><div><strong>${esc(chosen.label)}</strong><p>Matched to Gametime’s team directory · ${Number(chosen.event_count)||state.teamGames.length} listed games</p></div><a class="text-link" href="./new.html?kind=team&team=${encodeURIComponent(chosen.team_id)}&category=${encodeURIComponent(chosen.category)}">Follow this team ${icon('arrow')}</a></div>`;
  }else if(state.teamChoices.length){
   box.innerHTML=`<div class="team-match"><div><strong>Matching teams</strong><p>Results include all matching teams, artists and places. Choose a team to see only its schedule.</p><div class="team-choice-list">${state.teamChoices.map(t=>`<button class="button secondary" data-team-choice="${esc(t.team_id)}">${esc(t.label)}<small>${esc(leagueName(t.category))}</small></button>`).join('')}</div></div></div>`;
   $$('[data-team-choice]').forEach(button=>button.onclick=()=>{state.exploreTeamId=button.dataset.teamChoice;state.offset=0;loadEvents();});
  }else box.innerHTML='';
 }catch(e){if(e.name==='AbortError'||ctrl!==state.controller)return;box.innerHTML='<p class="field-help">Team matching is temporarily unavailable. Showing matches for your search words; try the full school or team name.</p>';state.exploreTeam=null;state.exploreTeamId='';}
}
async function loadSearchQuantities(rows,ctrl,redraw=false){
 if(!state.searchQty||(IS_DEV&&typeof devRpc!=='function')||typeof fetch!=='function')return;
 const qty=state.searchQty;
 try{
  const prices=await sbPublicRpc('tix_search_quantity_prices',{p_event_ids:[...new Set([...rows,...state.teamGames].map(e=>e.event_id))].slice(0,200),p_qty:qty},{signal:ctrl.signal});
  if(ctrl!==state.controller||qty!==state.searchQty)return;
  for(const row of prices||[])state.quantityPrices[row.event_id]={...row,requested_qty:qty};
  for(const game of state.teamGames)game.quantity_price=state.quantityPrices[game.event_id];
  if(redraw){for(const e of rows){const el=document.getElementById('price-'+e.event_id);if(el)el.innerHTML=eventPriceCell(e);}applyQuantityBudget(true);renderTeamSchedule();}
 }catch(e){if(e.name==='AbortError'||ctrl!==state.controller)return;for(const row of rows)delete state.quantityPrices[row.event_id];}
}
async function prioritizeSearch(rows,ctrl,force=false){
 if(IS_DEV||typeof fetch!=='function'||!session||(!state.search&&!state.exploreTeamId))return;
 const key=[state.search,state.category,state.exploreTeamId].join('|');if(!force&&key===state.priorityKey)return;
 try{
  const token=await accessToken();if(ctrl!==state.controller)return;
  const result=await sbPublicRpc('tix_prioritize_search',{p_query:state.search,p_category:state.category==='all-sports'?null:state.category||null,p_team_id:state.exploreTeamId||null,p_event_ids:rows.slice(0,12).map(e=>e.event_id)},{signal:ctrl.signal,token});
  if(ctrl!==state.controller)return;
  state.priorityKey=key;
  const box=$('#team-search-context');
  if(result?.state==='queued'&&box){box.querySelector('.team-priority')?.remove();box.insertAdjacentHTML('beforeend',`<p class="team-priority" role="status">${result.teams?`${Number(result.teams)} ${Number(result.teams)===1?'team schedule':'team schedules'} prioritized. `:''}${Number(result.events)||0} listed games queued for checks across the next year. Schedules and prices update as checks finish.</p>`);}
 }catch(e){if(e.name==='AbortError'||ctrl!==state.controller)return;const box=$('#team-search-context');if(box)box.insertAdjacentHTML('beforeend','<p class="field-help">The team schedule could not be prioritized. Saved events and individual price checks remain available. Try Refresh these results.</p>');}
}
async function refreshSearchResults(){
 const button=$('#refresh-results'),ctrl=state.controller;if(!button||!ctrl)return;
 button.disabled=true;button.textContent='Refreshing…';
 try{await prioritizeSearch(state.events,ctrl,true);await queuePriceChecks(state.events,ctrl,true);await loadSearchQuantities(state.events,ctrl,true);renderTeamSchedule();}
 finally{if(button.isConnected){button.disabled=false;button.innerHTML=icon('refresh')+' Refresh these results';}}
}
function applyQuantityBudget(updateCount=false){
 const limit=Math.round(Number(state.maxPrice)*100);
 for(const article of $$('#events .event-row')){const price=exactSearchPrice(state.quantityPrices[article.dataset.eventId],state.searchQty);article.hidden=!!(state.searchQty&&limit>0&&price&&price.price_cents>limit);}
 if(updateCount&&$('#results-count')){const shown=$$('#events .event-row:not([hidden])').length;$('#results-count').textContent=$('#results-count').textContent.replace(/^\d+/,String(shown));}
}
function renderTeamSchedule(){
 const box=$('#team-schedule-panel');if(!box)return;
 box.hidden=!state.exploreTeam;
 if(!state.exploreTeam)return;
 const games=state.chartHome?state.teamGames.filter(e=>e.is_home===true):state.teamGames;
 box.innerHTML=`<div class="history-head"><div><h2>${esc(state.exploreTeam.label)} full schedule prices</h2><p>${state.chartHome?`${games.length} confirmed home games of ${state.teamGames.length} listed`:`${games.length} listed games`} · next year${state.teamGames.length===200?' (first 200 shown)':''}. Search date, place and budget filters apply to the list below.</p></div><label class="schedule-view">Show<select id="schedule-home"><option value="all" ${!state.chartHome?'selected':''}>All games</option><option value="home" ${state.chartHome?'selected':''}>Home games</option></select></label></div>${schedulePriceChart(games,{label:state.exploreTeam.label,qty:state.searchQty})}`;
 $('#schedule-home').onchange=e=>{state.chartHome=e.target.value==='home';renderTeamSchedule();};
}
async function coverage(){
 const selectedCategory=query.get('category')||'';
 layout('Know what’s been checked.','Schedule coverage, price freshness, and checks that need attention.',`<section class="settings-panel"><label class="field-label" for="coverage-category">Category</label><select id="coverage-category"><option value="">All events</option>${['nfl-football','college-football','nba-basketball','college-basketball','mlb-baseball','nhl-hockey','concert'].map(c=>`<option value="${c}" ${selectedCategory===c?'selected':''}>${leagueName(c)}</option>`).join('')}</select><div id="coverage-status">${loadingRows(2)}</div></section><div class="coverage-notes"><section><h2>Saved prices and exact quantities</h2><p>A Gametime get-in price is the lowest advertised entry price. It does not confirm tax or a seller lot for two, four, or any other exact group size. Select a ticket quantity in search to see only verified group prices as the main price.</p></section><section><h2>What happens after a search</h2><p>Signed-in searches prioritize the matched team’s schedule and request prices for visible games up to one year ahead. Provider delays and request limits can leave a saved price or a pending check. A failed source keeps its last known price.</p></section><section><h2>Missing games</h2><p>Search the full school or team name and choose its directory match. Use Refresh these results to prioritize the team again. Source pages without a confirmed event or price remain unknown until the source supplies them.</p><a class="text-link" href="./index.html">Find a team ${icon('arrow')}</a></section></div>`,`<button id="refresh-coverage" class="button secondary">${icon('refresh')} Refresh status</button>`);
 let coverageLoad=0;const load=async()=>{const id=++coverageLoad,box=$('#coverage-status');box.innerHTML=loadingRows(2);try{const h=await sbPublicRpc('tix_catalog_health',{p_category:$('#coverage-category').value||null});if(id!==coverageLoad)return;box.innerHTML=coverageMarkup(h);}catch{if(id!==coverageLoad)return;box.innerHTML=errorBox('Coverage status could not load. Your saved events and prices are still available.','retry-coverage');$('#retry-coverage').onclick=load;}};
 $('#coverage-category').onchange=load;$('#refresh-coverage').onclick=load;load();
}

async function getHealth(){try {const rows=await sbGet('tix_state?k=in.(collector_health,notification_health)&select=k,v');return Object.fromEntries(rows.map(r=>[r.k,typeof r.v==='string'?JSON.parse(r.v):r.v]));}catch{return {};}}
let watchPollTimer=null,watchSnapshotBusy=false;
const watchRefreshRequested=new Map();
async function requestFreshWatchChecks(){
 if(IS_DEV)return;
 state.watchRefreshStates||={};
 const candidates=state.watches.filter(w=>w.active&&!w.match?.archived_at&&!w.purchased_at&&!watchCheckFresh(w,state.intelligence.find(i=>i.watch_id===w.id)));
 const requests=[];
 const eventWatches=candidates.filter(w=>w.kind==='event');
 const eventIds=[...new Set(eventWatches.flatMap(w=>w.match?.event_ids||[]))];
 for(let offset=0;offset<eventIds.length&&requests.length<4;offset+=12){
   const ids=eventIds.slice(offset,offset+12),key='events:'+ids.join(',');
   requests.push({key,watches:eventWatches.filter(w=>w.match?.event_ids?.some(id=>ids.includes(id))),body:{p_event_ids:ids}});
 }
 const teams=new Set();
 for(const w of candidates.filter(w=>w.kind==='team')){
   const key='team:'+(w.match?.category||'')+':'+(w.match?.team_id||w.match?.slug);if(teams.has(key)||requests.length>=8)continue;teams.add(key);
   requests.push({key,watches:candidates.filter(other=>other.kind==='team'&&(other.match?.team_id||other.match?.slug)===(w.match?.team_id||w.match?.slug)),body:{p_team_id:w.match?.team_id||null,p_category:w.match?.category||null,p_query:(w.match?.team_label||teamName(w.match?.category,w.match?.slug)||'').slice(0,100)}});
 }
 for(const request of requests){
   if(Date.now()-(watchRefreshRequested.get(request.key)||0)<300000)continue;
   watchRefreshRequested.set(request.key,Date.now());
   let result;
   try{result=await sbRpc('tix_prioritize_search',request.body);}catch{result={state:'failed'};}
   for(const w of request.watches)state.watchRefreshStates[w.id]=result?.state||'failed';
   if(result?.state==='rate_limited')break;
 }
}
function scheduleWatchSnapshot(){
 clearTimeout(watchPollTimer);
 watchPollTimer=setTimeout(async()=>{
   if(document.body.dataset.page!=='watches')return;
   if(!document.hidden&&!watchSnapshotBusy&&!document.querySelector('.watch-target-editor,.watch-schedule[open],.watch-menu[open],.watch-expanded[open]')){
     watchSnapshotBusy=true;
     try{
       state.intelligence=await sbGet('tix_alert_intelligence_v?select=*');
       state.scans=state.intelligence.filter(x=>x.last_checked_at).map(x=>({watch_id:x.watch_id,outcome:x.scan_outcome,checked_at:x.last_checked_at,detail:x.scan_detail,criteria_version:x.criteria_version}));
       renderWatches();await requestFreshWatchChecks();renderWatches();
     }catch{renderWatches();}finally{watchSnapshotBusy=false;}
   }
   scheduleWatchSnapshot();
 },30000);
}
async function watches(){
 clearTimeout(watchPollTimer);
 layout('Your ticket alerts.','Your events, your seats, your price. We’ll keep watch.',`${globalThis.TicketlineNeonAuth?'<p class="notice subtle" role="status">Ticketline is using a new free database. Previous alerts and history are still in the old database. Review or recreate any missing alert here.</p>':''}<div id="watch-health"></div><div class="watch-toolbar"><div class="segmented" aria-label="Filter alerts">${[['all','All alerts'],['active','Watching'],['hit','At target'],['paused','Paused'],['past','Past alerts']].map(([k,l])=>`<button data-filter="${k}" aria-pressed="${state.filter===k}">${l}</button>`).join('')}</div><button id="refresh-watches" class="text-button">${icon('refresh')} Refresh</button></div><div id="watches">${loadingRows(3)}</div>`,`<a class="button primary" href="./new.html">${icon('plus')} Create an alert</a>`);
 $$('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;$$('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',x===b));renderWatches();});$('#refresh-watches').onclick=watches;
 try{
 const [ws,intelligence,health]=await Promise.all([sbGet('tix_watches?select=*&order=created_at.desc'),sbGet('tix_alert_intelligence_v?select=*'),getHealth()]);
 state.watches=ws;state.intelligence=intelligence;
 state.scans=intelligence.filter(x=>x.last_checked_at).map(x=>({watch_id:x.watch_id,outcome:x.scan_outcome,checked_at:x.last_checked_at,detail:x.scan_detail,criteria_version:x.criteria_version}));
 // Read complete paginated history for at most four watches at a time; skip the
 // archived ones, so a long alert list doesn't fan out dozens of requests.
 const histories=[],queue=ws.filter(w=>!w.match?.archived_at&&!w.purchased_at);
 await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{
   for(let w;(w=queue.shift());){
     try{const rows=await readAlertHistory(w.id,'7d');
       histories.push(...rows.map(r=>({...r,watch_id:w.id})));}
     catch(e){reportError(e,'watch history');}
   }
 }));
 state.prices=histories;
 const ids=[...new Set(ws.filter(w=>w.kind==='event').flatMap(w=>w.match?.event_ids||[]))];
 state.eventMarkets={};
 const batches=await Promise.allSettled(Array.from({length:Math.ceil(ids.length/40)},(_,i)=>
   sbGet('tix_events_v?event_id=in.('+ids.slice(i*40,i*40+40).map(encodeURIComponent).join(',')+')&select=event_id,name,slug,category,event_date,datetime_local,venue,city,state,min_total,price_checked_at,discovery_status,url')));
 for(const result of batches)if(result.status==='fulfilled')for(const event of result.value)state.eventMarkets[event.event_id]=event;
 renderWatches();scheduleWatchSnapshot();
 requestFreshWatchChecks().then(()=>renderWatches()).catch(()=>{});
 const h=health.collector_health;
 const watchIssue=state.scans.some(s=>['provider_incomplete','failed','parser_failure','http_failure','event_unavailable'].includes(s.outcome));
 const checkLate=h&&ageMinutes(h.checked_at)>35;
 $('#watch-health').innerHTML=h?`<div class="health-strip ${checkLate||watchIssue?'attention':''}">${icon('clock')}<span>${checkLate?'Checks are delayed.':watchIssue?'One or more alert checks need attention.':'Last collector run '+ago(h.checked_at).toLowerCase()+'.'} New alerts usually get their first check on the next run.</span><a href="./notifications.html">View status</a></div>`:'';
 }catch(e){$('#watches').innerHTML=errorBox(e.message);$('#retry').onclick=watches;}
}
function alertFrequencyLabel(w){
 const mode=w.match?.notification_mode;
 return mode==='first_event'?'First qualifying match per game':mode==='drop'?'Further price drops · at most hourly':mode==='periodic'?'Periodic updates · at most hourly':w.alert_style==='repeat'?'Hourly while at target':'First match per event & section';
}
function watchStatus(w,intel,p,recent,archived,hit){
 if(w.purchased_at)return 'Purchased';if(archived)return 'Past alert';if(!w.active)return 'Paused';
 if(!intel?.last_checked_at)return 'First check pending';
 if(!watchCheckFresh(w,intel))return 'Check pending';
 if(['failed','parser_failure','http_failure'].includes(recent?.outcome||intel.scan_outcome))return 'Check delayed';
 if(hit)return 'At your price';if(intel.scan_outcome==='unavailable')return 'No matching seats';
 return intel.scan_outcome==='provider_incomplete'?'Details unconfirmed':intel.scan_outcome==='event_unavailable'?'Event unavailable':'Watching';
}
function watchHeading(w){
 if(w.kind!=='event')return `<h2>${esc(w.kind==='team'?(w.match?.team_label||teamName(w.match?.category,w.match?.slug)||w.label):w.label)}</h2>${w.kind==='team'&&w.label!==(w.match?.team_label||teamName(w.match?.category,w.match?.slug))?`<p class="watch-personal-label">${esc(w.label)}</p>`:''}`;
 const id=w.match?.event_ids?.[0],event=state.eventMarkets?.[id],intel=state.intelligence?.find(i=>i.watch_id===w.id);
 const name=event?.name||w.match?.event_name||intel?.event_label||'Event details unavailable';
 return `<h2>${esc(name)}</h2>${w.label!==name?`<p class="watch-personal-label">${esc(w.label)}</p>`:''}${watchEventDetails(w)}`;
}
function watchGap(w,p){
 if(!p)return '';
 const gap=p.price_cents-w.threshold_cents;
 return `<p class="watch-gap ${gap<=0?'at-target':''}"><strong>${gap>0?money(gap)+' above your target':gap<0?money(-gap)+' below your target':'At your target'}</strong><span>${money(p.price_cents*w.qty)} total for ${w.qty} · ${p.basis==='fees_included_tax_reported'?'Fees and reported tax included':'Fees included; tax may be added'}</span></p>`;
}
function watchProgress(w,intel){
 const valid=intel?.criteria_version==null||w.criteria_version==null||intel.criteria_version===w.criteria_version;
 const last=valid?intel?.last_success_at:null;
 return `<p class="watch-progress">${last?'Last successful check '+esc(ago(last).toLowerCase()):'No successful check recorded for these preferences'}${intel?.last_checked_at?`<span>Last attempt ${esc(ago(intel.last_checked_at).toLowerCase())}</span>`:''}</p>`;
}
async function editWatchTarget(w,article){
 const button=article.querySelector('[data-action="target"]');button.hidden=true;
 const form=document.createElement('form');form.className='watch-target-editor';form.innerHTML=`<label>Maximum per ticket, fees included<input type="number" min="1" max="50000" step="0.01" inputmode="decimal" required value="${(w.threshold_cents/100).toFixed(2)}"></label><div><button class="button primary" type="submit">Save target</button><button class="button secondary" type="button">Cancel</button></div><p role="status"></p>`;
 button.after(form);form.querySelector('input').focus();form.querySelector('[type="button"]').onclick=()=>{form.remove();button.hidden=false;button.focus();};
 form.onsubmit=async e=>{e.preventDefault();const input=form.querySelector('input'),cents=Math.round(Number(input.value)*100);if(!Number.isInteger(cents)||cents<100||cents>5000000)return;
 const submit=form.querySelector('[type="submit"]');submit.disabled=true;
 try{const updated=await sbRpc('tix_update_watch_controls',{p_watch_id:w.id,p_threshold_cents:cents,p_excluded_event_ids:null,p_expected_version:w.criteria_version});Object.assign(w,updated);renderWatches();toast('Target saved. Waiting for a check using your new price.');}catch(error){form.querySelector('[role="status"]').textContent=error.message;submit.disabled=false;}
 };
}
function watchScheduleShell(w){return `<details class="watch-schedule"><summary>Upcoming games &amp; exclusions</summary><div class="watch-schedule-body" role="region" aria-label="Upcoming games for ${esc(w.label)}"></div></details>`;}
async function loadWatchSchedule(w,details){
 const box=details.querySelector('.watch-schedule-body');if(box.dataset.loaded)return;box.dataset.loaded='true';box.innerHTML='<p role="status">Loading upcoming games…</p>';
 try{
 let rows;
 if(w.match?.team_id)rows=await sbPublicRpc('tix_search_team_events',{p_team_id:w.match.team_id,p_limit:500});
 else{const slug=String(w.match?.slug||'').replace(/[^a-z0-9-]/g,'');if(!slug)throw Error('Edit this alert to choose a confirmed team.');rows=await sbGet('tix_events_v?category=eq.'+encodeURIComponent(w.match.category)+'&slug=ilike.*'+encodeURIComponent(slug)+'*&event_date=gte.'+todayISO()+'&select=event_id,name,event_date,datetime_local,venue,slug&order=event_date&limit=500');rows=rows.map(r=>({...r,is_home:(r.slug||'').endsWith('-at-'+slug),is_away:(r.slug||'').startsWith(slug+'-at-')})).filter(r=>r.is_home||r.is_away);}
 const ha=w.match?.home_away||'any';rows=rows.filter(r=>r.event_date>=todayISO()&&(ha==='any'||ha==='home'&&r.is_home===true||ha==='away'&&(r.is_home===false||r.is_away===true))).sort((a,b)=>String(a.event_date).localeCompare(String(b.event_date)));
 const samples={};for(let offset=0;offset<rows.length;offset+=40){const ids=rows.slice(offset,offset+40).map(r=>encodeURIComponent(r.event_id));const markets=await sbGet('tix_event_market?event_id=in.('+ids.join(',')+')&select=event_id,checked_at,by_qty');for(const m of markets)samples[m.event_id]=m;}
 if(!rows.length){box.innerHTML='<p>No upcoming games are currently listed for this alert.</p>';return;}
 box.innerHTML='<p class="field-help">Prices verify your quantity. Section restrictions are checked by your alert separately. Excluded games never send an alert.</p><div class="watch-game-list">'+rows.map(r=>{
 const m=samples[r.event_id],price=ageMinutes(m?.checked_at)>=0&&ageMinutes(m?.checked_at)<15?m?.by_qty?.[String(w.qty)]:null,usable=price&&knownPriceBasis(price.basis)&&Number.isInteger(price.low)&&price.low>0,cents=usable?price.low:null;
 const excluded=w.match?.excluded_event_ids?.includes(r.event_id);
 return `<div class="watch-game"><div><a href="./event.html?event=${encodeURIComponent(r.event_id)}">${esc(r.name||'Game')}</a><small>${esc(quickGameDate(r))}${r.venue?' · '+esc(r.venue):''}</small><span>${cents==null?'Matching price pending':money(cents)+' per ticket · '+(cents<=w.threshold_cents?'under your target':'above your target')}${w.match?.club_level?' · section match unconfirmed':''}</span></div><label><input type="checkbox" data-exclude="${esc(r.event_id)}" ${excluded?'checked':''}> Exclude</label></div>`;
 }).join('')+'</div><p class="schedule-save-status" role="status"></p>';
 box.querySelectorAll('[data-exclude]').forEach(input=>input.onchange=async()=>{box.querySelectorAll('input').forEach(i=>i.disabled=true);const excluded=new Set(w.match?.excluded_event_ids||[]);if(input.checked)excluded.add(input.dataset.exclude);else excluded.delete(input.dataset.exclude);
 try{const updated=await sbRpc('tix_update_watch_controls',{p_watch_id:w.id,p_threshold_cents:null,p_excluded_event_ids:[...excluded],p_expected_version:w.criteria_version});Object.assign(w,updated);const card=details.closest('.watch-card');if(card){const score=card.querySelector('.watch-score>div+div');score.innerHTML='<span>Current price</span><strong>—</strong><small>Waiting for a check with your new preferences</small>';card.querySelector('.watch-gap')?.remove();card.querySelector('.watch-progress').textContent='Waiting for a successful check with your new preferences.';card.querySelector('.badge').textContent='Check pending';card.querySelector('a.full')?.remove();card.classList.remove('is-hit');}box.querySelector('.schedule-save-status').textContent='Game preferences saved.';}catch(e){input.checked=!input.checked;box.querySelector('.schedule-save-status').textContent=e.message;}finally{box.querySelectorAll('input').forEach(i=>i.disabled=false);}
 });
 }catch(e){box.dataset.loaded='';box.innerHTML=`<p role="status">${esc(e.message||'Could not load this schedule. Close and reopen to retry.')}</p>`;}
}

function watchCheckFresh(w,intel){
 const age=ageMinutes(intel?.last_checked_at);
 return age>=0&&age<15&&(intel.criteria_version==null||w.criteria_version==null||intel.criteria_version===w.criteria_version)&&new Date(intel.last_checked_at)>=new Date(w.criteria_updated_at||w.created_at||0);
}
function watchLatest(w){
 const intel=state.intelligence?.find(x=>x.watch_id===w.id);
 if(intel&&watchCheckFresh(w,intel)&&intel.criteria_version===w.criteria_version&&knownPriceBasis(intel.basis)&&intel.current_price_cents!=null&&intel.scan_outcome==='ok'&&ageMinutes(intel.price_checked_at)<15&&new Date(intel.price_checked_at)>=new Date(w.criteria_updated_at||w.created_at||0)){
   return [{watch_id:w.id,price_cents:intel.current_price_cents,checked_at:intel.price_checked_at,
     listing_url:intel.listing_url,event_label:intel.event_label,event_id:intel.current_event_id,club:intel.club,qty:w.qty,
     basis:intel.basis,prefee_cents:intel.prefee_cents,sales_tax_cents:intel.sales_tax_cents,pre_tax_total_cents:intel.pre_tax_total_cents,deal:intel.deal,hist:intel.hist,lots:intel.lots}];
 }
 if(intel)return [];
 const scans=state.scans.filter(s=>s.watch_id===w.id);const byEvent=Object.fromEntries(scans.map(s=>[s.event_id,s]));const seen=new Set();
 const latest=state.prices.filter(p=>{if(!knownPriceBasis(p.basis)||p.watch_id!==w.id||p.criteria_version!=null&&p.criteria_version!==w.criteria_version||new Date(p.checked_at)<new Date(w.criteria_updated_at||w.created_at))return false;const key=p.event_id+'|'+p.club;if(seen.has(key))return false;seen.add(key);const scan=byEvent[p.event_id];return p.qty===w.qty&&ageMinutes(p.checked_at)<15&&scan?.criteria_version===w.criteria_version&&scan.outcome==='ok'&&new Date(p.checked_at)>=new Date(scan.checked_at)-1000;});
 const rows=latest.filter(p=>p.watch_id===w.id);return rows.sort((a,b)=>a.price_cents-b.price_cents);
}
function watchDiagnostic(w,intel,price,market){
 if(!w.active)return 'This alert is paused.';
 if(!intel?.last_checked_at||!watchCheckFresh(w,intel)){
   const refresh=state.watchRefreshStates?.[w.id];
   return refresh==='failed'?'Could not request current prices. Use Refresh to try again.':refresh==='rate_limited'?'Price updates are temporarily limited. Waiting for the next check.':intel?.last_checked_at?'Updating prices. The previous check is old; a fresh check is pending.':'Waiting for the first check of your seats and quantity.';
 }
 if(['parser_failure','http_failure','failed'].includes(intel.scan_outcome))
   return `Last ${intel.scan_detail?.source==='database'?'database save':'ticket-provider check'} failed ${ago(intel.last_checked_at).toLowerCase()}. We will retry.`;
 if(intel.scan_detail?.reasons?.some(r=>r.startsWith('deal_')))return 'Price matched, but the deal rating is not confirmed. Deal-only alerts are waiting for verified tier ordering.';
 if(intel.scan_outcome==='provider_incomplete'&&intel.scan_detail?.reasons?.includes('required_listing_fields_unknown'))return `Required listing details are not confirmed. We cannot verify ${w.qty} tickets together yet.`;
 if(intel.scan_outcome==='provider_incomplete')return market?.min_total!=null&&market.price_checked_at?
   `Gametime get-in is ${money(market.min_total)} per ticket, but that does not verify ${w.qty} tickets together. Exact-seat alerts wait for seller lot sizes.`:
   `Gametime did not provide seller lot sizes. We cannot verify ${w.qty} tickets together yet.`;
 if(intel.scan_outcome==='event_unavailable')return 'This event is unavailable from the ticket provider.';
 if(!price){
   const lots=intel.scan_detail?.available_lots||[],count=intel.scan_detail?.listings_checked||0,matches=intel.scan_detail?.matching_listings;
   const checked=ago(intel.last_checked_at).toLowerCase();
   if(intel.scan_outcome==='ok')return `A listing matched your ${w.qty}-ticket alert at the last check, but a current verified price is not available.`;
   if(matches>0)return `The last check found listings offering ${w.qty} tickets together, but none matched your other seat requirements.`;
   if(lots.includes(w.qty))return `The provider reported ${w.qty}-ticket lots at the last check, but no listing was verified for all of this alert’s requirements.`;
   if(intel.scan_outcome==='unavailable')return count?
     `None of the ${count} listings checked ${checked} offered ${w.qty} tickets together${lots.length?`; available ticket quantities were ${lots.join(', ')}`:''}.`:
     'No matching listings were found at the last check.';
   return 'A matching price is not confirmed. Waiting for a successful ticket-provider check.';
 }
 const distance=price.price_cents-w.threshold_cents;
 return distance>0?`At the last verified check, the cheapest matching ${w.qty}-ticket lot was ${money(price.price_cents)}. Your target is ${money(w.threshold_cents)}.`:
   `At the last verified check, a matching listing was ${money(Math.abs(distance))} ${distance?'below':'at'} your target. Check Activity for delivery status.`;
}
function watchScanSummary(w,intel){
 if(!watchCheckFresh(w,intel))return '';
 const matches=intel?.scan_detail?.matching_listings;
 if(Number.isInteger(matches)&&matches>=0)return `${matches} ${matches===1?'listing':'listings'} ${matches?'offered':'verified for'} ${w.qty} tickets together · checked ${ago(intel.last_checked_at)}`;
 return intel?.last_checked_at?`Last provider check ${ago(intel.last_checked_at)}`:'';
}
function watchPriceDisplay(w,current,history,scan){
 if(current)return {label:'Current price',price_cents:current.price_cents,
   detail:`Verified ${ago(current.checked_at)}`,breakdown:priceBreakdown(current)};
 const fresh=watchCheckFresh(w,{last_checked_at:scan?.checked_at,criteria_version:scan?.criteria_version});
 const detail=w.active===false?'Alert paused':!fresh?'Updating prices':scan.outcome==='unavailable'?'No listings match these seat preferences':scan.outcome==='provider_incomplete'?'Listing details unavailable':['failed','parser_failure','http_failure'].includes(scan.outcome)?'Could not check prices':scan.outcome==='event_unavailable'?'Event unavailable':'Price not confirmed';
 return {label:'Current price',price_cents:null,detail};
}
function watchEventDetails(w){
 if(w.kind!=='event')return '';
 const ids=w.match?.event_ids||[];
 const intel=state.intelligence?.find(x=>x.watch_id===w.id);
 const events=ids.length?ids:[null];
 return '<div class="watch-event-details">'+events.map(id=>{
  const event=state.eventMarkets?.[id];
  const name=event?.name||w.match?.event_name||(intel?.current_event_id===id?intel.event_label:'')||'Event details unavailable';
  const date=event?.event_date||(events.length===1?w.match?.event_date:null);
  const label=date?dateObj(date).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'}):'Date to be confirmed';
  return `<p class="watch-event"><strong>${id?`<a href="./event.html?event=${encodeURIComponent(id)}">${esc(name)}</a>`:esc(name)}</strong><span>${esc(label)}${event?.datetime_local?' · '+esc(dateObj(event.datetime_local).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})):''}${event?.venue?' · '+esc(event.venue):''}</span></p>`;
 }).join('')+'</div>';
}
function renderWatches(){
 const box=$('#watches');const ws=state.watches.filter(w=>{const past=!!(w.match?.archived_at||w.purchased_at);return state.filter==='past'?past:!past&&(state.filter==='all'||(state.filter==='active'&&w.active)||(state.filter==='paused'&&!w.active)||(state.filter==='hit'&&w.active&&watchLatest(w).some(p=>p.price_cents<=w.threshold_cents)));});
 if(!ws.length){box.innerHTML=`<div class="empty-state watch-empty"><span class="empty-ticket">${icon('ticket')}</span><h2>${state.watches.length?'No alerts in this view.':'Good seats start with a game plan.'}</h2><p>${state.watches.length?'Choose another filter to see your saved alerts.':'Choose an event and your maximum price. Your first ticket alert takes about a minute to set up.'}</p><a class="button primary" href="./new.html">${icon('plus')} Create an alert</a></div>`;return;}
 box.innerHTML='<div class="watch-grid"></div>';const grid=$('.watch-grid');
 for(const w of ws){const rows=watchLatest(w),p=rows[0],history=watchHistory(state.prices,w.id),context=priceProof(history,p),intel=state.intelligence.find(x=>x.watch_id===w.id),archived=!!(w.match?.archived_at||w.purchased_at),hit=w.active&&!archived&&p&&p.price_cents<=w.threshold_cents;const recent=state.scans.filter(s=>s.watch_id===w.id)[0],display=watchPriceDisplay(w,p,history,recent),market=w.kind==='event'?state.eventMarkets[w.match?.event_ids?.[0]]:null,marketFresh=market?.min_total!=null&&market.price_checked_at&&ageMinutes(market.price_checked_at)<15;const status=watchStatus(w,intel,p,recent,archived,hit);
 const article=document.createElement('article');article.className='watch-card'+(hit?' is-hit':'');article.innerHTML=`<div class="watch-card-head">${watchTeamStamp(w,market)}<span class="badge ${hit?'green':!w.active?'neutral':['failed','provider_incomplete'].includes(recent?.outcome)?'amber':'blue'}">${w.active?'<i></i>':''}${status}</span></div>${watchHeading(w)}<p class="watch-detail">${esc(w.kind==='team'?matchSummary(w):w.kind==='date'?matchSummary(w):'One event')} · ${w.qty} ${w.qty===1?'ticket':'tickets together'}</p><div class="watch-score"><div><span>Your target</span><strong>${money(w.threshold_cents)}</strong><small>per ticket, fees included</small></div><div><span>${display.label}</span><strong class="${hit?'hit-text':''}">${display.price_cents!=null?money(display.price_cents):'—'}</strong><small>${esc(display.detail)}</small>${display.breakdown?`<small>${esc(display.breakdown)}</small>`:''}</div></div>${watchGap(w,p)}${watchProgress(w,intel)}<details class="watch-expanded"><summary>Details &amp; price history</summary>${p?`<div class="watch-trend">${sparkline(history.filter(r=>r.basis===p.basis&&r.qty===p.qty&&r.club===p.club&&(!p.event_id||r.event_id===p.event_id)))}<p>${esc(context||'Price history is building with each check.')}</p></div>`:''}${marketFresh&&!p?`<div class="watch-market"><span>Gametime get-in · any quantity</span><strong>${money(market.min_total)}</strong><small>Checked ${ago(market.price_checked_at)} · exact ${w.qty}-ticket lot unverified</small></div>`:''}${p?`<p class="price-context">${esc(p.club)} · ${esc(p.event_label||'')}${hit?`<br><strong>${money(w.threshold_cents-p.price_cents)} below your limit</strong>`:''}</p>`:(marketFresh||intel?.scan_outcome==='provider_incomplete'?'':'<p class="price-context">We’ll show a price when a recent listing matches your seat preferences.</p>')}<div class="intelligence"><strong>${esc(watchDiagnostic(w,intel,p,marketFresh?market:null))}</strong>${p&&history.length>1&&intel?.low_7d_cents!=null?`<p>7-day low ${money(intel.low_7d_cents)} · high ${money(intel.high_7d_cents)}${intel.price_24h_ago_cents!=null&&p?` · ${money(Math.abs(p.price_cents-intel.price_24h_ago_cents))} ${p.price_cents<intel.price_24h_ago_cents?'down':'up'} in 24 hours`:''}</p>`:''}${watchScanSummary(w,intel)?`<p>${esc(watchScanSummary(w,intel))}</p>`:''}</div>${marketLinks(market?.name||p?.event_label||w.label)}${!p&&marketFresh&&safeUrl(market.url)?`<a class="text-link market-view" href="${esc(safeUrl(market.url))}" target="_blank" rel="noopener">Check current listings on Gametime ${icon('arrow')}</a>`:''}<div class="watch-options"><span>${icon('people')}${w.match?.club_level?(w.clubs.length?esc(w.clubs.join(', ')):'Any club section'):'Any section'}</span><span>${icon('bell')}${alertFrequencyLabel(w)}</span></div></details>${w.kind==='team'?watchScheduleShell(w):''}${p&&safeUrl(p.listing_url)?`<a class="button ${hit?'primary':'secondary'} full" href="${esc(safeUrl(p.listing_url))}" target="_blank" rel="noopener">View tickets on Gametime ${icon('arrow')}</a>`:''}<div class="card-actions"><button data-action="target">Change target</button><details class="watch-menu"><summary>Manage alert</summary><div><a href="./new.html?edit=${encodeURIComponent(w.id)}">Edit all preferences</a><a href="./ledger.html?watch=${encodeURIComponent(w.id)}">Price history</a>${archived?(w.purchased_at?'':`<button data-action="restore">Restore</button>`):`<button data-action="pause">${w.active?'Pause':'Resume'}</button><button data-action="purchased">I bought tickets</button><button data-action="delete" aria-label="Archive ${esc(w.label)}">Archive</button>`}</div></details></div>`;
 article.querySelector('[data-action="target"]').onclick=()=>editWatchTarget(w,article);
 const schedule=article.querySelector('.watch-schedule');if(schedule)schedule.addEventListener('toggle',()=>{if(schedule.open)loadWatchSchedule(w,schedule);});
 if(article.querySelector('[data-action="pause"]'))article.querySelector('[data-action="pause"]').onclick=async e=>{e.target.disabled=true;try{const out=await sbWrite('PATCH','tix_watches?id=eq.'+encodeURIComponent(w.id),{active:!w.active});if(!out.length)throw new Error('This alert no longer exists. Refresh the page.');w.active=!w.active;renderWatches();toast(w.active?'Alert resumed.':'Alert paused.');}catch(err){toast(err.message);e.target.disabled=false;}};
 if(article.querySelector('[data-action="restore"]'))article.querySelector('[data-action="restore"]').onclick=async e=>{e.target.disabled=true;try{const {archived_at,...match}=w.match;const out=await sbWrite('PATCH','tix_watches?id=eq.'+encodeURIComponent(w.id),{match});if(!out.length)throw new Error('This alert no longer exists. Refresh the page.');w.match=match;renderWatches();toast('Alert restored. It stays paused until you resume it.');}catch(err){toast(err.message);e.target.disabled=false;}};
 if(article.querySelector('[data-action="purchased"]'))article.querySelector('[data-action="purchased"]').onclick=()=>{
   showDialog('Mark tickets purchased?',`<p>This stops <strong>${esc(w.label)}</strong> and keeps its history.</p><label class="field-label" for="purchase-price">Total paid, optional</label><div class="currency-input"><span>$</span><input id="purchase-price" type="number" min="0" step="0.01" inputmode="decimal"></div><div class="dialog-actions"><button class="button secondary" id="purchase-cancel">Cancel</button><button class="button primary" id="purchase-confirm">Mark purchased</button></div><div id="purchase-error"></div>`);
   $('#purchase-cancel').onclick=()=>$('#dialog').close();
   $('#purchase-confirm').onclick=async e=>{e.target.disabled=true;try{const input=$('#purchase-price').value;
     const total=input===''?null:Math.round(Number(input)*100);if(total!=null&&(!Number.isFinite(total)||total<0))throw new Error('Enter a valid total price.');
     const purchased_at=new Date().toISOString();const out=await sbWrite('PATCH','tix_watches?id=eq.'+encodeURIComponent(w.id),{active:false,purchased_at,purchase_price_cents:total});
     if(!out.length)throw new Error('This alert no longer exists.');w.active=false;w.purchased_at=purchased_at;w.purchase_price_cents=total;
     $('#dialog').close();renderWatches();toast('Purchase saved.');
   }catch(err){$('#purchase-error').innerHTML=errorBox(err.message,'');e.target.disabled=false;}};
 };
 if(article.querySelector('[data-action="delete"]'))article.querySelector('[data-action="delete"]').onclick=()=>{showDialog('Archive this alert?',`<p><strong>${esc(w.label)}</strong></p><p>This stops the alert and keeps its price and text history in Past alerts. You can restore it from Past alerts later.</p><div class="dialog-actions"><button class="button secondary" id="cancel-delete">Keep watching</button><button class="button danger" id="confirm-delete">Archive alert</button></div><div id="delete-error"></div>`);$('#cancel-delete').onclick=()=>$('#dialog').close();$('#confirm-delete').onclick=async e=>{e.target.disabled=true;try{const match={...w.match,archived_at:new Date().toISOString()};const out=await sbWrite('PATCH','tix_watches?id=eq.'+encodeURIComponent(w.id),{active:false,match});if(!out.length)throw new Error('This alert no longer exists. Refresh the page.');w.active=false;w.match=match;$('#dialog').close();renderWatches();toast('Alert archived.');}catch(err){$('#delete-error').innerHTML=errorBox(err.message,'');e.target.disabled=false;}};};grid.appendChild(article);const logo=article.querySelector('.team-logo');if(logo)logo.onerror=()=>{logo.parentElement.classList.remove('has-team-logo');logo.remove();};
 }
}
async function builder(){
 state.kind=['team','date'].includes(query.get('kind'))?query.get('kind'):'event';
 if(!query.has('edit')){
  const qty=Number(query.get('qty'));if(Number.isInteger(qty)&&qty>=1&&qty<=8)state.qty=qty;
  if(query.get('quick')==='1'){
   const price=query.get('price')||'';
   if(/^\d{1,6}(?:\.\d{1,2})?$/.test(price)&&Number(price)>=1&&Number(price)<=400000)state.threshold=price;
   state.emailEnabled=query.get('email')!=='0';state.smsEnabled=query.get('sms')==='1';
   if(!state.emailEnabled&&!state.smsEnabled)state.emailEnabled=true;
  }
 }
 const quickStep=()=>query.get('quick')==='1'&&state.threshold&&!state.smsEnabled?3:2;
 if(state.kind==='date'&&query.get('date')&&!query.has('edit')){
  const date=query.get('date');
  if(/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=todayISO()&&date<=todayISO(new Date(Date.now()+365*86400000))){state.selected={date,city:(query.get('city')||'').slice(0,60),state:''};state.step=quickStep();renderBuilder();return;}
 }
 if(state.kind==='team'&&query.get('team')&&!query.has('edit')){
  try{const teams=await sbPublicRpc('tix_resolve_teams',{p_query:query.get('team'),p_category:state.category||null,p_limit:12});const team=teams?.find(t=>t.team_id===query.get('team'));if(team){state.selected={team:team.team_id,team_id:team.team_id,label:team.label};state.step=quickStep();renderBuilder();loadClubs();return;}}catch{}
 }
 if(query.has('edit')||query.has('event')){
 layout('Getting your alert ready.','One moment while we load the details.',loadingRows(2));
 try {
 if(query.has('edit')){const [w]=await sbGet('tix_watches?id=eq.'+encodeURIComponent(query.get('edit'))+'&select=*');if(!w)throw new Error('This alert was removed. Start a new alert from Find events.');state.edit=w;state.kind=w.kind;state.qty=w.qty;state.threshold=(w.threshold_cents/100).toString();state.clubs=w.clubs||[];state.clubLevel=w.match.club_level??!!w.clubs.length;state.homeAway=w.match.home_away||'home';state.alertStyle=w.alert_style;state.alertMode=w.match?.notification_mode||(w.alert_style==='repeat'?'periodic':'legacy');state.emailEnabled=w.email_enabled!==false;state.smsEnabled=!!w.sms_enabled;state.label=w.label;state.category=w.match.category||state.category;try{const meta=await sbRpc('tix_destination_meta',{p_watch_id:w.id});state.destinationConfigured=!!meta?.configured;state.provider=meta?.provider||'';state.existingProvider=state.provider;}catch{}if(w.kind==='team')state.selected={team:w.match.slug,team_id:w.match.team_id||null,label:w.match.team_label||null};else if(w.kind==='date')state.selected={date:w.match.date,city:w.match.city,state:w.match.state,venue_slug:w.match.venue_slug};else{const [event]=await sbGet('tix_events_v?event_id=eq.'+encodeURIComponent(w.match.event_ids[0])+'&select=*');if(!event)throw new Error('This event is no longer in the catalog. Create a new alert for an upcoming event.');state.selected=event;}}
 else{const [event]=await sbGet('tix_events_v?event_id=eq.'+encodeURIComponent(query.get('event'))+'&select=*');if(!event)throw new Error('This event is no longer available. Find another event to watch.');state.selected=event;}
 state.step=query.has('edit')?2:quickStep();renderBuilder();loadClubs();
 }catch(e){layout('Let’s find another event.','Your alert has not changed.',errorBox(e.message,'')+'<a class="button primary" href="./new.html">Start a new alert</a>');}return;
 }renderBuilder();
}
// College basketball school names for the team picker. Generated by scripts/tickets_team_names.py from Gametime's public directory.
// Display and search only: the value stored in watch.match.slug is still the nickname slug the collector matches on.
// "u" = one school uses the nickname (shown as "School Nickname"); "s" = several do (nickname stays the name, schools are listed).
const TEAM_NAMES={"2k-sports-classic":["u","2K Sports Classic 2K Sports Classic","2k sports classic 2k"],"49ers":["u","Charlotte 49ers","charlotte uncc"],"aac-basketball":["u","American Athletic Conference Basketball Tournament AAC Basketball","american athletic conference basketball tournament aac"],"aaul-hbcu-basketball-invitational":["u","AAUL HBCU Basketball Invitational AAUL HBCU Basketball Invitational","aaul hbcu basketball invitational aaul"],"acc-tournament":["u","ACC Basketball Tournament ACC Tournament","acc basketball tournament acc"],"acrisure-invitational":["u","Acrisure Invitational Acrisure Invitational","acrisure invitational"],"acrisure-series":["u","The Acrisure Series Acrisure Series","the acrisure series"],"aggies":["s",["Delaware Valley","New Mexico State","North Carolina A&T","Texas A&M","UC Davis","Utah State"],"ncat nmsu txam ucd usu"],"alabama-sports-hof-basketball-classic":["u","Alabama Sports Hall of Fame Basketball Classic Alabama Sports HOF Basketball Classic","alabama sports hall of fame basketball classic"],"ambassadors":["u","College of Biblical Studies Ambassadors","college of biblical studies"],"anchormen":["u","Rhode Island College Anchormen","rhode island college"],"anteaters":["u","UC Irvine Anteaters","uc irvine uci"],"antelopes":["u","Grand Canyon Antelopes","grand canyon gcu"],"argonauts":["u","West Florida Argonauts","west florida"],"art-u":["u","Academy of Art Art U","academy of art"],"asheville-championship":["u","Asheville Championship Asheville Championship","asheville championship"],"atlantic-10-tournament":["u","Atlantic 10 Tournament Atlantic 10 Tournament","atlantic 10 tournament"],"attles":["u","Al Attles Classic Attles","al attles classic"],"az-tip-off":["u","Arizona Tip-Off AZ Tip-Off","arizona tip-off az"],"aztecs":["u","San Diego State Aztecs","san diego state sdsu"],"badgers":["s",["Spring Hill College","Wisconsin"],"wis"],"ball-dawgs-classic":["u","Ball Dawgs Classic Ball Dawgs Classic","ball dawgs classic"],"ballin-in-boutwell":["u","Ballin In Boutwell Ballin In Boutwell","ballin in boutwell"],"barclays-center-classic":["u","Barclays Center Classic Barclays Center Classic","barclays center classic"],"barstool-invitational":["u","Barstool Sports Invitational Barstool Invitational","barstool sports invitational"],"basketball-hall-of-fame-tip-off":["u","Basketball Hall of Fame Tip Off Basketball Hall of Fame Tip Off","basketball hall of fame tip off"],"basketball-showcase":["u","Hoop Hype XL | College Basketball Showcase Basketball Showcase","hoop hype xl | college basketball showcase"],"battlin-bears":["u","Rocky Mountain College Battlin' Bears","rocky mountain college"],"battling-bishops":["u","North Carolina Wesleyan Battling Bishops","north carolina wesleyan"],"beach":["u","Long Beach State Beach","long beach state lbsu"],"beacons":["s",["UMass Boston","Valparaiso"],"valp"],"bearcat":["u","McKendree Bearcat","mckendree mku"],"bearcats":["s",["Binghamton","Brescia","Cincinnati","Northwest Missouri State","Rust College","Southwest Baptist","St. Vincent","Willamette"],"bing cin nwmsu"],"bearkats":["u","Sam Houston State Bearkats","sam houston state samst"],"bears":["s",["Baylor","Brown","Central Arkansas","Coast Guard","Lenoir Rhyne","Mercer","Missouri State","Morgan State","Northern Colorado","SUNY Potsdam","Shawnee State"],"bay brown cau lru merc misu morg ncu suny"],"beavers":["s",["Babson","Baruch","Bluffton","Oregon State"],""],"beehive-classic":["u","Beehive Classic Beehive Classic","beehive classic"],"bengals":["u","Idaho State Bengals","idaho state idst"],"big-12":["u","Big 12 Basketball Tournament Big 12","big 12 basketball tournament"],"big-5-classic":["u","Big 5 Classic Big 5 Classic","big 5 classic"],"big-blue":["u","Milikin Big Blue Big Blue","milikin big blue"],"big-east-tournament":["u","Big East Tournament Big East Tournament","big east tournament"],"big-green":["u","Dartmouth Big Green","dartmouth dart"],"big-red":["u","Cornell Big Red","cornell corn"],"big-sky-mens-tournament":["u","Big Sky Mens Basketball Tournament Big Sky Mens Tournament","big sky mens basketball tournament"],"big-south":["u","Big South Basketball Tournament Big South","big south basketball tournament"],"big-ten-tournament":["u","Big Ten Mens Basketball Tournament Big Ten Tournament","big ten mens basketball tournament"],"big-west":["u","Big West Tournament Big West","big west tournament"],"bill-walton-classic":["u","National University Bill Walton Classic Bill Walton Classic","national university bill walton classic"],"billikens":["u","St. Louis Billikens","st. louis"],"bison":["s",["Bethany College Basketball","Bucknell","Gallaudet","Howard","Oklahoma Baptist"],"buck howd"],"bisons":["s",["Harding","Lipscomb","North Dakota State"],"lip ndst"],"black-bears":["u","Maine Black Bears","maine maine"],"black-college-invitational":["u","Black College Invitational Black College Invitational","black college invitational"],"black-knights":["u","Army Black Knights","army army"],"blackbirds":["u","LIU Brooklyn Blackbirds","liu brooklyn liu"],"blazers":["s",["Belhaven","Elms College","Hood College Blazers","UAB","Valdosta State"],"hood uab vsu"],"bloodhounds":["u","John Jay College Bloodhounds","john jay college"],"blue-angels":["u","Mount Mary Blue Angels","mount mary"],"blue-bears":["u","Livingstone Blue Bears","livingstone"],"blue-demons":["u","DePaul Blue Demons","depaul"],"blue-devils":["s",["Central Connecticut State","Dillard","Duke","SUNY Fredonia","Wisconsin-Stout"],"ccst duke suny"],"blue-hawks":["u","Dickinson State Blue Hawks","dickinson state"],"blue-hens":["u","Delaware Blue Hens","delaware ud"],"blue-hose":["u","Presbyterian Blue Hose","presbyterian pres"],"blue-raiders":["u","Middle Tennessee State Blue Raiders","middle tennessee state mtsu"],"blue-tigers":["u","Lincoln (MO) Blue Tigers","lincoln (mo)"],"bluejays":["u","Creighton Bluejays","creighton crei"],"bobcats":["s",["Bryant & Stratton","Frostburg State","Georgia College","Lee-McRae College","Montana State","Ohio","Peru State","Quinnipiac","Texas State"],"mstu ohio quinn tsu"],"boilmakers":["u","Purdue Boilmakers","purdue pur"],"boll-weevils":["u","Arkansas Monticello Boll Weevils","arkansas monticello"],"bonnies":["u","St. Bonaventure Bonnies","st. bonaventure sbon"],"braves":["s",["Alcorn State","Bradley","UNC Pembroke"],"alcst brad uncp"],"brew-city":["u","Brew City Battle Brew City","brew city battle"],"brewton-parker-barons":["u","Brewton-Parker College Brewton-Parker Barons","brewton-parker college"],"bronchos":["u","Central Oklahoma Bronchos","central oklahoma uco"],"broncos":["s",["Boise State","Fayetteville State","Rider","Santa Clara","Texas Pan American","Western Michigan"],"bsu fysu ru scu tpau wmu"],"bruins":["s",["Bellevue","Belmont","Bob Jones","Carolina University","George Fox","UCLA"],"bel ucla"],"bryan-lions":["u","Bryan College Bryan Lions","bryan college"],"buccaneers":["s",["Charleston Southern","Christian Brothers","East Tennessee State","Park University Gilbert"],"char etsu"],"buckeyes":["u","Ohio State Buckeyes","ohio state osu"],"buffaloes":["s",["Arkansas Baptist","Colorado","Miligan","West Texas A&M Women's"],"colo"],"bulldogs":["s",["Alabama A&M","Bowie State","Boyce","Bryant","Butler","Citadel","Drake","Ferris State","Fisk","Fresno State","Gardner-Webb","Georgia","Gonzaga","Jarvis Christian","Louisiana Tech","Minnesota Duluth","Mississippi State","Samford","South Carolina State","Southwestern Oklahoma State","Tennessee Wesleyan","Texas Lutheran","Truman State","UNC Asheville","Union Commonwealth","Yale"],"alam bry but cit drake fsu gonz gwu latu msst sam scst sw uga unca yale"],"bulls":["s",["Buffalo","South Florida"],"buff usf"],"c-m-newton-classic":["u","C.M. Newton Classic C.M. Newton Classic","c.m. newton classic"],"c-usa-basketball-tournament":["u","C-USA Basketball Tournament C-USA Basketball Tournament","c-usa basketball tournament"],"caa-mens":["u","CAA Men's Basketball Championship CAA Men's","caa men's basketball championship caa"],"cairn-highlanders":["u","Cairn Cairn Highlanders","cairn"],"camels":["u","Campbell Camels","campbell camp"],"cardinal":["u","Stanford Cardinal","stanford stan"],"cardinals":["s",["Andrews University","Ball State","Catholic University","Incarnate Word","Lamar","Louisville","Plattsburgh State","Saginaw Valley State","St. John Fisher","William Jewell"],"au bsu cu iwu lamar lou svsu"],"caresource-invitational":["u","CareSource Invitational CareSource Invitational","caresource invitational"],"catamounts":["s",["Vermont","Vermont Lowell","Western Carolina"],"vu wcar"],"cavaliers":["s",["Montreat College","Virginia","Walsh"],"uva"],"cbi-tournament":["u","CBI Tournament CBI Tournament","cbi tournament cbi"],"cbs-sports-classic":["u","CBS Sports Classic CBS Sports Classic","cbs sports classic cbs"],"champions-classic":["u","Champions Classic Champions Classic","champions classic"],"chanticleers":["u","Coastal Carolina Chanticleers","coastal carolina ccu"],"chargers":["s",["Alabama-Huntsville","Hillsdale College","New Haven"],""],"charleston-classic":["u","Charleston Classic Charleston Classic","charleston classic"],"chicago-legends":["u","Chicago Legends Chicago Legends","chicago legends"],"chippewas":["u","Central Michigan Chippewas","central michigan cmu"],"choctaws":["u","Mississippi College Choctaws","mississippi college mc"],"christian-evangels":["u","Mid-America Christian Evangels","mid-america"],"christian-wolfpack":["u","Oak Hills Christian Christian Wolfpack","oak hills christian"],"ciaa-basketball-tournament":["u","CIAA Mens and Womens Basketball Tournament CIAA Basketball Tournament","ciaa mens and womens basketball tournament ciaa"],"citi-hoops-classic":["u","Citi Hoops Classic Citi Hoops Classic","citi hoops classic"],"classique-du-nord":["u","Classique Du Nord - NCAA Division II Classique Du Nord","classique du nord - ncaa division ii"],"cleveland-classic":["u","Cleveland Classic Cleveland Classic","cleveland classic"],"coast-to-coast-challenge":["u","Coast to Coast Challenge Coast to Coast Challenge","coast to coast challenge"],"cobbers":["u","Concordia College Cobbers","concordia college"],"college-basketball-crown":["u","College Basketball Crown College Basketball Crown","college basketball crown"],"college-of-new-jersey":["u","College of New Jersey Lions College of New Jersey","college of new jersey lions"],"college-slam-dunk-3-point-championships":["u","State Farm College Slam Dunk & 3-Point Championships College Slam Dunk & 3-Point Championships","state farm college slam dunk & 3-point championships"],"colonels":["s",["Centre","Eastern Kentucky","Nicholls State"],"eku nstu"],"colonials":["u","Robert Morris Colonials","robert morris rmu"],"comets":["s",["Capital","Maryville State","UT Dallas"],"ut"],"commodores":["u","Vanderbilt Commodores","vanderbilt van"],"compete-4-cause":["u","Compete 4 Cause Classic Compete 4 Cause","compete 4 cause classic"],"continental-tire":["u","Continental Tire Main Event Basketball Tournament Continental Tire","continental tire main event basketball tournament"],"cornhuskers":["u","Nebraska Cornhuskers","nebraska neb"],"cougars":["s",["Azusa Pacific","BYU","Caldwell","Charleston","Chicago State","Cleary","Colorado Christian","Houston","Indiana-Kokomo","SIU Edwardsville","Washington State"],"byu cald ccu charu csu hou iku siued wsu"],"cowboys":["s",["Hardin-Simmons","McNeese State","New Mexico Highlands","Oklahoma State","Wyoming"],"mcu nmhu okst wyo"],"coyotes":["u","South Dakota Coyotes","south dakota sdu"],"crimson":["u","Harvard Crimson","harvard harv"],"crimson-hawks":["u","IUP Crimson Hawks","iup iup"],"crimson-pride":["u","IUPUC Crimson Pride","iupuc iupuc"],"crimson-tide":["u","Alabama Crimson Tide","alabama ala"],"crimson-wave":["u","Calumet College Crimson Wave","calumet college"],"crossroads-classic":["u","Crossroads Classic Crossroads Classic","crossroads classic"],"crusaders":["s",["Dallas Christian","Holy Cross","North Greenville","William Carey"],"holy ngu"],"cyclones":["u","Iowa State Cyclones","iowa state isu"],"delta-devils":["u","Mississippi Valley State Delta Devils","mississippi valley state mvsu"],"demon-deacons":["u","Wake Forest Demon Deacons","wake forest wake"],"demons":["u","Northwestern State Demons","northwestern state nwst"],"detroit-basketball-showcase":["u","Detroit Basketball Showcase Detroit Basketball Showcase","detroit basketball showcase cbb"],"devils":["u","Fairleigh Dickinson Florham Devils","fairleigh dickinson florham"],"diamond-head-classic":["u","Diamond Head Classic Diamond Head Classic","diamond head classic"],"dolphins":["s",["Jacksonville","Le Moyne"],"jack"],"dons":["u","San Francisco Dons","san francisco usf"],"doubleheader":["u","KAN v STAN, PORT v SAC ST Doubleheader","kan v stan, port v sac st"],"dragons":["s",["Drexel","Lane College","Minnesota State - Moorhead","Tiffin Dragons","Virginia-Lynchburg"],"drex lc msu tiff"],"drovers":["u","University of Science and Arts (OK) Drovers","university of science and arts (ok)"],"ducks":["u","Oregon Ducks","oregon"],"dukes":["s",["Duquesne","James Madison"],"duq jmu"],"dustdevils":["u","Texas A&M-International Dustdevils","texas a&m-international txami"],"eagles":["s",["Alice Lloyd College","American","Ashland","Avila","Biola University","Boston College","Central Methodist","Chadron State","Concordia Irvine","Coppin State","Eastern Michigan","Eastern Washington","Embry-Riddle","Florida Gulf Coast","Georgia Southern","Judson Eagles","Midway","Morehead State","North Carolina Central","Northern New Mexico","Northwest Indian College","Northwest University","Oklahoma Christian","Southwestern Christian","Trinity Baptist","Williams Baptist (ARK)","Winthrop"],"au bc copst emu ewu fgcu gsu more nnmu uncc win"],"edward-waters":["u","Edward Waters College Edward Waters","edward waters college"],"elks":["u","Stanton Elks","stanton"],"empire":["u","Empire Classic Empire","empire classic"],"engineers":["u","MIT Engineers","mit mit"],"espn-events-invitational":["u","ESPN Events Invitational ESPN Events Invitational","espn events invitational espn"],"explorers":["u","La Salle Explorers","la salle salle"],"falcons":["s",["Air Force","Bowling Green","Fisher College","Florida College","Friends University","Montevallo Falcons","Pfeiffer","Simmons College of Kentucky","St. Augustine's","UT Permian Basin"],"afa bgu ut"],"fightin-engineers":["u","Rose-Hulman Fightin' Engineers","rose-hulman rhit"],"fighting-bees":["u","St. Ambrose Fighting Bees","st. ambrose"],"fighting-hawks":["u","North Dakota Fighting Hawks","north dakota ndu"],"fighting-illini":["u","Illinois Fighting Illini","illinois ill"],"fighting-indians":["u","Haskell Indian Nations Fighting Indians","haskell indian nations"],"fighting-irish":["u","Notre Dame Fighting Irish","notre dame nd"],"fighting-knights":["u","Lynn Fighting Knights Fighting Knights","lynn fighting knights lynn"],"fighting-muskies":["u","Muskingum Fighting Muskies","muskingum"],"fighting-saints":["u","Carroll College Fighting Saints","carroll college"],"fighting-scots":["s",["Edinboro University","Wooster"],""],"fighting-squirrels":["u","Mary Baldwin Fighting Squirrels","mary baldwin"],"firebirds":["s",["District of Columbia Women's","Saint Katherine"],""],"firehawks":["u","Tennessee Southern Firehawks","tennessee southern ut"],"firestorm":["u","Arizona Christian Baketball Firestorm","arizona christian baketball"],"flames":["s",["Bethesda","Liberty","UIC"],"bu lib uic"],"flyers":["s",["Dayton","Lewis Flyers"],"day lewis"],"flying-fleet":["u","Erskine Flying Fleet","erskine erk"],"foresters":["u","Huntington Foresters","huntington"],"fort-myers":["u","Fort Myers Tip-Off Fort Myers","fort myers tip-off"],"friars":["u","Providence Friars","providence prov"],"gaels":["s",["Iona","Saint Mary's"],"iona smc"],"gamecocks":["s",["Jacksonville State","South Carolina"],"jkst usc"],"gators":["s",["Florida","Notre Dame of Maryland","San Francisco State"],"fla"],"gauchos":["u","UC Santa Barbara Gauchos","uc santa barbara ucsb"],"generals":["s",["LSU Alexandria","Washington & Lee"],"lsu"],"gentlemen":["u","Centenary College Gentlemen","centenary college"],"geoducks":["u","Evergreen State Geoducks","evergreen state"],"gold-rush":["u","Xavier (LA) Gold Rush","xavier (la)"],"golden-bear":["u","West Virginia Tech Golden Bear","west virginia tech"],"golden-bears":["s",["California","Clinton","Concordia St Paul","Miles College"],"mc"],"golden-bobcats":["u","UC Merced Golden Bobcats","uc merced uc"],"golden-bulls":["u","Johnson C. Smith Golden Bulls","johnson c. smith"],"golden-eagles":["s",["Cal State LA","Clarion","Cornerstone","La Sierra","Marquette","Minnesota Crookston","Oral Roberts","Southern Miss","Spalding","St. Joseph's - Long Island","Tennessee Tech"],"marq oru smu tnt"],"golden-flashes":["u","Kent State Golden Flashes","kent state kent"],"golden-flyers":["u","Nazareth College Golden Flyers","nazareth college"],"golden-gophers":["u","Minnesota Golden Gophers","minnesota minn"],"golden-griffins":["u","Canisius Golden Griffins","canisius can"],"golden-grizzlies":["u","Oakland Golden Grizzlies","oakland oak"],"golden-hurricane":["u","Tulsa Golden Hurricane","tulsa tlsa"],"golden-knights":["s",["College of Saint Rose","Gannon"],"gu"],"golden-lions":["u","Arkansas Pine Bluff Golden Lions","arkansas pine bluff arpb"],"golden-panthers":["u","Florida International Golden Panthers","florida international fiu"],"gophers":["u","Sarah Lawrence College Gophers","sarah lawrence college"],"gorillas":["u","Pittsburg State Gorillas","pittsburg state pstu"],"gotham-classic":["u","Gotham Classic Gotham Classic","gotham classic"],"governors":["u","Austin Peay Governors","austin peay apu"],"great-danes":["u","Albany Great Danes","albany alb"],"green-knights":["u","St Norbert Green Knights","st norbert snu"],"green-terror":["u","McDaniel Green Terror","mcdaniel"],"green-wave":["u","Tulane Green Wave","tulane tuln"],"grenadiers":["u","Indiana Southeast Grenadiers","indiana southeast"],"grey-wolves":["u","Lourdes Grey Wolves","lourdes"],"greyhounds":["s",["Assumption University","Eastern New Mexico","Indianapolis University","Loyola Maryland"],"enmu iu lmd"],"griffins":["s",["Chestnut Hill College","Westminster"],""],"griffons":["u","Missouri Western State Griffons","missouri western state"],"grizzlies":["s",["Adams State","Franklin College","Montana"],"mont"],"gulf-coast-showcase":["u","Men's Gulf Coast Showcase Gulf Coast Showcase","men's gulf coast showcase"],"gulls":["u","Endicott College Gulls","endicott college"],"gyrenes":["u","Ave Maria Gyrenes","ave maria"],"halal-guys-showcase":["u","The Halal Guys Showcase Halal Guys Showcase","the halal guys showcase"],"hall-of-fame":["u","Basketball Hall of Fame Showcase Hall of Fame","basketball hall of fame showcase"],"hall-of-fame-classic":["u","Basketball Hall of Fame Classic Hall of Fame Classic","basketball hall of fame classic"],"hall-of-fame-invite":["u","Basketball Hall of Fame Invitational Hall of Fame Invite","basketball hall of fame invitational"],"hardrockers":["u","South Dakota Mines Hardrockers","south dakota mines"],"hatters":["u","Stetson Hatters","stetson stet"],"hawkeyes":["u","Iowa Hawkeyes","iowa iowa"],"hawks":["s",["Chowan","Hartford","Maryland Eastern Shore","Monmouth","Quincy","Quincy Women's","Rockhurst University","Saint Josephs","San Diego Christian"],"cu hart joes mesu mon qu"],"hbcu-challenge":["u","HBCU Challenge HBCU Challenge","hbcu challenge hbcu"],"hbcu-tip-off":["u","HBCU Tip Off HBCU Tip Off","hbcu tip off hbcu"],"highlanders":["s",["NJIT","Radford","UC Riverside"],"njit rad ucr"],"hillcats":["u","Rogers State Hillcats","rogers state"],"hilltoppers":["u","Western Kentucky Hilltoppers","western kentucky wku"],"hof-series":["u","Hall of Fame Series HOF Series","hall of fame series"],"hokies":["u","Virginia Tech Hokies","virginia tech vt"],"holiday-hoopfest":["u","Holiday Hoopfest Holiday Hoopfest","holiday hoopfest"],"holiday-hoopsgiving":["u","Holiday Hoopsgiving Holiday Hoopsgiving","holiday hoopsgiving"],"hoophall-2016":["u","Hoophall 2016 Hoophall 2016","hoophall 2016"],"hoophall-miami":["u","HoopHall Miami Invitational HoopHall Miami","hoophall miami invitational"],"hoosiers":["u","Indiana Hoosiers","indiana ind"],"horizon-league":["u","Horizon League Basketball Tournament Horizon League","horizon league basketball tournament"],"horned-frogs":["u","TCU Horned Frogs","tcu tcu"],"hornets":["s",["Alabama State","Delaware State","Emporia State","Harris Stowe State University","Morris College","Sacramento State","Shenandoah"],"alst dsu esu sacst"],"houston-hoopfest":["u","Houston Hoopfest Houston Hoopfest","houston hoopfest"],"hoyas":["u","Georgetown Hoyas","georgetown gtwn"],"hurricanes":["s",["Georgia Southwestern State","Miami"],"gsws mia"],"huskies":["s",["Houston Christian","Michigan Tech","Northeastern","Northern Illinois","Northern Illinois Women's","St. Cloud State","UConn","UW-Eau Claire","Washington"],"hcu niu wash"],"ichabods":["u","Washburn Ichabods Ichabods","washburn ichabods wash"],"icons-of-the-game":["u","Icons of the Game Icons of the Game","icons of the game"],"indy-classic":["u","Indy Classic Indy Classic","indy classic"],"islanders":["u","Texas A&M Corpus Christi Islanders","texas a&m corpus christi txamcc"],"ivy-league":["u","Ivy League Basketball Tournament Ivy League","ivy league basketball tournament"],"jack-jones-hoopfest":["u","Jack Jones Hoopfest Jack Jones Hoopfest","jack jones hoopfest"],"jackrabbits":["u","South Dakota State Jackrabbits","south dakota state sdsu"],"jacksonville-classic":["u","Jacksonville Classic Jacksonville Classic","jacksonville classic"],"jaguars":["s",["IU Indianapolis","South Alabama","Southern"],"iu sau su"],"jaspers":["u","Manhattan Jaspers","manhattan man"],"javelinas":["u","Texas A&M Kingsville Javelinas","texas a&m kingsville txamj"],"jayhawks":["u","Kansas Jayhawks","kansas ku"],"jerry-colangelo-classic":["u","Jerry Colangelo Classic Jerry Colangelo Classic","jerry colangelo classic"],"jets":["u","Newman Jets","newman"],"jimmies":["u","Jamestown Jimmies","jamestown"],"jimmy-v-classic":["u","Jimmy V Classic Jimmy V Classic","jimmy v classic"],"jumbos":["u","Tufts Jumbos","tufts"],"jumpman":["u","Jumpman Invitational Jumpman","jumpman invitational"],"keydets":["u","VMI Keydets","vmi vmi"],"knights":["s",["Bellarmine","Central Penn","Fairleigh Dickinson","Kentucky Christian","Marian","Southern Virginia","Southwestern Adventist","St. Andrews","UCF","Warner Pacific","Wartburg"],"bu fair mu ucf wpu"],"koalas":["u","Columbia College Koalas","columbia college"],"lakers":["s",["Clayton State","Grand Valley State","Mercyhurst","Roosevelt"],"mu"],"lancers":["s",["California Baptist","Grace College","Longwood","Mount Marty"],"cbu long"],"las-vegas-clash":["u","Las Vegas Clash Las Vegas Clash","las vegas clash"],"las-vegas-classic":["u","Las Vegas Classic Las Vegas Classic","las vegas classic"],"las-vegas-invitational":["u","Las Vegas Invitational Las Vegas Invitational","las vegas invitational"],"leathernecks":["u","Western Illinois Leathernecks","western illinois wiu"],"lees-mcrae-bobcats":["u","Lees McRae Lees McRae Bobcats","lees mcrae"],"legacy-classic":["u","Legacy Classic Legacy Classic","legacy classic"],"legends-classic":["u","Legends Classic Legends Classic","legends classic"],"legends-of-basketball":["u","Legends of Basketball Showcase Legends of Basketball","legends of basketball showcase"],"leopards":["s",["La Verne","Lafayette"],"laf verne"],"lions":["s",["Arkansas-Fort","Bryn Athyn","Columbia","East Texas A&M","Emerson","Florida Memorial","Georgian Court","Justice","LMU","Lincoln University","Lindenwood","Mars Hill","Missouri Southern State","Molloy University","Mount St. Joseph","North Alabama","Paine College","Penn State Behrend","Piedmont","Saint Leo","Southeastern Louisiana","Texas A&M - Commerce","Vanguard"],"col lmu lu nau selu"],"little-giants":["u","Wabash Little Giants","wabash"],"lobo-classic":["u","Lobo Classic Lobo Classic","lobo classic"],"lobos":["s",["New Mexico","Sul Ross State"],"unm"],"loggers":["u","Puget Sound Loggers","puget sound"],"longhorns":["u","Texas Longhorns","texas tex"],"lopers":["u","Nebraska-Kearney Lopers","nebraska-kearney unk"],"lsc-basketball-championship":["u","Lone Star Conference Basketball Championship LSC Basketball Championship","lone star conference basketball championship lsc"],"lumberjacks":["s",["Humboldt State","Northern Arizona","Stephen F. Austin"],"hbst nau sfau"],"lynx":["s",["Lesly","Rhodes"],""],"lyons":["u","Wheaton College Lyons","wheaton college"],"mac":["u","MAC Basketball Tournament MAC","mac basketball tournament mac"],"main-event":["u","MGM Grand Main Event Main Event","mgm grand main event mgm"],"majors":["u","Millsaps College Majors","millsaps college"],"maple-leafs":["u","Goshen College Maple Leafs","goshen college"],"marauders":["u","Central State Marauders","central state csu"],"mariners":["s",["Coastal Georgia","Merchant Marine"],""],"marlins":["u","Virginia Wesleyan Marlins","virginia wesleyan"],"maroon-tigers":["u","Morehouse Maroon Tigers","morehouse more"],"maroons":["u","Chicago Maroons","chicago chi"],"mastodons":["s",["IPFW","Purdue Fort Wayne"],"ipfw pfwu"],"matadors":["u","Cal State Northridge Matadors","cal state northridge csun"],"maui-invitational":["u","Maui Invitational Maui Invitational","maui invitational"],"mavericks":["s",["Minnesota State","Nebraska-Omaha","UT Arlington"],"uno uta"],"mcdonalds-all-american-game":["u","McDonalds All American Game McDonalds All American Game","mcdonalds all american game"],"meac-tournament":["u","MEAC Basketball Tournament MEAC Tournament","meac basketball tournament meac"],"mean-green":["u","North Texas Mean Green","north texas ntu"],"mens-tournament":["u","D1 Men's College Basketball Tournament Mens Tournament","d1 men's college basketball tournament d1"],"metro-mens":["u","Metro Conference Mens Basketball Tournament Metro Mens","metro conference mens basketball tournament"],"middle-georgia-state-knights":["u","Middle Georgia State Middle Georgia State Knights","middle georgia state"],"midshipmen":["u","Navy Midshipmen","navy navy"],"mighty-oaks":["u","Oakland City University Mighty Oaks","oakland city university"],"miners":["s",["Missouri S&T","UTEP"],"utep"],"minutemen":["u","UMass Minutemen","umass"],"missouri-valley":["u","MVC Basketball Tournament Missouri Valley","mvc basketball tournament mvc"],"moccasins":["u","Florida Southern Moccasins","florida southern fsu"],"mocs":["u","Chattanooga Mocs","chattanooga chat"],"monarchs":["u","Old Dominion Monarchs","old dominion odu"],"mountain-cats":["u","Pittsburgh-Johnstown Mountain Cats","pittsburgh-johnstown"],"mountain-hawks":["u","Lehigh Mountain Hawks","lehigh leh"],"mountain-west-tournament":["u","Mountain West Mens Basketball Tournament Mountain West Tournament","mountain west mens basketball tournament"],"mountaineers":["s",["Appalachian State","Berea College","Eastern Oregon","Mount St. Marys","West Virginia","Western Colorado"],"apsu msm wcu wvu"],"musketeers":["u","Xavier Musketeers","xavier xav"],"muskies":["u","Lakeland Muskies","lakeland llu"],"mustangs":["s",["Cal Poly","Central Baptist","Mid-Atlantic Christian","SMU","Southwest Minnesota State","University of the Southwest","Western New Mexico"],"poly smst smu wnmu"],"myrtle-beach-invitational":["u","Myrtle Beach Invitational Myrtle Beach Invitational","myrtle beach invitational"],"nabc-brooklyn-showcase":["u","NABC Brooklyn Showcase NABC Brooklyn Showcase","nabc brooklyn showcase nabc"],"nanooks":["u","Alaska-Fairbanks Nanooks","alaska-fairbanks uaf"],"nashville-hoops-showdown":["u","Nashville Hoops Showdown Nashville Hoops Showdown","nashville hoops showdown"],"nba-hbcu-classic":["u","NBA HBCU Classic NBA HBCU Classic","nba hbcu classic nba"],"neon-hoops-showcase":["u","Neon Hoops Showcase Neon Hoops Showcase","neon hoops showcase"],"never-forget-tribute":["u","Never Forget Tribute Classic Never Forget Tribute","never forget tribute classic"],"new-college":["u","New College of Florida New College","new college of florida"],"nike-hoop":["u","Nike Hoop Summit Nike Hoop","nike hoop summit"],"nit-season-tip-off":["u","NIT Season Tip-Off NIT Season Tip-Off","nit season tip-off nit"],"nit-tournament":["u","NIT Tournament NIT Tournament","nit tournament nit"],"nittany-lions":["s",["Penn State","Penn State Brandywine"],"psu"],"norse":["s",["Luther","Northern Kentucky"],"nku"],"northern-lights":["u","MSU Northern Lights Northern Lights","msu northern lights msu"],"oaks":["u","Menlo College Oaks","menlo college"],"oilers":["u","Findlay Oilers","findlay"],"oles":["u","St. Olaf Oles","st. olaf"],"orange":["u","Syracuse Orange","syracuse syc"],"orange-bowl-basketball-classic":["u","Orange Bowl Basketball Classic Orange Bowl Basketball Classic","orange bowl basketball classic"],"orediggers":["s",["Colorado School of Mines","Montana Tech"],"mtu"],"ospreys":["u","North Florida Ospreys","north florida nfu"],"ovc":["u","OVC Basketball Tournament OVC","ovc basketball tournament ovc"],"owls":["s",["Florida Atlantic","Kennesaw State","Rice","Temple","Warren Wilson","William Woods"],"fau kenn rice tem"],"ozark-christian-college-ambassadors":["u","Ozark Christian College Ozark Christian College Ambassadors","ozark christian college"],"pac-12-tournament":["u","PAC 12 Basketball Tournament PAC 12 Tournament","pac 12 basketball tournament pac"],"pacers":["s",["Marywood","William Peace"],""],"paladins":["u","Furman Paladins","furman fur"],"panthers":["s",["Birmingham-Southern College","Chapman","Clark Atlanta","Davenport","Drury","Eastern Illinois","Ferrum College","Florida Tech","Georgia State","Hanover College","High Point","Kentucky Wesleyan","LaGrange","Northern Iowa","Ohio Dominican","Pittsburgh","Prairie View A&M","Wisconsin Milwaukee","York"],"chap eiu gsu high niu pitt pvam ukw uwm"],"patriots":["s",["George Mason","UT Tyler","University of the Cumberlands"],"gmu utt"],"peacocks":["s",["Saint Peter's","Upper Iowa"],"sp"],"penguins":["u","Youngstown State Penguins","youngstown state ysu"],"penmen":["u","Southern New Hampshire Penmen","southern new hampshire"],"phantoms":["u","East West Phantoms","east west"],"phoenix":["s",["Elon","Wisconsin Green Bay"],"elon uwgb"],"pilots":["s",["Bethel Indiana","Portland"],"port"],"pioneers":["s",["Cal State East Bay","Denver","Lewis & Clark","Malone","Pacific Union","Point Park","Sacred Heart","Transylvania","Tusculum","Utica"],"du shu tu tusc"],"pirates":["s",["East Carolina","Hampton","Seton Hall","Southwestern University"],"ecu hamp shu swu"],"pk80":["u","Phil Knight Invitational PK80","phil knight invitational"],"players-era-festival":["u","Players Era Festival Players Era Festival","players era festival"],"poets":["u","Whittier Poets","whittier whit"],"pointers":["u","UW-Stevens Point Pointers","uw-stevens point"],"polar-bears":["s",["Bowdoin","Ohio Northern"],""],"praire-stars":["u","Illinois-Springfield Praire Stars","illinois-springfield"],"pride":["s",["Clarke University","Greensboro College","Hofstra","Purdue Northwest"],"hof"],"privateers":["u","New Orleans Privateers","new orleans uno"],"purple-aces":["u","Evansville Purple Aces","evansville evan"],"purple-eagles":["u","Niagara Purple Eagles","niagara nu"],"purple-knights":["u","St. Michaels Women's Purple Knights","st. michaels women's"],"quakers":["s",["Earlham College","Guilford","Pennsylvania","Wilmington College"],"gu penn"],"racers":["u","Murray State Racers","murray state murst"],"ragin-cajuns":["u","Louisiana Ragin' Cajuns","louisiana llu"],"raiders":["u","Wright State Raiders","wright state wsu"],"railsplitters":["u","Lincoln Memorial Railsplitters","lincoln memorial unlu"],"ramblers":["u","Loyola Chicago Ramblers","loyola chicago lcmu"],"rams":["s",["Angelo State","Bluefield","Colorado State","Columbia International","Cornell College","Fordham","Framingham State","Rhode Island","Shepherd University","Texas Wesleyan","VCU","Winston-Salem State"],"ansu csu ford uri vcu wssu"],"rangers":["s",["Northwestern Oklahoma State","Regis","Wisconsin-Parkside"],"uwp"],"rattlers":["u","Florida A&M Rattlers","florida a&m flam"],"ravens":["s",["Anderson","Franklin Pierce","Rosemont"],""],"razorbacks":["u","Arkansas Razorbacks","arkansas ark"],"rebels":["s",["Ole Miss","UNLV"],"ole unlv"],"red-devils":["u","Eureka Red Devils","eureka"],"red-flash":["u","Saint Francis (PA) Red Flash","saint francis (pa) sfu"],"red-foxes":["u","Marist Red Foxes","marist mar"],"red-leafs":["u","Simon Fraser Red Leafs","simon fraser"],"red-raiders":["s",["Colgate","Texas Tech"],"colg ttu"],"red-storm":["u","St. John's Red Storm","st. john's sju"],"red-wolves":["u","Arkansas State Red Wolves","arkansas state arkst"],"redbirds":["u","Illinois State Redbirds","illinois state ilst"],"reddies":["u","Henderson State Reddies","henderson state"],"redhawks":["s",["Benedictine Mesa","Miami (OH)","Roberts Wesleyan","Seattle","Southeast Missouri State"],"moh semsu su"],"redmen":["u","McGill Redmen","mcgill mcgill"],"regents":["u","Rockford Regents","rockford rock"],"reinhardt-eagles":["u","Reinhardt Eagles Reinhardt Eagles","reinhardt eagles"],"retrievers":["u","UMBC Retrievers","umbc umbc"],"revolutionaries":["u","George Washington Revolutionaries","george washington gw"],"river-hawks":["u","UMass Lowell River Hawks","umass lowell uml"],"riverhawks":["u","Northeastern State RiverHawks","northeastern state"],"roadrunners":["s",["CSU Bakersfield","Dalton State","Metro State","UTSA"],"csub utsa"],"rockets":["u","Toledo Rockets","toledo tol"],"roos":["s",["Kansas City","SUNY-Canton"],"umkc"],"royals":["s",["Ecclesia College","Queens"],""],"running-eagles":["u","Life University Running Eagles","life university"],"saints":["s",["Central Christian","Emmanuel College","Limestone","Maryville University","Saint Martins","Siena","St. Lawrence","Thomas More"],"lime mu siena smu tmu"],"salukis":["u","Southern Illinois Salukis","southern illinois siu"],"san-marcos-cougars":["u","Cal State San Marcos San Marcos Cougars","cal state san marcos"],"saxons":["u","Alfred University Saxons","alfred university"],"scarlet-knights":["u","Rutgers Scarlet Knights","rutgers rutg"],"scots":["u","Macalester Scots","macalester"],"screaming-eagles":["u","Southern Indiana Screaming Eagles","southern indiana siu"],"sea-lions":["u","Point Loma Nazarene Sea Lions","point loma nazarene"],"seahawks":["s",["Keiser","Northwood","St. Mary's College of Maryland","UNC Wilmington","Wagner"],"nwu uncw wag"],"seawolves":["s",["Sonoma State","Stony Brook"],"ssu stony"],"sec-tournament":["u","SEC Basketball Tournament SEC Tournament","sec basketball tournament sec"],"seminoles":["u","Florida State Seminoles","florida state fsu"],"senators":["u","Davis and Elkins Senators","davis and elkins"],"setters":["u","Pace Setters","pace"],"sharks":["s",["Hawaii Pacific","LIU","Nova Southeastern"],"liu nsu"],"shockers":["u","Wichita State Shockers","wichita state"],"silverswords":["u","Chaminade Silverswords","chaminade cham"],"simmons-bank":["u","Simmons Bank Showdown Simmons Bank","simmons bank showdown"],"skyhawk":["u","Navajo Tech Skyhawk","navajo tech"],"skyhawks":["s",["Fort Lewis College","Point","Stonehill","UT Martin"],"ft utm"],"sooners":["u","Oklahoma Sooners","oklahoma okla"],"southern-tournament":["u","Southern Conference Basketball Tournament Southern Tournament","southern conference basketball tournament"],"spartans":["s",["Aurora","Dubuque","Michigan State","Missouri Baptist","Norfolk State","San Jose State","South Carolina Upstate","Trinity Western","UNC Greensboro","USC Upstate","University of Tampa Bay"],"mbu msu nfst scusu sjsu uncg uscu"],"spiders":["u","Richmond Spiders","richmond rich"],"spirit":["u","Ottawa Spirit","ottawa"],"stags":["u","Fairfield Stags","fairfield fair"],"stallions":["u","North American Stallions","north american"],"stars":["u","Oklahoma City Stars","oklahoma city"],"state-farm-champions-classic":["u","State Farm Champions Classic State Farm Champions Classic","state farm champions classic"],"storm":["u","Lake Erie Storm","lake erie"],"stormy-petrels":["u","Oglethorpe Stormy Petrels","oglethorpe"],"summit-league":["u","Summit League Basketball Tournament Summit League","summit league basketball tournament"],"sun-belt-tournament":["u","Sun Belt Basketball Tournament Sun Belt Tournament","sun belt basketball tournament"],"sun-bowl":["u","Sun Bowl Invitational Sun Bowl","sun bowl invitational"],"sun-devils":["u","Arizona State Sun Devils","arizona state asu"],"sunbirds":["u","Fresno Pacific Sunbirds","fresno pacific"],"sunshine-slam":["u","Sunshine Slam Sunshine Slam","sunshine slam"],"swac-basketball":["u","SWAC Basketball Tournament SWAC Basketball","swac basketball tournament swac"],"sycamores":["u","Indiana State Sycamores","indiana state indst"],"tar-heels":["u","North Carolina Tar Heels","north carolina unc"],"tartans":["u","Carnegie Mellon Tartans","carnegie mellon"],"terrapins":["u","Maryland Terrapins","maryland md"],"terriers":["s",["Boston","Hiram College","St Francis Brooklyn","St. Francis","Wofford"],"bu sfc sfu woff"],"texans":["u","Tarleton State Texans","tarleton state"],"texarkana-eagles":["u","Texas A&M - Texarkana Texarkana Eagles","texas a&m - texarkana"],"the-battleground-2k24":["u","The Battleground 2K24 The Battleground 2K24","the battleground 2k24"],"the-rock":["u","Slippery Rock University The Rock","slippery rock university"],"thorobreds":["u","Kentucky State Thorobreds","kentucky state kstu"],"thunderbirds":["u","Southern Utah Thunderbirds","southern utah suu"],"thundering-herd":["u","Marshall Thundering Herd","marshall marsh"],"thunderwolves":["u","Colorado State-Pueblo ThunderWolves","colorado state-pueblo"],"tigers":["s",["Auburn","Benedict College Tigers","Champion Christian College","Clemson","Doane Tigers","Fort Hays State","Georgetown (KY)","Grace Christian University","Grambling State","Holy Family","Jackson State","LSU","Memphis","Missouri","Occidental","Pacific","Paul Quinn","Princeton","Savannah State","Tennessee State","Texas Southern","Towson","Trinity (TX)","Voorhees"],"aub clem doane fhsu gram jackst lsu mem mizz prince savst tnsu tow tsu uop"],"titans":["s",["Cal State Fullerton","Detroit Mercy","Illinois Wesleyan"],"csf det"],"toccoa-falls-screaming-eagles":["u","Toccoa Falls Toccoa Falls Screaming Eagles","toccoa falls"],"tommies":["u","St. Thomas Tommies","st. thomas"],"toppers":["u","Blue Mountain College Toppers","blue mountain college"],"toreros":["u","San Diego Toreros","san diego usd"],"tornados":["u","King University Tornados","king university"],"toros":["u","Cal State Dominquez Hills Toros","cal state dominquez hills csudh"],"trailblazers":["s",["Ohio Christian","UNT Dallas","Utah Tech"],"unt"],"tribe":["u","William & Mary Tribe","william & mary wmu"],"tritons":["s",["Eckerd College","Missouri-St. Louis","UC San Diego"],"eu mslu uc"],"trojans":["s",["Arkansas Little Rock","Mount Olive","Trevecca Trojans","Troy","USC","Virginia State"],"arlr mou troy usc"],"trolls":["u","Trinity Christian Trolls","trinity christian"],"uccs-mountain-lions":["u","UCCS UCCS Mountain Lions","uccs uc"],"utes":["u","Utah Utes","utah"],"valley-of-the-sun":["u","Valley of the Sun Shootout Valley of the Sun","valley of the sun shootout"],"vancouver-select":["u","Vancouver Select Men's Vancouver Select","vancouver select men's"],"vandals":["u","Idaho Vandals","idaho idu"],"vaqueros":["u","UT Rio Grande Vaqueros","ut rio grande utrg"],"vegas-showdown":["u","Vegas Showdown Vegas Showdown","vegas showdown"],"vikings":["s",["Augustana (SD)","Berry College","Cleveland State","Elizabeth City State","Portland State"],"cst ecst psu"],"volunteers":["u","Tennessee Volunteers","tennessee tenn"],"vulcans":["u","Hawaii-Hilo Vulcans","hawaii-hilo uhh"],"wac-tournament":["u","WAC Basketball Tournament WAC Tournament","wac basketball tournament wac"],"walla-walla":["u","Walla Walla Walla Walla","walla walla"],"war-hawks":["u","McMurry War Hawks","mcmurry"],"warhawks":["s",["Auburn University Montgomery","Louisiana Monroe"],"ulm"],"warriors":["s",["Cal State Stanislaus","Corban","Hawaii","Life Pacific","Merrimack","Midland","Nyack","Rochester Christian Women's","SAGU American Indian College","Waldorf","Wayne State","Webber International","Westcliff","Westmont","William Jessup","Winona State"],"csu merr mu nyk sagu uh west wsu"],"waves":["u","Pepperdine Waves","pepperdine pepp"],"wcc-basketball":["u","West Coast Conference Basketball Tournament WCC Basketball","west coast conference basketball tournament wcc"],"wildcats":["s",["Abilene Christian","Arizona","Bethel University","Bethune-Cookman","Central Washington","Chico State","Daemen","Davidson","Fort Valley State","Johnson & Wales","Kansas State","Kentucky","Linfield","Louisiana Christian","New Hampshire","Northern Michigan","Northwestern","Villanova","Weber State"],"acu ari beth csuc dav fvsu ksu nu uk unh vill web"],"wolf-pack":["u","Nevada Wolf Pack","nevada un"],"wolfpack":["s",["Loyola New Orleans","NC State"],"ncst"],"wolverines":["s",["Michigan","Utah Valley"],"mich uvu"],"wolves":["s",["Cardinal Stritch","Cheyney","Keuka College Basketball","Newberry","Northern State","West Georgia","Western Oregon"],""],"wonder-boys":["u","Arkansas Tech Wonder Boys","arkansas tech"],"wooden-legacy":["u","Wooden Legacy Wooden Legacy","wooden legacy"],"yellow-jackets":["s",["Allen University Yellow Jackets","American International","Baldwin-Wallace","Black Hills State","Cedarville Yellow Jackets","Defiance","Georgia Tech","Howard Payne","Randolph Macon"],"cedar gt"],"yellowjackets":["u","Montana State-Billings Yellowjackets","montana state-billings"],"zips":["u","Akron Zips","akron akr"]};
function teamInfo(category,slug){return category==='college-basketball'&&Object.prototype.hasOwnProperty.call(TEAM_NAMES,slug)?TEAM_NAMES[slug]:null;}
function teamName(category,slug){const i=teamInfo(category,slug);return i&&i[0]==='u'?i[1]:cap(slug);}
function teamWords(text){return String(text).toLowerCase().replace(/['\u2019]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean);}
function teamHit(tokens,words){return tokens.every(t=>words.some(w=>w.startsWith(t)));}
// Never narrower than the old nickname substring search; school names and abbreviations only add matches.
function teamMatches(category,slug,filter){if(cap(slug).toLowerCase().includes(filter))return true;const i=teamInfo(category,slug);const tokens=teamWords(filter);if(!i||!tokens.length)return false;return teamHit(tokens,teamWords(cap(slug)+' '+(i[0]==='u'?i[2]:i[1].join(' ')+' '+i[2])));}
function teamSub(category,slug,filter){const i=teamInfo(category,slug);if(!i||i[0]!=='s')return '';const tokens=teamWords(filter);const hit=tokens.length?i[1].filter(s=>teamHit(tokens,teamWords(s))):[];const rest=i[1].filter(s=>!hit.includes(s));const list=hit.concat(rest);return 'Shared nickname: '+list.slice(0,3).join(', ')+(list.length>3?', +'+(list.length-3)+' more':'');}
function selectionTitle(){return state.kind==='team'?(state.selected?.label||teamName(state.category,state.selected?.team)):state.kind==='date'?whenShort(state.selected?.date)+(state.selected?.city?' in '+state.selected.city:state.selected?.state?' in '+state.selected.state:''):cap(state.selected?.name||'Choose an event');}
function summary(){const total=Math.round(Number(state.threshold)*100)*state.qty;const destination=state.smsEnabled?(state.provider?(state.phone?`${carrierName(state.provider)} · ${formatPhone(state.phone)}`:`${carrierName(state.provider)} · saved number`):'Add a number'):'Off';return `<aside class="builder-summary"><div class="summary-ticket"><div class="summary-top">${icon('ticket')}<span>Your game plan</span></div><h3>${esc(state.selected?selectionTitle():'A great night starts here.')}</h3><p>${esc(state.kind==='event'&&state.selected?whenShort(state.selected.event_date)+' · '+(state.selected.venue||cap(state.selected.venue_slug)):state.kind==='team'?'Follow the schedule. Catch the right price.':'Choose what you want to see, then set your limit.')}</p><div class="summary-lines"><div><span>Tickets together</span><strong>${state.qty}</strong></div><div><span>Maximum per ticket</span><strong>${state.threshold?money(Math.round(Number(state.threshold)*100)):'Your call'}</strong></div><div><span>Total ticket budget</span><strong>${state.threshold?money(total):'—'}</strong></div></div><div class="summary-bottom">${icon('check')} Fees included in your limit</div></div><div class="aside-note">${icon('bell')}<p><strong>Delivery</strong>${state.emailEnabled?'Sign-in email':'Email off'}${state.smsEnabled?' + '+esc(destination):''}. Your full number stays private.</p></div></aside>`;}
// Warn before leaving the builder with unsaved details; cleared once the alert saves.
addEventListener('beforeunload',e=>{if(page==='new'&&state.step>=2&&!state.saved){e.preventDefault();e.returnValue='';}});
function renderBuilder(){
 layout(state.edit?'Fine-tune your alert.':'Be there. At your price.','A few details now. A heads-up when the right tickets show up.',`<ol class="steps" aria-label="Alert setup progress">${['Pick your event','Price & delivery','Review & save'].map((s,i)=>`<li class="${state.step===i+1?'current':state.step>i+1?'complete':''}" ${state.step===i+1?'aria-current="step"':''}><span>${state.step>i+1?icon('check'):i+1}</span>${s}</li>`).join('')}</ol><div class="builder-layout"><section class="builder-panel" id="builder-panel"></section><div id="builder-summary">${summary()}</div></div>`);
 if(state.step===1)pickStep();else if(state.step===2)priceStep();else reviewStep();
}
function pickStep(){
 $('#builder-panel').innerHTML=`<div class="panel-heading"><h2>What’s on your radar?</h2><p>Track one event, a team, or everything on a date.</p></div><div class="kind-grid">${[['event','ticket','One event','A game, concert, or show'],['team','ball','A team','Home, away, or both'],['date','clock','A day out','See what fits your plans']].map(([k,i,t,s])=>`<button data-kind="${k}" aria-pressed="${state.kind===k}">${icon(i)}<strong>${t}</strong><span>${s}</span></button>`).join('')}</div><div id="picker"></div>`;
 $$('[data-kind]').forEach(b=>b.onclick=()=>{state.kind=b.dataset.kind;state.selected=null;state.clubs=[];state.clubLevel=false;state.controller?.abort();pickStep();});
 if(state.kind==='event'){$('#picker').innerHTML=`${searchControls(true)}<div class="results-meta"><span id="results-count" role="status"></span></div><div id="events"></div><button id="more-events" class="button secondary load-more" hidden>Show more events</button>`;bindSearch(pickerEvents);$('#more-events').onclick=()=>{state.offset+=12;pickerEvents(true);};state.offset=0;pickerEvents();}
 else if(state.kind==='team')teamPicker();else datePicker();
}
async function pickerEvents(append=false){await loadEvents(append);if(!$('#events'))return;$$('.alert-button',$('#events')).forEach(a=>{a.innerHTML=`Select ${icon('arrow')}<span class="sr-only">${esc(a.closest('article').querySelector('h3').textContent)}</span>`;a.onclick=e=>{e.preventDefault();const id=new URL(a.href).searchParams.get('event');state.selected=state.events.find(x=>x.event_id===id);state.step=2;renderBuilder();loadClubs();window.scrollTo({top:0,behavior:'instant'});};});}
async function teamPicker(){
 $('#picker').innerHTML=`<label class="field-label" for="team-league">League</label><select id="team-league">${['nfl-football','mlb-baseball','nba-basketball','nhl-hockey','college-football','college-basketball','mls-soccer'].map(c=>`<option value="${c}" ${c===state.category?'selected':''}>${leagueName(c)}</option>`).join('')}</select><label class="field-label" for="team-search">Find your team</label><div class="search-input standalone">${icon('search')}<input id="team-search" type="search" placeholder="School, team name, or abbreviation" value="${esc(query.get('team')||'')}"></div><p class="field-help">Choose a school or team from Gametime’s directory. Teams that share a nickname stay separate.</p><div id="team-options" class="team-grid">${loadingRows(2)}</div>`;
 state.category=$('#team-league').value;$('#team-league').onchange=e=>{state.category=e.target.value;query.delete('team');teamPicker();};
 const category=state.category;let request=0,timer;
 const draw=async()=>{
  const id=++request,filter=$('#team-search').value.trim(),box=$('#team-options');box.innerHTML=loadingRows(2);
  try{
   let teams=[],directoryUnavailable=false;
   try{teams=await sbPublicRpc('tix_resolve_teams',{p_query:filter,p_category:category,p_limit:100});}catch{directoryUnavailable=true;}
   if(id!==request||category!==state.category||!box.isConnected)return;
   // Preserve the existing pro-team picker while its source directory fills.
   if(!teams?.length&&!category.startsWith('college-')){const old=await sbGet('tix_teams_v?category=eq.'+encodeURIComponent(category)+'&select=team,events&order=team');teams=old.filter(t=>teamMatches(category,t.team,filter)).map(t=>({label:teamName(category,t.team),team:t.team,event_count:t.events}));}
   if(id!==request||category!==state.category||!box.isConnected)return;
   state.teams=teams||[];
   box.innerHTML=state.teams.length?state.teams.map((t,i)=>`<button class="team-option" data-source-team="${i}">${icon('ball')}<span>${esc(t.label)}<small>${Number(t.event_count)||0} listed games · ${t.team_id?'source team confirmed':'schedule match'}</small></span>${icon('arrow')}</button>`).join(''):directoryUnavailable?'<p class="muted">The source team directory is unavailable. College teams need a confirmed school identity; <a href="./index.html?category='+encodeURIComponent(category)+'">choose an individual game</a> or try again shortly.</p>':'<p class="muted">No source team matches yet. Try the full school name or <a href="./index.html?category='+encodeURIComponent(category)+'">choose an individual game</a>.</p>';
   $$('[data-source-team]').forEach(button=>button.onclick=()=>{const t=state.teams[Number(button.dataset.sourceTeam)];state.selected={team:t.team||t.team_id,team_id:t.team_id||null,label:t.label};state.step=2;renderBuilder();loadClubs();});
  }catch{if(id===request&&box.isConnected)box.innerHTML='<p class="muted">The team directory could not load. Try another league or <a href="./index.html">select an individual game</a>.</p>';}
 };
 $('#team-search').oninput=()=>{clearTimeout(timer);timer=setTimeout(draw,250);};draw();
}
function datePicker(){
 $('#picker').innerHTML=`<form id="date-form"><label class="field-label" for="day-out">Which day?</label><input id="day-out" type="date" required min="${todayISO()}" max="${todayISO(new Date(Date.now()+365*86400000))}" value="${esc(state.selected?.date||'')}"><div class="two-fields"><div><label class="field-label" for="day-city">City <span>optional</span></label><input id="day-city" placeholder="e.g. Minneapolis" value="${esc(state.selected?.city||'')}"></div><div><label class="field-label" for="day-state">State or province <span>optional</span></label><input id="day-state" placeholder="e.g. MN" maxlength="2" pattern="[A-Za-z]{2}" value="${esc(state.selected?.state||'')}"></div></div><p class="field-help">Track any event on this date. Add a city or state to keep the search close to your plans.</p><button class="button primary" type="submit">Continue ${icon('arrow')}</button><div id="day-error"></div></form>`;
 $('#date-form').onsubmit=async e=>{e.preventDefault();const b=$('#date-form button');b.disabled=true;const selected={date:$('#day-out').value,city:$('#day-city').value.trim(),state:$('#day-state').value.trim().toUpperCase()};try{let q='tix_events_v?select=event_id&event_date=eq.'+selected.date+'&limit=1';if(selected.city)q+='&city=ilike.'+encodeURIComponent(selected.city);if(selected.state)q+='&state=eq.'+encodeURIComponent(selected.state);const rows=await sbGet(q);if(!rows.length)throw new Error('No events are listed for this date and place. Try a different day or remove the city.');state.selected=selected;state.step=2;renderBuilder();}catch(err){$('#day-error').innerHTML=errorBox(err.message,'');b.disabled=false;}};
}
function teamPriceQuery(){
 const today=new Date(),end=todayISO(new Date(today.getTime()+30*86400000));
 const team=String(state.selected?.team||'').replace(/[^a-z0-9-]/g,'');
 const q=new URLSearchParams({select:'event_id,event_date,min_total,price_checked_at,discovery_status',category:'eq.'+state.category,order:'event_date,event_id',limit:'100'});
 q.append('event_date','gte.'+todayISO(today));q.append('event_date','lte.'+end);
 if(state.homeAway==='any')q.set('or',`(slug.ilike.*-at-${team},slug.ilike.${team}-at-*)`);
 else q.set('slug','ilike.'+(state.homeAway==='home'?`*-at-${team}`:`${team}-at-*`));
 return 'tix_events_v?'+q;
}
function teamPriceSummary(rows,now=Date.now()){
 const checked=rows.filter(e=>Number.isInteger(e.min_total)&&e.min_total>0&&e.price_checked_at&&
   ['ok','metadata_only'].includes(e.discovery_status)&&now-new Date(e.price_checked_at).getTime()<72*3600000);
 const prices=checked.map(e=>e.min_total);
 return {total:rows.length,count:prices.length,low:prices.length?Math.min(...prices):null,
   average:prices.length?Math.round(prices.reduce((sum,p)=>sum+p,0)/prices.length):null};
}
async function loadTeamPriceReference(refreshed=false){
 const box=$('#price-reference');if(!box||state.kind!=='team'||!state.selected?.team)return;
 const selected=state.selected,token=state.priceReferenceToken=(state.priceReferenceToken||0)+1;
 box.innerHTML='<div class="reference-price team-market" role="status">Checking recent game prices…</div>';
 try{
  const rows=selected.team_id?(await sbPublicRpc('tix_search_team_events',{p_team_id:selected.team_id,p_limit:200})).filter(e=>state.homeAway==='any'||state.homeAway==='home'&&e.is_home===true||state.homeAway==='away'&&e.is_home===false):await sbGet(teamPriceQuery());
  if(token!==state.priceReferenceToken||state.selected!==selected||!box.isConnected||state.step!==2)return;
  const prices=teamPriceSummary(rows),games=state.homeAway==='any'?'home and away':state.homeAway;
  box.innerHTML=`<div class="reference-price team-market"><div class="team-market-heading"><strong>Current get-in prices</strong><span>${selected.team_id?'Next year':'Next 30 days'} · ${esc(games)} games</span></div>${prices.count?`<div class="team-market-values"><div><span>Lowest</span><strong>${money(prices.low)}</strong></div><div><span>Average</span><strong>${money(prices.average)}</strong></div></div>`:'<p>No recent get-in prices for these games yet.</p>'}<p>${prices.count} of ${prices.total} upcoming ${prices.total===1?'game':'games'} checked recently. Provider get-in per ticket; tax, exact quantity and section are unconfirmed.</p>${selected.team_id?schedulePriceChart(rows,{label:selected.label||'Team schedule'}):''}</div>`;
  // Price the unchecked games now (no tracking), then redraw once with them.
  if(!IS_DEV&&!refreshed&&prices.count<prices.total){
   const ids=priceCheckCandidates(rows);
   if(ids.length)captureEventPrices(ids).then(results=>{
    if(results.some(r=>Number.isInteger(r.min_total))&&token===state.priceReferenceToken&&state.selected===selected&&box.isConnected)loadTeamPriceReference(true);
   }).catch(()=>{});
  }
 }catch{
  if(token===state.priceReferenceToken&&box.isConnected)box.innerHTML='<div class="reference-price team-market" role="status">Recent team prices could not load. Your alert settings are still available.</div>';
 }
}
function priceStep(){
 const needsNumber=!state.destinationConfigured;
 $('#builder-panel').innerHTML=`<button class="text-button back-button" id="back-pick">${icon('arrow')} Change event</button><div class="panel-heading"><h2>Make it your kind of ticket.</h2><p>${esc(selectionTitle())}</p></div><form id="price-form">${state.kind==='team'?`<fieldset><legend>Which games?</legend><div class="segmented">${[['home','Home games'],['away','Away games'],['any','Home & away']].map(([v,l])=>`<label class="radio-choice"><input type="radio" name="home-away" value="${v}" ${state.homeAway===v?'checked':''}><span>${l}</span></label>`).join('')}</div></fieldset>`:''}<div class="price-fields"><div><label class="field-label" for="qty">Tickets together</label><div class="quantity-control"><button type="button" id="qty-minus" aria-label="One fewer ticket">−</button><input id="qty" type="number" min="1" max="8" required value="${state.qty}" aria-describedby="qty-help"><button type="button" id="qty-plus" aria-label="One more ticket">+</button></div><p class="field-help" id="qty-help">Only listings that sell your exact quantity.</p></div><div><label class="field-label" for="budget-mode">Budget style</label><select id="budget-mode"><option value="per" ${state.budgetMode==='per'?'selected':''}>Per ticket</option><option value="total" ${state.budgetMode==='total'?'selected':''}>Total for all tickets</option></select><label class="field-label" for="target">Maximum ${state.budgetMode==='total'?'total':'per ticket'}</label><div class="currency-input"><span>$</span><input type="number" id="target" min="1" max="400000" step="0.01" inputmode="decimal" required placeholder="150" value="${esc(state.budgetMode==='total'?(Number(state.threshold)*state.qty).toFixed(2):state.threshold)}" aria-describedby="target-help"></div><p class="field-help" id="target-help">Fees included. Alert at this price or less.</p></div></div><div id="price-reference" aria-live="polite"></div><fieldset><legend>Where do you want to sit?</legend><div class="seat-choices"><label class="radio-card"><input type="radio" name="seat-type" value="any" ${!state.clubLevel?'checked':''}><span><strong>Any section</strong><small>The best match anywhere in the venue.</small></span></label><label class="radio-card"><input type="radio" name="seat-type" value="club" ${state.clubLevel?'checked':''}><span><strong>Club seats only</strong><small>Match sections listed as a club.</small></span></label></div><div id="club-options"></div></fieldset><fieldset><legend>How often should we alert you?</legend><label class="field-label" for="alert-frequency">Notification frequency</label><select id="alert-frequency">${[['first_event','First qualifying match per game'],['drop','A meaningful further price drop'],['periodic','Periodic updates — at most hourly'],...(state.alertMode==='legacy'?[['legacy','Existing: first match per section']]:[])].map(([v,l])=>`<option value="${v}" ${(state.alertMode||'first_event')===v?'selected':''}>${l}</option>`).join('')}</select><p class="field-help">Price-drop alerts require at least $5 and 5% below your lowest notified price for that game, at most hourly. All notifications must still meet your target.</p></fieldset><fieldset class="destination-card"><legend>Delivery</legend><p class="destination-intro">Email goes to your sign-in address. Add email-to-text if you also want a phone alert.</p><label class="delivery-choice"><input type="checkbox" id="email-enabled" ${state.emailEnabled?'checked':''}><span><strong>Email me</strong><small>To your sign-in email address</small></span></label><label class="delivery-choice"><input type="checkbox" id="sms-enabled" ${state.smsEnabled?'checked':''}><span><strong>Also text me</strong><small>Via your carrier’s email-to-text gateway</small></span></label><div id="sms-fields" ${state.smsEnabled?'':'hidden'}><div class="two-fields"><div><label class="field-label" for="carrier">Cell provider</label><select id="carrier" ${state.smsEnabled?'required':''} aria-describedby="carrier-help"><option value="">Choose your provider</option><option value="tmobile" ${state.provider==='tmobile'?'selected':''}>T-Mobile or Metro</option><option value="verizon" ${state.provider==='verizon'?'selected':''}>Verizon or Visible</option><option value="uscellular" ${state.provider==='uscellular'?'selected':''}>UScellular</option><option disabled>AT&amp;T or Cricket — gateway retired</option></select></div><div><label class="field-label" for="phone">Cell number ${state.destinationConfigured?'<span>leave blank to keep saved number</span>':''}</label><input id="phone" type="tel" inputmode="tel" autocomplete="tel-national" ${state.smsEnabled&&needsNumber?'required':''} placeholder="(612) 555-0148" value="${esc(state.phone)}" aria-describedby="phone-help"></div></div><p class="field-help" id="phone-help">Your full number is stored in a private delivery table and never shown on the public alert board.</p><p class="carrier-note" id="carrier-help">Carrier gateways can delay or filter texts. Verizon is retiring its gateway by March 2027; AT&amp;T already ended support.</p></div><div id="destination-error"></div></fieldset><label class="field-label" for="alert-name">Alert name <span>optional</span></label><input id="alert-name" maxlength="140" placeholder="${esc(selectionTitle())}" value="${esc(state.label||'')}"><div class="form-bottom"><p>${icon('shield')} You decide when to buy.</p><button class="button primary" type="submit">Review alert ${icon('arrow')}</button></div></form>`;
 $('#carrier option[value="uscellular"]').insertAdjacentHTML('beforebegin',`<option value="xfinity" ${state.provider==='xfinity'?'selected':''}>Xfinity Mobile</option>`);
 const sync=()=>{const previousQty=state.qty;state.qty=Number($('#qty').value)||1;if(previousQty!==state.qty){if($('#price-reference'))$('#price-reference').innerHTML='<p class="field-help">Updating prices for '+state.qty+' tickets together.</p>';clearTimeout(state.spreadTimer);state.spreadTimer=setTimeout(loadPriceSpread,200);}state.threshold=state.budgetMode==='total'?(perTicketTargetCents($('#target').value,state.qty,'total')/100).toFixed(2):$('#target').value;state.label=$('#alert-name').value;state.phone=$('#phone').value;state.provider=$('#carrier').value;$('#builder-summary').innerHTML=summary();$('#qty-minus').disabled=state.qty<=1;$('#qty-plus').disabled=state.qty>=8;};
 $('#qty-minus').onclick=()=>{$('#qty').value=Math.max(1,state.qty-1);sync();};$('#qty-plus').onclick=()=>{$('#qty').value=Math.min(8,state.qty+1);sync();};$('#qty').oninput=()=>{sync();clearTimeout(state.spreadTimer);state.spreadTimer=setTimeout(loadPriceSpread,200);};$('#target').oninput=sync;$('#budget-mode').onchange=e=>{state.budgetMode=e.target.value;$('#target').value=state.budgetMode==='total'?(Number(state.threshold)*state.qty).toFixed(2):state.threshold;document.querySelector('label[for="target"]').textContent='Maximum '+(state.budgetMode==='total'?'total':'per ticket');sync();};$('#alert-name').oninput=sync;$('#phone').oninput=sync;$('#phone').onblur=()=>{const d=normalizeUSPhone($('#phone').value);if(d)$('#phone').value=formatPhone(d);sync();};$('#carrier').onchange=sync;$('#email-enabled').onchange=e=>{state.emailEnabled=e.target.checked;sync();};$('#sms-enabled').onchange=e=>{state.smsEnabled=e.target.checked;$('#sms-fields').hidden=!state.smsEnabled;$('#carrier').required=state.smsEnabled;$('#phone').required=state.smsEnabled&&!state.destinationConfigured;sync();};
 $$('[name="seat-type"]').forEach(r=>r.onchange=()=>{state.clubLevel=r.value==='club';if(!state.clubLevel)state.clubs=[];renderClubOptions();});
 $('#alert-frequency').onchange=e=>{state.alertMode=e.target.value;state.alertStyle=['drop','periodic'].includes(state.alertMode)?'repeat':'first';};
 $$('[name="home-away"]').forEach(r=>r.onchange=()=>{state.homeAway=r.value;state.clubs=[];loadClubs();loadTeamPriceReference();});
 $('#back-pick').onclick=()=>{sync();state.step=1;renderBuilder();};
 $('#price-form').onsubmit=e=>{e.preventDefault();sync();const digits=normalizeUSPhone(state.phone);const changedCarrier=state.destinationConfigured&&state.provider!==state.existingProvider;if(!state.emailEnabled&&!state.smsEnabled){$('#destination-error').innerHTML=errorBox('Choose email or text delivery.','');return;}if(state.smsEnabled&&((!digits&&!state.destinationConfigured)||(state.phone&&!digits)||(changedCarrier&&!digits))){const message=changedCarrier?'Enter your number again when you change carriers.':'Enter a valid 10-digit U.S. cell number.';$('#destination-error').innerHTML=errorBox(message,'');$('#phone').focus();return;}if(digits)state.phone=formatPhone(digits);if(!Number.isInteger(state.qty)||state.qty<1||state.qty>8)return;state.step=3;renderBuilder();window.scrollTo({top:0,behavior:'instant'});};renderClubOptions();sync();loadPriceSpread();loadTeamPriceReference();
 if(state.kind==='event')$('#price-reference').innerHTML='<p class="field-help">Updating prices for '+state.qty+' tickets together.</p>';
}
async function loadPriceSpread(){
 const box=$('#price-reference');if(!box||state.kind!=='event'||!state.selected?.event_id)return;
 const event=state.selected,qty=state.qty;
 try{
  const rows=await sbGet('tix_event_market?event_id=eq.'+encodeURIComponent(event.event_id)+'&select=by_qty,checked_at,coverage&limit=1');
  if(event!==state.selected||qty!==state.qty||box!==$('#price-reference'))return;
  const sample=rows[0];state.spread=ageMinutes(sample?.checked_at)<15?sample?.by_qty?.[String(qty)]||null:null;
  box.innerHTML=`<div class="reference-price spread-price" role="status">${icon('chart')}<div>${marketQuantitySummary(sample,qty,event.discovery_status==='metadata_only')}</div></div>`;
 }catch{if(event===state.selected&&qty===state.qty&&box===$('#price-reference'))box.innerHTML='<p class="field-help">Prices for '+qty+' tickets together could not load. Please try again.</p>';}
}
async function loadClubs(){
 const selection=state.selected;state.clubOptions=[];
 try{let venue=selection?.venue_slug;if(state.kind==='team'&&state.homeAway==='home'){const rs=selection.team_id?(await sbPublicRpc('tix_search_team_events',{p_team_id:selection.team_id,p_limit:200})).filter(e=>e.is_home===true):await sbGet('tix_events_v?category=eq.'+encodeURIComponent(state.category)+'&slug=ilike.'+encodeURIComponent('*-at-'+state.selected.team)+'&event_date=gte.'+todayISO()+'&select=venue_slug&limit=100');const counts={};rs.forEach(r=>{if(r.venue_slug)counts[r.venue_slug]=(counts[r.venue_slug]||0)+1;});venue=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];}if(state.kind==='team'&&state.homeAway!=='home')venue=null;
 if(venue){const [r]=await sbGet('tix_venue_clubs?venue_slug=eq.'+encodeURIComponent(venue)+'&select=clubs');if(state.selected!==selection)return;state.clubOptions=(r?.clubs||[]).filter(c=>c.group!=='__market__');}
 }catch{}if(state.step===2&&$('#club-options'))renderClubOptions();
}
function renderClubOptions(){const box=$('#club-options');if(!box)return;if(!state.clubLevel){box.innerHTML='';return;}box.innerHTML=state.clubOptions.length?`<label class="field-label" for="club-choice">Club section</label><select id="club-choice"><option value="">Any club section</option>${state.clubOptions.map(c=>`<option value="${esc(c.group)}" ${state.clubs.includes(c.group)?'selected':''}>${esc(c.group)}</option>`).join('')}</select><p class="field-help">Club names come from actual listings. Availability varies by event.</p>`:`<div class="notice subtle">${icon('info')}<p>We’ll match any section labeled “club” by Gametime. ${state.kind==='team'&&state.homeAway!=='home'?'Club names vary across away venues.':'Specific club names will appear once a venue has been checked.'}</p></div>`;if($('#club-choice'))$('#club-choice').onchange=e=>state.clubs=e.target.value?[e.target.value]:[];}
function makeWatch(){const match={...(state.edit?.match||{}),club_level:state.clubLevel};match.notification_mode=state.alertMode||state.edit?.match?.notification_mode||'first_event';if(state.edit?.match?.min_deal)match.min_deal=state.edit.match.min_deal;if(state.kind==='event'){match.event_ids=[state.selected.event_id];match.event_date=state.selected.event_date;}if(state.kind==='team'){Object.assign(match,{slug:state.selected.team,category:state.category,home_away:state.homeAway,...(state.selected.team_id?{team_id:state.selected.team_id,team_label:state.selected.label}:{})});}if(state.kind==='date'){Object.assign(match,{date:state.selected.date});for(const k of ['city','state','venue_slug'])if(state.selected[k])match[k]=state.selected[k];}return {kind:state.kind,label:state.label?.trim()||selectionTitle(),match,clubs:state.clubLevel?state.clubs:[],qty:state.qty,threshold_cents:Math.round(Number(state.threshold)*100),alert_style:state.alertStyle,active:state.edit?state.edit.active:true,email_enabled:state.emailEnabled,sms_enabled:state.smsEnabled};}
function reviewStep(){
 const w=makeWatch();const destination=state.phone?`${carrierName(state.provider)} · ${formatPhone(state.phone)}`:`${carrierName(state.provider)} · saved number`;$('#builder-panel').innerHTML=`<button class="text-button back-button" id="back-price">${icon('arrow')} Change preferences</button><div class="panel-heading"><h2>Looks like a game plan.</h2><p>Check the details, then let us keep watch.</p></div><dl class="review-list"><div><dt>Watching</dt><dd>${esc(selectionTitle())}${state.kind==='team'?'<small>'+esc(state.homeAway==='any'?'Home and away games':cap(state.homeAway)+' games')+'</small>':''}</dd></div><div><dt>Tickets</dt><dd>${state.qty} ${state.qty===1?'ticket':'tickets together'}</dd></div><div><dt>Alert me at</dt><dd>${money(w.threshold_cents)} or less per ticket<small>${money(w.threshold_cents*state.qty)} total ticket budget, fees included</small></dd></div><div><dt>Sections</dt><dd>${state.clubLevel?esc(state.clubs.join(', ')||'Any club section'):'Any section'}</dd></div><div><dt>Alert frequency</dt><dd>${alertFrequencyLabel(w)}</dd></div><div><dt>Delivery</dt><dd>${state.emailEnabled?'Sign-in email':''}${state.emailEnabled&&state.smsEnabled?' + ':''}${state.smsEnabled?esc(destination):''}</dd></div></dl><div class="notice subtle">${icon('bell')}<div><strong>Your confirmation is ready</strong><p>After you save, we’ll queue: “We’re on the lookout for tickets to ${esc(selectionTitle())} at ${money(w.threshold_cents)} or less. We’ll alert you when the price hits.”</p></div></div>${state.kind==='event'&&state.selected?.discovery_status==='metadata_only'?'<div class="notice subtle" role="status"><strong>Listing details are currently unavailable</strong><p>This alert will not send a price notification until an exact seller-supported lot can be verified.</p></div>':''}<p class="privacy-note">Your alert and any saved phone number are private to your signed-in account.</p><button class="button primary full" id="save-alert">${icon('bell')}${state.edit?'Save changes':'Create alert'}</button><div id="save-error"></div>`;
 $('#back-price').onclick=()=>{state.step=2;renderBuilder();};$('#save-alert').onclick=saveAlert;
}
async function saveAlert(){
 const b=$('#save-alert');if(b.disabled)return;b.disabled=true;b.textContent='Saving your alert…';$('#save-error').innerHTML='';
 try{const w=makeWatch();
 await sbRpc('tix_save_alert',{p_watch:w,p_watch_id:state.edit?.id||null,
   p_phone:state.phone||null,p_provider:state.provider||null,p_confirmation_label:selectionTitle()});
 state.saved=true;
 let teamScheduleStatus='';
 if(w.kind==='team'&&w.match.team_id){try{const priority=await sbRpc('tix_prioritize_search',{p_query:w.match.team_label||w.label,p_category:w.match.category||null,p_team_id:w.match.team_id,p_event_ids:[]});teamScheduleStatus=priority?.state==='queued'?'This team’s schedule is prioritized for the next available check.':priority?.state==='rate_limited'?'The schedule refresh request limit was reached. Your saved alert remains active.':'The team schedule was not newly queued. Existing scheduled checks remain in place.';}catch{teamScheduleStatus='Your alert is saved, but its team schedule could not be prioritized. Search this team and use Refresh these results to try again.';}}
 main.innerHTML=`<div class="container success-page"><div class="success-symbol">${icon('check')}</div><h1>${state.edit?'Your alert is updated.':'You’re on the list.'}</h1><p>${esc(w.label)}</p><div class="success-summary"><strong>${money(w.threshold_cents)} or less</strong><span>per ticket · ${w.qty} ${w.qty===1?'ticket':'tickets together'} · fees included</span></div><p class="muted">${!w.active?'This alert is still paused. Resume it from My alerts when you’re ready.':'Your confirmation is queued. We’ll keep checking and '+(state.emailEnabled?'email your sign-in address':'send an email-to-text message')+(state.emailEnabled&&state.smsEnabled?' and send an email-to-text message':'')+' when a matching price qualifies.'}</p>${teamScheduleStatus?`<p class="muted" role="status">${esc(teamScheduleStatus)}</p>`:''}<div class="success-actions"><a class="button primary" href="./watches.html">See my alerts ${icon('arrow')}</a><a class="button secondary" href="./new.html">Create another alert</a></div><a class="text-link" href="./notifications.html">Check notification status</a></div>`;window.scrollTo({top:0,behavior:'instant'});
 }catch(e){$('#save-error').innerHTML=errorBox(e.message,'');b.disabled=false;b.textContent=state.edit?'Save changes':'Create alert';}
}
async function activity(){
 layout('Every check. Every heads-up.','Review ticket movement and delivery results.',`<div class="activity-tabs segmented"><button data-activity="alerts" aria-pressed="true">Text alerts</button><button data-activity="prices" aria-pressed="false">Price history</button><button data-activity="past" aria-pressed="false">Past alerts</button></div><div id="activity-controls"></div><div id="activity-content">${loadingRows()}</div><button id="activity-more" class="button secondary" hidden>Show more</button>`,`<button id="refresh-activity" class="button secondary">${icon('refresh')} Refresh</button>`);
 let offset=0, selected=query.get('watch')||'',range='7d',historyGroup='';
 if(selected)state.activityKind='prices';
 const draw=async(append=false)=>{
   const box=$('#activity-content'),controls=$('#activity-controls'),more=$('#activity-more');
   if(!append){box.innerHTML=loadingRows();offset=0;}more.hidden=true;
   try{
     const ws=await sbGet('tix_watches?select=*&order=created_at.desc');
     const names=Object.fromEntries(ws.map(w=>[w.id,w.label]));
     if(state.activityKind==='past'){
       const past=ws.filter(w=>w.match?.archived_at||w.purchased_at);
       controls.innerHTML='';box.innerHTML=past.length?`<div class="activity-list">${past.map(w=>`<article class="past-row"><h3>${esc(w.label)}</h3><p>${w.purchased_at?'Purchased':'Archived'} ${whenShort(w.purchased_at||w.match.archived_at)}</p><a href="./ledger.html?watch=${encodeURIComponent(w.id)}">Price history</a></article>`).join('')}</div>`:'<div class="empty-state"><h2>No past alerts.</h2></div>';return;
     }
     if(state.activityKind==='prices'){
       if(!selected||!ws.some(w=>w.id===selected))selected=ws[0]?.id||'';
       controls.innerHTML=`<div class="activity-filter"><label>Alert<select id="activity-watch">${ws.map(w=>`<option value="${esc(w.id)}" ${selected===w.id?'selected':''}>${esc(w.label)}</option>`).join('')}</select></label><label>Range<select id="activity-range">${[['24h','24H'],['7d','7D'],['30d','30D'],['all','All']].map(([v,l])=>`<option value="${v}" ${range===v?'selected':''}>${l}</option>`).join('')}</select></label></div>`;
       if($('#activity-watch'))$('#activity-watch').onchange=e=>{selected=e.target.value;draw();};
       if($('#activity-range'))$('#activity-range').onchange=e=>{range=e.target.value;draw();};
       if(!selected){box.innerHTML='<div class="empty-state"><h2>No price history yet.</h2></div>';return;}
       const rows=await readAlertHistory(selected,range);
       if(!rows.length){box.innerHTML='<div class="empty-state"><h2>No prices in this range.</h2></div>';return;}
       rows.sort((a,b)=>new Date(a.checked_at)-new Date(b.checked_at));
       const series=comparableHistoryGroups(rows);
       if(!series.some(g=>g.key===historyGroup))historyGroup=series.at(-1)?.key||'';
       controls.insertAdjacentHTML('beforeend',`<label class="history-series-label">Compare the same event, quantity, section and basis<select id="history-series">${series.map(g=>`<option value="${esc(g.key)}" ${g.key===historyGroup?'selected':''}>${esc(g.label)}</option>`).join('')}</select></label>`);
       $('#history-series').onchange=e=>{historyGroup=e.target.value;draw();};
       const comparable=series.find(g=>g.key===historyGroup)?.samples||[],latest=comparable.at(-1);
       if(!latest){box.innerHTML='<p>No observations with a confirmed price basis are available in this range. Prices with an unknown basis cannot be compared.</p>';return;}
       const vals=comparable.map(r=>r.price_cents);
       const watch=ws.find(w=>w.id===selected);
       const markers=await sbGet(`tix_alerts?watch_id=eq.${encodeURIComponent(selected)}&criteria_version=eq.${watch.criteria_version}&status=eq.sent&select=sent_at&order=sent_at.desc&limit=100`);
       box.innerHTML=`<section class="history-panel"><div class="history-head"><div><h2>${esc(names[selected])}</h2><p>${esc(priceProof(rows,latest)||`${rows.length} observations`)}</p></div><strong>${money(latest.price_cents)}<small>${knownPriceBasis(latest.basis)?' last recorded per ticket':' recorded price · basis unknown'}</small></strong></div>${sparkline(comparable,true,watch.threshold_cents,markers)}<div class="chart-range"><span>${money(Math.min(...vals))} low</span><span>${comparable.length} time buckets</span><span>${money(Math.max(...vals))} high</span></div><p class="field-help" id="chart-readout" role="status">Each point uses the selected event, quantity, section and price basis. Tap or focus a point for its timestamp and price. Orange dots mark notifications.</p></section>`;
       box.querySelectorAll('.chart-point').forEach(point=>{const show=()=>{$('#chart-readout').textContent=point.querySelector('title').textContent;};point.onclick=show;point.onfocus=show;});return;
     }
     controls.innerHTML='';
     const rows=await sbGet(`tix_alerts?select=*&order=sent_at.desc,id.desc&limit=51&offset=${offset}`);
     const visible=rows.slice(0,50);
     const markup=visible.map(r=>{const url=safeUrl(r.listing_url);return `<article class="activity-row"><span class="activity-icon ${r.status==='failed'?'failed':''}">${icon('bell')}</span><div><h3>${esc(names[r.watch_id]||'Past alert')}</h3><p>${esc(r.club)} · ${r.qty} tickets · ${r.channel==='email'?'Email':'Carrier text'} · ${whenShort(r.sent_at)}</p><span class="badge ${r.status==='failed'?'amber':'green'}">${r.status==='failed'?'Send failed — will retry':'Accepted for delivery'}</span></div><div class="activity-price"><strong>${money(r.price_cents)}</strong>${url?`<a href="${esc(url)}" target="_blank" rel="noopener">View listing</a>`:''}</div></article>`;}).join('');
     if(append)box.querySelector('.activity-list')?.insertAdjacentHTML('beforeend',markup);
     else box.innerHTML=visible.length?`<div class="activity-list">${markup}</div>`:'<div class="empty-state"><h2>No alerts sent yet.</h2></div>';
     offset+=visible.length;more.hidden=rows.length<=50;
   }catch(e){box.innerHTML=errorBox(e.message);if($('#retry'))$('#retry').onclick=()=>draw();}
 };
 $$('[data-activity]').forEach(b=>b.onclick=()=>{state.activityKind=b.dataset.activity;$$('[data-activity]').forEach(x=>x.setAttribute('aria-pressed',x===b));draw();});
 $('#activity-more').onclick=()=>draw(true);$('#refresh-activity').onclick=()=>draw();
 $$('[data-activity]').forEach(x=>x.setAttribute('aria-pressed',x.dataset.activity===state.activityKind));draw();
}
async function notifications(){
 layout('The heads-up that matters.','Your alert is only useful if you know where it’s going.',`<div class="notification-layout"><section class="settings-panel"><div class="settings-title"><span class="setting-icon">${icon('bell')}</span><div><h2>Email and text alerts</h2><p>Email to your sign-in address, with optional carrier text</p></div></div><div id="delivery-health">${loadingRows(1)}</div><div class="delivery-test"><label for="test-watch">Test a saved alert’s delivery</label><select id="test-watch"></select><button class="button secondary" id="test-delivery">Send delivery test</button><p id="test-result" role="status">A test uses the selected alert’s enabled channels. It is queued for the next collector run.</p></div><div class="settings-divider"></div><h3>How are alerts delivered?</h3><p>Ticketline emails your verified sign-in address by default. You may also enable a carrier email-to-text copy for each alert. Direct SMS is not configured.</p><h3>When will I get an alert?</h3><p>We queue a confirmation when you save an alert. After that, we email and optionally text when a checked listing has your exact number of tickets and costs at or below your per-ticket limit, fees included.</p><dl class="schedule-list"><div><dt>All active alerts</dt><dd>Target: every 15 minutes</dd></div></dl><p class="field-help">Checks are scheduled, not instant. Busy periods, the ticket provider, and the carrier can delay an alert. Choose one match per game, further price drops, or hourly updates. Existing per-section alerts retain their settings until you change them.</p><a class="button primary" href="./watches.html">Manage my alerts ${icon('arrow')}</a></section><aside><div class="settings-panel"><h3>Not seeing your alert?</h3><ol class="troubleshoot"><li>Check your sign-in inbox and spam folder. If text is enabled, check the carrier and number in the alert.</li><li>Make sure your alert is watching, not paused.</li><li>Check Activity for a matching price and the send result.</li><li>Check your phone’s spam or blocked messages.</li></ol><p>“Accepted for delivery” means the mail server accepted the message. It does not confirm that the carrier delivered it to your phone.</p><a class="text-link" href="./ledger.html">View alert activity ${icon('arrow')}</a></div><div class="aside-note">${icon('shield')}<p>Full phone numbers stay in a private delivery table. They are never returned to the public site or shown on alert cards. <a class="text-link" href="./privacy.html">Privacy policy</a></p></div><div class="settings-panel account-panel"><h3>Delete your account</h3><p>Permanently removes your sign-in, every alert, its price history, delivery log and any saved phone number. This cannot be undone.</p><button class="button secondary" id="delete-account">Delete my account and data</button></div></aside></div>`,`<button class="button secondary" id="refresh-status">${icon('refresh')} Refresh status</button>`);
 const testButton=$('#test-delivery');testButton.disabled=true;
 try{const testWatches=await sbGet('tix_watches?active=eq.true&select=id,label&order=created_at.desc');$('#test-watch').innerHTML=testWatches.map(w=>`<option value="${esc(w.id)}">${esc(w.label)}</option>`).join('');testButton.disabled=!testWatches.length;if(!testWatches.length)$('#test-result').textContent='Create or resume an alert before testing delivery.';}catch{$('#test-result').textContent='Could not load alerts for testing.';}
 testButton.onclick=async()=>{testButton.disabled=true;try{await sbRpc('tix_request_delivery_test',{p_watch_id:$('#test-watch').value});$('#test-result').textContent='Delivery test queued for the next collector run. Check your inbox or phone to confirm receipt.';}catch(e){$('#test-result').textContent=e.message;}finally{testButton.disabled=false;}};
 $('#refresh-status').onclick=notifications;
 if(globalThis.TicketlineNeonAuth){$('#delete-account').disabled=true;$('#delete-account').textContent='Account removal is unavailable during recovery';}
 $('#delete-account').onclick=()=>{
   showDialog('Delete your account?',`<p>This permanently deletes your sign-in, all alerts, price history, delivery history and saved phone numbers.</p><label class="field-label" for="delete-confirm">Type DELETE to confirm</label><input id="delete-confirm" autocomplete="off" spellcheck="false"><div class="dialog-actions"><button class="button secondary" id="delete-cancel">Keep my account</button><button class="button danger" id="delete-go" disabled title="Type DELETE to enable">Delete everything</button></div><div id="delete-account-error"></div>`);
   $('#delete-cancel').onclick=()=>$('#dialog').close();
   $('#delete-confirm').oninput=e=>{$('#delete-go').disabled=e.target.value.trim()!=='DELETE';};
   $('#delete-go').onclick=async e=>{e.target.disabled=true;e.target.textContent='Deleting…';
     try{await sbRpc('tix_delete_my_account',{});session=null;storeSession(null);location.replace('./index.html');}
     catch(err){$('#delete-account-error').innerHTML=errorBox(err.message.replace('Your alert was not saved.','Your account was not deleted.'),'');e.target.disabled=false;e.target.textContent='Delete everything';}};
 };const h=await getHealth();const c=h.collector_health,n=h.notification_health;const pagesChecked=(c?.checked_events||0)+(c?.discovery_checked||0),pagesFailed=(c?.failed_events||0)+(c?.discovery_failed||0),pagesWithoutLots=(c?.provider_incomplete||0)+(c?.discovery_metadata_only||0);
 $('#delivery-health').innerHTML=`<div class="delivery-state"><span class="status-dot ${c?.email_configured?'green':'amber'}"></span><div><strong>${c?.email_configured?'Email delivery is connected':'Delivery configuration not yet verified'}</strong><p>${c?.email_configured?'Sign-in email is the default; carrier text can be added per alert.':'The next collector run will report its configuration here.'}</p></div></div><div class="delivery-state"><span class="status-dot ${n?.status==='accepted'?'green':'amber'}"></span><div><strong>${n?n.status==='accepted'?'Last send accepted':'Last send failed':'No delivery attempt recorded'}</strong><p>${n?`${ago(n.checked_at)}${n.channel?' · '+esc(n.channel):''}${n.test?' · Test message':''}. ${n.status==='accepted'?n.channel==='email'?'Check your inbox to confirm receipt.':'Check your phone to confirm receipt.':'The collector will retry qualifying alerts on a later check.'}`:'A confirmation or qualifying ticket alert will show a result here.'}</p></div></div><div class="delivery-state"><span class="status-dot ${c&&ageMinutes(c.checked_at)<35&&c.status==='ok'?'green':'amber'}"></span><div><strong>${c?ageMinutes(c.checked_at)>35?'Collector check is overdue':c.status==='error'?'Collector needs attention':c.status==='degraded'?'Listing data unavailable on some checks':'Collector checked '+ago(c.checked_at).toLowerCase():'Waiting for collector status'}</strong><p>${c?`${pagesChecked} event pages checked on the last run${pagesFailed?', '+pagesFailed+' could not be checked':''}${pagesWithoutLots?', '+pagesWithoutLots+' had no listing details':''}.`:'Status will appear after the first updated collector run.'}</p></div></div>`;
}
async function eventDetail(autoRefresh=true){
 const id=query.get('event');
 if(!id){layout('Choose an event.','Find a game or show to review.',`<a class="button primary" href="./index.html">Find events</a>`);return;}
 layout('Checking this event.','Getting the latest recorded market details.',loadingRows());
 try{
   const [event]=await sbGet(`tix_events_v?event_id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
   if(!event)throw new Error('This event is not in the current catalog.');
   const [venueRows,watchRows,changes]=await Promise.all([
     sbGet(`tix_event_market?event_id=eq.${encodeURIComponent(id)}&select=by_qty,groups,listing_count,checked_at,coverage&limit=1`),
     session?sbGet('tix_watches?select=*&order=created_at.desc'):Promise.resolve([]),
     session?sbGet(`tix_event_changes?event_id=eq.${encodeURIComponent(id)}&select=field,old_value,new_value,detected_at&order=detected_at.desc&limit=10`):Promise.resolve([])
   ]);
   const venue=venueRows[0],watches=watchRows.filter(w=>!w.match?.archived_at&&w.match?.event_ids?.includes(id));
   const market=venue?.by_qty||{},groups=venue?.groups||[];
   const stale=ageMinutes(event.price_checked_at)>120;
   const alertLink=watches.length?location.origin+location.pathname.replace(/event\.html$/,'ledger.html')+'?watch='+encodeURIComponent(watches[0].id):location.origin+location.pathname.replace(/event\.html$/,'new.html')+'?event='+encodeURIComponent(id);
   const gametime=safeUrl(event.url);
   const renderQty=()=>{
     const qty=Number($('#detail-qty').value);
     $('#detail-quantity').innerHTML=marketQuantitySummary(venue,qty,event.discovery_status==='metadata_only');
   };
   layout(esc(event.name),`${esc(event.venue||cap(event.venue_slug)||'Venue to be confirmed')} · ${esc([event.city,event.state].filter(Boolean).join(', '))}`,
     `<div class="event-detail"><section class="settings-panel"><p class="event-date-line">${esc(whenShort(event.event_date))}${event.datetime_local?' · '+esc(event.datetime_local.slice(11,16))+' venue local time':''}</p>${changes.length?`<div class="notice error" role="status"><strong>Event details changed</strong><p>${changes.map(c=>`${esc(c.field.replace('_',' '))}: ${esc(c.old_value||'unknown')} → ${esc(c.new_value||'unknown')}`).join('<br>')}</p></div>`:''}<div class="detail-prices"><div><small>Get-in price</small><strong>${event.min_total?money(event.min_total):'—'}</strong><span>${event.price_checked_at?`${stale?'Last recorded':'Checked'} ${ago(event.price_checked_at)}`:'Not checked yet'}</span></div><div><label class="field-label" for="detail-qty">Tickets together</label><select id="detail-qty">${Array.from({length:8},(_,i)=>`<option value="${i+1}" ${(watches[0]?.qty||2)===i+1?'selected':''}>${i+1}</option>`).join('')}</select><div id="detail-quantity"></div></div></div>${venue?`<p class="field-help">${event.discovery_status==='metadata_only'?'Provider get-in price checked; seller lot details were unavailable.':`${venue.listing_count} marketplace listings checked ${ago(venue.checked_at)}.`} Prices and availability can change at checkout.</p>`:''}<div class="detail-actions"><a class="button primary" href="./new.html?event=${encodeURIComponent(id)}">${icon('bell')} Create alert</a>${gametime?`<a class="button secondary" href="${esc(gametime)}" target="_blank" rel="noopener">View Gametime</a>`:''}</div>${marketLinks(event.name)}<div class="detail-actions"><button id="refresh-history" class="button secondary">Refresh price now</button></div><p id="capture-status" role="status"></p></section><aside class="settings-panel"><h2>Seat areas</h2>${groups.length?`<ul class="seat-breakdown">${groups.map(g=>`<li><span>${esc(g.group)}</span><strong>${money(g.cheapest)}</strong><small>${g.listings} listings</small></li>`).join('')}</ul>`:'<p>No section breakdown has been recorded yet.</p>'}<h2>Your alerts</h2>${watches.length?`<ul>${watches.map(w=>`<li><a href="./new.html?edit=${encodeURIComponent(w.id)}">${esc(w.label)} · ${money(w.threshold_cents)} target</a></li>`).join('')}</ul>`:'<p>Sign in and create an alert to track this event.</p>'}<h2>Add to calendar</h2><p>Calendar entries use the event date; confirm the local start time with the venue.</p><div class="detail-actions"><button class="button secondary" id="download-ics">Apple / ICS</button><a class="button secondary" id="google-calendar" target="_blank" rel="noopener">Google Calendar</a></div></aside></div><section class="settings-panel"><h2>Price history</h2><label for="history-basis">Compare the same price basis</label><select id="history-basis"><option value="getin">Get-in price · quantity and tax unconfirmed</option><option value="fees_included_tax_reported">Selected quantity · tax reported</option><option value="fees_included_tax_unknown">Selected quantity · tax unknown</option></select><div class="history-filters"><label for="history-section">Section<select id="history-section"><option value="">Any section · lowest comparable lot</option>${groups.map(g=>`<option value="${esc(g.group)}">${esc(g.group)}</option>`).join('')}</select></label><label for="history-range">Time range<select id="history-range"><option value="7d">Last 7 days</option><option value="24h">Last 24 hours</option><option value="30d">Last 30 days</option><option value="all">All recorded history</option></select></label></div><div id="event-history"></div><h2>Recorded listings</h2><p>Exact seller lot sizes and seat details when supplied. DOM-only results may have no seat numbers.</p><div id="event-listings"></div><button class="button secondary" id="more-listings" hidden>More listings</button></section>`);
   let listingOffset=0,recordedLoad=0;
   const loadRecorded=async(append=false)=>{
    const loadId=++recordedLoad;
    const qty=Number($('#detail-qty').value),basis=$('#history-basis').value;
    const historyQty=basis==='getin'?0:qty;
    if(!append)listingOffset=0;
    try {
     const [history,listings]=await Promise.all([readComparableEventHistory({p_event_id:id,p_qty:historyQty,p_basis:basis==='getin'?'provider_get_in_tax_quantity_unconfirmed':basis,p_section:basis==='getin'?null:$('#history-section').value||null}),sbPublicRpc('tix_event_listings',{p_event_id:id,p_qty:qty,p_offset:listingOffset})]);
     if(loadId!==recordedLoad||!$('#event-listings'))return;
     const shownHistory=historyRangeRows(history||[],$('#history-range').value);
     $('#history-section').disabled=basis==='getin';
     $('#event-history').innerHTML=shownHistory.length?`${sparkline(shownHistory,true)}<p>${shownHistory.length} comparable samples · ${esc(historyQty?qty+' tickets together':'provider get-in')} · ${esc(basis==='getin'?'quantity and tax unconfirmed':basis==='fees_included_tax_reported'?'tax reported':'tax unconfirmed')} · ${esc(basis==='getin'?'all seat areas':$('#history-section').value||'any section')}</p><details class="chart-data"><summary>Recorded prices and timestamps</summary><div class="listing-table-wrap"><table><thead><tr><th>Checked</th><th>Per ticket</th></tr></thead><tbody>${shownHistory.map(r=>`<tr><td>${esc(new Date(r.checked_at).toLocaleString('en-US'))}</td><td>${money(r.price_cents)}</td></tr>`).join('')}</tbody></table></div></details>`:'<p>No comparable price samples in this range. Each line uses the same event, quantity, section choice, and price basis.</p>';
     const html=(listings||[]).map(l=>`<tr><td>${esc(l.section_group||l.section||'Unknown section')}</td><td>${esc(l.row_label||'—')}</td><td>${esc(Array.isArray(l.seats)?l.seats.map(s=>typeof s==='object'?s.seat||s.number||JSON.stringify(s):s).join(', '):'Not supplied')}</td><td>${esc((l.lots||[]).join(', ')||'Not supplied')}</td><td>${money(l.price_cents)}<small>${esc(l.basis?.replaceAll('_',' ')||'Unknown basis')}</small></td></tr>`).join('');
     if(append)$('#event-listings tbody')?.insertAdjacentHTML('beforeend',html);
     else $('#event-listings').innerHTML=listings?.length?`<div class="listing-table-wrap"><table><thead><tr><th>Section</th><th>Row</th><th>Seats</th><th>Available lots</th><th>Per ticket</th></tr></thead><tbody>${html}</tbody></table></div><p>${listings[0].coverage?.complete?'Complete embedded inventory':'Partial coverage'} · checked ${ago(listings[0].checked_at)}. Availability can change.</p>`:'<p>No recorded listings confirm this exact quantity yet.</p>';
     $('#more-listings').hidden=listings?.length!==50;
    }catch(e){if(loadId!==recordedLoad||!$('#event-history'))return;$('#event-history').textContent=e.message||'History could not load. Saved market details remain above.';}
   };
   $('#history-basis').onchange=()=>loadRecorded();
   $('#history-section').onchange=()=>loadRecorded();$('#history-range').onchange=()=>loadRecorded();
   $('#more-listings').onclick=()=>{listingOffset+=50;loadRecorded(true);};
   // Opening an event while signed in prices it now and tracks it, so its
   // price keeps being re-checked and saved to history.
   const refresh=async()=>{
    const button=$('#refresh-history');button.disabled=true;$('#capture-status').textContent=captureStateText({state:'checking'});
    try{
     let result=await captureEventPrice(id,{qty:Number($('#detail-qty').value)||2});
     if(result.state==='queued'&&result.next_attempt_at&&new Date(result.next_attempt_at).getTime()-Date.now()<70000){
      $('#capture-status').textContent=captureStateText(result);
      await new Promise(resolve=>setTimeout(resolve,Math.max(1000,new Date(result.next_attempt_at).getTime()-Date.now())));
      if(!button.isConnected)return;
      result=await captureEventPrice(id,{qty:Number($('#detail-qty').value)||2});
     }
     $('#capture-status').textContent=captureStateText(result)+(session&&!['scheduled','saved_only'].includes(result.state)?' This event is tracked: its price is re-checked automatically and saved to history.':'');
     await loadRecorded();
     if(result.min_total){const price=$('.detail-prices strong');price.textContent=money(result.min_total);$('.detail-prices > div > span').textContent=(result.state==='cached'&&result.checked_at?'Checked '+ago(result.checked_at):'Checked just now')+(result.state==='metadata_only'?' · get-in only':'');}
     if(['complete','empty'].includes(result.state)){await eventDetail(false);return;}
     // Poll database state only while a check or detail worker is pending;
     // polling never starts another provider fetch.
     for(let i=0;i<12&&(['queued','checking'].includes(result.state)||result.detail_worker==='queued');i++){
      await new Promise(resolve=>setTimeout(resolve,5000));if(!button.isConnected)break;
      const status=await sbPublicRpc('tix_event_capture_status',{p_event_id:id});$('#capture-status').textContent=captureStateText(status);
      if(['complete','empty'].includes(status.state)){await eventDetail(false);break;}
      if(status.state==='failed'||status.suspended){await loadRecorded();break;}
     }
    }catch(e){$('#capture-status').textContent=e.message;}finally{button.disabled=false;}
   };
   $('#refresh-history').onclick=refresh;
   loadRecorded();
   if(autoRefresh&&typeof IS_DEV!=='undefined'&&!IS_DEV)refresh();
   else sbPublicRpc('tix_event_capture_status',{p_event_id:id}).then(s=>{if(s&&$('#capture-status'))$('#capture-status').textContent=session?captureStateText(s):'Sign in to load the live price and keep this event\'s price history.';}).catch(()=>{});
   $('#detail-qty').onchange=()=>{renderQty();loadRecorded();if(typeof IS_DEV!=='undefined'&&!IS_DEV)refresh();};renderQty();
   $('#download-ics').onclick=()=>downloadICS(event,alertLink);
   $('#google-calendar').href=googleCalendarUrl(event,alertLink);
 }catch(e){layout('Event details unavailable.','We could not load this event.',errorBox(e.message));if($('#retry'))$('#retry').onclick=eventDetail;}
}
// Last-resort error page: an unexpected exception must never leave the page spinning.
function fatal(error){
 const ref=reportError(error,'unhandled');
 if(!$('#main .page-loading')&&main.childElementCount)return toast('Something went wrong. Reference '+ref+'.');
 layout('Something went wrong.','This page hit an unexpected error. Your saved alerts are not affected.',`<div class="notice error" role="alert">${icon('info')}<div><strong>Reference ${ref}</strong><p>Reload the page to try again. If it keeps happening, include this reference when you report it.</p></div></div><div class="detail-actions"><a class="button primary" href="">Reload</a><a class="button secondary" href="./index.html">Go to Find events</a></div>`);
}
addEventListener('error',e=>fatal(e.error||e.message));
addEventListener('unhandledrejection',e=>fatal(e.reason));
const PUBLIC_PAGES=['explore','event','coverage','privacy','notfound'];
(async()=>{try{if(!PUBLIC_PAGES.includes(page)&&!(await requireSession()))return;
  await ({explore,watches,new:builder,activity,notifications,coverage,event:eventDetail,privacy:()=>{},notfound:()=>{}}[page]||explore)();}catch(e){fatal(e);}})();
if(!IS_DEV&&'serviceWorker' in navigator)navigator.serviceWorker.register('./service-worker.js').catch(()=>{});

