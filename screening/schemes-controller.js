'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{
  root.BooksScreeningSchemes=api;
  const start=()=>{root.BooksScreeningSchemesApp=api.mount(root.document);};
  if(root.document&&root.BooksTrendControllerApp)start();
  else if(root.document)root.addEventListener('books:trend-mounted',start,{once:true});
 }
})(globalThis,()=>{
 const publicApi='/api/a-share-daily/schemes';
 const changes={baseline:'建档基准',new:'新入选',continued:'持续入选',exited:'已退出',unknown:'待核对'};
 const statuses={running:'运行中',complete:'已完成',error:'失败'};
 const horizons=[1,3,5,10,15,20];
 const percent=value=>(value>0?'+':'')+value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%';
 const beijingTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?beijingTime.format(new Date(value))+'（北京）':'未提供';
 function mount(doc,options={}){
  const el=id=>doc.getElementById('trend-scheme-'+id);if(!el('review'))return null;
  const env=doc.defaultView||globalThis,app=options.app||env.BooksTrendControllerApp;
  if(!app)return null;
  let state={schemes:[],id:'',detail:null,run:null,runId:'',history:false,monitor:null,hourly:null,readAt:null,collection:null,filter:'all',busy:false,loading:false,readError:null};
  let sequence=0,destroyed=false,runOptions='';
  const listeners=[],requests=new Set();
  async function request(path){
   const controller=new AbortController();requests.add(controller);
   const timer=env.setTimeout(()=>controller.abort(),30000);
   try{
    const response=await env.fetch(path,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
    const value=await response.json();
    if(!response.ok)throw Object.assign(Error(value.message||'自动筛选数据读取失败。'),{status:response.status});
    return value;
   }finally{env.clearTimeout(timer);requests.delete(controller);}
  }
  function failed(error){
   let message=error.message;
   if(error.name==='TypeError')message='方案数据读取暂时失败；'+(state.run||state.monitor?'保留上次成功结果，稍后自动检查。':'稍后自动重试。');
   else if(error.name==='AbortError')message='读取方案请求已超时；'+(state.run||state.monitor?'保留上次成功结果。':'稍后自动重试。');
   state={...state,readError:{id:state.id,message}};
  }
  function option(value,text){const node=doc.createElement('option');node.value=value;node.textContent=text;return node;}
  function cell(row,text){const node=doc.createElement('td');node.textContent=text;row.append(node);return node;}
  function empty(text){const row=doc.createElement('tr');cell(row,text).colSpan=9;el('records').replaceChildren(row);}
  function assessmentText(episode){
   if(episode?.elimination)return '已剔除 · '+episode.elimination.reason+' · 决定日 '+episode.elimination.decisionDay;
   const assessment=episode?.assessment;
   if(!assessment)return '待核 · 未返回15日考核';
   const label=assessment.status==='ready'?(assessment.passed===true?'通过':assessment.passed===false?'未达标':'待核'):assessment.status==='pending'?'待考核':assessment.status==='not_observable'?'不可核验':'待核';
   return label+' · '+assessment.reason;
  }
  function hourlyText(){
   const hourly=state.hourly,status=hourly?.attempt?.status,snapshot=hourly?.lastSuccess;
   if(status==='unconfigured')return '盘中来源未配置';
   if(status==='closed')return '非交易时段';
   if(status==='stale')return '上次指数快照已过期';
   if(status==='failed')return '读取失败'+(snapshot?'，保留上次指数快照':'，暂无指数快照');
   if(status==='complete'&&snapshot){
    const indices=snapshot.indices.filter(index=>Number.isFinite(index.changePercent));
    return indices.length?'指数快照 '+indices.map(index=>index.name+' '+percent(index.changePercent)).join(' / '):'指数快照待核';
   }
   return '盘中来源状态待核';
  }
  function renderRows(){
   const run=state.run;
   if(!run){empty(state.loading?'正在读取运行记录。':'尚无已完成的每日运行记录。');return;}
   if(run.status!=='complete'){empty(run.status==='error'?'本次运行失败，尚无已完成结果。':'本次运行尚未完成。');return;}
   const records=run.records.filter(record=>state.filter==='all'||record.change===state.filter),episodes=new Map(),monitorEpisodes=new Map();
   for(const track of state.detail.tracks){
    if(track.revision!==run.revision||track.entryDay>run.day||track.exitDay&&track.exitDay<run.day)continue;
    const before=episodes.get(track.code);if(!before||track.entryDay>before.entryDay)episodes.set(track.code,track);
   }
   if(state.monitor?.schemeId===run.schemeId)for(const episode of [...state.monitor.active,...state.monitor.eliminated])monitorEpisodes.set(episode.code+':'+episode.entryDay+':'+episode.enteredRunId,episode);
   const rows=[];
   for(const record of records){
    let track=episodes.get(record.stock.code);
    if(['baseline','new'].includes(record.change)&&track?.enteredRunId!==run.id)track=null;
    const episode=track?monitorEpisodes.get(track.code+':'+track.entryDay+':'+track.enteredRunId)||track:null;
    const row=doc.createElement('tr'),stock=cell(row,''),name=doc.createElement('a'),date=doc.createElement('small');
    name.textContent=record.stock.name+' '+record.stock.code;
    const symbol=/^(\d{6})\.(SH|SZ)$/.exec(record.stock.code);
    if(symbol)name.href='../chart.html?tvwidgetsymbol='+encodeURIComponent((symbol[2]==='SH'?'SSE:':'SZSE:')+symbol[1]);
    date.textContent=track?'观察起点 '+track.entryDay:'未确认入选';
    if(track){date.title='首次确认 '+stamp(track.knownAt);date.setAttribute('aria-label',date.textContent+' · '+date.title);}stock.append(name,date);
    const change=cell(row,changes[record.change]);
    if(record.change==='unknown'){const reason=doc.createElement('small');reason.textContent=record.reason;change.append(reason);}
    for(const days of horizons){
     const observation=days===15?episode?.assessment||track?.observations[String(days)]:track?.observations[String(days)],ready=observation?.status==='ready'&&Number.isFinite(observation.returnPercent);
     const value=cell(row,ready?percent(observation.returnPercent):'—');
     const description='第'+days+'个交易日 · '+(observation?.targetDay||'目标日未确定')+' · '+(observation?.reason||(track?'尚无该观察记录':'未建立观察记录'))+(observation?.observedAt?' · 核对 '+observation.observedAt:observation?.checkedAt?' · 核对 '+observation.checkedAt:'');
     value.title=description;value.setAttribute('aria-label',value.textContent+' · '+description);
    }
    cell(row,assessmentText(episode));rows.push(row);
   }
   if(rows.length)el('records').replaceChildren(...rows);else empty('该运行记录没有'+(state.filter==='all'?'可显示的变化':changes[state.filter])+'股票。');
  }
  function render(){
   const scheme=state.detail?.scheme,monitor=state.monitor;
   const daily=scheme?(scheme.enabled?'每日自动筛选':'每日筛选已暂停'):state.busy||state.loading?'正在读取自动筛选状态':'暂无启用的自动筛选方案';
   const counts=monitor?'活跃 '+monitor.active.length+' 只 · 已剔除 '+monitor.eliminated.length+' 只':'活跃与剔除记录待核';
   el('status').textContent=daily+' · 每小时检查：'+hourlyText()+' · 15个交易日涨幅不足5%自动剔除 · '+counts+(state.readError?' · '+state.readError.message:'');
   el('status').dataset.error=String(Boolean(state.readError));
   el('source').textContent=scheme?'方案 '+scheme.name+' · v'+scheme.revision+' · 数据日 '+(monitor?.day||state.run?.day||'待核')+' · 日线来源 '+(monitor?.sourceId||'待核')+' · 页面读取 '+stamp(state.readAt):'';
   const snapshot=state.hourly?.lastSuccess;
   if(snapshot)el('source').textContent+=' · 盘中来源 '+snapshot.sourceId+' · 来源时间 '+stamp(snapshot.asOf)+' · 本站读取 '+stamp(snapshot.fetchedAt)+' · 有效截止 '+stamp(snapshot.staleAfter);
   let runs=state.detail?.runs||[];if(state.run&&!runs.some(run=>run.id===state.run.id))runs=[state.run,...runs];
   const nextOptions=JSON.stringify(runs.map(run=>[run.id,run.day,run.revision,run.status]));
   if(nextOptions!==runOptions){runOptions=nextOptions;el('runs').replaceChildren(...(runs.length?runs.map(run=>option(run.id,run.day+' · v'+run.revision+' · '+statuses[run.status])):[option('','暂无运行')]));}
   el('runs').value=state.runId;el('runs').disabled=state.busy||state.loading||!runs.length;el('change').value=state.filter;
   const run=state.run,countsSummary=run?.status==='complete'?run.summary:null;
   el('run-summary').textContent=run?'数据日 '+run.day+' · v'+run.revision+(countsSummary?' · 基准 '+countsSummary.baseline+' · 新 '+countsSummary.new+' · 持续 '+countsSummary.continued+' · 退出 '+countsSummary.exited+' · 待核 '+countsSummary.unknown:' · '+statuses[run.status]):'尚无已完成运行';
   const attempt=scheme?.attempt;
   let status=state.loading?'正在读取运行记录。':run?'数据日 '+run.day+' · '+statuses[run.status]+(run.error?'：'+run.error:''):'尚无已完成运行。';
   if(attempt?.status==='error'&&attempt.id!==run?.id)status='v'+attempt.revision+'运行失败：'+attempt.error+'；'+(run?'保留数据日 '+run.day+' 上次结果。':'尚无上次成功结果。');
   else if(attempt?.status==='running')status='v'+attempt.revision+'正在运行'+(attempt.summary?' · '+attempt.summary.stage+' '+attempt.summary.checked+'/'+attempt.summary.total:'')+'；'+(run?.status==='complete'?'下方保留数据日 '+run.day+' 上次结果。':'完成后显示结果。');
   const collection=state.collection?.attempt;
   if(collection?.status==='failed')status='收盘采集失败：'+collection.error+'；'+(run?'保留数据日 '+run.day+' 上次结果。':'尚无已完成方案结果。');
   else if(collection?.status==='running')status='收盘采集中 · '+collection.stage+' '+collection.checked+'/'+collection.total+'；'+(run?'保留数据日 '+run.day+' 上次结果。':'完成后更新方案。');
   if(run){
    const baseline=run.summary?.isBaseline;
    status+=' · 来源 '+stamp(run.asOf)+' · '+(baseline?'建档 ':'执行 ')+stamp(run.startedAt);
    if(baseline)status+=' · '+(run.summary.baselineReason==='first_run'?'首次':'本次')+'基准，不回填旧信号。';
   }
   el('run-status').textContent=state.id?status:'';renderRows();
  }
  async function loadScheme(id,{preserveHistory=false}={}){
   const token=++sequence;state={...state,loading:true};render();
   try{
    const detail=await request(publicApi+'?id='+encodeURIComponent(id));if(destroyed||token!==sequence)return;
    if(detail.scheme.id!==id)throw Error('自动筛选方案与请求不一致；保留上次结果。');
    const monitor=detail.monitor;
    if(!monitor)throw Error('监控数据尚未返回；保留上次监控与复盘，活跃状态待核。');
    if(monitor.schema!=='books.screening.monitor.v1'||monitor.schemeId!==id||!Array.isArray(monitor.active)||!Array.isArray(monitor.eliminated))throw Error('自动监控数据不完整；保留上次结果。');
    app.setMonitor(monitor);
    const history=preserveHistory&&state.id===id&&state.history,run=history?state.run:detail.latestRun;
    state={...state,id,detail,collection:detail.collection||null,monitor,hourly:detail.hourly||null,readAt:new Date().toISOString(),run,runId:run?.id||'',history,loading:false,readError:null};
    render();
   }catch(error){if(!destroyed&&token===sequence){state={...state,loading:false};failed(error);render();}}
  }
  async function refresh(){
   if(state.busy||destroyed)return;const token=++sequence;state={...state,busy:true};render();
   try{
    const value=await request(publicApi);if(destroyed||token!==sequence)return;
    state={...state,schemes:value.schemes,collection:value.collection||null};
    const selected=value.schemes.find(item=>item.enabled);
    if(selected)await loadScheme(selected.id,{preserveHistory:true});
    else state={...state,readError:state.monitor?{id:state.id,message:'暂无启用的自动筛选方案；保留上次监控。'}:null};
   }catch(error){if(!destroyed)failed(error);}
   finally{if(!destroyed){state={...state,busy:false};render();}}
  }
  function listen(target,event,handler){target.addEventListener(event,handler);listeners.push([target,event,handler]);}
  listen(el('runs'),'change',async()=>{
   const id=el('runs').value;if(!id)return;const token=++sequence;state={...state,loading:true};render();
   try{const {run}=await request(publicApi+'?run='+encodeURIComponent(id));if(!destroyed&&token===sequence){if(run.schemeId!==state.id)throw Error('运行记录与当前方案不一致。');state={...state,run,runId:id,history:true,loading:false,readError:null};render();}}
   catch(error){if(!destroyed&&token===sequence){state={...state,loading:false};failed(error);render();}}
  });
  listen(el('change'),'change',()=>{state={...state,filter:el('change').value};render();});
  listen(el('review'),'toggle',()=>{if(el('review').open&&state.id&&!state.loading&&!state.busy)loadScheme(state.id,{preserveHistory:true});});
  const refreshTimer=env.setInterval(()=>{if(!doc.hidden&&!state.busy&&!state.loading){if(state.id)loadScheme(state.id,{preserveHistory:true});else refresh();}},60000);
  function destroy(){if(destroyed)return;destroyed=true;sequence++;env.clearInterval(refreshTimer);for(const controller of requests)controller.abort();for(const [target,event,handler]of listeners)target.removeEventListener(event,handler);}
  listen(env,'pagehide',event=>{if(!event.persisted)destroy();});
  render();if(options.autoLoad!==false)refresh();
  return {refresh,destroy,getState:()=>state};
 }
 return {mount};
});
