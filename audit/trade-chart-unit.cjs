'use strict';
// Synthetic fixtures exercise interactions offline; none are published as account data.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),M=require('../trader/trade-replay-model.js');
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.attrs={};this.style={};this.clientWidth=600;this.clientHeight=410;this.offsetHeight=170;this.events={};this.classes=new Set();this.classList={add:x=>this.classes.add(x),remove:x=>this.classes.delete(x),toggle:(x,v)=>v?this.classes.add(x):this.classes.delete(x)};}
 set textContent(x){this.text=String(x);this.children=[];} get textContent(){return this.text||'';}
 append(...xs){this.children.push(...xs);} before(x){this.beforeNode=x;}replaceChildren(...xs){this.text='';this.children=xs;}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){this.events[k]=fn;}remove(){this.removed=true;}scrollIntoView(){this.scrolled=true;}
}
const content=e=>[e.textContent,...e.children.map(content)].join(' ');
function fixture(){
 const container=new Element(),playback=new Element(),bars=Array.from({length:4},(_,i)=>({time:1700002800+i*3600,open:85,high:90,low:80,close:87,volume:i+10})),time=bars[1].time*1000+1000,events=M.hyperliquidEvents([{coin:'SOL',side:'A',sz:'196.87',px:'86.762',startPosition:'-1',closedPnl:'0',fee:'.1',feeToken:'USDC',tid:1,oid:11,time},{coin:'SOL',side:'A',sz:'2',px:'87',startPosition:'-197.87',closedPnl:'0',fee:'.1',feeToken:'USDC',tid:2,oid:12,time:time+2000}]);
 const series={data:[],setData(x){this.data=x;},createPriceLine(x){return x;},removePriceLine(){}},volume={setData(x){this.data=x;}},marker={setMarkers(x){this.data=x;}},scale={fitContent(){},setVisibleLogicalRange(x){this.range=x;}},chart={addSeries(type){return type==='candle'?series:volume;},priceScale(){return {applyOptions(){}};},timeScale(){return scale;},subscribeCrosshairMove(f){this.move=f;},subscribeClick(f){this.click=f;},unsubscribeCrosshairMove(){this.move=null;},unsubscribeClick(){this.click=null;},remove(){this.removed=true;}};
 let timer=null,outside=0;const env={BooksTradeReplayModel:M,LightweightCharts:{createChart(){return chart;},CandlestickSeries:'candle',HistogramSeries:'volume',createSeriesMarkers(){return marker;}},document:{createElement:t=>new Element(t)},setInterval:fn=>{timer=fn;return 1;},clearInterval:()=>{timer=null;}};
 vm.runInNewContext(fs.readFileSync('trader/trade-chart.js','utf8'),env);
 const view=env.BooksTradeChart.mount(container,playback,{bars,events,seconds:3600,cycle:{symbol:'SOL',official:false,avgEntry:86,avgExit:84},name:'<img src=x onerror=bad>',onOutside:()=>outside++});
 return {container,playback,bars,events,series,volume,marker,chart,view,tooltip:container.children[0],tick:()=>timer?.(),outside:()=>outside};
}
test('hovered marker resolves one exact fill and safe text without fabricating a new position',()=>{
 const f=fixture();f.chart.move({hoveredInfo:{objectId:f.marker.data[0].id},time:f.bars[1].time,point:{x:590,y:400},seriesData:new Map([[f.series,f.bars[1]]])});
 assert.equal(f.tooltip.hidden,false);assert.match(content(f.tooltip),/加仓.*空仓.*196.87 @ 86.762.*17,080.83.*来源时间.*首次发现/);assert.ok(content(f.tooltip).includes('<img src=x onerror=bad>'));assert.equal(f.tooltip.children.some(x=>x.tag==='img'),false);assert.equal(f.tooltip.classes.has('is-pinned'),false);assert.ok(parseFloat(f.tooltip.style.left)<=242);assert.ok(parseFloat(f.tooltip.style.top)+f.tooltip.offsetHeight<=402);
 f.container.events.pointerleave();assert.equal(f.tooltip.hidden,true);
});
test('click pins all same-candle observations until close; moving elsewhere does not erase them',()=>{
 const f=fixture();f.chart.click({time:f.bars[1].time,point:{x:20,y:20}});assert.match(content(f.tooltip),/2 条操作/);assert.equal(f.tooltip.classes.has('is-pinned'),true);f.chart.move({time:f.bars[3].time,point:{x:60,y:40}});assert.equal(f.tooltip.hidden,false);f.container.events.pointerleave();assert.equal(f.tooltip.hidden,false);f.tooltip.children[0].children.at(-1).onclick();assert.equal(f.tooltip.hidden,true);
});
test('playback hides future markers, exact event seek updates cursor, and outside events stay outside',()=>{
 const f=fixture();f.playback.children[0].onclick();assert.equal(f.series.data.length,1);assert.equal(f.marker.data.length,0);f.tick();assert.equal(f.series.data.length,2);assert.equal(f.marker.data.length,2);f.view.focusEvent(f.events[0]);assert.equal(f.container.scrolled,true);assert.equal(f.tooltip.hidden,false);f.view.focusEvent({...f.events[0],time:1});assert.equal(f.outside(),1);assert.equal(f.series.data.length,2);f.view.destroy();assert.equal(f.chart.removed,true);assert.equal(f.chart.move,null);assert.equal(f.tooltip.removed,true);
});
test('volume uses actual source quantities alongside unchanged candle timestamps',()=>{
 const f=fixture();assert.equal(f.volume.data.length,4);assert.equal(f.volume.data[0].value,10);assert.equal(f.series.data[0].time,f.bars[0].time);
});
