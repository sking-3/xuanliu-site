'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const schemesUI=require('../screening/schemes-controller.js'),trend=require('../screening/trend-controller.js'),model=require('../control/model.js'),engine=require('../screening/trend-screen.js'),patterns=require('../screening/trend-patterns.js'),pool=require('../screening/market-pool.js');
const html=fs.readFileSync(require.resolve('../screening/index.html'),'utf8'),day='2026-11-20';
const clone=value=>JSON.parse(JSON.stringify(value)),settle=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
class Target{
 constructor(){this.events=new Map();}
 addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}
 removeEventListener(type,fn){this.events.get(type)?.delete(fn);}
 dispatchEvent(event){for(const fn of this.events.get(event.type)||[])fn(event);}
 async emit(type){for(const fn of this.events.get(type)||[])await fn({type,preventDefault(){}});await settle();}
}
class Element extends Target{
 constructor(tag='div'){super();this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.own='';this.disabled=false;this.hidden=false;this.checked=false;this.parentNode=null;}
 get textContent(){return this.own+this.children.map(node=>node.textContent).join('');}
 set textContent(value){this.replaceChildren();this.own=String(value);}
 append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this.own='';this.append(...nodes);}
 remove(){if(this.parentNode){const list=this.parentNode.children;list.splice(list.indexOf(this),1);this.parentNode=null;}}
 insertBefore(node,before){if(node===before)return;node.remove();this.children.splice(before?this.children.indexOf(before):this.children.length,0,node);node.parentNode=this;}
 setAttribute(key,value){this.attrs[key]=String(value);}
 querySelectorAll(selector){const key=selector.slice(1,-1).replace(/^data-/,'').replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());return this.children.filter(node=>node.dataset[key]!==undefined);}
}
function documentFixture(){
 const env=new Target(),ids=new Map(),data=[],timers=new Map(),intervals=new Map(),storage=new Map();let nextTimer=0;
 for(const match of html.matchAll(/<(\w+)\b([^>]*)>/g)){
  const node=new Element(match[1]),id=/\bid="([^"]+)"/.exec(match[2]);
  if(id)ids.set(id[1],node);
  for(const attr of match[2].matchAll(/data-(trend-[\w-]+)="([^"]*)"/g)){const key=attr[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());node.dataset[key]=attr[2];data.push(node);}
 }
 ids.get('trend-screen').append(...data);ids.get('trend-lookback').value='20';ids.get('trend-scheme-change').value='all';
 env.setTimeout=(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;};env.clearTimeout=id=>timers.delete(id);env.setInterval=(fn,ms)=>{const id=++nextTimer;intervals.set(id,{fn,ms});return id;};env.clearInterval=id=>intervals.delete(id);
 env.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 env.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options.detail;}};
 const doc={defaultView:env,hidden:false,getElementById:id=>ids.get(id),createElement:tag=>new Element(tag)};
 return {env,doc,ids,timers,intervals,storage,el:id=>ids.get('trend-scheme-'+id),async fire(ms){const due=[...timers].filter(([,timer])=>timer.ms===ms);for(const [id,timer]of due){timers.delete(id);timer.fn();}await settle();return due.length;},async tick(){for(const timer of intervals.values())timer.fn();await settle();}};
}
const config=model.normalizeConfig({name:'初期转强',settings:{mode:'strength',direction:'up',sampleSize:'all'}});
const draft=()=>({config:clone(config),selection:{patternId:'near-ma-20',qualification:'strict',scopeCodes:null}});
function record(index,change){return {stock:{code:String(600000+index)+'.SH',name:'股票'+index},result:{metrics:{periodReturn:2}},selected:change==='unknown'?null:change!=='exited',confirmedSelected:change!=='exited',change,reason:change==='unknown'?'本日数据不足':''};}
function completedRun(id='run1',revision=1,runDay=day){return {id,schemeId:'scheme1',revision,day:runDay,asOf:runDay+'T08:10:00Z',startedAt:'2026-11-22T02:30:45Z',generation:'g1',status:'complete',error:null,summary:{isBaseline:true,baselineReason:'first_run',baseline:1,new:1,continued:1,exited:1,unknown:1,selected:3,total:5,ready:4},records:['baseline','new','continued','exited','unknown'].map((change,index)=>record(index,change))};}
function schemeValue(extra={}){return {id:'scheme1',name:'已存方案',revision:1,enabled:true,config:clone(config),selection:draft().selection,attempt:null,lastSuccess:null,...extra};}
function fixture(options={}){
 const f=documentFixture(),calls=[],applied=[];let scheme=schemeValue(),run=completedRun(),tracks=[];
 const app={getSchemeDraft:draft,applyScheme:async value=>applied.push(value)},custom=options.fetch;
 f.env.fetch=async(path,init)=>{
  assert.ok(path.startsWith('/api/a-share-daily/schemes')||path.startsWith('/api/research-control/schemes'));const body=init.body?JSON.parse(init.body):undefined;calls.push({path,init,body});
  if(custom){const response=await custom(path,init,body,calls.length);if(response)return response;}
  let value;
  if(path==='/api/a-share-daily/schemes')value={schemes:[scheme]};
  else if(path.startsWith('/api/a-share-daily/schemes?id='))value={scheme,runs:[run],latestRun:run.status==='complete'?run:null,tracks};
  else if(path.startsWith('/api/a-share-daily/schemes?run='))value={run};
  else if(path==='/api/research-control/schemes'){scheme={...scheme,id:body.id||'scheme1',name:body.name,revision:body.id?scheme.revision+1:1,config:body.config,selection:body.selection,enabled:body.enabled};value={scheme};}
  else{scheme={...scheme,enabled:body.enabled};value={scheme};}
  return {ok:true,status:200,json:async()=>clone(value)};
 };
 const appUI=schemesUI.mount(f.doc,{app,autoLoad:false});
 return {...f,calls,applied,appUI,setScheme:value=>scheme=value,setRun:value=>run=value,setTracks:value=>tracks=value};
}
test('public list is read-only and saving current conditions reports success only after the serverreply',async t=>{
 let reply;const f=fixture({fetch:async(path)=>path==='/api/research-control/schemes'?new Promise(resolve=>reply=resolve):null});t.after(()=>f.appUI.destroy());await f.appUI.refresh();
 assert.equal(f.calls.length,2);assert.equal(f.calls[0].init.method,'GET');assert.equal(f.applied.length,0);assert.equal(f.el('select').value,'scheme1');f.el('select').value='';await f.el('select').emit('change');
 f.el('name').value='我的每日方案';await f.el('name').emit('input');const saving=f.el('save').emit('click');await settle();
 assert.equal(f.el('save').disabled,true);assert.doesNotMatch(f.el('status').textContent,/已保存到服务器/);const post=f.calls.at(-1);assert.equal(post.body.name,'我的每日方案');assert.equal(post.body.config.settings.sampleSize,'all');assert.equal(post.body.selection.patternId,'near-ma-20');assert.equal(post.body.enabled,true);assert.equal(post.body.id,undefined);
 reply({ok:true,status:201,json:async()=>({scheme:schemeValue({name:'我的每日方案'})})});await saving;assert.match(f.el('status').textContent,/已保存到服务器/);assert.equal(f.el('select').value,'scheme1');assert.deepEqual([...f.storage.keys()],['books.screening.schemeId.v1']);assert.ok(f.calls.every(call=>call.init.credentials==='same-origin'&&call.init.redirect==='error'));
});
test('an existing scheme loads explicitly, saves with its revision, and can pause or resume',async t=>{
 const f=fixture();t.after(()=>f.appUI.destroy());await f.appUI.refresh();f.el('select').value='scheme1';await f.el('select').emit('change');assert.equal(f.applied.length,0);
 await f.el('load').emit('click');assert.deepEqual(f.applied,[{config,selection:draft().selection}]);assert.match(f.el('status').textContent,/已载入/);
 await f.el('save').emit('click');const saved=f.calls.find(call=>call.path==='/api/research-control/schemes');assert.equal(saved.body.id,'scheme1');assert.equal(saved.body.expectedRevision,1);
 await f.el('toggle').emit('click');assert.equal(f.calls.filter(call=>call.path.endsWith('/enabled')).at(-1).body.enabled,false);assert.match(f.el('status').textContent,/暂停每日新增筛选.*继续观察/);assert.equal(f.el('toggle').textContent,'恢复每日筛选');
 await f.el('toggle').emit('click');assert.equal(f.calls.filter(call=>call.path.endsWith('/enabled')).at(-1).body.enabled,true);
});
test('401 requires only the existing login,403 is ownership denial, and409 preserves the unsaved draft',async t=>{
 for(const status of [401,403,409]){
  const f=fixture({fetch:async path=>path==='/api/research-control/schemes'?{ok:false,status,json:async()=>({error:status===409?'revision_conflict':'denied',message:'拒绝'})}:null});t.after(()=>f.appUI.destroy());await f.appUI.refresh();f.el('name').value='保留的草稿';await f.el('name').emit('input');await f.el('save').emit('click');
  assert.equal(f.el('name').value,'保留的草稿');assert.doesNotMatch(f.el('status').textContent,/已保存到服务器|管理员/);assert.equal(f.el('status').dataset.error,'true');
  if(status===401)assert.match(f.el('status').textContent,/登录现有账户.*登录账户/);else if(status===403)assert.match(f.el('status').textContent,/没有此方案的修改权限/);else assert.match(f.el('status').textContent,/版本已变化.*当前条件保留/);
 }
});
test('the first baseline is polled at most three times after saving and never by a permanent interval',async t=>{
 let details=0;const current=schemeValue({revision:2,attempt:{id:'running1',revision:2,status:'running'}}),f=fixture({fetch:async(path)=>{
  if(path==='/api/research-control/schemes')return {ok:true,status:201,json:async()=>({scheme:current})};
  if(path.includes('?id=')){details++;return {ok:true,status:200,json:async()=>({scheme:current,runs:[],latestRun:null,tracks:[]})};}
 }});t.after(()=>f.appUI.destroy());await f.appUI.refresh();details=0;f.el('name').value='首次基准';await f.el('name').emit('input');await f.el('save').emit('click');assert.equal(details,1);
 assert.equal(await f.fire(5000),1);assert.equal(await f.fire(5000),1);assert.equal(await f.fire(5000),1);assert.equal(await f.fire(5000),0);assert.equal(details,4);assert.equal(f.timers.size,0);assert.match(f.el('run-status').textContent,/正在运行/);
});
test('review uses all five change states and joins the matching episode instead of an older same-stocktrade',async t=>{
 const f=fixture(),run=completedRun();t.after(()=>f.appUI.destroy());
 f.setTracks([{id:'old',revision:1,code:'600000.SH',entryDay:'2026-11-01',exitDay:'2026-11-10',enteredRunId:'older',observations:{'1':{status:'ready',returnPercent:999}}},{id:'current',revision:1,code:'600000.SH',entryDay:day,knownAt:'2026-11-22T03:04:05Z',exitDay:null,enteredRunId:'run1',observations:{'1':{status:'ready',returnPercent:3.2},'3':{status:'pending',returnPercent:null,reason:'未到第3个交易日'}}}]);
 await f.appUI.refresh();f.el('select').value='scheme1';await f.el('select').emit('change');assert.equal(f.el('records').children.length,5);const first=f.el('records').children[0];assert.equal(first.children.length,7);assert.match(first.textContent,/观察起点 2026-11-20.*建档基准.*\+3.2%/);assert.match(first.children[0].children[1].title,/首次确认 2026\/11\/22 11:04:05（北京）/);assert.match(f.el('run-status').textContent,/来源 2026\/11\/20 16:10:00（北京）.*建档 2026\/11\/22 10:30:45（北京）.*首次基准，不回填旧信号/);assert.match(first.children[3].attrs['aria-label'],/第3个交易日.*未到第3个交易日/);assert.equal(first.children[3].children.length,0);assert.doesNotMatch(first.textContent,/999|实际成交收益|未到第3个交易日/);
 for(const change of ['baseline','new','continued','exited','unknown']){f.el('change').value=change;await f.el('change').emit('change');assert.equal(f.el('records').children.length,1);assert.equal(f.el('records').children[0].children[1].textContent.startsWith({baseline:'建档基准',new:'新入选',continued:'持续入选',exited:'已退出',unknown:'待核对'}[change]),true);}
 assert.match(f.el('records').textContent,/本日数据不足/);assert.match(f.el('run-summary').textContent,/基准 1.*新 1.*持续 1.*退出 1.*待核 1/);
 const oldRun=completedRun('older',1,'2026-11-01');oldRun.records=[record(0,'baseline')];f.setRun(oldRun);f.el('change').value='all';await f.el('change').emit('change');f.el('runs').value='older';await f.el('runs').emit('change');assert.match(f.el('records').textContent,/\+999%/);assert.match(f.el('run-summary').textContent,/数据日 2026-11-01/);
});
test('a failed new revision retains the last successful date and delayed selected-scheme responses cannot overwrite another selection',async t=>{
 let release;const f=fixture({fetch:async path=>path.includes('?id=slow')?new Promise(resolve=>release=resolve):null});t.after(()=>f.appUI.destroy());f.setScheme(schemeValue({revision:2,attempt:{id:'failed',revision:2,status:'error',error:'同日日线不足'}}));await f.appUI.refresh();f.el('select').value='scheme1';await f.el('select').emit('change');assert.match(f.el('run-status').textContent,/v2运行失败.*同日日线不足.*保留数据日 2026-11-20/);
 f.el('select').value='slow';const loading=f.el('select').emit('change');await settle();f.el('select').value='';await f.el('select').emit('change');release({ok:true,status:200,json:async()=>({scheme:schemeValue({id:'slow'}),runs:[],latestRun:null,tracks:[]})});await loading;assert.equal(f.el('select').value,'');assert.equal(f.el('name').value,'');assert.equal(f.appUI.getState().detail,null);
});
test('leaving cancels bounded polling and in-flight reads while bfcache navigation preserves the component',async()=>{
 const f=fixture();await f.appUI.refresh();f.env.dispatchEvent({type:'pagehide',persisted:true});assert.equal(f.el('save').events.get('click').size,1);assert.equal(f.intervals.size,1);f.env.dispatchEvent({type:'pagehide',persisted:false});assert.equal(f.el('save').events.get('click').size,0);assert.equal(f.timers.size,0);assert.equal(f.intervals.size,0);
});
test('visible periodicrefresh advances the latest review but never replaces a manually selected historicalrun or typedname',async t=>{
 const f=fixture();t.after(()=>f.appUI.destroy());await f.appUI.refresh();assert.equal(f.applied.length,0);const before=f.calls.length;
 f.doc.hidden=true;await f.tick();assert.equal(f.calls.length,before);f.doc.hidden=false;
 f.setRun(completedRun('run2',1,'2026-11-23'));await f.tick();assert.equal(f.appUI.getState().run.id,'run2');assert.match(f.el('run-summary').textContent,/2026-11-23/);
 f.setRun(completedRun('run1',1,day));f.el('runs').value='run1';await f.el('runs').emit('change');f.el('name').value='未保存的新名称';await f.el('name').emit('input');
 f.setRun(completedRun('run3',1,'2026-11-24'));await f.tick();f.el('review').open=false;await f.el('review').emit('toggle');f.el('review').open=true;await f.el('review').emit('toggle');assert.equal(f.appUI.getState().run.id,'run1');assert.equal(f.el('runs').value,'run1');assert.equal(f.el('name').value,'未保存的新名称');assert.match(f.el('run-summary').textContent,/2026-11-20/);assert.equal(f.applied.length,0);
});
test('periodic read failures retain the successful result and clear their own Chineseerror after recovery',async t=>{
 let failure=null;const f=fixture({fetch:async path=>{if(path.includes('?id=')&&failure)throw failure;}});t.after(()=>f.appUI.destroy());await f.appUI.refresh();const before=clone(f.appUI.getState().run);
 failure=new TypeError('Failed to fetch');await f.tick();assert.deepEqual(f.appUI.getState().run,before);assert.equal(f.appUI.getState().readError.id,'scheme1');assert.equal(f.el('status').dataset.error,'true');assert.match(f.el('status').textContent,/方案数据读取暂时失败.*保留上次成功结果/);assert.doesNotMatch(f.el('status').textContent,/Failed to fetch/);
 failure=null;await f.tick();assert.equal(f.appUI.getState().readError,null);assert.equal(f.el('status').dataset.error,'false');assert.doesNotMatch(f.el('status').textContent,/读取暂时失败|Failed to fetch/);assert.deepEqual(f.appUI.getState().run,before);
 failure=Object.assign(Error('aborted'),{name:'AbortError'});await f.tick();assert.match(f.el('status').textContent,/读取方案请求已超时.*保留上次成功结果/);failure=null;await f.tick();assert.equal(f.el('status').dataset.error,'false');
});
test('read recovery never hides an unconfirmed401 or409 writefailure',async t=>{
 for(const status of [401,409]){
  let failRead=false;const f=fixture({fetch:async path=>{
   if(path==='/api/research-control/schemes')return {ok:false,status,json:async()=>({error:status===409?'revision_conflict':'sign_in_required',message:'拒绝写入'})};
   if(path.includes('?id=')&&failRead)throw new TypeError('Failed to fetch');
  }});t.after(()=>f.appUI.destroy());await f.appUI.refresh();await f.el('save').emit('click');const message=f.el('status').textContent;
  failRead=true;await f.tick();assert.notEqual(f.appUI.getState().readError,null);assert.equal(f.el('status').textContent,message);
  failRead=false;await f.tick();assert.equal(f.appUI.getState().readError,null);assert.equal(f.appUI.getState().error,true);assert.equal(f.el('status').dataset.error,'true');assert.equal(f.el('status').textContent,message);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 }
});
test('local schemeid is only a review preference and collectionprogress or failure keeps the prior successfuldate',async t=>{
 let collection={attempt:{status:'running',stage:'collecting',checked:430,total:3194}},f=fixture({fetch:async(path)=>{
  if(path==='/api/a-share-daily/schemes')return {ok:true,status:200,json:async()=>({schemes:[schemeValue({id:'first'}),schemeValue({id:'remembered'})],collection})};
  if(path.includes('?id=remembered'))return {ok:true,status:200,json:async()=>({scheme:schemeValue({id:'remembered'}),runs:[completedRun()],latestRun:completedRun(),tracks:[],collection})};
 }});t.after(()=>f.appUI.destroy());f.storage.set('books.screening.schemeId.v1','remembered');await f.appUI.refresh();assert.equal(f.el('select').value,'remembered');assert.match(f.el('run-status').textContent,/收盘采集中.*collecting 430\/3194.*2026-11-20/);assert.equal(f.applied.length,0);
 collection={attempt:{status:'failed',error:'官方日线来源限流'}};await f.tick();assert.match(f.el('run-status').textContent,/收盘采集失败.*官方日线来源限流.*保留数据日 2026-11-20/);assert.equal(f.appUI.getState().run.day,day);
});
function mainFixture(){
 const f=documentFixture(),bars=Array.from({length:65},(_,i)=>({date:new Date(Date.parse(day+'T00:00:00Z')-(64-i)*86400000).toISOString().slice(0,10),close:100+i,volume:i>=60?700:1000})),stocks=Array.from({length:32},(_,index)=>({code:String(600000+index)+'.SH',name:'股'+index}));
 let context={day,asOf:day+'T08:00:00Z',rows:stocks.slice(0,2),filtersActive:true};const calls=[];
 f.env.fetch=async(path)=>{
  calls.push(path);if(path.endsWith('/state'))return {ok:true,json:async()=>({available:true,scope:'full-market',lastSuccess:{generation:'g1'}})};
  const query=new URL(path,'https://books.test').searchParams,mode=query.get('mode'),lookback=Number(query.get('lookback')),consensus=mode==='consensus'?engine.buildConsensus({records:stocks.map(stock=>({stock,bars})),calendar:bars,lookback,day,expectedCount:32,totalUniverseCount:32}):null;
  return {ok:true,json:async()=>({generation:'g1',mode,lookback,day,status:'complete',limits:{enabled:false},reference:{code:'000300.SH'},fullMarket:true,marketUniverseCount:32,consensus,patternVersion:patterns.version,patternDefinitions:patterns.definitions,records:stocks.map(stock=>({stock,result:engine.evaluate({mode,bars,referenceBars:bars,lookback,day,code:stock.code,consensus,limits:{enabled:false}}),patterns:patterns.classify({bars,calendar:bars,lookback,day})}))})};
 };
 const app=trend.mount(f.doc,{engine,model,patterns,pool,selection:{getContext:()=>context},charts:{create:()=>({observe(){},dispose(){},destroy(){}})},autoLoad:false});
 return {...f,app,calls,setContext:value=>context=value};
}
test('the actual controller exports every condition and exactscope, and loading replaces oldpatches and survives a late default',async t=>{
 const f=mainFixture();t.after(()=>f.app.destroy());await f.app.start('strength');let value=f.app.getSchemeDraft();assert.equal(value.config.settings.sampleSize,'all');assert.equal(value.selection.qualification,'strict');assert.deepEqual(value.selection.scopeCodes,['600000.SH','600001.SH']);
 const saved={config:model.normalizeConfig({name:'载入方案',settings:{mode:'market',lookback:60,direction:'down',minimumBreadth:.3,strength:{crossWithinDays:8},patterns:{nearPct:5},limits:{maxReturn60:80}}}),selection:{patternId:'volume-contract',qualification:'strict',scopeCodes:[]}};
 await f.app.applyScheme(saved);value=f.app.getSchemeDraft();assert.equal(value.config.settings.lookback,60);assert.equal(value.config.settings.patterns.nearPct,5);assert.equal(value.config.settings.direction,'down');assert.equal(value.selection.patternId,'volume-contract');assert.deepEqual(value.selection.scopeCodes,[]);assert.equal(f.app.getState().records.length,0);
 assert.equal(f.app.applyConfiguration(model.DEFAULT_CONFIG),false);f.setContext({day,rows:[{code:'600009.SH'}],filtersActive:true});f.env.dispatchEvent({type:'books:selection-changed'});assert.deepEqual(f.app.getSchemeDraft().selection.scopeCodes,[]);
 saved.selection.scopeCodes=null;await f.app.applyScheme(saved);assert.equal(f.app.getState().records.length,32);assert.equal(f.app.getSchemeDraft().selection.scopeCodes,null);assert.equal(f.app.getSchemeDraft().selection.patternId,'volume-contract');assert.equal(f.ids.get('trend-pattern').value,'volume-contract');
 const before=clone(f.app.getSchemeDraft());assert.throws(()=>f.app.applyScheme({...saved,selection:{...saved.selection,patternId:'not-a-pattern'}}));assert.deepEqual(f.app.getSchemeDraft(),before);
});
test('the actual trend and scheme controllers save and reload every peer condition with nullable values intact',async t=>{
 const f=mainFixture(),cachedFetch=f.env.fetch,posts=[];let stored=null;
 f.env.fetch=async(path,init)=>{
  if(path==='/api/research-control/schemes'){
   const body=JSON.parse(init.body);posts.push(clone(body));stored=schemeValue({id:'peer-scheme',name:body.name,config:clone(body.config),selection:clone(body.selection)});
   return {ok:true,status:201,json:async()=>({scheme:clone(stored)})};
  }
  if(path==='/api/a-share-daily/schemes')return {ok:true,status:200,json:async()=>({schemes:stored?[clone(stored)]:[]})};
  if(path.startsWith('/api/a-share-daily/schemes?id='))return {ok:true,status:200,json:async()=>({scheme:clone(stored),runs:[],latestRun:null,tracks:[]})};
  return cachedFetch(path,init);
 };
 const ui=schemesUI.mount(f.doc,{app:f.app,autoLoad:false});t.after(()=>{ui.destroy();f.app.destroy();});await f.app.start('strength');
 const peer={enabled:true,groupTopPercent:45,minPeers:6,minExcessReturn:1.2,minRecentExcess:.4,minImprovement:.2,minDownsideExcess:null,maxSupportDistance:3.5,minResistanceSpace:4,sectorTopPercent:50};
 const input=key=>f.ids.get('trend-screen').children.find(node=>node.dataset.trendPeer===key);
 for(const [key,value]of Object.entries(peer).filter(([key])=>key!=='enabled')){const node=input(key);assert.ok(node,'real HTML field '+key);node.value=value===null?'':String(value);await node.emit('change');}
 f.ids.get('trend-peer-enabled').checked=true;await f.ids.get('trend-peer-enabled').emit('change');
 assert.deepEqual(f.app.getSchemeDraft().config.settings.peer,peer);const original=clone(f.app.getSchemeDraft());
 f.el('name').value='同走势选强与空间';await f.el('name').emit('input');await f.el('save').emit('click');
 assert.equal(posts.length,1);assert.deepEqual(posts[0].config.settings.peer,peer);assert.deepEqual(posts[0].selection,original.selection);assert.equal(posts[0].enabled,true);assert.match(f.el('status').textContent,/已保存到服务器/);
 input('groupTopPercent').value='90';await input('groupTopPercent').emit('change');input('minResistanceSpace').value='';await input('minResistanceSpace').emit('change');f.ids.get('trend-peer-enabled').checked=false;await f.ids.get('trend-peer-enabled').emit('change');
 assert.equal(f.app.getSchemeDraft().config.settings.peer.groupTopPercent,90);assert.equal(f.app.getSchemeDraft().config.settings.peer.minResistanceSpace,null);
 await f.el('load').emit('click');assert.deepEqual(f.app.getSchemeDraft().config.settings.peer,peer);assert.equal(input('groupTopPercent').value,'45');assert.equal(input('minDownsideExcess').value,'');assert.equal(input('maxSupportDistance').value,'3.5');assert.equal(input('minResistanceSpace').value,'4');assert.equal(input('sectorTopPercent').value,'50');assert.equal(f.ids.get('trend-peer-enabled').checked,true);
 assert.equal(posts.length,1,'loading never writes a second scheme revision');
});
