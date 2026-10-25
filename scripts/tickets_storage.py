#!/usr/bin/env python3
"""Owner-approved raw-listing retention only. Never deletes alerts or price history."""
import json,os,time,urllib.request

def main():
 if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Storage maintenance is hosted-only')
 base=os.environ['SUPABASE_URL'];key=os.environ['SUPABASE_SERVICE_KEY'];deleted=0
 headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'}
 policy=urllib.request.Request(base+'/rest/v1/tix_storage_policy?id=eq.true&select=listing_retention_enabled&limit=1',headers=headers)
 with urllib.request.urlopen(policy,timeout=60) as response:rows=json.load(response)
 if not rows or rows[0].get('listing_retention_enabled') is not True:
  print('Raw-listing retention is not enabled by the owner; no rows removed.');return
 for _ in range(1000):
  request=urllib.request.Request(base+'/rest/v1/rpc/tix_prune_listing_copies',data=b'{"p_execute":true,"p_limit":2000}',headers=headers)
  with urllib.request.urlopen(request,timeout=60) as response:result=json.load(response)
  if result.get('busy'):time.sleep(1);continue
  n=result.get('deleted',0);deleted+=n
  if not n:break
 print('Superseded raw listing copies removed:',deleted,'; price-history rollups retained.')
if __name__=='__main__':main()
