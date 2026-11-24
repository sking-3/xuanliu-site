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
check('host sizes the entire measured native strip',()=>{size(contentWindow,origin,44.5);assert.equal(properties['--books-ticker-height'],'45px');size(contentWindow,origin,86.25);assert.equal(properties['--books-ticker-height'],'87px')});
check('host keeps the published compact minimum height',()=>{size(contentWindow,origin,10);assert.equal(properties['--books-ticker-height'],'32px')});
const {feeds,quote,fresh,change,endpoint} = require('../market-strip.js');
const html = fs.readFileSync('market-strip.html','utf8');
const seeded = [...html.matchAll(/<a class="tape-item"[^>]*>[\s\S]*?<\/a>/g)].map(m=>m[0]);
check('six first-paint native chart links include attributable dated closes without remote rendering',()=>{
  assert.doesNotMatch(html,/tradingview-widget|embed-widget-ticker-tape|<iframe/);
  assert.equal(seeded.length,6);
  const symbols = Object.keys(feeds);
  for (const [i,tag] of seeded.entries()) {
    const attr = key=>tag.match(new RegExp(key+'="([^"]+)"'))?.[1];
    const sym = symbols[i],close=Number(attr('data-close')),prev=Number(attr('data-previous-close'));
    assert.equal(attr('target'),'_parent');assert.equal(attr('data-symbol'),sym);
    assert.equal(new URL(attr('href'),origin).searchParams.get('tvwidgetsymbol'),sym);
    assert.match(attr('datetime'),/^\d{4}-\d{2}-\d{2}$/);
    assert.ok(attr('data-previous-date')<attr('datetime'));
    assert.ok(close>0 && prev>0);assert.ok(tag.includes('收盘') && tag.includes('腾讯行情'));
    assert.equal(Number(tag.match(/data-direction="(?:up|down|flat)">([-+\d.]+)%/)[1]),Number(change(close,prev).toFixed(2)));
    assert.equal(new URL(attr('data-source-url')).searchParams.get('param').split(',')[0],feeds[sym][0]);
  }
});
const examples=[
  ['SSE:000001','20261116161427','2026-11-16T09:28:00Z'],
  ['HSI:HSI','2026/11/16 17:28:11','2026-11-16T09:30:00Z'],
  ['FRED:NDQCOM','2026-11-16 17:15:59','2026-11-16T22:16:00Z']
];
function data(symbol,stamp,price=101,previous=100) {
  const ticker=feeds[symbol][0];
  const qt=[];qt[2]=ticker.slice(2);qt[3]=String(price);qt[4]=String(previous);qt[30]=stamp;
  const day=[['2026-11-12','96','98'],['2026-11-13','98','100'],['2026-11-16','100','101']];
  return {code:0,data:{[ticker]:{day,qt:{[ticker]:qt}}}};
}
check('three exchange dispatch paths and verified daily pairs after local close',()=>{
  for(const [symbol,stamp,time] of examples) {
    const result=quote(symbol,data(symbol,stamp),new Date(time));
    assert.deepEqual(result,{closing:{date:'2026-11-16',close:101,previousClose:100,previousDate:'2026-11-13'},delayed:null});
    const url=new URL(endpoint('https://web.ifzq.gtimg.cn',feeds[symbol]));
    assert.ok(url.pathname.includes('/'+feeds[symbol][1]+'/'));assert.equal(url.searchParams.get('param').split(',')[0],feeds[symbol][0]);
  }
});
check('an unconfirmed current candle, future date or wrong code never becomes the official close',()=>{
  const [symbol,stamp,time]=examples[0],now=new Date(time);
  const wrong=data(symbol,stamp);wrong.data.sh000001.qt.sh000001[2]='000688';
  assert.equal(quote(symbol,wrong,now).closing.date,'2026-11-13');
  assert.equal(quote(symbol,data(symbol,stamp,2222),now).closing.date,'2026-11-13');
  assert.equal(quote(symbol,data(symbol,'20261116145900'),now).closing.date,'2026-11-13');
  const rows=data(symbol,stamp);rows.data.sh000001.day.push(['2026-11-17','42','42']);
  assert.equal(quote(symbol,rows,now).closing.date,'2026-11-16');
});
check('verified intraday snapshots retain exchange-local time and separated last closed session',()=>{
  for (const [s,stamp,clock,expected] of [
    ['SSE:000001','20261116104230','2026-11-16T02:45:00Z','2026-11-16T02:42:30.000Z'],
    ['HSI:HSI','2026/11/16 10:42:30','2026-11-16T02:45:00Z','2026-11-16T02:42:30.000Z'],
    ['FRED:NDQCOM','2026-11-16 10:42:30','2026-11-16T15:45:00Z','2026-11-16T15:42:30.000Z']]) {
    const now=new Date(clock),result=quote(s,data(s,stamp,100.123),now);
    assert.equal(result.closing.date,'2026-11-13');assert.ok(fresh(s,result.delayed,result.closing,now));
    assert.equal(result.delayed.price,100.123);assert.equal(result.delayed.instant,expected);
    assert.equal(fresh(s,result.delayed,result.closing,new Date(now.getTime()+32*60e3)),false);
  }
});
check('stale, future, mismatched previous close and lunch-break ticks fall back to closing data',()=>{
  const s='SSE:000001',now=new Date('2026-11-16T02:45:00Z');
  for(const [time,previous] of [['20261116101100',100],['20261116104600',100],['20261116104200',500],['20261116104287',100]]){
    const result=quote(s,data(s,time,101,previous),now);
    assert.equal(result.delayed,null);assert.equal(result.closing.date,'2026-11-13');
  }
  assert.equal(quote(s,data(s,'20261116112900'),new Date('2026-11-16T03:31:00Z')).delayed,null);
});
check('short, malformed and duplicate series fail independently',()=>{
  const s='SSE:000001',stamp=examples[0][1],now=new Date(examples[0][2]);
  for(const mutate of [bars=>bars.splice(1),bars=>bars.push(bars[1]),bars=>bars[1][2]='',bars=>bars[1][0]='2026-02-31']) {
    const d=data(s,stamp);mutate(d.data.sh000001.day);assert.equal(quote(s,d,now),null);
  }
  assert.equal(quote(s,{code:403},now),null);
});
console.log(count+' ticker regression checks passed.');
