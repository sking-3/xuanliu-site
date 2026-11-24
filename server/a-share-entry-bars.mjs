export const entryPolicyVersion='books.entry-bars.2026-11-24.v1';
export const entryPolicy=Object.freeze({lookback:20,historyWindow:61,formationCooldownSessions:15,confirmationSessions:3,triggerSessions:3,maxOpeningChasePercent:2,confirmationMa:20,confirmationVolumeSessions:20,entryOutcomeValidated:false});

const patternVersion='books.trend-patterns.2026-11-22.v2';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validBar=bar=>bar&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close)&&bar.high>=bar.low;
const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
const mean=values=>values.reduce((total,value)=>total+value,0)/values.length;
const closeAt=day=>day+'T15:00:00+08:00';
const openAt=day=>day+'T09:30:00+08:00';
const describe=bar=>({date:bar.date,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume});
const waiting=new Set(['waiting_confirmation','waiting_trigger']);

function confirmationAt(bars,index,formation){
  const current=bars[index],prior=bars.slice(index-entryPolicy.confirmationVolumeSessions,index);
  if(!validBar(current)||prior.length!==20||prior.some(bar=>!validBar(bar)))return null;
  const ma20=mean(bars.slice(index-19,index+1).map(bar=>bar.close)),volumeMean20=mean(prior.map(bar=>bar.volume));
  return {matched:above(current.close,formation.high)&&above(current.close,current.open)&&above(current.close,ma20)&&!above(volumeMean20,current.volume),ma20,volumeMean20,volumeRatio:current.volume/volumeMean20};
}

function replaySetup({stock,bars,dates,index,ids,end}){
  const formation=bars[index],setup={id:stock.code+':'+formation.date,patternIds:ids,formation:describe(formation),confirmation:null,keyBar:null,
    conditionKnownAt:null,trigger:null,invalidation:{below:formation.low,priceBasis:'qfq_research_reference',rule:'严格跌破形成K最低价；参考位固定，不事后下移'},
    replayStatus:'waiting_confirmation',observedEvent:null,reason:'等待形成K之后3个交易日内的收盘确认',remainingSessions:Math.max(0,entryPolicy.confirmationSessions-(end-index))};
  const finish=(status,reason,eventIndex)=>{
    setup.replayStatus=status;setup.reason=reason;setup.remainingSessions=0;
    if(eventIndex!==undefined)setup.observedEvent={date:dates[eventIndex],knownAfter:closeAt(dates[eventIndex])};
    return setup;
  };
  if(formation.high===formation.low)return finish('unexecutable','形成K为一字价日，未当作可成交入场证据',index);
  let confirmed=-1;
  for(let i=index+1;i<=Math.min(end,index+entryPolicy.confirmationSessions);i++){
    const bar=bars[i];
    if(!validBar(bar))return finish('unavailable','确认窗口存在停牌、无成交或缺日线；未跳过缺口',i);
    if(above(formation.low,bar.low))return finish('invalidated','确认前已跌破形成K最低价',i);
    if(bar.high===bar.low)return finish('unexecutable','确认窗口出现一字价日，未假设可确认或可成交',i);
    const evidence=confirmationAt(bars,i,formation);
    if(evidence?.matched){
      confirmed=i;setup.confirmation={...describe(bar),ma20:evidence.ma20,volumeMean20:evidence.volumeMean20,volumeRatio:evidence.volumeRatio};
      setup.keyBar={...describe(bar),kind:'close_confirmation',knownAfter:closeAt(bar.date)};setup.conditionKnownAt=closeAt(bar.date);
      setup.trigger={above:bar.high,priceBasis:'qfq_research_reference',validFrom:dates[i+1]||null,expiresOn:dates[i+entryPolicy.triggerSessions]||null,validForSessions:entryPolicy.triggerSessions};
      break;
    }
  }
  if(confirmed===-1){
    if(end-index>=entryPolicy.confirmationSessions)return finish('expired','3个交易日内未满足收盘越形成K高点、阳线、MA20上方及量能确认');
    return setup;
  }
  setup.replayStatus='waiting_trigger';setup.reason='关键K已收盘确认；仅从下一交易日起观察严格突破关键K高点';
  setup.remainingSessions=Math.max(0,entryPolicy.triggerSessions-(end-confirmed));
  for(let i=confirmed+1;i<=Math.min(end,confirmed+entryPolicy.triggerSessions);i++){
    const bar=bars[i],level=setup.trigger.above;
    if(!validBar(bar))return finish('unavailable','触发窗口存在停牌、无成交或缺日线；未跳过缺口',i);
    if(above(formation.low,bar.open))return finish('invalidated','开盘已经低于固定失效参考位',i);
    if(above((bar.open/level-1)*100,entryPolicy.maxOpeningChasePercent))return finish('chased','开盘高于触发参考位超过2%，按固定追高限制排除',i);
    if(bar.high===bar.low)return finish('unexecutable','触发窗口为一字价日，未假设可以买入',i);
    const touched=above(bar.high,level),invalid=above(formation.low,bar.low);
    if(touched&&invalid)return finish('ambiguous','同日同时越过触发位和失效位；日线不能核实执行顺序，不假设成交',i);
    if(invalid)return finish('invalidated','触发前跌破固定失效参考位',i);
    if(touched){
      finish('triggered_observation','日线已观察到越过触发参考位；不代表实际成交或已验证买点',i);
      setup.observedEvent.mode=above(bar.open,level)?'opening_gap':'intraday_range_only';
      setup.observedEvent.exactIntradayTimeKnown=setup.observedEvent.mode==='opening_gap';
      setup.observedEvent.knownAfter=setup.observedEvent.exactIntradayTimeKnown?openAt(bar.date):closeAt(bar.date);
      return setup;
    }
  }
  if(end-confirmed>=entryPolicy.triggerSessions)return finish('expired','关键K确认后3个交易日内没有严格突破其高点');
  return setup;
}

/** Pure research replay. Every classification receives only a closed prefix, never future candles. */
export function analyzeEntryBars({stock,bars,calendar,patterns,matches,day,asOf,sourceId,generation,sourceAdjustment='qfq',sourceFetchedAt=null,policyKnownAt=null,nextSessionDay=null,effectivePatternIds=[],now=Date.now}={}){
  const checkedAt=now();
  if(!finite(checkedAt))throw Error('关键K检查时间无效');
  if(typeof stock?.code!=='string'||!/^\d{6}\.(SH|SZ)$/.test(stock.code)||!validDay(day)||typeof sourceId!=='string'||!sourceId||typeof generation!=='string'||!generation||!finite(Date.parse(asOf))||Date.parse(asOf)>checkedAt||Date.parse(asOf)<Date.parse(closeAt(day)))throw Error('关键K分析须绑定已收盘日期、股票、来源与完整批次');
  if(sourceAdjustment!=='qfq')throw Error('关键K研究参考价必须使用明确的前复权口径');
  if(patterns?.version!==patternVersion||!Array.isArray(patterns.definitions)||patterns.definitions.length!==16||typeof (matches||patterns.classify)!=='function')throw Error('关键K必须沿用已确认的16类固定形态目录');
  if(!Array.isArray(calendar)||!calendar.length||!Array.isArray(bars)||bars.length>640)throw Error('关键K缺少有界历史日线或指数交易日历');
  const dates=calendar.map(bar=>typeof bar==='string'?bar:bar.date);
  if(dates.some((date,i)=>!validDay(date)||date>day||i&&date<=dates[i-1])||dates.at(-1)!==day)throw Error('关键K日历须为截至数据日的实际已知交易日，不推断未来工作日');
  if(bars.some((bar,i)=>!validDay(bar?.date)||bar.date>day||i&&bar.date<=bars[i-1].date))throw Error('关键K原始日线日期重复、逆序或包含未来数据');
  for(const [value,label]of [[sourceFetchedAt,'来源读取'],[policyKnownAt,'规则生效']])if(value!==null&&(!finite(Date.parse(value))||Date.parse(value)>checkedAt))throw Error(label+'时间无效或晚于检查时间');
  if(nextSessionDay!==null&&(!validDay(nextSessionDay)||nextSessionDay<=day))throw Error('下一交易日必须由已核验日历明确提供，不能早于数据日');
  const allowed=new Set(patterns.definitions.map(item=>item.id));
  if(!Array.isArray(effectivePatternIds)||effectivePatternIds.some(id=>!allowed.has(id)))throw Error('有效形态身份与固定目录不符');
  const byDay=new Map(bars.map(bar=>[bar.date,bar])),aligned=dates.map(date=>byDay.get(date)||null),setups=[],lastFormation=new Map();
  const validRange=index=>index>=60&&aligned.slice(index-60,index+1).every(validBar);
  let previous=new Set(),previousKnown=false;
  for(let index=60;index<dates.length;index++){
    const known=validRange(index);
    if(!known){previous=new Set();previousKnown=false;continue;}
    const window=aligned.slice(index-60,index+1),input={bars:window,calendar:window,day:dates[index],lookback:20};
    const classified=matches?matches(input):patterns.classify(input),ids=Array.isArray(classified)?classified:classified?.status==='ready'?classified.labels.map(item=>item.id):null;
    if(!ids||ids.some(id=>!allowed.has(id))||new Set(ids).size!==ids.length)throw Error('关键K形态分类返回未知、重复或无效身份');
    const current=new Set(ids),formed=previousKnown?ids.filter(id=>!previous.has(id)&&index-(lastFormation.get(id)??-Infinity)>=entryPolicy.formationCooldownSessions):[];
    if(formed.length){
      for(const id of formed)lastFormation.set(id,index);
      setups.push(replaySetup({stock,bars:aligned,dates,index,ids:formed,end:dates.length-1}));
    }
    previous=current;previousKnown=true;
  }
  const checkedStamp=new Date(checkedAt).toISOString(),effective=new Set(effectivePatternIds);
  for(const setup of setups){
    const firstTarget=setup.trigger?.validFrom||setup.confirmation&&nextSessionDay,firstOpen=firstTarget?openAt(firstTarget):null;
    const observationKnownAt=setup.conditionKnownAt||closeAt(setup.formation.date);
    const knownAt=sourceFetchedAt&&policyKnownAt?new Date(Math.max(checkedAt,Date.parse(observationKnownAt),Date.parse(sourceFetchedAt),Date.parse(policyKnownAt))).toISOString():null;
    const late=Boolean(firstOpen&&knownAt&&Date.parse(knownAt)>Date.parse(firstOpen));
    setup.detectedAt=checkedStamp;setup.knownAt=knownAt;setup.firstTargetOpenAt=firstOpen;setup.lateDiscovery=late;
    setup.status=late?'late_discovery':setup.replayStatus;
    setup.mode='historical_research_replay';setup.recommended=false;setup.entryOutcomeValidated=false;
    setup.patternGatePassed=setup.patternIds.some(id=>effective.has(id));
    setup.recommendationReasons=[...(!setup.patternGatePassed?['对应固定形态当前未通过原有完整门槛']:[]),'本触发规则尚未独立完成收益与样本外验证'];
    if(!knownAt)setup.recommendationReasons.push('来源读取或规则生效时间未知，不追认已发生的入场');
    if(late)setup.recommendationReasons.push('实际发现晚于首个目标开盘；仅保留回放及未来剩余窗口条件观察');
    const pending=waiting.has(setup.replayStatus)&&setup.remainingSessions>0;
    const nextOpen=nextSessionDay?Date.parse(openAt(nextSessionDay)):null;
    const watchStatus=!pending?'not_active':!knownAt?'knowledge_time_unknown':!nextSessionDay?'next_session_unknown':nextOpen<=checkedAt?'requires_fresh_data':'future_condition_watch';
    setup.monitoring={status:watchStatus,nextSessionDay:pending?nextSessionDay:null,remainingSessions:pending?setup.remainingSessions:0,requiresFreshData:true};
    if(setup.trigger&&!setup.trigger.validFrom&&nextSessionDay)setup.trigger.validFrom=nextSessionDay;
  }
  const current=setups.filter(setup=>waiting.has(setup.replayStatus)&&setup.remainingSessions>0);
  return {schema:'books.a-share.entry-bars.v1',entryPolicyVersion,patternVersion,sourceId,generation,day,asOf,checkedAt:checkedStamp,stock:{code:stock.code,name:stock.name||stock.code},
    priceBasis:'前复权研究参考价，非实际委托报价',policy:entryPolicy,entryOutcomeValidated:false,recommended:false,
    sourceFetchedAt,policyKnownAt,coverage:{calendarSessions:dates.length,sourceBars:bars.length,currentDayValid:Boolean(validBar(aligned.at(-1)))},
    summary:{setupCount:setups.length,confirmedCount:setups.filter(setup=>setup.keyBar).length,currentWatchCount:current.length,recommendedCount:0,triggeredObservations:setups.filter(setup=>setup.replayStatus==='triggered_observation').length},
    setups,current,
    method:{formation:'固定形态首次成立，沿用15交易日同形态形成间隔',confirmation:'形成K后最多3交易日：收盘严格越过形成K高点、阳线、MA20上方、量不低于此前20日均量',trigger:'确认收盘之后，从下一交易日起最多3交易日严格越过关键K高点；开盘超触发位2%排除',invalidation:'形成K最低价固定作为失效研究参考位；不下移',timing:'所有确认只用当根及以前已收盘日线；日内精确触发时间和实际成交未知',outcomes:'未计算本触发规则收益，不引用原次日开盘形态收益作为本规则回报'}};
}
