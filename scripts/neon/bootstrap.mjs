import {Client} from 'pg';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {migrationSource} from './migration-source.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const arg=process.argv.indexOf('--connection-file');
const connection=arg>=0?JSON.parse(await readFile(process.argv[arg+1],'utf8')):process.env.DATABASE_URL_UNPOOLED;
if(typeof connection!=='string'||!/^postgres(?:ql)?:\/\//.test(connection))throw new Error('A direct Neon connection is required');
const url=new URL(connection);
if(!url.hostname.endsWith('.neon.tech')||url.hostname.includes('-pooler.'))throw new Error('Bootstrap requires a direct Neon endpoint');
url.searchParams.set('sslmode','verify-full');
const db=new Client({connectionString:url.href});await db.connect();
try{
 await db.query(await readFile(path.join(root,'scripts/neon/compat.sql'),'utf8'));
 const existing=await db.query("select to_regclass('public.tix_watches') is not null present,(select count(*) from ticketline_internal.migrations)::integer recorded");
 if(existing.rows[0].present&&!existing.rows[0].recorded)throw new Error('Existing schema has no bootstrap checkpoints; verify and record its applied migrations before continuing');
 const files=JSON.parse(await readFile(path.join(root,'scripts/ticketline_migrations.json'),'utf8'));
 for(const file of files){
  const source=migrationSource(file,await readFile(path.join(root,'scripts',file),'utf8')),hash=createHash('sha256').update(source).digest('hex');
  const old=(await db.query('select sha256 from ticketline_internal.migrations where filename=$1',[file])).rows[0];
  if(old){if(old.sha256!==hash)throw new Error(`Applied migration changed: ${file}`);continue;}
  try{await db.query(source);await db.query('insert into ticketline_internal.migrations(filename,sha256) values($1,$2)',[file,hash]);console.log('Applied',file);}
  catch(error){await db.query('rollback');throw new Error(`Migration ${file}: ${error.message}`);}
 }
 await db.query(await readFile(path.join(root,'scripts/neon/runtime.sql'),'utf8'));
}finally{await db.end();}
