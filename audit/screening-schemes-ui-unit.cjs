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
 for(const descriptor of require('./legacy-screening-fixture.cjs')){
  const node=new Element(descriptor.tag);if(descriptor.id)ids.set(descriptor.id,node);
  if(descriptor.data){Object.assign(node.dataset,descriptor.data);data.push(node);}
 }
 ids.get('trend-screen').append(...data);ids.get('trend-lookback').value='20';ids.get('trend-scheme-change').value='all';
 env.setTimeout=(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;};env.clearTimeout=id=>timers.delete(id);env.setInterval=(fn,ms)=>{const id=++nextTimer;intervals.set(id,{fn,ms});return id;};env.clearInterval=id=>intervals.delete(id);
 env.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 env.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options.detail;}};
 const doc={defaultView:env,hidden:false,getElementById:id=>ids.get(id),createElement:tag=>new Element(tag)};
 return {env,doc,ids,timers,intervals,storage,el:id=>ids.get('trend-scheme-'+id),async fire(ms){const due=[...timers].filter(([,timer])=>timer.ms===ms);for(const [id,timer]of due){timers.delete(id);timer.fn();}await settle();return due.length;},async tick(){for(const timer of intervals.values())timer.fn();await settle();}};
}
const config=model.normalizeConfig({name:'初期转强',settings:{mode:'strength',direction:'up',sampleSize:'all'}});
const method={sourceId:'tickflow-eod',engineVersion:model.engineVersion,patternVersion:patterns.version};
const draft=()=>({config:clone(config),selection:{patternId:'near-ma-20',qualification:'strict',scopeCodes:null}});
function record(index,change){return {stock:{code:String(600000+index)+'.SH',name:'股票'+index},result:{metrics:{periodReturn:2}},selected:change==='unknown'?null:change!=='exited',confirmedSelected:change!=='exited',change,reason:change==='unknown'?'本日数据不足':''};}
function completedRun(id='run1',revision=1,runDay=day){return {id,schemeId:'scheme1',revision,...method,day:runDay,asOf:runDay+'T08:10:00Z',startedAt:'2026-11-22T02:30:45Z',generation:'g1',status:'complete',error:null,summary:{isBaseline:true,baselineReason:'first_run',baseline:1,new:1,continued:1,exited:1,unknown:1,selected:3,total:5,ready:4},records:['baseline','new','continued','exited','unknown'].map((change,index)=>record(index,change))};}
function schemeValue(extra={}){return {id:'scheme1',name:'已存方案',revision:1,enabled:true,config:clone(config),selection:draft().selection,attempt:null,lastSuccess:null,...extra};}
function monitorValue(extra={}){return {schema:'books.screening.monitor.v1',schemeId:'scheme1',scope:'scheme',revision:1,mode:'strength',lookback:20,benchmark:'000300.SH',policy:{horizon:15,minimumReturnPercent:5},sourceId:'tickflow-eod',engineVersion:model.engineVersion,patternVersion:patterns.version,day,generation:'g1',active:[],eliminated:[],...extra};}
function fixture(options={}){
 const f=documentFixture(),calls=[],applied=[],monitors=[];let scheme=schemeValue(),run=completedRun(),tracks=[],monitor=monitorValue(),hourly=null;
 const app={getSchemeDraft:draft,applyScheme:async value=>applied.push(value),setMonitor:value=>options.acceptMonitor?.(value)===false?false:monitors.push(clone(value))},custom=options.fetch;
 f.env.fetch=async(path,init)=>{
  assert.ok(path.startsWith('/api/a-share-daily/schemes'));assert.equal(init.method,'GET');assert.equal(init.body,undefined);calls.push({path,init});
  if(custom){const response=await custom(path,init,calls.length);if(response)return response;}
  let value;
  if(path==='/api/a-share-daily/schemes')value={schemes:[scheme]};
  else if(path.startsWith('/api/a-share-daily/schemes?id='))value={scheme,runs:[run],latestRun:run.status==='complete'?run:null,tracks,monitor,hourly};
  else if(path.startsWith('/api/a-share-daily/schemes?run='))value={run};
  else throw Error('unexpected request '+path);
  return {ok:true,status:200,json:async()=>clone(value)};
 };
 const appUI=schemesUI.mount(f.doc,{app,autoLoad:false});
 return {...f,calls,applied,monitors,appUI,setScheme:value=>scheme=value,setRun:value=>run=value,setTracks:value=>tracks=value,setMonitor:value=>monitor=value,setHourly:value=>hourly=value};
}
test('retired scheme fixture still reads its first enabled monitor; the new page has no scheme mount or manual bar',async t=>{
 const f=fixture({fetch:async path=>path==='/api/a-share-daily/schemes'?{ok:true,status:200,json:async()=>({schemes:[schemeValue({id:'paused',enabled:false}),schemeValue(),schemeValue({id:'remembered'})]})}:null});t.after(()=>f.appUI.destroy());
 f.storage.set('books.screening.schemeId.v1','remembered');await f.appUI.refresh();
 for(const id of ['select','name','load','save','toggle'])assert.equal(f.el(id),undefined);
 assert.doesNotMatch(html,/trend-scheme-bar|保存并每日运行|载入条件|暂停每日筛选|id="trend-scheme-review"|src="schemes-controller\.js/);assert.match(html,/id="stock-desk-tracking"/);assert.equal(schemesUI.mount({getElementById:()=>null}),null);
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].path,'/api/a-share-daily/schemes?id=scheme1');assert.equal(f.appUI.getState().id,'scheme1');assert.equal(f.applied.length,0);assert.deepEqual(f.monitors,[monitorValue()]);
 assert.match(f.el('status').textContent,/每日自动筛选.*每小时检查：盘中来源状态待核.*15个交易日涨幅不足5%自动剔除.*活跃 0 只/);
 assert.match(f.el('source').textContent,/已存方案.*数据日 2026-11-20.*日线来源 tickflow-eod.*页面读取.*（北京）/);
 assert.ok(f.calls.every(call=>call.init.credentials==='same-origin'&&call.init.redirect==='error'&&call.init.cache==='no-store'));
 assert.equal(f.storage.get('books.screening.schemeId.v1'),'remembered');assert.equal(f.timers.size,0);assert.deepEqual([...f.intervals.values()].map(timer=>timer.ms),[60000]);
});
test('no enabled scheme remains pending instead of inventing an empty monitor and retries on the existing minute interval',async t=>{
 let schemes=[schemeValue({enabled:false})];const f=fixture({fetch:async path=>path==='/api/a-share-daily/schemes'?{ok:true,status:200,json:async()=>({schemes})}:null});t.after(()=>f.appUI.destroy());await f.appUI.refresh();
 assert.equal(f.calls.length,1);assert.equal(f.monitors.length,0);assert.equal(f.appUI.getState().monitor,null);assert.match(f.el('status').textContent,/暂无启用.*活跃与剔除记录待核/);assert.doesNotMatch(f.el('status').textContent,/活跃 0|已接通/);
 schemes=[schemeValue()];await f.tick();assert.equal(f.monitors.length,1);assert.equal(f.appUI.getState().id,'scheme1');
});
test('hourly status distinguishes missing credentials, source snapshots and retained stale data without replacing15-day returns',async t=>{
 const f=fixture();t.after(()=>f.appUI.destroy());const track={...method,revision:1,code:'600000.SH',entryDay:day,enteredRunId:'run1',observations:{},assessment:{status:'ready',passed:true,returnPercent:5.1,reason:'第15日已达5%'}};
 f.setTracks([track]);f.setMonitor(monitorValue({active:[track]}));f.setHourly({schema:'books.a-share.hourly.v1',attempt:{status:'unconfigured',requestCount:0},lastSuccess:null});await f.appUI.refresh();assert.match(f.el('status').textContent,/每小时检查：盘中来源未配置/);assert.doesNotMatch(f.el('status').textContent,/已接通|指数快照/);assert.equal(f.el('records').children[0].children[6].textContent,'+5.1%');
 const snapshot={sourceId:'tickflow-auth-quotes-v1',asOf:day+'T02:00:00Z',fetchedAt:day+'T02:00:02Z',staleAfter:day+'T03:00:00Z',indices:[{code:'000001.SH',name:'上证指数',changePercent:1.2},{code:'399001.SZ',name:'深证成指',changePercent:0},{code:'399006.SZ',name:'创业板指',changePercent:null}]};
 f.setHourly({schema:'books.a-share.hourly.v1',attempt:{status:'complete',requestCount:1},lastSuccess:snapshot});await f.tick();assert.match(f.el('status').textContent,/指数快照 上证指数 \+1.2% \/ 深证成指 0%/);assert.doesNotMatch(f.el('status').textContent,/创业板指 0%/);assert.match(f.el('source').textContent,/盘中来源 tickflow-auth-quotes-v1.*来源时间 2026\/11\/20 10:00:00（北京）.*本站读取 2026\/11\/20 10:00:02（北京）.*有效截止 2026\/11\/20 11:00:00（北京）/);
 for(const [status,label]of [['stale','上次指数快照已过期'],['failed','读取失败，保留上次指数快照'],['closed','非交易时段']]){f.setHourly({schema:'books.a-share.hourly.v1',attempt:{status},lastSuccess:snapshot});await f.tick();assert.ok(f.el('status').textContent.includes(label));assert.ok(f.el('source').textContent.includes(snapshot.sourceId));assert.equal(f.el('records').children[0].children[6].textContent,'+5.1%');}
});
test('review keeps all five change states and old horizons while joining the exact episode for15-day assessment',async t=>{
 const f=fixture();t.after(()=>f.appUI.destroy());
 const current={...method,id:'current',revision:1,code:'600000.SH',name:'股票0',entryDay:day,knownAt:'2026-11-22T03:04:05Z',exitDay:null,enteredRunId:'run1',observations:{'1':{status:'ready',returnPercent:3.2},'3':{status:'pending',returnPercent:null,reason:'未到第3个交易日'}}};
 const eliminated={...current,assessment:{status:'ready',passed:false,targetDay:'2026-12-11',returnPercent:4.99,reason:'第15个交易日涨幅不足5%',checkedAt:'2026-12-11T08:10:00Z'},elimination:{targetDay:'2026-12-11',decisionDay:'2026-12-11',returnPercent:4.99,reason:'第15个交易日涨幅不足5%'}};
 f.setTracks([{...method,id:'old',revision:1,code:'600000.SH',entryDay:'2026-11-01',exitDay:'2026-11-10',enteredRunId:'older',observations:{'1':{status:'ready',returnPercent:999}}},current]);f.setMonitor(monitorValue({eliminated:[eliminated]}));
 await f.appUI.refresh();assert.equal(f.el('records').children.length,5);const first=f.el('records').children[0];assert.equal(first.children.length,9);assert.match(first.textContent,/观察起点 2026-11-20.*建档基准.*\+3.2%.*\+4.99%.*已剔除.*涨幅不足5%.*决定日 2026-12-11/);
 assert.match(first.children[0].children[1].title,/首次确认 2026\/11\/22 11:04:05（北京）/);assert.match(f.el('run-status').textContent,/来源 2026\/11\/20 16:10:00（北京）.*建档 2026\/11\/22 10:30:45（北京）.*首次基准，不回填旧信号/);
 assert.match(first.children[3].attrs['aria-label'],/第3个交易日.*未到第3个交易日/);assert.equal(first.children[3].children.length,0);assert.match(first.children[6].attrs['aria-label'],/第15个交易日.*2026-12-11.*涨幅不足5%/);assert.doesNotMatch(first.textContent,/999|实际成交收益|未到第3个交易日/);
 for(const change of ['baseline','new','continued','exited','unknown']){f.el('change').value=change;await f.el('change').emit('change');assert.equal(f.el('records').children.length,1);assert.equal(f.el('records').children[0].children[1].textContent.startsWith({baseline:'建档基准',new:'新入选',continued:'持续入选',exited:'已退出',unknown:'待核对'}[change]),true);}
 assert.match(f.el('records').textContent,/本日数据不足/);assert.match(f.el('run-summary').textContent,/基准 1.*新 1.*持续 1.*退出 1.*待核 1/);
 const oldRun=completedRun('older',1,'2026-11-01');oldRun.records=[record(0,'baseline')];f.setRun(oldRun);f.el('change').value='all';await f.el('change').emit('change');f.el('runs').value='older';await f.el('runs').emit('change');assert.match(f.el('records').textContent,/\+999%/);assert.doesNotMatch(f.el('records').textContent,/4.99%|已剔除/);assert.match(f.el('run-summary').textContent,/数据日 2026-11-01/);
});
test('same-day engine source and pattern generations select their own baseline new continued and exited episodes regardless of track order',async t=>{
 const currentRun=completedRun('current-method'),oldRun={...completedRun('old-method'),engineVersion:method.engineVersion+'-previous'};
 function tracksFor(run,offset){return run.records.slice(0,4).map((record,index)=>({...method,engineVersion:run.engineVersion,id:run.id+'-'+index,revision:1,code:record.stock.code,entryDay:index<2?day:'2026-11-18',exitDay:index===3?day:null,enteredRunId:index<2?run.id:'earlier-'+run.id,observations:{'1':{status:'ready',returnPercent:offset+index+1}},assessment:{status:'ready',passed:true,returnPercent:offset+index+5.2,reason:run.id+'考核'}}));}
 const current=tracksFor(currentRun,0),previous=tracksFor(oldRun,10);
 const unrelated=current.flatMap(track=>[{...track,id:'other-source-'+track.id,sourceId:'other-source',observations:{'1':{status:'ready',returnPercent:999}}},{...track,id:'other-pattern-'+track.id,patternVersion:'other-pattern',observations:{'1':{status:'ready',returnPercent:999}}}]);
 const competing=current.slice(0,2).map(track=>({...track,id:'other-run-'+track.id,enteredRunId:'unrelated-run',observations:{'1':{status:'ready',returnPercent:999}}}));
 const outOfWindow=[{...current[2],entryDay:'2026-11-01',exitDay:'2026-11-10'},{...current[2],entryDay:'2026-11-23',exitDay:null}];
 const tracks=[...previous,...unrelated,...competing,...outOfWindow,...current];
 for(const order of [tracks,tracks.toReversed()]){
  const f=fixture();t.after(()=>f.appUI.destroy());f.setRun(currentRun);f.setTracks(order);f.setMonitor(monitorValue({active:current.slice(0,3),eliminated:[current[3]]}));await f.appUI.refresh();
  for(let index=0;index<4;index++){const row=f.el('records').children[index];assert.equal(row.children[2].textContent,'+'+(index+1)+'%');assert.equal(row.children[6].textContent,'+'+(index+5.2)+'%');assert.match(row.children[8].textContent,/current-method考核/);assert.doesNotMatch(row.textContent,/未确认入选|未返回15日考核|999/);}
  f.setRun(oldRun);f.el('runs').value=oldRun.id;await f.el('runs').emit('change');
  for(let index=0;index<4;index++){const row=f.el('records').children[index];assert.equal(row.children[2].textContent,'+'+(index+11)+'%');assert.equal(row.children[6].textContent,'+'+(index+15.2)+'%');assert.match(row.children[8].textContent,/old-method考核/);assert.doesNotMatch(row.textContent,/未确认入选|current-method考核|999/);}
 }
});
test('an unknown run or track method never borrows an observation from a known or unknown method',async t=>{
 const f=fixture();t.after(()=>f.appUI.destroy());
 for(const field of ['sourceId','engineVersion','patternVersion'])for(const missing of ['run','track','both']){
  const run=completedRun(),track={...method,revision:1,code:'600000.SH',entryDay:day,enteredRunId:run.id,observations:{'1':{status:'ready',returnPercent:999}}};
  if(missing!=='track')delete run[field];if(missing!=='run')delete track[field];f.setRun(run);f.setTracks([track]);await f.appUI.refresh();const row=f.el('records').children[0];assert.match(row.children[0].textContent,/未确认入选/);assert.equal(row.children[2].textContent,'—');assert.equal(row.children[6].textContent,'—');assert.match(row.children[8].textContent,/待核.*未返回15日考核/);assert.doesNotMatch(row.textContent,/999/);
 }
});
test('pending unavailable and unobservable15-day results stay unknown while a genuine zero remains zero',async t=>{
 const f=fixture(),track={...method,revision:1,code:'600000.SH',entryDay:day,enteredRunId:'run1',observations:{}};t.after(()=>f.appUI.destroy());f.setTracks([track]);
 for(const [status,passed,value,label]of [['pending',null,null,'待考核'],['unavailable',null,null,'待核'],['not_observable',null,null,'不可核验'],['ready',false,0,'未达标'],['ready',true,5,'通过']]){
  f.setMonitor(monitorValue({active:[{...track,assessment:{status,passed,returnPercent:value,reason:'真实复核原因'}}]}));await f.appUI.refresh();const row=f.el('records').children[0];assert.equal(row.children[6].textContent,value===null?'—':value===0?'0%':'+5%');assert.equal(row.children[8].textContent,label+' · 真实复核原因');
 }
});
test('failed revisions and collection progress keep the last successful date',async t=>{
 let collection={attempt:{status:'running',stage:'collecting',checked:430,total:3194}};const f=fixture({fetch:async path=>path.includes('?id=')?{ok:true,status:200,json:async()=>({scheme:schemeValue({revision:2,attempt:{id:'failed',revision:2,status:'error',error:'同日日线不足'}}),runs:[completedRun()],latestRun:completedRun(),tracks:[],monitor:monitorValue(),collection})}:null});t.after(()=>f.appUI.destroy());await f.appUI.refresh();assert.match(f.el('run-status').textContent,/收盘采集中.*collecting 430\/3194.*2026-11-20/);
 collection={attempt:{status:'failed',error:'官方日线来源限流'}};await f.tick();assert.match(f.el('run-status').textContent,/收盘采集失败.*官方日线来源限流.*保留数据日 2026-11-20/);assert.equal(f.appUI.getState().run.day,day);
 collection=null;await f.tick();assert.match(f.el('run-status').textContent,/v2运行失败.*同日日线不足.*保留数据日 2026-11-20/);
});
test('leaving removes listeners and aborts in-flight reads while bfcache navigation preserves the component',async()=>{
 let signal;const f=fixture({fetch:async(path,init)=>path.includes('?id=')?new Promise((resolve,reject)=>{signal=init.signal;signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));}):null});const loading=f.appUI.refresh();await settle();assert.equal(signal.aborted,false);
 f.env.dispatchEvent({type:'pagehide',persisted:true});assert.equal(f.el('runs').events.get('change').size,1);assert.equal(f.intervals.size,1);assert.equal(signal.aborted,false);
 f.env.dispatchEvent({type:'pagehide',persisted:false});await loading;assert.equal(f.el('runs').events.get('change').size,0);assert.equal(signal.aborted,true);assert.equal(f.timers.size,0);assert.equal(f.intervals.size,0);assert.equal(f.monitors.length,0);
});
test('visible minute refresh advances the latest review without replacing a selected historical run',async t=>{
 const f=fixture();t.after(()=>f.appUI.destroy());await f.appUI.refresh();assert.equal(f.applied.length,0);const before=f.calls.length;
 f.doc.hidden=true;await f.tick();assert.equal(f.calls.length,before);f.doc.hidden=false;
 f.setRun(completedRun('run2',1,'2026-11-23'));await f.tick();assert.equal(f.appUI.getState().run.id,'run2');assert.match(f.el('run-summary').textContent,/2026-11-23/);
 f.setRun(completedRun('run1',1,day));f.el('runs').value='run1';await f.el('runs').emit('change');
 f.setRun(completedRun('run3',1,'2026-11-24'));await f.tick();f.el('review').open=false;await f.el('review').emit('toggle');f.el('review').open=true;await f.el('review').emit('toggle');assert.equal(f.appUI.getState().run.id,'run1');assert.equal(f.el('runs').value,'run1');assert.match(f.el('run-summary').textContent,/2026-11-20/);assert.equal(f.applied.length,0);assert.ok(f.monitors.length>=3);
});
test('delayed detail responses cannot overwrite a newer historical review',async t=>{
 let delayed=false,release;const f=fixture({fetch:async path=>path.includes('?id=')&&delayed?new Promise(resolve=>release=resolve):null});t.after(()=>f.appUI.destroy());await f.appUI.refresh();delayed=true;await f.tick();
 const oldRun=completedRun('older',1,'2026-11-01');f.setRun(oldRun);f.el('runs').value='older';await f.el('runs').emit('change');const monitorCount=f.monitors.length;
 release({ok:true,status:200,json:async()=>({scheme:schemeValue(),runs:[completedRun('newer')],latestRun:completedRun('newer'),tracks:[],monitor:monitorValue()})});await settle();assert.equal(f.appUI.getState().run.id,'older');assert.equal(f.monitors.length,monitorCount);
});
test('periodic read failures retain the monitor and review and clear their own error after recovery',async t=>{
 let failure=null;const f=fixture({fetch:async path=>{if(path.includes('?id=')&&failure)throw failure;}});t.after(()=>f.appUI.destroy());f.setMonitor(monitorValue({active:[{code:'600000.SH',entryDay:day}]}));await f.appUI.refresh();const before=clone(f.appUI.getState()),monitors=f.monitors.length;
 failure=new TypeError('Failed to fetch');await f.tick();assert.deepEqual(f.appUI.getState().run,before.run);assert.deepEqual(f.appUI.getState().monitor,before.monitor);assert.equal(f.monitors.length,monitors);assert.equal(f.appUI.getState().readAt,before.readAt);assert.equal(f.appUI.getState().readError.id,'scheme1');assert.equal(f.el('status').dataset.error,'true');assert.match(f.el('status').textContent,/活跃 1 只.*方案数据读取暂时失败.*保留上次成功结果/);assert.doesNotMatch(f.el('status').textContent,/Failed to fetch/);
 failure=null;await f.tick();assert.equal(f.appUI.getState().readError,null);assert.equal(f.el('status').dataset.error,'false');assert.doesNotMatch(f.el('status').textContent,/读取暂时失败|Failed to fetch/);assert.deepEqual(f.appUI.getState().run,before.run);
 failure=Object.assign(Error('aborted'),{name:'AbortError'});await f.tick();assert.match(f.el('status').textContent,/读取方案请求已超时.*保留上次成功结果/);failure=null;await f.tick();assert.equal(f.el('status').dataset.error,'false');
});
test('missing or invalid monitor responses never clear the last monitor or send a write',async t=>{
 const f=fixture();t.after(()=>f.appUI.destroy());await f.appUI.refresh();const previous=clone(f.appUI.getState().monitor),count=f.monitors.length;
 f.setMonitor(null);await f.tick();assert.deepEqual(f.appUI.getState().monitor,previous);assert.equal(f.monitors.length,count);assert.match(f.el('status').textContent,/监控数据尚未返回.*保留上次监控/);
 f.setMonitor(monitorValue({schemeId:'another'}));await f.tick();assert.deepEqual(f.appUI.getState().monitor,previous);assert.equal(f.monitors.length,count);assert.match(f.el('status').textContent,/自动监控数据不完整.*保留上次结果/);assert.ok(f.calls.every(call=>call.init.method==='GET'));
});
test('HTTP read denials preserve accepted data and remain read-only',async t=>{
 for(const status of [401,403,409]){
  let denied=false;const f=fixture({fetch:async path=>path.includes('?id=')&&denied?{ok:false,status,json:async()=>({message:'方案读取被拒绝'})}:null});t.after(()=>f.appUI.destroy());await f.appUI.refresh();const before=clone(f.appUI.getState().monitor);denied=true;await f.tick();assert.deepEqual(f.appUI.getState().monitor,before);assert.equal(f.el('status').dataset.error,'true');assert.match(f.el('status').textContent,/方案读取被拒绝/);assert.ok(f.calls.every(call=>call.init.method==='GET'));
 }
});
test('a monitor rejected by the main controller cannot replace accepted review counts or its read time',async t=>{
 let accepted=true;const f=fixture({acceptMonitor:()=>accepted});t.after(()=>f.appUI.destroy());await f.appUI.refresh();
 const before=clone(f.appUI.getState());accepted=false;f.setMonitor(monitorValue({revision:0,active:[{code:'600009.SH'}]}));f.setRun(completedRun('stale'));
 await f.tick();assert.deepEqual(f.appUI.getState().monitor,before.monitor);assert.deepEqual(f.appUI.getState().run,before.run);assert.equal(f.appUI.getState().readAt,before.readAt);assert.match(f.el('status').textContent,/监控批次已过期.*保留上次监控与复盘/);assert.equal(f.monitors.length,1);
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
test('the actual controller preserves every nullable peer condition through draft and explicit applyScheme',async t=>{
 const f=mainFixture();t.after(()=>f.app.destroy());await f.app.start('strength');
 const peer={enabled:true,groupTopPercent:45,minPeers:6,minExcessReturn:1.2,minRecentExcess:.4,minImprovement:.2,minDownsideExcess:null,maxSupportDistance:3.5,minResistanceSpace:4,sectorTopPercent:50};
 const input=key=>f.ids.get('trend-screen').children.find(node=>node.dataset.trendPeer===key);
 for(const [key,value]of Object.entries(peer).filter(([key])=>key!=='enabled')){const node=input(key);assert.ok(node,'real HTML field '+key);node.value=value===null?'':String(value);await node.emit('change');}
 f.ids.get('trend-peer-enabled').checked=true;await f.ids.get('trend-peer-enabled').emit('change');assert.deepEqual(f.app.getSchemeDraft().config.settings.peer,peer);const original=clone(f.app.getSchemeDraft());
 input('groupTopPercent').value='90';await input('groupTopPercent').emit('change');input('minResistanceSpace').value='';await input('minResistanceSpace').emit('change');f.ids.get('trend-peer-enabled').checked=false;await f.ids.get('trend-peer-enabled').emit('change');
 assert.equal(f.app.getSchemeDraft().config.settings.peer.groupTopPercent,90);assert.equal(f.app.getSchemeDraft().config.settings.peer.minResistanceSpace,null);
 await f.app.applyScheme(original);assert.deepEqual(f.app.getSchemeDraft().config.settings.peer,peer);assert.equal(input('groupTopPercent').value,'45');assert.equal(input('minDownsideExcess').value,'');assert.equal(input('maxSupportDistance').value,'3.5');assert.equal(input('minResistanceSpace').value,'4');assert.equal(input('sectorTopPercent').value,'50');assert.equal(f.ids.get('trend-peer-enabled').checked,true);
 assert.deepEqual(f.app.getSchemeDraft().selection,original.selection);
});
