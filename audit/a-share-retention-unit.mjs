import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {runRetention,restoreGeneration,restoreDatabaseSnapshot,assertCollectionSpace,readStoredFile} from '../server/a-share-retention.mjs';

const fixed=()=>Date.parse('2026-11-24T10:00:00Z');
const days=['2026-11-01','2026-11-02','2026-11-03','2026-11-04'];
const generations=days.map((day,i)=>day+'T090000Z-'+i);
const cacheTables=['settings','history','history_v2','batches_v2'];
const schemeTables=['screening_scheme','screening_scheme_version','screening_scheme_run','screening_scheme_track'];
const controlTables=['research_control_heads','research_control_versions','research_control_datasets','research_control_runs','research_control_audit'];
const writeJson=(file,value)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));};
const readJson=file=>JSON.parse(readFileSync(file,'utf8'));
const bars=()=>Array.from({length:500},(_,i)=>({date:new Date(Date.UTC(2024,0,i+1)).toISOString().slice(0,10),open:10+i/100,high:11+i/100,low:9+i/100,close:10.5+i/100,volume:100000+i}));

function cacheSchema(db){db.exec(`
  CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE history(day TEXT NOT NULL,code TEXT NOT NULL,as_of TEXT NOT NULL,source_json TEXT NOT NULL,PRIMARY KEY(day,code));
  CREATE TABLE history_v2(source_id TEXT NOT NULL,day TEXT NOT NULL,code TEXT NOT NULL,as_of TEXT NOT NULL,source_json TEXT NOT NULL,PRIMARY KEY(source_id,day,code,as_of));
  CREATE TABLE batches_v2(source_id TEXT NOT NULL,day TEXT NOT NULL,as_of TEXT NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(source_id,day));
`);}
function schemeSchema(db){db.exec(`
  CREATE TABLE screening_scheme(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE screening_scheme_version(scheme_id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,config_json TEXT NOT NULL,selection_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scheme_id,revision));
  CREATE TABLE screening_scheme_run(id TEXT PRIMARY KEY,scheme_id TEXT NOT NULL,revision INTEGER NOT NULL,day TEXT NOT NULL,generation TEXT NOT NULL,source_id TEXT NOT NULL,as_of TEXT NOT NULL,engine_version TEXT NOT NULL,pattern_version TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error TEXT,records_json TEXT NOT NULL DEFAULT '[]',summary_json TEXT);
  CREATE TABLE screening_scheme_track(id TEXT PRIMARY KEY,scheme_id TEXT NOT NULL,revision INTEGER NOT NULL,code TEXT NOT NULL,entry_day TEXT NOT NULL,episode_json TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX screening_scheme_completed_method ON screening_scheme_run(scheme_id,revision,day,source_id,engine_version,pattern_version) WHERE status='complete';
  CREATE TABLE research_control_heads(owner_id TEXT PRIMARY KEY,current_revision INTEGER NOT NULL DEFAULT 0,active_revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
  CREATE TABLE research_control_versions(owner_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,kind TEXT NOT NULL,source_revision INTEGER,config_json TEXT NOT NULL,engine_version TEXT NOT NULL,PRIMARY KEY(owner_id,revision));
  CREATE TABLE research_control_datasets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,dataset_json TEXT NOT NULL,summary_json TEXT NOT NULL,UNIQUE(owner_id,sha256));
  CREATE TABLE research_control_runs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL,dataset_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,progress_json TEXT,result_json TEXT,settings_json TEXT NOT NULL,engine_version TEXT NOT NULL,error_code TEXT,stop_requested INTEGER NOT NULL DEFAULT 0);
  CREATE UNIQUE INDEX research_control_one_running_owner ON research_control_runs(owner_id) WHERE status IN ('queued','running');
  CREATE TABLE research_control_audit(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,event TEXT NOT NULL,created_at TEXT NOT NULL,revision INTEGER,detail_json TEXT NOT NULL);
  CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT);
`);}
function rows(file,names,day){const db=new DatabaseSync(file,{readOnly:true});try{return Object.fromEntries(names.map(name=>{const order=db.prepare('PRAGMA table_info('+name+')').all().filter(column=>column.pk).sort((a,b)=>a.pk-b.pk).map(column=>column.name).join(',');return [name,db.prepare('SELECT * FROM '+name+(day&&name!=='settings'?' WHERE day=?':'')+' ORDER BY '+order).all(...(day&&name!=='settings'?[day]:[])).map(row=>({...row}))];}));}finally{db.close();}}

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'books-retention-')),dir=join(root,'data'),booksDb=join(root,'books.sqlite');mkdirSync(dir);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=new DatabaseSync(join(dir,'collector.sqlite'));cacheSchema(source);
  source.prepare('INSERT INTO settings VALUES(?,?)').run('source-hold',JSON.stringify({disabled:false,observedAt:'2026-11-24T00:00:00Z'}));
  for(let i=0;i<days.length;i++){
    const day=days[i],generation=generations[i],asOf=day+'T08:00:00Z',record={schema:'raw',bars:bars(),fetchedAt:asOf};
    for(const code of ['000300.SH','000001.SH','399001.SZ','600519.SH'])source.prepare('INSERT INTO history_v2 VALUES(?,?,?,?,?)').run('tickflow-free-forward-v1',day,code,asOf,JSON.stringify({...record,code}));
    source.prepare('INSERT INTO history VALUES(?,?,?,?)').run(day,'600519.SH',asOf,JSON.stringify(record));
    source.prepare('INSERT INTO batches_v2 VALUES(?,?,?,?)').run('tickflow-free-forward-v1',day,asOf,JSON.stringify({asOf,expectedCount:1,stocks:[{code:'600519.SH',name:'冻结名册'}]}));
    const publicDir=join(dir,'generations',generation),privateDir=join(dir,'private','generations',generation);
    const marker={generation,day,asOf,sourceId:'tickflow-free-forward-v1',finishedAt:day+'T09:00:00Z',completed:true};
    writeJson(join(publicDir,'complete.json'),marker);
    for(const name of ['result-consensus-20-all-000300.SH.json','pattern-regimes.json']){
      const value={generation,day,asOf,patterns:[],candidates:[{code:'600519.SH'}]};writeJson(join(publicDir,name),value);writeFileSync(join(publicDir,name+'.gz'),gzipSync(JSON.stringify(value)));
    }
    const chart='<svg xmlns="http://www.w3.org/2000/svg"><title>600519.SH '+day+'</title></svg>';writeFileSync(join(publicDir,'entry-chart.svg'),chart);writeFileSync(join(publicDir,'entry-chart.svg.gz'),gzipSync(chart));
    for(const code of ['000300.SH','000001.SH','399001.SZ'])writeJson(join(privateDir,'dataset-all-'+code+'.json'),{day,referenceCode:code,referenceBars:bars().slice(-61),records:[{code:'600519.SH',bars:bars().slice(-61)}]});
    writeFileSync(join(privateDir,'history-all.ndjson'),JSON.stringify({schema:'history',day,referenceCode:'000300.SH',referenceBars:bars()})+'\n'+JSON.stringify({code:'600519.SH',bars:bars()})+'\n');
  }
  source.close();
  writeJson(join(dir,'current.json'),{generation:generations[3],day:days[3]});writeJson(join(dir,'historical-current.json'),{generation:generations[0],day:days[0]});
  const books=new DatabaseSync(booksDb);schemeSchema(books);
  books.prepare('INSERT INTO screening_scheme VALUES(?,?,?,?,?,?,?)').run('scheme-a','owner-a','初期转强',1,1,'2026-11-01','2026-11-04');
  books.prepare('INSERT INTO screening_scheme_version VALUES(?,?,?,?,?,?)').run('scheme-a',1,'初期转强','{"threshold":0.6}','{"qualification":"strict"}','2026-11-01');
  books.prepare('INSERT INTO screening_scheme_run VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('run-a','scheme-a',1,days[1],generations[1],'tickflow-free-forward-v1',days[1]+'T08:00:00Z','model-v1','patterns-v1','daily','complete',days[1]+'T08:30:00Z',days[1]+'T09:00:00Z',null,'[{"code":"600519.SH","state":"new"}]','{"new":1}');
  books.prepare('INSERT INTO screening_scheme_track VALUES(?,?,?,?,?,?,?)').run('track-a','scheme-a',1,'600519.SH',days[1],'{"targetDays":15,"targetReturn":5,"status":"active"}','2026-11-04');
  books.prepare('INSERT INTO research_control_heads VALUES(?,?,?,?)').run('owner-a',1,1,days[1]);
  books.prepare('INSERT INTO research_control_versions VALUES(?,?,?,?,?,?,?)').run('owner-a',1,days[1],'config_saved',null,'{"threshold":0.6}','model-v1');
  books.prepare('INSERT INTO research_control_datasets VALUES(?,?,?,?,?,?,?)').run('dataset-a','owner-a',days[1],'fixture-dataset-hash',2,'{"records":[]}','{"ready":0}');
  books.prepare('INSERT INTO research_control_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('control-run-a','owner-a',1,'dataset-a','complete',days[1],days[1],days[1],'{"checked":0}','{"matched":0}','{"threshold":0.6}','model-v1',null,0);
  books.prepare('INSERT INTO research_control_audit VALUES(?,?,?,?,?,?)').run('audit-a','owner-a','run_finished',days[1],1,'{"runId":"control-run-a"}');
  books.prepare('INSERT INTO users VALUES(?,?)').run('owner-a','must-not-be-in-backup');books.close();
  return {root,dir,booksDb,retain:options=>runRetention({dir,booksDb,now:fixed,reserveBytes:0,...options})};
}

test('cold migration preserves all indices, frozen roster, plans and reviews through an isolated restore',async t=>{
  const f=fixture(t),generation=generations[1],rawFile=join(f.dir,'private','generations',generation,'history-all.ndjson'),raw=readFileSync(rawFile),pointer=readFileSync(join(f.dir,'current.json'));
  const expectedCache=rows(join(f.dir,'collector.sqlite'),cacheTables,days[1]),expectedSchemes=rows(f.booksDb,[...schemeTables,...controlTables]);
  const originalFetch=globalThis.fetch;let network=0;globalThis.fetch=()=>{network++;throw Error('external requests prohibited');};t.after(()=>{globalThis.fetch=originalFetch;});
  const result=await f.retain();assert.equal(result.status,'complete');assert.equal(result.coldGenerations,1);assert.equal(result.caches.length,1);assert.equal(result.caches[0].day,days[1]);
  assert.equal(result.caches[0].counts.history_v2,4);assert.equal(existsSync(rawFile),false);assert.deepEqual(gunzipSync(readFileSync(rawFile+'.gz')),raw);assert.deepEqual(await readStoredFile(rawFile),raw);
  for(const index of [0,2,3])assert.equal(existsSync(join(f.dir,'private','generations',generations[index],'history-all.ndjson')),true);
  assert.deepEqual(readFileSync(join(f.dir,'current.json')),pointer);assert.equal(rows(join(f.dir,'collector.sqlite'),['history_v2'],days[1]).history_v2.length,0);
  assert.deepEqual(rows(join(f.dir,'collector.sqlite'),['settings']),{settings:expectedCache.settings});
  const target=join(f.root,'restored'),restored=await restoreGeneration({dir:f.dir,generation,target,now:fixed});assert.equal(restored.completed,true);
  assert.deepEqual(readFileSync(join(target,'private','generations',generation,'history-all.ndjson')),raw);
  const chart=join(target,'generations',generation,'entry-chart.svg');assert.deepEqual(gunzipSync(readFileSync(chart+'.gz')),readFileSync(chart));
  assert.deepEqual(rows(join(target,'collector.sqlite'),cacheTables,days[1]),expectedCache);assert.deepEqual(rows(join(target,'schemes.sqlite'),[...schemeTables,...controlTables]),expectedSchemes);
  const db=new DatabaseSync(join(target,'collector.sqlite'),{readOnly:true});for(const code of ['000300.SH','000001.SH','399001.SZ'])assert.equal(JSON.parse(db.prepare('SELECT source_json FROM history_v2 WHERE code=?').get(code).source_json).bars.length,500);db.close();
  const recoveredSchemes=new DatabaseSync(join(target,'schemes.sqlite'),{readOnly:true});assert.equal(recoveredSchemes.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='users'").get().n,0);assert.equal(recoveredSchemes.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='screening_scheme_completed_method'").get().n,1);recoveredSchemes.close();
  assert.equal(readJson(join(target,'current.json')).generation,generation);assert.equal(network,0);assert.equal(readdirSync(join(f.dir,'archives')).some(name=>name.startsWith('.verify-')),false);
});

test('reruns deduplicate compressed snapshots and keep the first associated plan revision recoverable',async t=>{
  const f=fixture(t),first=await f.retain(),folder=join(f.dir,'archives','schemes'),firstCount=readdirSync(folder).length;
  const repeated=await f.retain();assert.equal(repeated.newlyCompressedFiles,0);assert.equal(repeated.caches.length,0);assert.equal(repeated.schemes,first.schemes);assert.equal(readdirSync(folder).length,firstCount);
  const db=new DatabaseSync(f.booksDb);db.exec("UPDATE screening_scheme SET name='修改后' WHERE id='scheme-a'");db.close();
  const newer=await f.retain();assert.notEqual(newer.schemes,first.schemes);
  const target=join(f.root,'old-plan-restore');await restoreGeneration({dir:f.dir,generation:generations[1],target,now:fixed});assert.equal(rows(join(target,'schemes.sqlite'),['screening_scheme']).screening_scheme[0].name,'初期转强');
  const latestTarget=join(f.root,'latest-schemes.sqlite');await restoreDatabaseSnapshot({dir:f.dir,manifest:newer.schemes,target:latestTarget});assert.equal(rows(latestTarget,['screening_scheme']).screening_scheme[0].name,'修改后');
});

test('corrupt preexisting gzip stops before deleting its original or migrating cold source rows',async t=>{
  const f=fixture(t),file=join(f.dir,'generations',generations[1],'result-consensus-20-all-000300.SH.json');writeFileSync(file+'.gz',gzipSync('different'));
  const original=readFileSync(file),pointer=readFileSync(join(f.dir,'current.json'));
  await assert.rejects(f.retain(),/压缩恢复校验不符/);assert.deepEqual(readFileSync(file),original);assert.deepEqual(readFileSync(join(f.dir,'current.json')),pointer);
  assert.equal(rows(join(f.dir,'collector.sqlite'),['history_v2'],days[1]).history_v2.length,4);assert.equal(readJson(join(f.dir,'retention-status.json')).status,'failed');
});

test('corrupt archived source data cannot publish a restored pointer and existing recovery targets are refused',async t=>{
  const f=fixture(t),result=await f.retain(),manifest=readJson(join(f.dir,result.caches[0].manifest));writeFileSync(join(f.dir,manifest.file),gzipSync('corrupted'));
  const target=join(f.root,'bad-restore');await assert.rejects(restoreGeneration({dir:f.dir,generation:generations[1],target,now:fixed}),/归档校验失败/);assert.equal(existsSync(join(target,'current.json')),false);
  await assert.rejects(restoreGeneration({dir:f.dir,generation:generations[1],target:f.dir,now:fixed}),/恢复目标必须为空/);assert.equal(readJson(join(f.dir,'current.json')).generation,generations[3]);
});

test('missing or damaged cold files fail recovery and subsequent maintenance without changing current',async t=>{
  const f=fixture(t);await f.retain();const file=join(f.dir,'private','generations',generations[1],'history-all.ndjson.gz');unlinkSync(file);
  const target=join(f.root,'missing-file');await assert.rejects(restoreGeneration({dir:f.dir,generation:generations[1],target,now:fixed}),/归档文件缺失/);assert.equal(existsSync(join(target,'current.json')),false);
  await assert.rejects(f.retain(),error=>error.code==='ENOENT');assert.equal(readJson(join(f.dir,'retention-status.json')).status,'failed');assert.equal(readJson(join(f.dir,'current.json')).generation,generations[3]);
});

test('another collector lock and a failed-attempt cache day retain active resume data',async t=>{
  const f=fixture(t);writeFileSync(join(f.dir,'worker.lock'),'other-process');await assert.rejects(f.retain(),/采集任务运行中/);assert.equal(existsSync(join(f.dir,'archives')),false);
  writeFileSync(join(f.dir,'worker.lock'),String(process.pid));writeJson(join(f.dir,'status.json'),{attempt:{day:days[1],status:'failed'}});
  const result=await f.retain();assert.equal(result.caches.length,0);assert.equal(rows(join(f.dir,'collector.sqlite'),['history_v2'],days[1]).history_v2.length,4);assert.equal(readFileSync(join(f.dir,'worker.lock'),'utf8'),String(process.pid));
});

test('capacity preflight reports explicit required space without changing any data',async t=>{
  const f=fixture(t),pointer=readFileSync(join(f.dir,'current.json'));
  await assert.rejects(assertCollectionSpace({dir:f.dir,reserveBytes:0,batchBytes:Number.MAX_SAFE_INTEGER}),error=>error.code==='archive_capacity'&&error.details.requiredBytes>error.details.freeBytes&&error.details.vacuumAllowance>0);
  assert.deepEqual(readFileSync(join(f.dir,'current.json')),pointer);assert.equal(existsSync(join(f.dir,'retention-status.json')),false);
});

test('maintenance publishes each running stage before its awaited progress callback',async t=>{
  const f=fixture(t),stages=[];await f.retain({onProgress:async value=>{const status=readJson(join(f.dir,'retention-status.json'));assert.equal(status.status,'running');assert.equal(status.stage,value.stage);await new Promise(resolve=>setImmediate(resolve));stages.push(value.stage);}});
  assert.deepEqual([...new Set(stages)],['archive-backup','archive-compress','archive-cache','archive-vacuum']);assert.equal(readJson(join(f.dir,'retention-status.json')).status,'complete');
});

test('optional scheme table groups restore independently and partially missing groups stop before cold migration',async t=>{
  for(const omitted of [schemeTables,controlTables]){
    const f=fixture(t),db=new DatabaseSync(f.booksDb);for(const table of omitted)db.exec('DROP TABLE '+table);db.close();
    const result=await f.retain(),target=join(f.root,'single-group.sqlite'),expected=omitted===schemeTables?controlTables:schemeTables;
    await restoreDatabaseSnapshot({dir:f.dir,manifest:result.schemes,target});assert.deepEqual(rows(target,expected),rows(f.booksDb,expected));
  }
  const f=fixture(t),db=new DatabaseSync(f.booksDb);db.exec('DROP TABLE research_control_audit');db.close();await assert.rejects(f.retain(),/方案恢复表组不完整/);
  assert.equal(existsSync(join(f.dir,'private','generations',generations[1],'history-all.ndjson')),true);assert.equal(rows(join(f.dir,'collector.sqlite'),['history_v2'],days[1]).history_v2.length,4);
});

test('incomplete generations can be recovered as private artifacts without claiming a completed batch',async t=>{
  const f=fixture(t),generation='2026-11-02T010000Z-99',file=join(f.dir,'generations',generation,'result.json');writeJson(file,{stage:'incomplete'});
  await f.retain();assert.equal(existsSync(file),false);const target=join(f.root,'partial');const result=await restoreGeneration({dir:f.dir,generation,target,now:fixed});
  assert.equal(result.completed,false);assert.equal(existsSync(join(target,'current.json')),false);assert.deepEqual(readJson(join(target,'generations',generation,'result.json')),{stage:'incomplete'});
});

test('multi-megabyte 500-bar archive restores byte-for-byte through the streaming path',async t=>{
  const f=fixture(t),generation=generations[1],file=join(f.dir,'private','generations',generation,'history-all.ndjson');
  const records=Array.from({length:160},(_,i)=>({code:String(600000+i)+'.SH',bars:bars().map((bar,n)=>({...bar,close:bar.close+i/100+n%7/1000,volume:bar.volume+i*997}))}));
  writeFileSync(file,records.map(record=>JSON.stringify(record)).join('\n')+'\n');
  const original=readFileSync(file),before=createHash('sha256').update(original).digest('hex');assert.ok(original.length>6*1024**2);
  await f.retain();const target=join(f.root,'large-restore');await restoreGeneration({dir:f.dir,generation,target,now:fixed});
  const restored=readFileSync(join(target,'private','generations',generation,'history-all.ndjson'));assert.equal(createHash('sha256').update(restored).digest('hex'),before);
  assert.equal(restored.length,original.length);assert.ok(readFileSync(file+'.gz').length<original.length);t.diagnostic(JSON.stringify({synthetic:true,rawBytes:original.length,gzipBytes:readFileSync(file+'.gz').length}));
});

test('more than 128 files cross manifest commit groups and restore including the final partial group',async t=>{
  const f=fixture(t),generation=generations[1],location=join(f.dir,'generations',generation,'entries'),originals=new Map();mkdirSync(location);
  for(let i=0;i<267;i++){
    const file=join(location,'entry-'+String(i).padStart(3,'0')+(i%2?'.json':'.svg')),body=i%2?JSON.stringify({code:'600519.SH',index:i}):'<svg><title>'+i+'</title></svg>';
    writeFileSync(file,body);originals.set(file,Buffer.from(body));
  }
  const result=await f.retain(),manifest=readJson(join(f.dir,'archives','generations',generation+'.json'));
  assert.equal(manifest.status,'complete');assert.ok(result.newlyCompressedFiles>256);assert.equal(new Set(manifest.files.map(file=>file.path)).size,manifest.files.length);
  for(const [file,body]of originals){assert.equal(existsSync(file),false);assert.deepEqual(gunzipSync(readFileSync(file+'.gz')),body);}
  const target=join(f.root,'grouped-restore');await restoreGeneration({dir:f.dir,generation,target,now:fixed});
  for(const [file,body]of originals){const restored=join(target,file.slice(f.dir.length+1));assert.deepEqual(readFileSync(restored),body);assert.deepEqual(gunzipSync(readFileSync(restored+'.gz')),body);}
});

test('a bad gzip keeps the entire uncommitted group plaintext and resumes after repair without duplicate records',async t=>{
  const f=fixture(t),generation=generations[1],location=join(f.dir,'generations',generation),marker=readJson(join(location,'complete.json'));rmSync(location,{recursive:true});mkdirSync(location);writeJson(join(location,'complete.json'),marker);
  for(let i=0;i<260;i++)writeJson(join(location,'entry-'+String(i).padStart(3,'0')+'.json'),{code:'600519.SH',index:i});
  const names=readdirSync(location).filter(name=>name!=='complete.json'),bad=join(location,names[200]),original=readFileSync(bad);writeFileSync(bad+'.gz',gzipSync('bad group member'));
  await assert.rejects(f.retain(),/压缩恢复校验不符/);const manifestPath=join(f.dir,'archives','generations',generation+'.json'),partial=readJson(manifestPath);
  assert.equal(partial.status,'compressing');assert.equal(partial.files.length,128);
  for(const [i,name]of names.entries())assert.equal(existsSync(join(location,name)),i>=128,name);
  assert.equal(rows(join(f.dir,'collector.sqlite'),['history_v2'],days[1]).history_v2.length,4);assert.equal(readJson(join(f.dir,'current.json')).generation,generations[3]);
  writeFileSync(bad+'.gz',gzipSync(original));await f.retain();const complete=readJson(manifestPath);assert.equal(complete.status,'complete');assert.equal(new Set(complete.files.map(file=>file.path)).size,complete.files.length);
  for(const name of names)assert.equal(existsSync(join(location,name)),false);
  const target=join(f.root,'resumed-group-restore');await restoreGeneration({dir:f.dir,generation,target,now:fixed});for(const name of names)assert.deepEqual(JSON.parse(readFileSync(join(target,'generations',generation,name))),{code:'600519.SH',index:Number(name.slice(6,9))});
});

test('a committed manifest with undeleted plaintext resumes safely after an interrupted unlink phase',async t=>{
  const f=fixture(t),generation=generations[1];await f.retain();const manifestPath=join(f.dir,'archives','generations',generation+'.json'),manifest=readJson(manifestPath);
  manifest.status='compressing';writeJson(manifestPath,manifest);
  for(const record of manifest.files.slice(0,3)){const file=join(f.dir,record.path);writeFileSync(file,gunzipSync(readFileSync(file+'.gz')));}
  const result=await f.retain(),completed=readJson(manifestPath);assert.equal(result.newlyCompressedFiles,3);assert.equal(completed.status,'complete');assert.equal(completed.files.length,manifest.files.length);
  assert.equal(new Set(completed.files.map(file=>file.path)).size,completed.files.length);for(const record of completed.files)assert.equal(existsSync(join(f.dir,record.path)),false);
  await restoreGeneration({dir:f.dir,generation,target:join(f.root,'interrupted-unlink-restore'),now:fixed});
});
