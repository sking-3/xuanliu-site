#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {avatarUrl} = require('../trader/binance-data.js');

const ids = [
  '5156287639231681792','5139646755272846081','5178595252342363392',
  '4751838302089254401','4532994172262753536','4708220152086930177','4664928038467820544',
  '4566696155639181057','4186437056735338496','4286775714676474369','4753185532199309057'
];
const periods = ['90D','365D'];
const file = path.join(__dirname,'..','trader','binance','period-returns.json');
const base = 'https://www.binance.com/bapi/futures/v1/';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

function urlFor(id,period) {
  if (!ids.includes(id)) throw Error('unsupported_account');
  if (period==='profile') return base+'friendly/future/copy-trade/lead-portfolio/detail?portfolioId='+id;
  if (!periods.includes(period)) throw Error('unsupported_period');
  return base+'public/future/copy-trade/lead-portfolio/performance?portfolioId='+id+'&timeRange='+period;
}

function decode(receipt,now=Date.now()) {
  const {portfolioId:id,period,sourceUrl,receivedAt,httpStatus,bodyBase64} = receipt;
  if (sourceUrl!==urlFor(id,period) || httpStatus!==200 || typeof receivedAt!=='string' ||
      !/^\d{4}-\d\d-\d\dT.*Z$/.test(receivedAt) || !Number.isFinite(Date.parse(receivedAt)) ||
      Date.parse(receivedAt)>now+5000) throw Error('invalid_source_receipt');
  if (typeof bodyBase64!=='string' || bodyBase64.length>131072) throw Error('invalid_response_bytes');
  const bytes=Buffer.from(bodyBase64,'base64');
  if (!bytes.length || bytes.toString('base64')!==bodyBase64) throw Error('invalid_response_bytes');
  const raw=JSON.parse(bytes.toString('utf8'));
  if (raw.code!=='000000' || raw.success!==true || !raw.data || typeof raw.data!=='object') throw Error('unsuccessful_response');
  const sha256=hash(bytes);
  const evidencePath='binance/evidence/performance-v1/'+id+'/'+period+'-'+sha256+'.json';
  return {id,period,sourceUrl,receivedAt,data:raw.data,bytes,sha256,evidencePath};
}

function profile(decoded) {
  const {data,id,sourceUrl,receivedAt,sha256,evidencePath}=decoded;
  if (data.leadPortfolioId!==id) throw Error('identity_mismatch');
  if (!['PUBLIC','SIGNAL'].includes(data.portfolioType) || data.status!=='ACTIVE' ||
      (data.publicLeadPortfolioId!=null && data.publicLeadPortfolioId!==id)) throw Error('portfolio_not_public_active');
  if (!Number.isSafeInteger(data.startTime) || data.startTime<=0 || data.startTime>Date.parse(receivedAt) ||
      typeof data.nickname!=='string' || !data.nickname.trim() || data.nickname.length>200 ||
      typeof data.positionShow!=='boolean') throw Error('invalid_public_profile');
  return {portfolioId:id,name:data.nickname.trim(),avatarUrl:avatarUrl(data.avatarUrl),startTime:data.startTime,positionShow:data.positionShow,
    profileSourceUrl:sourceUrl,profileEvidencePath:evidencePath,profileEvidenceSha256:sha256,profileFetchedAt:receivedAt};
}

function value(x) {
  if (x==null) return null;
  if (typeof x==='number' && Number.isFinite(x)) return x;
  if (typeof x==='string' && /^[+-]?\d+(\.\d+)?$/.test(x) && Number.isFinite(Number(x))) return Number(x);
  throw Error('invalid_metric');
}

function performance(decoded,account) {
  const {data,id,period,sourceUrl,receivedAt,sha256,bytes,evidencePath}=decoded;
  if (account.portfolioId!==id || data.timeRange!==period || data.portfolioId!=null && data.portfolioId!==id ||
      data.leadPortfolioId!=null && data.leadPortfolioId!==id || account.startTime>Date.parse(receivedAt)) throw Error('wrong_period_or_account');
  const metrics=Object.fromEntries(['roi','pnl','mdd','winRate'].map(key=>[key,value(data[key])]));
  if (metrics.roi===null) throw Error('no_reported_roi');
  if (metrics.winRate!==null && (metrics.winRate<0 || metrics.winRate>100)) throw Error('invalid_win_rate');
  return {...metrics,status:'ready',sourcePeriod:period,currency:'USDT',sourceUrl,evidencePath,
    lastAttemptAt:receivedAt,lastSuccessAt:receivedAt,sourceAsOf:null,errorCode:null,
    portfolioStartedAt:new Date(account.startTime).toISOString(),profileEvidencePath:account.profileEvidencePath,
    profileEvidenceSha256:account.profileEvidenceSha256,
    evidence:{sha256,bytes:bytes.length,httpStatus:200,code:'000000',receivedAt}};
}

async function getReceipt(id,period,fetchImpl) {
  const sourceUrl=urlFor(id,period);
  const r=await fetchImpl(sourceUrl,{headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(12000)});
  if (r.status!==200) throw Error('http_'+r.status);
  if (!r.headers.get('content-type')?.includes('application/json')) throw Error('invalid_content_type');
  const parts=[];let length=0;
  for await (const chunk of r.body) {
    length+=chunk.byteLength;
    if (length>65536) throw Error('response_too_large');
    parts.push(chunk);
  }
  return {portfolioId:id,period,sourceUrl,httpStatus:r.status,receivedAt:new Date().toISOString(),
    bodyBase64:Buffer.concat(parts).toString('base64')};
}

async function capture(fetchImpl=globalThis.fetch,sleep=delay) {
  const receipts=[],failures=[];
  for (const id of ids) {
    let account;
    for (const period of ['profile',...periods]) {
      if (receipts.length || failures.length) await sleep(500);
      try {
        const receipt=await getReceipt(id,period,fetchImpl), d=decode(receipt);
        if (period==='profile') account=profile(d); else performance(d,account);
        receipts.push(receipt);
      } catch (error) {
        const code=/^[a-zA-Z0-9_]{1,80}$/.test(error.message)?error.message:'network_error';
        failures.push({id,period,code,at:new Date().toISOString()});
        if (/^http_(202|401|403|418|429|451)$/.test(code)) return {receipts,failures};
        if (period==='profile') break;
      }
    }
  }
  return {receipts,failures};
}

function merge(previous,receipts,failures=[],now=Date.now()) {
  if (previous.schemaVersion!==1 || !Array.isArray(previous.accounts) || !Array.isArray(receipts)) throw Error('invalid_collection');
  const accounts=new Map(previous.accounts.map(row=>[row.portfolioId,structuredClone(row)]));
  const batch=new Map(),artifacts=new Map();
  for (const receipt of receipts) {
    const d=decode(receipt,now);
    if (!batch.has(d.id)) batch.set(d.id,new Map());
    if (batch.get(d.id).has(d.period)) throw Error('duplicate_receipt');
    batch.get(d.id).set(d.period,d);
  }
  let generatedAt=previous.generatedAt;
  function latest(at) {if (!generatedAt || at>generatedAt) generatedAt=at;}
  for (const [id,group] of batch) {
    const detail=group.get('profile');
    if (!detail) throw Error('missing_profile_receipt');
    const checked=profile(detail),old=accounts.get(id);
    if (old && Date.parse(old.profileFetchedAt)>Date.parse(detail.receivedAt)) continue;
    const account={...checked,performance:old?.performance??{schemaVersion:1,byPeriod:{}}};
    if (old && old.startTime!==checked.startTime) throw Error('portfolio_start_changed');
    artifacts.set(detail.evidencePath,detail.bytes);
    latest(detail.receivedAt);
    for (const period of periods) {
      const d=group.get(period);
      if (!d) continue;
      const part=performance(d,account),before=account.performance.byPeriod[period];
      if (before && Date.parse(before.lastAttemptAt)>Date.parse(part.lastSuccessAt)) continue;
      account.performance.byPeriod[period]=part;
      artifacts.set(d.evidencePath,d.bytes);latest(d.receivedAt);
    }
    if (Object.keys(account.performance.byPeriod).length) accounts.set(id,account);
  }
  for (const {id,period,code,at} of failures) {
    const account=accounts.get(id);
    if (!account || Date.parse(account.profileFetchedAt)>Date.parse(at)) continue;
    latest(at);
    if (period==='profile' && ['identity_mismatch','portfolio_not_public_active'].includes(code)) {accounts.delete(id);continue;}
    for (const window of period==='profile'?periods:[period]) {
      const prev=account.performance.byPeriod[window];
      if (prev && Date.parse(prev.lastAttemptAt)<=Date.parse(at)) {
        prev.status='stale';prev.errorCode=code;prev.lastAttemptAt=at;
      }
    }
  }
  return {out:{schemaVersion:1,generatedAt,accounts:[...accounts.values()].sort((a,b)=>a.portfolioId.localeCompare(b.portfolioId))},artifacts};
}

function write(filename,receipts,failures) {
  const root=path.dirname(path.dirname(filename));
  const before=fs.existsSync(filename)?fs.readFileSync(filename,'utf8'):null;
  const previous=before?JSON.parse(before):{schemaVersion:1,generatedAt:null,accounts:[]};
  const {out,artifacts}=merge(previous,receipts,failures);
  const keep=new Set();
  for (const account of out.accounts) {
    keep.add(account.profileEvidencePath);
    for (const part of Object.values(account.performance.byPeriod)) {
      keep.add(part.evidencePath);keep.add(part.profileEvidencePath);
    }
  }
  for (const [ref,bytes] of artifacts) {
    if (!keep.has(ref)) continue;
    const target=path.join(root,ref);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    try {fs.writeFileSync(target,bytes,{flag:'wx'});}
    catch(e){if (e.code!=='EEXIST' || !fs.readFileSync(target).equals(bytes)) throw e;}
  }
  for (const ref of keep) {
    if (!/^binance\/evidence\/performance-v1\/\d{19}\/(profile|90D|365D)-[a-f0-9]{64}\.json$/.test(ref) ||
        hash(fs.readFileSync(path.join(root,ref)))!==ref.slice(-69,-5)) throw Error('missing_or_changed_evidence');
  }
  const tmp=filename+'.periods-'+process.pid+'.tmp';
  try {
    fs.writeFileSync(tmp,JSON.stringify(out,null,2)+'\n');
    if ((fs.existsSync(filename)?fs.readFileSync(filename,'utf8'):null)!==before) throw Error('collection_changed_during_write');
    fs.renameSync(tmp,filename);
  } finally {fs.rmSync(tmp,{force:true});}
  for (const id of ids) {
    const dir='binance/evidence/performance-v1/'+id;
    if (!fs.existsSync(path.join(root,dir))) continue;
    for (const name of fs.readdirSync(path.join(root,dir))) {
      if (/^(profile|90D|365D)-[a-f0-9]{64}\.json$/.test(name) && !keep.has(dir+'/'+name)) fs.unlinkSync(path.join(root,dir,name));
    }
  }
  return out;
}

async function main(args) {
  let data;
  if (!args.length) data=await capture();
  else if (args[0]==='--receipts' && args.length>=2) {
    data={receipts:args.slice(1).flatMap(f=>JSON.parse(fs.readFileSync(f,'utf8'))),failures:[]};
  } else throw Error('Usage: collect_binance_periods.cjs [--receipts file.json ...]');
  if (!data.receipts.length && !data.failures.length) throw Error('empty_input');
  const out=write(file,data.receipts,data.failures);
  console.log(JSON.stringify({accounts:out.accounts.length,received:data.receipts.length,failures:data.failures}));
  if (!data.receipts.length) process.exitCode=1;
}
if (require.main===module) main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={ids,periods,urlFor,decode,profile,performance,capture,merge,write};
