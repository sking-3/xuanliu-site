/* Independently public profile/performance/curve evidence never unlocks positions. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksReferenceData=api;})(globalThis,function(){
'use strict';
const ID='5075281354358777856',BASE='https://www.binance.com/bapi/futures/v1/',MAX_AGE=3600000;
const PERIODS=Object.freeze(['7D','30D','90D','180D','365D']);
const isTime=(x,now)=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&Date.parse(x)<=now+300000;
const evidence=(x,url,now)=>x&&x.sourceUrl===url&&isTime(x.fetchedAt,now)&&/^[a-f0-9]{64}$/.test(x.evidenceSha256||'');
const identity=(data,id)=>id===ID&&(data?.schemaVersion===1||data?.schemaVersion===2)&&data.portfolioId===ID&&data.scope==='official_historical_positions_only';
const keyPeriod=period=>typeof period==='string'?period.toUpperCase():'';
const periodData=(data,kind,period)=>{
 const p=keyPeriod(period);
 if(p==='30D'&&data?.[kind])return data[kind];
 const table=data?.[kind+'ByPeriod']||data?.periods?.[kind];
 if(table&&Object.prototype.hasOwnProperty.call(table,p))return table[p];
 return null;
};
const periodUrl=(kind,period)=>BASE+'public/future/copy-trade/lead-portfolio/'+(kind==='performance'?'performance?':'chart-data?')+'portfolioId='+ID+'&timeRange='+period+(kind==='chart'?'&dataType=PNL':'');
function performance(data,id,period,{now=Date.now()}={}){
 const p=keyPeriod(period),empty={status:'unavailable',periodSupported:false,sourcePeriod:p||period,currency:'USDT',sourceAsOf:null,lastSuccessAt:null,roi:null,pnl:null,mdd:null,winRate:null,copierPnl:null,winOrders:null,totalOrder:null,sharpRatio:null,errorCode:null};
 if(!identity(data,id)||!PERIODS.includes(p))return empty;
 const x=periodData(data,'performance',p),url=periodUrl('performance',p);
 if(!x)return empty;
 const numeric=['roi','pnl','mdd','winRate'];
 if(!evidence(x,url,now)||x.sourcePeriod!==p||x.currency!=='USDT'||(x.asOf??null)!==null||!numeric.every(k=>typeof x[k]==='number'&&Number.isFinite(x[k]))||x.winRate<0||x.winRate>100||x.mdd<0||x.mdd>100)return {...empty,periodSupported:false,errorCode:'reference_performance_schema'};
 if(x.copierPnl!==undefined&&(typeof x.copierPnl!=='number'||!Number.isFinite(x.copierPnl)))return {...empty,periodSupported:false,errorCode:'reference_performance_schema'};
 return {...empty,periodSupported:true,status:now-Date.parse(x.fetchedAt)>MAX_AGE?'stale':'ready',lastSuccessAt:x.fetchedAt,...Object.fromEntries([...numeric,'copierPnl','winOrders','totalOrder','sharpRatio'].map(k=>[k,x[k]??null]))};
}
function chart(data,id,period,{now=Date.now()}={}){
 const p=keyPeriod(period),empty={status:'unavailable',periodSupported:false,currency:'USDT',sourcePeriod:p||period,points:[],pointCount:null,startAt:null,endAt:null,lastSuccessAt:null};
 if(!identity(data,id)||!PERIODS.includes(p))return empty;
 const x=periodData(data,'curve',p),url=periodUrl('chart',p);
 if(!x)return empty;
 if(!evidence(x,url,now)||x.sourcePeriod!==p||x.currency!=='USDT'||!Array.isArray(x.points)||x.points.length>1000)return empty;
 let last=-Infinity;for(const point of x.points){if(!isTime(point.time,now)||typeof point.value!=='number'||!Number.isFinite(point.value)||Date.parse(point.time)<=last)return {...empty,periodSupported:false};last=Date.parse(point.time);}
 return {...empty,periodSupported:true,status:now-Date.parse(x.fetchedAt)>MAX_AGE?'stale':'ready',points:x.points.map(point=>({...point})),pointCount:x.points.length,startAt:x.points[0]?.time||null,endAt:x.points.at(-1)?.time||null,lastSuccessAt:x.fetchedAt};
}
function profile(data,id,{now=Date.now()}={}){
 if(!identity(data,id))return null;const x=data.profile,url=BASE+'friendly/future/copy-trade/lead-portfolio/detail?portfolioId='+ID;
 if(!evidence(x,url,now)||typeof x.nickname!=='string'||typeof x.positionShow!=='boolean'||!['marginBalance','aumAmount'].every(k=>typeof x[k]==='string'&&/^\d+(?:\.\d+)?$/.test(x[k])&&Number.isFinite(Number(x[k])))||!['currentCopyCount','maxCopyCount'].every(k=>Number.isSafeInteger(x[k])&&x[k]>=0))return null;
 const lastTradeTime=x.lastTradeTime==null?null:(Number.isFinite(Number(x.lastTradeTime))?Number(x.lastTradeTime):Date.parse(String(x.lastTradeTime)));
 if(lastTradeTime!==null&&!Number.isFinite(lastTradeTime))return null;
 return {...x,lastTradeTime,lastTradeAt:lastTradeTime===null?null:new Date(lastTradeTime).toISOString(),status:now-Date.parse(x.fetchedAt)>MAX_AGE?'stale':'ready',currency:'USDT'};
}
function periods(data,id,{now=Date.now()}={}){
 const out={};for(const p of PERIODS)out[p]={performance:performance(data,id,p,{now}),chart:chart(data,id,p,{now})};return out;
}
return {ID,PERIODS,performance,chart,profile,periods};
});
