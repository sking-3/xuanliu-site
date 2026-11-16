'use strict';
// Synthetic fixtures exercise interactions offline; none are published as account data.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),M=require('../trader/trade-replay-model.js');
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.attrs={};this.style={};this.clientWidth=600;this.clientHeight=410;this.offsetHeight=170;this.events={};this.classes=new Set();this.classList={add:x=>this.classes.add(x),remove:x=>this.classes.delete(x),toggle:(x,v)=>v?this.classes.add(x):this.classes.delete(x)};}
 set textContent(x){this.text=String(x);this.children=[];} get textContent(){return this.text||'';}
 append(...xs){this.children.push(...xs);} before(x){this.beforeNode=x;}replaceChildren(...xs){this.text='';this.children=xs;}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){this.events[k]=fn;}remove(){this.removed=true;}scrollIntoView(){this.scrolled=true;}
}
const content=e=>[e.textContent,...e.children.map(content)].join(' ');
function fixture(barCount=4,dense=false){
 const container=new Element(),playback=new Element(),bars=Array.from({length:barCount},(_,i)=>({time:1700002800+i*3600,open:85,high:90,low:80,close:87,volume:i+10})),time=bars[1].time*1000+1000,events=M.hyperliquidEvents([{coin:'SOL',side:'A',sz:'196.87',px:'86.762',startPosition:'-1',closedPnl:'0',fee:'.1',feeToken:'USDC',tid:1,oid:11,time},{coin:'SOL',side:'A',sz:'2',px:'87',startPosition:'-197.87',closedPnl:'0',fee:'.1',feeToken:'USDC',tid:2,oid:12,time:time+2000}]);
 if(dense){
   const example=events[0];
   for(let i=2;i<bars.length-1;i++)events.push({...example,id:'nearby-'+i,time:bars[i].time*1000+100});
 }
 const toolbar=new Element(),sizeObservers=new Set();
 const series={data:[],setData(x){this.data=x;},createPriceLine(x){return x;},removePriceLine(){}},volume={setData(x){this.data=x;}},marker={setMarkers(x){this.data=x;}},scale={
   range:null,observers:new Set(),
   fitContent(){this.setVisibleLogicalRange({from:-0.5,to:series.data.length-0.5});},
   getVisibleLogicalRange(){return this.range;},
   setVisibleLogicalRange(x){this.range={from:x.from,to:x.to};for(const fn of this.observers)fn(this.range);},
   subscribeVisibleLogicalRangeChange(fn){this.observers.add(fn);},
   unsubscribeVisibleLogicalRangeChange(fn){this.observers.delete(fn);},
   width(){return container.clientWidth;},
   subscribeSizeChange(fn){sizeObservers.add(fn);},unsubscribeSizeChange(fn){sizeObservers.delete(fn);},
   logicalToCoordinate(index){return this.range?(index-this.range.from)*container.clientWidth/(this.range.to-this.range.from):null;},
   timeToCoordinate(time){const index=bars.findIndex(bar=>bar.time===time);return index<0?null:this.logicalToCoordinate(index);}
  },chart={addSeries(type){return type==='candle'?series:volume;},priceScale(){return {applyOptions(){}};},timeScale(){return scale;},subscribeCrosshairMove(f){this.move=f;},subscribeClick(f){this.click=f;},unsubscribeCrosshairMove(){this.move=null;},unsubscribeClick(){this.click=null;},remove(){this.removed=true;}};
 let timer=null,outside=0;const env={BooksTradeReplayModel:M,LightweightCharts:{createChart(element,opts){chart.config=opts;return chart;},CandlestickSeries:'candle',HistogramSeries:'volume',createSeriesMarkers(){return marker;}},document:{createElement:t=>new Element(t)},setInterval:fn=>{timer=fn;return 1;},clearInterval:()=>{timer=null;}};
 vm.runInNewContext(fs.readFileSync('trader/trade-chart.js','utf8'),env);
 const view=env.BooksTradeChart.mount(container,playback,{toolbar,bars,events,seconds:3600,cycle:{symbol:'SOL',official:false,avgEntry:86,avgExit:84},name:'<img src=x onerror=bad>',onOutside:()=>outside++});
 return {container,playback,toolbar,sizeObservers,bars,events,series,volume,marker,chart,scale,view,tooltip:container.children[0],tick:()=>timer?.(),outside:()=>outside};
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
const nested=root=>[root,...root.children.flatMap(nested)];
const zoomButton=(fixture,label)=>nested(fixture.toolbar).find(el=>el.attrs['aria-label']===label);
const widthOf=range=>range.to-range.from;
test('zoom changes the candle time span around its center without changing text, replay data or marker identities',()=>{
 const f=fixture(100),originalRange=f.scale.getVisibleLogicalRange(),originalData=f.series.data,originalIds=f.marker.data.map(m=>m.id),font=f.chart.config.layout.fontSize;
 const controls=nested(f.toolbar).find(el=>el.attrs.role==='group'&&el.attrs['aria-label']==='图表缩放');assert.ok(controls);
 const plus=zoomButton(f,'放大图表'),minus=zoomButton(f,'缩小图表'),reset=zoomButton(f,'重置图表');
 const box=[f.container.clientWidth,f.container.clientHeight];const center=r=>(r.from+r.to)/2;
 plus.onclick();const enlarged=f.scale.getVisibleLogicalRange();assert.ok(widthOf(enlarged)<widthOf(originalRange));assert.ok(Math.abs(center(enlarged)-center(originalRange))<=1);
 minus.onclick();const wide=f.scale.getVisibleLogicalRange();assert.ok(widthOf(wide)>widthOf(enlarged));
 reset.onclick();assert.deepEqual(f.scale.getVisibleLogicalRange(),originalRange);
 assert.equal(f.series.data,originalData);assert.deepEqual(f.marker.data.map(m=>m.id),originalIds);
 assert.equal(f.chart.config.layout.fontSize,font);assert.deepEqual([f.container.clientWidth,f.container.clientHeight],box);
 assert.equal(f.container.style.transform,undefined);assert.equal(f.container.style.zoom,undefined);
 f.view.destroy();assert.equal(f.scale.observers.size,0);assert.equal(f.sizeObservers.size,0);
});
test('zoom limits and reset stay inside the loaded portion of a replay and preserve its cursor',()=>{
 const f=fixture(100),plus=zoomButton(f,'放大图表'),minus=zoomButton(f,'缩小图表');
 for(let i=0;i<50;i++)plus.onclick();
 assert.ok(widthOf(f.scale.range)>=2-1e-8&&widthOf(f.scale.range)<=2+1e-8);
 for(let i=0;i<50;i++)minus.onclick();
 assert.ok(widthOf(f.scale.range)<=100+1e-8);
 const slider=nested(f.playback).find(el=>el.tag==='input');
 slider.value='17';slider.oninput();const before=f.series.data.length;
 zoomButton(f,'重置图表').onclick();
 assert.equal(f.series.data.length,before);assert.equal(Number(slider.value),17);
 plus.onclick();minus.onclick();
 assert.ok(widthOf(f.scale.range)<=17+1e-8 && f.scale.range.to<=17+1e-8);
 slider.value='1';slider.oninput();zoomButton(f,'重置图表').onclick();plus.onclick();
 assert.equal(f.series.data.length,1);assert.ok(Number.isFinite(f.scale.range.from)&&Number.isFinite(f.scale.range.to));
 f.view.destroy();
});
test('dense labels are suppressed without losing arrow IDs or the underlying tooltip observations',()=>{
 const f=fixture(100,true),marks=f.marker.data.slice(),hidden=marks.filter(m=>!m.text);
 assert.ok(hidden.length>0,'adjacent labels would overlap in a 600px plot');
 assert.ok(marks.some(m=>m.text),'retain readable sparse labels');
 for(const m of marks)assert.ok(m.shape==='arrowUp'||m.shape==='arrowDown');
 const marker=hidden[0];
 f.chart.click({hoveredObjectId:marker.id,time:marker.time,point:{x:25,y:70}});
 assert.equal(f.tooltip.hidden,false);assert.ok(content(f.tooltip).includes('来源时间'));
 const ids=marks.map(m=>m.id);
 for(let i=0;i<5;i++)zoomButton(f,'放大图表').onclick();
 assert.deepEqual(f.marker.data.map(m=>m.id),ids,'arrows survive changes in label density');
 f.view.destroy();
});
