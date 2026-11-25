import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {prepare} from './a-share-pattern-regimes.mjs';
import {analyzeDailyPrefix,definitions,version as modelVersion} from './a-share-daily-setups.mjs';
import {marketRegimeAt} from './a-share-market-preference.mjs';
import {version as positionVersion} from './a-share-market-position.mjs';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {readStoredJson} from './a-share-retention.mjs';

export const filename='decision-analogues-v1',version='books.a-share.decision-analogues.2026-11-25.v1';
const schema='books.a-share.decision-analogues.v1',binding=['sourceId','generation','day','asOf'],horizons=[1,3,5,15];
const method='historical_close_path_not_forecast_or_trade_return',finite=Number.isFinite;
const same=(a,b)=>binding.every(key=>a?.[key]===b?.[key]),time=value=>typeof value==='string'&&finite(Date.parse(value));
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&finite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const mainboard=value=>/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(value||'');
const validBar=bar=>bar&&day(bar.date)&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const band=value=>!finite(value)?null:value<100/3?'low':value<200/3?'mid':'high';
const regimeOf={bullish_trend:'bull',bearish_trend:'bear',mixed_or_range:'sideways',unknown:'unknown'};
const labels=new Map(definitions.map(item=>['setup:'+item.id,item.label]));
for(const [key,label]of [['first','连续近涨停1日'],['two','连续近涨停2日'],['three-plus','连续近涨停3日以上'],['unknown','近涨停连续段未核验']])labels.set('limit:'+key,label);
const limitClass=value=>value.atLimit!==true?null:value.consecutiveCount===1?'limit:first':value.consecutiveCount===2?'limit:two':value.consecutiveCount>=3?'limit:three-plus':'limit:unknown';
const classes=value=>[...value.setups.map(item=>'setup:'+item.id),limitClass(value.limitUp)].filter(Boolean);
const keyOf=(classId,regime,positionBand)=>JSON.stringify([classId,regime,positionBand]);
const values=()=>({count:0,chunks:[]});
function addValue(store,value){const index=store.count++;store.chunks[Math.floor(index/1024)]||=new Float64Array(1024);store.chunks[Math.floor(index/1024)][index%1024]=value;}
function quantiles(store){
  if(!store.count)return {p25:null,median:null,p75:null};
  const sorted=new Float64Array(store.count);for(let index=0;index<store.chunks.length;index++)sorted.set(store.chunks[index].subarray(0,Math.min(1024,store.count-index*1024)),index*1024);sorted.sort();
  const at=p=>{const index=(sorted.length-1)*p,lower=Math.floor(index),fraction=index-lower;return sorted[lower]+(sorted[Math.min(lower+1,sorted.length-1)]-sorted[lower])*fraction;};return {p25:at(.25),median:at(.5),p75:at(.75)};
}
function outcomeBucket(){return {values:values(),stocks:new Set(),days:new Set(),sumReturn:0,positive:0,sumDrawdown:0,worstDrawdown:0,pending:0,unavailable:0,fromDay:null,toDay:null,lastOutcomeDay:null};}
function adequate(count,stocks,dates){return count>=30&&stocks>=10&&dates>=10;}
function reasons(count,stocks,dates){return [...(count<30?['fewer_than_30_events']:[]),...(stocks<10?['fewer_than_10_stocks']:[]),...(dates<10?['fewer_than_10_signal_days']:[])];}
function summarize(bucket){
  const sampleCount=bucket.values.count,stockCount=bucket.stocks.size,signalDayCount=bucket.days.size,q=quantiles(bucket.values);
  return {sampleCount,stockCount,signalDayCount,meanReturnPercent:sampleCount?bucket.sumReturn/sampleCount:null,medianReturnPercent:q.median,p25ReturnPercent:q.p25,p75ReturnPercent:q.p75,positiveRate:sampleCount?bucket.positive/sampleCount:null,meanDrawdownPercent:sampleCount?bucket.sumDrawdown/sampleCount:null,worstDrawdownPercent:sampleCount?bucket.worstDrawdown:null,adequate:adequate(sampleCount,stockCount,signalDayCount),reasons:reasons(sampleCount,stockCount,signalDayCount),pendingCount:bucket.pending,unavailableCount:bucket.unavailable,fromDay:bucket.fromDay,toDay:bucket.toDay,lastOutcomeDay:bucket.lastOutcomeDay,eligibleForSelection:false};
}
function addEvent(bucket,series,dates,index,code){
  for(const horizon of horizons){
    const target=index+horizon,part=bucket.horizons[horizon];
    if(target>=dates.length){part.pending++;continue;}
    const path=series.bars.slice(index,target+1);
    if(path.length!==horizon+1||path.some((bar,offset)=>!validBar(bar)||bar.date!==dates[index+offset])){part.unavailable++;continue;}
    const anchor=path[0].close,returns=path.map(bar=>(bar.close/anchor-1)*100);let peak=anchor,drawdown=0;
    if(returns.some(value=>!finite(value))){part.unavailable++;continue;}
    for(const bar of path){peak=Math.max(peak,bar.close);drawdown=Math.max(drawdown,(1-bar.close/peak)*100);}
    addValue(part.values,returns.at(-1));part.stocks.add(code);part.days.add(dates[index]);part.sumReturn+=returns.at(-1);part.positive+=Number(returns.at(-1)>0);part.sumDrawdown+=drawdown;part.worstDrawdown=Math.max(part.worstDrawdown,drawdown);part.fromDay=part.fromDay===null?dates[index]:part.fromDay<dates[index]?part.fromDay:dates[index];part.toDay=part.toDay===null?dates[index]:part.toDay>dates[index]?part.toDay:dates[index];part.lastOutcomeDay=part.lastOutcomeDay===null?dates[target]:part.lastOutcomeDay>dates[target]?part.lastOutcomeDay:dates[target];
    if(horizon===15)for(let step=1;step<=15;step++)addValue(bucket.path[step-1],returns[step]);
  }
}

/** Descriptive historical analogues for today's requested model/limit classes, never a selection gate. */
export async function precomputeDecisionAnalogues({historyFile,target,batch,position,now=Date.now,signal,onProgress=()=>{}}){
  const checked=now();
  if(!batch||!day(batch.day)||!time(batch.asOf)||Date.parse(batch.asOf)<Date.parse(batch.day+'T15:00:00+08:00')||Date.parse(batch.asOf)>checked||typeof batch.sourceId!=='string'||!batch.sourceId||!/^[0-9TZ-]{1,80}$/.test(batch.generation||'')||!Number.isInteger(batch.total)||batch.total<1||position?.schema!=='books.a-share.market-position.v1'||position.version!==positionVersion||position.completed!==true||position.datasetBound!==true||!same(position,batch)||position.eligibleForSelection!==false||!time(position.computedAt)||Date.parse(position.computedAt)>checked||!position.byCode)throw Error('Decision analogues need a matching completed position/source batch');
  const path=join(target,filename+'.json');let cached;try{cached=await readStoredJson(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(cached){if(cached.schema!==schema||cached.version!==version||cached.modelVersion!==modelVersion||cached.positionVersion!==positionVersion||cached.completed!==true||cached.datasetBound!==true||!same(cached,batch)||cached.coverage?.processed!==batch.total||cached.eligibleForSelection!==false)throw Error('Decision analogue cached report differs from this source batch');return cached;}
  const currentRegime=regimeOf[position.market?.benchmark?.regime];if(!currentRegime)throw Error('Decision analogue benchmark regime is missing');
  const wanted=new Map(),requests=new Map(),byCode={},bySetup={};
  for(const [code,item]of Object.entries(position.byCode)){
    if(!mainboard(code)||!item.metrics||!item.limitUp||!Array.isArray(item.setups)||item.setups.some(setup=>!labels.has('setup:'+setup.id)||setup.qualified!==false||setup.actualFillVerified!==false))throw Error('Decision analogue current model identity is invalid');
    const positionBand=band(item.metrics.rangePosition60Percent),ids=classes(item);requests.set(code,{ids,positionBand});bySetup[code]={};
    byCode[code]={primary:null,core:null,coreReason:'fixed_pattern_analogues_not_in_first_version',reason:positionBand===null?'verified_60_session_position_unavailable':ids.length?'pending_historical_summary':'no_current_model_or_limit_class'};
    if(positionBand===null)continue;
    for(const classId of ids){const key=keyOf(classId,currentRegime,positionBand);if(!wanted.has(key))wanted.set(key,{key,classId,regime:currentRegime,positionBand,horizons:Object.fromEntries(horizons.map(horizon=>[horizon,outcomeBucket()])),path:Array.from({length:15},values)});}
  }
  const neededClasses=new Set([...wanted.values()].map(item=>item.classId)),seen=new Set(),coverage={processed:0,requestedGroups:wanted.size,selectedSignals:0,groupedSignals:0,overlapSkipped:0};let header,dates,states;
  for await(const line of readHistoryLines(historyFile)){
    signal?.throwIfAborted();const record=JSON.parse(line);
    if(!header){
      header=record;const reference=header.reference;
      if(header.schema!=='books.a-share.history.v1'||!same(header,batch)||header.total!==batch.total||header.historyRequested!==500||reference?.code!=='000300.SH'||reference.adjustment!=='index'||!time(reference.fetchedAt)||Date.parse(reference.fetchedAt)<Date.parse(batch.asOf)||Date.parse(reference.fetchedAt)>checked||!Array.isArray(reference.bars)||!reference.bars.length||reference.bars.length>500||reference.bars.some((bar,index)=>!validBar(bar)||bar.date>batch.day||index&&bar.date<=reference.bars[index-1].date)||reference.bars.at(-1).date!==batch.day)throw Error('Decision analogue raw header or benchmark differs from this batch');
      dates=reference.bars.map(bar=>bar.date);states=reference.bars.map((_,index)=>marketRegimeAt(reference.bars,index).state);if(states.at(-1)!==currentRegime)throw Error('Decision analogue current benchmark regime differs from the real reference');continue;
    }
    const {stock,source}=record;
    if(!mainboard(stock?.code)||seen.has(stock.code)||typeof stock.name!=='string'||!stock.name.trim()||source?.sourceId!==batch.sourceId||source.day!==batch.day||!['ready','unavailable'].includes(source.status)||source.adjustment!=='qfq'||source.historyRequested!==500||!Array.isArray(source.bars)||source.bars.length>500||source.bars.some((bar,index)=>!day(bar.date)||bar.date>batch.day||index&&bar.date<=source.bars[index-1].date)||!time(source.fetchedAt)||Date.parse(source.fetchedAt)<Date.parse(batch.asOf)||Date.parse(source.fetchedAt)>checked)throw Error('Decision analogue stock identity, date or source is invalid');
    seen.add(stock.code);coverage.processed++;
    const current=position.byCode[stock.code];if(current&&(current.name!==stock.name||current.sourceFetchedAt!==source.fetchedAt))throw Error('Decision analogue current stock receipt differs from position source');
    if(/^(?:S?\*?ST)|退/i.test(stock.name.replace(/\s/g,''))){if(current)throw Error('Decision analogue risk stock cannot be a current request');continue;}
    if(!neededClasses.size)continue;
    const series=prepare(source.bars,dates);series.referenceBars=header.reference.bars;const lastExit=new Map();
    if(current){const last=analyzeDailyPrefix(series,dates.length-1,stock);if(last.metrics.close!==current.metrics.close||band(last.metrics.rangePosition60Percent)!==requests.get(stock.code).positionBand||JSON.stringify(classes(last))!==JSON.stringify(requests.get(stock.code).ids))throw Error('Decision analogue current class or price position differs from its source');}
    for(let index=0;index<dates.length;index++){
      const analysis=analyzeDailyPrefix(series,index,stock),positionBand=band(analysis.metrics.rangePosition60Percent);
      for(const classId of classes(analysis)){
        if(!neededClasses.has(classId))continue;
        if(index<=(lastExit.get(classId)??-1)){coverage.overlapSkipped++;continue;}
        lastExit.set(classId,index+15);coverage.selectedSignals++;
        if(positionBand===null)continue;const bucket=wanted.get(keyOf(classId,states[index],positionBand));if(!bucket)continue;
        coverage.groupedSignals++;addEvent(bucket,series,dates,index,stock.code);
      }
    }
    if(coverage.processed%100===0)await onProgress({stage:'decision-analogues',checked:coverage.processed,total:batch.total});
  }
  if(!header||seen.size!==batch.total||[...requests.keys()].some(code=>!seen.has(code)))throw Error('Decision analogue full source coverage is incomplete');
  const groups={};
  for(const bucket of wanted.values()){
    const outcomes=Object.fromEntries(horizons.map(horizon=>[horizon,summarize(bucket.horizons[horizon])])),full=outcomes[15],points=bucket.path.map(quantiles);
    groups[bucket.key]={key:bucket.key,groupKey:bucket.key,classId:bucket.classId,label:labels.get(bucket.classId),regime:bucket.regime,positionBand:bucket.positionBand,positionBucket:bucket.positionBand,method,currentRosterBias:true,eligibleForSelection:false,horizons:outcomes,
      path:{sampleCount:full.sampleCount,stockCount:full.stockCount,signalDayCount:full.signalDayCount,fromDay:full.fromDay,toDay:full.toDay,lastOutcomeDay:full.lastOutcomeDay,reasons:full.reasons,adequate:full.adequate,steps:Array.from({length:16},(_,index)=>index),median:full.sampleCount?[0,...points.map(point=>point.median)]:null,p25:full.sampleCount?[0,...points.map(point=>point.p25)]:null,p75:full.sampleCount?[0,...points.map(point=>point.p75)]:null,eligibleForSelection:false}};
  }
  for(const [code,request]of requests){
    if(request.positionBand===null)continue;
    for(const classId of request.ids)if(classId.startsWith('setup:'))bySetup[code][classId.slice(6)]=groups[keyOf(classId,currentRegime,request.positionBand)];
    const primary=request.ids.find(id=>id.startsWith('limit:'))||request.ids[0];if(primary){byCode[code].primary=groups[keyOf(primary,currentRegime,request.positionBand)];byCode[code].reason=null;}
  }
  const report={schema,version,modelVersion,positionVersion,completed:true,datasetBound:true,...Object.fromEntries(binding.map(key=>[key,batch[key]])),computedAt:new Date(now()).toISOString(),currentRegime,currentRosterBias:true,eligibleForSelection:false,method,coverage,byCode,bySetup,groups,
    policy:{horizons,minSamples:30,minStocks:10,minSignalDays:10,nonoverlapSessions:16,positionBands:'equal_thirds_of_causal_60_session_ohlc_range',historyRequested:500,originalSixteenAndThirteenGatesChanged:false,savedScheme15DayPolicyChanged:false,actualFillVerified:false,core:'not_in_first_version'}};
  const body=JSON.stringify(report);signal?.throwIfAborted();await writeFile(path+'.tmp',body);await writeFile(path+'.gz.tmp',gzipSync(body));await rename(path+'.gz.tmp',path+'.gz');await rename(path+'.tmp',path);await onProgress({stage:'decision-analogues',checked:batch.total,total:batch.total});return report;
}
