// Fixed, public market-data collection for the static research page.
// No account credentials, private archives, order routes or dynamic source URLs.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runResearch,METHOD_VERSION} from './engine.mjs';

export const DAY=86400000;
export const SOURCE=Object.freeze({name:'Kraken public OHLC',symbol:'BTC/USD',url:'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440',documentation:'https://docs.kraken.com/api-reference/market-data/get-ohlc-data'});
const MAX_BYTES=2000000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const error=(code,message)=>Object.assign(new Error(message),{code});
const validDate=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const iso=ms=>new Date(ms).toISOString();

function validateBars(input,now){
  if(!Array.isArray(input)||input.length<300||input.length>720)throw error('invalid_data','已收盘日线数量不足或超出来源限制');
  const keys=['time','open','high','low','close','volume'];
  for(let i=0;i<input.length;i++){
    const b=input[i];
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).join(',')!==keys.join(',')||!keys.every(k=>typeof b[k]==='number'&&Number.isFinite(b[k])))throw error('invalid_data','日线字段无效');
    if(!Number.isSafeInteger(b.time)||b.time<0||b.time%DAY!==0||b.time+DAY>now||b.open<=0||b.high<=0||b.low<=0||b.close<=0||b.volume<0||b.high<Math.max(b.open,b.close,b.low)||b.low>Math.min(b.open,b.close,b.high))throw error('invalid_data','日线价格或收盘时间无效');
    if(i&&b.time-input[i-1].time!==DAY)throw error('invalid_data','日线重复、乱序或存在缺口');
  }
  return input;
}

export function decodeKraken(payload,now=Date.now()){
  if(!payload||!Array.isArray(payload.error))throw error('invalid_data','来源响应格式无效');
  if(payload.error.length){if(payload.error.some(x=>typeof x==='string'&&/rate limit|permission|denied|forbidden/i.test(x)))throw error('source_stopped','来源拒绝访问或请求受限，已停止自动采集');throw error('source_error','来源返回错误');}
  const rows=payload.result?.XXBTZUSD;
  if(!Array.isArray(rows)||rows.length<301||rows.length>721)throw error('invalid_data','来源返回日线数量无效');
  // Kraken documents its final entry as the still-forming interval.
  const bars=rows.slice(0,-1).map(r=>{
    if(!Array.isArray(r)||r.length<8)throw error('invalid_data','来源日线格式无效');
    if([0,1,2,3,4,6].some(i=>!['number','string'].includes(typeof r[i])||String(r[i]).trim()===''))throw error('invalid_data','来源日线字段缺失');
    return {time:Number(r[0])*1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[6])};
  });
  return validateBars(bars,now);
}

function validatePrevious(record,now){
  if(!record||record.schemaVersion!==1||!record.source||Object.keys(SOURCE).some(k=>record.source[k]!==SOURCE[k])||!['ready','stale','stopped','blocked','error'].includes(record.status))throw error('invalid_archive','已有公开研究档案格式无效，未覆盖');
  if(record.lastAttempt!==null&&!validDate(record.lastAttempt))throw error('invalid_archive','已有记录时间无效，未覆盖');
  const present=record.bars!==null||record.report!==null||record.dataHash!==null||record.reportHash!==null;
  if(!present){if(record.bars!==null||record.report!==null||record.dataHash!==null||record.reportHash!==null||record.retrievedAt!==null||record.latestClosedAt!==null||record.runAt!==null||record.status==='ready')throw error('invalid_archive','已有空记录不一致，未覆盖');return record;}
  try{validateBars(record.bars,now);}catch{throw error('invalid_archive','已有日线无效，未覆盖');}
  if(!validDate(record.retrievedAt)||!validDate(record.latestClosedAt)||!validDate(record.runAt)||Date.parse(record.retrievedAt)>now||Date.parse(record.runAt)>now||record.latestClosedAt!==iso(record.bars.at(-1).time+DAY)||record.dataHash!==digest(JSON.stringify(record.bars))||record.reportHash!==digest(JSON.stringify(record.report))||record.report?.data?.suppliedSha256!==record.dataHash||record.report?.methodVersion!==METHOD_VERSION)throw error('invalid_archive','已有数据、报告或时间未通过核对，未覆盖');
  return record;
}
async function boundedText(response){
  if(Number(response.headers.get('content-length'))>MAX_BYTES)throw error('source_too_large','来源响应超过大小限制');
  if(!response.body)throw error('invalid_data','来源响应为空');
  const reader=response.body.getReader(),chunks=[];let length=0;
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_BYTES){await reader.cancel();throw error('source_too_large','来源响应超过大小限制');}chunks.push(value);}
  return Buffer.concat(chunks).toString('utf8');
}
async function atomicJSON(file,value){
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(tmp,JSON.stringify(value)+'\n',{flag:'wx'});await rename(tmp,file);}finally{await unlink(tmp).catch(()=>{});}
}
const empty=()=>({schemaVersion:1,source:SOURCE,retrievedAt:null,latestClosedAt:null,dataHash:null,bars:null,report:null,reportHash:null,runAt:null,status:'error',lastAttempt:null,error:null});

// Pass a fixture fetch in tests; normal invocation always uses the fixed public URL.
export async function collectPublic({outputDir,fetchImpl=fetch,now=Date.now,refreshNow=false}={}){
  if(typeof outputDir!=='string'||!outputDir)throw new TypeError('outputDir required');
  const time=now();if(!Number.isFinite(time))throw new TypeError('invalid time');
  await mkdir(outputDir,{recursive:true});const file=path.join(outputDir,'latest.json');let previous;
  try{previous=validatePrevious(JSON.parse(await readFile(file,'utf8')),time);}catch(e){if(e.code==='ENOENT')previous=empty();else if(e.code==='invalid_archive')throw e;else throw error('invalid_archive','已有公开研究档案无法读取，未覆盖');}
  // The stop is persisted in the published state and does not silently reset on a new runner.
  if(previous.status==='stopped'||previous.status==='blocked')return previous;
  // Scheduled runs, manual dispatches and UI-only pushes share the last attempt.
  if(!refreshNow&&previous.lastAttempt&&time<Date.parse(previous.lastAttempt)+DAY)return previous;
  const lastAttempt=iso(time);
  try{
    let response;
    try{response=await fetchImpl(SOURCE.url,{method:'GET',headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw error('source_unavailable','来源暂时无法连接');}
    if(response.status===403||response.status===429)throw error('source_stopped','来源拒绝访问或请求受限，已停止自动采集');
    if(!response.ok)throw error('source_error','来源返回 HTTP '+response.status);
    const raw=await boundedText(response);let payload;try{payload=JSON.parse(raw);}catch{throw error('invalid_data','来源响应不是有效 JSON');}
    const retrievedAt=iso(now()),bars=decodeKraken(payload,Date.parse(retrievedAt)),latestClosedAt=iso(bars.at(-1).time+DAY);
    if(previous.latestClosedAt&&latestClosedAt<previous.latestClosedAt)throw error('older_source','来源数据早于已保存的记录');
    const dataHash=digest(JSON.stringify(bars));
    const report=runResearch(bars,{feeBps:10,slippageBps:5,intervalMs:DAY,dataHash,source:SOURCE.name,snapshotId:dataHash});
    const result={schemaVersion:1,source:SOURCE,retrievedAt,latestClosedAt,dataHash,bars,report,reportHash:digest(JSON.stringify(report)),runAt:iso(now()),status:'ready',lastAttempt,error:null,rawHash:digest(raw)};
    await atomicJSON(file,result);return result;
  }catch(e){
    const stopped=e.code==='source_stopped',status=stopped?'stopped':previous.bars?'stale':'error';
    const next={...previous,status,lastAttempt,error:{code:e.code||'run_failed',message:e.code?e.message:'研究计算失败',at:iso(now())}};
    await atomicJSON(file,next);return next;
  }
}
async function main(){
  const args=process.argv.slice(2);if(![2,3].includes(args.length)||args[0]!=='--output-dir'||args.length===3&&args[2]!=='--refresh-now')throw new Error('Usage: node collect-public.mjs --output-dir <directory> [--refresh-now]');
  const result=await collectPublic({outputDir:path.resolve(args[1]),refreshNow:args.length===3});
  process.stdout.write(JSON.stringify({status:result.status,lastAttempt:result.lastAttempt,latestClosedAt:result.latestClosedAt,error:result.error?.code||null})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{process.stderr.write((e.code||'error')+': '+e.message+'\n');process.exitCode=1;});
