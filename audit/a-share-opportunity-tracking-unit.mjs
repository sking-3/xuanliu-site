import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {buildOpportunityWorkbench,observeOpportunity,describeMarketContext,viewOpportunityWorkbench,runOpportunityTracking,directoryName,version} from '../server/a-share-opportunity-tracking.mjs';
import {closeCandidateVersion} from '../server/a-share-entry-current.mjs';
import {entryPolicyVersion} from '../server/a-share-entry-bars.mjs';
import {entryValidationVersion} from '../server/a-share-entry-validation.mjs';
import {version as viprasolVersion,familyId as viprasolFamily,definitions as viprasolRules} from '../server/a-share-viprasol-study.mjs';
import {version as watchVersion} from '../server/a-share-desk-watches.mjs';

const sourceId='tickflow-free-forward-v1',stock={code:'600000.SH',name:'合成生命周期测试'},dates=[];
for(let value=Date.parse('2026-08-03T00:00:00Z');dates.length<90;value+=86400000)if(![0,6].includes(new Date(value).getUTCDay()))dates.push(new Date(value).toISOString().slice(0,10));
const anchor=70,bar=(date,close)=>({date,open:close-.1,high:close+.5,low:close-.5,close,volume:1000});
const stats={sampleCount:20,stockCount:5,signalDayCount:4,meanReturnPercent:1,medianReturnPercent:.5,meanExcessPercent:.2,positiveRate:.6,meanDrawdownPercent:2,worstDrawdownPercent:4};
function input(step=0){
  const day=dates[anchor+step],now=()=>Date.parse(day+'T09:00:00Z'),batch={generation:day+'-'+(100+step),sourceId,day,asOf:day+'T07:00:00.000Z',total:1,ready:1,dataPolicy:{rawPublic:false,derivedPublic:true}},computedAt=new Date(now()).toISOString();
  const bars=dates.slice(0,anchor+step+1).map((date,index)=>bar(date,100+Math.max(0,index-anchor))),source={status:'ready',sourceId,day,adjustment:'qfq',historyRequested:500,fetchedAt:day+'T08:00:00.000Z',bars};
  const reference={code:'000300.SH',bars:dates.slice(0,anchor+step+1).map((date,index)=>bar(date,100+index/10))};
  const patterns=Array.from({length:16},(_,i)=>({id:'pattern-'+i,label:'合成条件'+i,status:'inactive',recommended:false,reasons:['original_gate_not_passed'],fit:stats,recent:stats,validation:stats}));
  const entryReport={schema:'books.a-share.entry-current.v1',version:closeCandidateVersion,entryPolicyVersion,entryValidationVersion,completed:true,datasetBound:true,...batch,computedAt,patterns,current:[]};
  const viprasolReport={schema:'books.a-share.viprasol-study.v1',version:viprasolVersion,familyId:viprasolFamily,implementationCommit:null,completed:true,datasetBound:true,...batch,computedAt,rules:viprasolRules.map(rule=>({...rule,status:'blocked',nativeGate:{passed:false},statisticalGatePassed:false,eligibleForSelection:false,reasons:['native_review_allowlist_missing'],fit:stats,recent:stats,validation:stats})),current:[]};
  if(!step)entryReport.current.push({...batch,...stock,setupId:stock.code+':'+dates[anchor-3],formationDay:dates[anchor-3],patternIds:['pattern-0'],stage:'waiting_breakout',nearTrigger:true,qualified:false,patternGatePassed:false,entryGatePassed:false,eligiblePatternIds:[],closePrice:100,trigger:{above:101},invalidation:{below:97},knownAfter:day+'T15:00:00+08:00',sourceFetchedAt:source.fetchedAt,actualDiscoveryAt:computedAt,activeUntil:dates[anchor+1]+'T09:30:00+08:00',actualFillVerified:false,reasons:['original_gate_not_passed']});
  return {batch,reference,records:[{stock,source}],source,bars,entryReport,viprasolReport,now};
}
function watchInput(value,code='600001.SH'){
  const familyId='close-limitup-watch',firstSeenAt=new Date(value.now()-1000).toISOString(),row={...value.batch,code,name:'合成独立观察',familyId,ruleVersion:watchVersion,setupId:familyId+':'+value.batch.day,ruleIds:['close-limitup'],anchorDay:value.batch.day,phase:'close',state:'watch',qualified:false,qualification:'unqualified_observation',sourceFetchedAt:value.source.fetchedAt,actualDiscoveryAt:firstSeenAt,firstSeenAt,conditionKnownAfter:value.batch.day+'T15:00:00+08:00',activeUntil:dates[anchor+1]+'T09:30:00+08:00',reference:{close:100,trigger:null,invalidation:null},chartUrls:{},reasons:['synthetic_unqualified_watch'],research:{rules:[],institutionalEvidence:null},actualFillVerified:false};
  row.id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);return row;
}
function withWatchStock(value){value.batch.total=2;value.records.push({stock:{code:'600001.SH',name:'合成观察股'},source:value.source});return value;}

test('independent close watches freeze their actual first sight and receive the same three-session follow-up without becoming B',async()=>{
  const value=withWatchStock(input()),watch=watchInput(value),original=structuredClone(watch),first=await buildOpportunityWorkbench({...value,additionalCurrent:[watch]});
  const row=first.current.find(item=>item.id===watch.id),track=first.tracks.find(item=>item.id===watch.id);assert.equal(row.state,'watch');assert.equal(row.qualified,false);assert.equal(row.reference.trigger,null);assert.equal(track.firstSeenAt,watch.firstSeenAt);assert.equal(track.original.actualDiscoveryAt,watch.actualDiscoveryAt);assert.equal(first.summary.qualifiedCount,0);assert.deepEqual(watch,original);
  const later=await buildOpportunityWorkbench({...withWatchStock(input(3)),previous:first}),follow=later.tracks.find(item=>item.id===watch.id);assert.equal(follow.observations[3].status,'ready');assert(Math.abs(follow.observations[3].returnPercent-3)<1e-10);assert.equal(follow.firstSeenAt,track.firstSeenAt);assert.deepEqual(follow.original,track.original);
});
test('additional rows cannot promote qualification, invent B, mix batches, duplicate core codes or backdate their first sight',async()=>{
  for(const change of [row=>row.qualified=true,row=>row.eligibleForSelection=true,row=>row.state='triggered_B',row=>row.phase='a14',row=>row.sourceId='other-source',row=>row.ruleVersion='unapproved-rule',row=>row.firstSeenAt=dates[anchor]+'T07:00:00Z',row=>row.reference.trigger=101]){
    const value=withWatchStock(input()),row=watchInput(value);change(row);await assert.rejects(buildOpportunityWorkbench({...value,additionalCurrent:[row]}),/Additional current/);
  }
  const value=withWatchStock(input()),row=watchInput(value);await assert.rejects(buildOpportunityWorkbench({...value,additionalCurrent:[row,row]}),/Additional current/);await assert.rejects(buildOpportunityWorkbench({...value,additionalCurrent:[watchInput(value,stock.code)]}),/Additional current/);
  row.reference.close=101;await assert.rejects(buildOpportunityWorkbench({...value,additionalCurrent:[row]}),/current close differs/);
});

test('freezes first actual sight and original gate state; three-session outcomes mature without waiting fifteen sessions',async()=>{
  const firstInput=input(),first=await buildOpportunityWorkbench(firstInput),original=structuredClone(first.tracks[0].original);
  assert.equal(first.current[0].state,'near_B');assert.equal(first.current[0].phase,'close');assert.equal(first.current[0].qualified,false);assert.equal(first.summary.qualifiedCount,0);assert.equal(first.tracks[0].firstSeenAt,new Date(firstInput.now()).toISOString());
  assert.deepEqual(Object.values(first.tracks[0].observations).map(value=>[value.status,value.returnPercent]),[['pending',null],['pending',null],['pending',null]]);assert.equal(first.current[0].research.rules[0].fit.sampleCount,20);assert.equal(first.current[0].research.institutionalEvidence,null);
  const third=await buildOpportunityWorkbench({...input(3),previous:first});assert.equal(third.summary.thirdSessionReadyCount,1);assert.deepEqual(third.tracks[0].original,original);assert.equal(third.tracks[0].firstSeenAt,first.tracks[0].firstSeenAt);
  for(const horizon of [1,2,3]){const result=third.tracks[0].observations[horizon];assert.equal(result.status,'ready');assert.equal(result.targetDay,dates[anchor+horizon]);assert(Math.abs(result.returnPercent-horizon)<1e-10);}
  assert.equal(third.method.savedScheme15DayPolicyChanged,false);assert.deepEqual(third.method.horizons,[1,2,3]);assert.equal('bars' in third.tracks[0].original,false);
});

test('closed prefixes remain pending and later qfq rebasing uses both prices from the same batch',async()=>{
  const first=await buildOpportunityWorkbench(input()),second=await buildOpportunityWorkbench({...input(1),previous:first}),ready=structuredClone(second.tracks[0].observations[1]);
  assert.equal(ready.status,'ready');assert.equal(second.tracks[0].observations[2].status,'pending');assert.equal(second.tracks[0].observations[3].returnPercent,null);
  const later=input(3);for(const candle of later.source.bars)for(const key of ['open','high','low','close'])candle[key]*=.5;
  const third=await buildOpportunityWorkbench({...later,previous:second});assert.deepEqual(third.tracks[0].observations[1],ready);assert.equal(third.tracks[0].original.reference.close,100);assert(Math.abs(third.tracks[0].observations[3].returnPercent-3)<1e-10);
});

test('missing and zero-trade sessions never become zero returns or get skipped',async()=>{
  const first=await buildOpportunityWorkbench(input()),later=input(3);later.source.bars=later.source.bars.filter(candle=>candle.date!==dates[anchor+2]);
  const gap=await buildOpportunityWorkbench({...later,previous:first});assert.equal(gap.tracks[0].observations[1].status,'ready');assert.equal(gap.tracks[0].observations[2].status,'unavailable');assert.equal(gap.tracks[0].observations[3].returnPercent,null);
  const halt=input(3);halt.source.bars.find(candle=>candle.date===dates[anchor+1]).volume=0;
  const missing=await buildOpportunityWorkbench({...halt,previous:first});for(const value of Object.values(missing.tracks[0].observations)){assert.equal(value.status,'unavailable');assert.equal(value.returnPercent,null);}
});

test('outcomes already closed before actual first sight cannot be backfilled as prospective observations',async()=>{
  const first=await buildOpportunityWorkbench(input()),later=input(3),track=structuredClone(first.tracks[0]);track.firstSeenAt=dates[anchor+2]+'T08:00:00.000Z';
  const observed=observeOpportunity(track,{source:later.source,reference:later.reference,batch:later.batch,now:later.now()});assert.equal(observed.observations[1].status,'not_observable');assert.equal(observed.observations[2].returnPercent,null);assert.equal(observed.observations[3].status,'ready');
  assert.throws(()=>observeOpportunity({...track,firstSeenAt:dates[anchor+4]+'T08:00:00Z'},{source:later.source,reference:later.reference,batch:later.batch,now:later.now()}),/observation time/);
});

test('different source and qfq methods cannot produce mixed-basis returns',async()=>{
  const first=await buildOpportunityWorkbench(input());
  for(const change of [{sourceId:'other-source'},{adjustment:'none'},{fetchedAt:dates[anchor+4]+'T08:00:00Z'}]){const later=input(3);Object.assign(later.source,change);await assert.rejects(buildOpportunityWorkbench({...later,previous:first}),/history source/);}
  const later=input(3),changed=observeOpportunity({...first.tracks[0],original:{...first.tracks[0].original,sourceId:'old-source'}},{source:later.source,reference:later.reference,batch:later.batch,now:later.now()});assert.equal(changed.observations[3].status,'unavailable');assert.equal(changed.observations[3].returnPercent,null);
});

test('rejects duplicate opportunities or history codes, backdated first sightings, future calendars and mismatched reports',async()=>{
  const duplicate=input();duplicate.entryReport.current.push(structuredClone(duplicate.entryReport.current[0]));await assert.rejects(buildOpportunityWorkbench(duplicate),/duplicated/);
  const raw=input();raw.batch.total=2;raw.records.push(structuredClone(raw.records[0]));await assert.rejects(buildOpportunityWorkbench(raw),/history source/);
  const badReport=input();badReport.entryReport.generation='other';await assert.rejects(buildOpportunityWorkbench(badReport),/current-16/);
  const future=input();future.reference.bars.push(bar(dates[anchor+1],110));await assert.rejects(buildOpportunityWorkbench(future),/calendar/);
  const first=await buildOpportunityWorkbench(input());first.tracks[0].firstSeenAt=first.tracks[0].original.sourceFetchedAt;await assert.rejects(buildOpportunityWorkbench({...input(1),previous:first}),/episode identity/);
  const wrongClose=input();wrongClose.entryReport.current[0].closePrice=99.9;await assert.rejects(buildOpportunityWorkbench(wrongClose),/current close differs/);
});

test('near, triggered and far observation states remain separate from original statistical eligibility',async()=>{
  const value=input(),near=value.entryReport.current[0],triggered={...structuredClone(near),setupId:stock.code+':'+dates[anchor-4],formationDay:dates[anchor-4],stage:'triggered_at_close',trigger:{above:99}},far={...structuredClone(near),setupId:stock.code+':'+dates[anchor-5],formationDay:dates[anchor-5],nearTrigger:false,trigger:{above:110}};
  value.entryReport.current.push(triggered,far);value.viprasolReport.current.push({...value.batch,...stock,familyId:viprasolFamily,ruleId:viprasolRules[0].id,signalDay:value.batch.day,stage:'source_today_long_close',eligibleForSelection:false,closePrice:100,sourceFetchedAt:value.source.fetchedAt,actualDiscoveryAt:new Date(value.now()).toISOString(),conditionKnownAfter:near.knownAfter,activeUntil:near.activeUntil,actualFillVerified:false,originalReference:{entry:100,stop:97,target:105},reasons:['native_review_allowlist_missing']});
  const result=await buildOpportunityWorkbench(value);assert.deepEqual(result.current.map(row=>row.state),['near_B','triggered_B','watch','triggered_B']);assert.equal(result.summary.qualifiedCount,0);assert.deepEqual(result.current[3].chartUrls,{});
  const fake=input();fake.entryReport.current[0].qualified=true;await assert.rejects(buildOpportunityWorkbench(fake),/cannot promote/);
  const unobserved=input();unobserved.entryReport.current[0].stage='triggered_at_close';await assert.rejects(buildOpportunityWorkbench(unobserved),/unobserved price condition/);
});

test('benchmark context is causal, descriptive and never an eligibility gate; serving expiry does not rewrite the ledger',async()=>{
  const value=input(),report=await buildOpportunityWorkbench(value);assert.equal(report.marketContext.regime,'bullish_trend');assert.equal(report.marketContext.usedForEligibility,false);assert.equal(report.marketContext.fullMarketCycleVerified,false);assert.equal(report.summary.qualifiedCount,0);
  const short={...value.reference,bars:value.reference.bars.slice(-64)};assert.equal(describeMarketContext(short,value.batch).regime,'unknown');
  const before=structuredClone(report),view=viewOpportunityWorkbench(report,{now:Date.parse(report.current[0].activeUntil)});assert.equal(view.liveCandidateCount,0);assert.equal(view.current[0].displayState,'expired');assert.deepEqual(report,before);
});

function intradayTrack(first){
  const track=structuredClone(first.tracks[0]),day=track.original.anchorDay,receivedAt=day+'T06:02:00.000Z';
  Object.assign(track.original,{phase:'a14',sourceId:'tencent-public-stock-quotes-v1',historySourceId:sourceId,basisDay:dates[anchor-1],basisClose:100,quotePrevClose:100,quoteSourceAt:day+'T06:00:00.000Z',receivedAt,sourceFetchedAt:receivedAt,actualDiscoveryAt:receivedAt,conditionKnownAfter:receivedAt,reference:{...track.original.reference,close:100.2}});track.firstSeenAt=receivedAt;track.id=JSON.stringify([track.original.sourceId,track.original.ruleVersion,track.original.familyId,track.original.setupId,track.original.code,track.original.anchorDay]);track.observations={};return track;
}

test('14:00 observations rebase the frozen quote using same-batch real basis prices without changing the close formula',async()=>{
  const first=await buildOpportunityWorkbench(input()),track=intradayTrack(first),later=input(3);
  for(const candle of later.source.bars)for(const key of ['open','high','low','close'])candle[key]*=.5;
  const observed=observeOpportunity(track,{source:later.source,reference:later.reference,batch:later.batch,now:later.now()});
  assert.equal(observed.observations[3].status,'ready');assert(Math.abs(observed.observations[3].returnPercent-(103/100.2-1)*100)<1e-10);assert.equal(observed.observations[3].method,'intraday_reference_rebased_to_same_batch_qfq_not_trade_return');assert.equal(track.original.reference.close,100.2);
  const close=observeOpportunity(first.tracks[0],{source:later.source,reference:later.reference,batch:later.batch,now:later.now()});assert(Math.abs(close.observations[3].returnPercent-3)<1e-10);assert.equal(close.observations[3].method,'same_batch_qfq_close_change_not_trade_return');
});

test('14:00 quote evidence must be captured in-window with a real matching frozen previous close',async()=>{
  const first=await buildOpportunityWorkbench(input()),later=input(3),base=intradayTrack(first),day=base.original.anchorDay;
  for(const change of [{quotePrevClose:100.02},{quoteSourceAt:day+'T06:11:00Z'},{receivedAt:day+'T06:11:00Z'},{quoteSourceAt:day+'T06:03:00Z'},{basisClose:null}]){
    const track=structuredClone(base);Object.assign(track.original,change);assert.throws(()=>observeOpportunity(track,{source:later.source,reference:later.reference,batch:later.batch,now:later.now()}),/14:00 quote time or frozen price basis/);
  }
  const future=structuredClone(base);future.firstSeenAt=day+'T06:01:00Z';assert.throws(()=>observeOpportunity(future,{source:later.source,reference:later.reference,batch:later.batch,now:later.now()}),/frozen price basis/);
});

test('14:00 outcomes require continuous actual basis-to-target sessions and the matching historical source',async()=>{
  const first=await buildOpportunityWorkbench(input()),track=intradayTrack(first),later=input(3);
  const wrong=structuredClone(track);wrong.original.historySourceId='other-history';assert.equal(observeOpportunity(wrong,{source:later.source,reference:later.reference,batch:later.batch,now:later.now()}).observations[3].returnPercent,null);
  later.source.bars=later.source.bars.filter(candle=>candle.date!==track.original.basisDay);const missing=observeOpportunity(track,{source:later.source,reference:later.reference,batch:later.batch,now:later.now()});assert.equal(missing.observations[3].status,'unavailable');assert.equal(missing.observations[3].returnPercent,null);
  const prefix=input(1),partial=observeOpportunity(track,{source:prefix.source,reference:prefix.reference,batch:prefix.batch,now:prefix.now()});assert.equal(partial.observations[1].status,'ready');assert.equal(partial.observations[3].status,'pending');
});

test('later close batches adopt frozen live14 episodes once and advance their three-session follow-up automatically',async()=>{
  const first=await buildOpportunityWorkbench(input()),captured=intradayTrack(first),original=structuredClone(captured.original);
  const report=await buildOpportunityWorkbench({...input(3),previous:first,additionalTracks:[captured]});const adopted=report.tracks.find(track=>track.id===captured.id);
  assert.equal(adopted.firstSeenAt,captured.firstSeenAt);assert.deepEqual(adopted.original,original);assert.equal(adopted.observations[3].status,'ready');assert(Math.abs(adopted.observations[3].returnPercent-(103/100.2-1)*100)<1e-10);
  const next=await buildOpportunityWorkbench({...input(4),previous:report,additionalTracks:[captured]});assert.equal(next.tracks.filter(track=>track.id===captured.id).length,1);assert.deepEqual(next.tracks.find(track=>track.id===captured.id).observations[3],adopted.observations[3]);
  const changed=structuredClone(captured);changed.original.reference.close+=.1;await assert.rejects(buildOpportunityWorkbench({...input(4),previous:report,additionalTracks:[changed]}),/changed after first sight/);
});

async function storedFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'books-opportunity-ledger-'));t.after(()=>rm(dir,{recursive:true,force:true}));const value=input();value.batch.total=1000;value.batch.ready=1000;
  for(const report of [value.entryReport,value.viprasolReport])Object.assign(report,value.batch);
  const target=join(dir,'generations',value.batch.generation),privateTarget=join(dir,'private','generations',value.batch.generation);await mkdir(join(target,'entry-current-v2'),{recursive:true});await mkdir(join(target,'viprasol-study-v1'),{recursive:true});await mkdir(privateTarget,{recursive:true});
  const complete={...value.batch,completed:true,fullMarket:true,closeCandidateVersion:closeCandidateVersion,viprasolStudyVersion:viprasolVersion,viprasolImplementationCommit:null};
  await writeFile(join(dir,'current.json'),JSON.stringify(value.batch));await writeFile(join(target,'complete.json'),JSON.stringify(complete));await writeFile(join(target,'entry-current-v2','report.json'),JSON.stringify(value.entryReport));await writeFile(join(target,'viprasol-study-v1','report.json'),JSON.stringify(value.viprasolReport));
  const header={schema:'books.a-share.history.v1',...value.batch,historyRequested:500,reference:value.reference},rows=Array.from({length:1000},(_,index)=>({stock:{...stock,code:String(600000+index)+'.SH'},source:value.source})),historyFile=join(privateTarget,'history-all.ndjson');await writeFile(historyFile,[header,...rows].map(JSON.stringify).join('\n'));
  return {dir,value,target,historyFile};
}

test('runner stores recoverable gzip ledger snapshots without changing the source pointer or raw archive, and reuses the same generation',async t=>{
  const f=await storedFixture(t),before=await readFile(join(f.dir,'current.json')),rawBefore=await readFile(f.historyFile),result=await runOpportunityTracking({dir:f.dir,now:f.value.now});
  assert.equal(result.version,version);assert.equal(result.summary.trackCount,1);assert.deepEqual(await readFile(join(f.dir,'current.json')),before);assert.deepEqual(await readFile(f.historyFile),rawBefore);
  const file=join(f.target,directoryName,'report.json'),plain=await readFile(file),compressed=await readFile(file+'.gz');assert.deepEqual(gunzipSync(compressed),plain);assert.equal(JSON.parse(await readFile(join(f.dir,directoryName,'current.json'))).generation,f.value.batch.generation);
  await rm(file);const later=await runOpportunityTracking({dir:f.dir,now:()=>f.value.now()+1000});assert.equal(later.tracks[0].firstSeenAt,result.tracks[0].firstSeenAt);assert.equal(later.summary.trackCount,1);assert.deepEqual(await readFile(file+'.gz'),compressed);
  await rm(join(f.dir,directoryName,'current.json'));await rm(f.historyFile);const restored=await runOpportunityTracking({dir:f.dir,now:()=>f.value.now()+2000});assert.equal(restored.tracks[0].firstSeenAt,result.tracks[0].firstSeenAt);assert.equal(JSON.parse(await readFile(join(f.dir,directoryName,'current.json'))).generation,f.value.batch.generation);assert.deepEqual(await readFile(file+'.gz'),compressed);
});

test('runner freezes watches before first publication and rejects later same-generation additions or altered originals',async t=>{
  const f=await storedFixture(t),watch=watchInput(f.value),first=await runOpportunityTracking({dir:f.dir,additionalCurrent:[watch],now:f.value.now}),file=join(f.target,directoryName,'report.json'),body=await readFile(file);
  assert.equal(first.current.find(row=>row.id===watch.id).state,'watch');assert.equal(first.tracks.find(row=>row.id===watch.id).firstSeenAt,watch.firstSeenAt);
  await rm(f.historyFile);const repeat=await runOpportunityTracking({dir:f.dir,additionalCurrent:[watch],now:()=>f.value.now()+1000});assert.equal(repeat.tracks.find(row=>row.id===watch.id).firstSeenAt,watch.firstSeenAt);
  const altered=structuredClone(watch);altered.reference.close+=1;await assert.rejects(runOpportunityTracking({dir:f.dir,additionalCurrent:[altered],now:f.value.now}),/already frozen/);
  await assert.rejects(runOpportunityTracking({dir:f.dir,additionalCurrent:[watchInput(f.value,'600002.SH')],now:f.value.now}),/already frozen/);assert.deepEqual(await readFile(file),body);
});

test('corrupt or incomplete input cannot create a workbench pointer or replace the published source',async t=>{
  const f=await storedFixture(t),pointer=await readFile(join(f.dir,'current.json')),body=await readFile(f.historyFile,'utf8');await writeFile(f.historyFile,body.slice(0,body.lastIndexOf('\n')));
  await assert.rejects(runOpportunityTracking({dir:f.dir,now:f.value.now}),/coverage is incomplete/);await assert.rejects(readFile(join(f.dir,directoryName,'current.json')),/ENOENT/);assert.deepEqual(await readFile(join(f.dir,'current.json')),pointer);
});
