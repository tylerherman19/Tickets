/* shared chrome + data for the ticket watch pages */
const SB_URL = "https://aahqagqztanltejsqjom.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhaHFhZ3F6dGFubHRlanNxam9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTU3MjIsImV4cCI6MjEwNDQ3MTcyMn0.GWQZZ0Sp45Q6mW8Fz3DYF2Gj-LEURBMa7HoWvBgXmaE";
const H = {apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json"};

const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = c => Number.isFinite(Number(c)) && c !== null ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:Number(c)%100 ? 2 : 0}).format(c/100) : '—';
const perTicketTargetCents = (amount,qty,mode='per') => {
 const cents=Math.round(Number(amount)*100);
 return Number.isInteger(qty)&&qty>0&&Number.isFinite(cents)?(mode==='total'?Math.floor(cents/qty):cents):NaN;
};
const knownPriceBasis = basis => ['fees_included_tax_reported','fees_included_tax_unknown'].includes(basis);
function priceBreakdown(price){
 if(!price||!Number.isInteger(price.price_cents)||price.price_cents<=0)return '';
 const total=price.price_cents,base=price.prefee_cents,tax=price.sales_tax_cents,pretax=price.pre_tax_total_cents;
 if(price.basis==='fees_included_tax_reported'&&Number.isInteger(base)&&base>=0&&Number.isInteger(tax)&&tax>=0&&total>=base+tax&&(pretax==null||Number.isInteger(pretax)&&pretax===total-tax))
   return `${money(base)} base + ${money(total-base-tax)} fees + ${money(tax)} tax = ${money(total)} all-in`;
 return knownPriceBasis(price.basis)?`${money(total)} · fees included, tax not confirmed`:`${money(total)} · price basis not confirmed`;
}
function priceProof(rows,current){
 // Vendor history is opaque until a real comparable schema is observed.
 // Compare only Ticketline checks on the same basis/event/quantity/section.
 const comparable=rows.filter(r=>current&&r.basis===current.basis&&(!current.event_id||r.event_id===current.event_id)&&(!current.qty||r.qty===current.qty)&&(!current.club||r.club===current.club));
 const context=priceContext(comparable);
 return context?'Ticketline checks · '+context:'No history available';
}
function lotFilterMarkup(id,value='any'){
 return `<label class="field-label" for="${id}">Group filter</label><select id="${id}">${[['any','Any'],['2','Pairs (2)'],['4','Groups of 4']].map(([v,label])=>`<option value="${v}" ${value===v?'selected':''}>${label}</option>`).join('')}</select>`;
}
function marketQuantityText(sample,qty,metadataOnly=false){
 const spread=sample?.by_qty?.[String(qty)],coverage=sample?.coverage;
 const prior=metadataOnly||ageMinutes(sample?.checked_at)>=120;
 if(spread&&knownPriceBasis(spread.basis)){
   const basis=spread.basis==='fees_included_tax_reported'?'all-in (reported tax)':'fees included, tax not confirmed';
   return `${prior?'Prior sample':'Last checked'}: ${money(spread.low)} low · ${money(spread.typical)} typical · ${money(spread.high)} high for exactly ${qty} together · ${basis} · ${spread.listings} matching listings`;
 }
 if(spread)return `Recorded ${qty}-ticket prices have an unconfirmed basis.`;
 if(!metadataOnly&&coverage?.complete&&!(coverage.unknown_lots>0)&&!(coverage.unknown_seats>0))return `No seller-confirmed ${qty}-ticket lot in the last market sample.`;
 return `Exactly ${qty} together: not confirmed. Seller lot coverage is incomplete.`;
}
const todayISO = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dateObj = iso => new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso||'') ? iso+'T12:00:00' : iso);
const whenShort = iso => iso ? dateObj(iso).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) : 'Date to be confirmed';
const cap = s => String(s||'').replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase()).replace(/\bAt\b/g,'at').replace(/U S Bank/g,'U.S. Bank').replace(/49 Ers/g,'49ers');
const ageMinutes = ts => ts ? Math.max(0,(Date.now()-new Date(ts).getTime())/60000) : Infinity;
const ago = ts => { const m=ageMinutes(ts); return !Number.isFinite(m) ? 'Not checked yet' : m<1 ? 'Just now' : m<60 ? `${Math.floor(m)} min ago` : m<1440 ? `${Math.floor(m/60)} hr ago` : Math.floor(m/1440)===1 ? '1 day ago' : `${Math.floor(m/1440)} days ago`; };
const safeUrl = raw => { if(typeof raw!=='string'||!raw.trim())return ''; try { const u=new URL(raw,'https://gametime.co'); return u.protocol==='https:' && (u.hostname==='gametime.co'||u.hostname.endsWith('.gametime.co')) ? u.href : ''; } catch {return '';} };
const eventSearchUrl = (market,label) => {
 const q=encodeURIComponent(String(label||'').trim());
 const bases={tickpick:'https://www.tickpick.com/search?q=',seatgeek:'https://seatgeek.com/search?search=',vivid:'https://www.vividseats.com/search?searchTerm='};
 return bases[market]+q;
};
const marketLinks = label => `<div class="market-links" aria-label="Compare ticket marketplaces"><span>Compare</span><a href="${eventSearchUrl('tickpick',label)}" target="_blank" rel="noopener">TickPick</a><a href="${eventSearchUrl('seatgeek',label)}" target="_blank" rel="noopener">SeatGeek</a><a href="${eventSearchUrl('vivid',label)}" target="_blank" rel="noopener">Vivid Seats</a></div>`;
const watchHistory = (prices,watchId) => prices.filter(p=>p.watch_id===watchId).sort((a,b)=>new Date(a.checked_at)-new Date(b.checked_at));
function sparkline(rows,wide=false,target=null,alerts=[]){
 if(!rows.length)return '';
 const sample=rows.length>180?rows.filter((_,i)=>i%Math.ceil(rows.length/180)===0||i===rows.length-1):rows;
 const vals=sample.map(r=>Number(r.price_cents)),lo=Math.min(...vals,target??Infinity),hi=Math.max(...vals,target??-Infinity),w=wide?680:240,h=wide?180:58,pad=wide?22:3,span=hi-lo||1;
 const times=sample.map(r=>new Date(r.checked_at).getTime()),first=times[0],duration=Math.max(1,times.at(-1)-first);
 const x=i=>pad+(times[i]-first)*(w-pad*2)/duration;
 const y=v=>h-pad-(v-lo)*(h-pad*2)/span;
 const pts=vals.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
 const targetLine=wide&&target!=null?`<line class="chart-target" x1="${pad}" x2="${w-pad}" y1="${y(target)}" y2="${y(target)}"/><text x="${pad+3}" y="${Math.max(12,y(target)-5)}">Target ${money(target)}</text>`:'';
 const dots=wide?sample.map((r,i)=>`<circle class="chart-point" cx="${x(i)}" cy="${y(vals[i])}" r="3" tabindex="0"><title>${esc(new Date(r.checked_at).toLocaleString('en-US'))}: ${money(vals[i])}</title></circle>`).join(''):'';
 const markers=wide?alerts.map(a=>{const t=new Date(a.sent_at).getTime();if(t<first||t>times.at(-1))return '';const mx=pad+(t-first)*(w-pad*2)/duration;return `<circle class="chart-alert" cx="${mx}" cy="${h-pad}" r="5"><title>Notification ${esc(new Date(a.sent_at).toLocaleString('en-US'))}</title></circle>`;}).join(''):'';
 return `<svg class="price-chart ${wide?'full-chart':'sparkline'}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Price history from ${money(vals[0])} to ${money(vals.at(-1))}">${targetLine}<polyline points="${pts}"/>${dots}${markers}</svg>`;
}
function priceContext(rows){
 const basis=rows.at(-1)?.basis;
 if(!knownPriceBasis(basis))return '';
 rows=rows.filter(r=>r.basis===basis);
 if(rows.length<2)return '';
 const latest=rows.at(-1),cut=Date.now()-86400000,prior=[...rows].reverse().find(r=>new Date(r.checked_at).getTime()<=cut),min=Math.min(...rows.map(r=>r.price_cents));
 const bits=[];
 if(prior){const d=latest.price_cents-prior.price_cents;bits.push(d===0?'unchanged since yesterday':`${d<0?'down':'up'} ${money(Math.abs(d))} since yesterday`);}
 const days=Math.max(1,Math.ceil((new Date(latest.checked_at)-new Date(rows[0].checked_at))/86400000));
 if(latest.price_cents===min)bits.push(`lowest in ${days} ${days===1?'day':'days'}`);
 return bits.join(' · ');
}

// Search prices stay explicit about quantity and the last successful observation.
function priceFreshness(event){
 const age=ageMinutes(event.price_checked_at),has=Number.isInteger(event.min_total)&&event.min_total>0;
 if(['failed','http_failure','parser_failure'].includes(event.discovery_status))return {state:'failed',label:has?'Check failed · saved price':'Last check failed'};
 if(!event.price_checked_at)return {state:'unchecked',label:'Price not checked'};
 if(!has)return {state:'unavailable',label:'Price unavailable at last check'};
 return {state:age<=15?'fresh':'saved',label:(age<=15?'Checked ':'Saved price · ')+ago(event.price_checked_at).toLowerCase()};
}
function exactSearchPrice(row,qty){
 if(!row||row.requested_qty!=null&&row.requested_qty!==qty||!row.checked_at||!Number.isFinite(new Date(row.checked_at).getTime())||!Number.isInteger(row.price_cents)||row.price_cents<=0||!knownPriceBasis(row.basis)||!['verified','complete','partial','ok'].includes(row.state))return null;
 return {price_cents:row.price_cents,checked_at:row.checked_at,label:`Exactly ${qty} together`,basis:row.basis};
}
function schedulePriceChart(rows,{label='Team schedule',qty=0}={}){
 const games=[...rows].sort((a,b)=>String(a.event_date).localeCompare(String(b.event_date))||String(a.event_id).localeCompare(String(b.event_id)));
 if(!games.length)return '<p class="field-help">No games with a confirmed home designation are listed yet. Choose all games to see the available schedule.</p>';
 const price=e=>qty?exactSearchPrice(e.quantity_price,qty)?.price_cents:(Number.isInteger(e.min_total)&&e.min_total>0?e.min_total:null);
 const freshness=e=>qty?priceFreshness({min_total:price(e),price_checked_at:e.quantity_price?.checked_at,discovery_status:e.quantity_price?.state==='failed'?'failed':null}):priceFreshness(e);
 const high=Math.max(100,...games.map(e=>price(e)||0)),width=Math.max(560,games.length*48+70),height=220,left=52,bottom=170,step=(width-left-18)/games.length;
 const marks=games.map((e,i)=>{const value=price(e),x=left+step*(i+.5),y=value==null?bottom:bottom-(value/high)*140,text=`${whenShort(e.event_date)} · ${e.name} · ${value==null?'Price not confirmed':money(value)+' per ticket'} · ${freshness(e).label}`;return `<g><a href="./event.html?event=${encodeURIComponent(e.event_id)}" aria-label="${esc(text)}">${value==null?`<circle class="schedule-unknown" cx="${x.toFixed(1)}" cy="${bottom}" r="5"/>`:`<rect class="schedule-bar" x="${(x-Math.min(14,step*.28)).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.min(28,step*.56).toFixed(1)}" height="${Math.max(2,bottom-y).toFixed(1)}" rx="3"/>`}<title>${esc(text)}</title></a><text x="${x.toFixed(1)}" y="192" text-anchor="middle">${esc(dateObj(e.event_date).toLocaleDateString('en-US',{month:'short',day:'numeric'}))}</text></g>`;}).join('');
 return `<div class="schedule-chart-scroll"><svg class="schedule-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}: ${qty?'verified '+qty+'-ticket':'get-in'} prices by game date. Gray dots mean unknown prices."><line x1="${left}" x2="${width-12}" y1="${bottom}" y2="${bottom}"/><text x="42" y="34" text-anchor="end">${money(high)}</text><text x="42" y="174" text-anchor="end">$0</text>${marks}</svg></div><p class="field-help">${qty?`Per ticket for exactly ${qty} together; only verified seller lots are plotted.`:'Gametime get-in per ticket; exact quantity and tax are unconfirmed.'} Gray dots mean a price is unknown, never free.</p><details class="chart-data"><summary>Game prices and check times</summary><div class="listing-table-wrap"><table><thead><tr><th>Date</th><th>Game</th><th>Per ticket</th><th>${qty?'Quantity check':'Last check'}</th></tr></thead><tbody>${games.map(e=>`<tr><td>${esc(whenShort(e.event_date))}</td><td><a href="./event.html?event=${encodeURIComponent(e.event_id)}">${esc(e.name)}</a></td><td>${price(e)==null?'Not confirmed':money(price(e))}</td><td>${esc(freshness(e).label)}</td></tr>`).join('')}</tbody></table></div></details>`;
}
function coverageMarkup(health){
 if(!health||typeof health!=='object'||health.events==null||!Number.isFinite(Number(health.events)))return '<p>Coverage is unavailable right now. <a href="./coverage.html">Check coverage status</a> or try again shortly.</p>';
 const number=n=>n!=null&&Number.isFinite(Number(n))?Number(n).toLocaleString('en-US'):'Unknown';
 const metrics=[['Events listed',health.events],['With saved prices',health.priced],['Need first price',health.unpriced],['Checked within 24 hours',health.fresh],['Older saved prices',health.stale],['Checks pending',health.pending_checks],['Failed checks',health.failed_checks],['Teams checked',health.teams_checked],['Teams needing attention',health.teams_failed]];
 const collectorMessage=health.collector_state==='stale'?'Price checks are delayed. Saved prices remain available.':health.collector_state==='failed'?'The last price sweep failed. Saved prices remain available.':health.collector_state!=='fresh'?'Price-sweep status is unknown. Saved prices remain available.':Number(health.failed_checks)>0||Number(health.teams_failed)>0?'Some checks need attention. Saved prices remain available while checks retry.':'Collection is running.';
 return `<p class="coverage-state ${health.provider_paused||health.collector_state!=='fresh'?'attention':''}" role="status">${health.provider_paused?'Live checks are paused. Saved prices remain available.':collectorMessage} Coverage includes the next ${number(health.horizon_days||365)} days.</p><dl class="coverage-grid">${metrics.map(([label,value])=>`<div><dt>${label}</dt><dd>${number(value)}</dd></div>`).join('')}</dl><p class="field-help">${health.last_catalog_at?'Schedules updated '+esc(ago(health.last_catalog_at).toLowerCase())+'. ':''}${health.last_collector_at?'Last price sweep '+esc(ago(health.last_collector_at).toLowerCase())+'. ':''}A listed event can have an unknown price. Saved get-in prices do not confirm exact ticket quantities.</p>`;
}
// An alert can have a separate series for every event and seat area. Read
// every page within one snapshot instead of silently accepting the REST cap.
async function readAlertHistory(watchId,range='7d'){
 const pageSize=1000,maxPages=10,snapshot=new Date().toISOString(),rows=[],seen=new Set();
 const base=`rpc/tix_alert_history?p_watch_id=${encodeURIComponent(watchId)}&p_range=${encodeURIComponent(range)}&checked_at=lte.${encodeURIComponent(snapshot)}&order=checked_at.desc,event_id.asc,qty.asc,club.asc,basis.asc,criteria_version.desc&limit=${pageSize}`;
 for(let page=0;page<maxPages;page++){
  const batch=await sbGet(base+'&offset='+(page*pageSize));
  if(!Array.isArray(batch))throw new Error('Price history could not load. Try again shortly.');
  for(const row of batch){const key=JSON.stringify([row.checked_at,row.event_id,row.qty,row.club,row.basis]);if(!seen.has(key)){seen.add(key);rows.push(row);}}
  if(batch.length<pageSize)return rows;
 }
 throw new Error('This alert has too much price history to display completely. Choose a shorter time range.');
}
async function readComparableEventHistory(body){
 try{const rows=await sbPublicRpc('tix_event_comparable_history',body);if(Array.isArray(rows))return rows;}catch{}
 if(body.p_section)throw new Error('History for this section is unavailable. Choose Any section to view saved comparable prices.');
 const {p_section,...legacy}=body;return sbPublicRpc('tix_event_price_history',legacy);
}
function historyRangeRows(rows,range){
 const days={'24h':1,'7d':7,'30d':30}[range];
 return rows.filter(r=>!days||new Date(r.checked_at).getTime()>=Date.now()-days*86400000);
}
function comparableHistoryGroups(rows){
 const groups=new Map();
 for(const r of rows){if(!knownPriceBasis(r.basis)||!Number.isInteger(r.price_cents)||r.price_cents<=0)continue;const key=JSON.stringify([r.event_id||'',r.qty||0,r.club||r.section||'',r.basis||'unknown']);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
 return [...groups.entries()].map(([key,samples])=>({key,samples:samples.sort((a,b)=>new Date(a.checked_at)-new Date(b.checked_at)),label:`${samples[0].event_label||samples[0].event_id||'Event'} · ${samples[0].qty||'unknown quantity'} tickets · ${samples[0].club||samples[0].section||'Any section'} · ${samples[0].basis==='fees_included_tax_reported'?'tax reported':samples[0].basis==='fees_included_tax_unknown'?'tax unconfirmed':'basis unconfirmed'}`}));
}

const normalizeUSPhone = raw => { let digits=String(raw||'').replace(/\D/g,'');if(digits.length===11&&digits[0]==='1')digits=digits.slice(1);return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits)?digits:''; };
const formatPhone = raw => {const d=normalizeUSPhone(raw);return d?`(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`:String(raw||'');};
const carrierName = carrier => ({tmobile:'T-Mobile or Metro',verizon:'Verizon or Visible',xfinity:'Xfinity Mobile',uscellular:'UScellular'}[carrier]||'Your carrier');
const leagueName = c => ({'nfl-football':'NFL','mlb-baseball':'MLB','nba-basketball':'NBA','nhl-hockey':'NHL','college-football':'College football','college-basketball':'College basketball','mls-soccer':'MLS','concert':'Concerts','comedy':'Comedy','theater':'Theater','sports':'More sports'}[c] || cap(c));
const iconPaths = {
 ticket:'<path d="M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4z"/><path d="M15 7v2m0 2v2m0 2v2"/>',
 tag:'<path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.6"/>',
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
 bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
 arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
 close:'<path d="m6 6 12 12M6 18 18 6"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 ball:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5 5c7 4 7 10 0 14M19 5c-7 4-7 10 0 14"/>',
 people:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>',
 pause:'<path d="M8 5v14M16 5v14"/>',
 mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
 chart:'<path d="M4 3v17h17M7 14l4-4 4 2 5-7"/>',
 refresh:'<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>'
};
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]||iconPaths.ticket}</svg>`;
// Abort after `ms`, and also when the caller's signal aborts.
const withTimeout = (ms,signal) => signal ? AbortSignal.any([signal,AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
// Reads are idempotent, so retry network errors, 429s and 5xx with backoff.
// Writes are never retried automatically; the caller decides.
async function fetchWithRetry(url,options,{tries=3,timeout=20000,signal}={}){
 for(let attempt=1;;attempt++){
  try{
   const r=await fetch(url,{...options,signal:withTimeout(timeout,signal)});
   if((r.status===429||r.status>=500)&&attempt<tries){await sleep(400*2**attempt);continue;}
   return r;
  }catch(e){
   if(signal?.aborted||attempt>=tries)throw e.name==='TimeoutError'?new Error('The request timed out. Check your connection and try again.'):e;
   await sleep(400*2**attempt);
  }
 }
}
// PostgREST returns arrays for table reads; tolerate null or an empty body.
async function readJson(r){const text=await r.text();if(!text)return null;try{return JSON.parse(text);}catch{throw new Error('The server sent an unexpected response. Please try again.');}}
async function sbGet(path, {signal}={}) {
 if(IS_DEV) return devGet(path);
 const token=await accessToken();
 const r=await fetchWithRetry(SB_URL+'/rest/v1/'+path,{headers:{...H,Authorization:'Bearer '+(token||SB_KEY)}},{signal});
 if(r.status===401&&token){expireSession();throw new Error('Your session expired. Sign in again to continue.');}
 if(!r.ok) throw new Error(r.status===401||r.status===403 ? 'Your session could not access this data. Please reload and try again.' : 'Could not load ticket data. Check your connection and try again.');
 return (await readJson(r)) ?? [];
}
async function sbPublicRpc(name,body,{signal,token}={}) {
 if(IS_DEV) return typeof devRpc==='function'?devRpc(name,body):false;
 const r=await fetchWithRetry(SB_URL+'/rest/v1/rpc/'+name,{method:'POST',headers:token?{...H,Authorization:'Bearer '+token}:H,body:JSON.stringify(body)},{signal,timeout:10000,tries:2});
 if(!r.ok) throw new Error('Could not request a price check.');
 return readJson(r);
}
// One request per call: a timed-out capture may already have committed history.
// A search prices up to 12 events in one call without tracking them; opening
// an event (track) also keeps its price history going.
async function captureEventPrices(eventIds,{signal,track=false}={}) {
 if(IS_DEV)return eventIds.map(event_id=>({event_id,state:'suspended',reason:'preview'}));
 const token=await accessToken();if(!token)return eventIds.map(event_id=>({event_id,state:'sign_in_required'}));
 const r=await fetch(SB_URL+'/functions/v1/ticketline-prices',{method:'POST',headers:{...H,Authorization:'Bearer '+token},body:JSON.stringify({event_ids:eventIds,track}),signal:signal?withTimeout(45000,signal):AbortSignal.timeout(45000)});
 const result=await readJson(r);
 // Older deployments have the discovery queue but no Edge capture route.
 // Fall back only for the explicit missing-route response, never auth or provider errors.
 if(r.status===404&&result?.code==='NOT_FOUND'){
   const out=[];
   for(const event_id of eventIds.slice(0,3)){const queued=await sbPublicRpc('tix_request_price_check',{p_event_id:event_id},{signal,token});out.push({event_id,state:queued?'scheduled':'saved_only'});}
   return out;
 }
 if(!r.ok)throw new Error(result?.reason==='capture_failed'?'Price check failed. The saved price is still available.':'Could not refresh prices.');
 return Array.isArray(result?.results)?result.results:[];
}
async function captureEventPrice(eventId,{signal}={}) {
 const [result]=await captureEventPrices([eventId],{signal,track:true});
 if(!result)throw new Error('Could not refresh prices.');
 if(result.state==='failed')throw new Error('Price check failed. The saved price is still available.');
 return result;
}
function captureStateText(result) {
 if(result.guard_enabled===false||result.reason==='rollout_disabled')return 'Live refresh is paused during rollout. Saved prices remain available.';
 if(result.suspended||result.state==='suspended')return 'Live checks are paused. Saved prices remain available.';
 if(result.state==='queued'&&result.reason==='request_limit')return 'Live checks are at their request limit. This price will refresh automatically shortly.';
 return {scheduled:'Price check requested for the scheduled collector. Refresh this page after the next sweep.',saved_only:'No new check was queued. A request may already be pending. Available saved prices are shown below.',sign_in_required:'Sign in to refresh prices and save history. Saving history does not enable alerts.',cached:'Price checked in the last 15 minutes.',queued:'Check queued. It will run shortly, subject to request limits.',checking:'Checking prices…',metadata_only:'Get-in price saved just now. Exact quantities are not confirmed.',complete:'Prices and seat details saved.',partial:'Available seat details saved. Coverage is partial.',empty:'The provider returned an empty listing set.',failed:'The check failed. The last saved price is still available.',expired:'This event has passed.',beyond_horizon:'Live checks cover events up to one year ahead.',not_checked:'No price check has completed yet.'}[result.state]||'Waiting for the next check.';
}
// One line for a whole search: how many prices are fresh and what is left.
function searchPriceSummary(results) {
 const count=states=>results.filter(r=>states.includes(r.state)).length;
 if(results.some(r=>r.state==='suspended'))return captureStateText({state:'suspended'});
 if(results.length&&results.every(r=>r.state==='sign_in_required'))return captureStateText({state:'sign_in_required'});
 const fresh=count(['metadata_only','complete','partial','empty','cached']),scheduled=count(['scheduled']),waiting=count(['queued']),failed=count(['failed']);
 const parts=[];
 if(fresh)parts.push(`${fresh} live ${fresh===1?'price':'prices'} updated`);
 if(scheduled)parts.push(`${scheduled} queued for the next scheduled check`);
 if(waiting)parts.push(`${waiting} waiting on the request limit`);
 if(failed)parts.push(`${failed} could not be checked (saved prices shown)`);
 return parts.length?parts.join(' · ')+'.':'Showing saved prices.';
}
async function sbWrite(method,path,body,prefer='return=representation') {
 if(IS_DEV) throw new Error('Local preview is read-only. Sign in on the live site to save an alert.');
 const token=await accessToken();if(!token)throw new Error('Your session expired. Sign in again to change your alert.');
 let r;
 try{r=await fetch(SB_URL+'/rest/v1/'+path,{method,headers:{...H,Authorization:'Bearer '+token,Prefer:prefer},body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}
 catch(e){throw new Error(e.name==='TimeoutError'?'The save timed out. Refresh to check whether it went through before trying again.':'You appear to be offline. Your changes were not saved.');}
 if(r.status===401){expireSession();throw new Error('Your session expired. Sign in again to change your alert.');}
 if(!r.ok) throw new Error(r.status===403 ? 'This alert could not be saved. Access to the alert board is unavailable.' : 'Your changes were not saved. Please try again.');
 return r.status===204 ? [] : (await readJson(r)) ?? [];
}
async function sbRpc(name,body) {
 if(IS_DEV) throw new Error('Local preview is read-only.');
 const token=await accessToken();if(!token)throw new Error('Your session expired. Sign in again to change your alert.');
 let r;
 try{r=await fetch(SB_URL+'/rest/v1/rpc/'+name,{method:'POST',headers:{...H,Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}
 catch(e){throw new Error(e.name==='TimeoutError'?'The save timed out. Check My alerts before trying again so you do not create a duplicate.':'You appear to be offline. Nothing was saved.');}
 if(r.status===401){expireSession();throw new Error('Your session expired. Sign in again to save.');}
 if(!r.ok){
  // Only surface messages raised deliberately by our RPCs (P0001 / 42501), never raw database detail.
  let detail='';try{const err=await r.json();if(['P0001','42501'].includes(err.code))detail=err.message||'';}catch{}
  if(r.status>=500)reportError(new Error('rpc '+name+' '+r.status));
  throw new Error(detail||'Your alert was not saved. Please try again.');
 }
 return r.status===204?null:readJson(r);
}
// Client-side error reporting. There is no third-party tracker (by design, see privacy.html);
// errors are logged with a short reference the user can quote, and never include personal data.
function reportError(error,context=''){
 const ref=Math.random().toString(36).slice(2,8).toUpperCase();
 console.error(`[ticketline ${ref}]`,context,error?.message||error);
 return ref;
}
function toast(message) { $('#toast').textContent=message; $('#toast').classList.add('show'); clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('show'),5000); }
function errorBox(message,retryId='retry') {return `<div class="notice error" role="alert">${icon('info')}<div><strong>Something interrupted that.</strong><p>${esc(message)}</p>${retryId?`<button class="text-button" id="${retryId}">Try again</button>`:''}</div></div>`;}
function loadingRows(n=4) {return `<div aria-label="Loading events" role="status">${Array.from({length:n},()=>'<div class="skeleton-row"><i></i><div><b></b><span></span></div></div>').join('')}</div>`;}
function chrome(page) {
  $('#chrome').innerHTML=`<header class="header"><div class="header-inner"><a class="brand" href="./index.html" aria-label="Ticketline home"><span class="brand-mark">${icon('tag')}</span><span>Ticketline</span></a><nav aria-label="Main navigation"><a ${page==='explore'||page==='new'?'aria-current="page"':''} href="./index.html">Set a price</a><a ${page==='watches'?'aria-current="page"':''} href="./watches.html">My alerts</a><a ${page==='activity'?'aria-current="page"':''} href="./ledger.html">Activity</a><a ${page==='notifications'?'aria-current="page"':''} href="./notifications.html">Delivery</a></nav>${session?'<button id="sign-out" class="notification-link">Sign out</button>':''}</div></header>`;
 $('#footer').innerHTML=`<footer class="footer"><div><a class="brand small" href="./index.html"><span class="brand-mark">${icon('tag')}</span>Ticketline</a><p>We watch the price. You make the call.</p></div><div><span>Prices from Gametime. All prices in USD.</span><p>Availability and checkout prices can change.</p></div><div class="footer-links"><a href="./coverage.html">Data coverage</a><a href="./notifications.html">How delivery works</a><a href="./privacy.html">Privacy</a><button class="text-button" id="how-link">How it works</button></div></footer>`;
 if($('#sign-out'))$('#sign-out').onclick=signOut;
 if(session&&!IS_DEV)sbRpc('tix_is_admin',{}).then(allowed=>{if(allowed){const a=document.createElement('a');a.href='./admin.html';a.textContent='Admin';if(page==='admin')a.setAttribute('aria-current','page');document.querySelector('nav[aria-label="Main navigation"]').append(a);}}).catch(()=>{});
 $('#how-link').onclick=()=>showDialog('Your game. Your budget.',`<div class="help-steps"><p><strong>1. Pick what you want to see.</strong><br>Track one event, a team’s schedule, or a day out.</p><p><strong>2. Set your limit.</strong><br>Choose the exact number of tickets and your maximum price per ticket, fees included.</p><p><strong>3. Get the heads-up.</strong><br>When a checked listing is at or below your limit, we send an alert with a link to Gametime. You choose whether to buy.</p></div><p class="muted">Checks target every 15 minutes in the week before an event and hourly further out. Scheduling can be delayed. Sign in to keep your alerts and history private.</p><a class="button primary" href="./new.html">Create an alert ${icon('arrow')}</a>`);
}
let dialogReturnFocus;
function showDialog(title,body) { const d=$('#dialog'); dialogReturnFocus=document.activeElement; d.innerHTML=`<div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="icon-button" id="dialog-close" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body">${body}</div>`;d.showModal();$('#dialog-close').onclick=()=>d.close();d.onclose=()=>dialogReturnFocus?.focus();d.onclick=e=>{if(e.target===d&&e.clientX&&(e.clientX<d.getBoundingClientRect().left||e.clientX>d.getBoundingClientRect().right||e.clientY<d.getBoundingClientRect().top||e.clientY>d.getBoundingClientRect().bottom))d.close();}; }
function dateBadge(iso) {const d=dateObj(iso);return `<div class="date-badge"><span>${d.toLocaleDateString('en-US',{month:'short'})}</span><strong>${d.getDate()}</strong><small>${d.toLocaleDateString('en-US',{weekday:'short'})}</small></div>`;}

// One identifier per submitted/opened search, never a visitor identifier.
function newSearchActivity(source,term){
 if(!term.trim()||typeof crypto==='undefined'||!crypto.randomUUID)return null;
 return {p_search_id:crypto.randomUUID(),p_query:term.trim().slice(0,100),p_source:source};
}
async function recordSearchActivity(body){
 if(typeof IS_DEV!=='undefined'&&IS_DEV||typeof fetch!=='function')return false;
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),5000);
 try{
 const token=typeof accessToken==='function'?await accessToken():null;
 if(ctrl.signal.aborted)return false;
 const res=await fetch(SB_URL+'/rest/v1/rpc/tix_record_search',{method:'POST',headers:{apikey:SB_KEY,Authorization:'Bearer '+(token||SB_KEY),'Content-Type':'application/json'},body:JSON.stringify(body),signal:ctrl.signal});
 return res.ok;
 }catch{return false;}finally{clearTimeout(timer);}
}
