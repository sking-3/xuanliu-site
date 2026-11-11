/* Independently public profile/performance/curve evidence never unlocks positions. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksReferenceData=api;})(globalThis,function(){
'use strict';
const ID='5075281354358777856',BASE='https://www.binance.com/bapi/futures/v1/',MAX_AGE=3600000;
const isTime=(x,now)=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&Date.parse(x)<=now+300000;
const evidence=(x,url,now)=>x&&x.sourceUrl===url&&isTime(x.fetchedAt,now)&&/^[a-f0-9]{64}$/.test(x.evidenceSha256||'');
const identity=(data,id)=>id===ID&&data?.schemaVersion===1&&data.portfolioId===ID&&data.scope==='official_historical_positions_only';
function performance(data,id,period,{now=Date.now()}={}){
 const empty={status:'unavailable',periodSupported:period==='30D',sourcePeriod:period,currency:'USDT',sourceAsOf:null,lastSuccessAt:null,roi:null,pnl:null,mdd:null,winRate:null,errorCode:null};
 if(!identity(data,id)||period!=='30D')return empty;
 const x=data.performance,url=BASE+'public/future/copy-trade/lead-portfolio/performance?portfolioId='+ID+'&timeRange=30D';
 if(!evidence(x,url,now)||x.sourcePeriod!=='30D'||x.currency!=='USDT'||x.asOf!==null||!['roi','pnl','mdd','winRate'].every(k=>typeof x[k]==='number'&&Number.isFinite(x[k]))||x.winRate<0||x.winRate>100||x.mdd<0||x.mdd>100)return {...empty,errorCode:'reference_performance_schema'};
 return {...empty,status:now-Date.parse(x.fetchedAt)>MAX_AGE?'stale':'ready',lastSuccessAt:x.fetchedAt,...Object.fromEntries(['roi','pnl','mdd','winRate'].map(k=>[k,x[k]]))};
}
function chart(data,id,period,{now=Date.now()}={}){
 const empty={status:'unavailable',periodSupported:period==='30D',currency:'USDT',sourcePeriod:period,points:[],pointCount:null,startAt:null,endAt:null,lastSuccessAt:null};
 if(!identity(data,id)||period!=='30D')return empty;
 const x=data.curve,url=BASE+'public/future/copy-trade/lead-portfolio/chart-data?portfolioId='+ID+'&timeRange=30D&dataType=PNL';
 if(!evidence(x,url,now)||x.sourcePeriod!=='30D'||x.currency!=='USDT'||!Array.isArray(x.points)||x.points.length>1000)return empty;
 let last=-Infinity;for(const p of x.points){if(!isTime(p.time,now)||typeof p.value!=='number'||!Number.isFinite(p.value)||Date.parse(p.time)<=last)return empty;last=Date.parse(p.time);}
 return {...empty,status:now-Date.parse(x.fetchedAt)>MAX_AGE?'stale':'ready',points:x.points.map(p=>({...p})),pointCount:x.points.length,startAt:x.points[0]?.time||null,endAt:x.points.at(-1)?.time||null,lastSuccessAt:x.fetchedAt};
}
function profile(data,id,{now=Date.now()}={}){
 if(!identity(data,id))return null;const x=data.profile,url=BASE+'friendly/future/copy-trade/lead-portfolio/detail?portfolioId='+ID;
 if(!evidence(x,url,now)||typeof x.nickname!=='string'||typeof x.positionShow!=='boolean'||!['marginBalance','aumAmount'].every(k=>typeof x[k]==='string'&&/^\d+(?:\.\d+)?$/.test(x[k])&&Number.isFinite(Number(x[k])))||!['currentCopyCount','maxCopyCount'].every(k=>Number.isSafeInteger(x[k])&&x[k]>=0))return null;
 return {...x,status:now-Date.parse(x.fetchedAt)>MAX_AGE?'stale':'ready',currency:'USDT'};
}
return {ID,performance,chart,profile};
});
