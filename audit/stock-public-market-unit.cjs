'use strict';
// Isolated lifecycle checks; no provider request, quotation or browser rendering.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'stock-public-market.js'),'utf8');
function setup(){
 const elements=Object.fromEntries(['status','loader','widget','recovery','reload'].map(name=>[name,{textContent:'',hidden:name==='recovery',disabled:false,events:{},addEventListener(type,fn){this.events[type]=fn;}}]));
 const timers=new Map();let resolveDefinition,reloads=0,sequence=0;
 const definition=new Promise(resolve=>{resolveDefinition=resolve;});
 vm.runInNewContext(source,{document:{querySelector(selector){return elements[selector.match(/^\[data-public-market-(.+)\]$/)?.[1]];}},customElements:{whenDefined(name){assert.equal(name,'tv-screener');return definition;}},location:{reload(){reloads++;}},setTimeout(fn,delay){assert.equal(delay,15000);timers.set(++sequence,fn);return sequence;},clearTimeout(id){timers.delete(id);}});
 return {elements,timers,register:async()=>{resolveDefinition();await Promise.resolve();},deadline(){for(const [id,fn]of [...timers]){timers.delete(id);fn();}},reloads:()=>reloads};
}
test('script failure exposes manual recovery and collapses the blank component without retrying',()=>{
 const h=setup();h.elements.loader.events.error();
 assert.equal(h.elements.widget.hidden,true);assert.equal(h.elements.recovery.hidden,false);assert.match(h.elements.status.textContent,/未能加载/);assert.match(h.elements.status.textContent,/不会自动重试/);assert.equal(h.timers.size,0);assert.equal(h.reloads(),0);
});
test('definition deadline exposes the same recovery without scheduling another attempt',()=>{
 const h=setup();h.deadline();
 assert.equal(h.elements.widget.hidden,true);assert.equal(h.elements.recovery.hidden,false);assert.match(h.elements.status.textContent,/数据暂不可用/);assert.equal(h.timers.size,0);assert.equal(h.reloads(),0);
});
test('registration cancels the deadline but does not claim verified quotation availability',async()=>{
 const h=setup();await h.register();
 assert.equal(h.elements.widget.hidden,false);assert.equal(h.elements.recovery.hidden,true);assert.equal(h.timers.size,0);assert.match(h.elements.status.textContent,/不代表报价已取得/);
 h.elements.loader.events.error();assert.equal(h.elements.recovery.hidden,true);
});
test('late registration restores the component after timeout without an extra request',async()=>{
 const h=setup();h.deadline();await h.register();
 assert.equal(h.elements.widget.hidden,false);assert.equal(h.elements.recovery.hidden,true);assert.match(h.elements.status.textContent,/组件已注册/);assert.equal(h.timers.size,0);assert.equal(h.reloads(),0);
});
test('reload occurs only on explicit action and a second click cannot duplicate it',()=>{
 const h=setup();h.elements.loader.events.error();assert.equal(h.reloads(),0);
 h.elements.reload.events.click();h.elements.reload.events.click();assert.equal(h.reloads(),1);assert.equal(h.elements.reload.disabled,true);
});
test('US recovery markup supplies an official source and keeps the existing attribution and page hierarchy',()=>{
 const html=fs.readFileSync(path.join(root,'us.html'),'utf8'),main=html.match(/<section class="stock-public-market"[^>]*>(.*?)<\/section>/s)?.[1];
 assert.ok(main);assert.match(main,/data-public-market-widget/);assert.match(main,/data-public-market-recovery hidden/);assert.match(main,/<button type="button" data-public-market-reload>重新加载页面<\/button>/);assert.match(main,/<a class="feed-source" href="https:\/\/www\.tradingview\.com\/markets\/stocks-usa\/" target="_blank" rel="noopener noreferrer">/);
 assert.equal((html.match(/<h1(?:\s|>)/g)||[]).length,1);assert.match(html,/<h2>美股行情与选股<\/h2>/);assert.match(html,/by TradingView/);assert.match(html,/当前不启用新策略或后台排程/);
});
