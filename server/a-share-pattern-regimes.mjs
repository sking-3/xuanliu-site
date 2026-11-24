export const version='books.pattern-regimes.2026-11-24.v1';
const fixedProfile={id:'daily-close-volume-v1',fastPeriod:5,midPeriod:10,slowPeriod:20,slopeDays:5,maPeriods:[5,10,20],consolidationDays:5,nearPct:2,rangePct:4,crossWindow:3,pullbackMinPct:2,pullbackMaxPct:8,volumeRecentDays:5,volumePreviousDays:20,volumeExpandRatio:1.2,volumeContractRatio:.8};
export const policy=Object.freeze({lookback:20,horizon:15,targetReturnPercent:5,trainDays:120,recentDays:60,testDays:180,foldDays:20,purgeDays:15,roundTripCostPercent:.3,minTrainSamples:60,minTrainStocks:20,minTrainDates:20,minRecentSamples:30,minRecentStocks:10,minRecentDates:10,minValidationSamples:60,minValidationStocks:20,minValidationDates:20,minPositiveFolds:2,minIndependentBlocks:8,familywiseAlpha:.05,maxReturn5:8,maxReturn20:15,maxMa20Deviation:8,maxVolumeRatio:2.5,formedWithinDays:3});
const horizons=[3,5,10,15];
const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const exceeds=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
const compare=(a,b)=>a<b?-1:a>b?1:0;
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validBar=bar=>bar&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const median=values=>{const ordered=values.slice().sort((a,b)=>a-b),m=Math.floor(ordered.length/2);return ordered.length%2?ordered[m]:(ordered[m-1]+ordered[m])/2;};

function prepare(bars,dates){
  const byDay=new Map();let previous='';
  for(const bar of bars||[]){if(!validDay(bar?.date)||bar.date<=previous)throw Error('形态日线日期重复、逆序或无效');previous=bar.date;byDay.set(bar.date,bar);}
  const aligned=dates.map(date=>byDay.get(date)||null),n=dates.length;
  const prices=new Float64Array(n+1),volumes=new Float64Array(n+1),invalid=new Uint16Array(n+1),mas=new Map([5,10,20].map(period=>[period,new Float64Array(n)]));
  for(let i=0;i<n;i++){
    const valid=validBar(aligned[i]);prices[i+1]=prices[i]+(valid?aligned[i].close:0);volumes[i+1]=volumes[i]+(valid?aligned[i].volume:0);invalid[i+1]=invalid[i]+Number(!valid);
    for(const [period,values]of mas)values[i]=i+1>=period&&invalid[i+1]===invalid[i+1-period]?(prices[i+1]-prices[i+1-period])/period:NaN;
  }
  return {bars:aligned,prices,volumes,invalid,mas,validRange:(start,end)=>start>=0&&invalid[end+1]===invalid[start]};
}

/** The fixed close/volume catalogue, with the same defaults as trend-patterns.v2. */
export function fixedMatches(series,index){
  const {bars,volumes,mas,validRange}=series;
  if(index<60||!validRange(index-60,index))return [];
  const matched=[],close=bars[index].close,fast=mas.get(5),mid=mas.get(10),slow=mas.get(20);
  if(exceeds(fast[index],mid[index])&&exceeds(mid[index],slow[index])&&exceeds(slow[index],slow[index-5]))matched.push('trend-up');
  if(exceeds(mid[index],fast[index])&&exceeds(slow[index],mid[index])&&exceeds(slow[index-5],slow[index]))matched.push('trend-down');
  let previousHigh=-Infinity,previousLow=Infinity,peak=close;
  for(let i=index-20;i<index;i++){previousHigh=Math.max(previousHigh,bars[i].close);previousLow=Math.min(previousLow,bars[i].close);peak=Math.max(peak,bars[i].close);}
  const drawdown=(1-close/peak)*100;
  if(!exceeds(2,drawdown)&&!exceeds(drawdown,8))matched.push('close-pullback');
  for(const period of [5,10,20]){
    const ma=mas.get(period);let low=Infinity,high=-Infinity,maxDeviation=0;
    for(let i=index-4;i<=index;i++){low=Math.min(low,bars[i].close);high=Math.max(high,bars[i].close);maxDeviation=Math.max(maxDeviation,Math.abs(bars[i].close/ma[i]-1)*100);}
    if(!exceeds(maxDeviation,2)&&!exceeds((high/low-1)*100,4))matched.push('near-ma-'+period);
    for(const direction of ['regain','lose']){
      if(direction==='regain'?!exceeds(close,ma[index]):!exceeds(ma[index],close))continue;
      for(let i=index;i>index-3;i--){
        const crossed=direction==='regain'?exceeds(bars[i].close,ma[i])&&!exceeds(bars[i-1].close,ma[i-1]):exceeds(ma[i],bars[i].close)&&!exceeds(ma[i-1],bars[i-1].close);
        if(crossed){matched.push(direction+'-ma-'+period);break;}
      }
    }
  }
  if(exceeds(close,previousHigh))matched.push('close-breakout');
  if(exceeds(previousLow,close))matched.push('close-breakdown');
  const ratio=((volumes[index+1]-volumes[index-4])/5)/((volumes[index-4]-volumes[index-24])/20);
  if(!exceeds(1.2,ratio))matched.push('volume-expand');
  if(!exceeds(ratio,.8))matched.push('volume-contract');
  return matched;
}

/** Signal is known at close; entry is the next actual open, never the signal close. */
export function evaluateEvent({bars,reference,signalIndex,code,costPercent=policy.roundTripCostPercent}){
  const entryIndex=signalIndex+1,exitIndex=signalIndex+policy.horizon;
  if(exitIndex>=bars.length)return {status:'pending',reason:'尚未满15个后续交易日'};
  const previous=bars[signalIndex],entry=bars[entryIndex],exit=bars[exitIndex];
  if(!validBar(previous)||!validBar(entry)||!validBar(exit))return {status:'unavailable',reason:'信号、入场或退出日缺有效成交'};
  if(entry.high===entry.low)return {status:'unexecutable',reason:'次日为一字价日，未假设可以买入'};
  if(entry.open/previous.close>=1.098)return {status:'unexecutable',reason:'次日开盘接近或超过主板涨停，未假设可以买入'};
  const beforeExit=bars[exitIndex-1];
  if(validBar(beforeExit)&&exit.high===exit.low&&exit.close<beforeExit.close)return {status:'unexecutable',reason:'退出日一字下跌，未假设可以卖出'};
  let peak=entry.open,drawdown=0;
  for(let i=entryIndex;i<=exitIndex;i++){
    if(!validBar(bars[i])||!validBar(reference[i]))return {status:'unavailable',reason:'持有区间停牌、无成交或缺日线，不跨缺口计算'};
    peak=Math.max(peak,bars[i].close);drawdown=Math.max(drawdown,(1-bars[i].close/peak)*100);
  }
  if(!validBar(reference[entryIndex]))return {status:'unavailable',reason:'同期指数开盘缺失'};
  const returns={};for(const horizon of horizons)returns[horizon]=(bars[signalIndex+horizon].close/entry.open-1)*100-costPercent;
  const referenceReturn=(reference[exitIndex].close/reference[entryIndex].open-1)*100;
  return {status:'ready',code,signalIndex,entryIndex,exitIndex,returns,returnPercent:returns[15],excessPercent:returns[15]-referenceReturn,drawdownPercent:drawdown};
}

function wilson(successes,total){
  if(!total)return [null,null];const z=1.959963984540054,p=successes/total,denominator=1+z*z/total,center=(p+z*z/(2*total))/denominator,margin=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/denominator;
  return [Math.max(0,center-margin),Math.min(1,center+margin)];
}

export function summarizeEvents(events,dates){
  const count=events.length,values=events.map(event=>event.returnPercent),hits=events.filter(event=>!exceeds(policy.targetReturnPercent,event.returnPercent)).length;
  const [low,high]=wilson(hits,count),signals=events.map(event=>event.signalIndex);let first=Infinity,last=-Infinity,worst=0;
  for(const event of events){first=Math.min(first,event.signalIndex);last=Math.max(last,event.signalIndex);worst=Math.max(worst,event.drawdownPercent);}
  return {sampleCount:count,stockCount:new Set(events.map(event=>event.code)).size,signalDayCount:new Set(signals).size,fromDay:count?dates[first]:null,toDay:count?dates[last]:null,
    meanReturnPercent:count?mean(values):null,medianReturnPercent:count?median(values):null,meanExcessPercent:count?mean(events.map(event=>event.excessPercent)):null,positiveRate:count?values.filter(value=>value>0).length/count:null,targetHitRate:count?hits/count:null,targetHitWilsonLow:low,targetHitWilsonHigh:high,
    meanDrawdownPercent:count?mean(events.map(event=>event.drawdownPercent)):null,worstDrawdownPercent:count?worst:null,
    returns:Object.fromEntries(horizons.map(horizon=>[String(horizon),{sampleCount:count,meanReturnPercent:count?mean(events.map(event=>event.returns[horizon])):null}]))};
}

function adequate(stats,kind){
  const prefix=kind==='recent'?'minRecent':kind==='validation'?'minValidation':'minTrain';
  return stats.sampleCount>=policy[prefix+'Samples']&&stats.stockCount>=policy[prefix+'Stocks']&&stats.signalDayCount>=policy[prefix+'Dates'];
}
const positive=stats=>stats.sampleCount>0&&stats.meanReturnPercent>0&&stats.meanExcessPercent>0&&stats.positiveRate>=.5;
function signTail(positive,total){let combinations=1,sum=0;for(let i=0;i<=total;i++){if(i>=positive)sum+=combinations;combinations=combinations*(total-i)/(i+1);}return sum/2**total;}

/** Each fold's choice is frozen before any outcome from that fold is observed. */
export function walkForward(events,dates,{patternCount=16}={}){
  const matureEnd=dates.length-1-policy.horizon,testStart=matureEnd-policy.testDays+1,folds=[],selectedEvents=[];
  if(testStart-policy.purgeDays-policy.trainDays<60)return {status:'insufficient',reason:'需要足够的前置形态、120日训练、15日隔离和180日样本外区间',folds,selectedEvents,stats:summarizeEvents([],dates),blockCount:0,positiveBlockCount:0,pValue:null,adjustedPValue:null};
  for(let start=testStart;start<=matureEnd;start+=policy.foldDays){
    const end=Math.min(start+policy.foldDays-1,matureEnd),trainEnd=start-policy.purgeDays-1,trainStart=trainEnd-policy.trainDays+1;
    const training=summarizeEvents(events.filter(event=>event.signalIndex>=trainStart&&event.signalIndex<=trainEnd&&event.exitIndex<start),dates),selected=adequate(training,'train')&&positive(training);
    const testing=events.filter(event=>event.signalIndex>=start&&event.signalIndex<=end),test=summarizeEvents(testing,dates);
    if(selected)selectedEvents.push(...testing);
    folds.push({startDay:dates[start],endDay:dates[end],trainedThrough:dates[trainEnd],trainingOutcomeThrough:dates[trainEnd+policy.horizon],selected,training,test});
  }
  // One cross-sectional average on each 15-session anchor: holding intervals do not overlap.
  // Other events still contribute to descriptive OOS statistics, never to independent-block count.
  const blocks=[];
  for(let index=testStart;index<=matureEnd;index+=policy.horizon){
    const bucket=selectedEvents.filter(event=>event.signalIndex===index);
    if(new Set(bucket.map(event=>event.code)).size>=3){const excess=mean(bucket.map(event=>event.excessPercent));if(excess!==0)blocks.push(excess);}
  }
  const blockCount=blocks.length,positiveBlockCount=blocks.filter(value=>value>0).length,pValue=blockCount?signTail(positiveBlockCount,blockCount):null;
  const stats=summarizeEvents(selectedEvents,dates),selectedFoldCount=folds.filter(fold=>fold.selected).length,positiveFoldCount=folds.filter(fold=>fold.selected&&positive(fold.test)).length;
  return {status:'ready',folds,selectedEvents,stats,selectedFoldCount,positiveFoldCount,blockCount,positiveBlockCount,pValue,adjustedPValue:pValue===null?null:Math.min(1,pValue*patternCount)};
}

function recentStrength(series,index){
  const {bars,mas,volumes,validRange}=series;
  if(index<60||!validRange(index-60,index))return null;
  const close=bars[index].close,ma5=mas.get(5),ma20=mas.get(20),metrics={return5:(close/bars[index-5].close-1)*100,return20:(close/bars[index-20].close-1)*100,ma20Deviation:(close/ma20[index]-1)*100,volumeRatio:((volumes[index+1]-volumes[index-4])/5)/((volumes[index-4]-volumes[index-24])/20)};
  let cross=false;for(let i=index;i>index-5;i--)if(exceeds(ma5[i],ma20[i])&&!exceeds(ma5[i-1],ma20[i-1])){cross=true;break;}
  return metrics.return5>0&&exceeds(close,ma20[index])&&exceeds(ma5[index],ma20[index])&&cross&&!exceeds(metrics.return5,policy.maxReturn5)&&!exceeds(metrics.return20,policy.maxReturn20)&&!exceeds(metrics.ma20Deviation,policy.maxMa20Deviation)&&!exceeds(metrics.volumeRatio,policy.maxVolumeRatio)?metrics:null;
}

export async function analyzePatternRegimes({dataset,records=dataset?.records,patterns,day=dataset?.day,asOf=dataset?.asOf,sourceId,generation,now=Date.now,universeMetadata=dataset?.universeMetadata,onProgress}={}){
  if(!dataset||!validDay(day)||dataset.day!==day||!finite(Date.parse(asOf))||Date.parse(asOf)>now()||typeof sourceId!=='string'||!sourceId||typeof generation!=='string'||!generation)throw Error('形态统计须绑定完整日线的日期、来源和批次');
  if(patterns?.version!=='books.trend-patterns.2026-11-22.v2'||Object.entries(fixedProfile).some(([key,value])=>JSON.stringify(patterns.profile?.[key])!==JSON.stringify(value))||!Array.isArray(patterns.definitions)||patterns.definitions.length!==16)throw Error('固定形态目录版本或参数不符，不能沿用旧统计');
  const reference=dataset.reference;
  if(reference?.code!=='000300.SH'||!Array.isArray(reference.bars)||reference.bars.length>640||!reference.bars.length)throw Error('形态统计需要沪深300同口径完整历史');
  const dates=reference.bars.map(bar=>bar.date);
  if(dates.some((date,i)=>!validDay(date)||date>day||i&&date<=dates[i-1])||dates.at(-1)!==day||reference.bars.some(bar=>!validBar(bar)))throw Error('形态参考历史缺失、日期不齐或晚于目标日');
  if(!records||!records[Symbol.iterator]&&!records[Symbol.asyncIterator])throw Error('形态统计缺少市场名册');
  const universeCount=dataset.universe?.length||dataset.expectedCount||(Array.isArray(records)?records.length:null);
  const definitions=patterns.definitions,events=new Map(definitions.map(def=>[def.id,{chunks:[],count:0}])),counts=new Map(definitions.map(def=>[def.id,{current:0,pending:0,unavailable:0,unexecutable:0}])),fresh=[],seen=new Set();let readyCount=0;
  const end=dates.length-1;
  const firstNeeded=Math.max(61,end-policy.horizon-policy.testDays-policy.purgeDays-policy.trainDays);
  for await(const record of records){
    const stock=record?.stock,source=record?.source;
    if(typeof stock?.code!=='string'||seen.has(stock.code))throw Error('形态市场名册代码缺失或重复');seen.add(stock.code);
    if(!['ready','unavailable'].includes(source?.status)||source.adjustment!=='qfq'||source.sourceId&&source.sourceId!==sourceId||!Array.isArray(source.bars)||source.bars.some(bar=>bar.date>day)||/ST|退市|退$/i.test(stock.name||''))continue;
    const series=prepare(source.bars,dates);
    const todayReady=source.status==='ready'&&series.validRange(end-60,end);
    if(todayReady)readyCount++;
    let previous=new Set(),previousKnown=false,lastSignal=new Map(),formed=new Map();
    for(let index=60;index<=end;index++){
      const known=series.validRange(index-60,index),matched=new Set(fixedMatches(series,index));
      for(const id of matched){
        if(index===end&&todayReady)counts.get(id).current++;
        if(previous.has(id)||!previousKnown)continue;
        formed.set(id,index);
        if(index-(lastSignal.get(id)??-Infinity)<policy.horizon)continue;
        lastSignal.set(id,index);
        if(index<firstNeeded)continue;
        const event=evaluateEvent({bars:series.bars,reference:reference.bars,signalIndex:index,code:stock.code});
        if(event.status==='ready'){
          const rows=events.get(id),row=rows.count++,chunkIndex=Math.floor(row/4096);
          rows.chunks[chunkIndex]||=new Float64Array(4096*8);
          rows.chunks[chunkIndex].set([seen.size,index,event.returns[3],event.returns[5],event.returns[10],event.returns[15],event.excessPercent,event.drawdownPercent],row%4096*8);
        }else counts.get(id)[event.status]++;
      }
      previous=matched;previousKnown=known;
    }
    const ids=todayReady?[...previous].filter(id=>formed.has(id)&&end-formed.get(id)<policy.formedWithinDays):[],metrics=ids.length?recentStrength(series,end):null;
    if(metrics)fresh.push({code:stock.code,name:stock.name,patternIds:ids,formed,metrics,sourceAt:source.fetchedAt||asOf});
    if(onProgress&&readyCount%100===0)onProgress({stage:'pattern-statistics',checked:seen.size,total:universeCount,ready:readyCount});
  }
  const matureEnd=end-policy.horizon,output=[];
  for(const definition of definitions){
    // Compact numeric rows retain derived outcomes for all stocks; expand only one pattern at a time.
    const compact=events.get(definition.id),historical=[];events.delete(definition.id);
    for(let row=0;row<compact.count;row++){
      const chunk=compact.chunks[Math.floor(row/4096)],i=row%4096*8;
      historical.push({code:chunk[i],signalIndex:chunk[i+1],exitIndex:chunk[i+1]+policy.horizon,returns:{3:chunk[i+2],5:chunk[i+3],10:chunk[i+4],15:chunk[i+5]},returnPercent:chunk[i+5],excessPercent:chunk[i+6],drawdownPercent:chunk[i+7]});
    }
    compact.chunks.length=0;
    historical.sort((a,b)=>a.signalIndex-b.signalIndex||a.code-b.code);
    const fit=summarizeEvents(historical.filter(event=>event.signalIndex>matureEnd-policy.trainDays&&event.signalIndex<=matureEnd),dates),recent=summarizeEvents(historical.filter(event=>event.signalIndex>matureEnd-policy.recentDays&&event.signalIndex<=matureEnd),dates),rolling=walkForward(historical,dates,{patternCount:definitions.length});
    const reasons=[];
    if(!adequate(fit,'train'))reasons.push('最近120个成熟信号日的样本、股票或日期数不足');else if(!positive(fit))reasons.push('最近120个成熟信号日没有同时保持正估算收益、正超额和至少半数正收益');
    if(!adequate(recent,'recent'))reasons.push('最近60个成熟信号日样本不足');else if(!positive(recent))reasons.push('最近60个成熟信号日优势未保持');
    if(rolling.status!=='ready')reasons.push(rolling.reason);
    else{
      if(!adequate(rolling.stats,'validation'))reasons.push('训练期已选形态的样本外事件不足');
      if(!positive(rolling.stats))reasons.push('滚动样本外没有同时保持正估算收益、正超额和至少半数正收益');
      if(rolling.positiveFoldCount<policy.minPositiveFolds)reasons.push('至少两个已预选样本外区间为正的条件未满足');
      if(rolling.blockCount<policy.minIndependentBlocks)reasons.push('非重叠15日验证锚点不足8个');
      if(rolling.adjustedPValue===null||rolling.adjustedPValue>policy.familywiseAlpha)reasons.push('非重叠区间胜出检验未通过固定目录的多重比较校正');
    }
    const recommended=reasons.length===0,insufficient=!adequate(fit,'train')||!adequate(recent,'recent')||rolling.status!=='ready';
    const {selectedEvents,stats,status,reason,...validation}=rolling;
    output.push({...definition,status:recommended?'effective':insufficient?'insufficient':positive(fit)&&positive(recent)?'watch':'inactive',recommended,reasons,currentMatchCount:counts.get(definition.id).current,pendingCount:counts.get(definition.id).pending,excludedEvents:{unavailable:counts.get(definition.id).unavailable,unexecutable:counts.get(definition.id).unexecutable},fit,recent,validation:{...stats,...validation}});
  }
  const effective=new Set(output.filter(item=>item.recommended).map(item=>item.id)),candidates=fresh.map(stock=>{
    const patternIds=stock.patternIds.filter(id=>effective.has(id));
    return {code:stock.code,name:stock.name,patternIds,formedAt:patternIds.length?dates[Math.max(...patternIds.map(id=>stock.formed.get(id)))]:null,metrics:stock.metrics,sourceAt:stock.sourceAt};
  }).filter(stock=>stock.patternIds.length).sort((a,b)=>a.metrics.return5-b.metrics.return5||compare(a.code,b.code));
  const universeWarning='按本次名册及当前风险名称过滤回看历史，不含已退市或历史时点名册，可能有存续偏差；当日停牌或缺行情不会抹掉已成熟历史事件。结果仅为研究候选，不代表可实现收益。';
  return {schema:'books.a-share.pattern-regimes.v1',version,day,asOf,computedAt:new Date(now()).toISOString(),sourceId,generation,benchmark:{code:reference.code,label:'沪深300'},policy:{...policy,patternVersion:patterns.version},coverage:{universeCount:universeCount||seen.size,readyCount,historyDays:dates.length,historyStart:dates[0],historyEnd:day,universeBasis:universeMetadata?.basis||'current-roster-retrospective',warning:universeWarning},
    summary:{patternCount:definitions.length,effectiveCount:effective.size,candidateCount:candidates.length,reason:effective.size?candidates.length?'已按近期有效固定形态及初期转强、未明显拉升条件筛选':'近期有效形态当前没有满足初期转强及未明显拉升条件的股票':'尚无固定形态通过完整近期与滚动样本外门槛；保留各形态样本和未通过原因'},patterns:output,candidates,candidateCodes:candidates.map(stock=>stock.code),
    method:{returnLabel:'信号次一交易日开盘至第3/5/10/15个后续交易日收盘的前复权价格变化估算；各期限使用同一15日成熟事件组，非实际成交收益',drawdownLabel:'从次日开盘起，15个交易日收盘路径的最大回撤；未含盘中高低点及费用',costLabel:'估算收益统一减去往返费用及滑点0.30个百分点；实际费率与成交差异未知',validationLabel:'固定形态参数；120个信号日训练、15交易日隔离、随后20日验证，最近180个成熟信号日滚动9折；非重叠15日锚点按日期合并后单侧符号检验，按固定目录数Bonferroni校正；检验假设各区间方向独立，不能证明未来获利',confidenceLabel:'5%目标命中率的95% Wilson区间仅描述事件组；同日股票相关，不能当独立样本的保证',universeWarning}};
}
