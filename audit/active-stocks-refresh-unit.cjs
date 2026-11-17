'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../home-active-stocks.js'),fixture=require('./active-stocks-fixture.cjs');
const pending=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
function bus(){
 const listeners=new Map();
 return {addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
  removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
  emit(name,event={}){return Promise.all([...(listeners.get(name)||[])].map(fn=>fn(event)));},
  count(){return [...listeners.values()].reduce((n,set)=>n+set.size,0);}};
}
class Element{
 constructor(){this.dataset={};this.children=[];this.attrs={};this.own='';}
 set textContent(value){this.own=String(value);this.children=[];}
 get textContent(){return this.own+this.children.map(child=>child.textContent).join('');}
 set innerHTML(_){throw Error('No HTML injection');}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;this.own='';}
 setAttribute(key,value){this.attrs[key]=String(value);}
}
function harness(fetcher){
 const nodes=Object.fromEntries(['home-active-stocks','active-stocks-status','active-stocks-list','active-stocks-meta'].map(id=>[id,new Element()]));
 const events=bus(),doc={...bus(),visibilityState:'visible',getElementById:id=>nodes[id],createElement:()=>new Element()};
 let time=Date.parse('2026-11-13T08:00:00.000Z'),id=0;
 const tasks=new Map(),timers={
  setInterval(fn,delay){tasks.set(++id,{fn,delay,kind:'interval'});return id;},clearInterval(id){tasks.delete(id);},
  setTimeout(fn,delay){tasks.set(++id,{fn,delay,kind:'timeout'});return id;},clearTimeout(id){tasks.delete(id);},
  fire(delay,kind='interval'){const calls=[];for(const [id,task]of [...tasks])if(task.delay===delay&&task.kind===kind){
   if(kind==='timeout')tasks.delete(id);calls.push(task.fn());
  }return Promise.all(calls);}
 };
 const calls=[],options={events,timers,now:()=>time,fetch:(url,request)=>{calls.push({url,request});return fetcher(calls.length,request);}};
 return {doc,nodes,events,timers,tasks,calls,options,now:value=>{time=Date.parse(value);},
  start:()=>api.mount(doc,options),status:()=>nodes['active-stocks-status'].textContent,state:()=>nodes['home-active-stocks'].dataset.state};
}
function newer(){
 const data=fixture();data.publicationVersion=11;data.tradingDates=['2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-16'];
 data.dataAsOf='2026-11-16';data.generatedAt='2026-11-16T08:00:00.000Z';
 data.rows.forEach(row=>row.dailyAmounts.forEach((entry,i)=>entry.date=data.tradingDates[i]));
 data.rows[0].name='合成更新样本';return data;
}
test('clock-only ticks cross the 72-hour boundary without fetching or renewing source dates',async()=>{
 const h=harness(()=>response(fixture())),app=h.start();await app.ready;
 assert.match(h.status(),/日终快照/);
 h.now('2026-11-16T07:00:01.000Z');await h.timers.fire(api.CLOCK_MS);
 assert.match(h.status(),/历史快照.*2026-11-13/);assert.equal(h.calls.length,1);
 assert.equal(h.nodes['active-stocks-list'].children.length,3);app.destroy();
});
test('periodic reads adopt a newer cloud snapshot while hidden tabs defer reads until visible',async()=>{
 const h=harness(n=>response(n===1?fixture():newer())),app=h.start();await app.ready;
 h.now('2026-11-16T08:00:00.000Z');h.doc.visibilityState='hidden';
 await h.timers.fire(api.REFRESH_MS);assert.equal(h.calls.length,1);
 h.doc.visibilityState='visible';await h.doc.emit('visibilitychange');
 assert.equal(h.calls.length,2);assert.match(h.status(),/2026-11-16/);
 assert.match(h.nodes['active-stocks-list'].textContent,/合成更新样本/);
 await h.timers.fire(api.REFRESH_MS);assert.equal(h.calls.length,3);
 assert.equal(h.calls[2].url,api.FILE);assert.equal(h.calls[2].request.cache,'no-store');app.destroy();
});
test('remount, refresh, visibility and BFCache restoration coalesce one pending request',async()=>{
 const wait=pending(),h=harness(()=>wait.promise),app=h.start();
 assert.equal(h.start(),app);assert.equal(h.calls.length,1);
 assert.equal(app.refresh(),app.ready);
 const a=h.doc.emit('visibilitychange'),b=h.events.emit('pageshow',{persisted:true}),c=h.timers.fire(api.REFRESH_MS);
 assert.equal(h.calls.length,1);
 wait.resolve(response(fixture()));await Promise.all([app.ready,a,b,c]);
 assert.equal(h.calls.length,1);assert.equal(h.tasks.size,2);
 await h.events.emit('pageshow',{persisted:false});assert.equal(h.calls.length,1);app.destroy();
});
test('failed refreshes preserve real data dates and continue aging without pretending success',async()=>{
 const h=harness(n=>n===1?response(fixture()):new Response('Forbidden',{status:403})),app=h.start();await app.ready;
 h.now('2026-11-16T09:00:00.000Z');await app.refresh();
 assert.equal(h.state(),'stale');assert.match(h.status(),/更新失败 · 保留历史快照.*2026-11-13/);
 assert.equal(h.nodes['active-stocks-list'].children.length,3);assert.match(h.nodes['active-stocks-meta'].textContent,/2026-11-09 至 2026-11-13/);
 await h.timers.fire(api.CLOCK_MS);assert.equal(h.calls.length,2);app.destroy();
});
test('older dates, older generation times and changed same-generation payloads cannot replace a snapshot',async()=>{
 for(const mutate of [
  d=>{Object.assign(d,fixture());d.generatedAt='2026-11-17T08:00:00.000Z';},
  d=>{d.generatedAt='2026-11-16T07:30:00.000Z';},
  d=>{d.rows[0].name='被改写的同版本';}
 ]){
  const old=newer();mutate(old);const h=harness(n=>response(n===1?newer():old));h.now('2026-11-17T09:00:00.000Z');
  const app=h.start();await app.ready;await app.refresh();
  assert.equal(h.state(),'stale');assert.match(h.status(),/2026-11-16/);
  assert.match(h.nodes['active-stocks-list'].textContent,/合成更新样本/);
  assert.doesNotMatch(h.nodes['active-stocks-list'].textContent,/被改写/);app.destroy();
 }
});
test('a delayed obsolete owner cannot overwrite the new owner after destroy and remount',async()=>{
 const wait=pending(),h=harness(n=>n===1?wait.promise:response(newer()));h.now('2026-11-16T09:00:00.000Z');
 const first=h.start();first.destroy();assert.equal(h.calls[0].request.signal.aborted,true);
 const second=h.start();await second.ready;wait.resolve(response(fixture()));await first.ready;
 assert.match(h.status(),/2026-11-16/);assert.equal(h.state(),'ready');second.destroy();
 assert.equal(h.tasks.size,0);assert.equal(h.doc.count(),0);assert.equal(h.events.count(),0);
});
test('timeout preserves the last snapshot and does not overlap an uncooperative transport',async()=>{
 const wait=pending(),h=harness(n=>n===1?response(fixture()):n===2?wait.promise:response(newer())),app=h.start();await app.ready;
 const inflight=app.refresh();await h.timers.fire(10000,'timeout');
 assert.equal(h.calls[1].request.signal.aborted,true);assert.equal(h.state(),'stale');
 assert.equal(app.refresh(),inflight);assert.equal(h.calls.length,2);
 wait.resolve(response(fixture()));await inflight;
 assert.equal(h.state(),'stale');h.now('2026-11-16T09:00:00.000Z');await app.refresh();
 assert.equal(h.state(),'ready');assert.match(h.status(),/2026-11-16/);app.destroy();
});
test('a later failure cannot resurrect data removed by an explicit disabled snapshot',async()=>{
 const empty=require('../research-data/a-active-stocks.json');
 const h=harness(n=>n===1?response(fixture()):n===2?response(empty):new Response('offline',{status:503})),app=h.start();
 await app.ready;await app.refresh();assert.equal(h.state(),'not_configured');await app.refresh();
 assert.equal(h.state(),'unavailable');assert.equal(h.nodes['active-stocks-list'].children.length,0);
 assert.equal(h.nodes['active-stocks-meta'].textContent,'');assert.doesNotMatch(h.status(),/2026-11/);app.destroy();
});
test('non-persisted page exit aborts work and removes listeners and timers',async()=>{
 const wait=pending(),h=harness(()=>wait.promise),app=h.start();
 await h.events.emit('pagehide',{persisted:true});assert.equal(h.calls[0].request.signal.aborted,false);
 await h.events.emit('pagehide',{persisted:false});assert.equal(h.calls[0].request.signal.aborted,true);
 assert.equal(h.tasks.size,0);assert.equal(h.doc.count(),0);assert.equal(h.events.count(),0);
 wait.resolve(response(fixture()));await app.ready;assert.equal(h.nodes['active-stocks-list'].children.length,0);
});

function disabled(revision){
 const data=JSON.parse(JSON.stringify(require('../research-data/a-active-stocks.json')));
 if(revision===undefined)delete data.publicationVersion;else data.publicationVersion=revision;
 return data;
}
test('ready A then versioned withdrawal then identical cached A never restores the list',async()=>{
 const values=[fixture(),disabled(11),fixture(),fixture(),disabled(11),fixture()];
 const h=harness(n=>response(values[n-1])),app=h.start();await app.ready;
 assert.equal(h.nodes['active-stocks-list'].children.length,3);
 for(let i=1;i<values.length;i++){
  await app.refresh();assert.equal(h.nodes['active-stocks-list'].children.length,0);
  assert.equal(h.nodes['active-stocks-meta'].textContent,'');assert.doesNotMatch(h.status(),/2026-11-13/);
 }
 app.destroy();
});
test('legacy unversioned withdrawal before any ready record latches closed even for higher publications',async()=>{
 for(const version of [undefined,null]){
  const fresh=newer();fresh.publicationVersion=100;
  const values=[disabled(version),fixture(),disabled(99),fresh];
  const h=harness(n=>response(values[n-1]));h.now('2026-11-17T09:00:00.000Z');
  const app=h.start();await app.ready;
  for(let i=1;i<values.length;i++){await app.refresh();assert.equal(h.nodes['active-stocks-list'].children.length,0);}
  app.destroy();
 }
});
test('legacy withdrawal after A survives controller destruction and cannot be bypassed by remount',async()=>{
 const fresh=newer();fresh.publicationVersion=100;
 const values=[fixture(),disabled(undefined),fixture(),fresh],h=harness(n=>response(values[n-1]));
 h.now('2026-11-17T09:00:00.000Z');const first=h.start();await first.ready;await first.refresh();first.destroy();
 const second=h.start();await second.ready;assert.equal(h.nodes['active-stocks-list'].children.length,0);
 await second.refresh();assert.equal(h.nodes['active-stocks-list'].children.length,0);second.destroy();
});
test('versioned withdrawal restores only with a strictly newer publication and non-regressing source dates',async()=>{
 const equal=fixture();equal.publicationVersion=11;
 const bad=fixture();bad.publicationVersion=12;bad.generatedAt='2026-11-13T07:30:00.000Z';
 const valid=fixture();valid.publicationVersion=13;
 const values=[fixture(),disabled(11),equal,bad,valid],h=harness(n=>response(values[n-1])),app=h.start();
 await app.ready;await app.refresh();
 for(let i=0;i<2;i++){await app.refresh();assert.equal(h.nodes['active-stocks-list'].children.length,0);}
 await app.refresh();assert.equal(h.state(),'ready');assert.equal(h.nodes['active-stocks-list'].children.length,3);
 assert.match(h.status(),/2026-11-13/);app.destroy();
});
test('a stale disabled response still withdraws and cannot lower the existing publication floor',async()=>{
 const newerPublication=fixture();newerPublication.publicationVersion=11;
 const values=[fixture(),disabled(2),fixture(),newerPublication],h=harness(n=>response(values[n-1])),app=h.start();
 await app.ready;await app.refresh();await app.refresh();assert.equal(h.nodes['active-stocks-list'].children.length,0);
 await app.refresh();assert.equal(h.state(),'ready');app.destroy();
});
test('versioned withdrawal floor survives remount and remains effective against the same payload',async()=>{
 const values=[fixture(),disabled(11),fixture()],h=harness(n=>response(values[n-1])),first=h.start();
 await first.ready;await first.refresh();first.destroy();
 const second=h.start();await second.ready;assert.equal(h.nodes['active-stocks-list'].children.length,0);second.destroy();
});
test('newer source timestamps cannot disguise an older publication revision',async()=>{
 const old=newer();old.publicationVersion=10;old.generatedAt='2026-11-17T08:00:00.000Z';
 const h=harness(n=>response(n===1?newer():old));h.now('2026-11-17T09:00:00.000Z');
 const app=h.start();await app.ready;await app.refresh();assert.equal(h.state(),'stale');
 assert.match(h.status(),/2026-11-16/);app.destroy();
});
