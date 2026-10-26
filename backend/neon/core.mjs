import {createRemoteJWKSet, jwtVerify, decodeJwt} from 'jose';
import {randomUUID} from 'node:crypto';

const REPO='tylerherman19/Tickets', AUDIENCE='ticketline-github-actions';
const GH_ISSUER='https://token.actions.githubusercontent.com';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKFLOWS=new Set(['tickets.yml','ticket-quotes.yml','ticket-details.yml','tickets-team-refresh.yml','tickets-basketball.yml','tickets-performers.yml','tickets-sweep.yml','ticket-storage.yml','ticket-backup.yml','neon-recovery.yml']);

export function trustedJob(payload){
  const workflow=payload.workflow_ref?.split('/.github/workflows/')[1]?.split('@')[0];
  return payload.repository===REPO&&payload.ref==='refs/heads/main'&&WORKFLOWS.has(workflow)&&
    payload.workflow_ref===`${REPO}/.github/workflows/${workflow}@refs/heads/main`;
}

export function createBackend({env,service,fetcher=globalThis.fetch,verifyNeon,verifyGithub,quoteFactory}){
  const internalKey=randomUUID();
  const origins=new Set((env.TIX_ALLOWED_ORIGINS||'https://tylerherman19.github.io').split(','));
  const jwks=env.NEON_AUTH_JWKS_URL&&createRemoteJWKSet(new URL(env.NEON_AUTH_JWKS_URL));
  const githubJwks=createRemoteJWKSet(new URL(`${GH_ISSUER}/.well-known/jwks`));
  verifyNeon||=async token=>(await jwtVerify(token,jwks,{issuer:new URL(env.NEON_AUTH_BASE_URL).origin})).payload;
  verifyGithub||=async token=>(await jwtVerify(token,githubJwks,{issuer:GH_ISSUER,audience:AUDIENCE})).payload;
  const synced=new Map();let anonymous;

  async function anonymousToken(){
    if(anonymous?.until>Date.now())return anonymous.value;
    const r=await fetcher(env.NEON_AUTH_BASE_URL+'/token/anonymous',{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('anonymous_auth_unavailable');const body=await r.json();
    if(typeof body.token!=='string')throw new Error('anonymous_token_missing');
    anonymous={value:body.token,until:Date.now()+60000};return body.token;
  }
  async function identity(authorization){
    if(!authorization||authorization==='Bearer public')return {role:'anon'};
    if(!authorization.startsWith('Bearer '))throw new Error('invalid_authorization');
    const bearer=authorization.slice(7), untrusted=decodeJwt(bearer);
    if(untrusted.iss===GH_ISSUER){
      const claims=await verifyGithub(bearer);
      if(!trustedJob(claims))throw new Error('untrusted_workflow');
      return {role:'service'};
    }
    const claims=await verifyNeon(bearer);
    if(claims.role!==undefined&&claims.role!=='authenticated')throw new Error('invalid_user_role');
    if(!UUID.test(claims.sub||''))throw new Error('invalid_user');
    return {role:'authenticated',sub:claims.sub,email:claims.email,token:bearer};
  }
  async function dataRequest(path,options,who){
    if(!env.NEON_DATA_API_URL)throw new Error('database_not_configured');
    const incoming=new URL(path,'https://ticketline.internal');
    if(!/^\/rest\/v1\/(?:rpc\/)?tix_[a-z0-9_]+$/.test(incoming.pathname))return Response.json({error:'unknown_endpoint'},{status:404});
    if(who.role==='service')return service.request(incoming,options);
    const upstream=new URL(env.NEON_DATA_API_URL);
    upstream.pathname=upstream.pathname.replace(/\/$/,'')+incoming.pathname.slice('/rest/v1'.length);
    upstream.search=incoming.search;
    const headers=new Headers();
    for(const key of ['accept','content-type','prefer','range','range-unit','if-none-match']){
      const value=new Headers(options.headers).get(key);if(value)headers.set(key,value);
    }
    headers.set('authorization',`Bearer ${who.token||await anonymousToken()}`);
    return fetcher(upstream,{...options,headers,redirect:'error',signal:AbortSignal.timeout(60000)});
  }
  async function syncUser(who){
    if(who.role!=='authenticated'||(synced.get(who.sub)||0)>Date.now())return;
    await service.syncUser(who.sub);
    if(synced.size>500)synced.clear();synced.set(who.sub,Date.now()+30000);
  }
  async function quoteFetch(input,options={}){
    const url=new URL(typeof input==='string'?input:input.url);
    if(url.origin!=='https://ticketline.internal')return fetcher(input,options);
    const authorization=new Headers(options.headers).get('authorization');
    const who=authorization===`Bearer ${internalKey}`?{role:'service'}:await identity(authorization);
    await syncUser(who);
    if(url.pathname==='/auth/v1/user')return Response.json(who.sub?{id:who.sub,email:who.email}:{error:'unauthorized'},{status:who.sub?200:401});
    return dataRequest(url.pathname+url.search,options,who);
  }
  const quotes=quoteFactory?.(quoteFetch,{...env,TIX_INTERNAL_KEY:internalKey});
  async function boundedBody(req,limit){
    if(Number(req.headers.get('content-length')||0)>limit)throw new RangeError('body_limit');
    if(!req.body)return undefined;
    const reader=req.body.getReader(),chunks=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new RangeError('body_limit');}chunks.push(value);}
    return Buffer.concat(chunks,size);
  }
  return {async fetch(req){
    const url=new URL(req.url),origin=req.headers.get('origin');
    const cors=origin&&origins.has(origin)?{'access-control-allow-origin':origin,vary:'Origin','access-control-allow-headers':'authorization,apikey,content-type,prefer,range,range-unit','access-control-allow-methods':'GET,HEAD,POST,PATCH,DELETE,OPTIONS','access-control-expose-headers':'content-range'}:{};
    const reply=(body,status=200)=>Response.json(body,{status,headers:{...cors,'cache-control':'no-store'}});
    if(origin&&!origins.has(origin))return reply({error:'origin_not_allowed'},403);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    if(url.pathname==='/status'&&req.method==='GET')return reply({backend:'neon',configured:!!env.NEON_DATA_API_URL});
    if(url.pathname==='/functions/v1/ticketline-prices'&&quotes){
      const headers=new Headers(req.headers);headers.delete('x-forwarded-for');headers.delete('x-real-ip');
      return quotes(new Request(req,{headers}));
    }
    if(!url.pathname.startsWith('/rest/v1/'))return reply({error:'not_found'},404);
    let who;
    try{who=await identity(req.headers.get('authorization'));}catch{return reply({error:'sign_in_required'},401);}
    try{
      await syncUser(who);
      const body=await boundedBody(req,who.role==='service'?16*1024*1024:128*1024);
      const r=await dataRequest(url.pathname+url.search,{method:req.method,headers:req.headers,body},who);
      const headers=new Headers(r.headers);for(const [k,v]of Object.entries(cors))headers.set(k,v);headers.set('cache-control','no-store');
      return new Response(r.body,{status:r.status,headers});
    }catch(error){return reply({error:error instanceof RangeError?'request_too_large':'database_unavailable'},error instanceof RangeError?413:503);}
  }};
}
