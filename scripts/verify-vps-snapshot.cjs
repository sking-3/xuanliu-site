'use strict';
const {createHash}=require('node:crypto');
const {setTimeout:sleep}=require('node:timers/promises');
const {paths}=require('./approve-research-publication.cjs');
const origin='https://45-77-39-98.sslip.io';
async function verify({snapshotPath,digest,fetchImpl=fetch,now=Date.now,wait=sleep,timeout=420000}={}){
 if(!paths.includes(snapshotPath)||!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid snapshot verification input');
 const deadline=now()+timeout;let attempt=0,lastError='No published response';
 while(now()<deadline){
  attempt++;
  const response=await fetchImpl(origin+'/'+snapshotPath+'?verify='+digest+'-'+attempt,{redirect:'error',headers:{'Cache-Control':'no-cache','Accept-Encoding':'identity'},signal:AbortSignal.timeout(15000)}).catch(()=>null);
  if(response&&[401,403,418,429].includes(response.status))throw Error('Formal site refused verification: HTTP '+response.status);
  if(response?.ok&&response.body){
   const hash=createHash('sha256');let bytes=0;
   for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>2*1024*1024)throw Error('Formal snapshot exceeds size limit');hash.update(chunk);}
   const actual=hash.digest('hex');
   if(actual===digest)return {snapshotPath,digest,verifiedAt:new Date(now()).toISOString(),attempts:attempt};
   lastError='Formal snapshot digest differs from the approved snapshot';
  }else lastError=response?'Formal site HTTP '+response.status:'Formal site connection unavailable';
  const left=deadline-now();if(left>0)await wait(Math.min(10000,left));
 }
 throw Error(lastError+'; publication verification timed out');
}
if(require.main===module){
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=='--path'||args[2]!=='--digest'){console.error('Usage: verify-vps-snapshot.cjs --path <snapshot> --digest <sha256>');process.exitCode=1;}
 else verify({snapshotPath:args[1],digest:args[3]}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={verify};
