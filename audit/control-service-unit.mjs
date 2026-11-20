import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createControlService} from '../server/control-service.mjs';

const require=createRequire(import.meta.url);
const Model=require('../control/model.js'),engine=require('../screening/trend-screen.js');
const admin={id:'owner_a',role:'admin',status:'active'},other={...admin,id:'owner_b'};
const copy=value=>JSON.parse(JSON.stringify(value));
function dataset(size=40){
  const day='2026-11-20',dates=[];
  for(let date=new Date(day+'T00:00:00Z');dates.length<61;date.setUTCDate(date.getUTCDate()-1)){
    if(![0,6].includes(date.getUTCDay()))dates.unshift(date.toISOString().slice(0,10));
  }
  let close=100;
  const bars=dates.map((date,i)=>({date,close:close*=1+[.002,-.001,.004,-.002,.003][i%5],volume:100}));
  const universe=Array.from({length:size},(_,i)=>({code:`${600000+i}.SH`,name:`合成测试${i}`,sector:'测试行业',exchange:'SH'}));
  return {schema:'books.research.dataset.v1',day,asOf:day+'T15:00:00+08:00',completed:true,collectionStatus:'complete',
    expectedCount:size,totalUniverseCount:size,universe,reference:{code:'000300.SH',adjustment:'index',bars:copy(bars),fetchedAt:day+'T15:01:00+08:00'},
    records:universe.map(stock=>({stock,source:{status:'ready',day,adjustment:'qfq',bars:copy(bars),fetchedAt:day+'T15:02:00+08:00'}}))};
}
function fixture(t,overrides={}){
  const dir=mkdtempSync(join(tmpdir(),'books-control-unit-')),db=new DatabaseSync(join(dir,'control.sqlite'));
  db.exec('CREATE TABLE existing_data (value TEXT); INSERT INTO existing_data VALUES (\'preserved\')');
  const scheduled=[],services=[];let tick=0;
  const options={db,model:Model,engine,now:()=>Date.UTC(2026,10,21)+tick++,schedule:fn=>scheduled.push(fn),...overrides};
  let service=createControlService(options);services.push(service);
  t.after(()=>{for(const instance of services)instance.close();db.close();rmSync(dir,{recursive:true,force:true});});
  async function request(route,body,options={}){
    const url=new URL(route.startsWith('/')?route:'/api/research-control/'+route,'http://localhost');
    const req={method:body===undefined?'GET':'POST',url:url.pathname+url.search,body};const res={};
    const handled=await service.handle(req,res,{user:admin,path:url.pathname,url,
      readJson:async(_req,maxBytes)=>{res.readLimit=maxBytes;return req.body;},
      json:(_res,status,value)=>Object.assign(res,{status,body:value}),...options});
    return {...res,handled};
  }
  return {db,scheduled,request,replace(overrides={}){service=createControlService({...options,...overrides});services.push(service);return service;},
    get service(){return service;},async drain(){while(scheduled.length)await scheduled.shift()();},
    async importData(data=dataset(),user=admin){const result=await request('datasets',{dataset:data},{user});assert.equal(result.status,201);return result.body.id;}};
}
async function save(f,expectedRevision,name){const r=await f.request('config',{expectedRevision,config:{name}});assert.equal(r.status,201);return r.body;}

test('route guard defends admin role, active status and owner ID without changing existing data',async t=>{
  const f=fixture(t);
  for(const user of [null,{...admin,role:'reader'},{...admin,status:'disabled'},{...admin,id:''},{...admin,id:12}]){
    const r=await f.request('state',undefined,{user});assert.equal(r.status,403);assert.equal(r.body.error,'admin_required');
  }
  assert.equal((await f.request('/api/elsewhere')).handled,false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_control_heads').get().n,0);
  assert.equal(f.db.prepare('SELECT value FROM existing_data').get().value,'preserved');
});
test('initial state exposes truthful offline capabilities and isolated defaults',async t=>{
  const f=fixture(t),r=await f.request('state');assert.equal(r.status,200);
  assert.deepEqual(r.body.capabilities,{archiveReplay:true,liveCollection:false,scheduler:false});
  assert.equal(r.body.currentRevision,0);assert.equal(r.body.activeRevision,0);assert.equal(r.body.activeConfig,null);
  assert.deepEqual(r.body.config,Model.normalizeConfig(Model.DEFAULT_CONFIG));
  assert.deepEqual(r.body.versions,[]);assert.deepEqual(r.body.datasets,[]);assert.deepEqual(r.body.runs,[]);assert.equal(r.body.job,null);
});
test('configuration versions are immutable and stale saves fail atomically',async t=>{
  const f=fixture(t);await save(f,0,'第一版');
  const conflict=await f.request('config',{expectedRevision:0,config:{name:'不应保存'}});
  assert.equal(conflict.status,409);assert.equal(conflict.body.error,'revision_conflict');
  await save(f,1,'第二版');const state=(await f.request('state')).body;
  assert.equal(state.currentRevision,2);assert.equal(state.activeRevision,0);assert.deepEqual(state.versions.map(v=>v.config.name),['第二版','第一版']);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_control_versions').get().n,2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_control_audit').get().n,2);
});
test('activation compares the active pointer and rollback appends then activates a new version',async t=>{
  const f=fixture(t);await save(f,0,'原始方案');await save(f,1,'修改方案');
  assert.equal((await f.request('activate',{revision:2,expectedActiveRevision:0})).status,200);
  assert.equal((await f.request('activate',{revision:1,expectedActiveRevision:0})).status,409);
  const r=await f.request('rollback',{revision:1,expectedRevision:2});assert.equal(r.status,201);assert.equal(r.body.revision,3);assert.equal(r.body.activeRevision,3);
  const state=(await f.request('state')).body;assert.equal(state.activeConfig.name,'原始方案');assert.equal(state.versions[0].sourceRevision,1);
  assert.equal(state.versions[0].kind,'config_rollback');assert.equal(state.versions[1].config.name,'修改方案');
  assert.equal((await f.request('rollback',{revision:1,expectedRevision:2})).status,409);
});
test('active config remains available when its revision falls outside the last20 versions',async t=>{
  const f=fixture(t);await save(f,0,'早期生效版');await f.request('activate',{revision:1,expectedActiveRevision:0});
  for(let rev=1;rev<23;rev++)await save(f,rev,`新版${rev+1}`);
  const state=(await f.request('state')).body;
  assert.equal(state.versions.length,20);assert.equal(state.versions.at(-1).revision,4);assert.equal(state.activeRevision,1);assert.equal(state.activeConfig.name,'早期生效版');
});
test('normalization rejects executable fields, malformed JSON and oversize bodies using fixed errors',async t=>{
  const f=fixture(t);
  assert.equal((await f.request('config',{expectedRevision:0,config:{command:'shell'}})).status,400);
  assert.equal((await f.request('datasets',{dataset:{schema:'unsupported',secret:'private'}})).body.error,'invalid_dataset');
  const syntax=await f.request('config',{}, {readJson:async()=>{throw new SyntaxError('secret stack');}});
  assert.equal(syntax.status,400);assert.doesNotMatch(JSON.stringify(syntax.body),/secret|stack/);
  const limit=await f.request('datasets',{dataset:'x'.repeat(24*1024*1024)});assert.equal(limit.status,413);assert.equal(limit.readLimit,24*1024*1024);
  assert.equal((await f.request('state')).body.currentRevision,0);
});
test('normalized original datasets persist without overwrites and deduplicate within each owner',async t=>{
  const f=fixture(t),raw=dataset(),id=await f.importData(raw),again=await f.request('datasets',{dataset:raw});
  assert.equal(again.status,200);assert.equal(again.body.id,id);assert.equal(again.body.deduplicated,true);
  assert.equal(again.body.hash.length,64);assert.equal(again.body.summary.expectedCount,40);assert.equal(again.body.summary.totalUniverseCount,40);
  assert.equal(again.body.summary.day,'2026-11-20');assert.ok(again.body.byteLength>0);
  raw.records[0].source.bars[0].close=999;
  const read=await f.request('datasets?id='+id);assert.deepEqual(read.body.dataset,Model.normalizeDataset(dataset()));
  assert.notEqual(read.body.dataset.records[0].source.bars[0].close,999);
  const ownerB=await f.request('datasets',{dataset:dataset()},{user:other});assert.equal(ownerB.status,201);assert.notEqual(ownerB.body.id,id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM research_control_datasets').get().n,2);
});
test('every read and mutation is scoped to its administrator owner',async t=>{
  const f=fixture(t);await save(f,0,'甲的方案');const id=await f.importData();
  for(const route of ['datasets?id='+id])assert.equal((await f.request(route,undefined,{user:other})).status,404);
  assert.equal((await f.request('activate',{revision:1,expectedActiveRevision:0},{user:other})).status,404);
  assert.equal((await f.request('rollback',{revision:1,expectedRevision:0},{user:other})).status,404);
  assert.equal((await f.request('run',{datasetId:id,revision:1},{user:other})).status,404);
  const run=(await f.request('run',{datasetId:id,revision:1})).body.run;
  for(const route of ['runs?id='+run.id,'export?id='+run.id])assert.equal((await f.request(route,undefined,{user:other})).status,404);
  assert.equal((await f.request('stop',{runId:run.id},{user:other})).status,404);
  const state=(await f.request('state',undefined,{user:other})).body;
  assert.equal(state.currentRevision,0);assert.equal(state.job,null);assert.deepEqual(state.versions,[]);assert.deepEqual(state.datasets,[]);assert.deepEqual(state.runs,[]);
});
test('a real pure-engine run persists actual results, settings and progress with no external requests',async t=>{
  const f=fixture(t),id=await f.importData();let requests=0;const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{requests++;throw Error('no external requests allowed');};t.after(()=>{globalThis.fetch=originalFetch;});
  await save(f,0,'可复现参数');
  const r=await f.request('run',{datasetId:id,revision:1});assert.equal(r.status,202);assert.equal(r.body.run.status,'queued');
  assert.equal((await f.request('state')).body.job.id,r.body.run.id);
  assert.equal((await f.request('run',{datasetId:id,revision:1})).status,409);
  await f.drain();const result=(await f.request('runs?id='+r.body.run.id)).body;
  assert.equal(result.status,'complete');assert.equal(result.result.status,'complete');assert.equal(result.result.records.length,40);
  assert.equal(result.progress.checked,40);assert.equal(result.progress.total,40);assert.equal(result.settings.name,'可复现参数');assert.equal(result.engineVersion,Model.engineVersion);
  assert.equal(result.datasetId,id);assert.ok(result.startedAt);assert.ok(result.finishedAt);assert.equal(requests,0);
  const state=(await f.request('state')).body;assert.equal(state.job,null);assert.equal(state.runs[0].result,undefined);assert.equal(state.datasets[0].dataset,undefined);
  assert.deepEqual((await f.request('export?id='+r.body.run.id)).body,result);
});
test('an incompatible real archive reports unavailable instead of manufacturing a complete result',async t=>{
  const f=fixture(t),id=await f.importData();await f.request('config',{expectedRevision:0,config:{settings:{benchmark:'000001.SH'}}});
  const run=(await f.request('run',{datasetId:id,revision:1})).body.run;await f.drain();
  const result=(await f.request('runs?id='+run.id)).body;assert.equal(result.status,'unavailable');assert.equal(result.result.records.length,0);assert.match(result.result.reason,/指数日历/);
});
test('queued stop never evaluates and a completed stop request is idempotent',async t=>{
  let evaluations=0;const f=fixture(t,{model:{...Model,evaluateDataset:async()=>{evaluations++;return {status:'complete'};}}}),id=await f.importData();
  const run=(await f.request('run',{datasetId:id,revision:0})).body.run;
  const stop=await f.request('stop',{runId:run.id});assert.equal(stop.body.run.status,'stopped');assert.equal(stop.body.run.stopRequested,true);
  await f.drain();assert.equal(evaluations,0);assert.equal((await f.request('runs?id='+run.id)).body.result,null);
  assert.equal((await f.request('stop',{runId:run.id})).body.run.status,'stopped');
});
test('running stop cooperates with the evaluator and retains only actual partial results',async t=>{
  let release,entered;const entry=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{model:{...Model,evaluateDataset:async(_dataset,_config,_engine,{onProgress,shouldStop})=>{
    onProgress({checked:1,total:40});entered();await gate;
    return {status:shouldStop()?'stopped':'complete',records:[{actual:'one checked record'}],counts:{checked:1,total:40}};
  }}}),id=await f.importData();
  const run=(await f.request('run',{datasetId:id,revision:0})).body.run,pending=f.scheduled.shift()();await entry;
  const running=(await f.request('state')).body.job;assert.equal(running.status,'running');assert.equal(running.progress.checked,1);
  const stop=await f.request('stop',{runId:run.id});assert.equal(stop.body.run.status,'running');assert.equal(stop.body.run.stopRequested,true);
  release();await pending;const result=(await f.request('runs?id='+run.id)).body;
  assert.equal(result.status,'stopped');assert.equal(result.result.status,'stopped');assert.equal(result.result.records.length,1);assert.equal(result.result.counts.checked,1);
});
test('the active job limit is per owner, not a global execution lock',async t=>{
  const f=fixture(t),idA=await f.importData(),idB=await f.importData(dataset(),other);
  assert.equal((await f.request('run',{datasetId:idA,revision:0})).status,202);
  assert.equal((await f.request('run',{datasetId:idB,revision:0},{user:other})).status,202);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM research_control_runs WHERE status='queued'").get().n,2);await f.drain();
  assert.equal((await f.request('state')).body.runs.length,1);assert.equal((await f.request('state',undefined,{user:other})).body.runs.length,1);
});
test('restart marks pending work interrupted and cannot revive the prior queued callback',async t=>{
  const f=fixture(t),id=await f.importData(),run=(await f.request('run',{datasetId:id,revision:0})).body.run;
  f.replace();let result=(await f.request('runs?id='+run.id)).body;assert.equal(result.status,'interrupted');assert.equal(result.error,'process_restart');assert.ok(result.finishedAt);
  await f.drain();result=(await f.request('runs?id='+run.id)).body;assert.equal(result.status,'interrupted');assert.equal(result.result,null);
  assert.equal((await f.request('state')).body.job,null);assert.equal((await f.request('run',{datasetId:id,revision:0})).status,202);await f.drain();
});
test('close interrupts running work and late completion cannot overwrite that outcome',async t=>{
  let release,entered;const entry=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{model:{...Model,evaluateDataset:async()=>{entered();await gate;return {status:'complete',records:[]};}}}),id=await f.importData();
  const run=(await f.request('run',{datasetId:id,revision:0})).body.run,pending=f.scheduled.shift()();await entry;f.service.close();release();await pending;
  const row=f.db.prepare('SELECT * FROM research_control_runs WHERE id=?').get(run.id);assert.equal(row.status,'interrupted');assert.equal(row.error_code,'service_closed');assert.equal(row.result_json,null);
  assert.equal((await f.request('state')).status,503);
});
test('unexpected evaluator failures expose a fixed code and preserve the last actual progress',async t=>{
  const f=fixture(t,{model:{...Model,evaluateDataset:async(_d,_c,_e,{onProgress})=>{onProgress({checked:3,total:40});throw Error('secret diagnostic stack');}}}),id=await f.importData();
  const run=(await f.request('run',{datasetId:id,revision:0})).body.run;await f.drain();const result=(await f.request('runs?id='+run.id)).body;
  assert.equal(result.status,'error');assert.equal(result.error,'evaluation_failed');assert.equal(result.progress.checked,3);assert.equal(result.result,null);assert.doesNotMatch(JSON.stringify(result),/secret diagnostic|stack/);
});
test('failed local dispatch is persisted and releases the owner job slot',async t=>{
  const f=fixture(t,{schedule:()=>{throw Error('internal dispatch detail');}}),id=await f.importData();
  const r=await f.request('run',{datasetId:id,revision:0});assert.equal(r.status,503);assert.equal(r.body.error,'schedule_failed');
  const state=(await f.request('state')).body;assert.equal(state.job,null);assert.equal(state.runs[0].status,'error');assert.equal(state.runs[0].error,'schedule_failed');
});
