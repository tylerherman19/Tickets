#!/usr/bin/env python3
"""Owner-approved raw-listing retention only. Never deletes alerts or price history."""
import json,os,urllib.request

def main():
 if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Storage maintenance is hosted-only')
 base=os.environ['SUPABASE_URL'];key=os.environ['SUPABASE_SERVICE_KEY'];deleted=0
 for _ in range(100):
  request=urllib.request.Request(base+'/rest/v1/rpc/tix_prune_listing_copies',data=b'{"p_execute":true,"p_limit":5000}',headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'})
  with urllib.request.urlopen(request,timeout=60) as response:result=json.load(response)
  n=result.get('deleted',0);deleted+=n
  if n<5000:break
 print('Superseded raw listing copies removed:',deleted,'; price-history rollups retained.')
if __name__=='__main__':main()
