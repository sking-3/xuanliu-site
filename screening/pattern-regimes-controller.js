'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{
  root.BooksPatternRegimes=api;
  const start=()=>{root.BooksPatternRegimesApp=api.mount(root.document);};
  if(root.document&&root.BooksTrendControllerApp)start();
  else if(root.document)root.addEventListener('books:trend-mounted',start,{once:true});
 }
})(globalThis,()=>{
 const schema='books.a-share.pattern-regimes.v1',statuses={effective:'近期有效',watch:'继续观察',insufficient:'样本不足',inactive:'近期未通过'};
 const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
 const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 const percent=value=>Number.isFinite(value)?(value>0?'+':'')+value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
 const magnitude=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
 const beijing=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const stamp=value=>time(value)?beijing.format(new Date(value))+'（北京）':'未提供';
 function diagnosticsText(values=[]){
  const display=value=>value===null?'未取得':typeof value==='number'?value.toLocaleString('zh-CN',{maximumFractionDigits:4}):String(value);
  return values.filter(item=>item.passed===false).map(item=>item.label+' '+display(item.actual)+(item.unit||'')+' / '+item.operator+' '+display(item.threshold)+(item.unit||'')).join('；');
 }
 function validate(value,current){
  if(value?.schema!==schema||!date(value.day)||!time(value.asOf)||!time(value.computedAt)||value.generation!==current.generation||value.day!==current.day||value.sourceId!==current.sourceId||!Array.isArray(value.patterns)||!Array.isArray(value.candidates)||value.benchmark?.code!=='000300.SH'||value.policy?.patternVersion!==current.patternVersion||value.policy?.lookback!==20||value.policy?.horizon!==15||value.policy?.targetReturnPercent!==5)throw Error('形态验证与当前日线批次或固定口径不一致，保留上次结果。');
  if(!value.patterns.length||['trainDays','recentDays','testDays','foldDays','purgeDays'].some(key=>!Number.isInteger(value.policy[key])||value.policy[key]<1)||['returnLabel','drawdownLabel','costLabel'].some(key=>typeof value.method?.[key]!=='string'))throw Error('形态验证口径或固定目录不完整，保留上次结果。');
  const ids=new Set(),codes=new Set();
  for(const item of value.patterns){
   if(typeof item.id!=='string'||ids.has(item.id)||typeof item.label!=='string'||!Object.hasOwn(statuses,item.status)||typeof item.recommended!=='boolean'||item.recommended!==(item.status==='effective')||!Array.isArray(item.reasons))throw Error('形态验证记录不完整，保留上次结果。');
   ids.add(item.id);
   for(const stats of [item.recent,item.validation])if(!stats||!Number.isInteger(stats.sampleCount)||stats.sampleCount<0||['medianReturnPercent','meanExcessPercent','worstDrawdownPercent'].some(key=>stats[key]!==null&&!Number.isFinite(stats[key])))throw Error('形态样本或收益统计不完整，保留上次结果。');
  }
  const effective=new Set(value.patterns.filter(item=>item.recommended).map(item=>item.id));
  for(const stock of value.candidates){
   if(!/^\d{6}\.(SH|SZ)$/.test(stock.code)||codes.has(stock.code)||!Array.isArray(stock.patternIds)||!stock.patternIds.length||stock.patternIds.some(id=>!effective.has(id))||!date(stock.formedAt))throw Error('形态候选与已验证形态不一致，保留上次结果。');
   codes.add(stock.code);
  }
  return value;
 }
 function mount(doc,options={}){
  const el=id=>doc.getElementById('pattern-regimes'+(id?'-'+id:''));if(!el(''))return null;
  const env=doc.defaultView||globalThis,app=options.app||env.BooksTrendControllerApp;
  if(!app?.setRegimeFilter)return null;
  let state={data:null,selected:'',loading:false,error:null,readAt:null},sequence=0,destroyed=false,controller=null;
  const listeners=[];
  function text(tag,content,className){const node=doc.createElement(tag);node.textContent=content;if(className)node.className=className;return node;}
  function statisticRow(label,stats){
   const row=doc.createElement('div');row.className='pattern-regimes-stat';row.append(text('span',label));
   const values=[['成熟样本',stats.sampleCount.toLocaleString('zh-CN')],['中位净变化',percent(stats.medianReturnPercent)],['平均超额',percent(stats.meanExcessPercent)],['最差路径回撤',magnitude(stats.worstDrawdownPercent)]];
   for(const [name,value]of values){const cell=doc.createElement('span');cell.append(text('small',name),text('span',value));row.append(cell);}
   return row;
  }
  function filterFor(data,selected){
   const patterns=data.patterns.filter(item=>item.recommended&&(selected==='*'||item.id===selected)),ids=new Set(patterns.map(item=>item.id));
   return {schema:'books.screening.pattern-filter.v1',generation:data.generation,sourceId:data.sourceId,day:data.day,benchmark:data.benchmark.code,lookback:data.policy.lookback,patternVersion:data.policy.patternVersion,patternId:selected,label:selected==='*'?'全部近期有效形态':patterns[0]?.label||'当前形态已失效',codes:data.candidates.filter(stock=>stock.patternIds.some(id=>ids.has(id))).map(stock=>stock.code)};
  }
  function select(selected){
   if(selected&&!state.data)return;
   const filter=selected?filterFor(state.data,selected):null;
   if(app.setRegimeFilter(filter)===false){state={...state,error:'当前日线批次尚未对齐，保留原筛选与形态结果。'};render();return;}
   state={...state,selected,error:null};render();
  }
  function render(){
   const data=state.data,effective=data?.patterns.filter(item=>item.recommended)||[];
   el('clear').setAttribute('aria-pressed',String(!state.selected));
   const count=value=>Number.isInteger(value)&&value>=0?value.toLocaleString('zh-CN'):'—';
   el('status').textContent=data?'已完成 '+data.patterns.length+' 类统计 · 覆盖 '+count(data.coverage?.readyCount)+'/'+count(data.coverage?.universeCount)+' 只 · '+effective.length+' 类通过'+(!effective.length?'，不推荐':'')+' · 当前候选 '+data.candidates.length+' 只'+(state.error?' · '+state.error:''):state.error||'正在读取已完成的形态验证。';
   el('status').dataset.error=String(Boolean(state.error));
   el('source').textContent=data?'数据日 '+data.day+' · 历史窗口 '+(data.coverage?.historyStart||'未提供')+' 至 '+(data.coverage?.historyEnd||'未提供')+' · 固定20日结构 / 15交易日观察 · 来源 '+data.sourceId+' · 来源时间 '+stamp(data.asOf)+' · 计算 '+stamp(data.computedAt)+' · 页面读取 '+stamp(state.readAt):'';
   const current=app.getState(),bound=data&&current.generation===data.generation&&current.day===data.day&&current.sourceId===data.sourceId&&current.lookback===data.policy.lookback&&current.reference?.code===data.benchmark.code;
   el('selection').textContent=state.selected?(bound?'下方股票按'+(state.selected==='*'?'全部近期有效形态':data.patterns.find(item=>item.id===state.selected)?.label||'已失效形态')+'筛选，并继续应用当前条件及15日剔除。':'形态筛选仅适用于同批次的20日 / 沪深300口径；当前下方保留常规筛选。'):data&&!effective.length?'当前无形态通过滚动验证，未启用推荐；下方保留常规筛选。':'';
   const buttons=[];
   if(effective.length){
    const all=text('button','全部近期有效形态');all.type='button';all.dataset.patternRegime='*';all.setAttribute('aria-pressed',String(state.selected==='*'));all.append(text('span','当前候选 '+data.candidates.length+' 只 · 与当前筛选条件取交集'));buttons.push(all);
    for(const item of effective){
     const candidateCount=data.candidates.filter(stock=>stock.patternIds.includes(item.id)).length;
     const button=text('button',item.label+' · 当前候选 '+candidateCount+' 只');button.type='button';button.dataset.patternRegime=item.id;button.setAttribute('aria-pressed',String(state.selected===item.id));
     button.append(text('span','近60日 '+item.recent.sampleCount+' 样本 · 中位净变化 '+percent(item.recent.medianReturnPercent)+' · 最差回撤 '+magnitude(item.recent.worstDrawdownPercent)),text('span','样本外180日 '+item.validation.sampleCount+' 样本 · 中位净变化 '+percent(item.validation.medianReturnPercent)+' · 最差回撤 '+magnitude(item.validation.worstDrawdownPercent)));
     buttons.push(button);
    }
   }
   el('options').replaceChildren(...buttons);
   if(!data)return;
   const policy=data.policy,method=data.method;
   el('method').textContent='近期统计只使用已满15交易日的信号；'+policy.trainDays+'日训练，隔离'+policy.purgeDays+'日，之后逐'+policy.foldDays+'日滚动检验，共'+policy.testDays+'日样本外。'+method.returnLabel+'；'+method.drawdownLabel+'；'+method.costLabel+'。'+(method.universeWarning||data.coverage?.warning||'');
   const rows=[];
   for(const item of data.patterns){
    const row=doc.createElement('article');row.className='pattern-regimes-record';
    const title=doc.createElement('div');title.className='pattern-regimes-record-title';title.append(text('strong',item.label),text('small',statuses[item.status]));
    row.append(title,statisticRow('近期'+policy.recentDays+'日',item.recent),statisticRow('样本外'+policy.testDays+'日',item.validation));
    row.append(text('p','近期信号 '+(item.recent.fromDay||'未提供')+' 至 '+(item.recent.toDay||'未提供')+' · 样本外 '+(item.validation.fromDay||'未提供')+' 至 '+(item.validation.toDay||'未提供'),'pattern-regimes-source'));
    row.append(text('p',item.reasons.join('；')||item.rule,'pattern-regimes-reason'));
    const failed=diagnosticsText(item.diagnostics);if(failed)row.append(text('p','未通过的实际值 / 原门槛：'+failed,'pattern-regimes-reason'));rows.push(row);
   }
   el('records').replaceChildren(...rows);
  }
  async function refresh(){
   if(destroyed||state.loading)return;
   const current=app.getState();if(!current.generation||!current.day||!current.sourceId)return;
   const token=++sequence;controller=new AbortController();const active=controller;
   const timer=env.setTimeout(()=>active.abort(),30000);state={...state,loading:true};
   try{
    const response=await env.fetch('/api/a-share-daily/patterns?generation='+encodeURIComponent(current.generation),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:active.signal});
    const value=await response.json();if(!response.ok)throw Error(value.message||'形态验证缓存暂不可用，保留上次结果。');
    const data=validate(value,current);if(destroyed||token!==sequence)return;
    const latest=app.getState();if(latest.generation!==data.generation||latest.day!==data.day||latest.sourceId!==data.sourceId)throw Error('读取期间日线批次已改变，保留上次结果，稍后自动检查。');
    if(state.data&&(data.day<state.data.day||data.day===state.data.day&&Date.parse(data.computedAt)<Date.parse(state.data.computedAt)))throw Error('形态验证时间早于已显示结果，拒绝回退。');
    if(state.selected&&app.setRegimeFilter(filterFor(data,state.selected))===false)throw Error('形态筛选未接受当前批次，保留上次结果。');
    state={...state,data,readAt:new Date().toISOString(),error:null};
   }catch(error){if(!destroyed&&token===sequence)state={...state,error:error.name==='AbortError'?'形态验证读取超时，保留上次结果。':error.name==='TypeError'?'形态验证读取失败，保留上次结果。':error.message};}
   finally{env.clearTimeout(timer);if(controller===active)controller=null;if(!destroyed&&token===sequence){state={...state,loading:false};render();}}
  }
  function listen(target,type,fn){target.addEventListener(type,fn);listeners.push([target,type,fn]);}
  listen(el('clear'),'click',()=>select(''));
  listen(el('options'),'click',event=>{const button=event.target.closest?.('[data-pattern-regime]');if(button)select(button.dataset.patternRegime);});
  listen(env,'books:trend-run-finished',()=>refresh());
  const interval=env.setInterval(()=>{if(!doc.hidden)refresh();},60000);
  function cleanup(){if(destroyed)return;destroyed=true;sequence++;controller?.abort();env.clearInterval(interval);for(const [target,type,fn]of listeners)target.removeEventListener(type,fn);}
  listen(env,'pagehide',event=>{if(!event.persisted)cleanup();});render();if(options.autoLoad!==false)refresh();
  return {refresh,select,getState:()=>state,destroy:cleanup};
 }
 return {mount,validate,diagnosticsText};
});
