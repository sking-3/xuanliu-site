'use strict';
/* Offline only: no subprocess or network request is executed. */
const assert=require('node:assert/strict');
const API=require('../scripts/refresh_trader_positions.cjs');
const T=1800000000000,iso=n=>new Date(n).toISOString(),A='0x'+'1'.repeat(40);
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(){
  const feed={schemaVersion:1,status:'ready',source:{id:'hyperliquid',status:'ok',selectedAccounts:1,lastAttemptAt:iso(T-25*60000),positionVerification:{scope:'default_perp_dex',completedAt:iso(T-25*60000),candidateAccounts:1,checkedAccounts:1,holdingAccounts:1,emptyAccounts:0,failedAccounts:0,unattemptedAccounts:0}},traders:[{accountId:A}]};
  const aggregate=(kind,end,start)=>({schemaVersion:1,methodVersion:kind==='portfolio'?'portfolio-periods-v2':'closing-fill-v1',generatedAt:iso(end),source:{id:'hyperliquid',status:'ready',startedAt:iso(start),completedAt:iso(end),accounts:1,cached:0,attempted:1,succeeded:1,failed:0,unattempted:0,available:1,stopCode:null},accounts:{[A]:{status:'ready',fetchedAt:iso(end),lastAttemptAt:iso(end-1000),errorCode:null,[kind==='portfolio'?'portfolio':'win']:kind==='portfolio'?{windows:{}}:{value:50}}}});
  return {feed,portfolios:aggregate('portfolio',T-20*60000,T-24*60000),analytics:aggregate('analytics',T-61000,T-19*60000),notBefore:iso(T-30*60000),now:T};
}
function ioFixture(values){const files=new Map(Object.entries(values).map(([k,v])=>[k,JSON.stringify(v)]));return {files,stat:async f=>{if(!files.has(f)){const e=Error('missing');e.code='ENOENT';throw e;}return {size:Buffer.byteLength(files.get(f))};},readFile:async f=>files.get(f)};}
let count=0;async function test(name,fn){await fn();count++;console.log('ok '+name);}
(async()=>{
await test('clean same-run snapshots with a completed cooldown permit verification',()=>{const r=API.guardSnapshots(fixture());assert.equal(r.allowed,true);assert.equal(r.cooldownMs,61000);assert.equal(r.latestCompletedAt,iso(T-61000));});
await test('all three stages propagate 403 and 429 without attempting to clear the block',()=>{
  for(const code of ['http_403','http_429'])for(const kind of ['positions','portfolio','analytics']){const f=fixture();if(kind==='positions')f.feed.source.positionVerification.stopCode=code;else f[kind==='portfolio'?'portfolios':'analytics'].source.stopCode=code;
    const r=API.guardSnapshots(f);assert.equal(r.allowed,false);assert.equal(r.reason,code);assert.equal(r.blockedStage,kind);}
});
await test('feed fallback error and per-account denial also block the final request',()=>{
  for(const kind of ['feed','portfolio','analytics']){const f=fixture();if(kind==='feed'){f.feed.source.status='stale';f.feed.source.errorCode='http_429';}else{const row=f[kind==='portfolio'?'portfolios':'analytics'].accounts[A];row.status='stale';row.errorCode='http_403';}
    assert.equal(API.guardSnapshots(f).allowed,false);}
});
await test('blocked stages do not need an unnecessary cooldown because nothing will run',()=>{const f=fixture();f.analytics.generatedAt=iso(T);f.analytics.source.completedAt=iso(T);f.analytics.source.stopCode='http_429';assert.equal(API.guardSnapshots(f).allowed,false);});
await test('missing explicit run start and old or future run starts fail closed',()=>{
  for(const value of [null,undefined,'bad',iso(T+1),iso(T-2*60*60000-1)]){const f=fixture();f.notBefore=value;assert.throws(()=>API.guardSnapshots(f),/invalid_run_start/);}
});
await test('any previous-run status is rejected even when it would otherwise appear clean',()=>{
  for(const kind of ['feed','portfolios','analytics']){const f=fixture();if(kind==='feed')f.feed.source.lastAttemptAt=iso(T-31*60000);else f[kind].generatedAt=iso(T-31*60000);assert.throws(()=>API.guardSnapshots(f),/not_from_current_run/);}
});
await test('future snapshot timestamps and mismatched source completion times reject',()=>{
  const future=fixture();future.analytics.generatedAt=iso(T+5001);assert.throws(()=>API.guardSnapshots(future),/not_from_current_run/);
  const mismatch=fixture();mismatch.portfolios.source.completedAt=iso(T-21*60000);assert.throws(()=>API.guardSnapshots(mismatch),/invalid_portfolio_status/);
});
await test('sixty seconds is a hard shared-budget cooldown',()=>{
  const f=fixture();f.analytics.generatedAt=iso(T-59999);f.analytics.source.completedAt=f.analytics.generatedAt;assert.throws(()=>API.guardSnapshots(f),/cooldown_not_elapsed/);
  f.analytics.generatedAt=iso(T-60000);f.analytics.source.completedAt=f.analytics.generatedAt;assert.equal(API.guardSnapshots(f).allowed,true);
});
await test('missing status, method version, stopCode or counter mismatches reject',()=>{
  for(const edit of [f=>delete f.portfolios.source.stopCode,f=>{f.analytics.methodVersion='unknown';},f=>{f.analytics.source.failed=1;},f=>{f.portfolios.source.available=0;},f=>{f.feed.source.selectedAccounts=2;},f=>{f.feed.source.positionVerification.holdingAccounts=0;}]){const f=fixture();edit(f);assert.throws(()=>API.guardSnapshots(f),/invalid_/);}
});
await test('unknown stop codes are not silently interpreted as permission',()=>{const f=fixture();f.analytics.source.stopCode='allow_anyway';assert.throws(()=>API.guardSnapshots(f),/invalid_analytics_status/);});
await test('invalid account state and addresses outside the current feed reject',()=>{
  for(const edit of [f=>{f.analytics.accounts[A].status='unavailable';},f=>{f.portfolios.accounts[A].lastAttemptAt='bad';},f=>{f.analytics.accounts['0x'+'2'.repeat(40)]=f.analytics.accounts[A];delete f.analytics.accounts[A];}]){const f=fixture();edit(f);assert.throws(()=>API.guardSnapshots(f),/invalid_/);}
});
await test('ordinary source failure is retained honestly but does not imitate a denial',()=>{const f=fixture();f.feed.source.status='stale';f.feed.source.errorCode='network_error';f.analytics.source.stopCode='batch_timeout';assert.equal(API.guardSnapshots(f).allowed,true);});
await test('valid empty unavailable snapshots still obey the cooldown and status rules',()=>{
  const f=fixture();f.feed={schemaVersion:1,status:'unavailable',source:{id:'hyperliquid',status:'error',selectedAccounts:0,lastAttemptAt:iso(T-120000),errorCode:'network_error'},traders:[]};
  for(const key of ['portfolios','analytics']){f[key].accounts={};for(const k of ['accounts','cached','attempted','succeeded','failed','unattempted','available'])f[key].source[k]=0;}
  assert.equal(API.guardSnapshots(f).allowed,true);
});
await test('bounded file reads reject oversized files and malformed JSON',async()=>{
  await assert.rejects(API.readBounded('/x',100,{stat:async()=>({size:101})}),/status_file_too_large/);
  await assert.rejects(API.readBounded('/x',100,{stat:async()=>({size:4}),readFile:async()=>'{bad'}),/invalid_status_json/);
});
await test('CLI denial skips Python even if the supplied runner would succeed',async()=>{
  const f=fixture();f.analytics.source.stopCode='http_403';const io=ioFixture({'/f/feed':f.feed,'/f/p':f.portfolios,'/f/a':f.analytics});let runs=0;const logs=[];
  const r=await API.main(['--feed','/f/feed','--portfolios','/f/p','--analytics','/f/a','--not-before',f.notBefore],{io,now:()=>T,run:async()=>{runs++;},log:x=>logs.push(x)});
  assert.equal(r.status,'skipped');assert.equal(r.reason,'http_403');assert.equal(runs,0);assert.equal(logs.length,1);
});
await test('CLI invokes the fixed Python collector without shell interpolation then validates new output',async()=>{
  const f=fixture(),feedPath='/f/feed;$(do-not-run).json',io=ioFixture({[feedPath]:f.feed,'/f/p':f.portfolios,'/f/a':f.analytics});let clock=T,call;
  const r=await API.main(['--feed',feedPath,'--portfolios','/f/p','--analytics','/f/a','--not-before',f.notBefore],{io,now:()=>clock,log:()=>{},run:async(...args)=>{call=args;clock+=1000;const changed=copy(f.feed);changed.source.lastAttemptAt=iso(clock);changed.source.positionVerification.completedAt=iso(clock);io.files.set(feedPath,JSON.stringify(changed));return{stdout:'unused',stderr:''};}});
  assert.equal(call[0],'python3');assert.equal(call[1][0],'-B');assert(call[1][1].endsWith('/scripts/collect_hyperliquid.py'));assert.deepEqual(call[1].slice(2),['--output',feedPath]);assert.equal(call[2].shell,false);assert.equal(call[2].timeout,360000);assert.equal(r.status,'refreshed');assert.equal(r.lastAttemptAt,iso(T+1000));
});
await test('missing files, invalid arguments and a failed subprocess never report refresh success',async()=>{
  const f=fixture(),io=ioFixture({'/f/feed':f.feed,'/f/p':f.portfolios,'/f/a':f.analytics}),args=['--feed','/f/feed','--portfolios','/f/p','--analytics','/f/a','--not-before',f.notBefore];let calls=0;
  await assert.rejects(API.main(['--bad'],{io}),/invalid_arguments/);
  await assert.rejects(API.main(args,{io,now:()=>T,run:async()=>{calls++;throw Error('python failed');},log:()=>{}}),/python failed/);assert.equal(calls,1);
  io.files.delete('/f/p');await assert.rejects(API.main(args,{io,now:()=>T,run:async()=>{calls++;},log:()=>{}}));assert.equal(calls,1);
});
await test('a zero exit that did not update the feed is not claimed as successful',async()=>{
  const f=fixture(),io=ioFixture({'/f/feed':f.feed,'/f/p':f.portfolios,'/f/a':f.analytics});await assert.rejects(API.main(['--feed','/f/feed','--portfolios','/f/p','--analytics','/f/a','--not-before',f.notBefore],{io,now:()=>T,run:async()=>({stdout:'',stderr:''}),log:()=>{}}),/feed_not_from_current_run/);
});
await test('the Python collector may return a new stale status without a false refreshed claim',async()=>{
  const f=fixture(),io=ioFixture({'/f/feed':f.feed,'/f/p':f.portfolios,'/f/a':f.analytics});let clock=T;
  const r=await API.main(['--feed','/f/feed','--portfolios','/f/p','--analytics','/f/a','--not-before',f.notBefore],{io,now:()=>clock,log:()=>{},run:async()=>{clock++;const changed=copy(f.feed);changed.source.status='stale';changed.source.errorCode='http_429';changed.source.lastAttemptAt=iso(clock);io.files.set('/f/feed',JSON.stringify(changed));return{};}});
  assert.equal(r.status,'source_stale');assert.equal(r.errorCode,'http_429');
});

await test('the final position guard rejects a v1 portfolio snapshot during v2 migration',async()=>{
  const f=fixture();f.portfolios.methodVersion='portfolio-periods-v1';assert.throws(()=>API.guardSnapshots(f),/invalid_portfolio_status/);
  const io=ioFixture({'/f/feed':f.feed,'/f/p':f.portfolios,'/f/a':f.analytics});let launches=0;
  await assert.rejects(API.main(['--feed','/f/feed','--portfolios','/f/p','--analytics','/f/a','--not-before',f.notBefore],{io,now:()=>T,run:async()=>{launches++;},log:()=>{}}),/invalid_portfolio_status/);assert.equal(launches,0);
});
console.log('PASS '+count+' offline final-position-guard tests');
})().catch(error=>{console.error(error);process.exitCode=1;});
