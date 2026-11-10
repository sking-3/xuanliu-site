'use strict';
/* Offline regression tests. All HTTP, clocks, timers and file I/O are injected. */
const assert=require('node:assert/strict');
const API=require('../scripts/collect_trader_analytics.cjs');
const normalize=require('../trader/account-analytics.js').normalize;
const T=1800000000000,iso=t=>new Date(t).toISOString(),address=i=>'0x'+i.toString(16).padStart(40,'0');
const fill=(updates={})=>({coin:'BTC',time:T-1000,dir:'Close Long',side:'A',sz:'1',startPosition:'2',closedPnl:'10',fee:'1',feeToken:'USDC',tid:1,oid:100,hash:'0xabc',...updates});
const feed=(n=1)=>({source:{id:'hyperliquid',status:'ok',positionVerification:{scope:'default_perp_dex',completedAt:iso(T)}},traders:Array.from({length:n},(_,i)=>({accountId:address(i+1),exchange:'Hyperliquid',sourceKind:'public_account',positionCheck:{scope:'default_perp_dex',count:1,checkedAt:iso(T),sourceTime:iso(T-1000)}}))});
const response=(payload=[fill()],status=200,headers={})=>({status,headers:{get:key=>({'content-type':'application/json',...headers})[key]??null},text:async()=>typeof payload==='string'?payload:JSON.stringify(payload)});
function previous(records) {
  return {schemaVersion:1,methodVersion:API.METHOD_VERSION,generatedAt:iso(T),accounts:Object.fromEntries(records.map(([id,age=0,extra={}])=>[address(id),{status:'ready',fetchedAt:iso(T-age),lastAttemptAt:iso(T-age),errorCode:null,win:normalize.winRate([fill({time:T-age-1000})],T-age),...extra}]))};
}
function env(handler=()=>response(),options={}) {
  let tick=0,serial=0,live=0,maximum=0;const timers=new Map(),calls=[];
  const setTimer=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:tick+ms});return id;};
  const clearTimer=id=>timers.delete(id);
  const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
  const fetch=async(url,settings)=>{
    const call={url,settings,body:JSON.parse(settings.body),at:tick};calls.push(call);live++;maximum=Math.max(maximum,live);
    try{return await handler(call,calls.length);}finally{live--;}
  };
  const advance=async ms=>{const until=tick+ms;for(;;){const item=[...timers.entries()].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!item)break;tick=item[1].at;timers.delete(item[0]);item[1].fn();await flush();}tick=until;await flush();};
  const run=async input=>{
    let settled=false,result,error;
    API.collect({feed:feed(),...input,fetch,now:()=>T+tick,clock:()=>tick,setTimer,clearTimer,sleep:ms=>new Promise(resolve=>setTimer(resolve,ms)),...options}).then(x=>{result=x;settled=true;},x=>{error=x;settled=true;});
    for(let i=0;i<10000&&!settled;i++) {await flush();if(settled)break;const next=[...timers.values()].sort((a,b)=>a.at-b.at)[0];if(!next)throw Error('collector hung without timer');await advance(Math.max(0,next.at-tick));}
    if(!settled)throw Error('collector did not finish');if(error)throw error;return result;
  };
  return {run,calls,timers,advance,flush,now:()=>T+tick,maximum:()=>maximum};
}
let count=0;async function test(name,fn){await fn();count++;console.log('ok '+name);}
(async()=>{
await test('successful aggregate reuses exact normalizer and never persists raw fills',async()=>{
  const e=env(),r=await e.run({feed:feed(2)});
  assert.equal(r.schemaVersion,1);assert.equal(r.methodVersion,'closing-fill-v1');assert.equal(r.source.succeeded,2);assert.equal(r.source.status,'ready');
  assert.deepEqual(r.accounts[address(1)].win,normalize.winRate([fill()],T));assert.equal(r.accounts[address(1)].status,'ready');
  const raw=JSON.stringify(r);for(const key of ['"closedPnl"','"oid"','"tid"','"hash"','"startPosition"','"sz"'])assert(!raw.includes(key));
  for(const call of e.calls){assert.equal(call.url,'https://api.hyperliquid.xyz/info');assert.deepEqual(call.body,{type:'userFills',user:call.body.user,aggregateByTime:false});assert.equal(call.settings.redirect,'error');assert.equal(call.settings.credentials,'omit');}
  assert(e.maximum()<=2);assert.equal(e.timers.size,0);
});
await test('empty samples and zero percent stay distinct',async()=>{
  const e=env((call,n)=>response(n===1?[]:[fill({closedPnl:'0',fee:'1'})])),r=await e.run({feed:feed(2)});
  assert.equal(r.accounts[address(1)].win.value,null);assert.equal(r.accounts[address(1)].win.eligibleCount,0);assert.equal(r.accounts[address(1)].status,'ready');
  assert.equal(r.accounts[address(2)].win.value,0);assert.equal(r.accounts[address(2)].win.losing,1);
});
await test('fresh persisted cache prevents requests across runs',async()=>{
  const e=env(()=>{throw Error('should not fetch');}),r=await e.run({feed:feed(2),previous:previous([[1,600000],[2,0]])});
  assert.equal(e.calls.length,0);assert.equal(r.source.cached,2);assert.equal(r.source.attempted,0);assert.equal(r.accounts[address(1)].fetchedAt,iso(T-600000));
});
await test('missing accounts first then oldest success, pruning unqualified accounts',async()=>{
  const p=previous([[1,3000000],[3,1500000],[4,3000000]]),e=env(),r=await e.run({feed:feed(3),previous:p});
  assert.deepEqual(e.calls.map(x=>x.body.user),[address(2),address(1),address(3)]);assert.equal(r.accounts[address(4)],undefined);
});
await test('malformed or wrong-version cache does not seed values',async()=>{
  for(const edit of [p=>{p.methodVersion='future';},p=>{p.generatedAt=iso(T+6000);},p=>{p.accounts[address(1)].win.winning=999;},p=>{p.accounts[address(1)].win.startAt=iso(T+900000);},p=>{p.accounts[address(1)].win.value=90;},p=>{p.accounts[address(1)].win.historyComplete=true;}]) {
    const p=previous([[1,0]]);edit(p);const e=env(),r=await e.run({previous:p});assert.equal(e.calls.length,1);assert.equal(r.accounts[address(1)].win.value,100);
  }
});
await test('cache validation strips unknown fields instead of publishing raw records',async()=>{
  const p=previous([[1,0]]);p.accounts[address(1)].win.fills=[fill()];p.accounts[address(1)].secret='never';
  const r=await env().run({previous:p});assert(!JSON.stringify(r).includes('"fills"'));assert(!JSON.stringify(r).includes('never'));
});
await test('ordinary errors retain last good values and source timestamps',async()=>{
  const p=previous([[1,1800000]]),e=env(()=>response('do not log',500)),r=await e.run({previous:p});
  const x=r.accounts[address(1)];assert.equal(e.calls.length,1);assert.equal(x.status,'stale');assert.equal(x.errorCode,'http_500');assert.equal(x.fetchedAt,iso(T-1800000));assert.equal(x.lastAttemptAt,iso(T));assert.equal(x.win.value,100);assert(!JSON.stringify(r).includes('do not log'));
});
await test('failed fresh previous result retries instead of masking stale status',async()=>{
  const p=previous([[1,60000,{status:'stale',errorCode:'network_error'}]]),e=env(),r=await e.run({previous:p});
  assert.equal(e.calls.length,1);assert.equal(r.accounts[address(1)].status,'ready');
});
await test('no valid last good result remains null after network error',async()=>{
  const e=env(()=>{throw Error('sensitive-body');}),r=await e.run();const x=r.accounts[address(1)];
  assert.equal(x.status,'unavailable');assert.equal(x.win,null);assert.equal(x.fetchedAt,null);assert.equal(x.errorCode,'network_error');assert.equal(r.source.status,'unavailable');assert(!JSON.stringify(r).includes('sensitive-body'));
});
await test('403 and 429 block queued work and abort in-flight requests without retry',async()=>{
  for(const status of [403,429]) {
    let aborted=0;const e=env((call,n)=>{if(n===1)return response('blocked',status);return new Promise((_,reject)=>call.settings.signal.addEventListener('abort',()=>{aborted++;reject(Error('cancelled'));}));});
    const r=await e.run({feed:feed(8)});assert.equal(e.calls.length,2);assert.equal(aborted,1);assert.equal(r.source.stopCode,'http_'+status);assert.equal(r.source.attempted,2);assert.equal(r.source.failed,2);assert.equal(r.source.unattempted,6);assert.equal(e.timers.size,0);
  }
});
await test('a same-run position block prevents any analytics request',async()=>{
  for(const place of ['position','fallback'])for(const code of ['http_403','http_429']) {
    const f=feed(2);if(place==='position')f.source.positionVerification.stopCode=code;else f.source.errorCode=code;
    const e=env(()=>{throw Error('unexpected fetch');}),r=await e.run({feed:f,previous:previous([[1,0]])});
    assert.equal(e.calls.length,0);assert.equal(r.accounts[address(1)].status,'stale');assert.equal(r.accounts[address(1)].fetchedAt,iso(T));assert.equal(r.accounts[address(2)].win,null);assert.equal(r.source.stopCode,code);
  }
});
await test('rolling quota launches no more than seven worst-case calls per minute',async()=>{
  const e=env(),r=await e.run({feed:feed(18)});
  assert.equal(r.source.succeeded,18);for(const call of e.calls){const window=e.calls.filter(x=>x.at>call.at-60000&&x.at<=call.at);assert(window.length*120<=900);}
  assert.equal(e.calls[7].at,60000);assert.equal(e.calls[14].at,120000);
});
await test('hard batch deadline includes quota wait and keeps unattempted last good',async()=>{
  const good=env(()=>response(),{limits:{batchMs:30000}}),r=await good.run({feed:feed(10),previous:previous([[10,1800000]])});
  assert.equal(good.calls.length,7);assert.equal(r.source.stopCode,'batch_timeout');assert.equal(r.source.unattempted,3);assert.equal(r.accounts[address(10)].status,'stale');assert.equal(r.accounts[address(10)].fetchedAt,iso(T-1800000));assert.equal(r.accounts[address(10)].lastAttemptAt,iso(T-1800000));assert.equal(good.timers.size,0);
});
await test('request timeout aborts once without a retry',async()=>{
  let aborted=0;const e=env(call=>new Promise((_,reject)=>call.settings.signal.addEventListener('abort',()=>{aborted++;reject(Error('abort'));}))),r=await e.run();
  assert.equal(e.calls.length,1);assert.equal(aborted,1);assert.equal(r.accounts[address(1)].errorCode,'request_timeout');assert.equal(r.source.failed,1);assert.equal(e.timers.size,0);
});
await test('no request starts without a full request-timeout window left',async()=>{
  let aborted=0;const e=env(call=>new Promise((_,reject)=>call.settings.signal.addEventListener('abort',()=>{aborted++;reject(Error('abort'));})),{limits:{batchMs:1000}}),r=await e.run({feed:feed(4)});
  assert.equal(e.calls.length,0);assert.equal(aborted,0);assert.equal(r.source.stopCode,'batch_timeout');assert.equal(r.source.unattempted,4);
});
await test('invalid content type, oversized headers and invalid JSON do not overwrite cache',async()=>{
  for(const reply of [response('<html>',200,{'content-type':'text/html'}),response('{}',200,{'content-length':String(API.LIMITS.maxBytes+1)}),response('{bad-json')]) {
    const r=await env(()=>reply).run({previous:previous([[1,1800000]])});assert.equal(r.accounts[address(1)].status,'stale');assert.equal(r.accounts[address(1)].win.value,100);
  }
});
await test('streaming body size limit cancels reader',async()=>{
  let cancelled=false,released=false;
  const reply={status:200,headers:{get:key=>key==='content-type'?'application/json':null},body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(1024)}),cancel:async()=>{cancelled=true;},releaseLock:()=>{released=true;}})}};
  const r=await env(()=>reply,{limits:{maxBytes:100}}).run();assert.equal(r.accounts[address(1)].errorCode,'response_too_large');assert(cancelled&&released);
});
await test('invalid fills leave an unavailable aggregate instead of accepting guessed fields',async()=>{
  const r=await env(()=>response([fill({feeToken:null})])).run();assert.equal(r.accounts[address(1)].win,null);assert.equal(r.accounts[address(1)].errorCode,'invalid_response');
});
await test('unverified, zero and expired positions never launch account requests',async()=>{
  const f=feed(4);delete f.traders[0].positionCheck;f.traders[1].positionCheck.count=0;f.traders[2].positionCheck.checkedAt=iso(T-3600001);f.traders[3].positionCheck.sourceTime=iso(T-120001);
  const e=env(),r=await e.run({feed:f});assert.equal(e.calls.length,0);assert.deepEqual(r.accounts,{});
  const old=feed();delete old.source.positionVerification;assert.deepEqual(API.selectAccounts(old,T),[]);
});
await test('invalid addresses, duplicates and oversized candidate sets fail before fetching',async()=>{
  for(const change of [f=>{f.traders[0].accountId='not-an-address';},f=>f.traders.push({...f.traders[0]}),f=>{f.traders=feed(201).traders;}]) {
    const f=feed();change(f);const e=env();await assert.rejects(e.run({feed:f}),/invalid_feed/);assert.equal(e.calls.length,0);
  }
});
await test('age expiry uses original fetch time even for skipped cache',async()=>{
  const r=API.validatedCache(previous([[1,3600001]]),[address(1)],T);assert.equal(r[address(1)].status,'stale');
});
await test('atomic write serializes only result and cleans temporary file on failure',async()=>{
  const calls=[],io={mkdir:async()=>{},writeFile:async(...args)=>calls.push(['write',...args]),rename:async(...args)=>calls.push(['rename',...args]),unlink:async(...args)=>calls.push(['unlink',...args])};
  await API.atomicWrite('/tmp/analytics.json',{ok:true},io);assert.equal(calls[0][2],'{"ok":true}\n');assert.equal(calls[1][0],'rename');assert.equal(calls[2][0],'unlink');
  const bad={...io,rename:async()=>{throw Error('disk failure');}};await assert.rejects(API.atomicWrite('/tmp/analytics.json',{},bad),/disk failure/);assert.equal(calls.at(-1)[0],'unlink');
});
await test('CLI uses injected disk and fetch with no raw record writes',async()=>{
  const files=new Map([['/test/feed.json',JSON.stringify(feed())]]),logs=[];
  const io={stat:async file=>{if(!files.has(file)){const e=Error('missing');e.code='ENOENT';throw e;}return {size:Buffer.byteLength(files.get(file))};},readFile:async file=>files.get(file),mkdir:async()=>{},writeFile:async(file,value)=>files.set(file,value),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlink:async file=>files.delete(file)};
  const r=await API.main(['--feed','/test/feed.json','--output','/test/analytics.json'],{io,now:()=>T,fetch:async()=>response(),log:value=>logs.push(value)});
  assert.equal(r.accounts[address(1)].win.value,100);assert(files.has('/test/analytics.json'));assert(!files.get('/test/analytics.json').includes('closedPnl'));assert.equal(logs.length,1);
});

await test('successful request-start timestamp survives a cache round trip',async()=>{
  const p=previous([[1,1000]]);p.accounts[address(1)].lastAttemptAt=iso(T-2000);
  const r=await env().run({previous:p});assert.equal(r.accounts[address(1)].lastAttemptAt,iso(T-2000));assert.equal(r.accounts[address(1)].fetchedAt,iso(T-1000));
});
await test('new future sample beyond five seconds is rejected before publishing',async()=>{
  const r=await env(()=>response([fill({time:T+5001})])).run();assert.equal(r.accounts[address(1)].win,null);assert.equal(r.accounts[address(1)].errorCode,'invalid_response');
  const ok=await env(()=>response([fill({time:T+5000})])).run();assert.equal(ok.accounts[address(1)].win.value,100);
});

await test('contradictory unavailable result cannot be resurrected from cache',async()=>{
  const p=previous([[1,0,{status:'unavailable'}]]),e=env();const r=await e.run({previous:p});assert.equal(e.calls.length,1);assert.equal(r.accounts[address(1)].status,'ready');
  const failed=previous([[1,0,{status:'ready',errorCode:'http_500'}]]),retry=env();await retry.run({previous:failed});assert.equal(retry.calls.length,1);
});
await test('two hundred accounts remain bounded by the real twenty-two minute quota',async()=>{
  const e=env(),r=await e.run({feed:feed(200)});assert.equal(r.source.stopCode,'batch_timeout');assert.equal(r.source.attempted,154);assert.equal(r.source.succeeded,154);assert.equal(r.source.unattempted,46);assert.equal(e.now(),T+22*60000);assert.equal(Object.keys(r.accounts).length,200);
});
await test('a portfolio-stage block prevents all closing-fill requests',async()=>{
  for(const priorStopCode of ['http_403','http_429']) {
    const e=env(()=>{throw Error('unexpected request');}),r=await e.run({priorStopCode,feed:feed(2),previous:previous([[1,0]])});
    assert.equal(e.calls.length,0);assert.equal(r.source.stopCode,priorStopCode);assert.equal(r.accounts[address(1)].status,'stale');assert.equal(r.accounts[address(1)].fetchedAt,iso(T));
  }
});
await test('CLI validates current portfolio stop status before using the API',async()=>{
  for(const code of ['http_403','http_429']) {
    const status={schemaVersion:1,methodVersion:'portfolio-periods-v2',generatedAt:iso(T),source:{id:'hyperliquid',status:'unavailable',stopCode:code}};
    const files=new Map([['/test/feed.json',JSON.stringify(feed())],['/test/portfolios.json',JSON.stringify(status)]]);
    const io={stat:async file=>{if(!files.has(file)){const e=Error('missing');e.code='ENOENT';throw e;}return {size:Buffer.byteLength(files.get(file))};},readFile:async file=>files.get(file),mkdir:async()=>{},writeFile:async(file,value)=>files.set(file,value),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlink:async file=>files.delete(file)};
    const args=['--feed','/test/feed.json','--output','/test/analytics.json','--portfolio-status','/test/portfolios.json'];
    const deps={io,now:()=>T,fetch:async()=>{throw Error('unexpected fetch');},log:()=>{}};
    const r=await API.main(args,deps);assert.equal(r.source.stopCode,code);assert.equal(r.source.attempted,0);
    for(const malformed of ['http_403 ',42,undefined]) {
      status.source.stopCode=malformed;files.set('/test/portfolios.json',JSON.stringify(status));
      await assert.rejects(API.main(args,deps),/invalid_portfolio_status/);
    }
    status.source.stopCode=code;
    status.generatedAt=iso(T-600001);files.set('/test/portfolios.json',JSON.stringify(status));
    await assert.rejects(API.main(args,deps),/invalid_portfolio_status/);
    status.generatedAt=iso(T+5001);files.set('/test/portfolios.json',JSON.stringify(status));
    await assert.rejects(API.main(args,deps),/invalid_portfolio_status/);
  }
});

await test('closing-fill CLI rejects v1 portfolio stage status before making any request',async()=>{
  const status={schemaVersion:1,methodVersion:'portfolio-periods-v1',generatedAt:iso(T),source:{id:'hyperliquid',status:'ready',stopCode:null}};
  const files=new Map([['/test/feed.json',JSON.stringify(feed())],['/test/portfolios.json',JSON.stringify(status)]]);let calls=0;
  const io={stat:async file=>{if(!files.has(file)){const error=Error('missing');error.code='ENOENT';throw error;}return {size:Buffer.byteLength(files.get(file))};},readFile:async file=>files.get(file)};
  await assert.rejects(API.main(['--feed','/test/feed.json','--output','/test/analytics.json','--portfolio-status','/test/portfolios.json'],{io,now:()=>T,fetch:async()=>{calls++;return response();},log:()=>{}}),/invalid_portfolio_status/);assert.equal(calls,0);
});
console.log('PASS '+count+' offline collector tests');
})().catch(error=>{console.error(error);process.exitCode=1;});
