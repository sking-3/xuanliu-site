/* Read-only, foreground public account analytics. No keys, wallet or trading calls.
 * Drawdown mirrors Hyperliquid's portfolio UI PnL-peak/account-equity denominator,
 * with guards for missing/nonpositive denominators. It is NOT strategy NAV MDD.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksAccountAnalytics = api;
})(globalThis, function () {
'use strict';
const INFO = 'https://api.hyperliquid.xyz/info';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_BYTES = 5 * 1024 * 1024, CACHE_MS = 300000, MAX_RECORDS = 200;
const BUDGET = 400, INTERVAL = 60000, TIMEOUT = 12000;
const WEIGHTS = {portfolio:20, win:120};
const PERIODS = {week:'7D', month:'30D', allTime:'ALL'};
const sharedLedger = [];
const copy = value => JSON.parse(JSON.stringify(value));
const invalid = () => { throw Error('invalid_response'); };
const iso = value => new Date(value).toISOString();
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function list(value, max) { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function string(value, max=140) { if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(); return value; }
function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.length > 80 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) invalid();
  const n=Number(value); if (!Number.isFinite(n) || Math.abs(n)>=1e20) invalid(); return n;
}
function timestamp(value, now) { if (!Number.isSafeInteger(value) || value<0 || value>now+300000) invalid(); return value; }
function id(value) {
  if (typeof value==='number' && Number.isSafeInteger(value) && value>=0) return String(value);
  if (typeof value==='string' && /^\d{1,24}$/.test(value)) return value;
  return invalid();
}
function address(value) { if (typeof value!=='string' || !ADDRESS.test(value)) throw Error('invalid_address'); return value.toLowerCase(); }
function history(value, now) {
  let previous=-1;
  return list(value,20000).map(pair=>{
    if (!Array.isArray(pair) || pair.length!==2) invalid();
    const t=timestamp(pair[0],now), v=numeric(pair[1]);
    if (t<=previous) invalid(); previous=t; return [t,v];
  });
}
/* Preserve actual source points, both endpoints, and every bucket's extrema. */
function downsample(points, maximum=240) {
  if (!Number.isSafeInteger(maximum) || maximum<4) throw Error('invalid_limit');
  if (points.length<=maximum) return points.map(point=>({...point}));
  const buckets=Math.floor((maximum-2)/2), indexes=new Set([0,points.length-1]), count=points.length-2;
  for (let b=0;b<buckets;b++) {
    const first=1+Math.floor(b*count/buckets), end=1+Math.floor((b+1)*count/buckets);
    let min=first,max=first;
    for (let i=first+1;i<end;i++) { if(points[i].value<points[min].value)min=i; if(points[i].value>points[max].value)max=i; }
    indexes.add(min); indexes.add(max);
  }
  return [...indexes].sort((a,b)=>a-b).map(index=>({...points[index]}));
}
/* Hyperliquid UI utility Gce, exported as Mn in config-BOv79UVk.js:
 * peak starts at zero; drawdown=(peakPnL-currentPnL)/equityAtPeak.
 * Source reference: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/miscellaneous-ui
 * Exact timestamp alignment is checked rather than guessing across missing points.
 */
function sampledDrawdown(pnl, equity) {
  const unavailable=reason=>({value:null,reason,pairedSampleCount:0});
  if (pnl.length<2) return unavailable('insufficient_samples');
  if (!equity || equity.length!==pnl.length || pnl.some((point,i)=>point[0]!==equity[i][0])) return unavailable('unpaired_samples');
  let peak=0, denominator=0, maximum=0, comparisons=0, missingDenominator=false;
  for (let i=0;i<pnl.length;i++) {
    const current=pnl[i][1];
    if (denominator>0) { maximum=Math.max(maximum,(peak-current)/denominator); comparisons++; }
    else if (current<peak && i>0) missingDenominator=true;
    if (current>=peak) { peak=current; denominator=equity[i][1]; }
  }
  if (missingDenominator) return unavailable('non_positive_peak_equity');
  if (!comparisons) return unavailable('no_valid_peak');
  const value=maximum*100;
  if (!Number.isFinite(value)) return unavailable('invalid_denominator');
  return {value,reason:null,pairedSampleCount:pnl.length};
}
function portfolio(payload, now=Date.now()) {
  const windows={}, seen=new Set();
  for (const row of list(payload,32)) {
    if (!Array.isArray(row) || row.length!==2 || typeof row[0]!=='string') invalid();
    const key=Object.hasOwn(PERIODS,row[0])?PERIODS[row[0]]:null; if(!key)continue;
    if(seen.has(key))invalid(); seen.add(key);
    const raw=object(row[1]), pnl=history(raw.pnlHistory,now);
    const equity=raw.accountValueHistory===undefined?null:history(raw.accountValueHistory,now);
    const metric=sampledDrawdown(pnl,equity), baseline=pnl.length?pnl[0][1]:0;
    const points=pnl.map(([time,value])=>({time:iso(time),value:numeric(value-baseline)}));
    windows[key]={sourcePeriod:row[0],startAt:pnl.length?iso(pnl[0][0]):null,endAt:pnl.length?iso(pnl[pnl.length-1][0]):null,
      sampleCount:pnl.length,points:downsample(points),curveUnit:'USD',curveBasis:'pnl_change_from_first_sample',
      mdd:metric.value,mddUnavailableReason:metric.reason,mddPairedSampleCount:metric.pairedSampleCount,
      mddMethod:'hyperliquid_ui_pnl_peak_equity',mddUnit:'percent',scope:'all_account'};
  }
  return {windows};
}
function winRate(payload, now=Date.now()) {
  const rows=list(payload,2000), seen=new Map(), unique=[];
  for(const raw of rows) {
    object(raw);
    const r={coin:string(raw.coin,80),time:timestamp(raw.time,now),dir:string(raw.dir,80),side:raw.side,
      sz:numeric(raw.sz),startPosition:numeric(raw.startPosition),closedPnl:numeric(raw.closedPnl),fee:numeric(raw.fee),
      feeToken:string(raw.feeToken,40).trim(),tid:id(raw.tid),oid:id(raw.oid),hash:string(raw.hash,140)};
    if(!['A','B'].includes(r.side) || r.sz<=0)invalid();
    const key=[r.coin,r.time,r.tid,r.oid,r.hash].join('|'), encoded=JSON.stringify(r);
    if(seen.has(key)) { if(seen.get(key)!==encoded)invalid(); continue; }
    seen.set(key,encoded);unique.push(r);
  }
  let winning=0,losing=0,breakeven=0,excludedCount=0;
  const eligible=[];
  for(const r of unique) {
    const long=r.dir==='Close Long' && r.startPosition>0 && r.side==='A';
    const short=r.dir==='Close Short' && r.startPosition<0 && r.side==='B';
    const tolerance=Number.EPSILON*Math.max(Math.abs(r.startPosition),r.sz)*8;
    if(/[@/:]/.test(r.coin) || !(long||short) || r.feeToken!=='USDC' || r.sz>Math.abs(r.startPosition)+tolerance) { excludedCount++;continue; }
    const net=numeric(r.closedPnl-r.fee);
    if(net>0)winning++;else if(net<0)losing++;else breakeven++;
    eligible.push(r);
  }
  const bounds=items=>items.length?[iso(Math.min(...items.map(r=>r.time))),iso(Math.max(...items.map(r=>r.time)))]:[null,null];
  const [startAt,endAt]=bounds(eligible),[sourceSampleStartAt,sourceSampleEndAt]=bounds(unique);
  return {startAt,endAt,sourceSampleStartAt,sourceSampleEndAt,winning,losing,breakeven,eligibleCount:eligible.length,
    totalFills:unique.length,receivedFills:rows.length,duplicateCount:rows.length-unique.length,excludedCount,
    value:eligible.length?winning/eligible.length*100:null,unit:'percent',capped:rows.length===2000,historyComplete:false,
    method:'closing_fill_net_of_closing_fee',scope:'default_perp_dex',feeToken:'USDC',includesOpeningFees:false,includesFunding:false};
}
const ERROR_TEXT={invalid_response:'来源数据格式异常',response_too_large:'来源响应超过大小限制',invalid_content_type:'来源未返回行情数据',
  request_timeout:'账户数据请求超时',network_error:'暂时无法连接账户数据源',http_403:'数据源拒绝访问，可稍后手动重试',
  http_429:'数据源请求受限，请稍后手动重试',source_paused:'数据源请求已暂停，可手动重试',unavailable:'当前浏览器无法读取账户数据',
  target_inactive:'账户已离开当前页面',hidden:'页面暂不可见',cancelled:'请求已取消',destroyed:'账户数据服务已关闭'};
function blankSection(kind) { return {status:'idle',fetchedAt:null,attemptedAt:null,error:null,errorCode:null,...(kind==='portfolio'?{windows:{}}:{value:null,eligibleCount:0,totalFills:0})}; }
function create(options={}) {
  const fetcher=options.fetch || globalThis.fetch?.bind(globalThis), Controller=options.Controller || globalThis.AbortController;
  const now=options.now || Date.now, setTimer=options.setTimer || setTimeout, clearTimer=options.clearTimer || clearTimeout;
  const notify=options.onChange || (()=>{}), ledger=options.rateLedger || (options.now?[]:sharedLedger);
  const records=new Map(), jobs=new Map();
  let queue=[], active=new Set(), timer=null, visible=options.visible!==false, destroyed=false, targets=null, includeTargetWins=false, paused=null, pauseUntil=0;
  const emit=record=>{if(!destroyed)notify(copy(record));};
  function clearWake(){if(timer!==null){clearTimer(timer);timer=null;}}
  function recordFor(rawAddress) {
    const key=address(rawAddress);
    if(records.has(key)){const value=records.get(key);records.delete(key);records.set(key,value);return value;}
    while(records.size>=MAX_RECORDS) {
      const victim=[...records.keys()].find(a=>!jobs.has(a+':portfolio')&&!jobs.has(a+':win')) || records.keys().next().value;
      for(const kind of ['portfolio','win']) { const job=jobs.get(victim+':'+kind);if(job)cancel(job,'cancelled'); }
      records.delete(victim);
    }
    const record={address:key,portfolio:blankSection('portfolio'),win:blankSection('win')};records.set(key,record);return record;
  }
  function errorSection(record,kind,code) {
    record[kind]={...record[kind],status:'error',error:ERROR_TEXT[code] || '账户数据暂不可用',errorCode:code,
      retryAfterAt:pauseUntil>now()?iso(pauseUntil):null};emit(record);
  }
  function settle(job) {
    if(job.settled)return;job.settled=true;
    if(jobs.get(job.key)===job)jobs.delete(job.key);
    job.resolve(copy(job.record));
  }
  function cancel(job,reason='cancelled',asError=false) {
    if(job.cancelled||job.settled)return;job.cancelled=true;
    queue=queue.filter(item=>item!==job);active.delete(job);
    job.cancelRequest?.();
    if(asError)errorSection(job.record,job.kind,reason);
    else {const section=job.record[job.kind];section.status=section.fetchedAt?'ready':'idle';section.error=null;section.errorCode=null;emit(job.record);}
    settle(job);
  }
  function block(code,until,currentJob) {
    paused=code;pauseUntil=until||0;clearWake();
    for(const job of [...jobs.values()])if(job!==currentJob)cancel(job,code,true);
  }
  function pruneBudget(){const cutoff=now()-INTERVAL;for(let i=ledger.length-1;i>=0;i--)if(ledger[i].time<=cutoff)ledger.splice(i,1);}
  function retryTime(response) {
    const value=response.headers?.get?.('retry-after');if(!value)return 0;
    const seconds=Number(value), time=Number.isFinite(seconds)&&seconds>=0?now()+seconds*1000:Date.parse(value);
    return Number.isFinite(time)?Math.max(now(),Math.min(time,now()+86400000)):0;
  }
  async function readResponse(response) {
    const contentType=response.headers?.get?.('content-type') || '';
    if(!/(?:application|text)\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(contentType))throw Error('invalid_content_type');
    const declared=response.headers?.get?.('content-length');
    if(declared!==null&&declared!==undefined&&declared!==''&&Number(declared)>MAX_BYTES)throw Error('response_too_large');
    let text;
    if(response.body?.getReader) {
      const reader=response.body.getReader(), chunks=[];let length=0;
      try {
        for(;;) {const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array))invalid();length+=value.byteLength;if(length>MAX_BYTES)throw Error('response_too_large');chunks.push(value);}
        const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      } catch(error){try{await reader.cancel();}catch(_){}throw error;}
      finally {try{reader.releaseLock();}catch(_){}}
    } else {
      if(typeof response.text!=='function')invalid();text=await response.text();if(typeof text!=='string')invalid();
      if(new TextEncoder().encode(text).byteLength>MAX_BYTES)throw Error('response_too_large');
    }
    try{return JSON.parse(text);}catch(_){throw Error('invalid_response');}
  }
  async function request(job) {
    if(!fetcher||!Controller)throw Error('unavailable');
    const controller=new Controller();let timeout=null,rejectCancel;
    const cancelled=new Promise((_,reject)=>{rejectCancel=reject;});
    job.cancelRequest=()=>{controller.abort();rejectCancel(Error('cancelled'));};
    timeout=setTimer(()=>{controller.abort();rejectCancel(Error('request_timeout'));},TIMEOUT);
    const operation=(async()=>{
      const type=job.kind==='portfolio'?'portfolio':'userFills';
      const body={type,user:job.record.address};if(type==='userFills')body.aggregateByTime=false;
      let response;
      try {response=await fetcher(INFO,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});}
      catch(error){throw Error(job.cancelled?'cancelled':controller.signal.aborted?'request_timeout':'network_error');}
      if(job.cancelled)throw Error('cancelled');
      if(!response || typeof response.status!=='number')invalid();
      if(response.status<200||response.status>=300) {
        const code='http_'+response.status;
        if(response.status===403||response.status===429)block(code,response.status===429?retryTime(response):0,job);
        throw Error(code);
      }
      return readResponse(response);
    })();
    try{return await Promise.race([operation,cancelled]);}
    finally{clearTimer(timeout);job.cancelRequest=null;}
  }
  async function run(job) {
    active.add(job);job.record[job.kind]={...job.record[job.kind],status:'loading',attemptedAt:iso(now()),error:null,errorCode:null,retryAfterAt:null};emit(job.record);
    try {
      const payload=await request(job);
      if(job.cancelled||destroyed||!visible||jobs.get(job.key)!==job)return;
      const result=job.kind==='portfolio'?portfolio(payload,now()):winRate(payload,now());
      job.record[job.kind]={...result,status:'ready',fetchedAt:iso(now()),attemptedAt:job.record[job.kind].attemptedAt,error:null,errorCode:null,retryAfterAt:null};emit(job.record);
    } catch(error) {
      if(!job.cancelled&&!destroyed&&jobs.get(job.key)===job) {
        const message=typeof error?.message==='string'?error.message:'';
        const code=Object.hasOwn(ERROR_TEXT,message)||/^http_\d{3}$/.test(message)?message:'invalid_response';
        errorSection(job.record,job.kind,code);
      }
    } finally {active.delete(job);settle(job);pump();}
  }
  function pump() {
    clearWake();if(destroyed||!visible||paused)return;
    pruneBudget();
    while(active.size<2&&queue.length) {
      const spent=ledger.reduce((total,entry)=>total+entry.weight,0);
      const index=queue.findIndex(job=>spent+WEIGHTS[job.kind]<=BUDGET);
      if(index<0)break;
      const [job]=queue.splice(index,1);ledger.push({time:now(),weight:WEIGHTS[job.kind]});void run(job);
    }
    if(queue.length&&active.size<2&&ledger.length)timer=setTimer(()=>{timer=null;pump();},Math.max(1,Math.min(...ledger.map(entry=>entry.time))+INTERVAL-now()));
  }
  function ensure(rawAddress,kind,settings={}) {
    const record=recordFor(rawAddress), key=record.address+':'+kind, existing=jobs.get(key), section=record[kind];
    if(existing)return existing.promise;
    if(destroyed)return Promise.resolve(copy(record));
    if(!visible || (targets&&(kind==='portfolio'||includeTargetWins)&&!targets.has(record.address)&&!settings.force))return Promise.resolve(copy(record));
    const age=section.fetchedAt?now()-Date.parse(section.fetchedAt):Infinity;
    if(!settings.force&&section.status==='ready'&&age>=0&&age<CACHE_MS)return Promise.resolve(copy(record));
    if(!settings.force&&section.status==='error')return Promise.resolve(copy(record));
    if(paused) {
      if(!settings.force||now()<pauseUntil){errorSection(record,kind,paused);return Promise.resolve(copy(record));}
      paused=null;pauseUntil=0;
    }
    let resolve;const promise=new Promise(done=>{resolve=done;});
    const job={key,record,kind,promise,resolve,cancelled:false,settled:false,cancelRequest:null};
    jobs.set(key,job);queue.push(job);section.status='queued';section.error=null;section.errorCode=null;emit(record);pump();return promise;
  }
  function resumeTargets() {
    if(!targets)return;
    // Queue the inexpensive curves first, then closing-fill samples under the same budget.
    for(const account of targets)void ensure(account,'portfolio');
    if(includeTargetWins)for(const account of targets)void ensure(account,'win');
  }
  function updateTargets(accounts,includeWins) {
    if(!Array.isArray(accounts)||accounts.length>12)throw Error('invalid_targets');
    if(destroyed)return;
    const manageWins=includeTargetWins||includeWins;
    targets=new Set(accounts.map(address));includeTargetWins=includeWins;
    for(const job of [...jobs.values()])if((job.kind==='portfolio'||manageWins)&&!targets.has(job.record.address))cancel(job,'target_inactive');
    if(includeWins)resumeTargets();pump();
  }
  return {
    ensurePortfolio:(account,settings)=>ensure(account,'portfolio',settings),
    ensureWinRate:(account,settings)=>ensure(account,'win',settings),
    get:account=>copy(recordFor(account)),
    // Current visible page, at most 12 accounts. Both metrics load automatically.
    setTargets:accounts=>updateTargets(accounts,true),
    // Compatibility for older callers that explicitly request only portfolio data.
    setPortfolioTargets:accounts=>updateTargets(accounts,false),
    setVisible(value) {
      if(destroyed)return;visible=!!value;
      if(!visible){clearWake();for(const job of [...jobs.values()])cancel(job,'hidden');}
      else{resumeTargets();pump();}
    },
    destroy() {if(destroyed)return;destroyed=true;clearWake();for(const job of [...jobs.values()])cancel(job,'destroyed');queue=[];records.clear();targets=null;},
  };
}
return {create,normalize:{portfolio,winRate,sampledDrawdown},downsample,endpoints:{info:INFO},limits:{maxBytes:MAX_BYTES,cacheMs:CACHE_MS,maxRecords:MAX_RECORDS,weightPerMinute:BUDGET,timeoutMs:TIMEOUT,weights:{...WEIGHTS}}};
});
