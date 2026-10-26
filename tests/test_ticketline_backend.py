import base64,json,os,sys,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import ticketline_backend as backend
class Response:
 def __init__(self,token):self.token=token
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self):return json.dumps({'value':self.token}).encode()
def token(**overrides):
 claims={'repository':'tylerherman19/Tickets','ref':'refs/heads/main','exp':time.time()+300,**overrides}
 return 'header.'+base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')+'.signature'
class BackendIdentityTests(unittest.TestCase):
 def setUp(self):backend._cached=None
 def env(self):return patch.dict(os.environ,{'SUPABASE_SERVICE_KEY':'github-oidc','GITHUB_ACTIONS':'true','ACTIONS_ID_TOKEN_REQUEST_URL':'https://example.actions.githubusercontent.com/idtoken?api-version=2','ACTIONS_ID_TOKEN_REQUEST_TOKEN':'test-request-token'},clear=True)
 def test_legacy_key_is_unchanged(self):
  with patch.dict(os.environ,{'SUPABASE_SERVICE_KEY':'legacy'},clear=True):self.assertEqual(backend.service_key(),'legacy')
 def test_short_lived_key_is_cached_then_refreshed(self):
  first=token();second=token(exp=time.time()+400)
  with self.env(),patch.object(backend.urllib.request,'urlopen',side_effect=[Response(first),Response(second)]) as request:
   self.assertEqual(backend.service_key(),first);self.assertEqual(backend.service_key(),first)
   self.assertIn('audience=ticketline-github-actions',request.call_args.args[0].full_url)
   backend._cached=(first,time.time()+10)
   self.assertEqual(backend.service_key(),second);self.assertEqual(request.call_count,2)
 def test_untrusted_endpoint_is_never_contacted(self):
  with self.env(),patch.dict(os.environ,{'ACTIONS_ID_TOKEN_REQUEST_URL':'https://evil.invalid/token'}),patch.object(backend.urllib.request,'urlopen') as request:
   with self.assertRaises(RuntimeError):backend.service_key()
   request.assert_not_called()
 def test_wrong_repository_or_branch_is_rejected(self):
  for value in [token(repository='other/repo'),token(ref='refs/heads/pull-request')]:
   with self.env(),patch.object(backend.urllib.request,'urlopen',return_value=Response(value)):
    with self.assertRaises(RuntimeError):backend.service_key()
if __name__=='__main__':unittest.main()
