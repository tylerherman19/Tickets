import contextlib, json, os, sys, unittest, urllib.error
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
os.environ.setdefault('SUPABASE_URL','https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY','test')
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
import tickets_team_refresh as refresh
import tickets_coverage_health as health
from ticketline_guard import CaptureDeferred

class FakeGuard:
    def __init__(self,error=None): self.sources=[];self.error=error
    @contextlib.contextmanager
    def capture(self,event_id,source):
        self.sources.append((event_id,source))
        if self.error: raise self.error
        yield self

class TeamRefreshTests(unittest.TestCase):
    def event(self,eid='a'*24,days=80,category='cbb',price=1300):
        day=datetime.now(timezone.utc).date()+timedelta(days=days)
        return {'id':eid,'category':category,'name':'Visitor at Wisconsin','seoUrl':f'https://gametime.co/basketball/visitor-at-badgers-tickets/{day.month}-{day.day}-{day.year}-madison-wi-kohl-center/events/{eid}',
                'minPrice':{'total':price}}
    def run_worker(self,page=None,error=None,available=True):
        calls=[];writes=[];guard=FakeGuard(error)
        def db(method,path,body=None,prefer=None):
            calls.append((method,path,body))
            if path=='rpc/tix_team_refresh_due': return [{'team_id':'cbbwis','path':'/wisconsin-tickets/performers/cbbwis','category':'college-basketball'}]
            if path=='rpc/tix_resolve_teams': return [{'team_id':'exists'}]
            return []
        page=page if page is not None else 'window.__data='+json.dumps({'performer':{'slug':'cbbwis'},'schedule':[self.event()]})
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}),patch.object(refresh.collect,'GUARD',guard),patch.object(refresh.teams,'available',return_value=available), \
             patch.object(refresh.collect,'sb',side_effect=db),patch.object(refresh.collect,'get_text',return_value=page) as fetched, \
             patch.object(refresh.collect,'write_state',side_effect=lambda k,v:writes.append((k,v))),patch.object(refresh.collect.time,'sleep'):
            try: refresh.main();raised=None
            except RuntimeError as e:raised=e
        return calls,writes,guard,fetched,raised
    def test_demand_fetches_one_guarded_team_page_and_imports_full_horizon_prices(self):
        calls,writes,guard,fetched,raised=self.run_worker()
        self.assertIsNone(raised)
        self.assertEqual(guard.sources,[(None,'tracked')])
        self.assertEqual(fetched.call_count,1)
        saved=next(body for method,path,body in calls if path=='tix_catalog?on_conflict=event_id')
        self.assertEqual(saved[0]['category'],'college-basketball');self.assertEqual(saved[0]['min_total'],1300)
        self.assertTrue(any(path=='rpc/tix_link_team_events' and body['p_team_id']=='cbbwis' and body['p_checked'] and body['p_rows']==[{'event_id':'a'*24,'is_home':None}] for _,path,body in calls))
        self.assertEqual(writes[0][1]['checked'],1)
        self.assertFalse(any('email' in path or 'alert' in path for _,path,_ in calls))
    def test_absent_schema_skips_without_provider_access(self):
        calls,writes,guard,fetched,raised=self.run_worker(available=False)
        self.assertFalse(calls);self.assertFalse(writes);self.assertFalse(guard.sources);fetched.assert_not_called()
    def test_global_provider_pause_stops_immediately_with_failure(self):
        calls,writes,guard,fetched,raised=self.run_worker(error=CaptureDeferred('HTTP_429','suspended'))
        self.assertIsNotNone(raised);self.assertEqual(writes[0][1]['deferred'],'HTTP_429');fetched.assert_not_called()
    def test_missing_page_isolated_parse_failure_does_not_fulfill_demand(self):
        calls,writes,_,_,raised=self.run_worker(page='not valid provider data')
        self.assertIsNone(raised);self.assertEqual(writes[0][1]['failed'],1)
        self.assertTrue(any(path=='rpc/tix_team_check_failed' for _,path,_ in calls))
        self.assertFalse(any(path=='rpc/tix_link_team_events' for _,path,_ in calls))
    def test_priced_events_without_team_membership_cannot_fulfill_demand(self):
        page='window.__data='+json.dumps({'events':[self.event()]})
        calls,writes,_,_,raised=self.run_worker(page=page)
        self.assertIsNone(raised)
        self.assertEqual(writes[0][1]['failed'],1)
        self.assertEqual(writes[0][1]['checked'],0)
        self.assertFalse(any(path=='rpc/tix_link_team_events' for _,path,_ in calls))
    def test_catalog_rows_preserve_unknown_price_and_reject_mismatched_sport_and_dates(self):
        events=[self.event(),self.event('b'*24,days=366),self.event('c'*24,category='nba'),self.event('d'*24,price=None)]
        rows=refresh.catalog_rows(events,'college-basketball')
        self.assertEqual([r['event_id'] for r in rows],['a'*24,'d'*24]);self.assertNotIn('min_total',rows[1])
    def test_registry_bootstrap_uses_admission_and_provider_sources_for_missing_sports_only(self):
        guard=FakeGuard();calls=[]
        def db(method,path,body=None,prefer=None):
            calls.append((method,path,body))
            if path=='rpc/tix_resolve_teams':return [] if body['p_category']=='college-basketball' else [{'team_id':'exists'}]
            return []
        team={'category':'cbb','name':'Wisconsin Badgers Basketball','slug':'cbbwis','shortName':'Badgers','seoUrl':'https://gametime.co/wisconsin-tickets/performers/cbbwis'}
        with patch.object(refresh.collect,'GUARD',guard),patch.object(refresh.collect,'sb',side_effect=db), \
             patch.object(refresh.collect,'get_text',return_value='window.__data='+json.dumps(team)) as fetch,patch.object(refresh.collect.time,'sleep'):
            self.assertEqual(refresh.bootstrap_registry(),1)
        self.assertEqual(guard.sources,[(None,'catalog')]);fetch.assert_called_once_with('https://gametime.co/c/college-basketball')
        self.assertTrue(any(path=='rpc/tix_upsert_teams' for _,path,_ in calls))

class CoverageHealthTests(unittest.TestCase):
    def base(self):return {'events':100,'priced':90,'unpriced':10,'fresh':80,'stale':10,'teams':10,'teams_checked':10,'teams_failed':0,'failed_checks':0,'provider_paused':False,'collector_state':'fresh','last_collector_at':datetime.now(timezone.utc).isoformat()}
    def test_partial_coverage_warns_without_asserting_sold_out_or_failing_the_worker(self):
        assessment=health.assess(self.base())
        self.assertEqual(assessment['status'],'warning');self.assertFalse(assessment['critical'])
    def test_provider_outage_and_stale_or_failed_collector_alerts_are_actionable(self):
        for change in ({'provider_paused':True},{'last_collector_at':None},{'last_collector_at':(datetime.now(timezone.utc)-timedelta(hours=3)).isoformat()},{'collector_state':'failed'},{'events':0}):
            result=health.assess({**self.base(),**change});self.assertEqual(result['status'],'error');self.assertTrue(result['critical'])
    def test_cannot_run_monitor_locally(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}),patch.object(health.collect,'sb') as db:
            with self.assertRaisesRegex(RuntimeError,'hosted-only'):health.main()
            db.assert_not_called()

class CatalogSourceProofTests(unittest.TestCase):
    def test_unknown_or_contradictory_event_sport_cannot_be_relabelled(self):
        event=TeamRefreshTests().event()
        for replacement in ({'category':'concert'},{'category':None,'seoUrl':event['seoUrl'].replace('/basketball/','/concert/')},
                            {'category':'cbb','seoUrl':event['seoUrl'].replace('/basketball/','/nba-basketball/')}):
            self.assertEqual(refresh.catalog_rows([{**event,**replacement}],'college-basketball'),[])

class CoverageTransitionTests(unittest.TestCase):
    def test_workflow_alerts_once_for_new_outage_and_stays_quiet_until_change(self):
        current={**CoverageHealthTests().base(),'provider_paused':True}
        previous={}
        def db(method,path,body=None,prefer=None):
            return current if path=='rpc/tix_catalog_health' else [{'v':previous}] if previous else []
        def save(key,value):previous.update(value)
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}),patch.object(health.collect,'sb',side_effect=db),patch.object(health.collect,'write_state',side_effect=save):
            with self.assertRaisesRegex(RuntimeError,'coverage alert'):health.main()
            health.main()
            current['provider_paused']=False
            health.main()
            current['provider_paused']=True
            health.main() # One successful poll did not resolve this incident.
            current['events']=0
            with self.assertRaisesRegex(RuntimeError,'No upcoming catalog events'):health.main()
            current['events']=100
            current['provider_paused']=False
            for _ in range(health.RECOVERY_CHECKS):health.main()
            current['provider_paused']=True
            with self.assertRaisesRegex(RuntimeError,'coverage alert'):health.main()

    def test_rollout_preserves_legacy_incidents_and_never_hides_the_current_outage(self):
        assessment=health.assess({**CoverageHealthTests().base(),'collector_state':'failed'})
        previous={'status':'error','critical':assessment['critical']}
        incident,new=health.incident_state(previous,assessment)
        self.assertEqual(new,[])
        self.assertEqual(incident['incident_reasons'],assessment['critical'])
        self.assertEqual(assessment['status'],'error')
        for _ in range(5):
            recovered=health.assess(CoverageHealthTests().base())
            incident,new=health.incident_state(incident,recovered)
            incident,new=health.incident_state(incident,assessment)
            self.assertEqual(new,[])
            self.assertEqual(incident['healthy_checks'],0)


class AlertProgressMonitorTests(unittest.TestCase):
    def test_individual_alert_delays_and_uncertain_delivery_are_actionable(self):
        for key in ('delivery_uncertain',):
            result=health.assess({**CoverageHealthTests().base(),key:1})
            self.assertEqual(result['status'],'error')
            self.assertTrue(result['critical'])

class AlertProgressRaceTests(unittest.TestCase):
    def assessment(self,overdue,now,previous=None,**extra):
        return health.assess({**CoverageHealthTests().base(),'last_collector_at':now.isoformat(),'overdue_alert_events':overdue,**extra},now=now,previous=previous)

    def test_hourly_monitor_collector_race_never_sends_false_outage(self):
        start=datetime.now(timezone.utc);previous={};notifications=[]
        # Production pattern: monitor sees an old sample at :00; collector
        # finishes at :02; the next three quarter-hour polls are healthy.
        for minute in range(0,181,15):
            now=start+timedelta(minutes=minute)
            assessment=self.assessment(int(minute%60==0),now,previous)
            incident,new=health.incident_state(previous,assessment)
            previous={**assessment,**incident};notifications.extend(new)
            if minute%60==0:
                self.assertEqual(assessment['status'],'warning')
                self.assertTrue(assessment['overdue_since'])
            else:self.assertIsNone(assessment['overdue_since'])
        self.assertEqual(notifications,[])

    def test_real_stall_is_confirmed_after_elapsed_time_then_notified_once(self):
        now=datetime.now(timezone.utc)
        first=self.assessment(1,now)
        self.assertFalse(first['critical'])
        # An immediate Actions retry cannot turn one observation into an outage.
        self.assertFalse(self.assessment(1,now+timedelta(seconds=30),first)['critical'])
        confirmed=self.assessment(1,now+timedelta(minutes=15),first)
        self.assertEqual(confirmed['status'],'error')
        incident,new=health.incident_state({},confirmed);self.assertEqual(len(new),1)
        _,new=health.incident_state({**confirmed,**incident},confirmed);self.assertEqual(new,[])

    def test_actual_failures_are_immediate_even_during_lateness_grace(self):
        now=datetime.now(timezone.utc)
        for extra in ({'collector_state':'failed'},{'provider_paused':True},{'delivery_uncertain':1}):
            self.assertTrue(self.assessment(1,now,**extra)['critical'])

    def test_pending_lateness_does_not_rearm_an_existing_incident(self):
        now=datetime.now(timezone.utc)
        confirmed=self.assessment(1,now,{'overdue_since':(now-timedelta(minutes=15)).isoformat()})
        incident,_=health.incident_state({},confirmed)
        pending=self.assessment(1,now)
        for _ in range(health.RECOVERY_CHECKS+1):
            incident,new=health.incident_state(incident,pending)
            self.assertEqual(incident['healthy_checks'],0);self.assertEqual(new,[])
            self.assertTrue(incident['incident_reasons'])

    def test_hosted_monitor_persists_grace_and_still_fails_for_confirmed_stalls(self):
        previous={};runtime={'overdue_alert_events':1}
        def db(method,path,body=None,prefer=None):
            if path=='rpc/tix_catalog_health':return CoverageHealthTests().base()
            if path=='rpc/tix_runtime_health':return runtime
            return [{'v':dict(previous)}] if previous else []
        def save(key,value):previous.clear();previous.update(value)
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}),patch.object(health.collect,'sb',side_effect=db),patch.object(health.collect,'write_state',side_effect=save):
            health.main();self.assertEqual(previous['status'],'warning')
            health.main();self.assertFalse(previous['critical'])
            previous['overdue_since']=(datetime.now(timezone.utc)-timedelta(minutes=11)).isoformat()
            with self.assertRaisesRegex(RuntimeError,'remain overdue'):health.main()
            health.main() # Incident already notified; no duplicate email.
            runtime['overdue_alert_events']=0
            for _ in range(health.RECOVERY_CHECKS):health.main()
            self.assertFalse(previous['incident_reasons']);self.assertTrue(previous['recovered_at'])
