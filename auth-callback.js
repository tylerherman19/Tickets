/* Complete email links here before opening the app. Credentials stay in the fragment. */
(async()=>{
  const fallback=new URL('./watches.html',location.href);
  const root=new URL('./',location.href);
  function localDestination(value){
    try {
      const candidate=new URL(value||fallback.href,location.href);
      const allowed=['index.html','watches.html','new.html','ledger.html','notifications.html','event.html','admin.html'];
      if(candidate.origin===root.origin&&candidate.pathname.startsWith(root.pathname)&&allowed.includes(candidate.pathname.slice(root.pathname.length))) return candidate;
    }catch{}
    return fallback;
  }
  let destination=localDestination(new URLSearchParams(location.search).get('next'));
  const prefix='#confirmation_url=';
  let failure=null;
  if(location.hash.startsWith(prefix)){
    let raw=location.hash.slice(prefix.length);
    // Remove the one-time credential before any requests or navigation.
    history.replaceState(null,'',location.pathname+location.search);
    try {
      if(!raw.startsWith('https://')) raw=decodeURIComponent(raw);
      const confirmation=new URL(raw);
      const expected=new URL(SB_URL);
      const hash=confirmation.searchParams.get('token');
      if(confirmation.origin!==expected.origin||confirmation.pathname!=='/auth/v1/verify'||!['email','magiclink','signup'].includes(confirmation.searchParams.get('type'))||!hash||!/^[a-zA-Z0-9_-]{20,512}$/.test(hash)) throw new Error('This sign-in link is not valid. Please request a new email.');
      const redirect=confirmation.searchParams.get('redirect_to');
      if(redirect){
        const target=new URL(redirect);
        if(target.origin===root.origin&&target.pathname===location.pathname) destination=localDestination(target.searchParams.get('next'));
      }
      const response=await fetch(SB_URL+'/auth/v1/verify',{
        method:'POST',headers:{apikey:SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({type:'email',token_hash:hash}),signal:AbortSignal.timeout(15000)});
      const next=await response.json();
      if(!response.ok){
        if(response.status===429) throw new Error('Too many attempts. Wait a minute, then request a new sign-in email.');
        if(response.status>=500) throw new Error('The sign-in service is temporarily unavailable. Please try again shortly.');
        throw new Error('This sign-in link has expired or was already used. Request a new email. Links and codes expire after 5 minutes.');
      }
      if(typeof next.access_token!=='string'||typeof next.refresh_token!=='string') throw new Error('Sign-in could not be completed. Please request a new sign-in email.');
      session={access_token:next.access_token,refresh_token:next.refresh_token,expires_at:Date.now()+Number(next.expires_in||3600)*1000};
      if(!storeSession(session)){session=null;throw new Error('Your browser could not keep you signed in. Allow website data for Ticketline, then try again.');}rememberSignIn(null);
      sessionStorage.removeItem('ticketline.auth-error');
      location.replace(destination.pathname+destination.search);return;
    }catch(e){
      failure=e.name==='TypeError'||e.name==='TimeoutError'?'Could not reach the sign-in service. Check your connection and try the email link again.':e.message;
    }
  }
  // Continue to accept links sent before direct verification was introduced.
  if(!failure&&session){
    try {if(await accessToken()){location.replace(destination.pathname+destination.search);return;}}catch{}
  }
  const notice=sessionStorage.getItem('ticketline.auth-error');
  const message=failure||(notice?'This sign-in link is expired, already used, or could not be verified. Request a new email.':'The email link did not include the sign-in details. Open the newest Ticketline email and try its link, or enter its code.');
  document.querySelector('#main').innerHTML=`<div class="container page auth-page"><h1>We couldn’t finish signing you in.</h1><p role="alert">${esc(message)}</p><a class="button primary" href="${esc(destination.pathname+destination.search)}">Return to sign-in</a></div>`;
})();
