import { captureFromPage, blockingSignals, validEventUrl } from '../_shared/provider.mjs';

declare const EdgeRuntime: {waitUntil(work:Promise<unknown>):void};
const base = Deno.env.get('SUPABASE_URL')!;
const adminKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const publicKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const origins = new Set((Deno.env.get('TIX_ALLOWED_ORIGINS') || 'https://tylerherman19.github.io').split(','));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
async function rpc(name: string, body: unknown, key = adminKey, authorization = `Bearer ${adminKey}`) {
  const response = await fetch(`${base}/rest/v1/rpc/${name}`, {method:'POST',redirect:'error',
    headers:{apikey:key,Authorization:authorization,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`database_${response.status}`);
  return response.json();
}
async function catalog(id: string) {
  const r = await fetch(`${base}/rest/v1/tix_events_v?event_id=eq.${id}&select=*&limit=1`,{
    headers:{apikey:adminKey,Authorization:`Bearer ${adminKey}`},redirect:'error',signal:AbortSignal.timeout(5000)});
  if (!r.ok) throw new Error('catalog_unavailable');
  return (await r.json())[0];
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
export async function handleRequest(req:Request) {
  const requestStarted=performance.now();
  const origin = req.headers.get('origin') || '';
  const cors: Record<string,string> = origins.has(origin)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin',
    'Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'}:{};
  const reply = (body: unknown,status=200) => Response.json(body,{status,headers:{...cors,'Cache-Control':'no-store'}});
  if (origin && !origins.has(origin)) return reply({error:'origin_not_allowed'},403);
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  if (req.method!=='POST') return reply({error:'POST_required'},405);
  let lease: string|null=null;
  try {
    const authorization = req.headers.get('authorization') || '';
    const user = await fetch(`${base}/auth/v1/user`,{headers:{apikey:publicKey,Authorization:authorization},
      redirect:'error',signal:AbortSignal.timeout(5000)});
    if (!user.ok || !(await user.json()).id) return reply({error:'sign_in_required'},401);
    if (Number(req.headers.get('content-length') || 0)>1024) return reply({error:'request_too_large'},413);
    const text=await req.text();if(text.length>1024)return reply({error:'request_too_large'},413);
    const body=JSON.parse(text),id=body.event_id;
    if (!/^[a-f0-9]{24}$/.test(id||'')) return reply({error:'invalid_event'},400);
    const requested=await rpc('tix_request_capture',{p_event_id:id,p_details:true},publicKey,authorization);
    if (['expired','beyond_horizon','failed'].includes(requested.state)||requested.reason==='queue_full') return reply(requested);
    const claim=await rpc('tix_claim_capture',{p_event_id:id,p_source:'edge'});
    if (claim.state!=='checking') {
      if(claim.state==='cached') EdgeRuntime.waitUntil(dispatchDetail(id).catch(()=>{}));
      return reply({...claim,detail_worker:'scheduled'});
    }
    lease=claim.token;
    const event=await catalog(id);
    if (!event || !validEventUrl(event.url,id)) throw new Error('invalid_catalog_url');
    const admission=await rpc('tix_admit_provider_http',{p_token:lease});
    if (!admission.allowed) {
      await rpc('tix_release_capture',{p_token:lease,p_reason:admission.reason});lease=null;
      return reply({state:'queued',reason:admission.reason,next_attempt_at:admission.next_attempt_at});
    }
    const start=performance.now();
    const response=await fetch(event.url,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'User-Agent':UA}});
    const page=await response.text(),blocking=blockingSignals(response.status,page);
    if (blocking.length) {
      await rpc('tix_suspend_provider',{p_token:lease,p_reason:blocking.join(',')});
      throw new Error('provider_suspended');
    }
    if (!response.ok) throw new Error(response.status>=300&&response.status<400?'redirect_not_followed':`provider_http_${response.status}`);
    const capture=captureFromPage(page,id);
    const fetch_parse_ms=Math.round(performance.now()-start);
    const observation_id=await rpc('tix_finish_capture',{p_token:lease,p_capture:capture});lease=null;
    // Rich browser collection may take a minute or longer once a runner starts.
    // It never holds up the fast price response and its actual state is polled.
    let detail_worker='not_needed';
    if (capture.state==='metadata_only'||capture.state==='partial') {
      EdgeRuntime.waitUntil(dispatchDetail(id).catch(()=>{}));detail_worker='queued';
    }
    return reply({state:capture.state,event_id:id,min_total:capture.min_total,observation_id,
      checked_at:new Date().toISOString(),listing_count:capture.listings.length,detail_worker,
      fetch_parse_ms,total_ms:Math.round(performance.now()-requestStarted)});
  } catch(error) {
    if(lease)await rpc('tix_release_capture',{p_token:lease,p_reason:String(error).includes('provider_suspended')?'provider_suspended':'capture_failed'}).catch(()=>{});
    console.error('ticketline_capture_failed',String(error).replace(/Bearer\s+\S+/g,'<redacted>'));
    return reply({state:'failed',reason:'capture_failed'},503);
  }
}
Deno.serve(handleRequest);
