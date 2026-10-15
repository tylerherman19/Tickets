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
