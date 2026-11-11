(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksTradeReplayData=api;})(globalThis,function(){
'use strict';
const INFO='https://api.hyperliquid.xyz/info',KLINE='https://fapi.binance.com/fapi/v1/klines';
function create(env){
 const memory=new Map(),pending=new Map();let localMarketStop=null;
 const cacheKey='books.trade-replay.history.v1',stopKey='books.trade-replay.binance-kline-stop.v1';
 const stored=()=>{try{const s=env.localStorage.getItem(cacheKey);return s&&s.length<2500000?JSON.parse(s):{};}catch{return {};}};
 const histories=stored();
 function cached(address){const x=histories[address];return x&&Number.isSafeInteger(x.fetchedAt)&&x.fetchedAt<=Date.now()+300000&&Array.isArray(x.rows)&&x.rows.length<=2000?x:null;}
 function blocker(kind){if(kind==='hyperliquid')return env.BooksSourcePolicy?.reason()||(!env.BooksSourcePolicy?'snapshot_unverified':null);try{return localMarketStop||env.localStorage.getItem(stopKey);}catch{return 'storage_unavailable';}}
 async function request(url,options,kind){
  // A deep link can open before the three same-origin safety files finish.
  // Only wait on that local verification; no exchange request precedes it.
  let reason=blocker(kind);const until=Date.now()+8000;
  while(reason==='snapshot_unverified'&&Date.now()<until){await new Promise(resolve=>setTimeout(resolve,100));reason=blocker(kind);}
  if(reason)throw Error(reason);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const res=await env.fetch(url,{...options,signal:controller.signal,credentials:'omit',redirect:'error'});
   if([403,429].includes(res.status)){const code='http_'+res.status;if(kind==='hyperliquid')env.BooksSourcePolicy?.stop(code);else{localMarketStop=code;try{env.localStorage.setItem(stopKey,code);}catch{}}throw Error(code);}
   if(!res.ok)throw Error('source_http_'+res.status);
   const chunks=[],reader=res.body.getReader();let size=0;
   while(true){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>2500000){await reader.cancel();throw Error('source_too_large');}chunks.push(x.value);}
   return JSON.parse(await new Blob(chunks).text());
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
 async function candles(exchange,symbol,interval,start,end){
  const seconds=({'15m':900,'1h':3600,'4h':14400,'1d':86400})[interval];
  if(!seconds||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||end-start>seconds*1000*1490||!/^[A-Za-z0-9._:\-]{1,60}$/.test(symbol))throw Error('invalid_kline_window');
  const kind=exchange==='Binance'?'binance':'hyperliquid',key=[kind,symbol,interval,start,end].join('|');
  if(memory.has(key))return memory.get(key);if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   const raw=kind==='binance'?await request(KLINE+'?'+new URLSearchParams({symbol,interval,startTime:start,endTime:end,limit:1500}),{},kind):await request(INFO,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin:symbol,interval,startTime:start,endTime:end}})},kind);
   const bars=env.BooksTradeReplayModel.candles(raw,kind),value={bars,fetchedAt:Date.now(),interval,source:kind==='binance'?'Binance USDⓈ-M 合约':'Hyperliquid 永续',symbol};
   if(memory.size>=12)memory.delete(memory.keys().next().value);memory.set(key,value);return value;
  })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 }
 return {cached,fills,candles,blocker};
}
return {create};
});
