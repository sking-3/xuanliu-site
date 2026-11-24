/* Public Bitget UTA books1 feed. Quotes only; no account or trading access. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksBitgetBookStream=api;})(globalThis,function(){
'use strict';
const URL='wss://ws.bitget.com/v3/ws/public', MAX_AGE=5000, MAX_MESSAGE=100000;
const decimal=/^\d{1,18}(?:\.\d{1,12})?$/;
function level(value){if(!Array.isArray(value)||value.length<2||!decimal.test(value[0])||!decimal.test(value[1]))throw Error('invalid_book');const p=Number(value[0]),q=Number(value[1]);if(!(p>0&&q>0&&Number.isFinite(p)&&Number.isFinite(q)))throw Error('invalid_book');return {price:value[0],quantity:value[1]};}
function create({symbol,WebSocket:Socket=globalThis.WebSocket,now=()=>Date.now(),setTimeout:setTimer=globalThis.setTimeout,clearTimeout:clearTimer=globalThis.clearTimeout,onChange=()=>{}}={}){
 if(typeof symbol!=='string'||!/^[A-Z0-9]{2,30}USDT$/.test(symbol)||typeof Socket!=='function'||typeof now!=='function'||typeof onChange!=='function')throw Error('invalid_config');
 let socket=null,active=false,generation=0,quote=null,status='idle',reason=null,heartbeat=null,pongTimeout=null,reconnect=null,connectTimeout=null,retries=0,awaitingPong=false;
 const clear=id=>{if(id!==null)clearTimer(id);};
 const valid=token=>active&&generation===token;
 function snapshot(){const t=now(),fresh=status==='live'&&quote&&Number.isSafeInteger(t)&&t>=quote.receivedAt&&t-quote.receivedAt<=MAX_AGE&&t>=quote.sourceTime&&t-quote.sourceTime<=MAX_AGE;return {venue:'Bitget',symbol,status:status==='live'&&!fresh?'stale':status,reason:status==='live'&&!fresh?'quote_stale':reason,quote:quote?{...quote,bid:{...quote.bid},ask:{...quote.ask}}:null,usable:!!fresh,staleAfterMs:MAX_AGE};}
 function emit(){onChange(snapshot());}
 function dispose(){generation++;for(const id of [heartbeat,pongTimeout,reconnect,connectTimeout])clear(id);heartbeat=pongTimeout=reconnect=connectTimeout=null;awaitingPong=false;const old=socket;socket=null;if(old){old.onopen=old.onmessage=old.onerror=old.onclose=null;try{old.close(1000,'stopped');}catch{}}}
 function halt(why){dispose();active=false;status='error';reason=why;emit();}
 function start(){if(active)return;active=true;retries=0;status='connecting';reason=null;quote=null;connect();}
 function stop(){dispose();active=false;status='stopped';reason=null;emit();}
 function disconnect(why){if(!active)return;dispose();status='disconnected';reason=why;emit();if(retries>=3){active=false;return;}const token=generation,delay=Math.min(1000*2**retries,4000);retries++;reconnect=setTimer(()=>{reconnect=null;if(valid(token)){status='connecting';reason=null;connect();}},delay);}
 function connect(){const token=generation;if(!valid(token))return;let ws;try{ws=new Socket(URL);socket=ws;}catch{disconnect('connection_failed');return;}emit();
  connectTimeout=setTimer(()=>{if(valid(token)&&socket===ws)disconnect('connection_timeout');},12000);
  const alive=()=>valid(token)&&socket===ws;
  function sendPing(){if(!alive())return;if(awaitingPong){disconnect('heartbeat_timeout');return;}try{ws.send('ping');awaitingPong=true;pongTimeout=setTimer(()=>{if(alive()&&awaitingPong)disconnect('heartbeat_timeout');},10000);heartbeat=setTimer(sendPing,30000);}catch{disconnect('connection_failed');}}
  ws.onopen=()=>{if(!alive())return;clear(connectTimeout);connectTimeout=null;try{ws.send(JSON.stringify({op:'subscribe',args:[{instType:'usdt-futures',topic:'books1',symbol}]}));heartbeat=setTimer(sendPing,30000);}catch{disconnect('connection_failed');}};
  ws.onmessage=event=>{if(!alive())return;try{
   if(typeof event.data!=='string'||event.data.length>MAX_MESSAGE)throw Error('invalid_message');
   if(event.data==='pong'){awaitingPong=false;clear(pongTimeout);pongTimeout=null;return;}
   const message=JSON.parse(event.data);if(!message||typeof message!=='object'||Array.isArray(message))throw Error('invalid_message');
   if(message.event==='error'){halt('source_rejected');return;}
   const arg=message.arg;if(!arg||arg.instType!=='usdt-futures'||arg.topic!=='books1'||arg.symbol!==symbol)throw Error('unexpected_subscription');
   if(message.event==='subscribe')return;
   if(message.action!=='snapshot'||!Array.isArray(message.data)||message.data.length!==1)throw Error('invalid_book');
   const row=message.data[0],receivedAt=now(),sourceTime=Number(row?.ts);
   if(!Number.isSafeInteger(receivedAt)||!Number.isSafeInteger(sourceTime)||sourceTime<=0||sourceTime>receivedAt+1000||receivedAt-sourceTime>MAX_AGE)throw Error('invalid_time');
   if(!Array.isArray(row.a)||!Array.isArray(row.b)||row.a.length!==1||row.b.length!==1)throw Error('invalid_book');
   const ask=level(row.a[0]),bid=level(row.b[0]);if(Number(bid.price)>Number(ask.price))throw Error('crossed_book');
   if(quote&&sourceTime<quote.sourceTime)return;
   // Several complete books may share a millisecond. We cannot prove their
   // order from timestamps alone: ignore same-time data without refreshing age.
   if(quote&&sourceTime===quote.sourceTime)return;
   quote={venue:'Bitget',symbol,bid,ask,sourceTime,receivedAt};status='live';reason=null;emit();
  }catch(e){halt(['unexpected_subscription','invalid_book','invalid_time','crossed_book','invalid_message'].includes(e.message)?e.message:'invalid_stream');}};
  ws.onerror=()=>{if(alive())disconnect('connection_error');};ws.onclose=()=>{if(alive())disconnect('connection_closed');};
 }
 return {start,stop,getState:snapshot,getQuote:()=>{const state=snapshot();return state.usable?state.quote:null;}};
}
return {create,MAX_AGE,URL};
});
