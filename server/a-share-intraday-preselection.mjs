import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {openStore,createGuard} from './a-share-daily.mjs';
import {readStoredJson} from './a-share-retention.mjs';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {writeIntradayCharts} from './a-share-intraday-chart.mjs';
import {closeCandidateVersion} from './a-share-entry-current.mjs';

const require=createRequire(import.meta.url);
export const sourceId='tencent-public-stock-quotes-v1',version='books.a-share.a14.2026-11-25.v1',directoryName='intraday-preselection-v1';
export const schedule='交易日14:00:30采集小名单，14:03与14:07补查；拒绝访问后停止，最多20只，不扫描全市场';
const stamp=now=>new Date(now()).toISOString(),finite=value=>Number.isFinite(value)&&value>0;
const same=(a,b)=>['generation','sourceId','day','asOf'].every(key=>a?.[key]===b?.[key]);
async function optional(file){try{return await readStoredJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function save(file,value){const body=JSON.stringify(value);await writeFile(file+'.tmp',body);await rename(file+'.tmp',file);await writeFile(file+'.gz.tmp',gzipSync(body));await rename(file+'.gz.tmp',file+'.gz');}

function validateCapture(report,{day,batch,parents,checked,completed}){
 const from=Date.parse(day+'T14:00:00+08:00'),until=Date.parse(day+'T14:10:00+08:00'),computed=Date.parse(report?.computedAt),generated=Number(String(report?.generation).slice(day.length+1)),expected=new Map(parents.map(row=>[row.code,row])),seen=new Set();
 if(report?.schema!=='books.a-share.opportunity-workbench.v1'||report.version!=='books.a-share.opportunity-tracking.2026-11-25.v1'||report.phase!=='a14'||report.completed!==completed||report.datasetBound!==true||report.sourceId!==sourceId||report.day!==day||!new RegExp('^'+day+'-\\d+$').test(report.generation||'')||!Number.isSafeInteger(generated)||generated<from||generated>computed||report.historyGeneration!==batch.generation||report.historySourceId!==batch.sourceId||report.marketContext?.historyDay!==batch.day||!Number.isFinite(computed)||computed<from||computed>until||computed>checked||!Array.isArray(report.current)||!Array.isArray(report.missing)||!Array.isArray(report.tracks)||report.summary?.shortlistCount!==parents.length||report.current.length+report.missing.length!==parents.length||report.tracks.length!==report.current.length)throw Error('14:00归档身份、历史批次或采集窗口无效');
 for(const row of report.current){
  const parent=expected.get(row.code),quoted=Date.parse(row.quoteSourceAt),received=Date.parse(row.receivedAt),id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);
  if(!parent||seen.has(row.code)||row.id!==id||row.familyId!=='entry-confirmation-16'||row.ruleVersion!==version||row.setupId!==parent.setupId||!isDeepStrictEqual(row.ruleIds,parent.patternIds)||!['generation','sourceId','day'].every(key=>row[key]===report[key])||row.historyGeneration!==batch.generation||row.historySourceId!==batch.sourceId||row.phase!=='a14'||row.anchorDay!==day||row.basisDay!==batch.day||!['watch','near_B','triggered_B'].includes(row.state)||row.qualified!==false||row.qualification!=='unqualified_observation'||row.actualFillVerified!==false||!Number.isFinite(quoted)||!Number.isFinite(received)||quoted<from||quoted>until||received<quoted||received>until||received-quoted>120000||received>computed||Date.parse(row.asOf)!==quoted||row.sourceFetchedAt!==row.receivedAt||row.actualDiscoveryAt!==row.receivedAt||row.conditionKnownAfter!==row.receivedAt||row.firstSeenAt!==row.receivedAt||Date.parse(row.activeUntil)!==Date.parse(day+'T15:00:00+08:00')||!finite(row.basisClose)||!finite(row.quotePrevClose)||Math.abs(row.basisClose-row.quotePrevClose)>.011||!finite(row.reference?.close)||row.reference.trigger!==parent.trigger.above||row.reference.invalidation!==parent.invalidation.below)throw Error('14:00归档证券、报价时点或参考位绑定无效');
  const distance=(row.reference.close/row.reference.trigger-1)*100,state=row.reference.close>row.reference.trigger?'triggered_B':distance>=-2?'near_B':'watch';
  if(row.state!==state||row.distanceToTriggerPct!==distance||row.reference.close<row.reference.invalidation||row.reference.close>row.reference.trigger*1.02)throw Error('14:00归档状态与原价格条件不符');
  for(const window of [60,120])if(row.chartUrls?.[window]!=='/api/a-share-daily/a14-chart?'+new URLSearchParams({day,code:row.code,window:String(window)}))throw Error('14:00归档图表身份无效');
  const track=report.tracks.find(track=>track.id===row.id);if(!track||track.firstSeenAt!==row.firstSeenAt||!isDeepStrictEqual(track.original,row)||!isDeepStrictEqual(track.observations,row.observations))throw Error('14:00归档首次观察记录已改变');seen.add(row.code);
 }
 for(const row of report.missing){if(!expected.has(row.code)||seen.has(row.code)||typeof row.reason!=='string'||!row.reason||typeof row.retryable!=='boolean')throw Error('14:00待补证券记录无效');seen.add(row.code);}
 const asOf=report.current.length?Math.min(...report.current.map(row=>Date.parse(row.asOf))):computed;
 if(Date.parse(report.asOf)!==asOf||report.summary.candidateCount!==report.current.length||report.summary.missingCount!==report.missing.length||report.summary.qualifiedCount!==0)throw Error('14:00归档汇总或来源时间无效');
}

function captureReport({day,batch,generation,current,missing,parents,now,completed}){
 return {schema:'books.a-share.opportunity-workbench.v1',version:'books.a-share.opportunity-tracking.2026-11-25.v1',phase:'a14',completed,datasetBound:true,generation,sourceId,historyGeneration:batch.generation,historySourceId:batch.sourceId,day,asOf:current.length?current.reduce((min,row)=>row.asOf<min?row.asOf:min,current[0].asOf):stamp(now),computedAt:stamp(now),current,tracks:current.map(row=>({id:row.id,firstSeenAt:row.firstSeenAt,original:structuredClone(row),observations:structuredClone(row.observations)})),summary:{candidateCount:current.length,shortlistCount:parents.length,missingCount:missing.length,qualifiedCount:0},missing,marketContext:{status:'not_recomputed_intraday',historyDay:batch.day},method:{lastBar:'unclosed_at_actual_quote_time',maxSymbols:20,firstSeen:'first_actual_capture_not_backfilled',actualFillVerified:false,...(completed&&missing.some(row=>row.retryable)?{partial:true,reason:'14:07最后补查后仍有报价未就绪；仅发布实际捕获记录，缺项另列。'}:{})}};
}

export function parseTencentQuotes(body,requested){
 const rows=new Map();
 for(const match of body.matchAll(/v_((?:sh|sz)\d{6})="([^"\r\n]*)";/g)){
  if(!requested.includes(match[1])||rows.has(match[1]))throw Error('报价证券身份或重复行无效');
  const fields=match[2].split('~'),symbol=match[1],code=symbol.slice(2)+'.'+(symbol.startsWith('sh')?'SH':'SZ'),clock=fields[30];
  if(fields.length<35||fields[2]!==symbol.slice(2)||!/^\d{14}$/.test(clock||''))throw Error('报价格式或时刻无效');
  const quote={code,name:fields[1],price:Number(fields[3]),prevClose:Number(fields[4]),open:Number(fields[5]),high:Number(fields[33]),low:Number(fields[34]),sourceAt:clock.slice(0,4)+'-'+clock.slice(4,6)+'-'+clock.slice(6,8)+'T'+clock.slice(8,10)+':'+clock.slice(10,12)+':'+clock.slice(12,14)+'+08:00'};
  if(!['price','prevClose','open','high','low'].every(key=>finite(quote[key]))||quote.high<Math.max(quote.price,quote.open)||quote.low>Math.min(quote.price,quote.open))throw Error('报价开高低收无效');rows.set(symbol,quote);
 }
 if(requested.some(symbol=>!rows.has(symbol)))throw Error('报价缺少请求的证券');return rows;
}

export function recheckIntradayCandidate({parent,source,reference,quote,day,receivedAt,historyGeneration}){
 if(!/^(?:60\d{4}\.SH|00\d{4}\.SZ)$/.test(parent.code)||/^(?:S?\*?ST)|退/i.test(quote.name.replace(/\s/g,'')))return {accepted:false,reason:'不属于已核对的沪深主板普通股'};
 if(parent.stage!=='waiting_breakout'||parent.remainingSessions<1||source.status!=='ready'||source.adjustment!=='qfq'||source.day!==parent.day||quote.code!==parent.code||source.bars.at(-1)?.date!==parent.day||!finite(quote.prevClose)||Math.abs(source.bars.at(-1).close-quote.prevClose)>.011)return {accepted:false,reason:'历史参考位到期或前收与归档日线基准不一致'};
 const received=Date.parse(receivedAt),quoted=Date.parse(quote.sourceAt),from=Date.parse(day+'T14:00:00+08:00'),until=Date.parse(day+'T14:10:00+08:00');
 if(![received,quoted].every(Number.isFinite)||quoted<from||quoted>until||received<quoted||received>until||received-quoted>120000)return {accepted:false,reason:'未取得14:00时段内的新鲜报价',retryable:true};
 if(reference?.code!=='000300.SH'||reference.bars?.at(-1)?.date!==source.day)return {accepted:false,reason:'缺少同批真实交易日日历'};
 const byDay=new Map(source.bars.map(bar=>[bar.date,bar])),aligned=[];
 for(let i=reference.bars.length-1;i>=0;i--){const bar=byDay.get(reference.bars[i].date);if(!bar||!['open','high','low','close','volume'].every(key=>finite(bar[key]))||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close))break;aligned.unshift(bar);}
 if(aligned.length<21)return {accepted:false,reason:'最近20个真实交易日有缺失、停牌或无有效成交'};
 const trigger=parent.trigger.above,invalidation=parent.invalidation.below,prices=aligned.map(bar=>bar.close).concat(quote.price),last=prices.length-1,mean20=prices.slice(-20).reduce((sum,value)=>sum+value,0)/20;
 if(quote.low<invalidation||quote.open>trigger*1.02||quote.price>trigger*1.02||(quote.price/prices[last-5]-1)*100>8||(quote.price/prices[last-20]-1)*100>15||(quote.price/mean20-1)*100>8)return {accepted:false,reason:'条件失效、跳空追高或已明显拉升'};
 const distance=(quote.price/trigger-1)*100,state=quote.price>trigger?'triggered_B':distance>=-2?'near_B':'watch';
 const row={code:parent.code,name:parent.name,familyId:'entry-confirmation-16',ruleVersion:version,setupId:parent.setupId,ruleIds:parent.patternIds.slice(),anchorDay:day,phase:'a14',state,qualified:false,qualification:'unqualified_observation',
  generation:day+'-'+received,sourceId,historySourceId:source.sourceId,historyGeneration,day,asOf:new Date(quoted).toISOString(),sourceFetchedAt:receivedAt,actualDiscoveryAt:receivedAt,conditionKnownAfter:receivedAt,activeUntil:day+'T15:00:00+08:00',firstSeenAt:receivedAt,
  basisDay:source.day,basisClose:source.bars.at(-1).close,quotePrevClose:quote.prevClose,quoteSourceAt:new Date(quoted).toISOString(),receivedAt,
  reference:{close:quote.price,trigger,invalidation},distanceToTriggerPct:distance,strategy:'trend',chartUrls:{},observations:{},reasons:['14:00时段真实报价重新核验，最后一根日K未收盘','盘中量尚未核实；仅确认价格条件，不提升原有验证资格'],research:{rules:[],institutionalEvidence:null},actualFillVerified:false};
 row.id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);return {accepted:true,row,bars:aligned.concat({date:day,open:quote.open,high:quote.high,low:quote.low,close:quote.price,volume:null})};
}

export async function collectIntradayPreselection({dir,siteDir,fetch:request=globalThis.fetch,now=Date.now,wait,calendar}={}){
 calendar||=require(join(siteDir,'market-calendar.js'));const local=calendar.clock('CN',now()),session=local&&calendar.session('CN',local.date),root=join(dir,directoryName);await mkdir(root,{recursive:true});
 const previous=await optional(join(root,'current.json')),attempt={status:'closed',day:local?.date||null,startedAt:stamp(now),finishedAt:null,requests:0,error:null};let db;
 if(!session?.verified||!session.open||local.time<'140000'||local.time>'141000'){attempt.finishedAt=stamp(now);await save(join(root,'status.json'),attempt);return {attempt,lastSuccess:previous};}
 const day=local.date,target=join(root,'days',day),saved=await optional(join(target,'report.json'));
 try{
  const batch=await readStoredJson(join(dir,'current.json')),latest=calendar.latestClosed('CN',now()),complete=await readStoredJson(join(dir,'generations',batch.generation,'complete.json'));
  if(batch.day!==latest?.date||batch.day>=day||!complete.completed||complete.fullMarket!==true||batch.total<1000||!same(complete,batch)||batch.ready/batch.total<.8)throw Error('盘中预选缺少最近完整收盘批次');
  const entry=await readStoredJson(join(dir,'generations',batch.generation,'entry-current-v2/report.json'));
  if(!entry.completed||entry.datasetBound!==true||entry.schema!=='books.a-share.entry-current.v1'||entry.version!==closeCandidateVersion||complete.closeCandidateVersion!==entry.version||!same(entry,batch))throw Error('盘中预选参考位与已完成批次不一致');
  const parents=[...new Map(entry.current.filter(row=>row.stage==='waiting_breakout'&&row.remainingSessions>0).sort((a,b)=>Math.abs(a.distanceToTriggerPct)-Math.abs(b.distanceToTriggerPct)).map(row=>[row.code,row])).values()].slice(0,20),wanted=new Set(parents.map(row=>row.code)),sources=new Map();
  if(saved){
   validateCapture(saved,{day,batch,parents,checked:now(),completed:true});
   await save(join(root,'current.json'),saved);attempt.status='no_new_snapshot';attempt.finishedAt=stamp(now);await save(join(root,'status.json'),attempt);return {attempt,lastSuccess:saved};
  }
  const pending=await optional(join(target,'pending.json'));if(pending)validateCapture(pending,{day,batch,parents,checked:now(),completed:false});
  const current=pending?.current||[],missing=new Map((pending?.missing||parents.map(row=>({code:row.code,reason:'尚未完成本轮报价读取',retryable:true}))).map(row=>[row.code,row])),generation=pending?.generation||day+'-'+now(),retry=parents.filter(row=>missing.get(row.code)?.retryable);
  let header=true,reference;
  for await(const line of readHistoryLines(join(dir,'private','generations',batch.generation,'history-all.ndjson'))){
   if(header){const data=JSON.parse(line);if(data.schema!=='books.a-share.history.v1'||!same(data,batch)||data.total!==batch.total||data.historyRequested!==500||data.reference?.code!=='000300.SH'||data.reference.bars?.at(-1)?.date!==batch.day)throw Error('盘中参考历史头与收盘批次不符');reference=data.reference;header=false;continue;}
   const match=/"code":"(\d{6}\.(?:SH|SZ))"/.exec(line);if(match&&wanted.has(match[1])){const row=JSON.parse(line);if(row.stock?.code===match[1]){const fetched=Date.parse(row.source.fetchedAt);if(sources.has(row.stock.code)||row.source.sourceId!==batch.sourceId||row.source.day!==batch.day||!Number.isFinite(fetched)||fetched<Date.parse(batch.asOf)||fetched>now())throw Error('盘中参考历史身份、读取时点或重复行无效');sources.set(row.stock.code,row.source);}}
  }
  db=openStore(join(dir,'collector.sqlite'));const guarded=createGuard({db,fetch:request,now,wait,sourceId,interval:6500,onRequest:()=>attempt.requests++});await mkdir(target,{recursive:true});
  for(let offset=0;offset<retry.length;offset+=5){
   const group=retry.slice(offset,offset+5),symbols=group.map(row=>(row.code.endsWith('SH')?'sh':'sz')+row.code.slice(0,6)),response=await guarded('https://qt.gtimg.cn/q='+symbols.join(','));
   if(!response.ok)throw Error('公开报价 HTTP '+response.status);
   const quotes=parseTencentQuotes(new TextDecoder('gb18030').decode(await response.arrayBuffer()),symbols),receivedAt=stamp(now);
   await save(join(target,'private-quotes-'+Date.parse(receivedAt)+'-'+offset+'.json'),{sourceId,receivedAt,quotes:[...quotes.values()]});
   for(const parent of group){const source=sources.get(parent.code);if(!source){missing.set(parent.code,{code:parent.code,reason:'归档日线缺失',retryable:false});continue;}const quote=quotes.get((parent.code.endsWith('SH')?'sh':'sz')+parent.code.slice(0,6)),result=recheckIntradayCandidate({parent,source,reference,quote,day,receivedAt,historyGeneration:batch.generation});
    if(!result.accepted){missing.set(parent.code,{code:parent.code,reason:result.reason,retryable:result.retryable===true});continue;}
    result.row.generation=generation;
    for(const window of [60,120])result.row.chartUrls[window]='/api/a-share-daily/a14-chart?'+new URLSearchParams({day,code:parent.code,window:String(window)});
    await writeIntradayCharts({directory:join(target,'charts'),row:result.row,bars:result.bars});current.push(result.row);missing.delete(parent.code);
   }
   await save(join(target,'pending.json'),captureReport({day,batch,generation,current,missing:[...missing.values()],parents,now,completed:false}));
  }
  const outstanding=[...missing.values()],waiting=outstanding.some(row=>row.retryable),lastCheck=now()>=Date.parse(day+'T14:07:00+08:00');
  const report=captureReport({day,batch,generation,current,missing:outstanding,parents,now,completed:!waiting||lastCheck&&current.length>0});
  validateCapture(report,{day,batch,parents,checked:now(),completed:report.completed});
  if(!report.completed){attempt.status='waiting_source';attempt.error=current.length?'已保存实际捕获记录，未更新报价的缺项等待下次补查。':'报价尚未更新到14:00时段，等待下次定时补查。';attempt.finishedAt=stamp(now);await save(join(target,'pending.json'),report);await save(join(root,'status.json'),attempt);return {attempt,lastSuccess:previous};}
  await save(join(target,'report.json'),report);await save(join(root,'current.json'),report);attempt.status='complete';attempt.finishedAt=stamp(now);await save(join(root,'status.json'),attempt);return {attempt,lastSuccess:report};
 }catch(error){const held=db?.prepare('SELECT value FROM settings WHERE key=?').get('source-hold:'+sourceId);attempt.status=held?'held':'failed';attempt.error=error.message;attempt.finishedAt=stamp(now);await save(join(root,'status.json'),attempt);return {attempt,lastSuccess:previous};}
 finally{db?.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))collectIntradayPreselection({dir:process.env.BOOKS_A_SHARE_DIR,siteDir:process.env.BOOKS_SITE_DIR}).then(result=>{console.log(JSON.stringify({attempt:result.attempt,summary:result.lastSuccess?.summary}));if(result.attempt.status==='failed')process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});
