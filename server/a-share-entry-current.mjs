import {entryPolicy} from './a-share-entry-bars.mjs';
import {evaluateEntryOutcome,entryValidationPolicy} from './a-share-entry-validation.mjs';

export const closeCandidateVersion='books.entry-current.2026-11-24.v1';
export const closeCandidatePolicy=Object.freeze({maxDistancePercent:2,formedWithinDays:entryValidationPolicy.formedWithinDays,horizon:entryValidationPolicy.horizon,closeEntryValidated:false});
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validBar=(bar,day)=>bar&&bar.date===day&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
const closeAt=day=>day+'T15:00:00+08:00';
const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;

function validWaitingWindow(setup,bars,dates,formationIndex,keyIndex,end){
  const formation=bars[formationIndex],key=bars[keyIndex],remaining=entryPolicy.triggerSessions-(end-keyIndex);
  if(setup.observedEvent!==null||remaining<1||setup.remainingSessions!==remaining||keyIndex-formationIndex>entryPolicy.confirmationSessions)return false;
  for(let index=formationIndex;index<=end;index++){
    const bar=bars[index];
    if(!validBar(bar,dates[index])||bar.high===bar.low||index>formationIndex&&above(formation.low,bar.low))return false;
    if(index>keyIndex&&above(bar.high,key.high))return false;
  }
  for(let index=formationIndex+1;index<=keyIndex;index++){
    const bar=bars[index],prior=bars.slice(index-entryPolicy.confirmationVolumeSessions,index);
    if(prior.length!==entryPolicy.confirmationVolumeSessions||prior.some((value,offset)=>!validBar(value,dates[index-entryPolicy.confirmationVolumeSessions+offset])))return false;
    const ma20=mean(bars.slice(index-19,index+1).map(value=>value.close)),volumeMean20=mean(prior.map(value=>value.volume));
    const confirmed=above(bar.close,formation.high)&&above(bar.close,bar.open)&&above(bar.close,ma20)&&!above(volumeMean20,bar.volume);
    if(confirmed)return index===keyIndex;
  }
  return false;
}

/** Current close-based research candidates, never a projection of historical chart markers. */
export function buildCloseCandidates({stock,bars,reference,dates,setups,strength,day,asOf,sourceFetchedAt,computedAt,nextSessionDay,entryEffectiveIds=[],shapeEffectiveIds=[]}={}){
  if(strength?.matched!==true||!/^\d{6}\.(SH|SZ)$/.test(stock?.code||'')||![bars,reference,dates,setups].every(Array.isArray)||!validDay(day)||!validDay(nextSessionDay)||nextSessionDay<=day)return [];
  const closedAt=Date.parse(closeAt(day)),computed=Date.parse(computedAt),fetched=Date.parse(sourceFetchedAt),sourceAsOf=Date.parse(asOf),activeUntil=nextSessionDay+'T09:30:00+08:00';
  if(![computed,fetched,sourceAsOf].every(Number.isFinite)||fetched<closedAt||sourceAsOf<closedAt||fetched<sourceAsOf||computed<Math.max(fetched,sourceAsOf)||computed>=Date.parse(activeUntil))return [];
  if(dates.length<entryPolicy.historyWindow||dates.at(-1)!==day||bars.length!==dates.length||reference.length!==dates.length||dates.some((date,index)=>!validDay(date)||date>day||index>0&&date<=dates[index-1]))return [];
  if(bars.some((bar,index)=>bar&&bar.date!==dates[index])||reference.some((bar,index)=>bar&&bar.date!==dates[index]))return [];
  const end=dates.length-1,start=end-entryPolicy.historyWindow+1;
  if(bars.slice(start).some((bar,index)=>!validBar(bar,dates[start+index]))||reference.slice(start).some((bar,index)=>!validBar(bar,dates[start+index])))return [];
  const current=bars[end];
  if(current.high===current.low)return [];
  const entryEffective=new Set(entryEffectiveIds),shapeEffective=new Set(shapeEffectiveIds),candidates=[];
  for(const setup of setups){
    const triggered=setup.replayStatus==='triggered_observation'&&setup.observedEvent?.date===day,waiting=setup.replayStatus==='waiting_trigger';
    if(!triggered&&!waiting)continue;
    const formationIndex=dates.indexOf(setup.formation?.date),keyIndex=dates.indexOf(setup.keyBar?.date),formationAgeSessions=end-formationIndex,known=Date.parse(setup.knownAt);
    if(formationIndex<20||formationAgeSessions<0||formationAgeSessions>=closeCandidatePolicy.formedWithinDays||keyIndex<=formationIndex||keyIndex>end||!Number.isFinite(known)||known>computed)continue;
    if(setup.id!==stock.code+':'+dates[formationIndex]||!Array.isArray(setup.patternIds)||!setup.patternIds.length||setup.patternIds.some(id=>typeof id!=='string'||!id)||new Set(setup.patternIds).size!==setup.patternIds.length)continue;
    const trigger=setup.trigger?.above,invalidation=setup.invalidation?.below;
    if(trigger!==bars[keyIndex].high||invalidation!==bars[formationIndex].low||!above(trigger,invalidation)||above(invalidation,current.low))continue;
    const distanceToTriggerPct=(current.close/trigger-1)*100;
    if(triggered){
      if(!above(current.close,trigger)||above(distanceToTriggerPct,closeCandidatePolicy.maxDistancePercent))continue;
      if(evaluateEntryOutcome({setup,bars,reference,dates,code:stock.code}).status!=='pending')continue;
    }else{
      if(above(current.close,trigger)||above(-distanceToTriggerPct,closeCandidatePolicy.maxDistancePercent)||!validWaitingWindow(setup,bars,dates,formationIndex,keyIndex,end))continue;
    }
    const eligiblePatternIds=setup.patternIds.filter(id=>entryEffective.has(id)&&shapeEffective.has(id)),qualified=eligiblePatternIds.length>0;
    const patternGatePassed=setup.patternIds.some(id=>shapeEffective.has(id)),entryGatePassed=setup.patternIds.some(id=>entryEffective.has(id));
    const reasons=[...(!patternGatePassed?['对应固定形态未通过原完整门槛']:[]),...(!entryGatePassed?['触发入场规则未通过独立滚动验证']:[]),...(patternGatePassed&&entryGatePassed&&!qualified?['没有同一形态同时通过原形态和独立入场验证']:[]),
      `收盘距离${closeCandidatePolicy.maxDistancePercent}%仅用于研究候选过滤，按收盘价入场的收益尚未独立验证`,'当日收盘后形成条件观察，下一交易日须重新核验，不代表实际成交'];
    candidates.push({code:stock.code,name:stock.name||stock.code,setupId:setup.id,patternIds:setup.patternIds.slice(),stage:triggered?'triggered_at_close':'waiting_breakout',day,asOf,
      formationDay:dates[formationIndex],keyBarDay:dates[keyIndex],formationAgeSessions,closePrice:current.close,trigger:{...setup.trigger},invalidation:{...setup.invalidation},distanceToTriggerPct,
      knownAfter:closeAt(day),sourceFetchedAt,actualDiscoveryAt:new Date(Math.max(computed,fetched,known)).toISOString(),nextSessionDay,activeUntil,remainingSessions:triggered?0:setup.remainingSessions,
      eligiblePatternIds,patternGatePassed,entryGatePassed,qualified,qualification:qualified?'qualified_watch':'research',reasons,requiresRecheck:true,closeEntryValidated:closeCandidatePolicy.closeEntryValidated,actualFillVerified:false,priceBasis:'qfq_research_reference'});
  }
  return candidates;
}
