import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {runSavedSchemes} from '../server/a-share-scheme-runner.mjs';
import {createSchemeStore} from '../server/a-share-schemes.mjs';

const require=createRequire(import.meta.url),model=require('../control/model.js'),patterns=require('../screening/trend-patterns.js'),siteDir=resolve('.');
const sourceId='test-forward-same-batch',ownerId='owner_a',scopeCodes=['600000.SH','600001.SH'];
const codes=Array.from({length:1000},(_,i)=>String(600000+i)+'.SH');
const fullDayTime=day=>Date.parse(day+'T20:10:00+08:00');
function calendar(day){const dates=[];for(let d=new Date(day+'T00:00:00Z');dates.length<61;d.setUTCDate(d.getUTCDate()-1))if(![0,6].includes(d.getUTCDay()))dates.unshift(d.toISOString().slice(0,10));return dates;}
const level=date=>100+(Date.parse(date+'T00:00:00Z')-Date.parse('2026-01-01T00:00:00Z'))/86400000*.05;
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'books-scheme-runner-')),dbFile=join(dir,'app.sqlite'),db=new DatabaseSync(dbFile);let time=fullDayTime('2026-11-02'),serial=0;
  const now=()=>time,store=createSchemeStore({db,model,patterns,now});
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  async function batch(day,{scale=1,missing=[],opposite=[],gap=[],provider=sourceId}={}){
    time=fullDayTime(day);const dates=calendar(day),asOf=day+'T15:10:00+08:00',generation=day+'-'+(time+serial++);
    const universe=codes.map(code=>({code,name:'测试'+code,sector:'测试',exchange:'SH'}));
    const bars=dates.map(date=>({date,close:level(date)*scale,volume:100}));
    const records=universe.map(stock=>({stock,source:missing.includes(stock.code)?{status:'unavailable',sourceId:provider,day,reason:'本轮无可核验日线',fetchedAt:asOf}:{status:'ready',sourceId:provider,day,adjustment:'qfq',bars:bars.filter(bar=>!gap.includes(stock.code)||bar.date!==dates.at(-2)).map(bar=>({...bar,close:opposite.includes(stock.code)?20000/bar.close:bar.close})),fetchedAt:asOf}}));
    const dataset={schema:'books.research.dataset.v1',day,asOf,completed:true,collectionStatus:'complete',expectedCount:universe.length,totalUniverseCount:universe.length,universe,records,reference:{code:'000300.SH',adjustment:'index',bars,fetchedAt:asOf}};
    const manifest={generation,sourceId:provider,dataPolicy:{rawPublic:false,derivedPublic:true},day,asOf,total:1000,ready:1000-missing.length,fullMarket:true};
    await mkdir(join(dir,'private','generations',generation),{recursive:true});await mkdir(join(dir,'generations',generation),{recursive:true});
    await writeFile(join(dir,'private','generations',generation,'dataset-all-000300.SH.json'),JSON.stringify(dataset));
    await writeFile(join(dir,'generations',generation,'complete.json'),JSON.stringify({...manifest,completed:true}));await writeFile(join(dir,'current.json'),JSON.stringify(manifest));
    return {dataset,manifest};
  }
  function save(changes={}){return store.save({ownerId,name:'盘后观察',config:{settings:{mode:'market',sampleSize:'all',limits:{enabled:false}}},selection:{patternId:'',qualification:'strict',scopeCodes},...changes});}
  return {dir,dbFile,db,store,now,setNow:value=>{time=value;},batch,save,run:(extra={})=>runSavedSchemes({dbFile,dir,siteDir,now,...extra})};
}

test('a real completed private batch creates one derived baseline per named scheme and same-day reruns are idempotent without external requests',async t=>{
  const f=await fixture(t),scheme=f.save();await f.batch('2026-11-02');let external=0;t.mock.method(globalThis,'fetch',()=>{external++;throw Error('must stay offline');});
  const first=await f.run();assert.equal(first.status,'complete');assert.equal(first.schemes[0].status,'complete');
  const run=f.store.latestRun(scheme.id);assert.equal(run.kind,'baseline');assert.equal(run.summary.isBaseline,true);assert.equal(run.summary.baselineReason,'first_run');assert.equal(run.summary.baseline,2);assert.equal(run.summary.new,0);assert.equal(run.summary.selected,2);assert.equal(run.summary.total,2);assert.equal(run.summary.market.requestedCount,1000);
  assert(run.records.every(record=>record.selected&&record.confirmedSelected&&record.change==='baseline'));assert.equal(f.store.tracks(scheme.id).length,2);
  assert.doesNotMatch(JSON.stringify(run.records),/"(?:bars|prices|price|close|ma5|ma20|startClose|endClose|volumeAvg5|volumeAvgPrevious20)"/);
  const second=await f.run();assert.equal(second.schemes[0].status,'skipped');assert.equal(second.schemes[0].runId,run.id);assert.equal(f.store.runs(scheme.id).length,1);assert.equal(f.store.tracks(scheme.id).length,2);assert.equal(external,0);
  for(const track of f.store.tracks(scheme.id))for(const observation of Object.values(track.observations)){assert.equal(observation.status,'pending');assert.equal(observation.returnPercent,null);}
});
test('unknown quotes retain confirmed membership, real exits and reentries get separate episodes, and an exit does not stop subsequent observations',async t=>{
  const f=await fixture(t),scheme=f.save();await f.batch('2026-11-02');await f.run();
  await f.batch('2026-11-03',{missing:[scopeCodes[0]],opposite:[scopeCodes[1]]});await f.run();let run=f.store.latestRun(scheme.id);
  const unknown=run.records.find(record=>record.stock.code===scopeCodes[0]),exit=run.records.find(record=>record.stock.code===scopeCodes[1]);
  assert.equal(unknown.selected,null);assert.equal(unknown.confirmedSelected,true);assert.equal(unknown.change,'unknown');assert.equal(exit.selected,false);assert.equal(exit.confirmedSelected,false);assert.equal(exit.change,'exited');assert.equal(run.summary.exited,1);assert.equal(run.summary.unknown,1);
  const episode=f.store.tracks(scheme.id).find(track=>track.code===scopeCodes[1]);assert.equal(episode.exitDay,'2026-11-03');assert.equal(episode.observations[1].status,'ready');
  await f.batch('2026-11-04');await f.run();run=f.store.latestRun(scheme.id);assert.equal(run.records.find(record=>record.stock.code===scopeCodes[0]).change,'continued');assert.equal(run.records.find(record=>record.stock.code===scopeCodes[1]).change,'new');assert.equal(f.store.tracks(scheme.id).length,3);
  await f.batch('2026-11-05');await f.run();const exited=f.store.tracks(scheme.id).find(track=>track.id===episode.id);assert.equal(exited.exitDay,'2026-11-03');assert.equal(exited.observations[3].targetDay,'2026-11-05');assert.equal(exited.observations[3].status,'ready');
});
test('saved revisions and engine changes establish explicit baselines instead of manufacturing new entries',async t=>{
  const f=await fixture(t),scheme=f.save();await f.batch('2026-11-02');await f.run();
  const revised=f.save({id:scheme.id,expectedRevision:1,name:'新门槛',config:{settings:{mode:'market',limits:{enabled:false},minimumBreadth:.5}}});
  await f.batch('2026-11-03');await f.run();let run=f.store.latestRun(scheme.id);assert.equal(run.revision,2);assert.equal(run.summary.baselineReason,'revision_changed');assert.equal(run.summary.baseline,2);assert.equal(run.summary.new,0);
  f.db.prepare("UPDATE screening_scheme_run SET engine_version='older-engine' WHERE id=?").run(run.id);
  await f.batch('2026-11-04');await f.run();run=f.store.latestRun(scheme.id);assert.equal(run.summary.baselineReason,'engine_changed');assert.equal(run.summary.new,0);assert.equal(run.summary.baseline,2);assert.equal(run.revision,revised.revision);
});
test('a same-day engine upgrade creates a new baseline without rewriting old results or entry identities and then skips the same method',async t=>{
  const f=await fixture(t),scheme=f.save();await f.batch('2026-11-02');const currentVersion=model.engineVersion;
  model.engineVersion=currentVersion+'-previous';
  try{assert.equal((await f.run()).status,'complete');}finally{model.engineVersion=currentVersion;}
  const old=f.store.latestRun(scheme.id),oldRecords=JSON.stringify(old.records),entries=f.store.tracks(scheme.id).map(track=>({id:track.id,engineVersion:track.engineVersion,enteredRunId:track.enteredRunId,entryDay:track.entryDay,knownAt:track.knownAt,observations:track.observations}));
  f.setNow(f.now()+1000);const result=await f.run();assert.equal(result.status,'complete');const run=f.store.latestRun(scheme.id);
  assert.notEqual(run.id,old.id);assert.equal(run.day,old.day);assert.equal(run.kind,'baseline');assert.equal(run.summary.baselineReason,'engine_changed');assert.equal(run.summary.new,0);assert.equal(run.summary.baseline,2);assert.equal(run.summary.exited,0);assert.equal(run.engineVersion,currentVersion);
  assert.equal(JSON.stringify(f.store.getRun(old.id).records),oldRecords);assert.equal(f.store.getRun(old.id).engineVersion,currentVersion+'-previous');
  for(const entry of entries){
    const kept=f.store.tracks(scheme.id).find(track=>track.id===entry.id);for(const key of ['engineVersion','enteredRunId','entryDay','knownAt'])assert.equal(kept[key],entry[key]);
    for(const [horizon,observation]of Object.entries(entry.observations))if(['ready','not_observable'].includes(observation.status))assert.deepEqual(kept.observations[horizon],observation);
  }
  assert.equal(f.store.tracks(scheme.id).length,4);assert.equal(f.store.runs(scheme.id).length,2);
  const repeat=await f.run();assert.equal(repeat.schemes[0].status,'skipped');assert.equal(repeat.schemes[0].runId,run.id);assert.equal(f.store.runs(scheme.id).length,2);
});
test('same-batch qfq observations use verified market sessions, retain blank gaps and never backfill a move known before scheme creation',async t=>{
  const f=await fixture(t),scheme=f.save({selection:{patternId:'',qualification:'strict',scopeCodes:[scopeCodes[0]]}});const first=await f.batch('2026-11-06');await f.run();
  const originalAnchor=first.dataset.records[0].source.bars.at(-1).close;
  await f.batch('2026-11-09',{scale:.5});await f.run();let track=f.store.tracks(scheme.id)[0],one=track.observations[1];
  assert.equal(one.targetDay,'2026-11-09');assert.equal(one.status,'ready');assert.equal(one.method,'same_batch_forward_adjusted_close_change');assert(Math.abs(one.returnPercent-(level('2026-11-09')/level('2026-11-06')-1)*100)<1e-10);assert.notEqual(one.returnPercent,(level('2026-11-09')*.5/originalAnchor-1)*100);
  await f.batch('2026-11-11',{gap:[scopeCodes[0]]});await f.run();track=f.store.tracks(scheme.id)[0];assert.equal(track.observations[3].targetDay,'2026-11-11');assert.equal(track.observations[3].status,'unavailable');assert.equal(track.observations[3].returnPercent,null);assert.match(track.observations[3].reason,/缺失|缺口/);assert.equal(track.observations[1].returnPercent,one.returnPercent);
  const late=f.save({name:'延迟创建',selection:{patternId:'',qualification:'strict',scopeCodes:[scopeCodes[1]]}});await f.batch('2026-11-06');f.setNow(fullDayTime('2026-11-10'));await f.run({schemeIds:[late.id]});await f.batch('2026-11-11');await f.run({schemeIds:[late.id]});const delayed=f.store.tracks(late.id)[0];assert.equal(delayed.observations[1].status,'not_observable');assert.equal(delayed.observations[1].returnPercent,null);assert.equal(delayed.observations[3].status,'ready');
});
test('shape unknown never becomes a false exit, failed schemes preserve their success and do not block independent schemes',async t=>{
  const f=await fixture(t),good=f.save({selection:{patternId:'close-breakout',qualification:'strict',scopeCodes:[scopeCodes[0]]}}),bad=f.save({name:'缺少指数档',config:{settings:{mode:'market',benchmark:'000001.SH',limits:{enabled:false}}}});await f.batch('2026-11-02');
  const first=await f.run();assert.equal(first.status,'failed');assert.equal(first.schemes.find(value=>value.schemeId===good.id).status,'complete');assert.equal(first.schemes.find(value=>value.schemeId===bad.id).status,'failed');assert.equal(f.store.latestRun(bad.id),null);assert.equal(f.store.runs(bad.id)[0].status,'error');
  await f.batch('2026-11-03',{gap:[scopeCodes[0]]});await f.run({schemeIds:[good.id]});const run=f.store.latestRun(good.id);assert.equal(run.records[0].selected,null);assert.equal(run.records[0].change,'unknown');assert.equal(run.records[0].confirmedSelected,true);assert.equal(run.summary.exited,0);
  const prior=run.id,manifest=JSON.parse(await readFile(join(f.dir,'current.json')));await writeFile(join(f.dir,'generations',manifest.generation,'complete.json'),JSON.stringify({}));await assert.rejects(f.run({schemeIds:[good.id]}),/回执/);assert.equal(f.store.latestRun(good.id).id,prior);
});
test('disabled schemes stop new screens but existing episodes continue, missing configuration cannot open an implicit production database',async t=>{
  const f=await fixture(t),scheme=f.save({selection:{patternId:'',qualification:'strict',scopeCodes:[scopeCodes[0]]}});await f.batch('2026-11-02');await f.run();f.store.setEnabled({ownerId,id:scheme.id,enabled:false});
  await f.batch('2026-11-03');const result=await f.run();assert.equal(result.schemes[0].status,'disabled');assert.equal(f.store.runs(scheme.id).length,1);assert.equal(f.store.tracks(scheme.id)[0].observations[1].status,'ready');
  await assert.rejects(runSavedSchemes({dir:f.dir,siteDir}),/明确/);
});

test('a revised scheme cannot inherit confirmed membership through unknown data from its old rule version',async t=>{
  const f=await fixture(t),scheme=f.save({selection:{patternId:'',qualification:'strict',scopeCodes:[scopeCodes[0]]}});await f.batch('2026-11-02');await f.run();
  f.save({id:scheme.id,expectedRevision:1,name:'不同规则',selection:{patternId:'',qualification:'strict',scopeCodes:[scopeCodes[0]]},config:{settings:{mode:'market',limits:{enabled:false},minimumBreadth:.4}}});
  await f.batch('2026-11-03',{missing:[scopeCodes[0]]});await f.run();let run=f.store.latestRun(scheme.id);assert.equal(run.summary.baselineReason,'revision_changed');assert.equal(run.records[0].selected,null);assert.equal(run.records[0].confirmedSelected,null);assert.equal(run.records[0].change,'unknown');assert.equal(f.store.tracks(scheme.id,{revision:2}).length,0);
  await f.batch('2026-11-04',{missing:[scopeCodes[0]]});await f.run();run=f.store.latestRun(scheme.id);assert.equal(run.records[0].confirmedSelected,null);
  await f.batch('2026-11-05');await f.run();run=f.store.latestRun(scheme.id);assert.equal(run.records[0].change,'baseline');assert.equal(run.summary.new,0);assert.equal(run.summary.continued,0);assert.equal(f.store.tracks(scheme.id,{revision:2})[0].entryDay,'2026-11-05');
});
test('fresh running work is preserved and only a same-scheme attempt older than six hours is recovered explicitly',async t=>{
  const f=await fixture(t),scheme=f.save(),batch=await f.batch('2026-11-02'),began=f.now();
  const running=f.store.beginRun({schemeId:scheme.id,revision:scheme.revision,day:batch.manifest.day,generation:batch.manifest.generation,sourceId,asOf:batch.manifest.asOf,engineVersion:model.engineVersion,patternVersion:patterns.version,kind:'baseline'});
  const fresh=await f.run();assert.equal(fresh.status,'failed');assert.equal(f.store.getRun(running.id).status,'running');assert.equal(f.store.runs(scheme.id).length,1);
  f.setNow(began+6*3600000+1);const recovered=await f.run();assert.equal(recovered.status,'complete');assert.equal(f.store.getRun(running.id).status,'error');assert.equal(f.store.getRun(running.id).error,'process_interrupted');assert.equal(f.store.runs(scheme.id).length,2);assert.notEqual(f.store.latestRun(scheme.id).id,running.id);
});
test('a missing chosen-shape support window is unknown even when the selected market rule still matches',async t=>{
  const f=await fixture(t),scheme=f.save({selection:{patternId:'regain-ma-20',qualification:'strict',scopeCodes:[scopeCodes[0]]},config:{settings:{mode:'market',patterns:{crossWindow:20},limits:{enabled:false}}}});
  async function reshape(day,short=false){
    const {dataset,manifest}=await f.batch(day),series=dataset.reference.bars.map(bar=>({...bar,close:100}));
    series.at(-2).close=99;series.at(-1).close=101;dataset.reference.bars=series;dataset.records[0].source.bars=short?series.slice(-26):series;
    await writeFile(join(f.dir,'private','generations',manifest.generation,'dataset-all-000300.SH.json'),JSON.stringify(dataset));
  }
  await reshape('2026-11-02');await f.run();assert.equal(f.store.latestRun(scheme.id).records[0].selected,true);
  await reshape('2026-11-03',true);await f.run();const run=f.store.latestRun(scheme.id),record=run.records[0];assert.equal(record.result.status,'ready');assert.equal(record.result.matched,true);assert.equal(record.selected,null);assert.equal(record.confirmedSelected,true);assert.equal(record.change,'unknown');assert.equal(run.summary.exited,0);assert.match(record.reason,/形态资料不足/);
});
