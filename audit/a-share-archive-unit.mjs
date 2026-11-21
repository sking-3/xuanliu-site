import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {publishArchivedDataset} from '../server/a-share-archive.mjs';

const require=createRequire(import.meta.url),engine=require('../screening/trend-screen.js'),model=require('../control/model.js');
const now=()=>Date.parse('2026-11-21T00:00:00Z'),archiveId='completed-real-archive';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'books-historical-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const json=async file=>JSON.parse(await readFile(file,'utf8'));
function dataset(){
  const dates=[];for(let stamp=Date.parse('2026-08-01T00:00:00Z');stamp<=Date.parse('2026-11-20T00:00:00Z');stamp+=86400000){const date=new Date(stamp);if(date.getUTCDay()>0&&date.getUTCDay()<6)dates.push(date.toISOString().slice(0,10));}
  const bars=dates.slice(-61).map((date,index)=>({date,close:100+index/10+Math.sin(index)/2,volume:1000+index}));
  const universe=Array.from({length:200},(_,index)=>({code:index<100?String(600000+index)+'.SH':String(index).padStart(6,'0')+'.SZ',name:'股票'+index,sector:'行业'+index%5,exchange:index<100?'SH':'SZ'}));
  const stocks=engine.selectMarketSample(universe,120),day='2026-11-20',fetchedAt='2026-11-21T00:00:00Z';
  return {schema:'books.research.dataset.v1',day,asOf:'2026-11-20T08:15:00Z',completed:true,collectionStatus:'complete',expectedCount:120,totalUniverseCount:universe.length,universe,
    reference:{code:'000300.SH',adjustment:'index',bars,fetchedAt},records:stocks.map((stock,index)=>({stock,source:index?{status:'ready',day,adjustment:'qfq',bars:bars.map(bar=>({...bar,close:bar.close*(index+1)})),fetchedAt}:{status:'unavailable',day,reason:'缺少完整日线'}}))};
}
test('offline sample publication preserves raw provenance and independent full collection files',async t=>{
  const dir=await fixture(t),input=dataset(),before=JSON.stringify(input),status='{"attempt":{"status":"failed","checked":430,"error":"HTTP 501"}}',current='{"generation":"2026-11-19-1"}';
  await writeFile(join(dir,'status.json'),status);await writeFile(join(dir,'current.json'),current);
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('external request prohibited');};t.after(()=>{globalThis.fetch=originalFetch;});
  const published=await publishArchivedDataset({dataset:input,archiveId,dir,siteDir:resolve('.'),now});
  assert.equal(JSON.stringify(input),before);assert.equal(await readFile(join(dir,'status.json'),'utf8'),status);assert.equal(await readFile(join(dir,'current.json'),'utf8'),current);
  assert.equal(published.scope,'historical-sample');assert.equal(published.sampleCount,120);assert.equal(published.marketUniverseCount,200);assert.equal(published.fullMarket,false);assert.equal(published.ready,119);
  assert.equal(published.asOf,input.asOf);assert.equal(published.day,input.day);assert.equal(published.publishedAt,new Date(now()).toISOString());assert.equal(published.archiveId,archiveId);
  assert.deepEqual(await json(join(dir,'historical-current.json')),published);
  const location=join(dir,'generations',published.generation),files=await readdir(location);
  assert.equal(files.some(file=>file.startsWith('market.')),false);assert.equal(files.some(file=>file.includes('000001.SH')||file.includes('399001.SZ')||file.includes('-240-')),false);
  for(const sample of ['120','all'])assert.deepEqual(await json(join(location,'dataset-'+sample+'-000300.SH.json')),model.normalizeDataset(input));
  assert.equal((await json(join(location,'complete.json'))).completed,true);
  for(const mode of ['consensus','market','strength'])for(const lookback of [20,60]){
    const filename='result-'+mode+'-'+lookback+'-'+(mode==='consensus'?'120':'all')+'-000300.SH.json',result=await json(join(location,filename));
    assert.equal(result.records.length,120);assert.equal(result.scope,'historical-sample');assert.equal(result.fullMarket,false);assert.equal(result.requests,0);assert.equal(result.limits.enabled,false);assert.equal(result.day,input.day);
    const expected=await model.evaluateDataset(input,{settings:{mode,lookback,sampleSize:'120',limits:{enabled:false}}},engine);
    assert.equal(result.status,expected.status);assert.deepEqual(result.records.map(record=>record.result),expected.records.map(record=>record.result));
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(join(location,filename+'.gz')))),result);
    assert.equal(result.records[1].fetchedAt,input.records[1].source.fetchedAt);assert.equal(result.referenceFetchedAt,input.reference.fetchedAt);
  }
});
test('invalid or unfinished raw data cannot publish or replace a historical pointer',async t=>{
  const dir=await fixture(t),input=dataset(),before='{"generation":"2026-11-19-120"}';await writeFile(join(dir,'historical-current.json'),before);
  for(const invalid of [{...input,completed:false},{...input,records:input.records.slice(1)},{...input,expectedCount:119,records:input.records.slice(1)}])await assert.rejects(publishArchivedDataset({dataset:invalid,archiveId,dir,siteDir:resolve('.'),now}));
  assert.equal(await readFile(join(dir,'historical-current.json'),'utf8'),before);await assert.rejects(readdir(join(dir,'generations')),/ENOENT/);
});
test('a nonrepresentative cohort remains unavailable for common trends without blocking honest individual modes',async t=>{
  const dir=await fixture(t),input=dataset(),codes=new Set(input.records.map(record=>record.stock.code));
  input.records[1].stock=input.universe.find(stock=>!codes.has(stock.code));
  const published=await publishArchivedDataset({dataset:input,archiveId,dir,siteDir:resolve('.'),now}),location=join(dir,'generations',published.generation);
  const common=await json(join(location,'result-consensus-20-120-000300.SH.json'));
  assert.equal(common.status,'unavailable');assert.match(common.reason,/固定分层/);assert.equal(common.records.length,120);assert(common.records.every(record=>record.result.status==='unavailable'));
  const individual=await json(join(location,'result-market-20-all-000300.SH.json'));assert.equal(individual.status,'complete');assert.equal(individual.records.filter(record=>record.result.status==='ready').length,119);
});
test('short real histories do not become available for the unsupported longer period',async t=>{
  const dir=await fixture(t),input=dataset();input.reference.bars=input.reference.bars.slice(-26);for(const record of input.records)if(record.source.bars)record.source.bars=record.source.bars.slice(-26);
  const published=await publishArchivedDataset({dataset:input,archiveId,dir,siteDir:resolve('.'),now}),location=join(dir,'generations',published.generation);
  for(const mode of ['consensus','market','strength']){
    const result=await json(join(location,'result-'+mode+'-60-'+(mode==='consensus'?'120':'all')+'-000300.SH.json'));
    assert.equal(result.status,'unavailable');assert.equal(result.records.filter(record=>record.result.status==='ready').length,0);
  }
});
test('verified production archive publishes the six real period results offline without altering its source data',{skip:!process.env.BOOKS_TEST_DATASET},async t=>{
  const dir=await fixture(t),input=await json(process.env.BOOKS_TEST_DATASET),before=JSON.stringify(input),originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('external request prohibited');};t.after(()=>{globalThis.fetch=originalFetch;});
  const published=await publishArchivedDataset({dataset:input,archiveId:'0a51d3e8-0fd0-472b-a3e3-72a3ee4278ae',dir,siteDir:resolve('.'),now});
  assert.equal(JSON.stringify(input),before);assert.equal(published.sampleCount,120);assert.equal(published.marketUniverseCount,3052);assert.equal(published.ready,119);assert.equal(published.day,'2026-11-20');
  const counts={};for(const mode of ['consensus','market','strength'])for(const lookback of [20,60]){
    const value=await json(join(dir,'generations',published.generation,'result-'+mode+'-'+lookback+'-'+(mode==='consensus'?'120':'all')+'-000300.SH.json'));
    assert.equal(value.status,'complete');assert.equal(value.records.filter(record=>record.result.status==='ready').length,119);
    counts[mode+'/'+lookback]=value.records.filter(record=>engine.applyLimits(record.result,model.DEFAULT_CONFIG.settings.limits,lookback).matched===true).length;
  }
  assert.deepEqual(counts,{'consensus/20':73,'consensus/60':0,'market/20':21,'market/60':2,'strength/20':1,'strength/60':1});t.diagnostic(JSON.stringify(counts));
});
