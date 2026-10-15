import os
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
os.environ.setdefault('SUPABASE_URL', 'https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY', 'test')
import tickets_sweep as sweep

class SweepTests(unittest.TestCase):
    def test_bounded_valid_ids(self):
        self.assertEqual(sweep.event_ids('a'*24+','+'a'*24), ['a'*24])
        for raw in ['', 'bad', ','.join(f'{n:024x}' for n in range(9))]:
            with self.assertRaises(ValueError): sweep.event_ids(raw)

    def test_local_sweep_cannot_contact_database_or_provider(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS':'false'}), patch.object(sweep.collect,'sb') as db:
            with self.assertRaisesRegex(RuntimeError, 'hosted-only'): sweep.main()
            db.assert_not_called()

    def test_sweep_saves_metadata_without_alerts_and_stops_on_block(self):
        ids=['a'*24,'b'*24]
        rows=[dict(event_id=eid,event_date=datetime.now(timezone.utc).date().isoformat(),name='Game',url='https://gametime.co/events/'+eid) for eid in ids]
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','TIX_SWEEP_EVENT_IDS':','.join(ids)}), patch.object(sweep.collect,'sb',return_value=rows), patch.object(sweep,'fetch_once',side_effect=['page',RuntimeError('blocked')]) as fetch, patch.object(sweep.collect,'parse_event_page',return_value=({'event_id':ids[0],'min_total':3700},[])), patch.object(sweep.collect,'page_outcome',return_value='metadata_only'), patch.object(sweep.collect,'record_event_market') as save, patch.object(sweep.collect,'send_sms') as send, patch.object(sweep.collect,'GUARD',None):
            with self.assertRaisesRegex(RuntimeError,'blocked'): sweep.main()
            self.assertEqual(fetch.call_count,2)
            self.assertEqual(save.call_count,1)
            self.assertEqual(save.call_args.args[-1],'metadata_only')
            send.assert_not_called()

    def test_provider_urls_must_be_canonical(self):
        for url in ['http://gametime.co/events/a','https://evil.test/events/a','https://gametime.co/events/a?x=1']:
            with self.assertRaises(ValueError): sweep.fetch_once(url)
