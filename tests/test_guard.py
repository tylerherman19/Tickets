import contextlib
import sys
import os
import unittest
from unittest.mock import patch
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
from ticketline_guard import Guard,CaptureDeferred
import tickets_collect as collect

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.calls=[]
        self.admitted=True
        def rpc(name,body):
            self.calls.append((name,body))
            if name=='tix_claim_capture': return {'state':'checking','token':'lease'}
            if name=='tix_admit_provider_http': return {'allowed':self.admitted,'reason':'request_limit'}
            if name=='tix_finish_capture': return 'observation'
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
