import contextlib
import os
import sys
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
os.environ.setdefault('SUPABASE_URL','https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY','test')
import tickets_quote_worker as worker

class QuoteWorkerTests(unittest.TestCase):
    def test_free_worker_exits_when_no_quotes_are_due(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','TIX_QUOTE_EXIT_WHEN_IDLE':'true'}),patch.object(worker.collect,'sb',return_value=[]) as request,patch.object(worker.time,'sleep',side_effect=AssertionError('idle workers should sleep at the database level')):
            worker.main()
            request.assert_called_once_with('POST','rpc/tix_quick_due',{'p_limit':1})
    def test_requested_seat_count_is_captured_without_notifications(self):
        job={'event_id':'fixture','url':'https://gametime.co/events/fixture','requested_quantities':[4],'detail_requested':True}
        guard=MagicMock();guard.capture.return_value=contextlib.nullcontext()
        with patch.object(worker.collect,'GUARD',guard), patch.object(worker.collect,'fetch_provider_page',return_value=('metadata_only',{'event_id':'fixture'},[])), patch.object(worker.collect,'rendered_quantity_listings',return_value=[{'verified_quantity':4}]) as render, patch.object(worker.collect,'record_event_market') as save, patch.object(worker.collect,'send_sms',side_effect=AssertionError('quote checks must never send')):
            worker.capture(job)
            render.assert_called_once_with(job['url'],{4})
            guard.capture.assert_called_once_with('fixture','detail')
            self.assertEqual(save.call_args.args[-1],'partial')
    def test_background_warming_keeps_its_lower_priority(self):
        guard=MagicMock();guard.capture.return_value=contextlib.nullcontext()
        with patch.object(worker.collect,'GUARD',guard), patch.object(worker.collect,'fetch_provider_page',return_value=('ok',{'event_id':'fixture'},[])), patch.object(worker.collect,'record_event_market'):
            worker.capture({'event_id':'fixture','url':'https://gametime.co/events/fixture','warm_quantities':[2,4]})
            guard.capture.assert_called_once_with('fixture','warm')
    def test_fresh_metadata_skips_redundant_fetch_and_never_relabels_old_amount(self):
        from datetime import datetime,timezone
        guard=MagicMock();guard.capture.return_value=contextlib.nullcontext()
        job={'event_id':'fixture','url':'https://gametime.co/events/fixture','warm_quantities':[4],'price_checked_at':datetime.now(timezone.utc).isoformat(),'min_total':3900}
        with patch.object(worker.collect,'GUARD',guard),patch.object(worker.collect,'fetch_provider_page',side_effect=AssertionError('duplicate metadata request')),patch.object(worker.collect,'rendered_quantity_listings',return_value=None),patch.object(worker.collect,'record_event_market') as save:
            worker.capture(job)
            self.assertIsNone(save.call_args.args[1]['min_total'])
    def test_local_execution_cannot_fetch_provider(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}),patch.object(worker.collect,'sb',side_effect=AssertionError('no network')):
            with self.assertRaisesRegex(RuntimeError,'hosted-only'):worker.main()

if __name__=='__main__':unittest.main()
