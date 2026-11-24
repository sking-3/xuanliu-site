import {evaluateEntryOutcome,entryValidationPolicy} from './a-share-entry-validation.mjs';

export const entryMarkerVersion='books.entry-markers.2026-11-24.v1';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const validBar=(bar,day)=>bar&&bar.date===day&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
const mean=bars=>bars.reduce((sum,bar)=>sum+bar.close,0)/bars.length;
const closeAt=day=>day+'T15:00:00+08:00';
const order=['B','ADD','REDUCE','INVALID','S'];
const reasons={
  B:'关键K确认后首次有效突破；历史入场观察，非实际买入',
  S:'突破后第15个交易日收盘固定研究退出；非最佳卖点或实际卖出',
  ADD:'突破观察窗口内收盘重回MA5，收盘高于MA20且MA20不下降；波段加仓观察，未独立验证',
  REDUCE:'突破观察窗口内收盘跌破MA5；波段减仓观察，未独立验证',
  INVALID:'日线首次跌破固定形成K低点；条件失效，不代表止损成交'
};

/** Aligned, closed daily bars only. B is rechecked at T, never selected by later returns. */
export function buildEntryMarkers({setups,bars,reference,dates}={}){
  if(![setups,bars,reference,dates].every(Array.isArray))throw Error('图表标记缺少关键K、日线或交易日历');
  const positions=new Map(dates.map((day,index)=>[day,index])),markersById=new Map();
  function add(setup,index,kind,referencePrice,knownAfter){
    const day=dates[index],id=day+':'+kind;
    const evidence={setupId:setup.id,patternIds:setup.patternIds.slice().sort(),status:setup.status||setup.replayStatus,replayStatus:setup.replayStatus,
      knownAfter,actualDiscoveryAt:setup.knownAt||null,lateDiscovery:setup.lateDiscovery===true,referencePrice,
      independentlyValidated:false,actualFillVerified:false};
    let marker=markersById.get(id);
    if(!marker){
      marker={id,day,kind,state:'research',reason:reasons[kind],knownAfter,setupIds:[],patternIds:[],evidence:[],referencePrice,
        independentlyValidated:false,actualFillVerified:false,recommended:false};
      markersById.set(id,marker);
    }
    if(marker.setupIds.includes(setup.id))return;
    marker.setupIds.push(setup.id);marker.setupIds.sort();
    marker.patternIds=[...new Set([...marker.patternIds,...setup.patternIds])].sort();
    marker.evidence.push(evidence);marker.evidence.sort((a,b)=>a.setupId.localeCompare(b.setupId));
    if(Date.parse(knownAfter)>Date.parse(marker.knownAfter))marker.knownAfter=knownAfter;
    if(marker.referencePrice!==referencePrice)marker.referencePrice=null;
  }
  for(const setup of setups){
    if(setup.replayStatus!=='triggered_observation')continue;
    const triggerIndex=positions.get(setup.observedEvent?.date);
    if(triggerIndex===undefined)continue;
    if(typeof setup.id!=='string'||!Array.isArray(setup.patternIds))throw Error('图表标记缺少关键K身份');
    const code=setup.id.split(':')[0],prefixEnd=triggerIndex+1;
    const atTrigger=evaluateEntryOutcome({setup,bars:bars.slice(0,prefixEnd),reference:reference.slice(0,prefixEnd),dates:dates.slice(0,prefixEnd),code});
    if(atTrigger.status!=='pending')continue;
    const trigger=bars[triggerIndex],entryPrice=Math.max(setup.trigger.above,trigger.open),exitIndex=triggerIndex+entryValidationPolicy.horizon;
    add(setup,triggerIndex,'B',entryPrice,closeAt(dates[triggerIndex]));
    for(let index=triggerIndex+1;index<=Math.min(exitIndex,dates.length-1);index++){
      const bar=bars[index];
      if(!validBar(bar,dates[index])||!validBar(reference[index],dates[index]))break;
      if(above(setup.invalidation.below,bar.low)){
        add(setup,index,'INVALID',setup.invalidation.below,closeAt(dates[index]));break;
      }
      if(index===exitIndex||bar.high===bar.low||index<20)continue;
      const window=bars.slice(index-20,index+1);
      if(window.length!==21||window.some((value,offset)=>!validBar(value,dates[index-20+offset])))continue;
      const ma5=mean(window.slice(-5)),previousMa5=mean(window.slice(-6,-1)),ma20=mean(window.slice(-20)),previousMa20=mean(window.slice(0,20)),previous=window.at(-2);
      if(above(bar.close,ma5)&&!above(previous.close,previousMa5)&&above(bar.close,ma20)&&!above(previousMa20,ma20))add(setup,index,'ADD',bar.close,closeAt(dates[index]));
      if(above(ma5,bar.close)&&!above(previousMa5,previous.close))add(setup,index,'REDUCE',bar.close,closeAt(dates[index]));
    }
    // X ends +/- observations, but does not rewrite the existing fixed-horizon study.
    const outcome=evaluateEntryOutcome({setup,bars,reference,dates,code});
    if(outcome.status==='ready')add(setup,outcome.exitIndex,'S',bars[outcome.exitIndex].close,closeAt(dates[outcome.exitIndex]));
  }
  const markers=[...markersById.values()].sort((a,b)=>a.day.localeCompare(b.day)||order.indexOf(a.kind)-order.indexOf(b.kind));
  const byDay=new Map();
  for(const marker of markers){
    if(!byDay.has(marker.day))byDay.set(marker.day,{day:marker.day,markerIds:[],kinds:[],conflict:false});
    const group=byDay.get(marker.day);group.markerIds.push(marker.id);group.kinds.push(marker.kind);
    group.conflict=group.kinds.includes('B')&&group.kinds.includes('S');
  }
  return {version:entryMarkerVersion,markers,groups:[...byDay.values()]};
}
