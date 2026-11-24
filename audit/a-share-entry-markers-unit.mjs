import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildEntryMarkers,entryMarkerVersion} from '../server/a-share-entry-markers.mjs';

function calendar(count){const days=[];for(let time=Date.UTC(2024,0,1);days.length<count;time+=86400000){const day=new Date(time);if(day.getUTCDay()!==0&&day.getUTCDay()!==6)days.push(day.toISOString().slice(0,10));}return days;}
const bar=(date,changes={})=>({date,open:100,high:101,low:99,close:100,volume:1000,...changes});
function fixture(count=100){
  const dates=calendar(count),bars=dates.map(day=>bar(day)),reference=dates.map(day=>bar(day));
  bars[61]=bar(dates[61],{open:99.5,high:101,low:98,close:100.5});
  bars[62]=bar(dates[62],{open:100.5,high:103,low:100,close:102,volume:1100});
  bars[63]=bar(dates[63],{open:102,high:104,low:101,close:103.5});
  const setup={id:'600000.SH:'+dates[61],patternIds:['regain-ma-20'],replayStatus:'triggered_observation',status:'late_discovery',
    formation:{...bars[61]},keyBar:{...bars[62]},observedEvent:{date:dates[63]},trigger:{above:103},invalidation:{below:98},
    knownAt:dates.at(-1)+'T08:00:00Z',lateDiscovery:true};
  return {setups:[setup],bars,reference,dates};
}
const selected=(input,kind)=>buildEntryMarkers(input).markers.filter(marker=>marker.kind===kind);

test('B reuses the first real T and S uses the fixed fifteenth following close, never a hindsight peak',()=>{
  const f=fixture();f.bars[69]=bar(f.dates[69],{open:119,high:121,low:118,close:120});
  f.bars[78]=bar(f.dates[78],{open:107,high:110,low:106,close:109});
  const result=buildEntryMarkers(f),buy=result.markers.find(marker=>marker.kind==='B'),sell=result.markers.find(marker=>marker.kind==='S');
  assert.equal(result.version,entryMarkerVersion);assert.equal(buy.day,f.dates[63]);assert.equal(buy.referencePrice,103);
  assert.equal(sell.day,f.dates[78]);assert.equal(sell.referencePrice,109);assert.match(sell.reason,/第15/);assert.notEqual(sell.day,f.dates[69]);
  for(const marker of result.markers){assert.equal(marker.state,'research');assert.equal(marker.recommended,false);assert.equal(marker.actualFillVerified,false);assert.equal(marker.independentlyValidated,false);}
});

test('every historical marker is prefix-stable without looking at future prices or outcome maturity',()=>{
  const f=fixture();f.bars[65]=bar(f.dates[65],{open:101,high:104,low:100,close:103});
  const full=buildEntryMarkers(f);
  for(const count of [62,63,64,65,66,70,78,79,90]){
    const prefix={...f,bars:f.bars.slice(0,count),reference:f.reference.slice(0,count),dates:f.dates.slice(0,count)},last=prefix.dates.at(-1);
    const actual=buildEntryMarkers(prefix);
    assert.deepEqual(actual.markers,full.markers.filter(marker=>marker.day<=last),String(count));
    assert.deepEqual(actual.groups,full.groups.filter(group=>group.day<=last),String(count));
  }
  const before=selected(f,'B');f.bars[78]=null;assert.deepEqual(selected(f,'B'),before);
});

test('a missing, halted, unaligned, benchmark-missing, or not-yet-mature exit never creates S',()=>{
  for(const mode of ['missing','halted','unaligned','benchmark']){
    const f=fixture();
    if(mode==='missing')f.bars[67]=null;
    if(mode==='halted')f.bars[67].volume=0;
    if(mode==='unaligned')f.bars[67].date=f.dates[68];
    if(mode==='benchmark')f.reference[67]=null;
    assert.equal(selected(f,'S').length,0,mode);assert.equal(selected(f,'B').length,1,mode);
  }
  assert.equal(selected(fixture(78),'S').length,0);assert.equal(selected(fixture(79),'S').length,1);
});

test('a one-price falling fifteenth day cannot masquerade as an executable sell reference',()=>{
  const f=fixture();f.bars[78]=bar(f.dates[78],{open:90,high:90,low:90,close:90});
  assert.equal(selected(f,'B').length,1);assert.equal(selected(f,'S').length,0);
});

test('fake, chased, ambiguous and same-confirmation-day trigger references do not manufacture B',()=>{
  for(const mode of ['equality','chase','ambiguous','same-day']){
    const f=fixture();
    if(mode==='equality'){f.bars[63].high=103;f.bars[63].close=102.5;}
    if(mode==='chase')f.bars[63]=bar(f.dates[63],{open:105.07,high:107,low:104,close:106});
    if(mode==='ambiguous')f.bars[63].low=97;
    if(mode==='same-day')f.setups[0].observedEvent.date=f.dates[62];
    assert.equal(buildEntryMarkers(f).markers.length,0,mode);
  }
});

test('daily +/- use strict close-to-MA5 first crossings only inside an existing B observation window',()=>{
  const f=fixture();f.bars[65]=bar(f.dates[65],{open:101,high:104,low:100,close:103});
  const adds=selected(f,'ADD'),reductions=selected(f,'REDUCE');
  assert(adds.some(marker=>marker.day===f.dates[65]));assert(reductions.some(marker=>marker.day===f.dates[64]));
  for(const marker of [...adds,...reductions]){assert(marker.day>f.dates[63]&&marker.day<f.dates[78]);assert.equal(marker.knownAfter,marker.day+'T15:00:00+08:00');assert.match(marker.reason,/未独立验证/);}
  f.setups[0].replayStatus='waiting_trigger';assert.equal(buildEntryMarkers(f).markers.length,0);
});

test('separate daily crossings may repeat within the same window without being described as a once-only signal',()=>{
  const f=fixture();
  for(const index of [65,67])f.bars[index]=bar(f.dates[index],{open:101,high:104,low:100,close:103});
  const adds=selected(f,'ADD'),reductions=selected(f,'REDUCE');
  assert.deepEqual(adds.map(marker=>marker.day),[f.dates[65],f.dates[67]]);
  assert(reductions.some(marker=>marker.day===f.dates[64]));assert(reductions.some(marker=>marker.day===f.dates[66]));
  for(const marker of [...adds,...reductions])assert.doesNotMatch(marker.reason,/首次/);
});

test('ADD rejects a falling MA20 while REDUCE still reports an actual weakening close',()=>{
  const f=fixture();f.bars[45]=bar(f.dates[45],{open:102,high:104,low:101,close:103});
  f.bars[65]=bar(f.dates[65],{open:101,high:103,low:100,close:102.5});
  assert.equal(selected(f,'ADD').some(marker=>marker.day===f.dates[65]),false);
  assert.equal(selected(f,'REDUCE').some(marker=>marker.day===f.dates[64]),true);
});

test('X is a fixed-level condition observation, stops later +/- and leaves fixed-horizon research intact',()=>{
  const f=fixture();f.bars[64]=bar(f.dates[64],{open:100,high:102,low:97,close:99});
  f.bars[65]=bar(f.dates[65],{open:101,high:105,low:100,close:104});
  const result=buildEntryMarkers(f),invalid=result.markers.find(marker=>marker.kind==='INVALID');
  assert.equal(invalid.day,f.dates[64]);assert.equal(invalid.referencePrice,98);assert.equal(invalid.actualFillVerified,false);assert.equal(invalid.stopFillPrice,undefined);
  assert.equal(result.markers.some(marker=>['ADD','REDUCE'].includes(marker.kind)),false);
  assert.equal(result.markers.find(marker=>marker.kind==='S').day,f.dates[78]);
});

test('missing holding sessions terminate +/- observations instead of assuming continuity across a gap',()=>{
  const f=fixture();f.bars[64]=null;f.bars[65]=bar(f.dates[65],{open:101,high:105,low:100,close:104});
  assert.deepEqual(buildEntryMarkers(f).markers.map(marker=>marker.kind),['B']);
});

test('same-day B and S remain separate cohort markers and are explicitly grouped as a conflict',()=>{
  const f=fixture();f.bars[76]=bar(f.dates[76],{open:99.5,high:101,low:98,close:100.5});
  f.bars[77]=bar(f.dates[77],{open:100.5,high:103,low:100,close:102,volume:1100});
  f.bars[78]=bar(f.dates[78],{open:102,high:104,low:101,close:103.5});
  f.setups.push({...f.setups[0],id:'600000.SH:'+f.dates[76],formation:{...f.bars[76]},keyBar:{...f.bars[77]},observedEvent:{date:f.dates[78]}});
  const group=buildEntryMarkers(f).groups.find(value=>value.day===f.dates[78]);
  assert(group.kinds.includes('B'));assert(group.kinds.includes('S'));assert.equal(group.conflict,true);
  assert.deepEqual(group.markerIds,[f.dates[78]+':B',f.dates[78]+':S']);
});

test('same-day equivalent observations merge without losing setup identity or actual discovery metadata',()=>{
  const f=fixture(),original=f.setups[0];
  f.setups.push({...original,id:'600000.SH:second-pattern',patternIds:['volume-expand'],status:'triggered_observation',knownAt:null,lateDiscovery:false});
  const result=buildEntryMarkers(f),buy=result.markers.find(marker=>marker.kind==='B');
  assert.equal(result.markers.filter(marker=>marker.kind==='B').length,1);assert.equal(buy.setupIds.length,2);assert.equal(buy.evidence.length,2);
  assert.deepEqual(buy.patternIds,['regain-ma-20','volume-expand']);assert.equal(buy.evidence.find(item=>item.setupId===original.id).actualDiscoveryAt,original.knownAt);
  assert.equal(buy.evidence.find(item=>item.setupId===original.id).lateDiscovery,true);assert.equal(buy.evidence.find(item=>item.actualDiscoveryAt===null).status,'triggered_observation');
});

test('even opening gaps become valid daily research observations only after the full T candle closes',()=>{
  const f=fixture(),intraday=selected(f,'B')[0];assert.equal(intraday.knownAfter,f.dates[63]+'T15:00:00+08:00');
  f.bars[63]=bar(f.dates[63],{open:104,high:105,low:103.5,close:104.5});
  const gap=selected(f,'B')[0];assert.equal(gap.knownAfter,f.dates[63]+'T15:00:00+08:00');assert.equal(gap.referencePrice,104);
  assert.equal(gap.evidence[0].knownAfter,gap.knownAfter);
  f.bars[63].low=97;assert.deepEqual(selected(f,'B'),[]);
});

test('empty or untriggered records stay empty and the pure derivation neither mutates inputs nor fetches',t=>{
  const f=fixture(),before=structuredClone(f);t.mock.method(globalThis,'fetch',()=>{throw Error('pure chart markers cannot fetch');});
  buildEntryMarkers(f);assert.deepEqual(f,before);
  assert.deepEqual(buildEntryMarkers({...f,setups:[]}).markers,[]);
  f.setups[0].replayStatus='invalidated';assert.deepEqual(buildEntryMarkers(f).markers,[]);
});
