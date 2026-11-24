import {mkdir,readFile,writeFile,rename,access,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {readStoredJson} from './a-share-retention.mjs';
import {buildCloseCandidates,closeCandidateVersion,closeCandidatePolicy} from './a-share-entry-current.mjs';
import {writeCurrentChart} from './a-share-entry-current-chart.mjs';
import {entryPolicyVersion} from './a-share-entry-bars.mjs';
import {entryValidationVersion} from './a-share-entry-validation.mjs';
import {version as shapeValidationVersion} from './a-share-pattern-regimes.mjs';

const require=createRequire(import.meta.url);
export const currentEntryDirectory='entry-current-v2';
const same=(a,b)=>['generation','sourceId','day','asOf'].every(key=>a[key]===b[key]);
const valid=bar=>bar&&['open','high','low','close','volume'].every(key=>Number.isFinite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
async function save(file,value){const body=JSON.stringify(value);await writeFile(file,body);await writeFile(file+'.gz',gzipSync(body));}

/** Appends one versioned, atomic view to a completed source batch; raw data and original studies stay unchanged. */
export async function precomputeCurrentEntries({target,privateTarget,batch,siteDir,nextSessionDay,now=Date.now,onProgress=()=>{},signal}){
  const directory=join(target,currentEntryDirectory);
  try{
    const previous=await readStoredJson(join(directory,'report.json'));
    if(previous.completed===true&&previous.version===closeCandidateVersion&&previous.entryPolicyVersion===entryPolicyVersion&&previous.entryValidationVersion===entryValidationVersion&&previous.datasetBound===true&&same(previous,batch))return previous;
    throw Error('已有收盘候选视图批次不符，未覆盖原结果');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const validation=await readStoredJson(join(target,'entry-validation.json')),shapes=await readStoredJson(join(target,'pattern-regimes.json'));
  const catalog=require(join(siteDir,'screening/trend-patterns.js')),ids=new Set(catalog.definitions.map(item=>item.id));
  const validPatterns=report=>Array.isArray(report.patterns)&&report.patterns.length===16&&new Set(report.patterns.map(item=>item.id)).size===16&&report.patterns.every(item=>ids.has(item.id)&&typeof item.recommended==='boolean'&&item.recommended===(item.status==='effective'));
  if(!same(validation,batch)||!same(shapes,batch)||validation.schema!=='books.a-share.entry-validation.v1'||validation.version!==entryValidationVersion||validation.entryPolicyVersion!==entryPolicyVersion||shapes.schema!=='books.a-share.pattern-regimes.v1'||shapes.version!==shapeValidationVersion||!validPatterns(validation)||!validPatterns(shapes))throw Error('收盘候选缺少同批、同版本及完整16类形态与独立入场验证');
  const engine=require(join(siteDir,'screening/trend-screen.js')),{riskName}=require(join(siteDir,'screening/market-pool.js'));
  const entryEffectiveIds=validation.patterns.filter(item=>item.recommended).map(item=>item.id),shapeEffectiveIds=shapes.patterns.filter(item=>item.status==='effective').map(item=>item.id);
  const computedAt=new Date(now()).toISOString(),stage=join(target,'.entry-current-'+process.pid+'-'+now());
  await mkdir(stage);let header,dates,count=0;const current=[],seen=new Set();
  try{
  for await(const line of readHistoryLines(join(privateTarget,'history-all.ndjson'))){
    signal?.throwIfAborted();const row=JSON.parse(line);
    if(!header){header=row;if(header.schema!=='books.a-share.history.v1'||!same(header,batch)||!Array.isArray(header.reference?.bars))throw Error('收盘候选私有历史批次不符');dates=header.reference.bars.map(bar=>bar.date);continue;}
    const {stock,source}=row;
    if(!stock?.code||seen.has(stock.code)||source?.sourceId!==batch.sourceId||source.day!==batch.day)throw Error('收盘候选证券或日期不符');
    seen.add(stock.code);count++;
    if(source.status==='ready'&&source.adjustment==='qfq'&&!riskName(stock)){
      const replay=await readStoredJson(join(privateTarget,'entries',stock.code+'.json'));
      if(!same(replay,batch)||replay.stock?.code!==stock.code)throw Error('收盘候选关键K归档批次不符');
      const byDay=new Map(source.bars.map(bar=>[bar.date,bar])),aligned=dates.map(date=>byDay.get(date)||null);
      const strength=engine.evaluate({mode:'strength',bars:source.bars.slice(-61),referenceBars:header.reference.bars.slice(-61),day:batch.day,lookback:20});
      const items=buildCloseCandidates({stock,bars:aligned,reference:header.reference.bars,dates,setups:replay.setups,strength,day:batch.day,asOf:batch.asOf,
        sourceFetchedAt:source.fetchedAt||null,computedAt,nextSessionDay,entryEffectiveIds,shapeEffectiveIds});
      let start=aligned.length;while(start>0&&valid(aligned[start-1]))start--;
      for(const item of items){
        const chart=window=>'/api/a-share-daily/entry-current-chart?'+new URLSearchParams({generation:batch.generation,code:stock.code,setup:item.formationDay,window:String(window)});
        current.push({...item,day:batch.day,sourceId:batch.sourceId,generation:batch.generation,asOf:batch.asOf,chartUrls:{60:chart(60),120:chart(120)},priceBasis:'前复权收盘研究价，非实际委托报价'});
        await writeCurrentChart({directory:stage,stock,bars:aligned.slice(start),item:{...item,day:batch.day}});
      }
    }
    if(count%50===0)await onProgress({checked:count,total:header.total,currentCode:stock.code});
  }
  if(!header||count!==header.total||count!==batch.total)throw Error('收盘候选归档覆盖不完整，未发布视图');
  signal?.throwIfAborted();
  const report={schema:'books.a-share.entry-current.v1',version:closeCandidateVersion,completed:true,datasetBound:true,...Object.fromEntries(['generation','sourceId','day','asOf'].map(key=>[key,batch[key]])),sourceDay:batch.day,computedAt,
    entryPolicyVersion:validation.entryPolicyVersion,entryValidationVersion:validation.version,benchmark:validation.benchmark,policy:closeCandidatePolicy,outcomePolicy:validation.policy,method:validation.method,patterns:validation.patterns,current,
    summary:{patternCount:16,candidateCount:current.length,stockCount:new Set(current.map(item=>item.code)).size,qualifiedCount:current.filter(item=>item.qualified).length,
      todayTriggeredCount:current.filter(item=>item.stage==='triggered_at_close').length,waitingBreakoutCount:current.filter(item=>item.stage==='waiting_breakout').length,
      entryEffectiveCount:entryEffectiveIds.length,shapeEffectiveCount:shapeEffectiveIds.length,reason:current.length?'按当日收盘与仍有效关键价汇总；收盘入场规则未独立验证，需重新核验实际行情':'当前无满足收盘位置与有效窗口的候选，不以旧B/S或未确认形态填充'}};
  await save(join(stage,'report.json'),report);await rename(stage,directory);return report;
  }finally{await rm(stage,{recursive:true,force:true});}
}

export async function rebuildCurrentEntries({dir,siteDir,now=Date.now,signal}={}){
  const batch=await readStoredJson(join(dir,'current.json')),target=join(dir,'generations',batch.generation),complete=await readStoredJson(join(target,'complete.json'));
  if(!complete.completed||!same(batch,complete)||batch.dataPolicy?.rawPublic!==false||batch.total<1000)throw Error('没有可更新收盘候选的完整私有市场批次');
  await access(join(dir,'private','generations',batch.generation,'history-all.ndjson'));
  const calendar=require(join(siteDir,'market-calendar.js'));let nextSessionDay=null;
  for(let i=1;i<=14;i++){const day=new Date(Date.parse(batch.day+'T00:00:00Z')+i*86400000).toISOString().slice(0,10),session=calendar.session('CN',day);if(!session.verified)break;if(session.open){nextSessionDay=day;break;}}
  const attempt={status:'running',stage:'entry-current',jobType:'entry-current',day:batch.day,total:batch.total,checked:0,requests:0,startedAt:new Date(now()).toISOString()};
  const progress=async fields=>{Object.assign(attempt,fields);const old=JSON.parse(await readFile(join(dir,'status.json'),'utf8'));const file=join(dir,'status.json');await writeFile(file+'.tmp',JSON.stringify({...old,attempt:{...attempt}}));await rename(file+'.tmp',file);};
  try{
    await progress({});const report=await precomputeCurrentEntries({target,privateTarget:join(dir,'private','generations',batch.generation),batch,siteDir,nextSessionDay,now,signal,onProgress:progress});
    await progress({status:'complete',stage:'published',checked:batch.total,ready:batch.ready,missing:batch.missing,currentCode:null,finishedAt:new Date(now()).toISOString()});
    return {attempt,lastSuccess:batch,currentEntries:report.summary};
  }catch(error){await progress({status:'failed',finishedAt:new Date(now()).toISOString(),error:error.message});throw error;}
}
