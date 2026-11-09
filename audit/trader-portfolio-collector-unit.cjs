'use strict';
/* All samples, network replies, file operations and clocks in this test are offline. */
const assert=require('node:assert/strict');
const API=require('../scripts/collect_trader_portfolios.cjs');
const normalizer=require('../trader/account-analytics.js');
const T=1800000000000,DAY=86400000,iso=t=>new Date(t).toISOString(),address=i=>'0x'+i.toString(16).padStart(40,'0');
const sample=(period='month',times=[T-2000,T-1000,T],pnl=[0,10,5],equity=[100,110,105])=>[[period,{pnlHistory:times.map((t,i)=>[t,String(pnl[i])]),accountValueHistory:times.map((t,i)=>[t,String(equity[i])])}]];
const wide=()=>sample('allTime',[T-400*DAY,T-365*DAY,T-200*DAY,T-180*DAY,T-100*DAY,T-90*DAY,T-60*DAY,T],[0,10,20,30,25,40,35,50],[100,110,120,130,125,140,135,150]);
const feed=(n=1)=>({source:{id:'hyperliquid',status:'ok',positionVerification:{scope:'default_perp_dex',completedAt:iso(T)}},traders:Array.from({length:n},(_,i)=>({accountId:address(i+1),exchange:'Hyperliquid',sourceKind:'public_account',positionCheck:{scope:'default_perp_dex',count:1,checkedAt:iso(T),sourceTime:iso(T-1000)}}))});
const response=(payload=sample(),status=200,headers={})=>({status,headers:{get:key=>({'content-type':'application/json',...headers})[key]??null},text:async()=>typeof payload==='string'?payload:JSON.stringify(payload)});
function previous(records) {
  return {schemaVersion:1,methodVersion:API.METHOD_VERSION,generatedAt:iso(T),accounts:Object.fromEntries(records.map(([id,age=0,extra={}])=>[address(id),{status:'ready',fetchedAt:iso(T-age),lastAttemptAt:iso(T-age),errorCode:null,portfolio:API.compactPortfolio(normalizer.normalize.portfolio(sample('month',[T-age-2000,T-age-1000,T-age]),T-age)),...extra}]))};
}
function env(handler=()=>response(),options={}) {
  let tick=0,serial=0,live=0,maximum=0;const timers=new Map(),calls=[];
  const setTimer=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:tick+ms});return id;},clearTimer=id=>timers.delete(id);
  const flush=async()=>{for(let i=0;i<2000;i++)await Promise.resolve();};
  const fetch=async(url,settings)=>{const call={url,settings,body:JSON.parse(settings.body),at:tick};calls.push(call);live++;maximum=Math.max(maximum,live);try{return await handler(call,calls.length);}finally{live--;}};
  const advance=async ms=>{const until=tick+ms;for(;;){const item=[...timers.entries()].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!item)break;tick=item[1].at;timers.delete(item[0]);item[1].fn();await flush();}tick=until;await flush();};
  const run=async input=>{let settled=false,result,error;
    API.collect({feed:feed(),...input,fetch,now:()=>T+tick,clock:()=>tick,setTimer,clearTimer,sleep:ms=>new Promise(resolve=>setTimer(resolve,ms)),...options}).then(x=>{result=x;settled=true;},x=>{error=x;settled=true;});
    for(let i=0;i<10000&&!settled;i++){await flush();if(settled)break;const next=[...timers.values()].sort((a,b)=>a.at-b.at)[0];if(!next)throw Error('collector hung');await advance(Math.max(0,next.at-tick));}
    if(!settled)throw Error('collector did not finish');if(error)throw error;return result;};
  return {run,calls,timers,advance,now:()=>T+tick,maximum:()=>maximum};
}
let count=0;async function test(name,fn){await fn();count++;console.log('ok '+name);}
(async()=>{
await test('portfolio endpoint returns validated native windows without raw source histories',async()=>{
  const e=env(),r=await e.run({feed:feed(2)});assert.equal(r.schemaVersion,1);assert.equal(r.methodVersion,'portfolio-periods-v1');assert.equal(r.source.succeeded,2);
  assert.deepEqual(r.accounts[address(1)].portfolio,API.compactPortfolio(normalizer.normalize.portfolio(sample(),T)));
  for(const call of e.calls){assert.equal(call.url,'https://api.hyperliquid.xyz/info');assert.deepEqual(call.body,{type:'portfolio',user:call.body.user});assert.equal(call.settings.redirect,'error');assert.equal(call.settings.credentials,'omit');}
  const json=JSON.stringify(r);assert(!json.includes('accountValueHistory'));assert(!json.includes('pnlHistory'));assert(e.maximum()<=2);assert.equal(e.timers.size,0);
});
await test('native windows and all three derived periods retain their real ranges and methods',async()=>{
  const r=await env(()=>response([...sample('week'),...sample('month'),...wide()])).run(),w=r.accounts[address(1)].portfolio.windows;
  assert.deepEqual(Object.keys(w).sort(),['180D','30D','365D','7D','90D','ALL'].sort());
  for(const key of ['90D','180D','365D']){const x=w[key];assert.equal(x.derived,true);assert.equal(x.roi,null);assert.equal(x.roiUnavailableReason,'cash_flow_adjusted_return_unavailable');assert.equal(x.coverageStatus,'full');assert.equal(x.mddMethod,'window_pnl_peak_equity');assert.equal(x.startAt,iso(T-parseInt(key)*DAY));assert.equal(x.endAt,iso(T));}
  assert.equal(w['30D'].requestedStartAt,null);assert.equal(w['30D'].mddMethod,'hyperliquid_ui_pnl_peak_equity');
});
await test('empty histories and single samples preserve null PnL and drawdown',async()=>{
  const r=await env(()=>response(sample('allTime',[],[],[]))).run(),w=r.accounts[address(1)].portfolio.windows;
  for(const x of Object.values(w)){assert.equal(x.pnl,null);assert.equal(x.mdd,null);assert.equal(x.sampleCount,0);assert.equal(x.coverageDays,0);assert.deepEqual(x.points,[]);}
  const one=await env(()=>response(sample('allTime',[T],[5],[100]))).run();assert.equal(one.accounts[address(1)].portfolio.windows['90D'].pnl,null);
});
await test('insufficient long history stays explicitly insufficient rather than inventing points',async()=>{
  const r=await env(()=>response(sample('allTime',[T-60*DAY,T],[10,20],[100,110]))).run(),w=r.accounts[address(1)].portfolio.windows;
  for(const key of ['90D','180D','365D']){assert.equal(w[key].coverageStatus,'insufficient_history');assert.equal(w[key].coverageDays,60);assert.equal(w[key].points.length,2);assert.equal(w[key].roi,null);}
});
await test('sampled boundary keeps the first actual point after cutoff',async()=>{
  const r=await env(()=>response(sample('allTime',[T-400*DAY,T-80*DAY,T],[0,10,20],[100,110,120]))).run(),w=r.accounts[address(1)].portfolio.windows;
  assert.equal(w['90D'].coverageStatus,'sampled_boundary');assert.equal(w['90D'].startAt,iso(T-80*DAY));assert.equal(w['90D'].requestedStartAt,iso(T-90*DAY));assert.equal(w['90D'].coverageDays,80);
});
await test('chart compaction preserves actual endpoints and computed metrics with original sample counts',async()=>{
  const times=Array.from({length:1000},(_,i)=>T-1000*DAY+i*DAY),pnl=times.map((_,i)=>i===420?900:i===810?-40:i%11),equity=times.map(()=>1000);
  const raw=sample('allTime',times,pnl,equity),normalized=normalizer.normalize.portfolio(raw,T),r=await env(()=>response(raw)).run(),stored=r.accounts[address(1)].portfolio;
  for(const [key,w] of Object.entries(stored.windows)){const source=normalized.windows[key];assert(w.points.length<=120);assert.equal(w.sampleCount,source.sampleCount);assert.equal(w.sourceSampleCount,source.sourceSampleCount);assert.equal(w.mdd,source.mdd);assert.deepEqual(w.points[0],source.points[0]);assert.deepEqual(w.points.at(-1),source.points.at(-1));const actual=new Set(source.points.map(p=>JSON.stringify(p)));assert(w.points.every(p=>actual.has(JSON.stringify(p))));}
});
await test('fresh persisted result bypasses network and retains earlier request-start time',async()=>{
  const p=previous([[1,600000]]);p.accounts[address(1)].lastAttemptAt=iso(T-601000);const e=env(()=>{throw Error('must not fetch');}),r=await e.run({previous:p});
  assert.equal(e.calls.length,0);assert.equal(r.source.cached,1);assert.equal(r.accounts[address(1)].fetchedAt,iso(T-600000));assert.equal(r.accounts[address(1)].lastAttemptAt,iso(T-601000));
});
await test('missing then oldest accounts are requested and unrelated cache records are pruned',async()=>{
  const e=env(),r=await e.run({feed:feed(3),previous:previous([[1,2400000],[3,1900000],[4,2000000]])});assert.deepEqual(e.calls.map(c=>c.body.user),[address(2),address(1),address(3)]);assert.equal(r.accounts[address(4)],undefined);
});
await test('invalid cache metadata cannot seed a fabricated metric',async()=>{
  for(const edit of [p=>{p.methodVersion='other';},p=>{p.generatedAt=iso(T+6000);},p=>{p.accounts[address(1)].portfolio.windows['30D'].sampleCount=1;},p=>{p.accounts[address(1)].portfolio.windows['30D'].pnl=999;},p=>{p.accounts[address(1)].portfolio.windows['30D'].points[0].value=2;},p=>{p.accounts[address(1)].portfolio.windows['30D'].sourceHistoryEndAt=iso(T-1000);},p=>{p.accounts[address(1)].portfolio.windows['30D'].mdd=-1;}]) {
    const p=previous([[1,0]]);edit(p);const e=env(),r=await e.run({previous:p});assert.equal(e.calls.length,1);assert.equal(r.accounts[address(1)].status,'ready');
  }
});
await test('cache exports only declared fields and strips unknown raw payload data',async()=>{
  const p=previous([[1,0]]);p.accounts[address(1)].portfolio.secret=[{raw:'not-published'}];p.accounts[address(1)].portfolio.windows['30D'].raw='not-published';
  const r=await env().run({previous:p});assert(!JSON.stringify(r).includes('not-published'));
});
await test('failed updates preserve the prior portfolio and original fetch time',async()=>{
  const e=env(()=>response('body must not leak',500)),r=await e.run({previous:previous([[1,1900000]])}),x=r.accounts[address(1)];
  assert.equal(x.status,'stale');assert.equal(x.fetchedAt,iso(T-1900000));assert.equal(x.lastAttemptAt,iso(T));assert.equal(x.errorCode,'http_500');assert(x.portfolio.windows['30D']);assert.equal(e.calls.length,1);assert(!JSON.stringify(r).includes('body must not leak'));
});
await test('stale cache is retried and an impossible unavailable cache is not resurrected',async()=>{
  for(const extra of [{status:'stale',errorCode:'network_error'},{status:'unavailable'},{status:'ready',errorCode:'http_500'}]){const e=env();await e.run({previous:previous([[1,0,extra]])});assert.equal(e.calls.length,1);}
});
await test('network failure with no good cache remains unavailable with a null portfolio',async()=>{
  const r=await env(()=>{throw Error('hidden-body');}).run();assert.equal(r.accounts[address(1)].status,'unavailable');assert.equal(r.accounts[address(1)].portfolio,null);assert.equal(r.accounts[address(1)].errorCode,'network_error');assert(!JSON.stringify(r).includes('hidden-body'));
});
await test('403 and 429 latch the whole batch, abort the other request and never retry',async()=>{
  for(const code of [403,429]){let aborted=0;const e=env((call,n)=>n===1?response('blocked',code):new Promise((_,reject)=>call.settings.signal.addEventListener('abort',()=>{aborted++;reject(Error('abort'));}))),r=await e.run({feed:feed(7)});
    assert.equal(e.calls.length,2);assert.equal(aborted,1);assert.equal(r.source.stopCode,'http_'+code);assert.equal(r.source.failed,2);assert.equal(r.source.unattempted,5);assert.equal(e.timers.size,0);}
});
await test('position-stage denial is propagated without starting any new info request',async()=>{
  for(const kind of ['position','fallback'])for(const code of ['http_403','http_429']){const f=feed();if(kind==='position')f.source.positionVerification.stopCode=code;else f.source.errorCode=code;
    const e=env(),r=await e.run({feed:f,previous:previous([[1,0]])});assert.equal(e.calls.length,0);assert.equal(r.accounts[address(1)].status,'stale');assert.equal(r.source.stopCode,code);}
});
await test('two hundred qualified accounts fit in seven minutes under the 600 weight quota',async()=>{
  const e=env(),r=await e.run({feed:feed(200)});assert.equal(r.source.succeeded,200);assert.equal(r.source.stopCode,null);assert.equal(r.source.unattempted,0);assert.equal(e.calls[30].at,60000);assert.equal(e.calls[180].at,360000);
  for(const call of e.calls){const batch=e.calls.filter(c=>c.at>call.at-60000&&c.at<=call.at);assert(batch.length*20<=600);}assert(e.now()<T+7*60000);
});
await test('batch deadline includes quota waits and preserves unattempted cache timestamps',async()=>{
  const e=env(()=>response(),{limits:{batchMs:30000}}),r=await e.run({feed:feed(35),previous:previous([[35,1900000]])});
  assert.equal(e.calls.length,30);assert.equal(r.source.stopCode,'batch_timeout');assert.equal(r.source.unattempted,5);assert.equal(r.accounts[address(35)].fetchedAt,iso(T-1900000));assert.equal(r.accounts[address(35)].lastAttemptAt,iso(T-1900000));
});
await test('timeout cancels once and a partial request window never launches',async()=>{
  let aborted=0;const e=env(call=>new Promise((_,reject)=>call.settings.signal.addEventListener('abort',()=>{aborted++;reject(Error('abort'));}))),r=await e.run();assert.equal(e.calls.length,1);assert.equal(aborted,1);assert.equal(r.accounts[address(1)].errorCode,'request_timeout');
  const small=env(()=>response(),{limits:{batchMs:1000}}),s=await small.run();assert.equal(small.calls.length,0);assert.equal(s.source.stopCode,'batch_timeout');
});
await test('malformed responses do not replace last-good portfolio',async()=>{
  for(const reply of [response('bad json'),response('<html>',200,{'content-type':'text/html'}),response('{}',200,{'content-length':String(API.LIMITS.maxBytes+1)}),response(sample('month',[T+6000],[0],[100]))]){
    const r=await env(()=>reply).run({previous:previous([[1,1900000]])});assert.equal(r.accounts[address(1)].status,'stale');assert.equal(r.accounts[address(1)].fetchedAt,iso(T-1900000));}
});
await test('zero or stale holdings are excluded from persistent outputs',async()=>{
  const f=feed(3);f.traders[0].positionCheck.count=0;delete f.traders[1].positionCheck;f.traders[2].positionCheck.checkedAt=iso(T-3600001);
  const e=env(),r=await e.run({feed:f,previous:previous([[1,0]])});assert.equal(e.calls.length,0);assert.deepEqual(r.accounts,{});
});
await test('invalid addresses and candidate counts fail before network use',async()=>{
  const f=feed();f.traders[0].accountId='bad';const e=env();await assert.rejects(e.run({feed:f}),/invalid_feed/);assert.equal(e.calls.length,0);await assert.rejects(e.run({feed:feed(201)}),/invalid_feed/);
});
await test('read and write enforce twelve MiB without partial replacement',async()=>{
  assert.equal(API.LIMITS.maxFileBytes,12*1024*1024);
  await assert.rejects(API.readFileJson('/fake',{stat:async()=>({size:API.LIMITS.maxFileBytes+1})}),/cache_file_too_large/);
  let wrote=false;await assert.rejects(API.atomicWrite('/fake',{body:'x'.repeat(API.LIMITS.maxFileBytes)},{mkdir:async()=>{},writeFile:async()=>{wrote=true;}}),/cache_file_too_large/);assert.equal(wrote,false);
});
await test('atomic storage cleans a failed rename and CLI uses injected IO',async()=>{
  const files=new Map([['/test/feed.json',JSON.stringify(feed())]]),logs=[],io={stat:async f=>{if(!files.has(f)){const e=Error('missing');e.code='ENOENT';throw e;}return{size:Buffer.byteLength(files.get(f))};},readFile:async f=>files.get(f),mkdir:async()=>{},writeFile:async(f,v)=>files.set(f,v),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlink:async f=>files.delete(f)};
  const r=await API.main(['--feed','/test/feed.json','--output','/test/portfolios.json'],{io,fetch:async()=>response(),now:()=>T,log:x=>logs.push(x)});assert(r.accounts[address(1)].portfolio.windows['30D']);assert(files.has('/test/portfolios.json'));assert.equal(logs.length,1);
});

await test('coverage and full-sample gap metadata cannot be silently corrupted',async()=>{
  for(const change of [w=>{w.coverageDays=null;},w=>{w.coverageDays=999;},w=>{w.maxSampleGapMs=1;},w=>{w.sourceSampleCount=1;}]){const p=previous([[1,0]]);change(p.accounts[address(1)].portfolio.windows['30D']);const e=env();await e.run({previous:p});assert.equal(e.calls.length,1);}
});
await test('derived windows cannot publish invented ROI or relabel incomplete boundaries as full',async()=>{
  const raw=sample('allTime',[T-400*DAY,T-80*DAY,T],[0,10,20],[100,110,120]),p={schemaVersion:1,methodVersion:API.METHOD_VERSION,generatedAt:iso(T),accounts:{[address(1)]:{status:'ready',fetchedAt:iso(T),lastAttemptAt:iso(T),errorCode:null,portfolio:API.compactPortfolio(normalizer.normalize.portfolio(raw,T))}}};
  for(const change of [w=>{w.roi=10;},w=>{w.coverageStatus='full';},w=>{w.requestedStartAt=w.startAt;}]){const bad=JSON.parse(JSON.stringify(p));change(bad.accounts[address(1)].portfolio.windows['90D']);const e=env();await e.run({previous:bad});assert.equal(e.calls.length,1);}
});
console.log('PASS '+count+' offline portfolio collector tests');
})().catch(error=>{console.error(error);process.exitCode=1;});
