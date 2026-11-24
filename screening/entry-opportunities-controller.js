'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{root.BooksEntryOpportunities=api;if(root.document)root.BooksEntryOpportunitiesApp=api.mount(root.document);}
})(globalThis,()=>{
 const schema='books.a-share.entry-current.v1',version='books.entry-current.2026-11-24.v2',policyVersion='books.entry-bars.2026-11-24.v1',validationVersion='books.entry-validation.2026-11-24.v1';
 const statuses={effective:'通过原T触发验证',watch:'继续验证',insufficient:'样本不足',inactive:'近期未通过'};
 const stages={waiting_breakout:'临近突破 · 等待条件',triggered_at_close:'当日收盘已触发 · 次日须核验'};
 const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
 const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
 const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 const number=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:4}):'—';
 const percent=value=>Number.isFinite(value)?(value>0?'+':'')+value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
 const magnitude=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
 const beijing=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const stamp=value=>time(value)?beijing.format(new Date(value))+'（北京）':'未提供';
 const binding=value=>typeof value?.generation==='string'&&value.generation&&day(value.day)&&typeof value.sourceId==='string'&&value.sourceId&&time(value.asOf)?JSON.stringify([value.generation,value.day,value.sourceId,value.asOf]):null;
 function chartUrl(path,data,item,window){
  if(typeof path!=='string'||!path.startsWith('/api/a-share-daily/entry-current-chart?'))return false;
  const url=new URL(path,'https://books.invalid');
  return url.origin==='https://books.invalid'&&!url.hash&&url.pathname==='/api/a-share-daily/entry-current-chart'&&url.searchParams.get('generation')===data.generation&&url.searchParams.get('code')===item.code&&url.searchParams.get('setup')===item.formationDay&&url.searchParams.get('window')===String(window)&&[...url.searchParams.keys()].length===4;
 }
 function validate(value,current){
  if(value?.schema!==schema||value.version!==version||value.completed!==true||value.datasetBound!==true||value.sourceDay!==value.day||binding(value)!==binding(current)||!binding(current)||!time(value.computedAt)||value.entryPolicyVersion!==policyVersion||value.entryValidationVersion!==validationVersion||value.benchmark?.code!=='000300.SH'||value.policy?.maxDistancePercent!==2||value.policy.confirmationSessions!==3||value.policy.triggerSessions!==3||value.policy.horizon!==15||value.policy.closeEntryValidated!==false||!Array.isArray(value.patterns)||value.patterns.length!==16||!Array.isArray(value.current))throw Error('收盘观察与完整日线批次或固定规则不一致，保留上次结果。');
  const patterns=new Map();
  for(const item of value.patterns){
   if(typeof item.id!=='string'||patterns.has(item.id)||typeof item.label!=='string'||!Object.hasOwn(statuses,item.status)||item.recommended!==(item.status==='effective')||!Array.isArray(item.reasons)||item.reasons.some(reason=>typeof reason!=='string'))throw Error('原T触发验证记录不完整，保留上次结果。');
   for(const stats of [item.fit,item.recent,item.validation])if(!Number.isInteger(stats?.sampleCount)||stats.sampleCount<0||['meanReturnPercent','medianReturnPercent','worstDrawdownPercent'].some(key=>stats[key]!==null&&!Number.isFinite(stats[key])))throw Error('原T触发样本、收益或回撤不完整。');
   patterns.set(item.id,item);
  }
  const seen=new Set();
  for(const item of value.current){
   if(!/^\d{6}\.(SH|SZ)$/.test(item.code)||binding(item)!==binding(value)||!day(item.formationDay)||!day(item.keyBarDay)||item.formationDay>=item.keyBarDay||item.keyBarDay>value.day||item.setupId!==item.code+':'+item.formationDay||seen.has(item.setupId)||!Object.hasOwn(stages,item.stage)||!Number.isFinite(item.closePrice)||!Number.isFinite(item.trigger?.above)||!Number.isFinite(item.invalidation?.below)||item.invalidation.below<=0||item.trigger.above<=item.invalidation.below||item.closePrice<=item.invalidation.below||!Number.isFinite(item.distanceToTriggerPct)||Math.abs((item.closePrice/item.trigger.above-1)*100-item.distanceToTriggerPct)>1e-8)throw Error('当前收盘价、参考位或候选日期不一致，未采用结果。');
   if(typeof item.nearTrigger!=='boolean'||item.nearTrigger!==(item.stage==='triggered_at_close'||!above(-item.distanceToTriggerPct,2))||item.stage==='triggered_at_close'&&(item.distanceToTriggerPct<=0||above(item.distanceToTriggerPct,2))||item.stage==='waiting_breakout'&&item.distanceToTriggerPct>0||!Number.isInteger(item.remainingSessions)||item.remainingSessions<0||item.stage==='triggered_at_close'&&item.remainingSessions!==0||!time(item.knownAfter)||!time(item.sourceFetchedAt)||!time(item.actualDiscoveryAt)||!time(item.activeUntil)||Date.parse(item.activeUntil)<=Date.parse(value.asOf)||Date.parse(item.actualDiscoveryAt)>Date.parse(value.computedAt)||item.requiresRecheck!==true||item.closeEntryValidated!==false||item.actualFillVerified!==false)throw Error('收盘候选时点或研究状态无效，未采用结果。');
   if(!Array.isArray(item.patternIds)||!item.patternIds.length||item.patternIds.some(id=>!patterns.has(id))||!Array.isArray(item.eligiblePatternIds)||item.eligiblePatternIds.some(id=>!item.patternIds.includes(id)||!patterns.get(id).recommended)||typeof item.qualified!=='boolean'||item.qualified!==(item.nearTrigger&&item.eligiblePatternIds.length>0)||item.qualification!==(item.qualified?'qualified_watch':'research')||!Array.isArray(item.reasons)||item.reasons.some(reason=>typeof reason!=='string')||![60,120].every(window=>chartUrl(item.chartUrls?.[window],value,item,window)))throw Error('收盘候选资格或同批图表不一致，未加载结果。');
   seen.add(item.setupId);
  }
  const s=value.summary;
  if(s?.patternCount!==16||s.candidateCount!==value.current.length||s.stockCount!==new Set(value.current.map(item=>item.code)).size||s.qualifiedCount!==value.current.filter(item=>item.qualified).length||s.todayTriggeredCount!==value.current.filter(item=>item.stage==='triggered_at_close').length||s.waitingBreakoutCount!==value.current.filter(item=>item.stage==='waiting_breakout').length||typeof s.reason!=='string'||['entryEffectiveCount','shapeEffectiveCount'].some(key=>!Number.isInteger(s[key])||s[key]<0||s[key]>16))throw Error('收盘候选汇总与逐股结果不一致。');
  return value;
 }
 const activeAt=(item,now)=>time(item.activeUntil)&&Date.parse(item.activeUntil)>now;
 function currentPool(data,scope,now=Date.now()){return data?data.current.filter(item=>activeAt(item,now)&&(scope==='near'?item.nearTrigger:scope!=='qualified'||item.qualified)):[];}
 function diagnosticText(values=[]){return values.filter(item=>item.passed===false).map(item=>item.label+' '+(item.actual===null?'未取得':typeof item.actual==='number'?number(item.actual):String(item.actual))+(item.unit||'')+' / '+item.operator+' '+(typeof item.threshold==='number'?number(item.threshold):String(item.threshold))+(item.unit||'')).join('；');}
 function mount(doc,options={}){
  const el=id=>doc?.getElementById('entry-opportunities'+(id?'-'+id:'')),env=doc?.defaultView||globalThis;
  if(!el(''))return null;
  const now=options.now||Date.now,listeners=[],cards=new Map();let state={data:null,scope:'research',loading:false,error:null,readAt:null},sequence=0,destroyed=false,controller=null;
  function text(tag,value,className){const node=doc.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
  function statsRow(label,stats){const row=text('div','','entry-opportunities-stats');row.append(text('span',label));for(const [label,value]of [['成熟触发样本',stats.sampleCount.toLocaleString('zh-CN')],['平均净变化',percent(stats.meanReturnPercent)],['中位净变化',percent(stats.medianReturnPercent)],['最差路径回撤',magnitude(stats.worstDrawdownPercent)]]){const cell=doc.createElement('span');cell.append(text('small',label),text('span',value));row.append(cell);}return row;}
  function drawChart(record){
   const {item,data,box}=record;box.replaceChildren();
   if(record.failed.has(record.window)){const message=text('p','本批当前图未能载入，价格与条件依据保留。','entry-opportunities-note'),retry=text('button','重试当前图','entry-opportunities-toggle');retry.type='button';retry.addEventListener('click',()=>{record.failed.delete(record.window);drawChart(record);});box.append(message,retry);return;}
   const image=doc.createElement('img');image.className='entry-current-chart';image.loading='lazy';image.decoding='async';image.alt=(item.name||item.code)+'：'+data.day+'收盘研究价、当前有效关键K、触发和失效参考位；不含旧买卖标记';image.src=item.chartUrls[record.window];image.addEventListener('error',()=>{if(cards.get(item.setupId)===record){record.failed.add(record.window);drawChart(record);}},{once:true});box.append(image);
  }
  function stockRow(item,data){
   const stale=!activeAt(item,now()),signature=JSON.stringify([binding(data),data.computedAt,item,stale]);let record=cards.get(item.setupId);
   if(record?.signature===signature)return record.row;
   const row=text('article','','entry-opportunities-stock'),title=text('h5','','entry-opportunities-stock-title'),link=text('a',(item.name||item.code)+' '+item.code);row.dataset.setupId=item.setupId;
   link.href='../chart.html?tvwidgetsymbol='+encodeURIComponent((item.code.endsWith('.SH')?'SSE:':'SZSE:')+item.code.slice(0,6));title.append(link,text('span',stale?'待更新 · 上次批次':item.stage==='waiting_breakout'&&!item.nearTrigger?'已确认 · 等待接近':stages[item.stage]));row.append(title,text('p',!item.nearTrigger?'已确认但距离触发位较远，尚非临近买点；等待价格接近，不提前标B。':item.qualified?'原两类门槛通过；收盘入场规则未独立验证。':'研究候选 · 条件名单，不是已验证买点。','entry-current-qualification'));
   const facts=text('dl','','entry-opportunities-facts');for(const [label,value]of [['前复权收盘研究价',number(item.closePrice)],['触发参考价','> '+number(item.trigger.above)],['失效参考价','< '+number(item.invalidation.below)],['距触发价',percent(item.distanceToTriggerPct)],['确认关键K',item.keyBarDay],['原验证状态',item.eligiblePatternIds.length?'原两类门槛通过':'原门槛未齐']]){const cell=doc.createElement('div');cell.append(text('dt',label),text('dd',value));facts.append(cell);}row.append(facts);
   const toolbar=text('div','','stock-signal-toolbar'),select=doc.createElement('select'),box=text('div','','entry-current-chart-box');toolbar.append(text('span','当前有效关键K · 非历史B/S'));
   select.setAttribute('aria-label',(item.name||item.code)+'当前图显示范围');for(const window of [60,120]){const option=text('option','近'+window+'个交易日');option.value=String(window);select.append(option);}select.value=String(record?.window||60);toolbar.append(select);row.append(toolbar,box);
   record={row,box,item,data,window:Number(select.value),signature,failed:new Set()};cards.set(item.setupId,record);select.addEventListener('change',()=>{const window=Number(select.value);if([60,120].includes(window)&&window!==record.window){record.window=window;drawChart(record);}});drawChart(record);
   row.append(text('p','数据日 '+data.day+' · 来源 '+stamp(data.asOf)+' · 读取 '+stamp(item.sourceFetchedAt),'entry-opportunities-source'),text('p',stale?'已超过 '+stamp(item.activeUntil)+' 重核时点，等待新日线；不能作为今日入场依据。':'下一开盘前 '+stamp(item.activeUntil)+' 须重核；'+(item.stage==='waiting_breakout'?'尚未触发，不提前标B。':'当日收盘触发，次日能否执行须重核。'),'entry-opportunities-note'));
   const detail=doc.createElement('details'),summary=text('summary','条件依据与未通过原因');detail.className='entry-current-evidence';detail.append(summary,text('p',item.reasons.join('；'),'entry-opportunities-note'),text('p','形成 '+item.formationDay+' · 可知 '+stamp(item.knownAfter)+' · 实际发现 '+stamp(item.actualDiscoveryAt)+' · 非实际委托报价，未核实成交。','entry-opportunities-source'));row.append(detail);return row;
  }
  function render(){
   const data=state.data,active=currentPool(data,state.scope,now()),allActive=currentPool(data,'research',now());el('scope').value=state.scope;el('retry').hidden=!state.error;el('retry').disabled=state.loading;
   const expired=data?data.current.filter(item=>!activeAt(item,now())&&(state.scope==='near'?item.nearTrigger:state.scope!=='qualified'||item.qualified)):[];
   const codes=new Set(allActive.map(item=>item.code)),nearCodes=new Set(allActive.filter(item=>item.nearTrigger).map(item=>item.code)),farCount=[...codes].filter(code=>!nearCodes.has(code)).length;
   el('status').textContent=data?'数据日 '+data.day+' · 有效候选 '+codes.size+' 只 · 接近触发 '+nearCodes.size+' 只 · 远距离 '+farCount+' 只 · 原两类门槛通过 '+new Set(allActive.filter(item=>item.eligiblePatternIds.length).map(item=>item.code)).size+' 只'+(expired.length?' · 待更新 '+new Set(expired.map(item=>item.code)).size+' 只':'')+(state.error?' · '+state.error:''):state.error||(state.loading?'正在读取已完成的收盘观察批次。':'等待已完成的收盘观察批次。');el('status').dataset.error=String(Boolean(state.error));
   el('source').textContent=data?'来源 '+data.sourceId+' · 来源时点 '+stamp(data.asOf)+' · 计算 '+stamp(data.computedAt)+' · 页面读取 '+stamp(state.readAt):'';
   el('selection').textContent=state.scope==='research'?'条件名单，不是已验证买点；展示仍在有效窗口的确认K与当日触发，远距离候选须等待接近。':state.scope==='near'?'仅显示触发价2%以内的有效条件；仍须次日重核，不代表已验证买点。':'仅保留同一形态通过原两类门槛的条件；收盘价入场规则仍未独立验证，不代表可直接买入。';
   const sections=[],wanted=new Set([...active,...expired].map(item=>item.setupId));for(const key of cards.keys())if(!wanted.has(key))cards.delete(key);
   const groups=[{stage:'waiting_breakout',near:true,label:stages.waiting_breakout},{stage:'triggered_at_close',near:true,label:stages.triggered_at_close},{stage:'waiting_breakout',near:false,label:'已确认 · 等待接近（尚非临近买点）'}];
   for(const group of groups){const items=active.filter(item=>item.stage===group.stage&&item.nearTrigger===group.near);if(!items.length)continue;const section=text('section','','entry-current-group');section.append(text('h5',group.label+' · '+items.length,'entry-current-group-heading'));for(const item of items)section.append(stockRow(item,data));sections.push(section);}
   if(!active.length)sections.push(text('p',data?state.scope==='qualified'?'本批暂无通过原两类门槛且仍有效的收盘观察。可切换研究候选；不使用旧B/S补齐。':state.scope==='near'?'本批暂无触发价2%以内的有效条件，可查看研究候选中的等待接近名单。':data.summary.reason+'；不以旧B/S填充当前名单。':'尚无完整收盘观察批次，不使用历史图或测试数据填充。','entry-opportunities-empty'));
   if(expired.length){const section=text('section','','entry-current-group entry-current-stale');section.append(text('h5','上次批次条件 · 待更新 '+expired.length,'entry-current-group-heading'));for(const item of expired)section.append(stockRow(item,data));sections.push(section);}el('list').replaceChildren(...sections);
   if(!data)return;
   el('method').textContent='以下为原T触发规则验证，不等于收盘价买入验证。'+(data.method?.returnLabel||'触发后第15个交易日收盘净变化')+'；'+(data.method?.drawdownLabel||'触发起收盘路径回撤')+'；'+(data.method?.costLabel||'费用与滑点假设见原验证口径')+'。距触发2%仅用于临近分组，收盘入场尚未独立验证。';
   const records=[];for(const item of data.patterns){const row=text('article','','entry-opportunities-record'),title=text('h5',item.label);title.append(text('small',statuses[item.status]));row.append(title,statsRow('最近120日',item.fit),statsRow('近期60日',item.recent),statsRow('样本外180日',item.validation),text('p',item.reasons.join('；')||'原T触发规则门槛通过。','entry-opportunities-note'));const diagnostic=diagnosticText(item.diagnostics);if(diagnostic)row.append(text('p',diagnostic,'entry-opportunities-diagnostic'));records.push(row);}el('records').replaceChildren(...records);
  }
  async function read(path,signal){const response=await env.fetch('/api/a-share-daily/'+path,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal});if(!response.ok)throw Error('收盘观察暂不可用（HTTP '+response.status+'），保留上次结果。');return response.json();}
  async function refresh(){
   if(destroyed)return;controller?.abort();const token=++sequence,active=new AbortController();controller=active;const timer=env.setTimeout(()=>active.abort(),30000);state={...state,loading:true};render();
   try{
    const meta=await read('state',active.signal),current=meta.lastSuccess;if(destroyed||token!==sequence)return;if(!meta.available||meta.scope!=='full-market'||!binding(current))throw Error('尚无完整全市场日线批次，保留上次结果。');
    const data=validate(await read('entry-current?generation='+encodeURIComponent(current.generation),active.signal),current);if(destroyed||token!==sequence)return;
    if(state.data&&(data.day<state.data.day||data.day===state.data.day&&Date.parse(data.computedAt)<Date.parse(state.data.computedAt)))throw Error('收盘观察日期或计算时间回退，保留上次结果。');
    state={...state,data,error:null,readAt:new Date(now()).toISOString()};
   }catch(error){if(!destroyed&&token===sequence)state={...state,error:error.name==='AbortError'?'收盘观察读取超时，保留上次结果。':error.name==='TypeError'?'收盘观察读取失败，保留上次结果。':error.message};}
   finally{env.clearTimeout(timer);if(!destroyed&&token===sequence){state={...state,loading:false};controller=null;render();}}
  }
  function listen(target,type,fn){target.addEventListener(type,fn);listeners.push([target,type,fn]);}
  listen(el('scope'),'change',()=>{state={...state,scope:['qualified','near'].includes(el('scope').value)?el('scope').value:'research'};render();});listen(el('retry'),'click',refresh);
  const interval=env.setInterval(()=>{if(!doc.hidden)refresh();},60000);
  function destroy(){if(destroyed)return;destroyed=true;sequence++;controller?.abort();cards.clear();env.clearInterval(interval);for(const [target,type,fn]of listeners)target.removeEventListener(type,fn);}
  listen(env,'pagehide',event=>{if(!event.persisted)destroy();});render();if(options.autoLoad!==false)refresh();return {refresh,destroy,getState:()=>state};
 }
 return {mount,validate,currentPool,diagnosticText};
});
