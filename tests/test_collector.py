import json
import os
import sys
import unittest
from datetime import timedelta
from unittest.mock import patch
os.environ.setdefault('SUPABASE_URL', 'https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY', 'test')
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import tickets_collect as c

def listing(price=15000, lots=None, seats=None, group='Club'):
    return {'id':'listing', 'availableLots':lots if lots is not None else [2,4],
            'seats': seats if seats is not None else ['1','2','3','4'], 'price':{'total':price},
            'spot':{'sectionGroup':group,'section':'C1','row':'2'}, 'seoUrl':'https://gametime.co/event/listings/listing'}

class CollectorTests(unittest.TestCase):
    def test_successful_empty_provider_market_clears_old_get_in_price(self):
        event={'event_id':'abc','name':'A game','event_date':'2026-10-04','url':'https://gametime.co/events/abc'}
        writes=[]
        with patch.object(c,'sb',side_effect=lambda method,path,body=None,prefer=None: writes.append((path,body)) or []):
            c.record_event_market(event,{'event_id':'abc','name':'A game','min_total':None},[],c.NOW.isoformat())
        patch_body=next(body for path,body in writes if path.startswith('tix_catalog?'))
        self.assertIn('min_total',patch_body)
        self.assertIsNone(patch_body['min_total'])
        self.assertEqual(patch_body['discovery_status'],'ok')
        sample=next(body for path,body in writes if path.startswith('tix_event_market?'))
        self.assertEqual(sample[0]['event_id'],'abc')
        self.assertEqual(sample[0]['listing_count'],0)

    def test_discovery_seeds_local_cities_and_major_sports_then_queries_other_markets(self):
        with patch.object(c,'sb',return_value=[]) as db:
            c.discovery_due()
        self.assertEqual(db.call_count,9)
        self.assertEqual(db.call_args_list[0].args[1],'rpc/tix_requested_discovery')
        self.assertEqual(db.call_args_list[0].args[2],{'p_limit':8})
        self.assertIn('city=eq.Minneapolis',db.call_args_list[1].args[1])
        self.assertIn('city=eq.Milwaukee',db.call_args_list[2].args[1])
        self.assertIn('category=eq.mlb-baseball',db.call_args_list[3].args[1])
        self.assertIn('name=not.ilike.*tbd*',db.call_args_list[3].args[1])
        self.assertEqual(db.call_args_list[7].args[1],'rpc/tix_discovery_due')
        self.assertEqual(db.call_args_list[7].args[2]['p_limit'],c.DISCOVERY_NEAR_FETCHES)
        self.assertEqual(db.call_args_list[8].args[2]['p_from_days'],8)

    def test_exact_quantity_respects_allowed_lots(self):
        self.assertIsNone(c.cheapest_any([listing(lots=[1,3,4])],2))
        self.assertIsNone(c.cheapest_for([listing(lots=[1,3,4])],'Club',2))
        self.assertEqual(c.cheapest_any([listing()],2)[0],15000)
    def test_missing_lots_is_not_proof_of_purchase_quantity(self):
        l=listing(); del l['availableLots']
        self.assertFalse(c.allows_quantity(l,2))
    def test_club_and_qty_choose_correct_price(self):
        ls=[listing(1000, lots=[1]),listing(12000,group='Upper'),listing(16000),listing(15000)]
        self.assertEqual(c.cheapest_for(ls,'Club',2)[0],15000)
        self.assertEqual(c.cheapest_any(ls,2)[0],12000)
    def test_no_zero_price_or_invented_seats(self):
        self.assertIsNone(c.cheapest_any([listing(0),listing(seats=['1'])],2))
    def test_parser_does_not_rewrite_undefined_inside_strings(self):
        payload={'redux':{'data':{'fullEvents':{'events':{'abc':{'event':{'id':'abc','name':'undefined concert'}}}}},'listings':{'listings':[listing()]}}}
        meta,ls=c.parse_event_page('<script>window.__data='+json.dumps(payload)+';</script>')
        self.assertEqual(meta['name'],'undefined concert'); self.assertEqual(len(ls),1)
    def test_parser_ignores_braces_in_strings(self):
        payload={'redux':{'data':{'fullEvents':{'events':{'abc':{'event':{'id':'abc','name':'A } "quoted" event'}}}}}}}
        self.assertEqual(c.parse_event_page('window.__data='+json.dumps(payload))[0]['event_id'],'abc')
        self.assertEqual(c.parse_event_page('<html>No event data</html>'),(None,[]))
    def test_parser_reads_current_astro_event_listings(self):
        encoded = {
            'eventId':[0,'abc'],
            'eventPath':[0,'/events/abc'],
            'fullEvent':[0,{'event':[0,{'id':[0,'abc'],'name':[0,'A game'],
                'category':[0,'nfl'],'datetimeLocal':[0,'2026-09-13T15:25:00'],
                'minPrice':[0,{'total':[0,17300]}],'seoUrl':[0,'/events/abc']}]}],
            'listingsResponse':[0,{'listings':[1,[[0,listing(17300)]]]}]
        }
        attrs=json.dumps(encoded).replace('&','&amp;').replace('"','&quot;')
        page='<astro-island component-export="EventListings" props="'+attrs+'">'
        meta,ls=c.parse_event_page(page)
        self.assertEqual(meta['event_id'],'abc')
        self.assertEqual(meta['min_total'],17300)
        self.assertEqual(len(ls),1)
        self.assertEqual(ls[0]['price']['total'],17300)

    def test_market_spread_respects_available_lots(self):
        listings = [
            {"price":{"total":10000},"seats":[1,2],"availableLots":[2]},
            {"price":{"total":14000},"seats":[1,2,3],"availableLots":[2,3]},
            {"price":{"total":20000},"seats":[1,2],"availableLots":[2]},
        ]
        spread = c.market_spreads(listings)["2"]
        self.assertEqual(spread, {"low":10000,"typical":14000,"high":20000,"listings":3})

    def test_cents_not_rounded(self):
        self.assertEqual(c.fmt_money(10050),'$100.50');self.assertEqual(c.fmt_money(10000),'$100')
    def test_private_destination_builds_supported_gateway_address(self):
        self.assertEqual(c.destination_address({'phone_digits':'6125550148','provider':'tmobile'}),'6125550148@tmomail.net')
        self.assertEqual(c.destination_address({'phone_digits':'6125550148','provider':'verizon'}),'6125550148@vzwpix.com')

    def test_watch_without_destination_never_uses_global_test_gateway(self):
        with patch.object(c,'SMS_GATEWAY','6125550148@tmomail.net'), patch.object(c,'write_state') as state:
            self.assertFalse(c.send_sms('ticket match','private event',recipient=''))
            self.assertEqual(state.call_args.args[1]['status'],'failed')
        self.assertEqual(c.destination_address({'phone_digits':'6125550148','provider':'xfinity'}),'6125550148@mypixmessages.com')
        self.assertEqual(c.destination_address({'phone_digits':'1123456789','provider':'tmobile'}),'')
        self.assertEqual(c.destination_address({'phone_digits':'6125550148','provider':'unknown'}),'')
    def test_confirmation_sends_email_and_optional_carrier_text_independently(self):
        queue={'watch_id':'w','event_label':'Minnesota Vikings at Green Bay Packers','attempts':0,
               'email_attempts':0,'email_enabled':True,'sms_enabled':True,'sent_at':None,'email_sent_at':None}
        writes=[]
        def db(method,path,body=None,prefer=None):
            if path.startswith('tix_confirmation_queue?') and method=='GET': return [queue]
            if path.startswith('tix_destinations?'): return [{'phone_digits':'6125550148','provider':'tmobile'}]
            if path.startswith('tix_watches?'): return [{'threshold_cents':15000}]
            writes.append((path,body)); return []
        with patch.object(c,'sb',side_effect=db),patch.object(c,'owner_email',return_value='owner@example.com'),patch.object(c,'send_sms',return_value=True) as send:
            self.assertEqual(c.send_pending_confirmations(),0)
        self.assertEqual({call.kwargs['recipient'] for call in send.call_args_list},
                         {'owner@example.com','6125550148@tmomail.net'})
        self.assertIn("We're on the lookout for tickets to Minnesota Vikings at Green Bay Packers at $150 or less.",
                      send.call_args.args[1])
        self.assertTrue(any(body.get('sent_at') and body.get('email_sent_at') for _,body in writes))
    def test_confirmation_email_only_does_not_require_phone(self):
        queue={'watch_id':'w','event_label':'Vikings','attempts':0,'email_attempts':0,
               'email_enabled':True,'sms_enabled':False,'email_sent_at':None}
        def db(method,path,body=None,prefer=None):
            if path.startswith('tix_confirmation_queue?email_enabled=') and method=='GET': return [queue]
            if path.startswith('tix_confirmation_queue?') and method=='GET': return []
            if path.startswith('tix_watches?'): return [{'threshold_cents':15000}]
            return []
        with patch.object(c,'sb',side_effect=db),patch.object(c,'owner_email',return_value='owner@example.com'),patch.object(c,'send_sms',return_value=True) as send:
            self.assertEqual(c.send_pending_confirmations(),0)
        send.assert_called_once()
        self.assertEqual(send.call_args.kwargs['recipient'],'owner@example.com')
    def test_repeat_is_limited_to_one_hour(self):
        with patch.object(c,'sb',return_value=[{'sent_at':(c.NOW-timedelta(minutes=59)).isoformat()}]):
            self.assertTrue(c.already_alerted('w','e','Club',60))
        with patch.object(c,'sb',return_value=[{'sent_at':(c.NOW-timedelta(minutes=61)).isoformat()}]):
            self.assertFalse(c.already_alerted('w','e','Club',60))
            self.assertTrue(c.already_alerted('w','e','Club'))
    def test_first_match_deduplication_uses_current_criteria_version(self):
        with patch.object(c,'sb',return_value=[{'sent_at':c.NOW.isoformat()}]) as db:
            self.assertTrue(c.already_alerted('w','e','Club',criteria_version=3))
            self.assertIn('criteria_version=eq.3',db.call_args.args[1]);self.assertIn('channel=eq.sms',db.call_args.args[1])
    def test_price_alert_deduplication_is_independent_by_channel(self):
        def db(method,path,body=None,prefer=None):
            return [{'sent_at':c.NOW.isoformat()}] if 'channel=eq.sms' in path else []
        with patch.object(c,'sb',side_effect=db):
            self.assertTrue(c.already_alerted('w','e','Club',criteria_version=2,channel='sms'))
            self.assertFalse(c.already_alerted('w','e','Club',criteria_version=2,channel='email'))
    def test_adaptive_intervals_respect_workflow_cadence(self):
        self.assertEqual(c.check_interval_minutes(2),15)
        self.assertEqual(c.check_interval_minutes(20),60)
        self.assertEqual(c.check_interval_minutes(60),180)
        self.assertEqual(c.check_interval_minutes(60,10500,10000),15)
    def test_parser_failure_is_distinct_from_zero_inventory(self):
        self.assertEqual(c.page_outcome('<html>changed markup</html>',None),'parser_failure')
        self.assertEqual(c.page_outcome('<astro-island component-export="EventListings" props="listingsResponse"></astro-island>',{'event_id':'e'}),'ok')
        self.assertEqual(c.page_outcome('window.__data={"fullEvents":{}}',{'event_id':'e'}),'metadata_only')
    def test_provider_metadata_without_lots_is_retried_once(self):
        meta={'event_id':'e','min_total':3300}
        with patch.object(c,'get_text',side_effect=['metadata','complete']) as fetch, \
             patch.object(c,'parse_event_page',side_effect=[(meta,[]),(meta,[listing()])]), \
             patch.object(c,'page_outcome',side_effect=['metadata_only','ok']):
            status,_,listings=c.fetch_provider_page('https://gametime.co/events/e')
        self.assertEqual(status,'ok');self.assertEqual(len(listings),1)
        self.assertEqual(fetch.call_count,2)
    def test_persistent_metadata_only_keeps_provider_get_in_without_exact_lots(self):
        meta={'event_id':'e','min_total':3300}
        with patch.object(c,'get_text',return_value='metadata'), \
             patch.object(c,'parse_event_page',return_value=(meta,[])), \
             patch.object(c,'page_outcome',return_value='metadata_only'):
            status,_,listings=c.fetch_provider_page('https://gametime.co/events/e')
        self.assertEqual(status,'metadata_only');self.assertEqual(listings,[])
        writes=[]
        with patch.object(c,'sb',side_effect=lambda method,path,body=None,prefer=None:writes.append((path,body)) or []):
            c.record_event_market({'event_id':'e','url':'https://gametime.co/events/e'},meta,[],c.NOW.isoformat(),status)
        catalog=next(body for path,body in writes if path.startswith('tix_catalog?'))
        self.assertEqual(catalog['min_total'],3300)
        self.assertEqual(catalog['discovery_status'],'metadata_only')
    def test_event_time_change_is_recorded(self):
        watch={'id':'w','kind':'event','match':{'event_ids':['abc']},'clubs':[], 'qty':2,
               'threshold_cents':10000,'alert_style':'first','active':True,'created_at':c.NOW.isoformat()}
        event={'event_id':'abc','event_date':c.NOW.date().isoformat(),'name':'A game','url':'https://gametime.co/event',
               'datetime_local':'2026-09-27T15:00:00'}
        writes=[]
        def db(method,path,body=None,prefer=None):
            if path.startswith('tix_watches?'):return [watch]
            if method=='GET':return []
            writes.append((path,body));return []
        meta={'event_id':'abc','name':'A game','datetime_local':'2026-09-27T18:00:00','min_total':None}
        with patch.object(c,'sb',side_effect=db),patch.object(c,'catalog_stale',return_value=False),patch.object(c,'resolve_events',return_value=[event]),patch.object(c,'get_text',return_value='html'),patch.object(c,'page_outcome',return_value='ok'),patch.object(c,'parse_event_page',return_value=(meta,[])),patch.object(c.time,'sleep'):
            c.main()
        self.assertTrue(any(path=='tix_event_changes' and body[0]['field']=='datetime_local' for path,body in writes))
    def test_event_watch_excludes_past_events(self):
        with patch.object(c,'sb',return_value=[]) as db:
            c.resolve_events({'kind':'event','match':{'event_ids':['abc']}})
            self.assertIn('event_date=gte.',db.call_args[0][1])
    def test_invalid_watch_cannot_trigger_send(self):
        self.assertFalse(c.valid_watch({'kind':'event','qty':0,'threshold_cents':100,'alert_style':'first'}))
        self.assertTrue(c.valid_watch({'kind':'event','qty':2,'threshold_cents':10050,'alert_style':'first'}))
    def test_price_at_target_sends_and_unavailable_scan_clears_state(self):
        for price,expect_send in [(10000,True),(10001,False)]:
            watch={'id':'w','kind':'event','match':{'event_ids':['abc']},'clubs':[], 'qty':2,
                   'threshold_cents':10000,'alert_style':'first','active':True,'created_at':c.NOW.isoformat()}
            event={'event_id':'abc','event_date':c.NOW.date().isoformat(),'name':'A game','url':'https://gametime.co/event'}
            writes=[]
            def db(method,path,body=None,prefer=None):
                if path.startswith('tix_watches?'): return [watch]
                if method=='GET': return []
                writes.append((path,body)); return []
            meta={'event_id':'abc','name':'A game','datetime_local':None,'min_total':price}
            with patch.object(c,'sb',side_effect=db),patch.object(c,'catalog_stale',return_value=False),patch.object(c,'resolve_events',return_value=[event]),patch.object(c,'get_text',return_value='html'),patch.object(c,'page_outcome',return_value='ok'),patch.object(c,'parse_event_page',return_value=(meta,[listing(price)])),patch.object(c,'owner_email',return_value='owner@example.com'),patch.object(c,'send_sms',return_value=True) as send,patch.object(c.time,'sleep'):
                c.main();self.assertEqual(send.called,expect_send)
                self.assertTrue(any(path.startswith('tix_scans') and body[0]['outcome']=='ok' for path,body in writes))
    def test_no_matching_lots_records_unavailable(self):
        watch={'id':'w','kind':'event','match':{'event_ids':['abc']},'clubs':[],'qty':2,'threshold_cents':10000,'alert_style':'first','active':True,'created_at':c.NOW.isoformat()}
        event={'event_id':'abc','event_date':c.NOW.date().isoformat(),'name':'A game','url':'https://gametime.co/event'}
        def db(method,path,body=None,prefer=None): return [watch] if path.startswith('tix_watches?') else []
        meta={'event_id':'abc','name':'A game','datetime_local':None,'min_total':1000}
        with patch.object(c,'sb',side_effect=db),patch.object(c,'catalog_stale',return_value=False),patch.object(c,'resolve_events',return_value=[event]),patch.object(c,'get_text',return_value='html'),patch.object(c,'page_outcome',return_value='ok'),patch.object(c,'parse_event_page',return_value=(meta,[listing(1000,lots=[1,3,4])])),patch.object(c,'send_sms') as send,patch.object(c,'scan_result') as scan,patch.object(c.time,'sleep'):
            c.main();send.assert_not_called();self.assertEqual(scan.call_args[0][2],'unavailable')

if __name__=='__main__':unittest.main()
