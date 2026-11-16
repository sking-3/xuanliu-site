#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const path=require('node:path');
const {persistSnapshots}=require('./position_lifecycle.cjs');
const {validateCollection}=require('./collect_binance.cjs');
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
function snapshotsFromBinance(collection){
  validateCollection(collection);const observations=[];
  for(const account of collection.portfolios){
    const accountId=account.portfolioId,scope='public_lead_futures',sourceUrl='https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-data/positions?portfolioId='+accountId;
    const base={exchange:'Binance',accountId,scope,sourceUrl};
    const snapshots=new Map((account.snapshots||[]).map(s=>[s.observedAt,s]));
    if(account.snapshot)snapshots.set(account.snapshot.observedAt,account.snapshot);
    for(const s of snapshots.values()){
      if(s.complete!==true||!Array.isArray(s.positions))throw Error('invalid_binance_observation');
      const positions=s.positions.map(p=>{
        const linear=(p.collateral==='USDT'||p.collateral==='USDC')&&p.symbol.endsWith(p.collateral);
        return {key:p.key,symbol:p.symbol,side:p.side.toLowerCase(),quantity:p.quantity,quantityUnit:linear?p.symbol.slice(0,-p.collateral.length):null,
          entryPrice:p.entryPrice,markPrice:p.markPrice,unrealizedPnl:p.unrealizedPnl,leverage:p.leverage,currency:p.collateral,
          notional:linear?Number(p.markPrice)*Number(p.quantity):null};
      });
      observations.push({...base,observedAt:s.observedAt,status:'complete',positions});
    }
    if(account.source.status!=='ready'&&account.source.lastAttemptAt)observations.push({...base,observedAt:account.source.lastAttemptAt,status:account.source.status==='restricted'?'hidden':account.snapshot?'stale':'unavailable',positions:[]});
  }
  return observations;
}
function snapshotFromFocus(raw){
  // public-focus.js validates the address, source timestamps, rows and numbers.
  const d=require('../trader/public-focus.js').validate(raw);
  return {exchange:'Hyperliquid',accountId:d.address,scope:d.scope,observedAt:d.fetchedAt,sourceTime:d.sourceTime,sourceUrl:'https://api.hyperliquid.xyz/info',status:'complete',
    ...(d.accountValue!=null?{equity:{value:d.accountValue,currency:'USDC'}}:{}),positions:d.positions.map(p=>({key:p.coin+':'+p.side,symbol:p.coin,side:p.side,quantity:p.quantity,quantityUnit:p.coin,
      entryPrice:p.entryPrice,unrealizedPnl:p.unrealizedPnl,marginUsed:p.marginUsed,leverage:p.leverage.value,notional:p.positionValue,currency:'USDC'}))};
}
async function hiddenFromProfile(root,accountId,profile){
  if(profile.positionShow!==false)return null;
  const sourceUrl='https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId='+accountId;
  if(profile.sourceUrl!==sourceUrl)throw Error('invalid_binance_visibility_source');
  const bytes=await fs.readFile(path.join(root,profile.evidencePath)),evidence=JSON.parse(bytes);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==profile.evidenceSha256||evidence.code!=='000000'||evidence.success!==true||evidence.data?.positionShow!==false||String(evidence.data.leadPortfolioId)!==accountId)throw Error('invalid_binance_visibility_evidence');
  return {exchange:'Binance',accountId,scope:'public_lead_futures',sourceUrl,evidenceSha256:profile.evidenceSha256,observedAt:profile.fetchedAt,status:'hidden',positions:[]};
}
async function main(args=process.argv.slice(2)){
  const root=path.resolve(args[1]||path.join(__dirname,'../trader'));let values=[];
  if(args[0]==='--stdin'){
    const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>128*1024*1024)throw Error('position_archive_batch_too_large');chunks.push(chunk);}
    values=JSON.parse(Buffer.concat(chunks));
  }else if(args[0]==='--bundled'){
    const {snapshotsFromOKX,snapshotsFromBitget}=require('./observe_exchange_positions.cjs');
    values=[...snapshotsFromBinance(await json(path.join(root,'binance/portfolios.json'))),...snapshotsFromOKX(await json(path.join(root,'okx/trades.json'))),...snapshotsFromBitget(await json(path.join(root,'bitget/period-returns.json'))),snapshotFromFocus(await json(path.join(root,'public-focus.json')))];
    const {parsePeriodReturns}=require('../trader/binance-data.js');const raw=await json(path.join(root,'binance/period-returns.json')),returns=parsePeriodReturns(raw);
    for(const row of returns.accounts)if(row.positionShow===false){
      const original=raw.accounts.find(a=>a.portfolioId===row.portfolioId);
      values.push(await hiddenFromProfile(root,row.portfolioId,{positionShow:false,sourceUrl:row.profileSourceUrl,evidencePath:row.profileEvidencePath,evidenceSha256:row.profileEvidenceSha256,fetchedAt:original.profileFetchedAt}));
    }
    const historyText=await fs.readFile(path.join(root,'aoying-history.js'),'utf8'),prefix='globalThis.BooksAoyingHistory=';
    if(!historyText.includes(prefix))throw Error('invalid_reference_profile_file');
    const reference=JSON.parse(historyText.split(prefix)[1].trim().replace(/;$/,''));
    if(reference.portfolioId!=='5075281354358777856'||reference.profile.evidencePath!=='binance/evidence/aoying-analysis-current/profile.json')throw Error('invalid_reference_profile_file');
    const hidden=await hiddenFromProfile(root,reference.portfolioId,reference.profile);if(hidden)values.push(hidden);
  }else throw Error('usage: archive_positions.cjs --bundled|--stdin [traderRoot]');
  const result=await persistSnapshots(root,values);console.log(JSON.stringify(result));
}
module.exports={snapshotsFromBinance,snapshotFromFocus,main};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
