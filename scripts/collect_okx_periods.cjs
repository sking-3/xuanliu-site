#!/usr/bin/env node
/* Collect the public SWAP leaderboard, dated PnL curves and official period win ratios. */
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const model=require('../trader/okx-period-data.js');
const guard=require('./okx_source_guard.cjs');
const day=86400000;
function expect(ok,reason){if(!ok)throw Error(reason);}
function number(value){
  expect(typeof value==='string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)),'invalid OKX numeric field');
  return Number(value);
}
function select(payload){
  const batch=payload.data?.[0];
  expect(payload.code==='0' && /^\d{14}$/.test(batch?.dataVer) && Array.isArray(batch.ranks) && batch.ranks.length<=20,'invalid OKX leaderboard');
  const seen=new Set();
  const eligible=[];
  for(const r of batch.ranks){
    expect(model.validId(r.uniqueCode) && !seen.has(r.uniqueCode),'invalid or duplicate public trader ID');
    seen.add(r.uniqueCode);
    const leadDays=number(r.leadDays),copies=number(r.copyTraderNum),ratio=number(r.pnlRatio);
    expect(Number.isSafeInteger(leadDays) && leadDays>=0 && Number.isSafeInteger(copies) && copies>=0,'invalid OKX days or followers');
    if(r.ccy!=='USDT'||leadDays<90||copies<1||ratio<=0)continue;
    eligible.push(r);
  }
  return eligible.sort((a,b)=>number(b.pnlRatio)-number(a.pnlRatio)||a.uniqueCode.localeCompare(b.uniqueCode)).slice(0,model.limit);
}
function curve(payload,period,receivedAt){
  const rows=payload.data,days=model.days[period];
  expect(payload.code==='0' && Array.isArray(rows),'invalid OKX curve reply');
  // A provider snapshot can omit one day. Keep the actual returned points and window.
  if(rows.length!==days && rows.length!==days+1)return null;
  const points=rows.map(p=>({t:number(p.beginTs),pnl:number(p.pnl),ratio:number(p.pnlRatio)})).sort((a,b)=>a.t-b.t);
  const first=points[0],last=points.at(-1);
  if(first.ratio!==0 || first.pnl!==0 || last.t-first.t!==days*day ||
    !points.every((p,i)=>Number.isSafeInteger(p.t)&&p.t>0&&(p.t-first.t)%day===0&&(!i||p.t>points[i-1].t)))return null;
  const age=Date.parse(receivedAt)-last.t;
  if(!(age>=0 && age<2*day))return null;
  return {sourcePeriod:period,roi:Number((last.ratio*100).toFixed(10)),pnl:last.pnl,mdd:null,winRate:null,
    beginTs:first.t,endTs:last.t,pointCount:points.length,sourceAsOf:null,lastSuccessAt:receivedAt};
}
function sourceWinRate(payload,period){
  const row=payload?.data?.[0];
  if(payload?.code!=='0'||!Array.isArray(payload.data)||payload.data.length!==1||row?.ccy!=='USDT' ||
    typeof row.winRatio!=='string'||!/^(?:0|1)(?:\.\d+)?$/.test(row.winRatio)||
    typeof row.profitDays!=='string'||!/^\d+$/.test(row.profitDays)||typeof row.lossDays!=='string'||!/^\d+$/.test(row.lossDays))return null;
  const winRate=Number((Number(row.winRatio)*100).toFixed(10));
  const profitDays=Number(row.profitDays),lossDays=Number(row.lossDays);
  if(!model.winMatchesDays(winRate,profitDays,lossDays,period))return null;
  return {winRate,profitDays,lossDays};
}
function receipt(name,url,bytes,meta){
  expect(meta.sourceUrl===url && meta.name===name && meta.httpStatus===200 && meta.code==='0' &&
    meta.bytes===bytes.length && bytes.length>0 && bytes.length<=1048576 && Number.isFinite(Date.parse(meta.receivedAt)),'invalid OKX receipt for '+name);
  const payload=JSON.parse(bytes.toString('utf8'));
  expect(payload.code==='0','OKX source rejected '+name);
  const sha=createHash('sha256').update(bytes).digest('hex');
  return {name,url,bytes,receivedAt:meta.receivedAt,payload,sha,evidencePath:model.evidencePath(name,sha)};
}
async function fetchReceipt(name,url){
  await guard.check();
  const response=await fetch(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15000)});
  if(response.status===403||response.status===429)await guard.stop(response.status);
  expect(response.ok,'OKX HTTP '+response.status+' for '+name);
  const bytes=Buffer.from(await response.arrayBuffer());
  return receipt(name,url,bytes,{name,sourceUrl:url,httpStatus:response.status,code:'0',bytes:bytes.length,receivedAt:new Date().toISOString()});
}
function stored(dir){return async(name,url)=>{
  const [bytes,meta]=await Promise.all([fs.readFile(path.join(dir,name+'.raw.json')),fs.readFile(path.join(dir,name+'.meta.json'),'utf8')]);
  return receipt(name,url,bytes,JSON.parse(meta));
};}
async function collect(read,wait=async()=>{}){
  const leaderboard=await read('leaders',model.rankUrl);
  const selected=select(leaderboard.payload),accounts=[],archive=[leaderboard];
  let generatedAt=leaderboard.receivedAt;
  let statsReadFailed=false;
  for(const r of selected){
    const id=r.uniqueCode,performance={};
    for(const p of ['90D','7D','30D','365D']){
      if(number(r.leadDays)<model.days[p])continue;
      await wait();
      const source=await read(id+'-'+model.ranges[p],model.curveUrl(id,p));
      const part=curve(source.payload,p,source.receivedAt);
      if(!part)continue;
      if(p==='90D'){
        // Require the independent leaderboard return, daily bucket and PnL to match.
        const newest=r.pnlRatios?.reduce((latest,row)=>!latest||number(row.beginTs)>number(latest.beginTs)?row:latest,null);
        if(!newest || number(newest.beginTs)!==part.endTs || Math.abs(part.roi-number(r.pnlRatio)*100)>1e-8 ||
           Math.abs(part.pnl-number(r.pnl))>.000001)break;
      }else if(!performance['90D'] || part.endTs!==performance['90D'].endTs)continue;
      performance[p]={...part,sourceUrl:source.url,evidenceSha256:source.sha,evidencePath:source.evidencePath};
      archive.push(source);
      if(Date.parse(source.receivedAt)>Date.parse(generatedAt))generatedAt=source.receivedAt;
      if(statsReadFailed)continue;
      await wait();
      const stats=await read(model.statsName(id,p),model.statsUrl(id,p)).catch(err=>{
        if(err.code==='OKX_SOURCE_STOPPED')throw err;
        // Older saved evidence sets may never have fetched this optional endpoint.
        if(err.code!=='ENOENT')statsReadFailed=true;
        return null;
      });
      const win=sourceWinRate(stats?.payload,p);
      if(!win)continue;
      // Older loaded pages require winRate=null on the curve itself.
      performance[p].winRateEvidence={sourceUrl:stats.url,evidenceSha256:stats.sha,evidencePath:stats.evidencePath,
        lastSuccessAt:stats.receivedAt,percent:win.winRate,profitDays:win.profitDays,lossDays:win.lossDays};
      archive.push(stats);
      if(Date.parse(stats.receivedAt)>Date.parse(generatedAt))generatedAt=stats.receivedAt;
    }
    if(!performance['90D'])continue;
    accounts.push({uniqueCode:id,name:r.nickName.trim(),avatarUrl:model.avatarUrl(r.portLink),leadDays:number(r.leadDays),copyTraderNum:number(r.copyTraderNum),
      sourceUrl:model.accountSourceUrl(id),performance});
  }
  expect(accounts.length>0,'no OKX 90D curve matched the leaderboard; previous archive kept');
  const bundle={schemaVersion:1,source:'okx_public_lead',generatedAt,rankEvidencePath:leaderboard.evidencePath,rankEvidenceSha256:leaderboard.sha,
    rankSourceUrl:leaderboard.url,rankFetchedAt:leaderboard.receivedAt,rankVersion:leaderboard.payload.data[0].dataVer,accounts};
  return {bundle:model.parse(bundle),archive};
}
function mergeDirectory(previous,next){
  model.parse(next);
  if(!previous)return next;
  model.parse(previous);
  expect(Date.parse(next.rankFetchedAt)>=Date.parse(previous.rankFetchedAt),'refusing to overwrite a newer leaderboard');
  const old=new Map(previous.accounts.map(row=>[row.uniqueCode,row]));
  const accounts=next.accounts.map(row=>{
    const former=old.get(row.uniqueCode);old.delete(row.uniqueCode);
    // Missing new windows retain their own original evidence and observation time.
    return former?{...row,performance:{...former.performance,...row.performance}}:row;
  });
  for(const row of old.values())accounts.push({...row,selection:row.selection||{
    status:'historical',rankEvidencePath:previous.rankEvidencePath,rankEvidenceSha256:previous.rankEvidenceSha256,
    rankSourceUrl:previous.rankSourceUrl,rankFetchedAt:previous.rankFetchedAt,rankVersion:previous.rankVersion
  }});
  expect(accounts.length<=model.archiveLimit,'OKX directory archive limit reached');
  return model.parse({...next,accounts});
}
async function publish(dir,{bundle,archive}){
  const destination=path.join(dir,'period-returns.json');
  await fs.mkdir(path.join(dir,'evidence'),{recursive:true});
  let previous;
  try {previous=JSON.parse(await fs.readFile(destination,'utf8'));}catch(err){if(err.code!=='ENOENT')throw err;}
  bundle=mergeDirectory(previous,bundle);
  for(const source of archive){
    const file=path.join(dir,'evidence',path.basename(source.evidencePath));
    // Content-addressed paths may be shared by past and future snapshots.
    try { await fs.writeFile(file,source.bytes,{flag:'wx'}); }
    catch(err){if(err.code!=='EEXIST')throw err;expect((await fs.readFile(file)).equals(source.bytes),'stored evidence mismatch');}
  }
  const references=new Map([[bundle.rankEvidencePath,bundle.rankEvidenceSha256]]);
  for(const row of bundle.accounts){
    if(row.selection)references.set(row.selection.rankEvidencePath,row.selection.rankEvidenceSha256);
    for(const part of Object.values(row.performance)){
      references.set(part.evidencePath,part.evidenceSha256);
      if(part.winRateEvidence)references.set(part.winRateEvidence.evidencePath,part.winRateEvidence.evidenceSha256);
    }
  }
  for(const [ref,sha] of references){
    const bytes=await fs.readFile(path.join(dir,'evidence',path.basename(ref)));
    expect(createHash('sha256').update(bytes).digest('hex')===sha,'missing or changed OKX evidence');
  }
  const tmp=destination+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(tmp,JSON.stringify(bundle)+'\n');await fs.rename(tmp,destination);}
  finally{await fs.rm(tmp,{force:true});}
}
async function main(args){
  const argsMap=new Map();
  for(let i=0;i<args.length;i+=2){expect(['--receipts','--out'].includes(args[i]) && args[i+1] && !argsMap.has(args[i]),'usage: collect_okx_periods.cjs [--receipts DIR] [--out DIR]');argsMap.set(args[i],args[i+1]);}
  const dir=argsMap.get('--receipts');
  const result=await collect(dir?stored(dir):fetchReceipt,dir?undefined:()=>new Promise(resolve=>setTimeout(resolve,650)));
  await publish(argsMap.get('--out')||path.resolve(__dirname,'../trader/okx'),result);
  console.log('OKX verified',Object.fromEntries(Object.keys(model.days).map(p=>[p,result.bundle.accounts.filter(r=>r.performance[p]).length])));
}
module.exports={select,curve,receipt,stored,collect,mergeDirectory,publish};
if(require.main===module)main(process.argv.slice(2)).catch(err=>{console.error(err.message);process.exitCode=1;});
