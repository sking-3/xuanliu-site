'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const api=require('../trader/period-roi.js');
const analytics=require('../trader/account-analytics.js');
const NOW=Date.parse('2026-11-10T12:00:00Z'),DAY=86400000;
const USER='0x'+'1'.repeat(40),OTHER='0x'+'2'.repeat(40);
const iso=t=>new Date(t).toISOString();let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function fixture(events=[],options={}){
 const offsets=options.offsets||[-400,-365,-180,-90,-30,0],profits=options.profits||[0,50,100,200,250,300],initial=options.initial??1000;
 const rows=events.map((e,i)=>({time:NOW+e.at*DAY,hash:'0x'+(i+1).toString(16).padStart(64,'0'),delta:e.delta})).sort((a,b)=>a.time-b.time);
 const pnl=offsets.map((d,i)=>[NOW+d*DAY,String(profits[i])]);
 const equity=offsets.map((d,i)=>[NOW+d*DAY,String(initial+profits[i]+events.filter(e=>e.at<=d).reduce((n,e)=>n+e.cash,0))]);
 const raw=[['perpAllTime',{pnlHistory:pnl,accountValueHistory:equity}]],ledger={rows,queryStartAt:NOW-365*DAY,queryEndAt:NOW,fetchedAt:iso(NOW+1000),pageCount:1,exhausted:true};
 return {raw,ledger,now:NOW+2000};
}
function calc(f){return api.calculate(f.raw,f.ledger,USER,f.now);}
function wholeWindow(f,period='90D'){
 return {...analytics.normalize.portfolio(f.raw,f.now).windows[period],...calc(f)[period]};
}
function rejects(mutator){const f=fixture(),w=wholeWindow(f);mutator(w);assert.throws(()=>api.validateWindow(w,USER,f.now),/invalid_roi_evidence/);}
test('actual sampled intervals produce positive, zero and negative returns',()=>{
 const f=fixture(),r=calc(f);assert.equal(r['90D'].roi,100*100/1200);assert.equal(r['180D'].roi,100*200/1100);assert.equal(r['365D'].roi,100*250/1050);
 const z=fixture([], {profits:[0,0,0,0,0,0]});assert.equal(calc(z)['90D'].roi,0);
 const n=fixture([], {profits:[0,-10,-20,-30,-40,-50]});assert.equal(calc(n)['90D'].roi,100*-20/970);
});
test('observed deposit then withdrawal retains the intra-sample capital peak',()=>{
 const f=fixture([{at:-75,delta:{type:'deposit',usdc:'500'},cash:500},{at:-60,delta:{type:'withdraw',usdc:'499',fee:'1'},cash:-500}]);
 const r=calc(f)['90D'];assert.equal(r.roiEvidence.maxNetDeposits,500);assert.equal(r.roiEvidence.capitalBase,1700);assert.equal(r.roi,100*100/1700);assert.equal(r.roiEvidence.relevantCount,2);
});
test('withdrawal fee is part of the capital movement and cannot vanish in a relative tolerance',()=>{
 const f=fixture([{at:-60,delta:{type:'withdraw',usdc:'99',fee:'1'},cash:-100}]);assert.equal(calc(f)['90D'].roiUnavailableReason,null);
 f.ledger.rows[0].delta.fee='0';assert.equal(calc(f)['90D'].roiUnavailableReason,'ledger_reconciliation_failed');
 const large=fixture([{at:-60,delta:{type:'withdraw',usdc:'99',fee:'0'},cash:-100}],{initial:1e10});assert.equal(calc(large)['90D'].roiUnavailableReason,'ledger_reconciliation_failed');
});
test('default perp sends use address, route and USDC rather than all account transfers',()=>{
 const f=fixture([
  {at:-80,delta:{type:'send',user:USER,destination:USER,sourceDex:'spot',destinationDex:'',token:'USDC',amount:'500',fee:'0',nativeTokenFee:'0'},cash:500},
  {at:-70,delta:{type:'send',user:USER,destination:USER,sourceDex:'',destinationDex:'spot',token:'USDC',amount:'100',fee:'0',nativeTokenFee:'0'},cash:-100},
  {at:-60,delta:{type:'send',user:USER,destination:OTHER,sourceDex:'spot',destinationDex:'spot',token:'HYPE',amount:'1000',fee:'0',nativeTokenFee:'0'},cash:0},
  {at:-50,delta:{type:'spotTransfer',user:OTHER,destination:USER,token:'HYPE',amount:'10'},cash:0}
 ]);const r=calc(f)['90D'];assert.equal(r.roiEvidence.maxNetDeposits,500);assert.equal(r.roiEvidence.relevantCount,2);assert.equal(r.roiEvidence.recordCount,4);
});
test('unverified send fee currencies and nondefault DEX routes stay unavailable',()=>{
 for(const extra of [{fee:'1'},{nativeTokenFee:'0.00002'},{sourceDex:'xyz'},{token:'HYPE'}]){
  const f=fixture([{at:-50,delta:{type:'send',user:OTHER,destination:USER,sourceDex:'spot',destinationDex:'',token:'USDC',amount:'10',fee:'0',nativeTokenFee:'0',...extra},cash:10}]);
  assert.equal(calc(f)['90D'].roiUnavailableReason,'unknown_ledger_event');
 }
});
test('explicit spot-only sends exclude spot and native fees from default-perp capital',()=>{
 const f=fixture([
  {at:-70,delta:{type:'send',user:USER,destination:OTHER,sourceDex:'spot',destinationDex:'spot',token:'USDC',amount:'50',fee:'0.001152',feeToken:'USDC',nativeTokenFee:'0'},cash:0},
  {at:-60,delta:{type:'send',user:OTHER,destination:USER,sourceDex:'spot',destinationDex:'spot',token:'USDC',amount:'70',fee:'0',nativeTokenFee:'0.00002'},cash:0},
  {at:-50,delta:{type:'send',user:USER,destination:OTHER,sourceDex:'spot',destinationDex:'spot',token:'MAX',amount:'80',fee:'0',nativeTokenFee:'0'},cash:0}
 ]);
 const r=calc(f)['90D'];assert.equal(r.roiUnavailableReason,null);assert.equal(r.roi,calc(fixture())['90D'].roi);
 assert.equal(r.roiEvidence.maxNetDeposits,0);assert.equal(r.roiEvidence.relevantCount,0);assert.equal(r.roiEvidence.recordCount,3);
 // If the observed perp equity did change, the scope exclusion cannot bypass
 // strict interval reconciliation, including a fee larger than 0.02 USD.
 f.raw[0][1].accountValueHistory[4][1]='1249.95';assert.equal(calc(f)['90D'].roiUnavailableReason,'ledger_reconciliation_failed');
});
test('spot-only scope exclusion still validates addresses and numeric fees',()=>{
 const delta={type:'send',user:USER,destination:OTHER,sourceDex:'spot',destinationDex:'spot',token:'USDC',amount:'50',fee:'0',nativeTokenFee:'0.00002'};
 for(const extra of [{fee:'NaN'},{nativeTokenFee:'-1'},{amount:'NaN'},{user:OTHER,destination:OTHER}]){
  assert.equal(calc(fixture([{at:-60,delta:{...delta,...extra},cash:0}]))['90D'].roiUnavailableReason,'invalid_ledger_event');
 }
});
test('account class, subaccount and verified internal transfer directions reconcile',()=>{
 const f=fixture([
  {at:-80,delta:{type:'accountClassTransfer',usdc:'200',toPerp:true},cash:200},
  {at:-75,delta:{type:'accountClassTransfer',usdc:'50',toPerp:false},cash:-50},
  {at:-70,delta:{type:'subAccountTransfer',usdc:'100',user:OTHER,destination:USER},cash:100},
  {at:-65,delta:{type:'subAccountTransfer',usdc:'20',user:USER,destination:OTHER},cash:-20},
  {at:-60,delta:{type:'internalTransfer',usdc:'100',fee:'1',user:OTHER,destination:USER},cash:99},
  {at:-55,delta:{type:'internalTransfer',usdc:'10',fee:'1',user:USER,destination:OTHER},cash:-10}
 ]);assert.equal(calc(f)['90D'].roiUnavailableReason,null);assert.equal(calc(f)['90D'].roiEvidence.maxNetDeposits,329);
});
test('an unknown historical delta blocks only windows that include it',()=>{
 const f=fixture([{at:-200,delta:{type:'rewardsClaim',amount:'1'},cash:0}]),r=calc(f);
 assert.equal(r['90D'].roiUnavailableReason,null);assert.equal(r['180D'].roiUnavailableReason,null);assert.equal(r['365D'].roiUnavailableReason,'unknown_ledger_event');
});
test('unknown or malformed cash events are never assumed to be zero',()=>{
 for(const delta of [{type:'vaultWithdraw',requestedUsd:'100'},{type:'deposit',usdc:'NaN'},{type:'withdraw',usdc:'10'},{type:'send',user:OTHER,destination:OTHER}]){
  const reason=calc(fixture([{at:-60,delta,cash:0}]))['90D'].roiUnavailableReason;assert.ok(['unknown_ledger_event','invalid_ledger_event'].includes(reason));
 }
});
test('same-millisecond opposite cash flows cannot fabricate an event ordering',()=>{
 const f=fixture([{at:-60,delta:{type:'deposit',usdc:'100'},cash:100},{at:-60,delta:{type:'withdraw',usdc:'99',fee:'1'},cash:-100}]);
 assert.equal(calc(f)['90D'].roiUnavailableReason,'ambiguous_ledger_order');
 f.ledger.rows.reverse();assert.equal(calc(f)['90D'].roiUnavailableReason,'ambiguous_ledger_order');
 const inflows=fixture([{at:-60,delta:{type:'deposit',usdc:'100'},cash:100},{at:-60,delta:{type:'deposit',usdc:'200'},cash:200}]);
 const first=calc(inflows)['90D'];inflows.ledger.rows.reverse();assert.deepEqual(calc(inflows)['90D'],first);assert.equal(first.roiEvidence.maxNetDeposits,300);
});
test('each interval must reconcile even when endpoint errors cancel',()=>{
 const f=fixture();f.raw[0][1].accountValueHistory[4][1]='2250';assert.equal(calc(f)['90D'].roiUnavailableReason,'ledger_reconciliation_failed');
});
test('absolute reconciliation tolerance accepts rounding only',()=>{
 const f=fixture();f.raw[0][1].accountValueHistory[4][1]='1250.01';assert.equal(calc(f)['90D'].roiUnavailableReason,null);
 f.raw[0][1].accountValueHistory[4][1]='1250.03';assert.equal(calc(f)['90D'].roiUnavailableReason,'ledger_reconciliation_failed');
});
test('one sample, absent equity, mismatched timestamps and insufficient history stay empty',()=>{
 const one=fixture([],{offsets:[-400,0],profits:[0,100]});assert.equal(calc(one)['90D'].roiUnavailableReason,'insufficient_samples');
 const absent=fixture();delete absent.raw[0][1].accountValueHistory;assert.equal(calc(absent)['90D'].roiUnavailableReason,'unpaired_samples');
 const mismatch=fixture();mismatch.raw[0][1].accountValueHistory[4][0]++;assert.equal(calc(mismatch)['90D'].roiUnavailableReason,'unpaired_samples');
 const short=fixture([],{offsets:[-80,-30,0],profits:[0,10,20]});assert.equal(calc(short)['90D'].roiUnavailableReason,'insufficient_history');
});
test('no interpolation occurs at a rolling boundary',()=>{
 const f=fixture([],{offsets:[-400,-364,-179,-89,-30,0]});const w=wholeWindow(f);
 assert.equal(w.coverageStatus,'sampled_boundary');assert.equal(w.roiEvidence.startAt,iso(NOW-89*DAY));assert.equal(api.validateWindow(w,USER,f.now).roi,w.roi);
});
test('cash events at sample boundaries do not assume observation ordering',()=>{
 for(const at of [-90,0]){
  const f=fixture([{at,delta:{type:'deposit',usdc:'100'},cash:100}]);assert.equal(calc(f)['90D'].roiUnavailableReason,'ambiguous_ledger_order');
  const netZero=fixture([{at,delta:{type:'deposit',usdc:'100'},cash:100},{at,delta:{type:'withdraw',usdc:'99',fee:'1'},cash:-100}]);assert.equal(calc(netZero)['90D'].roiUnavailableReason,'ambiguous_ledger_order');
 }
});
test('query exhaustion and full actual sample coverage are required',()=>{
 const f=fixture();f.ledger.exhausted=false;assert.equal(calc(f)['90D'].roiUnavailableReason,'ledger_incomplete');
 delete f.ledger;assert.equal(calc(f)['90D'].roiUnavailableReason,'ledger_unavailable');
 const late=fixture();late.ledger.queryStartAt=NOW-80*DAY;assert.equal(calc(late)['90D'].roiUnavailableReason,'ledger_incomplete');
 const early=fixture();early.ledger.queryEndAt=NOW-DAY;assert.equal(calc(early)['90D'].roiUnavailableReason,'ledger_incomplete');
});
test('duplicate rows, out of range dates and oversized metadata fail closed',()=>{
 const f=fixture([{at:-60,delta:{type:'deposit',usdc:'10'},cash:10}]);f.ledger.rows.push(structuredClone(f.ledger.rows[0]));assert.equal(calc(f)['90D'].roiUnavailableReason,'invalid_ledger_event');
 for(const modify of [l=>l.pageCount=11,l=>l.rows[0].time=NOW+1,l=>l.fetchedAt=iso(NOW+400000),l=>l.rows[0].hash='bad']){const x=fixture([{at:-60,delta:{type:'deposit',usdc:'10'},cash:10}]);modify(x.ledger);assert.equal(calc(x)['90D'].roiUnavailableReason,'invalid_ledger_event');}
});
test('negative initial equity is rejected and the source 100 USD floor is explicit',()=>{
 const bad=fixture([],{initial:-1000});assert.equal(calc(bad)['90D'].roiUnavailableReason,'invalid_capital_basis');
 const small=fixture([],{initial:10,profits:[0,0,0,0,1,2]});assert.equal(calc(small)['90D'].roiEvidence.capitalBase,100);assert.equal(calc(small)['90D'].roi,2);
});
test('valid evidence round-trips without claiming complete history',()=>{
 const f=fixture(),w=wholeWindow(f),clean=api.validateWindow(w,USER,f.now);
 assert.deepEqual(clean,calc(f)['90D']);assert.equal(clean.roiEvidence.historyComplete,false);assert.equal(clean.roiEvidence.queryExhausted,true);
 assert.deepEqual(api.validateWindow({roi:null,roiUnavailableReason:'cash_flow_adjusted_return_unavailable'},USER,f.now),{roi:null,roiUnavailableReason:'cash_flow_adjusted_return_unavailable',roiEvidence:null});
});
test('nonempty ROI requires evidence, matching accounts, units, dates and formula',()=>{
 for(const mutate of [w=>delete w.roiEvidence,w=>w.roi++,w=>w.roiEvidence.accountId=OTHER,w=>w.roiEvidence.currency='USDT',w=>w.roiEvidence.scope='all_account',w=>w.roiEvidence.historyComplete=true,w=>w.roiEvidence.queryExhausted=false,w=>w.roiEvidence.pnl++,w=>w.roiEvidence.capitalBase++,w=>w.roiEvidence.initialEquity++,w=>w.roiEvidence.startAt=iso(NOW-89*DAY),w=>w.roiEvidence.pairedSampleCount--,w=>w.roiEvidence.maxReconciliationError=.03,w=>w.coverageStatus='insufficient_history',w=>w.roiEvidence.ledgerFetchedAt=iso(NOW-DAY),w=>w.requestedDays=30,w=>w.roiUnavailableReason='unknown_ledger_event'])rejects(mutate);
});
test('failure evidence cannot smuggle a value or a false reason',()=>{
 assert.throws(()=>api.validateWindow({roi:null,roiUnavailableReason:'made_up'},USER,NOW));
 assert.throws(()=>api.validateWindow({roi:null,roiUnavailableReason:'ledger_unavailable',roiEvidence:{}},USER,NOW));
 assert.throws(()=>api.validateWindow({roi:0,roiUnavailableReason:null},USER,NOW));
});
test('no relevant cash records cannot attest an invented capital peak',()=>{
 rejects(w=>{w.roiEvidence.maxNetDeposits=100;w.roiEvidence.capitalBase+=100;w.roi=100*w.pnl/w.roiEvidence.capitalBase;});
});
test('browser export is pure and performs no network or storage work',()=>{
 const sandbox={};vm.runInNewContext(fs.readFileSync(require.resolve('../trader/period-roi.js'),'utf8'),sandbox);
 assert.equal(typeof sandbox.BooksPeriodROI.calculate,'function');assert.equal(typeof sandbox.BooksPeriodROI.validateWindow,'function');assert.equal(sandbox.BooksPeriodROI.METHOD,'public_ledger_peak_capital_v1');
});
console.log('PASS '+passed+' public-ledger period ROI checks. Offline synthetic fixtures only.');
