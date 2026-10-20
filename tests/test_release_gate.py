import io
import json
import os
import sys
import unittest
import urllib.error
from unittest.mock import patch
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
import tickets_release_gate as gate

class ReleaseGateTests(unittest.TestCase):
    def test_missing_rpc_fails_release_preflight(self):
        error=urllib.error.HTTPError('https://database.invalid',404,'missing',{},io.BytesIO(b'{"code":"PGRST202"}'))
        with patch.dict(os.environ,{'SUPABASE_URL':'https://database.invalid','SUPABASE_SERVICE_KEY':'fixture'}),patch('urllib.request.urlopen',side_effect=error):
            self.assertFalse(gate.schema_ready())
    def test_auth_errors_do_not_bypass_guard(self):
        error=urllib.error.HTTPError('https://database.invalid',401,'auth',{},io.BytesIO(b'{"code":"bad_auth"}'))
        with patch.dict(os.environ,{'SUPABASE_URL':'https://database.invalid','SUPABASE_SERVICE_KEY':'fixture'}),patch('urllib.request.urlopen',side_effect=error):
            with self.assertRaisesRegex(RuntimeError,'HTTP 401'):gate.schema_ready()
    def test_fast_search_schema_uses_current_collector(self):
        for guard_enabled in (False,True):
            response=io.BytesIO(json.dumps({'guard_enabled':guard_enabled,'schema':20261022}).encode())
            with patch.dict(os.environ,{'SUPABASE_URL':'https://database.invalid','SUPABASE_SERVICE_KEY':'fixture'}),patch('urllib.request.urlopen',return_value=response):
                self.assertTrue(gate.schema_ready())
    def test_older_schema_is_not_accepted(self):
        # 20261012 without 20261016 lacks the RPCs the current collector calls.
        response=io.BytesIO(json.dumps({'guard_enabled':False}).encode())
        with patch.dict(os.environ,{'SUPABASE_URL':'https://database.invalid','SUPABASE_SERVICE_KEY':'fixture'}),patch('urllib.request.urlopen',return_value=response):
            self.assertFalse(gate.schema_ready())
    def test_local_preflight_cannot_use_service_credentials(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}),patch.object(gate,'schema_ready') as ready:
            with self.assertRaises(RuntimeError):gate.main()
            ready.assert_not_called()

    def test_sitemap_refresh_preserves_provider_verified_college_categories(self):
        source=open(os.path.join(os.path.dirname(__file__),'..','scripts','tickets_collect.py')).read()
        patched=gate.preserve_college_categories(source)
        compile(patched,'collector','exec')
        self.assertIn("r['category'] = 'college-basketball'",patched)
        self.assertIn('category=eq.college-basketball&select=event_id',patched)
        self.assertEqual(gate.preserve_college_categories(patched),patched)
        with self.assertRaises(RuntimeError): gate.preserve_college_categories('changed format')
