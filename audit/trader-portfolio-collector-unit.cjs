'use strict';
/* All samples, network replies, file operations and clocks in this test are offline. */
const assert=require('node:assert/strict');
const API=require('../scripts/collect_trader_portfolios.cjs');
const normalizer=require('../trader/account-analytics.js');
const T=1800000000000,DAY=86400000,iso=t=>new Date(t).toISOString(),address=i=>'0x'+i.toString(16).padStart(40,'0');
const sample=(period='perpMonth',times=[T-2000,T-1000,T],pnl=[0,10,5],equity=[100,110,105])=>[[period,{pnlHistory:times.map((t,i)=>[t,String(pnl[i])]),accountValueHistory:times.map((t,i)=>[t,String(equity[i])])}]];
const wide=()=>sample('perpAllTime',[T-400*DAY,T-365*DAY,T-200*DAY,T-180*DAY,T-100*DAY,T-90*DAY,T-60*DAY,T],[0,10,20,30,25,40,35,50],[100,110,120,130,125,140,135,150]);
const feed=(n=1)=>({source:{id:'hyperliquid',status:'ok',positionVerification:{scope:'default_perp_dex',completedAt:iso(T)}},traders:Array.from({length:n},(_,i)=>({accountId:address(i+1),exchange:'Hyperliquid',sourceKind:'public_account',positionCheck:{scope:'default_perp_dex',count:1,checkedAt:iso(T),sourceTime:iso(T-1000)}}))});
const response=(payload=sample(),status=200,headers={})=>({status,headers:{get:key=>({'content-type':'application/json',...headers})[key]??null},text:async()=>typeof payload==='string'?payload:JSON.stringify(payload)});
function previous(records) {
  return {schemaVersion:1,methodVersion:API.METHOD_VERSION,generatedAt:iso(T),accounts:Object.fromEntries(records.map(([id,age=0,extra={}])=>[address(id),{status:'ready',fetchedAt:iso(T-age),lastAttemptAt:iso(T-age),errorCode:null,portfolio:API.compactPortfolio(normalizer.normalize.portfolio(sample('perpMonth',[T-age-2000,T-age-1000,T-age]),T-age)),...extra}]))};
}
function env(handler=()=>response(),options={}) {
  let tick=0,serial=0,live=0,maximum=0;const timers=new Map(),calls=[];
  const setTimer=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:tick+ms});return id;},clearTimer=id=>timers.delete(id);
  const flush=async()=>{for(let i=0;i<2000;i++)await Promise.resolve();};
  const fetch=async(url,settings)=>{const call={url,settings,body:JSON.parse(settings.body),at:tick};calls.push(call);live++;maximum=Math.max(maximum,live);try{return await (call.body.type==='userNonFundingLedgerUpdates'?(options.ledgerHandler||(()=>response([])))(call,calls.length):handler(call,calls.length));}finally{live--;}};
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
  const e=env(),r=await e.run({feed:feed(2)});assert.equal(r.schemaVersion,1);assert.equal(r.methodVersion,'portfolio-periods-v2');assert.equal(r.source.succeeded,2);assert.equal(r.source.refreshIntervalMinutes,360);assert.equal(r.source.staleAfterMinutes,60);assert.equal(API.LIMITS.freshMs,30*60000);
  assert.deepEqual(r.accounts[address(1)].portfolio,API.compactPortfolio(normalizer.normalize.portfolio(sample(),T)));
  for(const call of e.calls){assert.equal(call.url,'https://api.hyperliquid.xyz/info');assert.deepEqual(call.body,{type:'portfolio',user:call.body.user});assert.equal(call.settings.redirect,'error');assert.equal(call.settings.credentials,'omit');}
  const json=JSON.stringify(r);assert(!json.includes('accountValueHistory'));assert(!json.includes('pnlHistory'));assert(e.maximum()<=2);assert.equal(e.timers.size,0);
});
await test('native windows and all three derived periods retain their real ranges and methods',async()=>{
  const r=await env(()=>response([...sample('perpWeek'),...sample('perpMonth'),...wide()])).run(),w=r.accounts[address(1)].portfolio.windows;
  assert.deepEqual(Object.keys(w).sort(),['180D','30D','365D','7D','90D','ALL'].sort());
  for(const key of ['90D','180D','365D']){const x=w[key];assert.equal(x.derived,true);assert.equal(typeof x.roi,'number');assert.equal(x.roiUnavailableReason,null);assert.equal(x.roiEvidence.historyComplete,false);assert.equal(x.coverageStatus,'full');assert.equal(x.mddMethod,'window_pnl_peak_equity');assert.equal(x.startAt,iso(T-parseInt(key)*DAY));assert.equal(x.endAt,iso(T));}
  assert.equal(w['30D'].requestedStartAt,null);assert.equal(w['30D'].mddMethod,'hyperliquid_ui_pnl_peak_equity');
});
await test('empty histories and single samples preserve null PnL and drawdown',async()=>{
  const r=await env(()=>response(sample('perpAllTime',[],[],[]))).run(),w=r.accounts[address(1)].portfolio.windows;assert.equal(r.source.available,1);assert.equal(r.accounts[address(1)].status,'ready');assert.equal(Object.keys(w).length,4);
  for(const x of Object.values(w)){assert.equal(x.pnl,null);assert.equal(x.mdd,null);assert.equal(x.sampleCount,0);assert.equal(x.coverageDays,0);assert.deepEqual(x.points,[]);}
  const one=await env(()=>response(sample('perpAllTime',[T],[5],[100]))).run();assert.equal(one.accounts[address(1)].portfolio.windows['90D'].pnl,null);
});
await test('insufficient long history stays explicitly insufficient rather than inventing points',async()=>{
  const r=await env(()=>response(sample('perpAllTime',[T-60*DAY,T],[10,20],[100,110]))).run(),w=r.accounts[address(1)].portfolio.windows;
  for(const key of ['90D','180D','365D']){assert.equal(w[key].coverageStatus,'insufficient_history');assert.equal(w[key].coverageDays,60);assert.equal(w[key].points.length,2);assert.equal(w[key].roi,null);}
});
await test('sampled boundary keeps the first actual point after cutoff',async()=>{
  const r=await env(()=>response(sample('perpAllTime',[T-400*DAY,T-80*DAY,T],[0,10,20],[100,110,120]))).run(),w=r.accounts[address(1)].portfolio.windows;
  assert.equal(w['90D'].coverageStatus,'sampled_boundary');assert.equal(w['90D'].startAt,iso(T-80*DAY));assert.equal(w['90D'].requestedStartAt,iso(T-90*DAY));assert.equal(w['90D'].coverageDays,80);
});
await test('chart compaction preserves actual endpoints and computed metrics with original sample counts',async()=>{
  const times=Array.from({length:1000},(_,i)=>T-1000*DAY+i*DAY),pnl=times.map((_,i)=>i===420?900:i===810?-40:i%11),equity=times.map(()=>1000);
  const raw=sample('perpAllTime',times,pnl,equity),normalized=normalizer.normalize.portfolio(raw,T),r=await env(()=>response(raw)).run(),stored=r.accounts[address(1)].portfolio;
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
await test('two hundred accounts needing no ledger fit in seven minutes under the 600 weight quota',async()=>{
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
  for(const reply of [response('bad json'),response('<html>',200,{'content-type':'text/html'}),response('{}',200,{'content-length':String(API.LIMITS.maxBytes+1)}),response(sample('perpMonth',[T+6000],[0],[100]))]){
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
  const raw=sample('perpAllTime',[T-400*DAY,T-80*DAY,T],[0,10,20],[100,110,120]),p={schemaVersion:1,methodVersion:API.METHOD_VERSION,generatedAt:iso(T),accounts:{[address(1)]:{status:'ready',fetchedAt:iso(T),lastAttemptAt:iso(T),errorCode:null,portfolio:API.compactPortfolio(normalizer.normalize.portfolio(raw,T))}}};
  for(const change of [w=>{w.roi=10;},w=>{w.coverageStatus='full';},w=>{w.requestedStartAt=w.startAt;}]){const bad=JSON.parse(JSON.stringify(p));change(bad.accounts[address(1)].portfolio.windows['90D']);const e=env();await e.run({previous:bad});assert.equal(e.calls.length,1);}
});

await test('v1 portfolio caches are rejected rather than relabeled as perpetual v2 data',async()=>{
  const old=previous([[1,0]]);old.methodVersion='portfolio-periods-v1';
  const e=env(),r=await e.run({previous:old});assert.equal(e.calls.length,1);assert.equal(r.methodVersion,'portfolio-periods-v2');assert.equal(r.accounts[address(1)].portfolio.windows['30D'].scope,'perp_account');assert.equal(r.accounts[address(1)].portfolio.windows['30D'].sourcePeriod,'perpMonth');
  const failed=await env(()=>response('source failed',500)).run({previous:old});assert.equal(failed.accounts[address(1)].portfolio,null);assert.equal(failed.accounts[address(1)].fetchedAt,null);assert.equal(failed.accounts[address(1)].status,'unavailable');
});
await test('v2 cache cannot carry old all-account scope or non-perpetual source periods',async()=>{
  for(const change of [w=>{w.scope='all_account';},w=>{w.sourcePeriod='month';},w=>{w.sourcePeriod='perpWeek';}]){const bad=previous([[1,0]]);change(bad.accounts[address(1)].portfolio.windows['30D']);const e=env();await e.run({previous:bad});assert.equal(e.calls.length,1);}
});

await test('failed v1 migration preserves the file byte-for-byte and stops before publishing',async()=>{
  const old=previous([[1,1900000]]);old.methodVersion='portfolio-periods-v1';const original=JSON.stringify(old),files=new Map([['/test/feed.json',JSON.stringify(feed())],['/test/portfolios.json',original]]);let writes=0,calls=0;
  const io={stat:async f=>({size:Buffer.byteLength(files.get(f))}),readFile:async f=>files.get(f),mkdir:async()=>{},writeFile:async(f,v)=>{writes++;files.set(f,v);},rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlink:async f=>files.delete(f)};
  await assert.rejects(API.main(['--feed','/test/feed.json','--output','/test/portfolios.json'],{io,now:()=>T,fetch:async()=>{calls++;return response('unavailable',503);},log:()=>{}}),/migration_no_verified_portfolios/);
  assert.equal(calls,1);assert.equal(writes,0);assert.equal(files.get('/test/portfolios.json'),original);
});
await test('an upstream denial during migration neither sends requests nor overwrites legacy data',async()=>{
  const old=previous([[1,0]]);old.methodVersion='portfolio-periods-v1';const f=feed();f.source.positionVerification.stopCode='http_429';const original=JSON.stringify(old),files=new Map([['/test/feed.json',JSON.stringify(f)],['/test/portfolios.json',original]]);let calls=0;
  const io={stat:async name=>({size:Buffer.byteLength(files.get(name))}),readFile:async name=>files.get(name),writeFile:async()=>{throw Error('must not write');}};
  await assert.rejects(API.main(['--feed','/test/feed.json','--output','/test/portfolios.json'],{io,now:()=>T,fetch:async()=>{calls++;return response();},log:()=>{}}),/migration_no_verified_portfolios/);assert.equal(calls,0);assert.equal(files.get('/test/portfolios.json'),original);
});
await test('partial verified migration publishes only new v2 values and leaves failed accounts null',async()=>{
  const old=previous([[1,1900000],[2,1900000]]);old.methodVersion='portfolio-periods-v1';const files=new Map([['/test/feed.json',JSON.stringify(feed(2))],['/test/portfolios.json',JSON.stringify(old)]]);let calls=0;
  const io={stat:async f=>({size:Buffer.byteLength(files.get(f))}),readFile:async f=>files.get(f),mkdir:async()=>{},writeFile:async(f,v)=>files.set(f,v),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlink:async f=>files.delete(f)};
  const result=await API.main(['--feed','/test/feed.json','--output','/test/portfolios.json'],{io,now:()=>T,fetch:async()=>response(++calls===1?sample():'unavailable',calls===1?200:503),log:()=>{}});
  assert.equal(result.methodVersion,'portfolio-periods-v2');assert.equal(result.source.available,1);assert.equal(result.accounts[address(1)].portfolio.windows['30D'].scope,'perp_account');assert.equal(result.accounts[address(2)].portfolio,null);assert.equal(JSON.parse(files.get('/test/portfolios.json')).methodVersion,'portfolio-periods-v2');
});
await test('already-v2 failures retain their last good values under the existing semantics',async()=>{
  const old=previous([[1,1900000]]),files=new Map([['/test/feed.json',JSON.stringify(feed())],['/test/portfolios.json',JSON.stringify(old)]]);
  const io={stat:async f=>({size:Buffer.byteLength(files.get(f))}),readFile:async f=>files.get(f),mkdir:async()=>{},writeFile:async(f,v)=>files.set(f,v),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlink:async f=>files.delete(f)};
  const result=await API.main(['--feed','/test/feed.json','--output','/test/portfolios.json'],{io,now:()=>T,fetch:async()=>response('unavailable',503),log:()=>{}});assert.equal(result.accounts[address(1)].status,'stale');assert.equal(result.accounts[address(1)].fetchedAt,old.accounts[address(1)].fetchedAt);assert.deepEqual(result.accounts[address(1)].portfolio,old.accounts[address(1)].portfolio);
});

await test('unrecognized all-account-only response cannot count as a verified perpetual portfolio',async()=>{
  assert.equal(API.validPortfolio({windows:{}},T),null);
  const oldShape=[...sample('week'),...sample('month'),...sample('allTime')];
  const r=await env(()=>response(oldShape)).run();assert.equal(r.accounts[address(1)].portfolio,null);assert.equal(r.accounts[address(1)].errorCode,'invalid_response');assert.equal(r.source.available,0);assert.equal(r.source.failed,1);
});
await test('HTTP 200 with no recognized perpetual windows cannot bypass migration protection',async()=>{
  const old=previous([[1,1900000]]);old.methodVersion='portfolio-periods-v1';const original=JSON.stringify(old),files=new Map([['/test/feed.json',JSON.stringify(feed())],['/test/portfolios.json',original]]);let writes=0;
  const io={stat:async f=>({size:Buffer.byteLength(files.get(f))}),readFile:async f=>files.get(f),mkdir:async()=>{},writeFile:async()=>{writes++;},rename:async()=>{},unlink:async()=>{}};
  await assert.rejects(API.main(['--feed','/test/feed.json','--output','/test/portfolios.json'],{io,now:()=>T,fetch:async()=>response(sample('allTime')),log:()=>{}}),/migration_no_verified_portfolios/);
  assert.equal(writes,0);assert.equal(files.get('/test/portfolios.json'),original);
});

await test('top-level migration failure retains its precise public-safe log code',()=>{
  assert.deepEqual(API.failureReport(Error('migration_no_verified_portfolios')),{status:'failed',errorCode:'migration_no_verified_portfolios'});
  assert.deepEqual(API.failureReport(Error('do-not-log-body-or-credentials')),{status:'failed',errorCode:'invalid_response'});
  const bad=previous([[1,0,{status:'stale',errorCode:'migration_no_verified_portfolios'}]]);assert.deepEqual(API.validatedCache(bad,[address(1)],T),{});
});
const event=(n,t,delta={type:'deposit',usdc:'0'})=>({time:t,hash:'0x'+n.toString(16).padStart(64,'0'),delta});
async function roiPrevious(){const prior=await env(()=>response(wide())).run();prior.accounts[address(1)].status='stale';prior.accounts[address(1)].errorCode='network_error';return prior;}
await test('short ledger pages require inclusive-tail confirmation and retain account-bound evidence',async()=>{
  const rows=[event(1,T-80*DAY),event(2,T-40*DAY)],e=env(()=>response(wide()),{ledgerHandler:call=>response(rows.filter(r=>r.time>=call.body.startTime&&r.time<=call.body.endTime))}),r=await e.run();
  const calls=e.calls.filter(c=>c.body.type==='userNonFundingLedgerUpdates');assert.equal(calls.length,4);assert.equal(calls[0].body.startTime,T-90*DAY);assert.equal(calls[1].body.startTime,rows[1].time);assert.equal(calls[0].body.endTime,T);assert.equal(calls[2].body.endTime,T-90*DAY);assert.equal(calls[3].body.endTime,T-180*DAY);
  const w=r.accounts[address(1)].portfolio.windows['90D'];assert.equal(w.roiEvidence.recordCount,2);assert.equal(w.roiEvidence.pageCount,2);assert.equal(w.roiEvidence.accountId,address(1));assert.equal(w.roiEvidence.queryExhausted,true);assert.equal(w.roiEvidence.historyComplete,false);
  const e2=env(()=>{throw Error('fresh cache must not fetch');}),r2=await e2.run({previous:r});assert.equal(e2.calls.length,0);assert.deepEqual(r2.accounts[address(1)].portfolio,r.accounts[address(1)].portfolio);
  const foreign=JSON.parse(JSON.stringify(r));foreign.accounts[address(2)]=foreign.accounts[address(1)];delete foreign.accounts[address(1)];assert.deepEqual(API.validatedCache(foreign,[address(2)],T),{});
  assert(!JSON.stringify(r).includes(rows[0].hash));assert.equal(r.source.requestCount,5);assert.equal(r.source.ledgerRequests,4);assert.equal(r.source.roiAccounts,1);
});
await test('deposit and withdrawal between sampled endpoints increase capital despite net-zero flows',async()=>{
  const raw=sample('perpAllTime',[T-400*DAY,T-365*DAY,T-90*DAY,T],[0,0,0,50],[100,100,100,150]);
  const rows=[event(1,T-80*DAY,{type:'deposit',usdc:'100'}),event(2,T-40*DAY,{type:'withdraw',usdc:'100',fee:'0'})];
  const r=await env(()=>response(raw),{ledgerHandler:call=>response(rows.filter(x=>x.time>=call.body.startTime&&x.time<=call.body.endTime))}).run(),w=r.accounts[address(1)].portfolio.windows['90D'];
  assert.equal(w.roi,25);assert.equal(w.roiEvidence.capitalBase,200);assert.equal(w.roiEvidence.maxNetDeposits,100);assert.equal(w.roiEvidence.relevantCount,2);
});
await test('actual 2000-row pages are accepted with overlap deduplicated on the next request',async()=>{
  const start=T-80*DAY,rows=Array.from({length:2001},(_,i)=>event(i+1,start+i));
  const e=env(()=>response(wide()),{ledgerHandler:call=>response(rows.filter(r=>r.time>=call.body.startTime&&r.time<=call.body.endTime).slice(0,2000))}),r=await e.run(),calls=e.calls.filter(c=>c.body.type==='userNonFundingLedgerUpdates');
  assert.equal(calls.length,5);assert.equal(calls[1].body.startTime,start+1999);assert.equal(calls[2].body.startTime,start+2000);assert.equal(r.accounts[address(1)].portfolio.windows['90D'].roiEvidence.recordCount,2001);assert.equal(r.source.succeeded,1);
});
await test('saturated same-timestamp pages and exhausted page caps fail closed without replacing last-good',async()=>{
  for(const saturated of [true,false]){
    let seq=0;const old=await roiPrevious(),e=env(()=>response(wide()),{ledgerHandler:call=>response(Array.from({length:2000},(_,i)=>event(++seq,call.body.startTime+(saturated?0:i+1))))}),r=await e.run({previous:old});
    assert.equal(r.accounts[address(1)].errorCode,'invalid_response');assert.equal(r.accounts[address(1)].status,'stale');assert.equal(r.accounts[address(1)].fetchedAt,old.accounts[address(1)].fetchedAt);assert.deepEqual(r.accounts[address(1)].portfolio,old.accounts[address(1)].portfolio);
    assert.equal(r.source.ledgerRequests,saturated?1:10);assert.equal(e.timers.size,0);
  }
});
await test('empty ledger traversal can establish no reported flows but never claims complete account history',async()=>{
  const e=env(()=>response(wide())),r=await e.run(),w=r.accounts[address(1)].portfolio.windows['365D'];assert.equal(r.source.ledgerRequests,3);assert.equal(w.roiEvidence.recordCount,0);assert.equal(w.roiEvidence.pageCount,3);assert.equal(w.roiEvidence.historyComplete,false);assert.equal(w.roiEvidence.queryExhausted,true);
});
await test('no eligible long history sends no ledger request',async()=>{
  for(const raw of [sample(),sample('perpAllTime',[],[],[]),sample('perpAllTime',[T],[0],[100]),sample('perpAllTime',[T-60*DAY,T],[0,10],[100,110])]){
    const e=env(()=>response(raw),{ledgerHandler:()=>{throw Error('must not fetch ledger');}}),r=await e.run();assert.equal(e.calls.length,1);assert.equal(r.source.ledgerRequests,0);assert.equal(r.source.succeeded,1);
  }
});
await test('ledger network and parsing errors preserve complete prior portfolio and timestamp',async()=>{
  for(const handler of [()=>{throw Error('network secrets');},()=>response('bad json'),()=>response([],200,{'content-type':'text/html'}),()=>response([],200,{'content-length':String(API.LIMITS.maxBytes+1)}),()=>response([event(1,T+1)]),()=>response(Array.from({length:2001},(_,i)=>event(i+1,T-1000+i)))]){
    const old=await roiPrevious(),e=env(()=>response(wide()),{ledgerHandler:handler}),r=await e.run({previous:old}),x=r.accounts[address(1)];assert.equal(x.status,'stale');assert.equal(x.fetchedAt,old.accounts[address(1)].fetchedAt);assert.deepEqual(x.portfolio,old.accounts[address(1)].portfolio);assert.equal(r.source.succeeded,0);assert(!JSON.stringify(r).includes('network secrets'));assert.equal(e.timers.size,0);
  }
});
await test('ledger timeouts retain old ROI evidence and abort once',async()=>{
  const prior=await env(()=>response(wide())).run();let aborted=0;
  const e=env(()=>response(wide()),{ledgerHandler:call=>new Promise((_,reject)=>call.settings.signal.addEventListener('abort',()=>{aborted++;reject(Error('abort'));}))});
  // Force a legitimate retry while preserving the earlier source times and evidence.
  prior.accounts[address(1)].status='stale';prior.accounts[address(1)].errorCode='network_error';
  const r=await e.run({previous:prior}),x=r.accounts[address(1)];assert.equal(x.errorCode,'request_timeout');assert.equal(x.fetchedAt,prior.accounts[address(1)].fetchedAt);assert.deepEqual(x.portfolio,prior.accounts[address(1)].portfolio);assert.equal(aborted,1);assert.equal(e.timers.size,0);
});
await test('ledger 403 and 429 stop all accounts and prevent every subsequent request',async()=>{
  for(const code of [403,429]){let aborted=0;const seen=new Map(),e=env(()=>response(wide()),{ledgerHandler:call=>{const n=(seen.get(call.body.user)||0)+1;seen.set(call.body.user,n);if(n===1)return response([event(1,T-40*DAY)]);if(call.body.user===address(1))return response('denied',code);return new Promise((_,reject)=>call.settings.signal.addEventListener('abort',()=>{aborted++;reject(Error('abort'));}));}}),r=await e.run({feed:feed(5)});
    assert.equal(r.source.stopCode,'http_'+code);assert.equal(r.source.attempted,2);assert.equal(r.source.unattempted,3);assert.equal(r.source.failed,2);assert.equal(e.calls.length,6);assert.equal(aborted,1);assert.equal(e.timers.size,0);
  }
});
await test('mixed portfolio and ledger requests share the sliding 600-weight quota and concurrency cap',async()=>{
  const e=env(()=>response(wide())),r=await e.run({feed:feed(8)});assert.equal(r.source.succeeded,8);assert.equal(r.source.ledgerRequests,24);assert.equal(r.source.requestCount,32);assert.equal(r.source.maxBatchMinutes,7);assert.equal(r.source.ledgerRequestWeight,120);assert(e.maximum()<=2);
  for(const call of e.calls){const used=e.calls.filter(c=>c.at>call.at-60000&&c.at<=call.at).reduce((sum,c)=>sum+(c.body.type==='portfolio'?20:120),0);assert(used<=600,`weight ${used} at ${call.at}`);}assert(e.calls.some(c=>c.at>=60000));assert.equal(e.timers.size,0);
});
await test('ledger quota wait obeys batch deadline and a later run prioritizes unattempted older accounts',async()=>{
  const e=env(()=>response(wide()),{limits:{batchMs:30000,weightPerMinute:140}}),r=await e.run({feed:feed(3),previous:previous([[3,1900000]])});
  assert.equal(r.source.stopCode,'batch_timeout');assert.equal(r.source.succeeded,0);assert.equal(r.source.failed,2);assert.equal(r.source.unattempted,1);assert.equal(r.source.ledgerRequests,0);assert.equal(r.accounts[address(3)].lastAttemptAt,iso(T-1900000));assert.equal(e.timers.size,0);
  const next=env(undefined,{now:()=>T+30000});await next.run({feed:feed(3),previous:r});assert.equal(next.calls[0].body.user,address(3));
});
await test('ledger reconciliation failure is an unavailable ROI with fresh real portfolio rather than transport failure',async()=>{
  const raw=sample('perpAllTime',[T-400*DAY,T-365*DAY,T-90*DAY,T],[0,0,0,50],[100,100,100,100]);
  const r=await env(()=>response(raw)).run(),x=r.accounts[address(1)];assert.equal(x.status,'ready');assert.equal(x.fetchedAt,iso(T));assert.equal(r.source.succeeded,1);assert.equal(r.source.failed,0);assert.equal(x.portfolio.windows['90D'].pnl,50);assert.equal(x.portfolio.windows['90D'].roi,null);assert.equal(x.portfolio.windows['90D'].roiUnavailableReason,'ledger_reconciliation_failed');
});
await test('unavailable attempt metadata survives validation without allowing data or future timestamps',async()=>{
  const p={schemaVersion:1,methodVersion:API.METHOD_VERSION,generatedAt:iso(T),accounts:{[address(1)]:{status:'unavailable',fetchedAt:null,portfolio:null,lastAttemptAt:iso(T-1000),errorCode:'request_timeout'}}};
  assert.equal(API.validatedCache(p,[address(1)],T)[address(1)].lastAttemptAt,iso(T-1000));
  for(const alter of [x=>x.lastAttemptAt=iso(T+10000),x=>x.portfolio={},x=>x.fetchedAt=iso(T),x=>x.errorCode='secret error',x=>x.lastAttemptAt='invalid']){const bad=JSON.parse(JSON.stringify(p));alter(bad.accounts[address(1)]);assert.deepEqual(API.validatedCache(bad,[address(1)],T),{});}
});
await test('failed cold ledger saves only its verified base curve with the true portfolio response time',async()=>{
  const e=env(()=>response(wide()),{ledgerHandler:()=>new Promise(()=>{})}),r=await e.run(),x=r.accounts[address(1)];
  assert.equal(x.status,'stale');assert.equal(x.errorCode,'request_timeout');assert.equal(x.fetchedAt,iso(T));assert.equal(r.generatedAt,iso(T+10000));assert.equal(r.source.available,1);assert.equal(r.source.succeeded,0);assert.equal(r.source.failed,1);assert.equal(x.portfolio.windows['90D'].roi,null);assert.equal(x.portfolio.windows['90D'].roiUnavailableReason,'ledger_unavailable');assert.equal(x.portfolio.windows.ALL.pnl,50);assert.equal(e.timers.size,0);
  for(const code of [403,429]){const rejected=await env(()=>response(wide()),{ledgerHandler:()=>response('denied',code)}).run();assert.equal(rejected.accounts[address(1)].portfolio,null);assert.equal(rejected.accounts[address(1)].fetchedAt,null);assert.equal(rejected.source.stopCode,'http_'+code);}
});
await test('eight heavy ledger accounts rotate after the seven-minute budget instead of starving the tail',async()=>{
  let seq=0;const options={ledgerHandler:call=>response(Array.from({length:2000},(_,i)=>event(++seq,call.body.startTime+i+1)))},a=env(()=>response(wide()),options),first=await a.run({feed:feed(8)});
  assert.equal(first.source.stopCode,'batch_timeout');assert(first.source.attempted<8);assert.equal(first.source.attempted,first.source.succeeded+first.source.failed);assert(first.source.available>0);
  const tried=new Set(a.calls.filter(c=>c.body.type==='portfolio').map(c=>c.body.user)),untried=Array.from({length:8},(_,i)=>address(i+1)).filter(x=>!tried.has(x));assert(untried.length>0);
  // Later wall-clock time validates the previous batch while fake monotonic time
  // still starts at zero for its independent seven-minute budget.
  const b=env(()=>response(wide()),{...options,now:()=>T+8*60000}),later=feed(8);for(const row of later.traders){row.positionCheck.checkedAt=iso(T+8*60000);row.positionCheck.sourceTime=iso(T+8*60000-1000);}
  const second=await b.run({feed:later,previous:first});
  assert.equal(b.calls[0].body.user,untried[0]);const secondTried=new Set(b.calls.filter(c=>c.body.type==='portfolio').map(c=>c.body.user));assert(untried.every(x=>secondTried.has(x)));assert.equal(second.source.attempted,second.source.succeeded+second.source.failed);assert.equal(a.timers.size,0);assert.equal(b.timers.size,0);
});
await test('quarter and half-year results survive a longer annual ledger cap within one shared ten-page budget',async()=>{
  let seq=0;const e=env(()=>response(wide()),{ledgerHandler:call=>call.body.startTime>=T-180*DAY?response([]):response(Array.from({length:2000},(_,i)=>event(++seq,call.body.startTime+i+1)))}),r=await e.run(),x=r.accounts[address(1)];
  assert.equal(r.source.ledgerRequests,10);assert.equal(r.source.failed,1);assert.equal(x.status,'stale');assert.equal(x.errorCode,'invalid_response');assert.equal(typeof x.portfolio.windows['90D'].roi,'number');assert.equal(typeof x.portfolio.windows['180D'].roi,'number');assert.equal(x.portfolio.windows['365D'].roi,null);assert.equal(x.portfolio.windows['365D'].roiUnavailableReason,'ledger_unavailable');assert.equal(x.portfolio.windows['90D'].roiEvidence.pageCount,1);assert.equal(x.portfolio.windows['180D'].roiEvidence.pageCount,2);
  assert.equal(x.fetchedAt,x.portfolio.windows['180D'].roiEvidence.ledgerFetchedAt);assert.equal(e.timers.size,0);
});
await test('later transport failure preserves a new confirmed quarter but never mixes it into an old proven record',async()=>{
  const options={ledgerHandler:call=>call.body.startTime>=T-90*DAY?response([]):response('unavailable',503)};
  const fresh=await env(()=>response(wide()),options).run(),x=fresh.accounts[address(1)];assert.equal(x.status,'stale');assert.equal(x.errorCode,'http_503');assert.equal(typeof x.portfolio.windows['90D'].roi,'number');assert.equal(x.portfolio.windows['180D'].roi,null);assert.equal(x.fetchedAt,iso(T));
  const old=await roiPrevious(),raw=wide();raw[0][1].pnlHistory.at(-1)[1]='60';raw[0][1].accountValueHistory.at(-1)[1]='160';
  const after=await env(()=>response(raw),options).run({previous:old});assert.deepEqual(after.accounts[address(1)].portfolio,old.accounts[address(1)].portfolio);assert.equal(after.accounts[address(1)].fetchedAt,old.accounts[address(1)].fetchedAt);
});
await test('source denial after confirmed short windows still discards this account new results and stops the batch',async()=>{
  for(const code of [403,429]){const e=env(()=>response(wide()),{ledgerHandler:call=>call.body.startTime>=T-180*DAY?response([]):response('denied',code)}),r=await e.run();assert.equal(r.source.stopCode,'http_'+code);assert.equal(r.accounts[address(1)].portfolio,null);assert.equal(r.accounts[address(1)].fetchedAt,null);assert.equal(r.source.failed,1);assert.equal(e.timers.size,0);}
});
await test('incremental earlier segments reuse successful later rows and deduplicate inclusive segment boundaries',async()=>{
  const rows=[event(1,T-90*DAY-1),event(2,T-90*DAY),event(3,T-90*DAY+1),event(4,T-40*DAY)],e=env(()=>response(wide()),{ledgerHandler:call=>response(rows.filter(r=>r.time>=call.body.startTime&&r.time<=call.body.endTime))}),r=await e.run(),w=r.accounts[address(1)].portfolio.windows;
  assert.equal(r.source.ledgerRequests,5);assert.equal(r.source.succeeded,1);assert.equal(w['90D'].roiEvidence.recordCount,2);assert.equal(w['180D'].roiEvidence.recordCount,4);assert.equal(w['365D'].roiEvidence.recordCount,4);assert.equal(w['90D'].roiEvidence.ledgerQueryStartAt,iso(T-90*DAY));assert.equal(w['365D'].roiEvidence.ledgerQueryStartAt,iso(T-365*DAY));
  const calls=e.calls.filter(c=>c.body.type==='userNonFundingLedgerUpdates');assert.equal(calls[2].body.endTime,T-90*DAY);assert.equal(calls[4].body.endTime,T-180*DAY);
});
await test('identical actual sampled starts share one ledger traversal across requested periods',async()=>{
  const raw=sample('perpAllTime',[T-400*DAY,T-80*DAY,T],[0,0,20],[100,100,120]),e=env(()=>response(raw)),r=await e.run();assert.equal(r.source.ledgerRequests,1);assert.equal(r.source.succeeded,1);
  for(const key of ['90D','180D','365D']){assert.equal(r.accounts[address(1)].portfolio.windows[key].roi,20);assert.equal(r.accounts[address(1)].portfolio.windows[key].roiEvidence.ledgerQueryStartAt,iso(T-80*DAY));}
});
await test('partially completed ledger proof keeps its actual later success time before a failed extension',async()=>{
  const rows=Array.from({length:6000},(_,i)=>event(i+1,T-80*DAY+i)),e=env(()=>response(wide()),{ledgerHandler:call=>call.body.startTime<T-90*DAY?response('failed',503):response(rows.filter(r=>r.time>=call.body.startTime&&r.time<=call.body.endTime).slice(0,2000))}),r=await e.run(),x=r.accounts[address(1)];
  assert.equal(typeof x.portfolio.windows['90D'].roi,'number');assert(Date.parse(x.fetchedAt)>=T+60000);assert.equal(x.fetchedAt,x.portfolio.windows['90D'].roiEvidence.ledgerFetchedAt);assert.equal(x.portfolio.windows['180D'].roi,null);assert.equal(x.errorCode,'http_503');assert(API.validPortfolio(x.portfolio,Date.parse(x.fetchedAt),address(1)));assert.equal(e.timers.size,0);
});
await test('new short-history accounts explicitly report insufficient history without querying a ledger',async()=>{
  const raw=sample('perpAllTime',[T-75*DAY,T],[0,20],[100,120]),e=env(()=>response(raw)),r=await e.run();assert.equal(r.source.ledgerRequests,0);
  for(const key of ['90D','180D','365D']){assert.equal(r.accounts[address(1)].portfolio.windows[key].roi,null);assert.equal(r.accounts[address(1)].portfolio.windows[key].roiUnavailableReason,'insufficient_history');}
});
console.log('PASS '+count+' offline portfolio collector tests');
})().catch(error=>{console.error(error);process.exitCode=1;});
