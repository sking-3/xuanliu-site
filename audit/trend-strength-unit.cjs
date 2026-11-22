'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const engine=require('../screening/trend-screen.js');
const day='2026-11-20';
function dates(count){
 const output=[];
 for(let date=new Date(day+'T00:00:00Z');output.length<count;date.setUTCDate(date.getUTCDate()-1))if(![0,6].includes(date.getUTCDay()))output.unshift(date.toISOString().slice(0,10));
 return output;
}
function bars(daily=i=>[.01,-.006,.004,-.003,.002][i%5],count=61){
 let price=100;
 return dates(count).map((date,i)=>{if(i)price*=1+daily(i);return {date,close:price,volume:100,open:price,high:price*1.01,low:price*.99};});
}
const gain=daily=>(daily.reduce((value,r)=>value*(1+r),1)-1)*100;
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,actual+' != '+expected);
function record(index,values={}){
 return {stock:{code:String(600000+index)+'.SH'},result:{status:'ready',eligible:true,candidateMatched:true,excluded:false,matched:true,metrics:{startAt:dates(21)[0],endAt:day,sampleCount:21,relativeBaseline:'full_market_leave_one_out_equal_stock_daily_median',excessReturn:index,recentExcessReturn:index,relativeStrengthChange:index,downsideExcess:index,downsideDays:2,...values}}};
}
const rank=(records,options={})=>engine.rankStrength(records,{day,lookback:20,...options});

test('fixed full-market facts use the leave-self-out daily median and exact selected windows',()=>{
 const peer=i=>[.01,-.006,.004,-.003,.002][i%5],strong=i=>peer(i)+.001;
 const records=Array.from({length:30},(_,i)=>({stock:{code:String(600000+i)+'.SH'},bars:bars(i?peer:strong)}));
 const before=JSON.stringify(records),c=engine.buildConsensus({records,calendar:bars(),day,lookback:20,expectedCount:30,totalUniverseCount:30});
 assert.equal(c.status,'ready');assert.equal(JSON.stringify(records),before);
 const m=c.perCode['600000.SH'],p=Array.from({length:20},(_,i)=>peer(i+41)),s=Array.from({length:20},(_,i)=>strong(i+41));
 near(m.excessReturn,gain(s)-gain(p));near(m.recentExcessReturn,gain(s.slice(-5))-gain(p.slice(-5)));
 near(m.relativeStrengthChange,m.recentExcessReturn-(gain(s.slice(-10,-5))-gain(p.slice(-10,-5))));
 assert.equal(m.downsideDays,p.filter(r=>r<0).length);near(m.downsideExcess,.1);
 const evaluated=engine.evaluate({mode:'consensus',bars:records[0].bars,referenceBars:bars(),day,lookback:20,code:'600000.SH',consensus:c,limits:{enabled:false}});
 near(evaluated.metrics.excessReturn,m.excessReturn);
});
test('a period with no baseline decline preserves unknown resilience instead of zero',()=>{
 const records=Array.from({length:30},(_,i)=>({stock:{code:String(600000+i)+'.SH'},bars:bars(()=>.002+i*.00001)}));
 const c=engine.buildConsensus({records,calendar:bars(()=>.002),day,lookback:60,expectedCount:30,totalUniverseCount:30});
 assert.equal(c.status,'ready');assert.equal(c.perCode['600000.SH'].downsideDays,0);assert.equal(c.perCode['600000.SH'].downsideExcess,null);
});
test('a fixed120 or240-style sample cannot label itself a full-market relative baseline',()=>{
 const records=Array.from({length:40},(_,i)=>({stock:{code:String(600000+i)+'.SH'},bars:bars()}));
 const sampled=engine.buildConsensus({records,calendar:bars(),day,lookback:20,expectedCount:40,totalUniverseCount:3194});
 assert.equal(sampled.status,'ready');assert.equal(sampled.perCode['600000.SH'].relativeBaseline,'market_sample_leave_one_out_equal_stock_daily_median');
 const rows=Array.from({length:5},(_,i)=>record(i,{...sampled.perCode[String(600000+i)+'.SH']}));
 const output=rank(rows);assert.equal(output.status,'unavailable');assert.equal(output.groupCount,0);assert(output.records.every(r=>r.result.relativeStrength.matched===null));
});

test('same-length facts with different starting sessions never share one rank',()=>{
 const rows=Array.from({length:6},(_,i)=>record(i));rows[5].result.metrics.startAt='2026-10-22';
 const output=rank(rows);assert.equal(output.status,'unavailable');assert.equal(output.groupCount,0);
 assert(output.records.every(row=>row.result.relativeStrength.matched===null));
});
test('current group ranking changes percentiles without changing its fixed market baseline facts',()=>{
 const records=Array.from({length:10},(_,i)=>record(i)),before=JSON.stringify(records);
 const all=rank(records),subset=rank(records.slice(5));
 assert.equal(all.status,'ready');assert.equal(subset.status,'ready');
 near(all.records[5].result.relativeStrength.meanPercentile,100*5/9);near(subset.records[0].result.relativeStrength.meanPercentile,0);
 assert.deepEqual(subset.records.map(r=>r.result.metrics),records.slice(5).map(r=>r.result.metrics));assert.equal(JSON.stringify(records),before);
 assert.equal(all.records.at(-1).result.relativeStrength.baselineMethod,'full_market_leave_one_out_equal_stock_daily_median');
});
test('three same-period components have equal influence while resilience stays independent',()=>{
 const records=[record(0,{excessReturn:0,recentExcessReturn:2,relativeStrengthChange:1,downsideExcess:999}),record(1,{excessReturn:1,recentExcessReturn:1,relativeStrengthChange:2,downsideExcess:null,downsideDays:0}),record(2,{excessReturn:2,recentExcessReturn:0,relativeStrengthChange:0,downsideExcess:-999})];
 const output=rank(records,{minPeers:3,groupTopPercent:100});
 for(const r of output.records){const facts=r.result.relativeStrength;near(facts.meanPercentile,Object.values(facts.percentiles).reduce((sum,n)=>sum+n,0)/3);assert.equal(Object.keys(facts.percentiles).length,3);assert.equal(facts.status,'ready');}
 near(output.records[0].result.relativeStrength.meanPercentile,50);near(output.records[1].result.relativeStrength.meanPercentile,100*2/3);
 const optional=rank(records,{minPeers:3,groupTopPercent:100,minDownsideExcess:0});assert.equal(optional.records[1].result.relativeStrength.status,'unavailable');assert.equal(optional.records[1].result.relativeStrength.matched,null);assert.equal(optional.records[2].result.relativeStrength.matched,false);
});
test('heat, eligibility and direction exclusions never enter the group ranks',()=>{
 const records=Array.from({length:8},(_,i)=>record(i));records[5].result.excluded=true;records[6].result.eligible=false;records[7].result.directionMatched=false;
 const output=rank(records);assert.equal(output.groupCount,5);assert.equal(output.records[4].result.relativeStrength.rank,1);
 for(const r of output.records.slice(5)){assert.equal(r.result.relativeStrength.status,'unavailable');assert.equal(r.result.relativeStrength.matched,null);}
});
test('a missing or mismatched period stays unknown and cannot inflate another score',()=>{
 const records=Array.from({length:7},(_,i)=>record(i));records[5].result.metrics.excessReturn=null;records[6].result.metrics.sampleCount=61;
 const output=rank(records);assert.equal(output.groupCount,5);assert.equal(output.records[4].result.relativeStrength.meanPercentile,100);
 for(const r of output.records.slice(5))assert.equal(r.result.relativeStrength.meanPercentile,null);
 records[4].result.metrics.endAt='2026-11-19';const short=rank(records);assert.equal(short.status,'unavailable');assert.equal(short.groupCount,4);assert(short.records.every(r=>r.result.relativeStrength.matched===null));
});
test('a duplicate security cannot create an extra peer and invalid rules fail explicitly',()=>{
 assert.throws(()=>rank([record(0),record(0)]),/重复/);
 for(const options of [{groupTopPercent:0},{groupTopPercent:101},{minPeers:1},{minPeers:2.5},{minExcessReturn:NaN},{minDownsideExcess:'0'},{minResistanceSpace:-1},{unknown:1}])assert.throws(()=>rank([record(0),record(1)],options));
});
test('index-relative or legacy unmarked excess cannot impersonate the fixed market baseline',()=>{
 const records=Array.from({length:7},(_,i)=>record(i));records[5].result.metrics.relativeBaseline='reference_series';delete records[6].result.metrics.relativeBaseline;
 const output=rank(records);assert.equal(output.groupCount,5);assert.equal(output.records[5].result.relativeStrength.meanPercentile,null);assert.equal(output.records[6].result.relativeStrength.meanPercentile,null);
 assert.match(output.records[5].result.relativeStrength.reason,/口径/);
});
test('ties are order independent and boundary ties remain together',()=>{
 const records=Array.from({length:5},(_,i)=>record(i,{excessReturn:1,recentExcessReturn:1,relativeStrengthChange:1}));
 const a=rank(records),b=rank(records.slice().reverse());
 for(const r of a.records){assert.equal(r.result.relativeStrength.rank,1);assert.equal(r.result.relativeStrength.meanPercentile,50);assert.equal(r.result.relativeStrength.matched,true);}
 assert.deepEqual(a.records.map(r=>r.result.relativeStrength),b.records.reverse().map(r=>r.result.relativeStrength));
});
test('tiny floating noise cannot promote identical facts to different ranks',()=>{
 const records=Array.from({length:5},(_,i)=>record(i,{excessReturn:1+i*1e-15,recentExcessReturn:1,relativeStrengthChange:i*1e-15}));
 for(const r of rank(records).records){assert.equal(r.result.relativeStrength.rank,1);assert.equal(r.result.relativeStrength.meanPercentile,50);}
});
test('top-group and component thresholds are independent and adjustable',()=>{
 const records=Array.from({length:10},(_,i)=>record(i));
 assert.equal(rank(records).records.filter(r=>r.result.relativeStrength.matched).length,3);
 assert.equal(rank(records,{groupTopPercent:50}).records.filter(r=>r.result.relativeStrength.matched).length,5);
 assert.equal(rank(records,{groupTopPercent:100,minRecentExcess:8}).records.filter(r=>r.result.relativeStrength.matched).length,2);
 assert.equal(rank(records,{groupTopPercent:100,minImprovement:10}).records.filter(r=>r.result.relativeStrength.matched).length,0);
});
function structureBars(){
 const rows=bars(()=>0,21);rows[10].high=102;rows[10].low=98;return rows;
}
test('support and resistance use confirmed prior OHLC levels and expose distances only',()=>{
 const rows=structureBars(),before=JSON.stringify(rows),facts=engine.deriveSupportResistance({bars:rows,calendar:rows,day});
 assert.equal(facts.status,'ready');near(facts.supportDistancePct,2);near(facts.resistanceSpacePct,2);assert.equal(facts.startAt,rows[0].date);assert.equal(facts.endAt,day);assert(facts.supportTouches>0);assert(facts.resistanceTouches>0);assert.equal(JSON.stringify(rows),before);
 for(const key of ['open','high','low','close','support','resistance','supportPrice','resistancePrice'])assert.equal(Object.hasOwn(facts,key),false);
 const scaled=rows.map(b=>({...b,open:b.open*10,high:b.high*10,low:b.low*10,close:b.close*10}));
 assert.deepEqual(engine.deriveSupportResistance({bars:scaled,calendar:scaled,day}),facts);
});
test('today cannot retroactively create its own resistance and an absent level is not infinite room',()=>{
 const rows=structureBars();rows.at(-1).open=103;rows.at(-1).close=103;rows.at(-1).high=110;rows.at(-1).low=100;
 const facts=engine.deriveSupportResistance({bars:rows,calendar:rows,day});assert.equal(facts.status,'ready');assert.equal(facts.resistanceSpacePct,null);assert.equal(facts.resistanceTouches,null);assert.match(facts.reason,/没有.*压力/);
});
test('legacy close-only bars, future data, missing days and malformed OHLC remain unavailable',()=>{
 const source=structureBars(),legacy=source.map(({date,close,volume})=>({date,close,volume}));
 for(const rows of [legacy,source.slice(1),source.filter((_,i)=>i!==8),source.map((b,i)=>i===5?{...b,high:1}:b),[...source,{...source.at(-1),date:'2026-11-23'}]]){
  const facts=engine.deriveSupportResistance({bars:rows,calendar:source,day});assert.equal(facts.status,'unavailable');assert.equal(facts.supportDistancePct,null);assert.equal(facts.resistanceSpacePct,null);
 }
});
test('structure thresholds only apply with same-day known levels and never overwrite old rule outcomes',()=>{
 const records=Array.from({length:5},(_,i)=>record(i));for(const r of records)r.result.structure=engine.deriveSupportResistance({bars:structureBars(),calendar:structureBars(),day});
 const before=JSON.stringify(records),tight=rank(records,{groupTopPercent:100,maxSupportDistance:1}),room=rank(records,{groupTopPercent:100,minResistanceSpace:1});
 assert(tight.records.every(r=>r.result.relativeStrength.matched===false));assert(room.records.every(r=>r.result.relativeStrength.matched===true));
  assert.equal(JSON.stringify(records),before);assert.equal(JSON.stringify(room.records.map(r=>({...r,result:{...r.result,relativeStrength:undefined}}))),before);
 records[0].result.structure={status:'unavailable',endAt:day};records[1].result.structure.endAt='2026-11-19';
 const unknown=rank(records,{groupTopPercent:100,maxSupportDistance:3});assert.equal(unknown.records[0].result.relativeStrength.matched,null);assert.equal(unknown.records[1].result.relativeStrength.matched,null);
  assert.equal(room.records[0].result.matched,true);
});
