import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackend,trustedJob} from '../backend/neon/core.mjs';
const env={NEON_AUTH_BASE_URL:'https://auth.example.test/db/auth',NEON_AUTH_JWKS_URL:'https://auth.example.test/jwks',NEON_DATA_API_URL:'https://data.example.test/db/rest/v1'};
const job={iss:'https://token.actions.githubusercontent.com',repository:'tylerherman19/Tickets',ref:'refs/heads/main',workflow_ref:'tylerherman19/Tickets/.github/workflows/tickets.yml@refs/heads/main'};
const jwt=claims=>'eyJhbGciOiJSUzI1NiJ9.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
test('only the approved repository, branch and operational workflows can reach service access',()=>{
 assert.equal(trustedJob(job),true);
 for(const patch of [{repository:'attacker/Tickets'},{ref:'refs/heads/feature'},{workflow_ref:'tylerherman19/Tickets/.github/workflows/quality.yml@refs/heads/main'},{workflow_ref:'tylerherman19/Tickets/.github/workflows/tickets.yml@refs/tags/main'}])assert.equal(trustedJob({...job,...patch}),false);
});
test('forged job identities, malformed tokens and private internal markers cannot acquire service access',async()=>{
 let calls=0;
 const backend=createBackend({env,service:{request:()=>{calls++;return Response.json([]);}},verifyGithub:async()=>{throw Error('bad signature');},verifyNeon:async()=>{throw Error('bad signature');}});
 for(const token of ['internal','not-a-jwt',jwt(job)])assert.equal((await backend.fetch(new Request('https://api.example/rest/v1/tix_watches',{headers:{authorization:'Bearer '+token}}))).status,401);
 assert.equal(calls,0);
});
test('verified jobs use the private service and never forward the GitHub token to Data API',async()=>{
 let calls=0;
 const backend=createBackend({env,service:{request:()=>{calls++;return Response.json([{ok:true}]);}},verifyGithub:async()=>job,fetcher:()=>{throw Error('must not forward a job token');}});
 const r=await backend.fetch(new Request('https://api.example/rest/v1/tix_catalog',{headers:{authorization:'Bearer '+jwt(job)}}));
 assert.equal(r.status,200);assert.equal(calls,1);
});
test('user requests retain their verified identity and cannot enter service mode via a role claim',async()=>{
 const id='10000000-0000-4000-8000-000000000001',token=jwt({iss:'https://auth.example.test',sub:id,role:'authenticated'});let synced;
 const backend=createBackend({env,service:{syncUser:user=>{synced=user;},request:()=>{throw Error('must not enter service mode');}},verifyNeon:async t=>JSON.parse(Buffer.from(t.split('.')[1],'base64url').toString()),fetcher:async(url,options)=>{assert.equal(options.headers.get('authorization'),'Bearer '+token);assert.equal(new URL(url).hostname,'data.example.test');return Response.json([]);}});
 const r=await backend.fetch(new Request('https://api.example/rest/v1/tix_watches',{headers:{authorization:'Bearer '+token}}));
 assert.equal(r.status,200);assert.equal(synced,id);
 const elevated=jwt({iss:'https://auth.example.test',sub:id,role:'service_role'});
 assert.equal((await backend.fetch(new Request('https://api.example/rest/v1/tix_watches',{headers:{authorization:'Bearer '+elevated}}))).status,401);
});
test('anonymous requests only use managed anonymous identity and reject unexpected endpoints/origins',async()=>{
 let serviceCalls=0;
 const backend=createBackend({env,service:{request:()=>{serviceCalls++;}},fetcher:async(url,options)=>{if(String(url).endsWith('/token/anonymous'))return Response.json({token:'managed-anonymous'});assert.equal(options.headers.get('authorization'),'Bearer managed-anonymous');return Response.json([]);}});
 assert.equal((await backend.fetch(new Request('https://api.example/rest/v1/tix_events_v'))).status,200);
 assert.equal((await backend.fetch(new Request('https://api.example/rest/v1/users'))).status,404);
 assert.equal((await backend.fetch(new Request('https://api.example/rest/v1/tix_events_v',{headers:{origin:'https://evil.example'}}))).status,403);
 assert.equal(serviceCalls,0);
});
