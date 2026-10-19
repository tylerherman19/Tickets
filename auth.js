/* Small passwordless Supabase Auth client for the static GitHub Pages site. */
const IS_DEV = ['localhost','127.0.0.1'].includes(location.hostname);
const SESSION_KEY = 'ticketline.session.v1';
const PENDING_SIGN_IN_KEY = 'ticketline.pending-sign-in.v1';
const validSignInEmail = email => typeof email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
function pendingSignIn(){
  try {
    const pending=JSON.parse(localStorage.getItem(PENDING_SIGN_IN_KEY));
    if(pending&&validSignInEmail(pending.email)&&Number.isFinite(pending.requested_at)&&pending.requested_at<=Date.now()&&Date.now()-pending.requested_at<3600000) return pending;
  } catch {}
  rememberSignIn(null);return null;
}
function rememberSignIn(value){
  try {value?localStorage.setItem(PENDING_SIGN_IN_KEY,JSON.stringify(value)):localStorage.removeItem(PENDING_SIGN_IN_KEY);}catch{}
}
let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { try { localStorage.removeItem(SESSION_KEY); } catch {} }
if (session && (typeof session.access_token!=='string' || typeof session.refresh_token!=='string')) session = null;
const storeSession = value => { try { value ? localStorage.setItem(SESSION_KEY,JSON.stringify(value)) : localStorage.removeItem(SESSION_KEY); } catch {} };
const callback = new URLSearchParams(location.hash.slice(1));
if (callback.has('access_token') && callback.has('refresh_token')) {
  session = {access_token:callback.get('access_token'),refresh_token:callback.get('refresh_token'),
    expires_at:Date.now()+Number(callback.get('expires_in')||3600)*1000};
  storeSession(session);rememberSignIn(null);
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
  if(!['explore','event','coverage','privacy','notfound'].includes(document.body.dataset.page)) setTimeout(()=>location.reload(),0);
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
  main.innerHTML=`<div class="container page auth-page"><h1>Sign in to your alerts.</h1>${notice?`<p class="notice subtle" role="status">${esc(notice)}</p>`:''}<p>Enter your email for a secure sign-in link and a 6-digit code. You can browse ticket prices without signing in.</p><p>Price alerts are emailed to this address by default. You can add carrier email-to-text when creating an alert.</p><form id="sign-in-form" novalidate><label class="field-label" for="sign-in-email">Email</label><input id="sign-in-email" type="email" autocomplete="email" maxlength="254" required aria-describedby="sign-in-status"><button class="button primary" type="submit">Email me a sign-in link</button></form><p id="sign-in-status" role="status" aria-live="polite"></p><p id="sign-in-recipient" class="field-help" hidden></p><button id="use-existing-code" class="text-button" type="button">I already have a code</button><form id="verify-code-form" hidden novalidate><label class="field-label" for="sign-in-code">6-digit code</label><input id="sign-in-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required aria-describedby="verify-code-status"><button class="button primary" type="submit">Verify code</button><p id="verify-code-status" role="status" aria-live="polite"></p><button id="resend-sign-in-code" class="text-button" type="button">Send a new code</button><button id="change-sign-in-email" class="text-button" type="button">Use a different email</button></form><p class="field-help">By signing in you agree to the <a class="text-link" href="./privacy.html">privacy policy</a>.</p></div>`;
  const form=document.querySelector('#sign-in-form'),status=document.querySelector('#sign-in-status'),button=form.querySelector('button');
  const codeForm=document.querySelector('#verify-code-form'),codeInput=document.querySelector('#sign-in-code'),codeStatus=document.querySelector('#verify-code-status'),verifyButton=codeForm.querySelector('button');
  const emailInput=document.querySelector('#sign-in-email'),recipient=document.querySelector('#sign-in-recipient'),existingCode=document.querySelector('#use-existing-code');
  const pending=pendingSignIn();
  let pendingEmail=pending?.email||null;
  function showCode(email){
    pendingEmail=email;emailInput.value=email;form.hidden=true;codeForm.hidden=false;existingCode.hidden=true;
    recipient.hidden=false;recipient.textContent='Enter the code sent to '+email+'. You can also click the sign-in link in that email.';
    codeInput.value='';codeStatus.textContent='';codeInput.focus();
  }
  const resend=document.querySelector('#resend-sign-in-code');
  let cooldownTimer=null;
  function cooldown(requestedAt){
    if(cooldownTimer)clearInterval(cooldownTimer);
    const tick=()=>{
      const wait=Math.max(0,Math.ceil((requestedAt+60000-Date.now())/1000));
      button.disabled=resend.disabled=wait>0;
      button.textContent=wait?`Resend in ${wait}s`:'Email me a sign-in link';
      resend.textContent=wait?`Send a new code in ${wait}s`:'Send a new code';
      if(!wait&&cooldownTimer){clearInterval(cooldownTimer);cooldownTimer=null;}
    };
    tick();if(button.disabled)cooldownTimer=setInterval(tick,1000);
  }
  resend.onclick=()=>{if(!resend.disabled)form.requestSubmit();};
  if(pendingEmail){showCode(pendingEmail);cooldown(pending.requested_at);}
  existingCode.onclick=()=>{
    const email=emailInput.value.trim().toLowerCase();
    if(!validSignInEmail(email)){status.textContent='Enter the email address that received your code.';emailInput.focus();return;}
    rememberSignIn({email,requested_at:Date.now()});showCode(email);status.textContent='';
  };
  document.querySelector('#change-sign-in-email').onclick=()=>{
    pendingEmail=null;rememberSignIn(null);form.hidden=false;codeForm.hidden=true;recipient.hidden=true;existingCode.hidden=false;
    codeInput.value='';codeStatus.textContent='';status.textContent='';emailInput.focus();
  };
  codeForm.onsubmit=async event=>{
    event.preventDefault();
    if(verifyButton.disabled) return;
    const email=pendingEmail;
    if(!validSignInEmail(email)){codeStatus.textContent='Start with your email address to request a code.';return;}
    const token=codeInput.value.trim();
    if(!/^[0-9]{6}$/.test(token)){codeStatus.textContent='Enter the 6-digit code from your email.';codeInput.focus();return;}
    verifyButton.disabled=true;verifyButton.textContent='Verifying…';codeStatus.textContent='';
    try {
      const r=await fetch(SB_URL+'/auth/v1/verify',{
        method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({type:'email',email,token}),signal:AbortSignal.timeout(15000)});
      const next=await r.json();
      if(!r.ok){
        if(r.status===429) throw new Error('Too many attempts. Wait a minute, then try again.');
        if(r.status>=500) throw new Error('The sign-in service is temporarily unavailable. Please try again shortly.');
        // Supabase uses otp_expired for both invalid and expired codes.
        if(next.error_code==='otp_expired'||next.code==='otp_expired') throw new Error('That code is incorrect, expired, or already used. Use the newest email. If you already clicked its sign-in link, request a new email.');
        throw new Error('That code could not be verified. Check the 6 digits in your latest email and try again.');
      }
      if(typeof next.access_token!=='string'||typeof next.refresh_token!=='string') throw new Error('Sign-in could not be completed. Please request a new sign-in email.');
      session={access_token:next.access_token,refresh_token:next.refresh_token,expires_at:Date.now()+Number(next.expires_in||3600)*1000};
      storeSession(session);rememberSignIn(null);
      location.reload();
    } catch(e){
      codeStatus.textContent=e.name==='TimeoutError'||e.name==='TypeError'?'Could not reach the sign-in service. Check your connection and try again.':e.message;
    } finally {verifyButton.disabled=false;verifyButton.textContent='Verify code';}
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    if(button.disabled) return;
    const email=document.querySelector('#sign-in-email').value.trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){status.textContent='Enter a valid email address.';document.querySelector('#sign-in-email').focus();return;}
    button.disabled=resend.disabled=true;button.textContent=resend.textContent='Sending…';
    try {
      const destination=location.pathname+location.search;
      const redirect=new URL('./auth-callback.html',location.href);
      redirect.searchParams.set('next',destination);
      const r=await fetch(SB_URL+'/auth/v1/otp?redirect_to='+encodeURIComponent(redirect.href),{
        method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({email,create_user:true}),signal:AbortSignal.timeout(15000)});
      if(r.status===429) throw new Error('Too many sign-in requests. Wait a minute, then try again.');
      if(!r.ok) throw new Error('Could not send the sign-in link. Please try again.');
      // Same message whether or not the address already has an account.
      status.textContent='Check your email. Click the sign-in link or enter the 6-digit code below. Use the newest email.';
      const requestedAt=Date.now();rememberSignIn({email,requested_at:requestedAt});showCode(email);cooldown(requestedAt);
    } catch(e){
      status.textContent=e.name==='TimeoutError'||e.name==='TypeError'?'Could not reach the sign-in service. Check your connection and try again.':e.message;
      button.disabled=resend.disabled=false;button.textContent='Email me a sign-in link';resend.textContent='Send a new code';
    }
  };
  return false;
}
async function signOut(){
  const token=session?.access_token;
  session=null;storeSession(null);rememberSignIn(null);
  // Revoke the refresh token server-side; local sign-out still completes if this fails.
  if(token&&!IS_DEV){ try { await fetch(SB_URL+'/auth/v1/logout',{method:'POST',headers:{apikey:SB_KEY,Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)}); } catch {} }
  location.replace('./index.html');
}
// Sign-out in another tab, or Back into a page restored from the bfcache after sign-out,
// must not keep showing private data.
addEventListener('storage',e=>{
  if(e.key!==SESSION_KEY)return;
  if(!e.newValue&&session){session=null;location.reload();return;}
  // An email link often opens a new tab. Resume the original sign-in tab too.
  if(e.newValue&&!session){
    try {
      const next=JSON.parse(e.newValue);
      if(typeof next?.access_token==='string'&&typeof next?.refresh_token==='string'){session=next;location.reload();}
    } catch {}
  }
});
addEventListener('pageshow',e=>{ if(e.persisted&&!IS_DEV){ let stored=null; try{stored=localStorage.getItem(SESSION_KEY);}catch{} if(!!stored!==!!session) location.reload(); } });
