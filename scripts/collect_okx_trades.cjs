#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const model=require('../trader/okx-trades.js');
const run=promisify(execFile), kinds=['positions','history'],maxPages=5;
const base=path.resolve(__dirname,'../trader/okx');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(ok,msg){if(!ok)throw Error(msg);}
function n(v){
  if(v===undefined||v===null||v==='')return null;
  check(typeof v==='string'&&/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v)&&Number.isFinite(Number(v)),'invalid OKX number');
  return Number(v);
}
function iso(value){const t=n(value);check(Number.isSafeInteger(t)&&t>0,'invalid OKX timestamp');return new Date(t).toISOString();}
function row(raw,id,kind,p){
  check(raw&&raw.uniqueCode===id&&raw.instType==='SWAP'&&model.validSubId(raw.subPosId),'foreign or invalid OKX position');
  // A successful response can contain deliberately masked instruments, quantities and prices.
  if(!raw.instId||!raw.openTime||!raw.openAvgPx||!raw.subPos||!raw.posSide||
      kind==='history'&&(!raw.closeTime||!raw.closeAvgPx))return null;
  const quantity=n(raw.subPos);
  if(quantity===0)return null;
  check(['long','short','net'].includes(raw.posSide),'invalid position side');
  const side=raw.posSide==='net'?(quantity<0?'short':'long'):raw.posSide;
  const r={id:raw.subPosId,symbol:raw.instId,side,sourceSide:raw.posSide,quantity:Math.abs(quantity),unit:'张',
    currency:raw.ccy,leverage:n(raw.lever),openedAt:iso(raw.openTime),entryPrice:n(raw.openAvgPx),
    margin:n(raw.margin),marginMode:['cross','isolated'].includes(raw.mgnMode)?raw.mgnMode:null,
    sourceUrl:p.sourceUrl,evidencePath:p.evidencePath};
  const ratio=n(kind==='history'?raw.pnlRatio:raw.uplRatio);
  r.pnlRatioPct=ratio===null?null:Number((ratio*100).toFixed(10));
  if(kind==='history')Object.assign(r,{closedAt:iso(raw.closeTime),exitPrice:n(raw.closeAvgPx),realizedPnl:n(raw.pnl)});
  else Object.assign(r,{markPrice:n(raw.markPx),unrealizedPnl:n(raw.upl)});
  return r;
}
async function live(name,url){
  const response=await run('curl',['--disable','--silent','--show-error','--compressed','--max-time','18','--connect-timeout','8',
    '--retry','2','--retry-all-errors','--header','Accept: application/json','--write-out','\n%{http_code}',url],{maxBuffer:5*1024*1024,encoding:'buffer'});
  const b=response.stdout,split=b.lastIndexOf(10);
  check(split>0,'empty HTTP response');
  return {bytes:b.subarray(0,split),meta:{sourceUrl:url,httpStatus:Number(b.subarray(split+1).toString()),receivedAt:new Date().toISOString()}};
}
function stored(dir){return async(name,url)=>{
  const [bytes,meta]=await Promise.all([fs.readFile(path.join(dir,name+'.raw.json')),fs.readFile(path.join(dir,name+'.meta.json'),'utf8')]);
  return {bytes,meta:JSON.parse(meta)};
};}
function proof(id,kind,after,receipt){
  const {bytes,meta}=receipt,sourceUrl=model.url(id,kind,after);
  check(meta.sourceUrl===sourceUrl&&Number.isFinite(Date.parse(meta.receivedAt)),'wrong OKX receipt identity or time');
  check(meta.httpStatus===200,'HTTP '+meta.httpStatus);
  check(bytes.length>0&&bytes.length<3*1024*1024,'unexpected response size');
  const data=JSON.parse(bytes.toString('utf8'));
  check(typeof data.code==='string'&&Array.isArray(data.data),'invalid OKX response');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const page={after,sourceUrl,evidencePath:model.evidence(id,kind,sha256),sha256,bytes:bytes.length,receivedAt:meta.receivedAt};
  return {data,page,bytes};
}
function unavailable(id,kind,checkedAt,previous,reason,page){
  const sourceUrl=model.url(id,kind);
  if(previous?.rows.length && (kind==='history'||!page)){
    const pages=previous.pages.slice();
    if(page&&!pages.some(p=>p.evidencePath===page.evidencePath))pages.push(page);
    return {...previous,status:'stale',checkedAt,reason,pages};
  }
  return {status:'unavailable',rows:[],checkedAt,fetchedAt:null,sourceUrl,evidencePath:page?.evidencePath||null,
    pages:page?[page]:[],truncated:false,hiddenCount:0,reason};
}
async function group(read,wait,id,kind,previous,archive){
  const result={sourceUrl:model.url(id,kind),evidencePath:null,status:'ready',checkedAt:null,fetchedAt:null,pages:[],rows:[],hiddenCount:0,truncated:false,reason:null};
  const ids=new Set();let after='';
  for(let i=1;i<=maxPages;i++){
    let received=null;
    try{
      await wait();
      received=await read(id+'-'+kind+'-'+i,model.url(id,kind,after));
      const {data,page,bytes}=proof(id,kind,after,received);
      if(data.code!=='0'){
        archive.set(page.evidencePath,bytes);
        if(!result.pages.length)return unavailable(id,kind,page.receivedAt,previous,'OKX '+data.code+' '+String(data.msg||'').slice(0,160),page);
        throw Error('OKX '+data.code);
      }
      check(data.data.length<=100,'page exceeds requested limit');
      const rows=[],pageIds=new Set();
      let hiddenCount=0;
      for(const raw of data.data){
        check(!ids.has(raw.subPosId)&&!pageIds.has(raw.subPosId),'repeated public lead position');
        const r=row(raw,id,kind,page);pageIds.add(raw.subPosId);
        if(r)rows.push(r);else hiddenCount++;
      }
      for(const key of pageIds)ids.add(key);
      archive.set(page.evidencePath,bytes);
      result.pages.push(page);result.rows.push(...rows);result.hiddenCount+=hiddenCount;
      result.checkedAt=page.receivedAt;result.fetchedAt=page.receivedAt;
      result.evidencePath ||= page.evidencePath;
      if(data.data.length<100)break;
      after=data.data.at(-1).subPosId;
      if(i===maxPages)result.truncated=true;
    }catch(err){
      const stamp=received?.meta?.receivedAt||new Date().toISOString();
      if(!result.pages.length)return unavailable(id,kind,stamp,previous,err.message.slice(0,160));
      result.checkedAt=stamp;result.truncated=true;result.reason=err.message.slice(0,160);break;
    }
  }
  if(kind==='history'&&previous?.rows.length){
    // Keep previously published closed positions and the exact receipts backing them as the source's window advances.
    const retired=previous.rows.filter(r=>!ids.has(r.id)),kept=new Set(retired.map(r=>r.evidencePath));
    const known=new Set(result.pages.map(p=>p.evidencePath));
    result.pages.push(...previous.pages.filter(p=>kept.has(p.evidencePath)&&!known.has(p.evidencePath)));
    result.rows.push(...retired);
  }
  result.rows.sort((a,b)=>String(b.closedAt||b.openedAt).localeCompare(String(a.closedAt||a.openedAt))||b.id.localeCompare(a.id));
  result.status=result.truncated||result.hiddenCount?'partial':result.rows.length?'ready':'empty';
  return result;
}
async function collect(accounts,read,wait,prev){
  const archive=new Map(),rows=[];
  const prevMap=new Map((prev?.accounts||[]).map(a=>[a.uniqueCode,a]));
  for(const account of accounts){
    check(model.validId(account.uniqueCode),'invalid trader ID');
    const activity={};
    for(const kind of kinds)activity[kind]=await group(read,wait,account.uniqueCode,kind,prevMap.get(account.uniqueCode)?.activity[kind],archive);
    activity.orders={status:'unsupported',rows:[],checkedAt:null,fetchedAt:null,sourceUrl:null,evidencePath:null,reason:'公开接口提供带单持仓及已平仓记录，未提供逐笔成交流水。'};
    rows.push({uniqueCode:account.uniqueCode,name:account.name,activity});
  }
  const currentIds=new Set(rows.map(a=>a.uniqueCode));
  for(const a of (prev?.accounts||[]))if(!currentIds.has(a.uniqueCode))rows.push(a);
  const generatedAt=new Date(Math.max(...rows.flatMap(a=>kinds.map(k=>Date.parse(a.activity[k].checkedAt))))).toISOString();
  return {bundle:model.parse({schemaVersion:1,source:'okx_public_lead_subpositions',generatedAt,accounts:rows},Date.parse(generatedAt)),archive};
}
async function publish(out,bundle,archive){
  const destination=path.join(out,'trades.json'),dir=path.join(out,'trade-evidence');
  await fs.mkdir(dir,{recursive:true});
  for(const [rel,bytes] of archive){
    const file=path.join(dir,path.basename(rel));
    try{await fs.writeFile(file,bytes,{flag:'wx'});}
    catch(e){if(e.code!=='EEXIST')throw e;check((await fs.readFile(file)).equals(bytes),'raw evidence mismatch');}
  }
  const wanted=new Set(bundle.accounts.flatMap(a=>kinds.flatMap(k=>a.activity[k].pages.map(p=>path.basename(p.evidencePath)))));
  for(const name of wanted)await fs.access(path.join(dir,name));
  const temp=destination+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,JSON.stringify(bundle)+'\n');await fs.rename(temp,destination);}
  finally{await fs.rm(temp,{force:true});}
  // Retain earlier content-addressed evidence for durable observations when a position disappears.
}
async function main(args){
  const opts=new Map();
  for(let i=0;i<args.length;i+=2){
    check(['--receipts','--out','--accounts'].includes(args[i])&&args[i+1]&&!opts.has(args[i]),'usage: collect_okx_trades.cjs [--receipts DIR] [--out DIR] [--accounts period-returns.json]');opts.set(args[i],args[i+1]);
  }
  const out=opts.get('--out')||base,source=JSON.parse(await fs.readFile(opts.get('--accounts')||path.join(base,'period-returns.json'),'utf8'));
  await fs.mkdir(out,{recursive:true});const lock=path.join(out,'.trades-collect.lock');const f=await fs.open(lock,'wx');
  try{
    let previous=null;
    try{
      const raw=JSON.parse(await fs.readFile(path.join(out,'trades.json'),'utf8'));
      previous=model.parse(raw,Date.parse(raw.generatedAt));
    }catch(e){if(e.code!=='ENOENT')throw e;}
    const dir=opts.get('--receipts');
    const {bundle,archive}=await collect(source.accounts,dir?stored(dir):live,dir?async()=>{}:()=>pause(650),previous);
    if(previous)check(Date.parse(bundle.generatedAt)>=Date.parse(previous.generatedAt),'refusing to publish an older snapshot');
    await publish(out,bundle,archive);
    for(const a of bundle.accounts)console.log(a.name,kinds.map(k=>k+' '+a.activity[k].status+' '+a.activity[k].rows.length).join(' / '));
  }finally{await f.close();await fs.rm(lock,{force:true});}
}
module.exports={row,proof,collect,stored,publish};
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
