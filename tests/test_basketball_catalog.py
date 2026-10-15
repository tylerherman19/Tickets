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
