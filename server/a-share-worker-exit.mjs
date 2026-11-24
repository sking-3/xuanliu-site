import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** systemd runs this after a fatal worker exit, including failures JS cannot catch. */
export function workerExitState(state,{serviceResult='',exitCode='',exitStatus='',now=Date.now}={}){
  if(serviceResult==='success')return state;
  const failed=Boolean(serviceResult||exitCode&&exitCode!=='exited'||exitStatus&&exitStatus!=='0');
  if(!failed||state?.attempt?.status!=='running')return state;
  const error='采集进程异常退出：SERVICE_RESULT='+(serviceResult||'未提供')+'；EXIT_CODE='+(exitCode||'未提供')+'；EXIT_STATUS='+(exitStatus||'未提供')+'。';
  return {...state,attempt:{...state.attempt,status:'failed',finishedAt:new Date(now()).toISOString(),error}};
}

export async function recordWorkerExit({dir,...exit}={}){
  const file=join(dir,'status.json');let body;
  try{body=await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return {updated:false,reason:'status_missing'};throw error;}
  const state=JSON.parse(body),next=workerExitState(state,exit);
  if(next===state)return {updated:false,reason:'unchanged'};
  const temporary=file+'.exit-'+process.pid+'.tmp';
  try{await writeFile(temporary,JSON.stringify(next));await rename(temporary,file);}
  finally{try{await unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return {updated:true};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  recordWorkerExit({dir:process.env.BOOKS_A_SHARE_DIR||'/var/lib/books/a-share-daily',serviceResult:process.env.SERVICE_RESULT||'',exitCode:process.env.EXIT_CODE||'',exitStatus:process.env.EXIT_STATUS||''})
    .then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
