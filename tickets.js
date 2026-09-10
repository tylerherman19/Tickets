/* shared chrome + data for the ticket watch pages */
const SB_URL = "https://aahqagqztanltejsqjom.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhaHFhZ3F6dGFubHRlanNxam9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTU3MjIsImV4cCI6MjEwNDQ3MTcyMn0.GWQZZ0Sp45Q6mW8Fz3DYF2Gj-LEURBMa7HoWvBgXmaE";
const H = {apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json"};

const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = c => Number.isFinite(Number(c)) && c !== null ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:Number(c)%100 ? 2 : 0}).format(c/100) : '—';
const todayISO = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const dateObj = iso => new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso||'') ? iso+'T12:00:00' : iso);
const whenShort = iso => iso ? dateObj(iso).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) : 'Date to be confirmed';
const cap = s => String(s||'').replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase()).replace(/\bAt\b/g,'at').replace(/U S Bank/g,'U.S. Bank').replace(/49 Ers/g,'49ers');
const ageMinutes = ts => ts ? Math.max(0,(Date.now()-new Date(ts).getTime())/60000) : Infinity;
const ago = ts => { const m=ageMinutes(ts); return !Number.isFinite(m) ? 'Not checked yet' : m<1 ? 'Just now' : m<60 ? `${Math.floor(m)} min ago` : m<1440 ? `${Math.floor(m/60)} hr ago` : `${Math.floor(m/1440)} days ago`; };
const safeUrl = raw => { if(typeof raw!=='string'||!raw.trim())return ''; try { const u=new URL(raw,'https://gametime.co'); return u.protocol==='https:' && (u.hostname==='gametime.co'||u.hostname.endsWith('.gametime.co')) ? u.href : ''; } catch {return '';} };
const normalizeUSPhone = raw => { let digits=String(raw||'').replace(/\D/g,'');if(digits.length===11&&digits[0]==='1')digits=digits.slice(1);return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits)?digits:''; };
const formatPhone = raw => {const d=normalizeUSPhone(raw);return d?`(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`:String(raw||'');};
const carrierName = carrier => ({tmobile:'T-Mobile or Metro',verizon:'Verizon or Visible',uscellular:'UScellular'}[carrier]||'Your carrier');
const leagueName = c => ({'nfl-football':'NFL','mlb-baseball':'MLB','nba-basketball':'NBA','nhl-hockey':'NHL','college-football':'College football','mls-soccer':'MLS','concert':'Concerts','comedy':'Comedy','theater':'Theater','sports':'More sports'}[c] || cap(c));
const iconPaths = {
 ticket:'<path d="M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4z"/><path d="M15 7v2m0 2v2m0 2v2"/>',
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
async function sbGet(path, {signal}={}) {
 const r=await fetch(SB_URL+'/rest/v1/'+path,{headers:H,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
 if(!r.ok) throw new Error(r.status===401||r.status===403 ? 'Your session could not access this data. Please reload and try again.' : 'Could not load ticket data. Check your connection and try again.');
 return r.json();
}
async function sbWrite(method,path,body,prefer='return=representation') {
 const r=await fetch(SB_URL+'/rest/v1/'+path,{method,headers:{...H,Prefer:prefer},body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(!r.ok) throw new Error(r.status===401||r.status===403 ? 'This alert could not be saved. Access to the alert board is unavailable.' : 'Your changes were not saved. Please try again.');
 return r.status===204 ? [] : r.json();
}
async function sbRpc(name,body) {
 const r=await fetch(SB_URL+'/rest/v1/rpc/'+name,{method:'POST',headers:H,body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(!r.ok){let detail='';try{detail=(await r.json()).message||'';}catch{}throw new Error(detail||'Your text destination was not saved. Please try again.');}
 return r.status===204?null:r.json();
}
function toast(message) { $('#toast').textContent=message; $('#toast').classList.add('show'); clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('show'),5000); }
function errorBox(message,retryId='retry') {return `<div class="notice error" role="alert">${icon('info')}<div><strong>Something interrupted that.</strong><p>${esc(message)}</p>${retryId?`<button class="text-button" id="${retryId}">Try again</button>`:''}</div></div>`;}
function loadingRows(n=4) {return `<div aria-label="Loading events" role="status">${Array.from({length:n},()=>'<div class="skeleton-row"><i></i><div><b></b><span></span></div></div>').join('')}</div>`;}
function chrome(page) {
  $('#chrome').innerHTML=`<header class="header"><div class="header-inner"><a class="brand" href="./index.html" aria-label="Ticketline home"><span class="brand-mark">${icon('ticket')}</span><span>Ticketline<span class="brand-period">.</span></span></a><nav aria-label="Main navigation"><a ${page==='explore'?'aria-current="page"':''} href="./index.html">Find events</a><a ${page==='watches'||page==='new'?'aria-current="page"':''} href="./watches.html">My alerts</a><a ${page==='activity'?'aria-current="page"':''} href="./ledger.html">Activity</a></nav><a class="notification-link" aria-label="Notification status" ${page==='notifications'?'aria-current="page"':''} href="./notifications.html">${icon('bell')}<span>Notifications</span></a></div></header>`;
 $('#footer').innerHTML=`<footer class="footer"><div><a class="brand small" href="./index.html">${icon('ticket')}Ticketline.</a><p>A little patience. A better ticket.</p></div><div><span>Prices from Gametime. All prices in USD.</span><p>Availability and checkout prices can change.</p></div><div class="footer-links"><a href="./notifications.html">Notification settings</a><button class="text-button" id="how-link">How it works</button></div></footer>`;
 $('#how-link').onclick=()=>showDialog('Your game. Your budget.',`<div class="help-steps"><p><strong>1. Pick what you want to see.</strong><br>Track one event, a team’s schedule, or a day out.</p><p><strong>2. Set your limit.</strong><br>Choose the exact number of tickets and your maximum price per ticket, fees included.</p><p><strong>3. Get the heads-up.</strong><br>When a checked listing is at or below your limit, we send an alert with a link to Gametime. You choose whether to buy.</p></div><p class="muted">Checks target every 15 minutes in the week before an event and hourly further out. Scheduling can be delayed. This is a shared personal alert board; saved watches are visible to people with access to this site.</p><a class="button primary" href="./new.html">Create an alert ${icon('arrow')}</a>`);
}
let dialogReturnFocus;
function showDialog(title,body) { const d=$('#dialog'); dialogReturnFocus=document.activeElement; d.innerHTML=`<div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="icon-button" id="dialog-close" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body">${body}</div>`;d.showModal();$('#dialog-close').onclick=()=>d.close();d.onclose=()=>dialogReturnFocus?.focus();d.onclick=e=>{if(e.target===d&&e.clientX&&(e.clientX<d.getBoundingClientRect().left||e.clientX>d.getBoundingClientRect().right||e.clientY<d.getBoundingClientRect().top||e.clientY>d.getBoundingClientRect().bottom))d.close();}; }
function dateBadge(iso) {const d=dateObj(iso);return `<div class="date-badge"><span>${d.toLocaleDateString('en-US',{month:'short'})}</span><strong>${d.getDate()}</strong><small>${d.toLocaleDateString('en-US',{weekday:'short'})}</small></div>`;}
