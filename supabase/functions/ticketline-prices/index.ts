import { captureFromPage, blockingSignals, validEventUrl, movedEventUrl, performerPaths } from '../_shared/provider.mjs';

declare const EdgeRuntime: {waitUntil(work:Promise<unknown>):void};
const base = Deno.env.get('SUPABASE_URL')!;
const adminKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const publicKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const origins = new Set((Deno.env.get('TIX_ALLOWED_ORIGINS') || 'https://tylerherman19.github.io').split(','));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
// One search page shows 12 results. Four page requests at a time keeps a
// search to a few seconds; the database guard still admits every request.
const MAX_EVENTS = 12, CONCURRENCY = 4;
type Result = Record<string, unknown> & {event_id:string,state:string};
async function rpc(name: string, body: unknown, key = adminKey, authorization = `Bearer ${adminKey}`) {
  const response = await fetch(`${base}/rest/v1/rpc/${name}`, {method:'POST',redirect:'error',
    headers:{apikey:key,Authorization:authorization,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`database_${response.status}`);
  return response.json();
}
async function catalog(ids: string[]) {
  const r = await fetch(`${base}/rest/v1/tix_events_v?event_id=in.(${ids.join(',')})&select=event_id,url`,{
    headers:{apikey:adminKey,Authorization:`Bearer ${adminKey}`},redirect:'error',signal:AbortSignal.timeout(5000)});
  if (!r.ok) throw new Error('catalog_unavailable');
  return new Map<string,{url:string}>((await r.json()).map((row:{event_id:string,url:string}) => [row.event_id,row]));
}
// Dispatch contains only an event ID; this workflow never sends notifications.
// A repo-scoped Actions-write token is an optional release secret. Scheduled
// capture remains the honest fallback when that secret is absent.
async function dispatchDetail(id: string) {
  const token = Deno.env.get('TIX_GITHUB_DISPATCH_TOKEN');
  if (!token) return 'scheduled';
  if (!await rpc('tix_claim_detail_dispatch',{p_event_id:id})) return 'already_queued';
  const r = await fetch('https://api.github.com/repos/tylerherman19/Tickets/actions/workflows/ticket-details.yml/dispatches',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,
    Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},
    body:JSON.stringify({ref:'main',inputs:{event_id:id}})});
  return r.ok?'dispatched':'scheduled';
}
// One admitted provider request per event, saved before it is reported.
async function captureOne(id: string, event: {url:string}|undefined, performers: Set<string>, qty:number): Promise<Result> {
  let lease: string|null=null;
  // Events outside the public catalog view never take a lease or a request.
  if (!event || !validEventUrl(event.url,id)) return {event_id:id,state:'failed',reason:'invalid_event'};
  try {
    const claim=await rpc('tix_claim_capture',{p_event_id:id,p_source:'interactive'});
    if (claim.state!=='checking') return {event_id:id,state:claim.state,reason:claim.reason,min_total:claim.min_total,
      checked_at:claim.checked_at,next_attempt_at:claim.next_attempt_at,observation_id:claim.observation_id};
    lease=claim.token;
    const admission=await rpc('tix_admit_provider_http',{p_token:lease});
    if (!admission.allowed) {
      await rpc('tix_release_capture',{p_token:lease,p_reason:admission.reason});lease=null;
      return {event_id:id,state:'queued',reason:admission.reason,next_attempt_at:admission.next_attempt_at};
    }
    const start=performance.now();
    const filtered=new URL(event.url);filtered.searchParams.set('quantity',String(qty));
    const response=await fetch(filtered.href,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'User-Agent':UA}});
    const page=await response.text(),blocking=blockingSignals(response.status,page);
    if (blocking.length) {
      await rpc('tix_suspend_provider',{p_token:lease,p_reason:blocking.join(',')});
      throw new Error('provider_suspended');
    }
    if (response.status>=300&&response.status<400) {
      // Never followed. A move to the same event's page saves the new link and
      // the event is re-checked with it; anything else backs off.
      const location=response.headers.get('location');
      const moved=await rpc('tix_note_redirect',{p_token:lease,p_location:movedEventUrl(location,event.url,id)});lease=null;
      console.warn('ticketline_redirect',id,response.status,moved.reason,String(location).replace(/[?#].*/,'').slice(0,200));
      return {event_id:id,state:moved.state,reason:moved.reason,next_attempt_at:moved.next_attempt_at};
    }
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    const capture=captureFromPage(page,id);
    for (const path of performerPaths(page)) performers.add(path);
    const fetch_parse_ms=Math.round(performance.now()-start);
    const observation_id=await rpc('tix_finish_capture',{p_token:lease,p_capture:capture});lease=null;
    return {event_id:id,state:capture.state,min_total:capture.min_total,observation_id,
      checked_at:new Date().toISOString(),listing_count:capture.listings.length,fetch_parse_ms};
  } catch(error) {
    const suspended=String(error).includes('provider_suspended');
    if(lease)await rpc('tix_release_capture',{p_token:lease,p_reason:suspended?'provider_suspended':'capture_failed'}).catch(()=>{});
    console.error('ticketline_capture_failed',String(error).replace(/Bearer\s+\S+/g,'<redacted>'));
    return {event_id:id,state:suspended?'suspended':'failed',reason:suspended?'provider_suspended':'capture_failed'};
  }
}
export async function handleRequest(req:Request) {
  const requestStarted=performance.now();
  const origin = req.headers.get('origin') || '';
  const cors: Record<string,string> = origins.has(origin)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin',
    'Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'}:{};
  const reply = (body: unknown,status=200) => Response.json(body,{status,headers:{...cors,'Cache-Control':'no-store'}});
  if (origin && !origins.has(origin)) return reply({error:'origin_not_allowed'},403);
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  if (req.method!=='POST') return reply({error:'POST_required'},405);
  try {
    const authorization = req.headers.get('authorization') || '';
    const bearer=authorization.startsWith('Bearer ')?authorization.slice(7):'';
    let publicJwt=false;
    try{const claims=JSON.parse(atob(bearer.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));publicJwt=claims.role==='anon'&&claims.ref===new URL(base).hostname.split('.')[0];}catch{}
    const anonymous=authorization===`Bearer ${publicKey}`||publicJwt;
    let owner:string|null=null;
    if(!anonymous){
    const user = await fetch(`${base}/auth/v1/user`,{headers:{apikey:publicKey,Authorization:authorization},
      redirect:'error',signal:AbortSignal.timeout(5000)});
    if (!user.ok) return reply({error:'sign_in_required'},401);
    owner=(await user.json()).id;
    if(!owner)return reply({error:'sign_in_required'},401);
    }
    if (Number(req.headers.get('content-length') || 0)>2048) return reply({error:'request_too_large'},413);
    const text=await req.text();if(text.length>2048)return reply({error:'request_too_large'},413);
    const body=JSON.parse(text);
    // {event_id} is the original single-event request; it also tracks the event.
    const single=typeof body.event_id==='string'&&body.event_ids===undefined;
    const ids:unknown[]=single?[body.event_id]:Array.isArray(body.event_ids)?[...new Set(body.event_ids)]:[];
    if (!ids.length||ids.length>MAX_EVENTS||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id))) return reply({error:'invalid_event'},400);
    const eventIds=ids as string[];
    const qty=body.qty===undefined?2:body.qty;
    const details=body.details!==false;
    if(!Number.isInteger(qty)||qty<1||qty>8)return reply({error:'invalid_quantity'},400);
    const track=!anonymous&&(single||body.track===true)&&eventIds.length===1;
    if (track) {
      // Tracking is the signed-in owner's own choice; it never blocks the price check.
      const requested=await rpc('tix_request_capture',{p_event_id:eventIds[0],p_details:false},publicKey,authorization).catch(()=>null);
      if (requested&&['expired','beyond_horizon'].includes(requested.state)) return reply(single?requested:{results:[{event_id:eventIds[0],...requested}]});
    }
    // Validate a legacy public JWT through PostgREST before any privileged work.
    const quotes=await rpc('tix_public_quotes',{p_event_ids:eventIds,p_qty:qty},anonymous?bearer:adminKey,anonymous?authorization:`Bearer ${adminKey}`);
    const saved=new Map<string,Result>((Array.isArray(quotes)?quotes:[]).map((q:Result)=>[q.event_id,q]));
    const usable=(id:string)=>['complete','unavailable',...(details?[]:['advertised'])].includes(saved.get(id)?.state||'');
    const needed=eventIds.filter(id=>!usable(id));
    if(!needed.length){
      if(details)EdgeRuntime.waitUntil(rpc('tix_touch_quotes',{p_event_ids:eventIds,p_qty:qty}).catch(()=>{}));
      const rows=eventIds.map(id=>({...saved.get(id),event_id:id,state:saved.get(id)?.state==='complete'?'cached':saved.get(id)?.state}));
      return reply(single?{...rows[0],qty,total_ms:Math.round(performance.now()-requestStarted)}:{results:rows,tracked:track,qty,total_ms:Math.round(performance.now()-requestStarted)});
    }
    const network=req.headers.get('x-real-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
    const identity=owner?`owner:${owner}`:`public:${network}:${new Date().toISOString().slice(0,10)}`;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(adminKey+':quotes:'+identity));
    const actor=Array.from(new Uint8Array(digest)).map(n=>n.toString(16).padStart(2,'0')).join('');
    const admission=await rpc('tix_request_quote',{p_actor:actor,p_anonymous:anonymous,p_event_ids:needed,p_qty:details?qty:0});
    if(!admission?.allowed){
      const rows=eventIds.map(id=>saved.get(id)?.state==='complete'?{...saved.get(id),event_id:id,state:'cached'}:{...saved.get(id),event_id:id,state:admission?.reason==='provider_suspended'?'suspended':'queued',reason:admission?.reason||'request_limit',next_attempt_at:admission?.next_attempt_at});
      return reply(single?rows[0]:{results:rows,tracked:track,qty});
    }
    const events=await catalog(needed);
    const performers=new Set<string>(),results:Result[]=new Array(eventIds.length);
    let next=0,stopped=false;
    await Promise.all(Array.from({length:Math.min(CONCURRENCY,eventIds.length)},async()=>{
      for(let i;(i=next++)<eventIds.length;){
        // Provider blocking suspends everything; do not send further requests.
        results[i]=saved.get(eventIds[i])?.state==='advertised'?{...saved.get(eventIds[i]),event_id:eventIds[i]}:saved.get(eventIds[i])?.state==='complete'?{...saved.get(eventIds[i]),event_id:eventIds[i],state:'cached'}:saved.get(eventIds[i])?.state==='unavailable'?{...saved.get(eventIds[i]),event_id:eventIds[i],state:'unavailable'}:stopped?{event_id:eventIds[i],state:'suspended',reason:'provider_suspended'}:await captureOne(eventIds[i],events.get(eventIds[i]),performers,qty);
        if(results[i].state==='suspended')stopped=true;
      }
    }));
    if (performers.size) EdgeRuntime.waitUntil(rpc('tix_note_performers',{p_paths:[...performers].slice(0,200)}).catch(()=>{}));
    const current=await rpc('tix_public_quotes',{p_event_ids:eventIds,p_qty:qty});
    for(const q of Array.isArray(current)?current:[]){const i=eventIds.indexOf(q.event_id);if(i>=0)results[i]={...results[i],...q,state:q.state==='complete'?'complete':results[i].state};}
    let detail_worker='not_needed';
    if (details&&eventIds.length===1&&['metadata_only','partial','cached'].includes(results[0].state)) {
      // Rich browser collection may take a minute or longer once a runner starts.
      EdgeRuntime.waitUntil(dispatchDetail(eventIds[0]).catch(()=>{}));
      detail_worker=results[0].state==='cached'?'scheduled':'queued';
    }
    const total_ms=Math.round(performance.now()-requestStarted);
    if (!single) return reply({results,tracked:track,qty,total_ms});
    const result=results[0];
    if (result.state==='failed') return reply({state:'failed',reason:'capture_failed'},503);
    if (result.state==='suspended') return reply({state:'failed',reason:'capture_failed'},503);
    return reply({...result,qty,detail_worker,total_ms});
  } catch(error) {
    console.error('ticketline_capture_failed',String(error).replace(/Bearer\s+\S+/g,'<redacted>'));
    return reply({state:'failed',reason:'capture_failed'},503);
  }
}
Deno.serve(handleRequest);
