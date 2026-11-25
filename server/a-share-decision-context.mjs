import {mkdir,mkdtemp,writeFile,rename,rm,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {readStoredJson} from './a-share-retention.mjs';
import {observeOpportunity} from './a-share-opportunity-tracking.mjs';
import {definitions,version as ruleVersion} from './a-share-daily-setups.mjs';
import {version as positionVersion} from './a-share-market-position.mjs';

export const filename='decision-context-v1',chartDirectoryName='decision-context-v1-charts';
export const version='books.a-share.decision-context.2026-11-25.v1',schema='books.a-share.decision-context.v1';
const binding=['sourceId','generation','day','asOf'],same=(a,b)=>binding.every(key=>a?.[key]===b?.[key]);
const finite=Number.isFinite,validBar=bar=>bar&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const kinds=new Set(definitions.map(item=>item.id));
const identity=value=>Object.fromEntries(binding.map(key=>[key,value[key]]));
async function optional(path){try{return await readStoredJson(path);}catch(error){if(error.code!=='ENOENT')throw error;return null;}}
async function save(path,value){const body=JSON.stringify(value);await writeFile(path+'.tmp',body);await writeFile(path+'.gz.tmp',gzipSync(body));await rename(path+'.gz.tmp',path+'.gz');await rename(path+'.tmp',path);}
async function publishCharts(staged,target){
 try{await rename(staged,target);return;}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
 const paths=await readdir(staged,{recursive:true}),existing=await readdir(target,{recursive:true});if(JSON.stringify(paths.sort())!==JSON.stringify(existing.sort()))throw Error('Decision chart recovery paths differ from frozen source');
 for(const path of paths.filter(path=>path.endsWith('.svg')||path.endsWith('.svg.gz')))if(!(await readFile(join(staged,path))).equals(await readFile(join(target,path))))throw Error('Decision chart recovery would replace a different frozen chart');
}

export function validateDecisionContext(report,batch,now=Date.now()){
 if(report?.schema!==schema||report.version!==version||report.completed!==true||report.datasetBound!==true||!same(report,batch)||!finite(Date.parse(report.computedAt))||Date.parse(report.computedAt)>now||!Array.isArray(report.current)||!Array.isArray(report.tracks)||!Array.isArray(report.charts)||report.eligibleForSelection!==false)throw Error('Decision context differs from its completed source batch');
 const seen=new Set();
 for(const row of report.current){
  const plan=row.research?.plan,kind=plan?.kind,id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);
  if(!same(row,batch)||seen.has(id)||row.id!==id||row.familyId!=='daily-setup-watch'||row.ruleVersion!==ruleVersion||!kinds.has(kind)||row.setupId!==kind+':'+batch.day||row.anchorDay!==batch.day||row.phase!=='close'||!same(plan,batch)||plan.priceBasis!=='same_batch_qfq'||plan.qualified!==false||row.qualified!==false||row.actualFillVerified!==false||plan.actualFillVerified!==false||!['watch','near_B'].includes(row.state)||!finite(row.reference?.close)||row.reference.close<=0||row.reference.trigger!==plan.trigger||row.reference.invalidation!==plan.invalidation||!finite(Date.parse(row.firstSeenAt))||Date.parse(row.firstSeenAt)>now)throw Error('Decision context row identity, source or qualification changed');
  const track=report.tracks.find(item=>item.id===id);if(!track||track.firstSeenAt!==row.firstSeenAt||track.original.id!==id||track.original.firstSeenAt!==row.firstSeenAt)throw Error('Decision context first observation was not retained');seen.add(id);
 }
 return report;
}

function makeRow(code,value,setup,batch,computedAt,activeUntil){
 const plan={...setup,code,kind:setup.id,version:ruleVersion,...identity(batch),priceBasis:'same_batch_qfq',signalDay:batch.day,holdingRequired:setup.id==='range-support'};
 const distance=(value.metrics.close/setup.trigger-1)*100;
 const row={code,name:value.name,familyId:'daily-setup-watch',ruleVersion,setupId:setup.id+':'+batch.day,ruleIds:[setup.id],anchorDay:batch.day,phase:'close',state:setup.id==='range-support'?'watch':distance>=-2?'near_B':'watch',qualified:false,qualification:'unqualified_observation',...identity(batch),sourceFetchedAt:value.sourceFetchedAt,actualDiscoveryAt:computedAt,firstSeenAt:computedAt,conditionKnownAfter:batch.asOf,activeUntil,strategy:'trend',label:setup.label,reference:{close:value.metrics.close,trigger:setup.trigger,invalidation:setup.invalidation},distanceToTriggerPct:distance,chartUrls:Object.fromEntries([60,120].map(window=>[window,'/api/a-share-daily/context-chart?'+new URLSearchParams({generation:batch.generation,code,kind:setup.id,window:String(window)})])),reasons:setup.reason,research:{rules:[{id:setup.id,label:setup.label}],plan},actualFillVerified:false};
 row.id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);return row;
}

/** Separate immutable episodes: adding a model never rewrites the original 16/13 ledger. */
export async function precomputeDecisionContext({dir,historyFile,target,batch,position,analogues,nextSessionDay,writeChart,now=Date.now,signal,onProgress=()=>{}}){
 const checked=now(),path=join(target,filename+'.json');
 if(position?.version!==positionVersion||position.completed!==true||!same(position,batch)||!position.byCode||!/^\d{4}-\d{2}-\d{2}$/.test(nextSessionDay||'')||nextSessionDay<=batch.day)throw Error('Decision context needs a same-batch market position and verified next session');
 if(!analogues?.completed||!same(analogues,batch))throw Error('Decision context analogues differ from this source batch');
 const root=join(dir,filename);await mkdir(root,{recursive:true});
 const cached=await optional(path);if(cached){validateDecisionContext(cached,batch,checked);const source=await readStoredJson(join(dir,'current.json'));if(!same(source,batch))throw Error('Decision context source changed during recovery');await save(join(root,'current.json'),{schema,version,...identity(batch)});return cached;}
 const pointer=await optional(join(root,'current.json'));
 const previous=pointer?validateDecisionContext(await readStoredJson(join(dir,'generations',pointer.generation,filename+'.json')),pointer,checked):null;
 if(previous&&(previous.day>batch.day||Date.parse(previous.asOf)>Date.parse(batch.asOf)))throw Error('Decision context cannot move its source date backwards');
 const computedAt=new Date(checked).toISOString(),activeUntil=nextSessionDay+'T09:30:00+08:00',current=[];
 for(const [code,value]of Object.entries(position.byCode))for(const setup of value.setups){
  if(!kinds.has(setup.id)||setup.qualified!==false||setup.actualFillVerified!==false)throw Error('Decision context model is not an unqualified coded observation');
  const row=makeRow(code,value,setup,batch,computedAt,activeUntil);row.research.analogue=analogues.bySetup?.[code]?.[setup.id]||null;current.push(row);
 }
 const tracks=structuredClone(previous?.tracks||[]),byId=new Map(tracks.map(track=>[track.id,track]));
 for(const row of current){const old=byId.get(row.id);if(old){row.firstSeenAt=old.firstSeenAt;row.actualDiscoveryAt=old.original.actualDiscoveryAt;}else{const track={id:row.id,firstSeenAt:row.firstSeenAt,original:structuredClone(row),observations:{}};tracks.push(track);byId.set(row.id,track);}}
 const byCode=new Map();tracks.forEach((track,index)=>{const indexes=byCode.get(track.original.code)||[];indexes.push(index);byCode.set(track.original.code,indexes);});
 const wanted=new Map();for(const row of current){const rows=wanted.get(row.code)||[];rows.push(row);wanted.set(row.code,rows);}
 const stage=await mkdtemp(join(target,'.decision-context-')),chartRoot=join(stage,chartDirectoryName),charts=[],seen=new Set();let header,dates,count=0;
 try{
  await mkdir(chartRoot);
  for await(const line of readHistoryLines(historyFile)){
   signal?.throwIfAborted();const record=JSON.parse(line);
   if(!header){header=record;if(header.schema!=='books.a-share.history.v1'||!same(header,batch)||header.total!==batch.total||header.reference?.code!=='000300.SH'||header.reference.bars.at(-1)?.date!==batch.day)throw Error('Decision context raw header differs from its source batch');dates=header.reference.bars.map(bar=>bar.date);continue;}
   const {stock,source}=record;
   if(!stock?.code||seen.has(stock.code)||source?.sourceId!==batch.sourceId||source.day!==batch.day||!['ready','unavailable'].includes(source.status)||source.adjustment!=='qfq'||!Array.isArray(source.bars)||!finite(Date.parse(source.fetchedAt))||Date.parse(source.fetchedAt)<Date.parse(batch.asOf)||Date.parse(source.fetchedAt)>checked)throw Error('Decision context raw identity, price basis or acquisition time is invalid');
   seen.add(stock.code);count++;
   for(const index of byCode.get(stock.code)||[])tracks[index]=observeOpportunity(tracks[index],{source,reference:header.reference,batch,now:checked});
   if(wanted.has(stock.code)){
    const lookup=new Map(source.bars.map(bar=>[bar.date,bar]));let start=dates.length;while(start>Math.max(0,dates.length-120)&&validBar(lookup.get(dates[start-1])))start--;
    const bars=dates.slice(start).map(date=>lookup.get(date));if(bars.length<61||bars.at(-1).date!==batch.day||bars.at(-1).close!==position.byCode[stock.code].metrics.close)throw Error('Decision chart and selected daily model do not share continuous source prices');
    for(const row of wanted.get(stock.code)){const kind=row.research.plan.kind,directory=join(chartRoot,kind);await mkdir(directory,{recursive:true});await writeChart({directory,row,bars});for(const window of [60,120])charts.push({...identity(batch),code:row.code,kind,window,path:chartDirectoryName+'/'+kind+'/'+row.code+'-'+window+'.svg',priceBasis:'first-close-percent',actualCandles:Math.min(window,bars.length)});}
   }
   if(count%100===0)await onProgress({stage:'decision-context',checked:count,total:batch.total});
  }
  if(!header||count!==batch.total||current.some(row=>!seen.has(row.code)))throw Error('Decision context private universe coverage is incomplete');
  for(const [code,indexes]of byCode)if(!seen.has(code))for(const index of indexes)tracks[index]=observeOpportunity(tracks[index],{source:null,reference:header.reference,batch,now:checked});
  const observed=new Map(tracks.map(track=>[track.id,track.observations]));for(const row of current)row.observations=structuredClone(observed.get(row.id));
  const report={schema,version,completed:true,datasetBound:true,...identity(batch),computedAt,eligibleForSelection:false,current,tracks,charts,market:position.market,summary:{universeCount:count,candidateCount:current.length,stockCount:new Set(current.map(row=>row.code)).size,qualifiedCount:0},method:{codedAllMarket:true,models:definitions,originalSixteenAndThirteenGatesChanged:false,savedScheme15DayPolicyChanged:false,firstSeen:'first_actual_context_run_never_backdated',observation:'same_batch_qfq_close_change_not_trade_return'}};
  validateDecisionContext(report,batch,checked);signal?.throwIfAborted();
  const source=await readStoredJson(join(dir,'current.json'));if(!same(source,batch))throw Error('Decision context source changed during calculation');
  await publishCharts(chartRoot,join(target,chartDirectoryName));await save(path,report);await save(join(root,'current.json'),{schema,version,...identity(batch)});return report;
 }finally{await rm(stage,{recursive:true,force:true});}
}

/** Public projection contains selected derived metrics only, never the private market bar records. */
export function enrichDecisionContext(view,context,position,analogues,now=Date.now()){
 validateDecisionContext(context,view,now);if(!same(position,view)||!same(analogues,view))throw Error('Decision context presentation cannot mix source batches');
 const keys=['day','historySize','availableBarCount','historyStart','historyEnd','ma5','ma20','ma60','ma20Slope5Percent','ma60Slope5Percent','atr14','atrMethod','return5','return20','return60','ma20Deviation','volumeRatio20','prior20High','prior20Low','rangePosition60Percent','benchmarkReturn20','excess20'];
 const current=[...view.current,...context.current].map(row=>{
  const value=position.byCode[row.code],metrics=value?Object.fromEntries(keys.map(key=>[key,value.metrics[key]??null])):null;
  const analogue=row.familyId==='daily-setup-watch'?analogues.bySetup?.[row.code]?.[row.research.plan.kind]||null:row.familyId==='close-limitup-watch'?analogues.byCode?.[row.code]?.primary||null:null;
  return {...row,active:Date.parse(row.activeUntil)>now,displayState:Date.parse(row.activeUntil)>now?row.state:'expired',research:{...row.research,position:value?{...identity(position),metrics,strength:value.strength,limitUp:value.limitUp}:null,analogue,analogueReason:analogue?null:'该条件当前尚无同类完整路径统计；未借用其他形态结果'}};
 });
 const tracks=[...view.tracks,...context.tracks];
 const computedAt=new Date(Math.max(...[view,context,position,analogues].map(value=>Date.parse(value.computedAt)).filter(finite))).toISOString();
 return {...view,originalComputedAt:view.computedAt,computedAt,current,tracks,marketContext:{...view.marketContext,position:position.market},summary:{...view.summary,candidateCount:current.length,stockCount:new Set(current.map(row=>row.code)).size,nearBCount:current.filter(row=>row.state==='near_B').length,triggeredBCount:current.filter(row=>row.state==='triggered_B').length,watchCount:current.filter(row=>row.state==='watch').length,trackCount:tracks.length,thirdSessionReadyCount:tracks.filter(track=>track.observations[3]?.status==='ready').length},liveCandidateCount:current.filter(row=>row.active).length,liveQualifiedCount:current.filter(row=>row.active&&row.qualified).length};
}
