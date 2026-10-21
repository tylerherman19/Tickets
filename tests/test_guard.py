import contextlib
import io
import json
import sys
import os
import unittest
import urllib.error
from unittest.mock import patch
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
from ticketline_guard import Guard,CaptureDeferred,moved_event_url
import tickets_collect as collect

class GuardTests(unittest.TestCase):
    def test_capture_statement_rollback_retries_only_the_database_write_once(self):
        failure=urllib.error.HTTPError('https://database.test',500,'timeout',{},io.BytesIO(b'{"code":"57014"}'))
        response=io.BytesIO(b'"observation"')
        with patch('urllib.request.urlopen',side_effect=[failure,response]) as request,patch.object(collect.time,'sleep'):
            self.assertEqual(collect.sb('POST','rpc/tix_finish_capture',{'p_token':'lease'}),'observation')
        self.assertEqual(request.call_count,2)
        self.assertEqual(request.call_args_list[0].args[0].data,request.call_args_list[1].args[0].data)

    def test_uncertain_or_unrelated_writes_are_never_retried(self):
        for path,code in [('rpc/tix_finish_capture','XX000'),('rpc/tix_finish_delivery','57014')]:
            failure=urllib.error.HTTPError('https://database.test',500,'failed',{},io.BytesIO(json.dumps({'code':code}).encode()))
            with patch('urllib.request.urlopen',side_effect=failure) as request:
                with self.assertRaises(urllib.error.HTTPError):collect.sb('POST',path,{})
                self.assertEqual(request.call_count,1)
        with patch('urllib.request.urlopen',side_effect=TimeoutError('unknown commit')) as request:
            with self.assertRaises(TimeoutError):collect.sb('POST','rpc/tix_finish_capture',{})
            self.assertEqual(request.call_count,1)

    def test_database_timeouts_are_identified_separately_from_provider_http_errors(self):
        failure=urllib.error.HTTPError('https://database.test',500,'timeout',{},io.BytesIO(b'{"code":"57014"}'))
        with patch('urllib.request.urlopen',side_effect=failure):
            with self.assertRaises(urllib.error.HTTPError) as raised:
                collect.sb('POST','rpc/tix_save_capture',{})
        self.assertEqual(collect.failure_outcome(raised.exception),'failed')
        self.assertEqual(collect.failure_detail(raised.exception),{'source':'database','operation':'rpc/tix_save_capture','postgres_code':'57014'})
        provider=urllib.error.HTTPError('https://gametime.co/events/e',500,'unavailable',{},io.BytesIO(b''))
        self.assertEqual(collect.failure_outcome(provider),'http_failure')
        self.assertEqual(collect.failure_detail(provider),{})

    def setUp(self):
        self.calls=[]
        self.admitted=True
        def rpc(name,body):
            self.calls.append((name,body))
            if name=='tix_claim_capture': return {'state':'checking','token':'lease'}
            if name=='tix_admit_provider_http': return {'allowed':self.admitted,'reason':'request_limit'}
            if name=='tix_finish_capture': return 'observation'
            if name=='tix_note_redirect': return self.redirect_result(body)
        self.redirect_result=lambda body:{'state':'queued','reason':'url_moved'} if body['p_location'] else {'state':'failed','reason':'redirected'}
        self.guard=Guard(rpc)
    def test_denied_admission_never_opens_socket_and_releases(self):
        self.admitted=False
        with patch('urllib.request.build_opener') as opener:
            with self.assertRaises(CaptureDeferred):
                with self.guard.capture('event','detail'):
                    self.guard.text('https://gametime.co/events/event',{})
            opener.assert_not_called()
        self.assertEqual(self.calls[-1],('tix_release_capture',{'p_token':'lease','p_reason':'request_limit'}))
    def test_blocked_page_suspends_before_parsing(self):
        with self.assertRaises(CaptureDeferred):
            with self.guard.capture('event','edge'):
                self.guard.inspect(200,'<title>Just a moment</title>')
        self.assertTrue(any(n=='tix_suspend_provider' for n,b in self.calls))
    def test_no_redirects_and_only_one_http_attempt(self):
        response=type('Response',(),{'status':200,'read':lambda self:b'body','__enter__':lambda self:self,'__exit__':lambda *args:None})()
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value=response
            with self.guard.capture('event','detail'):
                self.assertEqual(self.guard.text('https://gametime.co/events/event',{}),'body')
            handler=opener.call_args[0][0]
            self.assertIsNone(handler.redirect_request(None,None,None,None,None,None))
            self.assertEqual(opener.return_value.open.call_count,1)
    def redirect(self, event_id, location, source='collector'):
        url='https://gametime.co/nfl-football/bills-at-vikings-tickets/11-9-2026-minneapolis-mn-u-s-bank-stadium/events/'+str(event_id)
        error=urllib.error.HTTPError(url,301,'Moved',{'Location':location} if location else {},io.BytesIO(b''))
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect=error
            with self.guard.capture(event_id,source):
                self.guard.text(url,{})
            self.assertEqual(opener.return_value.open.call_count,1)
    def test_same_event_redirect_saves_link_and_defers_without_following(self):
        with self.assertRaises(CaptureDeferred) as raised:
            self.redirect('event','/nfl-football/bills-at-vikings-tickets/11-8-2026-minneapolis-mn-u-s-bank-stadium/events/event')
        self.assertEqual((raised.exception.reason,raised.exception.state),('url_moved','queued'))
        self.assertIn(('tix_note_redirect',{'p_token':'lease','p_location':'https://gametime.co/nfl-football/bills-at-vikings-tickets/11-8-2026-minneapolis-mn-u-s-bank-stadium/events/event'}),self.calls)
        self.assertFalse(any(n=='tix_release_capture' for n,b in self.calls))
    def test_redirect_elsewhere_backs_off_and_stays_a_failed_check(self):
        for location in ['https://evil.test/events/event','/minnesota-vikings-tickets/performers/nflmin','/x/events/other',None]:
            self.calls.clear()
            with self.assertRaises(urllib.error.HTTPError):
                self.redirect('event',location)
            self.assertIn(('tix_note_redirect',{'p_token':'lease','p_location':None}),self.calls)
            self.assertFalse(any(n=='tix_release_capture' for n,b in self.calls))
    def test_redirect_before_database_step_fails_as_before(self):
        def missing(body): raise urllib.error.HTTPError('https://database.test',404,'missing',{},io.BytesIO(b''))
        self.redirect_result=missing
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.redirect('event','/x/events/event')
        self.assertEqual(raised.exception.code,301)
        self.assertEqual(self.calls[-1],('tix_release_capture',{'p_token':'lease','p_reason':'capture_failed'}))
    def test_redirected_catalog_page_is_not_an_event_move(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.redirect(None,'/nfl-football/minnesota-vikings-tickets/performers/nflmin','catalog')
        self.assertFalse(any(n=='tix_note_redirect' for n,b in self.calls))
    def test_moved_event_url_accepts_only_the_same_event_on_the_provider(self):
        url='https://gametime.co/a-tickets/11-9-2026-x-mn-y/events/'+'a'*24
        to='https://gametime.co/a-tickets/11-8-2026-x-mn-y/events/'+'a'*24
        self.assertEqual(moved_event_url(to,url,'a'*24),to)
        self.assertEqual(moved_event_url('/a-tickets/11-8-2026-x-mn-y/events/'+'a'*24,url,'a'*24),to)
        for location in [None,'',url,'https://evil.test/events/'+'a'*24,'//evil.test/events/'+'a'*24,'http://gametime.co/events/'+'a'*24,
                         'https://gametime.co:8443/events/'+'a'*24,'https://u@gametime.co/events/'+'a'*24,to+'?q=1',to+'#x',
                         to.replace('a'*24,'b'*24),'https://gametime.co/x/../events/'+'a'*24]:
            self.assertIsNone(moved_event_url(location,url,'a'*24),location)
        self.assertIsNone(moved_event_url(to,url,None))
    def test_finish_releases_atomically_without_second_release(self):
        with self.guard.capture('event','detail'):
            self.assertEqual(self.guard.finish({'state':'complete'}),'observation')
        self.assertFalse(any(n=='tix_release_capture' for n,b in self.calls))
    def test_seat_and_opaque_history_fields_are_preserved(self):
        raw={'id':'lot','price':{'total':1234,'prefee':1100,'salesTax':0},'availableLots':[2,4],'seats':['1','2','3','4'],'spot':{'section':'Club','row':'A'},'historicalPrice':{'uninterpreted':[1,2]}}
        captured=collect.capture_payload({'event_id':'event','min_total':1200},[raw],'ok')
        self.assertEqual(captured['listings'][0]['provider'],raw)
        self.assertEqual(captured['by_qty']['2']['low'],1234)
        self.assertNotIn('3',captured['by_qty'])
        self.assertEqual(captured['state'],'complete')
    def test_metadata_and_partial_are_never_confirmed_empty(self):
        self.assertEqual(collect.capture_payload({'event_id':'event'},[],'metadata_only')['state'],'metadata_only')
        self.assertFalse(collect.capture_payload({'event_id':'event'},[],'partial')['coverage']['complete'])
    def test_local_provider_requests_fail_closed(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}),patch.object(collect.GUARD,'text') as fetch:
            with self.assertRaises(RuntimeError):collect.get_text('https://gametime.co/events/event')
            fetch.assert_not_called()
    def test_history_worker_has_no_delivery_credentials_or_calls(self):
        from pathlib import Path
        workflow=Path('.github/workflows/ticket-details.yml').read_text()
        self.assertNotIn('GMAIL',workflow)
        self.assertNotIn('send_sms',Path('scripts/ticket_details.py').read_text())

