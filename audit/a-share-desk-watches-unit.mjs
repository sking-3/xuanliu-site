import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {precomputeDeskWatches,filename,chartDirectoryName,schema} from '../server/a-share-desk-watches.mjs';

const day='2026-11-25',nextSessionDay='2026-11-26',now=()=>Date.parse(day+'T10:00:00Z');
const dates=[];for(let time=Date.parse(day+'T00:00:00Z');dates.length<70;time-=86400000){const date=new Date(time);if(![0,6].includes(date.getUTCDay()))dates.unshift(date.toISOString().slice(0,10));}
const batch={generation:day+'-1795595546254',sourceId:'tickflow-free-forward-v1',day,asOf:day+'T07:00:00.000Z',total:1};
function bars(closes=dates.map(()=>10)){return closes.map((close,index)=>({date:dates[index],open:close-.03,high:close+.05,low:close-.05,close,volume:100}));}
function record(code='600000.SH',type='limit'){
 const source={sourceId:batch.sourceId,day,status:'ready',historyRequested:500,adjustment:'qfq',fetchedAt:day+'T08:00:00Z',bars:bars()};
 if(type==='limit')source.bars[source.bars.length-1]={date:day,open:10.1,high:11,low:10.05,close:11,volume:150};
 if(type==='early')source.bars=bars(dates.map((_,index)=>index<50?10:10+(index-49)*.025));
 return {stock:{code,name:'合成测试普通股',listingDate:'2000-01-01'},source};
}
function event(code='600000.SH',extra={}){return {id:'1225686142',code,title:'投资者关系活动记录表',url:'https://static.cninfo.com.cn/finalpage/2026-11-25/1225686142.PDF',sourceDate:day,publishedAt:null,precision:'day',firstSeenAt:day+'T09:00:00Z',kind:'research_visit',summary:'调研或投资者关系活动披露；参与调研不代表买入或持仓。',...extra};}
function institutions(events=[event()]){return {status:'complete',sourceId:'cninfo-public-announcements-v1',checkedAt:day+'T09:30:00Z',byCode:Object.groupBy(events,item=>item.code)};}
async function fixture(t,records=[record()]){
 const dir=await mkdtemp(join(tmpdir(),'books-desk-watch-unit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const target=join(dir,'generation'),historyFile=join(dir,'history-all.ndjson'),bound={...batch,total:records.length};await mkdir(target);
 const header={schema:'books.a-share.history.v1',...bound,historyRequested:500,reference:{code:'000300.SH',adjustment:'index',fetchedAt:day+'T08:00:00Z',bars:bars()}};
 const save=()=>writeFile(historyFile,[header,...records].map(JSON.stringify).join('\n')+'\n');await save();
 const calls=[];
 const writeChart=async({directory,row,bars:history})=>{
  calls.push({row:structuredClone(row),count:history.length,last:history.at(-1).close});
  for(const window of [60,120]){const body='<svg data-normalization="first-close-percent"><text>derived</text></svg>',file=join(directory,row.code+'-'+window+'.svg');await writeFile(file,body);await writeFile(file+'.gz',gzipSync(body));}
 };
 const run=options=>precomputeDeskWatches({historyFile,target,batch:bound,nextSessionDay,now,writeChart,...options});return {target,historyFile,bound,header,records,save,calls,run};
}

test('streams a source-today limit-up observation without inventing a B or official limit-price verification',async t=>{
 const f=await fixture(t),report=await f.run();assert.equal(report.schema,schema);assert.equal(report.summary.universeCount,1);assert.equal(report.summary.shortTermCount,1);assert.equal(report.summary.qualifiedCount,0);
 const row=report.current[0];assert.equal(row.familyId,'close-limitup-watch');assert.equal(row.strategy,'short-term');assert.equal(row.label,'收盘涨停观察·次日须复核');assert.equal(row.state,'watch');assert.equal(row.qualified,false);assert.equal(row.actualFillVerified,false);assert.equal(row.phase,'close');assert.deepEqual(row.reference,{close:11,trigger:null,invalidation:null});assert.equal(row.firstSeenAt,new Date(now()).toISOString());assert.equal(row.sourceFetchedAt,day+'T08:00:00Z');assert.equal(row.activeUntil,nextSessionDay+'T09:30:00+08:00');
 for(const key of ['sourceId','generation','day','asOf'])assert.equal(row[key],f.bound[key]);assert.equal(row.research.closeLimitReference.officialLimitPriceVerified,false);assert.equal(row.research.closeLimitReference.roundedTenPercent,11);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].last,11);assert.equal(report.charts.length,2);assert.ok(report.charts.every(chart=>chart.generation===f.bound.generation));assert.match(row.chartUrls[60],/workbench-chart\?generation=/);assert.equal(new URL(row.chartUrls[60],'http://local').searchParams.get('code'),row.code);
 const body=await readFile(join(f.target,filename+'.json'));assert.ok(gunzipSync(await readFile(join(f.target,filename+'.json.gz'))).equals(body));assert.equal(JSON.parse(body).current[0].id,JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]));assert.equal(Object.hasOwn(JSON.parse(body),'bars'),false);assert.equal(Object.hasOwn(row.research,'bars'),false);
});
test('rounded ten-percent close uses the prior actual session, not an older stock bar',async t=>{
 const row=record();row.source.bars.at(-2).close=9.99;row.source.bars.at(-2).open=9.98;row.source.bars.at(-2).high=10;row.source.bars.at(-2).low=9.97;row.source.bars.at(-1).close=10.99;row.source.bars.at(-1).high=10.99;
 const f=await fixture(t,[row]);assert.equal((await f.run()).current[0].research.closeLimitReference.roundedTenPercent,10.99);
 const g=await fixture(t,[record()]);g.records[0].source.bars.splice(-2,1);await g.save();const result=await g.run();assert.equal(result.current.length,0);assert.equal(result.summary.missingBasis,1);
});
test('excludes one-price bars, ST names, unknown listing dates and first five listing sessions',async t=>{
 const rows=[record('600000.SH'),record('600001.SH'),record('600002.SH'),record('600003.SH'),record('600004.SH')];
 rows[0].source.bars[69]={date:day,open:11,high:11,low:11,close:11,volume:100};rows[1].stock.name=' *ST 合成';rows[2].stock.listingDate=null;rows[3].stock.listingDate=dates.at(-5);rows[4].source.bars.at(-1).volume=0;
 const f=await fixture(t,rows),result=await f.run();assert.equal(result.current.length,0);assert.equal(result.summary.limitupFlatExcluded,1);assert.equal(result.summary.riskExcluded,1);assert.equal(result.summary.limitupListingUnknown,1);assert.equal(result.summary.limitupNewListingExcluded,1);assert.equal(result.summary.missingBasis,1);assert.equal(result.summary.processed,5);
});
test('institution activity produces a distinct unqualified early-strength watch with frozen real evidence',async t=>{
 const original=event(),f=await fixture(t,[record('600000.SH','early')]),result=await f.run({institutions:institutions([original])}),row=result.current[0];
 assert.equal(result.summary.institutionCount,1);assert.equal(result.summary.shortTermCount,0);assert.equal(row.strategy,'institution');assert.equal(row.familyId,'institution-disclosure-watch');assert.deepEqual(row.ruleIds,['research-visit']);assert.equal(row.qualified,false);assert.equal(row.state,'watch');assert.deepEqual(row.reference,{close:10.5,trigger:null,invalidation:null});assert.deepEqual(row.research.institutionalEvidence,[original]);assert.equal(row.research.institutionalEvidence[0].publishedAt,null);assert.equal(row.research.institutionalEvidence[0].firstSeenAt,original.firstSeenAt);assert.equal(row.conditionKnownAfter,new Date(original.firstSeenAt).toISOString());assert.equal(row.firstSeenAt,new Date(now()).toISOString());assert.match(row.label,/不代表机构买入/);assert.equal(result.method.institutionalBuyingInferred,false);assert.equal(result.method.originalSixteenAndThirteenGatesChanged,false);assert.ok(row.research.structure.return5>0&&row.research.structure.return5<8);assert.ok(row.research.structure.return20<15&&row.research.structure.ma20Deviation<8);assert.deepEqual(original,event());
});
test('the last-five-session date interval includes a weekend disclosure and preserves date-only precision',async t=>{
 const original=event('600000.SH',{sourceDate:'2026-11-21',url:'https://static.cninfo.com.cn/finalpage/2026-11-21/1225686142.PDF',firstSeenAt:'2026-11-23T09:00:00Z'}),f=await fixture(t,[record('600000.SH','early')]),result=await f.run({institutions:institutions([original])});
 assert.equal(result.method.institutionWindow.firstDate,'2026-11-19');assert.equal(result.current.length,1);assert.equal(result.current[0].research.institutionalEvidence[0].publishedAt,null);
});
test('does not select future, old, other-issuer or untyped disclosures',async t=>{
 const f=await fixture(t,[record('600000.SH','early')]),data=institutions([]);data.byCode['600000.SH']=[event('600000.SH',{id:'1',sourceDate:'2026-11-26'}),event('600000.SH',{id:'2',sourceDate:'2026-11-18'}),event('600001.SH',{id:'3'}),event('600000.SH',{id:'4',kind:'other'})];
 assert.equal((await f.run({institutions:data})).current.length,0);
});
test('anti-heat price caps and early strength remain required for institution-only observations',async t=>{
 const hot=record('600000.SH','early');hot.source.bars[69]={date:day,open:11.9,high:12.1,low:11.8,close:12,volume:100};
 const weak=record('600001.SH','flat'),f=await fixture(t,[hot,weak]),result=await f.run({institutions:institutions([event(),event('600001.SH',{id:'2'})])});
 assert.equal(result.summary.institutionHeatExcluded,1);assert.equal(result.summary.institutionNotEarlyExcluded,1);assert.equal(result.current.length,0);assert.deepEqual(result.method.antiHeat,{maxReturn5:8,maxReturn20:15,maxMa20Deviation:8});
});
test('deduplicates real disclosure IDs without converting plans or holdings to actual purchases',async t=>{
 const planned=event('600000.SH',{kind:'shareholder_increase',title:'股东增持计划',summary:'股东增持计划披露；不表示计划已经实施。'}),f=await fixture(t,[record('600000.SH','early')]),result=await f.run({institutions:institutions([planned,planned])});
 assert.equal(result.current[0].research.institutionalEvidence.length,1);assert.deepEqual(result.current[0].ruleIds,['shareholder-increase']);assert.equal(result.current[0].qualified,false);assert.match(result.current[0].research.institutionalEvidence[0].summary,/不表示计划已经实施/);
});
test('never overwrites existing core rows, their source files, or input collections',async t=>{
 const f=await fixture(t),core=new Set(['600000.SH']),original=structuredClone(f.records),sentinel=join(f.target,'core-current.json');await writeFile(sentinel,'core-original');const result=await f.run({existingCodes:core});
 assert.equal(result.summary.existingCoreExcluded,1);assert.equal(result.summary.processed,1);assert.equal(result.current.length,0);assert.equal(f.calls.length,0);assert.deepEqual([...core],['600000.SH']);assert.deepEqual(f.records,original);assert.equal(await readFile(sentinel,'utf8'),'core-original');
});
test('universe count, duplicate stocks and mixed source failures publish neither partial rows nor charts',async t=>{
 for(const mode of ['count','duplicate','source']){
  const f=await fixture(t,[record(),record('600001.SH')]);
  if(mode==='count')f.header.total=f.bound.total=3;if(mode==='duplicate')f.records[1].stock.code='600000.SH';if(mode==='source')f.records[1].source.sourceId='another-provider';await f.save();
  await assert.rejects(f.run(),/coverage|identity|source/);assert.ok(!(await readdir(f.target)).includes(filename+'.json'));assert.ok(!(await readdir(f.target)).includes(chartDirectoryName));assert.deepEqual(await readdir(f.target),[]);
 }
});
test('malformed references, future source reads and unsafe disclosure URLs cannot publish',async t=>{
 const a=await fixture(t);a.header.reference.bars[69].date='2026-11-26';await a.save();await assert.rejects(a.run(),/reference/);
 const b=await fixture(t);b.records[0].source.fetchedAt='2026-11-26T08:00:00Z';await b.save();await assert.rejects(b.run(),/read time/);
 const c=await fixture(t,[record('600000.SH','early')]);await assert.rejects(c.run({institutions:institutions([event('600000.SH',{url:'https://example.com/fake.pdf'})])}),/official PDF/);
});
test('requires independently restorable derived charts before completing a watch report',async t=>{
 const f=await fixture(t);await assert.rejects(f.run({writeChart:async()=>{}}),/ENOENT/);assert.deepEqual(await readdir(f.target),[]);
});
test('old invalid history never contaminates the current continuous chart or gets repaired with invented candles',async t=>{
 const row=record();for(const bar of row.source.bars.slice(0,9))bar.open=bar.high=bar.low=bar.close=0;
 const original=structuredClone(row),f=await fixture(t,[row]),result=await f.run();assert.equal(f.calls[0].count,61);assert.equal(result.current[0].research.chartBasis.continuousSessions,61);assert.equal(result.charts.find(chart=>chart.window===120).actualCandles,61);assert.equal(result.charts.find(chart=>chart.window===120).firstDate,dates[9]);assert.deepEqual(f.records[0],original);
 const g=await fixture(t);g.records[0].source.bars.splice(-10,1);await g.save();await assert.rejects(g.run(),/twenty continuous/);assert.deepEqual(await readdir(g.target),[]);
});
test('completed same-generation report is frozen and later repeats never backdate or replace its first-seen rows',async t=>{
 const f=await fixture(t),first=await f.run(),body=await readFile(join(f.target,filename+'.json'),'utf8');await writeFile(f.historyFile,'broken');
 const repeat=await f.run({now:()=>now()+3600000,writeChart:()=>{throw Error('must not rewrite');}});assert.deepEqual(repeat,first);assert.equal(await readFile(join(f.target,filename+'.json'),'utf8'),body);
 await assert.rejects(f.run({batch:{...f.bound,generation:day+'-2'}}),/existing report/);assert.equal(await readFile(join(f.target,filename+'.json'),'utf8'),body);
});
test('an interrupted chart-first publication recovers only exact derived bytes and preserves conflicting charts',async t=>{
 for(const changed of [false,true]){
  const f=await fixture(t),directory=join(f.target,chartDirectoryName);await mkdir(directory);await assert.rejects(f.run({writeChart:async args=>{for(const window of [60,120]){const body='<svg data-normalization="first-close-percent"><text>derived</text></svg>';await writeFile(join(directory,args.row.code+'-'+window+'.svg'),changed?'different':body);await writeFile(join(directory,args.row.code+'-'+window+'.svg.gz'),gzipSync(body));}throw Error('simulated before publication');}}),/simulated/);
  if(changed){await assert.rejects(f.run(),/orphan chart bytes/);assert.equal(await readFile(join(directory,'600000.SH-60.svg'),'utf8'),'different');assert.ok(!(await readdir(f.target)).includes(filename+'.json'));}
  else assert.equal((await f.run()).summary.shortTermCount,1);
 }
});
test('at the exact next-session open no newly discovered stale close watch becomes current',async t=>{
 const f=await fixture(t),result=await f.run({now:()=>Date.parse(nextSessionDay+'T09:30:00+08:00')});assert.equal(result.current.length,0);assert.equal(f.calls.length,0);assert.equal(result.method.inactiveReason,'next_verified_session_open_has_passed');
});
