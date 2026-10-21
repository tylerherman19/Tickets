import {test} from 'node:test';
import assert from 'node:assert/strict';
// Provider calls are mocked. Never contact Gametime from this test machine.
const env={SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'service',SUPABASE_ANON_KEY:'anon'};
globalThis.Deno={env:{get:key=>env[key]},serve:()=>{}};
const background=[];
globalThis.EdgeRuntime={waitUntil:work=>background.push(work)};
const {handleRequest}=await import('../supabase/functions/ticketline-prices/index.ts');
const id='aaaaaaaaaaaaaaaaaaaaaaaa';
const ids=Array.from({length:6},(_,n)=>String(n+1).repeat(24).slice(0,24).replace(/[^a-f0-9]/g,'b'));
function request(body={event_id:id},headers={}){return new Request('https://edge.invalid',{method:'POST',headers:{authorization:'Bearer user','Content-Type':'application/json',origin:'https://tylerherman19.github.io',...headers},body:JSON.stringify(body)});}
const response=(body,status=200)=>Response.json(body,{status});
const page=eventId=>'window.__data='+JSON.stringify({redux:{data:{fullEvents:{events:{[eventId]:{event:{id:eventId,minPrice:{total:1234},performers:[{seoUrl:'https://gametime.co/minnesota-vikings-tickets/performers/nflmin'}]}}}}}}});
const moved=eventId=>'https://gametime.co/nfl-football/bills-at-vikings-tickets/11-8-2026-minneapolis-mn-u-s-bank-stadium/events/'+eventId;
function mockFetch({quotes=[],quoteAllowed=true,user=true,claim=()=>({state:'checking',token:'lease'}),admitted=()=>true,providerStatus=()=>200,providerHeaders=()=>({}),
 noteRedirect=body=>response(body.p_location?{state:'queued',reason:'url_moved',next_attempt_at:'2026-10-16T00:00:00Z'}:{state:'failed',reason:'redirected',next_attempt_at:'2026-10-16T06:00:00Z'})}={}){
 const calls=[];let inFlight=0;calls.maxInFlight=0;
 globalThis.fetch=async(url,options)=>{
  calls.push({url,options});
  const body=options?.body?JSON.parse(options.body):{};
  if(url.endsWith('/auth/v1/user'))return response(user?{id:'owner'}:{},user?200:401);
  if(url.includes('/rpc/tix_public_quotes'))return response(quotes);
  if(url.includes('/rpc/tix_request_quote'))return response({allowed:quoteAllowed,reason:'caller_limit'});
  if(url.includes('/rpc/tix_request_capture'))return response({state:'queued',tracked:true});
  if(url.includes('/rpc/tix_claim_capture')){const c=claim(body.p_event_id);return response(c.state==='checking'?{...c,token:'lease-'+body.p_event_id}:c);}
  if(url.includes('/tix_events_v')){const list=decodeURIComponent(url).match(/in\.\(([^)]*)\)/)[1].split(',');return response(list.map(e=>({event_id:e,url:'https://gametime.co/events/'+e})));}
  if(url.includes('/rpc/tix_admit_provider_http'))return response(admitted(body.p_token)?{allowed:true}:{allowed:false,reason:'request_limit',next_attempt_at:'2026-10-16T00:01:00Z'});
  if(url.includes('/rpc/tix_finish_capture'))return response('observation');
  if(url.includes('/rpc/tix_note_redirect'))return noteRedirect(body);
  if(url.includes('/rpc/'))return response(null);
  if(url.startsWith('https://gametime.co/')){
   const eventId=new URL(url).pathname.split('/').at(-1);inFlight++;calls.maxInFlight=Math.max(calls.maxInFlight,inFlight);
   await new Promise(r=>setTimeout(r,5));inFlight--;
   return new Response(page(eventId),{status:providerStatus(eventId),headers:providerHeaders(eventId)});
  }
  throw Error('Unexpected network destination '+url);
 };return calls;
}
const providerCalls=calls=>calls.filter(c=>c.url.startsWith('https://gametime.co/'));
test('invalid auth and origins never request provider or write tracking',async()=>{
 const calls=mockFetch({user:false});assert.equal((await handleRequest(request())).status,401);
 assert.equal(calls.length,1);
 assert.equal((await handleRequest(request({}, {origin:'https://evil.invalid'}))).status,403);
 assert.equal(calls.length,1);
});
test('cached and exhausted requests never contact provider',async()=>{
 for(const config of [{claim:()=>({state:'cached',min_total:900,checked_at:'2026-10-16T00:00:00Z'})},{admitted:()=>false}]){
  const calls=mockFetch(config);const result=await (await handleRequest(request())).json();
  assert.ok(['cached','queued'].includes(result.state));
  if(result.state==='cached')assert.equal(result.min_total,900);
  else assert.ok(result.next_attempt_at);
  assert.equal(providerCalls(calls).length,0);
 }
});
test('one public request is saved before response; never retries or follows redirects',async()=>{
 const calls=mockFetch();const result=await (await handleRequest(request())).json();
 assert.equal(result.state,'metadata_only');assert.equal(result.min_total,1234);
 const provider=providerCalls(calls);
 assert.equal(provider.length,1);assert.equal(provider[0].options.redirect,'manual');
 const saved=JSON.parse(calls.find(c=>c.url.endsWith('tix_finish_capture')).options.body);
 assert.equal(saved.p_capture.meta.event_id,id);assert.equal(saved.p_capture.state,'metadata_only');
 assert.equal(calls.some(c=>/alert|email|sms/.test(c.url)),false);
 // The original single-event request tracks the opened event as its owner.
 const tracking=calls.find(c=>c.url.endsWith('tix_request_capture'));
 assert.equal(tracking.options.headers.Authorization,'Bearer user');
});
test('provider blocking suspends globally and releases without another request',async()=>{
 const calls=mockFetch({providerStatus:()=>429});const result=await handleRequest(request());
 assert.equal(result.status,503);
 assert.equal(providerCalls(calls).length,1);
 assert.ok(calls.some(c=>c.url.endsWith('tix_suspend_provider')));
 assert.ok(calls.some(c=>c.url.endsWith('tix_release_capture')));
 assert.ok(!calls.some(c=>c.url.endsWith('tix_finish_capture')));
});
test('a search prices every result at once, in bounded parallel, without tracking',async()=>{
 background.length=0;
 const calls=mockFetch({claim:e=>e===ids[0]?{state:'cached',min_total:500,checked_at:'2026-10-16T00:00:00Z'}:{state:'checking'},admitted:token=>token!=='lease-'+ids[5]});
 const result=await (await handleRequest(request({event_ids:ids}))).json();
 assert.equal(result.tracked,false);
 assert.deepEqual(result.results.map(r=>r.event_id),ids);
 assert.deepEqual(result.results.map(r=>r.state),['cached','metadata_only','metadata_only','metadata_only','metadata_only','queued']);
 assert.equal(result.results[0].min_total,500);assert.equal(result.results[1].min_total,1234);
 assert.ok(result.results[5].next_attempt_at);
 assert.equal(providerCalls(calls).length,4);
 assert.ok(calls.maxInFlight>1&&calls.maxInFlight<=4,'bounded parallel provider requests');
 assert.equal(calls.filter(c=>c.url.includes('/tix_events_v')).length,1);
 assert.equal(calls.some(c=>c.url.endsWith('tix_request_capture')),false);
 await Promise.all(background);
 const noted=calls.find(c=>c.url.endsWith('tix_note_performers'));
 assert.deepEqual(JSON.parse(noted.options.body).p_paths,['/minnesota-vikings-tickets/performers/nflmin']);
});
test('blocking during a search stops every remaining provider request',async()=>{
 const calls=mockFetch({providerStatus:()=>403});
 const result=await (await handleRequest(request({event_ids:ids}))).json();
 assert.ok(result.results.every(r=>['suspended'].includes(r.state)));
 assert.ok(providerCalls(calls).length<=4);
});
test('opening one event tracks it; invalid or oversized batches are refused',async()=>{
 let calls=mockFetch();
 const opened=await (await handleRequest(request({event_ids:[id],track:true}))).json();
 assert.equal(opened.tracked,true);assert.ok(calls.some(c=>c.url.endsWith('tix_request_capture')));
 calls=mockFetch();
 const many=Array.from({length:13},(_,n)=>n.toString(16).padStart(24,'0'));
 assert.equal((await handleRequest(request({event_ids:many}))).status,400);
 assert.equal((await handleRequest(request({event_ids:['bad']}))).status,400);
 assert.equal((await handleRequest(request({event_ids:[]}))).status,400);
 assert.equal(providerCalls(calls).length,0);
});
test('events outside the public catalog never take a lease or a provider request',async()=>{
 const calls=mockFetch();
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>url.includes('/tix_events_v')?(calls.push({url,options}),response([])):original(url,options);
 const result=await (await handleRequest(request({event_ids:[id]}))).json();
 assert.deepEqual(result.results.map(r=>[r.state,r.reason]),[['failed','invalid_event']]);
 assert.equal(calls.some(c=>c.url.includes('tix_claim_capture')),false);
 assert.equal(providerCalls(calls).length,0);
});
test('a redirect to the same event saves the new link and asks for a re-check, never following it',async()=>{
 const calls=mockFetch({providerStatus:e=>e===ids[1]?301:200,providerHeaders:e=>e===ids[1]?{location:new URL(moved(e)).pathname}:{}});
 const result=await (await handleRequest(request({event_ids:ids.slice(0,3)}))).json();
 assert.deepEqual(result.results.map(r=>[r.state,r.reason??null]),[['metadata_only',null],['queued','url_moved'],['metadata_only',null]]);
 assert.ok(result.results[1].next_attempt_at,'the site retries a queued result shortly');
 const provider=providerCalls(calls);
 assert.equal(provider.length,3);assert.ok(provider.every(c=>c.options.redirect==='manual'));
 assert.equal(provider.some(c=>c.url===moved(ids[1])),false,'the new link is not fetched in the same call');
 const noted=calls.filter(c=>c.url.endsWith('tix_note_redirect')).map(c=>JSON.parse(c.options.body));
 assert.deepEqual(noted,[{p_token:'lease-'+ids[1],p_location:moved(ids[1])}]);
 assert.equal(calls.some(c=>c.url.endsWith('tix_release_capture')),false);
});
test('a redirect anywhere else backs off without saving a link or another request',async()=>{
 for(const location of ['https://evil.test/events/'+id,'/nfl-football/minnesota-vikings-tickets/performers/nflmin',moved('b'.repeat(24)),
  moved(id)+'?quantity=2','//evil.test/events/'+id,'https://gametime.co:8443/events/'+id,null]){
  const calls=mockFetch({providerStatus:()=>302,providerHeaders:()=>location?{location}:{}});
  const result=await (await handleRequest(request({event_ids:[id]}))).json();
  assert.deepEqual(result.results.map(r=>[r.state,r.reason]),[['failed','redirected']],String(location));
  assert.equal(providerCalls(calls).length,1);
  const noted=calls.filter(c=>c.url.endsWith('tix_note_redirect')).map(c=>JSON.parse(c.options.body));
  assert.deepEqual(noted,[{p_token:'lease-'+id,p_location:null}],String(location));
  assert.equal(calls.some(c=>c.url.endsWith('tix_suspend_provider')||c.url.endsWith('tix_finish_capture')),false);
 }
});
test('before the database step is deployed a redirect fails as it did before',async()=>{
 const calls=mockFetch({providerStatus:()=>301,providerHeaders:()=>({location:moved(id)}),noteRedirect:()=>response({code:'PGRST202'},404)});
 const result=await (await handleRequest(request({event_ids:[id]}))).json();
 assert.deepEqual(result.results.map(r=>[r.state,r.reason]),[['failed','capture_failed']]);
 const released=calls.filter(c=>c.url.endsWith('tix_release_capture')).map(c=>JSON.parse(c.options.body));
 assert.deepEqual(released,[{p_token:'lease-'+id,p_reason:'capture_failed'}]);
 assert.equal(providerCalls(calls).length,1);
});
test('a blocking page is still detected first, even on a redirect status',async()=>{
 const calls=mockFetch({providerStatus:()=>302,providerHeaders:()=>({location:moved(id)})});
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>url.startsWith('https://gametime.co/')?(calls.push({url,options}),new Response('<title>Just a moment...</title>',{status:302,headers:{location:moved(id)}})):original(url,options);
 const result=await (await handleRequest(request({event_ids:[id]}))).json();
 assert.deepEqual(result.results.map(r=>r.state),['suspended']);
 assert.ok(calls.some(c=>c.url.endsWith('tix_suspend_provider')));
 assert.equal(calls.some(c=>c.url.endsWith('tix_note_redirect')),false);
});

test('anonymous quick pulls use selected seats, never write owner tracking and reserve admission',async()=>{
 const calls=mockFetch();const result=await (await handleRequest(request({event_id:id,qty:4},{authorization:'Bearer anon'}))).json();
 assert.equal(result.qty,4);assert.equal(providerCalls(calls)[0].url,'https://gametime.co/events/'+id+'?quantity=4');
 assert.equal(calls.some(c=>c.url.endsWith('/auth/v1/user')||c.url.endsWith('tix_request_capture')),false);
 const body=JSON.parse(calls.find(c=>c.url.endsWith('tix_request_quote')).options.body);assert.equal(body.p_anonymous,true);assert.equal(body.p_qty,4);assert.match(body.p_actor,/^[a-f0-9]{64}$/);
});
test('fresh exact public quotes return without provider admission or network; blocked callers keep saved prices',async()=>{
 let calls=mockFetch({quotes:[{event_id:id,state:'complete',market:{by_qty:{4:{low:5500}}}}]});
 let result=await (await handleRequest(request({event_id:id,qty:4},{authorization:'Bearer anon'}))).json();assert.equal(result.state,'cached');assert.equal(result.market.by_qty[4].low,5500);assert.equal(providerCalls(calls).length,0);assert.equal(calls.some(c=>c.url.endsWith('tix_request_quote')),false);
 calls=mockFetch({quoteAllowed:false,quotes:[{event_id:id,state:'advertised',min_total:3900}]});result=await (await handleRequest(request({event_id:id},{authorization:'Bearer anon'}))).json();assert.equal(result.state,'queued');assert.equal(result.min_total,3900);assert.equal(providerCalls(calls).length,0);
});

test('general browsing reuses advertised prices and never queues selected-seat work',async()=>{
 let calls=mockFetch({quotes:[{event_id:id,state:'advertised',min_total:3900}]});
 let result=await (await handleRequest(request({event_ids:[id],details:false},{authorization:'Bearer anon'}))).json();
 assert.equal(result.results[0].state,'advertised');assert.equal(providerCalls(calls).length,0);assert.equal(calls.some(c=>c.url.endsWith('tix_touch_quotes')),false);
 calls=mockFetch();result=await (await handleRequest(request({event_ids:[id],details:false},{authorization:'Bearer anon'}))).json();
 assert.equal(JSON.parse(calls.find(c=>c.url.endsWith('tix_request_quote')).options.body).p_qty,0);
 assert.equal(calls.some(c=>c.url.endsWith('tix_claim_detail_dispatch')),false);
});

test('a fresh advertised amount queues exact seats without fetching the same metadata again',async()=>{
 const calls=mockFetch({quotes:[{event_id:id,state:'advertised',min_total:3900}]});
 const result=await (await handleRequest(request({event_ids:[id],qty:4},{authorization:'Bearer anon'}))).json();
 assert.equal(result.results[0].state,'advertised');assert.equal(providerCalls(calls).length,0);assert.equal(JSON.parse(calls.find(c=>c.url.endsWith('tix_request_quote')).options.body).p_qty,4);
});
