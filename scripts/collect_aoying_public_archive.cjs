#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const model=require('../trader/aoying-public-archive.js');
const sha=data=>createHash('sha256').update(data).digest('hex');
function expect(value,message) {if(!value)throw Error(message);}
function keep(row,keys) {
  return Object.fromEntries(keys.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
}
function publicPositionSnapshot(input,raw){
  const state=input.positionState;
  if(!state||typeof state!=='object')return null; // old history-only captures
  const hasRows=Array.isArray(input.positions),visible=typeof state.positionShow==='boolean'?state.positionShow:null;
  const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const rows=(hasRows?input.positions:[]).map(r=>({symbol:r.symbol,baseAsset:r.baseAsset,side:String(r.side).toLowerCase(),quantity:r.absQty,
    entryPrice:number(r.avgPrice),markPrice:number(r.markPrice),notional:number(r.notional),unrealizedPnl:number(r.unrealizedPnl),leverage:number(r.leverage),
    sourceOpenedAt:Number.isSafeInteger(r.openTime)&&r.openTime>0?new Date(r.openTime).toISOString():null,origin:r.origin}));
  const empty=hasRows&&visible===true&&state.exchangeCount===0&&state.replayCount===0;
  const status=rows.length?'reported':empty?'reported_empty':visible===false?'hidden':'unavailable';
  const value=k=>rows.length||empty?number(input[k]):null;
  return {sourceUrl:model.sourceUrl,...captureReceipt(raw),sourceTime:state.syncedAt||null,status,sourcePositionShow:visible,rows,
    totals:{marginBalance:value('marginBalance'),notional:value('totalNotional'),unrealizedPnl:value('totalUnrealizedPnl'),effectiveLeverage:value('effectiveLeverage')},quote:'USDT',official:false};
}
function project(bytes,fetchedAt,now=Date.now()) {
  expect(bytes.length>0 && bytes.length<=8_000_000,'invalid AlphaFox response size');
  const reply=JSON.parse(bytes);
  const input=reply?.data;
  expect(reply.ok===true && input?.id===model.sourceId && input.portfolioId===model.portfolioId && input.historyLoaded===true
    && input.lifecycle?.sourceId===model.sourceId && input.lifecycle?.meta?.visibility==='public'
    && Array.isArray(input.closedPositions) && Array.isArray(input.latestOrders),'incomplete public AlphaFox archive');
  const raw={schemaVersion:1,projection:'public-historical-records-v1',sourceUrl:model.sourceUrl,sourceId:model.sourceId,portfolioId:model.portfolioId,
    sourceBodySha256:sha(bytes),polledAt:input.polledAt,fetchedAt,eventPnlAvailable:false,
    closedPositions:input.closedPositions.map(row=>keep(row,model.positionFields)),
    latestOrders:input.latestOrders.map(row=>{
      const data=keep(row,model.orderFields);
      // Price, quantity and event time identify this third-party observation; no exchange order ID is supplied.
      data.fingerprint=sha(JSON.stringify([model.sourceId,...model.orderFields.map(key=>data[key])]));
      return data;
    })};
  const observed=publicPositionSnapshot(input,raw);if(observed)raw.positionSnapshots=[observed];
  return model.parse(raw,now);
}
function mergeRecords(previous,latest,key) {
  const records=new Map(previous.map(row=>[row[key],row]));
  for(const row of latest) records.set(row[key],row);
  return [...records.values()];
}
function captureReceipt(raw) {
  return keep(raw,['sourceBodySha256','polledAt','fetchedAt']);
}
async function publish(file,raw) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const lock=file+'.lock',handle=await fs.open(lock,'wx');
  const tmp=file+'.'+randomUUID()+'.tmp';
  try {
    let current;
    try{current=model.parse(JSON.parse(await fs.readFile(file,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
    expect(!current || Date.parse(raw.polledAt)>=Date.parse(current.polledAt),'older AlphaFox snapshot rejected');
    if(current && Date.parse(current.polledAt)===Date.parse(raw.polledAt)) {
      expect(current.sourceBodySha256===raw.sourceBodySha256,'conflicting AlphaFox snapshot timestamp');
      const incoming=raw.positionSnapshots?.[0];
      if(!incoming||current.positionSnapshots?.some(s=>s.sourceBodySha256===incoming.sourceBodySha256))return current;
      // Reproject the previously acknowledged identical source body with the
      // original receipt; this is not a second observation of the position.
      const same=model.parse({...current,positionSnapshots:[...(current.positionSnapshots||[]),{...incoming,...captureReceipt(current)}]});
      await fs.writeFile(tmp,JSON.stringify(same)+'\n',{flag:'wx'});await fs.rename(tmp,file);return same;
    }
    const archive=model.parse(current?{...raw,
      positionSnapshots:[...(current.positionSnapshots||[]),...(raw.positionSnapshots||[])],
      archiveReceipts:[...(current.archiveReceipts||[captureReceipt(current)]),captureReceipt(raw)],
      closedPositions:mergeRecords(current.closedPositions,raw.closedPositions,'lifecycleId'),
      latestOrders:mergeRecords(current.latestOrders,raw.latestOrders,'fingerprint')
    }:raw);
    await fs.writeFile(tmp,JSON.stringify(archive)+'\n',{flag:'wx'});
    await fs.rename(tmp,file);
    return archive;
  } finally {await fs.rm(tmp,{force:true});await handle.close();await fs.rm(lock,{force:true});}
}
async function main(args) {
  const options=new Map();
  for(let i=0;i<args.length;i+=2) {
    expect(['--source-file','--fetched-at','--out'].includes(args[i]) && !options.has(args[i]) && args[i+1],'invalid AlphaFox collector argument');
    options.set(args[i],args[i+1]);
  }
  const sourceFile=options.get('--source-file');
  expect(Boolean(sourceFile)===options.has('--fetched-at'),'a saved response requires its receipt time');
  let bytes,fetchedAt;
  if(sourceFile) {bytes=await fs.readFile(sourceFile);fetchedAt=options.get('--fetched-at');}
  else {
    const response=await fetch(model.sourceUrl,{signal:AbortSignal.timeout(20000),credentials:'omit',redirect:'error'});
    expect(response.ok && Number(response.headers.get('content-length')||0)<=8_000_000,'AlphaFox HTTP '+response.status);
    bytes=Buffer.from(await response.arrayBuffer());fetchedAt=new Date().toISOString();
  }
  const raw=project(bytes,fetchedAt);
  const archive=await publish(options.get('--out')||path.resolve(__dirname,'../trader/binance/aoying-public-archive.json'),raw);
  console.log('AlphaFox public archive: '+archive.closedPositions.length+' historical positions, '+archive.latestOrders.length+' operations');
}
module.exports={project,publish};
if(require.main===module) main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
