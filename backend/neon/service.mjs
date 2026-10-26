import {Pool} from 'pg';
import {attachDatabasePool} from '@neon/functions';
const ident=x=>{if(!/^[a-z_][a-z0-9_]*$/.test(x))throw new Error('invalid_identifier');return '"'+x+'"';};
const response=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
export function createService(connectionString,{pool:providedPool}={}){
 if(!providedPool){if(!connectionString||!new URL(connectionString).password)throw new Error('A managed Neon database credential is required');const settings=new URL(connectionString);settings.searchParams.set('sslmode','verify-full');connectionString=settings.href;}
 const pool=providedPool||new Pool({connectionString,max:3,connectionTimeoutMillis:15000,idleTimeoutMillis:10000});if(!providedPool)attachDatabasePool(pool);
 const functions=new Map(),tables=new Map();
 async function rpc(name,body){
  let fn=functions.get(name);
  if(!fn){const {rows}=await pool.query("select p.proretset,t.typtype,p.proargnames,p.proargtypes::oid[] types from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_type t on t.oid=p.prorettype where n.nspname='public' and p.proname=$1",[name]);if(rows.length!==1)throw new Error('unknown_function');fn=rows[0];fn.types=fn.types.map(Number);functions.set(name,fn);}
  const keys=Object.keys(body||{}),values=keys.map(k=>{const i=fn.proargnames?.indexOf(k);if(i===undefined||i<0)throw new Error('unknown_argument');return [114,3802].includes(fn.types[i])?JSON.stringify(body[k]):body[k];});
  const call=keys.map((k,i)=>`${ident(k)}=>$${i+1}`).join(',');
  const {rows}=await pool.query(`select * from public.${ident(name)}(${call})`,values);
  return fn.proretset?rows:fn.typtype==='c'?(rows[0]||null):rows.length?Object.values(rows[0])[0]:null;
 }
 async function table(name){let t=tables.get(name);if(!t){const {rows}=await pool.query("select column_name,udt_name from information_schema.columns where table_schema='public' and table_name=$1",[name]);if(!rows.length)throw new Error('unknown_table');t=new Map(rows.map(x=>[x.column_name,x.udt_name]));tables.set(name,t);}return t;}
 return {
  syncUser:id=>pool.query('select public.tix_sync_neon_user($1)',[id]),
  async request(url,options){try{
   const name=url.pathname.split('/').at(-1),method=options.method||'GET';
   if(url.pathname.includes('/rpc/')){if(method!=='POST')return response({error:'POST_required'},405);return response(await rpc(name,JSON.parse(options.body||'{}')));}
   const columns=await table(name),values=[],filters=[],col=x=>{if(!columns.has(x))throw new Error('unknown_column');return ident(x);};
   const value=(key,v)=>{values.push(['json','jsonb'].includes(columns.get(key))&&v!==null?JSON.stringify(v):v);return '$'+values.length;};
   for(const [key,expr]of url.searchParams){
    if(['select','order','limit','offset','on_conflict'].includes(key))continue;
    const c=col(key);let match=expr.match(/^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike)\.(.*)$/s);
    if(match){const operators={eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<=',like:'like',ilike:'ilike'},pattern=['like','ilike'].includes(match[2])?match[3].replaceAll('*','%'):match[3];filters.push(`${match[1]?'not (':''}${c} ${operators[match[2]]} ${value(key,pattern)}${match[1]?')':''}`);continue;}
    if(expr==='is.null'||expr==='not.is.null'){filters.push(`${c} is ${expr.startsWith('not')?'not ':''}null`);continue;}
    match=expr.match(/^(not\.)?in\.\((.*)\)$/s);if(match){const list=match[2].split(',').map(x=>x.replace(/^"|"$/g,''));if(!list.length)throw new Error('empty_filter');filters.push(`${c} ${match[1]?'not ':''}in (${list.map(x=>value(key,x)).join(',')})`);continue;}
    if(expr==='is.true'||expr==='is.false'){filters.push(`${c} is ${expr.slice(3)}`);continue;}
    throw new Error('unsupported_filter');
   }
   const where=filters.length?' where '+filters.join(' and '):'',relation='public.'+ident(name);
   const select=url.searchParams.get('select')||'*',projection=select==='*'?'*':select.split(',').map(col).join(',');
   if(method==='GET'||method==='HEAD'){
    const order=url.searchParams.get('order');let ordering='';
    if(order)ordering=' order by '+order.split(',').map(x=>{const [key,dir='asc',nulls]=x.split('.');if(!['asc','desc'].includes(dir)||nulls&&!['nullsfirst','nullslast'].includes(nulls))throw new Error('invalid_order');return col(key)+' '+dir+(nulls?' nulls '+nulls.slice(5):'');}).join(',');
    const limit=Math.min(1000,Math.max(1,Number(url.searchParams.get('limit')||500))),offset=Math.max(0,Number(url.searchParams.get('offset')||0));if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset))throw new Error('invalid_pagination');
    return response((await pool.query(`select ${projection} from ${relation}${where}${ordering} limit ${limit} offset ${offset}`,values)).rows);
   }
   const body=options.body?JSON.parse(options.body):null,prefer=new Headers(options.headers).get('prefer')||'';
   if(method==='POST'){
    const rows=Array.isArray(body)?body:[body];if(!rows.length)return response([]);if(rows.length>1000)throw new Error('batch_limit');
    const keys=Object.keys(rows[0]);keys.forEach(col);if(!keys.length||rows.some(r=>Object.keys(r).some(k=>!keys.includes(k))))throw new Error('invalid_rows');
    const tuples=rows.map(r=>'('+keys.map(k=>value(k,r[k]??null)).join(',')+')').join(',');let conflict='';
    if(prefer.includes('resolution=')){
     const specified=url.searchParams.get('on_conflict');
     const target=specified?specified.split(','):(await pool.query("select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid=$1::regclass and i.indisprimary",['public.'+name])).rows.map(x=>x.attname);
     if(!target.length)throw new Error('conflict_target_required');target.forEach(col);
     conflict=' on conflict ('+target.map(ident).join(',')+') '+(prefer.includes('ignore-duplicates')?'do nothing':'do update set '+keys.map(k=>`${ident(k)}=excluded.${ident(k)}`).join(','));
    }
    const r=await pool.query(`insert into ${relation}(${keys.map(ident).join(',')}) values ${tuples}${conflict} returning ${projection}`,values);
    return prefer.includes('return=representation')?response(r.rows,201):new Response(null,{status:201});
   }
   if(!filters.length)throw new Error('write_filter_required');
   if(method==='PATCH'){const keys=Object.keys(body||{});if(!keys.length)throw new Error('empty_update');const set=keys.map(k=>`${col(k)}=${value(k,body[k])}`).join(',');const r=await pool.query(`update ${relation} set ${set}${where} returning ${projection}`,values);return prefer.includes('return=representation')?response(r.rows):new Response(null,{status:204});}
   if(method==='DELETE'){await pool.query(`delete from ${relation}${where}`,values);return new Response(null,{status:204});}
   return response({error:'unsupported_method'},405);
  }catch(error){console.error('ticketline_service_error',error.code||String(error.message).slice(0,60));return response({code:error.code||'invalid_request',message:String(error.message).slice(0,300)},400);}}
 };
}
