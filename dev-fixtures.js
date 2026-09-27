/* Read-only snapshot of real catalog rows for local UI work. No production API calls. */
const DEV_EVENTS = [
  {event_id:'695d92b61f2335daaac0feb9',name:'Dolphins at Vikings',slug:'dolphins-at-vikings',category:'nfl-football',event_date:'2026-10-04',venue:'U.S. Bank Stadium',venue_slug:'u-s-bank-stadium',city:'Minneapolis',state:'MN',url:'https://gametime.co/',min_total:null,last_seen:null},
  {event_id:'695cb020fa6aa653081fe5d6',name:'Bears at Packers',slug:'bears-at-packers',category:'nfl-football',event_date:'2026-10-11',venue:'Lambeau Field',venue_slug:'lambeau-field',city:'Green Bay',state:'WI',url:'https://gametime.co/',min_total:null,last_seen:null},
  {event_id:'695d92b61b3cc022614f5d22',name:'Colts at Vikings',slug:'colts-at-vikings',category:'nfl-football',event_date:'2026-10-25',venue:'U.S. Bank Stadium',venue_slug:'u-s-bank-stadium',city:'Minneapolis',state:'MN',url:'https://gametime.co/',min_total:null,last_seen:null}
];
function devGet(path){
  const u=new URL(path,'http://ticketline.local/'),q=u.searchParams;
  if(u.pathname.includes('tix_events_v')){
    let rows=DEV_EVENTS.filter(e=>e.event_date>=todayISO());
    for(const key of ['event_id','category','state','event_date']){
      const value=q.get(key);if(value?.startsWith('eq.'))rows=rows.filter(e=>String(e[key])===value.slice(3));
    }
    if(q.has('or')){const term=q.get('or').match(/name\.ilike\."\*([^*]+)\*/)?.[1]?.toLowerCase();if(term)rows=rows.filter(e=>e.name.toLowerCase().includes(term));}
    if(q.get('city')?.startsWith('ilike.'))rows=rows.filter(e=>e.city.toLowerCase().includes(q.get('city').slice(6,-1).toLowerCase()));
    return rows.sort((a,b)=>a.event_date.localeCompare(b.event_date)||a.event_id.localeCompare(b.event_id))
      .slice(Number(q.get('offset')||0),Number(q.get('offset')||0)+Number(q.get('limit')||100));
  }
  if(u.pathname.includes('tix_teams_v'))return [{team:'vikings',events:2},{team:'packers',events:1}];
  return [];
}
