import unittest, sys, os
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
import tickets_team_catalog as t

class TeamCatalogTests(unittest.TestCase):
    def team(self,name='Wisconsin Badgers Basketball',code='cbbwis'):
        return {'name':name,'category':'cbb','slug':code,'seoUrl':f'https://gametime.co/wisconsin-tickets/performers/{code}',
                'shortName':'Badgers','mediumName':'WISC Badgers'}
    def event(self):
        return {'id':'a'*24,'seoUrl':'https://gametime.co/x/events/'+'a'*24,
                'performers':[{'slug':'cbbwis'},{'slug':'cbbnw'}]}
    def test_names_and_ambiguous_aliases_preserve_unique_provider_id(self):
        rows=t.team_rows([self.team(),self.team('Washington Huskies Basketball','cbbwash')])
        self.assertEqual([r['team_id'] for r in rows],['cbbwis','cbbwash'])
        self.assertTrue(all('UW' in r['aliases'] for r in rows))
        self.assertIn('WISC',rows[0]['aliases'])
        self.assertIn('Badgers',rows[0]['aliases'])
    def test_untrusted_paths_unknown_sports_and_contradictory_slugs_are_rejected(self):
        for values in ({'category':'unknown'},{'seoUrl':'https://evil.test/x/performers/cbbwis'},
                       {'seoUrl':'https://gametime.co/x/performers/cbbwis?bad=yes'}, {'slug':'cbbother'},
                       {'seoUrl':'https://gametime.co/a/b/c/performers/cbbwis'}):
            self.assertEqual(t.team_rows({**self.team(),**values}),[])
    def test_membership_requires_source_identity_home_role_is_never_guessed(self):
        e=self.event();e['name']='Wisconsin Badgers at Northwestern Wildcats'
        rows=t.event_links(e)
        self.assertEqual(set(rows),{'cbbwis','cbbnw'})
        self.assertIsNone(rows['cbbwis'][0]['is_home'])
        e['homePerformer']={'slug':'cbbnw'};e['awayPerformerSlug']='cbbwis'
        rows=t.event_links(e)
        self.assertEqual(rows['cbbwis'][0]['is_home'],False)
        self.assertEqual(rows['cbbnw'][0]['is_home'],True)
    def test_team_page_maps_events_without_performer_metadata(self):
        event=self.event();event.pop('performers')
        self.assertEqual(t.event_links({'performer':{'slug':'cbbwis'},'schedule':[event]},'cbbwis'),{'cbbwis':[{'event_id':'a'*24,'is_home':None}]})
        self.assertEqual(t.event_links({'schedule':[], 'recommendations':[event]},'cbbwis'),{})
        self.assertEqual(t.event_links(event),{})
    def test_empty_checked_team_page_fulfills_demand_and_unchanged_prices_are_irrelevant(self):
        calls=[]
        t.save_links({},lambda *args:calls.append(args),'cbbwis',True)
        self.assertEqual(calls,[('POST','rpc/tix_link_team_events',{'p_team_id':'cbbwis','p_rows':[],'p_checked':True})])
    def test_old_schema_detection_only_tolerates_missing_rpc(self):
        import urllib.error
        def missing(*a):raise urllib.error.HTTPError('x',404,'missing',{},None)
        self.assertFalse(t.available(missing))
        def denied(*a):raise urllib.error.HTTPError('x',403,'denied',{},None)
        with self.assertRaises(urllib.error.HTTPError):t.available(denied)

    def test_unrelated_recommendations_never_inherit_the_context_team(self):
        event=self.event()
        event['performers']=[{'slug':'cbbduke'},{'slug':'cbbsyr'}]
        result=t.event_links({'performer':{'slug':'cbbwis'},'schedule':[], 'recommendations':[event]},'cbbwis')
        self.assertNotIn('cbbwis',result)
        self.assertEqual(set(result),{'cbbduke','cbbsyr'})
        event.pop('performers')
        self.assertNotIn('cbbwis',t.event_links({'performer':{'slug':'cbbwis'},'recommendations':[event]},'cbbwis'))
