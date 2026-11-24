import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {workerExitState,recordWorkerExit} from '../server/a-share-worker-exit.mjs';

const now=()=>Date.parse('2026-11-24T12:30:00Z');
const running=()=>({configured:true,schedule:'工作日20:10',attempt:{status:'running',stage:'entry-evidence',day:'2026-11-24',checked:1050,total:3460,ready:3182,missing:278,sourceId:'tickflow-free-forward-v1',dataPolicy:{rawPublic:false},startedAt:'2026-11-24T12:10:00Z',finishedAt:null,error:null,currentCode:'600519.SH',requests:72}});
const oom={serviceResult:'core-dump',exitCode:'dumped',exitStatus:'ABRT',now};
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'books-worker-exit-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('fatal systemd results change only a running attempt and retain its exact progress',()=>{
  for(const exit of [oom,{serviceResult:'signal',exitCode:'killed',exitStatus:'KILL',now},{serviceResult:'oom-kill',exitCode:'killed',exitStatus:'9',now},{serviceResult:'exit-code',exitCode:'exited',exitStatus:'1',now},{serviceResult:'timeout',exitCode:'killed',exitStatus:'TERM',now},{exitCode:'dumped',exitStatus:'6',now},{exitCode:'exited',exitStatus:'2',now}]){
    const state=running(),before=structuredClone(state),actual=workerExitState(state,exit);
    assert.equal(actual.attempt.status,'failed');assert.equal(actual.attempt.finishedAt,new Date(now()).toISOString());
    for(const [key,value]of Object.entries(state.attempt))if(!['status','finishedAt','error'].includes(key))assert.deepEqual(actual.attempt[key],value,key);
    assert.match(actual.attempt.error,new RegExp('EXIT_CODE='+exit.exitCode));assert.match(actual.attempt.error,new RegExp('EXIT_STATUS='+exit.exitStatus));assert.deepEqual(state,before);
  }
});

test('success, absent exit context and already completed failures are not rewritten',()=>{
  for(const exit of [{serviceResult:'success',exitCode:'exited',exitStatus:'0'},{exitCode:'exited',exitStatus:'0'},{}]){const state=running();assert.equal(workerExitState(state,exit),state);}
  for(const status of ['complete','failed','no_new_day','stopped']){const state=running();Object.assign(state.attempt,{status,error:'保留已有准确诊断',finishedAt:'2026-11-24T12:20:00Z'});assert.equal(workerExitState(state,oom),state);}
  for(const state of [null,{}, {attempt:null}])assert.equal(workerExitState(state,oom),state);
});

test('the exit writer atomically updates status and never modifies current or collector lock',async t=>{
  const dir=await fixture(t),file=join(dir,'status.json'),current='{"generation":"2026-11-23-1","day":"2026-11-23"}';
  await writeFile(file,JSON.stringify(running()));await writeFile(join(dir,'current.json'),current);await writeFile(join(dir,'worker.lock'),'old-main-pid');
  assert.deepEqual(await recordWorkerExit({dir,...oom}),{updated:true});const actual=JSON.parse(await readFile(file,'utf8'));assert.equal(actual.attempt.checked,1050);assert.equal(actual.attempt.status,'failed');assert.match(actual.attempt.error,/core-dump.*dumped.*ABRT/);
  assert.equal(await readFile(join(dir,'current.json'),'utf8'),current);assert.equal(await readFile(join(dir,'worker.lock'),'utf8'),'old-main-pid');assert.deepEqual((await readdir(dir)).sort(),['current.json','status.json','worker.lock']);
  const first=await readFile(file);await recordWorkerExit({dir,serviceResult:'signal',exitCode:'killed',exitStatus:'TERM',now:()=>now()+60000});assert.deepEqual(await readFile(file),first);
});

test('missing or invalid status is not replaced with fabricated collection data',async t=>{
  const dir=await fixture(t),file=join(dir,'status.json');assert.deepEqual(await recordWorkerExit({dir,...oom}),{updated:false,reason:'status_missing'});await assert.rejects(access(file),{code:'ENOENT'});
  await writeFile(file,'not-valid-json');await assert.rejects(recordWorkerExit({dir,...oom}),SyntaxError);assert.equal(await readFile(file,'utf8'),'not-valid-json');
});

test('successful or terminal attempts preserve original JSON bytes',async t=>{
  const dir=await fixture(t),file=join(dir,'status.json');
  for(const [status,exit]of [['running',{serviceResult:'success',exitCode:'exited',exitStatus:'0'}],['complete',oom],['failed',oom]]){
    const state=running();state.attempt.status=status;const body=JSON.stringify(state,null,2)+'\n';await writeFile(file,body);
    assert.equal((await recordWorkerExit({dir,...exit})).updated,false);assert.equal(await readFile(file,'utf8'),body);
  }
});

test('the ExecStopPost CLI reads systemd exit variables and uses the configured data directory',async t=>{
  const dir=await fixture(t),file=join(dir,'status.json');await writeFile(file,JSON.stringify(running()));
  const script=fileURLToPath(new URL('../server/a-share-worker-exit.mjs',import.meta.url));
  const child=spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,BOOKS_A_SHARE_DIR:dir,SERVICE_RESULT:'core-dump',EXIT_CODE:'dumped',EXIT_STATUS:'ABRT'}});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{updated:true});assert.match(JSON.parse(await readFile(file,'utf8')).attempt.error,/core-dump.*ABRT/);
  const service=await readFile(new URL('../server/books-a-share-daily.service',import.meta.url),'utf8');assert.match(service,/^ExecStart=\/usr\/bin\/node --max-old-space-size=192 \/opt\/books\/app\/a-share-daily\.mjs$/m);assert.match(service,/^ExecStopPost=\/usr\/bin\/node \/opt\/books\/app\/a-share-worker-exit\.mjs$/m);
});
