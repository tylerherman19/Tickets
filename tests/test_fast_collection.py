import contextlib
import json
import os
import sys
import unittest
import urllib.error
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock
os.environ.setdefault('SUPABASE_URL','https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY','test')
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
from ticketline_guard import Guard, CaptureDeferred
import tickets_collect as c
import tickets_performers as performers
import tickets_basketball_catalog as basketball

# Provider and database calls are mocked; nothing here contacts Gametime.

class FakeGuard:
    """Records capture sources; optionally defers chosen events."""
    def __init__(self, deferrals=None):
        self.sources=[]
        self.deferrals=deferrals or {}
        self.event_id=None
        self.token='lease'
    @contextlib.contextmanager
    def capture(self, event_id, source):
        self.sources.append((event_id,source))
        if event_id in self.deferrals: raise self.deferrals[event_id]
        self.event_id=event_id
        yield self


class GuardWaitTests(unittest.TestCase):
    def setUp(self):
        self.calls=[];self.slept=[];self.admissions=[]
        def rpc(name,body):
            self.calls.append(name)
            if name=='tix_claim_capture': return {'state':'checking','token':'lease'}
            if name=='tix_admit_provider_http': return self.admissions.pop(0)
        self.guard=Guard(rpc,sleep=self.slept.append,clock=lambda:datetime(2026,10,16,tzinfo=timezone.utc).timestamp())
    def test_full_minute_window_waits_once_then_proceeds(self):
        self.admissions=[{'allowed':False,'reason':'request_limit','next_attempt_at':'2026-10-16T00:00:05+00:00'},{'allowed':True}]
        with self.guard.capture('event','discovery'):
            self.guard.admit(wait=True)
        self.assertEqual(self.slept,[5.0])
        self.assertEqual(self.calls.count('tix_admit_provider_http'),2)
    def test_hourly_or_daily_limit_defers_without_waiting(self):
        self.admissions=[{'allowed':False,'reason':'request_limit','next_attempt_at':'2026-10-16T00:40:00Z'}]
        with self.assertRaises(CaptureDeferred) as raised:
            with self.guard.capture('event','discovery'):
                self.guard.admit(wait=True)
        self.assertEqual(self.slept,[])
        self.assertEqual(raised.exception.reason,'request_limit')
    def test_browser_subrequests_never_wait(self):
        self.admissions=[{'allowed':False,'reason':'request_limit','next_attempt_at':'2026-10-16T00:00:05Z'}]
        with self.assertRaises(CaptureDeferred):
            with self.guard.capture('event','collector'):
                self.guard.admit()
        self.assertEqual(self.slept,[])
    def test_paused_provider_is_reported_as_suspended(self):
        guard=Guard(lambda name,body:{'state':'suspended','reason':'HTTP_429'})
        with self.assertRaises(CaptureDeferred) as raised:
            with guard.capture('event','edge'): pass
        self.assertEqual((raised.exception.state,raised.exception.reason),('suspended','HTTP_429'))


class DiscoveryLoopTests(unittest.TestCase):
    def run_main(self, discovery, guard, fetch=None):
        writes=[];rpcs=[]
        def db(method,path,body=None,prefer=None):
            if path=='rpc/tix_note_performers': rpcs.append(body); return len(body['p_paths'])
            if method!='GET': writes.append((path,body))
            return []
        page_fetch=fetch or (lambda url,discovery=False:('metadata_only',{'event_id':url.rsplit('/',1)[-1],'min_total':1500},[]))
        def fetch_and_harvest(url,discovery=False):
            c.PERFORMERS.add('/minnesota-vikings-tickets/performers/nflmin')
            return page_fetch(url,discovery)
        with patch.object(c,'GUARD',guard),patch.object(c,'sb',side_effect=db),patch.object(c,'expire_event_storage',return_value=0), \
             patch.object(c,'catalog_stale',return_value=False),patch.object(c,'send_pending_confirmations',return_value=0), \
             patch.object(c,'discovery_due',return_value=discovery),patch.object(c,'fetch_provider_page',side_effect=fetch_and_harvest), \
             patch.object(c,'record_event_market',return_value=({},0)) as saved,patch.object(c,'rendered_quantity_listings') as rendered, \
             patch.object(c,'write_state') as state,patch.object(c.time,'sleep'):
            try: c.main()
            except RuntimeError as error: self.error=error
            else: self.error=None
        return state.call_args.args[1],saved,rendered,rpcs
    def event(self,eid,tracked=False):
        row={'event_id':eid,'event_date':(c.NOW+timedelta(days=3)).date().isoformat(),'url':'https://gametime.co/events/'+eid}
        if tracked: row['_history_requested']=True
        return row
    def test_opened_events_are_foreground_and_never_rendered_in_a_browser(self):
        guard=FakeGuard()
        health,saved,rendered,rpcs=self.run_main([self.event('t',True),self.event('d')],guard)
        self.assertEqual(guard.sources,[('t','tracked'),('d','discovery')])
        rendered.assert_not_called()
        self.assertEqual(saved.call_count,2)
        self.assertEqual(health['tracked_checked'],1)
        # Get-in-only public pages are the provider's normal format, not a degraded run.
        self.assertEqual(health['status'],'ok')
        self.assertEqual(health['discovery_metadata_only'],2)
        self.assertEqual(rpcs,[{'p_paths':['/minnesota-vikings-tickets/performers/nflmin']}])
    def test_budget_limit_stops_background_work_but_busy_events_are_skipped(self):
        guard=FakeGuard({'busy':CaptureDeferred('provider_busy'),'limit':CaptureDeferred('request_limit')})
        health,saved,_,_=self.run_main([self.event('busy'),self.event('ok'),self.event('limit'),self.event('never')],guard)
        self.assertEqual([s[0] for s in guard.sources],['busy','ok','limit'])
        self.assertEqual(saved.call_count,1)
        self.assertEqual(health['deferred'],{'provider_busy':1,'request_limit':1})
        self.assertEqual(health['status'],'ok')
    def test_provider_blocking_pause_is_an_error_but_rollout_pause_is_not(self):
        health,_,_,_=self.run_main([self.event('a'),self.event('b')],FakeGuard({'a':CaptureDeferred('HTTP_429','suspended')}))
        self.assertEqual((health['status'],health['provider_paused']),('error','HTTP_429'))
        self.assertIsNotNone(self.error)
        health,_,_,_=self.run_main([self.event('a')],FakeGuard({'a':CaptureDeferred('rollout_disabled','suspended')}))
        self.assertEqual(health['status'],'ok')
        self.assertIsNone(self.error)


class CatalogTests(unittest.TestCase):
    def test_sitemap_refresh_keeps_provider_verified_college_category(self):
        date=(datetime.now(timezone.utc)+timedelta(days=5)).date()
        loc=lambda eid:f'https://gametime.co/sports/duke-at-syracuse-tickets/{date.month}-{date.day}-{date.year}-syracuse-ny-dome/events/{eid}'
        xml='<loc>'+loc('a'*24)+'</loc><loc>'+loc('b'*24)+'</loc>'
        upserts=[]
        def db(method,path,body=None,prefer=None):
            if path.startswith('tix_catalog?category=eq.college-basketball'): return [{'event_id':'a'*24}]
            if path.startswith('tix_catalog?on_conflict'): upserts.extend(body)
            return []
        with patch.object(c,'sb',side_effect=db),patch.object(c,'get_text',return_value=xml):
            c._refresh_catalog()
        categories={row['event_id']:row['category'] for row in upserts}
        self.assertEqual(categories,{'a'*24:'college-basketball','b'*24:'sports'})
    def test_performer_links_match_edge_harvester(self):
        html=('<a href="https://gametime.co/minnesota-vikings-tickets/performers/nflmin">V</a>'
              '<astro-island props="{&quot;u&quot;:&quot;https:\\/\\/gametime.co\\/nba-basketball\\/lakers-tickets\\/performers\\/nbalal&quot;}"></astro-island>'
              '<a href="/hamilton-tickets/performers/hamilton">H</a><a href="/syracuse-orange-tickets/performers/cbbsyr">S</a>'
              ' /a/b/c/performers/deep https://evil.test/x-tickets/performers/bad')
        self.assertEqual(c.performer_paths(html),['/minnesota-vikings-tickets/performers/nflmin','/nba-basketball/lakers-tickets/performers/nbalal','/hamilton-tickets/performers/hamilton'])
    def test_college_prices_feed_bounded_history_only_on_guarded_schema(self):
        rows=[{'event_id':'a'*24,'min_total':1200,'url':'x'},{'event_id':'b'*24,'url':'y'}]
        with patch.object(basketball.collect,'sb') as db:
            basketball.record_history(rows)
        self.assertEqual(db.call_args.args[1],'rpc/tix_apply_get_in_prices')
        self.assertEqual(db.call_args.args[2]['p_rows'],[{'event_id':'a'*24,'min_total':1200}])


def event_object(eid,days=10,price=1500,key='minPrice'):
    date=(datetime.now(timezone.utc)+timedelta(days=days)).date()
    obj={'id':eid,'seoUrl':f'https://gametime.co/nfl-football/packers-at-vikings-tickets/{date.month}-{date.day}-{date.year}-minneapolis-mn-us-bank-stadium/events/{eid}'}
    if price is not None: obj[key]={'total':price}
    return obj


class PerformerSweepTests(unittest.TestCase):
    def test_only_upcoming_valid_priced_events_are_saved(self):
        items=[event_object('a'*24),event_object('b'*24,days=400),event_object('c'*24,price=None),event_object('d'*24,price=0),
               {**event_object('e'*24),'id':'f'*24},{'id':'bad','seoUrl':'x','minPrice':{'total':100}},event_object('a'*24,price=1400,key='min_price')]
        self.assertEqual(performers.price_rows(items),[{'event_id':'a'*24,'min_total':1400}])
    def test_legacy_and_astro_pages_both_yield_events(self):
        legacy='window.__data='+json.dumps({'performer':{'events':[event_object('a'*24)]}})
        props=json.dumps({'events':[1,[[0,event_object('b'*24)]]]}).replace('"','&quot;')
        astro=f'<astro-island component-export="PerformerEvents" props="{props}"></astro-island>'
        self.assertEqual([r['event_id'] for r in performers.price_rows(performers.page_objects(legacy))],['a'*24])
        self.assertEqual([r['event_id'] for r in performers.price_rows(performers.page_objects(astro))],['b'*24])
    def test_local_runs_are_denied(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}),patch.object(performers.collect,'sb') as db:
            with self.assertRaisesRegex(RuntimeError,'hosted-only'): performers.main()
            db.assert_not_called()
    def test_pinned_collector_without_guard_skips_quietly(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}),patch.object(performers.collect,'GUARD',None),patch.object(performers.collect,'sb') as db:
            performers.main()
            db.assert_not_called()
    def sweep(self,pages,due,state=None,deferrals=None):
        guard=FakeGuard(deferrals);writes=[];applied=[]
        def db(method,path,body=None,prefer=None):
            if path.startswith('tix_state?'): return [{'v':state}] if state is not None else []
            if path.startswith('tix_performers?next_check_at'): return due
            if path=='rpc/tix_apply_get_in_prices': applied.append(body['p_rows']); return {'updated':len(body['p_rows']),'history':1}
            if path=='rpc/tix_note_performers': writes.append(('note',body)); return 0
            writes.append((path,body)); return []
        def fetch(url,timeout=25):
            page=pages[url]
            if isinstance(page,Exception): raise page
            return page
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}),patch.object(performers.collect,'GUARD',guard), \
             patch.object(performers.collect,'sb',side_effect=db),patch.object(performers.collect,'get_text',side_effect=fetch), \
             patch.object(performers.collect,'write_state') as state_write,patch.object(performers.collect.time,'sleep'):
            try: performers.main(); error=None
            except RuntimeError as raised: error=raised
        return guard,writes,applied,state_write.call_args.args[1],error
    def test_pages_save_prices_back_off_failures_and_skip_fresh_directories(self):
        page='window.__data='+json.dumps({'events':[event_object('a'*24),event_object('b'*24)]})+' <a href="/hamilton-tickets/performers/hamilton">'
        missing=urllib.error.HTTPError('https://gametime.co/x',404,'missing',{},None)
        pages={'https://gametime.co/vikings-tickets/performers/nflmin':page,'https://gametime.co/gone-tickets/performers/gone':missing}
        due=[{'path':'/vikings-tickets/performers/nflmin','failures':0},{'path':'/gone-tickets/performers/gone','failures':2}]
        guard,writes,applied,stats,error=self.sweep(pages,due,state={'directories_at':datetime.now(timezone.utc).isoformat()})
        self.assertIsNone(error)
        self.assertEqual([s[1] for s in guard.sources],['catalog','catalog'])
        self.assertEqual(applied,[[{'event_id':'a'*24,'min_total':1500},{'event_id':'b'*24,'min_total':1500}]])
        ok=next(body for path,body in writes if path=='tix_performers?path=eq./vikings-tickets/performers/nflmin')
        self.assertEqual((ok['priced'],ok['failures'],ok['last_status']),(2,0,'ok'))
        gone=next(body for path,body in writes if path=='tix_performers?path=eq./gone-tickets/performers/gone')
        self.assertEqual((gone['failures'],gone['last_status']),(3,'404'))
        self.assertTrue(any(kind=='note' and body['p_paths']==['/hamilton-tickets/performers/hamilton'] for kind,body in writes))
        self.assertEqual((stats['pages'],stats['updated'],stats['failed']),(1,2,1))
    def test_daily_directories_run_once_and_unavailable_ones_are_recorded(self):
        missing=urllib.error.HTTPError('https://gametime.co/c/x',404,'missing',{},None)
        pages={f'https://gametime.co/c/{slug}':missing for slug in performers.DIRECTORIES}
        pages['https://gametime.co/c/nfl-football']='window.__data='+json.dumps({'events':[event_object('a'*24)]})
        guard,_,applied,stats,error=self.sweep(pages,[])
        self.assertIsNone(error)
        self.assertEqual(len(guard.sources),len(performers.DIRECTORIES))
        self.assertEqual(stats['directories']['nfl-football'],{'events':1,'updated':1})
        self.assertEqual(stats['directories']['theater'],{'error':404})
        self.assertTrue(stats['directories_at'])
    def test_budget_deferral_stops_and_provider_pause_fails_the_run(self):
        due=[{'path':f'/p{n}-tickets/performers/p{n}','failures':0} for n in range(3)]
        for reason,state,expect_error in [('request_limit','queued',False),('HTTP_403','suspended',True)]:
            guard=FakeGuard()
            calls=[]
            @contextlib.contextmanager
            def capture(event_id,source):
                calls.append(source)
                if len(calls)==2: raise CaptureDeferred(reason,state)
                yield guard
            guard.capture=capture
            page='window.__data={}'
            with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}),patch.object(performers.collect,'GUARD',guard), \
                 patch.object(performers.collect,'sb',side_effect=lambda m,p,b=None,prefer=None:due if p.startswith('tix_performers?next') else [{'v':{'directories_at':datetime.now(timezone.utc).isoformat()}}] if p.startswith('tix_state') else []), \
                 patch.object(performers.collect,'get_text',return_value=page),patch.object(performers.collect,'write_state') as state_write,patch.object(performers.collect.time,'sleep'):
                if expect_error:
                    with self.assertRaisesRegex(RuntimeError,'paused'): performers.main()
                else: performers.main()
            self.assertEqual(len(calls),2)
            self.assertEqual(state_write.call_args.args[1]['deferred'],reason)
    def test_directories_are_providers_own_category_links(self):
        # Gametime's menu links WNBA at /c/wnba and has no /c/ page for concerts.
        self.assertIn('wnba',performers.DIRECTORIES)
        for dead in ('wnba-basketball','concerts'): self.assertNotIn(dead,performers.DIRECTORIES)
    def test_redirected_page_is_skipped_but_blocking_is_not(self):
        for code in (301,302,307,308):
            self.assertTrue(performers.isolated(urllib.error.HTTPError('https://gametime.co/x',code,'moved',{},None)))
        for code in (403,429):
            self.assertFalse(performers.isolated(urllib.error.HTTPError('https://gametime.co/x',code,'blocked',{},None)))
    def test_backoff_schedule(self):
        self.assertEqual(performers.next_check(5),timedelta(hours=18))
        self.assertEqual(performers.next_check(0),timedelta(days=7))
        self.assertEqual(performers.next_check(0,3),timedelta(days=8))
        self.assertEqual(performers.next_check(0,9),timedelta(days=30))


class WorkflowTests(unittest.TestCase):
    def test_performer_sweep_is_scheduled_without_delivery_credentials(self):
        from pathlib import Path
        workflow=Path('.github/workflows/tickets-performers.yml').read_text()
        self.assertIn('tickets_release_gate.py',workflow)
        self.assertIn('tickets_performers.py',workflow)
        self.assertNotIn('GMAIL',workflow)
        self.assertIn('schedule:',workflow)


if __name__=='__main__':
    unittest.main()
