/* Independently public profile/performance/curve evidence never unlocks positions. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksReferenceData=api;})(globalThis,function(){
'use strict';
const ID='5075281354358777856',BASE='https://www.binance.com/bapi/futures/v1/',MAX_AGE=3600000;
const PERIODS=Object.freeze(['7D','30D','90D','180D','365D']);
const HISTORY_URL=BASE+'friendly/future/copy-trade/lead-portfolio/position-history';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const asMs=Date.parse;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
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
function evidencePath(item,name){
 const path=item?.evidencePath,sha=item?.evidenceSha256;
 if(typeof path!=='string'||!/^[a-f0-9]{64}$/.test(sha||''))return null;
 if(path==='binance/evidence/aoying-reference-v1/'+name+'-'+sha+'.json')return path;
 return /^binance\/evidence\/aoying-analysis-(?:current|[0-9]{8})\//.test(path)&&path.split('/').at(-1)===name+'.json'&&path.split('/').length===4?path:null;
}
const periodUrl=(kind,period)=>BASE+'public/future/copy-trade/lead-portfolio/'+(kind==='performance'?'performance?':'chart-data?')+'portfolioId='+ID+'&timeRange='+period+(kind==='chart'?'&dataType=PNL':'');
function performance(data,id,period,{now=Date.now()}={}){
 const p=keyPeriod(period),empty={status:'unavailable',periodSupported:false,sourcePeriod:p||period,currency:'USDT',sourceAsOf:null,lastSuccessAt:null,roi:null,pnl:null,mdd:null,winRate:null,copierPnl:null,winOrders:null,totalOrder:null,sharpRatio:null,errorCode:null};
 if(!identity(data,id)||!PERIODS.includes(p))return empty;
 const x=periodData(data,'performance',p),url=periodUrl('performance',p);
 if(!x)return empty;
 const numeric=['roi','pnl','mdd','winRate'];
 if(!evidence(x,url,now)||x.sourcePeriod!==p||x.currency!=='USDT'||(x.asOf??null)!==null||!numeric.every(k=>typeof x[k]==='number'&&Number.isFinite(x[k]))||x.winRate<0||x.winRate>100||x.mdd<0||x.mdd>100)return {...empty,periodSupported:false,errorCode:'reference_performance_schema'};
 if(x.copierPnl!==undefined&&(typeof x.copierPnl!=='number'||!Number.isFinite(x.copierPnl)))return {...empty,periodSupported:false,errorCode:'reference_performance_schema'};
 const result={...empty,periodSupported:true,status:now-Date.parse(x.fetchedAt)>MAX_AGE?'stale':'ready',lastSuccessAt:x.fetchedAt,sourceUrl:url,evidencePath:evidencePath(x,'performance-'+p),...Object.fromEntries([...numeric,'copierPnl','winOrders','totalOrder','sharpRatio'].map(k=>[k,x[k]??null]))};
 const adapter=typeof module==='object'&&module.exports?require('./binance-data.js'):globalThis.BinanceData;
 return adapter?.periodCoverage?adapter.periodCoverage(result,profile(data,id,{now})?.startTime):result;
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
 if(lastTradeTime!==null&&(!Number.isSafeInteger(lastTradeTime)||lastTradeTime<=0||lastTradeTime>asMs(x.fetchedAt)+300000))return null;
 return {...x,lastTradeTime,lastTradeAt:lastTradeTime===null?null:new Date(lastTradeTime).toISOString(),status:now-Date.parse(x.fetchedAt)>MAX_AGE?'stale':'ready',currency:'USDT'};
}
function periods(data,id,{now=Date.now()}={}){
 const out={};for(const p of PERIODS)out[p]={performance:performance(data,id,p,{now}),chart:chart(data,id,p,{now})};return out;
}
function acceptSnapshot(incoming,previous,{now=Date.now()}={}){
 const reject=()=>{throw Error('AOYING_REFERENCE_SCHEMA');};
 if(!identity(incoming,ID)||incoming.schemaVersion!==2||incoming.sourceUrl!==HISTORY_URL||!isTime(incoming.latestPublicFetchAt,now)||!isTime(incoming.fetchedAt,now)||
    incoming.completeAccountHistory!==false||incoming.positionRows!==null||
    !Number.isSafeInteger(incoming.sourceTotal)||incoming.sourceTotal<0||!Number.isSafeInteger(incoming.pages)||incoming.pages<1||
    !Array.isArray(incoming.rows)||incoming.rows.length>5000||incoming.rows.length>incoming.sourceTotal||
    !Array.isArray(incoming.evidence)||incoming.evidence.length!==incoming.pages)reject();

 const validClose=row=>object(row)&&typeof row.symbol==='string'&&/^[A-Z0-9_]{1,50}$/.test(row.symbol)&&['Long','Short'].includes(row.side)&&
    row.status==='All Closed'&&Number.isSafeInteger(row.opened)&&Number.isSafeInteger(row.closed)&&row.opened>0&&row.closed>=row.opened&&
    row.closed<=asMs(incoming.fetchedAt)+300000&&['avgCost','avgClosePrice','closedVolume','closingPnl','leverage'].every(key=>
      typeof row[key]==='string'&&/^-?\d+(?:\.\d+)?$/.test(row[key])&&Number.isFinite(Number(row[key])));
 if(!incoming.rows.every(validClose))reject();

 const snapshotTime=asMs(incoming.latestPublicFetchAt),verifiedProfile=profile(incoming,ID,{now});
 const withoutPath=({evidencePath,...part})=>part;
 const newer=(oldPart,newPart)=>!isTime(oldPart?.fetchedAt,now)||asMs(newPart.fetchedAt)>asMs(oldPart.fetchedAt)||
    (asMs(newPart.fetchedAt)===asMs(oldPart.fetchedAt)&&same(withoutPath(oldPart),withoutPath(newPart)));
 const prior=identity(previous,ID)?previous:null;
 if(!verifiedProfile||!evidencePath(incoming.profile,'profile')||asMs(verifiedProfile.fetchedAt)>snapshotTime||
    incoming.positionStatus!==(verifiedProfile.positionShow?'public':'restricted')||!newer(prior?.profile,incoming.profile))reject();
 if(prior){
  if(asMs(prior.latestPublicFetchAt)>snapshotTime||asMs(prior.fetchedAt)>asMs(incoming.fetchedAt))reject();
  if(asMs(prior.fetchedAt)===asMs(incoming.fetchedAt)&&(!same(prior.rows,incoming.rows)||!same(prior.evidence,incoming.evidence)||
     prior.sourceTotal!==incoming.sourceTotal||prior.pages!==incoming.pages))reject();
 }
 let newestPart=asMs(verifiedProfile.fetchedAt);
 for(const kind of ['performance','curve']){
  const table=incoming[kind+'ByPeriod'];
  if(!object(table)||Object.keys(table).length!==PERIODS.length||!same(incoming[kind],table['30D']))reject();
  for(const period of PERIODS){
   const part=table[period],view=kind==='performance'?performance(incoming,ID,period,{now}):chart(incoming,ID,period,{now});
   if(!view.periodSupported||!view.lastSuccessAt||asMs(view.lastSuccessAt)>snapshotTime||!evidencePath(part,kind+'-'+period)||
      !newer(prior&&periodData(prior,kind,period),part))reject();
   if(kind==='curve'&&(!view.pointCount||asMs(view.endAt)>asMs(view.lastSuccessAt)+300000))reject();
   newestPart=Math.max(newestPart,asMs(view.lastSuccessAt));
  }
 }
 if(newestPart!==snapshotTime)reject();
 return incoming;
}
return {ID,PERIODS,performance,chart,profile,periods,acceptSnapshot};
});
