'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('../screening/pattern-regimes-controller.js'),trend=require('../screening/trend-controller.js'),engine=require('../screening/trend-screen.js'),model=require('../control/model.js'),patterns=require('../screening/trend-patterns.js'),pool=require('../screening/market-pool.js');
const html=fs.readFileSync(require.resolve('../screening/index.html'),'utf8'),day='2026-11-23',asOf=day+'T08:10:00Z',generation='2026-11-23-123',sourceId='tickflow-free-forward-v1';
const clone=value=>JSON.parse(JSON.stringify(value)),settle=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
class Target{
 constructor(){this.events=new Map();}
 addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}
 removeEventListener(type,fn){this.events.get(type)?.delete(fn);}
 dispatchEvent(event){for(const fn of this.events.get(event.type)||[])fn(event);}
}
class Element extends Target{
 constructor(tag='div'){super();this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.own='';this.value='';this.parentNode=null;this.hidden=false;this.checked=false;}
 get textContent(){return this.own+this.children.map(node=>node.textContent).join('');}
 set textContent(value){this.replaceChildren();this.own=String(value);}
 append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
 insertBefore(node,before){if(node===before)return;node.remove();this.children.splice(before?this.children.indexOf(before):this.children.length,0,node);node.parentNode=this;}
 replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this.own='';this.append(...nodes);}
 remove(){if(this.parentNode){const list=this.parentNode.children;list.splice(list.indexOf(this),1);this.parentNode=null;}}
 setAttribute(key,value){this.attrs[key]=String(value);}
 querySelectorAll(selector){const key=selector.slice(1,-1).replace(/^data-/,'').replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());return this.children.filter(node=>node.dataset[key]!==undefined);}
 closest(selector){return selector==='[data-pattern-regime]'?this.dataset.patternRegime!==undefined?this:this.parentNode?.closest(selector):null;}
}
function documentFixture(){
 const env=new Target(),ids=new Map(),data=[],timeouts=new Map(),intervals=new Map(),storage=new Map();let next=0;
 for(const match of html.matchAll(/<(\w+)\b([^>]*)>/g)){
  const node=new Element(match[1]),id=/\bid="([^"]+)"/.exec(match[2]);if(id)ids.set(id[1],node);
  for(const attr of match[2].matchAll(/data-(trend-[\w-]+)="([^"]*)"/g)){node.dataset[attr[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=attr[2];data.push(node);}
 }
 ids.get('trend-screen').append(...data);ids.get('trend-lookback').value='20';
 env.setTimeout=(fn,ms)=>{const id=++next;timeouts.set(id,{fn,ms});return id;};env.clearTimeout=id=>timeouts.delete(id);
 env.setInterval=(fn,ms)=>{const id=++next;intervals.set(id,{fn,ms});return id;};env.clearInterval=id=>intervals.delete(id);
 env.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 env.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options.detail;}};
 const doc={defaultView:env,hidden:false,getElementById:id=>ids.get(id),createElement:tag=>new Element(tag)};
 return {doc,env,ids,timeouts,intervals,storage,el:id=>ids.get('pattern-regimes'+(id?'-'+id:'')),tick:async()=>{for(const timer of intervals.values())timer.fn();await settle();}};
}
const current=()=>({generation,day,asOf,sourceId,patternVersion:patterns.version,lookback:20,reference:{code:'000300.SH'}});
test('the pattern surface keeps the latest shared design navigation and working import controls',()=>{
 assert.match(html,/href="\.\.\/content-materials\.css\?v=/);assert.match(html,/href="\.\.\/academy\/index\.html">交易员研习/);
 assert.match(html,/<button class="review-picker" id="review-picker" type="button">选择文件<\/button>/);assert.match(html,/<input id="research-file"[^>]* hidden>/);assert.match(html,/<p id="file-state" role="status">还没有导入历史记录。<\/p>/);
 assert.equal([...html.matchAll(/id="pattern-regimes"/g)].length,1);assert.equal([...html.matchAll(/src="pattern-regimes-controller\.js\?/g)].length,1);
});
function stats(extra={}){return {sampleCount:50,stockCount:30,signalDayCount:25,fromDay:'2026-08-01',toDay:'2026-10-30',meanReturnPercent:2,medianReturnPercent:1.5,meanExcessPercent:.4,positiveRate:.6,targetHitRate:.4,worstDrawdownPercent:6,...extra};}
function payload(extra={}){
 return {schema:'books.a-share.pattern-regimes.v1',version:'books.pattern-regimes.2026-11-24.v1',generation,day,asOf,computedAt:day+'T08:20:00Z',sourceId,benchmark:{code:'000300.SH'},policy:{patternVersion:patterns.version,lookback:20,horizon:15,targetReturnPercent:5,trainDays:120,recentDays:60,testDays:180,foldDays:20,purgeDays:15},coverage:{readyCount:100,universeCount:102,historyStart:'2024-11-01',historyEnd:day,warning:'历史统计以当前名册为参照'},summary:{reason:'仅标记通过样本外检验的固定形态'},patterns:[{id:'regain-ma-20',label:'收盘重回MA20',status:'effective',recommended:true,reasons:['近期与样本外均通过'],recent:stats(),validation:stats({sampleCount:21,medianReturnPercent:.7,meanExcessPercent:.2,worstDrawdownPercent:12})}],candidates:[{code:'600005.SH',name:'股票5',patternIds:['regain-ma-20'],formedAt:day}],method:{returnLabel:'次日开盘至第15日收盘的模拟净变化',drawdownLabel:'成交后收盘路径最大回撤',costLabel:'往返成本假设0.3%',universeWarning:'当前名册存在历史存活偏差'},...extra};
}
function fixture(){
 const f=documentFixture(),calls=[],filters=[];let view=current(),value=payload(),response=null;
 const app={getState:()=>view,setRegimeFilter:filter=>{filters.push(clone(filter));return true;}};
 f.env.fetch=async(path,init)=>{calls.push({path,init});if(response)return response(path,init);return {ok:true,json:async()=>clone(value)};};
 const component=ui.mount(f.doc,{app,autoLoad:false});
 return {...f,app,component,calls,filters,setCurrent:v=>view=v,setPayload:v=>value=v,setResponse:fn=>response=fn};
}
test('fixed-pattern panel reads only the exact current derived generation and keeps validation periods separate',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());await f.component.refresh();assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].path,'/api/a-share-daily/patterns?generation='+generation);assert.equal(f.calls[0].init.method,'GET');assert.equal(f.calls[0].init.credentials,'same-origin');assert.equal(f.calls[0].init.redirect,'error');assert.equal(f.calls[0].init.cache,'no-store');
 assert.equal(f.filters.length,0);assert.match(f.el('status').textContent,/已完成 1 类统计.*覆盖 100\/102 只.*1 类通过.*当前候选 1 只/);assert.match(f.el('source').textContent,/数据日 2026-11-23.*历史窗口 2024-11-01 至 2026-11-23.*固定20日结构.*15交易日.*来源时间.*计算.*页面读取/);assert.match(f.el('options').textContent,/与当前筛选条件取交集.*近60日 50 样本.*最差回撤 6%.*样本外180日 21 样本.*最差回撤 12%/);
 const record=f.el('records').children[0];assert.match(record.children[1].textContent,/近期60日.*成熟样本50.*中位净变化\+1.5%.*平均超额\+0.4%.*最差路径回撤6%/);assert.match(record.children[2].textContent,/样本外180日.*成熟样本21.*中位净变化\+0.7%.*最差路径回撤12%/);
 assert.match(f.el('method').textContent,/120日训练.*隔离15日.*逐20日.*180日样本外.*往返成本假设0.3%.*存活偏差/);assert.equal(f.timeouts.size,0);
});
test('explicit pattern clicks select only validated candidates and clear restores the original conditions',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());await f.component.refresh();
 const button=f.el('options').children[1];f.el('options').dispatchEvent({type:'click',target:button});
 assert.equal(f.component.getState().selected,'regain-ma-20');assert.deepEqual(f.filters.at(-1),{schema:'books.screening.pattern-filter.v1',generation,sourceId,day,benchmark:'000300.SH',lookback:20,patternVersion:patterns.version,patternId:'regain-ma-20',label:'收盘重回MA20',codes:['600005.SH']});assert.match(f.el('selection').textContent,/继续应用当前条件及15日剔除/);assert.equal(f.storage.size,0);
 f.el('clear').dispatchEvent({type:'click'});assert.equal(f.filters.at(-1),null);assert.equal(f.component.getState().selected,'');assert.equal(f.el('clear').attrs['aria-pressed'],'true');
});
test('no effective pattern is zero recommendations rather than zero data and missing statistics stay blank',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());const item=payload().patterns[0];f.setPayload(payload({patterns:[{...item,status:'insufficient',recommended:false,reasons:['独立信号日不足'],recent:stats({sampleCount:0,medianReturnPercent:null,meanExcessPercent:null,worstDrawdownPercent:null}),validation:stats({sampleCount:0,medianReturnPercent:null,meanExcessPercent:null,worstDrawdownPercent:null})}],candidates:[]}));await f.component.refresh();
 assert.match(f.el('status').textContent,/已完成 1 类统计.*覆盖 100\/102 只.*0 类通过，不推荐.*当前候选 0 只/);assert.match(f.el('selection').textContent,/无形态通过滚动验证.*未启用推荐/);assert.equal(f.el('options').children.length,0);assert.match(f.el('records').textContent,/样本不足.*成熟样本0.*中位净变化—.*平均超额—.*最差路径回撤—.*独立信号日不足/);assert.doesNotMatch(f.el('records').textContent,/0%/);assert.equal(f.filters.length,0);
});
test('a real zero remains zero and an older invalid or failed response preserves accepted statistics and filters',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());const p=payload();p.patterns[0].recent=stats({medianReturnPercent:0,meanExcessPercent:0,worstDrawdownPercent:0});f.setPayload(p);await f.component.refresh();f.component.select('*');const before=f.el('records').textContent;assert.match(before,/中位净变化0%.*平均超额0%.*最差路径回撤0%/);
 for(const extra of [{generation:'older-generation'},{day:'2026-11-20'},{sourceId:'other-source'},{computedAt:'2026-11-23T07:00:00Z'},{policy:{...p.policy,patternVersion:'old-version'}}]){f.setPayload({...p,...extra});await f.component.refresh();assert.equal(f.el('records').textContent,before);assert.equal(f.component.getState().data.generation,generation);assert.equal(f.component.getState().selected,'*');assert.match(f.el('status').textContent,/保留上次|拒绝回退/);}
 f.setResponse(async()=>({ok:false,json:async()=>({error:'cache_read_failed'})}));await f.component.refresh();assert.equal(f.el('records').textContent,before);assert.match(f.el('status').textContent,/缓存暂不可用.*保留上次结果/);
});
test('foreign or duplicate candidates and unvalidated recommendations are rejected before changing a filter',()=>{
 for(const modify of [p=>p.patterns[0].recommended=false,p=>p.candidates.push(clone(p.candidates[0])),p=>p.candidates[0].patternIds=['unknown'],p=>p.patterns[0].recent.medianReturnPercent=Infinity,p=>delete p.method,p=>delete p.policy.testDays,p=>p.patterns=[]]){const p=payload();modify(p);assert.throws(()=>ui.validate(p,current()),/不完整|不一致/);}
});
test('a generation changed while reading cannot replace the accepted panel or activate stale codes',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());await f.component.refresh();let release;f.setResponse(async()=>({ok:true,json:()=>new Promise(resolve=>release=()=>resolve(payload()))}));const pending=f.component.refresh();await settle();f.setCurrent({...current(),generation:'newer'});release();await pending;assert.equal(f.component.getState().data.generation,generation);assert.match(f.el('status').textContent,/读取期间日线批次已改变/);assert.equal(f.filters.length,0);
});
test('fixed20-day evidence is explicit when viewing60-day stocks and a declined filter keeps the previous selection',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());await f.component.refresh();f.setCurrent({...current(),lookback:60});f.component.select('*');assert.match(f.el('selection').textContent,/仅适用于同批次的20日.*当前下方保留常规筛选/);
 f.app.setRegimeFilter=()=>false;f.component.select('regain-ma-20');assert.equal(f.component.getState().selected,'*');assert.match(f.el('status').textContent,/保留原筛选/);
});
test('visibility and page lifecycle keep one minute poll and abort pending reads without bfcache destruction',async()=>{
 const f=fixture();await f.component.refresh();assert.deepEqual([...f.intervals.values()].map(x=>x.ms),[60000]);f.doc.hidden=true;await f.tick();assert.equal(f.calls.length,1);f.doc.hidden=false;await f.tick();assert.equal(f.calls.length,2);
 f.env.dispatchEvent({type:'pagehide',persisted:true});assert.equal(f.intervals.size,1);let signal;f.setResponse(async(path,init)=>new Promise((resolve,reject)=>{signal=init.signal;signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));}));const pending=f.component.refresh();await settle();f.env.dispatchEvent({type:'pagehide',persisted:false});await pending;assert.equal(signal.aborted,true);assert.equal(f.intervals.size,0);assert.equal(f.timeouts.size,0);
});
test('regime intersection is exact-batch and precedes the existing pagination without mutating cached records',()=>{
 const snapshot={...current()},filter={generation,day,sourceId,lookback:20,benchmark:'000300.SH',patternVersion:patterns.version,codes:['600005.SH','600007.SH']},records=Array.from({length:10},(_,i)=>({stock:{code:'60000'+i+'.SH'}})),before=clone(records);
 assert.deepEqual(trend.filterRegimeRecords(records,filter,snapshot,'000300.SH').slice(0,4).map(x=>x.stock.code),filter.codes);assert.deepEqual(records,before);
 for(const mismatch of [{generation:'old'},{day:'2026-11-20'},{sourceId:'other'},{lookback:60},{patternVersion:'other'}])assert.equal(trend.filterRegimeRecords(records,filter,{...snapshot,...mismatch},'000300.SH'),records);
 assert.equal(trend.filterRegimeRecords(records,filter,snapshot,'399001.SZ'),records);assert.equal(trend.regimeApplies(null,snapshot,'000300.SH'),false);
});
async function mountedTrend(){
 const f=documentFixture(),stocks=Array.from({length:10},(_,i)=>({code:'60000'+i+'.SH',name:'股票'+i,sector:'工业',exchange:'SH'}));
 const bars=Array.from({length:61},(_,i)=>({date:new Date(Date.parse(day+'T00:00:00Z')-(60-i)*86400000).toISOString().slice(0,10),close:100+i,volume:1000}));
 const requests=[],observed=[],disposed=[];
 f.env.fetch=async(path,init)=>{
  requests.push(path);const url=new URL(path,'https://books.test');
  if(url.pathname.endsWith('/state'))return {ok:true,json:async()=>({available:true,fullMarket:true,scope:'full-market',lastSuccess:{generation,day,asOf}})};
  const mode=url.searchParams.get('mode'),lookback=Number(url.searchParams.get('lookback'));
  return {ok:true,json:async()=>({generation,day,asOf,sourceId,patternVersion:patterns.version,mode,lookback,status:'complete',phase:'evaluated',limits:{enabled:false},reference:{code:'000300.SH'},fullMarket:true,total:stocks.length,marketUniverseCount:stocks.length,records:stocks.map(stock=>({stock,result:engine.evaluate({mode,bars,referenceBars:bars,code:stock.code,lookback,day,limits:{enabled:false}}),patterns:patterns.classify({bars,calendar:bars,lookback,day})}))})};
 };
 const app=trend.mount(f.doc,{engine,model,pool,patterns,configuration:model.normalizeConfig({settings:{mode:'market',limits:{enabled:false}}}),selection:{getContext:()=>({filtersActive:false})},charts:{create:()=>({observe(host,stock){observed.push(stock.code);host.append(new Element('iframe'));},dispose(host){disposed.push(host);host.replaceChildren();},destroy(){}})},autoLoad:false});
 await app.start('market');return {...f,app,requests,observed,disposed,articles:()=>f.ids.get('trend-results').children.filter(node=>node.tagName==='article')};
}
test('actual mounted cards intersect effective codes after15-day removal and before local pages, then restore without source requests',async t=>{
 const f=await mountedTrend();t.after(()=>f.app.destroy());f.ids.get('trend-display').value='4';f.ids.get('trend-display').dispatchEvent({type:'change'});assert.equal(f.articles().length,4);assert.equal(f.ids.get('trend-page').textContent,'1 / 3');
 f.app.setMonitor({schema:'books.screening.monitor.v1',schemeId:'scheme1',mode:'market',lookback:20,benchmark:'000300.SH',sourceId,engineVersion:model.engineVersion,patternVersion:patterns.version,day,generation,policy:{horizon:15,minimumReturnPercent:5},active:[],eliminated:[{code:'600005.SH',elimination:{decisionDay:day}}]});
 const filter={schema:'books.screening.pattern-filter.v1',generation,day,sourceId,lookback:20,benchmark:'000300.SH',patternVersion:patterns.version,patternId:'regain-ma-20',label:'收盘重回MA20',codes:['600005.SH','600007.SH']},requests=f.requests.length;
 assert.equal(f.app.setRegimeFilter(filter),true);assert.deepEqual(f.articles().map(node=>node.dataset.code),['600007.SH']);assert.equal(f.ids.get('trend-pagination').hidden,true);assert.match(f.ids.get('trend-status').textContent,/已移出15日未达标 1只.*收盘重回MA20/);assert.match(f.articles()[0].textContent,/近期有效形态候选/);assert.equal(f.requests.length,requests);
 assert.equal(f.app.setRegimeFilter({...filter,generation:'old'}),false);assert.deepEqual(f.articles().map(node=>node.dataset.code),['600007.SH']);assert.equal(f.app.setRegimeFilter(null),true);assert.equal(f.articles().length,4);assert.equal(f.ids.get('trend-count').textContent,'9 只');assert.equal(f.requests.length,requests);
});
test('actual60-day view never borrows20-day regime evidence or destroys its current chart cards',async t=>{
 const f=await mountedTrend();t.after(()=>f.app.destroy());const filter={schema:'books.screening.pattern-filter.v1',generation,day,sourceId,lookback:20,benchmark:'000300.SH',patternVersion:patterns.version,patternId:'*',label:'全部近期有效形态',codes:['600005.SH']};assert.equal(f.app.setRegimeFilter(filter),true);assert.equal(f.articles().length,1);
 f.ids.get('trend-lookback').value='60';await f.app.start('market');assert.equal(f.articles().length,10);assert.match(f.ids.get('trend-status').textContent,/20日口径未对齐.*保留常规筛选/);assert.doesNotMatch(f.articles()[0].textContent,/近期有效形态候选/);const nodes=f.articles().slice();f.app.render();assert.deepEqual(f.articles(),nodes);
});
