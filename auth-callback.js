/* Finish the email link before loading the destination page. Never accept an external redirect. */
(async()=>{
  const next=new URLSearchParams(location.search).get('next');
  const fallback=new URL('./watches.html',location.href);
  let destination=fallback;
  try {
    const candidate=new URL(next||fallback.href,location.href);
    const root=new URL('./',location.href);
    const allowed=['index.html','watches.html','new.html','ledger.html','notifications.html','event.html','admin.html'];
    if(candidate.origin===root.origin&&candidate.pathname.startsWith(root.pathname)&&allowed.includes(candidate.pathname.slice(root.pathname.length))) destination=candidate;
  }catch{}
  if(session){
    try {
      if(await accessToken()){location.replace(destination.pathname+destination.search);return;}
    }catch{}
  }
  const notice=sessionStorage.getItem('ticketline.auth-error');
  const message=notice?'This sign-in link is expired, already used, or could not be verified. Request a new email.':'The email link did not include the sign-in details. Open the newest Ticketline email and try its link, or enter its code.';
  document.querySelector('#main').innerHTML=`<div class="container page auth-page"><h1>We couldn’t finish signing you in.</h1><p role="alert">${esc(message)}</p><a class="button primary" href="${esc(destination.pathname+destination.search)}">Return to sign-in</a></div>`;
})();
