import {readFile,writeFile,mkdir,mkdtemp,rename,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {readStoredJson,readStoredFile} from './a-share-retention.mjs';
import {analyzeViprasolStudy,version,sourceCommit,familyId,definitions} from './a-share-viprasol-study.mjs';

export const viprasolStudyDirectory='viprasol-study-v1';
const ruleIds=new Set(definitions.map(rule=>rule.id)),windows=[60,120];
const same=(a,b)=>['generation','sourceId','day','asOf'].every(key=>a[key]===b[key]);
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
async function optionalJson(file,missing){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return missing;throw error;}}
function headerBinding(header,batch){
 if(header?.schema!=='books.a-share.history.v1'||!same(header,batch)||header.total!==batch.total||header.historyRequested!==500||!Array.isArray(header.reference?.bars)||!header.reference.bars.length||header.reference.bars.length>500)throw Error('Viprasol raw history header does not match the requested-500 batch');
}
function recordBinding(record,batch,seen){
 const code=record.stock?.code,source=record.source;
 if(!/^\d{6}\.(SH|SZ)$/.test(code||'')||seen.has(code)||source?.sourceId!==batch.sourceId||source.day!==batch.day||source.adjustment!=='qfq'||source.historyRequested!==500||!Array.isArray(source.bars)||source.bars.length>500)throw Error('Viprasol raw stock is missing, duplicated, truncated or from another batch');
 seen.add(code);
}
function chartPath(item,window){
 if(!ruleIds.has(item.ruleId)||!/^\d{6}\.(SH|SZ)$/.test(item.code||'')||!validDay(item.day)||!windows.includes(window))throw Error('Viprasol chart identity is invalid');
 return item.ruleId+'-'+item.code+'-'+item.day+'-'+window+'.svg';
}
function validateReport(report,batch,implementationCommit){
 if(report?.schema!=='books.a-share.viprasol-study.v1'||report.version!==version||report.familyId!==familyId||report.sourceCommit!==sourceCommit||report.implementationCommit!==implementationCommit||report.completed!==true||!same(report,batch)||report.coverage?.universeCount!==batch.total||report.coverage.historyEnd!==batch.day||!Array.isArray(report.rules)||report.rules.length!==definitions.length||new Set(report.rules.map(rule=>rule.id)).size!==definitions.length||report.rules.some(rule=>!ruleIds.has(rule.id))||!Array.isArray(report.current))throw Error('Viprasol study output schema/version/source/coverage differs from its batch');
 const rules=new Map(report.rules.map(rule=>[rule.id,rule]));
 const identities=new Set();
 for(const item of report.current){
  const key=item.ruleId+':'+item.code+':'+item.day;
  if(!ruleIds.has(item.ruleId)||!/^\d{6}\.(SH|SZ)$/.test(item.code||'')||!same(item,batch)||item.signalDay!==batch.day||item.stage!=='source_today_long_close'||item.actualFillVerified!==false||typeof item.eligibleForSelection!=='boolean'||identities.has(key)||item.eligibleForSelection&&(rules.get(item.ruleId).eligibleForSelection!==true||rules.get(item.ruleId).nativeGate?.passed!==true||rules.get(item.ruleId).statisticalGatePassed!==true))throw Error('Viprasol current item is duplicated, unqualified or not source-today');
  identities.add(key);
 }
 const counts={ruleCount:definitions.length,statisticalPassedCount:report.rules.filter(rule=>rule.statisticalGatePassed).length,nativeApprovedCount:report.rules.filter(rule=>rule.nativeGate?.passed).length,effectiveCount:report.rules.filter(rule=>rule.eligibleForSelection).length,currentCount:report.current.length,qualifiedCurrentCount:report.current.filter(item=>item.eligibleForSelection).length};
 if(Object.entries(counts).some(([key,value])=>report.summary?.[key]!==value)||report.eligibleForSelection!==(counts.qualifiedCurrentCount>0))throw Error('Viprasol study summary disagrees with its separate statistical/native/current gates');
}
async function checkChart(directory,path,{cold=false}={}){
 const plain=cold?await readStoredFile(join(directory,path)):await readFile(join(directory,path));
 const compressed=await readFile(join(directory,path+'.gz'));
 if(!plain.length||!gunzipSync(compressed).equals(plain))throw Error('Viprasol chart gzip is missing or does not restore the SVG');
 const body=plain.toString('utf8');
 if(!/^\s*<svg\b[^>]*\bdata-normalization=["']first-close-percent["'][^>]*>/i.test(body)||!/<\/svg>\s*$/i.test(body))throw Error('Viprasol writer did not provide a normalized SVG');
}
async function validatePublishedCharts(directory,report,batch){
 if(report.datasetBound!==true||report.sourceDay!==batch.day||!Array.isArray(report.charts))throw Error('Viprasol published view lacks its batch-bound chart list');
 for(const item of report.current)if(item.familyId!==familyId||!Number.isFinite(item.closePrice)||item.closePrice<=0||!item.charts||!item.eligibleForSelection&&Object.keys(item.charts).length)throw Error('Viprasol current item lacks its own closing price or exposes unqualified charts');
 const qualified=report.current.filter(item=>item.eligibleForSelection),expected=new Set();
 if(report.charts.length!==qualified.length*windows.length)throw Error('Viprasol qualified chart coverage is incomplete');
 for(const item of qualified)for(const window of windows){
  const path=chartPath(item,window),matches=report.charts.filter(chart=>chart.ruleId===item.ruleId&&chart.code===item.code&&chart.window===window&&chart.path===path);
  if(item.familyId!==familyId||!Number.isFinite(item.closePrice)||item.closePrice<=0||item.charts?.[window]!==path||matches.length!==1||!same(matches[0],batch)||matches[0].day!==batch.day||expected.has(path))throw Error('Viprasol chart list does not bind every qualified current item');
  expected.add(path);await checkChart(directory,path,{cold:true});
 }
}

/** Storage contract only; selection is decided exclusively by the sealed study. */
export async function writeViprasolCurrentCharts({historyFile,directory,report,batch,writeCurrentChart,signal}){
 report.charts=[];report.current=report.current.map(item=>({...item,familyId,charts:{}}));
 const qualified=report.current.filter(item=>item.eligibleForSelection);if(!report.current.length)return;
 if(qualified.length&&typeof writeCurrentChart!=='function')throw Error('Viprasol qualified current items require an injected normalized-chart writer');
 const perCode=new Map();for(const item of report.current){const list=perCode.get(item.code)||[];list.push(item);perCode.set(item.code,list);}
 const seen=new Set(),found=new Set();let header,count=0;
 for await(const line of readHistoryLines(historyFile)){
  signal?.throwIfAborted();const record=JSON.parse(line);
  if(!header){header=record;headerBinding(header,batch);continue;}
  recordBinding(record,batch,seen);count++;
  const items=perCode.get(record.stock.code);if(!items)continue;
  const source=record.source,last=source.bars.at(-1);
  if(source.status!=='ready'||last?.date!==batch.day||!Number.isFinite(last.close)||last.close<=0)throw Error('Viprasol qualified chart has no same-source current closing bar');
  found.add(record.stock.code);
  for(const item of items){
   if(item.originalReference?.entry!==last.close||item.sourceFetchedAt!==source.fetchedAt)throw Error('Viprasol chart closing price or fetch time changed from the analyzed source');
   item.closePrice=last.close;
   if(!item.eligibleForSelection)continue;
   const paths=Object.fromEntries(windows.map(window=>[window,chartPath(item,window)]));
   await writeCurrentChart({directory,stock:record.stock,bars:source.bars,item,paths});
   for(const window of windows){await checkChart(directory,paths[window]);item.charts[window]=paths[window];report.charts.push({familyId,ruleId:item.ruleId,code:item.code,day:batch.day,generation:batch.generation,sourceId:batch.sourceId,asOf:batch.asOf,window,path:paths[window],priceBasis:'first-close-percent'});}
  }
 }
 if(!header||count!==batch.total||found.size!==perCode.size)throw Error('Viprasol chart source stock or full raw coverage is missing');
}

/** Appends an immutable, independent view; never changes raw history or current.json. */
export async function precomputeViprasolStudy({historyFile,target,batch,siteDir,marketMetadata={},policyKnownAt=null,nextSessionDay=null,now=Date.now,onProgress=()=>{},signal,writeCurrentChart}){
 if(!batch||!/^[0-9TZ-]{1,80}$/.test(batch.generation||'')||typeof batch.sourceId!=='string'||!batch.sourceId||!validDay(batch.day)||!Number.isFinite(Date.parse(batch.asOf))||!Number.isInteger(batch.total)||batch.total<1||!siteDir||!target||!historyFile)throw Error('Viprasol precompute requires a bound source batch and explicit paths');
 const build=await optionalJson(join(siteDir,'quant-research/viprasol-build.json'),{});
 if(!build||typeof build!=='object'||Array.isArray(build))throw Error('Viprasol build manifest is malformed');
 const implementationCommit=typeof build.implementationCommit==='string'&&/^[0-9a-f]{40}$/.test(build.implementationCommit)?build.implementationCommit:null;
 const nativeApprovals=await optionalJson(join(siteDir,'quant-research/native-audit/a-share-approvals.json'),[]);
 if(!Array.isArray(nativeApprovals))throw Error('Viprasol native approvals must be an explicit reviewed-entry array');
 if(!marketMetadata||typeof marketMetadata!=='object'||Array.isArray(marketMetadata))throw Error('Viprasol market metadata must be a same-batch code dictionary');
 for(const [code,item]of Object.entries(marketMetadata))if(!/^\d{6}\.(SH|SZ)$/.test(code)||!item||item.sourceKind!=='exchange-rule-derived'||item.generation!==batch.generation||item.sourceId!==batch.sourceId||item.sourceDay!==batch.day||item.sourceAsOf!==batch.asOf||item.mintickVerified===true&&(!Number.isFinite(item.mintick)||item.mintick<=0))throw Error('Viprasol derived market metadata is not bound to this generation');
 const directory=join(target,viprasolStudyDirectory);
 let existing;
 try{existing=await readStoredJson(join(directory,'report.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing!==undefined){validateReport(existing,batch,implementationCommit);await validatePublishedCharts(directory,existing,batch);return existing;}
 await mkdir(target,{recursive:true});const stage=await mkdtemp(join(target,'.viprasol-study-'));
 let header,count=0;const seen=new Set();
 try{
  const iterator=readHistoryLines(historyFile)[Symbol.asyncIterator]();
  try{
   const first=await iterator.next();if(first.done)throw Error('Viprasol private raw history is empty');header=JSON.parse(first.value);headerBinding(header,batch);
   const records=(async function*(){
    for(let next=await iterator.next();!next.done;next=await iterator.next()){
     signal?.throwIfAborted();const record=JSON.parse(next.value);recordBinding(record,batch,seen);count++;yield record;
    }
    if(count!==batch.total)throw Error('Viprasol private raw history is truncated or incomplete');
    if(Object.keys(marketMetadata).some(code=>!seen.has(code)))throw Error('Viprasol market metadata contains a code absent from this source batch');
   })();
   const report=await analyzeViprasolStudy({dataset:{day:batch.day,asOf:batch.asOf,sourceId:batch.sourceId,generation:batch.generation,expectedCount:batch.total,reference:header.reference,universeMetadata:header.universePolicy},records,sourceId:batch.sourceId,generation:batch.generation,implementationCommit,nativeApprovals,marketMetadata,policyKnownAt,nextSessionDay,now,onProgress});
   validateReport(report,batch,implementationCommit);
   await writeViprasolCurrentCharts({historyFile,directory:stage,report,batch,writeCurrentChart,signal});
   report.datasetBound=true;report.sourceDay=batch.day;
   validateReport(report,batch,implementationCommit);await validatePublishedCharts(stage,report,batch);
   const body=JSON.stringify(report);await writeFile(join(stage,'report.json'),body);await writeFile(join(stage,'report.json.gz'),gzipSync(body));
   const allowed=new Set(['report.json','report.json.gz',...report.charts.flatMap(chart=>[chart.path,chart.path+'.gz'])]);
   for(const entry of await readdir(stage,{withFileTypes:true}))if(!entry.isFile()||!allowed.has(entry.name))throw Error('Viprasol stage contains unexpected files instead of derived chart artifacts');
   signal?.throwIfAborted();await rename(stage,directory);return report;
  }finally{await iterator.return?.();}
 }finally{await rm(stage,{recursive:true,force:true});}
}
