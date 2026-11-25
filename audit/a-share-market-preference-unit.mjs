import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {marketRegimeAt,evaluatePreferenceOutcome,rankPreferences,analyzeMarketPreference,precomputeMarketPreference,policy,filename} from '../server/a-share-market-preference.mjs';
import {prepare,recentStrength,evaluateEvent,policy as originalPolicy} from '../server/a-share-pattern-regimes.mjs';
const require=createRequire(import.meta.url),patterns=require('../screening/trend-patterns.js');
function calendar(count){const dates=[];for(let stamp=Date.parse('2024-01-01T00:00:00Z');dates.length<count;stamp+=86400000)if(![0,6].includes(new Date(stamp).getUTCDay()))dates.push(new Date(stamp).toISOString().slice(0,10));return dates;}
const bar=(date,close=100,volume=1000)=>({date,open:close*.999,high:close*1.01,low:close*.99,close,volume});
function fixture(count=500,stocks=10){
  const dates=calendar(count),day=dates.at(-1),batch={generation:day+'-1',sourceId:'synthetic-offline-history',day,asOf:day+'T07:00:00.000Z',total:stocks},reference={code:'000300.SH',bars:dates.map((date,i)=>bar(date,100+i*.03))};
  const records=Array.from({length:stocks},(_,stock)=>({stock:{code:String(600000+stock)+'.SH',name:'合成偏好测试'+stock},source:{status:'ready',sourceId:batch.sourceId,day,adjustment:'qfq',historyRequested:500,fetchedAt:day+'T08:00:00.000Z',bars:dates.map((date,i)=>bar(date,100*Math.exp(i*.0003+.025*Math.sin(i*.41+stock*.3)),1000*(1+.7*Math.sin(i*.36+stock*.1))))}}));
  return {batch,reference,records,patterns,universeMetadata:{historicalMembership:false,basis:'current_roster_retrospective'},now:()=>Date.parse(day+'T09:00:00Z')};
}

test('benchmark regimes use only the closed signal prefix and distinguish bull, bear and sideways without full-cycle claims',()=>{
  const dates=calendar(100),up=dates.map((date,i)=>bar(date,100+i)),down=dates.map((date,i)=>bar(date,200-i)),flat=dates.map(date=>bar(date));
  assert.equal(marketRegimeAt(up,70).state,'bull');assert.equal(marketRegimeAt(down,70).state,'bear');assert.equal(marketRegimeAt(flat,70).state,'sideways');assert.equal(marketRegimeAt(up,63).state,'unknown');
  const before=marketRegimeAt(up,70),changed=up.map((value,i)=>i>70?bar(value.date,10000-i):value);assert.deepEqual(marketRegimeAt(changed,70),before);assert.equal(before.fullMarketCycleVerified,false);
});

test('three-session close observations mature independently of fifteen-session events and retain explicit excess and drawdown',()=>{
  const dates=calendar(4),bars=dates.map((date,i)=>bar(date,[100,110,99,103][i])),reference=dates.map(date=>bar(date));
  const result=evaluatePreferenceOutcome({bars,reference,signalIndex:0});assert.equal(result.status,'ready');assert(Math.abs(result.returnPercent-3)<1e-10);assert.equal(result.excessPercent,result.returnPercent);assert(Math.abs(result.drawdownPercent-10)<1e-10);assert.equal(evaluateEvent({bars,reference,signalIndex:0}).status,'pending');
  assert.equal(evaluatePreferenceOutcome({bars:bars.slice(0,3),reference:reference.slice(0,3),signalIndex:0}).status,'pending');
  const missing=bars.slice();missing[2]=null;assert.equal(evaluatePreferenceOutcome({bars:missing,reference,signalIndex:0}).status,'unavailable');missing[2]={...bars[2],volume:0};assert.equal(evaluatePreferenceOutcome({bars:missing,reference,signalIndex:0}).status,'unavailable');
});

test('comparison requires all 30/10/10 sample minima; ranking never promotes even adequate negative rows',()=>{
  const row={regime:'bull',patternId:'p',sampleCount:30,stockCount:10,signalDayCount:10,meanReturnPercent:-2,meanExcessPercent:-1,positiveRate:.2};
  for(const change of [{sampleCount:29},{stockCount:9},{signalDayCount:9}])assert.deepEqual(rankPreferences([{...row,...change}],'bull'),[]);
  assert.deepEqual(rankPreferences([{...row,meanReturnPercent:null}],'bull'),[]);
  const ranked=rankPreferences([{...row,patternId:'bad',meanExcessPercent:-5},{...row,patternId:'less_bad'}],'bull');assert.equal(ranked[0].patternId,'less_bad');assert(ranked.every(value=>value.rankingOnly&&value.eligibleForSelection===false));assert.deepEqual(rankPreferences([row],'bear'),[]);assert.deepEqual(rankPreferences([row],'unknown'),[]);
});

test('historical streaming retains all sixteen rows and nonoverlapping three-session samples under the original early-strength filters',async t=>{
  const value=fixture(),before=JSON.stringify(value.records),original=structuredClone(originalPolicy);let read=0;
  async function* stream(){for(const record of value.records){read++;yield record;}}
  t.mock.method(globalThis,'fetch',()=>{throw Error('preference research must remain offline');});
  const result=await analyzeMarketPreference({...value,records:stream()});assert.equal(read,10);assert.equal(result.byRegime.length,3);assert(result.byRegime.every(regime=>regime.patterns.length===16));assert.equal(result.currentRegime.state,'bull');assert.equal(result.coverage.historySessions,500);assert.equal(result.coverage.historicalMembership,false);assert.equal(result.coverage.fullMarketCycleVerified,false);
  const rows=result.byRegime.flatMap(regime=>regime.patterns);assert(rows.some(row=>row.sampleCount>0));assert(rows.some(row=>row.overlapCount>0));assert(result.adequateRanking.length>0);assert(result.adequateRanking.every(row=>row.regime==='bull'&&row.sampleCount>=30&&row.stockCount>=10&&row.signalDayCount>=10&&row.eligibleForSelection===false));
  for(const row of rows)assert(row.sampleCount<=10*Math.ceil((500-64)/3));assert.equal(result.eligibleForSelection,false);assert.equal(result.method.existingSixteenAndThirteenGatesChanged,false);assert.equal(JSON.stringify(value.records),before);assert.deepEqual(originalPolicy,original);assert.deepEqual(result.policy.limits,{maxReturn5:8,maxReturn20:15,maxMa20Deviation:8,maxVolumeRatio:2.5});
  assert.doesNotMatch(JSON.stringify(result),/"(?:bars|open|high|low|close|volume|prices|apiKey)":/);
});

test('the shared original early-strength helper keeps heat boundaries and volume exclusions unchanged',()=>{
  const dates=calendar(80),bars=dates.map(date=>bar(date));[99,99,99,99,99,99.5,100,100.5,101,101.5].forEach((close,index)=>{bars[70+index]=bar(dates[70+index],close);});
  assert(recentStrength(prepare(bars,dates),79));
  const limit=structuredClone(bars);limit[79]=bar(dates[79],limit[74].close*1.08);assert(recentStrength(prepare(limit,dates),79));limit[79]=bar(dates[79],limit[74].close*1.0801);assert.equal(recentStrength(prepare(limit,dates),79),null);
  const volume=structuredClone(bars);for(let i=75;i<80;i++)volume[i].volume=10000;assert.equal(recentStrength(prepare(volume,dates),79),null);
});

test('unknown histories, unavailable current names and incomplete or cross-source input never create made-up preferences',async()=>{
  const small=fixture(64,1),result=await analyzeMarketPreference(small);assert.equal(result.currentRegime.state,'unknown');assert.deepEqual(result.adequateRanking,[]);assert(result.byRegime.every(regime=>regime.patterns.every(row=>row.sampleCount===0&&row.meanReturnPercent===null)));
  const normal=fixture(150,1),first=await analyzeMarketPreference(normal);normal.records[0].source.status='unavailable';const unavailable=await analyzeMarketPreference(normal);assert.equal(unavailable.coverage.readyToday,0);assert.deepEqual(unavailable.byRegime,first.byRegime);
  for(const variant of ['source','duplicate','count','basis']){
    const bad=fixture(100,1);if(variant==='source')bad.records[0].source.sourceId='other';if(variant==='duplicate'){bad.batch.total=2;bad.records.push(bad.records[0]);}if(variant==='count')bad.batch.total=2;if(variant==='basis')bad.records[0].source.adjustment='none';
    if(variant==='basis'){const stopped=await analyzeMarketPreference(bad);assert.equal(stopped.coverage.missingBasis,1);assert.deepEqual(stopped.adequateRanking,[]);}else await assert.rejects(analyzeMarketPreference(bad));
  }
});

test('private-history serialization streams and gzip restores exactly, without changing the source or publishing pointers',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'books-market-preference-'));t.after(()=>rm(dir,{recursive:true,force:true}));const value=fixture(100,2),target=join(dir,'derived');await mkdir(target);
  const file=join(dir,'history-all.ndjson'),header={schema:'books.a-share.history.v1',...value.batch,historyRequested:500,reference:value.reference,universePolicy:value.universeMetadata};await writeFile(file,[header,...value.records].map(JSON.stringify).join('\n'));const before=await readFile(file);
  const report=await precomputeMarketPreference({historyFile:file,target,batch:value.batch,patterns,now:value.now}),plain=await readFile(join(target,filename+'.json'));assert.equal(report.datasetBound,true);assert.equal(report.coverage.processed,2);assert.deepEqual(gunzipSync(await readFile(join(target,filename+'.json.gz'))),plain);assert.deepEqual(await readFile(file),before);await assert.rejects(readFile(join(dir,'current.json')),/ENOENT/);
  await assert.rejects(precomputeMarketPreference({historyFile:file,target,batch:{...value.batch,generation:'other'},patterns,now:value.now}),/snapshot differs/);assert.deepEqual(await readFile(join(target,filename+'.json')),plain);
  await rm(join(target,filename+'.json'));await rm(file);const cached=await precomputeMarketPreference({historyFile:file,target,batch:value.batch,patterns,now:value.now});assert.deepEqual(cached,report);assert.deepEqual(gunzipSync(await readFile(join(target,filename+'.json.gz'))),plain);
});
