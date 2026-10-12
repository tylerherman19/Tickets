import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Provider calls are mocked. Never contact Gametime from this test machine.
const env={SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'service',SUPABASE_ANON_KEY:'anon'};
globalThis.Deno={env:{get:key=>env[key]},serve:()=>{}};
globalThis.EdgeRuntime={waitUntil:()=>{}};
const {handleRequest}=await import('../supabase/functions/ticketline-prices/index.ts');
const id='aaaaaaaaaaaaaaaaaaaaaaaa';
function request(body={event_id:id},headers={}){return new Request('https://edge.invalid',{method:'POST',headers:{authorization:'Bearer user','Content-Type':'application/json',origin:'https://tylerherman19.github.io',...headers},body:JSON.stringify(body)});}
const response=(body,status=200)=>Response.json(body,{status});
function mockFetch({user=true,claim={state:'checking',token:'lease'},admitted=true,providerStatus=200}={}){
 const calls=[];globalThis.fetch=async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/auth/v1/user'))return response(user?{id:'owner'}:{},user?200:401);
  if(url.includes('/rpc/tix_request_capture'))return response({state:'queued'});
  if(url.includes('/rpc/tix_claim_capture'))return response(claim);
  if(url.includes('/tix_events_v'))return response([{url:'https://gametime.co/events/'+id}]);
  if(url.includes('/rpc/tix_admit_provider_http'))return response({allowed:admitted,reason:'request_limit'});
  if(url.includes('/rpc/tix_finish_capture'))return response('observation');
  if(url.includes('/rpc/'))return response(null);
  if(url.startsWith('https://gametime.co/'))return new Response('window.__data='+JSON.stringify({redux:{data:{fullEvents:{events:{[id]:{event:{id,minPrice:{total:1234}}}}}}}}),{status:providerStatus});
  throw Error('Unexpected network destination '+url);
 };return calls;
}
test('invalid auth and origins never request provider or write tracking',async()=>{
 const calls=mockFetch({user:false});assert.equal((await handleRequest(request())).status,401);
 assert.equal(calls.length,1);
 assert.equal((await handleRequest(request({}, {origin:'https://evil.invalid'}))).status,403);
 assert.equal(calls.length,1);
});
test('cached and exhausted requests never contact provider',async()=>{
 for(const config of [{claim:{state:'cached'}},{admitted:false}]){
  const calls=mockFetch(config);const result=await (await handleRequest(request())).json();
  assert.ok(['cached','queued'].includes(result.state));
  assert.equal(calls.filter(c=>c.url.startsWith('https://gametime.co/')).length,0);
 }
});
test('one public request is saved before response; never retries or follows redirects',async()=>{
 const calls=mockFetch();const result=await (await handleRequest(request())).json();
 assert.equal(result.state,'metadata_only');assert.equal(result.min_total,1234);
 const provider=calls.filter(c=>c.url.startsWith('https://gametime.co/'));
 assert.equal(provider.length,1);assert.equal(provider[0].options.redirect,'manual');
 const saved=JSON.parse(calls.find(c=>c.url.endsWith('tix_finish_capture')).options.body);
 assert.equal(saved.p_capture.meta.event_id,id);assert.equal(saved.p_capture.state,'metadata_only');
 assert.equal(calls.some(c=>/alert|email|sms/.test(c.url)),false);
});
test('provider blocking suspends globally and releases without another request',async()=>{
 const calls=mockFetch({providerStatus:429});const result=await handleRequest(request());
 assert.equal(result.status,503);
 assert.equal(calls.filter(c=>c.url.startsWith('https://gametime.co/')).length,1);
 assert.ok(calls.some(c=>c.url.endsWith('tix_suspend_provider')));
 assert.ok(calls.some(c=>c.url.endsWith('tix_release_capture')));
 assert.ok(!calls.some(c=>c.url.endsWith('tix_finish_capture')));
});
