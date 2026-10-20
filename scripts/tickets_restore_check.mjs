// Offline restore drill. Uses an isolated, in-memory PostgreSQL database only.
import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';import {decryptSnapshot} from './backup_crypto.mjs';
export async function verifyRestore(snapshot){
 if(snapshot.format!==1||snapshot.scope!=='ticketline_private_state'||snapshot.schema!==20261021)throw Error('Unsupported snapshot');
 const allowed=['tix_watches','tix_destinations','tix_confirmation_queue','tix_admins','tix_prices','tix_delivery_outbox','tix_alerts','tix_scans','tix_watch_events','tix_watch_audit','tix_admin_audit','tix_searches','tix_schema_versions'];
 if(Object.keys(snapshot.tables).some(t=>!allowed.includes(t))||allowed.some(t=>!Array.isArray(snapshot.tables[t])))throw Error('Unexpected backup table');
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 for(const name of JSON.parse(readFileSync(new URL('./ticketline_migrations.json',import.meta.url),'utf8'))){
  const sql=readFileSync(new URL('./'+name,import.meta.url),'utf8').replace(/^.*(?:create extension.*pg_trgm|create index.*gin_trgm_ops).*$/gm,'');
  await db.exec(sql);
 }
 await db.exec('begin');
 for(const owner of snapshot.owner_references)await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)',[owner.id,owner.email,owner.email_confirmed_at]);
 for(const table of allowed){
  // This database has no server connection and no production credentials.
  await db.exec(`alter table public."${table}" disable trigger user`);
  const rows=snapshot.tables[table];
  if(rows.length)await db.query(`insert into public."${table}" overriding system value select * from jsonb_populate_recordset(null::public."${table}",$1::jsonb) on conflict do nothing`,[JSON.stringify(rows)]);
  await db.exec(`alter table public."${table}" enable trigger user`);
  const count=Number((await db.query(`select count(*) n from public."${table}"`)).rows[0].n);
  if(table==='tix_schema_versions'?count<rows.length:count!==rows.length)throw Error('Restore count mismatch: '+table);
 }
 await db.exec('commit');
 const ownership=await db.query('select count(*) n from tix_watches w left join auth.users u on u.id=w.owner_id where u.id is null');
 if(Number(ownership.rows[0].n))throw Error('Restored alerts have missing owners');
 return {status:'restore_verified',schema:snapshot.schema,tables:allowed.length,rows:Object.values(snapshot.tables).reduce((n,rows)=>n+rows.length,0),scope:snapshot.scope};
 }finally{await db.close();}
}
if(process.argv[1]?.endsWith('tickets_restore_check.mjs')){
 const [archive,keyPath]=process.argv.slice(2);if(!archive||!keyPath)throw Error('Usage: node scripts/tickets_restore_check.mjs encrypted-backup recovery-private-key');
 const snapshot=decryptSnapshot(JSON.parse(readFileSync(archive,'utf8')),readFileSync(keyPath,'utf8'));
 console.log(JSON.stringify(await verifyRestore(snapshot))); // Counts only, no private records.
}
