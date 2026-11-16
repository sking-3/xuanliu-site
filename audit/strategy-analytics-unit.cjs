'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),model=require('../trader/strategy-analytics.js');
const user='0x'+'1'.repeat(40),T=Date.parse('2026-11-16T12:00:00Z'),D=86400000,hash='0x'+'a'.repeat(64);
function raw(equity=[100,210,220],pnl=[0,10,20]){return [['month',{pnlHistory:pnl.map((v,i)=>[T-(2-i)*D,String(v)]),accountValueHistory:equity.map((v,i)=>[T-(2-i)*D,String(v)])}]];}
function ledger(rows=[]){return {queryStartAt:T-2*D,queryEndAt:T,fetchedAt:new Date(T).toISOString(),exhausted:true,pageCount:2,rows};}
const deposit={time:T-1.5*D,hash,delta:{type:'deposit',usdc:'100'}};
test('actual transfer is separated from performance and interval Dietz is chained',()=>{
 const r=model.calculate(raw(),ledger([deposit]),user,'30D',T);assert.equal(r.status,'ready');assert.equal(r.summary.pnl,20);assert.equal(r.summary.deposits,100);assert.equal(r.summary.endEquity,220);assert.equal(r.summary.balanceChangePct,120.00000000000001);assert.ok(Math.abs(r.summary.strategyReturnPct-((1+10/150)*(1+10/210)-1)*100)<1e-10);assert.equal(r.cashflows[0].hash,hash);assert.deepEqual(model.validate(r,user,'30D',T),r);
});
test('withdrawal changes balance while flat PnL leaves strategy return unchanged',()=>{
 const r=model.calculate(raw([100,50,50],[0,0,0]),ledger([{time:T-1.5*D,hash,delta:{type:'withdraw',usdc:'49',fee:'1'}}]),user,'30D',T);assert.equal(r.status,'ready');assert.equal(r.summary.withdrawals,50);assert.equal(r.summary.strategyReturnPct,0);assert.equal(r.summary.fees,1);assert.equal(r.summary.sampledMddPct,0);
});
test('missing ledger and mismatched equity retain amount series without fabricating adjusted ROI',()=>{
 const r=model.calculate(raw(),null,user,'30D',T);assert.equal(r.reason,'ledger_unavailable');assert.equal(r.points.length,3);assert.equal(r.summary.strategyReturnPct,null);const shifted=raw();shifted[0][1].accountValueHistory[1][0]++;assert.equal(model.calculate(shifted,ledger(),user,'30D',T).reason,'unpaired_samples');
});
test('unknown events, incomplete pagination, boundary ambiguity and reconciliation gaps suppress ROI',()=>{
 for(const [l,reason]of [[ledger([{...deposit,delta:{type:'newFutureType'}}]),'unknown_ledger_event'],[{...ledger(),exhausted:false},'ledger_incomplete'],[ledger([{...deposit,time:T}]),'ambiguous_ledger_order'],[ledger([]),'ledger_reconciliation_failed']]){const r=model.calculate(raw(),l,user,'30D',T);assert.equal(r.reason,reason);assert.equal(r.summary.strategyReturnPct,null);assert.ok(r.points.every(p=>p.strategyReturnPct===null));}
});
test('nonpositive interval capital and duplicated source samples reject',()=>{
 assert.equal(model.calculate(raw([0,0,0],[0,0,0]),ledger(),user,'30D',T).reason,'invalid_capital_basis');const p=raw();p[0][1].pnlHistory[1][0]=p[0][1].pnlHistory[0][0];assert.throws(()=>model.calculate(p,ledger(),user,'30D',T),/invalid_response/);
});
test('cashflow-neutral strategy curve measures sampled drawdown',()=>{
 const r=model.calculate(raw([100,120,108],[0,20,8]),ledger(),user,'30D',T);assert.equal(r.status,'ready');assert.ok(Math.abs(r.summary.sampledMddPct-10)<1e-10);assert.ok(Math.abs(r.summary.strategyReturnPct-8)<1e-10);
});
test('short all-time history cannot be labelled a full 90/180/365-day strategy return',()=>{
 const p=raw([100,120,108],[0,20,8]);p[0][0]='allTime';
 for(const period of ['90D','180D','365D']){const r=model.calculate(p,ledger(),user,period,T);assert.equal(r.reason,'insufficient_history');assert.equal(r.status,'partial');assert.equal(r.summary.pnl,8);assert.equal(r.points.length,3);assert.equal(r.summary.strategyReturnPct,null);assert.equal(r.summary.sampledMddPct,null);}
});
test('a partial or older response retains the complete dated analysis without mixing new values',()=>{
 const good=model.calculate(raw([100,120,108],[0,20,8]),ledger(),user,'30D',T),partial=model.calculate(raw(),null,user,'30D',T+60000),kept=model.prefer(good,partial);assert.equal(kept.summary.pnl,8);assert.equal(kept.fetchedAt,good.fetchedAt);assert.equal(kept.latestAttempt.reason,'ledger_unavailable');assert.equal(kept.latestAttempt.fetchedAt,partial.fetchedAt);
 const older={...good,fetchedAt:new Date(T+60000).toISOString(),summary:{...good.summary,endAt:new Date(T-D).toISOString(),pnl:999}};assert.equal(model.prefer(good,older).summary.pnl,8);assert.equal(model.prefer(good,older).latestAttempt.reason,'older_source');
});
test('all-account USDC transfers include spot withdrawals and exclude own spot/perp transfers',()=>{
 const to='0x'+'2'.repeat(40),send={time:T-1.5*D,hash,delta:{type:'send',user,destination:to,sourceDex:'spot',destinationDex:'spot',token:'USDC',amount:'50',usdcValue:'50',fee:'0',nativeTokenFee:'0.0001'}},internal={time:T-1.2*D,hash:'0x'+'b'.repeat(64),delta:{type:'accountClassTransfer',toPerp:true,usdc:'100'}};
 const r=model.calculate(raw([100,50,50],[0,0,0]),ledger([send,internal]),user,'30D',T);assert.equal(r.status,'ready');assert.equal(r.summary.withdrawals,50);assert.equal(r.cashflows.length,1);assert.equal(r.summary.strategyReturnPct,0);assert.equal(r.scope,'all_account');
 const noValue={...send,delta:{...send.delta,token:'HYPE',usdcValue:undefined}};assert.equal(model.calculate(raw(),ledger([noValue]),user,'30D',T).reason,'unknown_ledger_event');
});
test('request stops on source refusal without fetching ledger',async()=>{
 let count=0,stopped;const c=model.create({fetch:async()=>{count++;return new Response('',{status:429});},policy:{reason:()=>null,stop:s=>stopped=s}});await assert.rejects(c.request('0x'+'2'.repeat(40)),/http_429/);assert.equal(count,1);assert.equal(stopped,'http_429');c.destroy();
});
test('saved report cannot change account or silently change account scope',()=>{
 const r=model.calculate(raw([100,120,108],[0,20,8]),ledger(),user,'30D',T);for(const change of [{accountId:'0x'+'3'.repeat(40)},{scope:'default_perp_dex'},{cashflows:[{time:new Date(T).toISOString(),value:1,type:'deposit',hash:'javascript:alert(1)',fee:0}]}])assert.throws(()=>model.validate({...r,...change},user,'30D',T),/invalid_response/);
});
