import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {precomputeDecisionContext,enrichDecisionContext,filename,chartDirectoryName,version} from '../server/a-share-decision-context.mjs';
import {version as positionVersion} from '../server/a-share-market-position.mjs';
import {writeIntradayCharts} from '../server/a-share-intraday-chart.mjs';
const sourceId='tickflow-free-forward-v1',code='600000.SH';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'books-decision-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const dates=[];for(let time=Date.parse('2026-08-01T00:00:00Z');dates.length<84;time+=86400000)if(![0,6].includes(new Date(time).getUTCDay()))dates.push(new Date(time).toISOString().slice(0,10));
 const bars=dates.map((date,i)=>({date,open:10+i*.01,high:10.2+i*.01,low:9.8+i*.01,close:10.1+i*.01,volume:1000}));
 async function prepare(end=80){
  const day=dates[end-1],asOf=day+'T07:00:00.000Z',batch={generation:day+'-123',sourceId,day,asOf,total:1},target=join(dir,'generations',batch.generation),now=()=>Date.parse(day+'T12:00:00Z');await mkdir(target,{recursive:true});await writeFile(join(dir,'current.json'),JSON.stringify(batch));
  const source={sourceId,day,status:'ready',adjustment:'qfq',historyRequested:500,fetchedAt:day+'T08:00:00Z',bars:bars.slice(0,end)},reference={code:'000300.SH',adjustment:'index',fetchedAt:source.fetchedAt,bars:source.bars};
  const historyFile=join(target,'history.ndjson');await writeFile(historyFile,[{schema:'books.a-share.history.v1',...batch,historyRequested:500,reference},{stock:{code,name:'合成接口样本',listingDate:'2000-01-01'},source}].map(JSON.stringify).join('\n'));
  const setups=['range-support','support-reclaim'].map((id,i)=>({id,label:id,trigger:12+i,invalidation:9-i,buyZone:{low:9.8,high:10},reduceZone:{low:12.5+i,high:13+i},reason:['合成单测条件'],modelState:id==='range-support'?'existing_position_T_watch':'countertrend_watch',qualified:false,actualFillVerified:false}));
  const position={...batch,version:positionVersion,completed:true,market:{coverage:{total:1}},byCode:{[code]:{name:'合成接口样本',sourceFetchedAt:source.fetchedAt,metrics:{close:source.bars.at(-1).close,open:9,high:99,low:1,return20:1,volumeRatio20:1,rangePosition60Percent:40},strength:{return20Percentile:null},limitUp:{atLimit:false},setups}}},analogues={...batch,completed:true,byCode:{},bySetup:{[code]:{'range-support':{key:'range',method:'historical_close_path_not_forecast_or_trade_return'}}}};
  return {dir,target,batch,historyFile,position,analogues,nextSessionDay:dates[end],now,writeChart:writeIntradayCharts};
 }
 return {dir,prepare};
}
test('all coded setup rows keep distinct plans/charts and never gain B eligibility',async t=>{
 const f=await fixture(t),options=await f.prepare(),report=await precomputeDecisionContext(options);assert.equal(report.current.length,2);assert.equal(report.summary.qualifiedCount,0);assert.equal(new Set(report.current.map(row=>row.id)).size,2);
 for(const row of report.current){assert.equal(row.qualified,false);assert.notEqual(row.state,'triggered_B');assert.equal(row.research.plan.code,row.code);assert.equal(row.firstSeenAt,new Date(options.now()).toISOString());const kind=row.research.plan.kind;assert.ok(report.charts.some(chart=>chart.kind===kind));const svg=await readFile(join(options.target,chartDirectoryName,kind,code+'-60.svg'),'utf8');assert.match(svg,/data-normalization="first-close-percent"/);assert.doesNotMatch(svg,/data-kind="B"/);}
 assert.notEqual(report.current[0].chartUrls[60],report.current[1].chartUrls[60]);
});
test('rerunning a completed generation restores gzip without rescanning or changing first seen',async t=>{
 const f=await fixture(t),options=await f.prepare(),first=await precomputeDecisionContext(options);await unlink(options.historyFile);await unlink(join(options.target,filename+'.json'));
 const second=await precomputeDecisionContext({...options,now:()=>options.now()+60000});assert.deepEqual(second,first);assert.equal(second.version,version);
});
test('future completed session advances three-day tracking without replacing original discovery',async t=>{
 const f=await fixture(t),firstOptions=await f.prepare(80),first=await precomputeDecisionContext(firstOptions),nextOptions=await f.prepare(83),next=await precomputeDecisionContext(nextOptions),track=next.tracks.find(item=>item.id===first.current[0].id);
 assert.equal(track.firstSeenAt,first.current[0].firstSeenAt);assert.deepEqual(track.original,first.tracks[0].original);assert.equal(track.observations[3].status,'ready');assert.equal(track.observations[3].targetDay,nextOptions.batch.day);assert.ok(track.observations[3].returnPercent>0);assert.equal(next.current[0].observations[3].returnPercent,null);
});
test('public projection never leaks private raw bar metrics or lends one model another price',async t=>{
 const f=await fixture(t),options=await f.prepare(),context=await precomputeDecisionContext(options),view={...options.batch,computedAt:options.batch.asOf,current:[],tracks:[],marketContext:{},summary:{}},result=enrichDecisionContext(view,context,options.position,options.analogues,options.now());
 assert.equal(result.computedAt,context.computedAt);assert.equal(result.originalComputedAt,view.computedAt);assert.equal(result.asOf,options.batch.asOf);assert.equal(view.computedAt,options.batch.asOf);
 assert.equal(result.summary.nearBCount+result.summary.triggeredBCount+result.summary.watchCount,result.current.length);assert.equal(result.summary.thirdSessionReadyCount,0);
 assert.equal(result.current.length,2);assert.equal(result.current[0].research.analogue.key,'range');assert.equal(result.current[1].research.analogue,null);for(const row of result.current){assert.equal(row.research.position.metrics.open,undefined);assert.equal(row.research.position.metrics.high,undefined);assert.equal(row.research.position.metrics.low,undefined);assert.equal(row.research.position.metrics.close,undefined);assert.equal(row.reference.trigger,row.research.plan.trigger);assert.equal(row.research.position.metrics.return20,1);}
 const expired=enrichDecisionContext(view,context,options.position,options.analogues,Date.parse(context.current[0].activeUntil)+1);assert.equal(expired.current[0].displayState,'expired');assert.equal(context.current[0].displayState,undefined);
});
test('mismatched context inputs or failed chart cannot publish over last success',async t=>{
 const f=await fixture(t),options=await f.prepare(),first=await precomputeDecisionContext(options),pointer=await readFile(join(f.dir,filename,'current.json'),'utf8');const next=await f.prepare(83);
 await assert.rejects(precomputeDecisionContext({...next,position:{...next.position,day:'2000-01-01'}}),/same-batch/);
 await assert.rejects(precomputeDecisionContext({...next,writeChart:async()=>{throw Error('disk write failed');}}),/disk write failed/);assert.equal(await readFile(join(f.dir,filename,'current.json'),'utf8'),pointer);assert.equal(first.current[0].qualified,false);
});
