import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {buildCloseCandidates,closeCandidateVersion,closeCandidatePolicy} from '../server/a-share-entry-current.mjs';
import {entryPolicy,analyzeEntryBars} from '../server/a-share-entry-bars.mjs';
import {entryValidationPolicy} from '../server/a-share-entry-validation.mjs';

const require=createRequire(import.meta.url),patterns=require('../screening/trend-patterns.js'),engine=require('../screening/trend-screen.js');
function calendar(count){const dates=[];for(let time=Date.UTC(2024,0,1);dates.length<count;time+=86400000){const day=new Date(time);if(day.getUTCDay()!==0&&day.getUTCDay()!==6)dates.push(day.toISOString().slice(0,10));}return dates;}
const candle=(date,changes={})=>({date,open:100,high:101,low:99,close:100,volume:1000,...changes});
function fixture(stage='triggered',count=stage==='waiting'?63:64){
  const allDates=calendar(count+1),dates=allDates.slice(0,count),day=dates.at(-1),bars=dates.map(date=>candle(date)),reference=dates.map(date=>candle(date));
  bars[61]=candle(dates[61],{open:99.5,high:101,low:98,close:100.5});
  bars[62]=candle(dates[62],{open:100.5,high:103,low:100,close:102,volume:1100});
  if(count>63)bars[63]=candle(dates[63],stage==='waiting'?{open:102,high:103,low:101,close:102}:{open:102,high:104,low:101,close:103.5});
  const knownAt=day+'T07:10:00.000Z',setup={id:'600000.SH:'+dates[61],patternIds:['regain-ma-20'],formation:{...bars[61]},keyBar:{...bars[62]},
    trigger:{above:103,priceBasis:'qfq_research_reference'},invalidation:{below:98,priceBasis:'qfq_research_reference'},knownAt,
    replayStatus:stage==='waiting'?'waiting_trigger':'triggered_observation',observedEvent:stage==='waiting'?null:{date:dates[63]},remainingSessions:stage==='waiting'?3-(count-1-62):0};
  return {stock:{code:'600000.SH',name:'收盘研究测试'},bars,reference,dates,setups:[setup],strength:{status:'ready',matched:true},day,asOf:day+'T07:00:00.000Z',
    sourceFetchedAt:day+'T07:05:00.000Z',computedAt:day+'T08:00:00.000Z',nextSessionDay:allDates[count],entryEffectiveIds:[],shapeEffectiveIds:[]};
}

function lifecycleFixture(stage,offset){
  const f=fixture('waiting',65+offset);
  for(let index=61;index<f.bars.length;index++)f.bars[index]=candle(f.dates[index]);
  f.bars[61]=candle(f.dates[61],{open:99.8,high:101,low:98,close:99.5});
  f.bars[64]=candle(f.dates[64],{open:100.5,high:103,low:100,close:102,volume:1100});
  for(let index=65;index<f.bars.length;index++)f.bars[index]=candle(f.dates[index],{open:102,high:103,low:101,close:102});
  if(stage==='triggered')f.bars[f.bars.length-1]=candle(f.day,{open:102,high:104,low:101,close:103.5});
  const replay=analyzeEntryBars({stock:f.stock,bars:f.bars,calendar:f.dates,patterns,matches:input=>input.day===f.dates[61]?['regain-ma-20']:[],day:f.day,asOf:f.asOf,
    sourceId:'tickflow-free-forward-v1',generation:f.day+'-1',sourceFetchedAt:f.sourceFetchedAt,policyKnownAt:f.dates[60]+'T07:00:00Z',nextSessionDay:f.nextSessionDay,now:()=>Date.parse(f.computedAt)});
  f.setups=replay.setups;f.strength=engine.evaluate({mode:'strength',bars:f.bars.slice(-61),referenceBars:f.reference.slice(-61),day:f.day,lookback:20});
  return f;
}

test('v2 preserves the original stage windows, horizon and opening-chase policy without a global formation-age cap',()=>{
  assert.equal(closeCandidateVersion,'books.entry-current.2026-11-24.v2');assert(Object.isFrozen(closeCandidatePolicy));
  assert.deepEqual(closeCandidatePolicy,{maxDistancePercent:2,confirmationSessions:3,triggerSessions:3,horizon:15,closeEntryValidated:false});
  assert.equal(Object.hasOwn(closeCandidatePolicy,'formedWithinDays'),false);assert.equal(entryValidationPolicy.formedWithinDays,3);assert.equal(entryPolicy.maxOpeningChasePercent,2);
});

test('today first T that remains above its key at the close becomes a research candidate, never an executed buy',()=>{
  const f=fixture(),items=buildCloseCandidates(f);assert.equal(items.length,1);
  const item=items[0];assert.equal(item.stage,'triggered_at_close');assert.equal(item.closePrice,103.5);assert.equal(item.remainingSessions,0);assert.equal(item.nearTrigger,true);
  assert.equal(item.knownAfter,f.day+'T15:00:00+08:00');assert.equal(item.actualDiscoveryAt,f.computedAt);assert.equal(item.sourceFetchedAt,f.sourceFetchedAt);
  assert.equal(item.activeUntil,f.nextSessionDay+'T09:30:00+08:00');assert.equal(item.requiresRecheck,true);assert.equal(item.actualFillVerified,false);assert.equal(item.closeEntryValidated,false);
  assert.equal(item.qualified,false);assert.equal(item.qualification,'research');assert.equal(item.formationAgeSessions,2);assert.equal(item.keyBarDay,f.dates[62]);assert.match(item.reasons.join(' '),/尚未独立验证/);
  assert.doesNotMatch(JSON.stringify(item),/"(?:bars|open|high|low|close|volume)"/);
});

test('a valid confirmed C awaiting a future break remains distinct and keeps the original remaining window',()=>{
  for(const count of [63,64]){
    const f=fixture('waiting',count),items=buildCloseCandidates(f);assert.equal(items.length,1);
    assert.equal(items[0].stage,'waiting_breakout');assert.equal(items[0].remainingSessions,3-(count-1-62));
    assert(items[0].distanceToTriggerPct<=0&&items[0].distanceToTriggerPct>=-2);
  }
});

test('C confirmed on F+3 and its still-valid waiting window are not cut off by the age of F',()=>{
  for(const offset of [0,2]){
    const f=lifecycleFixture('waiting',offset);assert.equal(f.setups[0].replayStatus,'waiting_trigger');assert.equal(f.strength.matched,true);
    const [item]=buildCloseCandidates(f);assert(item);assert.equal(item.stage,'waiting_breakout');assert.equal(item.formationAgeSessions,3+offset);
    assert.equal(item.remainingSessions,3-offset);assert.equal(item.nearTrigger,true);
  }
});

test('the first valid T on F+4 and F+6 follows the original C+3 trigger limit with original strength intact',()=>{
  for(const offset of [1,3]){
    const f=lifecycleFixture('triggered',offset);assert.equal(f.setups[0].replayStatus,'triggered_observation');assert.equal(f.strength.matched,true);
    const [item]=buildCloseCandidates(f);assert(item);assert.equal(item.stage,'triggered_at_close');assert.equal(item.formationAgeSessions,3+offset);
    assert.equal(item.remainingSessions,0);assert.equal(item.nearTrigger,true);assert.equal(item.actualFillVerified,false);
  }
});

test('expired C windows and a forced T later than C+3 stay excluded without a formation-age shortcut',()=>{
  const waiting=lifecycleFixture('waiting',3);assert.equal(waiting.setups[0].replayStatus,'expired');assert.deepEqual(buildCloseCandidates(waiting),[]);
  waiting.setups[0].replayStatus='waiting_trigger';waiting.setups[0].remainingSessions=1;assert.deepEqual(buildCloseCandidates(waiting),[]);
  const late=lifecycleFixture('triggered',4);assert.equal(late.setups[0].replayStatus,'expired');assert.deepEqual(buildCloseCandidates(late),[]);
  late.setups[0].replayStatus='triggered_observation';late.setups[0].observedEvent={date:late.day};assert.deepEqual(buildCloseCandidates(late),[]);
});

test('formation-only F, historical B, S and MA5 add/reduce observations cannot populate the current pool',()=>{
  const f=fixture(),setup=f.setups[0];
  for(const replayStatus of ['waiting_confirmation','expired','invalidated','unexecutable','ambiguous','chased','S','ADD','REDUCE'])assert.deepEqual(buildCloseCandidates({...f,setups:[{...setup,replayStatus}]}),[],replayStatus);
  const old=fixture('triggered',65);assert.deepEqual(buildCloseCandidates(old),[]);
  assert.deepEqual(buildCloseCandidates({...f,setups:[{...setup,keyBar:null,trigger:null}]}),[]);
});

test('intraday touches that close back at or below the key, and any fixed invalidation breach, are excluded',()=>{
  for(const close of [103,102.9]){const f=fixture();f.bars[63].close=close;assert.deepEqual(buildCloseCandidates(f),[]);}
  const invalid=fixture();invalid.bars[63].low=97;assert.deepEqual(buildCloseCandidates(invalid),[]);
  const waiting=fixture('waiting',64);waiting.bars[63].low=97;assert.deepEqual(buildCloseCandidates(waiting),[]);
});

test('today T retains its exact two-percent close cap while waiting C is tagged near or far at that boundary',()=>{
  const exact=fixture();exact.bars[63]=candle(exact.day,{open:102,high:106,low:101,close:105.06});assert.equal(buildCloseCandidates(exact).length,1);
  exact.bars[63].close=105.060001;assert.deepEqual(buildCloseCandidates(exact),[]);
  const waiting=fixture('waiting',64);waiting.bars[63]=candle(waiting.day,{open:102,high:103,low:100,close:100.94});assert.equal(buildCloseCandidates(waiting)[0].nearTrigger,true);
  waiting.bars[63].close=100.939999;const [far]=buildCloseCandidates(waiting);assert(far);assert.equal(far.nearTrigger,false);assert.equal(far.qualified,false);
});

test('far but valid C remains a research observation even when the same pattern passes both original gates',()=>{
  const f=fixture('waiting');f.bars[62]=candle(f.day,{open:100.5,high:110,low:100,close:104,volume:1100});
  f.setups[0].keyBar={...f.bars[62]};f.setups[0].trigger.above=110;
  f.strength=engine.evaluate({mode:'strength',bars:f.bars.slice(-61),referenceBars:f.reference.slice(-61),day:f.day,lookback:20});assert.equal(f.strength.matched,true);
  const [item]=buildCloseCandidates({...f,entryEffectiveIds:['regain-ma-20'],shapeEffectiveIds:['regain-ma-20']});
  assert(item);assert.equal(item.stage,'waiting_breakout');assert.equal(item.nearTrigger,false);assert(item.distanceToTriggerPct< -2);
  assert.equal(item.patternGatePassed,true);assert.equal(item.entryGatePassed,true);assert.deepEqual(item.eligiblePatternIds,['regain-ma-20']);
  assert.equal(item.qualified,false);assert.equal(item.qualification,'research');assert.match(item.reasons.join(' '),/远距离研究观察/);
  assert.doesNotMatch(item.reasons.join(' '),/没有同一形态/);assert.equal(item.closeEntryValidated,false);
});

test('the original opening-chase exclusion still rejects a later close inside the new distance cap',()=>{
  const f=fixture();f.bars[63]=candle(f.day,{open:105.07,high:106,low:103.5,close:104});assert.deepEqual(buildCloseCandidates(f),[]);
});

test('waiting-breakout cannot hide an earlier intraday trigger or substitute an invalid confirmation candle',()=>{
  const f=fixture('waiting',64);f.bars[63].high=104;assert.deepEqual(buildCloseCandidates(f),[]);
  const weak=fixture('waiting');weak.bars[62].volume=999;assert.deepEqual(buildCloseCandidates(weak),[]);
  const noConfirmation=fixture('waiting');noConfirmation.bars[62].close=101;assert.deepEqual(buildCloseCandidates(noConfirmation),[]);
  const wrongWindow=fixture('waiting',64);wrongWindow.setups[0].remainingSessions=3;assert.deepEqual(buildCloseCandidates(wrongWindow),[]);
});

test('original strength failure is never relaxed by the broader lifecycle or distance observation pool',()=>{
  const f=fixture();for(const strength of [null,{matched:false},{status:'unavailable'}])assert.deepEqual(buildCloseCandidates({...f,strength}),[]);
  const far=fixture('waiting');far.bars[62]=candle(far.day,{open:100.5,high:110,low:100,close:104,volume:1100});far.setups[0].keyBar={...far.bars[62]};far.setups[0].trigger.above=110;
  assert.deepEqual(buildCloseCandidates({...far,strength:{matched:false}}),[]);
});

test('qualification requires the identical pattern ID to pass both original and independent gates',()=>{
  const f=fixture();f.setups[0].patternIds=['regain-ma-20','volume-expand'];
  const split=buildCloseCandidates({...f,entryEffectiveIds:['regain-ma-20'],shapeEffectiveIds:['volume-expand']})[0];
  assert.equal(split.entryGatePassed,true);assert.equal(split.patternGatePassed,true);assert.deepEqual(split.eligiblePatternIds,[]);assert.equal(split.qualified,false);assert.match(split.reasons.join(' '),/同一形态/);
  const both=buildCloseCandidates({...f,entryEffectiveIds:new Set(['regain-ma-20']),shapeEffectiveIds:new Set(['regain-ma-20'])})[0];
  assert.equal(both.qualified,true);assert.equal(both.qualification,'qualified_watch');assert.deepEqual(both.eligiblePatternIds,['regain-ma-20']);assert.equal(both.closeEntryValidated,false);
});

test('unknown, stale, future or pre-close knowledge never becomes a current candidate',()=>{
  const f=fixture();
  for(const change of [{sourceFetchedAt:null},{sourceFetchedAt:f.day+'T06:59:00Z'},{asOf:f.day+'T06:59:00Z'},{asOf:f.day+'T07:06:00Z'},{computedAt:f.day+'T07:01:00Z'},{computedAt:f.nextSessionDay+'T01:30:00Z'},{nextSessionDay:null},{nextSessionDay:f.day}])assert.deepEqual(buildCloseCandidates({...f,...change}),[],JSON.stringify(change));
  for(const knownAt of [null,'unknown',f.day+'T09:00:00Z'])assert.deepEqual(buildCloseCandidates({...f,setups:[{...f.setups[0],knownAt}]}),[]);
  assert.deepEqual(buildCloseCandidates({...f,asOf:f.day+'T06:00:00Z',sourceFetchedAt:f.day+'T06:00:00Z',computedAt:f.day+'T06:00:00Z'}),[]);
});

test('one-price, missing, halted, unaligned or incomplete recent source/reference bars are never guessed',()=>{
  for(const mode of ['one-price','missing','halted','unaligned','reference']){
    const f=fixture();
    if(mode==='one-price')f.bars[63]=candle(f.day,{open:104,high:104,low:104,close:104});
    if(mode==='missing')f.bars[50]=null;
    if(mode==='halted')f.bars[50].volume=0;
    if(mode==='unaligned')f.bars[50].date=f.dates[51];
    if(mode==='reference')f.reference[50]=null;
    assert.deepEqual(buildCloseCandidates(f),[],mode);
  }
  const f=fixture();assert.deepEqual(buildCloseCandidates({...f,bars:f.bars.slice(-60),reference:f.reference.slice(-60),dates:f.dates.slice(-60)}),[]);
});

test('future appended candles and future reported events cannot enter a frozen close batch',()=>{
  const f=fixture(),original=buildCloseCandidates(f),tomorrow=f.nextSessionDay;
  assert.deepEqual(buildCloseCandidates({...f,bars:[...f.bars,candle(tomorrow)],reference:[...f.reference,candle(tomorrow)],dates:[...f.dates,tomorrow]}),[]);
  assert.deepEqual(buildCloseCandidates({...f,setups:[{...f.setups[0],observedEvent:{date:tomorrow}}]}),[]);
  assert.deepEqual(buildCloseCandidates(f),original);
});

test('old or unknown setups cannot terminate iteration before a later legitimate current setup',()=>{
  const f=fixture(),valid=f.setups[0],unknown={...valid,knownAt:null};
  const old={...valid,formation:{...valid.formation,date:f.dates[10]}};
  assert.deepEqual(buildCloseCandidates({...f,setups:[old,unknown,valid]}),buildCloseCandidates(f));
});

test('derivation is offline and leaves candles, historical setup metadata and gate inputs unchanged',t=>{
  const f=fixture(),before=structuredClone(f);t.mock.method(globalThis,'fetch',()=>{throw Error('current candidates must not fetch');});
  buildCloseCandidates(f);assert.deepEqual(f,before);assert.deepEqual(buildCloseCandidates({...f,setups:[]}),[]);
});
