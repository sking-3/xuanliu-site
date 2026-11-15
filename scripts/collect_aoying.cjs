#!/usr/bin/env node
'use strict';

/*
 * Collects only Binance's public Aoying profile, performance and PnL charts.
 * The position endpoint is deliberately absent. Binance marks this profile's
 * positions as private, and an empty response must never be rendered as flat.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const vm=require('node:vm');

const PORTFOLIO_ID='5075281354358777856';
const BASE='https://www.binance.com/bapi/futures/v1/';
const PERIODS=Object.freeze(['7D','30D','90D','180D','365D']);
const DETAIL_URL=BASE+'friendly/future/copy-trade/lead-portfolio/detail?portfolioId='+PORTFOLIO_ID;
const performanceUrl=p=>BASE+'public/future/copy-trade/lead-portfolio/performance?portfolioId='+PORTFOLIO_ID+'&timeRange='+p;
const chartUrl=p=>BASE+'public/future/copy-trade/lead-portfolio/chart-data?portfolioId='+PORTFOLIO_ID+'&timeRange='+p+'&dataType=PNL';

function asIso(value,fallback){
 const date=value==null?null:new Date(value);
 return date&&Number.isFinite(date.getTime())?date.toISOString():fallback;
}
function sha256(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function assertEnvelope(raw,label){
 if(!raw||raw.code!=='000000'||raw.success!==true)throw new Error(`${label} returned an unsuccessful Binance response`);
 if(raw.data==null)throw new Error(`${label} returned no data`);
}
function readPrevious(file){
 if(!file||!fs.existsSync(file))return {};
 const sandbox={};sandbox.globalThis=sandbox;
 vm.runInNewContext(fs.readFileSync(file,'utf8'),sandbox,{filename:file});
 return sandbox.BooksAoyingHistory&&typeof sandbox.BooksAoyingHistory==='object'?sandbox.BooksAoyingHistory:{};
}
function responseJson(response,url){
 if(response&&typeof response.json==='function')return response.json();
 if(response&&typeof response==='object')return response;
 throw new Error(`Invalid response for ${url}`);
}
async function fetchJson(fetchImpl,url){
 const response=await fetchImpl(url,{headers:{accept:'application/json'}});
 if(response&&response.ok===false)throw new Error(`HTTP ${response.status||'error'} for ${url}`);
 return responseJson(response,url);
}
function writeEvidence(root,name,raw){
 const evidence=prepareEvidence(root,name,raw);
 fs.mkdirSync(path.dirname(evidence.path),{recursive:true});fs.writeFileSync(evidence.path,evidence.bytes);
 return evidence;
}
function prepareEvidence(root,name,raw){
 const bytes=Buffer.from(JSON.stringify(raw,null,2)+'\n');
 const file=path.join(root,name+'.json');
 return {bytes,sha256:sha256(bytes),path:file};
}
function evidencePath(file){return path.relative(path.resolve(__dirname,'..','trader'),file);}
function normalizePerformance(raw,period,url,receivedAt,evidence){
 assertEnvelope(raw,`performance ${period}`);
 const x=raw.data;
 if(x.timeRange!==period)throw new Error(`performance ${period} returned ${x.timeRange||'unknown'} data`);
 for(const key of ['roi','pnl','mdd','winRate'])if(typeof x[key]!=='number'||!Number.isFinite(x[key]))throw new Error(`performance ${period} has invalid ${key}`);
 if(x.winRate<0||x.winRate>100||x.mdd<0||x.mdd>100)throw new Error(`performance ${period} has out-of-range risk values`);
 return {roi:x.roi,pnl:x.pnl,mdd:x.mdd,winRate:x.winRate,copierPnl:Number.isFinite(x.copierPnl)?x.copierPnl:null,winOrders:Number.isFinite(x.winOrders)?x.winOrders:null,totalOrder:Number.isFinite(x.totalOrder)?x.totalOrder:null,sharpRatio:x.sharpRatio??null,sourcePeriod:period,currency:'USDT',asOf:null,fetchedAt:receivedAt,sourceUrl:url,evidenceSha256:evidence.sha256,evidencePath:evidencePath(evidence.path)};
}
function normalizeChart(raw,period,url,receivedAt,evidence){
 assertEnvelope(raw,`chart ${period}`);
 if(!Array.isArray(raw.data)||raw.data.length===0||raw.data.length>1000)throw new Error(`chart ${period} returned an invalid point list`);
 let previous=-Infinity;
 const points=raw.data.map(point=>{
  const time=asIso(point.dateTime??point.time,null);
  if(!time||typeof point.value!=='number'||!Number.isFinite(point.value))throw new Error(`chart ${period} contains an invalid point`);
  const stamp=Date.parse(time);if(stamp<=previous)throw new Error(`chart ${period} points are not increasing`);previous=stamp;
  return {time,value:point.value};
 });
 return {sourcePeriod:period,currency:'USDT',points,fetchedAt:receivedAt,sourceUrl:url,evidenceSha256:evidence.sha256,evidencePath:evidencePath(evidence.path)};
}
function normalizeProfile(raw,url,receivedAt,evidence){
 assertEnvelope(raw,'profile');
 const x=raw.data;
 if(typeof x.nickname!=='string'||typeof x.positionShow!=='boolean')throw new Error('profile is missing public identity or position visibility');
 for(const key of ['marginBalance','aumAmount'])if(!Number.isFinite(Number(x[key])))throw new Error(`profile has invalid ${key}`);
 for(const key of ['currentCopyCount','maxCopyCount'])if(!Number.isSafeInteger(x[key])||x[key]<0)throw new Error(`profile has invalid ${key}`);
 return {nickname:x.nickname,marginBalance:String(x.marginBalance),aumAmount:String(x.aumAmount),copierPnl:x.copierPnl==null?null:String(x.copierPnl),copyAum:x.copyAum==null?null:String(x.copyAum),profitSharingRate:x.profitSharingRate==null?null:String(x.profitSharingRate),currentCopyCount:x.currentCopyCount,maxCopyCount:x.maxCopyCount,totalCopyCount:Number.isSafeInteger(x.totalCopyCount)?x.totalCopyCount:null,closeLeadCount:Number.isSafeInteger(x.closeLeadCount)?x.closeLeadCount:null,favoriteCount:Number.isSafeInteger(x.favoriteCount)?x.favoriteCount:null,positionShow:x.positionShow,lastTradeTime:x.lastTradeTime??null,lastTradeAt:x.lastTradeTime??null,startTime:x.startTime??null,status:x.status??null,description:x.description??null,avatarUrl:x.avatarUrl??null,fetchedAt:receivedAt,sourceUrl:url,evidenceSha256:evidence.sha256,evidencePath:evidencePath(evidence.path)};
}
async function collectAoying({fetchImpl=globalThis.fetch,outputFile=path.resolve(__dirname,'..','trader','aoying-history.js'),evidenceDir=path.resolve(__dirname,'..','trader','binance','evidence','aoying-analysis-current'),previousFile=path.resolve(__dirname,'..','trader','aoying-history.js'),now=new Date()}={}){
 if(typeof fetchImpl!=='function')throw new Error('A fetch implementation is required');
 const receivedAt=new Date(now).toISOString();
 if(!Number.isFinite(Date.parse(receivedAt)))throw new Error('Invalid collection timestamp');
 const detail=await fetchJson(fetchImpl,DETAIL_URL);
 const evidenceQueue=[{name:'profile',raw:detail}];
 const profileEvidence=prepareEvidence(evidenceDir,'profile',detail);
 const profile=normalizeProfile(detail,DETAIL_URL,receivedAt,profileEvidence);
 const performanceByPeriod={};
 const curveByPeriod={};
 for(const period of PERIODS){
  const url=performanceUrl(period),raw=await fetchJson(fetchImpl,url),evidence=prepareEvidence(evidenceDir,`performance-${period}`,raw);evidenceQueue.push({name:`performance-${period}`,raw});
  performanceByPeriod[period]=normalizePerformance(raw,period,url,receivedAt,evidence);
 }
 for(const period of PERIODS){
  const url=chartUrl(period),raw=await fetchJson(fetchImpl,url),evidence=prepareEvidence(evidenceDir,`curve-${period}`,raw);evidenceQueue.push({name:`curve-${period}`,raw});
  curveByPeriod[period]=normalizeChart(raw,period,url,receivedAt,evidence);
 }
 const previous=readPrevious(previousFile);
 const history={...previous,schemaVersion:2,portfolioId:PORTFOLIO_ID,scope:'official_historical_positions_only',fetchedAt:previous.fetchedAt||null,latestPublicFetchAt:receivedAt,profile,performanceByPeriod,curveByPeriod,performance:performanceByPeriod['30D'],curve:curveByPeriod['30D'],positionStatus:profile.positionShow?'public':'restricted',positionAsOf:profile.lastTradeTime??null,positionRows:null,positionNote:profile.positionShow?'Public positions may be read from an approved endpoint.':'Binance marks positions private for this profile. Empty filtered responses are not interpreted as flat.'};
 for(const item of evidenceQueue)writeEvidence(evidenceDir,item.name,item.raw);
 fs.mkdirSync(path.dirname(outputFile),{recursive:true});
 fs.writeFileSync(outputFile,'/* Generated from Binance public Aoying profile/performance/chart endpoints. Positions are intentionally not requested. */\nglobalThis.BooksAoyingHistory='+JSON.stringify(history)+';\n');
 return history;
}
function parseArgs(argv){
 const out={};for(let i=0;i<argv.length;i++){const value=argv[i+1];if(argv[i]==='--output')out.outputFile=path.resolve(value),i++;else if(argv[i]==='--evidence-dir')out.evidenceDir=path.resolve(value),i++;else if(argv[i]==='--previous')out.previousFile=path.resolve(value),i++;else if(argv[i]==='--at')out.now=new Date(value),i++;}
 return out;
}
if(require.main===module){collectAoying(parseArgs(process.argv.slice(2))).then(history=>{console.log(JSON.stringify({output:parseArgs(process.argv.slice(2)).outputFile||path.resolve(__dirname,'..','trader','aoying-history.js'),historyFetchedAt:history.fetchedAt,latestPublicFetchAt:history.latestPublicFetchAt,periods:PERIODS,positionStatus:history.positionStatus},null,2));}).catch(error=>{console.error(error.stack||error);process.exitCode=1;});}
module.exports={BASE,PORTFOLIO_ID,PERIODS,DETAIL_URL,performanceUrl,chartUrl,collectAoying,normalizePerformance,normalizeChart,normalizeProfile};
