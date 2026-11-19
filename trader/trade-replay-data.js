(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksTradeReplayData=api;})(globalThis,function(){
'use strict';
const INFO='https://api.hyperliquid.xyz/info',KLINE='https://fapi.binance.com/fapi/v1/klines';
const FILLS_ARCHIVE='https://raw.githubusercontent.com/sking-3/xuanliu-site/main/trader/hyperliquid-fills.json';
const ARCHIVE_BYTES=4*1024*1024,ARCHIVE_REFRESH_MS=5*60*1000;
const intervalSeconds={'15m':900,'1h':3600,'4h':14400,'1d':86400};
const marketSources={binance:'Binance USDⓈ-M 合约',hyperliquid:'Hyperliquid 永续',okx:'OKX 永续合约',bitget:'Bitget 永续合约'};
const currentEndpoints={okx:'https://www.okx.com/api/v5/market/candles',bitget:'https://api.bitget.com/api/v2/mix/market/candles'};
const barNames={'15m':'15m','1h':'1H','4h':'4H','1d':'1Dutc'};
const addressPattern=/^0x[0-9a-f]{40}$/;
const shape=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const timeInBounds=(value,upper)=>Number.isSafeInteger(value)&&value>0&&value<=upper;
function isoTime(value,upper){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value))throw Error('archive_timestamp');
 const time=Date.parse(value);
 if(!timeInBounds(time,upper)||new Date(time).toISOString().slice(0,19)!==value.slice(0,19))throw Error('archive_timestamp');
 return time;
}
const decimal=x=>typeof x==='string'&&x.length<=40&&/^-?\d+(?:\.\d+)?$/.test(x);
const boundedText=x=>typeof x==='string'&&x.length>0&&x.length<=64&&!/[\u0000-\u001f\u007f]/.test(x);
const safeId=x=>Number.isSafeInteger(x)&&x>=0;
function archiveRows(rows,coveredThrough){
 if(!Array.isArray(rows)||rows.length>50||(!coveredThrough&&rows.length))throw Error('archive_rows');
 const seen=new Set();
 return rows.map((row,index)=>{
  if(!shape(row)||!boundedText(row.coin)||!timeInBounds(row.time,coveredThrough)||(index&&rows[index-1].time<row.time)||
   !['A','B'].includes(row.side)||!decimal(row.px)||Number(row.px)<0||!decimal(row.sz)||Number(row.sz)<0||
   !safeId(row.tid)||!safeId(row.oid)||typeof row.hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(row.hash))throw Error('archive_row');
  const key=JSON.stringify([row.coin,row.time,row.tid,row.oid,row.side]);
  if(seen.has(key))throw Error('archive_trade_id');
  seen.add(key);
  for(const k of ['startPosition','fee','closedPnl'])if(row[k]!=null&&!decimal(row[k]))throw Error('archive_row');
  for(const k of ['dir','feeToken'])if(row[k]!=null&&!boundedText(row[k]))throw Error('archive_row');
  if(row.crossed!=null&&typeof row.crossed!=='boolean')throw Error('archive_row');
  const {coin,time,tid,oid,side,px,sz,hash,startPosition,dir,fee,feeToken,closedPnl,crossed}=row;
  return {coin,time,tid,oid,side,px,sz,hash,startPosition,dir,fee,feeToken,closedPnl,crossed};
 });
}
function archiveAccount(account,upper){
 if(!shape(account))throw Error('archive_account');
 const {coveredThrough,gap,errorCode}=account,checkedAt=account.checkedAt===null?null:isoTime(account.checkedAt,upper);
 const fetchedAt=account.lastSuccessAt===null?null:isoTime(account.lastSuccessAt,checkedAt??0);
 if(fetchedAt===null?coveredThrough!==null:!timeInBounds(coveredThrough,fetchedAt))throw Error('archive_coverage');
 if(gap!==null&&(!shape(gap)||!timeInBounds(gap.from,upper)||!timeInBounds(gap.to,upper)||
  gap.from>gap.to||!['lookback_limit','response_cap'].includes(gap.reason)))throw Error('archive_gap');
 if(errorCode!==null&&(typeof errorCode!=='string'||!/^[a-z0-9_]{1,64}$/.test(errorCode)))throw Error('archive_error');
 const rows=archiveRows(account.rows,coveredThrough);
 return {checkedAt,fetchedAt,coveredThrough,gap:gap&&{from:gap.from,to:gap.to},errorCode,rows,receivedCount:rows.length,archiveKind:'published'};
}
function archiveDocument(doc,now){
 const source=doc?.source,accounts=doc?.accounts;
 if(!shape(doc)||doc.schemaVersion!==1||!shape(source)||source.id!=='hyperliquid'||source.endpoint!==INFO||source.intervalMinutes!==30||
  !['ready','partial','stopped'].includes(source.status)||![null,'http_403','http_429'].includes(source.stopCode)||
  (source.status==='stopped')!==Boolean(source.stopCode)||!shape(accounts))throw Error('archive_schema');
 const checkedAt=isoTime(source.checkedAt,now+300000);
 isoTime(source.startedAt,checkedAt);
 const ids=Object.keys(accounts);
 if(ids.length>200||ids.some(id=>!addressPattern.test(id)))throw Error('archive_wallets');
 // Validate all account checkpoints before promoting a newly published archive.
 const snapshots=new Map(ids.map(id=>[id,archiveAccount(accounts[id],checkedAt)]));
 return {source:{checkedAt,status:source.status,stopCode:source.stopCode},snapshots};
}
async function readArchive(response){
 if(!response.ok||!response.body||Number(response.headers.get('content-length'))>ARCHIVE_BYTES){
  response.body?.cancel().catch(()=>{});
  throw Error('archive_response');
 }
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),chunks=[];
 let size=0,done=false;
 try{
  while(!done){
   const part=await reader.read();done=part.done;
   if(done)break;
   size+=part.value.byteLength;
   if(size>ARCHIVE_BYTES)throw Error('archive_size');
   chunks.push(decoder.decode(part.value,{stream:true}));
  }
  chunks.push(decoder.decode());
 }finally{if(!done)reader.cancel().catch(()=>{});}
 return JSON.parse(chunks.join(''));
}
function create(env){
 const memory=new Map(),pending=new Map(),marketStops=new Map();
 const cacheKey='books.trade-replay.history.v1',stopKey=kind=>'books.trade-replay.'+kind+'-kline-stop.v1';
 const stored=()=>{try{const s=env.localStorage.getItem(cacheKey);return s&&s.length<2500000?JSON.parse(s):{};}catch{return {};}};
 const histories=stored();
 function cached(address){const x=histories[address];return x&&Number.isSafeInteger(x.fetchedAt)&&x.fetchedAt<=Date.now()+300000&&Array.isArray(x.rows)&&x.rows.length<=2000?x:null;}
 let archiveSource=null,archiveAccounts=new Map(),archivePending=null,lastArchiveAttempt=-Infinity,archiveUnavailable=false,archiveBlocked=false;
 function archiveState(address){
  const account=archiveAccounts.get(address),local=cached(address);
  const canUsePublished=account?.fetchedAt&&(!local?.rows.length||account.rows.length>0);
  const history=canUsePublished&&(!local||account.fetchedAt>=local.fetchedAt)?account:local;
  return {history,account,source:archiveSource,unavailable:archiveUnavailable};
 }
 async function savedFills(address){
  if(!addressPattern.test(address))return {history:null,unavailable:true};
  if(!archiveBlocked&&!archivePending&&Date.now()-lastArchiveAttempt>=ARCHIVE_REFRESH_MS){
   lastArchiveAttempt=Date.now();
   archivePending=(async()=>{
    // A first-party published file only. Live exchange routes keep their existing source policy.
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
     const response=await env.fetch(FILLS_ARCHIVE,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
     if(response.status===403||response.status===429)archiveBlocked=true;
     const {source,snapshots}=archiveDocument(await readArchive(response),Date.now());
     if(archiveSource&&source.checkedAt<archiveSource.checkedAt)throw Error('archive_version');
     if(archiveSource?.checkedAt!==source.checkedAt||archiveSource?.status!==source.status||archiveSource?.stopCode!==source.stopCode)archiveSource=source;
     for(const [id,account]of snapshots){
      const previous=archiveAccounts.get(id);
      if(!previous)continue;
      const regress=(account.fetchedAt??0)<(previous.fetchedAt??0)||(account.checkedAt??0)<(previous.checkedAt??0)||
       (account.coveredThrough??0)<(previous.coveredThrough??0);
      if(regress||(account.checkedAt===previous.checkedAt&&account.fetchedAt===previous.fetchedAt))snapshots.set(id,previous);
     }
     archiveAccounts=snapshots;
     archiveUnavailable=false;
    }catch{archiveUnavailable=true;}
    finally{clearTimeout(timer);}
   })().finally(()=>{archivePending=null;});
  }
  if(archivePending)await archivePending;
  return archiveState(address);
 }
 function blocker(kind,market=false){
  if(kind==='hyperliquid'){
   const source=env.BooksSourcePolicy?.reason()||(!env.BooksSourcePolicy?'snapshot_unverified':null);
   if(!market||['http_403','http_429','stream_rejected'].includes(source))return source;
  }
  try{return marketStops.get(kind)||env.localStorage.getItem(stopKey(kind));}catch{return 'storage_unavailable';}
 }
 async function request(url,options,kind,market=false){
  // A deep link can open before the three same-origin safety files finish.
  // Only wait on that local verification; no exchange request precedes it.
  let reason=blocker(kind,market);const until=Date.now()+8000;
  while(reason==='snapshot_unverified'&&Date.now()<until){await new Promise(resolve=>setTimeout(resolve,100));reason=blocker(kind,market);}
  if(reason)throw Error(reason);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const res=await env.fetch(url,{...options,signal:controller.signal,credentials:'omit',redirect:'error'});
   if((market?[202,401,403,418,429,451]:[403,429]).includes(res.status)){
    const code='http_'+res.status;
    if(!market)env.BooksSourcePolicy?.stop(code);
    else{marketStops.set(kind,code);try{env.localStorage.setItem(stopKey(kind),code);}catch{}}
    throw Error(code);
   }
   if(!res.ok)throw Error('source_http_'+res.status);
   const chunks=[],reader=res.body.getReader();let size=0;
   while(true){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>2500000){await reader.cancel();throw Error('source_too_large');}chunks.push(x.value);}
   const payload=new Uint8Array(size);let offset=0;
   for(const chunk of chunks){payload.set(chunk,offset);offset+=chunk.byteLength;}
   const decoded=new TextDecoder('utf-8',{fatal:true}).decode(payload);
   return JSON.parse(decoded);
  }finally{clearTimeout(timer);}
 }
 async function fills(address,force=false){
  if(!/^0x[0-9a-f]{40}$/.test(address))throw Error('invalid_address');
  const old=cached(address);if(!force&&old&&Date.now()-old.fetchedAt<60000)return old;
  const key='fills:'+address;if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   const raw=await request(INFO,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'userFills',user:address})},'hyperliquid');
   if(!Array.isArray(raw)||raw.length>2000)throw Error('fill_schema');
   const fields=['coin','px','sz','side','time','startPosition','dir','closedPnl','hash','oid','tid','fee','feeToken'];
   const fetchedAt=Date.now(),identity=r=>JSON.stringify([r.coin,r.time,r.tid??null,r.oid??null,r.hash??null]),prior=new Map((old?.rows||[]).map(r=>[identity(r),r.firstSeenAt]));
   const rows=raw.map(r=>({...Object.fromEntries(fields.filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])),firstSeenAt:prior.get(identity(r))||fetchedAt}));
   const next={rows,fetchedAt,receivedCount:raw.length};histories[address]=next;
   // Bounded device cache, only explicitly opened public accounts.
   const entries=Object.entries(histories).sort((a,b)=>b[1].fetchedAt-a[1].fetchedAt).slice(0,8);
   try{env.localStorage.setItem(cacheKey,JSON.stringify(Object.fromEntries(entries)));}catch{}
   return next;
  })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 }
 async function candles(exchange,symbol,interval,start,end,latest=false){
  const seconds=intervalSeconds[interval];
  if(!seconds||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||end-start>seconds*1000*1490||!/^[A-Za-z0-9._:\-]{1,60}$/.test(symbol))throw Error('invalid_kline_window');
  const kind=String(exchange).toLowerCase();
  if(kind!=='binance'&&kind!=='hyperliquid')throw Error('unsupported_market');
  const key=[kind,symbol,interval,start,end].join('|');
  if(!latest&&memory.has(key))return memory.get(key);if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   const raw=kind==='binance'?await request(KLINE+'?'+new URLSearchParams({symbol,interval,startTime:start,endTime:end,limit:1500}),{},kind,true):await request(INFO,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin:symbol,interval,startTime:start,endTime:end}})},kind,true);
   const bars=env.BooksTradeReplayModel.candles(raw,kind),value={bars,fetchedAt:Date.now(),interval,source:marketSources[kind],symbol};
   if(!latest){if(memory.size>=12)memory.delete(memory.keys().next().value);memory.set(key,value);}return value;
  })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 }
 async function recentCandles(exchange,symbol,interval){
  const end=Date.now(),step=intervalSeconds[interval]*1000;
  const kind=String(exchange).toLowerCase(),endpoint=Object.hasOwn(currentEndpoints,kind)&&currentEndpoints[kind];
  if(!endpoint)return candles(exchange,symbol,interval,Math.floor(end/step)*step-119*step,end,true);
  const granularity=barNames[interval];
  if(!granularity||typeof symbol!=='string')throw Error('invalid_kline_window');
  const okx=kind==='okx';
  if(!(okx?/^[A-Z0-9]{1,24}-[A-Z0-9]{1,12}-SWAP$/:/^[A-Z0-9]{1,24}(?:USDT|PERP)$/).test(symbol))throw Error('unsupported_market');
  const args=okx?{instId:symbol,bar:granularity,limit:120}:{symbol,granularity,productType:symbol.endsWith('PERP')?'USDC-FUTURES':'USDT-FUTURES',limit:120};
  const key=['recent',kind,symbol,interval].join('|');
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   const raw=await request(endpoint+'?'+new URLSearchParams(args),{},kind,true);
   if(raw?.code!==(okx?'0':'00000')||!Array.isArray(raw.data)||raw.data.length>120)throw Error('kline_schema');
   const normalized=raw.data.map(row=>{
    if(!Array.isArray(row)||row.length<(okx?9:7)||Number(row[0])%step!==0)throw Error('kline_schema');
    return [Number(row[0]),...row.slice(1,6)];
   });
   const bars=env.BooksTradeReplayModel.candles(normalized,'binance');
   return {bars,fetchedAt:Date.now(),interval,source:marketSources[kind],symbol};
  })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 }
 return {cached,archiveState,savedFills,fills,candles,recentCandles,blocker};
}
return {create};
});
