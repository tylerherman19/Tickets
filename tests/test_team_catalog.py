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
        washington={**self.team('Washington Huskies Basketball','cbbwash'),'shortName':'Huskies','mediumName':'WASH Huskies'}
        rows=t.team_rows([self.team(),washington])
        self.assertEqual([r['team_id'] for r in rows],['cbbwis','cbbwash'])
        self.assertTrue(all('UW' in r['aliases'] for r in rows))
        self.assertIn('WISC',rows[0]['aliases'])
        self.assertIn('Badgers',rows[0]['aliases'])
    def test_untrusted_paths_unknown_sports_and_contradictory_slugs_are_rejected(self):
        for values in ({'category':'unknown'},{'seoUrl':'https://evil.test/x/performers/cbbwis'},
                       {'seoUrl':'https://gametime.co/x/performers/cbbwis?bad=yes'}, {'slug':'cbbother'},
                       {'seoUrl':'https://gametime.co/a/b/c/performers/cbbwis'}):
            self.assertEqual(t.team_rows({**self.team(),**values}),[])
    def test_school_aliases_do_not_spread_to_other_campuses_or_state_schools(self):
        for label,mascot in [('Wisconsin Green Bay Basketball','Phoenix'),('Wisconsin Milwaukee Basketball','Panthers'),('Washington State Basketball','Cougars')]:
            row=t.team_rows({**self.team(label),'shortName':mascot,'mediumName':label})[0]
            self.assertNotIn('UW Madison',row['aliases'])
            self.assertNotIn('UW Seattle',row['aliases'])
            self.assertNotIn('UW',row['aliases'])
        for label in ['Wisconsin Basketball','Wisconsin Badgers Basketball',"Wisconsin Badgers Men's Basketball"]:
            self.assertIn('UW Madison',t.team_rows(self.team(label))[0]['aliases'])
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
    def test_live_mongo_performer_references_join_expanded_canonical_source_identities(self):
        # Shape verified in the guarded hosted Wisconsin/Syracuse page checks.
        wid='545d5fa83bf3761659000004';oid='5660e501f80c415b74000003'
        event={**self.event(),'performers':[{'id':wid,'primary':True},{'id':oid,'primary':False}]}
        wisconsin={**self.team('Wisconsin Basketball'),'id':wid}
        other={**self.team('Wyoming Basketball','cbbwyo'),'id':oid,'shortName':'Cowboys'}
        data={'redux':{'data':{'fullEvents':{'eventsData':[{'events':[{'event':event,'performers':[wisconsin,other]}]}]}}}}
        links=t.event_links(data,'cbbwis')
        self.assertEqual(set(links),{'cbbwis','cbbwyo'})
        self.assertIsNone(links['cbbwis'][0]['is_home'],'Primary is not proof of home designation')
        self.assertNotIn(wid,links)
        event['homeTeamId']=wid
        self.assertTrue(t.event_links(data)['cbbwis'][0]['is_home'])
        # Unmapped or contradictory Mongo IDs never become canonical teams.
        self.assertEqual(t.event_links(event),{})
        conflicting={**self.team('Other Basketball','cbbother'),'id':wid}
        self.assertNotIn('cbbwis',t.event_links([event,wisconsin,conflicting]))
    def test_source_at_label_matches_two_canonical_participants_without_guessing_neutral_or_shared_mascots(self):
        wisconsin={**self.team('Wisconsin Basketball'),'id':'1'*24}
        visitor={**self.team('Wyoming Basketball','cbbwyo'),'id':'2'*24,'shortName':'Cowboys'}
        event={**self.event(),'name':'Wyoming Cowboys at Wisconsin Badgers Mens Basketball (Exhibition)',
               'performers':[{'id':'1'*24,'primary':True},{'id':'2'*24,'primary':False}]}
        data=[event,wisconsin,visitor]
        links=t.event_links(data)
        self.assertTrue(links['cbbwis'][0]['is_home'])
        self.assertFalse(links['cbbwyo'][0]['is_home'])
        for label in ['Wisconsin vs Wyoming','Wyoming at Wisconsin (Neutral Site)','Badgers at Badgers']:
            event['name']=label
            self.assertIsNone(t.event_links(data)['cbbwis'][0]['is_home'])
        visitor.update(name='Spring Hill Basketball',shortName='Badgers')
        event['name']='Badgers at Badgers'
        self.assertIsNone(t.event_links(data)['cbbwis'][0]['is_home'])
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
