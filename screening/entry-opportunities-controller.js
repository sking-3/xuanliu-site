'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{
  root.BooksEntryOpportunities=api;
  const start=()=>{root.BooksEntryOpportunitiesApp=api.mount(root.document);};
  if(root.document&&root.BooksTrendControllerApp)start();
  else if(root.document)root.addEventListener('books:trend-mounted',start,{once:true});
 }
})(globalThis,()=>{
 const schema='books.a-share.entry-validation.v1',version='books.entry-validation.2026-11-24.v1',policyVersion='books.entry-bars.2026-11-24.v1';
 const statuses={effective:'通过独立验证',watch:'继续验证',insufficient:'样本不足',inactive:'近期未通过'};
 const pending=new Set(['waiting_confirmation','waiting_trigger']);
 const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
 const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 const number=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:4}):'—';
 const percent=value=>Number.isFinite(value)?(value>0?'+':'')+value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
 const magnitude=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
 const beijing=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const stamp=value=>time(value)?beijing.format(new Date(value))+'（北京）':'未提供';
 const binding=value=>value&&typeof value.generation==='string'&&value.generation&&day(value.day)&&typeof value.sourceId==='string'&&value.sourceId&&time(value.asOf)?JSON.stringify([value.generation,value.day,value.sourceId,value.asOf]):null;
 function localEvidence(path,current,code,chart=false){
  if(typeof path!=='string')return false;
  const url=new URL(path,'https://books.invalid');
  return path.startsWith('/api/a-share-daily/')&&url.origin==='https://books.invalid'&&!url.hash&&url.pathname==='/api/a-share-daily/'+(chart?'entry-chart':'entries')&&url.searchParams.get('generation')===current.generation&&url.searchParams.get('code')===code&&[...url.searchParams.keys()].length===(chart?3:2)&&(!chart||/^[012]$/.test(url.searchParams.get('setup')||''));
 }
 function validate(value,current){
  if(value?.schema!==schema||value.version!==version||value.entryPolicyVersion!==policyVersion||!binding(current)||binding(value)!==binding(current)||!time(value.computedAt)||value.benchmark?.code!=='000300.SH'||value.policy?.horizon!==15||value.policy?.targetReturnPercent!==5||!Array.isArray(value.patterns)||value.patterns.length!==16||!Array.isArray(value.current))throw Error('关键K独立验证与当前日线批次或固定规则不一致，保留上次结果。');
  const patterns=new Map();
  for(const item of value.patterns){
   if(typeof item.id!=='string'||patterns.has(item.id)||typeof item.label!=='string'||!Object.hasOwn(statuses,item.status)||typeof item.recommended!=='boolean'||item.recommended!==(item.status==='effective')||!Array.isArray(item.reasons)||item.reasons.some(reason=>typeof reason!=='string'))throw Error('关键K形态验证记录不完整，保留上次结果。');
   for(const stats of [item.fit,item.recent,item.validation])if(!stats||!Number.isInteger(stats.sampleCount)||stats.sampleCount<0||['meanReturnPercent','medianReturnPercent','worstDrawdownPercent'].some(key=>stats[key]!==null&&!Number.isFinite(stats[key])))throw Error('关键K触发后15日样本、收益或回撤不完整，保留上次结果。');
   patterns.set(item.id,item);
  }
  const setups=new Set();
  for(const item of value.current){
   if(!/^\d{6}\.(SH|SZ)$/.test(item.code)||!day(item.formationDay)||item.formationDay>value.day||item.setupId!==item.code+':'+item.formationDay||setups.has(item.setupId)||!pending.has(item.replayStatus)||!Array.isArray(item.patternIds)||!item.patternIds.length||item.patternIds.some(id=>!patterns.has(id))||!Array.isArray(item.reasons)||item.reasons.some(reason=>typeof reason!=='string')||['fresh','qualified','entryGatePassed','patternGatePassed'].some(key=>typeof item[key]!=='boolean'))throw Error('当前关键K日期、阶段或资格不完整，未采用返回结果。');
   setups.add(item.setupId);
   if(item.keyBarDay!==null&&(!day(item.keyBarDay)||item.keyBarDay<=item.formationDay||item.keyBarDay>value.day)||!Number.isFinite(item.invalidation?.below)||item.invalidation.below<=0||item.trigger!==null&&(!Number.isFinite(item.trigger?.above)||item.trigger.above<=item.invalidation.below)||item.replayStatus==='waiting_trigger'&&(!item.keyBarDay||!item.trigger)||item.knownAt!==null&&(!time(item.knownAt)||Date.parse(item.knownAt)>Date.parse(value.computedAt)))throw Error('当前关键K参考位或实际发现时间无效，未采用返回结果。');
   if(!localEvidence(item.evidenceUrl,value,item.code)||item.chartUrl!==null&&!localEvidence(item.chartUrl,value,item.code,true))throw Error('当前关键K图表或证据批次不一致，未加载返回链接。');
   if(item.fresh&&(item.monitoring?.status!=='future_condition_watch'||!day(item.monitoring.nextSessionDay)||item.monitoring.nextSessionDay<=value.day||item.monitoring.watchUntil!==item.monitoring.nextSessionDay+'T15:00:00+08:00'||!time(item.knownAt)||Date.parse(item.knownAt)>=Date.parse(item.monitoring.nextSessionDay+'T09:30:00+08:00')||Date.parse(value.computedAt)>=Date.parse(item.monitoring.nextSessionDay+'T09:30:00+08:00')||!Number.isInteger(item.monitoring.remainingSessions)||item.monitoring.remainingSessions<1||item.monitoring.remainingSessions>3))throw Error('当前关键K缺少有效的未来观察窗口，未采用返回结果。');
   if(item.qualified&&(!item.fresh||!item.entryGatePassed||!item.patternGatePassed||!Array.isArray(item.eligiblePatternIds)||!item.eligiblePatternIds.length||item.eligiblePatternIds.some(id=>!item.patternIds.includes(id)||!patterns.get(id)?.recommended)))throw Error('合格关键K未同时通过原形态和独立入场门槛，未采用返回结果。');
  }
  if(value.summary?.patternCount!==16||value.summary.candidateCount!==value.current.length||value.summary.qualifiedCount!==value.current.filter(item=>item.qualified).length||typeof value.summary.reason!=='string')throw Error('关键K观察汇总与逐项结果不一致，保留上次结果。');
  return value;
 }
 function freshAt(item,now){return item.fresh&&time(item.monitoring?.watchUntil)&&Date.parse(item.monitoring.watchUntil)>now;}
 function currentPool(data,scope,now=Date.now()){
  if(!data)return [];
  return data.current.filter(item=>scope==='research'?!item.qualified||!freshAt(item,now):item.qualified&&freshAt(item,now));
 }
 function diagnosticText(values=[]){
  return values.filter(item=>item.passed===false).map(item=>item.label+' '+(item.actual===null?'未取得':typeof item.actual==='number'?number(item.actual):String(item.actual))+(item.unit||'')+' / '+item.operator+' '+(typeof item.threshold==='number'?number(item.threshold):String(item.threshold))+(item.unit||'')).join('；');
 }
 function mount(doc,options={}){
  const el=id=>doc?.getElementById('entry-opportunities'+(id?'-'+id:'')),env=doc?.defaultView||globalThis,app=options.app||env.BooksTrendControllerApp;
  if(!el('')||!app?.getState)return null;
  const now=options.now||Date.now,listeners=[];let state={data:null,scope:'qualified',loading:false,error:null,readAt:null},sequence=0,destroyed=false,controller=null;
  const expanded=new Set(),details=new Map();
  function text(tag,content,className){const node=doc.createElement(tag);node.textContent=content;if(className)node.className=className;return node;}
  function stopDetails(){for(const item of details.values()){item.controller?.abort();item.sequence++;}details.clear();expanded.clear();}
  function statsRow(label,stats){
   const row=doc.createElement('div');row.className='entry-opportunities-stats';row.append(text('span',label));
   for(const [label,value]of [['成熟触发样本',stats.sampleCount.toLocaleString('zh-CN')],['平均净变化',percent(stats.meanReturnPercent)],['中位净变化',percent(stats.medianReturnPercent)],['最差路径回撤',magnitude(stats.worstDrawdownPercent)]]){const cell=doc.createElement('span');cell.append(text('small',label),text('span',value));row.append(cell);}
   return row;
  }
  function stockRow(item,data,bound){
   const row=doc.createElement('article');row.className='entry-opportunities-stock';row.dataset.setupId=item.setupId;
   const isFresh=bound&&freshAt(item,now()),title=text('h5','','entry-opportunities-stock-title'),link=text('a',(item.name||item.code)+' '+item.code);
   link.href='../chart.html?tvwidgetsymbol='+encodeURIComponent((item.code.endsWith('.SH')?'SSE:':'SZSE:')+item.code.slice(0,6));
   title.append(link,text('span',!isFresh?'需新收盘日线':item.replayStatus==='waiting_confirmation'?'等待收盘确认':'等待后日突破'));row.append(title);
   const facts=doc.createElement('dl');facts.className='entry-opportunities-facts';
   for(const [label,value]of [[item.keyBarDay?'确认关键K':'形成K',item.keyBarDay||item.formationDay],['突破参考位',item.trigger?'> '+number(item.trigger.above):'待确认'],['固定失效位','< '+number(item.invalidation.below)]]){const cell=doc.createElement('div');cell.append(text('dt',label),text('dd',value));facts.append(cell);}row.append(facts);
   row.append(text('p',item.qualified&&isFresh?'已通过原形态与独立入场验证，仅作条件观察。':'研究候选，未视为合格入场机会。','entry-opportunities-note'));
   row.append(text('p',item.reasons.join('；'),'entry-opportunities-note'));
   row.append(text('p',isFresh?'目标交易日 '+item.monitoring.nextSessionDay+' · 截至 '+stamp(item.monitoring.watchUntil)+' · 剩余 '+item.monitoring.remainingSessions+' 个交易日条件观察；盘中是否触发未核实。':'日线未更新或目标观察窗口已过，当前不可作为新入场机会。','entry-opportunities-note'));
   row.append(text('p','实际发现 '+stamp(item.knownAt),'entry-opportunities-source'));
   const button=text('button',expanded.has(item.setupId)?'收起关键K证据':'查看关键K与日线证据','entry-opportunities-toggle');button.type='button';button.dataset.entryOpportunity=item.setupId;button.setAttribute('aria-expanded',String(expanded.has(item.setupId)));button.disabled=!bound;row.append(button);
   if(expanded.has(item.setupId)){
    const detail=details.get(item.setupId);row.append(text('p',detail?.loading?'正在读取同批次关键K证据…':detail?.error||(detail?.data?'':'尚未读取关键K证据。'),'entry-opportunities-note'));
    if(detail?.data){
     const setup=detail.data.items.find(value=>value.id===item.setupId),chart=item.chartUrl||setup?.chartUrl;
     if(setup)row.append(text('p','F 形成 '+setup.formationDay+' · C 收盘确认 '+(setup.keyBarDay||'未形成')+' · '+setup.reason,'entry-opportunities-note'));
     if(chart&&!detail.failedChart){const image=doc.createElement('img');image.className='entry-opportunities-chart';image.alt=(item.name||item.code)+'关键K形成与确认日线证据';image.loading='lazy';image.decoding='async';image.src=chart;image.addEventListener('error',()=>{if(details.get(item.setupId)===detail){detail.failedChart=true;render();}},{once:true});row.append(image);}
     else row.append(text('p',detail.failedChart?'图表未载入；日期与参考位保留，可点击股票名称查看日K。':'本次逐股摘要没有该形成日图表；参考位与状态保留，可点击股票名称查看日K。','entry-opportunities-note'));
    }
   }
   return row;
  }
  function render(){
   const data=state.data,bound=data&&binding(data)===binding(app.getState()),active=bound?currentPool(data,'qualified',now()):[];
   el('scope').value=state.scope;el('retry').hidden=!state.error;el('retry').disabled=state.loading;
   el('status').textContent=data?'16 类独立验证 · 合格条件观察 '+active.length+' 个 · 研究候选 '+data.current.filter(item=>!item.qualified||!freshAt(item,now())).length+' 个'+(!bound?' · 旧批次仅保留查看，等待新批次对齐':'')+(state.error?' · '+state.error:''):state.error||(state.loading?'正在读取已完成的关键K独立验证。':'等待已完成的关键K独立验证。');
   el('status').dataset.error=String(Boolean(state.error));
   el('source').textContent=data?'数据日 '+data.day+' · 来源 '+data.sourceId+' · 来源时间 '+stamp(data.asOf)+' · 计算 '+stamp(data.computedAt)+' · 页面读取 '+stamp(state.readAt):'';
   el('selection').textContent=state.scope==='research'?'研究候选包括未通过门槛或等待新日线的形成窗口，不等于合格入场机会。':'只显示同时通过原形态、独立入场验证且观察窗口仍有效的条件机会；盘中触发与成交未核实。';
   const items=data?(state.scope==='qualified'?active:currentPool(data,'research',now())):[];
   el('list').replaceChildren(...(items.length?items.map(item=>stockRow(item,data,bound)):[text('p',data?state.scope==='qualified'?(data.summary.reason||'当前没有通过完整门槛且仍有效的观察机会。'):'当前没有符合初期转强与未明显拉升条件的研究候选。':'尚无已完成的关键K独立验证，不使用测试或历史回放填充当前机会。','entry-opportunities-empty')]));
   if(!data)return;
   el('method').textContent='与原固定形态次日开盘收益分开。'+(data.method?.returnLabel||'触发T后的第15个交易日收盘净变化估算')+'；'+(data.method?.drawdownLabel||'触发日至第15个后续交易日收盘路径回撤')+'；'+(data.method?.costLabel||'往返费用与滑点统一假设0.30个百分点')+'。'+(data.method?.excessLabel||'')+'；'+(data.method?.validationLabel||'')+'。未成熟、不可执行、顺序不明和重叠样本分别排除。';
   const records=[];
   for(const item of data.patterns){const row=doc.createElement('article');row.className='entry-opportunities-record';const title=text('h5',item.label);title.append(text('small',statuses[item.status]));row.append(title,statsRow('最近120日',item.fit),statsRow('近期60日',item.recent),statsRow('样本外180日',item.validation),text('p',item.reasons.join('；')||'独立验证门槛全部通过。','entry-opportunities-note'));
    const diagnostic=diagnosticText(item.diagnostics);if(diagnostic)row.append(text('p',diagnostic,'entry-opportunities-diagnostic'));records.push(row);}
   el('records').replaceChildren(...records);
  }
  async function refresh(){
   if(destroyed)return;
   const current=app.getState();if(!binding(current))return;
   if(state.loading&&controller?.binding===binding(current))return;
   controller?.abort();const token=++sequence,active=new AbortController();active.binding=binding(current);controller=active;const timer=env.setTimeout(()=>active.abort(),30000);state={...state,loading:true};render();
   try{
    const response=await env.fetch('/api/a-share-daily/entry-validation?generation='+encodeURIComponent(current.generation),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:active.signal});
    if(!response.ok)throw Error('关键K独立验证暂不可用（HTTP '+response.status+'），保留上次结果。');
    const data=validate(await response.json(),current);if(destroyed||token!==sequence||binding(app.getState())!==binding(data))return;
    if(state.data&&(data.day<state.data.day||data.day===state.data.day&&Date.parse(data.computedAt)<Date.parse(state.data.computedAt)))throw Error('关键K独立验证时间回退，保留上次结果。');
    if(!state.data||binding(state.data)!==binding(data))stopDetails();state={...state,data,error:null,readAt:new Date(now()).toISOString()};
   }catch(error){if(!destroyed&&token===sequence)state={...state,error:error.name==='AbortError'?'关键K独立验证读取超时，保留上次结果。':error.name==='TypeError'?'关键K独立验证读取失败，保留上次结果。':error.message};}
   finally{env.clearTimeout(timer);if(!destroyed&&token===sequence){state={...state,loading:false};controller=null;render();}}
  }
  async function loadDetail(item){
   const data=state.data;if(!data||binding(data)!==binding(app.getState()))return;
   const previous=details.get(item.setupId);if(previous?.loading||previous?.data)return;
   const detail={sequence:(previous?.sequence||0)+1,controller:new AbortController(),loading:true,data:null,error:null,failedChart:false};details.set(item.setupId,detail);const token=detail.sequence,timer=env.setTimeout(()=>detail.controller.abort(),30000);render();
   try{
    const response=await env.fetch(item.evidenceUrl,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:detail.controller.signal});if(!response.ok)throw Error('本批关键K证据暂不可用（HTTP '+response.status+'）。');
    const value=await response.json();if(value.schema!=='books.a-share.entry-evidence.v1'||binding(value)!==binding(data)||value.stock?.code!==item.code||!Array.isArray(value.items)||value.items.some((setup,index)=>setup.chartUrl!==null&&(!localEvidence(setup.chartUrl,data,item.code,true)||new URL(setup.chartUrl,'https://books.invalid').searchParams.get('setup')!==String(index))))throw Error('关键K证据与当前批次或股票不一致，未采用返回结果。');
    if(!destroyed&&details.get(item.setupId)===detail&&token===detail.sequence&&binding(state.data)===binding(data)&&binding(app.getState())===binding(data))detail.data=value;
   }catch(error){if(!destroyed&&details.get(item.setupId)===detail&&token===detail.sequence)detail.error=error.name==='AbortError'?'关键K证据读取超时，可收起后重新展开。':error.name==='TypeError'?'关键K证据读取失败，可收起后重新展开。':error.message;}
   finally{env.clearTimeout(timer);if(!destroyed&&details.get(item.setupId)===detail&&token===detail.sequence){detail.loading=false;detail.controller=null;render();}}
  }
  function listen(target,type,fn){target.addEventListener(type,fn);listeners.push([target,type,fn]);}
  listen(el('scope'),'change',()=>{state={...state,scope:el('scope').value==='research'?'research':'qualified'};render();});
  listen(el('retry'),'click',refresh);
  listen(el('list'),'click',event=>{const button=event.target.closest?.('[data-entry-opportunity]');if(!button||!state.data)return;const item=state.data.current.find(item=>item.setupId===button.dataset.entryOpportunity);if(!item)return;if(expanded.has(item.setupId)){expanded.delete(item.setupId);const detail=details.get(item.setupId);if(detail?.loading){detail.controller.abort();details.delete(item.setupId);}}else{expanded.add(item.setupId);loadDetail(item);}render();});
  listen(env,'books:trend-run-finished',refresh);const interval=env.setInterval(()=>{if(!doc.hidden)refresh();},60000);
  function destroy(){if(destroyed)return;destroyed=true;sequence++;controller?.abort();stopDetails();env.clearInterval(interval);for(const [target,type,fn]of listeners)target.removeEventListener(type,fn);}
  listen(env,'pagehide',event=>{if(!event.persisted)destroy();});render();if(options.autoLoad!==false)refresh();
  return {refresh,destroy,getState:()=>state};
 }
 return {mount,validate,currentPool,diagnosticText};
});
