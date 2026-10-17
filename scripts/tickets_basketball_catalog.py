#!/usr/bin/env python3
"""Import provider-identified college basketball events from public directory pages."""
import contextlib
import concurrent.futures
import json
import http.client
import os
import re
import urllib.error
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit
import tickets_collect as collect
from tickets_sweep import fetch_once
import tickets_team_catalog as teams


def page_data(page):
    marker='window.__data='
    if marker not in page:
        raise ValueError('Directory page data missing')
    raw=page.split(marker,1)[1]
    raw=re.sub(r'("(?:\\.|[^"\\])*"|undefined)',lambda m:'null' if m.group(0)=='undefined' else m.group(0),raw)
    return json.JSONDecoder().raw_decode(raw)[0]


def objects(value):
    if isinstance(value,dict):
        yield value
        for item in value.values(): yield from objects(item)
    elif isinstance(value,list):
        for item in value: yield from objects(item)


def get_in_price(event):
    values=[event[key] for key in ('minPrice','min_price') if key in event]
    if not values or any(type(value) is not type(values[0]) or value!=values[0] for value in values[1:]):
        return None
    price=values[0]
    return collect.cents_value(price.get('total'),positive=True) if isinstance(price,dict) else None


def save_rows(rows):
    # PostgREST bulk upserts require identical keys. Missing price fields must
    # be omitted, rather than sent as null and erasing a previous good sample.
    for priced in (False,True):
        group=[row for row in rows if ('min_total' in row)==priced]
        for offset in range(0,len(group),500):
            collect.sb('POST','tix_catalog?on_conflict=event_id',group[offset:offset+500],prefer='resolution=merge-duplicates,return=minimal')

def record_history(rows):
    # Guarded deployments also keep a bounded get-in history for these prices.
    priced=[{'event_id':row['event_id'],'min_total':row['min_total']} for row in rows if 'min_total' in row]
    for offset in range(0,len(priced),500):
        collect.sb('POST','rpc/tix_apply_get_in_prices',{'p_rows':priced[offset:offset+500],'p_source':'catalog'})

def catalog_rows(data):
    rows={}
    checked=datetime.now(timezone.utc)
    today=checked.date()
    for event in objects(data):
        if event.get('category') != 'cbb': continue
        url=event.get('seoUrl') or event.get('seo_url') or ''
        row=collect.parse_catalog_url(url)
        if not row or row['category'] not in ('college-basketball','sports','basketball'): continue
        if event.get('id') != row['event_id']: continue
        date=datetime.fromisoformat(row['event_date']).date()
        if not today <= date <= today+timedelta(days=365): continue
        row['category']='college-basketball'
        if event.get('name'): row['name']=event['name']
        price=get_in_price(event)
        if price is not None:
            row.update(min_total=price,price_checked_at=checked.isoformat(),discovery_status='metadata_only')
        previous=rows.get(row['event_id'])
        if previous and 'min_total' in previous and 'min_total' not in row:
            row.update({key:previous[key] for key in ('min_total','price_checked_at','discovery_status')})
        rows[row['event_id']]=row
    return list(rows.values())


def team_pages(data):
    urls={}
    for item in objects(data):
        url=item.get('seoUrl') or item.get('seo_url') or ''
        parts=urlsplit(url)
        if item.get('category')=='cbb' and parts.scheme=='https' and parts.netloc=='gametime.co' and re.fullmatch(r'/[^/]+/performers/cbb[a-z0-9]+',parts.path) and not parts.query and not parts.fragment:
            urls[parts.path.rsplit('/',1)[-1]]=url
    # Follow the provider-identified college teams; never infer sport from a mascot.
    ordered=sorted(urls)
    return [urls[key] for key in ordered]


def team_batch(pages,cursor,limit=48):
    if not pages: return []
    return [pages[(cursor+i)%len(pages)] for i in range(min(limit,len(pages)))]

def team_code(url):
    return url.rsplit('/',1)[-1]


def scheduled_pages(pages,coverage,limit,priority=()):
    # New teams go first; completion is tracked by provider ID rather than a
    # shifting numeric offset, so directory additions cannot skip a team.
    checked=coverage.get('teams',{})
    return sorted(pages,key=lambda url:(team_code(url) not in priority,checked.get(team_code(url),{}).get('checked_at',''),team_code(url)))[:limit]


def read_coverage():
    rows=collect.sb('GET','tix_state?k=eq.college_basketball_coverage&select=v&limit=1')
    value=rows[0]['v'] if rows else {'teams':{}}
    if isinstance(value,str): value=json.loads(value)
    if not isinstance(value,dict) or not isinstance(value.get('teams'),dict):
        raise ValueError('Invalid college basketball coverage state')
    return value


def import_pages(pages,load,coverage,save,workers=4,on_checked=None,on_failed=None):
    # Four independent page fetches at most. Guarded deployments serialize so
    # every attempt retains its shared lease/budget. No new work follows an error.
    checked=coverage['teams']
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for offset in range(0,len(pages),workers):
            urls=pages[offset:offset+workers]
            futures=[pool.submit(load,url) for url in urls]
            failure=None
            for url,future in zip(urls,futures):
                try:
                    data=future.result()
                    rows=save(data)
                    if on_checked: on_checked(team_code(url),data)
                    coverage.setdefault('errors',{}).pop(team_code(url),None)
                    checked[team_code(url)]={'checked_at':datetime.now(timezone.utc).isoformat(),
                                            'events':len(rows),'priced':sum('min_total' in row for row in rows)}
                except Exception as error:
                    code=team_code(url)
                    if on_failed: on_failed(code,error)
                    coverage.setdefault('errors',{})[code]={'at':datetime.now(timezone.utc).isoformat(),'kind':type(error).__name__,'status':getattr(error,'code',None)}
                    print(f'Provider team check failed: {code}; {type(error).__name__}; status={getattr(error,"code",None)}',flush=True)
                    # An unavailable team page must not suppress the rest of
                    # the league. Do not retry it in this run. Blocking/admission
                    # failures still stop all subsequent provider work.
                    isolated=(isinstance(error,urllib.error.HTTPError) and error.code in (404,410,500,502,503,504)
                              or isinstance(error,(http.client.IncompleteRead,http.client.RemoteDisconnected,TimeoutError,ConnectionError))
                              or isinstance(error,urllib.error.URLError) and not isinstance(error,urllib.error.HTTPError))
                    if not isolated: failure=failure or error
            collect.write_state('college_basketball_coverage',coverage)
            print(f'Provider team pages completed: {min(offset+workers,len(pages))}/{len(pages)}',flush=True)
            if failure: raise failure


def main():
    if os.environ.get('GITHUB_ACTIONS')!='true': raise RuntimeError('Catalog import is hosted-only')
    guard=getattr(collect,'GUARD',None)
    def load(url):
        with guard.capture(None,'catalog') if guard else contextlib.nullcontext():
            return page_data(fetch_once(url))
    directory=load('https://gametime.co/c/college-basketball')
    reliability=teams.available(collect.sb)
    if reliability: teams.save_teams(directory,collect.sb)
    seen=set()
    priced=set()
    def save(data):
        rows=catalog_rows(data)
        save_rows(rows)
        if reliability: teams.save_links(data,collect.sb)
        if guard: record_history(rows)
        seen.update(row['event_id'] for row in rows)
        priced.update(row['event_id'] for row in rows if 'min_total' in row)
        return rows
    save(directory)
    pages=team_pages(directory)
    coverage=read_coverage()
    coverage['directory_teams']=len(pages)
    selected=os.environ.get('TIX_BASKETBALL_TEAM','').strip()
    bootstrap=os.environ.get('TIX_BASKETBALL_BOOTSTRAP')=='true'
    if selected:
        batch=[url for url in pages if team_code(url)==selected]
        if len(batch)!=1: raise ValueError('Requested college team is not in the provider directory')
    else:
        pending=[url for url in pages if team_code(url) not in coverage['teams']] if bootstrap else pages
        # 32 team pages an hour revisits every team about twice a day within
        # the shared background budget; other sports use the performer sweep.
        demand=collect.sb('POST','rpc/tix_team_refresh_due',{'p_category':'college-basketball','p_limit':32}) if reliability else []
        priority={row['team_id'] for row in demand}
        batch=scheduled_pages(pending,coverage,len(pending) if bootstrap else 32,priority)
    print(f'Gametime directory: {len(pages)} team pages; processing {len(batch)}; bootstrap={bootstrap}',flush=True)
    def checked(code,data): teams.save_links(data,collect.sb,code,True)
    def failed(code,error): collect.sb('POST','rpc/tix_team_check_failed',{'p_team_id':code,'p_status':str(getattr(error,'code',None) or type(error).__name__)})
    import_pages(batch,load,coverage,save,workers=1 if guard else 4,
                 on_checked=checked if reliability else None,on_failed=failed if reliability else None)
    covered=sum(team_code(url) in coverage['teams'] for url in pages)
    coverage.update(covered_teams=covered,completed_at=datetime.now(timezone.utc).isoformat())
    if bootstrap:
        if covered!=len(pages): raise RuntimeError('Initial catalog coverage is incomplete')
        coverage['bootstrap_completed_at']=coverage['completed_at']
    collect.write_state('college_basketball_coverage',coverage)
    if not seen and covered!=len(pages): raise RuntimeError('No provider-identified college basketball events found')
    print(f'Imported {len(seen)} events and {len(priced)} get-in prices; provider team coverage {covered}/{len(pages)}',flush=True)

if __name__=='__main__': main()
