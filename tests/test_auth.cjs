const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync('auth.js','utf8');
function setup(){
 const dom=new JSDOM('<body data-page="watches"><main id="main"></main>',{url:'https://ticketline.example/watches.html',runScripts:'outside-only'});
 const w=dom.window,calls=[];
 w.SB_URL='https://auth.example';w.SB_KEY='public';w.esc=s=>String(s).replaceAll('<','&lt;');
 w.AbortSignal=AbortSignal;w.setInterval=()=>1;
 w.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,status:200,json:async()=>({})};};
 w.eval(source);return {w,calls,close:()=>w.close()};
}
async function request(w,email='owner@example.test'){
 w.document.querySelector('#sign-in-email').value=email;
 await w.document.querySelector('#sign-in-form').onsubmit({preventDefault(){}});
}
async function verify(w,token){
 w.document.querySelector('#sign-in-code').value=token;
 await w.document.querySelector('#verify-code-form').onsubmit({preventDefault(){}});
}
test('code entry appears only after a successful email request and binds to that address',async()=>{
 const {w,calls,close}=setup();try{
 await w.requireSession();assert.equal(w.document.querySelector('#verify-code-form').hidden,true);
 await request(w);assert.equal(w.document.querySelector('#verify-code-form').hidden,false);
 w.document.querySelector('#sign-in-email').value='different@example.test';
 await verify(w,'123');assert.equal(calls.length,1);
 await verify(w,'012345');assert.deepEqual(calls[1],{url:'https://auth.example/auth/v1/verify',body:{type:'email',email:'owner@example.test',token:'012345'}});
 assert.equal(w.localStorage.getItem('ticketline.session.v1'),null);
 }finally{close();}
});
test('wrong or expired code has an actionable error and permits another attempt',async()=>{
 const {w,close}=setup();try{
 await w.requireSession();await request(w);
 w.fetch=async()=>({ok:false,status:403,json:async()=>({error_code:'otp_expired'})});
 await verify(w,'123456');
 assert.match(w.document.querySelector('#verify-code-status').textContent,/incorrect or has expired/);
 assert.equal(w.document.querySelector('#verify-code-form button').disabled,false);
 assert.equal(w.localStorage.getItem('ticketline.session.v1'),null);
 }finally{close();}
});
test('successful code verification stores the same session fields as a link callback',async()=>{
 const {w,close}=setup();try{
 await w.requireSession();await request(w);
 w.fetch=async()=>({ok:true,status:200,json:async()=>({access_token:'access',refresh_token:'refresh',expires_in:3600})});
 await verify(w,'123456');
 const session=JSON.parse(w.localStorage.getItem('ticketline.session.v1'));
 assert.equal(session.access_token,'access');assert.equal(session.refresh_token,'refresh');assert.ok(session.expires_at>Date.now());
 }finally{close();}
});
test('failed email request does not reveal code entry; network failures stay retryable',async()=>{
 const {w,close}=setup();try{
 await w.requireSession();w.fetch=async()=>({ok:false,status:500});await request(w);
 assert.equal(w.document.querySelector('#verify-code-form').hidden,true);
 w.fetch=async()=>({ok:true,status:200});await request(w);
 w.fetch=async()=>{throw new TypeError('offline');};await verify(w,'123456');
 assert.match(w.document.querySelector('#verify-code-status').textContent,/Check your connection/);
 assert.equal(w.document.querySelector('#verify-code-form button').disabled,false);
 }finally{close();}
});
