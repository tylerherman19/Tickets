/* Read-only snapshot of real catalog rows for local UI work. No production API calls. */
const DEV_EVENTS = [
  {event_id:'695d92b61f2335daaac0feb9',name:'Dolphins at Vikings',slug:'dolphins-at-vikings',category:'nfl-football',event_date:'2026-10-04',venue:'U.S. Bank Stadium',venue_slug:'u-s-bank-stadium',city:'Minneapolis',state:'MN',url:'https://gametime.co/',min_total:null,price_checked_at:null,last_seen:null},
  {event_id:'695cb020fa6aa653081fe5d6',name:'Bears at Packers',slug:'bears-at-packers',category:'nfl-football',event_date:'2026-10-11',venue:'Lambeau Field',venue_slug:'lambeau-field',city:'Green Bay',state:'WI',url:'https://gametime.co/',min_total:null,price_checked_at:null,last_seen:null},
  {event_id:'695d92b61b3cc022614f5d22',name:'Colts at Vikings',slug:'colts-at-vikings',category:'nfl-football',event_date:'2026-10-25',venue:'U.S. Bank Stadium',venue_slug:'u-s-bank-stadium',city:'Minneapolis',state:'MN',url:'https://gametime.co/',min_total:null,price_checked_at:null,last_seen:null}
];
function devGet(path){
  const u=new URL(path,'http://ticketline.local/'),q=u.searchParams;
  if(u.pathname.includes('tix_events_v')){
    let rows=DEV_EVENTS.filter(e=>e.event_date>=todayISO());
    for(const key of ['event_id','category','state','event_date']){
      const value=q.get(key);if(value?.startsWith('eq.'))rows=rows.filter(e=>String(e[key])===value.slice(3));
    }
    if(q.get('event_id')?.startsWith('in.(')){const ids=q.get('event_id').slice(4,-1).split(',');rows=rows.filter(e=>ids.includes(e.event_id));}
    if(q.has('or')){const term=q.get('or').match(/name\.ilike\."\*([^*]+)\*/)?.[1]?.toLowerCase();if(term)rows=rows.filter(e=>e.name.toLowerCase().includes(term));}
    if(q.get('city')?.startsWith('ilike.'))rows=rows.filter(e=>e.city.toLowerCase().includes(q.get('city').slice(6,-1).toLowerCase()));
    return rows.sort((a,b)=>a.event_date.localeCompare(b.event_date)||a.event_id.localeCompare(b.event_id))
      .slice(Number(q.get('offset')||0),Number(q.get('offset')||0)+Number(q.get('limit')||100));
  }
  if(u.pathname.includes('tix_teams_v'))return [{team:'vikings',events:2},{team:'packers',events:1}];
  return [];
}

/* Synthetic examples for exercising the new UI locally. Never used on the live site. */
const DEV_TEAMS=[
 {team_id:'preview-wisconsin-badgers-basketball',category:'college-basketball',label:'Wisconsin Badgers',aliases:['Wisconsin','Badgers','UW'],event_count:4},
 {team_id:'preview-washington-huskies-basketball',category:'college-basketball',label:'Washington Huskies',aliases:['Washington','Huskies','UW'],event_count:1},
 {team_id:'preview-syracuse-orange-basketball',category:'college-basketball',label:'Syracuse Orange',aliases:['Syracuse','Orange','Cuse'],event_count:1}
];
const devDay=days=>todayISO(new Date(Date.now()+days*86400000));
DEV_EVENTS.push(...[
 {event_id:'preview-wisconsin-1',name:'Nebraska Cornhuskers at Wisconsin Badgers',event_date:devDay(14),min_total:1200,price_checked_at:new Date().toISOString(),is_home:true,discovery_status:'metadata_only'},
 {event_id:'preview-wisconsin-2',name:'Michigan Wolverines at Wisconsin Badgers',event_date:devDay(21),min_total:2700,price_checked_at:new Date(Date.now()-2*86400000).toISOString(),is_home:true,discovery_status:'metadata_only'},
 {event_id:'preview-wisconsin-3',name:'Iowa Hawkeyes at Wisconsin Badgers',event_date:devDay(28),min_total:null,price_checked_at:null,is_home:true,discovery_status:'pending'},
 {event_id:'preview-wisconsin-4',name:'Wisconsin Badgers at Illinois Fighting Illini',event_date:devDay(35),min_total:1800,price_checked_at:new Date(Date.now()-3600000).toISOString(),is_home:false,discovery_status:'metadata_only'}
].map(e=>({slug:e.name.toLowerCase().replaceAll(' ','-'),category:'college-basketball',venue:e.is_home?'Kohl Center':'State Farm Center',venue_slug:e.is_home?'kohl-center':'state-farm-center',city:e.is_home?'Madison':'Champaign',state:e.is_home?'WI':'IL',url:'https://gametime.co/',...e})));
function devRpc(name,body={}){
 if(name==='tix_resolve_teams'){
  const term=String(body.p_query||'').toLowerCase();
  return DEV_TEAMS.filter(t=>(!body.p_category||t.category===body.p_category)&&(!term||t.team_id===term||[t.label,...t.aliases].some(a=>a.toLowerCase().includes(term)))).slice(0,body.p_limit||12);
 }
 if(name==='tix_search_team_events')return body.p_team_id==='preview-wisconsin-badgers-basketball'?DEV_EVENTS.filter(e=>e.event_id.startsWith('preview-wisconsin-')):[];
 if(name==='tix_search_quantity_prices')return (body.p_event_ids||[]).map(event_id=>({event_id,price_cents:event_id==='preview-wisconsin-1'?1600:event_id==='preview-wisconsin-2'?3200:null,basis:event_id==='preview-wisconsin-1'?'fees_included_tax_unknown':'fees_included_tax_reported',checked_at:event_id==='preview-wisconsin-2'?new Date(Date.now()-3*86400000).toISOString():new Date().toISOString(),state:event_id==='preview-wisconsin-1'?'partial':event_id==='preview-wisconsin-2'?'complete':'unconfirmed',listing_count:event_id==='preview-wisconsin-3'?0:3,coverage:{complete:false}}));
 if(name==='tix_catalog_health')return new URLSearchParams(location.search).get('preview')==='unknown'?null:{as_of:new Date().toISOString(),horizon_days:365,collector_state:'fresh',freshness_hours:24,events:4394,priced:3900,unpriced:494,fresh:3220,stale:680,failed_checks:3,pending_checks:17,teams:972,teams_checked:955,teams_failed:3,last_catalog_at:new Date(Date.now()-20*60000).toISOString(),last_collector_at:new Date(Date.now()-4*60000).toISOString(),provider_paused:false};
 if(name==='tix_event_comparable_history'||name==='tix_event_price_history')return Array.from({length:8},(_,i)=>({checked_at:new Date(Date.now()-(8-i)*6*3600000).toISOString(),price_cents:[2100,1900,1950,1700,1750,1600,1650,1600][i],basis:body.p_basis,qty:body.p_qty,section:body.p_section}));
 if(name==='tix_event_listings')return [];
 if(name==='tix_event_capture_status')return {state:'not_checked'};
 return false;
}
if(typeof IS_DEV!=='undefined'&&IS_DEV)document.body.insertAdjacentHTML('afterbegin','<div class="dev-preview-note" role="note">Local preview · synthetic schedule and price examples. No live checks, emails, or saved changes.</div>');
