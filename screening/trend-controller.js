'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{root.BooksTrendController=api;if(root.document)root.BooksTrendControllerApp=api.mount(root.document);}
})(globalThis,()=>{
 const names={market:'跟随大盘',similar:'形态相似',strength:'共同走强'};
 const indexNames={'000300.SH':'沪深300','000001.SH':'上证指数','399001.SZ':'深证成指'};
 const fixedIndices=new Set(Object.keys(indexNames));
 function sortRecords(records,mode){
  const field=mode==='similar'?'curveCorrelation':mode==='market'?'correlation':'periodReturn',priority=r=>r.result.status==='ready'?(r.result.matched?2:1):0;
  const value=r=>Number.isFinite(r.result.metrics?.[field])?r.result.metrics[field]:-Infinity;
  return records.slice().sort((a,b)=>priority(b)-priority(a)||value(b)-value(a)||a.stock.code.localeCompare(b.stock.code));
 }
 function wait(ms,signal){return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(Error('已停止'));return;}
  const stop=()=>{clearTimeout(timer);reject(Error('已停止'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);
  signal.addEventListener('abort',stop,{once:true});
 });}
 function resolveReference(value,rows){
  const query=String(value||'').trim(),upper=query.toUpperCase();
  const matches=(rows||[]).filter(r=>r.code===upper||r.code.split('.')[0]===query||r.name===query);
  return matches.length===1?{stock:matches[0]}:{reason:matches.length?'名称或代码不唯一，请输入完整证券代码。':'请填写行情名单中的股票名称或六位代码。'};
 }
 function createRunner({technical,engine,wait:pause=wait,now=Date.now,onUpdate=()=>{}}){
  const cache=new Map();let active=null,requested=false;
  let state={mode:null,status:'idle',records:[],total:0,requests:0,reason:''};
  function emit(){onUpdate({...state,records:state.records.slice()});}
  function cancel(reason='已停止'){if(active){active.abort();active=null;state.status='stopped';state.reason=reason;emit();}}
  function blocked(){const s=technical.sourceState();return s.status!=='idle'?s.reason||'日线来源已停止访问。':'';}
  async function run(options){
   cancel();const control=new AbortController();active=control;
   const {mode,lookback,day,asOf,reference,index=false}=options,stocks=(options.stocks||[]).filter(stock=>mode!=='similar'||stock.code.toUpperCase()!==reference?.code?.toUpperCase());
   state={mode,lookback,day,asOf,reference:reference?{code:reference.code,name:reference.name||indexNames[reference.code]||reference.code}:null,status:'running',records:[],total:stocks.length,requests:0,reason:'',startedAt:new Date(now()).toISOString()};
   const current=()=>active===control&&!control.signal.aborted;
   const deny=blocked();
   if(!Object.hasOwn(names,mode)||![20,60].includes(lookback)||!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!stocks.length||!reference||index&&!fixedIndices.has(reference?.code)){
    state.status='unavailable';state.reason=mode==='similar'&&reference&&!stocks.length?'参考股自身不参与比较，当前范围没有其他股票。':'筛选范围、交易日或对照对象尚未准备好。';active=null;emit();return state;
   }
   if(deny){state.status='stopped';state.reason=deny;active=null;emit();return state;}
   emit();
   async function history(stock,isIndex=false){
    const key=[asOf,day,isIndex?'index':'qfq',stock.code].join('/'),minBars=Math.max(lookback+1,26),cached=cache.get(key);
    if(cached&&cached.bars.length>=minBars)return cached;
    let reason=blocked();if(reason)return {status:'unavailable',sourceStopped:true,reason};
    if(requested)await pause(1500,control.signal);
    if(!current())throw Error('已停止');
    reason=blocked();if(reason)return {status:'unavailable',sourceStopped:true,reason};
    requested=true;state.requests++;emit();
    const result=await technical.history({...stock,asOf},day,control.signal,{minBars,index:isIndex});
    if(!current())throw Error('已停止');
    if(result.status==='ready'&&result.day===day&&Array.isArray(result.bars)&&result.bars.at(-1)?.date===day){
     const kept={...result,bars:result.bars.slice(-61)};if(cache.size>=6000)cache.delete(cache.keys().next().value);cache.set(key,kept);return kept;
    }
    return result;
   }
   try{
    let anchor=null;
    {
     anchor=await history(reference,index);
     if(!current())return state;
     if(anchor.status!=='ready'){
      state.status=anchor.sourceStopped?'stopped':'unavailable';state.reason=anchor.reason||'对照日线不足，未开始逐股筛选。';active=null;emit();return state;
     }
     state.referenceFetchedAt=anchor.fetchedAt||null;emit();
    }
    for(const stock of stocks){
     if(!current())break;
     let source;
     try{source=await history(stock);}catch(error){if(!current())break;source={status:'unavailable',reason:'日线请求未完成。'};}
     if(!current())break;
     if(source.sourceStopped){state.status='stopped';state.reason=source.reason||'来源限制访问，已停止。';active=null;emit();return state;}
     let result=source;
     if(source.status==='ready'){
      try{result=engine.evaluate({mode,bars:source.bars,referenceBars:anchor?.bars,lookback,day,code:stock.code,referenceCode:reference?.code});}
      catch{result={status:'unavailable',reason:'走势计算未完成。'};}
     }
     state.records.push({stock,result,fetchedAt:source.fetchedAt||null,sourceUrl:source.sourceUrl||null,referenceFetchedAt:anchor?.fetchedAt||null});emit();
    }
    if(current()){state.status='complete';active=null;emit();}
   }catch(error){if(current()){state.status='stopped';state.reason=blocked()||'读取已停止，已完成结果保留。';active=null;emit();}}
   return state;
  }
  return {run,cancel,getState:()=>({...state,records:state.records.slice()}),clear(){cancel();state={mode:null,status:'idle',records:[],total:0,requests:0,reason:''};emit();},cacheSize:()=>cache.size};
 }
 function mount(doc,options={}){
  const host=doc.getElementById('trend-screen');if(!host)return null;
  const env=doc.defaultView||globalThis,el=id=>doc.getElementById(id);
  const selection=()=>options.selection||env.BooksStockSelection,technical=options.technical||env.BooksTechnicalScreen,engine=options.engine||env.BooksTrendScreen;
  if(!technical||!engine)return null;
  const buttons=[...host.querySelectorAll('[data-trend-mode]')],listeners=[];let page=0,contextKey='',state={status:'idle',records:[],total:0,requests:0};
  const number=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:d}):'—';
  const pct=v=>Number.isFinite(v)?(v>0?'+':'')+number(v)+'%':'—';
  const stamp=v=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)):'未提供';
  function context(){return selection()?.getContext?.()||{};}
  function contextIdentity(c=context()){return JSON.stringify([c.day,c.asOf,(c.rows||[]).map(r=>r.code),(c.pageRows||[]).map(r=>r.code),(c.savedRows||[]).map(r=>r.code)]);}
  function rows(c=context()){
   const scope=el('trend-scope').value;
   return (scope==='page'?c.pageRows:scope==='saved'?c.savedRows:c.rows)||[];
  }
  function add(tr,text,label){const td=doc.createElement('td');td.textContent=text;if(label)td.dataset.label=label;tr.append(td);return td;}
  function render(){
   const c=context(),running=state.status==='running',source=technical.sourceState(),available=!!c.day&&rows(c).length>0&&source.status==='idle';
   for(const button of buttons){button.disabled=running||!available;button.setAttribute('aria-pressed',String(button.dataset.trendMode===state.mode));}
   el('trend-stop').hidden=!running;host.setAttribute('aria-busy',String(running));
   const counts={checked:state.records.length,matched:state.records.filter(r=>r.result.status==='ready'&&r.result.matched).length,missing:state.records.filter(r=>r.result.status!=='ready').length};
   const date=state.day||c.day||'未取得',fresh=c.freshness?.state==='historical'?'历史批次':'来源批次';
   const target=state.reference?` · ${state.mode==='strength'?'交易日对照':'对照'} ${state.reference.name} ${state.reference.code}`:'';
   const progress=state.mode?`${names[state.mode]}${target} · ${fresh} ${date} · 已核验 ${counts.checked}/${state.total} 只 · 命中 ${counts.matched} · 资料不足 ${counts.missing} · 本轮请求 ${state.requests}`:`${fresh} ${date} · 当前范围 ${rows(c).length} 只，选择一种走势开始。`;
   el('trend-status').textContent=progress+(source.status!=='idle'?' · '+source.reason:state.reason?' · '+state.reason:running?' · 逐只核验中':state.status==='complete'?' · 核验完成':'');
   el('trend-rules').textContent=state.mode==='market'?'日收益相关性 ≥ 0.65，同向交易日比例 ≥ 60%；跟随下跌也可能命中。':state.mode==='similar'?'日收益相关性 ≥ 0.65，归一化价格曲线相关性 ≥ 0.80，同向交易日比例 ≥ 60%。':state.mode==='strength'?'区间及近5日上涨，收盘 > MA20、MA5 > MA20、MA20较5日前上升；近5日均量 ≥ 此前20日均量的1.2倍。指数仅用于对齐交易日，不参与涨跌条件。':'三种筛选使用所选20或60个交易日；资料不足单列，不计为未命中。';
   el('trend-rules').textContent+=' 保持页面打开，逐股读取，可随时停止；本页已读日线会复用。';
   const ordered=sortRecords(state.records,state.mode),visible=el('trend-only-matches').checked?ordered.filter(r=>r.result.status==='ready'&&r.result.matched):ordered;
   page=Math.max(0,Math.min(page,Math.ceil(visible.length/20)-1));const body=el('trend-rows');body.replaceChildren();
   for(const record of visible.slice(page*20,page*20+20)){
    const {stock,result}=record,m=result.metrics||{},tr=doc.createElement('tr');tr.dataset.code=stock.code;tr.dataset.status=result.status;
    const name=add(tr,'','股票'),link=doc.createElement('a');link.href='../company-dossier.html?symbol='+encodeURIComponent(stock.code);link.textContent=stock.name+' '+stock.code;name.append(link);
    add(tr,number(state.mode==='similar'?m.curveCorrelation:m.correlation),'走势相关性');add(tr,Number.isFinite(m.directionAgreement)?number(m.directionAgreement*100)+'%':'—','同向比例');
    add(tr,pct(m.periodReturn),'区间涨跌');add(tr,Number.isFinite(m.volumeRatio)?number(m.volumeRatio)+'倍':'—','均量比');
    const details=result.status==='ready'?(result.matched?'命中':'未命中')+' · '+(result.reasons||[]).join('；'):result.reason||'资料不足';
    const anchor=state.reference?` · ${state.mode==='strength'?'交易日对照':'对照'} ${state.reference.name} ${state.reference.code} · 对照读取 ${stamp(record.referenceFetchedAt)}（北京）`:'';
    add(tr,details+` · 数据 ${m.startAt||'—'} 至 ${m.endAt||state.day||'—'} · 读取 ${stamp(record.fetchedAt)}（北京）`+anchor,'依据及时间');body.append(tr);
   }
   if(!body.children.length){const tr=doc.createElement('tr'),td=add(tr,state.records.length?'当前显示条件下暂无记录；可关闭“仅看命中”查看资料不足与未命中。':state.reason||'尚未运行走势筛选。');td.colSpan=6;body.append(tr);}
   el('trend-count').textContent=`显示 ${visible.length} 条 · 命中 ${counts.matched} · 资料不足 ${counts.missing}`;
   el('trend-page').textContent=visible.length?`${page+1} / ${Math.ceil(visible.length/20)}`:'0 / 0';el('trend-prev').disabled=page===0;el('trend-next').disabled=(page+1)*20>=visible.length;
  }
  const runner=createRunner({technical,engine,wait:options.wait,now:options.now,onUpdate:value=>{state=value;render();}});
  async function start(mode){
   const c=context(),lookback=Number(el('trend-lookback').value);let reference,index=false;
   if(mode!=='similar'){reference={code:el('trend-benchmark').value};index=true;}
   if(mode==='similar'){
    const found=resolveReference(el('trend-reference').value,c.allRows);
    if(!found.stock){state={...state,reason:found.reason};render();return;}
    reference=found.stock;
   }
   selection()?.stopTechnicalScan?.();page=0;
   return runner.run({mode,lookback,day:c.day,asOf:c.asOf,stocks:rows(c).slice(),reference,index});
  }
  function listen(target,name,fn){target.addEventListener(name,fn);listeners.push([target,name,fn]);}
  for(const button of buttons)listen(button,'click',()=>start(button.dataset.trendMode));
  for(const id of ['trend-lookback','trend-benchmark','trend-reference','trend-scope'])listen(el(id),'change',()=>{page=0;runner.clear();render();});
  listen(el('trend-only-matches'),'change',()=>{page=0;render();});listen(el('trend-prev'),'click',()=>{page--;render();});listen(el('trend-next'),'click',()=>{page++;render();});
  listen(el('trend-stop'),'click',()=>runner.cancel('已停止，已核验结果保留；再次点击可复用本页已读取日线。'));
  listen(env,'books:selection-changed',()=>{const key=contextIdentity();if(contextKey&&contextKey!==key){page=0;runner.clear();}contextKey=key;render();});
  listen(env,'books:technical-source-state',()=>{if(technical.sourceState().status!=='idle')runner.cancel(technical.sourceState().reason);render();});
  listen(env,'pagehide',()=>runner.cancel('页面已离开，筛选停止。'));
  contextKey=contextIdentity();render();return {start,render,runner,isRunning:()=>runner.getState().status==='running',destroy(){runner.cancel();for(const [target,name,fn]of listeners)target.removeEventListener(name,fn);}};
 }
 return {createRunner,mount,resolveReference,sortRecords,names};
});
