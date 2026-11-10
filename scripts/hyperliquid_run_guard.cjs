#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {TextDecoder}=require('node:util');
const FILES=Object.freeze([
 Object.freeze({kind:'feed',name:'feed.json',maxBytes:2*1024*1024}),
 Object.freeze({kind:'analytics',name:'analytics.json',maxBytes:2*1024*1024}),
 Object.freeze({kind:'portfolios',name:'portfolios.json',maxBytes:12*1024*1024})
]);
const ERRORS=new Set(['invalid_arguments','missing_file','read_failed','invalid_file','file_too_large','invalid_json','invalid_feed_status','invalid_analytics_status','invalid_portfolios_status']);
const {decision}=require('../trader/source-policy.js');
const fail=reason=>{throw Error(reason);};
async function readBoundedJson(file,maxBytes,io=fs){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1)fail('invalid_file');
 let handle;
 try{
  handle=await io.open(file,'r');
  const stat=await handle.stat();
  if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size<1)fail('invalid_file');
  if(stat.size>maxBytes)fail('file_too_large');
  // Check bytes actually read too: the file may grow after stat().
  const buffer=Buffer.alloc(maxBytes+1);
  let count=0;
  for(;;){
   const size=Math.min(65536,maxBytes+1-count);
   const result=await handle.read(buffer,count,size,null),bytes=result?.bytesRead;
   if(!Number.isSafeInteger(bytes)||bytes<0||bytes>size)fail('read_failed');
   count+=bytes;
   if(count>maxBytes)fail('file_too_large');
   if(bytes===0)break;
  }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count)));}
  catch{fail('invalid_json');}
 }catch(error){
  if(ERRORS.has(error?.message))throw error;
  fail(error?.code==='ENOENT'?'missing_file':'read_failed');
 }finally{
  if(handle)await handle.close();
 }
}
async function checkCommitted() {
 const states={};
 for(const entry of FILES)states[entry.kind]=await readBoundedJson(path.join(__dirname,'../trader',entry.name),entry.maxBytes);
 const result=decision(states);
 if(!result.allowed)throw Error(result.reason);
}
async function main(args=process.argv.slice(2),dependencies={}){
 const stdout=dependencies.stdout||(text=>process.stdout.write(text));
 const stderr=dependencies.stderr||(text=>process.stderr.write(text));
 try{
  if(args.length)fail('invalid_arguments');
  const root=dependencies.root||path.resolve(__dirname,'..'),io=dependencies.io||fs;
  const states={};
  // All three sources must be readable before a decision can permit requests.
  for(const file of FILES)states[file.kind]=await readBoundedJson(path.join(root,'trader',file.name),file.maxBytes,io);
  const result=decision(states);
  if(!result.allowed)stderr('hyperliquid_guard:blocked:'+result.stage+':'+result.reason+'\n');
  stdout('allowed='+String(result.allowed)+'\n');
  return 0;
 }catch(error){
  stderr('hyperliquid_guard:'+(ERRORS.has(error?.message)?error.message:'read_failed')+'\n');
  return 1;
 }
}
module.exports={FILES,decision,readBoundedJson,checkCommitted,main};
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{process.stderr.write('hyperliquid_guard:read_failed\n');process.exitCode=1;});
