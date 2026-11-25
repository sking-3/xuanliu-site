import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {prepare} from './a-share-pattern-regimes.mjs';
import {describeMarketContext} from './a-share-opportunity-tracking.mjs';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {readStoredJson} from './a-share-retention.mjs';
import {analyzeDailyPrefix} from './a-share-daily-setups.mjs';

export const filename='market-position-v1',version='books.a-share.market-position.2026-11-25.v1';
const schema='books.a-share.market-position.v1',binding=['sourceId','generation','day','asOf'];
const finite=Number.isFinite,same=(a,b)=>binding.every(key=>a?.[key]===b?.[key]);
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&finite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const time=value=>typeof value==='string'&&finite(Date.parse(value));
const mainboard=value=>/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(value||'');
const validBar=bar=>bar&&day(bar.date)&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
const percent=(count,total)=>total?count/total*100:null;

function rankReturns(byCode,period){
  const key='return'+period,entries=Object.entries(byCode).filter(([,value])=>finite(value.metrics[key])).map(([code,value])=>({code,value:value.metrics[key]})).sort((a,b)=>a.value-b.value||a.code.localeCompare(b.code));
  const denominator=entries.length;
  for(const value of Object.values(byCode)){value.strength[key+'Percentile']=null;value.strength[key+'Denominator']=denominator;}
  if(denominator<2)return;
  for(let start=0;start<denominator;){
    let end=start+1;while(end<denominator&&!above(entries[end].value,entries[start].value))end++;
    const percentile=100*(start+(end-start-1)/2)/(denominator-1);
    for(let index=start;index<end;index++)byCode[entries[index].code].strength[key+'Percentile']=percentile;
    start=end;
  }
}

/** One private source record at a time; only compact current metrics and unqualified plans are retained. */
export async function precomputeMarketPosition({historyFile,target,batch,now=Date.now,signal,onProgress=()=>{}}){
  const checked=now(),closeAt=day(batch?.day)?Date.parse(batch.day+'T15:00:00+08:00'):NaN;
  if(!batch||!day(batch.day)||!time(batch.asOf)||Date.parse(batch.asOf)<closeAt||Date.parse(batch.asOf)>checked||typeof batch.sourceId!=='string'||!batch.sourceId||!/^[0-9TZ-]{1,80}$/.test(batch.generation||'')||!Number.isInteger(batch.total)||batch.total<1)throw Error('Market position needs one identified closed source batch');
  const path=join(target,filename+'.json');let cached;
  try{cached=await readStoredJson(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(cached){
    if(cached.schema!==schema||cached.version!==version||cached.completed!==true||cached.datasetBound!==true||!same(cached,batch)||cached.market?.coverage?.total!==batch.total||cached.eligibleForSelection!==false||!time(cached.computedAt)||Date.parse(cached.computedAt)>checked||!cached.byCode)throw Error('Market position existing report differs from this source batch');
    return cached;
  }
  const byCode={},seen=new Set(),coverage={total:batch.total,ready:0,riskExcluded:0,missing:0};
  const breadth={validPairs:0,advancers:0,decliners:0,flat:0,advancersPercent:null,aboveMa20Count:0,ma20Denominator:0,aboveMa20Percent:null};
  const limitUpLike={count:0,denominator:0,onePriceCount:0,streakDistribution:{},unknown:0,excluded:0,officialLimitPriceVerified:false};
  let header,dates,knownSectors=0;
  for await(const line of readHistoryLines(historyFile)){
    signal?.throwIfAborted();const record=JSON.parse(line);
    if(!header){
      header=record;const reference=header.reference;
      if(header.schema!=='books.a-share.history.v1'||!same(header,batch)||header.total!==batch.total||header.historyRequested!==500||reference?.code!=='000300.SH'||reference.adjustment!=='index'||!time(reference.fetchedAt)||Date.parse(reference.fetchedAt)<Date.parse(batch.asOf)||Date.parse(reference.fetchedAt)>checked||!Array.isArray(reference.bars)||reference.bars.length<2||reference.bars.length>500||reference.bars.some((bar,index)=>!validBar(bar)||bar.date>batch.day||index&&bar.date<=reference.bars[index-1].date)||reference.bars.at(-1).date!==batch.day)throw Error('Market position raw header or benchmark does not bind to this completed batch');
      dates=reference.bars.map(bar=>bar.date);continue;
    }
    const {stock,source}=record;
    if(!mainboard(stock?.code)||seen.has(stock.code)||typeof stock.name!=='string'||!stock.name.trim()||stock.listingDate!=null&&(!day(stock.listingDate)||stock.listingDate>batch.day)||source?.sourceId!==batch.sourceId||source.day!==batch.day||!['ready','unavailable'].includes(source.status)||source.adjustment!=='qfq'||source.historyRequested!==500||!Array.isArray(source.bars)||source.bars.length>500||source.bars.some((bar,index)=>!day(bar.date)||bar.date>batch.day||index&&bar.date<=source.bars[index-1].date)||!time(source.fetchedAt)||Date.parse(source.fetchedAt)<Date.parse(batch.asOf)||Date.parse(source.fetchedAt)>checked)throw Error('Market position stock identity, qfq source, date or acquisition time is invalid');
    seen.add(stock.code);
    if(typeof stock.sector==='string'&&stock.sector.trim()&&stock.sector!=='未分类')knownSectors++;
    if(/^(?:S?\*?ST)|退/i.test(stock.name.replace(/\s/g,''))){coverage.riskExcluded++;continue;}
    const series=prepare(source.bars,dates);series.referenceBars=header.reference.bars;
    const analysis=analyzeDailyPrefix(series,dates.length-1,stock),metrics=analysis.metrics,limitUp=analysis.limitUp;
    if(!metrics||!limitUp||!Array.isArray(analysis.setups)||analysis.setups.some(setup=>setup.qualified!==false||setup.actualFillVerified!==false))throw Error('Market position cannot promote an unqualified daily observation plan');
    if(metrics.valid.current)coverage.ready++;else coverage.missing++;
    if(metrics.valid.current&&metrics.valid.previous){breadth.validPairs++;if(above(metrics.close,metrics.prevClose))breadth.advancers++;else if(above(metrics.prevClose,metrics.close))breadth.decliners++;else breadth.flat++;}
    if(metrics.valid.current&&finite(metrics.ma20)){breadth.ma20Denominator++;if(above(metrics.close,metrics.ma20))breadth.aboveMa20Count++;}
    if(limitUp.status==='ready'&&typeof limitUp.atLimit==='boolean'){
      limitUpLike.denominator++;
      if(limitUp.atLimit){limitUpLike.count++;if(limitUp.onePrice===true)limitUpLike.onePriceCount++;const stage=Number.isInteger(limitUp.consecutiveCount)&&limitUp.consecutiveCount>0?String(limitUp.consecutiveCount):'unknown';limitUpLike.streakDistribution[stage]=(limitUpLike.streakDistribution[stage]||0)+1;}
    }else limitUpLike[limitUp.status==='excluded'?'excluded':'unknown']++;
    byCode[stock.code]={name:stock.name,metrics,limitUp,setups:analysis.setups,strength:{},sourceFetchedAt:source.fetchedAt};
    if(seen.size%100===0)await onProgress({stage:'market-position',checked:seen.size,total:batch.total});
  }
  if(!header||seen.size!==batch.total||coverage.ready+coverage.riskExcluded+coverage.missing!==batch.total)throw Error('Market position private universe coverage is incomplete');
  rankReturns(byCode,20);rankReturns(byCode,60);breadth.advancersPercent=percent(breadth.advancers,breadth.validPairs);breadth.aboveMa20Percent=percent(breadth.aboveMa20Count,breadth.ma20Denominator);
  const report={schema,version,completed:true,datasetBound:true,...Object.fromEntries(binding.map(key=>[key,batch[key]])),computedAt:new Date(checked).toISOString(),eligibleForSelection:false,
    market:{scope:'current_roster_sh_sz_mainboard',benchmark:describeMarketContext(header.reference,batch),breadth,limitUpLike,coverage,sector:{status:'unavailable',knownCount:knownSectors,reason:knownSectors?'现有行业标签未核对独立来源和日期；未计算行业热点或龙头。':'同代主板名册行业全部未分类；未计算行业热点或龙头。'}},byCode,
    method:{historyRequested:500,historicalMembership:false,survivorshipBias:true,scope:'current_roster_retrospective_not_all_historical_members',coverage:'ordinary_shares_with_valid_current_bar; each_metric_has_its_own_denominator',percentiles:'same_day_all_valid_ordinary_shares_return_midrank_not_selected_candidates',limitUp:'unverified_daily_close_ten_percent_proxy_including_core_and_one_price',originalSixteenAndThirteenGatesChanged:false,savedScheme15DayPolicyChanged:false,plans:'unqualified_observation_plans_not_validated_B_or_actual_fills'}};
  const body=JSON.stringify(report);signal?.throwIfAborted();await writeFile(path+'.tmp',body);await writeFile(path+'.gz.tmp',gzipSync(body));await rename(path+'.gz.tmp',path+'.gz');await rename(path+'.tmp',path);await onProgress({stage:'market-position',checked:batch.total,total:batch.total});return report;
}
