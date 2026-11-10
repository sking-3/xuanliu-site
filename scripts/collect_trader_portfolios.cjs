#!/usr/bin/env node
'use strict';
/* Public, read-only portfolio windows. Raw responses are never written to disk.
 * Financial metrics use full source samples; charts retain at most 120 actual points.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const analytics = require('../trader/account-analytics.js');
const periodROI = require('../trader/period-roi.js');
const shared = require('./collect_trader_analytics.cjs');
const INFO = 'https://api.hyperliquid.xyz/info';
const METHOD_VERSION = 'portfolio-periods-v2';
const LIMITS = Object.freeze({maxAccounts:200,weightPerMinute:600,requestWeight:20,ledgerRequestWeight:120,ledgerPages:10,ledgerRows:20000,intervalMs:60000,
  concurrency:2,timeoutMs:10000,batchMs:7*60000,freshMs:30*60000,staleMs:60*60000,
  maxBytes:5*1024*1024,maxFileBytes:12*1024*1024,maxPoints:120});
const PERIODS={"7D":'perpWeek',"30D":'perpMonth',"90D":'perpAllTime',"180D":'perpAllTime',"365D":'perpAllTime',ALL:'perpAllTime'};
const DAYS={"90D":90,"180D":180,"365D":365};
const MDD_REASONS=new Set(['insufficient_samples','unpaired_samples','non_positive_peak_equity','no_valid_peak','invalid_denominator']);
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
function failureReport(error) {
  return {status:'failed',errorCode:error?.message==='migration_no_verified_portfolios'?'migration_no_verified_portfolios':safeError(error)};
}
const blockedByFeed=shared.blockedByFeed;
const selectAccounts=shared.selectAccounts;
function validPortfolio(raw, fetchedAt, accountId) {
  if(!plain(raw)||!plain(raw.windows)||Object.keys(raw.windows).length===0||Object.keys(raw.windows).length>6)return null;
  const windows={};
  const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<1e20;
  const close=(a,b)=>Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
  for(const [key,w] of Object.entries(raw.windows)) {
    if(!Object.hasOwn(PERIODS,key)||!plain(w)||w.sourcePeriod!==PERIODS[key]||w.curveUnit!=='USD'||
      w.curveBasis!=='pnl_change_from_first_sample'||w.scope!=='perp_account'||w.mddMethod!==(Object.hasOwn(DAYS,key)?'window_pnl_peak_equity':'hyperliquid_ui_pnl_peak_equity')||w.mddUnit!=='percent')return null;
    const derived=Object.hasOwn(DAYS,key),days=derived?DAYS[key]:null;
    if(w.derived!==derived||w.requestedDays!==days)return null;
    for(const name of ['sampleCount','sourceSampleCount','mddPairedSampleCount'])if(!Number.isSafeInteger(w[name])||w[name]<0||w[name]>20000)return null;
    if(w.sampleCount>w.sourceSampleCount||w.mddPairedSampleCount>w.sampleCount||!Array.isArray(w.points)||w.points.length>LIMITS.maxPoints||w.points.length>w.sampleCount)return null;
    for(const name of ['startAt','endAt','sourceHistoryStartAt','sourceHistoryEndAt','requestedStartAt','requestedEndAt'])
      if(w[name]!==null&&(!Number.isFinite(time(w[name]))||time(w[name])>fetchedAt+5000))return null;
    if(w.sourceSampleCount===0?(w.sourceHistoryStartAt!==null||w.sourceHistoryEndAt!==null):(w.sourceHistoryStartAt===null||w.sourceHistoryEndAt===null||time(w.sourceHistoryStartAt)>time(w.sourceHistoryEndAt)))return null;
    if(w.sourceSampleCount===1&&w.sourceHistoryStartAt!==w.sourceHistoryEndAt)return null;
    if(w.sourceSampleCount>1&&time(w.sourceHistoryStartAt)>=time(w.sourceHistoryEndAt))return null;
    if(w.sampleCount===0?(w.startAt!==null||w.endAt!==null||w.points.length!==0):(w.startAt===null||w.endAt===null||w.points.length===0||time(w.startAt)>time(w.endAt)||time(w.startAt)<time(w.sourceHistoryStartAt)||w.endAt!==w.sourceHistoryEndAt))return null;
    if(!finite(w.coverageDays)||w.coverageDays<0)return null;
    const coverage=w.sampleCount?(time(w.endAt)-time(w.startAt))/86400000:0;
    if(w.coverageDays!==null&&!close(w.coverageDays,coverage))return null;
    if(w.maxSampleGapMs!==null&&(!Number.isSafeInteger(w.maxSampleGapMs)||w.maxSampleGapMs<0))return null;
    if(w.sampleCount>=2&&(w.coverageDays===null||w.maxSampleGapMs===null||w.maxSampleGapMs<=0||w.maxSampleGapMs>time(w.endAt)-time(w.startAt)))return null;
    if(w.sampleCount<2&&w.maxSampleGapMs!==null)return null;
    if(w.mdd===null){if(!MDD_REASONS.has(w.mddUnavailableReason)||w.mddPairedSampleCount!==0)return null;}
    else if(!finite(w.mdd)||w.mdd<0||w.mddUnavailableReason!==null||w.sampleCount<2||w.mddPairedSampleCount!==w.sampleCount)return null;
    if(w.sampleCount<2?w.pnl!==null:!finite(w.pnl))return null;
    let previous=-1;const points=[];
    for(const point of w.points) {
      if(!plain(point)||!finite(point.value)||!Number.isFinite(time(point.time))||time(point.time)<=previous||time(point.time)<time(w.startAt)||time(point.time)>time(w.endAt))return null;
      previous=time(point.time);points.push({time:point.time,value:point.value});
    }
    if(w.sampleCount&&(points[0].time!==w.startAt||points.at(-1).time!==w.endAt||points[0].value!==0))return null;
    if(w.sampleCount>=2&&!close(points.at(-1).value,w.pnl))return null;
    if(w.sampleCount>=2&&points.length===w.sampleCount){let gap=0;for(let i=1;i<points.length;i++)gap=Math.max(gap,time(points[i].time)-time(points[i-1].time));if(w.maxSampleGapMs!==gap)return null;}
    let roiFields={};
    if(derived) {
      try{roiFields=periodROI.validateWindow(w,accountId,fetchedAt);}catch(_){return null;}
      if(w.sourceSampleCount) {
        if(w.requestedEndAt!==w.sourceHistoryEndAt||time(w.requestedStartAt)!==time(w.requestedEndAt)-days*86400000||!w.sampleCount||time(w.startAt)<time(w.requestedStartAt))return null;
        const expected=time(w.sourceHistoryStartAt)>time(w.requestedStartAt)?'insufficient_history':w.startAt===w.requestedStartAt?'full':'sampled_boundary';
        if(w.coverageStatus!==expected)return null;
      }else if(w.requestedStartAt!==null||w.requestedEndAt!==null||w.coverageStatus!=='insufficient_history')return null;
    }else if(w.coverageStatus!=='source_window'||w.sourceSampleCount!==w.sampleCount||w.sourceHistoryStartAt!==w.startAt||w.sourceHistoryEndAt!==w.endAt||w.requestedStartAt!==null||w.requestedEndAt!==w.endAt||Object.hasOwn(w,'roi'))return null;
    windows[key]={sourcePeriod:w.sourcePeriod,startAt:w.startAt,endAt:w.endAt,sampleCount:w.sampleCount,points,
      curveUnit:'USD',curveBasis:'pnl_change_from_first_sample',mdd:w.mdd,mddUnavailableReason:w.mddUnavailableReason,
      mddPairedSampleCount:w.mddPairedSampleCount,mddMethod:w.mddMethod,mddUnit:'percent',scope:'perp_account',pnl:w.pnl,
      derived,requestedDays:days,requestedStartAt:w.requestedStartAt,requestedEndAt:w.requestedEndAt,
      coverageDays:w.coverageDays,coverageStatus:w.coverageStatus,sourceHistoryStartAt:w.sourceHistoryStartAt,
      sourceHistoryEndAt:w.sourceHistoryEndAt,sourceSampleCount:w.sourceSampleCount,maxSampleGapMs:w.maxSampleGapMs,
      ...roiFields};
  }
  return {windows};
}
function compactPortfolio(portfolio) {
  if(!plain(portfolio)||!plain(portfolio.windows))fail('invalid_response');
  return {windows:Object.fromEntries(Object.entries(portfolio.windows).map(([key,w])=>[key,{...w,points:analytics.downsample(w.points,LIMITS.maxPoints)}]))};
}
function validatedCache(previous, addresses, now=Date.now()) {
  const result={};
  if(!plain(previous)||previous.schemaVersion!==1||previous.methodVersion!==METHOD_VERSION||!plain(previous.accounts)||
    Object.keys(previous.accounts).length>LIMITS.maxAccounts||!Number.isFinite(time(previous.generatedAt))||time(previous.generatedAt)>now+5000)return result;
  for(const address of addresses) {
    const raw=Object.hasOwn(previous.accounts,address)?previous.accounts[address]:null;
    if(!plain(raw)||!['ready','stale','unavailable'].includes(raw.status))continue;
    const cachedError=raw.errorCode??null;
    if(cachedError!==null&&(typeof cachedError!=='string'||safeError({message:cachedError})!==cachedError))continue;
    if(raw.status==='unavailable') {
      const attempt=time(raw.lastAttemptAt);
      if(raw.portfolio!==null||raw.fetchedAt!==null||raw.lastAttemptAt!==null&&(!Number.isFinite(attempt)||attempt>time(previous.generatedAt)+5000||attempt>now+5000))continue;
      result[address]={status:'unavailable',fetchedAt:null,lastAttemptAt:raw.lastAttemptAt===null?null:iso(attempt),errorCode:cachedError,portfolio:null};
      continue;
    }
    const fetched=time(raw.fetchedAt);
    if(!Number.isFinite(fetched)||fetched>time(previous.generatedAt)+5000||fetched>now+5000)continue;
    const portfolio=validPortfolio(raw.portfolio,fetched,address);if(!portfolio)continue;
    const attempt=time(raw.lastAttemptAt);
    result[address]={status:raw.status==='stale'||cachedError||now-fetched>LIMITS.staleMs?'stale':'ready',fetchedAt:iso(fetched),
      lastAttemptAt:Number.isFinite(attempt)&&attempt<=time(previous.generatedAt)+5000?iso(attempt):iso(fetched),
      errorCode:cachedError,portfolio};
  }
  return result;
}
const readJsonResponse=shared.readJsonResponse;
function blank(){return {status:'unavailable',fetchedAt:null,lastAttemptAt:null,errorCode:null,portfolio:null};}
function ledgerRanges(portfolio) {
  const windows=Object.entries(portfolio.windows).filter(([key,w])=>Object.hasOwn(DAYS,key)&&w.sampleCount>=2&&w.coverageStatus!=='insufficient_history').map(([,w])=>w);
  if(!windows.length)return [];
  const starts=[...new Set(windows.map(w=>time(w.startAt)))].sort((a,b)=>b-a);
  return starts.map((start,i)=>({start,end:i?starts[i-1]:Math.max(...windows.map(w=>time(w.endAt)))}));
}
function stableJSON(value) {
  if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';
  if(plain(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableJSON(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
async function readLedger(request,address,range,now,budget) {
  const rows=[],seen=new Set();let cursor=range.start;
  while(budget.pageCount<LIMITS.ledgerPages) {
    budget.pageCount++;
    const batch=await request({type:'userNonFundingLedgerUpdates',user:address,startTime:cursor,endTime:range.end},LIMITS.ledgerRequestWeight);
    if(!Array.isArray(batch)||batch.length>2000)fail('invalid_response');
    let previous=cursor,added=0;
    for(const row of batch) {
      if(!plain(row)||!plain(row.delta)||typeof row.delta.type!=='string'||typeof row.hash!=='string'||!Number.isSafeInteger(row.time)||row.time<cursor||row.time>range.end||row.time<previous)fail('invalid_response');
      previous=row.time;const key=stableJSON(row);
      if(!seen.has(key)){seen.add(key);rows.push(row);added++;budget.keys.add(key);if(budget.keys.size>LIMITS.ledgerRows)fail('invalid_response');}
    }
    // A short first page is not proof of complete history. Verify its inclusive
    // tail with a second request; bounded API traversal is not full-history proof.
    if(!batch.length||!added&&batch.length<500&&previous===cursor)
      return {rows,queryStartAt:range.start,queryEndAt:range.end,fetchedAt:iso(now()),pageCount:budget.pageCount,exhausted:true};
    if(previous===cursor&&batch.length>=500)fail('invalid_response');
    if(!added&&previous===cursor)fail('invalid_response');
    cursor=previous;
  }
  fail('invalid_response');
}
async function collect({feed,previous=null,fetch:fetcher=globalThis.fetch,now=Date.now,clock=()=>performance.now(),
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
    // Failed or slow ledgers must rotate behind accounts that have not received
    // an attempt. Keep genuine source freshness independent of attempt order.
    .sort((a,b)=>Math.max(time(accounts[a].fetchedAt)||0,time(accounts[a].lastAttemptAt)||0)-Math.max(time(accounts[b].fetchedAt)||0,time(accounts[b].lastAttemptAt)||0));
  const cached=addresses.length-queue.length,active=new Map(),ledger=[],requests=[],inflight=new Set();
  let attempted=0,succeeded=0,failed=0,ledgerRequests=0,requestCount=0,stopCode=blockedByFeed(feed),batchTimer=null,wakeResolve=null;
  const wake=()=>{const resolve=wakeResolve;wakeResolve=null;if(resolve)resolve();};
  const stop=code=>{
    if(!stopCode)stopCode=code;
    for(const task of active.values())task.cancel(stopCode);
    wake();
  };
  const markFailure=(address,code,attemptedAt)=>{
    const record=accounts[address];record.status=record.portfolio?'stale':'unavailable';
    if(attemptedAt)record.lastAttemptAt=attemptedAt;record.errorCode=code;
  };
  function launch(address) {
    const attemptedAt=iso(now()),controller=new AbortController();let rejectCancel,settled=false;
    let basePortfolio=null,baseFetchedAt=null,verifiedAt=null;const verifiedWindows=new Set();
    const cancelled=new Promise((_,reject)=>{rejectCancel=reject;});
    const task={controller,cancelled,cancel:code=>{if(settled||controller.signal.aborted)return;controller.abort();rejectCancel(Error(code));wake();},promise:null};
    accounts[address].lastAttemptAt=attemptedAt;attempted++;active.set(address,task);
    const request=(body,weight)=>{
      if(stopCode||controller.signal.aborted)return Promise.reject(Error(stopCode||'cancelled'));
      if(weight>config.weightPerMinute)return Promise.reject(Error('invalid_response'));
      return new Promise((resolve,reject)=>{requests.push({body,weight,task,resolve,reject});wake();});
    };
    const operation=(async()=>{
      const raw=await request({type:'portfolio',user:address},config.requestWeight),portfolio=analytics.normalize.portfolio(raw,now());
      baseFetchedAt=iso(now());verifiedAt=baseFetchedAt;basePortfolio=portfolio;
      const missing=periodROI.calculate(raw,null,address,now());
      for(const key of Object.keys(DAYS))if(portfolio.windows[key]&&missing[key])Object.assign(portfolio.windows[key],missing[key]);
      const ranges=ledgerRanges(portfolio),budget={pageCount:0,keys:new Set()},merged=new Map();
      for(const range of ranges){
        const segment=await readLedger(request,address,range,now,budget);
        for(const row of segment.rows)merged.set(stableJSON(row),row);
        const events={...segment,rows:[...merged.values()].sort((a,b)=>a.time-b.time),queryEndAt:ranges[0].end};
        const values=periodROI.calculate(raw,events,address,now());
        // Earlier extensions cannot invalidate a separately verified shorter
        // window. Each published value retains its own ledger evidence/time.
        for(const key of Object.keys(DAYS))if(portfolio.windows[key]&&!verifiedWindows.has(key)&&time(portfolio.windows[key].startAt)>=range.start&&values[key]){
          Object.assign(portfolio.windows[key],values[key]);verifiedWindows.add(key);
        }
        verifiedAt=iso(now());
      }
      return portfolio;
    })();
    task.promise=Promise.race([operation,cancelled]).then(portfolio=>{
      if(stopCode||controller.signal.aborted)throw Error(stopCode||'cancelled');
      const fetched=now(),validated=validPortfolio(compactPortfolio(portfolio),fetched,address);if(!validated)fail('invalid_response');
      accounts[address]={status:'ready',fetchedAt:iso(fetched),lastAttemptAt:attemptedAt,errorCode:null,portfolio:validated};succeeded++;
    }).catch(error=>{
      const code=safeError(error),prior=accounts[address];failed++;
      // A bounded ledger failure must not discard a verified base curve on a
      // cold account. Retain a whole old record when it has a proven ROI, and
      // never publish new data after a source rejection. Collection time is
      // the last successful portfolio/ledger proof, never the later failure.
      if(basePortfolio&&!['http_403','http_429'].includes(stopCode||code)&&!Object.values(prior.portfolio?.windows||{}).some(w=>Number.isFinite(w.roi))) {
        for(const key of Object.keys(DAYS))if(basePortfolio.windows[key]&&!verifiedWindows.has(key))Object.assign(basePortfolio.windows[key],{roi:null,roiUnavailableReason:basePortfolio.windows[key].coverageStatus==='insufficient_history'?'insufficient_history':'ledger_unavailable',roiEvidence:null});
        const valid=validPortfolio(compactPortfolio(basePortfolio),time(verifiedAt),address);
        if(valid)accounts[address]={status:'stale',fetchedAt:verifiedAt,lastAttemptAt:attemptedAt,errorCode:code,portfolio:valid};
      }
      markFailure(address,code,attemptedAt);
    }).finally(()=>{
      settled=true;active.delete(address);wake();
    });
  }
  function begin(request) {
    const {task,body,weight}=request;
    ledger.push({at:clock(),weight});requestCount++;if(body.type==='userNonFundingLedgerUpdates')ledgerRequests++;
    inflight.add(request);
    const timer=setTimer(()=>task.cancel('request_timeout'),config.timeoutMs);
    const operation=(async()=>{
      let response;
      try{response=await fetcher(INFO,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body),credentials:'omit',redirect:'error',cache:'no-store',signal:task.controller.signal});}
      catch(error){if(task.controller.signal.aborted)throw error;throw Error('network_error');}
      if(task.controller.signal.aborted)throw Error(stopCode||'cancelled');
      if(response?.status===403||response?.status===429){const code='http_'+response.status;stop(code);throw Error(code);}
      if(!response||!Number.isInteger(response.status))fail('invalid_response');
      if(response.status!==200)throw Error('http_'+response.status);
      return readJsonResponse(response,config.maxBytes);
    })();
    Promise.race([operation,task.cancelled]).then(request.resolve,request.reject).finally(()=>{clearTimer(timer);inflight.delete(request);wake();});
  }
  const usedWeight=()=>ledger.reduce((sum,r)=>sum+r.weight,0);
  if(!stopCode&&queue.length)batchTimer=setTimer(()=>stop('batch_timeout'),config.batchMs);
  try {
    while(queue.length||active.size) {
      if(!stopCode&&clock()-start>=config.batchMs)stop('batch_timeout');
      if(stopCode){if(active.size)await Promise.all([...active.values()].map(task=>task.promise));break;}
      while(ledger.length&&ledger[0].at<=clock()-config.intervalMs)ledger.shift();
      for(let i=requests.length-1;i>=0;i--)if(requests[i].task.controller.signal.aborted){requests[i].reject(Error(stopCode||'cancelled'));requests.splice(i,1);}
      while(queue.length&&active.size<config.concurrency&&usedWeight()+requests.reduce((sum,r)=>sum+r.weight,0)+config.requestWeight<=config.weightPerMinute&&!stopCode&&config.batchMs-(clock()-start)>=config.timeoutMs)launch(queue.shift());
      while(requests.length&&!stopCode&&inflight.size<config.concurrency&&usedWeight()+requests[0].weight<=config.weightPerMinute&&config.batchMs-(clock()-start)>=config.timeoutMs)begin(requests.shift());
      if(active.size){
        if(requests.length&&config.batchMs-(clock()-start)<config.timeoutMs){stop('batch_timeout');continue;}
        let budgetTimer=null;const notified=new Promise(resolve=>{wakeResolve=resolve;});
        if(requests.length&&usedWeight()+requests[0].weight>config.weightPerMinute){
          const wait=ledger.length?Math.max(1,ledger[0].at+config.intervalMs-clock()):config.batchMs;
          budgetTimer=setTimer(wake,Math.min(wait,Math.max(1,config.batchMs-(clock()-start))));
        }
        await Promise.race([...active.values()].map(task=>task.promise).concat(notified));
        if(budgetTimer!==null)clearTimer(budgetTimer);wakeResolve=null;continue;
      }
      if(queue.length){const remaining=config.batchMs-(clock()-start);if(remaining<config.timeoutMs){stop('batch_timeout');continue;}
        const wait=ledger.length?Math.max(1,ledger[0].at+config.intervalMs-clock()):1;
        await sleep(Math.min(wait,remaining));}
    }
  }finally{if(batchTimer!==null)clearTimer(batchTimer);if(active.size){stop(stopCode||'cancelled');await Promise.all([...active.values()].map(task=>task.promise));}for(const request of requests.splice(0))request.reject(Error(stopCode||'cancelled'));}
  for(const address of queue)markFailure(address,stopCode||'not_attempted',null);
  if(stopCode&&attempted===0)for(const address of addresses)markFailure(address,stopCode,null);
  const generatedAt=iso(now());
  for(const record of Object.values(accounts))if(record.fetchedAt&&now()-time(record.fetchedAt)>config.staleMs){record.status='stale';record.errorCode=record.errorCode||'cache_expired';}
  const available=Object.values(accounts).filter(record=>record.portfolio!==null).length;
  return {schemaVersion:1,methodVersion:METHOD_VERSION,generatedAt,source:{id:'hyperliquid',endpoint:INFO,
    status:!addresses.length?'ready':failed||queue.length||stopCode?(available?'partial':'unavailable'):'ready',
    startedAt,completedAt:generatedAt,accounts:addresses.length,cached,attempted,succeeded,failed,unattempted:queue.length,
    available,stopCode,refreshIntervalMinutes:360,staleAfterMinutes:config.staleMs/60000,sourceSampleLimit:20000,maxChartPoints:LIMITS.maxPoints,
    weightPerMinute:config.weightPerMinute,requestWeight:config.requestWeight,ledgerRequestWeight:LIMITS.ledgerRequestWeight,requestCount,ledgerRequests,
    roiAccounts:Object.values(accounts).filter(r=>Object.values(r.portfolio?.windows||{}).some(w=>Number.isFinite(w.roi))).length,
    maxConcurrency:config.concurrency,maxBatchMinutes:config.batchMs/60000},accounts};
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
  const root=path.resolve(__dirname,'..');let feedPath=path.join(root,'trader/feed.json'),outputPath=path.join(root,'trader/portfolios.json');
  for(let i=0;i<args.length;i++){if(args[i]==='--feed'&&args[i+1])feedPath=path.resolve(args[++i]);else if(args[i]==='--output'&&args[i+1])outputPath=path.resolve(args[++i]);else fail('invalid_arguments');}
  const io=dependencies.io||fs,feed=await readFileJson(feedPath,io);let previous=null;
  try{previous=await readFileJson(outputPath,io);}catch(error){if(!['ENOENT'].includes(error.code)&&!(error instanceof SyntaxError)&&error.message!=='cache_file_too_large')throw error;}
  const result=await collect({feed,previous,...dependencies});
  // A failed scope migration must not replace a live legacy snapshot with an empty v2 file.
  // Keep the previous file byte-for-byte and stop the workflow before later API stages.
  if(plain(previous)&&previous.methodVersion!==METHOD_VERSION&&result.source.accounts>0&&result.source.available===0)
    fail('migration_no_verified_portfolios');
  await atomicWrite(outputPath,result,io);
  (dependencies.log||console.log)(JSON.stringify(result.source));return result;
}
module.exports={collect,main,selectAccounts,validatedCache,validPortfolio,compactPortfolio,readJsonResponse,atomicWrite,readFileJson,blockedByFeed,failureReport,LIMITS,METHOD_VERSION};
if(require.main===module)main().catch(error=>{console.error(JSON.stringify(failureReport(error)));process.exitCode=1;});
