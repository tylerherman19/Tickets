import contextlib
import io
import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
import tickets_storage as storage
import ticketline_backend_release as release


class StorageWorkerTests(unittest.TestCase):
    def run_worker(self,results):
        responses=[io.BytesIO(json.dumps(result).encode()) for result in results]
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','SUPABASE_URL':'https://example.test','SUPABASE_SERVICE_KEY':'test'}), \
             patch.object(storage.urllib.request,'urlopen',side_effect=responses) as requests, \
             patch.object(storage.time,'sleep'),contextlib.redirect_stdout(io.StringIO()):
            storage.main()
        return requests

    def test_disabled_database_policy_never_requests_deletion(self):
        requests=self.run_worker([[{'listing_retention_enabled':False}]])
        self.assertEqual(requests.call_count,1)
        self.assertIsNone(requests.call_args.args[0].data)

    def test_partial_batch_does_not_end_cleanup_early(self):
        requests=self.run_worker([[{'listing_retention_enabled':True}],{'deleted':1},{'deleted':0}])
        self.assertEqual(requests.call_count,3)
        self.assertTrue(json.loads(requests.call_args_list[1].args[0].data)['p_execute'])

    def test_busy_batch_is_retried(self):
        requests=self.run_worker([[{'listing_retention_enabled':True}],{'deleted':0,'busy':True},{'deleted':0}])
        self.assertEqual(requests.call_count,3)


class StorageRecoveryTests(unittest.TestCase):
    def database(self,approved=True,remaining=0,history_after=100):
        calls=[];batches=iter([{'deleted':2000},{'deleted':0}])
        def sql(query,read_only=None):
            calls.append((query,read_only))
            if query.startswith('select listing_retention_enabled'):return [{'listing_retention_enabled':approved}]
            if query.startswith('select count(*) history_rows'):return [{'history_rows':100}]
            if ' cleanup;' in query:return [{'cleanup':next(batches)}]
            if query.startswith('select public.tix_prune_listing_copies'):return [{'retention':{'eligible_rows':remaining}}]
            if query.startswith('select pg_database_size'):return [{'database_bytes':500_000_000,'history_rows':history_after}]
            return []
        return sql,calls

    def test_recovery_requires_the_existing_owner_approval(self):
        sql,calls=self.database(approved=False)
        with self.assertRaisesRegex(RuntimeError,'owner approval'):release.recover_storage(sql)
        self.assertEqual(len(calls),1)

    def test_recovery_compacts_only_after_verified_cleanup(self):
        sql,calls=self.database()
        with contextlib.redirect_stdout(io.StringIO()):release.recover_storage(sql)
        queries=[query for query,_ in calls]
        self.assertTrue(any(query.startswith('vacuum (full,analyze) public.tix_listing_observations') for query in queries))
        self.assertIn('alter database postgres set default_transaction_read_only=off',queries[-1])
        self.assertTrue(any('set enabled=false' in query for query in queries))
        self.assertTrue(all(read_only is False for query,read_only in calls if ' cleanup;' in query))

    def test_missing_history_proof_keeps_raw_rows_and_captures_paused(self):
        sql,calls=self.database(remaining=1)
        with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'lack verified rollups'):
            release.recover_storage(sql)
        self.assertFalse(any(query.startswith('vacuum') for query,_ in calls))
        self.assertFalse(any('alter database' in query for query,_ in calls))

    def test_history_loss_never_resumes_database_writes(self):
        sql,calls=self.database(history_after=99)
        with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'Price-history verification failed'):
            release.recover_storage(sql)
        self.assertFalse(any('alter database' in query for query,_ in calls))
