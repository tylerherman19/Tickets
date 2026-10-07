/* Small passwordless Supabase Auth client for the static GitHub Pages site. */
const IS_DEV = ['localhost','127.0.0.1'].includes(location.hostname);
const SESSION_KEY = 'ticketline.session.v1';
let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { try { localStorage.removeItem(SESSION_KEY); } catch {} }
if (session && (typeof session.access_token!=='string' || typeof session.refresh_token!=='string')) session = null;
const storeSession = value => { try { value ? localStorage.setItem(SESSION_KEY,JSON.stringify(value)) : localStorage.removeItem(SESSION_KEY); } catch {} };
const callback = new URLSearchParams(location.hash.slice(1));
if (callback.has('access_token') && callback.has('refresh_token')) {
  session = {access_token:callback.get('access_token'),refresh_token:callback.get('refresh_token'),
    expires_at:Date.now()+Number(callback.get('expires_in')||3600)*1000};
  storeSession(session);
  history.replaceState(null,'',location.pathname+location.search);
} else if (callback.has('error_description')) {
  // Expired or reused magic links come back as #error=...; don't leave them in the URL.
  sessionStorage.setItem('ticketline.auth-error', callback.get('error_description'));
  history.replaceState(null,'',location.pathname+location.search);
}
let refreshing = null;
// One refresh at a time: parallel page loads would otherwise reuse a rotated refresh token.
async function accessToken(){
  if(IS_DEV || !session) return null;
  if(session.expires_at>Date.now()+60000) return session.access_token;
  refreshing ||= (async()=>{
    let r;
    try {
      r=await fetch(SB_URL+'/auth/v1/token?grant_type=refresh_token',{
        method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({refresh_token:session.refresh_token}),signal:AbortSignal.timeout(15000)});
    } catch { throw new Error('Could not reach the sign-in service. Check your connection and try again.'); }
    if(r.status>=500) throw new Error('The sign-in service is temporarily unavailable. Please try again shortly.');
    if(!r.ok){ expireSession(); return null; }
    const next=await r.json();
    session={access_token:next.access_token,refresh_token:next.refresh_token,expires_at:Date.now()+next.expires_in*1000};
    storeSession(session);
    return session.access_token;
  })().finally(()=>{ refreshing=null; });
  return refreshing;
}
// The stored session is no longer valid: forget it and send private pages back to sign-in.
function expireSession(){
  if(!session) return;
  session=null;storeSession(null);
  sessionStorage.setItem('ticketline.auth-error','Your session expired. Sign in again to continue.');
  if(!['explore','event','privacy','notfound'].includes(document.body.dataset.page)) setTimeout(()=>location.reload(),0);
}
async function requireSession(){
  if(IS_DEV) return true;
  let token=null;
  try { token=await accessToken(); } catch(e) {
    document.querySelector('#main').innerHTML=`<div class="container page"><div class="notice error" role="alert"><div><strong>We couldn’t confirm your sign-in.</strong><p>${esc(e.message)}</p><a class="button secondary" href="">Try again</a></div></div></div>`;
    return false;
  }
  if(token) return true;
  const notice=sessionStorage.getItem('ticketline.auth-error');sessionStorage.removeItem('ticketline.auth-error');
  const main=document.querySelector('#main');
  main.innerHTML=`<div class="container page auth-page"><h1>Sign in to your alerts.</h1>${notice?`<p class="notice subtle" role="status">${esc(notice)}</p>`:''}<p>Enter your email for a secure sign-in link. You can browse ticket prices without signing in.</p><p>Price alerts are emailed to this address by default. You can add carrier email-to-text when creating an alert.</p><form id="sign-in-form" novalidate><label class="field-label" for="sign-in-email">Email</label><input id="sign-in-email" type="email" autocomplete="email" maxlength="254" required aria-describedby="sign-in-status"><button class="button primary" type="submit">Email me a sign-in link</button></form><p id="sign-in-status" role="status" aria-live="polite"></p><p class="field-help">By signing in you agree to the <a class="text-link" href="./privacy.html">privacy policy</a>.</p></div>`;
  const form=document.querySelector('#sign-in-form'),status=document.querySelector('#sign-in-status'),button=form.querySelector('button');
  form.onsubmit=async event=>{
    event.preventDefault();
    if(button.disabled) return;
    const email=document.querySelector('#sign-in-email').value.trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){status.textContent='Enter a valid email address.';document.querySelector('#sign-in-email').focus();return;}
    button.disabled=true;button.textContent='Sending…';
    try {
      const redirect=location.origin+location.pathname+location.search;
      const r=await fetch(SB_URL+'/auth/v1/otp?redirect_to='+encodeURIComponent(redirect),{
        method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({email,create_user:true}),signal:AbortSignal.timeout(15000)});
      if(r.status===429) throw new Error('Too many sign-in requests. Wait a minute, then try again.');
      if(!r.ok) throw new Error('Could not send the sign-in link. Please try again.');
      // Same message whether or not the address already has an account.
      status.textContent='Check your email for the sign-in link. It may take a minute to arrive.';
      // Short cooldown so repeated clicks can't flood the inbox or hit the auth rate limit.
      let wait=60;button.textContent=`Resend in ${wait}s`;
      const timer=setInterval(()=>{wait--;if(wait<=0){clearInterval(timer);button.disabled=false;button.textContent='Resend the link';}else button.textContent=`Resend in ${wait}s`;},1000);
    } catch(e){
      status.textContent=e.name==='TimeoutError'||e.name==='TypeError'?'Could not reach the sign-in service. Check your connection and try again.':e.message;
      button.disabled=false;button.textContent='Email me a sign-in link';
    }
  };
  return false;
}
async function signOut(){
  const token=session?.access_token;
  session=null;storeSession(null);
  // Revoke the refresh token server-side; local sign-out still completes if this fails.
  if(token&&!IS_DEV){ try { await fetch(SB_URL+'/auth/v1/logout',{method:'POST',headers:{apikey:SB_KEY,Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)}); } catch {} }
  location.replace('./index.html');
}
// Sign-out in another tab, or Back into a page restored from the bfcache after sign-out,
// must not keep showing private data.
addEventListener('storage',e=>{ if(e.key===SESSION_KEY&&!e.newValue&&session){ session=null; location.reload(); } });
addEventListener('pageshow',e=>{ if(e.persisted&&!IS_DEV){ let stored=null; try{stored=localStorage.getItem(SESSION_KEY);}catch{} if(!!stored!==!!session) location.reload(); } });
