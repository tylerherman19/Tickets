// Critical Ticketline state only. Encrypt before anything is written to disk.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {encryptSnapshot} from './backup_crypto.mjs';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('Backups must run in the hosted repository');
const base=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_KEY;
if(!base||!key)throw Error('Supabase backup settings are missing');
const headers={apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'};
if(process.argv[2]==='publish-health'){
 const health=JSON.parse(readFileSync('backups/health.json','utf8'));health.status='stored';health.artifact_id=process.env.BACKUP_ARTIFACT_ID;
 const saved=await fetch(base+'/rest/v1/tix_state?on_conflict=k',{method:'POST',headers:{...headers,Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({k:'backup_health',v:health,updated_at:health.checked_at}),redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!saved.ok)throw Error('Backup uploaded, but health record failed');
 console.log('Encrypted backup upload confirmed.');
}else{
const response=await fetch(base+'/rest/v1/rpc/tix_backup_snapshot',{method:'POST',headers,body:'{}',redirect:'error',signal:AbortSignal.timeout(60000)});
if(!response.ok)throw Error('Backup snapshot failed: HTTP '+response.status);
const snapshot=await response.json();
if(snapshot.scope!=='ticketline_private_state'||snapshot.schema<20261021||!Array.isArray(snapshot.tables?.tix_watches))throw Error('Unexpected backup schema');
const envelope=encryptSnapshot(snapshot,readFileSync(new URL('./backup-public.pem',import.meta.url),'utf8'));
mkdirSync('backups',{recursive:true});
const filename='backups/ticketline-private-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json.enc';
writeFileSync(filename,JSON.stringify(envelope),{mode:0o600});
const health={status:'encrypted_pending_upload',checked_at:new Date().toISOString(),schema:snapshot.schema,scope:snapshot.scope,rows:Object.fromEntries(Object.entries(snapshot.tables).map(([table,rows])=>[table,rows.length])),key_fingerprint:envelope.key_fingerprint};
writeFileSync('backups/health.json',JSON.stringify(health),{mode:0o600});
console.log('Encrypted critical-state backup created. Plaintext was never written to disk. Restore verification is separate.');
}
