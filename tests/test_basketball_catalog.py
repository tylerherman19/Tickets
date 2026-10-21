import os
import sys
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
os.environ.setdefault('SUPABASE_URL','https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY','test')
import tickets_basketball_catalog as catalog

class BasketballCatalogTests(unittest.TestCase):
    def test_budget_exhaustion_defers_without_claiming_a_team_failed_or_checked(self):
        from ticketline_guard import CaptureDeferred
        coverage={'teams':{}}
        pages=['https://gametime.co/team/performers/cbbone','https://gametime.co/team/performers/cbbtwo']
        with patch.object(catalog.collect,'write_state') as saved:
            with self.assertRaises(CaptureDeferred):
                catalog.import_pages(pages,lambda url: (_ for _ in ()).throw(CaptureDeferred('request_limit')),coverage,lambda data:[],workers=1)
        self.assertEqual(coverage['teams'],{})
        self.assertNotIn('errors',coverage)
        self.assertEqual(coverage['deferred']['reason'],'request_limit')
        saved.assert_called_once()

    def test_directory_admission_deferral_is_a_clean_scheduled_exit(self):
        from ticketline_guard import CaptureDeferred
        with patch.object(catalog,'run_import',side_effect=CaptureDeferred('request_limit')):
            catalog.main()
        with patch.object(catalog,'run_import',side_effect=RuntimeError('database failed')):
            with self.assertRaisesRegex(RuntimeError,'database failed'):catalog.main()

    def test_only_upcoming_college_games_import_without_overwriting_prices(self):
        date=datetime.now(timezone.utc).date()+timedelta(days=5)
        def url(category,eid):
            return f'https://gametime.co/{category}/duke-at-syracuse-tickets/{date.month}-{date.day}-{date.year}-syracuse-ny-jma-wireless-dome/events/{eid}'
        source={'events':[{'id':eid,'category':cat,'seoUrl':url('basketball',eid),'name':'Duke at Syracuse'} for cat,eid in [('cbb','a'*24),('nba','b'*24),('cfb','c'*24)]]}
        rows=catalog.catalog_rows(source)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['category'],'college-basketball')
        self.assertNotIn('min_total',rows[0])
        self.assertNotIn('price_checked_at',rows[0])

    def test_local_execution_is_denied(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}),patch.object(catalog,'fetch_once') as fetch:
            with self.assertRaises(RuntimeError): catalog.main()
            fetch.assert_not_called()

    def test_directory_includes_all_linked_college_teams_and_excludes_other_sports(self):
        teams=[{'category':'cbb','seoUrl':f'https://gametime.co/team-{n}-basketball-tickets/performers/cbb{n}'} for n in range(20)]
        teams.append({'category':'nba','seoUrl':'https://gametime.co/lakers-tickets/performers/nbalal'})
        self.assertEqual(len(catalog.team_pages(teams)),20)

    def test_directory_data_decodes_without_executing_script(self):
        data=catalog.page_data('window.__data={"value":undefined,"name":"undefined"};alert("bad")')
        self.assertIsNone(data['value'])
        self.assertEqual(data['name'],'undefined')

    def test_batch_cursor_covers_the_whole_directory_and_wraps(self):
        pages=list(range(120))
        self.assertEqual(catalog.team_batch(pages,96),list(range(96,120))+list(range(24)))
        self.assertEqual(set(catalog.team_batch(pages,0)+catalog.team_batch(pages,48)+catalog.team_batch(pages,96)),set(pages))
        self.assertEqual(catalog.team_batch([],0),[])
        self.assertEqual(catalog.team_batch(['one'],3),['one'])

    def test_valid_directory_prices_are_saved_as_get_in_only_even_beyond_30_days(self):
        date=datetime.now(timezone.utc).date()+timedelta(days=90)
        url=f'https://gametime.co/basketball/duke-at-orange-tickets/{date.month}-{date.day}-{date.year}-syracuse-ny-dome/events/'+('a'*24)
        for key in ('minPrice','min_price'):
            rows=catalog.catalog_rows({'category':'cbb','id':'a'*24,'seoUrl':url,key:{'total':1200}})
            self.assertEqual(rows[0]['min_total'],1200)
            self.assertEqual(rows[0]['discovery_status'],'metadata_only')
            self.assertTrue(rows[0]['price_checked_at'])
            self.assertNotIn('by_qty',rows[0])

    def test_unknown_zero_invalid_or_conflicting_prices_cannot_become_prices(self):
        for value in (None,{},[],0,{'total':None},{'total':0},{'total':-1},{'total':True},{'total':12.5},{'total':'1200'}):
            self.assertIsNone(catalog.get_in_price({'minPrice':value}))
        self.assertIsNone(catalog.get_in_price({'minPrice':{'total':1200},'min_price':{'total':1800}}))

    def test_mixed_price_batches_keep_identical_keys_without_erasing_saved_prices(self):
        rows=[{'event_id':'a','name':'A'}, {'event_id':'b','name':'B','min_total':1200,'price_checked_at':'now','discovery_status':'metadata_only'}]
        with patch.object(catalog.collect,'sb') as db:
            catalog.save_rows(rows)
        self.assertEqual(db.call_count,2)
        self.assertNotIn('min_total',db.call_args_list[0].args[2][0])
        self.assertEqual(db.call_args_list[1].args[2][0]['min_total'],1200)

    def test_coverage_prioritizes_missing_teams_then_oldest_check(self):
        pages=['https://gametime.co/a/performers/cbba','https://gametime.co/b/performers/cbbb','https://gametime.co/c/performers/cbbc']
        state={'teams':{'cbba':{'checked_at':'2026-10-15'},'cbbb':{'checked_at':'2026-10-01'}}}
        self.assertEqual(catalog.scheduled_pages(pages,state,3),[pages[2],pages[1],pages[0]])
        pages.append('https://gametime.co/new/performers/cbbnew')
        self.assertIn(pages[-1],catalog.scheduled_pages(pages,state,2))

    def test_failed_team_does_not_mark_coverage_complete_or_start_next_batch(self):
        pages=[f'https://gametime.co/team/performers/cbb{n}' for n in range(8)]
        attempted=[]
        def load(url):
            attempted.append(url)
            if url==pages[1]: raise RuntimeError('provider blocked')
            return {'id':url}
        state={'teams':{}}
        with patch.object(catalog.collect,'write_state') as save_state:
            with self.assertRaisesRegex(RuntimeError,'blocked'):
                catalog.import_pages(pages,load,state,lambda data:[],workers=4)
        self.assertEqual(set(attempted),set(pages[:4]))
        self.assertNotIn('cbb1',state['teams'])
        self.assertEqual(set(state['teams']),{'cbb0','cbb2','cbb3'})
        self.assertNotIn('bootstrap_completed_at',state)
        save_state.assert_called_once()

    def test_transient_failure_is_recorded_and_success_clears_it(self):
        import urllib.error
        url='https://gametime.co/team/performers/cbbteam'
        state={'teams':{}}
        with patch.object(catalog.collect,'write_state'):
            catalog.import_pages([url],lambda _:(_ for _ in ()).throw(urllib.error.HTTPError(url,502,'upstream',{},None)),state,lambda _:[],workers=1)
            self.assertEqual(state['errors']['cbbteam']['status'],502)
            self.assertNotIn('cbbteam',state['teams'])
            catalog.import_pages([url],lambda _:{},state,lambda _:[],workers=1)
            self.assertIn('cbbteam',state['teams'])
            self.assertNotIn('cbbteam',state['errors'])

    def test_one_upstream_team_failure_does_not_hide_other_teams(self):
        import urllib.error
        pages=[f'https://gametime.co/team/performers/cbb{n}' for n in range(8)]
        attempted=[]
        def load(url):
            attempted.append(url)
            if url==pages[1]: raise urllib.error.HTTPError(url,502,'upstream',{},None)
            return {}
        state={'teams':{}}
        with patch.object(catalog.collect,'write_state'):
            catalog.import_pages(pages,load,state,lambda _:[],workers=4)
        self.assertEqual(len(attempted),8)
        self.assertEqual(attempted.count(pages[1]),1)
        self.assertEqual(len(state['teams']),7)
        self.assertNotIn('cbb1',state['teams'])
        self.assertEqual(state['errors']['cbb1']['status'],502)

    def test_incomplete_body_is_isolated_but_http_blocking_stops_new_work(self):
        import http.client
        import urllib.error
        pages=[f'https://gametime.co/team/performers/cbb{n}' for n in range(8)]
        for error,expected in [(http.client.IncompleteRead(b'partial'),8),(urllib.error.HTTPError(pages[0],403,'blocked',{},None),4)]:
            attempted=[]
            def load(url):
                attempted.append(url)
                if url==pages[0]: raise error
                return {}
            with patch.object(catalog.collect,'write_state'):
                if expected==4:
                    with self.assertRaises(urllib.error.HTTPError): catalog.import_pages(pages,load,{'teams':{}},lambda _:[],workers=4)
                else:
                    catalog.import_pages(pages,load,{'teams':{}},lambda _:[],workers=4)
            self.assertEqual(len(attempted),expected)

