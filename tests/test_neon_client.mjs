import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {JSDOM} from 'jsdom';
test('the deployed browser bundle exposes OTP rate limits instead of reporting delivery success',async()=>{
 const dom=new JSDOM('',{url:'https://tylerherman19.github.io/Tickets/',runScripts:'outside-only'});const w=dom.window,calls=[];
 try{
  Object.defineProperty(w,'crypto',{value:webcrypto});Object.assign(w,{TextEncoder,TextDecoder,Response,Request,Headers,AbortController,AbortSignal,NEON_AUTH_URL:'https://auth.example.invalid/auth'});
  w.fetch=async(url,options)=>{calls.push(String(url));return Response.json({message:'Too many attempts',code:'TOO_MANY_REQUESTS'},{status:429});};
  w.eval(await readFile('neon-auth-client.js','utf8'));
  const result=await w.TicketlineNeonAuth.signInWithOtp({email:'fixture@example.invalid'});
  assert.equal(result.error.status,429);assert.ok(calls.some(x=>x.endsWith('/email-otp/send-verification-otp')));
 }finally{w.close();}
});
