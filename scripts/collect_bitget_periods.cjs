#!/usr/bin/env node
/* Anonymous reads of data displayed by Bitget's public futures copy-trading pages. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
const model = require('../trader/bitget-period-data.js');
const endpoint = route => 'https://www.bitget.com/v1/trigger/public/uta/'+route;
const rankBody = {sortRule:2,sortFlag:0,dataCycle:90,fullStatus:1,enterDayLl:90,aumLl:25000,followProfitLl:0,totalIncomeLl:0,pageNo:1,pageSize:30};
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
function expect(ok,reason) { if (!ok) throw Error(reason); }
function number(value) {
  expect(typeof value==='number' || typeof value==='string' && /^-?\d+(?:\.\d+)?$/.test(value),'invalid Bitget number');
  const n=Number(value);
  expect(Number.isFinite(n),'invalid Bitget number');
  return n;
}
const optional = value => value == null ? null : number(value);
const iso = millis => new Date(number(millis)).toISOString();
function receipt(name,route,body,bytes,meta) {
  const url=endpoint(route),sha=createHash('sha256').update(bytes).digest('hex');
  expect(meta.url===url && meta.method==='POST' && isDeepStrictEqual(meta.body,body) && meta.sha256===sha
    && Number.isFinite(Date.parse(meta.fetchedAt)) && bytes.length>0 && bytes.length<2097152,'invalid Bitget receipt '+name);
  const raw=JSON.parse(bytes.toString('utf8'));
  expect(String(raw.code)==='200' && raw.data && typeof raw.data==='object','Bitget source rejected '+name);
  return {data:raw.data,bytes,evidenceSha256:sha,evidencePath:model.evidencePath(name,sha),fetchedAt:meta.fetchedAt};
}
function stored(dir) {
  return async (name,route,body)=>{
    const [bytes,meta]=await Promise.all([fs.readFile(path.join(dir,name+'.raw.json')),fs.readFile(path.join(dir,name+'.meta.json'),'utf8')]);
    return receipt(name,route,body,bytes,JSON.parse(meta));
  };
}
async function fetchReceipt(name,route,body) {
  // Keep requests serial on the shared public web endpoints.
  await wait(2500);
  const url=endpoint(route);
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
    credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
  expect(res.ok,'Bitget HTTP '+res.status+' for '+name);
  const bytes=Buffer.from(await res.arrayBuffer());
  return receipt(name,route,body,bytes,{url,method:'POST',body,fetchedAt:new Date().toISOString(),
    sha256:createHash('sha256').update(bytes).digest('hex')});
}
function ref(source) {
  return {fetchedAt:source.fetchedAt,evidenceSha256:source.evidenceSha256,evidencePath:source.evidencePath};
}
function select(leaderboard) {
  expect(Array.isArray(leaderboard.rows) && leaderboard.rows.length<=rankBody.pageSize,'invalid Bitget leaderboard');
  const choices=[],seen=new Set();
  for (const row of leaderboard.rows) {
    if (row.type!==2 || !model.validId(row.portfolioId) || number(row.followCount)<1 || number(row.viewDataVO.profitRate)<=0) continue;
    expect(!seen.has(row.portfolioId) && row.klineProfit?.dataCycle===90,'invalid or duplicate Bitget portfolio');
    seen.add(row.portfolioId); choices.push(row);
  }
  return choices;
}
function activity(source,history,sourceUrl) {
  const data=source.data;
  expect(Array.isArray(data.rows),'missing Bitget position list');
  if (!history) expect(typeof data.strategySafe==='boolean','missing strategy protection status');
  const restricted=!history && data.strategySafe;
  expect(!restricted || data.rows.length===0,'unexpected protected position data');
  const rows=data.rows.map(row=>{
    expect(row.holdSide===1 || row.holdSide===2,'invalid Bitget position side');
    const record={symbol:row.symbolDisplayName || String(row.symbolId).split('_')[0],side:row.holdSide===1?'long':'short',
      openedAt:iso(row.openTime),entryPrice:number(row.averageOpenPrice),quantity:number(row.total),leverage:optional(row.lever)};
    if (!history) return {...record,markPrice:optional(row.markPrice)};
    return {...record,id:row.id,closedAt:iso(row.closeTime),exitPrice:number(row.averageClosePrice),
      realizedPnl:number(row.positionPnl),currency:row.tokenName};
  });
  return {...ref(source),sourceUrl:sourceUrl+'/current',status:restricted?'restricted':rows.length?'ready':'empty',
    rows,...(history?{hasMore:data.nextFlag===true}:{publicDelayMinutes:60})};
}
function pageRef(part,id,pageNo) {
  return {...ref(part),requestUrl:endpoint('historyPosition'),method:'POST',postedBody:{portfolioId:id,pageNo,pageSize:10},
    rowCount:part.rows.length,hasMore:part.hasMore};
}
const recentFirst=(a,b)=>b.closedAt.localeCompare(a.closedAt)||b.id.localeCompare(a.id);
function withPage(trade,page,sourceUrl) {
  return {...trade,evidencePath:page.evidencePath,sourceUrl,postedBody:page.postedBody};
}
async function historyPages(readPart,id,sourceUrl) {
  const pages=[],records=new Map();
  let first;
  for (let pageNo=1;pageNo<=10;pageNo++) {
    const suffix=pageNo===1?'closed':'closed-'+pageNo;
    const source=await readPart(suffix,'historyPosition',{pageNo,pageSize:10});
    expect(typeof source.data.nextFlag==='boolean','missing Bitget history pagination');
    const part=activity(source,true,sourceUrl);
    expect(part.rows.length<=10 && (!part.hasMore || part.rows.length>0),'invalid Bitget page');
    if (!first) first=part;
    const page=pageRef(part,id,pageNo),previousSize=records.size;
    pages.push(page);
    for (const trade of part.rows) {
      if (!records.has(trade.id)) records.set(trade.id,withPage(trade,page,part.sourceUrl));
    }
    expect(!part.rows.length || records.size>previousSize,'repeated Bitget history page');
    if (!part.hasMore) break;
  }
  const last=pages.at(-1);
  return {...first,rows:[...records.values()].sort(recentFirst),pages,pagesFetched:pages.length,hasMore:last.hasMore,truncated:last.hasMore,
    fetchedAt:pages.map(p=>p.fetchedAt).sort().at(-1)};
}
function normalizeLegacyHistory(part,id) {
  if(part.pages)return part;
  const page=pageRef(part,id,1);
  return {...part,rows:part.rows.map(row=>withPage(row,page,part.sourceUrl)),pages:[page],pagesFetched:1,truncated:part.hasMore};
}
function mergeHistory(current,old,id) {
  if(!old)return current;
  const prior=normalizeLegacyHistory(old,id);
  const rows=new Map(prior.rows.map(row=>[row.id,row]));
  for(const row of current.rows)rows.set(row.id,row);
  const pages=new Map([...(prior.priorPages||[]),...prior.pages].map(p=>[p.evidencePath,p]));
  for(const p of current.pages)pages.delete(p.evidencePath);
  return {...current,rows:[...rows.values()].sort(recentFirst),
    ...(pages.size?{priorPages:[...pages.values()]}:{})};
}
function normalizePerformance(source,charts,n,sourceUrl) {
  const d=source.data,series=charts.data.roiRows;
  expect(series?.dataCycle===n && Array.isArray(series.rows) && series.rows.length>0 && series.rows.length<=n+1,'invalid Bitget daily ROI curve');
  const curve=series.rows.map(row=>({time:iso(row.dataTime),value:number(row.amount)}));
  expect(curve.every((point,i)=>Date.parse(point.time)<=Date.parse(charts.fetchedAt) && (!i || point.time>curve[i-1].time)),'invalid Bitget curve date');
  const mdd=optional(d.maxDrawDown),win=optional(d.winRate);
  return {...ref(source),sourcePeriod:n+'D',sourceUrl,currency:'USD',sourceAsOf:null,lastSuccessAt:source.fetchedAt,
    roi:number(d.roi),pnl:number(d.profit),mdd:mdd===null?null:Number((100*mdd).toFixed(6)),
    winRate:win===null?null:Number((100*win).toFixed(6)),totalTrades:optional(d.totalTrades),winningTrades:optional(d.profitTrades),
    lastOrderTime:d.lastOrderTime ? iso(d.lastOrderTime) : null,
    curve,curveEvidencePath:charts.evidencePath,curveEvidenceSha256:charts.evidenceSha256,curveFetchedAt:charts.fetchedAt};
}
async function collect(read) {
  const rank=await read('leaders-aum','traderView',rankBody),accounts=[],archive=[rank];
  for (const candidate of select(rank.data)) {
    if (accounts.length===6) break;
    const id=candidate.portfolioId,sourceUrl=model.profileUrl(id),sources=[];
    const readPart=async (key,route,params)=>{
      const res=await read(id+'-'+key,route,{portfolioId:id,...params});
      expect(res.fetchedAt.slice(0,10)===rank.fetchedAt.slice(0,10)
        && Math.abs(Date.parse(res.fetchedAt)-Date.parse(rank.fetchedAt))<3600000,'Bitget mixed capture times');
      sources.push(res);return res;
    };
    const profile=await readPart('profile','details',{cycleTime:90}),detail=profile.data.publicDetail;
    expect(detail?.portfolioId===id && profile.data.traderAccountId===candidate.traderUid,'mismatched Bitget profile');
    if (number(detail.tradingDays)<90 || number(detail.curFollowCount)<1 || number(detail.aum)<25000) continue;
    const history=await historyPages(readPart,id,sourceUrl);
    if (!history.rows.length) continue;
    const performance={};
    for (const n of [90,30]) {
      const summary=await readPart('p'+n,'performance',{cycleTime:n});
      if (n===90 && number(summary.data.roi)<=0) break;
      const chart=await readPart('curve'+n,'cycleChartData',{cycleTime:n});
      performance[n+'D']=normalizePerformance(summary,chart,n,sourceUrl);
    }
    if (!performance['90D']) continue;
    const positions=activity(await readPart('open','currentPosition',{pageNo:1,pageSize:10}),false,sourceUrl);
    accounts.push({portfolioId:id,name:profile.data.displayName.trim(),sourceUrl,leadDays:detail.tradingDays,copyTraderNum:detail.curFollowCount,
      profileEvidence:ref(profile),performance,activity:{positions,history}});
    archive.push(...sources);
  }
  const generatedAt=archive.map(s=>s.fetchedAt).sort().at(-1);
  const bundle={schemaVersion:1,source:model.source,rankSourceUrl:model.rankUrl,rankEvidence:ref(rank),generatedAt,
    selection:'Bitget 合约统一账户组合，近90天 ROI 从高到低；官网首30项，带单满90天，AUM 至少 25,000 美元，带单及跟随盈亏非负。只收录近90天收益为正、采集时仍有跟随者且有公开平仓记录的前6个组合。',accounts};
  return {bundle:model.parse(bundle),archive};
}
async function publish(dir,{bundle,archive}) {
  await fs.mkdir(path.join(dir,'evidence'),{recursive:true});
  const lock=path.join(dir,'.publish-lock');
  const handle=await fs.open(lock,'wx');
  try {
    const dest=path.join(dir,'period-returns.json');
    let old;
    try {old=JSON.parse(await fs.readFile(dest,'utf8'));} catch (e) {if(e.code!=='ENOENT')throw e;}
    expect(!old || Date.parse(old.rankEvidence.fetchedAt)<=Date.parse(bundle.rankEvidence.fetchedAt),'newer Bitget snapshot exists');
    if (old) {
      model.parse(old);
      expect(Date.parse(old.generatedAt)<=Date.parse(bundle.generatedAt),'newer Bitget archive exists');
      const prior=new Map((old.archivedHistories||[]).map(r=>[r.portfolioId,r.history]));
      for(const row of old.accounts)prior.set(row.portfolioId,row.activity.history);
      for(const row of bundle.accounts) {
        row.activity.history=mergeHistory(row.activity.history,prior.get(row.portfolioId),row.portfolioId);
        prior.delete(row.portfolioId);
      }
      if(prior.size)bundle.archivedHistories=[...prior].map(([portfolioId,history])=>({portfolioId,history:normalizeLegacyHistory(history,portfolioId)}));
      model.parse(bundle);
    }
    for (const e of archive) {
      const file=path.join(dir,'evidence',path.basename(e.evidencePath));
      try {await fs.writeFile(file,e.bytes,{flag:'wx'});}
      catch(err) {if(err.code!=='EEXIST')throw err;expect((await fs.readFile(file)).equals(e.bytes),'evidence collision');}
    }
    const tmp=dest+'.'+randomUUID()+'.tmp';
    try {await fs.writeFile(tmp,JSON.stringify(bundle)+'\n');await fs.rename(tmp,dest);}
    finally {await fs.rm(tmp,{force:true});}
  } finally {await handle.close();await fs.rm(lock,{force:true});}
}
async function main(args) {
  const options=new Map();
  for (let i=0;i<args.length;i+=2) {
    expect(['--out','--receipts'].includes(args[i]) && !options.has(args[i]) && args[i+1],'invalid Bitget collector argument');
    options.set(args[i],args[i+1]);
  }
  const dir=options.get('--receipts');
  const result=await collect(dir?stored(dir):fetchReceipt);
  await publish(options.get('--out')||path.resolve(__dirname,'../trader/bitget'),result);
  console.log('Bitget verified '+result.bundle.accounts.length+' public portfolios with 30D/90D returns and position history');
}
module.exports={collect,stored,receipt,select,activity,historyPages,mergeHistory,normalizePerformance,publish};
if (require.main===module) main(process.argv.slice(2)).catch(err=>{console.error(err.message);process.exitCode=1;});
