/* Small passwordless Supabase Auth client for the static GitHub Pages site. */
const IS_DEV = ['localhost','127.0.0.1'].includes(location.hostname);
const SESSION_KEY = 'ticketline.session.v1';
let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { localStorage.removeItem(SESSION_KEY); }
const callback = new URLSearchParams(location.hash.slice(1));
if (callback.has('access_token') && callback.has('refresh_token')) {
  session = {access_token:callback.get('access_token'),refresh_token:callback.get('refresh_token'),
    expires_at:Date.now()+Number(callback.get('expires_in')||3600)*1000};
  localStorage.setItem(SESSION_KEY,JSON.stringify(session));
  history.replaceState(null,'',location.pathname+location.search);
}
async function accessToken(){
  if(IS_DEV) return null;
  if(!session) return null;
  if(session.expires_at>Date.now()+60000) return session.access_token;
  const r=await fetch(SB_URL+'/auth/v1/token?grant_type=refresh_token',{
    method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({refresh_token:session.refresh_token})});
  if(!r.ok){session=null;localStorage.removeItem(SESSION_KEY);return null;}
  const next=await r.json();
  session={access_token:next.access_token,refresh_token:next.refresh_token,
    expires_at:Date.now()+next.expires_in*1000};
  localStorage.setItem(SESSION_KEY,JSON.stringify(session));
  return session.access_token;
}
async function requireSession(){
  if(IS_DEV || await accessToken()) return true;
  const main=document.querySelector('#main');
  main.innerHTML='<div class="container page auth-page"><h1>Sign in to your alerts.</h1><p>Enter your email for a secure sign-in link.</p><form id="sign-in-form"><label class="field-label" for="sign-in-email">Email</label><input id="sign-in-email" type="email" autocomplete="email" required><button class="button primary" type="submit">Email me a sign-in link</button></form><p id="sign-in-status" role="status"></p></div>';
  document.querySelector('#sign-in-form').onsubmit=async event=>{
    event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
    const email=document.querySelector('#sign-in-email').value.trim();
    try {
      const redirect=location.origin+location.pathname+location.search;
      const r=await fetch(SB_URL+'/auth/v1/otp?redirect_to='+encodeURIComponent(redirect),{
        method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({email,create_user:true})});
      if(!r.ok) throw new Error('Could not send the sign-in link. Please try again.');
      document.querySelector('#sign-in-status').textContent='Check your email for the sign-in link.';
    } catch(e){document.querySelector('#sign-in-status').textContent=e.message;button.disabled=false;}
  };
  return false;
}
function signOut(){session=null;localStorage.removeItem(SESSION_KEY);location.reload();}
