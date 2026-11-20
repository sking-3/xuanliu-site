'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{root.BooksTrendController=api;if(root.document)root.BooksTrendControllerApp=api.mount(root.document);}
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
 function createRunner({technical,engine,wait:pause=wait,now=Date.now,onUpdate=()=>{}}){
  const cache=new Map();let active=null,requested=false,state=initial();
  function emit(){onUpdate({...state,records:state.records.slice()});}
  function blocked(){const s=technical.sourceState();return s.status!=='idle'?s.reason||'日线来源已停止访问。':'';}
  function cancel(reason='已停止'){if(active){active.abort();active=null;state.status='stopped';state.reason=reason+(state.mode==='consensus'?'；参考批次未完成，未判断市场共性。':'');emit();}}
  async function run(options={}){
   cancel();const control=new AbortController();active=control;
   const {mode,lookback,day,asOf,reference,limits={}}=options,marketRows=options.marketRows||[],size=options.sampleSize==='all'?Infinity:Number(options.sampleSize??120);
   let stocks=options.stocks||[];
   if(mode==='consensus'&&(size===Infinity||[120,240].includes(size)))stocks=engine.selectMarketSample(marketRows,size);
   state={...initial(),mode,lookback,day,asOf,limits:{...limits},reference:reference?{code:reference.code,name:indexNames[reference.code]||reference.code}:null,status:'running',phase:'collecting',total:stocks.length,marketUniverseCount:marketRows.length,fullMarket:size===Infinity,startedAt:new Date(now()).toISOString()};
   const current=()=>active===control&&!control.signal.aborted;
   if(!Object.hasOwn(names,mode)||![20,60].includes(lookback)||!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!stocks.length||!fixedIndices.has(reference?.code)||!validLimits(limits)||mode==='consensus'&&(!(size===Infinity||[120,240].includes(size))||stocks.length<30)){
    state.status='unavailable';state.reason=mode==='consensus'&&stocks.length<30?'市场参考池不足30只，不能把少数股票称为市场共同走势。':'筛选范围、交易日、指数日历或排除上限尚未准备好。';active=null;emit();return state;
   }
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
    state.referenceFetchedAt=anchor.fetchedAt||null;emit();
    for(const stock of stocks){
     if(!current())return state;let source;
     try{source=await history(stock);}catch{if(!current())return state;source={status:'unavailable',reason:'日线请求未完成。'};}
     if(!current())return state;
     if(source.sourceStopped){state.status='stopped';state.reason=(source.reason||'来源限制访问，已停止。')+(mode==='consensus'?'；未完成参考批次，未判断市场共性。':'');active=null;emit();return state;}
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
    active=null;emit();
   }catch{if(current()){state.status='stopped';state.reason=(blocked()||'读取已停止，已完成结果保留。')+(mode==='consensus'?'；未判断市场共性。':'');active=null;emit();}}
   return state;
  }
  return {run,cancel,getState:()=>({...state,records:state.records.slice()}),clear(){cancel();state=initial();emit();},cacheSize:()=>cache.size};
 }
 function mount(doc,options={}){
  const host=doc.getElementById('trend-screen');if(!host)return null;
  const env=doc.defaultView||globalThis,el=id=>doc.getElementById(id),selection=()=>options.selection||env.BooksStockSelection;
  const technical=options.technical||env.BooksTechnicalScreen,engine=options.engine||env.BooksTrendScreen;if(!technical||!engine)return null;
  const buttons=[...host.querySelectorAll('[data-trend-mode]')],listeners=[];let page=0,contextKey='',state=initial();
  const number=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:d}):'—',pct=v=>Number.isFinite(v)?(v>0?'+':'')+number(v)+'%':'—';
  const stamp=v=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)):'未提供';
  const context=()=>selection()?.getContext?.()||{};
  const identity=(c=context())=>JSON.stringify([c.day,c.asOf,...['rows','pageRows','savedRows','marketRows'].map(k=>(c[k]||[]).map(r=>r.code))]);
  function rows(c=context()){return (el('trend-scope').value==='page'?c.pageRows:el('trend-scope').value==='saved'?c.savedRows:c.rows)||[];}
  function add(tr,text,label){const td=doc.createElement('td');td.textContent=text;if(label)td.dataset.label=label;tr.append(td);return td;}
  function render(){
   const c=context(),running=state.status==='running',source=technical.sourceState();
   for(const b of buttons){const count=b.dataset.trendMode==='consensus'?(c.marketRows||[]).length:rows(c).length;b.disabled=running||!c.day||count<(b.dataset.trendMode==='consensus'?30:1)||source.status!=='idle';b.setAttribute('aria-pressed',String(b.dataset.trendMode===state.mode));}
   el('trend-stop').hidden=!running;host.setAttribute('aria-busy',String(running));
   const count={checked:state.records.length,matched:state.records.filter(r=>r.result.status==='ready'&&r.result.matched).length,missing:state.records.filter(r=>r.result.status==='unavailable').length,excluded:state.records.filter(r=>r.result.excluded).length};
   const date=state.day||c.day||'未取得',fresh=c.freshness?.state==='historical'?'历史批次':'来源批次',co=state.consensus;
   let progress=state.mode?`${names[state.mode]} · ${fresh} ${date} · 已读取 ${count.checked}/${state.total} 只 · 命中 ${count.matched} · 过热排除 ${count.excluded} · 资料不足 ${count.missing} · 请求 ${state.requests}`:`${fresh} ${date} · 市场参考池 ${(c.marketRows||[]).length} 只 · 指数/转强范围 ${rows(c).length} 只`;
   if(state.mode==='consensus')progress+=` · ${state.fullMarket?'完整池':'分层样本'} ${state.total}/${state.marketUniverseCount}`;
   progress+=source.status!=='idle'?' · '+source.reason:state.reason?' · '+state.reason:running?(state.mode==='consensus'?' · 逐股读取中；未完成前不判断共性':' · 逐股核验中'):state.status==='complete'?' · 核验完成':'';
   el('trend-status').textContent=progress;
   const medianReturn=co?.medianReturns?.length&&co.medianReturns.every(Number.isFinite)?(co.medianReturns.reduce((v,r)=>v*(1+r),1)-1)*100:NaN;
   const curve=co?.dates?.length?` · 样本中位曲线 ${co.dates[0]} 至 ${co.dates.at(-1)} ${pct(medianReturn)}${Number.isFinite(medianReturn)?medianReturn>0?'（上行）':medianReturn<0?'（下行）':'（持平）':''}`:'';
   const summary=el('trend-market-summary');if(summary)summary.textContent=co?`市场池 ${state.marketUniverseCount} · 计划读取 ${state.total} · 同日有效 ${co.validCount} · 有效覆盖 ${number(co.coverage*100)}% · 共性 ${co.commonCount}/${co.validCount}（${number(co.breadth*100)}%） · ${co.identified?'样本已形成主流共性':'未识别主流共性'}${curve}`:`市场共性始终从完整参考池分层取样，不跟随涨幅排序、个股筛选或当前页；选择完整池时逐股读取全部。${running?'本批至少约 '+Math.ceil(state.total*1.5/60)+' 分钟加网络耗时。':''}`;
   el('trend-rules').textContent=(state.mode==='consensus'?'至少30只且有效覆盖≥80%，其中≥60%满足相关性与同向条件才识别样本主流；中位数由各股日收益生成，排除自身贡献。':state.mode==='strength'?'近5日转强、收盘与MA5高于MA20且近5日发生上穿；不再强制大幅上涨或放量。':state.mode==='market'?'按同交易日计算与指数的收益相关性，同向下跌也可能命中。':'选择市场共同走势，自动找市场样本共性，不需要填写参考股票。')+' 成交量比不是资金流入金额；可停止，保持页面打开，同批日线会复用。';
   const ordered=sortRecords(state.records,state.mode),visible=el('trend-only-matches').checked?ordered.filter(r=>r.result.status==='ready'&&r.result.matched):ordered;
   page=Math.max(0,Math.min(page,Math.ceil(visible.length/20)-1));const body=el('trend-rows');body.replaceChildren();
   for(const record of visible.slice(page*20,page*20+20)){
    const {stock,result}=record,m=result.metrics||{},tr=doc.createElement('tr');tr.dataset.code=stock.code;tr.dataset.status=result.status;tr.dataset.excluded=String(!!result.excluded);
    const name=add(tr,'','股票'),link=doc.createElement('a');link.href='../company-dossier.html?symbol='+encodeURIComponent(stock.code);link.textContent=stock.name+' '+stock.code;name.append(link);
    add(tr,number(m.correlation),'走势相关性');add(tr,Number.isFinite(m.directionAgreement)?number(m.directionAgreement*100)+'%':'—','同向占比');add(tr,pct(m.periodReturn),'区间涨跌');add(tr,Number.isFinite(m.volumeRatio)?number(m.volumeRatio)+'倍':'—','成交量比');
    const verdict=result.status==='ready'?(result.excluded?'过热排除：'+(result.exclusionReasons||[]).join('；'):(result.matched?'命中':'未命中')+' · '+(result.reason||'')):result.reason||'资料不足';
    const basis=add(tr,verdict+` · ${m.startAt||'—'} 至 ${m.endAt||state.day||'—'} · 读取 ${stamp(record.fetchedAt)}（北京）`,'依据及时间');
    if(result.status==='ready'){
     const audit=doc.createElement('details'),title=doc.createElement('summary'),text=doc.createElement('p');title.textContent='核对原始计算';
     text.textContent=`前复权起点 ${number(m.startClose,8)} → 终点 ${number(m.endClose,8)}；区间涨幅 =（终点÷起点−1）×100% = ${number(m.periodReturn,8)}%；近5日均量 ${number(m.volumeAvg5,8)} ÷ 此前20日均量 ${number(m.volumeAvgPrevious20,8)} = ${number(m.volumeRatio,8)}倍；MA20偏离 ${pct(m.ma20Deviation)}；${state.mode==='consensus'?'市场参考池读取 '+stamp(state.poolFetchedStart)+' 至 '+stamp(state.poolFetchedEnd):'交易日/指数 '+state.reference?.name+'读取 '+stamp(record.referenceFetchedAt)}（北京）。成交量按来源同股单位比较，不是资金金额。`;
     audit.append(title,text);basis.append(audit);
    }
    body.append(tr);
   }
   if(!body.children.length){const tr=doc.createElement('tr'),td=add(tr,state.mode==='consensus'&&state.phase==='collecting'?'参考池尚未完成，暂不展示市场共性名单。':state.records.length?'当前显示条件下暂无记录；关闭“只看命中”可查看过热排除、资料不足与未命中。':state.reason||'尚未运行走势筛选。');td.colSpan=6;body.append(tr);}
   el('trend-count').textContent=`显示 ${visible.length} 条 · 命中 ${count.matched} · 过热排除 ${count.excluded} · 资料不足 ${count.missing}`;
   el('trend-page').textContent=visible.length?`${page+1} / ${Math.ceil(visible.length/20)}`:'0 / 0';el('trend-prev').disabled=page===0;el('trend-next').disabled=(page+1)*20>=visible.length;
  }
  const runner=createRunner({technical,engine,wait:options.wait,now:options.now,onUpdate:value=>{state=value;render();}});
  async function start(mode){
   const value=id=>el(id).value.trim()===''?NaN:Number(el(id).value);
   const c=context(),lookback=Number(el('trend-lookback').value),max=value('trend-max-return');
   const limits={enabled:el('trend-exclude-hot').checked,maxReturn20:lookback===20?max:15,maxReturn60:lookback===60?max:30,maxReturn5:value('trend-max-five'),maxDeviation:value('trend-max-deviation'),maxVolumeRatio:value('trend-max-volume')};
   if(!validLimits(limits)){state={...initial(),reason:'排除上限须为有效的非负数：百分比不超过1000，成交量比不超过100。'};render();return state;}
   selection()?.stopTechnicalScan?.();page=0;
   return runner.run({mode,lookback,day:c.day,asOf:c.asOf,stocks:rows(c).slice(),marketRows:c.marketRows||[],sampleSize:el('trend-sample').value,reference:{code:el('trend-benchmark').value},index:true,limits});
  }
  function listen(target,name,fn){target.addEventListener(name,fn);listeners.push([target,name,fn]);}
  for(const b of buttons)listen(b,'click',()=>start(b.dataset.trendMode));
  let previousLookback=Number(el('trend-lookback').value);
  for(const id of ['trend-lookback','trend-benchmark','trend-scope','trend-sample','trend-exclude-hot','trend-max-return','trend-max-five','trend-max-deviation','trend-max-volume'])listen(el(id),'change',()=>{
   if(id==='trend-lookback'){const before=previousLookback===60?30:15;if(Number(el('trend-max-return').value)===before)el('trend-max-return').value=Number(el(id).value)===60?'30':'15';previousLookback=Number(el(id).value);}
   page=0;runner.clear();render();
  });
  listen(el('trend-only-matches'),'change',()=>{page=0;render();});listen(el('trend-prev'),'click',()=>{page--;render();});listen(el('trend-next'),'click',()=>{page++;render();});
  listen(el('trend-stop'),'click',()=>runner.cancel('已停止，已读取日线保留在本页缓存。'));
  listen(env,'books:selection-changed',()=>{const key=identity();if(contextKey&&contextKey!==key){page=0;runner.clear();}contextKey=key;render();});
  listen(env,'books:technical-source-state',()=>{if(technical.sourceState().status!=='idle')runner.cancel(technical.sourceState().reason);render();});listen(env,'pagehide',()=>runner.cancel('页面已离开，筛选停止。'));
  contextKey=identity();render();return {start,render,runner,isRunning:()=>runner.getState().status==='running',destroy(){runner.cancel();for(const [target,name,fn]of listeners)target.removeEventListener(name,fn);}};
 }
 return {createRunner,mount,sortRecords,names};
});
