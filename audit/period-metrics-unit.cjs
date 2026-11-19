'use strict';
const assert=require('node:assert/strict');
const {resolve,parseSamples}=require('../trader/period-metrics.js');
const end='2026-11-19T13:57:28.000Z',start='2026-10-20T13:57:28.000Z';
const base={roi:299.1434297,pnl:676513.435411,asOf:end,asOfType:'source',currency:'USD'};
const old={value:0,startAt:'2026-08-19T21:07:24.002Z',endAt:'2026-08-19T21:07:24.002Z',eligibleCount:74};
const staleRisk={mdd:106.5910575,mddUnavailableReason:null,sampleCount:46,mddPairedSampleCount:46,
 startAt:'2026-10-16T23:24:00.029Z',endAt:'2026-11-16T00:39:30.725Z',points:[]};
const stale=resolve({exchange:'Hyperliquid',period:'30D',performance:base,sample:staleRisk,winEntry:{win:old}});
assert.equal(stale.roi,base.roi);
assert.equal(stale.pnl,base.pnl);
assert.equal(stale.mdd,null);
assert.equal(stale.winRate,null);
assert.equal(stale.alignedCurve,null);
const observedAt='2026-11-20T00:00:00.000Z',sha256='a'.repeat(64);
const risk={value:0,startAt:start,endAt:end,count:30,observedAt,sha256};
const win={...risk,value:0,count:74};
const row={anchorAt:end,sourceStartAt:start,mdd:risk,win,curve:[{time:start,value:0},{time:end,value:100}]};
const supplement=parseSamples({schemaVersion:1,generatedAt:observedAt,accounts:{['0x'+'1'.repeat(40)]:{'30D':row}}},Date.parse(observedAt));
const scoped=resolve({exchange:'Hyperliquid',period:'30D',performance:base,supplement:row});
assert.equal(scoped.mdd,0);assert.equal(scoped.winRate,0);
assert.equal(scoped.metricTimes.mdd.observedAt,observedAt);
assert.equal(scoped.metricTimes.roi.sourceAt,end);
const wrong=resolve({exchange:'Hyperliquid',period:'7D',performance:{...base},supplement:{...row,anchorAt:'2026-11-19T13:57:29Z'}});
assert.equal(wrong.mdd,null);
assert.equal(wrong.winRate,null);
for(const exchange of ['Binance','OKX','Bitget']){
 const masked=resolve({exchange,period:'365D',performance:{roi:1000,pnl:100,mdd:23,winRate:66,fullPeriod:false,lastSuccessAt:observedAt}});
 assert.deepEqual([masked.roi,masked.pnl,masked.mdd,masked.winRate],[null,null,null,null]);
 assert.equal(masked.periodInvalid,true);
}
const okx=resolve({exchange:'OKX',period:'30D',performance:{roi:12,pnl:100,mdd:null,winRate:60,
 beginTs:Date.parse(start),endTs:Date.parse(end),lastSuccessAt:end,
 winRateEvidence:{lastSuccessAt:observedAt},fullPeriod:true}});
assert.equal(okx.metricTimes.roi.sourceAt,end);
assert.equal(okx.metricTimes.winRate.observedAt,observedAt);
assert.equal(okx.mdd,null);
assert.equal(okx.metricTimes.winRate.method,'profit_days_ratio');
assert.equal(okx.metricTimes.winRate.sourceAt,null);
const native=resolve({exchange:'Hyperliquid',period:'30D',performance:base,supplement:{...row,native:{roi:305.39,pnl:690650.66,sourceAt:end,observedAt,sourcePeriod:'month',sha256}}});
assert.equal(native.roi,305.39);assert.equal(native.pnl,690650.66);assert.equal(native.metricTimes.roi.observedAt,observedAt);
assert.throws(()=>parseSamples({...supplement,accounts:{['0x'+'1'.repeat(40)]:{'30D':{...row,win:{...win,startAt:'2026-08-20T00:00:00Z'}}}}},Date.parse(observedAt)));
const capped=resolve({exchange:'Hyperliquid',period:'30D',performance:base,supplement:{...row,win:{...win,capped:true,complete:false}}});
assert.equal(capped.metricTimes.winRate.complete,false);
console.log('period metrics checks passed: exact window, zero values, field dates, short history, rejection and sample coverage');

const newer=resolve({exchange:'Hyperliquid',period:'30D',performance:{...base,asOf:'2026-11-19T15:57:40Z',roi:400},supplement:{...row,native:{roi:305.39,pnl:690650.66,sourceAt:end,observedAt,sourcePeriod:'month',sha256}}});
assert.equal(newer.roi,400);assert.equal(newer.mdd,null);
