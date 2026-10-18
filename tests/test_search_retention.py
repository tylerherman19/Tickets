import io
import os
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, 'scripts')
import tickets_search_retention as retention

class SearchRetentionTests(unittest.TestCase):
    def test_calls_only_private_retention_rpc_and_prints_count(self):
        with patch.dict(os.environ, {'SUPABASE_URL':'https://example.supabase.co/', 'SUPABASE_SERVICE_KEY':'test-only'}), patch.object(retention.urllib.request, 'urlopen') as opened, patch('sys.stdout', new_callable=io.StringIO) as output:
            opened.return_value.__enter__.return_value=io.BytesIO(b'3')
            retention.main()
            request=opened.call_args.args[0]
            self.assertEqual(request.full_url, 'https://example.supabase.co/rest/v1/rpc/tix_prune_search_activity')
            self.assertEqual(request.data, b'{}')
            self.assertEqual(opened.call_args.kwargs['timeout'],30)
            self.assertEqual(output.getvalue(),'Expired search records: 3\n')
