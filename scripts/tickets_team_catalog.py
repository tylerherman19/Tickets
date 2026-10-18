"""Provider-identified team names, aliases and event membership.

No HTTP here. Callers pass already admitted Gametime page data. Home/away is
saved from explicit roles or an unambiguous "away at home" event label whose
two participants resolve to the source's full performer identities. A mascot,
page position, primary flag or venue city alone never establishes home status.
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


def source_team(item):
    category=CATEGORIES.get(item.get('category'));label=item.get('name')
    if not category or not isinstance(label,str) or not 1<=len(label.strip())<=180: return None
    url=item.get('seoUrl') or item.get('seo_url')
    if not isinstance(url,str): return None
    parts=urlsplit(url);match=PATH.fullmatch(parts.path)
    if parts.scheme!='https' or parts.netloc!='gametime.co' or parts.query or parts.fragment or not match: return None
    code=match.group(2);source_code=provider_id(item.get('slug'))
    if source_code and source_code!=code: return None
    return category,label,parts.path,code


def team_rows(data):
    rows={}
    for item in objects(data):
        source=source_team(item)
        if not source: continue
        category,label,path,code=source
        aliases={label.strip()}
        for key in ('shortName','mediumName','abbreviation','abbreviatedName'):
            value=item.get(key)
            if isinstance(value,str) and value.strip():
                aliases.add(value.strip())
                if key=='mediumName':
                    abbr=re.match(r'^([A-Z0-9&]{2,8})\s',value)
                    if abbr: aliases.add(abbr.group(1))
        if category.startswith('college-'):
            # Match the whole school, not a prefix: Wisconsin Green Bay is
            # not UW Madison, and Washington State is not UW Seattle.
            school_name=re.sub(r'[^a-z0-9]+',' ',label.lower()).strip()
            school_name=re.sub(r' (?:(?:mens|womens|men s|women s) )?(?:basketball|football)$','',school_name)
            mascot=re.sub(r'[^a-z0-9]+',' ',str(item.get('shortName') or '').lower()).strip()
            if mascot and school_name.endswith(' '+mascot): school_name=school_name[:-len(mascot)-1]
            for school,names in SCHOOL_ALIASES.items():
                if school == school_name: aliases.update(names)
        rows[code]={'team_id':code,'category':category,'label':label.strip(),'path':path,
                    'aliases':sorted(a[:100] for a in aliases)[:20]}
    return list(rows.values())


def role_id(event,role,resolve=provider_id):
    for key in (role+'Performer',role+'_performer',role+'Team',role+'_team'):
        code=resolve(event.get(key))
        if code: return code
    for key in (role+'PerformerSlug',role+'_performer_slug',role+'TeamId',role+'_team_id'):
        code=resolve(event.get(key))
        if code: return code
    return None


def team_name(value):
    name=re.sub(r'[^a-z0-9]+',' ',str(value or '').lower()).strip()
    name=re.sub(r' exhibition$','',name)
    return re.sub(r' (?:(?:mens|womens|men s|women s) )?(?:basketball|football)$','',name)


def named_roles(event,codes,names):
    label=event.get('name')
    if len(codes)!=2 or not isinstance(label,str) or 'neutral' in label.lower(): return None,None
    parts=re.split(r'\s+at\s+',label,flags=re.I)
    if len(parts)!=2: return None,None
    sides=[[code for code in codes if team_name(side) in names.get(code,set())] for side in parts]
    if all(len(side)==1 for side in sides) and sides[0][0]!=sides[1][0]: return sides[1][0],sides[0][0]
    return None,None


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
    # Real event payloads reference Mongo performer IDs; expanded performer
    # objects supply their canonical URL codes. Join only explicit identities
    # from this same response, never page position, mascot or `primary` flags.
    source_ids={};canonical=set();names={}
    for item in objects(data):
        source=source_team(item)
        if not source: continue
        code=source[3];canonical.add(code)
        variants=names.setdefault(code,set())
        variants.update(team_name(item.get(key)) for key in ('name','shortName','mediumName') if item.get(key))
        full=team_name(item.get('name'));mascot=team_name(item.get('shortName'))
        if full and mascot and not full.endswith(' '+mascot): variants.add(full+' '+mascot)
        raw=provider_id(item.get('id'))
        if raw: source_ids.setdefault(raw,set()).add(code)
    def resolve(value):
        raw=provider_id(value)
        if raw in source_ids:
            choices=source_ids[raw]
            return next(iter(choices)) if len(choices)==1 else None
        return raw if raw and (raw in canonical or not EVENT.fullmatch(raw)) else None
    scheduled=schedule_event_ids(data,team_id) if team_id else set()
    for item in objects(data):
        eid=item.get('id')
        if not isinstance(eid,str) or not EVENT.fullmatch(eid): continue
        url=item.get('seoUrl') or item.get('seo_url') or ''
        if not isinstance(url,str): continue
        parts=urlsplit(url)
        if parts.scheme!='https' or parts.netloc!='gametime.co' or parts.query or parts.fragment or not parts.path.endswith('/events/'+eid): continue
        home=role_id(item,'home',resolve); away=role_id(item,'away',resolve)
        codes=set()
        if home: codes.add(home)
        if away: codes.add(away)
        for performer in item.get('performers',[]) if isinstance(item.get('performers'),list) else []:
            code=resolve(performer)
            if code:
                codes.add(code)
                role=(performer.get('homeAway') or performer.get('home_away') or performer.get('homeOrAway')) if isinstance(performer,dict) else None
                if role=='home': home=code
                elif role=='away': away=code
        if not home and not away and isinstance(item.get('performers'),list) and len(item['performers'])==2:
            home,away=named_roles(item,codes,names)
        if not codes and eid in scheduled: codes.add(team_id)
        for code in codes:
            if not code: continue
            linked.setdefault(code,{})[eid]={'event_id':eid,'is_home':True if code==home and code!=away else False if code==away and code!=home else None}
    return {code:list(rows.values()) for code,rows in linked.items()}


def save_teams(data,db):
    rows=team_rows(data)
    for start in range(0,len(rows),1000): db('POST','rpc/tix_upsert_teams',{'p_rows':rows[start:start+1000]})
    return len(rows)


def membership_shape(data,team_id):
    """Bounded public-source schema evidence when membership cannot be read."""
    events={};contexts=[]
    def walk(value,path):
        if isinstance(value,dict):
            eid=value.get('id')
            if isinstance(eid,str) and EVENT.fullmatch(eid) and '/events/'+eid in str(value.get('seoUrl') or '') and len(events)<2:
                events.setdefault(eid,{'keys':list(value)[:40],
                    'references':{k:v for k,v in value.items() if re.search('team|performer',k,re.I)}})
            if len(contexts)<6 and (value.get('slug')==team_id or value.get('id')==team_id or team_id in value):
                contexts.append({'path':path,'keys':list(value)[:40]})
            for key,item in value.items(): walk(item,path+'/'+str(key))
        elif isinstance(value,list):
            for i,item in enumerate(value): walk(item,path+'/'+str(i))
    walk(data,'')
    return {'team_id':team_id,'events':events,'contexts':contexts}


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
