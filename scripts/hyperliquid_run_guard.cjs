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
const BLOCKS=new Set(['http_403','http_429']);
const ERRORS=new Set(['invalid_arguments','missing_file','read_failed','invalid_file','file_too_large','invalid_json','invalid_feed_status','invalid_analytics_status','invalid_portfolios_status']);
const ADDRESS=/^0x[0-9a-f]{40}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const code=x=>x===null||(typeof x==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(x));
const fail=reason=>{throw Error(reason);};
function decision(states){
 if(!plain(states))fail('invalid_feed_status');
 const findings=[];
 const inspect=(value,stage,optional,invalid)=>{
  if(value===undefined&&optional)return;
  if(!code(value))fail(invalid);
  if(BLOCKS.has(value))findings.push({allowed:false,reason:value,stage});
 };
 const feed=states.feed,source=feed?.source;
 if(!plain(feed)||feed.schemaVersion!==1||!plain(source)||source.id!=='hyperliquid'||
  source.url!=='https://app.hyperliquid.xyz/leaderboard'||!Array.isArray(feed.traders)||feed.traders.length>200||
  source.selectedAccounts!==feed.traders.length||
  !((feed.status==='ready'&&['ok','stale'].includes(source.status))||(feed.status==='unavailable'&&source.status==='error')))
  fail('invalid_feed_status');
 inspect(source.errorCode,'feed',source.status!=='error','invalid_feed_status');
 const verification=source.positionVerification;
 if(verification!==undefined){
  if(!plain(verification)||verification.scope!=='default_perp_dex')fail('invalid_feed_status');
  inspect(verification.stopCode,'positions',true,'invalid_feed_status');
 }else if(feed.status==='ready')fail('invalid_feed_status');
 for(const [kind,method] of [['analytics','closing-fill-v1'],['portfolios','portfolio-periods-v2']]){
  const value=states[kind],invalid='invalid_'+kind+'_status',s=value?.source;
  if(!plain(value)||value.schemaVersion!==1||value.methodVersion!==method||!plain(s)||
   s.id!=='hyperliquid'||s.endpoint!=='https://api.hyperliquid.xyz/info'||
   !['ready','partial','unavailable'].includes(s.status)||!Object.hasOwn(s,'stopCode')||!plain(value.accounts))
   fail(invalid);
  const entries=Object.entries(value.accounts);
  if(entries.length>200||s.accounts!==entries.length)fail(invalid);
  inspect(s.stopCode,kind,false,invalid);
  for(const [address,record] of entries){
   if(!ADDRESS.test(address)||!plain(record)||!['ready','stale','unavailable'].includes(record.status)||!Object.hasOwn(record,'errorCode'))fail(invalid);
   inspect(record.errorCode,kind+'_record',false,invalid);
  }
 }
 return findings[0]||{allowed:true,reason:null,stage:null};
}
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
module.exports={FILES,decision,readBoundedJson,main};
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{process.stderr.write('hyperliquid_guard:read_failed\n');process.exitCode=1;});
