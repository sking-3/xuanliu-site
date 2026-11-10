/* Long-window returns from paired perpetual samples and queried public ledger.
 * This is a source-formula calculation over the actual sampled interval, not TWR,
 * an official published ROI, or proof that every historical cash flow is retained.
 * Network access, pagination and persisted source-refusal handling belong upstream.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksPeriodROI = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
'use strict';
const DAY=86400000, PERIODS=Object.freeze({'90D':90,'180D':180,'365D':365});
const METHOD='public_ledger_peak_capital_v1', MAX_ROWS=20000, MAX_PAGES=10, TOLERANCE=0.02;
const REASONS=Object.freeze(['cash_flow_adjusted_return_unavailable','insufficient_history','insufficient_samples',
  'unpaired_samples','ledger_unavailable','ledger_incomplete','unknown_ledger_event','invalid_ledger_event',
  'ambiguous_ledger_order','ledger_reconciliation_failed','invalid_capital_basis','invalid_portfolio']);
const ADDRESS=/^0x[0-9a-f]{40}$/;
const fail=()=>{throw Error('invalid_roi_evidence');};
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const iso=t=>new Date(t).toISOString();
const unavailable=reason=>({roi:null,roiUnavailableReason:reason,roiEvidence:null});
function number(v) {
  if(typeof v!=='number'&&(typeof v!=='string'||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(v)||v.length>80))fail();
  const n=Number(v);if(!Number.isFinite(n)||Math.abs(n)>=1e14)fail();return n;
}
function money(v) {const n=number(v);if(n<0)fail();return n;}
function numeric(v) {if(typeof v!=='number')fail();return number(v);}
function stamp(v,now) {if(!Number.isSafeInteger(v)||v<0||v>now+300000)fail();return v;}
function date(v,now) {
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v))fail();
  const t=Date.parse(v);return stamp(t,now);
}
function address(v) {if(typeof v!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(v))fail();return v.toLowerCase();}
function count(v,max=MAX_ROWS) {if(!Number.isSafeInteger(v)||v<0||v>max)fail();return v;}
function nearly(a,b,absolute=0.000001) {return Math.abs(a-b)<=absolute;}
function series(raw,now) {
  if(!Array.isArray(raw)||raw.length>20000)fail();let prev=-1;
  return raw.map(pair=>{if(!Array.isArray(pair)||pair.length!==2)fail();const t=stamp(pair[0],now),v=number(pair[1]);if(t<=prev)fail();prev=t;return [t,v];});
}
function source(raw,now) {
  if(!Array.isArray(raw)||raw.length>32)fail();const found=raw.filter(r=>Array.isArray(r)&&r[0]==='perpAllTime');
  if(found.length!==1||found[0].length!==2||!plain(found[0][1]))fail();
  const s=found[0][1];return {pnl:series(s.pnlHistory,now),equity:s.accountValueHistory===undefined?null:series(s.accountValueHistory,now)};
}
function ledgerInput(raw,now) {
  if(!plain(raw)||raw.exhausted!==true)return {error:raw?'ledger_incomplete':'ledger_unavailable'};
  try {
    const start=stamp(raw.queryStartAt,now),end=stamp(raw.queryEndAt,now),fetched=date(raw.fetchedAt,now);
    const pages=count(raw.pageCount,MAX_PAGES);if(start>end||fetched<end||pages<1||!Array.isArray(raw.rows)||raw.rows.length>MAX_ROWS||raw.rows.length>pages*2000)fail();
    let prev=-1;const seen=new Set(),rows=[];
    for(const r of raw.rows){if(!plain(r)||!plain(r.delta)||typeof r.delta.type!=='string'||r.delta.type.length>80||typeof r.hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(r.hash))fail();
      const t=stamp(r.time,now);if(t<start||t>end||t<prev)fail();prev=t;
      // The collector merges inclusive pagination boundaries. A duplicate here
      // must not silently change the denominator or count money twice.
      const key=t+'|'+r.hash.toLowerCase()+'|'+JSON.stringify(r.delta,Object.keys(r.delta).sort());if(seen.has(key))fail();seen.add(key);rows.push(r);
    }
    return {rows,start,end,fetchedAt:iso(fetched),pageCount:pages};
  }catch(_){return {error:'invalid_ledger_event'};}
}
function flow(row,user) {
  const d=row.delta,unknown=()=>({error:'unknown_ledger_event'});
  try {
    // Explicit alternative DEX collateral is not silently treated as main perp USDC.
    if(Object.hasOwn(d,'dex')&&d.dex!=='')return unknown();
    if(d.type==='deposit')return {value:money(d.usdc)};
    if(d.type==='withdraw')return {value:-money(d.usdc)-money(d.fee)};
    if(d.type==='accountClassTransfer'){
      if(typeof d.toPerp!=='boolean'||(d.fee!==undefined&&number(d.fee)!==0))return unknown();
      return {value:money(d.usdc)*(d.toPerp?1:-1)};
    }
    if(['send','internalTransfer','subAccountTransfer','spotTransfer'].includes(d.type)){
      const from=address(d.user),to=address(d.destination);if(from!==user&&to!==user)fail();
      if(d.type==='spotTransfer'){
        if(typeof d.token!=='string'||!d.token||d.token.length>80)fail();money(d.amount);
        return {value:0};
      }
      if(d.type==='send'){
        if(typeof d.sourceDex!=='string'||typeof d.destinationDex!=='string'||typeof d.token!=='string')fail();
        const amount=money(d.amount),fee=money(d.fee),nativeFee=d.nativeTokenFee===undefined?0:money(d.nativeTokenFee);
        // Explicit spot-to-spot transfers (including their spot/native-token
        // fees) do not move default-perp capital. This is a scope exclusion,
        // not a waiver of the per-interval equity/PnL reconciliation below.
        if(d.sourceDex==='spot'&&d.destinationDex==='spot')return {value:0};
        // Fee currency and inclusion in portfolio PnL vary across routes. Only
        // zero-fee sends involving perp are accepted until a route is verified.
        if(fee!==0||nativeFee!==0)return unknown();
        if(!['','spot'].includes(d.sourceDex)||!['','spot'].includes(d.destinationDex)||d.token!=='USDC')return unknown();
        return {value:(to===user&&d.destinationDex===''?amount:0)-(from===user&&d.sourceDex===''?amount:0)};
      }
      const amount=money(d.usdc);
      if(d.type==='subAccountTransfer'){
        if(d.fee!==undefined&&number(d.fee)!==0)return unknown();
        return {value:(to===user?amount:0)-(from===user?amount:0)};
      }
      const fee=money(d.fee);if(fee>amount)fail();
      return {value:(to===user?amount-fee:0)-(from===user?amount:0)};
    }
    return unknown();
  }catch(_){return {error:'invalid_ledger_event'};}
}
function windowReturn(s,ledger,user,days) {
  const last=s.pnl.at(-1),cutoff=last?last[0]-days*DAY:null;
  if(!last||s.pnl[0][0]>cutoff)return unavailable('insufficient_history');
  const pnl=s.pnl.filter(p=>p[0]>=cutoff),start=pnl[0]?.[0],end=last[0];
  if(pnl.length<2)return unavailable('insufficient_samples');
  const equity=s.equity?.filter(p=>p[0]>=start&&p[0]<=end);
  if(!equity||equity.length!==pnl.length||pnl.some((p,i)=>p[0]!==equity[i][0]))return unavailable('unpaired_samples');
  if(ledger.error)return unavailable(ledger.error);
  if(ledger.start>start||ledger.end<end)return unavailable('ledger_incomplete');
  // Public ledger and portfolio timestamps do not order a cash event against
  // an equity observation in the same millisecond. Do not assume which side
  // of either boundary contains that event (including net-zero round trips).
  for(const r of ledger.rows.filter(r=>r.time===start||r.time===end)){
    const f=flow(r,user);if(f.error)return unavailable(f.error);if(f.value!==0)return unavailable('ambiguous_ledger_order');
  }
  const selected=ledger.rows.filter(r=>r.time>start&&r.time<=end),events=[];
  for(const r of selected){const f=flow(r,user);if(f.error)return unavailable(f.error);events.push({time:r.time,value:f.value});}
  // Same-millisecond opposite flows have no provable intra-block order in the
  // public schema. Summing them first could conceal the capital peak.
  for(let i=0;i<events.length;){let j=i,positive=false,negative=false;while(j<events.length&&events[j].time===events[i].time){positive||=events[j].value>0;negative||=events[j].value<0;j++;}if(positive&&negative)return unavailable('ambiguous_ledger_order');i=j;}
  let running=0,peak=0,relevant=0,maxError=0,k=0;
  for(let i=1;i<pnl.length;i++){
    let interval=0;
    while(k<events.length&&events[k].time<=pnl[i][0]){const value=events[k++].value;running+=value;interval+=value;peak=Math.max(peak,running);if(value!==0)relevant++;}
    const residual=Math.abs((equity[i][1]-equity[i-1][1])-(pnl[i][1]-pnl[i-1][1])-interval);
    if(!Number.isFinite(residual)||residual>TOLERANCE)return unavailable('ledger_reconciliation_failed');maxError=Math.max(maxError,residual);
  }
  const initial=equity[0][1],profit=pnl.at(-1)[1]-pnl[0][1],capital=Math.max(100,initial+peak),roi=100*profit/capital;
  if(initial<0||!Number.isFinite(peak)||!Number.isFinite(capital)||!Number.isFinite(roi)||Math.abs(capital)>=1e14||Math.abs(roi)>=1e14)return unavailable('invalid_capital_basis');
  return {roi,roiUnavailableReason:null,roiEvidence:{method:METHOD,accountId:user,scope:'default_perp_dex',currency:'USD',
    startAt:iso(start),endAt:iso(end),pnl:profit,initialEquity:initial,maxNetDeposits:peak,capitalBase:capital,
    ledgerFetchedAt:ledger.fetchedAt,ledgerQueryStartAt:iso(ledger.start),ledgerQueryEndAt:iso(ledger.end),
    pageCount:ledger.pageCount,recordCount:selected.length,relevantCount:relevant,pairedSampleCount:pnl.length,
    maxReconciliationError:maxError,historyComplete:false,queryExhausted:true}};
}
function calculate(rawPortfolio,rawLedger,accountId,now=Date.now()) {
  const user=address(accountId);stamp(now,now);let s;
  try{s=source(rawPortfolio,now);}catch(_){return Object.fromEntries(Object.keys(PERIODS).map(p=>[p,unavailable('invalid_portfolio')]));}
  const ledger=ledgerInput(rawLedger,now);
  return Object.fromEntries(Object.entries(PERIODS).map(([period,days])=>[period,windowReturn(s,ledger,user,days)]));
}
function validateWindow(w,accountId,now=Date.now()) {
  if(!plain(w))fail();
  if(w.roi===null){if(!REASONS.includes(w.roiUnavailableReason)||(w.roiEvidence!==undefined&&w.roiEvidence!==null))fail();return unavailable(w.roiUnavailableReason);}
  const user=address(accountId),e=w.roiEvidence;numeric(w.roi);
  if(w.roiUnavailableReason!==null||!plain(e)||e.method!==METHOD||e.accountId!==user||!ADDRESS.test(e.accountId)||e.scope!=='default_perp_dex'||e.currency!=='USD'||e.historyComplete!==false||e.queryExhausted!==true)fail();
  if(w.derived!==true||w.sourcePeriod!=='perpAllTime'||w.scope!=='perp_account'||w.curveUnit!=='USD'||!Object.values(PERIODS).includes(w.requestedDays)||!['full','sampled_boundary'].includes(w.coverageStatus))fail();
  const start=date(w.startAt,now),end=date(w.endAt,now),requestedStart=date(w.requestedStartAt,now),requestedEnd=date(w.requestedEndAt,now);
  if(start>=end||start<requestedStart||end!==requestedEnd||requestedEnd-requestedStart!==w.requestedDays*DAY||e.startAt!==w.startAt||e.endAt!==w.endAt)fail();
  if(date(w.sourceHistoryStartAt,now)>requestedStart||w.sourceHistoryEndAt!==w.endAt)fail();
  if(w.coverageStatus==='full'?start!==requestedStart:start<=requestedStart)fail();
  const queryStart=date(e.ledgerQueryStartAt,now),queryEnd=date(e.ledgerQueryEndAt,now),fetched=date(e.ledgerFetchedAt,now);
  if(queryStart>start||queryEnd<end||queryStart>queryEnd||fetched<queryEnd)fail();
  const pageCount=count(e.pageCount,MAX_PAGES),records=count(e.recordCount),relevant=count(e.relevantCount),samples=count(e.pairedSampleCount),error=numeric(e.maxReconciliationError);
  if(pageCount<1||samples<2||samples!==w.sampleCount||relevant>records||records>pageCount*2000||error<0||error>TOLERANCE)fail();
  const pnl=numeric(e.pnl),initial=numeric(e.initialEquity),peak=numeric(e.maxNetDeposits),capital=numeric(e.capitalBase);
  if(initial<0||peak<0||relevant===0&&peak!==0||capital<100||!nearly(pnl,numeric(w.pnl))||!nearly(capital,Math.max(100,initial+peak))||!nearly(w.roi,100*pnl/capital,Math.max(1e-9,Number.EPSILON*Math.abs(w.roi)*32)))fail();
  const evidence={method:METHOD,accountId:user,scope:'default_perp_dex',currency:'USD',startAt:w.startAt,endAt:w.endAt,pnl,initialEquity:initial,maxNetDeposits:peak,capitalBase:capital,
    ledgerFetchedAt:iso(fetched),ledgerQueryStartAt:iso(queryStart),ledgerQueryEndAt:iso(queryEnd),pageCount,recordCount:records,relevantCount:relevant,pairedSampleCount:samples,maxReconciliationError:error,historyComplete:false,queryExhausted:true};
  return {roi:w.roi,roiUnavailableReason:null,roiEvidence:evidence};
}
return {calculate,validateWindow,REASONS,METHOD,TOLERANCE};
});
