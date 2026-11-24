'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('../screening/entry-bars-controller.js');
const current=()=>({generation:'2026-11-23-123',day:'2026-11-23',asOf:'2026-11-23T08:00:00Z',sourceId:'tickflow-free-forward-v1'});
const clone=value=>JSON.parse(JSON.stringify(value)),settle=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
function payload(code='600000.SH'){
 const snapshot=current();return {schema:'books.a-share.entry-evidence.v1',...snapshot,stock:{code,name:'研究样本'},entryPolicyVersion:'books.entry-bars.2026-11-24.v1',entryOutcomeValidated:false,recommended:false,sourceFetchedAt:'2026-11-23T08:01:00Z',items:[
  {id:code+':2026-11-19',patternIds:['regain-ma-20'],formationDay:'2026-11-19',keyBarDay:'2026-11-20',triggerDay:'2026-11-23',replayStatus:'triggered_observation',status:'late_discovery',knownAt:'2026-11-23T08:01:00Z',lateDiscovery:true,reason:'日线已越过触发位，不代表实际成交',trigger:{above:10.32},invalidation:{below:9.84},recommendationReasons:['固定形态当前未通过完整门槛','本规则尚未独立完成收益验证'],chartUrl:'/api/a-share-daily/entry-chart?'+new URLSearchParams({generation:snapshot.generation,code,setup:'0'})}
 ]};
}
class Target{
 constructor(){this.events=new Map();}
 addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}
 removeEventListener(type,fn){this.events.get(type)?.delete(fn);}
 dispatchEvent(event){for(const fn of this.events.get(event.type)||[])fn(event);}
}
class Element extends Target{
 constructor(tag='div'){super();this.tagName=tag;this.children=[];this.parentNode=null;this.dataset={};this.className='';this.attributes={};this.own='';this.hidden=false;this.disabled=false;}
 set textContent(value){this.replaceChildren();this.own=String(value);}
 get textContent(){return this.own+this.children.map(node=>node.textContent).join('');}
 append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
 insertBefore(node,before){node.remove();this.children.splice(before?this.children.indexOf(before):this.children.length,0,node);node.parentNode=this;}
 replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this.own='';this.append(...nodes);}
 remove(){if(this.parentNode){const list=this.parentNode.children;list.splice(list.indexOf(this),1);this.parentNode=null;}}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 setAttribute(name,value){this.attributes[name]=String(value);}
 matches(selector){return selector.split(',').some(part=>{const value=part.trim();if(value==='[data-entry-toggle]')return this.dataset.entryToggle!==undefined;if(value==='[data-entry-retry]')return this.dataset.entryRetry!==undefined;if(value==='.trend-stock[data-code]')return this.className.split(' ').includes('trend-stock')&&this.dataset.code!==undefined;return value.startsWith('.')?this.className.split(' ').includes(value.slice(1)):this.tagName===value;});}
 closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector)||null;}
 querySelectorAll(selector){const nodes=[];for(const node of this.children){if(node.matches(selector))nodes.push(node);nodes.push(...node.querySelectorAll(selector));}return nodes;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function fixture(count=1){
 const body=new Element(),env=new Target(),requests=[],timeouts=new Map(),observers=[];let state=current(),response=async()=>({ok:true,json:async()=>payload()}),timer=0;
 env.setTimeout=(fn,ms)=>{const id=++timer;timeouts.set(id,{fn,ms});return id;};env.clearTimeout=id=>timeouts.delete(id);
 env.MutationObserver=class{constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
 env.fetch=async(path,init)=>{requests.push({path,init});return response(path,init);};
 const doc={defaultView:env,getElementById:id=>id==='trend-results'?body:null,createElement:tag=>new Element(tag)};
 const stockCards=[];for(let i=0;i<count;i++){const card=new Element('article'),chart=new Element();card.className='trend-stock';card.dataset.code=String(600000+i)+'.SH';chart.className='trend-stock-chart';const iframe=new Element('iframe');chart.append(iframe);card.append(chart);body.append(card);stockCards.push(card);}
 const app={getState:()=>state},component=ui.mount(doc,{app});
 const click=node=>body.dispatchEvent({type:'click',target:node});
 return {body,env,requests,timeouts,observers,stockCards,component,click,setCurrent:value=>state=value,setResponse:value=>response=value,open:()=>click(stockCards[0].querySelector('.entry-bars-toggle'))};
}

test('one hundred cards mount no requests; explicit click reads one bound entry and preserves its existing chart',async t=>{
 const f=fixture(100);t.after(()=>f.component.destroy());const card=f.stockCards[0],chart=card.querySelector('.trend-stock-chart'),iframe=chart.children[0];
 assert.equal(f.requests.length,0);assert.equal(f.body.querySelectorAll('.entry-bars-toggle').length,100);assert.equal(card.children[0].className,'entry-bars');
 f.open();await settle();assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/a-share-daily/entries?generation=2026-11-23-123&code=600000.SH');
 assert.equal(f.requests[0].init.redirect,'error');assert.equal(f.requests[0].init.credentials,'same-origin');assert.equal(f.requests[0].init.cache,'no-store');
 assert.equal(card.querySelector('.trend-stock-chart'),chart);assert.equal(chart.children[0],iframe);assert.equal(f.timeouts.size,0);
 const panel=card.querySelector('.entry-bars-panel');assert.equal(panel.hidden,false);assert.match(panel.textContent,/关键K研究回放 · 未推荐.*关键K日期2026-11-20.*突破参考位> 10.32.*失效参考位< 9.84.*F 形成 2026-11-19.*C 收盘确认 2026-11-20.*T 越位观察 2026-11-23/);
 assert.match(panel.textContent,/晚于当时开盘发现.*前复权研究参考位.*非实际委托报价.*未独立完成收益验证，不推荐/);
 assert.equal(panel.querySelector('img').src,payload().items[0].chartUrl);assert.equal(panel.querySelector('img').loading,'lazy');
 f.open();assert.equal(panel.hidden,true);f.open();await settle();assert.equal(f.requests.length,1);
});

test('an empty evidence list and an unconfirmed last formation never invent a trigger or a buy point',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());f.setResponse(async()=>({ok:true,json:async()=>({...payload(),items:[]})}));f.open();await settle();assert.match(f.stockCards[0].textContent,/没有已形成的关键K证据.*不补造入场点/);assert.equal(f.stockCards[0].querySelectorAll('img').length,0);
 const formed=payload(),item=formed.items[0];Object.assign(item,{keyBarDay:null,triggerDay:null,trigger:null,replayStatus:'waiting_confirmation',status:'waiting_confirmation',lateDiscovery:false,chartUrl:null});
 const other=fixture();t.after(()=>other.component.destroy());other.setResponse(async()=>({ok:true,json:async()=>formed}));other.open();await settle();assert.match(other.stockCards[0].textContent,/形成K · 尚未确认.*形成K日期2026-11-19.*突破参考位待收盘确认/);assert.doesNotMatch(other.stockCards[0].textContent,/T 越位观察/);
});

test('wrong code, generation, date, source, rule, future candles and external charts are rejected',()=>{
 const base=payload();
 for(const extra of [{generation:'older'},{day:'2026-11-20'},{asOf:'2026-11-23T07:00:00Z'},{sourceId:'other'},{stock:{code:'600001.SH'}},{entryOutcomeValidated:true},{recommended:true},{entryPolicyVersion:'other'}])assert.throws(()=>ui.validate({...base,...extra},current(),'600000.SH'),/不一致/);
 for(const changes of [{formationDay:'2026-11-24'},{keyBarDay:'2026-11-19'},{triggerDay:'2026-11-20'},{knownAt:'invalid'},{chartUrl:'https://third-party.example/chart.svg'},{chartUrl:'/api/a-share-daily/entry-chart?generation=older&code=600000.SH&setup=0'},{trigger:{above:9}}]){const invalid=clone(base);Object.assign(invalid.items[0],changes);assert.throws(()=>ui.validate(invalid,current(),'600000.SH'));}
 const sameDay=clone(base);Object.assign(sameDay.items[0],{keyBarDay:null,triggerDay:'2026-11-19',trigger:null,replayStatus:'unexecutable',status:'unexecutable',lateDiscovery:false});assert.equal(ui.validate(sameDay,current(),'600000.SH'),sameDay);
});

test('every real entry-module terminal and pending state passes the public evidence projection',async()=>{
 const {analyzeEntryBars}=await import('../server/a-share-entry-bars.mjs'),patterns=require('../screening/trend-patterns.js');
 const dates=[];for(let time=Date.UTC(2024,0,1);dates.length<67;time+=86400000){const date=new Date(time);if(date.getUTCDay()!==0&&date.getUTCDay()!==6)dates.push(date.toISOString().slice(0,10));}
 const candle=(index,changes={})=>({date:dates[index],open:100,high:101,low:99,close:100,volume:1000,...changes});
 const states=[['waiting_confirmation',62],['waiting_trigger',63],['triggered_observation',64],['invalidated',64,{low:97,high:103,close:102}],['expired',66,{high:103,close:102}],['unavailable',64,{volume:0}],['unexecutable',64,{open:104,high:104,low:104,close:104}],['ambiguous',64,{low:97,high:104}],['chased',64,{open:105.07,high:107,low:104,close:106}]];
 for(const [expected,count,triggerChanges]of states){
  const day=dates[count-1],asOf=day+'T08:00:00Z',bars=Array.from({length:count},(_,i)=>candle(i));bars[61]=candle(61,{low:98,close:100.5});
  if(count>62)bars[62]=candle(62,{open:100.5,high:103,low:100,close:102,volume:1100});
  for(let i=63;i<count;i++)bars[i]=candle(i,{open:102,high:104,low:101,close:103.5,...triggerChanges});
  const result=analyzeEntryBars({stock:{code:'600000.SH'},bars,calendar:dates.slice(0,count),patterns,matches:input=>input.day===dates[61]?['regain-ma-20']:[],day,asOf,sourceId:'offline',generation:'fixture',sourceFetchedAt:asOf,policyKnownAt:dates[0]+'T00:00:00Z',nextSessionDay:dates[count],now:()=>Date.parse(asOf)+1000}),setup=result.setups[0];
  assert.equal(setup.replayStatus,expected);
  const value={schema:'books.a-share.entry-evidence.v1',generation:result.generation,sourceId:result.sourceId,day,asOf,stock:result.stock,entryPolicyVersion:result.entryPolicyVersion,entryOutcomeValidated:false,recommended:false,items:[{id:setup.id,patternIds:setup.patternIds,formationDay:setup.formation.date,keyBarDay:setup.keyBar?.date||null,triggerDay:setup.observedEvent?.date||null,replayStatus:setup.replayStatus,status:setup.status,knownAt:setup.knownAt,lateDiscovery:setup.lateDiscovery,reason:setup.reason,trigger:setup.trigger,invalidation:setup.invalidation,recommendationReasons:setup.recommendationReasons,chartUrl:null}]};
  assert.equal(ui.validate(value,result,'600000.SH'),value,expected);
 }
});

test('switching generation or removing a card aborts pending work and late data cannot populate another card',async t=>{
 for(const mode of ['generation','removed','code']){
  const f=fixture();t.after(()=>f.component.destroy());let resolve;f.setResponse(()=>new Promise(done=>resolve=done));f.open();assert.equal(f.requests.length,1);
  if(mode==='generation')f.setCurrent({...current(),generation:'new-generation'});
  if(mode==='removed')f.stockCards[0].remove();
  if(mode==='code')f.stockCards[0].dataset.code='600001.SH';
  f.component.sync();assert.equal(f.requests[0].init.signal.aborted,true);resolve({ok:true,json:async()=>payload()});await settle();
  assert.equal(f.body.querySelectorAll('img').length,0);assert.equal(f.component.getState().some(record=>record.data),false);
  if(mode!=='removed')assert.equal(f.stockCards[0].querySelector('.entry-bars-toggle').attributes['aria-expanded'],'false');
 }
});

test('closing cancels a fetch; error retry stays in the same generation and errors do not start background polling',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());let resolve;f.setResponse(()=>new Promise(done=>resolve=done));f.open();f.open();assert.equal(f.requests[0].init.signal.aborted,true);resolve({ok:true,json:async()=>payload()});await settle();assert.equal(f.component.getState()[0].data,null);
 f.setResponse(async()=>({ok:false,status:503}));f.open();await settle();assert.match(f.stockCards[0].textContent,/HTTP 503/);assert.equal(f.requests.length,2);
 f.setResponse(async()=>({ok:true,json:async()=>payload()}));f.click(f.stockCards[0].querySelector('.entry-bars-retry'));await settle();assert.equal(f.requests.length,3);assert.equal(f.component.getState()[0].error,null);assert.equal(f.component.getState()[0].data.generation,current().generation);
 const image=f.stockCards[0].querySelector('img');image.dispatchEvent({type:'error'});assert.match(f.stockCards[0].textContent,/图表未能载入.*日期和参考位证据仍保留/);assert.equal(f.requests.length,3);
});

test('batch update listeners reconcile recycled cards and cleanup leaves existing cards and charts intact',async()=>{
 const f=fixture(),card=f.stockCards[0],chart=card.querySelector('.trend-stock-chart');f.setCurrent({...current(),generation:'new-generation'});f.env.dispatchEvent({type:'books:trend-run-finished'});await settle();
 assert.match(f.component.getState()[0].binding,/new-generation/);assert.equal(f.requests.length,0);
 f.component.destroy();assert.equal(f.observers[0].disconnected,true);assert.equal(card.querySelector('.entry-bars'),null);assert.equal(card.querySelector('.trend-stock-chart'),chart);assert.equal(f.timeouts.size,0);
});

test('screening adds only two isolated resources and keeps the approved shared UI resources',()=>{
 const html=fs.readFileSync(require.resolve('../screening/index.html'),'utf8');
 for(const resource of ['entry-bars.css','entry-bars-controller.js','desk-skin.css','content-materials.css','stock-charts.js','pattern-regimes-controller.js','selection-shell.js'])assert.equal([...html.matchAll(new RegExp('(?:href|src)="(?:\\.\\./)?'+resource.replaceAll('.','\\.')+'\\?','g'))].length,1,resource);
 assert.match(html,/id="trend-results"/);assert.match(html,/href="\.\.\/academy\/index\.html">交易员研习/);
});
