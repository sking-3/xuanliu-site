/* Paired official all-account equity/PnL and public cash events. Interval Modified
 * Dietz is an estimate when cash flows occur between source samples, never an
 * official ROI or an exact intra-interval time-weighted return. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./period-roi.js'):root.BooksPeriodROI);if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksStrategyAnalytics=api;})(globalThis,function(ROI){
'use strict';
const INFO='https://api.hyperliquid.xyz/info',DAY=86400000,MAX_ROWS=20000;
const PERIODS={'1D':1,'7D':7,'30D':30,'90D':90,'180D':180,'365D':365,ALL:null};
const cache=new Map(),budget=[];
const fail=code=>{throw Error(code);},plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const iso=x=>new Date(x).toISOString();
function num(x){if(typeof x!=='number'&&(typeof x!=='string'||x.length>80||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(x)))fail('invalid_response');const n=Number(x);if(!Number.isFinite(n)||Math.abs(n)>=1e14)fail('invalid_response');return n;}
function address(x){if(typeof x!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(x))fail('invalid_address');return x.toLowerCase();}
function series(x,now){if(!Array.isArray(x)||x.length>MAX_ROWS)fail('invalid_response');let prev=-1;return x.map(p=>{if(!Array.isArray(p)||p.length!==2||!Number.isSafeInteger(p[0])||p[0]<=prev||p[0]>now+300000||p[0]<0)fail('invalid_response');prev=p[0];return [p[0],num(p[1])];});}
function source(raw,period,now){
 if(!Object.hasOwn(PERIODS,period)||!Array.isArray(raw)||raw.length>32)fail('invalid_response');
 const native=({'1D':'day','7D':'week','30D':'month'})[period],key=native||'allTime',rows=raw.filter(r=>Array.isArray(r)&&r[0]===key);
 if(rows.length!==1||rows[0].length!==2||!plain(rows[0][1]))fail('invalid_response');
 const all=series(rows[0][1].pnlHistory,now),equity=series(rows[0][1].accountValueHistory,now),end=all.at(-1)?.[0];
 const cutoff=PERIODS[period]===null||end===undefined?null:end-PERIODS[period]*DAY;
 const pnl=cutoff===null||native?all:all.filter(p=>p[0]>=cutoff),start=pnl[0]?.[0];
 return {pnl,equity:equity.filter(p=>start!==undefined&&p[0]>=start&&p[0]<=end),sourcePeriod:key,historyStartAt:all[0]?iso(all[0][0]):null,requestedStartAt:cutoff===null?null:iso(cutoff),coverageSufficient:!!native||cutoff===null||!!all.length&&all[0][0]<=cutoff};
}
function allAccountFlow(row,user){
 const d=row.delta;
 try{
  if(d.type==='accountClassTransfer'){if(typeof d.toPerp!=='boolean'||num(d.usdc)<0)return {error:'invalid_ledger_event'};return {value:0};}
  if(d.type==='send'||d.type==='spotTransfer'){
   const from=address(d.user),to=address(d.destination);if(from!==user&&to!==user)return {error:'invalid_ledger_event'};
   if(from===to)return {value:0};
   if(typeof d.token!=='string'||!d.token)return {error:'invalid_ledger_event'};
   const amount=d.usdcValue!==undefined?num(d.usdcValue):d.token==='USDC'?num(d.amount):null;
   if(amount===null)return {error:'unknown_ledger_event'};if(amount<0)return {error:'invalid_ledger_event'};
   return {value:(to===user?amount:0)-(from===user?amount:0)};
  }
  return ROI.normalizeFlow(row,user);
 }catch(_){return {error:'invalid_ledger_event'};}
}
function calculate(raw,ledger,accountId,period='30D',now=Date.now()){
 const user=address(accountId),s=source(raw,period,now),p=s.pnl,e=s.equity,start=p[0]?.[0],end=p.at(-1)?.[0];
 const summary={startEquity:null,endEquity:null,pnl:p.length>1?p.at(-1)[1]-p[0][1]:null,balanceChangePct:null,deposits:null,withdrawals:null,netFlow:null,fees:null,strategyReturnPct:null,sampledMddPct:null,sampleCount:p.length,maxGapMs:null,startAt:start===undefined?null:iso(start),endAt:end===undefined?null:iso(end),reconciliationError:null};
 const result={schemaVersion:1,accountId:user,period,scope:'all_account',currency:'USD',fetchedAt:iso(now),status:'partial',reason:null,summary,points:[],cashflows:[],method:'sample_interval_modified_dietz',historyComplete:false,sourcePeriod:s.sourcePeriod,historyStartAt:s.historyStartAt,requestedStartAt:s.requestedStartAt};
 const partial=reason=>{result.reason=reason;return result;};
 if(p.length<2)return partial('insufficient_samples');
 if(e.length!==p.length||p.some((r,i)=>r[0]!==e[i][0]))return partial('unpaired_samples');
 summary.startEquity=e[0][1];summary.endEquity=e.at(-1)[1];summary.balanceChangePct=e[0][1]>0?100*(e.at(-1)[1]/e[0][1]-1):null;
 result.points=p.map((r,i)=>({time:iso(r[0]),equity:e[i][1],pnl:r[1]-p[0][1],strategyReturnPct:null}));
 summary.maxGapMs=Math.max(...p.slice(1).map((r,i)=>r[0]-p[i][0]));
 const l=ROI.normalizeLedger(ledger,now);if(l.error)return partial(l.error);
 if(l.start>start||l.end<end)return partial('ledger_incomplete');
 const events=[];let deposits=0,withdrawals=0,fees=0;
 for(const row of l.rows.filter(r=>r.time>=start&&r.time<=end)){
  const f=allAccountFlow(row,user);if(f.error)return partial(f.error);
  if((row.time===start||row.time===end)&&f.value!==0)return partial('ambiguous_ledger_order');
  if(f.value===0)continue;
  const fee=row.delta.fee===undefined?null:num(row.delta.fee),feeToken=row.delta.type==='withdraw'?'USDC':typeof row.delta.feeToken==='string'&&row.delta.feeToken?row.delta.feeToken:null;
  if(f.value>0)deposits+=f.value;else withdrawals-=f.value;
  if(fee!==null&&feeToken==='USDC')fees+=fee;
  events.push({time:iso(row.time),type:row.delta.type,value:f.value,fee,feeToken,hash:row.hash});
 }
 result.cashflows=events;summary.deposits=deposits;summary.withdrawals=withdrawals;summary.netFlow=deposits-withdrawals;summary.fees=fees;
 let k=0,wealth=1,peak=1,mdd=0,error=0,invalidCapital=false;
 const returns=[0];
 for(let i=1;i<p.length;i++){
  const t0=p[i-1][0],t1=p[i][0],profit=p[i][1]-p[i-1][1];let net=0,weighted=0;
  while(k<events.length&&Date.parse(events[k].time)<=t1){const r=events[k++];net+=r.value;weighted+=r.value*(t1-Date.parse(r.time))/(t1-t0);}
  error=Math.max(error,Math.abs((e[i][1]-e[i-1][1])-profit-net));
  const capital=e[i-1][1]+weighted,rate=capital>0?profit/capital:null;
  if(!Number.isFinite(capital)||capital<=0||rate===null||rate<=-1||!Number.isFinite(rate))invalidCapital=true;
  if(!invalidCapital){wealth*=1+rate;peak=Math.max(peak,wealth);mdd=Math.max(mdd,100*(peak-wealth)/peak);if(!Number.isFinite(wealth)||wealth>1e12)invalidCapital=true;}
  returns.push(invalidCapital?null:100*(wealth-1));
 }
 summary.reconciliationError=error;
 if(!s.coverageSufficient)return partial('insufficient_history');
 if(error>ROI.TOLERANCE)return partial('ledger_reconciliation_failed');
 if(invalidCapital)return partial('invalid_capital_basis');
 summary.strategyReturnPct=100*(wealth-1);summary.sampledMddPct=mdd;
 result.points.forEach((r,i)=>r.strategyReturnPct=returns[i]);result.status='ready';return result;
}
function validate(raw,user,period,now=Date.now()){
 if(!plain(raw)||raw.schemaVersion!==1||raw.accountId!==address(user)||raw.period!==period||raw.scope!=='all_account'||raw.currency!=='USD'||raw.method!=='sample_interval_modified_dietz'||raw.historyComplete!==false||!['ready','partial'].includes(raw.status)||!plain(raw.summary)||!Array.isArray(raw.points)||raw.points.length>MAX_ROWS||!Array.isArray(raw.cashflows)||raw.cashflows.length>MAX_ROWS||!Number.isFinite(Date.parse(raw.fetchedAt))||Date.parse(raw.fetchedAt)>now+5000)fail('invalid_response');
 for(const key of ['startEquity','endEquity','pnl','balanceChangePct','deposits','withdrawals','netFlow','fees','strategyReturnPct','sampledMddPct','sampleCount','maxGapMs','reconciliationError'])if(raw.summary[key]!==null)num(raw.summary[key]);
 for(const key of ['points','cashflows']){let t=-1;for(const r of raw[key]){const current=Date.parse(r.time);if(!plain(r)||!Number.isFinite(current)||current<t||current>now+5000)fail('invalid_response');t=current;if(key==='points'){num(r.equity);num(r.pnl);if(r.strategyReturnPct!==null)num(r.strategyReturnPct);}else{num(r.value);if(r.fee!==null)num(r.fee);if(typeof r.type!=='string'||r.type.length>80||!/^0x[0-9a-fA-F]{64}$/.test(r.hash))fail('invalid_response');}}}
 if(raw.status==='ready'&&(raw.reason!==null||raw.summary.strategyReturnPct===null||raw.summary.sampledMddPct===null||raw.summary.reconciliationError>ROI.TOLERANCE))fail('invalid_response');
 return JSON.parse(JSON.stringify(raw));
}
function prefer(previous,next){
 if(!previous||previous.accountId!==next.accountId||previous.period!==next.period)return next;
 const older=Date.parse(next.summary?.endAt||'')<Date.parse(previous.summary?.endAt||'');
 if(previous.status==='ready'&&(next.status!=='ready'||older))return {...JSON.parse(JSON.stringify(previous)),latestAttempt:{fetchedAt:next.fetchedAt,status:next.status,reason:older?'older_source':next.reason,endAt:next.summary?.endAt||null}};
 return next;
}
function create(options={}){
 const fetcher=options.fetch||globalThis.fetch?.bind(globalThis),now=options.now||Date.now,policy=options.policy||(!options.fetch?globalThis.BooksSourcePolicy:null);
 let destroyed=false,active=null,unsub=null;
 if(policy?.subscribe)unsub=policy.subscribe(()=>active?.abort());
 async function request(user,period='30D',{force=false}={}){
  user=address(user);if(destroyed)fail('cancelled');if(!Object.hasOwn(PERIODS,period))fail('invalid_period');
  const key=user+':'+period,cached=cache.get(key);if(!force&&cached&&now()-Date.parse(cached.fetchedAt)<300000)return JSON.parse(JSON.stringify(cached));
  if(policy?.reason())fail(policy.reason());
  active?.abort();const controller=new AbortController();active=controller;
  const clock=()=>options.now?options.now():Date.now();
  const sleep=options.sleep||((ms)=>new Promise((resolve,reject)=>{const t=setTimeout(done,ms);function done(){controller.signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(t);reject(Error('cancelled'));}controller.signal.addEventListener('abort',abort,{once:true});}));
  const post=async(body,weight)=>{
   if(destroyed||controller.signal.aborted)fail('cancelled');if(policy?.reason())fail(policy.reason());
   while(true){const t=clock();while(budget.length&&budget[0].at<=t-60000)budget.shift();if(budget.reduce((a,r)=>a+r.weight,0)+weight<=400)break;await sleep(Math.max(1,budget[0].at+60000-t));}
   budget.push({at:clock(),weight});const timer=setTimeout(()=>controller.abort(),12000);
   try{const response=await fetcher(INFO,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
    if([403,429].includes(response.status)){policy?.stop('http_'+response.status);fail('http_'+response.status);}
    if(response.status!==200)fail('http_'+response.status);
    if(!/json/i.test(response.headers.get('content-type')||''))fail('invalid_response');
    const bytes=Number(response.headers.get('content-length')||0);if(bytes>5000000)fail('response_too_large');
    const text=await response.text();if(text.length>5000000)fail('response_too_large');return JSON.parse(text);
   }finally{clearTimeout(timer);}
  };
  try{
   const raw=await post({type:'portfolio',user},20),s=source(raw,period,now());
   if(s.pnl.length<2)return calculate(raw,null,user,period,now());
   const start=s.pnl[0][0],end=s.pnl.at(-1)[0],rows=[],seen=new Map();let cursor=start,exhausted=false,pageCount=0;
   for(;pageCount<10;){
    const batch=await post({type:'userNonFundingLedgerUpdates',user,startTime:cursor,endTime:end},120);pageCount++;
    if(!Array.isArray(batch)||batch.length>2000)fail('invalid_response');let last=cursor,added=0;
    for(const row of batch){if(!plain(row)||!plain(row.delta)||!Number.isSafeInteger(row.time)||row.time<last||row.time<cursor||row.time>end||typeof row.hash!=='string')fail('invalid_response');last=row.time;const key=row.time+'|'+row.hash+'|'+JSON.stringify(row.delta,Object.keys(row.delta).sort());if(!seen.has(key)){seen.set(key,true);rows.push(row);added++;if(rows.length>MAX_ROWS)fail('response_too_large');}}
    if(!batch.length||!added&&batch.length<500&&last===cursor){exhausted=true;break;}
    if(last===cursor)fail('ledger_incomplete');cursor=last;
   }
   if(destroyed||controller.signal.aborted)fail('cancelled');
   const result=prefer(cached,calculate(raw,{rows,queryStartAt:start,queryEndAt:end,fetchedAt:iso(now()),pageCount,exhausted},user,period,now()));
   cache.set(key,result);if(cache.size>12)cache.delete(cache.keys().next().value);return JSON.parse(JSON.stringify(result));
  }finally{if(active===controller)active=null;}
 }
 return {request,destroy(){destroyed=true;active?.abort();unsub?.();}};
}
return {calculate,create,source,validate,prefer,PERIODS};
});
