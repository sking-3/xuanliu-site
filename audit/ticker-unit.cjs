'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
let count=0;
const check=(name,fn)=>{fn();count++;console.log('PASS '+name)};
const origin='https://sking-3.github.io';
const messages=[],events={},properties={};
const contentWindow={postMessage:(data,target)=>messages.push({data,target})};
const frame={contentWindow,addEventListener:(type,fn)=>events['frame:'+type]=fn};
const parentContext={document:{querySelector:()=>frame,documentElement:{style:{setProperty:(name,value)=>properties[name]=value}}},window:{addEventListener:(type,fn)=>events[type]=fn},location:{origin}};
vm.runInNewContext(fs.readFileSync('index-ticker.js','utf8'),parentContext);
check('host requests measurement on startup and iframe load',()=>{assert.equal(messages.length,1);events['frame:load']();assert.equal(messages.length,2);assert.equal(messages[0].target,origin)});
const size=(source,from,height)=>events.message({origin:from,source,data:{type:'books-market-strip-size',height}});
check('host rejects wrong origin, wrong frame and invalid heights',()=>{for(const h of [NaN,Infinity,'45'])size(contentWindow,origin,h);size({},origin,100);size(contentWindow,'https://other.example',100);assert.deepEqual(properties,{})});
check('host fits the entire scaled provider component without clipping',()=>{size(contentWindow,origin,44.5);assert.equal(properties['--books-ticker-height'],'45px');size(contentWindow,origin,86.25);assert.equal(properties['--books-ticker-height'],'87px')});
check('host keeps safe minimum height',()=>{size(contentWindow,origin,10);assert.equal(properties['--books-ticker-height'],'40px')});
let height=43.5,resize;
const observed=[],childEvents={},reports=[];
const parent={postMessage:(data,target)=>reports.push({data,target})};
const vendorFrame={contentWindow:{}};
const widget={getBoundingClientRect:()=>({height}),querySelector:()=>vendorFrame};
const links={getBoundingClientRect:()=>({height:44}),contains:()=>false,addEventListener(){}};
const childDocument={
 body:{dataset:{}},
 querySelector:selector=>selector==='.strip-links'?links:widget
};
vm.runInNewContext(fs.readFileSync('market-strip.js','utf8'),{
 document:childDocument, window:{addEventListener:(type,fn)=>childEvents[type]=fn},location:{origin},parent,
 ResizeObserver:class{constructor(fn){resize=fn}observe(element){observed.push(element)}}
});
const provider='https://www.tradingview-widget.com';
const notify=(from,source,name,data)=>childEvents.message({origin:from,source,data:{name,data}});
check('first paint offers four source-specific index charts without an external request',()=>{
 const html=fs.readFileSync('market-strip.html','utf8');
 const nav=html.match(/<nav class="strip-links".*?<\/nav>/s)[0];
 const destinations=[...nav.matchAll(/href="chart\.html\?tvwidgetsymbol=([^"]+)"/g)].map(m=>decodeURIComponent(m[1]));
 assert.deepEqual(destinations,['SSE:000001','SZSE:399001','HSI:HSI','FRED:NDQCOM']);
 assert.equal((nav.match(/target="_parent"/g)||[]).length,4);
 assert.equal(childDocument.body.dataset.stripMode,'links');assert.equal(reports[0].data.height,45);assert.equal(reports[0].target,origin);
});
check('only the live provider frame may replace the links with its complete widget',()=>{
 notify('https://other.example',vendorFrame.contentWindow,'tv-widget-ready');notify(provider,{},'tv-widget-ready');
 notify(provider,vendorFrame.contentWindow,'tv-widget-load');
 assert.equal(childDocument.body.dataset.stripMode,'links');
 for (const h of [0,-1,Infinity,'58']) notify(provider,vendorFrame.contentWindow,'tv-widget-resize-iframe',{height:h});
 notify(provider,{},'tv-widget-resize-iframe',{height:58});
 notify('https://other.example',vendorFrame.contentWindow,'tv-widget-resize-iframe',{height:58});
 assert.equal(childDocument.body.dataset.stripMode,'links');
 notify(provider,vendorFrame.contentWindow,'tv-widget-resize-iframe',{height:58});
 assert.equal(childDocument.body.dataset.stripMode,'provider');assert.equal(widget.inert,false);
 assert.deepEqual(observed,[widget,links]);assert.equal(reports.at(-1).data.height,44.5);
 height=78;resize();assert.equal(reports.at(-1).data.height,79);
});
check('an explicit no-data message restores keyboard-accessible native chart links',()=>{
 notify(provider,vendorFrame.contentWindow,'tv-widget-no-data');assert.equal(childDocument.body.dataset.stripMode,'links');assert.equal(widget.inert,true);assert.equal(reports.at(-1).data.height,45);
});
check('late layout messages cannot hide an explicit outage, but ready can restore the widget',()=>{
 notify(provider,vendorFrame.contentWindow,'tv-widget-resize-iframe',{height:58});
 assert.equal(childDocument.body.dataset.stripMode,'links');
 notify(provider,vendorFrame.contentWindow,'tv-widget-ready');
 assert.equal(childDocument.body.dataset.stripMode,'provider');
});
check('tape only accepts same-origin parent measurement messages',()=>{
 const n=reports.length;
 childEvents.message({origin,source:{},data:{type:'books-market-strip-measure'}});
 childEvents.message({origin:'https://other.example',source:parent,data:{type:'books-market-strip-measure'}});
 assert.equal(reports.length,n);childEvents.message({origin,source:parent,data:{type:'books-market-strip-measure'}});
 assert.equal(reports.length,n+1);
});
console.log(`${count} ticker sizing/security DOM-model tests passed. Real rendering is verified separately.`);
