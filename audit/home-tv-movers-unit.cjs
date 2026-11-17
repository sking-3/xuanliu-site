'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../home-tv-movers.js'),'utf8');
function fixture(){
 const host={dataset:{},children:[],append(n){this.children.push(n);}},status={textContent:'正在准备'};
 const pending=new Map();let serial=0;
 const context=vm.createContext({document:{getElementById:id=>id==='tv-hotlists-host'?host:status,createElement:tag=>({tagName:tag})},
  location:{href:'https://example.invalid/site/index.html'},URL,
  setTimeout(fn,ms){assert.equal(ms,15000);pending.set(++serial,fn);return serial;},clearTimeout(id){pending.delete(id);}});
 vm.runInContext(source,context);
 return {host,status,pending,context,script:host.children[1],expire(){const tasks=[...pending.values()];pending.clear();tasks.forEach(fn=>fn());}};
}
test('renderer load is neutral and does not cancel the missing-iframe deadline',()=>{
 const f=fixture();f.script.onload();assert.equal(f.host.dataset.widgetState,'script-loaded');
 assert.equal(f.pending.size,1);assert.match(f.status.textContent,/等待来源行情/);
 f.expire();assert.equal(f.host.dataset.widgetState,'unverified');assert.match(f.status.textContent,/无法确认/);
 assert.doesNotMatch(f.status.textContent,/已打开|已更新|已连接|实时/);
});
test('an empty or failed iframe cannot turn renderer load into verified market data',()=>{
 const f=fixture();f.host.children[0].children=[{tagName:'iframe',loaded:true,body:''}];
 f.script.onload();f.expire();assert.equal(f.host.dataset.widgetState,'unverified');
 assert.equal(f.host.children[0].children.length,1,'leave source content and attribution visible');
});
test('late renderer load cannot replace timeout warning or extend its deadline',()=>{
 const f=fixture();f.expire();const warning=f.status.textContent;f.script.onload();
 assert.equal(f.host.dataset.widgetState,'unverified');assert.equal(f.status.textContent,warning);assert.equal(f.pending.size,0);
});
test('script error remains unavailable before or after its load callback',()=>{
 for(const afterLoad of [false,true]){const f=fixture();if(afterLoad)f.script.onload();f.script.onerror();
  assert.equal(f.host.dataset.widgetState,'unavailable');assert.equal(f.pending.size,0);f.script.onload();f.expire();
  assert.equal(f.host.dataset.widgetState,'unavailable');assert.match(f.status.textContent,/暂不可用/);}
});
test('one bounded provider renderer keeps SSE and the owned-site chart destination',()=>{
 const f=fixture(),c=JSON.parse(f.script.textContent);
 assert.equal(c.exchange,'SSE');assert.equal(c.showChart,false);assert.equal(c.largeChartUrl,'https://example.invalid/site/chart.html');
 assert.equal(f.script.src,'https://s3.tradingview.com/external-embedding/embed-widget-hotlists.js');
 vm.runInContext(source,f.context);assert.equal(f.host.children.length,2);assert.equal(f.pending.size,1);
});
