"""Availability gate: an unavailable free backend skips work without a mail loop."""
import json,os,sys,urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ticketline_backend import service_key
ready=False;reason='backend_unavailable'
try:
 key=service_key();base=os.environ['SUPABASE_URL'].rstrip('/')
 request=urllib.request.Request(base+'/rest/v1/rpc/tix_neon_capacity',data=b'{}',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 with urllib.request.urlopen(request,timeout=30) as response:state=json.load(response)
 if '--maintenance' in sys.argv:ready=True
 elif not state.get('capture_headroom'):reason='storage_budget'
 elif not state.get('provider_enabled'):reason='provider_paused'
 else:ready=True
except Exception as error:reason=type(error).__name__
message='Backend ready' if ready else 'Worker skipped: '+reason
print(message)
if os.environ.get('GITHUB_OUTPUT'):
 with open(os.environ['GITHUB_OUTPUT'],'a') as out:out.write('ready='+str(ready).lower()+'\n')
if os.environ.get('GITHUB_STEP_SUMMARY'):
 with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as out:out.write(message+'\n')
