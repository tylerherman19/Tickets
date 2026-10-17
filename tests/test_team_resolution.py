import os
import sys
import unittest
from datetime import timedelta
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
os.environ.setdefault('SUPABASE_URL', 'https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY', 'test')
import tickets_collect as collector


class TeamResolutionTests(unittest.TestCase):
    def test_canonical_team_matches_source_mapping_and_honors_home_away(self):
        date = (collector.NOW.date() + timedelta(days=20)).isoformat()
        rows = [{'event_id': side, 'event_date':date, 'is_home': home, 'category':'college-basketball',
                 'slug':'name-without-an-at-pattern'} for side, home in [('home',True),('away',False),('neutral',None)]]
        watch = {'kind':'team', 'match':{'team_id':'cbbwis', 'slug':'badgers', 'category':'college-basketball'}}
        for preference, expected in [('home',['home']),('away',['away']),('any',['home','away','neutral'])]:
            watch['match']['home_away'] = preference
            with patch.object(collector,'sb',return_value=rows) as db:
                result = collector.resolve_events(watch)
            self.assertEqual([row['event_id'] for row in result], expected)
            db.assert_called_once_with('POST','rpc/tix_search_team_events',{'p_team_id':'cbbwis','p_limit':500})

    def test_missing_identity_rpc_never_falls_back_to_nickname(self):
        watch = {'kind':'team','match':{'team_id':'cbbwis','slug':'badgers'}}
        with patch.object(collector,'sb',side_effect=RuntimeError('RPC deployment pending')) as db:
            with self.assertRaisesRegex(RuntimeError,'deployment pending'):
                collector.resolve_events(watch)
        self.assertEqual(db.call_count,1)

    def test_unmapped_identity_returns_no_events_without_broadening(self):
        with patch.object(collector,'sb',return_value=[]) as db:
            self.assertEqual(collector.resolve_events({'kind':'team','match':{'team_id':'cbbwis','slug':'badgers'}}),[])
        self.assertEqual(db.call_count,1)

    def test_canonical_results_recheck_category_date_horizon_and_deduplicate(self):
        date = (collector.NOW.date() + timedelta(days=10)).isoformat()
        rows = [dict(event_id='correct',event_date=date,category='college-basketball',is_home=True)] * 2
        rows += [dict(event_id='old',event_date=(collector.NOW.date()-timedelta(days=1)).isoformat(),category='college-basketball'),
                 dict(event_id='far',event_date=(collector.NOW.date()+timedelta(days=366)).isoformat(),category='college-basketball'),
                 dict(event_id='football',event_date=date,category='college-football')]
        with patch.object(collector,'sb',return_value=rows):
            result = collector.resolve_events({'kind':'team','match':{'team_id':'cbbwis','category':'college-basketball'}})
        self.assertEqual([row['event_id'] for row in result],['correct'])

    def test_invalid_team_identity_never_queries_or_matches_legacy_slug(self):
        for identity in ('',None,'Wisconsin','badgers OR 1=1','cbb/wis','x'):
            with patch.object(collector,'sb') as db:
                with self.assertRaises(ValueError):
                    collector.resolve_events({'kind':'team','match':{'team_id':identity,'slug':'badgers'}})
                db.assert_not_called()

    def test_unknown_home_status_is_excluded_from_home_or_away(self):
        rows = [{'event_id':'unknown','event_date':collector.NOW.date().isoformat()}]
        for preference in ('home','away'):
            with patch.object(collector,'sb',return_value=rows):
                self.assertEqual(collector.resolve_events({'kind':'team','match':{'team_id':'cbbwis','home_away':preference}}),[])

    def test_legacy_team_alerts_keep_existing_slug_behavior(self):
        rows = [{'event_id':'home','slug':'cornell-at-wisconsin-badgers'},
                {'event_id':'away','slug':'wisconsin-badgers-at-cornell'},
                {'event_id':'other','slug':'wisconsin-other'}]
        with patch.object(collector,'sb',return_value=rows) as db:
            result = collector.resolve_events({'kind':'team','match':{'slug':'wisconsin-badgers','home_away':'home'}})
        self.assertEqual([row['event_id'] for row in result],['home'])
        self.assertEqual(db.call_args.args[0],'GET')


if __name__ == '__main__':
    unittest.main()
