/* Durable public position observations; no account credentials or exchange actions. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksPositionObservations=api;})(globalThis,function(env){
'use strict';
const ids = {Binance:/^\d{19}$/, Bitget:/^\d{15,23}$/, OKX:/^[A-Za-z0-9]{16}(?:[A-Za-z0-9]{2})?$/, Hyperliquid:/^0x[a-f0-9]{40}$/};
const statuses = new Set(['complete','partial','hidden','unavailable','stale']);
function requireValue(valid, message){if(!valid)throw Error('position_history_'+message);}
function label(v,max=180){requireValue(typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v),'invalid_label');return v;}
function stamp(v){requireValue(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)&&Number.isFinite(Date.parse(v)),'invalid_time');return new Date(v).toISOString();}
function decimal(v,signed=true){if(v===null||v===undefined)return null;const s=String(v);requireValue((typeof v==='number'||typeof v==='string')&&s.length<=85&&/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s)&&Number.isFinite(Number(s))&&Math.abs(Number(s.toLowerCase().split('e')[1]||0))<=100&&(signed||Number(s)>=0),'invalid_decimal');return s;}
function magnitude(s){const [coefficient,exponent='0']=s.toLowerCase().split('e'),[whole,fraction='']=coefficient.split('.');return [BigInt(whole+fraction),fraction.length-Number(exponent)];}
function compare(a,b){const [x,scaleX]=magnitude(a),[y,scaleY]=magnitude(b),scale=Math.max(scaleX,scaleY);const diff=x*10n**BigInt(scale-scaleX)-y*10n**BigInt(scale-scaleY);return diff>0n?1:diff<0n?-1:0;}
function clean(s){
  requireValue(Object.hasOwn(ids,s.exchange)&&ids[s.exchange].test(s.accountId)&&typeof s.accountId==='string','account');
  const observedAt=stamp(s.observedAt);requireValue(statuses.has(s.status)&&Array.isArray(s.positions)&&s.positions.length<=3000,'snapshot');
  requireValue(['complete','partial'].includes(s.status)||!s.positions.length,'incomplete_rows');
  const url=new URL(s.sourceUrl);requireValue((url.protocol==='https:'||s.exchange==='Hyperliquid'&&url.href==='wss://api.hyperliquid.xyz/ws')&&!url.username&&!url.password&&url.href.length<=650,'source');
  const allowed={Hyperliquid:['api.hyperliquid.xyz','app.hyperliquid.xyz'],Binance:['www.binance.com'],OKX:['www.okx.com'],Bitget:['www.bitget.com','api.bitget.com']};
  requireValue(allowed[s.exchange].includes(url.hostname),'source_host');
  const seen=new Set();const positions=s.positions.map(p=>{
    const key=label(p.key),symbol=label(p.symbol,100);requireValue(!seen.has(key)&&['long','short','net'].includes(p.side),'position');seen.add(key);
    const out={key,symbol,side:p.side,quantity:decimal(p.quantity,false),quantityUnit:p.quantityUnit?label(p.quantityUnit,60):null};
    if(out.quantity!==null)requireValue(compare(out.quantity,'0')>0,'zero_position');
    for(const k of ['entryPrice','markPrice','unrealizedPnl','notional','marginUsed','leverage'])out[k]=decimal(p[k],k==='unrealizedPnl');
    out.currency=p.currency?label(p.currency,20):null;if(p.sourcePositionId)out.sourcePositionId=label(p.sourcePositionId);
    if(p.sourceOpenedAt)out.sourceOpenedAt=stamp(p.sourceOpenedAt);
    return out;
  }).sort((a,b)=>a.key.localeCompare(b.key));
  const value={exchange:s.exchange,accountId:s.accountId,scope:label(s.scope),observedAt,status:s.status,sourceUrl:url.href,positions};
  if(s.sourceTime)value.sourceTime=stamp(s.sourceTime);
  if(s.evidenceSha256){requireValue(/^[a-f0-9]{64}$/.test(s.evidenceSha256),'evidence');value.evidenceSha256=s.evidenceSha256;}
  if(s.equity&&s.equity.value!=null)value.equity={value:decimal(s.equity.value),currency:label(s.equity.currency,20)};
  if(s.errorCode)value.errorCode=label(s.errorCode,100);
  return value;
}
function advance(open,s){
  const events=[],seen=new Set();
  const emit=(type,row,prior)=>events.push({type,key:row.key,symbol:row.symbol,side:row.side,scope:s.scope,firstSeenAt:prior?.firstSeenAt||s.observedAt,from:prior?.lastSeenAt||null,to:s.observedAt,beforeQuantity:prior?.quantity??null,afterQuantity:type==='no_longer_seen'?null:row.quantity,quantityUnit:row.quantityUnit});
  for(const p of s.positions){
    const id=JSON.stringify([s.scope,p.key]),prior=open.get(id);seen.add(id);
    if(!prior)emit('first_seen',p,null);
    else if(s.status==='complete'&&prior.lastCompleteQuantity!=null&&p.quantity!==null&&p.quantityUnit===prior.lastCompleteUnit){
      const difference=compare(p.quantity,prior.lastCompleteQuantity);
      if(difference)emit(difference>0?'increased':'decreased',p,{...prior,lastSeenAt:prior.lastCompleteAt,quantity:prior.lastCompleteQuantity});
    }
    open.set(id,{...p,scope:s.scope,firstSeenAt:prior?.firstSeenAt||s.observedAt,lastSeenAt:s.observedAt,
      lastCompleteQuantity:s.status==='complete'?p.quantity:prior?.lastCompleteQuantity??null,
      lastCompleteAt:s.status==='complete'?s.observedAt:prior?.lastCompleteAt??null,
      lastCompleteUnit:s.status==='complete'?p.quantityUnit:prior?.lastCompleteUnit??null});
  }
  if(s.status==='complete')for(const [id,prior] of open){if(prior.scope===s.scope&&!seen.has(id)){emit('no_longer_seen',prior,prior);open.delete(id);}}
  return events;
}
function fromLive(accountId,part,transport){
  requireValue(transport==='rest'||transport==='websocket','transport');
  const {sourceTime,fetchedAt,rows}=part;
  requireValue(Number.isSafeInteger(sourceTime)&&Number.isSafeInteger(fetchedAt)&&sourceTime>=fetchedAt-120000&&sourceTime<=fetchedAt+5000,'stale_source');
  const sourceUrl=transport==='websocket'?'wss://api.hyperliquid.xyz/ws':'https://api.hyperliquid.xyz/info';
  const positions=rows.map(p=>({key:p.coin+':'+p.side,symbol:p.coin,side:p.side,quantity:p.quantity,quantityUnit:p.coin,
    entryPrice:p.entryPrice,notional:p.positionValue,markPrice:p.markPrice??(p.quantity>0?p.positionValue/p.quantity:null),unrealizedPnl:p.unrealizedPnl,
    marginUsed:p.marginUsed,leverage:p.leverage?.value,currency:'USDC'}));
  const snapshot=clean({exchange:'Hyperliquid',accountId,scope:'default_perp_dex',status:'complete',observedAt:new Date(fetchedAt).toISOString(),sourceTime:new Date(sourceTime).toISOString(),sourceUrl,
    equity:part.accountValue!=null?{value:part.accountValue,currency:'USDC'}:null,positions});
  return {...snapshot,transport};
}
function createLocal(environment){
  let connection=null;const errors=new Map();
  function open(){
    if(!connection)connection=new Promise((resolve,reject)=>{
      if(!environment.indexedDB){reject(Error('IndexedDBUnavailable'));return;}
      const request=environment.indexedDB.open('books.public-position-observations.v1',1);
      request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('samples',{keyPath:['accountId','time']});db.createObjectStore('heads',{keyPath:'accountId'});};
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
      request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('IndexedDBBlocked'));
    }).catch(e=>{connection=null;throw e;});return connection;
  }
  function notice(accountId,error){if(error)errors.set(accountId,error);else errors.delete(accountId);if(typeof environment.CustomEvent==='function')environment.dispatchEvent?.(new environment.CustomEvent('books-position-observation',{detail:{accountId,error}}));}
  function range(accountId,month=''){return environment.IDBKeyRange.bound([accountId,month],[accountId,month+'\uffff']);}
  function validAddress(id){requireValue(typeof id==='string'&&ids.Hyperliquid.test(id),'account');}
  const req=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  function initial(accountId){return {schemaVersion:1,exchange:'Hyperliquid',accountId,origin:'browser',months:[],open:[],counts:{snapshots:0,events:0},latest:null};}
  function next(head,s){
    const open=new Map(head.open.map(p=>[JSON.stringify([p.scope,p.key]),p]));
    // Sort by the source-provided clock (REST and websocket may arrive out of order).
    // Each observation retains both the source clock and the actual local read time.
    const events=advance(open,{...s,observedAt:s.sourceTime}).map(e=>({...e,timeBasis:'sourceTime'}));
    const month=s.sourceTime.slice(0,7);if(!head.months.includes(month))head.months.push(month);
    head.open=[...open.values()];head.latest={scope:s.scope,status:s.status,observedAt:s.observedAt,sourceTime:s.sourceTime};head.counts.snapshots++;head.counts.events+=events.length;return events;
  }
  async function save(snapshot){
    const db=await open(),{accountId,sourceTime}=snapshot;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['samples','heads'],'readwrite'),samples=tx.objectStore('samples'),heads=tx.objectStore('heads');let changed=false;
      tx.oncomplete=()=>resolve(changed);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('observation_write_aborted'));
      const existing=samples.get([accountId,sourceTime]);existing.onsuccess=()=>{
        if(existing.result){
          const saved=existing.result,prior=saved.snapshot;
          if(JSON.stringify(prior.positions)===JSON.stringify(snapshot.positions)&&JSON.stringify(prior.equity)===JSON.stringify(snapshot.equity))return;
          // Retain distinct reports at the same official clock without inventing
          // their execution order. The first snapshot remains the timeline base.
          const alternate=saved.alternateReports||[];
          if(!alternate.some(p=>JSON.stringify(p.positions)===JSON.stringify(snapshot.positions)&&JSON.stringify(p.equity)===JSON.stringify(snapshot.equity))){
            samples.put({...saved,alternateReports:[...alternate,snapshot]});changed=true;
          }
          return;
        }
        const pending=heads.get(accountId);pending.onsuccess=()=>{
          const head=pending.result||initial(accountId);
          if(!head.latest||sourceTime>head.latest.sourceTime){
            const events=next(head,snapshot);samples.add({accountId,time:sourceTime,snapshot,events});heads.put(head);changed=events.length>0||head.counts.snapshots===1;return;
          }
          // A delayed source sample must be retained without manufacturing a
          // backwards position change. Rebuild only on out-of-order arrival.
          samples.add({accountId,time:sourceTime,snapshot,events:[]});const rebuilt=initial(accountId),cursor=samples.openCursor(range(accountId));
          cursor.onsuccess=()=>{const hit=cursor.result;if(!hit){heads.put(rebuilt);changed=true;return;}const row=hit.value,events=next(rebuilt,row.snapshot);if(JSON.stringify(events)!==JSON.stringify(row.events))hit.update({...row,events});hit.continue();};
        };
      };
    });
  }
  async function record(accountId,part,transport){
    let snapshot;try{snapshot=fromLive(accountId,part,transport);}catch{return false;}
    try{const changed=await save(snapshot);if(changed||errors.has(accountId))notice(accountId,null);return true;}
    catch(e){const why=e?.name==='QuotaExceededError'?'quota_exceeded':'storage_unavailable';if(errors.get(accountId)!==why)notice(accountId,why);return false;}
  }
  async function index(accountId){validAddress(accountId);const db=await open();return await req(db.transaction('heads').objectStore('heads').get(accountId))||null;}
  async function month(accountId,month){validAddress(accountId);requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month),'month');const db=await open();const rows=await req(db.transaction('samples').objectStore('samples').getAll(range(accountId,month)));return rows.length?{schemaVersion:1,origin:'browser',exchange:'Hyperliquid',accountId,month,snapshots:rows.map(r=>r.alternateReports?{...r.snapshot,alternateReports:r.alternateReports}:r.snapshot),events:rows.flatMap(r=>r.events)}:null;}
  async function close(){if(connection){const db=await connection;db.close();connection=null;}}
  return {record,index,month,close,error:accountId=>errors.get(accountId)||null};
}
return {clean,advance,fromLive,createLocal,local:createLocal(env)};
});
