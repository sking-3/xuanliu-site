import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readdir,readFile,writeFile,rename,unlink,stat,statfs,access,copyFile} from 'node:fs/promises';
import {join,resolve,relative,dirname} from 'node:path';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip,gunzipSync} from 'node:zlib';
import {createInterface} from 'node:readline';

const generationPattern=/^[0-9TZ-]{1,80}$/;
const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
const cacheTables=['settings','history','history_v2','batches_v2'];
const schemeTables=['screening_scheme','screening_scheme_version','screening_scheme_run','screening_scheme_track'];
const controlTables=['research_control_heads','research_control_versions','research_control_datasets','research_control_runs','research_control_audit'];
const GiB=1024**3;
const sha=value=>createHash('sha256').update(value).digest('hex');
const stamp=now=>new Date(now()).toISOString();
const json=path=>readFile(path,'utf8').then(JSON.parse);
async function optional(path){try{return await json(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function atomic(path,value){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(value));await rename(path+'.tmp',path);}
async function exists(path){try{await access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function local(root,path){const target=resolve(root,path);if(!path||relative(root,target).startsWith('..')||resolve(root)===target)throw Error('归档路径超出恢复目录');return target;}

async function fileDigest(path,compressed=false){
  const hash=createHash('sha256');let bytes=0;
  await pipeline(createReadStream(path),...(compressed?[createGunzip()]:[]),new Writable({write(chunk,encoding,callback){hash.update(chunk);bytes+=chunk.length;callback();}}));
  return {sha256:hash.digest('hex'),bytes};
}
async function verifiedGzip(path){
  const original=await fileDigest(path),compressed=path+'.gz';
  if(!await exists(compressed)){await pipeline(createReadStream(path),createGzip({level:9}),createWriteStream(compressed+'.tmp'));await rename(compressed+'.tmp',compressed);}
  const restored=await fileDigest(compressed,true);
  if(restored.sha256!==original.sha256||restored.bytes!==original.bytes)throw Error('压缩恢复校验不符，保留明文：'+path);
  return {...original,gzipBytes:(await stat(compressed)).size};
}

/** Cold generations remain readable without being moved or published again. */
export async function readStoredFile(path){
  try{return await readFile(path);}catch(error){if(error.code!=='ENOENT')throw error;return gunzipSync(await readFile(path+'.gz'));}
}
export async function readStoredJson(path){return JSON.parse((await readStoredFile(path)).toString('utf8'));}

function tableInfo(db,names){
  return names.map(name=>{
    const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if(!schema)throw Error('恢复表不存在：'+name);
    const columns=db.prepare('PRAGMA table_info('+name+')').all();
    return {name,sql:schema.sql,columns:columns.map(column=>column.name),order:columns.filter(column=>column.pk).sort((a,b)=>a.pk-b.pk).map(column=>column.name)};
  });
}
function selectedSchemeTables(available){
  const names=[];for(const group of [schemeTables,controlTables])if(group.some(name=>available.has(name))){if(!group.every(name=>available.has(name)))throw Error('方案恢复表组不完整');names.push(...group);}return names;
}
function rows(db,tables,day){
  return (function*(){for(const table of tables){
    const where=day&&table.name!=='settings'?' WHERE day=?':'';
    const order=table.order.length?' ORDER BY '+table.order.join(','):'';
    const statement=db.prepare('SELECT '+table.columns.join(',')+' FROM '+table.name+where+order);
    for(const row of day&&table.name!=='settings'?statement.iterate(day):statement.iterate())yield {table:table.name,row:table.columns.map(column=>row[column])};
  }})();
}
function rowDigest(db,tables,day){const hash=createHash('sha256'),counts=Object.fromEntries(tables.map(table=>[table.name,0]));for(const row of rows(db,tables,day)){hash.update(JSON.stringify(row)+'\n');counts[row.table]++;}return {sha256:hash.digest('hex'),counts};}

async function writeDatabaseSnapshot({dbFile,dir,kind,day,now}){
  const db=new DatabaseSync(dbFile,{readOnly:true});db.exec('PRAGMA busy_timeout=5000; BEGIN');
  const folder=join(dir,'archives',kind);await mkdir(folder,{recursive:true,mode:0o700});
  const temp=join(folder,'snapshot-'+process.pid+'-'+now()+'.tmp.gz');
  try{
    const names=kind==='cache'?cacheTables:selectedSchemeTables(new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)));
    if(!names.length)return null;
    const tables=tableInfo(db,names),indexes=db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().filter(row=>names.includes(row.tbl_name));
    const header={schema:'books.a-share.database-archive.v1',kind,day:day||null,tables,indexes},hash=createHash('sha256'),counts=Object.fromEntries(names.map(name=>[name,0]));
    const source=(async function*(){yield JSON.stringify(header)+'\n';for(const row of rows(db,tables,day)){const line=JSON.stringify(row)+'\n';hash.update(line);counts[row.table]++;yield line;}})();
    await pipeline(Readable.from(source),createGzip({level:9}),createWriteStream(temp,{flags:'wx',mode:0o600}));
    const rowsSha256=hash.digest('hex'),identity=sha(JSON.stringify(header)+rowsSha256),name=(day?day+'-':'')+identity+'.ndjson.gz',file=join(folder,name);
    const content=await fileDigest(temp,true),record={schema:'books.a-share.database-manifest.v1',kind,day:day||null,createdAt:stamp(now),file:relative(dir,file),...content,gzipBytes:(await stat(temp)).size,rowsSha256,counts};
    if(await exists(file)){const old=await fileDigest(file,true);if(old.sha256!==content.sha256||old.bytes!==content.bytes)throw Error('已有恢复档与新快照不一致');await unlink(temp);}else await rename(temp,file);
    const manifest=file+'.manifest.json';if(!await exists(manifest))await atomic(manifest,record);
    await verifyDatabaseSnapshot({dir,manifest:relative(dir,manifest)});
    return relative(dir,manifest);
  }finally{db.exec('ROLLBACK');db.close();if(await exists(temp))await unlink(temp);}
}

export async function restoreDatabaseSnapshot({dir,manifest,target}){
  if(await exists(target))throw Error('数据库恢复目标必须不存在');
  const meta=await json(local(dir,manifest)),file=local(dir,meta.file),content=await fileDigest(file,true);
  if(content.sha256!==meta.sha256||content.bytes!==meta.bytes)throw Error('数据库归档校验失败');
  const reader=createInterface({input:createReadStream(file).pipe(createGunzip()),crlfDelay:Infinity}),iterator=reader[Symbol.asyncIterator](),first=await iterator.next();
  const header=JSON.parse(first.value),names=header.kind==='cache'?cacheTables:selectedSchemeTables(new Set(header.tables.map(table=>table.name)));
  if(header.schema!=='books.a-share.database-archive.v1'||!['cache','schemes'].includes(header.kind)||header.kind!==meta.kind||header.day!==meta.day||!names.length||header.tables.map(table=>table.name).join(',')!==names.join(','))throw Error('数据库归档身份不符');
  await mkdir(dirname(target),{recursive:true});const db=new DatabaseSync(target);db.exec('BEGIN');
  try{
    const inserts=new Map();for(const table of header.tables){db.exec(table.sql);inserts.set(table.name,db.prepare('INSERT INTO '+table.name+'('+table.columns.join(',')+') VALUES('+table.columns.map(()=>'?').join(',')+')'));}
    for(let next=await iterator.next();!next.done;next=await iterator.next()){const row=JSON.parse(next.value),insert=inserts.get(row.table);if(!insert)throw Error('数据库归档含未知表');insert.run(...row.row);}
    for(const index of header.indexes)db.exec(index.sql);
    const actual=rowDigest(db,header.tables,header.day);
    if(actual.sha256!==meta.rowsSha256||JSON.stringify(actual.counts)!==JSON.stringify(meta.counts))throw Error('隔离恢复后的数据库记录不符');
    db.exec('COMMIT');return {kind:header.kind,day:header.day,counts:actual.counts,rowsSha256:actual.sha256};
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();reader.close();}
}
async function verifyDatabaseSnapshot({dir,manifest}){
  const target=join(dir,'archives','.verify-'+process.pid+'-'+Date.now()+'.sqlite');
  try{return await restoreDatabaseSnapshot({dir,manifest,target});}finally{if(await exists(target))await unlink(target);}
}

async function archiveCacheDay({dir,day,now}){
  const dbFile=join(dir,'collector.sqlite'),manifest=await writeDatabaseSnapshot({dbFile,dir,kind:'cache',day,now}),meta=await json(local(dir,manifest));
  const db=new DatabaseSync(dbFile);db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  try{
    const current=rowDigest(db,tableInfo(db,cacheTables),day);
    if(current.sha256!==meta.rowsSha256)throw Error('缓存快照后来源状态发生变化，未迁移热缓存');
    let moved=0;for(const table of cacheTables.filter(name=>name!=='settings'))moved+=Number(db.prepare('DELETE FROM '+table+' WHERE day=?').run(day).changes);
    db.exec('COMMIT');return {day,manifest,moved,counts:meta.counts,gzipBytes:meta.gzipBytes,originalBytes:meta.bytes};
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}

async function files(root){
  if(!await exists(root))return [];
  const result=[];for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile())result.push(path);else throw Error('归档目录含未支持的文件类型');}return result;
}
async function archiveGeneration({dir,generation,now,schemes}){
  const path=join(dir,'archives','generations',generation+'.json'),previous=await optional(path),records=previous?.files||[],verified=new Set(),indices=new Map(records.map((record,index)=>[record.path,index]));schemes=previous?.schemes||schemes;let newlyCompressedFiles=0,savedBytes=0,pending=[];
  async function flush(){
    if(!pending.length)return;
    await atomic(path,{schema:'books.a-share.generation-archive.v1',generation,createdAt:previous?.createdAt||stamp(now),status:'compressing',schemes,files:records});
    for(const {file,record}of pending){await unlink(file);verified.add(record.path);newlyCompressedFiles++;savedBytes+=record.bytes-record.gzipBytes;}
    pending=[];
  }
  for(const kind of ['generations','private/generations'])for(const file of await files(join(dir,kind,generation))){
    if(!/\.(?:json|ndjson|svg)$/.test(file)||file.endsWith('/complete.json'))continue;
    const record={path:relative(dir,file),...await verifiedGzip(file)},index=indices.get(record.path);
    if(index===undefined){indices.set(record.path,records.length);records.push(record);}else records[index]=record;
    pending.push({file,record});if(pending.length===128)await flush();
  }
  await flush();
  for(const record of records)if(!verified.has(record.path)){const restored=await fileDigest(local(dir,record.path)+'.gz',true);if(restored.sha256!==record.sha256||restored.bytes!==record.bytes)throw Error('已有冷代归档校验失败：'+record.path);}
  const result={schema:'books.a-share.generation-archive.v1',generation,createdAt:previous?.createdAt||stamp(now),status:'complete',schemes,files:records,newlyCompressedFiles,savedBytes};await atomic(path,result);return result;
}

/** Conservative allowance includes the next batch, server reserve and SQLite VACUUM copy. */
export async function assertCollectionSpace({dir,reserveBytes=GiB,batchBytes=GiB}={}){
  const disk=await statfs(dir),freeBytes=disk.bavail*disk.bsize,db=join(dir,'collector.sqlite'),dbBytes=await exists(db)?(await stat(db)).size:0,requiredBytes=reserveBytes+batchBytes+2*dbBytes;
  if(freeBytes<requiredBytes)throw Object.assign(Error('归档空间不足，已停止本轮采集并保留最近成功结果'),{code:'archive_capacity',details:{freeBytes,requiredBytes,reserveBytes,batchBytes,vacuumAllowance:2*dbBytes}});
  return {freeBytes,requiredBytes};
}
async function withLock(dir,fn){
  const path=join(dir,'worker.lock');let owned=false;
  try{await writeFile(path,String(process.pid),{flag:'wx'});owned=true;}catch(error){if(error.code!=='EEXIST')throw error;if((await readFile(path,'utf8')).trim()!==String(process.pid))throw Error('采集任务运行中，未修改归档');}
  try{return await fn();}finally{if(owned)await unlink(path);}
}

export async function runRetention({dir,booksDb,hotGenerations=2,now=Date.now,onProgress=()=>{},reserveBytes=GiB}={}){
  if(!Number.isInteger(hotGenerations)||hotGenerations<1)throw Error('热代保留数至少为1');
  await mkdir(dir,{recursive:true});return withLock(dir,async()=>{
    const statusPath=join(dir,'retention-status.json'),startedAt=stamp(now),protectedGenerations=new Set(),protectedDays=new Set();
    const progress=async value=>{await atomic(statusPath,{schema:'books.a-share.retention.v1',status:'running',startedAt,updatedAt:stamp(now),...value});await onProgress(value);};
    try{
      for(const name of await readdir(dir))if(name.endsWith('.json')){const value=await json(join(dir,name));if(generationPattern.test(value?.generation||''))protectedGenerations.add(value.generation);if(dayPattern.test(value?.attempt?.day||''))protectedDays.add(value.attempt.day);}
      const generations=[];
      if(await exists(join(dir,'generations')))for(const entry of await readdir(join(dir,'generations'),{withFileTypes:true}))if(entry.isDirectory()&&generationPattern.test(entry.name)){const marker=await optional(join(dir,'generations',entry.name,'complete.json'));generations.push({generation:entry.name,day:marker?.day||entry.name.slice(0,10),completed:marker?.completed===true,finishedAt:marker?.finishedAt||''});}
      const completed=generations.filter(item=>item.completed).sort((a,b)=>b.day.localeCompare(a.day)||b.finishedAt.localeCompare(a.finishedAt));for(const item of completed.slice(0,hotGenerations))protectedGenerations.add(item.generation);for(const item of generations)if(protectedGenerations.has(item.generation))protectedDays.add(item.day);
      await progress({stage:'archive-backup',hotGenerations:protectedGenerations.size});
      const schemes=booksDb&&await exists(booksDb)?await writeDatabaseSnapshot({dbFile:booksDb,dir,kind:'schemes',now}):null;if(schemes)await atomic(join(dir,'archives','schemes','latest.json'),{manifest:schemes});
      const archived=[];for(const item of generations)if(!protectedGenerations.has(item.generation)){await progress({stage:'archive-compress',generation:item.generation,checked:archived.length,total:generations.length-protectedGenerations.size});archived.push(await archiveGeneration({dir,generation:item.generation,now,schemes}));}
      const caches=[];
      const dbFile=join(dir,'collector.sqlite');
      if(await exists(dbFile)){
        const db=new DatabaseSync(dbFile,{readOnly:true});let days;try{days=db.prepare('SELECT day FROM history UNION SELECT day FROM history_v2 UNION SELECT day FROM batches_v2 ORDER BY day').all().map(row=>row.day);}finally{db.close();}
        if(days.some(day=>!protectedDays.has(day)))await assertCollectionSpace({dir,reserveBytes,batchBytes:0});
        for(const day of days)if(!protectedDays.has(day)){if(!dayPattern.test(day))throw Error('缓存日期无效，未迁移');await progress({stage:'archive-cache',day,checked:caches.length,total:days.filter(value=>!protectedDays.has(value)).length});caches.push(await archiveCacheDay({dir,day,now}));}
        if(caches.length){const size=(await stat(dbFile)).size,disk=await statfs(dir);if(disk.bavail*disk.bsize<reserveBytes+2*size)throw Error('缓存已安全冷归档，SQLite压缩临时空间不足；未启动VACUUM');await progress({stage:'archive-vacuum',checked:caches.length});const db=new DatabaseSync(dbFile);try{db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM');}finally{db.close();}}
      }
      const result={schema:'books.a-share.retention.v1',status:'complete',startedAt,finishedAt:stamp(now),hotGenerations,protectedGenerations:[...protectedGenerations],protectedDays:[...protectedDays],coldGenerations:archived.length,newlyCompressedFiles:archived.reduce((n,item)=>n+item.newlyCompressedFiles,0),savedFileBytes:archived.reduce((n,item)=>n+item.savedBytes,0),compressedFiles:archived.reduce((sum,item)=>sum+item.files.length,0),coldBytes:archived.reduce((sum,item)=>sum+item.files.reduce((n,file)=>n+file.gzipBytes,0),0),originalBytes:archived.reduce((sum,item)=>sum+item.files.reduce((n,file)=>n+file.bytes,0),0),caches,schemes};await atomic(statusPath,result);return result;
    }catch(error){await atomic(statusPath,{schema:'books.a-share.retention.v1',status:'failed',startedAt,finishedAt:stamp(now),error:error.message,details:error.details||null});throw error;}
  });
}

export async function restoreGeneration({dir,generation,target,now=Date.now}={}){
  if(!generationPattern.test(generation||''))throw Error('恢复批次无效');
  if(await exists(target))throw Error('恢复目标必须为空且不存在；不会覆盖生产目录');
  return withLock(dir,async()=>{
    const root=resolve(target);await mkdir(root,{recursive:false});
    const archived=await optional(join(dir,'archives','generations',generation+'.json')),recordMap=new Map((archived?.files||[]).map(item=>[item.path,item]));
    let copied=0;const recovered=new Set();
    for(const kind of ['generations','private/generations']){
      const folder=join(dir,kind,generation),paths=await files(folder),seen=new Set();
      for(const path of paths){
        const rel=relative(dir,path),plain=rel.endsWith('.gz')?rel.slice(0,-3):rel;if(seen.has(plain))continue;seen.add(plain);
        const source=join(dir,plain),destination=local(root,plain),meta=recordMap.get(plain);await mkdir(dirname(destination),{recursive:true});
        const hash=createHash('sha256');let bytes=0;const meter=new Transform({transform(chunk,encoding,callback){hash.update(chunk);bytes+=chunk.length;callback(null,chunk);}});
        await pipeline(createReadStream(await exists(source)?source:source+'.gz'),...(await exists(source)?[]:[createGunzip()]),meter,createWriteStream(destination,{flags:'wx'}));
        const result=hash.digest('hex');if(meta&&(meta.sha256!==result||meta.bytes!==bytes))throw Error('恢复文件校验失败：'+plain);if(await exists(source+'.gz')){const compressed=await fileDigest(source+'.gz',true);if(compressed.sha256!==result||compressed.bytes!==bytes)throw Error('恢复双格式内容不一致');await copyFile(source+'.gz',destination+'.gz');}recovered.add(plain);copied++;
      }
    }
    for(const file of recordMap.keys())if(!recovered.has(file))throw Error('归档文件缺失，未发布恢复指针：'+file);
    const marker=await optional(join(root,'generations',generation,'complete.json'))||{generation,day:generation.slice(0,10),completed:false};
    const cacheFolder=join(dir,'archives','cache');
    if(await exists(join(dir,'collector.sqlite'))){const db=new DatabaseSync(join(dir,'collector.sqlite'),{readOnly:true});let count;try{count=db.prepare('SELECT (SELECT count(*) FROM history WHERE day=?)+(SELECT count(*) FROM history_v2 WHERE day=?)+(SELECT count(*) FROM batches_v2 WHERE day=?) AS n').get(marker.day,marker.day,marker.day).n;}finally{db.close();}if(count)await writeDatabaseSnapshot({dbFile:join(dir,'collector.sqlite'),dir,kind:'cache',day:marker.day,now});}
    const cacheManifests=[];if(await exists(cacheFolder))for(const name of await readdir(cacheFolder))if(name.startsWith(marker.day+'-')&&name.endsWith('.manifest.json')){const meta=await json(join(cacheFolder,name));cacheManifests.push({path:relative(dir,join(cacheFolder,name)),createdAt:meta.createdAt});}
    cacheManifests.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));if(!cacheManifests.length)throw Error('该代缺少可验证的来源缓存恢复档');
    for(let i=0;i<cacheManifests.length;i++){
      const file=join(root,i?'cache-part-'+i+'.sqlite':'collector.sqlite');await restoreDatabaseSnapshot({dir,manifest:cacheManifests[i].path,target:file});
      if(i){const db=new DatabaseSync(join(root,'collector.sqlite'));try{db.prepare('ATTACH DATABASE ? AS part').run(file);db.exec('BEGIN');for(const table of cacheTables)db.exec('INSERT OR REPLACE INTO '+table+' SELECT * FROM part.'+table);db.exec('COMMIT');}finally{db.close();}await unlink(file);}
    }
    const cacheManifest=cacheManifests.map(item=>item.path);
    const latest=await optional(join(dir,'archives','schemes','latest.json')),schemes=archived?.schemes||latest?.manifest;
    if(schemes)await restoreDatabaseSnapshot({dir,manifest:schemes,target:join(root,'schemes.sqlite')});
    if(marker.completed===true)await atomic(join(root,'current.json'),Object.fromEntries(Object.entries(marker).filter(([key])=>key!=='completed')));
    const result={schema:'books.a-share.restore.v1',generation,restoredAt:stamp(now),copiedFiles:copied,cacheManifest,schemes:schemes||null,completed:marker.completed===true};await atomic(join(root,'RESTORED.json'),result);return result;
  });
}
