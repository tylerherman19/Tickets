"""Provider-identified team names, aliases and event membership.

No HTTP here. Callers pass already admitted Gametime page data. Home/away is
saved only when explicit provider performer IDs identify that role; page titles,
mascots and venue cities are never enough to establish an event's home team.
"""
import re
from urllib.parse import urlsplit

CATEGORIES = {'nfl':'nfl-football','nba':'nba-basketball','mlb':'mlb-baseball','nhl':'nhl-hockey',
              'cfb':'college-football','cbb':'college-basketball','mls':'mls-soccer','wnba':'wnba'}
PATH = re.compile(r'^(/[a-z0-9-]{1,80}){1,2}/performers/([a-z0-9]{2,40})$')
EVENT = re.compile(r'^[a-f0-9]{24}$')
# Familiar abbreviations supplement the provider's own names and codes. An
# ambiguous alias is assigned to each named school, leaving selection explicit.
SCHOOL_ALIASES = {'wisconsin':('UW','UW Madison'), 'washington':('UW','UW Seattle'),
                  'syracuse':('Cuse','SU'), 'connecticut':('UConn',),
                  'southern california':('USC',), 'south carolina':('USC',),
                  'penn state':('PSU',), 'michigan state':('MSU',),
                  'ohio state':('OSU',), 'oregon state':('OSU',), 'oklahoma state':('OSU',)}


def objects(value):
    if isinstance(value,dict):
        yield value
        for item in value.values(): yield from objects(item)
    elif isinstance(value,list):
        for item in value: yield from objects(item)


def provider_id(value):
    if isinstance(value,str) and re.fullmatch(r'[a-z0-9]{2,40}',value): return value
    if isinstance(value,dict):
        return provider_id(value.get('slug')) or provider_id(value.get('id'))
    return None


def team_rows(data):
    rows={}
    for item in objects(data):
        category=CATEGORIES.get(item.get('category'))
        label=item.get('name')
        if not category or not isinstance(label,str) or not 1<=len(label.strip())<=180: continue
        url=item.get('seoUrl') or item.get('seo_url')
        if not isinstance(url,str): continue
        parts=urlsplit(url)
        match=PATH.fullmatch(parts.path)
        if parts.scheme!='https' or parts.netloc!='gametime.co' or parts.query or parts.fragment or not match: continue
        code=match.group(2)
        # The path's provider ID is authoritative. Reject contradictory object IDs.
        source_code=provider_id(item.get('slug'))
        if source_code and source_code!=code: continue
        aliases={label.strip()}
        for key in ('shortName','mediumName','abbreviation','abbreviatedName'):
            value=item.get(key)
            if isinstance(value,str) and value.strip():
                aliases.add(value.strip())
                if key=='mediumName':
                    abbr=re.match(r'^([A-Z0-9&]{2,8})\s',value)
                    if abbr: aliases.add(abbr.group(1))
        if category.startswith('college-'):
            lowered=label.lower()
            for school,names in SCHOOL_ALIASES.items():
                if lowered.startswith(school+' '): aliases.update(names)
        rows[code]={'team_id':code,'category':category,'label':label.strip(),'path':parts.path,
                    'aliases':sorted(a[:100] for a in aliases)[:20]}
    return list(rows.values())


def role_id(event,role):
    for key in (role+'Performer',role+'_performer',role+'Team',role+'_team'):
        code=provider_id(event.get(key))
        if code: return code
    for key in (role+'PerformerSlug',role+'_performer_slug',role+'TeamId',role+'_team_id'):
        code=provider_id(event.get(key))
        if code: return code
    return None


def schedule_event_ids(data,team_id):
    """Events in an explicitly identified team schedule, excluding upsells.

    A page can embed recommendations for unrelated events. Merely appearing
    on a team's page never establishes team membership.
    """
    ids=set()
    def walk(value):
        if isinstance(value,list):
            for item in value: walk(item)
        elif isinstance(value,dict):
            eid=value.get('id')
            if isinstance(eid,str) and EVENT.fullmatch(eid): ids.add(eid)
            for key,item in value.items():
                if not re.search(r'recommend|related|similar|upsell',key,re.I): walk(item)
    for item in objects(data):
        identified=provider_id(item)==team_id or provider_id(item.get('performer'))==team_id
        if identified:
            for key in ('events','schedule','upcomingEvents','upcoming_events'):
                if key in item: walk(item[key])
        for key in ('performerSchedules','performer_schedules','performerEvents','performer_events'):
            collection=item.get(key)
            if isinstance(collection,dict) and team_id in collection: walk(collection[team_id])
    return ids


def event_links(data,team_id=None):
    """Return source-identified memberships; explicit unrelated IDs win."""
    linked={}
    scheduled=schedule_event_ids(data,team_id) if team_id else set()
    for item in objects(data):
        eid=item.get('id')
        if not isinstance(eid,str) or not EVENT.fullmatch(eid): continue
        url=item.get('seoUrl') or item.get('seo_url') or ''
        if not isinstance(url,str): continue
        parts=urlsplit(url)
        if parts.scheme!='https' or parts.netloc!='gametime.co' or parts.query or parts.fragment or not parts.path.endswith('/events/'+eid): continue
        home=role_id(item,'home'); away=role_id(item,'away')
        codes=set()
        if home: codes.add(home)
        if away: codes.add(away)
        for performer in item.get('performers',[]) if isinstance(item.get('performers'),list) else []:
            code=provider_id(performer)
            if code:
                codes.add(code)
                role=(performer.get('homeAway') or performer.get('home_away') or performer.get('homeOrAway')) if isinstance(performer,dict) else None
                if role=='home': home=code
                elif role=='away': away=code
        if not codes and eid in scheduled: codes.add(team_id)
        for code in codes:
            if not code: continue
            linked.setdefault(code,{})[eid]={'event_id':eid,'is_home':True if code==home and code!=away else False if code==away and code!=home else None}
    return {code:list(rows.values()) for code,rows in linked.items()}


def save_teams(data,db):
    rows=team_rows(data)
    for start in range(0,len(rows),1000): db('POST','rpc/tix_upsert_teams',{'p_rows':rows[start:start+1000]})
    return len(rows)


def save_links(data,db,team_id=None,checked=False):
    linked=event_links(data,team_id)
    # A checked page with no events is still a completed directory inspection.
    if team_id and checked: linked.setdefault(team_id,[])
    for code,rows in linked.items():
        db('POST','rpc/tix_link_team_events',{'p_team_id':code,'p_rows':rows,'p_checked':checked and code==team_id})
    return len(linked)


def available(db):
    """Old deployments keep collecting normally until additive RPCs exist."""
    try:
        value=db('POST','rpc/tix_resolve_teams',{'p_query':'','p_category':None,'p_limit':0})
        return isinstance(value,list)
    except Exception as error:
        if getattr(error,'code',None)==404: return False
        raise
