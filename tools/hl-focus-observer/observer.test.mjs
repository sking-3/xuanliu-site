import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADDRESS, openStore, createObserver, normalizeFill, start } from './observer.mjs';
import { runSmoke } from './smoke.mjs';

const T=1794900000000;
const fill=(n=1,overrides={})=>({coin:'BTC',side:'B',px:'65000',sz:'0.25',startPosition:'0',dir:'Open Long',time:T-1000,tid:n,oid:n+100,hash:'0x'+n,...overrides});
const msg=(fills,isSnapshot=false)=>({channel:'userFills',data:{user:ADDRESS,fills,isSnapshot}});
function fixture(){const store=openStore(':memory:');let time=T;const observer=createObserver({store,now:()=>time});observer.connecting();return {store,observer,setTime:v=>time=v};}

test('initial snapshot and historical records never produce an executable or eligible event',()=>{
 const {store,observer}=fixture();const rows=observer.receive(msg([fill()],true));
 assert.equal(rows[0].kind,'initial_baseline');assert.equal(rows[0].eligible,false);assert.equal(rows[0].executable,false);assert.equal(observer.status().baseline,true);store.close();
});
test('fresh stream events preserve source and receipt times; duplicates persist once',()=>{
 const {store,observer}=fixture();observer.receive(msg([],true));const row=observer.receive(msg([fill(2)],false))[0];
 assert.deepEqual([row.action,row.sourceTime,row.observedAt,row.lagMs,row.eligible,row.executable],['open_long',T-1000,T,1000,true,false]);
 assert.equal(observer.receive(msg([fill(2)],false)).length,0);assert.equal(store.count(),1);store.close();
});
test('a repeated fill identity with changed economics fails closed instead of hiding the revision',()=>{
 const {store,observer}=fixture();observer.receive(msg([],true));observer.receive(msg([fill(2)]));
 assert.throws(()=>observer.receive(msg([fill(2,{px:'64000'})])),/identity_conflict/);assert.equal(store.count(),1);store.close();
});
test('omitted isSnapshot never establishes baseline but is accepted for live updates after baseline',()=>{
 const {store,observer}=fixture();let data=msg([fill()]);delete data.data.isSnapshot;assert.equal(observer.receive(data)[0].kind,'before_baseline');assert.equal(observer.status().baseline,false);
 observer.receive(msg([],true));data=msg([fill(2)]);delete data.data.isSnapshot;assert.equal(observer.receive(data)[0].kind,'stream');store.close();
});
test('reconnect marks missed data as baseline and latches a reconciliation gap',()=>{
 const {store,observer}=fixture();observer.receive(msg([fill()],true));observer.disconnected('network');observer.connecting();
 const [gap]=observer.receive(msg([fill(),fill(2)],true));assert.equal(gap.kind,'reconnect_baseline');assert.equal(gap.eligible,false);
 assert.equal(observer.receive(msg([fill(3)],false))[0].eligible,false);assert.equal(observer.status().reconciliationRequired,true);store.close();
});
test('xyz identity and exact sign logic distinguish partial close and reversal',()=>{
 const {store,observer}=fixture();observer.receive(msg([],true));
 const a=observer.receive(msg([fill(1,{coin:'xyz:NVDA',side:'A',startPosition:'1.066',sz:'0.277',dir:'Close Long'})]))[0];
 const b=observer.receive(msg([fill(2,{coin:'xyz:NVDA',side:'A',startPosition:'0.1',sz:'0.3',dir:'Long > Short'})]))[0];
 assert.equal(a.coin,'xyz:NVDA');assert.equal(a.action,'reduce_long');assert.equal(b.action,'long_to_short');store.close();
});
test('stale, future-skewed and semantically ambiguous events cannot be candidates',()=>{
 const {store,observer}=fixture();observer.receive(msg([],true));
 assert.equal(observer.receive(msg([fill(1,{time:T-31000})]))[0].eligible,false);
 assert.equal(observer.receive(msg([fill(2,{dir:'Open Long',side:'A'})]))[0].eligible,false);
 assert.equal(observer.receive(msg([fill(3,{time:T+500})]))[0].eligible,false);
 assert.throws(()=>observer.receive(msg([fill(4,{time:T+6000})])),/invalid_time/);store.close();
});
test('wrong address, malformed payload or invalid item fail before committing batch',()=>{
 const {store,observer}=fixture();observer.receive(msg([],true));const wrong=msg([fill()]);wrong.data.user='0x'+'1'.repeat(40);
 assert.throws(()=>observer.receive(wrong),/invalid_stream/);assert.throws(()=>observer.receive(msg([fill(),fill(2,{sz:'nope'})])),/invalid_decimal/);assert.equal(store.count(),0);store.close();
});
test('SQLite persistence preserves baseline and deduplicates through process restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hl-observer-')),path=join(dir,'state.sqlite');
 try {let store=openStore(path),observer=createObserver({store,now:()=>T});observer.connecting();observer.receive(msg([fill()],true));store.close();
  assert.equal(statSync(path).mode & 0o777,0o600);store=openStore(path);observer=createObserver({store,now:()=>T+1000});observer.connecting();
  const rows=observer.receive(msg([fill(),fill(2)],true));assert.equal(rows.length,1);assert.equal(rows[0].kind,'reconnect_baseline');assert.equal(rows[0].eligible,false);assert.equal(store.count(),2);assert.equal(observer.status().reconciliationRequired,true);assert.equal(observer.receive(msg([fill(3)]) )[0].eligible,false);store.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('concurrent stores cannot insert an already observed fill twice',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hl-observer-')),path=join(dir,'state.sqlite');
 try {const a=openStore(path),b=openStore(path),x=createObserver({store:a,now:()=>T}),y=createObserver({store:b,now:()=>T});x.connecting();y.connecting();x.receive(msg([],true));y.receive(msg([],true));
  assert.equal(x.receive(msg([fill(2)])).length,1);assert.equal(y.receive(msg([fill(2)])).length,0);assert.equal(a.count(),1);a.close();b.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('explicit source rejection remains stopped after a process restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hl-observer-')),path=join(dir,'state.sqlite');
 try {let store=openStore(path),observer=createObserver({store,now:()=>T});observer.connecting();observer.receive({channel:'error',data:'rejected'});assert.equal(observer.status().hardStopped,true);assert.throws(()=>observer.connecting(),/stopped/);assert.equal(store.transitions().at(-1).reason,'source_rejected');store.close();
  store=openStore(path);assert.equal(store.stopReason(),'source_rejected');assert.throws(()=>start({store,WebSocketImpl:class {}}),/source_stopped/);store.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('only known wallet is subscribed and startup/close do not require credentials',()=>{
 class MockWS extends EventTarget { constructor(url){super();this.url=url;this.sent=[];this.readyState=1;MockWS.socket=this;}send(v){this.sent.push(JSON.parse(v));}close(){this.readyState=3;this.dispatchEvent(new Event('close'));} }
 const store=openStore(':memory:'),app=start({store,WebSocketImpl:MockWS,now:()=>T,log:()=>{},reconnect:false});
 MockWS.socket.dispatchEvent(new Event('open'));assert.equal(MockWS.socket.url,'wss://api.hyperliquid.xyz/ws');assert.deepEqual(MockWS.socket.sent[0],{method:'subscribe',subscription:{type:'userFills',user:ADDRESS,aggregateByTime:false}});
 app.stop();assert.equal(app.status().hardStopped,true);store.close();
});
test('policy close after a successful connection persists stop and forbids restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hl-observer-')),path=join(dir,'state.sqlite');
 try {
  class MockWS extends EventTarget {constructor(){super();this.readyState=1;MockWS.instances=(MockWS.instances||0)+1;MockWS.socket=this;}send(){}close(){this.readyState=3;}}
  let store=openStore(path);start({store,WebSocketImpl:MockWS,now:()=>T,log:()=>{}});MockWS.socket.dispatchEvent(new Event('open'));
  const close=new Event('close');Object.defineProperty(close,'code',{value:1008});MockWS.socket.dispatchEvent(close);assert.equal(store.stopReason(),'source_rejected');store.close();
  store=openStore(path);assert.throws(()=>start({store,WebSocketImpl:MockWS}),/source_stopped/);assert.equal(MockWS.instances,1);store.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('receiving pong without a snapshot cannot keep observer falsely healthy',()=>{
 class MockWS extends EventTarget {constructor(){super();this.readyState=1;MockWS.socket=this;}send(){}close(){this.readyState=3;}}
 const callbacks=[],timers={setTimeout(fn,delay){const t={fn,delay};callbacks.push(t);return t;},clearTimeout(t){if(t)t.cancelled=true;},setInterval(){return {};},clearInterval(){}};
 const store=openStore(':memory:'),app=start({store,WebSocketImpl:MockWS,now:()=>T,log:()=>{},timers});MockWS.socket.dispatchEvent(new Event('open'));
 const event=new Event('message');Object.defineProperty(event,'data',{value:JSON.stringify({channel:'pong'})});MockWS.socket.dispatchEvent(event);
 callbacks.find(t=>t.delay===15000&&!t.cancelled).fn();assert.equal(app.status().hardStopped,true);assert.equal(store.stopReason(),'baseline_timeout');store.close();
});
test('bounded smoke accepts an explicit snapshot and never exports raw wallet or trade data',async()=>{
 class MockWS extends EventTarget {
  constructor(){super();this.readyState=1;MockWS.instances=(MockWS.instances||0)+1;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(value){if(JSON.parse(value).method!=='subscribe')return;setTimeout(()=>{
   const event=new Event('message');Object.defineProperty(event,'data',{value:JSON.stringify(msg([fill(1,{coin:'xyz:NVDA',hash:'0xsecret-raw',time:Date.now()-1000})],true))});this.dispatchEvent(event);
  },2);}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
 }
 const result=await runSmoke({WebSocketImpl:MockWS,durationMs:50,pollMs:5});assert.equal(result.success,true);assert.equal(result.summary.baselineRows,1);assert.equal(result.summary.ordersSent,0);assert.equal(MockWS.instances,1);
 const output=JSON.stringify(result.summary);assert.doesNotMatch(output,/xyz:NVDA|secret-raw|0x02665a/);
});
test('bounded smoke does not retry a refused connection',async()=>{
 class MockWS extends EventTarget {constructor(){super();MockWS.instances=(MockWS.instances||0)+1;queueMicrotask(()=>this.dispatchEvent(new Event('error')));}close(){}}
 const result=await runSmoke({WebSocketImpl:MockWS,durationMs:50,pollMs:5});assert.equal(result.success,false);assert.equal(result.summary.sourceStop,'connect_failed');assert.equal(MockWS.instances,1);
});
