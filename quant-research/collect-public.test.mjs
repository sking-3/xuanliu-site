import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectPublic,decodeKraken,DAY,SOURCE} from './collect-public.mjs';

const NOW=Date.parse('2026-11-17T12:00:00.000Z');
const day=Math.floor(NOW/DAY)*DAY;
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture({shift=0,count=301}={}){
  const rows=Array.from({length:count+1},(_,i)=>{const price=100+i/10+Math.sin(i/12);return [(day-(count-i)*DAY+shift)/1000,String(price),String(price+2),String(price-2),String(price+1),'0',String(100+i),10];});
  return {error:[],result:{XXBTZUSD:rows,last:rows.at(-1)[0]}};
}
const response=(data,status=200)=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
async function dir(t){const d=await mkdtemp(path.join(os.tmpdir(),'books-quant-public-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
const read=async d=>JSON.parse(await readFile(path.join(d,'latest.json'),'utf8'));

test('public collection uses fixed URL, excludes the forming candle, and links report to exact OHLCV hash',async t=>{
  const d=await dir(t),p=fixture();let called=0;
  const result=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async(url,opts)=>{called++;assert.equal(url,SOURCE.url);assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');return response(p);}});
  assert.equal(called,1);assert.equal(result.status,'ready');assert.equal(result.bars.length,301);assert.equal(result.latestClosedAt,new Date(day).toISOString());
  assert.equal(result.dataHash,hash(JSON.stringify(result.bars)));assert.equal(result.reportHash,hash(JSON.stringify(result.report)));assert.equal(result.report.data.suppliedSha256,result.dataHash);assert.equal(result.report.config.feeBps,10);assert.equal(result.report.config.slippageBps,5);assert.equal(result.error,null);assert.deepEqual(await read(d),result);
});
test('Kraken parser rejects malformed, missing, unclosed, duplicate and non-contiguous candles',()=>{
  const cases=[];let x;
  x=fixture();x.result.XXBTZUSD[2][6]=null;cases.push(x);
  x=fixture();x.result.XXBTZUSD[2][2]='0';cases.push(x);
  x=fixture();x.result.XXBTZUSD[2][0]=x.result.XXBTZUSD[1][0];cases.push(x);
  x=fixture();x.result.XXBTZUSD[2][0]+=DAY/1000;cases.push(x);
  x=fixture({count:299});cases.push(x);
  x=fixture({shift:DAY});cases.push(x);
  x=fixture();x.result.XXBTZUSD[2][1]='NaN';cases.push(x);
  for(const bad of cases)assert.throws(()=>decodeKraken(bad,NOW),/日线|字段/);
});
test('transient HTTP and invalid payload retain last-good data and expose attempt separately',async t=>{
  const d=await dir(t);const good=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response(fixture())});
  for(const [i,[data,status,code]] of [['not json',200,'invalid_data'],['error',500,'source_error']].entries()){
    const attempt=NOW+(i+1)*DAY,result=await collectPublic({outputDir:d,now:()=>attempt,fetchImpl:async()=>response(data,status)});
    assert.equal(result.status,'stale');assert.equal(result.error.code,code);assert.equal(result.lastAttempt,new Date(attempt).toISOString());
    for(const key of ['bars','report','dataHash','retrievedAt','latestClosedAt','runAt'])assert.deepEqual(result[key],good[key]);
  }
});
for(const source of [{status:403,body:'denied'},{status:429,body:'limited'},{status:200,body:{error:['EAPI:Rate limit exceeded'],result:{}}}])test(`source stop ${source.status} persists across fresh runner and retains last-good`,async t=>{
  const d=await dir(t),good=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response(fixture())});
  const stopped=await collectPublic({outputDir:d,now:()=>NOW+DAY,fetchImpl:async()=>response(source.body,source.status)});
  assert.equal(stopped.status,'stopped');assert.equal(stopped.error.code,'source_stopped');assert.equal(stopped.dataHash,good.dataHash);assert.deepEqual(stopped.report,good.report);
  let calls=0;const again=await collectPublic({outputDir:d,now:()=>NOW+2*DAY,fetchImpl:async()=>{calls++;return response(fixture());}});
  assert.equal(calls,0);assert.deepEqual(again,stopped);assert.deepEqual(await read(d),stopped);
});
test('initial failure publishes explicit error with null data and no fabricated report',async t=>{
  const d=await dir(t),result=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>{throw Error('offline');}});
  assert.equal(result.status,'error');assert.equal(result.error.code,'source_unavailable');for(const k of ['bars','report','dataHash','retrievedAt','latestClosedAt','runAt'])assert.equal(result[k],null);assert.deepEqual(await read(d),result);
});
test('initial 429 remains stopped on following runs, without a last-good snapshot',async t=>{
  const d=await dir(t),first=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response('',429)});
  assert.equal(first.status,'stopped');assert.equal(first.bars,null);let calls=0;const second=await collectPublic({outputDir:d,now:()=>NOW+DAY,fetchImpl:async()=>{calls++;return response(fixture());}});assert.equal(calls,0);assert.deepEqual(second,first);
});
test('successful collection is throttled for 24 hours across new runners, then may refresh',async t=>{
  const d=await dir(t),first=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response(fixture())});let calls=0;
  const early=await collectPublic({outputDir:d,now:()=>NOW+DAY-1,fetchImpl:async()=>{calls++;return response(fixture());}});
  assert.equal(calls,0);assert.deepEqual(early,first);assert.deepEqual(await read(d),first);
  const due=await collectPublic({outputDir:d,now:()=>NOW+DAY,fetchImpl:async()=>{calls++;return response(fixture());}});
  assert.equal(calls,1);assert.equal(due.status,'ready');assert.equal(due.lastAttempt,new Date(NOW+DAY).toISOString());
});
test('failed collection is also throttled for 24 hours without rewriting its error',async t=>{
  const d=await dir(t),first=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response('',500)});let calls=0;
  const early=await collectPublic({outputDir:d,now:()=>NOW+DAY-1,fetchImpl:async()=>{calls++;return response(fixture());}});
  assert.equal(calls,0);assert.deepEqual(early,first);
  const due=await collectPublic({outputDir:d,now:()=>NOW+DAY,fetchImpl:async()=>{calls++;return response(fixture());}});
  assert.equal(calls,1);assert.equal(due.status,'ready');
});
test('older source snapshot is refused without replacing the saved data',async t=>{
  const d=await dir(t),good=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response(fixture())});
  const older=await collectPublic({outputDir:d,now:()=>NOW+DAY,fetchImpl:async()=>response(fixture({shift:-DAY}))});
  assert.equal(older.status,'stale');assert.equal(older.error.code,'older_source');assert.equal(older.dataHash,good.dataHash);assert.equal(older.latestClosedAt,good.latestClosedAt);
});
test('corrupt previous archive cannot be hidden by fetching and overwriting it',async t=>{
  const d=await dir(t),good=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response(fixture())});good.bars[0].close+=0.1;
  const file=path.join(d,'latest.json'),bad=JSON.stringify(good);await writeFile(file,bad);let calls=0;
  await assert.rejects(()=>collectPublic({outputDir:d,now:()=>NOW+DAY,fetchImpl:async()=>{calls++;return response(fixture());}}),{code:'invalid_archive'});
  assert.equal(calls,0);assert.equal(await readFile(file,'utf8'),bad);
});
test('tampered report cannot be silently refreshed or overwritten',async t=>{
  const d=await dir(t),good=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response(fixture())});good.report.config.feeBps=999;
  const file=path.join(d,'latest.json'),bad=JSON.stringify(good);await writeFile(file,bad);let calls=0;
  await assert.rejects(()=>collectPublic({outputDir:d,now:()=>NOW+DAY,fetchImpl:async()=>{calls++;return response(fixture());}}),{code:'invalid_archive'});
  assert.equal(calls,0);assert.equal(await readFile(file,'utf8'),bad);
});
test('oversized source response leaves the old report intact',async t=>{
  const d=await dir(t),good=await collectPublic({outputDir:d,now:()=>NOW,fetchImpl:async()=>response(fixture())});
  const result=await collectPublic({outputDir:d,now:()=>NOW+DAY,fetchImpl:async()=>new Response('x'.repeat(2000001))});
  assert.equal(result.status,'stale');assert.equal(result.error.code,'source_too_large');assert.equal(result.dataHash,good.dataHash);
});
