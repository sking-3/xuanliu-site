'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{root.BooksViprasolOpportunities=api;if(root.document)root.BooksViprasolOpportunitiesApp=api.mount(root.document);}
})(globalThis,()=>{
 const version='books.viprasol-a-share-next-open.2026-11-25.v1',familyId='viprasol-original-long-next-open-13',sourceCommit='a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0';
 const ruleIds=['tyson','ronaldo','double-tap-double-top-bottom','absorption-radar-pro','apex-trend-signal-engine','elite-flow-pro','equilibrium-confluence-engine','liquidity-hunt-pro','ma-confluence-engine','market-os','naive-bayes-order-flow','pressure-flow-pro','elite-advanced-pattern-scanner'];
 const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 const binding=value=>JSON.stringify([value?.generation,value?.day,value?.sourceId,value?.asOf]);
 const validBinding=value=>typeof value?.generation==='string'&&/^[0-9TZ-]{1,80}$/.test(value.generation)&&/^\d{4}-\d{2}-\d{2}$/.test(value.day||'')&&typeof value.sourceId==='string'&&value.sourceId&&validTime(value.asOf);
 const number=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:4}):'—';
 const percent=value=>Number.isFinite(value)?(value>0?'+':'')+value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
 const beijing=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const stamp=value=>validTime(value)?beijing.format(new Date(value))+'（北京）':'未提供';
 const fields={sampleCount:'样本数',stockCount:'股票数',signalDayCount:'触发日期数',meanReturnPercent:'平均净变化',meanExcessPercent:'平均超额变化',positiveRate:'正收益占比'};
 const scopes={fit:'最近120日',recent:'近期60日',validation:'样本外180日'};
 const reasons={native_review_allowlist_missing:'原生分支复核尚未获准',implementation_commit_unbound:'计算版本未绑定',native_scope_not_fully_reviewed:'原生覆盖未完整复核',native_source_parameters_or_version_mismatch:'原生来源或参数不符',native_implementation_commit_mismatch:'原生复核版本不符',native_long_branch_unobserved:'原生多向分支尚未覆盖',native_prefix_stability_unverified:'历史信号会随后续数据变化',volume_semantics_unknown_or_mismatched:'成交量单位未完成同口径核对',native_approval_time_unknown_or_future:'原生复核时间未核实',original_lastbar_branch_is_not_prefix_stable:'历史信号会随后续数据变化',no_original_long_signal_observed:'未取得可用原始多向信号',source_fetch_time_unknown_or_not_bound_to_closed_batch:'来源采集时间未与收盘批次绑定',synthetic_evaluator_not_native_evidence:'测试计算器不构成原生证据',history:'滚动历史不足',positive_folds:'通过的滚动窗口不足',independent_blocks:'独立时间锚点不足',familywise_13:'13项多重检验未通过'};
 function reasonLabel(value){const match=/^(fit|recent|validation)_(.+)$/.exec(value);return match&&fields[match[2]]?scopes[match[1]]+' · '+fields[match[2]]+'未达标':reasons[value]||value;}
 function diagnosticText(items){return items.filter(item=>item.passed===false).map(item=>reasonLabel(item.id)+'：'+(item.actual===null?'未取得':typeof item.actual==='number'?number(item.actual):String(item.actual))+' / '+item.operator+' '+(typeof item.threshold==='number'?number(item.threshold):String(item.threshold))).join('；');}
 function validate(value,current){
  if(!validBinding(current)||!validBinding(value)||binding(value)!==binding(current)||value.schema!=='books.a-share.viprasol-study.v1'||value.version!==version||value.familyId!==familyId||value.sourceCommit!==sourceCommit||value.completed!==true||value.datasetBound!==true||value.sourceDay!==value.day||!validTime(value.computedAt)||!validTime(value.servedAt)||Date.parse(value.computedAt)<Date.parse(value.asOf)||!Array.isArray(value.rules)||value.rules.length!==13||new Set(value.rules.map(rule=>rule.id)).size!==13||value.rules.some(rule=>!ruleIds.includes(rule.id))||!Array.isArray(value.current)||!Array.isArray(value.charts))throw Error('验证结果与收盘批次或固定规则不一致，保留上次结果。');
  const rules=new Map(value.rules.map(rule=>[rule.id,rule]));
  for(const rule of value.rules){
   if(typeof rule.title!=='string'||typeof rule.statisticalGatePassed!=='boolean'||typeof rule.nativeGate?.passed!=='boolean'||typeof rule.eligibleForSelection!=='boolean'||rule.eligibleForSelection&&(!rule.statisticalGatePassed||!rule.nativeGate.passed)||!Array.isArray(rule.reasons)||rule.reasons.some(reason=>typeof reason!=='string')||!Array.isArray(rule.diagnostics))throw Error('规则资格或未达标原因不完整。');
   for(const stats of [rule.fit,rule.recent,rule.validation])if(!Number.isInteger(stats?.sampleCount)||stats.sampleCount<0||['meanReturnPercent','meanExcessPercent','worstDrawdownPercent'].some(key=>stats[key]!==null&&!Number.isFinite(stats[key])))throw Error('规则样本、收益或回撤不完整。');
  }
  const seen=new Set();
  for(const item of value.current){
   const key=item.ruleId+':'+item.code,rule=rules.get(item.ruleId),live=item.eligibleForSelection===true&&validTime(item.activeUntil)&&Date.parse(item.activeUntil)>Date.parse(value.servedAt);
   if(seen.has(key)||!rule||!/^\d{6}\.(SH|SZ)$/.test(item.code||'')||binding(item)!==binding(value)||item.familyId!==familyId||item.signalDay!==value.day||item.stage!=='source_today_long_close'||item.actualFillVerified!==false||typeof item.eligibleForSelection!=='boolean'||item.eligibleForSelection&&!rule.eligibleForSelection||item.liveEligibleForSelection!==live||!Number.isFinite(item.closePrice)||item.closePrice<=0||!validTime(item.sourceFetchedAt)||!validTime(item.actualDiscoveryAt)||Date.parse(item.actualDiscoveryAt)>Date.parse(value.computedAt))throw Error('当前B点的来源、时点或资格不符。');
   if(item.eligibleForSelection){
    if(!/^[a-f0-9]{40}$/.test(value.implementationCommit||'')||!validTime(item.activeUntil)||![60,120].every(window=>{const path=item.ruleId+'-'+item.code+'-'+value.day+'-'+window+'.svg';return item.charts?.[window]===path&&value.charts.some(chart=>chart.ruleId===item.ruleId&&chart.code===item.code&&chart.window===window&&chart.path===path&&chart.day===value.day&&binding(chart)===binding(value));}))throw Error('当前B点的同批图表未完成。');
   }
   seen.add(key);
  }
  const expected={ruleCount:13,statisticalPassedCount:value.rules.filter(rule=>rule.statisticalGatePassed).length,nativeApprovedCount:value.rules.filter(rule=>rule.nativeGate.passed).length,effectiveCount:value.rules.filter(rule=>rule.eligibleForSelection).length,currentCount:value.current.length,qualifiedCurrentCount:value.current.filter(item=>item.eligibleForSelection).length};
  if(Object.entries(expected).some(([key,count])=>value.summary?.[key]!==count)||value.liveQualifiedCurrentCount!==value.current.filter(item=>item.liveEligibleForSelection).length)throw Error('验证汇总与逐条资格不一致。');
  return value;
 }
 const currentPool=(data,now=Date.now())=>data?data.current.filter(item=>item.eligibleForSelection&&item.liveEligibleForSelection&&Date.parse(item.activeUntil)>now):[];
 function chartUrl(data,item,window){return '/api/a-share-daily/viprasol-current-chart?'+new URLSearchParams({generation:data.generation,code:item.code,rule:item.ruleId,window:String(window)});}
 function mount(doc,options={}){
  const el=id=>doc?.getElementById('viprasol-opportunities'+(id?'-'+id:'')),env=doc?.defaultView||globalThis;
  if(!el(''))return null;
  const now=options.now||Date.now,cards=new Map();let state={data:null,error:null,loading:false,readAt:null},sequence=0,destroyed=false,controller=null,expiryTimer=null;
  function text(tag,value,className){const node=doc.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
  function statsRow(label,stats){const row=text('div','','entry-opportunities-stats');row.append(text('span',label));for(const [label,value]of [['成熟样本',number(stats.sampleCount)],['15日平均净变化',percent(stats.meanReturnPercent)],['平均超额变化',percent(stats.meanExcessPercent)],['最差路径回撤',Number.isFinite(stats.worstDrawdownPercent)?number(stats.worstDrawdownPercent)+'%':'—']]){const cell=doc.createElement('span');cell.append(text('small',label),text('span',value));row.append(cell);}return row;}
  function drawChart(record){
   record.box.replaceChildren();
   if(record.failed.has(record.window)){const retry=text('button','重试当前B图','entry-opportunities-toggle');retry.type='button';retry.addEventListener('click',()=>{record.failed.delete(record.window);drawChart(record);});record.box.append(text('p','同批当前图未载入，价格和时点保留。','entry-opportunities-note'),retry);return;}
   const image=doc.createElement('img');image.className='entry-current-chart';image.loading='lazy';image.decoding='async';image.alt=record.item.name+'：'+record.data.day+'收盘当前B点，归一化日K与原始参考位；不含历史B/S';image.src=chartUrl(record.data,record.item,record.window);image.addEventListener('error',()=>{if(cards.get(record.key)===record){record.failed.add(record.window);drawChart(record);}},{once:true});record.box.append(image);
  }
  function stockRow(item,data){
   const key=item.ruleId+':'+item.code,signature=JSON.stringify([data.generation,data.computedAt,item]);let record=cards.get(key);if(record?.signature===signature)return record.row;
   const row=text('article','','entry-opportunities-stock'),title=text('h5','','entry-opportunities-stock-title'),link=text('a',(item.name||item.code)+' '+item.code);link.href='../chart.html?tvwidgetsymbol='+encodeURIComponent((item.code.endsWith('.SH')?'SSE:':'SZSE:')+item.code.slice(0,6));title.append(link,text('span',data.rules.find(rule=>rule.id===item.ruleId).title));row.append(title);
   const facts=text('dl','','entry-opportunities-facts');for(const [label,value]of [['前复权收盘研究价',number(item.closePrice)],['原始失效参考',number(item.originalReference?.stop)],['原始目标参考',number(item.originalReference?.target)]]){const cell=doc.createElement('div');cell.append(text('dt',label),text('dd',value));facts.append(cell);}row.append(facts);
   const toolbar=text('div','','stock-signal-toolbar'),select=doc.createElement('select'),box=text('div','','entry-current-chart-box');toolbar.append(text('span','当日收盘B · 次日开盘前重核'));select.setAttribute('aria-label',(item.name||item.code)+'当前B图显示范围');for(const window of [60,120]){const option=text('option','近'+window+'个交易日');option.value=String(window);select.append(option);}select.value=String(record?.window||60);toolbar.append(select);row.append(toolbar,box);record={key,row,item,data,signature,window:Number(select.value),box,failed:new Set()};cards.set(key,record);select.addEventListener('change',()=>{const window=Number(select.value);if([60,120].includes(window)){record.window=window;drawChart(record);}});drawChart(record);
   row.append(text('p','数据日 '+data.day+' · 来源 '+stamp(data.asOf)+' · 采集 '+stamp(item.sourceFetchedAt)+' · 实际发现 '+stamp(item.actualDiscoveryAt),'entry-opportunities-source'),text('p','重核截止 '+stamp(item.activeUntil)+'；原始参考不代表委托或实际成交。','entry-opportunities-note'));return row;
  }
  function render(){
   env.clearTimeout(expiryTimer);expiryTimer=null;
   const data=state.data,pool=currentPool(data,now());el('retry').hidden=!state.error;el('retry').disabled=state.loading;
   if(pool.length){const until=Math.min(...pool.map(item=>Date.parse(item.activeUntil)));expiryTimer=env.setTimeout(()=>{expiryTimer=null;if(!destroyed)render();},Math.min(2147483647,Math.max(0,until-now())));}
   el('status').textContent=data?'数据日 '+data.day+' · 13类规则 · 统计通过 '+data.summary.statisticalPassedCount+' · 原生准入 '+data.summary.nativeApprovedCount+' · 当前合格B '+pool.length+(state.error?' · '+state.error:''):state.error||(state.loading?'正在读取已完成的全市场验证。':'等待已完成的全市场验证。');el('status').dataset.error=String(Boolean(state.error));
   el('source').textContent=data?'沪深主板名册 '+number(data.coverage?.universeCount)+'只 · '+data.sourceId+' · 来源 '+stamp(data.asOf)+' · 计算 '+stamp(data.computedAt)+' · 页面读取 '+stamp(state.readAt):'';
   const wanted=new Set(pool.map(item=>item.ruleId+':'+item.code));for(const key of cards.keys())if(!wanted.has(key))cards.delete(key);
   if(pool.length){const group=text('section','','entry-current-group');for(const item of pool)group.append(stockRow(item,data));el('list').replaceChildren(group);}else el('list').replaceChildren(text('p',data?'本批暂无同时通过原生核验、滚动统计和当前走强条件的B点。未达标原因见下方验证；不放宽门槛，不补入历史信号。':'尚无完整验证批次；可以重新读取，已有收盘观察不受影响。','entry-opportunities-empty'));
   if(!data)return;
   el('method').textContent='信号当日收盘后可知，下一实际交易日开盘起算，第15交易日收盘退出；净变化扣除0.30个百分点费用假设，回撤按收盘路径。120/60/180日分窗、15日隔离、13项多重检验门槛不变。使用当前名册回溯，存在幸存者偏差。';
   const records=data.rules.map(rule=>{const row=text('article','','entry-opportunities-record'),title=text('h5',rule.title);title.append(text('small',rule.eligibleForSelection?'通过全部门槛':rule.statisticalGatePassed?'统计通过 · 原生准入未齐':'未通过 · 停用'));row.append(title,statsRow('最近120日',rule.fit),statsRow('近期60日',rule.recent),statsRow('样本外180日',rule.validation),text('p',rule.reasons.map(reasonLabel).join('；')||'当前独立门槛通过。','entry-opportunities-note'));if(rule.counts?.missingDependencies)row.append(text('p','缺少必要依赖 '+number(rule.counts.missingDependencies)+'只；对应股票停用。','entry-opportunities-note'));const checks=diagnosticText(rule.diagnostics);if(checks)row.append(text('p',checks,'entry-opportunities-diagnostic'));return row;});el('records').replaceChildren(...records);
  }
  async function read(path,signal){const response=await env.fetch('/api/a-share-daily/'+path,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal});if(!response.ok)throw Error('验证读取失败（HTTP '+response.status+'），保留上次结果。');return response.json();}
  async function refresh(){
   if(destroyed)return;controller?.abort();const token=++sequence,active=new AbortController();controller=active;const timer=env.setTimeout(()=>active.abort(),30000);state={...state,loading:true};render();
   try{
    const meta=await read('state',active.signal),current=meta.lastSuccess;if(destroyed||token!==sequence)return;if(!meta.available||meta.scope!=='full-market'||!validBinding(current))throw Error('尚无完整全市场批次，保留上次结果。');
    const data=validate(await read('viprasol-study?generation='+encodeURIComponent(current.generation),active.signal),current);if(destroyed||token!==sequence)return;
    if(state.data&&(data.day<state.data.day||data.day===state.data.day&&Date.parse(data.computedAt)<Date.parse(state.data.computedAt)))throw Error('数据日或计算时间回退，保留上次结果。');
    state={...state,data,error:null,readAt:new Date(now()).toISOString()};
   }catch(error){if(!destroyed&&token===sequence)state={...state,error:error.name==='AbortError'?'验证读取超时，保留上次结果。':error.name==='TypeError'?'验证读取失败，保留上次结果。':error.message};}
   finally{env.clearTimeout(timer);if(!destroyed&&token===sequence){state={...state,loading:false};controller=null;render();}}
  }
  const retry=()=>refresh(),pagehide=event=>{if(!event.persisted)destroy();},resume=()=>{if(!destroyed&&!doc.hidden){render();refresh();}};el('retry').addEventListener('click',retry);env.addEventListener('pagehide',pagehide);env.addEventListener('pageshow',resume);doc.addEventListener('visibilitychange',resume);const interval=env.setInterval(()=>{if(!doc.hidden)refresh();},60000);
  function destroy(){if(destroyed)return;destroyed=true;sequence++;controller?.abort();cards.clear();env.clearInterval(interval);env.clearTimeout(expiryTimer);el('retry').removeEventListener('click',retry);env.removeEventListener('pagehide',pagehide);env.removeEventListener('pageshow',resume);doc.removeEventListener('visibilitychange',resume);}
  render();if(options.autoLoad!==false)refresh();return {refresh,destroy,getState:()=>state};
 }
 return {validate,currentPool,mount,chartUrl,reasonLabel,diagnosticText};
});
