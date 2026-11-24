import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {analyzeEntryBars,entryPolicy,entryPolicyVersion} from '../server/a-share-entry-bars.mjs';

const require=createRequire(import.meta.url),patterns=require('../screening/trend-patterns.js');
function calendar(count){
  const dates=[];
  for(let time=Date.UTC(2024,0,1);dates.length<count;time+=86400000){const date=new Date(time);if(date.getUTCDay()!==0&&date.getUTCDay()!==6)dates.push(date.toISOString().slice(0,10));}
  return dates;
}
const candle=(date,changes={})=>({date,open:100,high:101,low:99,close:100,volume:1000,...changes});
function fixture(count=65){
  const dates=calendar(count+1),day=dates[count-1],asOf=day+'T08:00:00.000Z';
  const input={stock:{code:'600000.SH',name:'研究样本'},bars:dates.slice(0,count).map(date=>candle(date)),calendar:dates.slice(0,count),patterns,
    day,asOf,sourceId:'test-offline-qfq',generation:day+'-1',sourceFetchedAt:asOf,policyKnownAt:dates[0]+'T00:00:00.000Z',nextSessionDay:dates[count],now:()=>Date.parse(asOf)+1000};
  input.matches=({day:target,bars,calendar:actual,lookback})=>{assert.equal(bars.length,61);assert.equal(bars.at(-1).date,target);assert.equal(lookback,20);assert.deepEqual(bars.map(bar=>bar.date),actual.map(bar=>bar.date));assert(bars.every(bar=>bar.date<=target));return target===dates[61]?['regain-ma-20']:[];};
  input.bars[61]=candle(dates[61],{open:99.5,high:101,low:98,close:100.5});
  if(count>62)input.bars[62]=candle(dates[62],{open:100.5,high:103,low:100,close:102,volume:1100});
  if(count>63)input.bars[63]=candle(dates[63],{open:102,high:104,low:101,close:103.5});
  return {input,dates,run:changes=>analyzeEntryBars({...input,...changes})};
}

test('F, closing C and next-session T stay separate and use only closed 61-bar prefixes',()=>{
  const f=fixture(),result=f.run(),setup=result.setups[0];
  assert.equal(result.entryPolicyVersion,entryPolicyVersion);assert.equal(setup.formation.date,f.dates[61]);assert.equal(setup.keyBar.date,f.dates[62]);
  assert.equal(setup.keyBar.knownAfter,f.dates[62]+'T15:00:00+08:00');assert.equal(setup.trigger.validFrom,f.dates[63]);
  assert.equal(setup.observedEvent.date,f.dates[63]);assert.equal(setup.replayStatus,'triggered_observation');assert.equal(setup.observedEvent.mode,'intraday_range_only');
  assert.equal(setup.observedEvent.exactIntradayTimeKnown,false);assert.equal(setup.observedEvent.knownAfter,f.dates[63]+'T15:00:00+08:00');
  assert.equal(setup.invalidation.below,98);assert.equal(setup.trigger.above,103);assert.equal(setup.confirmation.volumeMean20,1000);
  assert.equal(setup.entryOutcomeValidated,false);assert.equal(setup.recommended,false);assert.doesNotMatch(JSON.stringify(result),/"(?:returnPercent|entryPrice|profit|fillPrice)"/);
});

test('last candle F has no invented confirmation, while last candle C only watches next verified session',()=>{
  const formed=fixture(62),f=formed.run().setups[0];
  assert.equal(f.replayStatus,'waiting_confirmation');assert.equal(f.keyBar,null);assert.equal(f.trigger,null);assert.equal(f.remainingSessions,3);
  const confirmed=fixture(63),result=confirmed.run(),c=result.current[0];
  assert.equal(c.replayStatus,'waiting_trigger');assert.equal(c.observedEvent,null);assert.equal(c.keyBar.date,confirmed.input.day);assert.equal(c.trigger.validFrom,confirmed.input.nextSessionDay);
  assert.equal(c.monitoring.status,'future_condition_watch');assert.equal(c.remainingSessions,3);assert.equal(result.summary.triggeredObservations,0);
  assert.equal(confirmed.run({nextSessionDay:null}).current[0].monitoring.status,'next_session_unknown');
  const opening=Date.parse(confirmed.input.nextSessionDay+'T10:00:00+08:00');
  assert.equal(confirmed.run({now:()=>opening}).current[0].monitoring.status,'requires_fresh_data');
});

test('confirmation requires every approved condition and expires after exactly three sessions',()=>{
  for(const changes of [{close:101},{open:102,close:102},{volume:999}]){
    const f=fixture(65);f.input.bars[62]=candle(f.dates[62],{open:100.5,high:103,low:99,close:102,volume:1100,...changes});
    f.input.bars[63]=candle(f.dates[63]);f.input.bars[64]=candle(f.dates[64]);
    const setup=f.run().setups[0];assert.equal(setup.keyBar,null);assert.equal(setup.replayStatus,'expired');
  }
  const belowMa=fixture(65);
  for(let i=43;i<61;i++)belowMa.input.bars[i]=candle(belowMa.dates[i],{open:110,high:111,low:109,close:110});
  belowMa.input.bars[63]=candle(belowMa.dates[63]);belowMa.input.bars[64]=candle(belowMa.dates[64]);
  assert.equal(belowMa.run().setups[0].keyBar,null);
  const boundary=fixture(65);boundary.input.bars[62]=candle(boundary.dates[62]);boundary.input.bars[63]=candle(boundary.dates[63]);
  boundary.input.bars[64]=candle(boundary.dates[64],{open:100,high:104,low:99,close:103,volume:1000});
  assert.equal(boundary.run().setups[0].keyBar.date,boundary.dates[64]);
});

test('trigger never uses the confirmation candle and equality does not trigger; three-session expiry is fixed',()=>{
  const f=fixture(66);
  for(let i=63;i<66;i++)f.input.bars[i]=candle(f.dates[i],{open:102,high:103,low:101,close:102});
  const setup=f.run().setups[0];assert.equal(setup.replayStatus,'expired');assert.equal(setup.trigger.expiresOn,f.dates[65]);assert.equal(setup.observedEvent,null);
  const boundary=fixture(66);boundary.input.bars[63]=f.input.bars[63];boundary.input.bars[64]=f.input.bars[64];boundary.input.bars[65]=candle(boundary.dates[65],{open:102,high:104,low:101,close:103.5});
  assert.equal(boundary.run().setups[0].observedEvent.date,boundary.dates[65]);
});

test('opening chase, known opening gap, open invalidation and ambiguous daily order are explicit',()=>{
  const scenarios=[
    [{open:105.07,high:107,low:104,close:106},'chased'],
    [{open:105.06,high:107,low:104,close:106},'triggered_observation'],
    [{open:97,high:104,low:96,close:100},'invalidated'],
    [{open:102,high:104,low:97,close:103},'ambiguous'],
    [{open:102,high:103,low:97,close:102},'invalidated']
  ];
  for(const [changes,status]of scenarios){const f=fixture(64);f.input.bars[63]=candle(f.dates[63],changes);assert.equal(f.run().setups[0].replayStatus,status);}
  const gap=fixture(64);gap.input.bars[63]=candle(gap.dates[63],{open:104,high:105,low:103.5,close:104.5});
  const setup=gap.run().setups[0];assert.equal(setup.observedEvent.mode,'opening_gap');assert.equal(setup.observedEvent.knownAfter,gap.dates[63]+'T09:30:00+08:00');
});

test('fixed F invalidation is never lowered by later candles or hindsight',()=>{
  const earlier=fixture(63),initial=earlier.run().setups[0];
  const later=fixture(64);later.input.bars[63]=candle(later.dates[63],{open:100,high:102,low:97,close:99});
  const invalid=later.run().setups[0];assert.equal(invalid.invalidation.below,initial.invalidation.below);assert.equal(invalid.replayStatus,'invalidated');
  assert.deepEqual(invalid.keyBar,initial.keyBar);assert.deepEqual(invalid.formation,initial.formation);
  const future=fixture(70),after=future.run().setups[0];
  assert.deepEqual(after.keyBar,initial.keyBar);assert.deepEqual(after.formation,initial.formation);assert.equal(after.observedEvent.date,future.dates[63]);
});

test('suspension, missing day and one-price candles do not become tradable signals',()=>{
  for(const index of [62,63]){
    const halted=fixture(65);halted.input.bars[index].volume=0;assert.equal(halted.run().setups[0].replayStatus,'unavailable');
    const missing=fixture(65);missing.input.bars.splice(index,1);assert.equal(missing.run().setups[0].replayStatus,'unavailable');
  }
  for(const index of [61,62,63]){
    const f=fixture(65);f.input.bars[index]=candle(f.dates[index],{open:102,high:102,low:102,close:102});
    assert.equal(f.run().setups[0].replayStatus,'unexecutable');
  }
  const gap=fixture(70);gap.input.bars[60].volume=0;assert.equal(gap.run().setups.length,0);
});

test('late source or newly introduced policy cannot retrospectively authorize an earlier opening',()=>{
  const f=fixture(64);
  for(const name of ['sourceFetchedAt','policyKnownAt']){
    const timely={sourceFetchedAt:f.dates[62]+'T07:30:00.000Z',policyKnownAt:f.dates[60]+'T07:30:00.000Z'};
    const early=f.run(timely).setups[0];assert.equal(early.lateDiscovery,false);assert.equal(early.status,'triggered_observation');
    const late=f.run({...timely,[name]:f.dates[63]+'T01:31:00.000Z'}).setups[0];
    assert.equal(late.lateDiscovery,true);assert.equal(late.status,'late_discovery');assert.equal(late.replayStatus,'triggered_observation');assert.equal(late.recommended,false);
  }
  const pending=fixture(64);pending.input.bars[63]=candle(pending.dates[63],{open:102,high:103,low:101,close:102});
  const watched=pending.run().current[0];assert.equal(watched.status,'late_discovery');assert.equal(watched.replayStatus,'waiting_trigger');assert.equal(watched.monitoring.remainingSessions,2);assert.equal(watched.monitoring.status,'future_condition_watch');
  assert(watched.recommendationReasons.some(reason=>reason.includes('晚于首个目标开盘')));
  assert.equal(f.run({sourceFetchedAt:null}).setups[0].knownAt,null);assert.equal(pending.run({sourceFetchedAt:null}).current[0].monitoring.status,'knowledge_time_unknown');
});

test('zero effective shapes and even a passing old shape never validate the independent entry model',()=>{
  const f=fixture(64),zero=f.run(),oldPassing=f.run({effectivePatternIds:['regain-ma-20']});
  assert.equal(zero.setups[0].patternGatePassed,false);assert.equal(oldPassing.setups[0].patternGatePassed,true);
  for(const result of [zero,oldPassing]){assert.equal(result.recommended,false);assert.equal(result.summary.recommendedCount,0);assert.equal(result.entryOutcomeValidated,false);assert(result.setups.every(item=>item.recommended===false));assert.match(result.method.outcomes,/不引用原次日开盘/);}
});

test('real fixed catalogue runs on 500 bars without input mutation, external requests or profile changes',t=>{
  const f=fixture(500),before=structuredClone({bars:f.input.bars,calendar:f.input.calendar,profile:patterns.profile});
  t.mock.method(globalThis,'fetch',()=>{throw Error('offline research must not request');});
  const result=f.run({matches:null});
  assert.equal(result.coverage.sourceBars,500);assert.equal(result.coverage.currentDayValid,true);assert.equal(result.recommended,false);
  assert.deepEqual(f.input.bars,before.bars);assert.deepEqual(f.input.calendar,before.calendar);assert.deepEqual(patterns.profile,before.profile);assert.equal(patterns.definitions.length,16);assert.equal(entryPolicy.confirmationSessions,3);
  f.input.bars.pop();const partial=f.run();assert.equal(partial.coverage.currentDayValid,false);assert.equal(partial.setups[0].formation.date,f.dates[61]);
});

test('future, duplicate, wrong basis and unbound knowledge times fail instead of contaminating replay',()=>{
  const f=fixture();
  assert.throws(()=>f.run({bars:[...f.input.bars,candle(f.dates[65])]}),/未来数据/);
  assert.throws(()=>f.run({calendar:[...f.input.calendar,f.dates[65]]}),/日历/);
  const duplicate=structuredClone(f.input.bars);duplicate[20].date=duplicate[19].date;
  assert.throws(()=>f.run({bars:duplicate}),/日期重复/);
  assert.throws(()=>f.run({sourceAdjustment:'raw'}),/前复权/);
  assert.throws(()=>f.run({sourceFetchedAt:'not-a-date'}),/来源读取/);
  assert.throws(()=>f.run({policyKnownAt:f.dates[65]+'T08:00:00.000Z'}),/规则生效/);
  assert.throws(()=>f.run({asOf:f.dates[65]+'T08:00:00.000Z'}),/已收盘日期/);
  assert.throws(()=>f.run({asOf:f.input.day+'T06:59:59.000Z'}),/已收盘日期/);
  assert.throws(()=>f.run({matches:()=>['unknown-shape']}),/未知/);
  assert.throws(()=>f.run({effectivePatternIds:['unknown-shape']}),/形态身份/);
  assert.throws(()=>f.run({nextSessionDay:f.input.day}),/下一交易日/);
});
