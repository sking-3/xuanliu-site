import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const stockCode=/^(?:6\d{5}\.SH|(?:00|30)\d{4}\.SZ)$/;
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const parse=value=>value===null?null:JSON.parse(value);
const runSummaryColumns='id,scheme_id,revision,day,generation,source_id,as_of,engine_version,pattern_version,kind,status,started_at,finished_at,error,summary_json';
const rawKeys=new Set(['bars','referencebars','prices','price','close','open','high','low','entryprice','exitprice','startclose','endclose','raw','rawresponse']);
function reject(status,code,message){throw Object.assign(new Error(message),{status,code});}
function text(value,label,max=128){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[<>\u0000-\u001f\u007f]/.test(value))reject(400,'invalid_input',label+'格式无效');return value.trim();
}
function day(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)reject(400,'invalid_day','交易日无效');return value;
}
function timestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))reject(400,'invalid_timestamp','时间须为含时区的 ISO 时间');day(value.slice(0,10));return value;
}
function encode(value,{derived=false}={}){
  let nodes=0;
  function visit(item,depth){
    if(++nodes>2000000||depth>20)reject(400,'invalid_json','资料结构过大');
    if(item===null||typeof item==='string'||typeof item==='boolean')return;
    if(typeof item==='number'&&Number.isFinite(item))return;
    if(!item||typeof item!=='object'||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))reject(400,'invalid_json','只接受普通 JSON 资料');
    if(Array.isArray(item))for(let i=0;i<item.length;i++)if(!Object.hasOwn(item,i))reject(400,'invalid_json','资料数组不能有空缺');
    for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(item))){
      if(Array.isArray(item)&&key==='length')continue;
      if(['__proto__','prototype','constructor'].includes(key)||!Object.hasOwn(descriptor,'value'))reject(400,'invalid_json','资料含无效字段');
      if(derived&&rawKeys.has(key.toLowerCase()))reject(400,'raw_data_not_allowed','方案记录只保存派生结果');
      if(descriptor.value===undefined&&!Array.isArray(item))continue;
      visit(descriptor.value,depth+1);
    }
  }
  visit(value,0);const result=JSON.stringify(value);
  if(Buffer.byteLength(result)>32*1024*1024)reject(413,'body_too_large','资料超过大小限制');return result;
}

export function createSchemeStore({db,model,patterns,now=Date.now}){
  const patternIds=new Set(patterns.definitions.map(item=>item.id)),clock=()=>new Date(now()).toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS screening_scheme (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,
      enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS screening_scheme_version (
      scheme_id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,
      config_json TEXT NOT NULL,selection_json TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(scheme_id,revision)
    );
    CREATE TABLE IF NOT EXISTS screening_scheme_run (
      id TEXT PRIMARY KEY,scheme_id TEXT NOT NULL,revision INTEGER NOT NULL,day TEXT NOT NULL,
      generation TEXT NOT NULL,source_id TEXT NOT NULL,as_of TEXT NOT NULL,
      engine_version TEXT NOT NULL,pattern_version TEXT NOT NULL,kind TEXT NOT NULL,
      status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error TEXT,
      records_json TEXT NOT NULL DEFAULT '[]',summary_json TEXT
    );
    CREATE TABLE IF NOT EXISTS screening_scheme_track (
      id TEXT PRIMARY KEY,scheme_id TEXT NOT NULL,revision INTEGER NOT NULL,code TEXT NOT NULL,
      entry_day TEXT NOT NULL,episode_json TEXT NOT NULL,updated_at TEXT NOT NULL
    );
  `);
  const q=sql=>db.prepare(sql);
  function transaction(fn){
    db.exec('BEGIN IMMEDIATE');
    try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }
  transaction(()=>db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS screening_scheme_completed_method
      ON screening_scheme_run(scheme_id,revision,day,source_id,engine_version,pattern_version) WHERE status='complete';
    DROP INDEX IF EXISTS screening_scheme_completed_day;
  `));
  function owner(value){if(!identifier(value))reject(400,'invalid_owner','方案归属无效');return value;}
  function row(id){return identifier(id)?q('SELECT * FROM screening_scheme WHERE id=?').get(id):null;}
  function owned(ownerId,id){const result=row(id);if(!result||result.owner_id!==owner(ownerId))reject(404,'scheme_not_found','找不到该方案');return result;}
  function version(schemeId,revision){return q('SELECT * FROM screening_scheme_version WHERE scheme_id=? AND revision=?').get(schemeId,revision);}
  function runView(value,full=false){
    if(!value)return null;const saved=full?version(value.scheme_id,value.revision):null;
    return {id:value.id,schemeId:value.scheme_id,revision:value.revision,day:value.day,generation:value.generation,sourceId:value.source_id,asOf:value.as_of,engineVersion:value.engine_version,patternVersion:value.pattern_version,kind:value.kind,status:value.status,startedAt:value.started_at,finishedAt:value.finished_at,error:value.error,summary:parse(value.summary_json),...(full?{records:parse(value.records_json),config:parse(saved.config_json),selection:parse(saved.selection_json)}:{})};
  }
  function schemeView(value){
    if(!value)return null;const saved=version(value.id,value.revision);
    return {id:value.id,name:value.name,revision:value.revision,enabled:!!value.enabled,config:parse(saved.config_json),selection:parse(saved.selection_json),createdAt:value.created_at,updatedAt:value.updated_at,
      attempt:runView(q('SELECT '+runSummaryColumns+' FROM screening_scheme_run WHERE scheme_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1').get(value.id)),
      lastSuccess:runView(q('SELECT '+runSummaryColumns+" FROM screening_scheme_run WHERE scheme_id=? AND status='complete' ORDER BY day DESC,started_at DESC,rowid DESC LIMIT 1").get(value.id))};
  }
  function selectionOf(value){
    encode(value);if(!value||Array.isArray(value)||Object.keys(value).some(key=>!['patternId','qualification','scopeCodes'].includes(key)))reject(400,'invalid_selection','筛选口径无效');
    if(typeof value.patternId!=='string'||value.patternId!==''&&!patternIds.has(value.patternId)||!['strict','observation'].includes(value.qualification))reject(400,'invalid_selection','形态或达标口径无效');
    if(value.scopeCodes!==null&&(!Array.isArray(value.scopeCodes)||value.scopeCodes.length>6000||value.scopeCodes.some(code=>!stockCode.test(code))))reject(400,'invalid_selection','股票范围无效');
    return {patternId:value.patternId,qualification:value.qualification,scopeCodes:value.scopeCodes===null?null:[...new Set(value.scopeCodes)]};
  }
  function save({ownerId,id,expectedRevision,name,config,selection,enabled=true}){
    owner(ownerId);name=text(name,'方案名称',80);if(typeof enabled!=='boolean')reject(400,'invalid_enabled','启用状态无效');
    encode(config);if(!config||typeof config!=='object'||Array.isArray(config))reject(400,'invalid_config','方案配置无效');
    let normalized;try{normalized=model.normalizeConfig({...config,name,settings:{...config.settings,sampleSize:'all'}});}catch{reject(400,'invalid_config','方案配置格式或参数不正确');}
    const selected=selectionOf(selection);
    if(normalized.settings.mode==='consensus')selected.scopeCodes=null;
    return transaction(()=>{
      const previous=id===undefined?null:owned(ownerId,id);
      if(previous&&expectedRevision!==previous.revision||!previous&&expectedRevision!==undefined&&expectedRevision!==0)reject(409,'revision_conflict','方案版本已变化，请刷新后保存');
      const schemeId=previous?.id||randomUUID(),revision=(previous?.revision||0)+1,at=clock();
      q('INSERT INTO screening_scheme_version VALUES (?,?,?,?,?,?)').run(schemeId,revision,name,JSON.stringify(normalized),JSON.stringify(selected),at);
      if(previous)q('UPDATE screening_scheme SET name=?,revision=?,enabled=?,updated_at=? WHERE id=?').run(name,revision,Number(enabled),at,schemeId);
      else q('INSERT INTO screening_scheme VALUES (?,?,?,?,?,?,?)').run(schemeId,ownerId,name,revision,Number(enabled),at,at);
      return schemeView(row(schemeId));
    });
  }
  function list({ownerId}={}){
    const values=ownerId===undefined?q('SELECT * FROM screening_scheme ORDER BY created_at DESC,rowid DESC').all():q('SELECT * FROM screening_scheme WHERE owner_id=? ORDER BY created_at DESC,rowid DESC').all(owner(ownerId));return values.map(schemeView);
  }
  function setEnabled({ownerId,id,enabled}){
    if(typeof enabled!=='boolean')reject(400,'invalid_enabled','启用状态无效');owned(ownerId,id);
    q('UPDATE screening_scheme SET enabled=?,updated_at=? WHERE id=?').run(Number(enabled),clock(),id);return schemeView(row(id));
  }
  function getRun(id){return identifier(id)?runView(q('SELECT * FROM screening_scheme_run WHERE id=?').get(id),true):null;}
  function latestRun(schemeId){return runView(q("SELECT * FROM screening_scheme_run WHERE scheme_id=? AND status='complete' ORDER BY day DESC,started_at DESC,rowid DESC LIMIT 1").get(schemeId),true);}
  function beginRun({schemeId,revision,day:sourceDay,generation,sourceId,asOf,engineVersion,patternVersion,kind}){
    if(!row(schemeId)||!Number.isSafeInteger(revision)||revision<1||!version(schemeId,revision))reject(404,'scheme_version_not_found','找不到该方案版本');
    day(sourceDay);timestamp(asOf);for(const value of [generation,sourceId,engineVersion,patternVersion,kind])text(value,'运行来源',160);
    return transaction(()=>{
      const completed=q("SELECT * FROM screening_scheme_run WHERE scheme_id=? AND revision=? AND day=? AND source_id=? AND engine_version=? AND pattern_version=? AND status='complete'").get(schemeId,revision,sourceDay,sourceId,engineVersion,patternVersion);
      if(completed)return {skipped:true,run:runView(completed,true)};
      const previous=q("SELECT day FROM screening_scheme_run WHERE scheme_id=? AND revision=? AND status='complete' ORDER BY day DESC LIMIT 1").get(schemeId,revision);
      if(previous&&sourceDay<previous.day)reject(409,'data_day_regression','数据日不能回退');
      if(q("SELECT id FROM screening_scheme_run WHERE scheme_id=? AND revision=? AND day=? AND status='running'").get(schemeId,revision,sourceDay))reject(409,'run_in_progress','该方案当日任务正在运行');
      const id=randomUUID();q("INSERT INTO screening_scheme_run(id,scheme_id,revision,day,generation,source_id,as_of,engine_version,pattern_version,kind,status,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,'running',?)").run(id,schemeId,revision,sourceDay,generation,sourceId,asOf,engineVersion,patternVersion,kind,clock());return getRun(id);
    });
  }
  function writeTrack(episode){
    const encoded=encode(episode,{derived:true});
    if(!identifier(episode.id)||!row(episode.schemeId)||!Number.isSafeInteger(episode.revision)||!version(episode.schemeId,episode.revision)||!stockCode.test(episode.code))reject(400,'invalid_track','跟踪记录归属无效');
    text(episode.name,'股票名称',100);day(episode.entryDay);timestamp(episode.knownAt);
    const entered=identifier(episode.enteredRunId)?q('SELECT scheme_id,revision,day FROM screening_scheme_run WHERE id=?').get(episode.enteredRunId):null;
    if(!entered||entered.scheme_id!==episode.schemeId||entered.revision!==episode.revision||entered.day!==episode.entryDay)reject(400,'invalid_track','入选运行记录不一致');
    if(episode.exitDay!==null&&(day(episode.exitDay)<episode.entryDay))reject(400,'invalid_track','退出日期无效');
    if(!episode.observations||typeof episode.observations!=='object'||Array.isArray(episode.observations)||Object.keys(episode.observations).some(key=>!['1','3','5','10','20'].includes(key)))reject(400,'invalid_track','后续观察窗口无效');
    const previous=q('SELECT episode_json FROM screening_scheme_track WHERE id=?').get(episode.id);
    if(previous){
      const old=parse(previous.episode_json);
      for(const key of ['schemeId','revision','code','entryDay','knownAt','enteredRunId'])if(old[key]!==episode[key])reject(409,'track_identity_conflict','不能改写跟踪记录起点');
      if(old.exitDay!==null&&old.exitDay!==episode.exitDay)reject(409,'track_exit_conflict','不能改写已确认退出日期');
      for(const [horizon,observation]of Object.entries(old.observations))if(['ready','not_observable'].includes(observation.status)&&!isDeepStrictEqual(observation,episode.observations[horizon]))reject(409,'observation_final','不能改写已完成的后续观察');
    }
    q('INSERT INTO screening_scheme_track VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET episode_json=excluded.episode_json,updated_at=excluded.updated_at').run(episode.id,episode.schemeId,episode.revision,episode.code,episode.entryDay,encoded,clock());
    return parse(encoded);
  }
  function updateTracks(values){if(!Array.isArray(values))reject(400,'invalid_tracks','跟踪记录须为数组');return transaction(()=>values.map(writeTrack));}
  function finishRun({runId,records,summary,tracks=[]}){
    if(!Array.isArray(records)||!Array.isArray(tracks))reject(400,'invalid_result','运行记录须为数组');const recordsJson=encode(records,{derived:true}),summaryJson=encode(summary,{derived:true});
    return transaction(()=>{
      const run=getRun(runId);if(!run)reject(404,'run_not_found','找不到运行记录');if(run.status==='complete')return run;if(run.status!=='running')reject(409,'run_not_running','运行已经结束');
      for(const episode of tracks){if(episode.schemeId!==run.schemeId)reject(400,'invalid_track','跟踪记录不属于当前方案');writeTrack(episode);}
      q("UPDATE screening_scheme_run SET status='complete',finished_at=?,records_json=?,summary_json=?,error=NULL WHERE id=?").run(clock(),recordsJson,summaryJson,runId);return getRun(runId);
    });
  }
  function failRun(runId,error){
    const run=getRun(runId);if(!run)reject(404,'run_not_found','找不到运行记录');if(run.status!=='running')return run;
    const message=String(typeof error==='string'?error:error?.message||'scheme_run_failed').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,1000)||'scheme_run_failed';
    q("UPDATE screening_scheme_run SET status='error',finished_at=?,error=? WHERE id=?").run(clock(),message,runId);return getRun(runId);
  }
  function updateProgress(runId,{stage,checked,total}){
    text(stage,'运行阶段',80);if(!Number.isSafeInteger(checked)||!Number.isSafeInteger(total)||checked<0||total<checked||total>6000)reject(400,'invalid_progress','运行进度无效');
    const run=getRun(runId);if(!run)reject(404,'run_not_found','找不到运行记录');if(run.status!=='running')return run;
    q("UPDATE screening_scheme_run SET summary_json=? WHERE id=? AND status='running'").run(JSON.stringify({...run.summary,stage,checked,total}),runId);return getRun(runId);
  }
  return {save,list,get:id=>schemeView(row(id)),setEnabled,beginRun,finishRun,failRun,updateProgress,latestRun,runs:schemeId=>q('SELECT '+runSummaryColumns+' FROM screening_scheme_run WHERE scheme_id=? ORDER BY started_at DESC,rowid DESC LIMIT 30').all(schemeId).map(value=>runView(value)),getRun,tracks:(schemeId,{revision}={})=>(revision===undefined?q('SELECT episode_json FROM screening_scheme_track WHERE scheme_id=? ORDER BY entry_day DESC,id').all(schemeId):q('SELECT episode_json FROM screening_scheme_track WHERE scheme_id=? AND revision=? ORDER BY entry_day DESC,id').all(schemeId,revision)).map(value=>parse(value.episode_json)),updateTracks};
}
