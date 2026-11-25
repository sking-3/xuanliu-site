'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{root.BooksStockDesk=api;if(root.document)root.BooksStockDeskApp=api.mount(root.document);}
})(globalThis,()=>{
 const schema='books.a-share.desk.v1',reportSchema='books.a-share.opportunity-workbench.v1',version='books.a-share.opportunity-tracking.2026-11-25.v1';
 const phases=['close','a14'],states={near_B:'接近B',triggered_B:'B触发',watch:'观察',expired:'已过期'};
 const phaseLabels={close:'收盘',a14:'14:00'},strategies=['all','trend','short-term','institution','t-plan'];
 const contextKinds=['trend-pullback','trend-continuation','range-support','support-reclaim'];
 const finite=Number.isFinite,time=value=>typeof value==='string'&&finite(Date.parse(value));
 const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&time(value+'T00:00:00Z')&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
 const binding=(a,b)=>['generation','sourceId','day','asOf'].every(key=>a[key]===b[key]);
 const formatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const clockFormatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const stamp=value=>time(value)?formatter.format(new Date(value))+' 北京':'未提供';
 const number=value=>finite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:4}):'—';
 const percent=value=>finite(value)?(value>0?'+':'')+value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
 const activeAt=(row,now)=>row.active!==false&&row.displayState!=='expired'&&Date.parse(row.activeUntil)>now;
 const stateLabel=row=>states[row.state]+(row.qualified?' · 验证通过':row.state==='watch'?'':' · 未验证');
 function datedState(row){
  const label=row.familyId==='close-limitup-watch'||row.research?.plan?.modelState==='limit_up_next_session_recheck'?'收盘近涨停（非当前买点）':row.state==='triggered_B'?'当日价格触发':row.state==='near_B'?'尚未突破 · 接近触发':finite(row.reference.trigger)?'尚未突破':'条件观察';
  return '截至'+row.day+' '+phaseLabels[row.phase]+'：'+label+(row.qualified?' · 验证通过':row.state==='watch'?'':' · 未通过验证');
 }
 function referenceText(row){
  const values=['参考价 '+number(row.reference.close)];
  if(finite(row.reference.trigger))values.push('触发 > '+number(row.reference.trigger));
  if(finite(row.reference.invalidation))values.push('失效 < '+number(row.reference.invalidation));
  return values.join(' · ');
 }
 function positionText(row){
  const position=row.research?.position;if(!position)return '个股位置：本时点资料暂缺';
  const values=[],metrics=position.metrics||{},strength=position.strength||{},limit=position.limitUp||{};
  if(finite(strength.return20Percentile))values.push('20日强于 '+number(strength.return20Percentile)+'%（'+number(strength.return20Denominator)+'只）');
  if(finite(metrics.rangePosition60Percent))values.push('60日区间位置 '+number(metrics.rangePosition60Percent)+'%');
  const bands={low:'低位',middle:'中位',mid:'中位',high:'高位',lower:'低位',upper:'高位'};
  if(bands[row.research.analogue?.positionBand])values.push(bands[row.research.analogue.positionBand]);
  if(finite(metrics.return5))values.push('5日 '+percent(metrics.return5));
  if(finite(metrics.ma20Deviation))values.push('距MA20 '+percent(metrics.ma20Deviation));
  if(limit.status==='ready'&&limit.atLimit===true&&Number.isInteger(limit.consecutiveCount))values.push('连续近涨停 '+limit.consecutiveCount+'日'+(limit.onePrice?'（一字价）':''));
  else if(limit.status==='unknown')values.push('近涨停连数未核验');
  return values.length?values.join(' · '):'个股位置：本时点资料暂缺';
 }
 function marketPositionText(report){
  const position=report?.marketContext?.position;if(!position)return '市场位置：本时点资料暂缺';
  const labels={bullish_trend:'上行',bearish_trend:'下行',mixed_or_range:'震荡',unknown:'资料不足'},breadth=position.breadth||{},values=['沪深300 '+(labels[position.benchmark?.regime]||'资料不足')];
  if(Number.isInteger(breadth.validPairs)&&breadth.validPairs>0)values.push('主板 涨'+number(breadth.advancers)+' / 跌'+number(breadth.decliners)+' / 平'+number(breadth.flat)+'（可比'+number(breadth.validPairs)+'只）');
  if(Number.isInteger(breadth.ma20Denominator)&&breadth.ma20Denominator>0)values.push('MA20上方 '+number(breadth.aboveMa20Count)+'/'+number(breadth.ma20Denominator)+'（'+number(breadth.aboveMa20Percent)+'%）');
  if(Number.isInteger(position.limitUpLike?.count))values.push('收盘近涨停 '+number(position.limitUpLike.count)+'只');
  if(position.coverage)values.push('覆盖 '+number(position.coverage.ready)+'/'+number(position.coverage.total));
  return values.join(' · ');
 }
 function validateResearch(row){
  const plan=row.research?.plan;
  if(plan){
   const zone=value=>value===null||value&&finite(value.low)&&finite(value.high)&&value.low>0&&value.high>=value.low;
   if(!contextKinds.includes(plan.kind)||typeof plan.label!=='string'||plan.signalDay!==row.day||!['next_session_watch','existing_position_T_watch','countertrend_watch','limit_up_next_session_recheck'].includes(plan.modelState)||!zone(plan.buyZone)||!zone(plan.reduceZone)||['trigger','invalidation'].some(key=>plan[key]!==null&&(!finite(plan[key])||plan[key]<=0))||typeof plan.holdingRequired!=='boolean'||plan.qualified!==false||plan.actualFillVerified!==false||!Array.isArray(plan.reason)||plan.reason.some(value=>typeof value!=='string'))throw Error('条件计划的日期、价位或观察资格不完整，保留上次结果。');
  }
  const analogue=row.research?.analogue;if(!analogue)return;
  if(analogue.method!=='historical_close_path_not_forecast_or_trade_return'||!analogue.horizons||typeof analogue.horizons!=='object')throw Error('同类历史路径口径不完整，保留上次结果。');
  for(const stats of [...Object.values(analogue.horizons),analogue.path].filter(Boolean)){
   if(['sampleCount','stockCount','signalDayCount'].some(key=>!Number.isInteger(stats[key])||stats[key]<0)||typeof stats.adequate!=='boolean'||!Array.isArray(stats.reasons))throw Error('同类历史样本数不完整，保留上次结果。');
   for(const key of ['medianReturnPercent','meanReturnPercent','positiveRate','meanDrawdownPercent','worstDrawdownPercent'])if(stats[key]!==undefined&&stats[key]!==null&&!finite(stats[key]))throw Error('同类历史收益或回撤不是有效数值，保留上次结果。');
  }
  if(analogue.path)for(const key of ['median','p25','p75']){const values=analogue.path[key];if(values!==null&&(!Array.isArray(values)||values.length!==16||values.some(value=>value!==null&&!finite(value))))throw Error('同类历史路径必须对应完整的15个后续交易日，保留上次结果。');}
 }
 function validateChart(path,row,report,window){
  if(typeof path!=='string'||!path.startsWith('/api/a-share-daily/'))return false;
  const url=new URL(path,'https://books.invalid');
  if(row.phase==='a14')return url.origin==='https://books.invalid'&&!url.hash&&url.pathname==='/api/a-share-daily/a14-chart'&&url.searchParams.get('day')===row.day&&url.searchParams.get('code')===row.code&&url.searchParams.get('window')===String(window)&&[...url.searchParams.keys()].length===3;
  if(url.pathname==='/api/a-share-daily/context-chart')return url.origin==='https://books.invalid'&&!url.hash&&row.phase==='close'&&row.familyId==='daily-setup-watch'&&row.qualified===false&&['watch','near_B'].includes(row.state)&&contextKinds.includes(row.research?.plan?.kind)&&row.ruleIds.length===1&&row.ruleIds[0]===row.research.plan.kind&&url.searchParams.get('generation')===report.generation&&url.searchParams.get('code')===row.code&&url.searchParams.get('kind')===row.research.plan.kind&&url.searchParams.get('window')===String(window)&&[...url.searchParams.keys()].length===4;
  if(url.pathname==='/api/a-share-daily/workbench-chart')return url.origin==='https://books.invalid'&&!url.hash&&row.phase==='close'&&row.state==='watch'&&row.qualified===false&&row.reference.trigger===null&&row.reference.invalidation===null&&['close-limitup-watch','institution-disclosure-watch'].includes(row.familyId)&&url.searchParams.get('generation')===report.generation&&url.searchParams.get('code')===row.code&&url.searchParams.get('window')===String(window)&&[...url.searchParams.keys()].length===3;
  return url.origin==='https://books.invalid'&&!url.hash&&['/api/a-share-daily/entry-current-chart','/api/a-share-daily/viprasol-current-chart'].includes(url.pathname)&&url.searchParams.get('generation')===report.generation&&url.searchParams.get('code')===row.code&&url.searchParams.get('window')===String(window);
 }
 function validateObservation(value,horizon,report,firstSeenAt,reportPhase){
  if(!value||value.horizon!==horizon||!['pending','ready','unavailable','not_observable'].includes(value.status)||!time(value.checkedAt)||typeof value.reason!=='string'||value.targetDay!==null&&!day(value.targetDay)||value.status==='ready'&&(!finite(value.returnPercent)||!day(value.targetDay))||value.status!=='ready'&&value.returnPercent!==null)throw Error('后续观察记录不完整，保留上次结果。');
  const observedDay=reportPhase==='a14'&&report.observationDay?report.observationDay:report.day;
  if(value.status==='ready'&&value.targetDay>observedDay)throw Error('后续观察尚未满交易日，不能显示收益。');
  if(value.status==='ready'&&reportPhase==='a14'&&(!day(report.observationDay)||typeof report.observationGeneration!=='string'||!report.observationGeneration||!time(report.observationAsOf)||typeof value.generation!=='string'||!value.generation||value.sourceId!==report.historySourceId||!time(value.asOf)||!time(value.sourceFetchedAt)||Date.parse(value.asOf)>Date.parse(report.observationAsOf)||Date.parse(value.asOf)<Date.parse(value.targetDay+'T15:00:00+08:00')||Date.parse(value.sourceFetchedAt)<Date.parse(value.asOf)||Date.parse(value.checkedAt)<Date.parse(value.sourceFetchedAt)))throw Error('14:00后续观察的独立日线来源或时点不一致。');
  if(value.status==='ready'&&time(firstSeenAt)&&Date.parse(value.targetDay+'T15:00:00+08:00')<=Date.parse(firstSeenAt))throw Error('后续观察早于首次发现，不能显示为入选后收益。');
 }
 function validateRow(row,report,phase,current=true,reportPhase=phase){
  if(typeof row?.id!=='string'||!row.id||!/^\d{6}\.(SH|SZ)$/.test(row.code)||typeof row.name!=='string'||row.phase!==phase||!Object.hasOwn(states,row.state)||row.state==='expired'||typeof row.qualified!=='boolean'||!day(row.anchorDay)||!Array.isArray(row.ruleIds)||!row.ruleIds.length||row.ruleIds.some(id=>typeof id!=='string')||typeof row.familyId!=='string'||typeof row.ruleVersion!=='string'||typeof row.setupId!=='string'||current&&!time(row.firstSeenAt)||!['asOf','sourceFetchedAt','actualDiscoveryAt','conditionKnownAfter','activeUntil'].every(key=>time(row[key]))||!finite(row.reference?.close)||row.reference.close<=0||['trigger','invalidation'].some(key=>row.reference[key]!==null&&!finite(row.reference[key]))||!Array.isArray(row.reasons)||row.reasons.some(reason=>typeof reason!=='string'))throw Error('候选身份、来源时点或条件不完整，保留上次结果。');
  validateResearch(row);
  if(current&&phase==='close'&&!binding(row,report))throw Error('候选与选股批次不一致，保留上次结果。');
  if(current&&phase==='a14'){
   const source=Date.parse(row.asOf),quoted=Date.parse(row.quoteSourceAt),received=Date.parse(row.receivedAt),from=Date.parse(row.day+'T14:00:00+08:00'),until=Date.parse(row.day+'T14:10:00+08:00');
   if(!['generation','sourceId','day','historyGeneration','historySourceId'].every(key=>row[key]===report[key])||typeof report.historyGeneration!=='string'||!report.historyGeneration||!finite(quoted)||!finite(received)||quoted!==source||row.receivedAt!==row.sourceFetchedAt||source<Date.parse(report.asOf)||quoted<from||quoted>until||received<quoted||received>until||received-quoted>120000||received>Date.parse(report.computedAt)||row.qualified!==false)throw Error('14:00报价时段、读取时间或日线依据不一致，保留上次结果。');
  }
  for(const window of [60,120])if(row.chartUrls?.[window]&&!validateChart(row.chartUrls[window],row,row,window))throw Error('日K不属于当前候选批次，保留上次结果。');
  for(const value of row.research?.regimePreference||[]){
   if(!row.ruleIds.includes(value.patternId)||typeof value.label!=='string'||!['bull','bear','sideways'].includes(value.regime)||value.eligibleForSelection!==false||typeof value.adequate!=='boolean'||['sampleCount','stockCount','signalDayCount'].some(key=>!Number.isInteger(value[key])||value[key]<0)||['meanReturnPercent','worstDrawdownPercent'].some(key=>value[key]!==null&&!finite(value[key]))||current&&(report.marketContext?.preferences?.horizon!==3||report.marketContext.preferences.regime!==value.regime))throw Error('同市场状态的3日观察样本或口径不一致。');
  }
  for(const [key,value]of Object.entries(row.observations||{})){if(![1,2,3].includes(Number(key)))throw Error('后续观察周期不符。');validateObservation(value,Number(key),report,row.firstSeenAt,reportPhase);}
 }
 function validateReport(report,phase,previous){
  if(report?.schema!==reportSchema||report.version!==version||report.completed!==true||report.datasetBound!==true||typeof report.generation!=='string'||!report.generation||typeof report.sourceId!=='string'||!report.sourceId||!day(report.day)||!time(report.asOf)||!time(report.computedAt)||!Array.isArray(report.current)||!Array.isArray(report.tracks))throw Error('选股批次尚未完整，保留上次结果。');
  if(previous&&(report.day<previous.day||Date.parse(report.asOf)<Date.parse(previous.asOf)||Date.parse(report.computedAt)<Date.parse(previous.computedAt)))throw Error(phaseLabels[phase]+'数据时间回退，保留上次结果。');
  if(phase==='a14'&&previous?.observationDay&&(!day(report.observationDay)||report.observationDay<previous.observationDay||!time(report.observationAsOf)||Date.parse(report.observationAsOf)<Date.parse(previous.observationAsOf)))throw Error('14:00后续观察截止时间回退，保留上次结果。');
  const ids=new Set();for(const row of report.current){validateRow(row,report,phase);if(ids.has(row.id))throw Error('候选记录重复。');ids.add(row.id);}
  const tracks=new Set();for(const track of report.tracks){
   if(!phases.includes(track.original?.phase)||phase==='a14'&&track.original.phase!=='a14')throw Error('跟踪记录时点不一致。');
   validateRow(track.original,report,track.original.phase,false,phase);
   if(track.id!==track.original.id||tracks.has(track.id)||!time(track.firstSeenAt)||!track.observations)throw Error('跟踪记录身份不一致。');
   for(const [key,value]of Object.entries(track.observations)){if(![1,2,3].includes(Number(key)))throw Error('跟踪周期不符。');validateObservation(value,Number(key),report,track.firstSeenAt,phase);}
   tracks.add(track.id);
  }
  return report;
 }
 function validate(value,previous={}){
  if(value?.schema!==schema||!value.institutions||typeof value.institutions.status!=='string'||!value.institutions.byCode||typeof value.institutions.byCode!=='object'||Array.isArray(value.institutions.byCode))throw Error('选股工作台响应不完整，保留上次结果。');
  for(const phase of phases){const slot=value[phase];if(!slot||!(phase==='close'?['ready','unavailable']:['ready','unavailable','held','not_collected']).includes(slot.status)||slot.status==='ready'&&!slot.data||slot.data===undefined)throw Error('选股时点状态不完整，保留上次结果。');if(slot.data)validateReport(slot.data,phase,previous[phase]);}
  if(value.a14.data?.observationGeneration&&value.close.data&&![['observationDay','day'],['observationGeneration','generation'],['observationAsOf','asOf']].every(([key,source])=>value.a14.data[key]===value.close.data[source]))throw Error('14:00后续观察与独立收盘批次不一致。');
  for(const [code,events]of Object.entries(value.institutions.byCode)){
   if(!/^\d{6}\.(SH|SZ)$/.test(code)||!Array.isArray(events))throw Error('机构披露记录不完整。');
   for(const event of events){
    const precision=event?.precision==='day'&&event.publishedAt===null||event?.precision==='minute'&&time(event.publishedAt);
    if(typeof event?.id!=='string'||event.code!==code||typeof event.title!=='string'||!event.title||typeof event.url!=='string'||!/^https?:\/\//.test(event.url)||!day(event.sourceDate)||!precision||!time(event.firstSeenAt)||!['research_visit','shareholder_increase','investment_fund_partnership','shareholder_decrease','fund_holding','shareholder_holding','repurchase','employee_share_plan','other'].includes(event.kind)||typeof event.summary!=='string')throw Error('机构披露日期、类型或原始出处不完整。');
   }
  }
  return value;
 }
 const eventsFor=(institutions,code)=>institutions?.byCode?.[code]||[];
 const institutionKinds=['research_visit','fund_holding','investment_fund_partnership'];
 const hasInstitutionEvidence=(institutions,code)=>eventsFor(institutions,code).some(event=>institutionKinds.includes(event.kind));
 function matches(row,filters,institutions){
  const strategy=row.strategy||'trend';
  if(filters.strategy==='t-plan'&&row.research?.plan?.holdingRequired!==true)return false;
  if(filters.strategy==='institution'&&!hasInstitutionEvidence(institutions,row.code))return false;
  if(!['all','institution','t-plan'].includes(filters.strategy)&&strategy!==filters.strategy)return false;
  if(filters.shape!=='all'&&!row.ruleIds.some(id=>row.familyId+':'+id===filters.shape))return false;
  return !filters.query||(row.code+' '+row.name).toLowerCase().includes(filters.query.trim().toLowerCase());
 }
 const selectRows=(report,filters,institutions,now=Date.now())=>(report?.current||[]).filter(row=>activeAt(row,now)&&matches(row,filters,institutions));
 const selectTracks=(report,filters,institutions)=>(report?.tracks||[]).filter(track=>(!filters.phase||track.original.phase===filters.phase)&&matches(track.original,filters,institutions));
 function mergeTracking(reports,phase){
  const merged=new Map((reports.a14?.tracks||[]).map(track=>[track.id,track]));
  for(const track of reports.close?.tracks||[]){const frozen=merged.get(track.id);merged.set(track.id,frozen?{...frozen,observations:{...frozen.observations,...track.observations}}:track);}
  return [...merged.values()].filter(track=>track.original.phase===phase);
 }
 function groupRows(rows){
  const groups=new Map(),rank={triggered_B:0,near_B:1,watch:2};
  const distance=row=>finite(row.reference.trigger)&&row.reference.trigger>0?Math.abs(row.reference.close/row.reference.trigger-1):Infinity;
  for(const row of rows){if(!groups.has(row.code))groups.set(row.code,[]);groups.get(row.code).push(row);}
  return [...groups.values()].map(values=>{const ordered=values.slice().sort((a,b)=>rank[a.state]-rank[b.state]||Number(b.qualified)-Number(a.qualified)||distance(a)-distance(b)||a.id.localeCompare(b.id));return {row:ordered[0],alternatives:ordered.slice(1)};});
 }
 function defaultPhase(reports,now){
  const a14=reports.a14,close=reports.close;
  return a14&&a14.current.some(row=>activeAt(row,now))&&(!close||a14.day>close.day)?'a14':'close';
 }
 function observationLabel(value){return value?.status==='ready'?percent(value.returnPercent):value?.status==='unavailable'?'— / 缺资料':value?.status==='not_observable'?'— / 发现较晚':'— / 待满';}
 function mount(doc,options={}){
  const el=id=>doc.getElementById('stock-desk'+(id?'-'+id:'')),env=doc.defaultView||globalThis;
  if(!el(''))return null;
  const now=options.now||Date.now,listeners=[];
  const state={reports:{close:null,a14:null},slots:{close:{status:'unavailable'},a14:{status:'not_collected'}},institutions:{status:'not_collected',byCode:{}},phase:'close',phaseExplicit:false,tab:'candidates',strategy:'all',shape:'all',query:'',loading:false,error:null,readAt:null,cards:new Map(),expanded:new Map(),windows:new Map(),chartErrors:new Set()};
  let sequence=0,controller=null,poll=null,deadline=null,expiry=null,destroyed=false,suspended=false;
  function text(tag,value,className){const node=doc.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
  function listen(node,event,fn){node.addEventListener(event,fn);listeners.push(()=>node.removeEventListener(event,fn));}
  function reasonFor(phase){const slot=state.slots[phase];return slot.reason||(phase==='a14'?'14:00候选尚未采集。':'收盘批次尚未完成。');}
  function renderChart(record,row){
   const window=state.windows.get(record.key)||60,path=row.chartUrls?.[window],key=path;
   record.range.value=String(window);
   if(!path){record.plot.replaceChildren(text('p','本条件暂无可发布的同批日K。'));return;}
   if(state.chartErrors.has(key)){record.plot.replaceChildren(text('p','本批日K载入失败，参考条件仍保留。'));return;}
   if(record.image?.getAttribute('src')===path&&record.image.parentNode===record.plot)return;
   const image=doc.createElement('img');image.alt=row.name+' '+row.day+' '+phaseLabels[row.phase]+'日K与当前条件'+(row.phase==='a14'?'（末根未收盘）':'');image.loading='lazy';image.decoding='async';image.setAttribute('src',path);
   image.addEventListener('error',()=>{if(record.image===image){state.chartErrors.add(key);if(state.cards.get(record.key)===record)render();}},{once:true});
   record.image=image;record.plot.replaceChildren(image);
  }
  function renderPlan(record,row){
   const plan=row.research?.plan,levels=[],add=(label,value)=>{const item=doc.createElement('div');item.append(text('dt',label),text('dd',value));levels.push(item);};
   if(plan?.buyZone)add('买入观察区',number(plan.buyZone.low)+'–'+number(plan.buyZone.high));
   if(plan?.reduceZone)add('压力减仓区',number(plan.reduceZone.low)+'–'+number(plan.reduceZone.high));
   const trigger=plan?plan.trigger:row.reference.trigger,invalidation=plan?plan.invalidation:row.reference.invalidation;
   if(finite(trigger))add('突破参考','> '+number(trigger));
   if(finite(invalidation))add('失效参考','< '+number(invalidation));
   const limitWatch=row.familyId==='close-limitup-watch';
   record.part('plan').hidden=!levels.length&&!limitWatch;
   record.part('plan-title').textContent=row.phase==='a14'?'盘中条件观察 · 收盘待确认':'下一交易日条件计划';
   record.part('plan-levels').replaceChildren(...levels);
   const labels={next_session_watch:'待下一交易日重新核验',existing_position_T_watch:'日线波段T观察',countertrend_watch:'逆势收复观察，尚未确认转强',limit_up_next_session_recheck:'本日近涨停，仅待下一交易日复核'};
   let note=plan?plan.label+' · '+labels[plan.modelState]:'原关键K条件参考，下一交易日须重新核验。';
   if(limitWatch)note='次日持续一字、封死或无法核实可成交则跳过；开板不等于B，等待新的回踩或突破条件。';
   if(plan?.holdingRequired||plan?.reduceZone)note+='；做T须有可卖底仓，当天新买不能当日卖出。';
   record.part('plan-note').textContent=note;
  }
  function renderAnalogue(host,row){
   const value=row.research?.analogue;host.hidden=false;
   if(!value){host.replaceChildren(text('p','同类历史：尚无本条件的成熟路径资料。'));return;}
   const nodes=[text('p',(value.label||'同类条件')+' · 历史收盘路径，非预测或交易收益')],table=doc.createElement('table'),head=doc.createElement('tr');
   for(const label of ['周期','样本','均值','中位数','最差回撤']){const cell=text('th',label);cell.setAttribute('scope','col');head.append(cell);}table.append(head);
   for(const horizon of [3,15]){
    const stats=value.horizons[horizon],line=doc.createElement('tr');
    for(const label of [horizon+'交易日',stats?number(stats.sampleCount):'未提供',percent(stats?.meanReturnPercent),percent(stats?.medianReturnPercent),finite(stats?.worstDrawdownPercent)?number(stats.worstDrawdownPercent)+'%':'—'])line.append(text('td',label));
    table.append(line);
    if(stats&&!stats.adequate)nodes.push(text('p',horizon+'日样本不足：'+(stats.reasons.length?stats.reasons.join('；'):'未达到同类统计门槛')));
   }
   nodes.splice(1,0,table);
   const path=value.path,complete=path&&path.sampleCount>0&&['median','p25','p75'].every(key=>Array.isArray(path[key])&&path[key].length===16&&path[key].every(finite));
   if(complete){
    const make=(tag,attrs)=>{const node=doc.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,entry]of Object.entries(attrs))node.setAttribute(key,entry);return node;};
    const svg=make('svg',{viewBox:'0 0 320 150',role:'img','aria-label':'同类历史15个交易日收盘价格变化的中位数与25%至75%区间，非预测'}),values=[...path.p25,...path.p75,...path.median],minimum=Math.min(0,...values),maximum=Math.max(0,...values),span=Math.max(1,maximum-minimum),low=minimum-span*.1,high=maximum+span*.1;
    const x=index=>36+index*17.4,y=value=>115-(value-low)/(high-low)*98,points=values=>values.map((value,index)=>x(index).toFixed(2)+','+y(value).toFixed(2)).join(' ');
    svg.append(make('line',{x1:36,y1:y(0),x2:297,y2:y(0),stroke:'#c4cdd2','stroke-dasharray':'3 4'}));
    svg.append(make('polygon',{points:points(path.p75)+' '+path.p25.map((value,index)=>x(index).toFixed(2)+','+y(value).toFixed(2)).reverse().join(' '),fill:'#d7e2e9'}));
    svg.append(make('polyline',{points:points(path.median),fill:'none',stroke:'#286178','stroke-width':2}));
    for(const [label,xx,yy,anchor]of [['T0',36,139,'start'],['+3日',x(3),139,'middle'],['+15日',297,139,'end'],[number(maximum)+'%',31,22,'end'],[number(minimum)+'%',31,116,'end']]){const node=make('text',{x:xx,y:yy,'text-anchor':anchor,fill:'#53636e','font-size':11});node.textContent=label;svg.append(node);}
    nodes.push(svg,text('p','实线：中位数 · 色带：25%–75% · 完整15日路径 '+number(path.sampleCount)+'例 / '+number(path.stockCount)+'只 / '+number(path.signalDayCount)+'个信号日'+(path.adequate?'':' · 样本不足')));
   }else nodes.push(text('p','完整15日路径：'+(path?number(path.sampleCount)+'例':'样本未提供')+'，尚无可绘制的成熟路径。'));
   nodes.push(text('p','历史价格变化未扣交易成本；采用当前名册回看，不替代本股实际3日跟踪。'));
   host.replaceChildren(...nodes);
  }
  function renderResearch(host,row,report,alternatives){
   const nodes=[text('p',row.qualified?'通过原验证门槛':'未通过验证'),text('p',datedState(row)+' · '+referenceText(row))];
   if(row.reasons.length)nodes.push(text('p',row.reasons.join('；')));
   if(row.research?.plan?.reason.length)nodes.push(text('p',row.research.plan.reason.join('；')));
   for(const rule of row.research?.rules||[]){
    nodes.push(text('p',rule.label||rule.id));
    for(const [key,label]of [['fit','拟合'],['recent','近期'],['validation','留出']]){const stats=rule[key];if(stats)nodes.push(text('p',label+' · 样本 '+number(stats.sampleCount)+' · 15日平均变化 '+percent(stats.meanReturnPercent)+' · 最差回撤 '+(finite(stats.worstDrawdownPercent)?number(stats.worstDrawdownPercent)+'%':'—')));}
   }
   for(const value of row.research?.regimePreference||[])nodes.push(text('p',preferenceText(value)));
   const regimes={bullish_trend:'上行',bearish_trend:'下行',mixed_or_range:'震荡',unknown:'资料不足'};
   if(report.marketContext?.regime)nodes.push(text('p','沪深300：'+(regimes[report.marketContext.regime]||'资料不足')));
   nodes.push(text('p','条件可知 '+stamp(row.conditionKnownAfter)+' · 首次发现 '+stamp(row.firstSeenAt)+' · 有效至 '+stamp(row.activeUntil)));
   if(alternatives.length)nodes.push(text('p','其他条件 · 同股不重复计数'));
   for(const item of alternatives){
    nodes.push(text('p',datedState(item)+' · '+item.setupId),text('p',referenceText(item)));
    if(item.research?.plan){const plan=item.research.plan;nodes.push(text('p',plan.label+(plan.buyZone?' · 买入观察 '+number(plan.buyZone.low)+'–'+number(plan.buyZone.high):'')+(plan.reduceZone?' · 压力减仓 '+number(plan.reduceZone.low)+'–'+number(plan.reduceZone.high):'')));}
    if(item.reasons.length)nodes.push(text('p',item.reasons.join('；')));
    for(const rule of item.research?.rules||[])for(const [key,label]of [['recent','近期'],['validation','留出']]){const stats=rule[key];if(stats)nodes.push(text('p',(rule.label||rule.id)+' · '+label+' · 样本 '+number(stats.sampleCount)+' · 15日平均变化 '+percent(stats.meanReturnPercent)+' · 最差回撤 '+(finite(stats.worstDrawdownPercent)?number(stats.worstDrawdownPercent)+'%':'—')));}
    for(const value of item.research?.regimePreference||[])nodes.push(text('p',preferenceText(value)));
    nodes.push(text('p','条件可知 '+stamp(item.conditionKnownAfter)+' · 首次发现 '+stamp(item.firstSeenAt)));
   }
   host.replaceChildren(...nodes);
  }
  function preferenceText(value){
   const labels={bull:'上升趋势',bear:'下降趋势',sideways:'震荡或过渡'};
   return '同市场状态 '+labels[value.regime]+' · '+value.label+' · 3日样本 '+number(value.sampleCount)+'（'+number(value.stockCount)+'只 / '+number(value.signalDayCount)+'个信号日） · 平均价格变化 '+percent(value.meanReturnPercent)+' · 最差回撤 '+(finite(value.worstDrawdownPercent)?number(value.worstDrawdownPercent)+'%':'—')+' · 未扣成本'+(value.adequate?'':' · 样本不足');
  }
  function renderInstitutions(host,row){
   const events=eventsFor(state.institutions,row.code);
   if(!events.length){host.replaceChildren(text('p',state.institutions.reason||'暂无已核验的机构披露。'));return;}
   const nodes=[];if(state.institutions.status!=='ready'||state.institutions.partial)nodes.push(text('p',state.institutions.reason||'机构披露仅含已完成的部分记录。'));
   for(const event of events){
    nodes.push(text('p',event.title));
    if(event.summary)nodes.push(text('p',event.summary));
    const published=event.precision==='day'?event.sourceDate+'（日期精度）':event.sourceDate+' '+clockFormatter.format(new Date(event.publishedAt))+' 北京（分钟精度）';
    nodes.push(text('p','披露 '+published+' · 首次发现 '+stamp(event.firstSeenAt)+' · 读取检查 '+stamp(state.institutions.checkedAt)));
    const link=text('a','原始披露');link.href=event.url;link.target='_blank';link.rel='noopener noreferrer';nodes.push(link);
   }host.replaceChildren(...nodes);
  }
  function card(row,report,alternatives){
   const key=row.phase+':'+row.code;let record=state.cards.get(key);
   if(!record){
    const node=el('card-template').content.firstElementChild.cloneNode(true),part=name=>node.querySelector('[data-stock-desk-'+name+']');
    const range=doc.createElement('select'),plot=doc.createElement('div'),label=text('label','图表：');range.setAttribute('aria-label',row.name+'图表交易日范围');
    for(const window of [60,120]){const option=text('option','近'+window+'个交易日');option.value=String(window);range.append(option);}
    label.append(range);part('chart').append(label,plot);record={key,node,part,range,plot,image:null};state.cards.set(key,record);
    range.addEventListener('change',()=>{if([60,120].includes(Number(range.value))){state.windows.set(key,Number(range.value));render();}});
    for(const name of ['research','institution']){
     const detail=part(name),remember=open=>{const expanded=state.expanded.get(key)||new Set();if(open)expanded.add(name);else expanded.delete(name);state.expanded.set(key,expanded);};
     detail.querySelector('summary').addEventListener('click',()=>remember(!detail.open));
     detail.addEventListener('toggle',()=>remember(detail.open));
    }
   }
   record.node.dataset.code=row.code;record.node.dataset.phase=row.phase;record.node.dataset.conditionId=row.id;
   record.part('name').textContent=row.name;record.part('code').textContent=row.code;
   record.part('institution').querySelector('summary').textContent=hasInstitutionEvidence(state.institutions,row.code)?'机构与公开披露':'公开披露';
   record.part('stage').textContent=datedState(row);
   record.part('reason').textContent=referenceText(row)+(alternatives.length?' · 共 '+(alternatives.length+1)+' 条条件':'');
   record.part('position').hidden=false;record.part('position').textContent=positionText(row);renderPlan(record,row);
   record.part('source').textContent=row.sourceId+' · '+row.day+' '+phaseLabels[row.phase]+' · 来源 '+stamp(row.asOf)+' · 读取 '+stamp(row.sourceFetchedAt);
   renderResearch(record.part('research-body'),row,report,alternatives);renderAnalogue(record.part('analogue'),row);renderInstitutions(record.part('institution-body'),row);renderChart(record,row);
   for(const name of ['research','institution'])record.part(name).open=state.expanded.get(key)?.has(name)||false;
   return record.node;
  }
  function renderTracking(report){
   const tracks=mergeTracking(state.reports,state.phase).filter(track=>matches(track.original,state,state.institutions)),table=el('tracking-rows').parentNode,through=state.reports.close?.day||report?.observationDay;
   const headers=['股票','观察日','条件状态','+1日','+2日','+3日','来源时点'],head=doc.createElement('tr');for(const label of headers){const th=text('th',label);th.setAttribute('scope','col');head.append(th);}table.querySelector('thead').replaceChildren(head);
   const rows=[];for(const track of tracks){const original=track.original,row=doc.createElement('tr'),values=[original.name+' '+original.code,original.anchorDay,stateLabel(original)+' · '+original.setupId,...[1,2,3].map(h=>observationLabel(track.observations[h])),stamp(original.asOf)];
    values.forEach((value,index)=>{const cell=text('td',value);cell.dataset.label=headers[index];if(index>=3&&index<=5){const observation=track.observations[index-2];cell.title=observation?'目标 '+(observation.targetDay||'待满')+' · 来源 '+observation.sourceId+' '+stamp(observation.asOf)+' · 读取 '+stamp(observation.sourceFetchedAt)+' · 核验 '+stamp(observation.checkedAt)+' · '+observation.reason:'尚未满对应交易日';}row.append(cell);});rows.push(row);
   }el('tracking-rows').replaceChildren(...rows);el('tracking-count').textContent=new Set(tracks.map(track=>track.original.code)).size+' 只 · '+tracks.length+' 条条件记录 · 收盘到收盘变化'+(through?' · 跟踪截至 '+through:'');el('tracking-empty').hidden=tracks.length>0;el('tracking-empty').textContent=report?'暂无符合条件的跟踪记录。':reasonFor(state.phase);
  }
  function render(){
   if(!state.phaseExplicit){const next=defaultPhase(state.reports,now());if(next!==state.phase){state.phase=next;state.shape='all';}}
   const report=state.reports[state.phase],slot=state.slots[state.phase],rows=selectRows(report,state,state.institutions,now()),groups=groupRows(rows),partial=state.phase==='a14'&&report?.method?.partial===true;
   const coverage=partial?' · 部分覆盖 · 缺 '+number(report.summary?.missingCount)+' 只':'';
   const retained=new Set(phases.flatMap(phase=>(state.reports[phase]?.current||[]).map(row=>phase+':'+row.code)));
   for(const id of state.cards.keys())if(!retained.has(id)){state.cards.delete(id);state.expanded.delete(id);state.windows.delete(id);}
   el('').dataset.state=state.loading?'loading':state.error?'error':report?'ready':'unavailable';
   el('date').textContent=report?'数据日 '+report.day:'数据日待核验';
   el('status').textContent=report?phaseLabels[state.phase]+' · '+new Set(rows.map(row=>row.code)).size+' 只'+coverage+(slot.status!=='ready'?' · '+reasonFor(state.phase)+' 保留上次数据。':''):state.loading?'正在读取已完成的选股批次':reasonFor(state.phase);
   el('source').textContent=report?'来源 '+report.sourceId+' · 来源时点 '+stamp(report.asOf)+' · 计算 '+stamp(report.computedAt)+' · 页面读取 '+stamp(state.readAt):reasonFor(state.phase);
   el('market-position').hidden=!report;el('market-position').textContent=marketPositionText(report);
   if(partial){const missing=(Array.isArray(report.missing)?report.missing:[]).map(item=>(item.code?item.code+'：':'')+item.reason).join('；');el('source').textContent+=' · '+report.method.reason+(missing?' · 缺项 '+missing:'');}
   el('error').hidden=!state.error;el('error').textContent=state.error||'';el('refresh').hidden=!state.error;el('refresh').disabled=state.loading;
   el('filters').disabled=false;
   for(const phase of phases){const option=el('phase').querySelector('option[value="'+phase+'"]');option.disabled=false;}
   for(const key of ['phase','strategy','query'])el(key).value=state[key];
   const shapes=new Map(),shapeRows=state.tab==='tracking'?mergeTracking(state.reports,state.phase).map(track=>track.original):report?.current||[];
   for(const row of shapeRows)for(const id of row.ruleIds){const rule=row.research?.rules?.find(rule=>rule.id===id),plan=row.research?.plan;shapes.set(row.familyId+':'+id,rule?.label||(plan?.kind===id?plan.label:id));}
   if(state.shape!=='all'&&!shapes.has(state.shape))shapes.set(state.shape,'所选形态（当前无记录）');
   const shapeOptions=[text('option','全部形态')];shapeOptions[0].value='all';for(const [key,label]of shapes){const option=text('option',label);option.value=key;shapeOptions.push(option);}el('shape').replaceChildren(...shapeOptions);el('shape').value=state.shape;
   for(const tab of ['candidates','tracking']){const selected=state.tab===tab;el(tab+'-tab').disabled=false;el(tab+'-tab').setAttribute('aria-selected',String(selected));el(tab+'-tab').tabIndex=selected?0:-1;el(tab).hidden=!selected;el(tab).setAttribute('aria-busy',String(state.loading));}
   el('count').textContent=new Set(rows.map(row=>row.code)).size+' 只 · '+rows.length+' 条条件';
   el('results').replaceChildren(...groups.map(group=>card(group.row,report,group.alternatives)));
   el('empty').hidden=groups.length>0;
   const expired=report?.current.some(row=>!activeAt(row,now()));
   el('empty').replaceChildren(text('p',state.strategy==='institution'&&state.institutions.status!=='ready'?(state.institutions.reason||'机构披露尚未采集。'):report?(expired?'本批条件已过期，等待新批次。':'暂无符合当前条件的股票。'):reasonFor(state.phase)));
   renderTracking(report);
   armExpiry();
  }
  function armExpiry(){
   env.clearTimeout(expiry);expiry=null;
   if(destroyed||suspended||doc.hidden)return;
   const deadlines=phases.flatMap(phase=>(state.reports[phase]?.current||[]).filter(row=>activeAt(row,now())).map(row=>Date.parse(row.activeUntil)));
   if(deadlines.length)expiry=env.setTimeout(()=>{expiry=null;render();},Math.min(2147483647,Math.max(1,Math.min(...deadlines)-now())));
  }
  function dispatch(action){
   if(action.type==='tab'&&['candidates','tracking'].includes(action.value))state.tab=action.value;
   if(action.type==='phase'&&phases.includes(action.value)){state.phase=action.value;state.phaseExplicit=true;state.shape='all';}
   if(action.type==='strategy'&&strategies.includes(action.value))state.strategy=action.value;
   if(action.type==='shape')state.shape=action.value;
   if(action.type==='query')state.query=String(action.value);
   render();
  }
  async function refresh(){
   if(destroyed||suspended||doc.hidden)return;
   controller?.abort();env.clearTimeout(deadline);const token=++sequence,active=new AbortController();controller=active;
   state.loading=true;render();deadline=env.setTimeout(()=>active.abort(),10000);
   try{
    const response=await env.fetch('/api/a-share-daily/workbench',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:active.signal});
    if(!response.ok)throw Error('选股读取失败（HTTP '+response.status+'），保留上次结果。');
    const value=validate(await response.json(),state.reports);if(destroyed||token!==sequence)return;
    for(const phase of phases){state.slots[phase]=value[phase];if(value[phase].data)state.reports[phase]=value[phase].data;}
    state.institutions=value.institutions;
    state.readAt=new Date(now()).toISOString();state.error=null;
   }catch(error){if(!destroyed&&token===sequence)state.error=error.name==='AbortError'?'选股读取超时，保留上次结果。':error.message;}
   finally{if(token===sequence){env.clearTimeout(deadline);deadline=null;controller=null;state.loading=false;if(!destroyed)render();}}
  }
  function stop(){env.clearInterval(poll);poll=null;env.clearTimeout(deadline);deadline=null;env.clearTimeout(expiry);expiry=null;controller?.abort();controller=null;sequence++;state.loading=false;}
  function start(){if(!destroyed&&!suspended&&!doc.hidden&&poll===null)poll=env.setInterval(()=>refresh(),60000);}
  for(const key of ['phase','strategy','shape'])listen(el(key),'change',()=>dispatch({type:key,value:el(key).value}));
  listen(el('query'),'input',()=>dispatch({type:'query',value:el('query').value}));
  for(const tab of ['candidates','tracking'])listen(el(tab+'-tab'),'click',()=>dispatch({type:'tab',value:tab}));
  listen(el('tabs'),'keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();dispatch({type:'tab',value:event.key==='Home'?'candidates':event.key==='End'?'tracking':state.tab==='candidates'?'tracking':'candidates'});el(state.tab+'-tab').focus();}});
  listen(el('filter-form'),'submit',event=>event.preventDefault());listen(el('refresh'),'click',refresh);
  listen(doc,'visibilitychange',()=>{if(doc.hidden)stop();else{render();refresh();start();}});
  listen(env,'pagehide',()=>{suspended=true;stop();});listen(env,'pageshow',event=>{if(!suspended&&!event.persisted)return;suspended=false;render();refresh();start();});
  render();if(options.autoLoad!==false)refresh();start();
  return {refresh,dispatch,getState:()=>state,destroy(){destroyed=true;stop();for(const remove of listeners)remove();state.cards.clear();}};
 }
 return {schema,version,validate,validateReport,selectRows,selectTracks,mergeTracking,groupRows,defaultPhase,observationLabel,mount};
});
