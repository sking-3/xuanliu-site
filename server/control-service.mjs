import {createHash, randomUUID} from 'node:crypto';

const PREFIX='/api/research-control';
const MAX_DATASET_BYTES=24*1024*1024, MAX_CONFIG_BYTES=256*1024;
const runningStatuses=new Set(['queued','running']);
const parse=value=>value==null?null:JSON.parse(value);
const encode=value=>JSON.stringify(value);
const clone=value=>parse(encode(value));
const revision=value=>Number.isSafeInteger(value)&&value>=0;
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
class ControlError extends Error{
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
const reject=(status,code,message)=>{throw new ControlError(status,code,message);};

/** Authenticated archive replay only. No external source, executable input or timer schedule. */
export function createControlService({db,model,engine,now=Date.now,schedule=fn=>setImmediate(fn)}){
  if(!db||!model?.normalizeConfig||!model?.normalizeDataset||!model?.evaluateDataset)throw Error('control_service_dependencies');
  const engineVersion=String(model.engineVersion||model.ENGINE_VERSION||'unknown');
  const clock=()=>new Date(now()).toISOString();
  const jobs=new Map();let closed=false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_control_heads (
      owner_id TEXT PRIMARY KEY,current_revision INTEGER NOT NULL DEFAULT 0,
      active_revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS research_control_versions (
      owner_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,
      kind TEXT NOT NULL,source_revision INTEGER,config_json TEXT NOT NULL,
      engine_version TEXT NOT NULL,PRIMARY KEY(owner_id,revision)
    );
    CREATE TABLE IF NOT EXISTS research_control_datasets (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,
      sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,dataset_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,UNIQUE(owner_id,sha256)
    );
    CREATE TABLE IF NOT EXISTS research_control_runs (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL,dataset_id TEXT NOT NULL,
      status TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,
      progress_json TEXT,result_json TEXT,settings_json TEXT NOT NULL,engine_version TEXT NOT NULL,
      error_code TEXT,stop_requested INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS research_control_one_running_owner
      ON research_control_runs(owner_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS research_control_audit (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,event TEXT NOT NULL,created_at TEXT NOT NULL,
      revision INTEGER,detail_json TEXT NOT NULL
    );
  `);
  db.prepare(`UPDATE research_control_runs SET status='interrupted',finished_at=?,error_code='process_restart'
    WHERE status IN ('queued','running')`).run(clock());
  const q=sql=>db.prepare(sql);
  function transaction(fn){
    db.exec('BEGIN IMMEDIATE');
    try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}
  }
  const audit=(owner,event,rev,detail={})=>q('INSERT INTO research_control_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),owner,event,clock(),rev,encode(detail));
  function head(owner){return q('SELECT * FROM research_control_heads WHERE owner_id=?').get(owner)||{current_revision:0,active_revision:0};}
  function ensureHead(owner){q('INSERT OR IGNORE INTO research_control_heads VALUES (?,0,0,?)').run(owner,clock());return head(owner);}
  function version(owner,rev){return q('SELECT * FROM research_control_versions WHERE owner_id=? AND revision=?').get(owner,rev);}
  function settings(owner,rev){
    if(rev===0)return model.normalizeConfig(clone(model.DEFAULT_CONFIG));
    const row=version(owner,rev);if(!row)reject(404,'version_not_found','找不到该配置版本。');return parse(row.config_json);
  }
  const versionView=row=>({revision:row.revision,createdAt:row.created_at,kind:row.kind,sourceRevision:row.source_revision,engineVersion:row.engine_version,config:parse(row.config_json)});
  const datasetView=row=>({id:row.id,createdAt:row.created_at,hash:row.sha256,byteLength:row.byte_length,summary:parse(row.summary_json)});
  const runView=(row,full=false)=>({id:row.id,revision:row.revision,datasetId:row.dataset_id,status:row.status,
    createdAt:row.created_at,startedAt:row.started_at,finishedAt:row.finished_at,progress:parse(row.progress_json),
    engineVersion:row.engine_version,error:row.error_code,stopRequested:!!row.stop_requested,
    ...(full?{result:parse(row.result_json),settings:parse(row.settings_json)}:{})});
  function ownedRun(owner,id){const row=q('SELECT * FROM research_control_runs WHERE owner_id=? AND id=?').get(owner,id);if(!row)reject(404,'run_not_found','找不到该运行记录。');return row;}
  function normalizeConfig(value){try{return model.normalizeConfig(value);}catch{reject(400,'invalid_config','配置格式或参数不正确。');}}
  function appendVersion(owner,config,kind,sourceRevision,expected,activate=false){
    return transaction(()=>{
      const current=ensureHead(owner);
      if(current.current_revision!==expected)reject(409,'revision_conflict','配置已变化，请刷新后再保存。');
      const next=expected+1;if(!revision(next))reject(409,'revision_limit','配置版本已达到上限。');
      q('INSERT INTO research_control_versions VALUES (?,?,?,?,?,?,?)').run(owner,next,clock(),kind,sourceRevision,encode(config),engineVersion);
      q('UPDATE research_control_heads SET current_revision=?,active_revision=?,updated_at=? WHERE owner_id=?').run(next,activate?next:current.active_revision,clock(),owner);
      audit(owner,kind,next,{sourceRevision});return {revision:next,currentRevision:next,activeRevision:activate?next:current.active_revision,config};
    });
  }
  function failJob(job,errorCode){
    if(closed)return;
    const row=q('SELECT * FROM research_control_runs WHERE owner_id=? AND id=?').get(job.owner,job.id);
    if(!row||!runningStatuses.has(row.status))return;
    const stopped=job.stop;
    const result=stopped?{status:'stopped',reason:'运行已停止，保留最后实际进度。',diagnostics:{lastProgress:parse(row.progress_json)}}:null;
    q('UPDATE research_control_runs SET status=?,finished_at=?,error_code=?,result_json=? WHERE owner_id=? AND id=?').run(stopped?'stopped':'error',clock(),stopped?null:errorCode,result?encode(result):null,job.owner,job.id);
  }
  async function execute(job){
    if(closed)return;
    try{
      let row=ownedRun(job.owner,job.id);if(row.status!=='queued')return;
      q("UPDATE research_control_runs SET status='running',started_at=? WHERE owner_id=? AND id=? AND status='queued'").run(clock(),job.owner,job.id);
      row=ownedRun(job.owner,job.id);
      const data=q('SELECT dataset_json FROM research_control_datasets WHERE owner_id=? AND id=?').get(job.owner,row.dataset_id);
      if(!data)throw Error('dataset_missing');
      const onProgress=value=>{
        if(closed)return;
        const progress=encode(value);
        if(typeof progress!=='string'||Buffer.byteLength(progress)>MAX_CONFIG_BYTES)throw Error('invalid_progress');
        q("UPDATE research_control_runs SET progress_json=? WHERE owner_id=? AND id=? AND status='running'").run(progress,job.owner,job.id);
      };
      const result=await model.evaluateDataset(parse(data.dataset_json),parse(row.settings_json),engine,{onProgress,shouldStop:()=>closed||job.stop});
      if(closed)return;
      const latest=ownedRun(job.owner,job.id);if(!runningStatuses.has(latest.status))return;
      const status=job.stop?'stopped':['complete','unavailable','stopped'].includes(result?.status)?result.status:'error';
      const storedResult=result&&typeof result==='object'?{...result,status}:null;
      q('UPDATE research_control_runs SET status=?,finished_at=?,result_json=?,error_code=? WHERE owner_id=? AND id=?').run(status,clock(),storedResult?encode(storedResult):null,status==='error'?'invalid_result':null,job.owner,job.id);
      audit(job.owner,'run_finished',row.revision,{runId:job.id,status});
    }catch{failJob(job,'evaluation_failed');}
    finally{if(jobs.get(job.owner)===job)jobs.delete(job.owner);}
  }
  async function handle(req,res,ctx){
    const {user,path,readJson,json}=ctx;
    if(typeof path!=='string'||!(path===PREFIX||path.startsWith(PREFIX+'/')))return false;
    const reply=(status,body)=>json(res,status,body);
    if(!user||user.role!=='admin'||user.status!=='active'||!identifier(user.id)){reply(403,{error:'admin_required',message:'仅活动管理员可使用研究控制台。'});return true;}
    if(closed){reply(503,{error:'service_closed',message:'研究服务已停止。'});return true;}
    const owner=user.id,method=req.method||'GET',route=path.slice(PREFIX.length);
    try{
      const url=ctx.url instanceof URL?ctx.url:new URL(ctx.url||req.url||path,'http://localhost');
      if(method==='GET'&&route==='/state'){
        const current=head(owner),versions=q('SELECT * FROM research_control_versions WHERE owner_id=? ORDER BY revision DESC LIMIT 20').all(owner),
          datasets=q('SELECT * FROM research_control_datasets WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(owner),
          runs=q('SELECT * FROM research_control_runs WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(owner),
          live=q("SELECT * FROM research_control_runs WHERE owner_id=? AND status IN ('queued','running') LIMIT 1").get(owner);
        reply(200,{capabilities:{archiveReplay:true,liveCollection:false,scheduler:false},engineVersion,
          currentRevision:current.current_revision,activeRevision:current.active_revision,config:settings(owner,current.current_revision),
          activeConfig:current.active_revision?settings(owner,current.active_revision):null,
          versions:versions.map(versionView),datasets:datasets.map(datasetView),runs:runs.map(row=>runView(row)),job:live?runView(live):null});return true;
      }
      if(method==='GET'&&route==='/datasets'){
        const id=url.searchParams.get('id');if(!identifier(id))reject(400,'invalid_dataset_id','请选择有效数据集。');
        const row=q('SELECT * FROM research_control_datasets WHERE owner_id=? AND id=?').get(owner,id);if(!row)reject(404,'dataset_not_found','找不到该数据集。');
        reply(200,{...datasetView(row),dataset:parse(row.dataset_json)});return true;
      }
      if(method==='GET'&&(route==='/runs'||route==='/export')){
        const id=url.searchParams.get('id');if(!identifier(id))reject(400,'invalid_run_id','请选择有效运行记录。');reply(200,runView(ownedRun(owner,id),true));return true;
      }
      if(method!=='POST'||!['/config','/activate','/rollback','/datasets','/run','/stop'].includes(route)){reply(404,{error:'not_found',message:'找不到该研究操作。'});return true;}
      const limit=route==='/datasets'?MAX_DATASET_BYTES:MAX_CONFIG_BYTES;
      const body=await readJson(req,limit);
      if(!body||typeof body!=='object'||Array.isArray(body))reject(400,'invalid_body','请求内容必须为JSON对象。');
      if(Buffer.byteLength(encode(body))>limit)reject(413,'body_too_large','上传内容超过大小限制。');
      if(route==='/config'){
        if(!revision(body.expectedRevision))reject(400,'invalid_revision','请提供当前配置版本。');
        reply(201,appendVersion(owner,normalizeConfig(body.config),'config_saved',null,body.expectedRevision));return true;
      }
      if(route==='/activate'){
        if(!revision(body.revision)||body.revision<1||!revision(body.expectedActiveRevision))reject(400,'invalid_revision','请提供配置版本和当前生效版本。');
        const result=transaction(()=>{const current=ensureHead(owner);if(current.active_revision!==body.expectedActiveRevision)reject(409,'active_revision_conflict','生效版本已变化，请刷新后重试。');
          if(!version(owner,body.revision))reject(404,'version_not_found','找不到该配置版本。');
          q('UPDATE research_control_heads SET active_revision=?,updated_at=? WHERE owner_id=?').run(body.revision,clock(),owner);audit(owner,'config_activated',body.revision);
          return {currentRevision:current.current_revision,activeRevision:body.revision};});reply(200,result);return true;
      }
      if(route==='/rollback'){
        if(!revision(body.revision)||body.revision<1||!revision(body.expectedRevision))reject(400,'invalid_revision','请提供回滚目标和当前配置版本。');
        const config=settings(owner,body.revision);reply(201,appendVersion(owner,config,'config_rollback',body.revision,body.expectedRevision,true));return true;
      }
      if(route==='/datasets'){
        let dataset;try{dataset=model.normalizeDataset(body.dataset);}catch{reject(400,'invalid_dataset','归档数据格式或来源时间不正确。');}
        const raw=encode(dataset),bytes=Buffer.byteLength(raw);if(bytes>MAX_DATASET_BYTES)reject(413,'dataset_too_large','归档数据超过24MiB限制。');
        const hash=createHash('sha256').update(raw).digest('hex');
        const result=transaction(()=>{const existing=q('SELECT * FROM research_control_datasets WHERE owner_id=? AND sha256=?').get(owner,hash);if(existing)return {row:existing,deduplicated:true};
          const id=randomUUID(),summary={day:dataset.day||null,asOf:dataset.asOf||dataset.source?.asOf||null,
            records:Array.isArray(dataset.records)?dataset.records.length:null,expectedCount:dataset.expectedCount??null,totalUniverseCount:dataset.totalUniverseCount??null};
          q('INSERT INTO research_control_datasets VALUES (?,?,?,?,?,?,?)').run(id,owner,clock(),hash,bytes,raw,encode(summary));audit(owner,'dataset_imported',null,{datasetId:id,hash,bytes});return {row:q('SELECT * FROM research_control_datasets WHERE owner_id=? AND id=?').get(owner,id),deduplicated:false};});
        reply(result.deduplicated?200:201,{...datasetView(result.row),deduplicated:result.deduplicated});return true;
      }
      if(route==='/run'){
        if(!identifier(body.datasetId)||!revision(body.revision))reject(400,'invalid_run','请选择数据集和配置版本。');
        const id=randomUUID(),result=transaction(()=>{
          if(q("SELECT id FROM research_control_runs WHERE owner_id=? AND status IN ('queued','running')").get(owner))reject(409,'already_running','已有运行中的任务，请先停止或等待完成。');
          if(!q('SELECT id FROM research_control_datasets WHERE owner_id=? AND id=?').get(owner,body.datasetId))reject(404,'dataset_not_found','找不到该数据集。');
          const config=settings(owner,body.revision);
          q("INSERT INTO research_control_runs (id,owner_id,revision,dataset_id,status,created_at,settings_json,engine_version) VALUES (?,?,?,?,'queued',?,?,?)").run(id,owner,body.revision,body.datasetId,clock(),encode(config),engineVersion);
          audit(owner,'run_queued',body.revision,{runId:id,datasetId:body.datasetId});return ownedRun(owner,id);
        });
        const job={id,owner,stop:false};jobs.set(owner,job);
        try{schedule(()=>execute(job));}catch{jobs.delete(owner);failJob(job,'schedule_failed');reject(503,'schedule_failed','任务暂时无法启动。');}
        reply(202,{run:runView(result)});return true;
      }
      if(route==='/stop'){
        if(!identifier(body.runId))reject(400,'invalid_run_id','请选择有效运行记录。');
        const row=ownedRun(owner,body.runId),job=jobs.get(owner);
        if(runningStatuses.has(row.status)){
          if(job?.id===row.id)job.stop=true;
          q('UPDATE research_control_runs SET stop_requested=1 WHERE owner_id=? AND id=?').run(owner,row.id);
          if(row.status==='queued')q("UPDATE research_control_runs SET status='stopped',finished_at=? WHERE owner_id=? AND id=? AND status='queued'").run(clock(),owner,row.id);
          audit(owner,'run_stop_requested',row.revision,{runId:row.id});
        }
        reply(200,{run:runView(ownedRun(owner,row.id))});return true;
      }
    }catch(error){
      if(error instanceof ControlError)reply(error.status,{error:error.code,message:error.message});
      else if(error?.status===413||error?.statusCode===413)reply(413,{error:'body_too_large',message:'上传内容超过大小限制。'});
      else if(error instanceof SyntaxError||error?.status===400||error?.statusCode===400)reply(400,{error:'invalid_json',message:'请求不是有效JSON。'});
      else reply(500,{error:'control_operation_failed',message:'研究操作未完成，请刷新状态后重试。'});
    }
    return true;
  }
  function close(){
    if(closed)return;closed=true;
    for(const job of jobs.values()){
      job.stop=true;
      q("UPDATE research_control_runs SET status='interrupted',finished_at=?,error_code='service_closed' WHERE owner_id=? AND id=? AND status IN ('queued','running')").run(clock(),job.owner,job.id);
    }
    jobs.clear();
  }
  return {handle,close};
}
