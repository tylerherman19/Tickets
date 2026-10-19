const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
const source=fs.readFileSync('auth.js','utf8');
const pendingKey='ticketline.pending-sign-in.v1';
function setup({url='https://ticketline.example/watches.html',pending=null,callbackPage=false,fetchResponse=null,storageDenied=false}={}){
 let reloads=0;const virtualConsole=new VirtualConsole();
 virtualConsole.on('jsdomError',error=>{if(error.message==='Not implemented: navigation (except hash changes)') reloads++;else throw error;});
 const dom=new JSDOM('<body data-page="watches"><main id="main"></main>',{url,runScripts:'outside-only',virtualConsole});
 const w=dom.window,calls=[];
 w.SB_URL='https://auth.example';w.SB_KEY='public';w.esc=s=>String(s).replaceAll('<','&lt;');
 w.AbortSignal=AbortSignal;w.setInterval=()=>1;
 if(storageDenied){const original=w.Storage.prototype.setItem;w.Storage.prototype.setItem=function(key,value){if(key==='ticketline.session.v1')throw new Error('Storage blocked');return original.call(this,key,value);};}
 if(pending)w.localStorage.setItem(pendingKey,JSON.stringify(pending));
 w.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return fetchResponse||{ok:true,status:200,json:async()=>({})};};
 w.eval(source+(callbackPage?'\n'+fs.readFileSync('auth-callback.js','utf8'):''));return {w,calls,reloads:()=>reloads,close:()=>w.close()};
}
const field=(w,id)=>w.document.querySelector('#'+id);
async function request(w,email='owner@example.test'){
 field(w,'sign-in-email').value=email;
 await field(w,'sign-in-form').onsubmit({preventDefault(){}});
}
async function verify(w,token){
 field(w,'sign-in-code').value=token;
 await field(w,'verify-code-form').onsubmit({preventDefault(){}});
}
test('requesting an email advances to a code-only form, remembers the address and binds verification to it',async()=>{
 const {w,calls,close}=setup();try{
 await w.requireSession();assert.equal(field(w,'verify-code-form').hidden,true);
 await request(w);assert.equal(field(w,'verify-code-form').hidden,false);assert.equal(field(w,'sign-in-form').hidden,true);
 assert.equal(JSON.parse(w.localStorage.getItem(pendingKey)).email,'owner@example.test');
 assert.match(field(w,'sign-in-recipient').textContent,/owner@example.test/);
 field(w,'sign-in-email').value='different@example.test';
 await verify(w,'123');assert.equal(calls.length,1);
 await verify(w,'012345');assert.deepEqual(calls[1],{url:'https://auth.example/auth/v1/verify',body:{type:'email',email:'owner@example.test',token:'012345'}});
 }finally{close();}
});
test('returning in the same browser restores only the code step without sending an email',async()=>{
 const {w,calls,close}=setup({pending:{email:'remembered@example.test',requested_at:Date.now()}});try{
 await w.requireSession();assert.equal(field(w,'sign-in-form').hidden,true);assert.equal(field(w,'verify-code-form').hidden,false);
 assert.equal(calls.length,0);
 await verify(w,'123456');assert.deepEqual(calls[0].body,{type:'email',email:'remembered@example.test',token:'123456'});
 }finally{close();}
});
test('changing the address clears the old code context without sending another email',async()=>{
 const {w,calls,close}=setup({pending:{email:'old@example.test',requested_at:Date.now()-61000}});try{
 await w.requireSession();field(w,'change-sign-in-email').click();
 assert.equal(field(w,'sign-in-form').hidden,false);assert.equal(field(w,'verify-code-form').hidden,true);
 assert.equal(w.localStorage.getItem(pendingKey),null);assert.equal(calls.length,0);
 await request(w,'new@example.test');await verify(w,'123456');assert.equal(calls[1].body.email,'new@example.test');
 }finally{close();}
});
test('expired, future or malformed remembered addresses do not trap users in the code step',async()=>{
 for(const pending of [{email:'old@example.test',requested_at:Date.now()-3600001},{email:'future@example.test',requested_at:Date.now()+60000},{email:'invalid',requested_at:Date.now()}]){
 const {w,calls,close}=setup({pending});try{
 await w.requireSession();assert.equal(field(w,'sign-in-form').hidden,false);assert.equal(w.localStorage.getItem(pendingKey),null);assert.equal(calls.length,0);
 }finally{close();}}
});
test('wrong, used or expired code leaves the code-only step retryable',async()=>{
 const {w,close}=setup();try{
 await w.requireSession();await request(w);
 w.fetch=async()=>({ok:false,status:403,json:async()=>({error_code:'otp_expired'})});await verify(w,'123456');
 assert.match(field(w,'verify-code-status').textContent,/incorrect, expired, or already used/);
 assert.equal(field(w,'verify-code-form').querySelector('button').disabled,false);assert.equal(field(w,'sign-in-form').hidden,true);
 assert.equal(w.localStorage.getItem('ticketline.session.v1'),null);
 }finally{close();}
});
test('successful code verification stores a session, clears the pending email and reloads',async()=>{
 const {w,reloads,close}=setup();try{
 await w.requireSession();await request(w);
 w.fetch=async()=>({ok:true,status:200,json:async()=>({access_token:'access',refresh_token:'refresh',expires_in:3600})});await verify(w,'123456');
 const session=JSON.parse(w.localStorage.getItem('ticketline.session.v1'));
 assert.equal(session.access_token,'access');assert.equal(session.refresh_token,'refresh');assert.ok(session.expires_at>Date.now());assert.equal(reloads(),1);
 assert.equal(w.localStorage.getItem(pendingKey),null);
 }finally{close();}
});
test('failed sends do not remember an address and verification network failures stay retryable',async()=>{
 const {w,close}=setup();try{
 await w.requireSession();w.fetch=async()=>({ok:false,status:500});await request(w);
 assert.equal(field(w,'sign-in-form').hidden,false);assert.equal(w.localStorage.getItem(pendingKey),null);
 w.fetch=async()=>({ok:true,status:200});await request(w);
 w.fetch=async()=>{throw new TypeError('offline');};await verify(w,'123456');
 assert.match(field(w,'verify-code-status').textContent,/Check your connection/);
 assert.equal(field(w,'verify-code-form').querySelector('button').disabled,false);
 }finally{close();}
});
test('an existing email from another browser can be used explicitly without sending a new email',async()=>{
 const {w,calls,close}=setup();try{
 await w.requireSession();field(w,'use-existing-code').click();assert.equal(calls.length,0);
 assert.match(field(w,'sign-in-status').textContent,/email address that received/);
 field(w,'sign-in-email').value=' Owner@Example.Test ';field(w,'use-existing-code').click();
 assert.equal(field(w,'sign-in-form').hidden,true);assert.equal(calls.length,0);
 await verify(w,'012345');assert.deepEqual(calls[0],{url:'https://auth.example/auth/v1/verify',body:{type:'email',email:'owner@example.test',token:'012345'}});
 }finally{close();}
});
test('email link callback saves the session before the protected page loads and removes tokens and pending code context',async()=>{
 const {w,calls,close}=setup({url:'https://ticketline.example/watches.html#access_token=link-access&refresh_token=link-refresh&expires_in=3600',pending:{email:'pending@example.test',requested_at:Date.now()}});try{
 assert.equal(await w.requireSession(),true);
 const stored=JSON.parse(w.localStorage.getItem('ticketline.session.v1'));
 assert.equal(stored.access_token,'link-access');assert.equal(stored.refresh_token,'link-refresh');
 assert.equal(w.location.hash,'');assert.equal(calls.length,0);assert.equal(w.localStorage.getItem(pendingKey),null);
 }finally{close();}
});

test('resending uses the remembered email and enforces the send cooldown without exposing the email form',async()=>{
 const {w,calls,close}=setup({pending:{email:'remembered@example.test',requested_at:Date.now()-61000}});try{
 await w.requireSession();const resend=field(w,'resend-sign-in-code');assert.equal(resend.disabled,false);
 resend.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);assert.match(calls[0].url,/auth\/v1\/otp/);assert.equal(calls[0].body.email,'remembered@example.test');
 assert.equal(field(w,'sign-in-form').hidden,true);assert.equal(resend.disabled,true);
 resend.click();assert.equal(calls.length,1);
 }finally{close();}
});

test('signing in through an email link in another tab resumes the original sign-in tab',async()=>{
 const {w,reloads,close}=setup();try{
 await w.requireSession();
 w.dispatchEvent(new w.StorageEvent('storage',{key:'ticketline.session.v1',newValue:JSON.stringify({access_token:'other-tab-access',refresh_token:'other-tab-refresh',expires_at:Date.now()+3600000})}));
 assert.equal(reloads(),1);assert.equal(await w.requireSession(),true);
 }finally{close();}
});


test('email requests use the dedicated callback and preserve the requested page without credentials',async()=>{
 const {w,calls,close}=setup({url:'https://ticketline.example/Tickets/new.html?event=abc&qty=2'});try{
 await w.requireSession();await request(w);
 const redirect=new URL(new URL(calls[0].url).searchParams.get('redirect_to'));
 assert.equal(redirect.pathname,'/Tickets/auth-callback.html');
 assert.equal(redirect.searchParams.get('next'),'/Tickets/new.html?event=abc&qty=2');
 assert.equal(redirect.hash,'');
 }finally{close();}
});

test('dedicated email callback opens the protected page only after storing the session',async()=>{
 const {w,reloads,close}=setup({url:'https://ticketline.example/Tickets/auth-callback.html?next=%2FTickets%2Fnew.html%3Fevent%3Dabc#access_token=link-access&refresh_token=link-refresh&expires_in=3600',callbackPage:true});try{
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reloads(),1);
 assert.equal(JSON.parse(w.localStorage.getItem('ticketline.session.v1')).access_token,'link-access');
 assert.equal(w.location.hash,'');
 }finally{close();}
});

test('dedicated callback explains an expired link instead of silently showing an email form',async()=>{
 const {w,reloads,close}=setup({url:'https://ticketline.example/Tickets/auth-callback.html?next=https%3A%2F%2Fevil.example# error=access_denied&error_description=Expired'.replace('# ','#'),callbackPage:true});try{
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reloads(),0);
 assert.match(w.document.querySelector('[role="alert"]').textContent,/expired, already used/);
 assert.equal(w.document.querySelector('a').getAttribute('href'),'/Tickets/watches.html');
 assert.equal(w.location.hash,'');
 }finally{close();}
});

const linkHash='a'.repeat(64);
function directEmailLink({encoded=false,origin='https://auth.example',type='magiclink',next='/Tickets/new.html?event=abc&qty=2'}={}){
 const redirect=new URL('https://ticketline.example/Tickets/auth-callback.html');redirect.searchParams.set('next',next);
 const confirmation=new URL(origin+'/auth/v1/verify');confirmation.searchParams.set('token',linkHash);confirmation.searchParams.set('type',type);confirmation.searchParams.set('redirect_to',redirect.href);
 return 'https://ticketline.example/Tickets/auth-callback.html#confirmation_url='+(encoded?encodeURIComponent(confirmation.href):confirmation.href);
}
test('direct email links verify once without an email or code, save the session, and scrub the link',async()=>{
 for(const encoded of [false,true]){
 const {w,calls,reloads,close}=setup({url:directEmailLink({encoded}),callbackPage:true,pending:{email:'owner@example.test',requested_at:Date.now()},fetchResponse:{ok:true,status:200,json:async()=>({access_token:'direct-access',refresh_token:'direct-refresh',expires_in:3600})}});try{
 assert.equal(w.location.hash,'');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,[{url:'https://auth.example/auth/v1/verify',body:{type:'email',token_hash:linkHash}}]);
 assert.equal(JSON.parse(w.localStorage.getItem('ticketline.session.v1')).access_token,'direct-access');
 assert.equal(w.localStorage.getItem(pendingKey),null);assert.equal(reloads(),1);
 }finally{close();}}
});
test('direct expired links show a clear five-minute expiry message and never sign in',async()=>{
 const {w,calls,reloads,close}=setup({url:directEmailLink({type:'signup'}),callbackPage:true,fetchResponse:{ok:false,status:403,json:async()=>({error_code:'otp_expired'})}});try{
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);assert.equal(reloads(),0);assert.equal(w.localStorage.getItem('ticketline.session.v1'),null);
 assert.match(w.document.querySelector('[role="alert"]').textContent,/expire after 5 minutes/);assert.equal(w.location.hash,'');
 }finally{close();}
});
test('foreign verification services and non-login link types are rejected without a request',async()=>{
 for(const url of [directEmailLink({origin:'https://evil.example'}),directEmailLink({type:'recovery'})]){
 const {w,calls,reloads,close}=setup({url,callbackPage:true});try{
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);assert.equal(reloads(),0);
 assert.match(w.document.querySelector('[role="alert"]').textContent,/not valid/);assert.equal(w.location.hash,'');
 }finally{close();}}
});
test('untrusted destination inside a valid email link stays on Ticketline after an error',async()=>{
 const {w,close}=setup({url:directEmailLink({next:'https://evil.example'}),callbackPage:true,fetchResponse:{ok:false,status:403,json:async()=>({})}});try{
 await new Promise(resolve=>setImmediate(resolve));assert.equal(w.document.querySelector('a').getAttribute('href'),'/Tickets/watches.html');
 }finally{close();}
});


test('blocked browser storage shows a useful error instead of redirecting back to the email form',async()=>{
 const {w,reloads,close}=setup({url:directEmailLink(),callbackPage:true,storageDenied:true,fetchResponse:{ok:true,status:200,json:async()=>({access_token:'direct-access',refresh_token:'direct-refresh',expires_in:3600})}});try{
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reloads(),0);
 assert.match(w.document.querySelector('[role="alert"]').textContent,/Allow website data/);
 assert.equal(w.localStorage.getItem('ticketline.session.v1'),null);
 }finally{close();}
});
