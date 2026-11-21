import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collect, createGuard, openStore, precompute, recomputeFromCache, retryAfter, INDICES } from '../server/a-share-daily.mjs';
import {sourceId,dataPolicy} from '../server/a-share-tickflow.mjs';
import {gzipSync} from 'node:zlib';
import patterns from '../screening/trend-patterns.js';

const now = () => Date.parse('2026-11-21T00:00:00Z');
const asOf = '2026-11-20T08:15:00.000Z';
const latest = { date: '2026-11-20', closeTime: '2026-11-20T07:00:00.000Z' };
const stocks = Array.from({ length: 1000 }, (_, i) => ({ code: String(600000 + i) + '.SH', name: '测试' + i, exchange: 'SH', sector: '测试' }));
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'books-daily-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function options(dir, changes = {}) {
  const input={ dir, siteDir: resolve('.'), now, wait: async () => {}, calendar: { latestClosed: () => latest }, pool: { build: value => ({ day: value.updatedAt.slice(0, 10), rows: stocks }), select: rows => rows }, fetch: async () => Response.json({ updatedAt: asOf }), technicalFactory: () => ({ history: async (stock, day, signal, settings) => ({ status: 'ready', adjustment: settings.index ? 'index' : 'qfq', bars: [{ date: day, close: 1, volume: 1 }], fetchedAt: new Date(now()).toISOString() }) }), compute: async value => ({ generation: '2026-11-20-1', day: value.day, asOf: value.asOf, total: value.universe.length, ready: [...value.sources.values()].filter(source=>source.status==='ready').length }), ...changes };
  const compute=input.compute;
  input.compute=async value=>{
    const result={...await compute(value),sourceId:value.sourceId,dataPolicy:value.dataPolicy,fullMarket:true};
    const directory=join(dir,'generations',result.generation);await mkdir(directory,{recursive:true});
    for(const code of INDICES)for(const mode of ['consensus','market','strength'])for(const lookback of [20,60]){const body=JSON.stringify({generation:result.generation,mode,lookback,reference:{code},records:[]}),path=join(directory,'result-'+mode+'-'+lookback+'-all-'+code+'.json');await writeFile(path,body);await writeFile(path+'.gz',gzipSync(body));}
    await writeFile(join(directory,'complete.json'),JSON.stringify({...result,completed:true}));
    return result;
  };
  return input;
}

test('429 reads full Retry-After and prevents every subsequent request, including after restart', async () => fixture(async dir => {
  let calls = 0;
  let db = openStore(join(dir, 'test.sqlite'));
  let fetch = createGuard({ db, now, fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); } });
  await assert.rejects(fetch('https://example.test'), /429/);
  const hold = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('source-hold').value);
  assert.equal(hold.retryAfter, '2026-11-21T00:02:00.000Z');
  await assert.rejects(fetch('https://example.test'), /暂停/);
  db.close();
  db = openStore(join(dir, 'test.sqlite'));
  fetch = createGuard({ db, now, fetch: async () => { calls++; } });
  await assert.rejects(fetch('https://example.test'), /暂停/);
  assert.equal(calls, 1);
  db.close();
}));

test('418, 403 and 451 stop without fallback requests', async () => fixture(async dir => {
  for (const status of [418, 403, 451]) {
    const db = openStore(join(dir, status + '.sqlite'));
    let calls = 0;
    const fetch = createGuard({ db, fetch: async () => { calls++; return new Response('', { status }); } });
    await assert.rejects(fetch('https://example.test'), new RegExp(String(status)));
    await assert.rejects(fetch('https://other.test'), /暂停/);
    assert.equal(calls, 1);
    db.close();
  }
}));

test('all external requests share the minimum interval', async () => fixture(async dir => {
  const db = openStore(join(dir, 'test.sqlite')); let time = 0; const waits = [];
  const fetch = createGuard({ db, now: () => time, wait: async ms => { waits.push(ms); time += ms; }, fetch: async () => new Response('{}') });
  await fetch('https://example.test'); await fetch('https://example.test'); await fetch('https://example.test');
  assert.deepEqual(waits, [1500, 1500]); db.close();
}));

test('Retry-After HTTP date is retained', () => {
  assert.equal(retryAfter('Sat, 21 Nov 2026 00:10:00 GMT', now()), '2026-11-21T00:10:00.000Z');
  assert.equal(retryAfter('invalid', now()), null);
});

test('interrupted compute resumes same-day history; completed day skips all external requests', async () => fixture(async dir => {
  let historyCalls = 0, computes = 0;
  let externalCalls = 0;
  const input = options(dir, { fetch: async () => { externalCalls++; return Response.json({ updatedAt: asOf }); }, technicalFactory: () => ({ history: async () => { historyCalls++; return { status: 'ready', adjustment: 'qfq', bars: [], fetchedAt: new Date(now()).toISOString() }; } }), compute: async value => { computes++; assert.equal(value.sources.size, 1000); assert.equal(value.references.size, 3); if (computes === 1) throw Error('interrupted'); return { generation: '2026-11-20-1', day: value.day, asOf: value.asOf, total: 1000, ready: 1000 }; } });
  assert.equal((await collect(input)).attempt.status, 'failed');
  assert.equal(historyCalls, 1003);
  assert.equal((await collect(input)).attempt.resumed, 1003);
  assert.equal(historyCalls, 1003); assert.equal(computes, 2);
  assert.equal((await collect(input)).attempt.status, 'no_new_day'); assert.equal(externalCalls, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'current.json'))).day, latest.date);
}));

test('late market date fails before stock requests and retains last success', async () => fixture(async dir => {
  const old = { generation: '2026-11-19-1', day: '2026-11-19', asOf: '2026-11-19T08:00:00Z' };
  await writeFile(join(dir, 'current.json'), JSON.stringify(old));
  let calls = 0;
  const result = await collect(options(dir, { fetch: async () => Response.json({ updatedAt: '2026-11-19T08:00:00Z' }), technicalFactory: () => ({ history: () => { calls++; } }) }));
  assert.equal(result.attempt.status, 'failed'); assert.match(result.attempt.error, /未覆盖最近收盘日/);
  assert.equal(calls, 0); assert.deepEqual(JSON.parse(await readFile(join(dir, 'current.json'))), old);
}));

test('coverage below 80% does not precompute or overwrite last success', async () => fixture(async dir => {
  await writeFile(join(dir, 'current.json'), '{"generation":"2026-11-19-1"}');
  let computed = false;
  const result = await collect(options(dir, { technicalFactory: () => ({ history: async (stock, day, signal, settings) => settings.index ? { status: 'ready', bars: [] } : { status: 'unavailable', reason: '缺目标日' } }), compute: async () => { computed = true; } }));
  assert.equal(result.attempt.status, 'failed'); assert.match(result.attempt.error, /覆盖不足80%/); assert.equal(computed, false);
  assert.equal(JSON.parse(await readFile(join(dir, 'current.json'))).generation, '2026-11-19-1');
}));

test('unverified calendar makes zero external requests', async () => fixture(async dir => {
  let calls = 0;
  const result = await collect(options(dir, { calendar: { latestClosed: () => null }, fetch: async () => { calls++; } }));
  assert.match(result.attempt.error, /交易日历未核验/); assert.equal(calls, 0);
}));

test('failed precompute retains previous pointer and reports exact stage', async () => fixture(async dir => {
  await writeFile(join(dir, 'current.json'), '{"generation":"2026-11-19-1"}');
  const result = await collect(options(dir, { compute: async ({ onProgress }) => { onProgress({ stage: 'precomputing' }); throw Error('disk full'); } }));
  assert.equal(result.attempt.status, 'failed'); assert.equal(result.attempt.stage, 'precomputing'); assert.equal(result.attempt.error, 'disk full');
  assert.equal(JSON.parse(await readFile(join(dir, 'current.json'))).generation, '2026-11-19-1');
}));

test('stopping collection records a failure, retains last result and makes no subsequent request', async () => fixture(async dir => {
  await writeFile(join(dir, 'current.json'), '{"generation":"2026-11-19-1","day":"2026-11-19"}');
  const control = new AbortController(); let calls = 0;
  const result = await collect(options(dir, { signal: control.signal, technicalFactory: () => ({ history: async () => { calls++; control.abort(Error('任务被停止')); return { status: 'ready', bars: [] }; } }) }));
  assert.equal(result.attempt.status, 'failed'); assert.match(result.attempt.error, /任务被停止/); assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'current.json'))).day, '2026-11-19');
}));

test('transport failure ends the batch immediately rather than counting every stock as missing', async () => fixture(async dir => {
  let calls=0;
  const result=await collect(options(dir,{technicalFactory:()=>({history:async(stock,day,signal,settings)=>{calls++;return settings.index?{status:'ready',bars:[]}:{status:'unavailable',transportError:true,reason:'HTTP 501'};}})}));
  assert.equal(result.attempt.status,'failed');assert.match(result.attempt.error,/HTTP 501/);assert.equal(calls,4);assert.equal(result.attempt.checked,0);assert.equal(result.attempt.missing,0);
}));

function series(seed=100){
  const dates=[];for(let date=new Date(latest.date+'T00:00:00Z');dates.length<61;date.setUTCDate(date.getUTCDate()-1))if(![0,6].includes(date.getUTCDay()))dates.unshift(date.toISOString().slice(0,10));
  return {timestamp:dates.map(day=>Date.parse(day+'T00:00:00+08:00')),open:dates.map((_,i)=>seed+i/10),high:dates.map((_,i)=>seed+i/10+2),low:dates.map((_,i)=>seed+i/10-1),close:dates.map((_,i)=>seed+i/10+1),volume:dates.map((_,i)=>1000+i)};
}
function tickflowResponse(url){
  const parsed=new URL(url);
  if(parsed.hostname==='raw.githubusercontent.com')return Response.json({updatedAt:asOf});
  assert.equal(parsed.origin,'https://free-api.tickflow.org');
  const codes=parsed.searchParams.get('symbols').split(',');assert(codes.length<=50);
  return Response.json({data:Object.fromEntries(codes.map(code=>[code,series(100+Number(code.slice(0,6))%17)]))});
}
test('default source batches all main-board records including risk names through one guard, keeps legacy cache private and skips only completed same-source days',async()=>fixture(async dir=>{
  const db=openStore(join(dir,'collector.sqlite'));db.prepare('INSERT INTO history VALUES(?,?,?,?)').run(latest.date,stocks[0].code,asOf,JSON.stringify({status:'ready',bars:[{close:999999}]}));db.close();
  let computes=0;const requests=[],waits=[],rows=stocks.map((stock,i)=>({...stock,name:i===0?'*ST测试':stock.name}));
  const input=options(dir,{technicalFactory:undefined,wait:async ms=>waits.push(ms),fetch:async url=>{requests.push(String(url));return tickflowResponse(url);},pool:{build:value=>({day:value.updatedAt.slice(0,10),rows}),select:(values,settings)=>{assert.equal(settings.excludeRiskNames,false);return values;}},compute:async value=>{
    computes++;assert.equal(value.sourceId,sourceId);assert.equal(value.dataPolicy.rawPublic,false);assert.equal(value.universe.length,1000);assert.equal(value.universe[0].name,'*ST测试');assert.equal(value.references.size,3);assert.equal(value.sources.get(stocks[0].code).bars.length,61);assert.notEqual(value.sources.get(stocks[0].code).bars[0].close,999999);
    for(const [code,source]of value.references){assert.equal(source.sourceId,sourceId);assert.equal(source.adjustment,'index');assert.equal(source.bars.at(-1).date,latest.date);assert(INDICES.includes(code));}
    return {generation:'2026-11-20-2',day:value.day,asOf:value.asOf,total:value.universe.length,ready:value.sources.size};
  }});
  const result=await collect(input);assert.equal(result.attempt.status,'complete');assert.equal(result.attempt.checked,1000);assert.equal(result.attempt.resumed,0);assert.equal(result.attempt.requests,22);
  assert.equal(requests.filter(url=>url.includes('tickflow')).length,21);assert(requests.every(url=>!url.includes('gtimg')&&!url.includes('finance.qq')));assert.equal(waits.length,21);assert(waits.every(ms=>ms===1500));
  const check=openStore(join(dir,'collector.sqlite'));assert.equal(check.prepare('SELECT count(*) AS n FROM history').get().n,1);assert.equal(check.prepare('SELECT count(*) AS n FROM history_v2 WHERE source_id=?').get(sourceId).n,1003);check.close();
  assert.equal((await collect(input)).attempt.status,'no_new_day');assert.equal(requests.length,22);
  await rm(join(dir,'generations','2026-11-20-2','result-strength-60-all-399001.SZ.json.gz'));
  const rebuilt=await collect(input);assert.equal(rebuilt.attempt.status,'complete');assert.equal(rebuilt.attempt.resumed,1003);assert.equal(computes,2);assert.equal(requests.length,22);
}));
test('a failed batch preserves exact successful codes and frozen snapshot for source-aware continuation without inventing remaining missing rows',async()=>fixture(async dir=>{
  let calls=0,failed=true;
  const input=options(dir,{technicalFactory:undefined,fetch:async url=>{
    calls++;const parsed=new URL(url);if(failed&&parsed.hostname==='free-api.tickflow.org'&&parsed.searchParams.get('symbols').split(',')[0]===stocks[50].code)return new Response('',{status:501});
    if(!failed)assert.notEqual(parsed.hostname,'raw.githubusercontent.com','resume uses frozen source/day snapshot');return tickflowResponse(url);
  }});
  const first=await collect(input);assert.equal(first.attempt.status,'failed');assert.equal(first.attempt.checked,50);assert.equal(first.attempt.missing,0);assert.match(first.attempt.error,/501/);assert.equal(calls,4);
  failed=false;const second=await collect(input);assert.equal(second.attempt.status,'complete');assert.equal(second.attempt.resumed,53);assert.equal(second.attempt.checked,1000);assert.equal(second.attempt.requests,19);assert.equal(second.lastSuccess.asOf,asOf);
  const check=openStore(join(dir,'collector.sqlite'));assert.equal(check.prepare('SELECT as_of FROM batches_v2 WHERE source_id=? AND day=?').get(sourceId,latest.date).as_of,asOf);assert.equal(check.prepare('SELECT count(*) AS n FROM history_v2 WHERE source_id=?').get(sourceId).n,1003);check.close();
}));
test('a same-day pointer from another source cannot suppress the new provider, and an unfinished compute cannot publish',async()=>fixture(async dir=>{
  const old={generation:'2026-11-20-1',day:latest.date,asOf,total:1000,ready:1000,sourceId:'tencent-public-history-v1',fullMarket:true};
  await writeFile(join(dir,'current.json'),JSON.stringify(old));await mkdir(join(dir,'generations',old.generation),{recursive:true});await writeFile(join(dir,'generations',old.generation,'complete.json'),JSON.stringify({...old,completed:true}));
  let called=false;const input=options(dir,{technicalFactory:undefined,fetch:tickflowResponse});
  input.compute=async value=>{called=true;return {generation:'2026-11-20-2',day:value.day,asOf:value.asOf,total:1000,ready:1000,sourceId};};
  const result=await collect(input);assert.equal(called,true);assert.equal(result.attempt.status,'failed');assert.match(result.attempt.error,/未完整结束/);assert.deepEqual(JSON.parse(await readFile(join(dir,'current.json'))),old);
}));
test('429 persists only its provider hold and prevents every automatic continuation request',async()=>fixture(async dir=>{
  const db=openStore(join(dir,'collector.sqlite'));db.prepare('INSERT INTO settings VALUES(?,?)').run('source-hold',JSON.stringify({reason:'旧腾讯停止记录'}));db.close();
  let requests=0;const input=options(dir,{technicalFactory:undefined,fetch:async url=>{requests++;return String(url).includes('tickflow')?new Response('',{status:429,headers:{'Retry-After':'120'}}):tickflowResponse(url);}});
  const first=await collect(input);assert.equal(first.attempt.status,'failed');assert.match(first.attempt.error,/429/);assert.equal(first.attempt.checked,0);assert.equal(requests,2);
  const next=await collect(input);assert.equal(next.attempt.status,'failed');assert.match(next.attempt.error,/暂停/);assert.equal(requests,2);
  const check=openStore(join(dir,'collector.sqlite'));assert.equal(JSON.parse(check.prepare('SELECT value FROM settings WHERE key=?').get('source-hold:'+sourceId).value).retryAfter,'2026-11-21T00:02:00.000Z');assert.equal(JSON.parse(check.prepare('SELECT value FROM settings WHERE key=?').get('source-hold').value).reason,'旧腾讯停止记录');check.close();
}));
test('batch transport diagnostics are preserved with zero fake progress or additional source requests',async()=>fixture(async dir=>{
  const details={sourceId,url:'https://free-api.tickflow.org/v1/klines/batch',httpStatus:501,contentType:'text/plain',server:'test',retryAfter:null,summary:'upstream unavailable'};
  let batches=0;const input=options(dir,{technicalFactory:undefined,sourceFactory:()=>({historyBatch:async()=>{batches++;throw Object.assign(Error('TickFlow HTTP 501'),{transportError:true,details});}})});
  const result=await collect(input);assert.equal(batches,1);assert.equal(result.attempt.status,'failed');assert.equal(result.attempt.checked,0);assert.equal(result.attempt.missing,0);assert.deepEqual(result.attempt.errorDetails,details);
  const status=JSON.parse(await readFile(join(dir,'status.json')));assert.deepEqual(status.attempt.errorDetails,details);await assert.rejects(readFile(join(dir,'current.json')),/ENOENT/);
}));
test('public precomputation contains derived metrics only while raw bars stay private and risk-name eligibility never shrinks the collected universe',async()=>fixture(async dir=>{
  const raw=series(),bars=raw.timestamp.map(stamp=>({date:new Date(stamp+8*3600000).toISOString().slice(0,10),close:100,volume:100}));
  [99,99,99,99,99,99.5,100,100.5,101,101.5].forEach((close,i)=>{bars[bars.length-10+i].close=close;});
  const universe=stocks.slice(0,40).map((stock,i)=>({...stock,name:i===0?'*ST测试':stock.name})),sources=new Map(universe.map(stock=>[stock.code,{status:'ready',sourceId,day:latest.date,adjustment:'qfq',adjustmentMethod:'比例前复权',volumeUnit:'手',bars,fetchedAt:new Date(now()).toISOString()}]));
  const references=new Map(INDICES.map((code,i)=>[code,{status:'ready',sourceId,adjustment:'index',bars:bars.map(bar=>({...bar,close:bar.close*(i+1)})),fetchedAt:new Date(now()).toISOString()}]));
  const input={dir,siteDir:resolve('.'),snapshot:{updatedAt:asOf,stocks:[{price:987654321}]},universe,sources,references,sourceId,dataPolicy,day:latest.date,asOf,startedAt:asOf,now};
  const published=await precompute(input);
  const location=join(dir,'generations',published.generation),files=await readdir(location);assert.equal(files.some(name=>name.startsWith('dataset-')||name.startsWith('market.')),false);
  assert.equal(published.dataPolicy.rawPublic,false);assert.equal(published.sourceId,sourceId);assert.equal(published.total,40);assert.equal(published.coverage,1);
  const privateData=JSON.parse(await readFile(join(dir,'private','generations',published.generation,'dataset-all-000300.SH.json')));assert.equal(privateData.records.length,40);assert.equal(privateData.records[0].source.bars[0].close,bars[0].close);
  assert.equal(Object.hasOwn(privateData,'dataPolicy'),false);assert.equal(Object.hasOwn(privateData,'sourceId'),false);
  const model=(await import('../control/model.js')).default,engine=(await import('../screening/trend-screen.js')).default;assert.equal(model.normalizeDataset(privateData).records.length,40);
  for(const mode of ['consensus','market','strength'])for(const lookback of [20,60]){
    const value=JSON.parse(await readFile(join(location,'result-'+mode+'-'+lookback+'-all-000300.SH.json')));
    assert.equal(value.records.length,40);assert.equal(value.sourceId,sourceId);assert.equal(value.dataPolicy.rawPublic,false);assert.equal(value.records[0].result.matched,false);assert.match(value.records[0].result.reason,/风险名称/);assert.doesNotMatch(JSON.stringify(value),/startClose|endClose|987654321|"bars"/);
    assert(value.records.every(record=>record.result.status!=='ready'||record.result.metrics.endAt===latest.date));
    assert.equal(value.patternVersion,patterns.version);assert.equal(value.patternProfile.id,'daily-close-volume-v1');assert.equal(value.patternDefinitions.length,16);
    assert(value.records.every(record=>record.patterns.version===value.patternVersion&&record.patterns.day===latest.date&&record.patterns.lookback===lookback));
    for(const record of value.records){
      const facts=record.patterns.facts,m=record.result.metrics,window=bars.slice(-lookback-1).map(bar=>bar.close),range=(Math.max(...window)/Math.min(...window)-1)*100;
      assert.equal(facts.version,patterns.version);assert.equal(facts.day,value.day);assert.equal(facts.lookback,lookback);assert.equal(facts.sampleCount,bars.length);assert.deepEqual(facts.profile,patterns.profile);
      assert.deepEqual(patterns.classifyFacts({facts,day:value.day,lookback}).labels,record.patterns.labels);
      assert.doesNotMatch(JSON.stringify(facts),/"(?:bars|prices|volumes|close|price|high|low|open|ma5|ma20|volumeAvg5|volumeAvgPrevious20)"/);
      assert(Math.abs(m.periodRangePercent-range)<1e-10);assert.equal(m.crossSearchDays,20);assert(m.crossAgeDays===null||Number.isInteger(m.crossAgeDays)&&m.crossAgeDays>=0&&m.crossAgeDays<m.crossSearchDays);
      assert.equal(typeof m.periodRangePercent,'number');assert.equal(typeof m.crossSearchDays,'number');
    }
    const risk=value.records[0].result,normal=value.records[1].result;
    assert.equal(risk.candidateMatched,true);assert.equal(risk.eligible,false);assert.equal(risk.baseMatched,false);assert.deepEqual(risk.eligibilityCodes,['risk_name']);assert.equal(normal.candidateMatched,true);assert.equal(normal.eligible,true);assert.equal(normal.matched,true);assert.equal(risk.marketQualified,normal.marketQualified);
    const heated=engine.applyLimits(risk,{enabled:true},lookback),restored=engine.applyLimits(heated,{enabled:false},lookback);
    assert.equal(restored.candidateMatched,true);assert.equal(restored.matched,false);assert.equal(restored.eligible,false);assert.match(restored.reason,/风险名称/);assert.deepEqual(restored.eligibilityCodes,['risk_name']);assert.equal(engine.applyLimits(normal,{enabled:true},lookback).matched,true);
  }
  for(const code of INDICES){const raw=JSON.parse(await readFile(join(dir,'private','generations',published.generation,'dataset-all-'+code+'.json')));assert.equal(raw.reference.bars[0].close,references.get(code).bars[0].close);}
  const next=await precompute({...input,now:()=>now()+1});
  for(const mode of ['consensus','market','strength'])for(const lookback of [20,60]){
    const value=JSON.parse(await readFile(join(dir,'generations',next.generation,'result-'+mode+'-'+lookback+'-all-000300.SH.json')));
    const cached=engine.applyLimits(value.records[0].result,{enabled:false},lookback);
    assert.equal(cached.candidateMatched,true);assert.equal(cached.eligible,false);assert.equal(cached.matched,false);assert.deepEqual(cached.eligibilityCodes,['risk_name']);
  }
}));

async function privateReplay(dir){
  const raw=series(),bars=raw.timestamp.map((stamp,i)=>({date:new Date(stamp+8*3600000).toISOString().slice(0,10),close:raw.close[i],volume:raw.volume[i]})),fetchedAt=new Date(now()).toISOString();
  const records=stocks.map((stock,i)=>({stock,source:i===stocks.length-1?{status:'unavailable',sourceId,day:latest.date,bars:[],adjustment:null,fetchedAt,reason:'缺少原始日线'}:{status:'ready',sourceId,day:latest.date,bars,adjustment:'qfq',adjustmentMethod:'比例前复权',volumeUnit:'手',fetchedAt}}));
  const dataset={schema:'books.research.dataset.v1',day:latest.date,asOf,completed:true,collectionStatus:'complete',expectedCount:stocks.length,totalUniverseCount:stocks.length,universe:stocks,records};
  const writer=options(dir,{compute:async()=>({generation:'2026-11-20-1',day:latest.date,asOf,total:stocks.length,ready:stocks.length-1})}).compute;
  const previous=await writer({sourceId,dataPolicy});
  await writeFile(join(dir,'current.json'),JSON.stringify(previous));
  const location=join(dir,'private','generations',previous.generation);await mkdir(location,{recursive:true});
  for(const [index,code]of INDICES.entries())await writeFile(join(location,'dataset-all-'+code+'.json'),JSON.stringify({...dataset,reference:{code,adjustment:'index',bars:bars.map(bar=>({...bar,close:bar.close*(index+1)})),fetchedAt}}));
  await writeFile(join(dir,'status.json'),'中止或完成的原始采集回执保持不变');
  return {previous,dataset,location};
}
test('offline replay bypasses same-day collection skip, publishes complete derived pattern profiles and preserves source dates and collection receipts',async t=>fixture(async dir=>{
  const f=await privateReplay(dir),before=await readFile(join(f.location,'dataset-all-000300.SH.json'),'utf8');
  t.mock.method(globalThis,'fetch',()=>{throw Error('offline replay must not request external data');});
  const replay=await recomputeFromCache({dir,siteDir:resolve('.'),now:()=>now()+1000});
  assert.equal(replay.attempt.jobType,'recompute');assert.equal(replay.attempt.status,'complete');assert.equal(replay.attempt.requests,0);assert.equal(replay.lastSuccess.recomputedFrom,f.previous.generation);assert.equal(replay.lastSuccess.patternVersion,patterns.version);assert.equal(replay.lastSuccess.patternProfile.id,'daily-close-volume-v1');
  assert.equal(replay.lastSuccess.day,latest.date);assert.equal(replay.lastSuccess.asOf,asOf);assert.equal(replay.lastSuccess.total,1000);assert.equal(replay.lastSuccess.ready,999);
  assert.equal(await readFile(join(dir,'status.json'),'utf8'),'中止或完成的原始采集回执保持不变');assert.equal(await readFile(join(f.location,'dataset-all-000300.SH.json'),'utf8'),before);
  assert.equal(JSON.parse(await readFile(join(dir,'current.json'))).generation,replay.lastSuccess.generation);
  const marker=JSON.parse(await readFile(join(dir,'generations',replay.lastSuccess.generation,'complete.json')));assert.equal(marker.recomputedFrom,f.previous.generation);assert.equal(marker.completed,true);
  for(const code of INDICES)for(const mode of ['consensus','market','strength'])for(const lookback of [20,60]){
    const value=JSON.parse(await readFile(join(dir,'generations',replay.lastSuccess.generation,'result-'+mode+'-'+lookback+'-all-'+code+'.json')));
    assert.equal(value.records.length,1000);assert.equal(value.patternDefinitions.length,16);assert.equal(value.records[0].fetchedAt,new Date(now()).toISOString());assert.equal(value.dataPolicy.rawPublic,false);
    assert.equal(value.patternVersion,patterns.version);assert.equal(value.records[0].patterns.facts.version,patterns.version);assert.equal(value.records[0].patterns.facts.day,value.day);assert.equal(value.records[0].patterns.facts.lookback,lookback);assert.deepEqual(value.records[0].patterns.facts.profile,patterns.profile);
    assert.equal(value.records.at(-1).patterns.status,'unavailable');assert.equal(value.records.at(-1).patterns.labels.length,0);
    assert.doesNotMatch(JSON.stringify(value),/"bars"|"startClose"|"endClose"/);
  }
}));
test('offline replay rejects inconsistent private calendars, sources or incomplete universes before compute and keeps the published pointer',async()=>fixture(async dir=>{
  const f=await privateReplay(dir),pointer=await readFile(join(dir,'current.json'),'utf8'),path=join(f.location,'dataset-all-000001.SH.json'),original=JSON.parse(await readFile(path));let computes=0;
  for(const change of [data=>{data.reference.code='399001.SZ';},data=>{data.records[0].source.sourceId='another-source';},data=>{data.records.pop();},data=>{data.records[0].source.bars[1].close+=1;}]){
    const invalid=JSON.parse(JSON.stringify(original));change(invalid);await writeFile(path,JSON.stringify(invalid));
    await assert.rejects(recomputeFromCache({dir,siteDir:resolve('.'),compute:async()=>{computes++;}}));assert.equal(computes,0);assert.equal(await readFile(join(dir,'current.json'),'utf8'),pointer);
  }
}));
test('offline compute failures or unfinished artifacts cannot replace a complete pointer or source receipt',async()=>fixture(async dir=>{
  await privateReplay(dir);const pointer=await readFile(join(dir,'current.json'),'utf8'),receipt=await readFile(join(dir,'status.json'),'utf8');
  for(const compute of [async()=>{throw Error('disk full');},async input=>({generation:'2026-11-20-2',day:input.day,asOf:input.asOf,sourceId,total:1000,ready:999})]){
    await assert.rejects(recomputeFromCache({dir,siteDir:resolve('.'),compute}));assert.equal(await readFile(join(dir,'current.json'),'utf8'),pointer);assert.equal(await readFile(join(dir,'status.json'),'utf8'),receipt);
  }
}));
