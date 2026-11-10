#!/usr/bin/env node
'use strict';
/* Final holding verification after background analytics, with fail-closed guards.
 * The caller must wait one full rate-limit window before invoking this wrapper.
 */
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const LIMITS=Object.freeze({feedBytes:2*1024*1024,portfolioBytes:12*1024*1024,analyticsBytes:2*1024*1024,
  cooldownMs:60000,maxRunAgeMs:2*60*60000,maxAccounts:200,processTimeoutMs:6*60000});
const BLOCKS=new Set(['http_403','http_429']);
const STOPS=new Set([null,'http_403','http_429','batch_timeout','cancelled']);
const ADDRESS=/^0x[0-9a-f]{40}$/;
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const fail=code=>{throw Error(code);};
const errorCode=x=>x===null||x===undefined||typeof x==='string'&&/^[a-z0-9_]{1,80}$/.test(x);
function time(x){if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x))return NaN;const n=Date.parse(x);return Number.isFinite(n)&&n>=0?n:NaN;}
function checkTime(value,min,max,code){const n=time(value);if(!Number.isFinite(n)||n<min||n>max)fail(code);return n;}
function validateFeed(feed,{since,now}) {
  const source=feed?.source;
  if(!plain(feed)||feed.schemaVersion!==1||!['ready','unavailable'].includes(feed.status)||!plain(source)||source.id!=='hyperliquid'||
    !['ok','stale','error'].includes(source.status)||!Array.isArray(feed.traders)||feed.traders.length>200||source.selectedAccounts!==feed.traders.length)fail('invalid_feed_status');
  if(feed.status==='unavailable'?(source.status!=='error'||feed.traders.length!==0):source.status==='error')fail('invalid_feed_status');
  const completed=checkTime(source.lastAttemptAt,since,now+5000,'feed_not_from_current_run');
  if(!errorCode(source.errorCode)||(source.status!=='ok'&&!source.errorCode))fail('invalid_feed_status');
  const addresses=new Set();
  for(const row of feed.traders){const address=typeof row?.accountId==='string'?row.accountId.toLowerCase():'';
    if(!ADDRESS.test(address)||addresses.has(address))fail('invalid_feed_status');addresses.add(address);}
  const verification=source.positionVerification;
  if(source.status==='ok'&&!plain(verification))fail('invalid_feed_status');
  if(verification!==undefined){
    if(!plain(verification)||verification.scope!=='default_perp_dex'||!errorCode(verification.stopCode))fail('invalid_feed_status');
    for(const key of ['candidateAccounts','checkedAccounts','holdingAccounts','emptyAccounts','failedAccounts','unattemptedAccounts'])
      if(!Number.isSafeInteger(verification[key])||verification[key]<0||verification[key]>200)fail('invalid_feed_status');
    if(verification.holdingAccounts!==feed.traders.length||verification.checkedAccounts!==verification.holdingAccounts+verification.emptyAccounts||
      verification.candidateAccounts!==verification.checkedAccounts+verification.failedAccounts+verification.unattemptedAccounts)fail('invalid_feed_status');
    checkTime(verification.completedAt,0,completed+5000,'invalid_feed_status');
  }
  const block=[source.errorCode,verification?.stopCode].find(code=>BLOCKS.has(code))||null;
  return {completed,addresses,block};
}
function validateAggregate(snapshot,kind,{since,now,addresses}) {
  const method=kind==='portfolio'?'portfolio-periods-v2':'closing-fill-v1',field=kind==='portfolio'?'portfolio':'win';
  const source=snapshot?.source;
  if(!plain(snapshot)||snapshot.schemaVersion!==1||snapshot.methodVersion!==method||!plain(source)||source.id!=='hyperliquid'||
    !['ready','partial','unavailable'].includes(source.status)||!Object.hasOwn(source,'stopCode')||!STOPS.has(source.stopCode)||
    !plain(snapshot.accounts)||Object.keys(snapshot.accounts).length>200)fail('invalid_'+kind+'_status');
  const generated=checkTime(snapshot.generatedAt,since,now+5000,kind+'_not_from_current_run');
  checkTime(source.startedAt,since,generated,kind+'_not_from_current_run');
  if(source.completedAt!==snapshot.generatedAt)fail('invalid_'+kind+'_status');
  for(const key of ['accounts','cached','attempted','succeeded','failed','unattempted','available'])
    if(!Number.isSafeInteger(source[key])||source[key]<0||source[key]>200)fail('invalid_'+kind+'_status');
  if(source.accounts!==Object.keys(snapshot.accounts).length||source.cached+source.attempted+source.unattempted!==source.accounts||
    source.attempted!==source.succeeded+source.failed||source.available>source.accounts)fail('invalid_'+kind+'_status');
  let block=BLOCKS.has(source.stopCode)?source.stopCode:null,available=0;
  for(const [address,record] of Object.entries(snapshot.accounts)){
    if(!ADDRESS.test(address)||!addresses.has(address)||!plain(record)||!['ready','stale','unavailable'].includes(record.status)||!errorCode(record.errorCode))fail('invalid_'+kind+'_status');
    if(record.status==='unavailable'){
      if(record.fetchedAt!==null||record[field]!==null)fail('invalid_'+kind+'_status');
    }else{
      checkTime(record.fetchedAt,0,generated+5000,'invalid_'+kind+'_status');
      if(!plain(record[field])||record.status==='ready'&&record.errorCode!==null)fail('invalid_'+kind+'_status');available++;
    }
    if(record.lastAttemptAt!==null)checkTime(record.lastAttemptAt,0,generated+5000,'invalid_'+kind+'_status');
    if(!block&&BLOCKS.has(record.errorCode))block=record.errorCode;
  }
  if(source.available!==available)fail('invalid_'+kind+'_status');
  return {completed:generated,block};
}
function guardSnapshots({feed,portfolios,analytics,notBefore,now=Date.now()}) {
  const since=time(notBefore);
  if(!Number.isFinite(since)||since>now||now-since>LIMITS.maxRunAgeMs)fail('invalid_run_start');
  const first=validateFeed(feed,{since,now});
  const portfolio=validateAggregate(portfolios,'portfolio',{since,now,addresses:first.addresses});
  const win=validateAggregate(analytics,'analytics',{since,now,addresses:first.addresses});
  const stages=[['positions',first],['portfolio',portfolio],['analytics',win]];
  for(const [stage,result] of stages)if(result.block)return {allowed:false,reason:result.block,blockedStage:stage};
  const latest=Math.max(...stages.map(([,result])=>result.completed));
  if(now-latest<LIMITS.cooldownMs)fail('cooldown_not_elapsed');
  return {allowed:true,reason:null,blockedStage:null,notBefore,latestCompletedAt:new Date(latest).toISOString(),cooldownMs:now-latest};
}
async function readBounded(file,maxBytes,io=fs){
  const stat=await io.stat(file);if(stat.size>maxBytes)fail('status_file_too_large');
  const raw=await io.readFile(file,'utf8');if(Buffer.byteLength(raw)>maxBytes)fail('status_file_too_large');
  try{return JSON.parse(raw);}catch(_){fail('invalid_status_json');}
}
async function main(args=process.argv.slice(2),dependencies={}) {
  const root=path.resolve(__dirname,'..');
  const files={feed:path.join(root,'trader/feed.json'),portfolios:path.join(root,'trader/portfolios.json'),analytics:path.join(root,'trader/analytics.json')};
  let notBefore=null;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--not-before'&&args[i+1])notBefore=args[++i];
    else if(['--feed','--portfolios','--analytics'].includes(args[i])&&args[i+1])files[args[i].slice(2)]=path.resolve(args[++i]);
    else fail('invalid_arguments');
  }
  const io=dependencies.io||fs,now=dependencies.now||Date.now,run=dependencies.run||execute,log=dependencies.log||console.log;
  const [feed,portfolios,analytics]=await Promise.all([readBounded(files.feed,LIMITS.feedBytes,io),readBounded(files.portfolios,LIMITS.portfolioBytes,io),readBounded(files.analytics,LIMITS.analyticsBytes,io)]);
  const guard=guardSnapshots({feed,portfolios,analytics,notBefore,now:now()});
  if(!guard.allowed){const result={status:'skipped',reason:guard.reason,blockedStage:guard.blockedStage};log(JSON.stringify(result));return result;}
  const launched=now();
  await run('python3',['-B',path.join(__dirname,'collect_hyperliquid.py'),'--output',files.feed],{
    cwd:root,shell:false,timeout:LIMITS.processTimeoutMs,killSignal:'SIGTERM',maxBuffer:1024*1024,encoding:'utf8'});
  const updated=await readBounded(files.feed,LIMITS.feedBytes,io);
  validateFeed(updated,{since:launched,now:now()});
  const result={status:updated.source.status==='ok'?'refreshed':updated.source.status==='stale'?'source_stale':'source_unavailable',
    accounts:updated.traders.length,lastAttemptAt:updated.source.lastAttemptAt,errorCode:updated.source.errorCode||updated.source.positionVerification?.stopCode||null};
  log(JSON.stringify(result));return result;
}
module.exports={guardSnapshots,validateFeed,validateAggregate,readBounded,main,LIMITS};
if(require.main===module)main().catch(error=>{const code=typeof error?.message==='string'&&/^[a-z_]{1,80}$/.test(error.message)?error.message:'position_refresh_failed';console.error(JSON.stringify({status:'failed',errorCode:code}));process.exitCode=1;});
