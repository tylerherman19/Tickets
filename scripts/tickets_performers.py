#!/usr/bin/env python3
"""Hosted get-in price sweep over provider team, artist and show pages.

One of these pages lists many upcoming events with a get-in price each, so it
keeps prices on most of the catalog within the shared daily request budget.
Prices are saved as get-in only (quantity and tax unconfirmed) on events that
already exist in the catalog; this never creates events, watches or alerts.
Each page request is admitted by the shared guard as background work.
"""
import json
import os
import re
import sys
import urllib.error
import http.client
from datetime import datetime, timezone, timedelta
import tickets_collect as collect
from ticketline_guard import CaptureDeferred
from tickets_basketball_catalog import page_data, objects, get_in_price
import tickets_team_catalog as teams

PAGE_LIMIT = 60
RELIABILITY = False
# Category pages link to the teams, artists and shows in that category. They
# are visited once a day; unavailable ones are recorded and skipped.
# College basketball is imported by its own workflow with its category.
# Slugs are the /c/ links in Gametime's own menu. The menu has no /c/ page for
# concerts (it lists music by genre); artist pages are still found from event pages.
DIRECTORIES = ('nfl-football','nba-basketball','nhl-hockey','mlb-baseball','college-football',
               'mls-soccer','wnba','comedy','theater')
DIRECTORY_INTERVAL = timedelta(hours=24)
EVENT_ID = re.compile(r'[0-9a-f]{24}')


def page_objects(page):
    """Decoded data objects from a legacy page or every Astro island."""
    if 'window.__data=' in page:
        return list(objects(page_data(page)))
    found = []
    for raw in re.findall(r'<astro-island\b[^>]*\bprops="([^"]*)"', page):
        try:
            found.extend(objects(collect._decode_astro(json.loads(collect.html_lib.unescape(raw)))))
        except ValueError:
            continue
    return found


def price_rows(items, today=None):
    """Upcoming catalog-shaped events with a valid get-in price."""
    today = today or datetime.now(timezone.utc).date()
    rows = {}
    for item in items:
        eid = item.get('id')
        url = item.get('seoUrl') or item.get('seo_url') or ''
        if not isinstance(eid,str) or not EVENT_ID.fullmatch(eid): continue
        parsed = collect.parse_catalog_url(url)
        if not parsed or parsed['event_id'] != eid: continue
        date = datetime.fromisoformat(parsed['event_date']).date()
        if not today <= date <= today+timedelta(days=365): continue
        price = get_in_price(item)
        if price is not None: rows[eid] = {'event_id':eid,'min_total':price}
    return list(rows.values())


def sweep_page(url):
    """One admitted request; save prices and newly linked performer pages."""
    with collect.GUARD.capture(None,'catalog'):
        page = collect.get_text(url)
    items=page_objects(page)
    if RELIABILITY:
        teams.save_teams(items,collect.sb)
        code=url.rsplit('/',1)[-1] if '/performers/' in url else None
        teams.save_links(items,collect.sb,code,checked=bool(code))
    rows = price_rows(items)
    result = {'updated':0,'history':0}
    for i in range(0,len(rows),500):
        saved = collect.sb('POST','rpc/tix_apply_get_in_prices',{'p_rows':rows[i:i+500],'p_source':'catalog'}) or {}
        result['updated'] += saved.get('updated',0)
        result['history'] += saved.get('history',0)
    collect.PERFORMERS.update(collect.performer_paths(page))
    return len(rows), result


def next_check(priced, failures=0):
    """Productive pages are revisited daily; empty or failing ones back off."""
    if failures: return timedelta(days=min(30,2**failures))
    return timedelta(hours=18) if priced else timedelta(days=7)


def isolated(error):
    """A missing, moved or broken page must not stop the sweep; blocking always
    does. Redirects are never followed, so a moved page backs off like a missing one."""
    return (isinstance(error,urllib.error.HTTPError) and error.code in (301,302,303,307,308,404,410,500,502,503,504)
            or isinstance(error,(http.client.IncompleteRead,http.client.RemoteDisconnected,TimeoutError,ConnectionError))
            or isinstance(error,urllib.error.URLError) and not isinstance(error,urllib.error.HTTPError)
            or isinstance(error,ValueError))


def due_directories(state, now):
    last = (state or {}).get('directories_at')
    try:
        if last and now-datetime.fromisoformat(last) < DIRECTORY_INTERVAL: return []
    except ValueError:
        pass
    return [f'https://gametime.co/c/{slug}' for slug in DIRECTORIES]


def main():
    global RELIABILITY
    if os.environ.get('GITHUB_ACTIONS') != 'true': raise RuntimeError('Performer sweep is hosted-only')
    if getattr(collect,'GUARD',None) is None:
        print('Guarded schema not deployed; performer sweep skipped.')
        return
    RELIABILITY = teams.available(collect.sb)
    limit = max(1,min(200,int(os.environ.get('TIX_PERFORMER_LIMIT') or PAGE_LIMIT)))
    now = datetime.now(timezone.utc)
    rows = collect.sb('GET','tix_state?k=eq.performer_sweep&select=v&limit=1')
    state = rows[0]['v'] if rows else {}
    if isinstance(state,str): state = json.loads(state)
    stats = {'started_at':now.isoformat(),'pages':0,'events':0,'updated':0,'history':0,'failed':0,'deferred':None,
             'directories_at':state.get('directories_at') if isinstance(state,dict) else None,'directories':{}}
    stop = None
    try:
        directories = due_directories(state if isinstance(state,dict) else {}, now)
        for url in directories:
            slug = url.rsplit('/',1)[-1]
            try:
                events,saved = sweep_page(url)
                stats['directories'][slug] = {'events':events,'updated':saved['updated']}
                stats['pages'] += 1; stats['events'] += events; stats['updated'] += saved['updated']; stats['history'] += saved['history']
            except CaptureDeferred:
                raise
            except Exception as error:
                if not isolated(error): raise
                stats['directories'][slug] = {'error':getattr(error,'code',None) or type(error).__name__}
            collect.time.sleep(collect.BACKGROUND_PAUSE_SECONDS)
        if directories: stats['directories_at'] = now.isoformat()
        try: collect.note_performers()
        except Exception as error: print(f'performer links not saved: {type(error).__name__}',file=sys.stderr)
        due = collect.sb('GET',f'tix_performers?next_check_at=lte.{now.isoformat().replace("+00:00","Z")}'
                         f'&select=path,failures&order=next_check_at,path&limit={limit}')
        for row in due:
            checked = datetime.now(timezone.utc)
            try:
                events,saved = sweep_page('https://gametime.co'+row['path'])
                update = {'checked_at':checked.isoformat(),'events':events,'priced':saved['updated'],'failures':0,
                          'last_status':'ok','next_check_at':(checked+next_check(saved['updated'])).isoformat()}
                stats['pages'] += 1; stats['events'] += events; stats['updated'] += saved['updated']; stats['history'] += saved['history']
            except CaptureDeferred:
                raise
            except Exception as error:
                if not isolated(error): raise
                failures = (row.get('failures') or 0)+1
                update = {'checked_at':checked.isoformat(),'failures':failures,
                          'last_status':str(getattr(error,'code',None) or type(error).__name__)[:40],
                          'next_check_at':(checked+next_check(0,failures)).isoformat()}
                stats['failed'] += 1
                if RELIABILITY: collect.sb('POST','rpc/tix_team_check_failed',{'p_team_id':row['path'].rsplit('/',1)[-1],'p_status':update['last_status']})
                print(f'performer page skipped: {row["path"]}: {update["last_status"]}',flush=True)
            collect.sb('PATCH','tix_performers?path=eq.'+row['path'],update)
            collect.time.sleep(collect.BACKGROUND_PAUSE_SECONDS)
    except CaptureDeferred as error:
        # Background budget used up, or provider paused: resume next run.
        stats['deferred'] = error.reason
        stop = error
    finally:
        try: collect.note_performers()
        except Exception as error: print(f'performer links not saved: {type(error).__name__}',file=sys.stderr)
        stats['finished_at'] = datetime.now(timezone.utc).isoformat()
        collect.write_state('performer_sweep',stats)
        print(f"Performer sweep: {stats['pages']} pages, {stats['events']} priced events listed, "
              f"{stats['updated']} catalog prices saved, {stats['history']} history points, "
              f"{stats['failed']} pages skipped, deferred={stats['deferred']}",flush=True)
    if stop is not None and stop.state == 'suspended' and stop.reason != 'rollout_disabled':
        raise RuntimeError('Provider checks are paused after a blocking response; see ROLLOUT.md')


if __name__ == '__main__':
    main()
