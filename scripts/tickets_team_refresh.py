#!/usr/bin/env python3
"""Hosted, bounded foreground refresh of team pages requested by searches.

No notifications and no personal data are handled. Every Gametime request is
admitted through the same provider guard as search/alerts, and blocking stops
all work without retries. Ordinary missing/broken pages back off independently.
"""
import os
from datetime import datetime, timezone, timedelta
import tickets_collect as collect
import tickets_performers as performers
import tickets_team_catalog as teams
from tickets_basketball_catalog import save_rows, get_in_price, record_history
from ticketline_guard import CaptureDeferred


def catalog_rows(items,category,today=None):
    today=today or datetime.now(timezone.utc).date()
    rows={}
    for item in items:
        eid=item.get('id')
        url=item.get('seoUrl') or item.get('seo_url') or ''
        if not isinstance(eid,str) or not teams.EVENT.fullmatch(eid): continue
        row=collect.parse_catalog_url(url) if isinstance(url,str) else None
        if not row or row['event_id']!=eid: continue
        source_value=item.get('category')
        source_category=teams.CATEGORIES.get(source_value)
        if source_value is not None and source_category!=category: continue
        generic={'college-basketball':{'sports','basketball'},'college-football':{'sports','football'}}.get(category,{'sports'})
        if row['category']!=category and not(source_category==category and row['category'] in generic): continue
        event_date=datetime.fromisoformat(row['event_date']).date()
        if not today<=event_date<=today+timedelta(days=365): continue
        row['category']=category
        if isinstance(item.get('name'),str) and item['name'].strip(): row['name']=item['name'].strip()
        price=get_in_price(item)
        if price is not None:
            row.update(min_total=price,price_checked_at=datetime.now(timezone.utc).isoformat(),discovery_status='metadata_only')
        if row['event_id'] not in rows or 'min_total' in row: rows[row['event_id']]=row
    return list(rows.values())


REGISTRY_DIRECTORIES={'nfl-football':'nfl-football','nba-basketball':'nba-basketball','mlb-baseball':'mlb-baseball',
                      'nhl-hockey':'nhl-hockey','college-football':'college-football','college-basketball':'college-basketball',
                      'mls-soccer':'mls-soccer','wnba':'wnba'}

def bootstrap_registry(force=False):
    total=0
    for category,directory in REGISTRY_DIRECTORIES.items():
        existing=collect.sb('POST','rpc/tix_resolve_teams',{'p_query':'','p_category':category,'p_limit':1})
        if existing and not force: continue
        try:
            with collect.GUARD.capture(None,'catalog'):
                page=collect.get_text('https://gametime.co/c/'+directory)
            items=performers.page_objects(page)
            if not items: raise ValueError('Directory page data missing')
            total+=teams.save_teams(items,collect.sb)
            rows=catalog_rows(items,category)
            save_rows(rows)
            record_history(rows)
            teams.save_links(items,collect.sb)
        except CaptureDeferred: raise
        except Exception as error:
            if not performers.isolated(error): raise
            print(f'Team identity directory unavailable: {category}; {type(error).__name__}')
        collect.time.sleep(collect.BACKGROUND_PAUSE_SECONDS)
    return total


def main():
    if os.environ.get('GITHUB_ACTIONS')!='true': raise RuntimeError('Team demand refresh is hosted-only')
    if getattr(collect,'GUARD',None) is None or not teams.available(collect.sb):
        print('Team demand schema is not deployed; existing collector continues.')
        return
    limit=max(1,min(24,int(os.environ.get('TIX_TEAM_REFRESH_LIMIT') or 12)))
    try:
        initialized=bootstrap_registry(os.environ.get('TIX_TEAM_REGISTRY_BOOTSTRAP')=='true')
    except CaptureDeferred as error:
        print(f'Team identity initialization deferred: {error.reason}')
        if error.state=='suspended' and error.reason!='rollout_disabled':
            raise RuntimeError('Provider checks are paused after a blocking response; see ROLLOUT.md')
        return
    due=collect.sb('POST','rpc/tix_team_refresh_due',{'p_category':None,'p_limit':limit})
    stats={'started_at':datetime.now(timezone.utc).isoformat(),'identities_imported':initialized,'requested':len(due),'checked':0,'events':0,'priced':0,'failed':0,'deferred':None}
    stop=None
    try:
        for row in due:
            try:
                # Foreground demand uses the foreground budget reserve. A null
                # event ID still requires allow_catalog plus a live guard lease.
                with collect.GUARD.capture(None,'tracked'):
                    page=collect.get_text('https://gametime.co'+row['path'])
                items=performers.page_objects(page)
                if not items: raise ValueError('Directory page data missing')
                rows=catalog_rows(items,row['category'])
                save_rows(rows)
                record_history(rows)
                teams.save_teams(items,collect.sb)
                teams.save_links(items,collect.sb,row['team_id'],True)
                stats['checked']+=1;stats['events']+=len(rows);stats['priced']+=sum('min_total' in x for x in rows)
            except CaptureDeferred: raise
            except Exception as error:
                if not performers.isolated(error): raise
                collect.sb('POST','rpc/tix_team_check_failed',{'p_team_id':row['team_id'],'p_status':str(getattr(error,'code',None) or type(error).__name__)})
                stats['failed']+=1
            collect.time.sleep(collect.BACKGROUND_PAUSE_SECONDS)
    except CaptureDeferred as error:
        stats['deferred']=error.reason
        stop=error
    finally:
        stats['finished_at']=datetime.now(timezone.utc).isoformat()
        collect.write_state('team_refresh_health',stats)
        print(f"Team demand refresh: {stats['checked']}/{stats['requested']} teams; {stats['events']} events, {stats['priced']} priced, {stats['failed']} failed; deferred={stats['deferred']}")
    if stop is not None and stop.state=='suspended' and stop.reason!='rollout_disabled':
        raise RuntimeError('Provider checks are paused after a blocking response; see ROLLOUT.md')

if __name__=='__main__': main()
