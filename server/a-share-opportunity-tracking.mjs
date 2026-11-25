import {mkdir,mkdtemp,writeFile,rename,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {readStoredJson} from './a-share-retention.mjs';
import {closeCandidateVersion} from './a-share-entry-current.mjs';
import {entryPolicyVersion} from './a-share-entry-bars.mjs';
import {entryValidationVersion} from './a-share-entry-validation.mjs';
import {version as viprasolVersion,familyId as viprasolFamily,definitions as viprasolRules} from './a-share-viprasol-study.mjs';
import {version as watchVersion} from './a-share-desk-watches.mjs';

export const version='books.a-share.opportunity-tracking.2026-11-25.v1';
export const directoryName='opportunity-workbench-v1';
export const schema='books.a-share.opportunity-workbench.v1';
const entryFamily='key-k-entry-16',horizons=[1,2,3];
const finite=Number.isFinite,day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&finite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const code=value=>typeof value==='string'&&/^\d{6}\.(SH|SZ)$/.test(value),time=value=>typeof value==='string'&&finite(Date.parse(value));
const same=(a,b)=>['generation','sourceId','day','asOf'].every(key=>a[key]===b[key]);
const closeAt=value=>Date.parse(value+'T15:00:00+08:00');
const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
const validBar=bar=>bar&&day(bar.date)&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const idOf=item=>JSON.stringify([item.sourceId,item.ruleVersion,item.familyId,item.setupId,item.code,item.anchorDay]);
const clone=value=>structuredClone(value);
async function optionalJson(file){try{return await readStoredJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}

function validateBatch(batch,now){
  if(!batch||!day(batch.day)||!time(batch.asOf)||Date.parse(batch.asOf)<closeAt(batch.day)||Date.parse(batch.asOf)>now||typeof batch.sourceId!=='string'||!batch.sourceId||!/^[0-9TZ-]{1,80}$/.test(batch.generation||'')||!Number.isInteger(batch.total)||batch.total<1)throw Error('Opportunity tracking needs one closed, identified source batch');
}
function referenceCalendar(reference,batch){
  if(reference?.code!=='000300.SH'||!Array.isArray(reference.bars)||!reference.bars.length||reference.bars.length>500||reference.bars.some((bar,index)=>!validBar(bar)||bar.date>batch.day||index&&bar.date<=reference.bars[index-1].date)||reference.bars.at(-1).date!==batch.day)throw Error('Opportunity tracking reference calendar is missing, unordered or from the future');
  return reference.bars.map(bar=>bar.date);
}

/** A causal benchmark trend descriptor, never a selection gate or a complete bull/bear-cycle claim. */
export function describeMarketContext(reference,batch){
  const dates=referenceCalendar(reference,batch),bars=reference.bars;
  const base={version:'benchmark-ma20-ma60-slope5-v1',benchmark:reference.code,day:batch.day,asOf:batch.asOf,historySessions:dates.length,fullMarketCycleVerified:false,usedForEligibility:false};
  if(bars.length<65)return {...base,regime:'unknown',reason:'fewer_than_65_verified_benchmark_sessions'};
  const average=values=>values.reduce((sum,bar)=>sum+bar.close,0)/values.length,ma20=average(bars.slice(-20)),ma60=average(bars.slice(-60)),old60=average(bars.slice(-65,-5)),last=bars.at(-1).close;
  const regime=last>ma20&&ma20>ma60&&ma60>old60?'bullish_trend':last<ma20&&ma20<ma60&&ma60<old60?'bearish_trend':'mixed_or_range';
  return {...base,regime,closeAboveMa20:last>ma20,ma20AboveMa60:ma20>ma60,ma60Slope5Percent:(ma60/old60-1)*100,reason:'benchmark_closed_prefix_only_not_historical_strategy_preference'};
}

function chartUrls(item,batch,native){
  if(native&&!item.eligibleForSelection)return {};
  return Object.fromEntries([60,120].map(window=>[window,'/api/a-share-daily/'+(native?'viprasol-current-chart':'entry-current-chart')+'?'+new URLSearchParams({generation:batch.generation,code:item.code,...(native?{rule:item.ruleId}:{setup:item.formationDay}),window:String(window)})]));
}
function researchSummary(item){
  const stats=value=>value?Object.fromEntries(['sampleCount','stockCount','signalDayCount','meanReturnPercent','medianReturnPercent','meanExcessPercent','positiveRate','meanDrawdownPercent','worstDrawdownPercent'].map(key=>[key,value[key]??null])):null;
  return {id:item.id,label:item.label||item.title||item.id,status:item.status,reasons:Array.isArray(item.reasons)?item.reasons.slice():[],fit:stats(item.fit),recent:stats(item.recent),validation:stats(item.validation)};
}
function currentRows(entry,viprasol,batch,now){
  if(entry?.schema!=='books.a-share.entry-current.v1'||entry.version!==closeCandidateVersion||entry.entryPolicyVersion!==entryPolicyVersion||entry.entryValidationVersion!==entryValidationVersion||entry.completed!==true||entry.datasetBound!==true||!same(entry,batch)||!Array.isArray(entry.patterns)||entry.patterns.length!==16||!Array.isArray(entry.current)||!time(entry.computedAt)||Date.parse(entry.computedAt)>now)throw Error('Opportunity tracking current-16 report does not bind to the closed batch');
  if(viprasol?.schema!=='books.a-share.viprasol-study.v1'||viprasol.version!==viprasolVersion||viprasol.familyId!==viprasolFamily||viprasol.completed!==true||viprasol.datasetBound!==true||!same(viprasol,batch)||!Array.isArray(viprasol.rules)||viprasol.rules.length!==viprasolRules.length||!Array.isArray(viprasol.current)||!time(viprasol.computedAt)||Date.parse(viprasol.computedAt)>now)throw Error('Opportunity tracking current-13 report does not bind to the closed batch');
  const rows=[],seen=new Set(),nativeRules=new Map(viprasol.rules.map(rule=>[rule.id,rule])),entryPatterns=new Map(entry.patterns.map(pattern=>[pattern.id,pattern]));
  for(const [native,report]of [[false,entry],[true,viprasol]])for(const item of report.current){
    if(!same(item,batch)||!code(item.code)||!time(item.sourceFetchedAt)||Date.parse(item.sourceFetchedAt)<Date.parse(batch.asOf)||Date.parse(item.sourceFetchedAt)>now||!time(item.actualDiscoveryAt)||Date.parse(item.actualDiscoveryAt)>now||!time(item.activeUntil)||item.actualFillVerified!==false||!finite(item.closePrice)||item.closePrice<=0)throw Error('Opportunity tracking received an unbound current row or a future source time');
    const known=native?item.conditionKnownAfter:item.knownAfter;
    if(!time(known)||Date.parse(known)<closeAt(batch.day)||Date.parse(known)>Date.parse(item.actualDiscoveryAt)||Date.parse(item.actualDiscoveryAt)<Date.parse(item.sourceFetchedAt))throw Error('Opportunity tracking close condition was not actually known at discovery');
    const qualified=native?item.eligibleForSelection:item.qualified,rule=nativeRules.get(item.ruleId);
    if(typeof qualified!=='boolean'||native&&(!rule||item.stage!=='source_today_long_close'||qualified&&(rule.eligibleForSelection!==true||rule.nativeGate?.passed!==true||rule.statisticalGatePassed!==true||!/^[a-f0-9]{40}$/.test(viprasol.implementationCommit||'')))||!native&&(!['waiting_breakout','triggered_at_close'].includes(item.stage)||!day(item.formationDay)||item.setupId!==item.code+':'+item.formationDay||qualified&&(!item.nearTrigger||!item.patternGatePassed||!item.entryGatePassed||!item.eligiblePatternIds?.length)))throw Error('Opportunity tracking cannot promote an unqualified or unidentified condition');
    if(native?item.signalDay!==batch.day:!finite(item.trigger?.above)||!finite(item.invalidation?.below)||item.invalidation.below<=0||item.trigger.above<=item.invalidation.below||item.closePrice<=item.invalidation.below||typeof item.nearTrigger!=='boolean'||item.stage==='triggered_at_close'&&(!above(item.closePrice,item.trigger.above)||above((item.closePrice/item.trigger.above-1)*100,2)||!item.nearTrigger)||item.stage==='waiting_breakout'&&(above(item.closePrice,item.trigger.above)||item.nearTrigger!==!above((1-item.closePrice/item.trigger.above)*100,2)))throw Error('Opportunity tracking cannot label an unobserved price condition as B');
    const state=native||item.stage==='triggered_at_close'?'triggered_B':item.nearTrigger?'near_B':'watch';
    const row={code:item.code,name:item.name||item.code,familyId:native?viprasolFamily:entryFamily,ruleVersion:native?viprasol.version+':'+(viprasol.implementationCommit||'unbound'):[entry.version,entry.entryPolicyVersion,entry.entryValidationVersion].join(':'),
      setupId:native?item.ruleId:item.setupId,ruleIds:native?[item.ruleId]:item.patternIds?.slice()||[],anchorDay:batch.day,phase:'close',state,qualified,qualification:qualified?'qualified_observation':'unqualified_observation',
      generation:batch.generation,sourceId:batch.sourceId,day:batch.day,asOf:batch.asOf,sourceFetchedAt:item.sourceFetchedAt,actualDiscoveryAt:item.actualDiscoveryAt,conditionKnownAfter:known,activeUntil:item.activeUntil,
      reference:{close:item.closePrice,trigger:native?item.originalReference?.entry??null:item.trigger?.above??null,invalidation:native?item.originalReference?.stop??null:item.invalidation?.below??null},chartUrls:chartUrls(item,batch,native),reasons:Array.isArray(item.reasons)?item.reasons.slice():[],research:{rules:(native?[rule]:(item.patternIds||[]).map(id=>entryPatterns.get(id))).filter(Boolean).map(researchSummary),institutionalEvidence:null},actualFillVerified:false};
    row.id=idOf(row);if(seen.has(row.id))throw Error('Opportunity tracking current opportunity is duplicated');seen.add(row.id);
    if(Date.parse(row.activeUntil)>now)rows.push(row);
  }
  return rows;
}

function watchRows(rows,batch,now,core=[]){
  if(!Array.isArray(rows))throw Error('Additional current watches must be a list');
  const seen=new Set(),coreCodes=new Set(core.map(row=>row.code));
  return rows.map(item=>{
    const family=['close-limitup-watch','institution-disclosure-watch'].includes(item.familyId);
    if(!family||item.ruleVersion!==watchVersion||!same(item,batch)||!code(item.code)||coreCodes.has(item.code)||item.id!==idOf(item)||seen.has(item.id)||item.setupId!==item.familyId+':'+batch.day||item.anchorDay!==batch.day||item.phase!=='close'||item.state!=='watch'||item.qualified!==false||item.eligibleForSelection===true||item.qualification!=='unqualified_observation'||item.actualFillVerified!==false||!Array.isArray(item.ruleIds)||item.ruleIds.some(id=>typeof id!=='string')||!Array.isArray(item.reasons)||!item.research||!finite(item.reference?.close)||item.reference.close<=0||item.reference.trigger!==null||item.reference.invalidation!==null)throw Error('Additional current rows must remain distinct unqualified close watches');
    const source=Date.parse(item.sourceFetchedAt),discovered=Date.parse(item.actualDiscoveryAt),first=Date.parse(item.firstSeenAt),known=Date.parse(item.conditionKnownAfter),until=Date.parse(item.activeUntil);
    if(![source,discovered,first,known,until].every(finite)||source<Date.parse(batch.asOf)||discovered<source||discovered>now||first<discovered||first>now||known<closeAt(batch.day)||known>discovered||until<=closeAt(batch.day))throw Error('Additional current watch source, first-seen or condition time is invalid');
    seen.add(item.id);return clone(item);
  });
}
function verifyFrozenWatches(report,additionalCurrent,batch,now){
  const rows=watchRows(additionalCurrent,batch,now),tracks=new Map(report.tracks.map(track=>[track.id,track]));
  for(const row of rows){
    const original=tracks.get(row.id)?.original;
    if(!original||Object.keys(row).some(key=>!isDeepStrictEqual(row[key],original[key])))throw Error('This source generation was already frozen without the same additional watches; use a new completed generation');
  }
}

function validatePrevious(previous,now){
  if(previous===null)return;
  if(previous?.schema!==schema||previous.version!==version||previous.completed!==true||previous.datasetBound!==true||!day(previous.day)||!time(previous.asOf)||!time(previous.computedAt)||Date.parse(previous.computedAt)>now||!Array.isArray(previous.current)||!Array.isArray(previous.tracks))throw Error('Opportunity tracking prior snapshot is incomplete');
  const seen=new Set();for(const track of previous.tracks){
    if(!track.original||track.id!==idOf(track.original)||seen.has(track.id)||!code(track.original.code)||!day(track.original.anchorDay)||typeof track.original.qualified!=='boolean'||track.original.actualFillVerified!==false||!time(track.firstSeenAt)||Date.parse(track.firstSeenAt)>Date.parse(previous.computedAt)||!time(track.original.sourceFetchedAt)||!time(track.original.actualDiscoveryAt)||Date.parse(track.firstSeenAt)<Math.max(Date.parse(track.original.sourceFetchedAt),Date.parse(track.original.actualDiscoveryAt))||!track.observations||Object.keys(track.observations).some(key=>!horizons.includes(Number(key))))throw Error('Opportunity tracking prior episode identity is invalid');
    for(const value of Object.values(track.observations))if(!['pending','ready','unavailable','not_observable'].includes(value.status)||value.status==='ready'&&(!finite(value.returnPercent)||!day(value.targetDay)||closeAt(value.targetDay)<=Date.parse(track.firstSeenAt)))throw Error('Opportunity tracking prior outcome is invalid or predates first sight');
    seen.add(track.id);
  }
}

/** Uses actual session positions and same-batch qfq prices; never turns missing data into a zero. */
export function observeOpportunity(track,{source,reference,batch,now=Date.now()}){
  validateBatch(batch,now);referenceCalendar(reference,batch);
  if(!time(track.firstSeenAt)||Date.parse(track.firstSeenAt)>now||source&&(!time(source.fetchedAt)||Date.parse(source.fetchedAt)>now||Date.parse(source.fetchedAt)<Date.parse(batch.asOf)||source.sourceId!==batch.sourceId||source.day!==batch.day))throw Error('Opportunity tracking observation time or source is invalid');
  const original=track.original,intraday=original.phase==='a14',dates=reference.bars.map(bar=>bar.date),anchor=dates.indexOf(original.anchorDay),bars=new Map((source?.bars||[]).map(bar=>[bar.date,bar])),observations=clone(track.observations);
  let basis=anchor;
  if(intraday){
    const quote=Date.parse(original.quoteSourceAt),received=Date.parse(original.receivedAt),clock=value=>new Date(value+8*3600000).toISOString(),inWindow=value=>clock(value).slice(0,10)===original.anchorDay&&clock(value).slice(11,19)>='14:00:00'&&clock(value).slice(11,19)<='14:10:00';
    if(original.sourceId!=='tencent-public-stock-quotes-v1'||!time(original.quoteSourceAt)||!time(original.receivedAt)||!inWindow(quote)||!inWindow(received)||quote>received||received>Date.parse(track.firstSeenAt)||!day(original.basisDay)||original.basisDay>=original.anchorDay||!finite(original.basisClose)||original.basisClose<=0||!finite(original.quotePrevClose)||original.quotePrevClose<=0||Math.abs(original.quotePrevClose-original.basisClose)>.011||!finite(original.reference?.close)||original.reference.close<=0||typeof original.historySourceId!=='string')throw Error('Opportunity tracking 14:00 quote time or frozen price basis is unverified');
    basis=dates.indexOf(original.basisDay);
  }
  for(const horizon of horizons){
    if(['ready','not_observable'].includes(observations[horizon]?.status))continue;
    const targetDay=anchor>=0?dates[anchor+horizon]||null:null;
    const method=intraday?'intraday_reference_rebased_to_same_batch_qfq_not_trade_return':'same_batch_qfq_close_change_not_trade_return';
    const observation={horizon,targetDay,status:'pending',returnPercent:null,reason:'awaiting_completed_trading_session',checkedAt:new Date(now).toISOString(),generation:batch.generation,sourceId:batch.sourceId,asOf:batch.asOf,sourceFetchedAt:source?.fetchedAt||null,method};
    if((intraday?original.historySourceId:original.sourceId)!==batch.sourceId){observation.status='unavailable';observation.reason='source_changed';}
    else if(anchor<0||basis<0){observation.status='unavailable';observation.reason='anchor_outside_verified_calendar';}
    else if(targetDay){
      if(closeAt(targetDay)<=Date.parse(track.firstSeenAt)){observation.status='not_observable';observation.reason='target_close_not_after_first_actual_sight';}
      else if(!source||source.status!=='ready'||source.adjustment!=='qfq'){observation.status='unavailable';observation.reason='missing_same_source_qfq_history';}
      else if(dates.slice(basis,anchor+horizon+1).some(date=>!validBar(bars.get(date)))){observation.status='unavailable';observation.reason='suspension_missing_or_zero_trade_session';}
      else{const entry=intraday?original.reference.close*(bars.get(original.basisDay).close/original.basisClose):bars.get(dates[anchor]).close,value=(bars.get(targetDay).close/entry-1)*100;if(finite(value)){observation.status='ready';observation.returnPercent=value;observation.reason=method;}else{observation.status='unavailable';observation.reason='nonfinite_close_change';}}
    }
    observations[horizon]=observation;
  }
  return {...track,observations};
}

/** Pure builder: the input record iterator is consumed exactly once. */
export async function buildOpportunityWorkbench({batch,reference,records,entryReport,viprasolReport,previous=null,additionalTracks=[],additionalCurrent=[],now=Date.now,signal,onProgress=()=>{}}){
  const checked=now(),computedAt=new Date(checked).toISOString();validateBatch(batch,checked);referenceCalendar(reference,batch);validatePrevious(previous,checked);
  if(previous&&(previous.day>batch.day||Date.parse(previous.asOf)>Date.parse(batch.asOf)))throw Error('Opportunity tracking cannot move its source date backwards');
  const marketContext=describeMarketContext(reference,batch),current=currentRows(entryReport,viprasolReport,batch,checked),tracks=clone(previous?.tracks||[]),byId=new Map(tracks.map(track=>[track.id,track]));
  current.push(...watchRows(additionalCurrent,batch,checked,current));
  const additionalIds=new Set(additionalCurrent.map(row=>row.id));
  validatePrevious({schema,version,completed:true,datasetBound:true,...batch,computedAt,current:[],tracks:additionalTracks},checked);
  for(const track of additionalTracks){
    if(track.original.phase!=='a14'||track.original.anchorDay>batch.day)throw Error('Only actually captured intraday episodes up to this completed day may be adopted');
    const old=byId.get(track.id);if(old){if(old.firstSeenAt!==track.firstSeenAt||!isDeepStrictEqual(old.original,track.original))throw Error('Frozen intraday episode changed after first sight');continue;}
    const frozen=clone(track);tracks.push(frozen);byId.set(frozen.id,frozen);
  }
  for(const row of current){
    if(!byId.has(row.id)){const track={id:row.id,firstSeenAt:row.firstSeenAt||computedAt,original:clone({...row,marketContext}),observations:{}};tracks.push(track);byId.set(row.id,track);}
    else if(additionalIds.has(row.id)&&Object.keys(row).some(key=>!isDeepStrictEqual(row[key],byId.get(row.id).original[key])))throw Error('Frozen additional close watch changed after first sight');
    row.firstSeenAt=byId.get(row.id).firstSeenAt;
  }
  const currentById=new Map(current.map(row=>[row.id,row])),byCode=new Map();for(const [index,track]of tracks.entries()){const list=byCode.get(track.original.code)||[];list.push(index);byCode.set(track.original.code,list);}
  const seen=new Set();let count=0;
  for await(const {stock,source}of records){
    signal?.throwIfAborted();
    if(!code(stock?.code)||seen.has(stock.code)||source?.sourceId!==batch.sourceId||source.day!==batch.day||!['ready','unavailable'].includes(source.status)||source.status==='ready'&&source.adjustment!=='qfq'||!Array.isArray(source.bars)||source.bars.length>500||source.bars.some((bar,index)=>!day(bar.date)||bar.date>batch.day||index&&bar.date<=source.bars[index-1].date)||!time(source.fetchedAt)||Date.parse(source.fetchedAt)<Date.parse(batch.asOf)||Date.parse(source.fetchedAt)>checked)throw Error('Opportunity tracking history source, qfq basis, date, order or code is invalid');
    seen.add(stock.code);count++;
    for(const index of byCode.get(stock.code)||[]){
      const track=tracks[index];
      const currentRow=currentById.get(track.id);
      if(currentRow&&(!validBar(source.bars.at(-1))||source.bars.at(-1).date!==batch.day||currentRow.reference.close!==source.bars.at(-1).close||currentRow.sourceFetchedAt!==source.fetchedAt))throw Error('Opportunity tracking current close differs from its original source');
      tracks[index]=observeOpportunity(track,{source,reference,batch,now:checked});
    }
    if(count%100===0)await onProgress({stage:'opportunity-tracking',checked:count,total:batch.total});
  }
  if(count!==batch.total||current.some(row=>!seen.has(row.code)))throw Error('Opportunity tracking private history coverage is incomplete');
  for(const [stockCode,indexes]of byCode)if(!seen.has(stockCode))for(const index of indexes)tracks[index]=observeOpportunity(tracks[index],{source:null,reference,batch,now:checked});
  const mapped=new Map(tracks.map(track=>[track.id,track]));for(const row of current)row.observations=clone(mapped.get(row.id).observations);
  return {schema,version,completed:true,datasetBound:true,...Object.fromEntries(['generation','sourceId','day','asOf'].map(key=>[key,batch[key]])),computedAt,marketContext,current,tracks,
    summary:{candidateCount:current.length,stockCount:new Set(current.map(row=>row.code)).size,nearBCount:current.filter(row=>row.state==='near_B').length,triggeredBCount:current.filter(row=>row.state==='triggered_B').length,watchCount:current.filter(row=>row.state==='watch').length,qualifiedCount:current.filter(row=>row.qualified).length,trackCount:tracks.length,thirdSessionReadyCount:tracks.filter(track=>track.observations[3]?.status==='ready').length},
    method:{observation:'same_batch_qfq_close_change_not_trade_return',horizons,anchor:'source_day_close',firstSeen:'first_actual_tracking_run_never_backdated',selection:'original_16_and_13_gates_unchanged',marketContext:'causal_benchmark_trend_only_not_complete_historical_bull_bear_preference',savedScheme15DayPolicyChanged:false}};
}

/** Serving-time freshness changes the view, never the frozen episode or outcome. */
export function viewOpportunityWorkbench(report,{now=Date.now()}={}){
  validatePrevious(report,now);
  const current=report.current.map(row=>({...row,active:Date.parse(row.activeUntil)>now,displayState:Date.parse(row.activeUntil)>now?row.state:'expired'}));
  return {...report,current,servedAt:new Date(now).toISOString(),liveCandidateCount:current.filter(row=>row.active).length,liveQualifiedCount:current.filter(row=>row.active&&row.qualified).length};
}

async function publishPointer(dir,batch){
  const current=await readStoredJson(join(dir,'current.json'));if(!same(current,batch))throw Error('Opportunity tracking source generation changed during calculation');
  const root=join(dir,directoryName);await mkdir(root,{recursive:true});
  const marker={schema,version,...Object.fromEntries(['generation','sourceId','day','asOf'].map(key=>[key,batch[key]]))};await writeFile(join(root,'current.json.tmp'),JSON.stringify(marker));await rename(join(root,'current.json.tmp'),join(root,'current.json'));
}

/** Reads existing complete reports and private history only; never collects or changes the source pointer. */
export async function runOpportunityTracking({dir,additionalCurrent=[],now=Date.now,signal,onProgress=()=>{}}){
  const batch=await readStoredJson(join(dir,'current.json')),checked=now();validateBatch(batch,checked);
  const target=join(dir,'generations',batch.generation),complete=await readStoredJson(join(target,'complete.json'));
  if(complete.completed!==true||!same(complete,batch)||complete.total!==batch.total||complete.ready!==batch.ready||complete.fullMarket!==true||batch.total<1000||!Number.isInteger(batch.ready)||batch.ready>batch.total||batch.ready/batch.total<.8||batch.dataPolicy?.rawPublic!==false)throw Error('Opportunity tracking needs an existing complete private market generation');
  const root=join(dir,directoryName),pointer=await optionalJson(join(root,'current.json'));
  if(pointer&&(pointer.schema!==schema||pointer.version!==version||!/^[0-9TZ-]{1,80}$/.test(pointer.generation||'')))throw Error('Opportunity tracking own pointer identity is invalid');
  const previous=pointer?await readStoredJson(join(dir,'generations',pointer.generation,directoryName,'report.json')):null;
  validatePrevious(previous,checked);if(previous&&!same(pointer,previous))throw Error('Opportunity tracking own pointer differs from its ledger snapshot');
  if(previous?.generation===batch.generation){verifyFrozenWatches(previous,additionalCurrent,batch,checked);return viewOpportunityWorkbench(previous,{now:checked});}
  if(previous&&(previous.day>batch.day||Date.parse(previous.asOf)>Date.parse(batch.asOf)))throw Error('Opportunity tracking cannot move its source date backwards');
  const archived=await optionalJson(join(target,directoryName,'report.json'));
  if(archived){validatePrevious(archived,checked);if(!same(archived,batch))throw Error('Opportunity tracking recovered snapshot belongs to another generation');verifyFrozenWatches(archived,additionalCurrent,batch,checked);await publishPointer(dir,batch);return viewOpportunityWorkbench(archived,{now:checked});}
  const entryReport=await readStoredJson(join(target,'entry-current-v2','report.json')),viprasolReport=await readStoredJson(join(target,'viprasol-study-v1','report.json'));
  if(complete.closeCandidateVersion!==entryReport.version||complete.viprasolStudyVersion!==viprasolReport.version||complete.viprasolImplementationCommit!==viprasolReport.implementationCommit)throw Error('Opportunity tracking report versions differ from the completed generation');
  const iterator=readHistoryLines(join(dir,'private','generations',batch.generation,'history-all.ndjson'))[Symbol.asyncIterator]();let report;
  const intradayRoot=join(dir,'intraday-preselection-v1','days'),additionalTracks=[];
  let intradayDays=[];try{intradayDays=await readdir(intradayRoot);}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const capturedDay of intradayDays.filter(value=>day(value)&&value<=batch.day).sort()){
    const snapshot=await optionalJson(join(intradayRoot,capturedDay,'report.json'));if(!snapshot)continue;
    if(snapshot.schema!==schema||snapshot.version!==version||snapshot.phase!=='a14'||snapshot.completed!==true||snapshot.day!==capturedDay||!Array.isArray(snapshot.tracks))throw Error('Frozen intraday snapshot identity is invalid');
    validatePrevious(snapshot,checked);additionalTracks.push(...snapshot.tracks);
  }
  try{
    const first=await iterator.next();if(first.done)throw Error('Opportunity tracking private history is empty');const header=JSON.parse(first.value);
    if(header.schema!=='books.a-share.history.v1'||!same(header,batch)||header.total!==batch.total||header.historyRequested!==500)throw Error('Opportunity tracking raw header differs from its generation');
    const records=(async function*(){for(let next=await iterator.next();!next.done;next=await iterator.next())yield JSON.parse(next.value);})();
    report=await buildOpportunityWorkbench({batch,reference:header.reference,records,entryReport,viprasolReport,previous,additionalTracks,additionalCurrent,now:()=>checked,signal,onProgress});
  }finally{await iterator.return?.();}
  const stage=await mkdtemp(join(target,'.opportunity-workbench-'));
  try{
    const body=JSON.stringify(report);await writeFile(join(stage,'report.json'),body);await writeFile(join(stage,'report.json.gz'),gzipSync(body));
    const current=await readStoredJson(join(dir,'current.json'));if(!same(current,batch))throw Error('Opportunity tracking source generation changed during calculation');
    signal?.throwIfAborted();await rename(stage,join(target,directoryName));await publishPointer(dir,batch);
    return viewOpportunityWorkbench(report,{now:checked});
  }finally{await rm(stage,{recursive:true,force:true});}
}
