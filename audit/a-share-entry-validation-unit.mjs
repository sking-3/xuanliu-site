import {test} from 'node:test';
import assert from 'node:assert/strict';
import {entryValidationVersion,entryValidationPolicy,version,policy,evaluateEntryOutcome,validateEntryEvents,reserveEntryIntervals} from '../server/a-share-entry-validation.mjs';
import {policy as originalPolicy} from '../server/a-share-pattern-regimes.mjs';

function calendar(count){const out=[];for(let time=Date.UTC(2024,0,1);out.length<count;time+=86400000){const day=new Date(time);if(day.getUTCDay()!==0&&day.getUTCDay()!==6)out.push(day.toISOString().slice(0,10));}return out;}
const bar=(date,changes={})=>({date,open:100,high:101,low:99,close:100,volume:1000,...changes});
function fixture(count=90){
  const dates=calendar(count),bars=dates.map(date=>bar(date)),reference=dates.map(date=>bar(date));
  bars[61]=bar(dates[61],{open:99.5,high:101,low:98,close:100.5});
  bars[62]=bar(dates[62],{open:100.5,high:103,low:100,close:102,volume:1100});
  bars[63]=bar(dates[63],{open:102,high:104,low:101,close:103.5});
  const setup={replayStatus:'triggered_observation',formation:{...bars[61]},keyBar:{...bars[62]},observedEvent:{date:dates[63]},trigger:{above:103},invalidation:{below:98},knownAt:dates.at(-1)+'T08:00:00Z'};
  return {dates,bars,reference,setup,code:'600000.SH'};
}
function event(code,signalIndex,net=10){return {status:'ready',code,signalIndex,entryIndex:signalIndex,exitIndex:signalIndex+15,returns:{3:net/3,5:net/2,10:net*.8,15:net},returnPercent:net,excessPercent:net*.8,drawdownPercent:net>0?2:12};}
function events(dates,{net=10}={}){const out=[];for(let i=61;i<dates.length-15;i++)for(let stock=0;stock<64;stock++)if(stock%16===i%16)out.push(event(String(600000+stock)+'.SH',i,net));return out;}

test('independent module preserves all existing fixed thresholds and exposes its distinct version',()=>{
  assert.equal(version,entryValidationVersion);assert.equal(policy,entryValidationPolicy);
  for(const [key,value]of Object.entries(originalPolicy))assert.equal(entryValidationPolicy[key],value,key);
  assert.equal(entryValidationPolicy.anchorStrideSessions,16);assert.equal(Object.isFrozen(entryValidationPolicy),true);
});

test('T price and T+15 close define the cohort, independently of the old F+1 open',()=>{
  const f=fixture();f.bars[78]=bar(f.dates[78],{open:108,high:110,low:107,close:109});
  f.bars[77]=bar(f.dates[77],{open:149,high:151,low:148,close:150});
  const result=evaluateEntryOutcome(f);
  assert.equal(result.status,'ready');assert.equal(result.entryIndex,63);assert.equal(result.exitIndex,78);assert.equal(result.entryReference,103);
  assert(Math.abs(result.returnPercent-((109/103-1)*100-.3))<1e-10);assert.notEqual(result.returnPercent,(109/f.bars[62].open-1)*100-.3);
  assert.equal(result.returns[3],(f.bars[66].close/103-1)*100-.3);assert.equal(result.actualFillVerified,false);
  assert.equal(result.researchConditionKnownAt,f.dates[62]+'T15:00:00+08:00');assert.equal(result.actualDiscoveryAt,f.setup.knownAt);
});

test('the 15 following sessions do not count T itself as day one and pending does not become a return',()=>{
  const f=fixture(78),pending=evaluateEntryOutcome(f);assert.equal(pending.status,'pending');assert.equal(pending.exitIndex,78);assert.equal(pending.returnPercent,undefined);
  f.dates.push(calendar(79)[78]);f.bars.push(bar(f.dates[78]));f.reference.push(bar(f.dates[78]));assert.equal(evaluateEntryOutcome(f).status,'ready');
  const waiting=fixture();waiting.setup.replayStatus='waiting_trigger';assert.equal(evaluateEntryOutcome(waiting).status,'waiting_trigger');
});

test('strict equality, ambiguous trigger/invalidity, chase and first-trigger order cannot yield ready samples',()=>{
  const equality=fixture();equality.bars[63].high=103;equality.bars[63].close=102.5;assert.equal(evaluateEntryOutcome(equality).status,'not_triggered');
  const ambiguous=fixture();ambiguous.bars[63].low=97;assert.equal(evaluateEntryOutcome(ambiguous).status,'ambiguous');
  const chase=fixture();chase.bars[63]=bar(chase.dates[63],{open:105.07,high:107,low:104,close:106});assert.equal(evaluateEntryOutcome(chase).status,'chased');
  const invalid=fixture();invalid.bars[63]=bar(invalid.dates[63],{open:97,high:104,low:96,close:100});assert.equal(evaluateEntryOutcome(invalid).status,'invalidated');
  const earlier=fixture();earlier.setup.observedEvent.date=earlier.dates[64];assert.equal(evaluateEntryOutcome(earlier).status,'unavailable');
  const sameDay=fixture();sameDay.setup.observedEvent.date=sameDay.dates[62];assert.equal(evaluateEntryOutcome(sameDay).status,'unavailable');
});

test('opening gap uses its actual open research reference within 2%, never the cheaper threshold',()=>{
  const f=fixture();f.bars[63]=bar(f.dates[63],{open:104,high:105,low:103.5,close:104.5});
  const result=evaluateEntryOutcome(f);assert.equal(result.status,'ready');assert.equal(result.entryReference,104);assert.equal(result.entryMode,'opening_gap_reference');
  assert.equal(result.returnPercent,(f.bars[78].close/104-1)*100-.3);
});

test('formation and confirmation are rechecked against raw records without choosing a later prettier C',()=>{
  const f=fixture();f.setup.trigger.above=102;assert.equal(evaluateEntryOutcome(f).status,'unavailable');f.setup.trigger.above=103;
  f.setup.invalidation.below=90;assert.equal(evaluateEntryOutcome(f).status,'unavailable');f.setup.invalidation.below=98;
  f.bars[62].volume=999;assert.equal(evaluateEntryOutcome(f).status,'unavailable');f.bars[62].volume=1100;
  f.bars[62].close=101;assert.equal(evaluateEntryOutcome(f).status,'unavailable');
  const later=fixture();later.bars[63]=bar(later.dates[63],{open:102,high:104,low:101,close:103.5});later.setup.keyBar={...later.bars[63]};later.setup.trigger.above=104;later.setup.observedEvent.date=later.dates[64];
  assert.equal(evaluateEntryOutcome(later).status,'unavailable');
});

test('fixed invalidation does not invent stop execution and closing drawdown keeps its own denominator',()=>{
  const f=fixture();f.bars[64]=bar(f.dates[64],{open:103,high:111,low:102,close:110});f.bars[65]=bar(f.dates[65],{open:100,high:101,low:96,close:99});
  const result=evaluateEntryOutcome(f);assert.equal(result.status,'ready');assert(Math.abs(result.drawdownPercent-10)<1e-10);assert.equal(result.invalidationFirstDay,f.dates[65]);assert.equal(result.fixedInvalidation,98);
  assert.equal(result.returnPercent,(f.bars[78].close/103-1)*100-.3);assert.equal(result.stopFillPrice,undefined);
});

test('missing, halted or misaligned holding sessions are excluded without skipping dates',()=>{
  for(const mode of ['missing','halted','misaligned']){
    const f=fixture();
    if(mode==='missing')f.bars[67]=null;
    if(mode==='halted')f.bars[67].volume=0;
    if(mode==='misaligned')f.bars[67].date=f.dates[68];
    assert.equal(evaluateEntryOutcome(f).status,'unavailable',mode);
  }
  const noIndex=fixture();noIndex.reference[67]=null;assert.equal(evaluateEntryOutcome(noIndex).status,'unavailable');
});


test('intermediate one-price bars remain real holding prices, while a locked falling exit is unexecutable',()=>{
  const f=fixture();f.bars[67]={date:f.dates[67],open:110,high:110,low:110,close:110,volume:1000};assert.equal(evaluateEntryOutcome(f).status,'ready');
  f.bars[78]={date:f.dates[78],open:90,high:90,low:90,close:90,volume:1000};assert.equal(evaluateEntryOutcome(f).status,'unexecutable');
});

test('relative validation uses aligned T-close intervals, never an invented simultaneous index open',()=>{
  const f=fixture();f.reference[63]=bar(f.dates[63],{open:80,high:102,low:79,close:100});f.reference[78]=bar(f.dates[78],{open:104,high:106,low:103,close:105});
  const result=evaluateEntryOutcome(f),stockAligned=(f.bars[78].close/f.bars[63].close-1)*100-.3;
  assert(Math.abs(result.excessPercent-(stockAligned-5))<1e-10);assert.equal(result.closeAlignedReturnPercent,stockAligned);
  assert.notEqual(result.excessPercent,result.returnPercent-(105/80-1)*100);
});

test('same-stock overlapping intervals are counted once and cannot inflate the independent date count',()=>{
  const dates=calendar(500),input=events(dates),first=input[0];input.push({...first});input.push(event(first.code,first.signalIndex+1));
  const result=validateEntryEvents(input,dates);assert.equal(result.overlapExcludedCount,2);assert.equal(result.matureSampleCount,input.length-2);assert.equal(result.fit.stockCount,64);
  const clustered=validateEntryEvents(Array.from({length:100},(_,i)=>event(String(i),100)),dates);assert.equal(clustered.validation.blockCount,0);assert.equal(clustered.recommended,false);
});

test('rolling choice is frozen before each trigger fold, and independent anchors never share a session',()=>{
  const dates=calendar(500),input=events(dates),result=validateEntryEvents(input,dates);
  assert.equal(result.validation.folds.length,9);assert.equal(result.validation.selectedFoldCount,9);assert.equal(result.validation.positiveFoldCount,9);assert.equal(result.validation.blockCount,12);assert.equal(result.recommended,true);
  assert(Math.abs(result.validation.adjustedPValue-16/4096)<1e-12);
  for(const fold of result.validation.folds){assert(fold.trainingOutcomeThrough<fold.startDay);assert(fold.trainedThrough<fold.startDay);}
  for(let i=1;i<result.validation.blocks.length;i++)assert(result.validation.blocks[i-1].exitDay<result.validation.blocks[i].triggerDay);
  const firstStart=dates.indexOf(result.validation.folds[0].startDay),changed=input.map(value=>value.signalIndex>=firstStart?event(value.code,value.signalIndex,-10):value),newResult=validateEntryEvents(changed,dates);
  assert.deepEqual(newResult.validation.folds[0].training,result.validation.folds[0].training);assert.equal(newResult.validation.folds[0].selected,result.validation.folds[0].selected);assert(newResult.validation.folds[0].test.meanReturnPercent<0);
});

test('future returns cannot enter a training choice, recent matured denominators or validation',()=>{
  const dates=calendar(500),input=events(dates),result=validateEntryEvents(input,dates),fold=result.validation.folds[0],start=dates.indexOf(fold.startDay);
  const leaky=event('late',start-14);leaky.returnPercent=99;leaky.excessPercent=99;leaky.returns={3:99,5:99,10:99,15:99};
  const changed=validateEntryEvents([...input,leaky],dates);assert.deepEqual(changed.validation.folds[0].training,fold.training);
  assert.throws(()=>validateEntryEvents([...input,event('future',490)],dates),/成熟收益事件/);
  assert.throws(()=>validateEntryEvents([event('wrong',70),{...event('wrong2',90),entryIndex:91}],dates),/口径/);
  assert.throws(()=>validateEntryEvents(input,dates,{patternCount:1}),/固定16类/);
});

test('negative, sparse and absent histories remain explicit instead of manufacturing an opportunity',()=>{
  const dates=calendar(500),negative=validateEntryEvents(events(dates,{net:-10}),dates);assert.equal(negative.recommended,false);assert.equal(negative.validation.selectedFoldCount,0);assert(negative.failedChecks.includes('validation_samples'));assert(negative.failedChecks.includes('familywise'));
  const sparse=validateEntryEvents([event('1',100)],dates);assert.equal(sparse.status,'insufficient');assert.equal(sparse.recommended,false);assert(sparse.failedChecks.includes('fit_samples'));
  const short=validateEntryEvents([],calendar(100));assert.equal(short.validation.status,'insufficient');assert.equal(short.fit.meanReturnPercent,null);assert.equal(short.validation.pValue,null);assert.equal(short.diagnostics.find(item=>item.id==='familywise').actual,null);assert.equal(short.diagnostics.find(item=>item.id==='familywise').passed,false);assert.equal(short.diagnostics.find(item=>item.id==='validation_sampleCount').threshold,60);
});

test('pure evaluation and validation neither mutate raw inputs nor request external data',t=>{
  const f=fixture(),before=structuredClone(f);t.mock.method(globalThis,'fetch',()=>{throw Error('offline pure validation');});evaluateEntryOutcome(f);assert.deepEqual(f,before);
  const dates=calendar(500),input=events(dates),original=structuredClone(input);validateEntryEvents(input,dates);assert.deepEqual(input,original);
});


test('entry intervals are reserved at T even when the first future exit later becomes unexecutable',()=>{
  const f=fixture(100);f.setup.id='600000.SH:first';f.setup.patternIds=['regain-ma-20'];
  f.bars[72]=bar(f.dates[72],{open:99.5,high:101,low:98,close:100.5});f.bars[73]=bar(f.dates[73],{open:100.5,high:103,low:100,close:102,volume:1100});f.bars[74]=bar(f.dates[74],{open:102,high:104,low:101,close:103.5});
  const later={...f.setup,id:'600000.SH:later',formation:{...f.bars[72]},keyBar:{...f.bars[73]},observedEvent:{date:f.dates[74]}};
  const setups=[later,f.setup],before=structuredClone(setups),initial=reserveEntryIntervals(setups,f.dates);
  assert.equal(evaluateEntryOutcome(f).status,'ready');assert.equal(evaluateEntryOutcome({...f,setup:later}).status,'ready');
  assert.deepEqual(initial.get(f.setup.id).acceptedPatternIds,['regain-ma-20']);assert.deepEqual(initial.get(later.id).overlapPatternIds,['regain-ma-20']);
  f.bars[78]={date:f.dates[78],open:90,high:90,low:90,close:90,volume:1000};
  assert.equal(evaluateEntryOutcome(f).status,'unexecutable');assert.equal(evaluateEntryOutcome({...f,setup:later}).status,'ready');
  assert.deepEqual(reserveEntryIntervals(setups,f.dates),initial);assert.deepEqual(setups,before);
  f.bars[78]=null;assert.equal(evaluateEntryOutcome(f).status,'unavailable');assert.deepEqual(reserveEntryIntervals(setups,f.dates),initial);
});

test('reservations include the fifteenth session, are pattern-specific, and pending holds do not free space',()=>{
  const dates=calendar(150),setup=(id,index,patternIds,replayStatus='triggered_observation')=>({id,patternIds,replayStatus,observedEvent:{date:dates[index]}});
  const input=[setup('first',100,['regain-ma-20']),setup('same-exit-day',115,['regain-ma-20','volume-expand']),setup('following-day',116,['regain-ma-20']),setup('pending',140,['regain-ma-20']),setup('pending-later',145,['regain-ma-20']),setup('not-triggered',99,['regain-ma-20'],'waiting_trigger')];
  const result=reserveEntryIntervals(input,dates);
  assert.deepEqual(result.get('first').acceptedPatternIds,['regain-ma-20']);assert.deepEqual(result.get('same-exit-day'),{acceptedPatternIds:['volume-expand'],overlapPatternIds:['regain-ma-20']});assert.deepEqual(result.get('following-day').acceptedPatternIds,['regain-ma-20']);
  assert.deepEqual(result.get('pending').acceptedPatternIds,['regain-ma-20']);assert.deepEqual(result.get('pending-later').overlapPatternIds,['regain-ma-20']);assert.equal(result.has('not-triggered'),false);
  const shorter=reserveEntryIntervals(input.slice(0,3),dates.slice(0,117));assert.deepEqual(shorter.get('same-exit-day'),result.get('same-exit-day'));assert.deepEqual(shorter.get('following-day'),result.get('following-day'));
});
