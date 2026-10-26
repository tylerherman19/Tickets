"""Hosted-only live checks; never fetches a provider page or sends a message."""
import json,os,sys,urllib.request,urllib.error
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ticketline_backend import service_key
base=os.environ['SUPABASE_URL'].rstrip('/')
def api(path,body=None,authenticated=True):
 headers={'Content-Type':'application/json'}
 if authenticated:headers['Authorization']='Bearer '+service_key()
 request=urllib.request.Request(base+'/rest/v1/'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
 with urllib.request.urlopen(request,timeout=60) as response:return json.load(response)
health=api('rpc/tix_runtime_health',{})
if health.get('schema',0)<20261030:raise RuntimeError('Incomplete schema')
public=api('tix_events_v?select=event_id&limit=1',authenticated=False)
if not isinstance(public,list):raise RuntimeError('Public catalog response is invalid')
try:api('tix_watches?select=id&limit=1',authenticated=False)
except urllib.error.HTTPError as error:
 if error.code not in(401,403):raise
else:raise RuntimeError('Anonymous callers could read private alerts')
api('tix_state?on_conflict=k',[{'k':'neon_connection_health','v':{'verified':True,'schema':health['schema']}}])
saved=api('tix_state?k=eq.neon_connection_health&select=v&limit=1')
if not saved or saved[0]['v'].get('verified') is not True:raise RuntimeError('Authenticated write/read verification failed')
print('Verified: public catalog, private-alert denial, GitHub identity, schema, and authenticated write/read.')
