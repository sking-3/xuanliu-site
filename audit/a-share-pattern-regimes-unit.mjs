import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {analyzePatternRegimes,evaluateEvent,summarizeEvents,walkForward,policy,fixedMatches} from '../server/a-share-pattern-regimes.mjs';

const require=createRequire(import.meta.url),patterns=require('../screening/trend-patterns.js');
function calendar(count){const days=[];for(let time=Date.UTC(2024,0,1);days.length<count;time+=86400000){const date=new Date(time);if(date.getUTCDay()!==0&&date.getUTCDay()!==6)days.push(date.toISOString().slice(0,10));}return days;}
const bar=(date,close=100,open=close,volume=1000)=>({date,open,high:Math.max(open,close)*1.01,low:Math.min(open,close)*.99,close,volume});
function series(count=500,stockCount=1){
  const dates=calendar(count),reference=dates.map(date=>bar(date));
  const records=Array.from({length:stockCount},(_,stock)=>({stock:{code:String(600000+stock)+'.SH',name:'研究样本'+stock},source:{status:'ready',adjustment:'qfq',sourceId:'test-real-source',fetchedAt:dates.at(-1)+'T08:00:00.000Z',bars:dates.map((date,i)=>bar(date,100*Math.exp(i*.0003+.025*Math.sin(i*.41+stock*.3)),100*Math.exp((i-.3)*.0003+.025*Math.sin((i-.3)*.41+stock*.3)),1000*(1+.7*Math.sin(i*.36+stock*.1))))}}));
  const day=dates.at(-1),asOf=day+'T08:00:00.000Z';
  return {dataset:{day,asOf,universe:records.map(record=>record.stock),reference:{code:'000300.SH',bars:reference},records},patterns,sourceId:'test-real-source',generation:day+'-1',now:()=>Date.parse(asOf)+1};
}
function inputEvents(dates,{negative=false}={}){
  const events=[];
  for(let signalIndex=61;signalIndex<dates.length-policy.horizon;signalIndex++)for(let stock=0;stock<30;stock++){
    const value=negative?-10:10;
    events.push({code:String(stock),signalIndex,entryIndex:signalIndex+1,exitIndex:signalIndex+15,returns:{3:value/3,5:value/2,10:value*.8,15:value},returnPercent:value,excessPercent:negative?-8:8,drawdownPercent:negative?12:2});
  }
  return events;
}

test('fixed default detector matches the existing catalogue without fitting new shapes',()=>{
  const f=series(),bars=f.dataset.records[0].source.bars,prices=new Float64Array(bars.length+1),volumes=new Float64Array(bars.length+1),mas=new Map([5,10,20].map(n=>[n,new Float64Array(bars.length)]));
  for(let i=0;i<bars.length;i++){prices[i+1]=prices[i]+bars[i].close;volumes[i+1]=volumes[i]+bars[i].volume;for(const [period,values]of mas)values[i]=i>=period-1?(prices[i+1]-prices[i+1-period])/period:NaN;}
  for(let i=60;i<bars.length;i++){
    const window=bars.slice(i-60,i+1),actual=fixedMatches({bars,prices,volumes,mas,validRange:()=>true},i).sort(),expected=patterns.classify({bars:window,calendar:window,day:window.at(-1).date,lookback:20}).labels.map(label=>label.id).sort();
    assert.deepEqual(actual,expected,'catalogue mismatch at '+i);
  }
});

test('next-open estimates, common mature cohort and closing drawdown have explicit definitions',()=>{
  const dates=calendar(20),bars=dates.map(date=>bar(date)),reference=dates.map(date=>bar(date));
  for(let i=1;i<=15;i++)bars[i]=bar(dates[i],i===1?110:i===2?99:105,100);
  const event=evaluateEvent({bars,reference,signalIndex:0,code:'600000.SH'});
  assert.equal(event.status,'ready');assert.equal(event.entryIndex,1);assert.equal(event.exitIndex,15);
  assert(Math.abs(event.returnPercent-4.7)<1e-10);assert(Math.abs(event.drawdownPercent-10)<1e-10);assert.equal(event.excessPercent,event.returnPercent);
  const stats=summarizeEvents([event],dates);assert.equal(stats.sampleCount,1);assert.equal(stats.targetHitRate,0);assert.equal(stats.returns['3'].sampleCount,1);assert.equal(stats.returns['15'].sampleCount,1);
  assert(Math.abs(stats.meanDrawdownPercent-10)<1e-10);assert(stats.targetHitWilsonHigh>0);assert.equal(stats.stockCount,1);
});

test('unmatured, unfillable, missing and halted intervals never become zero returns',()=>{
  const dates=calendar(20),bars=dates.map(date=>bar(date)),reference=dates.map(date=>bar(date));
  assert.equal(evaluateEvent({bars,reference,signalIndex:10,code:'600000.SH'}).status,'pending');
  bars[1]=bar(dates[1],111,111);assert.equal(evaluateEvent({bars,reference,signalIndex:0}).status,'unexecutable');bars[1]=bar(dates[1]);
  bars[1]={date:dates[1],open:105,high:105,low:105,close:105,volume:1000};assert.equal(evaluateEvent({bars,reference,signalIndex:0}).status,'unexecutable');bars[1]=bar(dates[1]);
  bars[5]=null;assert.equal(evaluateEvent({bars,reference,signalIndex:0}).status,'unavailable');bars[5]=bar(dates[5],100,100,0);assert.equal(evaluateEvent({bars,reference,signalIndex:0}).status,'unavailable');bars[5]=bar(dates[5]);
  bars[15]={date:dates[15],open:90,high:90,low:90,close:90,volume:1000};assert.equal(evaluateEvent({bars,reference,signalIndex:0}).status,'unexecutable');
  const empty=summarizeEvents([],dates);assert.equal(empty.meanReturnPercent,null);assert.equal(empty.targetHitRate,null);assert.equal(empty.worstDrawdownPercent,null);
});

test('rolling fold choices use only outcomes completed before the unseen fold and correct the fixed catalogue',()=>{
  const dates=calendar(500),events=inputEvents(dates),result=walkForward(events,dates);
  assert.equal(result.status,'ready');assert.equal(result.folds.length,9);assert.equal(result.selectedFoldCount,9);assert.equal(result.positiveFoldCount,9);assert.equal(result.blockCount,12);assert.equal(result.positiveBlockCount,12);
  assert(Math.abs(result.pValue-1/4096)<1e-12);assert(Math.abs(result.adjustedPValue-16/4096)<1e-12);
  for(const fold of result.folds){assert(fold.trainingOutcomeThrough<fold.startDay);assert(fold.trainedThrough<fold.trainingOutcomeThrough);assert(fold.training.toDay<=fold.trainedThrough);assert(fold.test.fromDay>=fold.startDay);}
  const first=result.folds[0],firstStart=dates.indexOf(first.startDay),mutated=events.map(event=>event.signalIndex>=firstStart?{...event,returnPercent:-50,excessPercent:-60,returns:{3:-50,5:-50,10:-50,15:-50}}:event),changed=walkForward(mutated,dates);
  assert.deepEqual(changed.folds[0].training,first.training);assert.equal(changed.folds[0].selected,first.selected);assert(changed.folds[0].test.meanReturnPercent<0);assert(changed.stats.meanReturnPercent<0);
});

test('negative or sparse past patterns are never selected into OOS recommendations',()=>{
  const dates=calendar(500),negative=walkForward(inputEvents(dates,{negative:true}),dates);
  assert.equal(negative.selectedFoldCount,0);assert.equal(negative.stats.sampleCount,0);assert.equal(negative.adjustedPValue,null);
  const sparse=walkForward(inputEvents(dates).filter(event=>event.code==='1'),dates);assert.equal(sparse.selectedFoldCount,0);assert.equal(sparse.stats.meanReturnPercent,null);
  assert.equal(walkForward([],calendar(100)).status,'insufficient');
});

test('constant persistent shapes do not create a fresh event every day',async()=>{
  const f=series();f.dataset.records[0].source.bars=f.dataset.reference.bars.map((value,i)=>bar(value.date,100+i*.1,100+i*.1));
  const result=await analyzePatternRegimes(f),shape=result.patterns.find(pattern=>pattern.id==='trend-up');
  assert.equal(shape.currentMatchCount,1);assert.equal(shape.fit.sampleCount,0);assert.equal(shape.recent.sampleCount,0);assert.equal(shape.recommended,false);assert.equal(result.candidateCodes.length,0);
});

test('event episodes have a15-session cooldown and missing history is not filled across gaps',async()=>{
  const f=series(500,2),first=f.dataset.records[0].source.bars;first[200]={...first[200],volume:0};
  const result=await analyzePatternRegimes(f);
  assert.equal(result.coverage.historyDays,500);assert.equal(result.coverage.readyCount,2);
  for(const shape of result.patterns){assert(shape.fit.sampleCount<=2*Math.ceil(policy.trainDays/15));assert(shape.recent.sampleCount<=2*Math.ceil(policy.recentDays/15));assert.equal(shape.recommended,false);}
  assert.match(result.method.universeWarning,/存续偏差/);assert.equal(result.summary.effectiveCount,0);
});

test('async per-stock input stays offline and publishes no raw OHLC arrays or invented metrics',async t=>{
  const f=series(100,3),records=f.dataset.records;delete f.dataset.records;let yielded=0;
  t.mock.method(globalThis,'fetch',()=>{throw Error('must remain offline');});
  async function* stream(){for(const record of records){yielded++;yield record;}}
  const result=await analyzePatternRegimes({...f,records:stream()});
  assert.equal(yielded,3);assert.equal(result.coverage.universeCount,3);assert.equal(result.summary.effectiveCount,0);assert(result.patterns.every(pattern=>pattern.status==='insufficient'));
  assert.doesNotMatch(JSON.stringify(result),/"(?:bars|open|high|low|close|volume|prices|last_price|apiKey|cookie)"/);
  assert.equal(result.version,'books.pattern-regimes.2026-11-24.v1');assert(result.method.returnLabel.includes('非实际成交收益'));
});

test('a stock unavailable today retains its genuinely mature historical events and has no current recommendation',async()=>{
  const f=series(),before=await analyzePatternRegimes(f),lastMatureDay=f.dataset.reference.bars.at(-16).date;
  f.dataset.records[0].source.status='unavailable';
  const unavailable=await analyzePatternRegimes(f);
  assert.equal(unavailable.coverage.readyCount,0);
  for(let i=0;i<before.patterns.length;i++){assert.deepEqual(unavailable.patterns[i].fit,before.patterns[i].fit);assert.equal(unavailable.patterns[i].currentMatchCount,0);}
  f.dataset.records[0].source.bars.pop();
  const halted=await analyzePatternRegimes(f),retained=before.patterns.filter(shape=>shape.fit.sampleCount>0&&shape.fit.toDay<lastMatureDay);
  assert(retained.length>0);
  for(const shape of retained)assert.deepEqual(halted.patterns.find(value=>value.id===shape.id).fit,shape.fit);
  assert.equal(halted.candidateCodes.length,0);assert.equal(halted.coverage.readyCount,0);
  assert(halted.patterns.reduce((total,shape)=>total+shape.fit.sampleCount,0)>0);
});

test('duplicate stock identities, wrong fixed catalogue, future clocks and malformed reference dates fail explicitly',async()=>{
  const f=series(100,2);f.dataset.records[1].stock.code=f.dataset.records[0].stock.code;
  await assert.rejects(analyzePatternRegimes(f),/代码缺失或重复/);
  await assert.rejects(analyzePatternRegimes({...series(100),patterns:{...patterns,definitions:[]}}),/目录版本/);
  await assert.rejects(analyzePatternRegimes({...series(100),patterns:{...patterns,profile:{...patterns.profile,nearPct:3}}}),/目录版本/);
  const future=series(100);future.now=()=>Date.parse(future.dataset.asOf)-1;await assert.rejects(analyzePatternRegimes(future),/日期、来源和批次/);
  const reference=series(100);reference.dataset.reference.bars[5].date=reference.dataset.reference.bars[4].date;await assert.rejects(analyzePatternRegimes(reference),/参考历史/);
});
