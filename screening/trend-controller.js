'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{
  root.BooksTrendController=api;
  if(root.document){
   root.BooksTrendControllerApp=api.mount(root.document);
   if(root.BooksTrendControllerApp)root.dispatchEvent(new root.Event('books:trend-mounted'));
  }
 }
})(globalThis,()=>{
 const names={consensus:'市场共同走势',market:'跟随指数',strength:'初期转强'};
 const indexNames={'000300.SH':'沪深300','000001.SH':'上证指数','399001.SZ':'深证成指'};
 const fixedIndices=new Set(Object.keys(indexNames));
 function sortRecords(records,mode){
  const priority=r=>r.result.status==='ready'?(r.result.matched?3:r.result.excluded?1:2):0;
  const metric=r=>{const m=r.result.metrics||{};return mode==='strength'?-Math.abs(m.ma20Deviation??Infinity):(m.correlation??-Infinity);};
  return records.slice().sort((a,b)=>priority(b)-priority(a)||metric(b)-metric(a)||a.stock.code.localeCompare(b.stock.code));
 }
 function wait(ms,signal){return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(Error('已停止'));return;}
  const stop=()=>{clearTimeout(timer);reject(Error('已停止'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);
  signal.addEventListener('abort',stop,{once:true});
 });}
 const initial=()=>({mode:null,status:'idle',phase:null,records:[],total:0,requests:0,reason:'',consensus:null});
 function validLimits(limits={}){
  return typeof limits.enabled!=='boolean'||limits.enabled?['maxReturn20','maxReturn60','maxReturn5','maxDeviation','maxVolumeRatio'].every(k=>limits[k]===undefined||Number.isFinite(limits[k])&&limits[k]>=0&&limits[k]<=(k==='maxVolumeRatio'?100:1000)):true;
 }
 function stockMetadata(stock){
  const code=typeof stock?.code==='string'?stock.code:'';
  return {code,name:typeof stock?.name==='string'?stock.name:code,sector:typeof stock?.sector==='string'?stock.sector:'未分类',exchange:typeof stock?.exchange==='string'?stock.exchange:code.slice(-2)};
 }
 function sourceData(source,day){
  const reason=typeof source.reason==='string'?source.reason.replace(/https?:\/\/[^\s）)]+/gi,'[来源地址省略]').replace(/\b(cookie|authorization)\s*[:=][^\r\n]*/gi,'$1=[已隐藏]').replace(/\b(api[-_]?key|token|secret)\s*[:=]\s*[^\s;]+/gi,'$1=[已隐藏]').replace(/[<>\u0000-\u001f\u007f]/g,' ').slice(0,500).trim()||null:null;
  return {status:source.status,day:source.day||day,bars:Array.isArray(source.bars)?source.bars.slice(-61).map(b=>({date:b.date,close:b.close,volume:b.volume})):[],adjustment:source.adjustment||null,fetchedAt:source.fetchedAt||null,reason};
 }
 function createRunner({technical,engine,wait:pause=wait,now=Date.now,onUpdate=()=>{}}){
  const cache=new Map();let active=null,requested=false,state=initial(),dataset=null;
  function emit(){onUpdate({...state,records:state.records.slice()});}
  function blocked(){const s=technical.sourceState();return s.status!=='idle'?s.reason||'日线来源已停止访问。':'';}
  function cancel(reason='已停止'){if(active){active.abort();active=null;state.status='stopped';state.reason=reason+(state.mode==='consensus'?'；参考批次未完成，未判断市场共性。':'');emit();}}
  async function run(options={}){
   cancel();dataset=null;const control=new AbortController();active=control;
   const {mode,lookback,day,asOf,reference,limits={}}=options,marketRows=options.marketRows||[],size=options.sampleSize==='all'?Infinity:Number(options.sampleSize??120);
   let stocks=options.stocks||[];
   if(mode==='consensus'&&(size===Infinity||[120,240].includes(size)))stocks=engine.selectMarketSample(marketRows,size);
   state={...initial(),mode,lookback,day,asOf,limits:{...limits},reference:reference?{code:reference.code,name:indexNames[reference.code]||reference.code}:null,status:'running',phase:'collecting',total:stocks.length,marketUniverseCount:marketRows.length,fullMarket:size===Infinity,startedAt:new Date(now()).toISOString()};
   const current=()=>active===control&&!control.signal.aborted;
   if(!Object.hasOwn(names,mode)||![20,60].includes(lookback)||!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!stocks.length||!fixedIndices.has(reference?.code)||!validLimits(limits)||mode==='consensus'&&(!(size===Infinity||[120,240].includes(size))||stocks.length<30)){
    state.status='unavailable';state.reason=mode==='consensus'&&stocks.length<30?'市场参考池不足30只，不能把少数股票称为市场共同走势。':'筛选范围、交易日、指数日历或排除上限尚未准备好。';active=null;emit();return state;
   }
   const collected={schema:'books.research.dataset.v1',day,asOf,source:'tencent-public-history',reference:null,universe:marketRows.map(stockMetadata),records:[],expectedCount:stocks.length,totalUniverseCount:marketRows.length,completed:false,collectionStatus:'running',startedAt:state.startedAt,finishedAt:null};dataset=collected;
   const deny=blocked();if(deny){state.status='stopped';state.reason=deny;active=null;emit();return state;}emit();
   async function history(stock,isIndex=false){
    const denied=blocked();if(denied)return {status:'unavailable',sourceStopped:true,reason:denied};
    const key=[asOf,day,isIndex?'index':'qfq',stock.code].join('/'),minBars=Math.max(lookback+1,26),cached=cache.get(key);
    if(cached&&cached.bars.length>=minBars)return cached;
    if(requested)await pause(1500,control.signal);
    if(!current())throw Error('已停止');
    const reason=blocked();if(reason)return {status:'unavailable',sourceStopped:true,reason};
    requested=true;state.requests++;emit();
    const result=await technical.history({...stock,asOf},day,control.signal,{minBars,index:isIndex});
    if(!current())throw Error('已停止');
    if(result.status==='ready'&&result.day===day&&Array.isArray(result.bars)&&result.bars.at(-1)?.date===day){
     const kept={...result,bars:result.bars.slice(-61)};if(cache.size>=6000)cache.delete(cache.keys().next().value);cache.set(key,kept);return kept;
    }
    return result;
   }
   function evaluate(record,anchor,consensus){
    if(record.source.status!=='ready')return record.source;
    try{return engine.evaluate({mode,bars:record.source.bars,referenceBars:anchor.bars,lookback,day,code:record.stock.code,referenceCode:reference.code,consensus,limits});}
    catch{return {status:'unavailable',matched:null,reason:'走势计算未完成。'};}
   }
   try{
    const anchor=await history(reference,true);if(!current())return state;
    if(anchor.status!=='ready'){state.status=anchor.sourceStopped?'stopped':'unavailable';state.reason=anchor.reason||'交易日日历不足，未开始逐股读取。';active=null;emit();return state;}
    const anchorData=sourceData(anchor,day);collected.reference={code:reference.code,bars:anchorData.bars,fetchedAt:anchorData.fetchedAt,adjustment:anchorData.adjustment};
    state.referenceFetchedAt=anchor.fetchedAt||null;emit();
    for(const stock of stocks){
     if(!current())return state;let source;
     try{source=await history(stock);}catch{if(!current())return state;source={status:'unavailable',reason:'日线请求未完成。'};}
     if(!current())return state;
     if(source.sourceStopped){state.status='stopped';state.reason=(source.reason||'来源限制访问，已停止。')+(mode==='consensus'?'；未完成参考批次，未判断市场共性。':'');active=null;emit();return state;}
     collected.records.push({stock:stockMetadata(stock),source:sourceData(source,day)});
     const record={stock,source,fetchedAt:source.fetchedAt||null,sourceUrl:source.sourceUrl||null,referenceFetchedAt:anchor.fetchedAt||null};
     record.result=mode==='consensus'&&source.status==='ready'?{status:'pending',matched:null,reason:'等候完整参考批次后计算共性。'}:evaluate(record,anchor,null);
     state.records.push(record);emit();
    }
    if(!current())return state;
    if(mode==='consensus'){
     state.consensus=engine.buildConsensus({records:state.records.filter(r=>r.source.status==='ready').map(r=>({stock:r.stock,bars:r.source.bars})),calendar:anchor.bars,lookback,day,expectedCount:stocks.length,totalUniverseCount:marketRows.length});
     state.phase='evaluated';
     const times=state.records.map(r=>r.fetchedAt).filter(Boolean).sort();state.poolFetchedStart=times[0]||null;state.poolFetchedEnd=times.at(-1)||null;
     for(const record of state.records)record.result=state.consensus.status==='ready'?evaluate(record,anchor,state.consensus):{status:'unavailable',matched:null,reason:state.consensus.reason||'参考池覆盖不足，暂不判断共性。'};
     state.reason=state.consensus.reason||'';
     state.status=state.consensus.status==='ready'?'complete':'unavailable';
    }else{state.phase='evaluated';state.status='complete';}
    state.finishedAt=new Date(now()).toISOString();collected.finishedAt=state.finishedAt;collected.completed=true;collected.collectionStatus='complete';active=null;emit();
   }catch{if(current()){state.status='stopped';state.reason=(blocked()||'读取已停止，已完成结果保留。')+(mode==='consensus'?'；未判断市场共性。':'');active=null;emit();}}
   return state;
  }
  function getExportStatus(){
   if(active)return {available:false,reason:'本轮仍在读取，完成完整批次后才能导出。'};
   const denied=blocked();if(denied)return {available:false,reason:denied};
   if(state.status==='stopped')return {available:false,reason:state.reason||'本轮已停止，不能导出未完成批次。'};
   if(!dataset?.completed||dataset.collectionStatus!=='complete'||!['complete','unavailable'].includes(state.status))return {available:false,reason:state.reason||'尚无完整采集批次，请先完成一轮读取。'};
   const codes=new Set(dataset.universe.map(s=>s.code)),records=dataset.records;
   if(!dataset.reference||dataset.reference.adjustment!=='index')return {available:false,reason:'指数日历资料不完整或口径未确认，不能导出。'};
   if(codes.size!==dataset.totalUniverseCount)return {available:false,reason:'参考股票池存在重复或数量不符，不能导出。'};
   if(records.length!==dataset.expectedCount||new Set(records.map(r=>r.stock.code)).size!==records.length)return {available:false,reason:'请求记录与计划数量不符或存在重复，不能导出。'};
   if(records.some(r=>!codes.has(r.stock.code)))return {available:false,reason:'所选股票包含当前参考股票池之外的证券，请调整范围后重新读取。'};
   if(records.some(r=>r.source.status==='ready'&&r.source.adjustment!=='qfq'))return {available:false,reason:'个股前复权口径未确认，不能导出。'};
   return {available:true,reason:''};
  }
  function exportDataset(){
   if(!getExportStatus().available)return null;
   return JSON.parse(JSON.stringify(dataset));
  }
  return {run,cancel,exportDataset,getExportStatus,getState:()=>({...state,records:state.records.slice()}),clear(){cancel();dataset=null;state=initial();emit();},cacheSize:()=>cache.size};
 }
 function createCachedRunner({env,engine,model,onUpdate=()=>{}}){
  const cache=new Map();let state=initial(),base=null,settings=null,desiredSettings=null,active=null,raw=null,rawRequest=null,metadata=null,lastCompleted=null,pollRequest=null,epoch=0;
  const emit=()=>onUpdate({...state,records:state.records.slice()});
  const key=s=>[s.mode,s.lookback,s.mode==='consensus'?s.sampleSize:'all',s.reference.code].join('/');
  function cancel(reason='已停止读取本站缓存。'){
   epoch++;
   if(pollRequest){pollRequest.abort();pollRequest=null;}
   if(active){active.abort();active=null;state={...state,status:'stopped',reason};emit();}
   if(rawRequest){rawRequest.abort();rawRequest=null;}
  }
  async function read(path,signal){
   const response=await env.fetch('/api/a-share-daily/'+path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
   const value=await response.json();if(!response.ok)throw Error(value.message||value.error||'本站日终缓存暂不可用');return value;
  }
  function view(){
   if(!base)return;
   const available=new Map(base.records.map(record=>[record.stock.code,record]));
   const full=settings.mode==='consensus'||settings.stocks===null;
   const selected=full?base.records:settings.stocks.map(stock=>available.get(stock.code)||{stock,result:{status:'unavailable',matched:null,reason:'本批日终缓存尚未覆盖该股票。'},fetchedAt:null,referenceFetchedAt:base.referenceFetchedAt});
   const uncovered=full?0:settings.stocks.filter(stock=>!available.has(stock.code)).length;
   state={...base,origin:'daily-cache',phase:'evaluated',limits:{...settings.limits},records:selected.map(record=>({...record,result:engine.applyLimits(record.result,settings.limits,settings.lookback)})),total:selected.length,lastSuccess:metadata?.lastSuccess||null,attempt:metadata?.attempt||null,scopeUncovered:uncovered};
   if(uncovered){state.status='unavailable';state.reason='所选范围有 '+uncovered+' 只未被本批日终缓存覆盖，已单列为资料不足。';}
   if(!selected.length&&settings.mode!=='consensus'){state.status='unavailable';state.reason='当前范围没有股票；可调整筛选条件或自选名单。';}
   lastCompleted={base,settings,raw,state};
   emit();
  }
  async function run(options,knownMetadata){
   cancel();base=null;raw=null;settings={...options,stocks:options.stocks===null?null:options.stocks.slice(),limits:{...options.limits}};desiredSettings=settings;
   const control=new AbortController(),requestedMode=settings.mode;active=control;state={...initial(),origin:'daily-cache',mode:settings.mode,lookback:settings.lookback,status:'running',phase:'loading',reason:'正在读取本站已完成的日终缓存。',lastSuccess:metadata?.lastSuccess||null};emit();
   try{
    metadata=knownMetadata||await read('state',control.signal);if(active!==control)return state;
    if(!metadata.available)throw Error(metadata.attempt?.error||'本站尚无完整日终批次；后台完成后才能展示。');
    const generation=metadata.lastSuccess?.generation;if(!generation)throw Error('本站完整批次标识缺失。');
    const cached=cache.get(key(settings));
    let next=cached&&cached.generation===metadata.lastSuccess?.generation?cached:null;
    if(!next){
     const query=new URLSearchParams({mode:settings.mode,lookback:settings.lookback,sampleSize:settings.mode==='consensus'?settings.sampleSize:'all',benchmark:settings.reference.code,generation});
     next=await read('result?'+query,control.signal);if(active!==control)return state;
     if(!['complete','unavailable'].includes(next.status)||next.mode!==settings.mode||next.lookback!==settings.lookback||next.reference?.code!==settings.reference.code||next.generation!==generation||!Array.isArray(next.records)||next.limits?.enabled!==false)throw Error('本站缓存与所选模式、周期、批次或原始参数不符。');
     cache.set(key(settings),next);
    }
    base=next;active=null;view();
   }catch(error){
    if(active===control||!active&&state.status==='running'){
     active=null;
     if(lastCompleted){
      base=lastCompleted.base;settings=lastCompleted.settings;raw=lastCompleted.raw;
      state={...lastCompleted.state,status:'unavailable',cacheReadFailed:true,attemptedMode:requestedMode,reason:'读取'+names[requestedMode]+'缓存失败：'+error.message+'；保留'+names[base.mode]+' '+base.day+' 上次结果。',lastSuccess:metadata?.lastSuccess||null,attempt:metadata?.attempt||null};
     }else state={...state,status:'unavailable',reason:error.message,lastSuccess:metadata?.lastSuccess||null,attempt:metadata?.attempt||null,records:[]};
     emit();
    }
   }
   return state;
  }
  async function refreshIfChanged(){
   if(active||pollRequest||!settings||state.status==='stopped')return state;
   const control=new AbortController(),startedEpoch=epoch;pollRequest=control;
   try{
    const next=await read('state',control.signal);
    if(pollRequest!==control||epoch!==startedEpoch)return state;
    metadata=next;pollRequest=null;
    if(next.available&&next.lastSuccess?.generation&&base?.generation!==next.lastSuccess.generation)return run(desiredSettings,next);
    state={...state,lastSuccess:next.lastSuccess||null,attempt:next.attempt||null};
    if(!base)state.reason=next.attempt?.error||'本站尚无完整日终批次；后台完成后自动显示。';
    emit();
   }catch(error){
    if(pollRequest===control&&epoch===startedEpoch){pollRequest=null;state={...state,reason:'本站状态检查失败：'+error.message+'；已载入结果和数据时间保留。'};emit();}
   }
   return state;
  }
  function reapply(changes){
   if(!settings)return;desiredSettings={...desiredSettings,...changes};
   if(state.cacheReadFailed)return run(desiredSettings);
   settings={...settings,...changes};
   if(base&&!active){try{view();}catch(error){state={...state,status:'unavailable',records:[],reason:error.message};emit();}}
  }
  function getExportStatus(){
   if(active)return {available:false,reason:'正在读取本站结果，请等待完成。'};
   if(!base||!['complete','unavailable'].includes(state.status))return {available:false,reason:state.reason||'尚无可导出的完整本站批次。'};
   if(state.scopeUncovered)return {available:false,reason:'所选范围包含缓存之外的股票，请调整范围后再导出。'};
   if(rawRequest)return {available:false,reason:'正在读取同代原始归档。'};
   if(!raw)return {available:false,reason:'原始归档尚未载入，点击导出或保存后从本站读取。'};
   return {available:true,reason:''};
  }
  async function loadDataset(){
   if(active||!base||state.status==='stopped'||state.scopeUncovered)throw Error(getExportStatus().reason);
   if(raw)return raw;
   if(rawRequest)throw Error('原始归档正在读取，请等待完成。');
   const control=new AbortController(),generation=base.generation;rawRequest=control;
   try{
    const query=new URLSearchParams({sampleSize:settings.mode==='consensus'?settings.sampleSize:'all',benchmark:settings.reference.code,generation});
    const value=await read('dataset?'+query,control.signal);
    if(rawRequest!==control||base?.generation!==generation)throw Error('显示批次已改变，请重新导出当前归档。');
    const checked=model.normalizeDataset(value);
    const codes=new Set(checked.records.map(record=>record.stock.code));
    if(checked.day!==base.day||checked.asOf!==base.asOf||checked.reference.code!==base.reference.code||checked.expectedCount!==base.records.length||base.records.some(record=>!codes.has(record.stock.code)))throw Error('原始归档与当前显示批次不一致。');
    raw=checked;if(lastCompleted?.base===base)lastCompleted.raw=raw;return raw;
   }finally{if(rawRequest===control)rawRequest=null;}
  }
  return {run,reapply,cancel,refreshIfChanged,loadDataset,getExportStatus,exportDataset(){return getExportStatus().available?JSON.parse(JSON.stringify(raw)):null;},getState:()=>({...state,records:state.records.slice()}),clear(){cancel();base=null;raw=null;lastCompleted=null;settings=null;desiredSettings=null;state=initial();emit();},cacheSize:()=>cache.size};
 }
 function mount(doc,options={}){
  const host=doc.getElementById('trend-screen');if(!host)return null;
  const env=doc.defaultView||globalThis,el=id=>doc.getElementById(id);
  const engine=options.engine||env.BooksTrendScreen,model=options.model||env.BooksControlModel;
  if(!engine||!model)return null;
  const charts=(options.charts||env.BooksStockCharts).create({document:doc,env});
  const buttons=[...host.querySelectorAll('[data-trend-mode]')],listeners=[],cards=new Map(),body=el('trend-results');
  let configuration=model.normalizeConfig(options.configuration||model.DEFAULT_CONFIG);
  let state=initial(),page=0,selectedMode=configuration.settings.mode,marketGeneration=null,contextKey='',interacted=false,configurationApplied=false,destroyed=false,displayed=null;
  const empty=doc.createElement('p');empty.className='trend-empty';body.replaceChildren(empty);
  el('trend-lookback').value=String(configuration.settings.lookback);
  const context=()=>((options.selection||env.BooksStockSelection)?.getContext?.()||{});
  const stocks=()=>{const c=context();return c.day?(c.rows||[]).slice():null;};
  const identity=()=>{const c=context();return JSON.stringify([c.day,c.asOf,(c.rows||[]).map(row=>row.code)]);};
  const percentage=value=>Number.isFinite(value)?(value>0?'+':'')+value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
  function card(stock){
   const article=doc.createElement('article'),heading=doc.createElement('header'),title=doc.createElement('h4');
   const name=doc.createElement('a'),code=doc.createElement('span'),change=doc.createElement('div'),value=doc.createElement('span'),period=doc.createElement('span'),chart=doc.createElement('div');
   article.className='trend-stock';article.dataset.code=stock.code;article.setAttribute('role','listitem');
   heading.className='trend-stock-heading';name.className='trend-stock-name';code.className='trend-stock-code';
   change.className='trend-stock-change';period.className='trend-stock-period';chart.className='trend-stock-chart';
   const symbol=/^(\d{6})\.(SH|SZ)$/.exec(stock.code);
   if(symbol)name.href='../chart.html?tvwidgetsymbol='+encodeURIComponent((symbol[2]==='SH'?'SSE:':'SZSE:')+symbol[1]);
   title.append(name,code);change.append(value,period);heading.append(title,change);article.append(heading,chart);
   return {article,name,code,value,period,chart};
  }
  function render(){
   const lookback=Number(el('trend-lookback').value),matching=state.mode===selectedMode&&state.lookback===lookback;
   const completed=matching&&state.generation&&state.phase==='evaluated'&&(!state.records.length||state.records.some(record=>record.result.status==='ready'));
   const refreshing=state.status==='running'&&displayed?.mode===selectedMode&&displayed.lookback===lookback;
   let visible=[];
   if(completed){
    visible=sortRecords(state.records.filter(record=>record.result.status==='ready'&&record.result.matched),selectedMode);
    displayed={mode:selectedMode,lookback,day:state.day,records:visible};
   }else if(refreshing)visible=displayed.records;
   const show=completed||refreshing;
   for(const button of buttons){button.disabled=false;button.setAttribute('aria-pressed',String(button.dataset.trendMode===selectedMode));}
   host.setAttribute('aria-busy',String(state.status==='running'));
   const old=refreshing||state.cacheReadFailed||Boolean(state.attempt?.error);
   el('trend-status').textContent=show?'数据日 '+displayed.day+(old?' · 上次成功结果':''):'';
   el('trend-count').textContent=show?visible.length+' 只':'';
   const pages=Math.ceil(visible.length/4);page=Math.max(0,Math.min(page,pages-1));
   const records=visible.slice(page*4,page*4+4),wanted=new Set(records.map(record=>record.stock.code));
   for(const [code,item]of cards)if(!wanted.has(code)){charts.dispose(item.chart);item.article.remove();cards.delete(code);}
   if(!records.length){
    empty.textContent=show?'没有符合条件的股票':'暂无已完成的筛选结果';
    if(body.children.length!==1||body.children[0]!==empty)body.replaceChildren(empty);
   }else{
    empty.remove();
    records.forEach((record,index)=>{
     let item=cards.get(record.stock.code),created=false;
     if(!item){item=card(record.stock);cards.set(record.stock.code,item);created=true;}
     item.name.textContent=record.stock.name;item.code.textContent=record.stock.code;
     const value=record.result.metrics?.periodReturn;
     item.value.textContent=percentage(value);item.value.className=value>0?'change-up':value<0?'change-down':'';
     item.period.textContent=lookback+'日涨跌';
     if(body.children[index]!==item.article)body.insertBefore(item.article,body.children[index]||null);
     if(created)charts.observe(item.chart,record.stock);
    });
   }
   el('trend-pagination').hidden=pages<=1;el('trend-page').textContent=pages?(page+1)+' / '+pages:'';
   el('trend-prev').disabled=page===0;el('trend-next').disabled=(page+1)*4>=visible.length;
  }
  const runner=createCachedRunner({env,engine,model,onUpdate:value=>{
   const finished=state.status==='running'&&value.status!=='running';state=value;render();
   if(finished&&typeof env.CustomEvent==='function')env.dispatchEvent(new env.CustomEvent('books:trend-run-finished',{detail:{status:state.status,mode:state.mode,day:state.day,startedAt:state.startedAt,finishedAt:state.finishedAt||null}}));
   if(state.generation&&state.phase==='evaluated'&&!state.cacheReadFailed&&state.generation!==marketGeneration&&typeof env.CustomEvent==='function'){
    marketGeneration=state.generation;env.dispatchEvent(new env.CustomEvent('books:refresh-selection',{detail:{generation:state.generation}}));
   }
  }});
  async function start(mode){
   if(destroyed)return runner.getState();
   selectedMode=mode;page=0;
   (options.selection||env.BooksStockSelection)?.stopTechnicalScan?.();
   const settings=configuration.settings;
   return runner.run({mode,lookback:Number(el('trend-lookback').value),stocks:stocks(),sampleSize:settings.sampleSize,reference:{code:settings.benchmark},limits:settings.limits});
  }
  function applyConfiguration(value){
   if(interacted||configurationApplied||destroyed)return false;
   configuration=model.normalizeConfig(value);configurationApplied=true;
   el('trend-lookback').value=String(configuration.settings.lookback);start(configuration.settings.mode);return true;
  }
  function listen(target,type,handler){target.addEventListener(type,handler);listeners.push([target,type,handler]);}
  for(const button of buttons)listen(button,'click',()=>{interacted=true;start(button.dataset.trendMode);});
  listen(el('trend-lookback'),'change',()=>{interacted=true;start(selectedMode);});
  listen(el('trend-prev'),'click',()=>{page--;render();});listen(el('trend-next'),'click',()=>{page++;render();});
  listen(env,'books:selection-changed',()=>{
   const next=identity();if(next!==contextKey){contextKey=next;page=0;runner.reapply({stocks:stocks()});}else render();
  });
  const pollTimer=env.setInterval(()=>{if(!doc.hidden)runner.refreshIfChanged();},60000);
  function cleanup(){
   if(destroyed)return;destroyed=true;env.clearInterval(pollTimer);runner.cancel('页面已离开，缓存读取停止。');charts.destroy();cards.clear();
  }
  listen(env,'pagehide',event=>{if(!event.persisted)cleanup();});contextKey=identity();render();
  if(options.autoLoad!==false)start(selectedMode);
  return {start,render,runner,applyConfiguration,loadDataset:()=>runner.loadDataset(),exportDataset:()=>runner.exportDataset(),getExportStatus:()=>runner.getExportStatus(),getState:()=>runner.getState(),isRunning:()=>state.status==='running',destroy(){cleanup();for(const [target,type,handler]of listeners)target.removeEventListener(type,handler);}};
 }
 return {createRunner,createCachedRunner,mount,sortRecords,names};
});
