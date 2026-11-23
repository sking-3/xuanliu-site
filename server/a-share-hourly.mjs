import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createGuard,openStore,INDICES} from './a-share-daily.mjs';
import {runSavedSchemes} from './a-share-scheme-runner.mjs';

const require=createRequire(import.meta.url);
export const sourceId='tickflow-auth-quotes-v1';
export const schedule='交易日 10:05、11:05、13:05、14:05、15:05（北京时间）；每次最多1个请求、3个指数；方案仅使用完整日终批次';
const names={'000300.SH':'沪深300','000001.SH':'上证指数','399001.SZ':'深证成指'};
const endpoint='https://api.tickflow.org/v1/quotes?symbols='+INDICES.join(',');
const maxAge=10*60*1000;
const errors={unconfigured:'未配置 BOOKS_TICKFLOW_API_KEY；小时盘面尚未启用。',closed:'当前不在已核验的盘面采集时段。',stale:'来源行情过期、未前进或时段不符；保留上次成功盘面。',failed:'小时盘面读取失败；保留上次成功盘面。',hold:'来源访问已暂停；不会自动重试。',schemes:'日终批次暂不可用；保留已完成方案结果。'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
const stamp=now=>new Date(now()).toISOString();
async function json(path){
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
}
async function atomicJson(path,value){await writeFile(path+'.tmp',JSON.stringify(value));await rename(path+'.tmp',path);}

/** Return only validated, derived public fields; never forward provider payloads or arbitrary errors. */
export function publicHourly(value){
  if(!object(value)||value.schema!=='books.a-share.hourly.v1'||value.schedule!==schedule)return null;
  const attempt=value.attempt,last=value.lastSuccess,schemes=value.schemes;
  if(!object(attempt)||!['complete','unconfigured','stale','failed','closed'].includes(attempt.status)||!timestamp(attempt.startedAt)||!timestamp(attempt.finishedAt)||Date.parse(attempt.finishedAt)<Date.parse(attempt.startedAt)||![0,1].includes(attempt.requestCount)||attempt.error!==null&&!Object.values(errors).includes(attempt.error))return null;
  let lastSuccess=null;
  if(last!==null){
    if(!object(last)||last.sourceId!==sourceId||!['asOf','fetchedAt','staleAfter'].every(key=>timestamp(last[key]))||Date.parse(last.asOf)>Date.parse(last.fetchedAt)||Date.parse(last.staleAfter)!==Date.parse(last.asOf)+maxAge||!Array.isArray(last.indices)||last.indices.length!==3)return null;
    const indices=[];
    for(const code of INDICES){
      const rows=last.indices.filter(row=>object(row)&&row.code===code),row=rows[0];
      if(rows.length!==1||row.name!==names[code]||typeof row.changePercent!=='number'||!Number.isFinite(row.changePercent)||!timestamp(row.sourceAt)||Date.parse(row.sourceAt)<Date.parse(last.asOf)||Date.parse(row.sourceAt)>Date.parse(last.fetchedAt))return null;
      indices.push({code,name:names[code],changePercent:row.changePercent,sourceAt:row.sourceAt});
    }
    if(Math.min(...indices.map(row=>Date.parse(row.sourceAt)))!==Date.parse(last.asOf))return null;
    lastSuccess={sourceId,asOf:last.asOf,fetchedAt:last.fetchedAt,staleAfter:last.staleAfter,indices};
  }
  if(!object(schemes)||!['complete','failed'].includes(schemes.status)||!timestamp(schemes.checkedAt)||schemes.error!==null&&schemes.error!==errors.schemes)return null;
  if(schemes.day!==null&&(typeof schemes.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(schemes.day))||schemes.generation!==null&&(typeof schemes.generation!=='string'||!/^[0-9TZ-]{1,80}$/.test(schemes.generation)))return null;
  return {schema:value.schema,schedule,attempt:{status:attempt.status,startedAt:attempt.startedAt,finishedAt:attempt.finishedAt,requestCount:attempt.requestCount,error:attempt.error},lastSuccess,schemes:{status:schemes.status,checkedAt:schemes.checkedAt,day:schemes.day,generation:schemes.generation,error:schemes.error}};
}

function deriveQuotes(payload,calendar,time,previous){
  if(!object(payload)||!Array.isArray(payload.data)||payload.data.length!==3)throw Error('invalid');
  const local=calendar.clock('CN',time),indices=[];
  for(const code of INDICES){
    const rows=payload.data.filter(row=>object(row)&&row.symbol===code),quote=rows[0];
    if(rows.length!==1||quote.region!=='CN'||!Number.isSafeInteger(quote.timestamp)||typeof quote.last_price!=='number'||typeof quote.prev_close!=='number'||!Number.isFinite(quote.last_price)||!Number.isFinite(quote.prev_close)||quote.last_price<=0||quote.prev_close<=0)throw Error('invalid');
    const source=calendar.clock('CN',quote.timestamp),old=previous?.indices.find(row=>row.code===code);
    const close=source?.time==='150000'&&local.time>='150000'&&['regular','closed','after_hours'].includes(quote.session);
    if(!source||source.date!==local.date||quote.timestamp>time||time-quote.timestamp>maxAge||old&&quote.timestamp<=Date.parse(old.sourceAt)||!close&&(!calendar.inSession('CN',source)||quote.session!=='regular'))throw Error('stale');
    const changePercent=(quote.last_price/quote.prev_close-1)*100;
    if(!Number.isFinite(changePercent))throw Error('invalid');
    indices.push({code,name:names[code],changePercent,sourceAt:new Date(quote.timestamp).toISOString()});
  }
  const asOf=Math.min(...indices.map(row=>Date.parse(row.sourceAt)));
  return {sourceId,asOf:new Date(asOf).toISOString(),fetchedAt:new Date(time).toISOString(),staleAfter:new Date(asOf+maxAge).toISOString(),indices};
}

export async function collectHourly({dir,dbFile,siteDir,fetch:request=globalThis.fetch,now=Date.now,apiKey=process.env.BOOKS_TICKFLOW_API_KEY,calendar,runSchemes=runSavedSchemes}={}){
  if(!dir||!dbFile||!siteDir)throw Error('小时任务需要明确的数据库、行情缓存和代码目录');
  await mkdir(dir,{recursive:true});
  const previous=publicHourly(await json(join(dir,'hourly.json')));
  const attempt={status:'failed',startedAt:stamp(now),finishedAt:null,requestCount:0,error:null};
  let lastSuccess=previous?.lastSuccess||null,db;
  try{
    if(!apiKey){attempt.status='unconfigured';attempt.error=errors.unconfigured;}
    else{
      calendar||=require(join(siteDir,'market-calendar.js'));
      const local=calendar.clock('CN',now()),session=local&&calendar.session('CN',local.date);
      const closeWindow=local&&local.time>='150000'&&local.time<='151000';
      if(!session?.verified||!session.open||!calendar.inSession('CN',local)&&!closeWindow){attempt.status='closed';attempt.error=errors.closed;}
      else{
        db=openStore(join(dir,'collector.sqlite'));
        const guarded=createGuard({db,fetch:request,now,sourceId,interval:6000,onRequest:()=>attempt.requestCount++});
        const response=await guarded(endpoint,{method:'GET',headers:{'x-api-key':apiKey}});
        if(!response.ok)throw Error('request');
        const next=deriveQuotes(await response.json(),calendar,now(),lastSuccess);
        lastSuccess=next;attempt.status='complete';
      }
    }
  }catch(error){
    const held=db?.prepare('SELECT value FROM settings WHERE key=?').get('source-hold:'+sourceId);
    attempt.status=error.message==='stale'?'stale':'failed';attempt.error=held?errors.hold:errors[attempt.status];
  }finally{db?.close();}
  let schemes;
  try{
    // The runner reads current.json and its complete private daily generation; quotes never enter it.
    const result=await runSchemes({dir,dbFile,siteDir,now});
    schemes={status:result.status==='complete'?'complete':'failed',checkedAt:stamp(now),day:result.day||null,generation:result.generation||null,error:result.status==='complete'?null:errors.schemes};
  }catch{schemes={status:'failed',checkedAt:stamp(now),day:null,generation:null,error:errors.schemes};}
  attempt.finishedAt=stamp(now);
  const value={schema:'books.a-share.hourly.v1',schedule,attempt,lastSuccess,schemes};
  const archive=join(dir,'hourly',attempt.startedAt.slice(0,10));
  await mkdir(archive,{recursive:true});
  await atomicJson(join(archive,attempt.startedAt.replace(/[:.]/g,'-')+'.json'),value);
  await atomicJson(join(dir,'hourly.json'),value);
  return value;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  collectHourly({dir:process.env.BOOKS_A_SHARE_DIR,dbFile:process.env.BOOKS_DB,siteDir:process.env.BOOKS_SITE_DIR})
    .then(value=>{console.log(JSON.stringify(value));if(value.attempt.status==='failed'||value.schemes.status==='failed')process.exitCode=1;})
    .catch(()=>{console.error('小时盘面任务未能保存状态。');process.exitCode=1;});
}
