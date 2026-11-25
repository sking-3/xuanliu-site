import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {precomputeMarketPosition,filename,version} from '../server/a-share-market-position.mjs';

const require=createRequire(import.meta.url),calendar=require('../market-calendar.js'),day='2026-11-25',now=()=>Date.parse(day+'T10:00:00Z'),dates=[];
for(let time=Date.parse(day+'T00:00:00Z');dates.length<90;time-=86400000){const value=new Date(time).toISOString().slice(0,10);if(calendar.session('CN',value).open)dates.unshift(value);}
const batch={generation:day+'-1795595546254',sourceId:'tickflow-free-forward-v1',day,asOf:day+'T07:00:00.000Z',total:1};
function bars(values=dates.map(()=>10)){return values.map((close,index)=>({date:dates[index],open:close-.01,high:close+.1,low:close-.1,close,volume:1000}));}
function record(index=0,values){return {stock:{code:String(600000+index)+'.SH',name:'合成背景测试'+index,sector:'未分类',listingDate:'2000-01-01'},source:{sourceId:batch.sourceId,day,status:'ready',adjustment:'qfq',historyRequested:500,fetchedAt:day+'T08:00:00Z',bars:bars(values)}};}
async function fixture(t,records=[record()]){
  const dir=await mkdtemp(join(tmpdir(),'books-market-position-'));t.after(()=>rm(dir,{recursive:true,force:true}));const target=join(dir,'generation'),historyFile=join(dir,'history-all.ndjson'),bound={...batch,total:records.length};await mkdir(target);
  const header={schema:'books.a-share.history.v1',...bound,historyRequested:500,universePolicy:{basis:'provider_current_reference',historicalMembership:false,sectorAsOf:null},reference:{code:'000300.SH',adjustment:'index',fetchedAt:day+'T08:00:00Z',bars:bars(dates.map((_,index)=>100+index/10))}};
  const save=()=>writeFile(historyFile,[header,...records].map(JSON.stringify).join('\n'));await save();await writeFile(join(dir,'current.json'),'synthetic-source-pointer-must-not-change');
  const run=options=>precomputeMarketPosition({historyFile,target,batch:bound,now,...options});return {dir,target,historyFile,bound,header,records,save,run};
}

test('computes per-metric full-universe denominators and return midranks without selecting candidates',async t=>{
  const records=[record(0),record(1),record(2,dates.map((_,index)=>index<69?10:10+(index-69)/10)),record(3)];records[3].source.status='unavailable';records[3].source.bars=records[3].source.bars.slice(-10);
  const f=await fixture(t,records),report=await f.run(),breadth=report.market.breadth;
  assert.equal(report.schema,'books.a-share.market-position.v1');assert.equal(report.version,version);assert.equal(report.completed,true);assert.equal(report.datasetBound,true);assert.equal(report.eligibleForSelection,false);assert.equal(report.market.scope,'current_roster_sh_sz_mainboard');
  assert.deepEqual(report.market.coverage,{total:4,ready:4,riskExcluded:0,missing:0});assert.equal(breadth.validPairs,4);assert.equal(breadth.advancers,1);assert.equal(breadth.flat,3);assert.equal(breadth.decliners,0);assert.equal(breadth.advancersPercent,25);assert.equal(breadth.ma20Denominator,3);assert.equal(breadth.aboveMa20Count,1);assert(Math.abs(breadth.aboveMa20Percent-100/3)<1e-10);
  assert.equal(report.byCode['600000.SH'].strength.return20Percentile,25);assert.equal(report.byCode['600001.SH'].strength.return20Percentile,25);assert.equal(report.byCode['600002.SH'].strength.return20Percentile,100);assert.equal(report.byCode['600003.SH'].strength.return20Percentile,null);assert.equal(report.byCode['600003.SH'].strength.return20Denominator,3);
  assert.equal(report.byCode['600003.SH'].metrics.return20,null);assert.equal(report.byCode['600000.SH'].sourceFetchedAt,records[0].source.fetchedAt);assert(report.byCode['600002.SH'].metrics.benchmarkReturn20>0);assert(Number.isFinite(report.byCode['600002.SH'].metrics.excess20));assert.equal(report.method.historicalMembership,false);assert.equal(report.method.survivorshipBias,true);assert.equal(report.method.savedScheme15DayPolicyChanged,false);
  assert.equal(report.market.sector.status,'unavailable');assert.equal(report.market.sector.knownCount,0);assert.doesNotMatch(JSON.stringify(report),/"bars"\s*:/);assert(Object.values(report.byCode).every(value=>value.setups.every(setup=>setup.qualified===false&&setup.actualFillVerified===false)));
});
test('missing actual sessions remove only their own metric denominators; no suspension is bridged',async t=>{
  const row=record();row.source.bars.splice(-10,1);const f=await fixture(t,[row]),report=await f.run(),value=report.byCode[row.stock.code];
  assert.equal(report.market.coverage.ready,1);assert.equal(report.market.breadth.validPairs,1);assert.equal(report.market.breadth.ma20Denominator,0);assert.equal(report.market.breadth.aboveMa20Percent,null);assert.equal(value.metrics.return20,null);assert.equal(value.strength.return20Denominator,0);assert.equal(value.strength.return20Percentile,null);
  const missingPrior=record();missingPrior.source.bars.splice(-2,1);const g=await fixture(t,[missingPrior]),second=await g.run();assert.equal(second.market.breadth.validPairs,0);assert.equal(second.market.breadth.advancersPercent,null);assert.equal(second.market.breadth.flat,0);
});
test('risk names and zero-price bars never become ordinary flat shares or zero-valued estimates',async t=>{
  const zero=record(),risk=record(1);Object.assign(zero.source.bars.at(-1),{open:0,high:0,low:0,close:0,volume:0});risk.stock.name=' *ST 合成';const f=await fixture(t,[zero,risk]),report=await f.run();
  assert.deepEqual(report.market.coverage,{total:2,ready:0,riskExcluded:1,missing:1});assert.equal(Object.hasOwn(report.byCode,risk.stock.code),false);assert.equal(report.market.breadth.validPairs,0);assert.equal(report.market.breadth.advancersPercent,null);assert.equal(report.market.breadth.aboveMa20Percent,null);assert.equal(report.byCode[zero.stock.code].metrics.close,null);assert.equal(report.byCode[zero.stock.code].strength.return60Denominator,0);assert.equal(report.byCode[zero.stock.code].strength.return60Percentile,null);
});
test('limit-like counts include one-price and all ordinary shares while new listings and unknown dates remain explicit',async t=>{
  const young=record(0),unknown=record(1),onePrice=record(2),consecutive=record(3);young.stock.listingDate=dates.at(-3);young.source.status='unavailable';young.source.bars=young.source.bars.slice(-3);unknown.stock.listingDate=null;
  for(const row of [young,unknown,onePrice,consecutive])Object.assign(row.source.bars.at(-1),{open:10.1,high:11,low:10,close:11});Object.assign(onePrice.source.bars.at(-1),{open:11,high:11,low:11,close:11});
  Object.assign(consecutive.source.bars.at(-3),{open:9.08,high:9.2,low:9,close:9.09});Object.assign(consecutive.source.bars.at(-2),{open:9.5,high:10,low:9.4,close:10});
  const f=await fixture(t,[young,unknown,onePrice,consecutive]),report=await f.run(),limit=report.market.limitUpLike;
  assert.equal(report.byCode[young.stock.code].limitUp.status,'excluded');assert.equal(report.byCode[unknown.stock.code].limitUp.status,'unknown');assert.equal(limit.count,2);assert.equal(limit.denominator,2);assert.equal(limit.onePriceCount,1);assert.equal(limit.streakDistribution['1'],1);assert.equal(limit.streakDistribution['2'],1);assert.equal(limit.officialLimitPriceVerified,false);assert.equal(report.eligibleForSelection,false);
});
test('a sole known return has its denominator but no fabricated cross-sectional percentile',async t=>{
  const f=await fixture(t),report=await f.run(),strength=report.byCode['600000.SH'].strength;assert.equal(strength.return20Denominator,1);assert.equal(strength.return20Percentile,null);assert.equal(strength.return60Denominator,1);assert.equal(strength.return60Percentile,null);
});
test('source/header/schema/reference identity and future read or bar violations cannot publish',async t=>{
  const changes=[f=>f.header.schema='other',f=>f.header.sourceId='other',f=>f.header.generation=day+'-2',f=>f.header.day='2026-11-24',f=>f.header.asOf=day+'T06:00:00Z',f=>f.header.historyRequested=61,f=>f.header.reference.code='000001.SH',f=>f.header.reference.fetchedAt=day+'T06:59:59Z',f=>f.records[0].source.sourceId='other',f=>f.records[0].source.adjustment='none',f=>f.records[0].source.fetchedAt='2026-11-26T08:00:00Z',f=>f.records[0].source.bars.at(-1).date='2026-11-26',f=>f.header.reference.bars.at(-1).date='2026-11-26'];
  for(const change of changes){const f=await fixture(t);change(f);await f.save();await assert.rejects(f.run(),/header|benchmark|identity|qfq|date|acquisition/);assert.deepEqual(await readdir(f.target),[]);assert.equal(await readFile(join(f.dir,'current.json'),'utf8'),'synthetic-source-pointer-must-not-change');}
});
test('duplicate or truncated full-universe records leave no partial report or source-pointer change',async t=>{
  const duplicate=await fixture(t,[record(),record()]);await assert.rejects(duplicate.run(),/identity/);assert.deepEqual(await readdir(duplicate.target),[]);
  const truncated=await fixture(t,[record(),record(1)]);truncated.records.pop();await truncated.save();await assert.rejects(truncated.run(),/coverage is incomplete/);assert.deepEqual(await readdir(truncated.target),[]);
});
test('gzip restores the same report and same-generation reuse requires no raw scan or changed timestamps',async t=>{
  const f=await fixture(t,[record(),record(1)]),raw=await readFile(f.historyFile),pointer=await readFile(join(f.dir,'current.json')),first=await f.run(),file=join(f.target,filename+'.json'),plain=await readFile(file),compressed=await readFile(file+'.gz');assert.deepEqual(gunzipSync(compressed),plain);assert.deepEqual(await readFile(f.historyFile),raw);assert.deepEqual(await readFile(join(f.dir,'current.json')),pointer);
  await rm(file);await rm(f.historyFile);assert.deepEqual(await f.run({now:()=>now()+3600000}),first);assert.deepEqual(await readFile(file+'.gz'),compressed);
  await assert.rejects(f.run({batch:{...f.bound,sourceId:'other-source'}}),/existing report differs/);assert.deepEqual(await readFile(file+'.gz'),compressed);
});
test('partial sector labels are counted without claiming industry coverage, hot themes or leadership',async t=>{
  const a=record(),b=record(1);a.stock.sector='银行';const f=await fixture(t,[a,b]),report=await f.run();assert.equal(report.market.sector.knownCount,1);assert.equal(report.market.sector.status,'unavailable');assert.match(report.market.sector.reason,/未核对独立来源和日期/);
});
test('aborted new precomputation does not publish any replacement artifact',async t=>{
  const f=await fixture(t),control=new AbortController();control.abort(Error('synthetic cancellation'));await assert.rejects(f.run({signal:control.signal}),/synthetic cancellation/);assert.deepEqual(await readdir(f.target),[]);
});
