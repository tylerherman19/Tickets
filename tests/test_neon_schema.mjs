import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {migrationSource} from '../scripts/neon/migration-source.mjs';
import {createService} from '../backend/neon/service.mjs';
test('Neon bootstrap preserves owner RLS and does not add privileged recovery exclusions',async()=>{
 const db=new PGlite();
 try{
  await db.exec('create role anonymous;create schema neon_auth;create table neon_auth."user"(id uuid primary key,email text,"emailVerified" boolean,"createdAt" timestamptz);');
  await db.exec(fs.readFileSync('scripts/neon/compat.sql','utf8').replace(/^create extension.*$/gm,''));
  for(const file of JSON.parse(fs.readFileSync('scripts/ticketline_migrations.json','utf8')))await db.exec(migrationSource(file,fs.readFileSync('scripts/'+file,'utf8')).replace(/^.*(?:create extension.*pg_trgm|create index.*gin_trgm_ops).*$/gm,''));
  await db.exec(fs.readFileSync('scripts/neon/runtime.sql','utf8'));
  const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
  for(let i=0;i<2;i++){await db.query('insert into neon_auth."user" values($1,$2,true,now())',[ids[i],`fixture${i}@example.invalid`]);await db.query('select public.tix_sync_neon_user($1)',[ids[i]]);await db.query("insert into tix_watches(owner_id,label,kind,match,qty,threshold_cents) values($1,$2,'event','{}',2,7500)",[ids[i],'Fixture '+i]);}
  await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:ids[0]})]);
  assert.deepEqual((await db.query('select owner_id from public.tix_watches')).rows.map(x=>x.owner_id),[ids[0]]);
  await assert.rejects(db.query('select * from public.tix_destinations'));
  await assert.rejects(db.query('select public.tix_sync_neon_user($1)',[ids[1]]));
  assert.equal((await db.query('select public.tix_is_admin() allowed')).rows[0].allowed,false);
  await db.exec('reset role');
  assert.equal((await db.query("select count(*)::integer n from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and (p.proname='tix_delete_my_account' or p.proname like 'tix_admin_%')")).rows[0].n,0);
  const service=createService(null,{pool:{query:(...args)=>db.query(...args)}});
  const result=await service.request(new URL('https://api.example/rest/v1/tix_state?on_conflict=k'),{method:'POST',headers:{prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify([{k:'neon-fixture',v:{valid:true}}])});
  assert.equal(result.status,201);assert.deepEqual((await result.json())[0].v,{valid:true});
  const health=await service.request(new URL('https://api.example/rest/v1/rpc/tix_runtime_health'),{method:'POST',body:'{}'});assert.equal(health.status,200);assert.equal((await health.json()).schema,20261030);
 }finally{await db.close();}
});
