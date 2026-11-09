#!/usr/bin/env node
'use strict';
/* Public, read-only closing-fill aggregates. Raw fills are never written to disk.
 * Every successful sample uses the same normalizer as the account detail page.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const analytics = require('../trader/account-analytics.js');
const INFO = 'https://api.hyperliquid.xyz/info';
const METHOD_VERSION = 'closing-fill-v1';
const LIMITS = Object.freeze({maxAccounts:200,weightPerMinute:900,requestWeight:120,intervalMs:60000,
  concurrency:2,timeoutMs:12000,batchMs:22*60000,freshMs:20*60000,staleMs:60*60000,
  maxBytes:5*1024*1024,maxFileBytes:2*1024*1024});
const ADDRESS = /^0x[0-9a-f]{40}$/;
const COUNTS = ['winning','losing','breakeven','eligibleCount','totalFills','receivedFills','duplicateCount','excludedCount'];
const TIMES = ['startAt','endAt','sourceSampleStartAt','sourceSampleEndAt'];
const ERROR_CODES = new Set(['http_403','http_429','network_error','request_timeout','batch_timeout','source_blocked',
  'invalid_response','invalid_content_type','response_too_large','cancelled','not_attempted','cache_expired']);
const clone = value => JSON.parse(JSON.stringify(value));
const iso = time => new Date(time).toISOString();
const fail = code => { throw Error(code); };
const plain = value => !!value && typeof value==='object' && !Array.isArray(value);
function time(value) {
  if (typeof value!=='string' || value.length>40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const result=Date.parse(value);return Number.isFinite(result)&&result>=0?result:NaN;
}
function safeError(error) {
  const message=error?.message;
  return ERROR_CODES.has(message)||/^http_[45]\d\d$/.test(message||'')?message:'invalid_response';
}
function blockedByFeed(feed) {
  const codes=[feed?.source?.positionVerification?.stopCode,feed?.source?.errorCode];
  return codes.find(code=>code==='http_403'||code==='http_429') || null;
}
function selectAccounts(feed, now=Date.now()) {
  if (!plain(feed)||!Array.isArray(feed.traders)||feed.traders.length>LIMITS.maxAccounts||feed.source?.id!=='hyperliquid')fail('invalid_feed');
  const verification=feed.source.positionVerification;
  // Older, not-yet-verified feeds may never trigger account requests.
  if (!verification || verification.scope!=='default_perp_dex')return [];
  const addresses=[],seen=new Set();
  for (const row of feed.traders) {
    if (!plain(row)||typeof row.accountId!=='string')fail('invalid_feed');
    const address=row.accountId.toLowerCase(),check=row.positionCheck;
    if (!ADDRESS.test(address)||seen.has(address))fail('invalid_feed');seen.add(address);
    if(row.sourceKind!=='public_account'||row.exchange!=='Hyperliquid'||!plain(check)||check.scope!=='default_perp_dex')continue;
    const checked=time(check.checkedAt),source=time(check.sourceTime);
    if(!Number.isSafeInteger(check.count)||check.count<1||check.count>1000||!Number.isFinite(checked)||!Number.isFinite(source))continue;
    if(now-checked>3600000||checked-now>5000||checked-source>120000||source-checked>5000)continue;
    addresses.push(address);
  }
  return addresses;
}
function validWin(raw, fetchedAt) {
  if(!plain(raw)||raw.method!=='closing_fill_net_of_closing_fee'||raw.scope!=='default_perp_dex'||raw.unit!=='percent'||
    raw.feeToken!=='USDC'||raw.historyComplete!==false||raw.includesOpeningFees!==false||raw.includesFunding!==false||typeof raw.capped!=='boolean')return null;
  const win={};
  for(const key of COUNTS){if(!Number.isSafeInteger(raw[key])||raw[key]<0||raw[key]>2000)return null;win[key]=raw[key];}
  if(win.winning+win.losing+win.breakeven!==win.eligibleCount||win.eligibleCount+win.excludedCount!==win.totalFills||
    win.totalFills+win.duplicateCount!==win.receivedFills||raw.capped!==(win.receivedFills===2000))return null;
  const expected=win.eligibleCount?win.winning/win.eligibleCount*100:null;
  if(expected===null?raw.value!==null:typeof raw.value!=='number'||!Number.isFinite(raw.value)||Math.abs(raw.value-expected)>1e-8)return null;
  for(const key of TIMES){if(raw[key]!==null&&(!Number.isFinite(time(raw[key]))||time(raw[key])>fetchedAt+5000))return null;win[key]=raw[key];}
  for(const [first,last,count] of [['startAt','endAt',win.eligibleCount],['sourceSampleStartAt','sourceSampleEndAt',win.totalFills]]) {
    if(count===0?(win[first]!==null||win[last]!==null):(win[first]===null||win[last]===null||time(win[first])>time(win[last])))return null;
  }
  if(win.eligibleCount&&(time(win.startAt)<time(win.sourceSampleStartAt)||time(win.endAt)>time(win.sourceSampleEndAt)))return null;
  return {...win,value:expected,unit:'percent',capped:raw.capped,historyComplete:false,method:raw.method,
    scope:'default_perp_dex',feeToken:'USDC',includesOpeningFees:false,includesFunding:false};
}
function validatedCache(previous, addresses, now=Date.now()) {
  const result={};
  if(!plain(previous)||previous.schemaVersion!==1||previous.methodVersion!==METHOD_VERSION||!plain(previous.accounts)||
    Object.keys(previous.accounts).length>LIMITS.maxAccounts||!Number.isFinite(time(previous.generatedAt))||time(previous.generatedAt)>now+5000)return result;
  for(const address of addresses) {
    const raw=Object.hasOwn(previous.accounts,address)?previous.accounts[address]:null;
    if(!plain(raw)||!['ready','stale'].includes(raw.status))continue;
    const cachedError=raw.errorCode??null;
    if(cachedError!==null&&(typeof cachedError!=='string'||safeError({message:cachedError})!==cachedError))continue;
    const fetched=time(raw.fetchedAt);
    if(!Number.isFinite(fetched)||fetched>time(previous.generatedAt)+5000||fetched>now+5000)continue;
    const win=validWin(raw.win,fetched);if(!win)continue;
    const attempt=time(raw.lastAttemptAt);
    result[address]={status:raw.status==='stale'||cachedError||now-fetched>LIMITS.staleMs?'stale':'ready',fetchedAt:iso(fetched),
      lastAttemptAt:Number.isFinite(attempt)&&attempt<=time(previous.generatedAt)+5000?iso(attempt):iso(fetched),
      errorCode:cachedError,win};
  }
  return result;
}
async function readJsonResponse(response, maxBytes=LIMITS.maxBytes) {
  if(!response||!Number.isInteger(response.status))fail('invalid_response');
  const contentType=response.headers?.get?.('content-type')||'';
  if(!/(?:application|text)\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(contentType))fail('invalid_content_type');
  const length=response.headers?.get?.('content-length');
  if(length!==undefined&&length!==null&&length!==''&&(!/^\d+$/.test(String(length))||Number(length)>maxBytes))fail('response_too_large');
  let text;
  if(response.body?.getReader) {
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try {
      for(;;){const row=await reader.read();if(row.done)break;if(!(row.value instanceof Uint8Array))fail('invalid_response');bytes+=row.value.byteLength;if(bytes>maxBytes)fail('response_too_large');chunks.push(row.value);}
      text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes));
    }catch(error){try{await reader.cancel();}catch(_){}throw error;}finally{reader.releaseLock();}
  }else{
    if(typeof response.text!=='function')fail('invalid_response');text=await response.text();
    if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)fail('response_too_large');
  }
  try{return JSON.parse(text);}catch(_){fail('invalid_response');}
}
function blank(){return {status:'unavailable',fetchedAt:null,lastAttemptAt:null,errorCode:null,win:null};}
async function collect({feed,previous=null,priorStopCode=null,fetch:fetcher=globalThis.fetch,now=Date.now,clock=()=>performance.now(),
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),setTimer=setTimeout,clearTimer=clearTimeout,limits={}}={}) {
  const config={...LIMITS,...limits};
  // Test configuration can tighten bounds, never raise the production ceilings.
  for(const key of ['maxAccounts','weightPerMinute','concurrency','timeoutMs','batchMs','maxBytes'])
    if(!Number.isFinite(config[key])||config[key]<=0||config[key]>LIMITS[key])fail('invalid_limits');
  config.requestWeight=LIMITS.requestWeight;config.intervalMs=LIMITS.intervalMs;
  if(config.weightPerMinute<config.requestWeight)fail('invalid_limits');
  const startedAt=iso(now()),start=clock(),addresses=selectAccounts(feed,now()).slice(0,config.maxAccounts);
  const accounts=validatedCache(previous,addresses,now());
  for(const address of addresses)if(!accounts[address])accounts[address]=blank();
  const queue=addresses.filter(address=>accounts[address].status!=='ready'||!accounts[address].fetchedAt||now()-time(accounts[address].fetchedAt)>config.freshMs)
    .sort((a,b)=>(time(accounts[a].fetchedAt)||0)-(time(accounts[b].fetchedAt)||0));
  const cached=addresses.length-queue.length,active=new Map(),ledger=[];
  let attempted=0,succeeded=0,failed=0,stopCode=blockedByFeed(feed)||(['http_403','http_429'].includes(priorStopCode)?priorStopCode:null),batchTimer=null;
  const stop=code=>{
    if(!stopCode)stopCode=code;
    for(const task of active.values())task.cancel(stopCode);
  };
  const markFailure=(address,code,attemptedAt)=>{
    const record=accounts[address];record.status=record.win?'stale':'unavailable';
    if(attemptedAt)record.lastAttemptAt=attemptedAt;record.errorCode=code;
  };
  function launch(address) {
    const attemptedAt=iso(now()),controller=new AbortController();let timer=null,rejectCancel,settled=false;
    const cancelled=new Promise((_,reject)=>{rejectCancel=reject;});
    const task={cancel:code=>{if(settled)return;controller.abort();rejectCancel(Error(code));},promise:null};
    accounts[address].lastAttemptAt=attemptedAt;attempted++;ledger.push(clock());active.set(address,task);
    timer=setTimer(()=>task.cancel('request_timeout'),Math.min(config.timeoutMs,Math.max(1,config.batchMs-(clock()-start))));
    const operation=(async()=>{
      let response;
      try{response=await fetcher(INFO,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({type:'userFills',user:address,aggregateByTime:false}),credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});}
      catch(error){if(controller.signal.aborted)throw error;throw Error('network_error');}
      if(controller.signal.aborted)throw Error(stopCode||'cancelled');
      if(response?.status===403||response?.status===429){const code='http_'+response.status;stop(code);throw Error(code);}
      if(!response||!Number.isInteger(response.status))fail('invalid_response');
      if(response.status!==200)throw Error('http_'+response.status);
      return analytics.normalize.winRate(await readJsonResponse(response,config.maxBytes),now());
    })();
    task.promise=Promise.race([operation,cancelled]).then(win=>{
      if(stopCode||controller.signal.aborted)throw Error(stopCode||'cancelled');
      const fetched=now(),validated=validWin(win,fetched);if(!validated)fail('invalid_response');
      accounts[address]={status:'ready',fetchedAt:iso(fetched),lastAttemptAt:attemptedAt,errorCode:null,win:validated};succeeded++;
    }).catch(error=>{failed++;markFailure(address,safeError(error),attemptedAt);}).finally(()=>{
      settled=true;clearTimer(timer);active.delete(address);
    });
  }
  if(!stopCode&&queue.length)batchTimer=setTimer(()=>stop('batch_timeout'),config.batchMs);
  try {
    while(queue.length||active.size) {
      if(!stopCode&&clock()-start>=config.batchMs)stop('batch_timeout');
      if(stopCode){if(active.size)await Promise.all([...active.values()].map(task=>task.promise));break;}
      while(ledger.length&&ledger[0]<=clock()-config.intervalMs)ledger.shift();
      while(queue.length&&active.size<config.concurrency&&(ledger.length+1)*config.requestWeight<=config.weightPerMinute&&!stopCode&&config.batchMs-(clock()-start)>=config.timeoutMs)launch(queue.shift());
      if(active.size){await Promise.race([...active.values()].map(task=>task.promise));continue;}
      if(queue.length){const remaining=config.batchMs-(clock()-start);if(remaining<config.timeoutMs){stop('batch_timeout');continue;}
        const wait=ledger.length?Math.max(1,ledger[0]+config.intervalMs-clock()):1;
        await sleep(Math.min(wait,remaining));}
    }
  }finally{if(batchTimer!==null)clearTimer(batchTimer);if(active.size){stop(stopCode||'cancelled');await Promise.all([...active.values()].map(task=>task.promise));}}
  for(const address of queue)markFailure(address,stopCode||'not_attempted',null);
  if(stopCode&&attempted===0)for(const address of addresses)markFailure(address,stopCode,null);
  const generatedAt=iso(now());
  for(const record of Object.values(accounts))if(record.fetchedAt&&now()-time(record.fetchedAt)>config.staleMs){record.status='stale';record.errorCode=record.errorCode||'cache_expired';}
  const available=Object.values(accounts).filter(record=>record.win!==null).length;
  return {schemaVersion:1,methodVersion:METHOD_VERSION,generatedAt,source:{id:'hyperliquid',endpoint:INFO,
    status:!addresses.length?'ready':failed||queue.length||stopCode?(available?'partial':'unavailable'):'ready',
    startedAt,completedAt:generatedAt,accounts:addresses.length,cached,attempted,succeeded,failed,unattempted:queue.length,
    available,stopCode,refreshIntervalMinutes:30,staleAfterMinutes:config.staleMs/60000,sampleLimit:2000,
    weightPerMinute:config.weightPerMinute,requestWeight:config.requestWeight,maxConcurrency:config.concurrency,maxBatchMinutes:config.batchMs/60000},accounts};
}
async function readFileJson(file, io=fs) {
  const stat=await io.stat(file);if(stat.size>LIMITS.maxFileBytes)fail('cache_file_too_large');
  const raw=await io.readFile(file,'utf8');if(Buffer.byteLength(raw)>LIMITS.maxFileBytes)fail('cache_file_too_large');
  return JSON.parse(raw);
}
async function atomicWrite(file,value,io=fs) {
  const raw=JSON.stringify(value)+'\n';if(Buffer.byteLength(raw)>LIMITS.maxFileBytes)fail('cache_file_too_large');
  await io.mkdir(path.dirname(file),{recursive:true});
  const temporary=file+'.tmp-'+process.pid+'-'+Math.random().toString(16).slice(2);
  try{await io.writeFile(temporary,raw,{encoding:'utf8',flag:'wx',mode:0o644});await io.rename(temporary,file);}
  finally{await io.unlink(temporary).catch(()=>{});}
}
async function main(args=process.argv.slice(2),dependencies={}) {
  const root=path.resolve(__dirname,'..');let feedPath=path.join(root,'trader/feed.json'),outputPath=path.join(root,'trader/analytics.json'),portfolioStatusPath=null;
  for(let i=0;i<args.length;i++){if(args[i]==='--feed'&&args[i+1])feedPath=path.resolve(args[++i]);else if(args[i]==='--output'&&args[i+1])outputPath=path.resolve(args[++i]);else if(args[i]==='--portfolio-status'&&args[i+1])portfolioStatusPath=path.resolve(args[++i]);else fail('invalid_arguments');}
  const io=dependencies.io||fs,feed=await readFileJson(feedPath,io);let previous=null;
  try{previous=await readFileJson(outputPath,io);}catch(error){if(!['ENOENT'].includes(error.code)&&!(error instanceof SyntaxError)&&error.message!=='cache_file_too_large')throw error;}
  let priorStopCode=null;
  if(portfolioStatusPath){
    const stat=await io.stat(portfolioStatusPath);if(stat.size>12*1024*1024)fail('invalid_portfolio_status');
    const raw=await io.readFile(portfolioStatusPath,'utf8');if(Buffer.byteLength(raw)>12*1024*1024)fail('invalid_portfolio_status');
    const status=JSON.parse(raw),generated=time(status.generatedAt),current=(dependencies.now||Date.now)();
    if(status.schemaVersion!==1||status.methodVersion!=='portfolio-periods-v1'||!plain(status.source)||status.source.id!=='hyperliquid'||!['ready','partial','unavailable'].includes(status.source.status)||!Object.hasOwn(status.source,'stopCode')||![null,'http_403','http_429','batch_timeout','cancelled'].includes(status.source.stopCode)||!Number.isFinite(generated)||generated>current+5000||current-generated>600000)fail('invalid_portfolio_status');
    if(['http_403','http_429'].includes(status.source.stopCode))priorStopCode=status.source.stopCode;
  }
  const result=await collect({feed,previous,...dependencies,priorStopCode});await atomicWrite(outputPath,result,io);
  (dependencies.log||console.log)(JSON.stringify(result.source));return result;
}
module.exports={collect,main,selectAccounts,validatedCache,validWin,readJsonResponse,atomicWrite,readFileJson,blockedByFeed,LIMITS,METHOD_VERSION};
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({status:'failed',errorCode:safeError(error)}));process.exitCode=1;});
