/* Public read-only sources for paper decisions. No credentials or exchange actions. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksPaperData=api;})(globalThis,function(){
'use strict';
const INFO='https://api.hyperliquid.xyz/info',ID='5075281354358777856';
function supported(r){return r?.exchange==='Binance'&&r.accountId===ID||r?.exchange==='Hyperliquid'&&/^0x[0-9a-f]{40}$/.test(r.accountId);}
function normalize(events){const out=[];for(const e of events){
 const coin=e.quote==='USDT'&&e.symbol.endsWith('USDT')?e.symbol.slice(0,-4):e.quote==='USDC'?e.symbol:null;
 const common={id:e.id,identity:e.identity||e.id,symbol:e.symbol,coin:coin||'',positionSide:e.positionSide,effect:['open','increase'].includes(e.effect)?'increase':'decrease',quantity:Number(e.quantity),time:e.time,firstSeenAt:typeof e.firstSeenAt==='number'?e.firstSeenAt:Date.parse(e.firstSeenAt),ambiguous:e.ambiguous||e.effect==='unknown',sourceEquityVerified:false,sourceEquity:null,sourceBefore:e.startPosition===undefined?null:Number(e.startPosition),sourceAfter:e.endPosition===undefined?null:Number(e.endPosition),fullPositionVerified:e.startPosition!==undefined&&e.endPosition!==undefined};
 if(e.effect==='reverse'){
  const before=Number(e.startPosition),after=Number(e.endPosition);out.push({...common,id:e.id+':close',identity:common.identity+':close',effect:'decrease',quantity:Math.abs(before),sourceAfter:0});
  out.push({...common,id:e.id+':open',identity:common.identity+':open',effect:'increase',positionSide:after>0?'long':'short',quantity:Math.abs(after),sourceBefore:0,sourceAfter:after});
 }else out.push(common);
 }return out;}
function create(env,options={}){
 const M=env.BooksTradeReplayModel,D=env.BooksTradeReplayData.create(env),reader=env.BooksBinancePublicRecords.reader(env);let metadata=null,metadataAt=0,marketStop=null;const books=new Map(),pending=new Map();
 async function request(body){
  let reason=env.BooksSourcePolicy?.reason()||(!env.BooksSourcePolicy?'snapshot_unverified':null),until=Date.now()+8000;
  while(reason==='snapshot_unverified'&&Date.now()<until){await new Promise(r=>setTimeout(r,100));reason=env.BooksSourcePolicy?.reason()||(!env.BooksSourcePolicy?'snapshot_unverified':null);}
  if(reason)throw Error(reason);if(!['meta','l2Book'].includes(body.type))throw Error('read_only_request_required');
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),10000);
  try{const r=await env.fetch(INFO,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'},credentials:'omit',redirect:'error',signal:control.signal});if([403,429].includes(r.status)){env.BooksSourcePolicy.stop('http_'+r.status);throw Error('http_'+r.status);}if(!r.ok)throw Error('market_http_'+r.status);const chunks=[],stream=r.body.getReader();let size=0;while(true){const x=await stream.read();if(x.done)break;size+=x.value.byteLength;if(size>2000000){await stream.cancel();throw Error('market_too_large');}chunks.push(x.value);}return JSON.parse(await new Blob(chunks).text());}finally{clearTimeout(timer);}
 }
 async function feed(r){
  if(!supported(r))throw Error('source_not_supported');
  if(r.exchange==='Binance'){const x=await reader.read(),versions=new Map(x.allRows.map(y=>[y.id,y.versionFirstSeenAt]));return {checkedAt:Date.parse(x.checkedAt),stopped:x.stopped,reason:x.stopReason||null,events:normalize(M.binanceEvents(x.allRows).map(e=>({...e,firstSeenAt:versions.get(e.id)||e.firstSeenAt}))),source:'本站 Python 公开操作检查点',precision:'币安聚合记录更新时间',currentPositionKnown:false};}
  const x=await D.fills(r.accountId);return {checkedAt:x.fetchedAt,stopped:false,events:normalize(M.hyperliquidEvents(x.rows)),source:'Hyperliquid 官方 userFills',precision:'来源逐笔成交时间',currentPositionKnown:true};
 }
 async function meta(){
  if(metadata&&Date.now()-metadataAt<600000)return metadata;if(pending.has('meta'))return pending.get('meta');
  const task=(async()=>{const raw=await request({type:'meta'});if(!Array.isArray(raw?.universe)||raw.universe.length>2000)throw Error('market_meta_schema');const map=new Map();for(const a of raw.universe)if(typeof a.name==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(a.name)&&!a.isDelisted&&Number.isInteger(a.szDecimals)&&a.szDecimals>=0&&a.szDecimals<=8&&Number.isInteger(a.maxLeverage)&&a.maxLeverage>0)map.set(a.name,{coin:a.name,szDecimals:a.szDecimals,maxLeverage:a.maxLeverage,minNotional:10});metadata=map;metadataAt=Date.now();return map;})();pending.set('meta',task);try{return await task;}finally{pending.delete('meta');}
 }
 async function market(coin){
  if(options.venue&&options.venue!=='Hyperliquid'){if(marketStop)throw Error(marketStop);if(!['Binance','Bitget'].includes(options.venue)||!/^\w{1,30}$/.test(coin))throw Error('unsupported_market');const reason=env.BooksSourcePolicy?.reason();if(reason)throw Error(reason);const r=await env.fetch('/api/paper-market?venue='+options.venue+'&coin='+encodeURIComponent(coin),{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});const value=await r.json();if(!r.ok){if(value.error==='source_stopped'){marketStop='source_stopped';}throw Error(value.error||'market_unavailable');}return value;}

  if(!/^[A-Za-z0-9_-]{1,40}$/.test(coin))throw Error('unsupported_market');const map=await meta(),asset=map.get(coin);if(!asset)throw Error('unsupported_market');
  const old=books.get(coin);if(old&&Date.now()-old.receivedAt<1500)return old;if(pending.has(coin))return pending.get(coin);
  const task=(async()=>{const raw=await request({type:'l2Book',coin});if(raw?.coin!==coin||!Number.isSafeInteger(raw.time)||!Array.isArray(raw.levels)||raw.levels.length!==2)throw Error('book_schema');const parse=(xs,buy)=>{if(!Array.isArray(xs)||!xs.length||xs.length>100)throw Error('book_schema');let previous=buy?Infinity:0;return xs.map(x=>{const px=Number(x.px),sz=Number(x.sz);if(!(px>0&&sz>0&&Number.isFinite(px)&&Number.isFinite(sz))||(buy?px>previous:px<previous))throw Error('book_schema');previous=px;return [px,sz];});};const next={...asset,bids:parse(raw.levels[0],true),asks:parse(raw.levels[1],false),time:raw.time,receivedAt:Date.now(),source:'Hyperliquid l2Book · USDC'};books.set(coin,next);return next;})();pending.set(coin,task);try{return await task;}finally{pending.delete(coin);}
 }
 return {feed,market,blocker:()=>marketStop||env.BooksSourcePolicy?.reason()||null};
}
return {ID,supported,normalize,create};
});
