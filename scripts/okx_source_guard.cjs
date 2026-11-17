'use strict';
// A source rejection is durable: neither scheduled collector retries it automatically.
const fs=require('node:fs/promises');
const path=require('node:path');
const location=path.resolve(__dirname,'../trader/okx/source-stop.json');
function error(status){const e=Error('OKX source stopped after HTTP '+status);e.code='OKX_SOURCE_STOPPED';return e;}
async function check(file=location){
  try {const raw=JSON.parse(await fs.readFile(file,'utf8'));throw error(raw.httpStatus||'unknown');}
  catch(e){if(e.code==='ENOENT')return;throw e;}
}
async function stop(status,file=location){
  if(status!==403&&status!==429)throw Error('invalid OKX stop status');
  await fs.mkdir(path.dirname(file),{recursive:true});
  try {await fs.writeFile(file,JSON.stringify({source:'OKX',status:'stopped',reason:'HTTP '+status,at:new Date().toISOString(),httpStatus:status})+'\n',{flag:'wx'});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  throw error(status);
}
module.exports={check,stop,error};
