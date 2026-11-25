'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{root.BooksStockDesk=api;if(root.document)root.BooksStockDeskApp=api.mount(root.document);}
})(globalThis,()=>{
 const schema='books.a-share.desk.v1',reportSchema='books.a-share.opportunity-workbench.v1',version='books.a-share.opportunity-tracking.2026-11-25.v1';
 const phases=['close','a14'],states={near_B:'接近B',triggered_B:'B触发',watch:'观察',expired:'已过期'};
 const phaseLabels={close:'收盘',a14:'14:00'},strategies=['all','trend','short-term','institution'];
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
 function validateChart(path,row,report,window){
  if(typeof path!=='string'||!path.startsWith('/api/a-share-daily/'))return false;
  const url=new URL(path,'https://books.invalid');
  if(row.phase==='a14')return url.origin==='https://books.invalid'&&!url.hash&&url.pathname==='/api/a-share-daily/a14-chart'&&url.searchParams.get('day')===row.day&&url.searchParams.get('code')===row.code&&url.searchParams.get('window')===String(window)&&[...url.searchParams.keys()].length===3;
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
 function matches(row,filters,institutions){
  const strategy=row.strategy||'trend';
  if(filters.strategy==='institution'&&!eventsFor(institutions,row.code).length)return false;
  if(!['all','institution'].includes(filters.strategy)&&strategy!==filters.strategy)return false;
  if(filters.shape!=='all'&&!row.ruleIds.some(id=>row.familyId+':'+id===filters.shape))return false;
  return !filters.query||(row.code+' '+row.name).toLowerCase().includes(filters.query.trim().toLowerCase());
 }
 const selectRows=(report,filters,institutions,now=Date.now())=>(report?.current||[]).filter(row=>activeAt(row,now)&&matches(row,filters,institutions));
 const selectTracks=(report,filters,institutions)=>(report?.tracks||[]).filter(track=>(!filters.phase||track.original.phase===filters.phase)&&matches(track.original,filters,institutions));
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
  function renderResearch(host,row,report,alternatives){
   const nodes=[text('p',row.qualified?'通过原验证门槛':'未通过验证'),text('p','实际条件：'+states[row.state]+' · 参考价 '+number(row.reference.close)+' · 触发 > '+number(row.reference.trigger)+' · 失效 < '+number(row.reference.invalidation))];
   if(row.reasons.length)nodes.push(text('p',row.reasons.join('；')));
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
    nodes.push(text('p',stateLabel(item)+' · '+item.setupId),text('p','参考价 '+number(item.reference.close)+' · 触发 > '+number(item.reference.trigger)+' · 失效 < '+number(item.reference.invalidation)));
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
    const range=doc.createElement('select'),plot=doc.createElement('div');range.setAttribute('aria-label',row.name+'日K范围');
    for(const window of [60,120]){const option=text('option',window+'日');option.value=String(window);range.append(option);}
    part('chart').append(range,plot);record={key,node,part,range,plot,image:null};state.cards.set(key,record);
    range.addEventListener('change',()=>{if([60,120].includes(Number(range.value))){state.windows.set(key,Number(range.value));render();}});
    for(const name of ['research','institution']){const detail=part(name);detail.addEventListener('toggle',()=>{const expanded=state.expanded.get(key)||new Set();if(detail.open)expanded.add(name);else expanded.delete(name);state.expanded.set(key,expanded);});}
   }
   record.node.dataset.code=row.code;record.node.dataset.phase=row.phase;record.node.dataset.conditionId=row.id;
   record.part('name').textContent=row.name;record.part('code').textContent=row.code;
   record.part('stage').textContent=stateLabel(row);
   record.part('reason').textContent='参考价 '+number(row.reference.close)+' · 触发 > '+number(row.reference.trigger)+' · 失效 < '+number(row.reference.invalidation)+(alternatives.length?' · 共 '+(alternatives.length+1)+' 条条件':'');
   record.part('source').textContent=row.sourceId+' · '+row.day+' '+phaseLabels[row.phase]+' · 来源 '+stamp(row.asOf)+' · 读取 '+stamp(row.sourceFetchedAt);
   renderResearch(record.part('research-body'),row,report,alternatives);renderInstitutions(record.part('institution-body'),row);renderChart(record,row);
   for(const name of ['research','institution'])record.part(name).open=state.expanded.get(key)?.has(name)||false;
   return record.node;
  }
  function renderTracking(report){
   const tracks=selectTracks(report,state,state.institutions),table=el('tracking-rows').parentNode;
   const headers=['股票','观察日','条件状态','+1日','+2日','+3日','来源时点'],head=doc.createElement('tr');for(const label of headers){const th=text('th',label);th.setAttribute('scope','col');head.append(th);}table.querySelector('thead').replaceChildren(head);
   const rows=[];for(const track of tracks){const original=track.original,row=doc.createElement('tr'),values=[original.name+' '+original.code,original.anchorDay,stateLabel(original)+' · '+original.setupId,...[1,2,3].map(h=>observationLabel(track.observations[h])),stamp(original.asOf)];
    values.forEach((value,index)=>{const cell=text('td',value);cell.dataset.label=headers[index];if(index>=3&&index<=5){const observation=track.observations[index-2];cell.title=observation?'目标 '+(observation.targetDay||'待满')+' · 来源 '+observation.sourceId+' '+stamp(observation.asOf)+' · 读取 '+stamp(observation.sourceFetchedAt)+' · 核验 '+stamp(observation.checkedAt)+' · '+observation.reason:'尚未满对应交易日';}row.append(cell);});rows.push(row);
   }el('tracking-rows').replaceChildren(...rows);el('tracking-count').textContent=new Set(tracks.map(track=>track.original.code)).size+' 只 · '+tracks.length+' 条条件记录 · 收盘到收盘变化'+(report?.observationDay?' · 跟踪截至 '+report.observationDay:'');el('tracking-empty').hidden=tracks.length>0;el('tracking-empty').textContent=report?'暂无符合条件的跟踪记录。':reasonFor(state.phase);
  }
  function render(){
   if(!state.phaseExplicit){const next=defaultPhase(state.reports,now());if(next!==state.phase){state.phase=next;state.shape='all';}}
   const report=state.reports[state.phase],slot=state.slots[state.phase],rows=selectRows(report,state,state.institutions,now()),groups=groupRows(rows);
   const retained=new Set(phases.flatMap(phase=>(state.reports[phase]?.current||[]).map(row=>phase+':'+row.code)));
   for(const id of state.cards.keys())if(!retained.has(id)){state.cards.delete(id);state.expanded.delete(id);state.windows.delete(id);}
   el('').dataset.state=state.loading?'loading':state.error?'error':report?'ready':'unavailable';
   el('date').textContent=report?'数据日 '+report.day:'数据日待核验';
   el('status').textContent=report?phaseLabels[state.phase]+' · '+new Set(rows.map(row=>row.code)).size+' 只'+(slot.status!=='ready'?' · '+reasonFor(state.phase)+' 保留上次数据。':''):state.loading?'正在读取已完成的选股批次':reasonFor(state.phase);
   el('source').textContent=report?'来源 '+report.sourceId+' · 来源时点 '+stamp(report.asOf)+' · 计算 '+stamp(report.computedAt)+' · 页面读取 '+stamp(state.readAt):reasonFor(state.phase);
   el('error').hidden=!state.error;el('error').textContent=state.error||'';el('refresh').hidden=!state.error;el('refresh').disabled=state.loading;
   el('filters').disabled=false;
   for(const phase of phases){const option=el('phase').querySelector('option[value="'+phase+'"]');option.disabled=false;}
   for(const key of ['phase','strategy','query'])el(key).value=state[key];
   const shapes=new Map(),shapeRows=state.tab==='tracking'?(report?.tracks||[]).filter(track=>track.original.phase===state.phase).map(track=>track.original):report?.current||[];
   for(const row of shapeRows)for(const id of row.ruleIds){const rule=row.research?.rules?.find(rule=>rule.id===id);shapes.set(row.familyId+':'+id,rule?.label||id);}
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
  listen(env,'pagehide',()=>{suspended=true;stop();});listen(env,'pageshow',()=>{suspended=false;render();refresh();start();});
  render();if(options.autoLoad!==false)refresh();start();
  return {refresh,dispatch,getState:()=>state,destroy(){destroyed=true;stop();for(const remove of listeners)remove();state.cards.clear();}};
 }
 return {schema,version,validate,validateReport,selectRows,selectTracks,groupRows,defaultPhase,observationLabel,mount};
});
