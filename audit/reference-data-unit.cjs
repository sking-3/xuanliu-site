'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),R=require('../trader/reference-data.js'),M=require('../trader/trade-replay-model.js');
const env={};vm.runInNewContext(fs.readFileSync('trader/aoying-history.js','utf8'),env);const data=JSON.parse(JSON.stringify(env.BooksAoyingHistory)),ID=R.ID,now=Date.parse(data.performance.fetchedAt)+1000;
test('Aoying independently public 30D values are usable by ranking without granting positions',()=>{const p=R.performance(data,ID,'30D',{now});assert.equal(p.roi,data.performance.roi);assert.equal(p.status,'ready');assert.equal(R.profile(data,ID,{now}).positionShow,false);assert.equal(p.positions,undefined);});
test('public performance expires without erasing history or changing source dates',()=>{const p=R.performance(data,ID,'30D',{now:now+7200000});assert.equal(p.status,'stale');assert.equal(p.lastSuccessAt,data.performance.fetchedAt);assert.equal(p.roi,data.performance.roi);});
test('multi-period values are available only when collected and never reused for unsupported periods',()=>{for(const period of ['7D','90D','180D','365D'])assert.equal(typeof R.performance(data,ID,period,{now}).roi,'number');assert.equal(R.performance(data,ID,'ALL',{now}).roi,null);assert.equal(R.performance(data,'another','30D',{now}).roi,null);for(const change of [x=>x.portfolioId='another',x=>x.performance.sourcePeriod='90D',x=>x.performance.sourceUrl='https://example.com',x=>x.performance.winRate=101,x=>x.performance.fetchedAt=new Date(now+600000).toISOString()]){const x=structuredClone(data);change(x);assert.equal(R.performance(x,ID,'30D',{now}).roi,null);}});
test('curve preserves actual source values, units and period; no synthesized zero point',()=>{const p=R.chart(data,ID,'30D',{now:Date.parse(data.curve.fetchedAt)+1000});assert.equal(p.pointCount,data.curve.points.length);assert.equal(p.points[0].value,data.curve.points[0].value);assert.equal(p.currency,'USDT');assert.equal(R.chart(data,ID,'90D',{now}).pointCount,data.curveByPeriod['90D'].points.length);});
test('sample analysis excludes unknown/open fragments, follows close times and keeps quotes separate',()=>{const end=Date.now(),c=(i,extra={})=>({id:String(i),symbol:'ETHUSDT',positionSide:'long',quote:'USDT',official:true,status:'官方已平仓',opened:end-i*86400000-3600000,closed:end-i*86400000,pnl:i%2?10:-5,leverage:3,...extra});const list=[c(1),c(2),c(20),c(3,{official:false,status:'观测片段 · 期初未知'}),c(4,{official:false,status:'样本内闭合',ambiguous:true})],s=M.summary(list,7,end);assert.equal(s.count,2);assert.equal(s.pnl,5);assert.equal(s.averageDuration,3600000);assert.equal(s.averageLeverage,3);assert.equal(s.wins,1);assert.equal(M.summary([...list,c(1,{quote:'USDC'})],7,end).pnl,null);});
test('no closed samples means unknown averages, not zero performance',()=>{const s=M.summary([],30,Date.now());assert.equal(s.count,0);assert.equal(s.pnl,null);assert.equal(s.averageLeverage,null);assert.equal(s.averageDuration,null);});
test('individual trade markers retain IDs and actual quantities within their candle only',()=>{const t=Date.UTC(2026,0,1,12,0,1),bars=[{time:Math.floor(t/1000/3600)*3600}],e=(id,ms)=>({id,side:'sell',effect:'increase',startPosition:'-1',time:ms,quantity:'196.87',price:'86.762'}),list=[e('a',t),e('b',t+1000),e('outside',t-7200000)],ms=M.markerGroups(list,bars,3600);assert.equal(ms.length,2);assert.equal(ms[0].text,'加');assert.equal(ms[0].events[0].quantity,'196.87');assert.notEqual(ms[0].id,ms[1].id);});
test('crowded candles keep overflow events accessible and unknown Binance opens remain ambiguous',()=>{const t=Date.now()-7200000,bars=[{time:Math.floor(t/1000/3600)*3600}],es=Array.from({length:12},(_,i)=>({id:String(i),side:'buy',effect:'increase',time:t,quantity:'1',price:'10'})),ms=M.markerGroups(es,bars,3600);assert.equal(ms.length,6);assert.equal(ms.flatMap(x=>x.events).length,12);assert.equal(ms[0].text,'开/加');assert.equal(M.markerGroups(es,bars,3600)[0].events[0].action,undefined);});

test('source-confirmed closed PnL stays valid when its associated execution versions are ambiguous',()=>{const es=M.binanceEvents([{id:'a',identity:'same',symbol:'ETHUSDT',positionSide:'SHORT',side:'SELL',executedQty:'1',avgPrice:'2000',totalPnl:'0',orderTime:Date.now()-5000,orderUpdateTime:Date.now()-5000},{id:'b',identity:'same',symbol:'ETHUSDT',positionSide:'SHORT',side:'SELL',executedQty:'2',avgPrice:'2000',totalPnl:'0',orderTime:Date.now()-4000,orderUpdateTime:Date.now()-4000}]);const end=Date.now(),cs=M.cycles(es,[{symbol:'ETHUSDT',side:'Short',opened:end-10000,closed:end-1000,avgCost:'2000',avgClosePrice:'1900',closedVolume:'3',closingPnl:'300',status:'All Closed'}]);assert.equal(cs[0].ambiguous,true);assert.equal(cs[0].observedChange,null);assert.equal(M.summary(cs,7,end).pnl,300);});

test('published Aoying fields are bound to preserved official response hashes',()=>{const crypto=require('node:crypto');for(const key of ['profile','curve','performance']){const x=data[key],bytes=fs.readFileSync('trader/'+x.evidencePath),raw=JSON.parse(bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),x.evidenceSha256);assert.equal(raw.code,'000000');assert.equal(raw.success,true);if(key==='performance')for(const k of ['roi','pnl','mdd','winRate'])assert.equal(Number(raw.data[k]),x[k]);if(key==='profile'){assert.equal(raw.data.positionShow,false);assert.equal(raw.data.marginBalance,x.marginBalance);assert.equal(raw.data.aumAmount,x.aumAmount);}if(key==='curve')assert.equal(raw.data.length,x.points.length);}});

test('same-origin Aoying reference accepts immutable receipts and retains independent history',()=>{
 const next=structuredClone(data),stamp=new Date(now).toISOString();
 next.latestPublicFetchAt=stamp;
 function advance(part,name){
  part.fetchedAt=stamp;
  part.evidencePath='binance/evidence/aoying-reference-v1/'+name+'-'+part.evidenceSha256+'.json';
 }
 advance(next.profile,'profile');
 for(const period of R.PERIODS){
  advance(next.performanceByPeriod[period],'performance-'+period);
  advance(next.curveByPeriod[period],'curve-'+period);
 }
 next.performance=next.performanceByPeriod['30D'];
 next.curve=next.curveByPeriod['30D'];
 assert.equal(R.acceptSnapshot(next,data,{now}),next);
 assert.equal(R.performance(next,ID,'365D',{now}).evidencePath,next.performanceByPeriod['365D'].evidencePath);
 assert.equal(next.fetchedAt,data.fetchedAt);
 assert.equal(R.profile(next,ID,{now}).lastTradeAt,R.profile(data,ID,{now}).lastTradeAt);
 assert.throws(()=>R.acceptSnapshot(data,next,{now}),/AOYING_REFERENCE_SCHEMA/);
});
test('same-origin Aoying reference rejects rewritten or incomplete periods, unrelated accounts and hidden holdings',()=>{
 for(const change of [
  x=>{x.curve.points[0].value++;x.curveByPeriod['30D'].points[0].value++;},
  x=>{x.curveByPeriod['365D'].points.reverse();},
  x=>{delete x.performanceByPeriod['365D'];},
  x=>{x.profile.evidencePath='binance/evidence/aoying-reference-v1/profile-'+'0'.repeat(64)+'.json';},
  x=>{x.portfolioId='9999999999999999999';},
  x=>{x.positionRows=[{}];},
  x=>{x.rows.pop();}
 ]){
  const incoming=structuredClone(data);change(incoming);
  assert.throws(()=>R.acceptSnapshot(incoming,data,{now}),/AOYING_REFERENCE_SCHEMA/);
 }
});
