/* Read the observer's public checkpoint, never an exchange account endpoint. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksBinancePublicRecords=api;})(globalThis,function(){
'use strict';
const ID='5075281354358777856',URL='https://raw.githubusercontent.com/sking-3/xuanliu-site/binance-public-orders-state/monitor-state/'+ID+'.json';
const fail=()=>{throw Error('PUBLIC_EXECUTION_SCHEMA');};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const stamp=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(x)&&Number.isFinite(Date.parse(x));
const decimal=x=>typeof x==='string'&&x.length<=100&&/^-?\d+(?:\.\d+)?$/.test(x)&&Number.isFinite(Number(x));
const directions={opening_or_increasing_long:'开多/加多方向',opening_or_increasing_short:'开空/加空方向',reducing_or_closing_long:'减多/平多方向',reducing_or_closing_short:'减空/平空方向',one_way_direction_unresolved:'单向仓位，开平未知'};
function parse(value,now=Date.now()){
 if(!plain(value)||value.schemaVersion!==1||value.portfolioId!==ID||value.scope!=='public_execution_records_only'||value.hiddenPositionsRequested!==false||typeof value.stopped!=='boolean'||!plain(value.records)||Object.keys(value.records).length>500||!(value.lastSuccessAt===null||stamp(value.lastSuccessAt)&&Date.parse(value.lastSuccessAt)<=now+300000))fail();
 const rows=[];
 for(const [key,r]of Object.entries(value.records)){
  if(!plain(r)||!/^[a-f0-9]{64}$/.test(key)||r.fingerprint!==key||!/^[a-f0-9]{64}$/.test(r.identity)||r.sourceOrderId!==null||!stamp(r.firstSeenAt)||!Number.isSafeInteger(r.orderTime)||!Number.isSafeInteger(r.orderUpdateTime)||r.orderTime<=0||r.orderUpdateTime<r.orderTime||r.orderUpdateTime>now+300000||!Object.hasOwn(directions,r.direction))fail();
  if(!['symbol','baseAsset','quoteAsset'].every(k=>typeof r[k]==='string'&&/^[A-Z0-9_]{1,50}$/.test(r[k]))||!['executedQty','avgPrice','totalPnl'].every(k=>decimal(r[k]))||Number(r.executedQty)<0||Number(r.avgPrice)<0)fail();
  if(Date.parse(r.firstSeenAt)>now+300000||r.versionFirstSeenAt!==undefined&&(!stamp(r.versionFirstSeenAt)||Date.parse(r.versionFirstSeenAt)>now+300000))fail();
  const row={id:key,identity:r.identity,sourceDirection:r.direction,symbol:r.symbol,baseAsset:r.baseAsset,quoteAsset:r.quoteAsset,quantity:r.executedQty,price:r.avgPrice,sourcePnl:r.totalPnl,createdAt:r.orderTime,updatedAt:r.orderUpdateTime,firstSeenAt:r.firstSeenAt,versionFirstSeenAt:r.versionFirstSeenAt||r.firstSeenAt,direction:directions[r.direction]};
  // Equal source creation times do not establish a common order identity.
  rows.push(row);
 }
 if(value.lastSuccessAt===null&&rows.length)fail();
 rows.sort((a,b)=>b.updatedAt-a.updatedAt||Date.parse(b.versionFirstSeenAt)-Date.parse(a.versionFirstSeenAt));
 return {checkedAt:value.lastSuccessAt,stopped:value.stopped,stopReason:typeof value.errorCode==='string'&&/^[a-zA-Z0-9_]{1,80}$/.test(value.errorCode)?value.errorCode:null,rows:rows.slice(0,20),allRows:rows,retainedRecords:rows.length};
}
function reader(env){
 let last=null,loadedAt=0,pending=null,stopped=null;
 const key='books.binance-public-record-reader-stop.v1';
 const cacheKey='books.binance-public-record-cache.v1';
 function hydrate(value){try{const next=parse(value);if(!last||Date.parse(next.checkedAt)>Date.parse(last.checkedAt))last=next;}catch{}}
 if(env.BooksPublicRecordSeed)hydrate(env.BooksPublicRecordSeed);
 try{const raw=env.localStorage.getItem(cacheKey);if(raw&&raw.length<=900000)hydrate(JSON.parse(raw));}catch{}
 function reason(){try{return stopped||env.localStorage.getItem(key);}catch{return 'storage_unavailable';}}
 async function read(){
  if(reason())throw Error(reason());
  if(last&&Date.now()-loadedAt<60000)return last;
  if(pending)return pending;
  pending=(async()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
   try{
    // Share one CDN key per minute while avoiding a five-minute-old raw-file cache.
    // A persisted refusal is checked before creating any request, including this key.
    const response=await env.fetch(URL+'?minute='+Math.floor(Date.now()/60000),{signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
    if(response.status===403||response.status===429){stopped='http_'+response.status;try{env.localStorage.setItem(key,stopped);}catch{}throw Error(stopped);}
    if(!response.ok)throw Error('checkpoint_read_failed');
    const stream=response.body.getReader(),chunks=[];let size=0;
    while(true){const {done,value}=await stream.read();if(done)break;size+=value.byteLength;if(size>900000){await stream.cancel();throw Error('checkpoint_too_large');}chunks.push(value);}
    const raw=JSON.parse(await new Blob(chunks).text()),next=parse(raw);
    if(!last||Date.parse(next.checkedAt)>=Date.parse(last.checkedAt)){last=next;try{env.localStorage.setItem(cacheKey,JSON.stringify({schemaVersion:1,portfolioId:ID,scope:'public_execution_records_only',hiddenPositionsRequested:false,stopped:raw.stopped,errorCode:raw.errorCode||null,lastSuccessAt:raw.lastSuccessAt,records:raw.records}));}catch{}}
    loadedAt=Date.now();return last;
   }finally{clearTimeout(timer);pending=null;}
  })();return pending;
 }
 return {read,last:()=>last,reason};
}
return {ID,URL,parse,reader};
});
