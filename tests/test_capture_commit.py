"""Provider parsing and rendering commit one final observation, not checkpoints."""
import contextlib
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault('SUPABASE_URL','https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY','test')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import tickets_collect as collect

class CaptureCommitTests(unittest.TestCase):
    def test_metadata_fetch_cannot_complete_a_job_before_its_quantity_check(self):
        meta={'event_id':'fixture','min_total':3900,'_inventory_state':'metadata_only'}
        guard=MagicMock(event_id='fixture',token='lease')
        with patch.object(collect,'GUARD',guard),patch.object(collect,'get_text',return_value='metadata'), \
             patch.object(collect,'parse_event_page',return_value=(meta,[])), \
             patch.object(collect,'sb',side_effect=AssertionError('fetch must not write')):
            self.assertEqual(collect.fetch_provider_page('https://gametime.co/events/fixture'),('metadata_only',meta,[]))
        guard.finish.assert_not_called()

    def test_multiple_rendered_quantities_produce_one_final_atomic_write(self):
        guard=MagicMock(event_id='fixture',token='lease')
        browser=MagicMock();page=browser.new_page.return_value
        page.goto.return_value.status=200
        page.content.return_value='provider page'
        page.locator.return_value.inner_text.return_value='2 Tickets 4 Tickets'
        cards=[{'href':f'https://gametime.co/events/fixture?listingId=lot{q}&quantity={q}',
                'price':'5000','fees':True,'group':'Club','seat':'Section C1, Row 2'} for q in [2,4]]
        page.locator.return_value.evaluate_all.side_effect=[[cards[0]],[cards[1]]]
        runtime=types.ModuleType('playwright.sync_api')
        pw=MagicMock();pw.chromium.launch.return_value=browser
        runtime.sync_playwright=lambda:contextlib.nullcontext(pw)
        runtime.TimeoutError=TimeoutError
        meta={'event_id':'fixture','min_total':3900,'_inventory_state':'metadata_only'}
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}), \
             patch.dict(sys.modules,{'playwright':types.ModuleType('playwright'),'playwright.sync_api':runtime}), \
             patch.object(collect,'GUARD',guard),patch.object(collect,'parse_event_page',return_value=(meta,[])), \
             patch.object(collect,'sb',side_effect=AssertionError('render must not write')):
            listings=collect.rendered_quantity_listings('https://gametime.co/events/fixture',{2,4})
            guard.finish.assert_not_called()
            self.assertEqual({row['verified_quantity'] for row in listings},{2,4})
            collect.record_event_market({'event_id':'fixture'},meta,listings,'2026-10-21T00:00:00Z','partial')
        guard.finish.assert_called_once()
        capture=guard.finish.call_args.args[0]
        self.assertEqual(len(capture['listings']),2)
        self.assertEqual(capture['state'],'partial')
        self.assertEqual(set(capture['by_qty']),{'2','4'})
        self.assertFalse(capture['coverage']['complete'])
        browser.close.assert_called_once()

if __name__=='__main__':unittest.main()
