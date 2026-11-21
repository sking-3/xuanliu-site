'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Charts=require('../screening/stock-charts.js');
class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.events={};this.attributes={};this.className='';this.textContent='';this.hidden=false;this.rect={top:0,bottom:300,left:0,right:600};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,handler){this.events[key]=handler;}
  removeEventListener(key,handler){if(this.events[key]===handler)delete this.events[key];}
  getBoundingClientRect(){return this.rect;}
  querySelector(selector){
    for(const child of this.children){
      if(selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.tagName===selector)return child;
      const found=child.querySelector(selector);if(found)return found;
    }
    return null;
  }
}
function harness({lazy=true,animationFrame=true}={}){
  const timers=new Map(),frames=new Map(),listeners=new Map(),mutations=[],viewports=[];let nextId=0;
  const env={setTimeout(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
    innerHeight:900,innerWidth:1200,addEventListener(type,handler){listeners.set(type,handler);},removeEventListener(type,handler){if(listeners.get(type)===handler)listeners.delete(type);},
    MutationObserver:class{constructor(callback){this.callback=callback;this.disconnected=false;mutations.push(this);}observe(target){this.target=target;}disconnect(){this.disconnected=true;}}};
  if(animationFrame){env.requestAnimationFrame=fn=>{const id=++nextId;frames.set(id,fn);return id;};env.cancelAnimationFrame=id=>frames.delete(id);}
  if(lazy)env.IntersectionObserver=class{
    constructor(callback,options){this.callback=callback;this.options=options;this.targets=new Set();this.disconnected=false;viewports.push(this);}
    observe(target){this.targets.add(target);}unobserve(target){this.targets.delete(target);}disconnect(){this.disconnected=true;this.targets.clear();}
  };
  const document={createElement:tag=>new Element(tag)},api=Charts.create({document,env});
  const near=(host,value=true)=>viewports[0].callback([{target:host,isIntersecting:value}]);
  function flushViewport(){
    const scheduled=animationFrame?[...frames.entries()]:[...timers.entries()].filter(([,timer])=>timer.delay===16);
    for(const [id,callback]of scheduled){if(animationFrame){frames.delete(id);callback();}else{timers.delete(id);callback.fn();}}
  }
  function frame(host,index){const element=new Element('iframe'),container=host.querySelector('.stock-chart-widget');host.querySelector('.tradingview-widget-container__widget').append(element);(index===undefined?mutations.findLast(observer=>observer.target===container):mutations[index]).callback();return element;}
  return {api,document,env,timers,frames,listeners,mutations,viewports,near,frame,flushViewport};
}
const stock={code:'600519.SH',name:'贵州茅台'};

test('UMD and CommonJS expose the same create contract without starting any requests',()=>{
  const scope={};vm.runInNewContext(fs.readFileSync(require.resolve('../screening/stock-charts.js'),'utf8'),scope);
  assert.equal(typeof scope.BooksStockCharts.create,'function');assert.deepEqual(Object.keys(Charts),['create']);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../screening/stock-charts.js'),'utf8'),/\bfetch\s*\(|XMLHttpRequest|WebSocket|setInterval/);
});
test('strict Shanghai and Shenzhen suffixes map to the fixed official daily candlestick widget',()=>{
  for(const [code,symbol]of [['600519.SH','SSE:600519'],['000333.SZ','SZSE:000333'],['000001.SZ','SZSE:000001']]){
    const h=harness({lazy:false}),host=new Element();h.api.observe(host,{code,name:'测试股票'});h.flushViewport();
    const script=host.querySelector('script'),config=JSON.parse(script.textContent);
    assert.equal(script.src,'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js');
    assert.equal(config.symbol,symbol);assert.equal(config.interval,'D');assert.equal(config.style,'1');assert.equal(config.timezone,'Asia/Shanghai');assert.equal(config.autosize,true);assert.equal(config.hide_top_toolbar,true);assert.equal(config.allow_symbol_change,false);
    assert.equal(host.querySelector('canvas'),null);assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].delay,15000);
    h.api.destroy();
  }
});
test('invalid, bare, lowercase, injected and Beijing codes never load a provider script',()=>{
  for(const code of ['600519','60051.SH','600519.sh',' 600519.SH','600519.SH\n','600519.SH/','600519.SH?foo=1','600519.SH"><script>','４００００１.SH','430047.BJ','SSE:600519',null,42]){
    const h=harness(),host=new Element();h.api.observe(host,{code});h.near(host);
    assert.equal(host.dataset.chartState,'unavailable',String(code));assert.equal(host.children[0].textContent,'日K暂不可用');
    assert.equal(host.querySelector('script'),null);assert.equal(host.querySelector('a'),null);assert.equal(h.mutations.length,0);assert.equal(h.timers.size,0);h.api.destroy();
  }
});
test('offscreen hosts remain idle and repeated visibility or observe calls mount only once',()=>{
  const h=harness(),host=new Element();h.api.observe(host,stock);h.api.observe(host,stock);
  assert.equal(h.viewports.length,1);assert.equal(h.viewports[0].options.rootMargin,'600px 0px');assert.equal(host.dataset.chartState,'waiting');assert.equal(h.timers.size,0);assert.equal(host.querySelector('script'),null);
  h.near(host,false);assert.equal(host.querySelector('script'),null);
  h.near(host);const script=host.querySelector('script');h.near(host);h.api.observe(host,stock);
  assert.equal(host.querySelector('script'),script);assert.equal(h.mutations.length,1);assert.equal(h.timers.size,1);assert.equal(h.viewports[0].targets.has(host),true);h.api.destroy();
});

test('one IO batch starts at most two actual viewport charts before earlier-listed nearby charts',()=>{
  const h=harness(),hosts=Array.from({length:4},()=>new Element());
  hosts[0].rect={top:1200,bottom:1500,left:0,right:600};hosts[1].rect={top:-700,bottom:-400,left:0,right:600};hosts[2].rect={top:0,bottom:300,left:0,right:600};hosts[3].rect={top:400,bottom:700,left:0,right:600};
  for(const host of hosts)h.api.observe(host,stock);h.viewports[0].callback(hosts.map(target=>({target,isIntersecting:true})));
  assert.deepEqual(hosts.map(host=>host.dataset.chartState),['waiting','waiting','loading','loading']);assert.equal(h.timers.size,2);
  h.frame(hosts[2]).events.load();assert.equal(hosts[0].dataset.chartState,'loading');assert.equal(hosts[1].dataset.chartState,'waiting');assert.equal(h.timers.size,2);
  h.frame(hosts[3]).events.load();assert.equal(hosts[1].dataset.chartState,'loading');assert.equal(h.timers.size,2);h.api.destroy();
});

test('a batch that frees a slot still collects all visibility changes before choosing its next chart',()=>{
  const h=harness(),hosts=Array.from({length:4},()=>new Element());hosts[2].rect={top:1200,bottom:1500,left:0,right:600};
  for(const host of hosts)h.api.observe(host,stock);h.near(hosts[0]);h.near(hosts[1]);
  h.viewports[0].callback([{target:hosts[2],isIntersecting:true},{target:hosts[0],isIntersecting:false},{target:hosts[3],isIntersecting:true}]);
  assert.equal(hosts[2].dataset.chartState,'waiting');assert.equal(hosts[3].dataset.chartState,'loading');assert.equal(h.mutations.length,3);assert.equal(h.timers.size,2);h.api.destroy();
});

test('load error timeout leaving and dispose all release an initialization slot',async()=>{
  for(const terminal of ['load','error','timeout','leave','dispose']){
    const h=harness(),hosts=Array.from({length:3},()=>new Element());for(const host of hosts)h.api.observe(host,stock);h.viewports[0].callback(hosts.map(target=>({target,isIntersecting:true})));
    const frame=h.frame(hosts[0]),load=frame.events.load,error=hosts[0].querySelector('script').onerror,timeout=[...h.timers.values()][0].fn;
    assert.equal(hosts[2].dataset.chartState,'waiting');assert.equal(h.timers.size,2);
    if(terminal==='load')load();else if(terminal==='error')error();else if(terminal==='timeout')timeout();else if(terminal==='leave')h.near(hosts[0],false);else{h.api.dispose(hosts[0]);await Promise.resolve();}
    assert.equal(hosts[2].dataset.chartState,'loading',terminal);assert.equal(h.mutations.length,3);assert.equal(h.timers.size,2);load();error();timeout();assert.equal(h.mutations.length,3);assert.equal(h.timers.size,2);h.api.destroy();
  }
});

test('queued charts that leave or are disposed never start and bulk disposal does not churn the queue',async()=>{
  const h=harness(),hosts=Array.from({length:20},()=>new Element());for(const host of hosts)h.api.observe(host,stock);h.viewports[0].callback(hosts.map(target=>({target,isIntersecting:true})));
  assert.equal(h.mutations.length,2);h.near(hosts[2],false);h.api.dispose(hosts[3]);
  for(const host of hosts)h.api.dispose(host);assert.equal(h.mutations.length,2);await Promise.resolve();assert.equal(h.mutations.length,2);assert.equal(h.timers.size,0);h.api.destroy();
});

test('four offscreen loaded charts are retained on their original hosts and reused with LRU eviction',()=>{
  const h=harness(),hosts=Array.from({length:6},()=>new Element()),frames=[];for(const host of hosts)h.api.observe(host,stock);
  for(let index=0;index<4;index++){h.near(hosts[index]);frames[index]=h.frame(hosts[index]);frames[index].events.load();h.near(hosts[index],false);}
  assert.equal(h.mutations.length,4);assert.equal(hosts.filter(host=>host.querySelector('iframe')).length,4);
  h.near(hosts[0]);assert.equal(hosts[0].querySelector('iframe'),frames[0]);assert.equal(h.mutations.length,4);h.near(hosts[0],false);
  h.near(hosts[4]);frames[4]=h.frame(hosts[4]);frames[4].events.load();h.near(hosts[4],false);
  assert.equal(hosts[1].dataset.chartState,'waiting');assert.equal(hosts[1].querySelector('iframe'),null);assert.equal(frames[1].events.load,undefined);assert.equal(hosts[0].querySelector('iframe'),frames[0]);assert.equal(hosts.filter(host=>host.querySelector('iframe')).length,4);
  h.near(hosts[1]);assert.equal(hosts[1].dataset.chartState,'loading');assert.equal(h.mutations.length,6);h.api.dispose(hosts[0]);assert.equal(hosts[0].children.length,0);h.api.destroy();assert.ok(hosts.every(host=>host.children.length===0));
});

test('geometry fallback uses the same two-slot visible-first queue and retains loaded charts for return visits',()=>{
  const h=harness({lazy:false}),hosts=Array.from({length:4},()=>new Element());hosts[0].rect={top:1200,bottom:1500,left:0,right:600};hosts[1].rect={top:-700,bottom:-400,left:0,right:600};
  for(const host of hosts)h.api.observe(host,stock);h.flushViewport();assert.deepEqual(hosts.map(host=>host.dataset.chartState),['waiting','waiting','loading','loading']);assert.equal(h.timers.size,2);
  const frame=h.frame(hosts[2]);frame.events.load();assert.equal(hosts[0].dataset.chartState,'loading');assert.equal(h.timers.size,2);
  hosts[2].rect={top:-1000,bottom:-700,left:0,right:600};h.listeners.get('scroll')();h.flushViewport();assert.equal(hosts[2].querySelector('iframe'),frame);const initialized=h.mutations.length;
  hosts[2].rect={top:0,bottom:300,left:0,right:600};h.listeners.get('scroll')();h.flushViewport();assert.equal(hosts[2].querySelector('iframe'),frame);assert.equal(h.mutations.length,initialized);h.api.destroy();
});

test('leaving while loading releases an embed and returning mounts a new isolated instance',()=>{
  const h=harness(),host=new Element();h.api.observe(host,stock);h.near(host);
  const script=host.querySelector('script'),oldError=script.onerror,timeout=[...h.timers.values()][0].fn,observer=h.mutations[0],frame=h.frame(host),oldLoad=frame.events.load;
  assert.equal(host.dataset.chartState,'loading');h.near(host,false);
  assert.equal(host.dataset.chartState,'waiting');assert.equal(host.querySelector('iframe'),null);assert.equal(host.querySelector('script'),null);assert.equal(script.onerror,null);assert.equal(frame.events.load,undefined);assert.equal(frame.events.error,undefined);assert.equal(observer.disconnected,true);assert.equal(h.timers.size,0);assert.equal(h.viewports[0].targets.has(host),true);
  h.near(host);const nextScript=host.querySelector('script');assert.notEqual(nextScript,script);
  oldError();timeout();observer.callback();oldLoad();
  assert.equal(host.dataset.chartState,'loading');assert.equal(host.querySelector('script'),nextScript);assert.equal(h.timers.size,1);assert.equal(h.mutations.length,2);h.api.destroy();
});

test('scrolling through2009 chart hosts keeps only the nearby embeds and supports returning to the start',()=>{
  const h=harness(),hosts=Array.from({length:2009},()=>new Element());for(const host of hosts)h.api.observe(host,stock);
  assert.equal(h.mutations.length,0);assert.equal(h.viewports[0].targets.size,2009);
  for(let index=0;index<hosts.length;index++){
    if(index>=4)h.near(hosts[index-4],false);
    h.near(hosts[index]);h.frame(hosts[index]).events.load();
  }
  assert.equal(hosts.filter(host=>host.querySelector('iframe')).length,8);assert.equal(hosts.filter(host=>host.dataset.chartState==='waiting').length,2001);assert.equal(h.timers.size,0);
  for(const host of hosts.slice(-4))h.near(host,false);h.near(hosts[0]);assert.equal(hosts[0].dataset.chartState,'loading');h.frame(hosts[0]).events.load();
  assert.equal(hosts.filter(host=>host.querySelector('iframe')).length,5);h.api.destroy();assert.equal(h.viewports[0].targets.size,0);assert.ok(hosts.every(host=>host.children.length===0));
});

test('geometry fallback batches2009 hosts and coalesces scroll and resize checks without mounting distant charts',()=>{
  const h=harness({lazy:false}),hosts=Array.from({length:2009},(_,index)=>{const host=new Element();host.rect={top:2000+index*400,bottom:2300+index*400,left:0,right:600};return host;});hosts[0].rect={top:0,bottom:300,left:0,right:600};
  for(const host of hosts)h.api.observe(host,stock);
  assert.equal(h.frames.size,1);assert.equal(h.mutations.length,0);assert.deepEqual([...h.listeners.keys()],['scroll','resize']);h.flushViewport();
  assert.equal(h.mutations.length,1);const firstFrame=h.frame(hosts[0]);firstFrame.events.load();
  hosts[0].rect={top:-1000,bottom:-700,left:0,right:600};hosts[2008].rect={top:800,bottom:1100,left:0,right:600};
  for(let index=0;index<10;index++)h.listeners.get('scroll')();h.listeners.get('resize')();assert.equal(h.frames.size,1);assert.equal(h.mutations.length,1);h.flushViewport();
  assert.equal(hosts[0].dataset.chartState,'frame-loaded');assert.equal(hosts[0].querySelector('iframe'),firstFrame);assert.equal(hosts[2008].dataset.chartState,'loading');assert.equal(hosts.filter(host=>host.querySelector('script')).length,2);assert.equal(h.mutations.length,2);h.api.destroy();assert.equal(h.listeners.size,0);assert.equal(h.timers.size,0);
});

test('geometry fallback follows the600px boundaries and ignores zero-size or horizontally hidden hosts',()=>{
  const h=harness({lazy:false}),hosts=Array.from({length:5},()=>new Element());
  hosts[0].rect={top:1500,bottom:1800,left:0,right:600};hosts[1].rect={top:-900,bottom:-600,left:0,right:600};hosts[2].rect={top:1501,bottom:1801,left:0,right:600};hosts[3].rect={top:0,bottom:0,left:0,right:0};hosts[4].rect={top:0,bottom:300,left:1201,right:1801};
  for(const host of hosts)h.api.observe(host,stock);h.flushViewport();assert.deepEqual(hosts.map(host=>host.dataset.chartState),['loading','loading','waiting','waiting','waiting']);
  h.env.innerHeight=400;h.listeners.get('resize')();h.flushViewport();assert.equal(hosts[0].dataset.chartState,'waiting');h.api.destroy();
});

test('fallback without animation frames schedules one16ms check and destroy cancels pending work and listeners',()=>{
  for(const animationFrame of [true,false]){
    const h=harness({lazy:false,animationFrame}),host=new Element();h.api.observe(host,stock);h.listeners.get('scroll')();
    const pending=animationFrame?[...h.frames.values()][0]:[...h.timers.values()][0].fn;assert.equal(animationFrame?h.frames.size:h.timers.size,1);if(!animationFrame)assert.equal([...h.timers.values()][0].delay,16);
    h.api.destroy();assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);pending();assert.equal(h.mutations.length,0);assert.equal(host.children.length,0);
  }
});
test('frame load reports only component loading and preserves visible official attribution',()=>{
  const h=harness({lazy:false}),host=new Element();h.api.observe(host,stock);h.flushViewport();const frame=h.frame(host);
  assert.equal(frame.title,'贵州茅台 日K（TradingView）');assert.equal(h.mutations[0].disconnected,true);
  const credit=host.querySelector('.tradingview-widget-copyright');assert.ok(credit);assert.equal(credit.hidden,false);assert.equal(credit.querySelector('a').href,'https://www.tradingview.com/');assert.equal(credit.querySelector('a').hidden,false);
  frame.events.load();assert.equal(host.dataset.chartState,'frame-loaded');assert.equal(h.timers.size,0);
  assert.equal(host.querySelector('.stock-chart-status').textContent,'');assert.doesNotMatch(host.dataset.chartState,/ready|verified/);h.api.destroy();
});
test('script failure removes the embed and leaves only the short empty state and complete chart link',()=>{
  const h=harness({lazy:false}),host=new Element();h.api.observe(host,stock);h.flushViewport();const error=host.querySelector('script').onerror;error();
  assert.equal(host.dataset.chartState,'unavailable');assert.equal(host.querySelector('.stock-chart-status').textContent,'日K暂不可用');
  assert.equal(host.querySelector('script'),null);assert.equal(host.querySelector('iframe'),null);assert.equal(host.querySelector('button'),null);assert.equal(host.querySelector('a').href,'../chart.html?tvwidgetsymbol=SSE%3A600519');
  assert.equal(h.timers.size,0);assert.equal(h.mutations[0].disconnected,true);h.api.observe(host,stock);error();assert.equal(h.mutations.length,1);h.api.destroy();
});

test('failed charts retain their link without automatic retries when leaving and returning',()=>{
  const h=harness(),host=new Element();h.api.observe(host,stock);h.near(host);host.querySelector('script').onerror();h.near(host,false);h.near(host);
  assert.equal(host.dataset.chartState,'unavailable');assert.equal(host.querySelector('a').href,'../chart.html?tvwidgetsymbol=SSE%3A600519');assert.equal(host.querySelector('script'),null);assert.equal(h.mutations.length,1);assert.equal(h.timers.size,0);h.api.destroy();
});
test('timeout before iframe creation or before iframe load cannot claim chart success',()=>{
  for(const withFrame of [false,true]){
    const h=harness({lazy:false}),host=new Element();h.api.observe(host,stock);h.flushViewport();
    const frame=withFrame?h.frame(host):null,lateLoad=frame?.events.load;
    [...h.timers.values()][0].fn();assert.equal(host.dataset.chartState,'unavailable');assert.equal(host.querySelector('script'),null);assert.equal(host.querySelector('iframe'),null);assert.equal(h.timers.size,0);
    lateLoad?.();assert.equal(host.dataset.chartState,'unavailable');assert.equal(host.querySelector('.stock-chart-status').textContent,'日K暂不可用');h.api.destroy();
  }
});
test('dispose cancels pending observation before a provider script exists',()=>{
  const h=harness(),host=new Element();h.api.observe(host,stock);h.api.dispose(host);h.near(host);
  assert.equal(host.children.length,0);assert.equal(host.dataset.chartState,undefined);assert.equal(h.viewports[0].targets.size,0);assert.equal(h.timers.size,0);assert.equal(h.mutations.length,0);h.api.destroy();
});
test('disposed old callbacks cannot overwrite a new chart mounted on the same host',()=>{
  const h=harness({lazy:false}),host=new Element();h.api.observe(host,stock);h.flushViewport();
  const script=host.querySelector('script'),oldError=script.onerror,timeout=[...h.timers.values()][0].fn,observer=h.mutations[0],frame=h.frame(host),oldLoad=frame.events.load;
  h.api.dispose(host);assert.equal(host.children.length,0);assert.equal(frame.events.load,undefined);assert.equal(frame.events.error,undefined);assert.equal(script.onerror,null);assert.equal(h.timers.size,0);
  h.api.observe(host,{code:'000333.SZ',name:'美的集团'});h.flushViewport();const nextScript=host.querySelector('script');
  oldError();timeout();observer.callback();oldLoad();
  assert.equal(host.dataset.chartState,'loading');assert.equal(host.querySelector('script'),nextScript);assert.equal(JSON.parse(nextScript.textContent).symbol,'SZSE:000333');assert.equal(h.timers.size,1);h.api.destroy();
});
test('multiple hosts have isolated timers and observers and destroy cleans all remaining embeds',()=>{
  const h=harness(),first=new Element(),second=new Element();h.api.observe(first,stock);h.api.observe(second,{code:'000333.SZ',name:'美的集团'});h.near(first);h.near(second);
  const secondScript=second.querySelector('script');h.api.dispose(first);assert.equal(h.timers.size,1);assert.equal(h.mutations[0].disconnected,true);assert.equal(second.querySelector('script'),secondScript);
  const frame=h.frame(second,1);assert.equal(frame.title,'美的集团 日K（TradingView）');frame.events.load();assert.equal(second.dataset.chartState,'frame-loaded');
  h.api.destroy();h.api.destroy();assert.equal(first.children.length,0);assert.equal(second.children.length,0);assert.equal(h.timers.size,0);assert.equal(h.viewports[0].disconnected,true);
  const unused=new Element();h.api.observe(unused,stock);assert.equal(unused.children.length,0);
});
