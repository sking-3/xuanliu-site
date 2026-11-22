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
 const publicApi='/api/a-share-daily/schemes',writeApi='/api/research-control/schemes';
 const changes={baseline:'建档基准',new:'新入选',continued:'持续入选',exited:'已退出',unknown:'待核对'};
 const statuses={running:'运行中',complete:'已完成',error:'失败'};
 const horizons=[1,3,5,10,20];
 const percent=value=>(value>0?'+':'')+value.toLocaleString('zh-CN',{maximumFractionDigits:2})+'%';
 const beijingTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?beijingTime.format(new Date(value))+'（北京）':'未提供';
 function mount(doc,options={}){
  const el=id=>doc.getElementById('trend-scheme-'+id),host=el('select');if(!host)return null;
  const env=doc.defaultView||globalThis,app=options.app||env.BooksTrendControllerApp;
  if(!app)return null;
  let state={schemes:[],id:'',name:'',detail:null,run:null,runId:'',history:false,collection:null,filter:'all',busy:false,loading:false,message:'',error:false,authRequired:false};
  let sequence=0,pollTimer=null,pollRemaining=0,destroyed=false,schemeOptions='',runOptions='';
  const listeners=[],requests=new Set();
  async function request(path,body){
   const controller=new AbortController();requests.add(controller);
   const timer=env.setTimeout(()=>controller.abort(),30000);
   try{
    const response=await env.fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
    const value=await response.json();
    if(!response.ok)throw Object.assign(Error(value.message||'方案请求未完成。'),{status:response.status,code:value.error});
    return value;
   }finally{env.clearTimeout(timer);requests.delete(controller);}
  }
  function notice(message,error=false,authRequired=false){state={...state,message,error,authRequired};}
  function failed(error){
   const auth=error.status===401;
   notice(auth?'请登录现有账户后保存或管理自己的方案。':error.status===403?'没有此方案的修改权限；可新建自己的方案。':error.status===409?'方案版本已变化，当前条件保留；请重新选择该方案，核对后再保存。':error.name==='AbortError'?'请求超时；请重新选择方案核对服务器状态。':error.message,true,auth);
  }
  function stopPoll(){if(pollTimer!==null){env.clearTimeout(pollTimer);pollTimer=null;}pollRemaining=0;}
  function upsert(scheme){
   const index=state.schemes.findIndex(item=>item.id===scheme.id),schemes=state.schemes.slice();
   if(index<0)schemes.unshift(scheme);else schemes[index]=scheme;
   state={...state,schemes};
  }
  function option(value,text){const node=doc.createElement('option');node.value=value;node.textContent=text;return node;}
  function cell(row,text){const node=doc.createElement('td');node.textContent=text;row.append(node);return node;}
  function empty(text){const row=doc.createElement('tr');cell(row,text).colSpan=7;el('records').replaceChildren(row);}
  function renderRows(){
   const run=state.run;
   if(!run){empty(state.loading?'正在读取运行记录。':'保存方案后显示真实运行记录。');return;}
   if(run.status!=='complete'){empty(run.status==='error'?'本次运行失败，尚无已完成结果。':'本次运行尚未完成。');return;}
   const records=run.records.filter(record=>state.filter==='all'||record.change===state.filter),episodes=new Map();
   for(const track of state.detail.tracks){
    if(track.revision!==run.revision||track.entryDay>run.day||track.exitDay&&track.exitDay<run.day)continue;
    const before=episodes.get(track.code);if(!before||track.entryDay>before.entryDay)episodes.set(track.code,track);
   }
   const rows=[];
   for(const record of records){
    let track=episodes.get(record.stock.code);
    if(['baseline','new'].includes(record.change)&&track?.enteredRunId!==run.id)track=null;
    const row=doc.createElement('tr'),stock=cell(row,''),name=doc.createElement('a'),date=doc.createElement('small');
    name.textContent=record.stock.name+' '+record.stock.code;
    const symbol=/^(\d{6})\.(SH|SZ)$/.exec(record.stock.code);
    if(symbol)name.href='../chart.html?tvwidgetsymbol='+encodeURIComponent((symbol[2]==='SH'?'SSE:':'SZSE:')+symbol[1]);
    date.textContent=track?'观察起点 '+track.entryDay:'未确认入选';
    if(track){date.title='首次确认 '+stamp(track.knownAt);date.setAttribute('aria-label',date.textContent+' · '+date.title);}stock.append(name,date);
    const change=cell(row,changes[record.change]);
    if(record.change==='unknown'){const reason=doc.createElement('small');reason.textContent=record.reason;change.append(reason);}
    for(const days of horizons){
     const observation=track?.observations[String(days)],ready=observation?.status==='ready'&&Number.isFinite(observation.returnPercent);
     const value=cell(row,ready?percent(observation.returnPercent):'—');
     const description='第'+days+'个交易日 · '+(observation?.targetDay||'目标日未确定')+' · '+(observation?.reason||(track?'尚无该观察记录':'未建立观察记录'))+(observation?.observedAt?' · 核对 '+observation.observedAt:'');
     value.title=description;value.setAttribute('aria-label',value.textContent+' · '+description);
    }
    rows.push(row);
   }
   if(rows.length)el('records').replaceChildren(...rows);else empty('该运行记录没有'+(state.filter==='all'?'可显示的变化':changes[state.filter])+'股票。');
  }
  function render(){
   const key=JSON.stringify(state.schemes.map(item=>[item.id,item.revision,item.name,item.enabled]));
   if(key!==schemeOptions){schemeOptions=key;host.replaceChildren(option('','新建方案'),...state.schemes.map(item=>option(item.id,item.name+' · v'+item.revision+(item.enabled?'':' · 已暂停'))));}
   host.value=state.id;el('name').value=state.name;host.disabled=state.busy;el('name').disabled=state.busy;
   el('save').disabled=state.busy||state.loading;el('load').disabled=state.busy||state.loading||!state.detail;el('toggle').hidden=!state.id;el('toggle').disabled=state.busy||state.loading||!state.detail;
   el('toggle').textContent=state.detail?.scheme.enabled?'暂停每日筛选':'恢复每日筛选';
   el('status').textContent=state.message;el('status').dataset.error=String(state.error);
   if(state.authRequired){const link=doc.createElement('a');link.textContent='登录账户';link.href='../auth.html?next=screening/index.html';el('status').append(link);}
   let runs=state.detail?.runs||[];if(state.run&&!runs.some(run=>run.id===state.run.id))runs=[state.run,...runs];
   const nextOptions=JSON.stringify(runs.map(run=>[run.id,run.day,run.revision,run.status]));
   if(nextOptions!==runOptions){runOptions=nextOptions;el('runs').replaceChildren(...(runs.length?runs.map(run=>option(run.id,run.day+' · v'+run.revision+' · '+statuses[run.status])):[option('','暂无运行')]));}
   el('runs').value=state.runId;el('runs').disabled=state.busy||state.loading||!runs.length;el('change').value=state.filter;
   const run=state.run,counts=run?.status==='complete'?run.summary:null;
   el('run-summary').textContent=run?'数据日 '+run.day+' · v'+run.revision+(counts?' · 基准 '+counts.baseline+' · 新 '+counts.new+' · 持续 '+counts.continued+' · 退出 '+counts.exited+' · 待核 '+counts.unknown:' · '+statuses[run.status]):state.id?'尚无已完成运行':'尚未选择方案';
   const attempt=state.detail?.scheme.attempt;
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
  function queuePoll(){
   const scheme=state.detail?.scheme,attempt=scheme?.attempt;
   if(!scheme||!pollRemaining||attempt?.revision===scheme.revision&&['complete','error'].includes(attempt.status))return;
   pollRemaining--;
   pollTimer=env.setTimeout(()=>{pollTimer=null;loadScheme(state.id,{polling:true,follow:true});},5000);
  }
  async function loadScheme(id,{polling=false,follow=false}={}){
   const token=++sequence;
   if(!polling)stopPoll();
   state={...state,id,history:polling?state.history:false,loading:true,detail:polling?state.detail:null,run:polling?state.run:null,runId:polling?state.runId:''};render();
   try{
    const detail=await request(publicApi+'?id='+encodeURIComponent(id));if(destroyed||token!==sequence)return;
    upsert(detail.scheme);const run=polling&&state.history?state.run:detail.latestRun;
    state={...state,detail,collection:detail.collection||null,name:polling?state.name:detail.scheme.name,run,runId:run?.id||'',loading:false};
    if(follow&&!polling)pollRemaining=3;
    render();if(follow)queuePoll();
   }catch(error){if(!destroyed&&token===sequence){state={...state,loading:false};failed(error);render();}}
  }
  async function refresh(){
   state={...state,busy:true};render();
   try{const value=await request(publicApi);if(!destroyed){
    state={...state,schemes:value.schemes,collection:value.collection||null};if(!state.message)notice(value.schemes.length?'复盘显示已保存方案；主筛选条件保持当前选择。':'尚无已保存方案，可将当前条件保存并每日运行。');
    let preferred=state.id;try{preferred=preferred||env.localStorage?.getItem('books.screening.schemeId.v1');}catch{}
    const selected=value.schemes.find(item=>item.id===preferred)||value.schemes.find(item=>item.enabled)||value.schemes[0];
    if(selected)await loadScheme(selected.id);
   }}
   catch(error){if(!destroyed)failed(error);}
   finally{if(!destroyed){state={...state,busy:false};render();}}
  }
  async function write(action){
   if(state.busy||destroyed)return;stopPoll();state={...state,busy:true};render();
   try{await action();}catch(error){if(!destroyed)failed(error);}finally{if(!destroyed){state={...state,busy:false};render();}}
  }
  function listen(target,event,handler){target.addEventListener(event,handler);listeners.push([target,event,handler]);}
  listen(host,'change',()=>{
   const id=host.value;sequence++;stopPoll();
   try{env.localStorage?.setItem('books.screening.schemeId.v1',id);}catch{}
   if(id)loadScheme(id);else{state={...state,id:'',name:'',detail:null,run:null,runId:'',loading:false};notice('将当前筛选条件保存为新方案。');render();}
  });
  listen(el('name'),'input',()=>{state={...state,name:el('name').value};});
  listen(el('save'),'click',()=>write(async()=>{
   const name=state.name.trim();if(!name)throw Error('请填写方案名称。');
   const draft=app.getSchemeDraft(),body={name,config:{...draft.config,name},selection:draft.selection,enabled:true};
   if(state.id){body.id=state.id;body.expectedRevision=state.detail.scheme.revision;}
   const {scheme}=await request(writeApi,body);if(destroyed)return;
   try{env.localStorage?.setItem('books.screening.schemeId.v1',scheme.id);}catch{}
   upsert(scheme);state={...state,id:scheme.id,name:scheme.name};notice('已保存到服务器 · v'+scheme.revision+' · 已启用每日筛选。');await loadScheme(scheme.id,{follow:true});
  }));
  listen(el('load'),'click',()=>write(async()=>{
   const scheme=state.detail.scheme;await app.applyScheme({config:scheme.config,selection:scheme.selection});
   if(!destroyed)notice('已载入“'+scheme.name+'”v'+scheme.revision+'条件，显示本站当前已完成批次。');
  }));
  listen(el('toggle'),'click',()=>write(async()=>{
   const previous=state.detail.scheme,{scheme}=await request(writeApi+'/enabled',{id:previous.id,enabled:!previous.enabled});if(destroyed)return;
   upsert(scheme);state={...state,detail:{...state.detail,scheme}};notice(scheme.enabled?'已恢复每日筛选。':'已暂停每日新增筛选；已有入选记录继续观察。');await loadScheme(scheme.id,{follow:scheme.enabled});
  }));
  listen(el('runs'),'change',async()=>{
   const id=el('runs').value;if(!id)return;const token=++sequence;stopPoll();state={...state,history:true,runId:id,run:null,loading:true};render();
   try{const {run}=await request(publicApi+'?run='+encodeURIComponent(id));if(!destroyed&&token===sequence){if(run.schemeId!==state.id)throw Error('运行记录与当前方案不一致。');state={...state,run,loading:false};render();}}
   catch(error){if(!destroyed&&token===sequence){state={...state,loading:false};failed(error);render();}}
  });
  listen(el('change'),'change',()=>{state={...state,filter:el('change').value};render();});
  listen(el('review'),'toggle',()=>{if(el('review').open&&state.id&&!state.loading&&!state.busy)loadScheme(state.id);});
  const refreshTimer=env.setInterval(()=>{if(!doc.hidden&&state.id&&!state.busy&&!state.loading)loadScheme(state.id,{polling:true});},60000);
  function destroy(){if(destroyed)return;destroyed=true;sequence++;stopPoll();env.clearInterval(refreshTimer);for(const controller of requests)controller.abort();for(const [target,event,handler]of listeners)target.removeEventListener(event,handler);}
  listen(env,'pagehide',event=>{if(!event.persisted)destroy();});
  render();if(options.autoLoad!==false)refresh();
  return {refresh,destroy,getState:()=>state};
 }
 return {mount};
});
