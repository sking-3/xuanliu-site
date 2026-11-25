import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {readStoredFile,readStoredJson} from './a-share-retention.mjs';
import {runOpportunityTracking,viewOpportunityWorkbench,directoryName as trackingDirectory,version as trackingVersion,schema as trackingSchema} from './a-share-opportunity-tracking.mjs';
import {precomputeMarketPreference,filename as preferenceFilename,version as preferenceVersion} from './a-share-market-preference.mjs';
import {collectInstitutionDisclosures,readInstitutionDisclosures} from './a-share-institution-disclosures.mjs';
import {precomputeDeskWatches,filename as watchFilename,version as watchVersion,schema as watchSchema,chartDirectoryName as watchChartDirectory} from './a-share-desk-watches.mjs';
import {writeIntradayCharts} from './a-share-intraday-chart.mjs';

export const schema='books.a-share.desk.v1',directoryName='stock-desk-v1';
const require=createRequire(import.meta.url),same=(a,b)=>['generation','sourceId','day','asOf'].every(key=>a?.[key]===b?.[key]);
const generation=value=>/^[0-9TZ-]{1,80}$/.test(value||''),mainBoard=value=>/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(value||'');
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const cnDay=value=>new Date(value+8*3600000).toISOString().slice(0,10),stamp=now=>new Date(now()).toISOString();
async function optional(file){try{return await readStoredJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function save(file,value){await writeFile(file+'.tmp',JSON.stringify(value));await rename(file+'.tmp',file);}

function validatePreference(value,batch){
  if(value?.schema!=='books.a-share.market-preference.v1'||value.version!==preferenceVersion||value.completed!==true||value.datasetBound!==true||!same(value,batch)||value.policy?.horizon!==3||value.policy.minSamples!==30||value.policy.minStocks!==10||value.policy.minSignalDays!==10||value.eligibleForSelection!==false||!Array.isArray(value.byRegime)||!Array.isArray(value.adequateRanking))throw Error('Workbench market preference differs from the completed source batch');
}
function enrichClose(report,preference,institutions,now){
  validatePreference(preference,report);
  const view=viewOpportunityWorkbench(report,{now}),regime=preference.currentRegime.state,patterns=preference.byRegime.find(item=>item.regime===regime)?.patterns||[];
  const preferences={regime,horizon:3,minSamples:30,minStocks:10,minSignalDays:10,patterns,rankingOnly:true,historicalMembership:false,fullMarketCycleVerified:false};
  const current=view.current.map(row=>({...row,research:{...row.research,regimePreference:patterns.filter(item=>row.ruleIds.includes(item.patternId)),institutionalEvidence:institutions.byCode[row.code]||[]}}));
  const ranks=new Map(preference.adequateRanking.filter(item=>item.regime===regime&&item.adequate===true&&item.sampleCount>=preference.policy.minSamples&&item.stockCount>=preference.policy.minStocks&&item.signalDayCount>=preference.policy.minSignalDays&&Number.isInteger(item.rank)&&item.rank>0).map(item=>[item.patternId,item.rank])),layers=new Map();
  current.forEach((row,index)=>{if((row.strategy||'trend')!=='trend')return;const key=row.state+':'+row.qualified;if(!layers.has(key))layers.set(key,[]);layers.get(key).push(index);});
  for(const positions of layers.values()){
    const ordered=positions.map(index=>({row:current[index],index,rank:Math.min(Infinity,...current[index].ruleIds.map(id=>ranks.get(id)??Infinity))}));
    ordered.sort((a,b)=>a.rank===b.rank?a.index-b.index:a.rank-b.rank);
    positions.forEach((position,index)=>{current[position]=ordered[index].row;});
  }
  return {...view,marketContext:{...view.marketContext,preferences,topRanking:preference.adequateRanking},current};
}

function validateA14(report,now){
  if(report?.schema!==trackingSchema||report.version!==trackingVersion||report.phase!=='a14'||report.completed!==true||report.datasetBound!==true||report.sourceId!=='tencent-public-stock-quotes-v1'||!generation(report.generation)||!generation(report.historyGeneration)||typeof report.historySourceId!=='string'||!day(report.day)||!Number.isFinite(Date.parse(report.computedAt))||Date.parse(report.computedAt)>now||!Array.isArray(report.current)||report.current.length>20||!Array.isArray(report.tracks))throw Error('14:00 snapshot identity is invalid');
  const from=Date.parse(report.day+'T14:00:00+08:00'),until=Date.parse(report.day+'T14:10:00+08:00'),seen=new Set();
  if(Date.parse(report.computedAt)<from||Date.parse(report.computedAt)>until)throw Error('14:00 snapshot was not captured in its source window');
  for(const row of report.current){
    const quote=Date.parse(row.quoteSourceAt),received=Date.parse(row.receivedAt),first=Date.parse(row.firstSeenAt),id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);
    if(!mainBoard(row.code)||seen.has(row.id)||row.id!==id||row.phase!=='a14'||!['generation','sourceId','day'].every(key=>row[key]===report[key])||Date.parse(row.asOf)!==quote||row.anchorDay!==report.day||row.historyGeneration!==report.historyGeneration||row.historySourceId!==report.historySourceId||![quote,received,first].every(Number.isFinite)||quote<from||quote>until||received<quote||received>until||first<received||first>Date.parse(report.computedAt)||row.sourceFetchedAt!==row.receivedAt||row.actualDiscoveryAt!==row.receivedAt||row.qualified!==false||row.actualFillVerified!==false)throw Error('14:00 snapshot row source or capture time is invalid');
    seen.add(row.id);
  }
}
async function readA14(dir,now){
  const root=join(dir,'intraday-preselection-v1'),attempt=await optional(join(root,'status.json')),report=await optional(join(root,'current.json'));
  if(report){validateA14(report,now);const frozen=await readStoredJson(join(root,'days',report.day,'report.json'));if(!isDeepStrictEqual(report,frozen))throw Error('14:00 published snapshot differs from its frozen archive');}
  const held=attempt?.status==='held',failed=attempt?.status==='failed';
  return {status:held?'held':failed?'unavailable':report?'ready':'not_collected',reason:attempt?.error||(report?null:'尚未取得14:00–14:10的真实小名单快照。'),data:report,attempt:attempt||null};
}
function projectA14(value,close,now){
  if(!value.data)return value;
  const observed=new Map((close?.tracks||[]).map(track=>[track.id,track]));
  const observation=row=>structuredClone(observed.get(row.id)?.observations||row.observations||{});
  const current=value.data.current.map(row=>({...row,observations:observation(row),active:Date.parse(row.activeUntil)>now,displayState:Date.parse(row.activeUntil)>now?row.state:'expired'}));
  return {...value,data:{...value.data,current,tracks:value.data.tracks.map(track=>({...track,observations:observation(track)})),observationDay:close?.day||null,observationGeneration:close?.generation||null,observationAsOf:close?.asOf||null,servedAt:new Date(now).toISOString(),liveCandidateCount:current.filter(row=>row.active).length,liveQualifiedCount:0}};
}

/** Read-only presentation: never starts collectors, rewrites a frozen episode, or grants eligibility. */
export async function readStockDesk({dir,now=Date.now()}={}){
  let close={status:'unavailable',data:null},a14,institutions;
  const attempt=await optional(join(dir,directoryName,'status.json'));
  try{const value=await readInstitutionDisclosures({dataDir:dir});institutions={...value,status:['complete','partial'].includes(value.status)?'ready':['held','failed'].includes(value.status)?value.status:'held',partial:value.status==='partial'};}
  catch(error){institutions={status:'failed',checkedAt:null,byCode:{},reason:error.message};}
  if(attempt?.institutions?.status==='failed'&&(!institutions.checkedAt||Date.parse(attempt.institutions.checkedAt)>=Date.parse(institutions.checkedAt)))institutions={...institutions,...attempt.institutions};
  try{
    const marker=await optional(join(dir,directoryName,'current.json'));
    if(marker){
      if(marker.schema!==schema||!generation(marker.generation))throw Error('Workbench pointer is invalid');
      const target=join(dir,'generations',marker.generation),complete=await readStoredJson(join(target,'complete.json'));
      const report=await readStoredJson(join(target,trackingDirectory,'report.json')),preference=await readStoredJson(join(target,preferenceFilename+'.json'));
      if(complete.completed!==true||!same(complete,marker)||!same(report,marker))throw Error('Workbench report is not bound to a completed generation');
      close={status:'ready',data:enrichClose(report,preference,institutions,now)};
    }
  }catch(error){close={status:'unavailable',data:null,reason:error.message};}
  try{a14=projectA14(await readA14(dir,now),close.data,now);}catch(error){a14={status:'unavailable',reason:error.message,data:null};}
  return {schema,close,a14,institutions,attempt};
}

/** Only a published frozen 14:00 row can expose its derived chart; raw quote archives stay private. */
export async function readA14Chart({dir,day:requestedDay,code,window,compressed=false,now=Date.now()}={}){
  if(!day(requestedDay)||!mainBoard(code)||![60,120].includes(Number(window)))return null;
  const value=await readA14(dir,now),report=value.data;
  if(!report||report.day!==requestedDay||!report.current.some(row=>row.code===code))return null;
  const file=join(dir,'intraday-preselection-v1','days',requestedDay,'charts',code+'-'+window+'.svg');
  return {body:await readStoredFile(compressed?file+'.gz':file),compressed};
}

export async function readWorkbenchChart({dir,generation:requestedGeneration,code,window,compressed=false}={}){
  if(!generation(requestedGeneration)||!mainBoard(code)||![60,120].includes(Number(window)))return null;
  const marker=await optional(join(dir,directoryName,'current.json'));
  if(marker?.schema!==schema||marker.generation!==requestedGeneration)return null;
  const target=join(dir,'generations',requestedGeneration),complete=await readStoredJson(join(target,'complete.json')),report=await readStoredJson(join(target,watchFilename+'.json'));
  if(complete.completed!==true||!same(complete,marker)||report.schema!==watchSchema||report.version!==watchVersion||report.completed!==true||report.datasetBound!==true||!same(report,marker)||!Array.isArray(report.current)||!Array.isArray(report.charts))return null;
  const path=watchChartDirectory+'/'+code+'-'+window+'.svg',chart=report.charts.find(item=>item.code===code&&item.window===Number(window));
  if(!report.current.some(row=>row.code===code&&row.qualified===false&&row.state==='watch'&&same(row,marker))||!chart||!same(chart,marker)||chart.path!==path||chart.priceBasis!=='first-close-percent')return null;
  const file=join(target,path);return {body:await readStoredFile(compressed?file+'.gz':file),compressed};
}

function nextVerifiedSession(calendar,sourceDay){
  for(let index=1;index<=14;index++){
    const date=new Date(Date.parse(sourceDay+'T00:00:00Z')+index*86400000).toISOString().slice(0,10),session=calendar.session('CN',date);
    if(!session.verified)return null;if(session.open)return date;
  }
  return null;
}

function readUniverse(dir,batch){
  const db=new DatabaseSync(join(dir,'collector.sqlite'),{readOnly:true});
  try{
    const frozen=db.prepare('SELECT as_of,snapshot_json FROM batches_v2 WHERE source_id=? AND day=?').get(batch.sourceId,batch.day),snapshot=frozen&&JSON.parse(frozen.snapshot_json);
    if(!frozen||frozen.as_of!==batch.asOf||snapshot?.schema!=='books.a-share.universe.v1'||snapshot.day!==batch.day||!Array.isArray(snapshot.universe)||snapshot.universe.length!==batch.total)throw Error('Institution enrichment has no matching frozen market roster');
    const codes=snapshot.universe.map(stock=>stock.code);if(codes.some(code=>!mainBoard(code))||new Set(codes).size!==codes.length)throw Error('Institution enrichment frozen market roster is invalid');return codes;
  }finally{db.close();}
}

/** Runs after a successful close publication; optional disclosure failures do not discard price tracking. */
export async function runStockDesk({dir,siteDir,now=Date.now,signal,onProgress=()=>{},track=runOpportunityTracking,precompute=precomputeMarketPreference,collectInstitutions=collectInstitutionDisclosures,fetch}={}){
  const root=join(dir,directoryName);await mkdir(root,{recursive:true});
  const previousAttempt=await optional(join(root,'status.json'));
  const attempt={status:'running',stage:'institutions',startedAt:stamp(now),finishedAt:null,error:null,institutions:null};
  const progress=async fields=>{Object.assign(attempt,fields);await save(join(root,'status.json'),attempt);await onProgress({...attempt});};
  try{
    const batch=await readStoredJson(join(dir,'current.json'));if(!generation(batch.generation))throw Error('Workbench source generation is invalid');
    Object.assign(attempt,Object.fromEntries(['generation','sourceId','day','asOf'].map(key=>[key,batch[key]])));await progress({});
    const target=join(dir,'generations',batch.generation),complete=await readStoredJson(join(target,'complete.json'));
    const entry=await readStoredJson(join(target,'entry-current-v2','report.json')),viprasol=await readStoredJson(join(target,'viprasol-study-v1','report.json'));
    if(complete.completed!==true||!same(complete,batch)||[entry,viprasol].some(report=>report.completed!==true||!same(report,batch)||!Array.isArray(report.current)))throw Error('Workbench core reports differ from the completed source batch');
    const existingCodes=new Set([...entry.current,...viprasol.current].map(row=>row.code));let institutions={byCode:{}};
    try{
      institutions=await readInstitutionDisclosures({dataDir:dir});
      const previous=institutions;
      let checked=null;
      if(previous.checkedAt&&cnDay(Date.parse(previous.checkedAt))===cnDay(now()))checked=previous;
      else if(previousAttempt?.institutions?.checkedAt&&cnDay(Date.parse(previousAttempt.institutions.checkedAt))===cnDay(now()))checked=previousAttempt.institutions;
      if(checked)attempt.institutions={status:checked.status,checkedAt:checked.checkedAt,reason:checked.reason||null,skipped:'already_checked_today'};
      else{
        institutions=await collectInstitutions({dataDir:dir,allowedUniverse:readUniverse(dir,batch),selectedCodes:[...existingCodes].slice(0,20),now,fetch});
        attempt.institutions={status:institutions.status,checkedAt:institutions.checkedAt,reason:institutions.reason||null};
      }
    }catch(error){attempt.institutions={status:'failed',checkedAt:stamp(now),reason:error.message};}
    await progress({stage:'desk-watches',checked:0,total:batch.total});
    const historyFile=join(dir,'private','generations',batch.generation,'history-all.ndjson');
    const watches=await precomputeDeskWatches({historyFile,target,batch,institutions,existingCodes,nextSessionDay:nextVerifiedSession(require(join(siteDir,'market-calendar.js')),batch.day),now,writeChart:writeIntradayCharts,signal,onProgress:progress});
    await progress({stage:'tracking',checked:0,total:batch.total});
    const tracked=await track({dir,additionalCurrent:watches.current,now,signal,onProgress:progress});if(!same(tracked,batch))throw Error('Workbench tracker changed source batches');
    await progress({stage:'market-preference',checked:0,total:batch.total});
    const preference=await precompute({historyFile,target,batch,patterns:require(join(siteDir,'screening/trend-patterns.js')),now,signal,onProgress:progress});validatePreference(preference,batch);
    const current=await readStoredJson(join(dir,'current.json'));if(!same(current,batch))throw Error('Workbench source generation changed during production');
    signal?.throwIfAborted();await save(join(root,'current.json'),{schema,...Object.fromEntries(['generation','sourceId','day','asOf'].map(key=>[key,batch[key]]))});
    await progress({status:'complete',stage:'published',finishedAt:stamp(now)});return {attempt};
  }catch(error){await progress({status:'failed',finishedAt:stamp(now),error:error.message});return {attempt};}
}
