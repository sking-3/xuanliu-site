import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {precomputeMarketPosition} from '../server/a-share-market-position.mjs';
import {precomputeDecisionAnalogues,filename,version} from '../server/a-share-decision-analogues.mjs';

const require=createRequire(import.meta.url),calendar=require('../market-calendar.js'),day='2026-12-31',now=()=>Date.parse(day+'T10:00:00Z');
function tradingDates(count){const dates=[];for(let time=Date.parse(day+'T00:00:00Z');dates.length<count;time-=86400000){const value=new Date(time).toISOString().slice(0,10);if(!value.startsWith('2026-'))throw Error('Synthetic fixture exceeds verified calendar');if(calendar.session('CN',value).open)dates.unshift(value);}return dates;}
function makeRecord(dates,index=0,{interval=16,drift=0,trend=false}={}){
  const pulses=new Set();for(let at=64;at<dates.length;at+=interval)pulses.add(at);pulses.add(dates.length-1);let price=10+index,step=Math.pow(1+drift/100,1/15);
  const bars=dates.map((date,at)=>{if(trend)price=10+index+at*.015;else if(pulses.has(at))price*=1.1;else if(at>64)price*=step;return {date,open:price-.025,high:pulses.has(at)&&!trend?price:price+.1,low:price-.1,close:price,volume:1000};});
  return {stock:{code:String(600000+index)+'.SH',name:'合成历史类似测试'+index,listingDate:'2000-01-01',sector:'未分类'},source:{sourceId:'tickflow-free-forward-v1',day,status:'ready',adjustment:'qfq',historyRequested:500,fetchedAt:day+'T08:00:00Z',bars}};
}
async function fixture(t,{count=225,stocks=1,interval=16,drifts=[],trend=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'books-decision-analogues-'));t.after(()=>rm(dir,{recursive:true,force:true}));const target=join(dir,'generation');await mkdir(target);const dates=tradingDates(count),records=Array.from({length:stocks},(_,index)=>makeRecord(dates,index,{interval,drift:drifts[index]||0,trend})),batch={generation:day+'-1798729200000',sourceId:'tickflow-free-forward-v1',day,asOf:day+'T07:00:00.000Z',total:stocks};
  const header={schema:'books.a-share.history.v1',...batch,historyRequested:500,reference:{code:'000300.SH',adjustment:'index',fetchedAt:day+'T08:00:00Z',bars:dates.map(date=>({date,open:100,high:101,low:99,close:100,volume:1000}))}},historyFile=join(dir,'history-all.ndjson');
  const save=()=>writeFile(historyFile,[header,...records].map(JSON.stringify).join('\n'));await save();const position=await precomputeMarketPosition({historyFile,target,batch,now});await writeFile(join(dir,'current.json'),'synthetic-current-pointer');
  const run=options=>precomputeDecisionAnalogues({historyFile,target,batch,position,now,...options});return {dir,target,dates,records,batch,header,historyFile,position,save,run};
}
const close=(actual,expected)=>assert(Math.abs(actual-expected)<1e-8,actual+' != '+expected);

test('only requested same-regime/position groups are aggregated; complete paths have real quantiles and never qualify a stock',async t=>{
  const f=await fixture(t,{stocks:10,drifts:Array.from({length:10},(_,index)=>index-5)}),report=await f.run(),summary=report.byCode['600000.SH'].primary;
  assert.equal(report.version,version);assert.equal(report.eligibleForSelection,false);assert.equal(report.currentRosterBias,true);assert.equal(Object.keys(report.groups).length,1);assert.equal(summary.classId,'limit:first');assert.equal(summary.regime,'sideways');assert.equal(summary.positionBand,'high');assert.equal(summary.method,'historical_close_path_not_forecast_or_trade_return');assert.equal(summary.currentRosterBias,true);assert.equal(summary.eligibleForSelection,false);
  const full=summary.horizons[15];assert.equal(full.sampleCount,100);assert.equal(full.stockCount,10);assert.equal(full.signalDayCount,10);assert.equal(full.adequate,true);close(full.meanReturnPercent,-.5);close(full.medianReturnPercent,-.5);close(full.p25ReturnPercent,-3);close(full.p75ReturnPercent,2);close(full.positiveRate,.4);close(full.worstDrawdownPercent,5);close(full.meanDrawdownPercent,1.5);
  assert.equal(summary.path.sampleCount,100);assert.equal(summary.path.steps.length,16);assert.equal(summary.path.median[0],0);close(summary.path.median[15],-.5);assert.equal(summary.path.fromDay,f.dates[64]);assert.equal(summary.path.toDay,f.dates[208]);assert.equal(summary.path.lastOutcomeDay,f.dates[223]);assert.deepEqual(summary.path.reasons,[]);assert.equal(report.byCode['600000.SH'].core,null);assert.equal(report.byCode['600000.SH'].coreReason,'fixed_pattern_analogues_not_in_first_version');assert.equal(Object.hasOwn(report,'bars'),false);
});
test('setup analogues use the four fixed current model IDs and retain an explicit missing core result',async t=>{
  const f=await fixture(t,{count:100,trend:true}),report=await f.run(),setups=report.bySetup['600000.SH'];assert(setups['trend-pullback']);assert(setups['trend-continuation']);assert.equal(report.byCode['600000.SH'].primary.classId,'setup:trend-pullback');assert.equal(report.byCode['600000.SH'].core,null);assert.equal(setups['trend-continuation'].eligibleForSelection,false);assert.equal(setups['trend-continuation'].horizons[15].adequate,false);assert(setups['trend-continuation'].horizons[15].reasons.includes('fewer_than_10_stocks'));
});
test('each horizon matures independently and no unfinished fifteen-session path is filled with zero',async t=>{
  const f=await fixture(t,{count:190}),report=await f.run(),summary=report.byCode['600000.SH'].primary;assert.equal(summary.horizons[1].sampleCount,8);assert.equal(summary.horizons[5].sampleCount,8);assert.equal(summary.horizons[15].sampleCount,7);assert.equal(summary.horizons[15].pendingCount,1);assert.equal(summary.path.sampleCount,7);
  const g=await fixture(t,{count:65}),pending=(await g.run()).byCode['600000.SH'].primary;assert.equal(pending.horizons[1].sampleCount,0);assert.equal(pending.horizons[1].meanReturnPercent,null);assert.equal(pending.horizons[15].pendingCount,1);assert.equal(pending.path.median,null);assert.equal(pending.path.p25,null);assert.equal(pending.path.p75,null);assert.equal(pending.path.fromDay,null);
});
test('stock/class intervals are reserved at the signal before future returns and require sixteen-session spacing',async t=>{
  const f=await fixture(t,{interval:8}),first=await f.run(),summary=first.byCode['600000.SH'].primary;assert.equal(first.coverage.selectedSignals,11);assert.equal(first.coverage.overlapSkipped,10);assert.equal(summary.horizons[15].sampleCount,10);assert.equal(summary.horizons[15].fromDay,f.dates[64]);
  const g=await fixture(t,{interval:8});const bar=g.records[0].source.bars[65],price=bar.close/2;Object.assign(bar,{open:price-.025,high:price+.1,low:price-.1,close:price});await g.save();const changed=await g.run(),other=changed.byCode['600000.SH'].primary;
  assert.equal(changed.coverage.selectedSignals,first.coverage.selectedSignals);assert.equal(changed.coverage.overlapSkipped,first.coverage.overlapSkipped);assert.equal(other.horizons[1].fromDay,summary.horizons[1].fromDay);assert(other.horizons[1].meanReturnPercent<summary.horizons[1].meanReturnPercent);assert(other.horizons[15].worstDrawdownPercent>40);
});
test('a missing future session is unavailable, not skipped or treated as a flat return',async t=>{
  const f=await fixture(t,{count:190,stocks:2});f.records[1].source.bars.splice(177,1);await f.save();
  await rm(join(f.target,'market-position-v1.json'));await rm(join(f.target,'market-position-v1.json.gz'));f.position=await precomputeMarketPosition({historyFile:f.historyFile,target:f.target,batch:f.batch,now});
  const report=await f.run({position:f.position}),summary=report.byCode['600000.SH'].primary;assert.equal(summary.horizons[1].sampleCount,15);assert.equal(summary.horizons[1].unavailableCount,1);assert.equal(summary.horizons[15].sampleCount,14);assert.equal(summary.horizons[15].pendingCount,2);assert.equal(report.byCode['600001.SH'].primary,null);assert.equal(report.byCode['600001.SH'].reason,'verified_60_session_position_unavailable');
});
test('wrong position/header/source identities and future suffix dates cannot publish a new analogue report',async t=>{
  for(const change of [f=>f.position.generation=day+'-2',f=>f.header.reference.code='000001.SH',f=>f.records[0].source.sourceId='other',f=>f.records[0].source.bars.at(-1).date='2027-01-01']){
    const f=await fixture(t,{count:100});change(f);await f.save();await assert.rejects(f.run(),/matching|header|benchmark|identity|date|source/);assert(!(await readdir(f.target)).includes(filename+'.json'));assert.equal(await readFile(join(f.dir,'current.json'),'utf8'),'synthetic-current-pointer');
  }
});
test('gzip-only cached group statistics restore without raw rescanning or altering source/position snapshots',async t=>{
  const f=await fixture(t,{count:100}),raw=await readFile(f.historyFile),position=structuredClone(f.position),first=await f.run(),file=join(f.target,filename+'.json'),plain=await readFile(file),compressed=await readFile(file+'.gz');assert.deepEqual(gunzipSync(compressed),plain);assert.deepEqual(await readFile(f.historyFile),raw);assert.deepEqual(f.position,position);await rm(file);await rm(f.historyFile);assert.deepEqual(await f.run(),first);assert.deepEqual(await readFile(file+'.gz'),compressed);
});
