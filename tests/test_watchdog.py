import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import tickets_watchdog as watchdog

class WatchdogTests(unittest.TestCase):
    def test_backup_schedule_uses_freshness_gate_and_shared_concurrency(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/tickets.yml').read_text()
        self.assertIn("cron: '8,23,38,53 * * * *'", workflow)
        self.assertIn("github.event_name == 'schedule'", workflow)
        self.assertIn('group: tickets-collector', workflow)
        self.assertIn('cancel-in-progress: false', workflow)

    def test_only_stale_checks_need_recovery(self):
        now = datetime(2026, 9, 28, 18, 0, tzinfo=timezone.utc)
        fresh = {'checked_at': (now-timedelta(minutes=24)).isoformat()}
        stale = {'checked_at': (now-timedelta(minutes=26)).isoformat()}
        self.assertFalse(watchdog.needs_recovery(fresh, now))
        self.assertTrue(watchdog.needs_recovery(stale, now))
        self.assertTrue(watchdog.needs_recovery(None, now))
        self.assertTrue(watchdog.needs_recovery({'checked_at':'invalid'}, now))

    def test_healthy_watchdog_does_not_start_collector(self):
        with patch.object(watchdog, 'latest_health', return_value={'checked_at':datetime.now(timezone.utc).isoformat()}), patch.object(watchdog.subprocess, 'run') as run:
            watchdog.main()
        run.assert_not_called()

    def test_stale_watchdog_starts_one_collector(self):
        with patch.object(watchdog, 'latest_health', return_value=None), patch.object(watchdog.subprocess, 'run') as run:
            watchdog.main()
        run.assert_called_once()
        self.assertTrue(run.call_args.kwargs['check'])

if __name__ == '__main__':
    unittest.main()
