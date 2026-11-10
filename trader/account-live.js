/* Public, foreground-only account reads. No wallet, signing, or trading calls. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksAccountLive = api;
})(globalThis, function () {
'use strict';
const INFO = 'https://api.hyperliquid.xyz/info';
const SOCKET = 'wss://api.hyperliquid.xyz/ws';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LIMIT = 200, MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['userFills', 'orderUpdates'];
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = () => { throw Error('invalid_response'); };
function object(v) { if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(); return v; }
function string(v, max = 100) { if (typeof v !== 'string' || !v.trim() || v.length > max) invalid(); return v; }
function numeric(v, nullable = false) {
  if (nullable && (v === null || v === undefined || v === '')) return null;
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v) || v.length > 80)) invalid();
  const n = Number(v); if (!Number.isFinite(n) || Math.abs(n) >= 1e20) invalid(); return n;
}
function positive(v, nullable = false) { const n = numeric(v, nullable); if (n !== null && n < 0) invalid(); return n; }
function timestamp(v, now) { if (!Number.isSafeInteger(v) || v < 0 || v > now + 300000) invalid(); return v; }
function id(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^\d{1,24}$/.test(v)) return v;
  return invalid();
}
function side(v) { if (v !== 'A' && v !== 'B') invalid(); return v === 'B' ? 'buy' : 'sell'; }
function list(v, max) { if (!Array.isArray(v) || v.length > max) invalid(); return v; }
function optionalBool(v) { if (v === undefined) return null; if (typeof v !== 'boolean') invalid(); return v; }
function positions(payload, now = Date.now()) {
  object(payload); const sourceTime = timestamp(payload.time, now);
  const rows = list(payload.assetPositions, 1000).map(item => {
    const p = object(object(item).position), signedSize = numeric(p.szi);
    const leverage = object(p.leverage);
    if (!['cross', 'isolated'].includes(leverage.type)) invalid();
    return {coin:string(p.coin, 40), signedSize, quantity:Math.abs(signedSize), side:signedSize > 0 ? 'long' : signedSize < 0 ? 'short' : 'flat',
      entryPrice:positive(p.entryPx, true), positionValue:positive(p.positionValue), unrealizedPnl:numeric(p.unrealizedPnl),
      marginUsed:positive(p.marginUsed), liquidationPrice:positive(p.liquidationPx, true),
      leverage:{type:leverage.type,value:positive(leverage.value)}};
  }).filter(r => r.signedSize !== 0);
  const seen = new Set(); for (const r of rows) { if (seen.has(r.coin)) invalid(); seen.add(r.coin); }
  return {rows,sourceTime};
}
function order(raw, now = Date.now()) {
  object(raw); const price = positive(raw.limitPx), quantity = positive(raw.sz);
  return {coin:string(raw.coin, 40), orderId:id(raw.oid), side:side(raw.side), price, quantity,
    notional:numeric(price * quantity), originalQuantity:positive(raw.origSz, true), time:timestamp(raw.timestamp, now),
    orderType:raw.orderType === undefined ? null : string(raw.orderType, 80), reduceOnly:optionalBool(raw.reduceOnly),
    isTrigger:optionalBool(raw.isTrigger), triggerPrice:positive(raw.triggerPx, true)};
}
function orders(payload, now = Date.now()) {
  const rows = list(payload, 5000).map(r => order(r, now));
  const seen = new Set(); for (const r of rows) { const k=r.coin+':'+r.orderId; if(seen.has(k))invalid();seen.add(k); }
  rows.sort((a,b)=>b.time-a.time); return rows;
}
// Source perpetual fills include the position immediately before execution.
function perpAction(raw) {
  const dir=raw.dir;
  if(!['Open Long','Open Short','Close Long','Close Short','Long > Short','Short > Long'].includes(dir))return null;
  const before=raw.startPosition, size=raw.sz;
  if(typeof before!=='string'||typeof size!=='string'||before.length>60||size.length>60||
     !/^-?\d+(?:\.\d+)?$/.test(before)||!/^\d+(?:\.\d+)?$/.test(size))return null;
  const scale=Math.max((before.split('.')[1]||'').length,(size.split('.')[1]||'').length);
  const units=s=>{const [whole,frac='']=s.split('.');return BigInt(whole+frac.padEnd(scale,'0'));};
  const prior=units(before),amount=units(size),next=prior+(raw.side==='B'?amount:-amount);
  if(!amount)return null;
  if(dir==='Open Long' && raw.side==='B' && prior>=0n)return prior===0n?'开多':'加多';
  if(dir==='Open Short' && raw.side==='A' && prior<=0n)return prior===0n?'开空':'加空';
  if(dir==='Close Long' && raw.side==='A' && prior>0n && next>=0n)return next===0n?'平多':'减多';
  if(dir==='Close Short' && raw.side==='B' && prior<0n && next<=0n)return next===0n?'平空':'减空';
  if(dir==='Long > Short' && prior>0n && next<0n)return '多转空';
  if(dir==='Short > Long' && prior<0n && next>0n)return '空转多';
  return null;
}
function fill(raw, address, now = Date.now()) {
  object(raw); const price = positive(raw.px), quantity = positive(raw.sz);
  if (!quantity) invalid();
  const r = {coin:string(raw.coin,40), side:side(raw.side), direction:string(raw.dir,80), positionAction:perpAction(raw), time:timestamp(raw.time,now),
    price,quantity,notional:numeric(price * quantity), closedPnl:numeric(raw.closedPnl), fee:numeric(raw.fee),
    feeToken:string(raw.feeToken,40), tradeId:id(raw.tid),orderId:id(raw.oid),hash:string(raw.hash,140)};
  r.key=[address.toLowerCase(),r.coin,r.time,r.tradeId,r.orderId,r.hash].join(':'); return r;
}
function fills(payload, address, now = Date.now()) { return list(payload,2000).map(r=>fill(r,address,now)); }
function updates(payload, address, now=Date.now()) {
  return list(payload,2000).map(raw=>{
    object(raw); const r={...order(raw.order,now),status:string(raw.status,80),statusTime:timestamp(raw.statusTimestamp,now)};
    r.key=[address.toLowerCase(),r.coin,r.orderId,r.status,r.statusTime].join(':'); return r;
  });
}
function merge(current, incoming, observedAt, timeKey='time') {
  const map=new Map(current.map(r=>[r.key,r]));for(const r of incoming)map.set(r.key,{...r,firstSeenAt:map.get(r.key)?.firstSeenAt??observedAt});
  return [...map.values()].sort((a,b)=>b[timeKey]-a[timeKey]||a.key.localeCompare(b.key)).slice(0,LIMIT);
}
function symbols(payload) {
  object(payload);const tokens=new Map();
  for(const t of list(payload.tokens,30000)){object(t);if(!Number.isSafeInteger(t.index)||t.index<0||tokens.has(t.index))invalid();tokens.set(t.index,string(t.name,80));}
  const result=Object.create(null),seen=new Set();
  for(const pair of list(payload.universe,20000)){
    object(pair);if(!Number.isSafeInteger(pair.index)||pair.index<0||seen.has(pair.index)||!Array.isArray(pair.tokens)||pair.tokens.length!==2)invalid();seen.add(pair.index);
    const base=tokens.get(pair.tokens[0]),quote=tokens.get(pair.tokens[1]);if(!base||!quote)invalid();
    const name=string(pair.name,100),value={base,quote,label:base+'/'+quote};result['@'+pair.index]=value;result[name]=value;
  }
  return result;
}
function section() {return {status:'idle',rows:[],fetchedAt:null,sourceTime:null,error:null};}
let activeClient=null;
function create(options={}) {
  const fetcher=options.fetch || globalThis.fetch?.bind(globalThis), WS=options.WebSocket || globalThis.WebSocket;
  const Controller=options.Controller || globalThis.AbortController, now=options.now || Date.now;
  const setTimer=options.setTimer || setTimeout, clearTimer=options.clearTimer || clearTimeout;
  const notify=options.onChange || (()=>{});
  let generation=0,active=false,visible=options.visible!==false,socket=null,refreshTimer=null,pingTimer=null,reconnectTimer=null,openTimer=null;
  const policy=options.policy || globalThis.BooksSourcePolicy;
  let localStop=null,unsubscribe=null;
  const blocked=()=>localStop || policy?.reason() || (!options.fetch&&!policy?'snapshot_unverified':null);
  function halt(code) {
    if(!active)return;
    if(['http_403','http_429','stream_rejected'].includes(code))localStop=code;
    dispose();restPaused=true;
    for(const key of ['positions','orders','fills','events']){
      state[key].status='error';state[key].error=code;
    }
    status('blocked',code);
  }
  let state,controllers=new Set(),busy=false,backfillPending=false,reconnects=0,accepted=false,lastInbound=0,restPaused=false,spotCache=null,spotAttempted=false;
  const reset=address=>({address,scope:'default_perp_dex',displayLimit:LIMIT,connection:{status:'idle',reason:null,lastMessageAt:null,gap:false},
    symbols:spotCache||{status:'idle',spot:{},fetchedAt:null,error:null},positions:section(),orders:section(),fills:{...section(),receivedCount:0,snapshot:false,limited:true},events:section()});
  state=reset(null);
  const emit=()=>notify(clone(state));
  const valid=token=>active&&visible&&token===generation;
  function clear(name) {if(name!==null)clearTimer(name);}
  function dispose() {
    generation++;clear(refreshTimer);clear(pingTimer);clear(reconnectTimer);clear(openTimer);refreshTimer=pingTimer=reconnectTimer=openTimer=null;
    for(const c of controllers)c.abort();controllers.clear();busy=false;backfillPending=false;
    const old=socket;socket=null;if(old){old.onopen=old.onmessage=old.onerror=old.onclose=null;try{old.close(1000,'Account view closed');}catch{}}
  }
  function status(kind,reason=null) {state.connection.status=kind;state.connection.reason=reason;emit();}
  async function request(type,token) {
    const controller=new Controller();controllers.add(controller);
    const timeout=setTimer(()=>controller.abort(),12000);
    try {
      const body=type==='spotMeta'?{type}:{type,user:state.address};if(type==='clearinghouseState'||type==='frontendOpenOrders')body.dex='';if(type==='userFills')body.aggregateByTime=false;
      const response=await fetcher(INFO,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
      if(response.status===403||response.status===429){
        const code='http_'+response.status;policy?.stop(code);halt(code);throw Error(code);
      }
      if(response.status!==200)throw Error('http_'+response.status);
      const contentType=response.headers.get('content-type') || '';if(!/application\/json/i.test(contentType))throw Error('unexpected_content_type');
      if(Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('response_too_large');
      const reader=response.body.getReader(),chunks=[];let size=0;
      while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error('response_too_large');}chunks.push(chunk.value);}
      if(!valid(token))return null;
      const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
    } finally {clear(timeout);controllers.delete(controller);}
  }
  async function readSection(name,type,token) {
    state[name].status='loading';state[name].error=null;emit();
    try {
      const payload=await request(type,token);if(!valid(token))return;
      const fetchedAt=now();
      if(name==='positions'){const parsed=positions(payload,fetchedAt);state.positions={status:'ready',...parsed,fetchedAt,error:null};}
      else if(name==='orders'){state.orders={status:'ready',rows:orders(payload,fetchedAt),fetchedAt,sourceTime:null,error:null};}
      else {const parsed=fills(payload,state.address,fetchedAt);state.fills={...state.fills,status:'ready',rows:merge(state.fills.rows,parsed,now()),receivedCount:parsed.length,fetchedAt,error:null};}
    } catch(error) {
      if(!valid(token))return;restPaused=true;state[name].status='error';state[name].error=/^http_\d{3}$/.test(error.message)?error.message:error.message==='invalid_response'?'invalid_response':'unavailable';
    }
    if(valid(token))emit();
  }
  async function readSymbols(token) {
    if(spotAttempted)return;spotAttempted=true;state.symbols.status='loading';emit();
    try {const payload=await request('spotMeta',token);if(!valid(token)){spotAttempted=false;return;}spotCache={status:'ready',spot:symbols(payload),fetchedAt:now(),error:null};state.symbols=spotCache;}
    catch {if(!valid(token)){spotAttempted=false;return;}state.symbols={status:'error',spot:{},fetchedAt:null,error:'unavailable'};}
    if(valid(token))emit();
  }
  async function refresh(includeFills=false) {
    if(!active||!visible)return;if(busy){backfillPending ||= includeFills;return;}if(blocked()){halt(blocked());return;}busy=true;const token=generation;clear(refreshTimer);refreshTimer=null;
    try {await Promise.all([readSymbols(token),readSection('positions','clearinghouseState',token),readSection('orders','frontendOpenOrders',token),...((includeFills||state.connection.status!=='live')?[readSection('fills','userFills',token)]:[])]);}
    finally {if(valid(token)){busy=false;if(!restPaused){const backfill=backfillPending;backfillPending=false;refreshTimer=setTimer(()=>refresh(backfill),backfill?0:60000);}}}
  }
  function connect(token) {
    if(!valid(token)||socket)return;if(blocked()){halt(blocked());return;}
    if(!WS){status('error','websocket_unavailable');return;}
    accepted=false;lastInbound=now();let seenOpen=false;const acknowledgments=new Set();
    try {socket=new WS(SOCKET);}catch{status('error','websocket_unavailable');return;}
    const thisSocket=socket;status('connecting');
    openTimer=setTimer(()=>{if(!alive())return;state.connection.status='error';state.connection.reason='stream_timeout';thisSocket.onclose=thisSocket.onerror=null;socket=null;clear(pingTimer);pingTimer=null;try{thisSocket.close(1000,'Subscription timeout');}catch{}emit();},12000);
    function alive(){return valid(token)&&socket===thisSocket;}
    function heartbeat(){
      if(!alive())return;
      if(now()-lastInbound>60000){try{thisSocket.close(4000,'Heartbeat timeout');}catch{}return;}
      if(thisSocket.readyState===1){try{thisSocket.send(JSON.stringify({method:'ping'}));}catch{try{thisSocket.close(4000,'Connection interrupted');}catch{}return;}}
      pingTimer=setTimer(heartbeat,30000);
    }
    thisSocket.onopen=()=>{
      if(!alive())return;seenOpen=true;
      for(const type of TYPES)thisSocket.send(JSON.stringify({method:'subscribe',subscription:{type,user:state.address}}));
      status('connecting');clear(pingTimer);pingTimer=setTimer(heartbeat,30000);
    };
    thisSocket.onmessage=event=>{
      if(!alive())return;
      try {
        if(typeof event.data!=='string'||new TextEncoder().encode(event.data).byteLength>MAX_BYTES)invalid();
        const message=object(JSON.parse(event.data));lastInbound=now();state.connection.lastMessageAt=lastInbound;
        if(message.channel==='pong')return;
        if(message.channel==='subscriptionResponse'){
          const response=object(message.data),sub=object(response.subscription);
          if(response.method!=='subscribe'||!TYPES.includes(sub.type)||String(sub.user).toLowerCase()!==state.address)invalid();
          acknowledgments.add(sub.type);accepted=acknowledgments.size===TYPES.length;if(accepted){clear(openTimer);openTimer=null;}if(sub.type==='orderUpdates'){state.events.status='ready';state.events.fetchedAt=now();}state.connection.status=accepted?'live':'connecting';state.connection.reason=null;emit();return;
        }
        if(message.channel==='error'){policy?.stop('stream_rejected');halt('stream_rejected');return;}
        if(message.channel==='userFills'){
          const data=object(message.data);if(String(data.user).toLowerCase()!==state.address)invalid();
          if(data.isSnapshot!==undefined&&typeof data.isSnapshot!=='boolean')invalid();
          const parsed=fills(data.fills,state.address,now());
          state.fills={...state.fills,status:'ready',rows:merge(state.fills.rows,parsed,now()),fetchedAt:now(),error:null,snapshot:data.isSnapshot===true};
        }else if(message.channel==='orderUpdates'){
          const parsed=updates(message.data,state.address,now());state.events={...state.events,status:'ready',rows:merge(state.events.rows,parsed,now(),'statusTime'),fetchedAt:now(),error:null};
          // Events are an audit trail, not a complete open-order snapshot. Refresh REST separately.
        }else return;
        acknowledgments.add(message.channel);accepted=acknowledgments.size===TYPES.length;if(accepted){clear(openTimer);openTimer=null;}state.connection.status=accepted?'live':'connecting';state.connection.reason=null;emit();
      }catch{
        state.connection.status='error';state.connection.reason='invalid_stream';clear(pingTimer);clear(openTimer);pingTimer=openTimer=null;
        thisSocket.onclose=thisSocket.onerror=null;socket=null;try{thisSocket.close(1000,'Invalid public data');}catch{}emit();
      }
    };
    thisSocket.onerror=()=>{if(alive()){state.connection.status='error';state.connection.reason='websocket_unavailable';emit();}};
    thisSocket.onclose=event=>{
      if(!alive())return;socket=null;clear(pingTimer);clear(openTimer);pingTimer=openTimer=null;state.connection.gap=true;
      if(event.code===1008){policy?.stop('stream_rejected');halt('stream_rejected');return;}
      if(accepted&&seenOpen&&![1003,1008,1009].includes(event.code)&&reconnects<2){
        reconnects++;status('reconnecting','stream_gap');reconnectTimer=setTimer(()=>{reconnectTimer=null;if(valid(token)){refresh(true);connect(token);}},reconnects===1?5000:15000);
      }else status('error','stream_disconnected');
    };
  }
  function start(address) {
    if(typeof address!=='string'||!ADDRESS.test(address))throw Error('invalid_address');
    address=address.toLowerCase();if(active&&state.address===address)return;
    if(activeClient&&activeClient!==api)activeClient.stop();activeClient=api;
    dispose();active=true;reconnects=0;restPaused=false;state=reset(address);
    unsubscribe?.();unsubscribe=policy?.subscribe(halt);
    if(blocked()){halt(blocked());return;}
    if(!visible){status('paused');return;}
    emit();const token=generation;refresh(true);connect(token);
  }
  function stop() {unsubscribe?.();unsubscribe=null;dispose();active=false;if(activeClient===api)activeClient=null;state.connection.status='closed';state.connection.reason=null;emit();}
  function setVisible(value) {
    value=!!value;if(value===visible)return;visible=value;if(!active)return;
    if(!visible){dispose();state.connection.gap=true;status('paused');return;}
    reconnects=0;state.connection.gap=true;emit();const token=generation;if(!restPaused)refresh(true);connect(token);
  }
  function manualRefresh() {
    if(!active||!visible)return;
    if(blocked()){halt(blocked());return;}
    restPaused=false;
    if(['error','blocked'].includes(state.connection.status)){
      clear(reconnectTimer);clear(pingTimer);clear(openTimer);reconnectTimer=pingTimer=openTimer=null;
      const old=socket;socket=null;if(old){old.onopen=old.onmessage=old.onerror=old.onclose=null;try{old.close(1000,'Manual reconnect');}catch{}}
      reconnects=0;state.connection.gap=true;connect(generation);
    }
    return refresh(true);
  }
  const api={start,stop,setVisible,refresh:manualRefresh,getState:()=>clone(state)};
  return api;
}
return {create,normalize:{positions,orders,fills,updates,symbols},endpoints:{info:INFO,websocket:SOCKET},displayLimit:LIMIT};
});
