import {build} from 'esbuild';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
await mkdir(path.join(root,'.neon-build'),{recursive:true});
await build({absWorkingDir:root,entryPoints:['backend/neon/auth-client.mjs'],outfile:'neon-auth-client.js',bundle:true,platform:'browser',target:'es2022',format:'iife',minify:true});
const banner="import{createRequire as ___cr}from'node:module';const require=___cr(import.meta.url);";
await build({absWorkingDir:root,entryPoints:['backend/neon/index.mjs'],outfile:'.neon-build/index.mjs',bundle:true,platform:'node',target:'node24',format:'esm',banner:{js:banner},plugins:[{
 name:'existing-quote-service',setup(builder){
  builder.onResolve({filter:/^ticketline:quotes$/},()=>({path:'quote-service',namespace:'ticketline'}));
  builder.onLoad({filter:/.*/,namespace:'ticketline'},async()=>{
   let source=await readFile(path.join(root,'supabase/functions/ticketline-prices/index.ts'),'utf8');
   source=source.split('\n').slice(1).join('\n').replace('declare const EdgeRuntime: {waitUntil(work:Promise<unknown>):void};','').replace('export async function handleRequest','async function handleRequest').replace('Deno.serve(handleRequest);','return handleRequest;');
   return {loader:'ts',resolveDir:root,contents:`import {captureFromPage,blockingSignals,validEventUrl,movedEventUrl,performerPaths} from './supabase/functions/_shared/provider.mjs';\nimport {waitUntil} from '@neon/functions';\nexport function createQuoteHandler(fetch,env){const EdgeRuntime={waitUntil};const Deno={env:{get:name=>({SUPABASE_URL:'https://ticketline.internal',SUPABASE_SERVICE_ROLE_KEY:env.TIX_INTERNAL_KEY,SUPABASE_ANON_KEY:'public',TIX_ALLOWED_ORIGINS:env.TIX_ALLOWED_ORIGINS}[name])}};\n${source}\n}`};
  });
 }
}]});
