'use strict';
// A source rejection is durable: neither scheduled collector retries it automatically.
const fs=require('node:fs/promises');
const path=require('node:path');
const location=path.resolve(__dirname,'../trader/okx/source-stop.json');
const httpStops=new Set([401,403,418,429,451]);
const apiStops=new Set(['50011','50040']);
const stopFile=()=>process.env.BOOKS_OKX_SOURCE_STOP_FILE||location;
const isHttpStop=status=>httpStops.has(status);
const isApiStop=code=>apiStops.has(code);
function reason(status,apiCode){return isApiStop(apiCode)?'API '+apiCode:'HTTP '+(isHttpStop(status)?status:'unknown');}
function error(status,apiCode){
  const e=Error('OKX source stopped after '+reason(status,apiCode));
  e.code='OKX_SOURCE_STOPPED';
  if(isApiStop(apiCode))e.apiCode=apiCode;
  return e;
}
async function check(file=stopFile()){
  try {const raw=JSON.parse(await fs.readFile(file,'utf8'));throw error(raw?.httpStatus,raw?.apiCode);}
  catch(e){if(e.code==='ENOENT')return;throw e;}
}
async function stop(status,file=stopFile(),apiCode){
  if(!isHttpStop(status)&&!(status===200&&isApiStop(apiCode)))throw Error('invalid OKX stop status');
  const failure=error(status,apiCode);
  const record={source:'OKX',status:'stopped',reason:reason(status,apiCode),at:new Date().toISOString(),httpStatus:status};
  if(isApiStop(apiCode))record.apiCode=apiCode;
  try {
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,JSON.stringify(record)+'\n',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  }catch(e){
    failure.message+=' (stop record could not be written)';
    failure.cause=e;
  }
  throw failure;
}
module.exports={check,stop,error,isHttpStop,isApiStop};
