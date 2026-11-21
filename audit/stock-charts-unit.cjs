'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Charts=require('../screening/stock-charts.js');
class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.events={};this.attributes={};this.className='';this.textContent='';this.hidden=false;}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,handler){this.events[key]=handler;}
  removeEventListener(key,handler){if(this.events[key]===handler)delete this.events[key];}
  querySelector(selector){
    for(const child of this.children){
      if(selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.tagName===selector)return child;
      const found=child.querySelector(selector);if(found)return found;
    }
    return null;
  }
}
function harness({lazy=true}={}){
  const timers=new Map(),mutations=[],viewports=[];let nextId=0;
  const env={setTimeout(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
    MutationObserver:class{constructor(callback){this.callback=callback;this.disconnected=false;mutations.push(this);}observe(target){this.target=target;}disconnect(){this.disconnected=true;}}};
  if(lazy)env.IntersectionObserver=class{
    constructor(callback,options){this.callback=callback;this.options=options;this.targets=new Set();this.disconnected=false;viewports.push(this);}
    observe(target){this.targets.add(target);}unobserve(target){this.targets.delete(target);}disconnect(){this.disconnected=true;this.targets.clear();}
  };
  const document={createElement:tag=>new Element(tag)},api=Charts.create({document,env});
  const near=(host,value=true)=>viewports[0].callback([{target:host,isIntersecting:value}]);
  function frame(host,index=mutations.length-1){const element=new Element('iframe');host.querySelector('.tradingview-widget-container__widget').append(element);mutations[index].callback();return element;}
  return {api,document,env,timers,mutations,viewports,near,frame};
}
const stock={code:'600519.SH',name:'贵州茅台'};

test('UMD and CommonJS expose the same create contract without starting any requests',()=>{
  const scope={};vm.runInNewContext(fs.readFileSync(require.resolve('../screening/stock-charts.js'),'utf8'),scope);
  assert.equal(typeof scope.BooksStockCharts.create,'function');assert.deepEqual(Object.keys(Charts),['create']);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../screening/stock-charts.js'),'utf8'),/\bfetch\s*\(|XMLHttpRequest|WebSocket|setInterval/);
});
test('strict Shanghai and Shenzhen suffixes map to the fixed official daily candlestick widget',()=>{
  for(const [code,symbol]of [['600519.SH','SSE:600519'],['000333.SZ','SZSE:000333'],['000001.SZ','SZSE:000001']]){
    const h=harness({lazy:false}),host=new Element();h.api.observe(host,{code,name:'测试股票'});
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
  assert.equal(h.viewports.length,1);assert.equal(h.viewports[0].options.rootMargin,'200px 0px');assert.equal(host.dataset.chartState,'waiting');assert.equal(h.timers.size,0);assert.equal(host.querySelector('script'),null);
  h.near(host,false);assert.equal(host.querySelector('script'),null);
  h.near(host);const script=host.querySelector('script');h.near(host);h.api.observe(host,stock);
  assert.equal(host.querySelector('script'),script);assert.equal(h.mutations.length,1);assert.equal(h.timers.size,1);assert.equal(h.viewports[0].targets.has(host),false);h.api.destroy();
});
test('frame load reports only component loading and preserves visible official attribution',()=>{
  const h=harness({lazy:false}),host=new Element();h.api.observe(host,stock);const frame=h.frame(host);
  assert.equal(frame.title,'贵州茅台 日K（TradingView）');assert.equal(h.mutations[0].disconnected,true);
  const credit=host.querySelector('.tradingview-widget-copyright');assert.ok(credit);assert.equal(credit.hidden,false);assert.equal(credit.querySelector('a').href,'https://www.tradingview.com/');assert.equal(credit.querySelector('a').hidden,false);
  frame.events.load();assert.equal(host.dataset.chartState,'frame-loaded');assert.equal(h.timers.size,0);
  assert.equal(host.querySelector('.stock-chart-status').textContent,'');assert.doesNotMatch(host.dataset.chartState,/ready|verified/);h.api.destroy();
});
test('script failure removes the embed and leaves only the short empty state and complete chart link',()=>{
  const h=harness({lazy:false}),host=new Element();h.api.observe(host,stock);const error=host.querySelector('script').onerror;error();
  assert.equal(host.dataset.chartState,'unavailable');assert.equal(host.querySelector('.stock-chart-status').textContent,'日K暂不可用');
  assert.equal(host.querySelector('script'),null);assert.equal(host.querySelector('iframe'),null);assert.equal(host.querySelector('button'),null);assert.equal(host.querySelector('a').href,'../chart.html?tvwidgetsymbol=SSE%3A600519');
  assert.equal(h.timers.size,0);assert.equal(h.mutations[0].disconnected,true);h.api.observe(host,stock);error();assert.equal(h.mutations.length,1);h.api.destroy();
});
test('timeout before iframe creation or before iframe load cannot claim chart success',()=>{
  for(const withFrame of [false,true]){
    const h=harness({lazy:false}),host=new Element();h.api.observe(host,stock);
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
  const h=harness({lazy:false}),host=new Element();h.api.observe(host,stock);
  const script=host.querySelector('script'),oldError=script.onerror,timeout=[...h.timers.values()][0].fn,observer=h.mutations[0],frame=h.frame(host),oldLoad=frame.events.load;
  h.api.dispose(host);assert.equal(host.children.length,0);assert.equal(frame.events.load,undefined);assert.equal(frame.events.error,undefined);assert.equal(script.onerror,null);assert.equal(h.timers.size,0);
  h.api.observe(host,{code:'000333.SZ',name:'美的集团'});const nextScript=host.querySelector('script');
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
