import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {prepare,fixedMatches,recentStrength,policy as originalPolicy} from './a-share-pattern-regimes.mjs';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {readStoredJson} from './a-share-retention.mjs';
import {describeMarketContext} from './a-share-opportunity-tracking.mjs';

export const version='books.a-share.market-preference.2026-11-25.v1';
export const filename='market-preference-v1';
export const policy=Object.freeze({horizon:3,minSamples:30,minStocks:10,minSignalDays:10,rankingOnly:true,eligibilityChanged:false});
const regimes=['bull','bear','sideways'],labels={bull:'上升趋势',bear:'下降趋势',sideways:'震荡或过渡',unknown:'样本不足'};
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validBar=bar=>bar&&validDay(bar.date)&&['open','high','low','close','volume'].every(key=>Number.isFinite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const same=(a,b)=>['generation','sourceId','day','asOf'].every(key=>a[key]===b[key]);
const enough=row=>row.sampleCount>=policy.minSamples&&row.stockCount>=policy.minStocks&&row.signalDayCount>=policy.minSignalDays;

/** Classification sees the signal prefix, never later index prices. */
export function marketRegimeAt(referenceBars,index){
  if(!Array.isArray(referenceBars)||!Number.isInteger(index)||index<0||index>=referenceBars.length)throw Error('Market preference needs a real benchmark prefix');
  const signalDay=referenceBars[index].date,context=describeMarketContext({code:'000300.SH',bars:referenceBars.slice(0,index+1)},{day:signalDay,asOf:signalDay+'T15:00:00+08:00'});
  const state={bullish_trend:'bull',bearish_trend:'bear',mixed_or_range:'sideways',unknown:'unknown'}[context.regime];
  return {state,label:labels[state],signalDay,conditionKnownAfter:signalDay+'T15:00:00+08:00',historySessions:index+1,method:context.version,retrospectiveClosedPrefix:true,fullMarketCycleVerified:false};
}

/** A separate three-session descriptive observation, not the original fifteen-session backtest. */
export function evaluatePreferenceOutcome({bars,reference,signalIndex}){
  const exit=signalIndex+policy.horizon;
  if(exit>=reference.length)return {status:'pending',reason:'three_future_sessions_not_yet_available'};
  const path=bars.slice(signalIndex,exit+1),benchmark=reference.slice(signalIndex,exit+1);
  if(path.length!==policy.horizon+1||path.some((bar,index)=>!validBar(bar)||bar.date!==benchmark[index]?.date)||benchmark.some(bar=>!validBar(bar)))return {status:'unavailable',reason:'missing_halted_or_misaligned_session'};
  const returnPercent=(path.at(-1).close/path[0].close-1)*100,referenceReturn=(benchmark.at(-1).close/benchmark[0].close-1)*100;
  if(!Number.isFinite(returnPercent)||!Number.isFinite(referenceReturn))return {status:'unavailable',reason:'nonfinite_close_change'};
  let peak=path[0].close,drawdownPercent=0;for(const bar of path){peak=Math.max(peak,bar.close);drawdownPercent=Math.max(drawdownPercent,(1-bar.close/peak)*100);}
  return {status:'ready',returnPercent,excessPercent:returnPercent-referenceReturn,drawdownPercent};
}

/** Adequacy allows comparison; neither a positive return nor the rank grants selection eligibility. */
export function rankPreferences(rows,currentRegime){
  if(!regimes.includes(currentRegime))return [];
  return rows.filter(row=>row.regime===currentRegime&&enough(row)&&[row.meanReturnPercent,row.meanExcessPercent,row.positiveRate].every(Number.isFinite)).slice().sort((a,b)=>b.meanExcessPercent-a.meanExcessPercent||b.meanReturnPercent-a.meanReturnPercent||b.positiveRate-a.positiveRate||a.patternId.localeCompare(b.patternId)).map((row,index)=>({...row,rank:index+1,rankingOnly:true,eligibleForSelection:false}));
}

export async function analyzeMarketPreference({batch,reference,records,patterns,universeMetadata=null,now=Date.now,signal,onProgress=()=>{}}){
  const checked=now();
  if(!batch||!validDay(batch.day)||!Number.isFinite(Date.parse(batch.asOf))||Date.parse(batch.asOf)<Date.parse(batch.day+'T15:00:00+08:00')||Date.parse(batch.asOf)>checked||typeof batch.sourceId!=='string'||!batch.sourceId||typeof batch.generation!=='string'||!batch.generation||!Number.isInteger(batch.total)||batch.total<1)throw Error('Market preference needs a closed identified source batch');
  if(patterns?.version!=='books.trend-patterns.2026-11-22.v2'||!Array.isArray(patterns.definitions)||patterns.definitions.length!==16||new Set(patterns.definitions.map(item=>item.id)).size!==16)throw Error('Market preference needs the unchanged fixed sixteen-pattern catalogue');
  if(reference?.code!=='000300.SH'||!Array.isArray(reference.bars)||!reference.bars.length||reference.bars.length>500||reference.bars.some((bar,index)=>!validBar(bar)||bar.date>batch.day||index&&bar.date<=reference.bars[index-1].date)||reference.bars.at(-1).date!==batch.day)throw Error('Market preference benchmark dates are missing, unordered or in the future');
  const dates=reference.bars.map(bar=>bar.date),states=reference.bars.map((_,index)=>marketRegimeAt(reference.bars,index)),currentRegime=states.at(-1),definitions=new Map(patterns.definitions.map(item=>[item.id,item]));
  const buckets=new Map();for(const regime of regimes)for(const patternId of definitions.keys())buckets.set(regime+':'+patternId,{regime,patternId,sumReturn:0,sumExcess:0,positive:0,worst:0,sampleCount:0,stocks:new Set(),signalDays:new Set(),pendingCount:0,unavailableCount:0,overlapCount:0});
  const seen=new Set(),counts={processed:0,readyToday:0,riskExcluded:0,missingBasis:0,patternMatchedDays:0,strengthAcceptedDays:0,earlyStrengthOrHeatRejectedDays:0};let firstRead=Infinity,lastRead=-Infinity;
  for await(const {stock,source}of records){
    signal?.throwIfAborted();
    if(!/^\d{6}\.(SH|SZ)$/.test(stock?.code||'')||seen.has(stock.code)||source?.sourceId!==batch.sourceId||source.day!==batch.day||!['ready','unavailable'].includes(source.status)||!Array.isArray(source.bars)||source.bars.length>500||source.bars.some((bar,index)=>!validDay(bar.date)||bar.date>batch.day||index&&bar.date<=source.bars[index-1].date)||!Number.isFinite(Date.parse(source.fetchedAt))||Date.parse(source.fetchedAt)<Date.parse(batch.asOf)||Date.parse(source.fetchedAt)>checked)throw Error('Market preference stock identity, source, date or read time is invalid');
    seen.add(stock.code);counts.processed++;firstRead=Math.min(firstRead,Date.parse(source.fetchedAt));lastRead=Math.max(lastRead,Date.parse(source.fetchedAt));
    if(/ST|退市|退$/i.test(stock.name||'')){counts.riskExcluded++;continue;}
    if(source.adjustment!=='qfq'){counts.missingBasis++;continue;}
    const series=prepare(source.bars,dates),lastExit=new Map();if(source.status==='ready'&&series.validRange(dates.length-61,dates.length-1))counts.readyToday++;
    for(let index=60;index<dates.length;index++){
      const regime=states[index].state;if(!regimes.includes(regime))continue;
      const matched=fixedMatches(series,index);if(!matched.length)continue;counts.patternMatchedDays++;
      if(!recentStrength(series,index)){counts.earlyStrengthOrHeatRejectedDays++;continue;}counts.strengthAcceptedDays++;
      for(const patternId of matched){
        const bucket=buckets.get(regime+':'+patternId);if(!bucket)throw Error('Market preference fixed detector returned an unknown pattern');
        // Future observation sessions are (signal, signal+3]; reserve before inspecting their prices.
        if(index+1<=(lastExit.get(patternId)??-1)){bucket.overlapCount++;continue;}lastExit.set(patternId,index+policy.horizon);
        const outcome=evaluatePreferenceOutcome({bars:series.bars,reference:reference.bars,signalIndex:index});
        if(outcome.status!=='ready'){bucket[outcome.status==='pending'?'pendingCount':'unavailableCount']++;continue;}
        bucket.sampleCount++;bucket.stocks.add(stock.code);bucket.signalDays.add(dates[index]);bucket.sumReturn+=outcome.returnPercent;bucket.sumExcess+=outcome.excessPercent;bucket.positive+=Number(outcome.returnPercent>0);bucket.worst=Math.max(bucket.worst,outcome.drawdownPercent);
      }
    }
    if(counts.processed%100===0)await onProgress({stage:'market-preference',checked:counts.processed,total:batch.total});
  }
  if(seen.size!==batch.total)throw Error('Market preference source coverage is incomplete');
  const rows=[...buckets.values()].map(bucket=>{
    if(![bucket.sumReturn,bucket.sumExcess,bucket.worst].every(Number.isFinite))throw Error('Market preference aggregate exceeds finite statistics');
    const result={regime:bucket.regime,patternId:bucket.patternId,label:definitions.get(bucket.patternId).label,sampleCount:bucket.sampleCount,stockCount:bucket.stocks.size,signalDayCount:bucket.signalDays.size,meanReturnPercent:bucket.sampleCount?bucket.sumReturn/bucket.sampleCount:null,positiveRate:bucket.sampleCount?bucket.positive/bucket.sampleCount:null,meanExcessPercent:bucket.sampleCount?bucket.sumExcess/bucket.sampleCount:null,worstDrawdownPercent:bucket.sampleCount?bucket.worst:null,pendingCount:bucket.pendingCount,unavailableCount:bucket.unavailableCount,overlapCount:bucket.overlapCount,eligibleForSelection:false};
    result.adequate=enough(result);result.adequacy={minimumSamples:policy.minSamples,minimumStocks:policy.minStocks,minimumSignalDays:policy.minSignalDays,reasons:[...(result.sampleCount<policy.minSamples?['fewer_than_30_events']:[]),...(result.stockCount<policy.minStocks?['fewer_than_10_stocks']:[]),...(result.signalDayCount<policy.minSignalDays?['fewer_than_10_signal_days']:[])]};return result;
  });
  return {schema:'books.a-share.market-preference.v1',version,completed:true,datasetBound:true,...Object.fromEntries(['generation','sourceId','day','asOf'].map(key=>[key,batch[key]])),computedAt:new Date(checked).toISOString(),policy:{...policy,patternVersion:patterns.version,earlyStrengthAndHeat:'original_recentStrength',limits:{maxReturn5:originalPolicy.maxReturn5,maxReturn20:originalPolicy.maxReturn20,maxMa20Deviation:originalPolicy.maxMa20Deviation,maxVolumeRatio:originalPolicy.maxVolumeRatio}},currentRegime,
    coverage:{...counts,universeCount:batch.total,historySessions:dates.length,historyStart:dates[0],historyEnd:dates.at(-1),sourceFetchedStart:new Date(firstRead).toISOString(),sourceFetchedEnd:new Date(lastRead).toISOString(),historicalMembership:false,universeBasis:universeMetadata?.basis||'current_roster_retrospective',fullMarketCycleVerified:false},byRegime:regimes.map(regime=>({regime,label:labels[regime],patterns:rows.filter(row=>row.regime===regime)})),adequateRanking:rankPreferences(rows,currentRegime.state),eligibleForSelection:false,
    method:{return:'same_batch_qfq_signal_close_to_third_future_session_close',cost:'gross_price_change_not_actual_trade_return_no_cost_deduction',excess:'same_three_session_benchmark_close_change',drawdown:'signal_close_to_third_session_close_path',event:'fixed_pattern_and_original_early_strength_at_signal_close',overlap:'future_sessions_(signal,signal_plus_3]_reserved_per_stock_pattern_before_outcome',ranking:'adequate_current_regime_comparison_only_not_profitability_or_selection_pass',scope:'at_most_500_verified_sessions_not_all_historical_bull_bear_cycles',universeWarning:'Current roster and current risk names are used retrospectively; historical membership and delisted survivors may be absent.',existingSixteenAndThirteenGatesChanged:false}};
}

/** One source record at a time; serializes derived statistics without publishing any source pointer. */
export async function precomputeMarketPreference({historyFile,target,batch,patterns,now=Date.now,signal,onProgress}){
  const path=join(target,filename+'.json');let previous;
  try{previous=await readStoredJson(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous){if(previous.schema!=='books.a-share.market-preference.v1'||previous.version!==version||previous.completed!==true||previous.datasetBound!==true||!same(previous,batch)||previous.policy?.horizon!==3||previous.policy.minSamples!==30||previous.policy.minStocks!==10||previous.policy.minSignalDays!==10||previous.eligibleForSelection!==false)throw Error('Market preference existing snapshot differs from the requested batch');return previous;}
  const iterator=readHistoryLines(historyFile)[Symbol.asyncIterator]();
  try{
    const first=await iterator.next();if(first.done)throw Error('Market preference private archive is empty');const header=JSON.parse(first.value);
    if(header.schema!=='books.a-share.history.v1'||!same(header,batch)||header.total!==batch.total||header.historyRequested!==500)throw Error('Market preference archive header differs from the completed batch');
    const records=(async function*(){for(let next=await iterator.next();!next.done;next=await iterator.next())yield JSON.parse(next.value);})();
    const report=await analyzeMarketPreference({batch,reference:header.reference,records,patterns,universeMetadata:header.universePolicy,now,signal,onProgress}),body=JSON.stringify(report);
    signal?.throwIfAborted();await writeFile(path+'.tmp',body);await writeFile(path+'.gz.tmp',gzipSync(body));await rename(path+'.gz.tmp',path+'.gz');await rename(path+'.tmp',path);return report;
  }finally{await iterator.return?.();}
}
