'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {FILES,decision,readBoundedJson,main}=require('../scripts/hyperliquid_run_guard.cjs');
const ADDRESS='0x'+'a'.repeat(40);
const clone=value=>JSON.parse(JSON.stringify(value));
function fixtures(){
 const aggregate=method=>({schemaVersion:1,methodVersion:method,generatedAt:'2000-01-01T00:00:00Z',
  source:{id:'hyperliquid',endpoint:'https://api.hyperliquid.xyz/info',status:'ready',accounts:1,stopCode:null,refreshIntervalMinutes:360,staleAfterMinutes:60},
  accounts:{[ADDRESS]:{status:'stale',errorCode:'cache_expired',fetchedAt:'2000-01-01T00:00:00Z'}}});
 return {feed:{schemaVersion:1,status:'ready',source:{id:'hyperliquid',url:'https://app.hyperliquid.xyz/leaderboard',status:'ok',selectedAccounts:0,
  fetchedAt:'2000-01-01T00:00:00Z',positionVerification:{scope:'default_perp_dex'}},traders:[]},
  analytics:aggregate('closing-fill-v1'),portfolios:aggregate('portfolio-periods-v2')};
}
function mockIO(states,overrides={}){
 const opened=[],closed=[],reads=[];
 const contents=Object.fromEntries(FILES.map(file=>[file.name,Buffer.from(JSON.stringify(states[file.kind]))]));
 return {opened,closed,reads,open:async(file,flags)=>{
  const name=path.basename(file);opened.push({name,flags});
  assert.equal(flags,'r');
  const override=overrides[name]||{};
  if(override.missing)throw Object.assign(Error('private missing path'),{code:'ENOENT'});
  const data=override.data===undefined?contents[name]:Buffer.from(override.data);
  let cursor=0;
  return {
   stat:async()=>({size:override.statSize===undefined?data.length:override.statSize,isFile:()=>override.isFile!==false}),
   read:async(buffer,offset,length,position)=>{
    assert.equal(position,null);
    reads.push({name,length});
    if(override.readError)throw Error('PRIVATE_RESPONSE_DO_NOT_LOG');
    const n=Math.min(length,data.length-cursor,override.chunk||Infinity);
    data.copy(buffer,offset,cursor,cursor+n);cursor+=n;return {bytesRead:n};
   },
   close:async()=>{closed.push(name);}
  };
 }};
}
async function invoke(states,overrides={},args=[]){
 const io=mockIO(states,overrides),out=[],err=[];
 const exitCode=await main(args,{root:'/synthetic',io,stdout:value=>out.push(value),stderr:value=>err.push(value)});
 return {exitCode,out,err,io};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
(async()=>{
 await test('old valid snapshots and 360-minute cadence do not need fresh timestamps',()=>{
  assert.equal(decision(fixtures()).allowed,true);
 });
 const setters=[
  (s,c)=>{s.feed.source.errorCode=c;},
  (s,c)=>{s.feed.source.positionVerification.stopCode=c;},
  (s,c)=>{s.analytics.source.stopCode=c;},
  (s,c)=>{s.portfolios.source.stopCode=c;},
  (s,c)=>{s.analytics.accounts[ADDRESS].errorCode=c;},
  (s,c)=>{s.portfolios.accounts[ADDRESS].errorCode=c;}
 ];
 await test('403 and 429 in every persisted source or record block without mutation',()=>{
  for(const code of ['http_403','http_429'])for(const set of setters){
   const states=fixtures();set(states,code);const before=clone(states),result=decision(states);
   assert.equal(result.allowed,false);assert.equal(result.reason,code);assert.deepEqual(states,before);
  }
 });
 await test('unavailable feed with a recorded refusal is still recognized',()=>{
  const states=fixtures();
  states.feed.status='unavailable';states.feed.source.status='error';states.feed.source.errorCode='http_403';delete states.feed.source.positionVerification;
  assert.equal(decision(states).allowed,false);
 });
 await test('unrelated transient failures do not silently become permanent refusals',()=>{
  const states=fixtures();states.feed.source.errorCode='network_error';states.analytics.source.stopCode='batch_timeout';
  assert.equal(decision(states).allowed,true);
 });
 await test('missing, malformed and mismatched status shapes fail closed',()=>{
  const mutations=[
   s=>{delete s.feed;},s=>{s.feed.source.id='other';},s=>{delete s.feed.source.positionVerification;},
   s=>{s.feed.source.positionVerification=null;},s=>{s.feed.source.errorCode=403;},
   s=>{s.analytics.source.status='unknown';},s=>{delete s.analytics.source.stopCode;},
   s=>{s.portfolios.methodVersion='legacy';},s=>{s.portfolios.accounts=[];},
   s=>{s.analytics.accounts[ADDRESS].status='unknown';},s=>{delete s.analytics.accounts[ADDRESS].errorCode;},
   s=>{s.portfolios.source.accounts=2;},s=>{s.portfolios.accounts[ADDRESS].errorCode='secret\npayload';}
  ];
  for(const mutate of mutations){const states=fixtures();mutate(states);assert.throws(()=>decision(states),/invalid_(feed|analytics|portfolios)_status/);}
 });
 await test('CLI writes only allowed=true after three bounded read-only files',async()=>{
  const r=await invoke(fixtures());assert.equal(r.exitCode,0);assert.deepEqual(r.out,['allowed=true\n']);assert.deepEqual(r.err,[]);
  assert.equal(r.io.opened.length,3);assert.equal(r.io.closed.length,3);
 });
 await test('full, positions and later attempts cannot clear or retry a persisted refusal',async()=>{
  const states=fixtures();states.portfolios.accounts[ADDRESS].errorCode='http_429';const before=clone(states);
  for(const mode of ['full','positions','push','retry']){
   const r=await invoke(states);assert.equal(r.exitCode,0,mode);assert.deepEqual(r.out,['allowed=false\n'],mode);
   assert.deepEqual(r.err,['hyperliquid_guard:blocked:portfolios_record:http_429\n']);
  }
  assert.deepEqual(states,before);
 });
 await test('missing files and invalid status JSON emit no allowance and exit nonzero',async()=>{
  for(const name of FILES.map(f=>f.name)){
   const r=await invoke(fixtures(),{[name]:{missing:true}});
   assert.equal(r.exitCode,1);assert.deepEqual(r.out,[]);assert.deepEqual(r.err,['hyperliquid_guard:missing_file\n']);
  }
  const r=await invoke(fixtures(),{'analytics.json':{data:'{}'}});assert.equal(r.exitCode,1);assert.deepEqual(r.out,[]);
  assert.deepEqual(r.err,['hyperliquid_guard:invalid_analytics_status\n']);
 });
 await test('stat size bounds reject before reading and always close the handle',async()=>{
  const io=mockIO(fixtures(),{'feed.json':{statSize:65}});
  await assert.rejects(()=>readBoundedJson('/synthetic/feed.json',64,io),/file_too_large/);
  assert.equal(io.reads.length,0);assert.deepEqual(io.closed,['feed.json']);
 });
 await test('growth after stat is capped at one byte over the limit',async()=>{
  const io=mockIO(fixtures(),{'feed.json':{data:'x'.repeat(100),statSize:1,chunk:7}});
  await assert.rejects(()=>readBoundedJson('/synthetic/feed.json',64,io),/file_too_large/);
  assert.deepEqual(io.closed,['feed.json']);assert(io.reads.every(r=>r.length<=65));
 });
 await test('short reads are joined while malformed JSON and UTF-8 remain failures',async()=>{
  const io=mockIO(fixtures(),{'feed.json':{data:'{"value":1}',chunk:2}});
  assert.deepEqual(await readBoundedJson('/synthetic/feed.json',64,io),{value:1});
  for(const data of ['{"private":"never log"',Buffer.from([0xff])]){
   const r=await invoke(fixtures(),{'feed.json':{data}});
   assert.equal(r.exitCode,1);assert.deepEqual(r.out,[]);assert.deepEqual(r.err,['hyperliquid_guard:invalid_json\n']);
  }
 });
 await test('read errors do not expose paths or response contents',async()=>{
  const r=await invoke(fixtures(),{'feed.json':{readError:true}});
  assert.equal(r.exitCode,1);assert.deepEqual(r.out,[]);assert.deepEqual(r.err,['hyperliquid_guard:read_failed\n']);
  assert.deepEqual(r.io.closed,['feed.json']);
 });
 await test('invalid arguments fail before reading files',async()=>{
  const r=await invoke(fixtures(),{},['--reset']);
  assert.equal(r.exitCode,1);assert.deepEqual(r.out,[]);assert.equal(r.io.opened.length,0);
  assert.deepEqual(r.err,['hyperliquid_guard:invalid_arguments\n']);
 });
 console.log('PASS '+passed+' Hyperliquid persistent refusal guard checks. Mock IO only; no source requests or disk writes.');
})().catch(error=>{console.error(error);process.exitCode=1;});
