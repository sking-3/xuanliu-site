import {policy as patternPolicy,summarizeEvents} from './a-share-pattern-regimes.mjs';

export const entryValidationVersion='books.entry-validation.2026-11-24.v1';
export const entryValidationPolicy=Object.freeze({...patternPolicy,anchorStrideSessions:16});
export const version=entryValidationVersion,policy=entryValidationPolicy;
const horizons=[3,5,10,15];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
const validBar=bar=>bar&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
const closeAt=day=>day+'T15:00:00+08:00';

function confirmation(bars,index,formation){
  const prior=bars.slice(index-20,index),current=bars[index];
  if(prior.length!==20||!validBar(current)||prior.some(bar=>!validBar(bar)))return false;
  const ma20=mean(bars.slice(index-19,index+1).map(bar=>bar.close));
  return above(current.close,formation.high)&&above(current.close,current.open)&&above(current.close,ma20)&&!above(mean(prior.map(bar=>bar.volume)),current.volume);
}

/** Inputs are aligned once per stock to the actual reference calendar. T is not F+1. */
export function evaluateEntryOutcome({setup,bars,reference,dates,code}={}){
  if(setup?.replayStatus!=='triggered_observation')return {status:setup?.replayStatus||'not_triggered',reason:'未观察到本规则的有效后日突破，不纳入触发收益样本'};
  const formationIndex=dates.indexOf(setup.formation?.date),keyBarIndex=dates.indexOf(setup.keyBar?.date),signalIndex=dates.indexOf(setup.observedEvent?.date),exitIndex=signalIndex+entryValidationPolicy.horizon;
  if(formationIndex<20||keyBarIndex<=formationIndex||keyBarIndex>formationIndex+3||signalIndex<=keyBarIndex||signalIndex>keyBarIndex+3)return {status:'unavailable',reason:'形成、确认和触发的交易日顺序或固定窗口不符'};
  const formation=bars[formationIndex],key=bars[keyBarIndex],trigger=bars[signalIndex];
  if(!validBar(formation)||!validBar(key)||!validBar(trigger)||formation.date!==dates[formationIndex]||key.date!==dates[keyBarIndex]||trigger.date!==dates[signalIndex])return {status:'unavailable',reason:'F/C/T 原始日线缺失或未按指数日历对齐'};
  if(setup.trigger?.above!==key.high||setup.invalidation?.below!==formation.low)return {status:'unavailable',reason:'触发或固定失效参考位与原始关键K不符'};
  for(let i=formationIndex;i<=keyBarIndex;i++){
    const bar=bars[i];
    if(!validBar(bar)||bar.date!==dates[i])return {status:'unavailable',reason:'确认窗口缺有效原始日线'};
    if(bar.high===bar.low)return {status:'unexecutable',reason:'形成或确认窗口为一字价日'};
    if(i>formationIndex&&above(formation.low,bar.low))return {status:'invalidated',reason:'确认前已跌破固定失效位'};
    if(i>formationIndex&&confirmation(bars,i,formation)&&i<keyBarIndex)return {status:'unavailable',reason:'确认K不是原规则首次确认，未重新挑选较优入场'};
  }
  if(!confirmation(bars,keyBarIndex,formation))return {status:'unavailable',reason:'原始确认K未满足阳线、MA20、量能及越位条件'};
  const level=key.high;
  for(let i=keyBarIndex+1;i<=signalIndex;i++){
    const bar=bars[i];
    if(!validBar(bar)||bar.date!==dates[i])return {status:'unavailable',reason:'触发窗口缺有效日线，不跨缺口确认'};
    if(above(formation.low,bar.open))return {status:'invalidated',reason:'触发前开盘已低于固定失效位'};
    if(above((bar.open/level-1)*100,2))return {status:'chased',reason:'开盘高于触发参考位超过固定2%限制'};
    if(bar.high===bar.low)return {status:'unexecutable',reason:'触发窗口为一字价日，未假设可以买入'};
    const touched=above(bar.high,level),invalid=above(formation.low,bar.low);
    if(touched&&invalid)return {status:'ambiguous',reason:'同日同时触发与失效，日线不能确认先后'};
    if(invalid)return {status:'invalidated',reason:'触发前跌破固定失效位'};
    if(touched&&i<signalIndex)return {status:'unavailable',reason:'T不是首次严格突破，未跳过更早触发'};
    if(i===signalIndex&&!touched)return {status:'not_triggered',reason:'最高价未严格越过关键K高点'};
  }
  const entryPrice=Math.max(level,trigger.open);
  let peak=entryPrice,drawdown=0,invalidationFirstDay=null;
  for(let i=signalIndex;i<=Math.min(exitIndex,dates.length-1);i++){
    const bar=bars[i],benchmark=reference[i];
    if(!validBar(bar)||bar.date!==dates[i]||!validBar(benchmark)||benchmark.date!==dates[i])return {status:'unavailable',reason:'触发后持有窗口停牌、缺日线或指数缺失，不跳交易日'};
    if(i===exitIndex&&bar.high===bar.low&&bar.close<bars[i-1].close)return {status:'unexecutable',reason:'第15交易日一字下跌，无法核实按固定期限退出'};
    peak=Math.max(peak,bar.close);drawdown=Math.max(drawdown,(1-bar.close/peak)*100);
    if(!invalidationFirstDay&&above(formation.low,bar.low))invalidationFirstDay=dates[i];
  }
  if(exitIndex>=dates.length)return {status:'pending',reason:'触发后尚未满15个后续交易日',signalIndex,entryIndex:signalIndex,exitIndex,code};
  const returns=Object.fromEntries(horizons.map(horizon=>[horizon,(bars[signalIndex+horizon].close/entryPrice-1)*100-entryValidationPolicy.roundTripCostPercent]));
  const referenceReturn=(reference[exitIndex].close/reference[signalIndex].close-1)*100;
  const closeAlignedReturn=(bars[exitIndex].close/trigger.close-1)*100-entryValidationPolicy.roundTripCostPercent;
  return {status:'ready',code,signalIndex,entryIndex:signalIndex,exitIndex,formationIndex,keyBarIndex,returns,returnPercent:returns[15],excessPercent:closeAlignedReturn-referenceReturn,drawdownPercent:drawdown,closeAlignedReturnPercent:closeAlignedReturn,
    entryReference:entryPrice,fixedInvalidation:formation.low,invalidationFirstDay,researchConditionKnownAt:closeAt(dates[keyBarIndex]),actualDiscoveryAt:setup.knownAt||null,
    entryMode:above(trigger.open,level)?'opening_gap_reference':'intraday_cross_reference',actualFillVerified:false};
}

/** Reserve one stock's T..T+15 intervals before inspecting any later outcome. */
export function reserveEntryIntervals(setups,dates){
  const positions=new Map(dates.map((day,index)=>[day,index])),reserved=new Map(),lastExit=new Map();
  const triggered=setups.filter(setup=>setup.replayStatus==='triggered_observation').map(setup=>{
    const index=positions.get(setup.observedEvent?.date);
    if(index===undefined||typeof setup.id!=='string'||!Array.isArray(setup.patternIds))throw Error('关键K占位缺少已核实的触发日期或形态身份');
    return {setup,index};
  }).sort((a,b)=>a.index-b.index||a.setup.id.localeCompare(b.setup.id));
  for(const {setup,index}of triggered){
    if(reserved.has(setup.id))throw Error('关键K占位身份重复');
    const acceptedPatternIds=[],overlapPatternIds=[];
    for(const id of setup.patternIds){
      if(index<=(lastExit.get(id)??-1))overlapPatternIds.push(id);
      else{acceptedPatternIds.push(id);lastExit.set(id,index+entryValidationPolicy.horizon);}
    }
    reserved.set(setup.id,{acceptedPatternIds,overlapPatternIds});
  }
  return reserved;
}

function checkedEvents(events,dates){
  const ordered=events.slice().sort((a,b)=>a.signalIndex-b.signalIndex||String(a.code).localeCompare(String(b.code))),out=[],lastExit=new Map();let overlapExcludedCount=0;
  for(const event of ordered){
    if(!['string','number'].includes(typeof event.code)||event.code===''||!Number.isInteger(event.signalIndex)||event.signalIndex<0||event.entryIndex!==event.signalIndex||event.exitIndex!==event.signalIndex+entryValidationPolicy.horizon||event.exitIndex>=dates.length||!horizons.every(horizon=>finite(event.returns?.[horizon]))||![event.returnPercent,event.excessPercent,event.drawdownPercent].every(finite)||event.drawdownPercent<0)throw Error('关键K成熟收益事件结构或触发后15日口径无效');
    const key=String(event.code);
    if(event.signalIndex<=(lastExit.get(key)??-1)){overlapExcludedCount++;continue;}
    out.push(event);lastExit.set(key,event.exitIndex);
  }
  return {events:out,overlapExcludedCount};
}
function adequate(stats,kind){
  const prefix=kind==='recent'?'minRecent':kind==='validation'?'minValidation':'minTrain';
  return stats.sampleCount>=entryValidationPolicy[prefix+'Samples']&&stats.stockCount>=entryValidationPolicy[prefix+'Stocks']&&stats.signalDayCount>=entryValidationPolicy[prefix+'Dates'];
}
const positive=stats=>stats.sampleCount>0&&stats.meanReturnPercent>0&&stats.meanExcessPercent>0&&stats.positiveRate>=.5;
function signTail(positive,total){let combinations=1,sum=0;for(let i=0;i<=total;i++){if(i>=positive)sum+=combinations;combinations=combinations*(total-i)/(i+1);}return sum/2**total;}

/** Mature events must first pass trigger-time reservation; OOS outcomes never choose their fold. */
export function validateEntryEvents(input,dates,{patternCount=16}={}){
  if(!Array.isArray(input)||!Array.isArray(dates)||!dates.length||dates.some((day,i)=>typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||i&&day<=dates[i-1])||patternCount!==16)throw Error('关键K验证须使用实际有序日历与固定16类多重校正');
  const {events,overlapExcludedCount}=checkedEvents(input,dates),policy=entryValidationPolicy;
  const matureEnd=dates.length-1-policy.horizon,testStart=matureEnd-policy.testDays+1,folds=[],selectedEvents=[];
  const fit=summarizeEvents(events.filter(event=>event.signalIndex>matureEnd-policy.trainDays&&event.signalIndex<=matureEnd),dates),recent=summarizeEvents(events.filter(event=>event.signalIndex>matureEnd-policy.recentDays&&event.signalIndex<=matureEnd),dates);
  const historyReady=testStart-policy.purgeDays-policy.trainDays>=60;
  if(historyReady)for(let start=testStart;start<=matureEnd;start+=policy.foldDays){
    const end=Math.min(start+policy.foldDays-1,matureEnd),trainEnd=start-policy.purgeDays-1,trainStart=trainEnd-policy.trainDays+1;
    const trainingEvents=events.filter(event=>event.signalIndex>=trainStart&&event.signalIndex<=trainEnd&&event.exitIndex<start),training=summarizeEvents(trainingEvents,dates),selected=adequate(training,'train')&&positive(training),testing=events.filter(event=>event.signalIndex>=start&&event.signalIndex<=end);
    if(selected)selectedEvents.push(...testing);
    folds.push({startDay:dates[start],endDay:dates[end],trainedThrough:dates[trainEnd],trainingOutcomeThrough:trainingEvents.length?dates[trainingEvents.reduce((last,event)=>Math.max(last,event.exitIndex),0)]:null,selected,training,test:summarizeEvents(testing,dates)});
  }
  // T..T+15 includes 16 sessions. Adjacent independent anchors never share a holding session.
  const blocks=[];
  for(let index=testStart;historyReady&&index<=matureEnd;index+=policy.anchorStrideSessions){
    const bucket=selectedEvents.filter(event=>event.signalIndex===index);
    if(new Set(bucket.map(event=>event.code)).size>=3){const excess=mean(bucket.map(event=>event.excessPercent));if(excess!==0)blocks.push({triggerDay:dates[index],exitDay:dates[index+policy.horizon],stockCount:bucket.length,meanExcessPercent:excess});}
  }
  const blockCount=blocks.length,positiveBlockCount=blocks.filter(block=>block.meanExcessPercent>0).length,pValue=blockCount?signTail(positiveBlockCount,blockCount):null;
  const validation={...summarizeEvents(selectedEvents,dates),status:historyReady?'ready':'insufficient',folds,selectedFoldCount:folds.filter(fold=>fold.selected).length,positiveFoldCount:folds.filter(fold=>fold.selected&&positive(fold.test)).length,blockCount,positiveBlockCount,pValue,adjustedPValue:pValue===null?null:Math.min(1,pValue*patternCount),blocks};
  const checks=[
    ['fit_samples',adequate(fit,'train'),'最近120个成熟触发日样本、股票或日期数不足'],
    ['fit_edge',positive(fit),'最近120个成熟触发日未同时保持正估算收益、正超额及至少半数正收益'],
    ['recent_samples',adequate(recent,'recent'),'最近60个成熟触发日样本、股票或日期数不足'],
    ['recent_edge',positive(recent),'最近60个成熟触发日优势未保持'],
    ['history',historyReady,'历史不足以容纳固定训练、隔离和样本外区间'],
    ['validation_samples',adequate(validation,'validation'),'训练预选后的样本外触发事件不足'],
    ['validation_edge',positive(validation),'滚动样本外未同时保持正估算收益、正超额及至少半数正收益'],
    ['positive_folds',validation.positiveFoldCount>=policy.minPositiveFolds,'至少两个预选样本外区间为正的条件未满足'],
    ['independent_blocks',blockCount>=policy.minIndependentBlocks,'不重叠16交易日持有区间锚点不足8个'],
    ['familywise',validation.adjustedPValue!==null&&validation.adjustedPValue<=policy.familywiseAlpha,'未通过固定16类目录的多重比较校正']
  ];
  const diagnostics=[];
  for(const [kind,stats,label]of [['fit',fit,'120日'],['recent',recent,'60日'],['validation',validation,'样本外']]){
    const prefix=kind==='fit'?'minTrain':kind==='recent'?'minRecent':'minValidation';
    for(const [field,suffix,title]of [['sampleCount','Samples','成熟触发样本'],['stockCount','Stocks','股票数'],['signalDayCount','Dates','触发日期数']])diagnostics.push({id:kind+'_'+field,label:label+title,actual:stats[field],threshold:policy[prefix+suffix],operator:'>=',passed:stats[field]>=policy[prefix+suffix]});
    for(const [field,title]of [['meanReturnPercent','平均净估算变化'],['meanExcessPercent','平均收盘区间超额']])diagnostics.push({id:kind+'_'+field,label:label+title,actual:stats[field],threshold:0,operator:'>',passed:stats[field]!==null&&stats[field]>0});
    diagnostics.push({id:kind+'_positiveRate',label:label+'正收益比例',actual:stats.positiveRate,threshold:.5,operator:'>=',passed:stats.positiveRate!==null&&stats.positiveRate>=.5});
  }
  diagnostics.push({id:'history',label:'历史交易日数',actual:dates.length,threshold:390,operator:'>=',passed:historyReady},
    {id:'positive_folds',label:'正样本外折数',actual:validation.positiveFoldCount,threshold:policy.minPositiveFolds,operator:'>=',passed:validation.positiveFoldCount>=policy.minPositiveFolds},
    {id:'independent_blocks',label:'不重叠持有区间锚点',actual:blockCount,threshold:policy.minIndependentBlocks,operator:'>=',passed:blockCount>=policy.minIndependentBlocks},
    {id:'familywise',label:'16类校正p值',actual:validation.adjustedPValue,threshold:policy.familywiseAlpha,operator:'<=',passed:validation.adjustedPValue!==null&&validation.adjustedPValue<=policy.familywiseAlpha});
  const reasons=checks.filter(([,passed])=>!passed).map(([, ,reason])=>reason),recommended=!reasons.length,insufficient=!adequate(fit,'train')||!adequate(recent,'recent')||!historyReady;
  return {version:entryValidationVersion,policy,fit,recent,validation,overlapExcludedCount,inputSampleCount:input.length,matureSampleCount:events.length,status:recommended?'effective':insufficient?'insufficient':positive(fit)&&positive(recent)?'watch':'inactive',recommended,reasons,diagnostics,failedChecks:checks.filter(([,passed])=>!passed).map(([id])=>id),
    method:{returnLabel:'T日严格突破C高点的研究参考价max(C高点,T开盘)至T后第3/5/10/15交易日收盘；非实际成交收益',drawdownLabel:'T日起至T后第15交易日的收盘路径最大回撤；固定失效位仅记录，不假定止损成交',excessLabel:'股票T收盘至T后第15交易日收盘的净变化，减指数相同收盘区间变化；与触发价估算收益分列，非同刻入场超额',costLabel:'各期限估算变化减往返成本及滑点0.30个百分点',validationLabel:'固定120日训练、15日隔离、20日一折、180日样本外；训练收益在验证开始前已成熟；同票按触发时点预占持有区间后再核验收益，不以未来退出结果挑选重叠事件；同触发日横截面合并，不重叠16日锚点检验并按16类校正',discoveryLabel:'历史研究按C收盘已知条件估算；实际来源读取与发现时间另存，不追认为当时可执行'}};
}
