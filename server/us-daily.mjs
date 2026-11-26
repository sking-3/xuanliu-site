import {mkdir,readFile,writeFile,rename,open,unlink,stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {gzipSync,gunzipSync,createGzip} from 'node:zlib';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {createTickflowUSSource,dataPolicy,sourceId} from './us-tickflow.mjs';
import {analyzeStock,buildSelection,latestSession,validBars} from './us-selection-engine.mjs';
import {sectorBenchmark,observeSectorPrice,evaluateSectorValue} from './us-sector-value.mjs';

const require=createRequire(import.meta.url),defaultSite=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const SCHEDULE='按America/New_York交易日历收盘后定时检查；具体时刻由timer安排，数据完成按批次校验；失败保留上次完成结果';
async function optionalJson(file){try{const buffer=await readFile(file);return JSON.parse(file.endsWith('.gz')?gunzipSync(buffer):buffer.toString());}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function atomicJson(file,value){const temp=file+'.tmp';await writeFile(temp,file.endsWith('.gz')?gzipSync(JSON.stringify(value),{level:6}):JSON.stringify(value));await rename(temp,file);}
export async function readState(directory){return await optionalJson(join(directory,'state.json'))||{schema:'books.us.selection.state.v1',status:'not_started',message:'美股盘后任务尚未完成',schedule:SCHEDULE};}
export async function readPublished(directory){
 const pointer=await optionalJson(join(directory,'published.json'));if(!pointer)return null;
 const snapshot=await optionalJson(join(directory,pointer.snapshot));if(snapshot?.schema!=='books.us.selection.v1'||snapshot.asOf!==pointer.asOf)throw Error('US completed snapshot pointer does not bind to its batch');
 return snapshot;
}
export function sourcePolicyAllowed(source){return source?.collectionAllowed===true&&source.analysisAllowed===true&&source.permissionsVerified===true&&!/^nasdaq/i.test(source.id||'')&&!/nasdaq\.com/i.test(source.url||'');}
async function cachedProvider(directory,pointer,snapshot){
 if(snapshot?.source?.id!==sourceId)throw Error('Cached US batch is not from the permitted TickFlow source');
 const listed=await optionalJson(join(directory,'batches',pointer.generation,'universe.json.gz'));
 if(listed?.sourceId!==sourceId||!Array.isArray(listed.universe)||!listed.universe.length)throw Error('Cached US universe is missing or does not bind to TickFlow');
 const unavailable=new Set((snapshot.short?.diagnostics||[]).map(row=>row.symbol));
 const reference=await optionalJson(join(directory,'raw/history/SPY.json.gz'));
 if(reference?.sourceId!==sourceId||!validBars(reference.bars)||reference.bars.at(-1).date!==pointer.asOf)throw Error('Cached SPY history is not from the completed target session');
 const dates=reference.bars.slice(-61).map(bar=>bar.date);
 return {async universe(){return listed;},async history(stocks,target){
  if(target.date!==pointer.asOf)throw Error('Cached US target session changed');const result=new Map();
  for(const stock of stocks){
   const saved=await optionalJson(join(directory,'raw/history',encodeURIComponent(stock.symbol)+'.json.gz'));
   if(saved&&saved.sourceId!==sourceId)throw Error('Cached US history source mismatch: '+stock.symbol);
   const bars=(saved?.bars||[]).slice(-500);
   if(!unavailable.has(stock.symbol)&&(!validBars(bars)||bars.at(-1)?.date!==target.date||JSON.stringify(bars.slice(-61).map(bar=>bar.date))!==JSON.stringify(dates)))throw Error('Cached US history is stale/incomplete: '+stock.symbol);
   result.set(stock.symbol,{bars,fetchedAt:saved?.fetchedAt||snapshot.source.fetchedAt,reason:unavailable.has(stock.symbol)?'保留上次完成批次的缺数据诊断':null,sourceBarTime:stock.symbol==='SPY'?snapshot.source.sourceBarTime||null:null});
  }
  return result;
 }};
}
export async function runDaily(options={}){
 const directory=resolve(options.directory||process.env.BOOKS_US_SELECTION_DIR||'/var/lib/books/us-selection'),now=options.now||Date.now,wait=options.wait||sleep;
 const calendar=options.calendar||require(join(process.env.BOOKS_SITE_DIR||defaultSite,'market-calendar.js'));
 await mkdir(directory,{recursive:true});const oldState=await readState(directory);
 let lock;const lockFile=join(directory,'worker.lock');
 try{lock=await open(lockFile,'wx');}catch(error){
  if(error.code!=='EEXIST')throw error;const pid=Number(await readFile(lockFile,'utf8'));if(!Number.isInteger(pid)||pid<1)return {status:'already_running'};
  try{process.kill(pid,0);return {status:'already_running'};}catch(aliveError){if(aliveError.code!=='ESRCH')return {status:'already_running'};}
  await unlink(lockFile);try{lock=await open(lockFile,'wx');}catch(recoveredError){if(recoveredError.code==='EEXIST')return {status:'already_running'};throw recoveredError;}
 }
 await lock.writeFile(String(process.pid));
 let changes,output,state={...oldState,schema:'books.us.selection.state.v1',startedAt:new Date(now()).toISOString(),schedule:SCHEDULE,processed:0,expected:0,requests:0,phase:null,error:null,lastFailure:oldState.error?{error:oldState.error,failedAt:oldState.failedAt}:oldState.lastFailure||null};
 const progress=async patch=>{Object.assign(state,patch,{updatedAt:new Date(now()).toISOString()});await atomicJson(join(directory,'state.json'),state);options.onProgress?.(state);};
 try{
  const pointer=await optionalJson(join(directory,'published.json')),previousSnapshot=pointer?await readPublished(directory):null;
  if(previousSnapshot){
   const {scope,short,asOf}=previousSnapshot;
   Object.assign(state,{covered:scope.covered,missing:scope.expected-scope.covered,candidates:short.rows.length,countsAsOf:asOf,countsBasis:'last_completed_batch',lastCompletedCounts:{asOf,expected:scope.expected,covered:scope.covered,missing:scope.expected-scope.covered,candidates:short.rows.length}});
  }
  if(oldState.sourceHold){await progress({status:'source_blocked',message:'来源此前拒绝访问，已停止自动请求',error:oldState.sourceHold.reason});return state;}
  if(!sourcePolicyAllowed(options.sourcePolicy||dataPolicy)){await progress({status:'source_pending',message:'来源读取与分析授权待核；本轮不采集，保留上次完成结果'});return state;}
  const target=latestSession(calendar,now()),session=calendar.session('US',target.date);state.targetDate=target.date;
  if(now()<Date.parse(target.closeTime)+30*60000){await progress({status:'waiting_source',message:'等待收盘30分钟及来源盘后更新'});return state;}
  if(options.fromCache&&(!pointer||pointer.asOf!==target.date))throw Error('Cached recomputation requires the completed pointer to match the latest closed US session');
  if(pointer?.asOf===target.date&&!options.force&&!options.fromCache){await progress({status:'idle',message:'最新已收盘批次已完成',lastSuccess:pointer});return state;}
  const generation=new Date(now()).toISOString().replace(/[:.]/g,'-'),batchName='batches/'+generation,batchDir=join(directory,batchName);
  await mkdir(batchDir,{recursive:true});await mkdir(join(directory,'raw/history'),{recursive:true});
  state.generation=generation;let previousRequest=0;
  const request=async(url,init={})=>{
   options.signal?.throwIfAborted();
   const delay=Math.max(0,previousRequest+3500-now());if(delay)await wait(delay);previousRequest=now();
   const response=await (options.fetch||fetch)(url,{...init,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000),redirect:'error'});state.requests++;
   if([401,403,418,429,451].includes(response.status)){state.sourceHold={reason:'HTTP '+response.status,httpStatus:response.status,stoppedAt:new Date(now()).toISOString(),retryAfter:response.headers.get('retry-after')};throw Error('来源拒绝访问 HTTP '+response.status+'；停止，不自动重试');}
   return response;
  };
  const provider=options.fromCache?await cachedProvider(directory,pointer,previousSnapshot):options.provider||createTickflowUSSource({request,now});
  state.collectionMode=options.fromCache?'from_cache':'tickflow_collection';
  await progress({status:'collecting',phase:'universe',covered:0,missing:0,candidates:0,countsAsOf:target.date,countsBasis:'current_collection',message:'读取来源美股目录'});
  const listed=await provider.universe();await atomicJson(join(batchDir,'universe.json.gz'),{...listed,sourceId});
  const {universe,scope}=listed;if(!universe.length)throw Error('来源美股目录筛后为空');state.expected=universe.length;
  const previousLedger=pointer?await optionalJson(join(directory,pointer.ledger)):null;
  const tracked=new Set((previousLedger?.records||[]).filter(r=>!r.followup||r.followup.elapsedSessions<=15).map(r=>r.symbol));
  output=createWriteStream(join(batchDir,'changes.jsonl.gz'));changes=createGzip({level:6});changes.pipe(output);
  async function archive(symbol,bars,fetchedAt){
   const file=join(directory,'raw/history',encodeURIComponent(symbol)+'.json.gz'),previous=await optionalJson(file),existing=new Map((previous?.bars||[]).map(b=>[b.date,b]));
   const revised=[];for(const bar of bars)if(JSON.stringify(existing.get(bar.date))!==JSON.stringify(bar)){revised.push(bar);existing.set(bar.date,bar);}
   if(revised.length){
    const line=JSON.stringify({symbol,sourceId,asOf:target.date,fetchedAt,bars:revised})+'\n';if(!changes.write(line))await once(changes,'drain');
    await atomicJson(file,{symbol,sourceId,fetchedAt,bars:[...existing.values()].sort((a,b)=>a.date.localeCompare(b.date))});
   }
  }
  const benchmarkStocks=['SPY','QQQ'].map(symbol=>({symbol,providerSymbol:symbol+'.US'})),referenceResult=await provider.history(benchmarkStocks,{...target,close:session.close}),benchmarks={};
  for(const symbol of ['SPY','QQQ']){const result=referenceResult.get(symbol);benchmarks[symbol]=result?.bars||[];await archive(symbol,benchmarks[symbol],result?.fetchedAt);}
  const reference=benchmarks.SPY;if(reference.length<201||reference.at(-1).date!==target.date||benchmarks.QQQ.length<201||benchmarks.QQQ.at(-1).date!==target.date)throw Error('SPY/QQQ尚未返回目标收盘日及201根历史；本轮不发布');
  const industryReference=sectorBenchmark(reference,target.date),industryPrices=new Map();
  const rows=[],diagnostics=[],series={},prices={},coverageMetrics={covered:0,aboveMA20:0};let fetchedAt=referenceResult.get('QQQ').fetchedAt;
  for(let offset=0;offset<universe.length;offset+=50){
   options.signal?.throwIfAborted();
   const stocks=universe.slice(offset,offset+50),result=await provider.history(stocks,{...target,close:session.close});
   for(const stock of stocks){
    const received=result.get(stock.symbol);if(!received)throw Error('美股批次响应缺少请求结果');
    if(received.fetchedAt>fetchedAt)fetchedAt=received.fetchedAt;await archive(stock.symbol,received.bars,fetchedAt);
    const analyzed=analyzeStock(stock,received.bars,reference,target.date,dataPolicy);
    if(analyzed.diagnostic)diagnostics.push(analyzed.diagnostic);else{coverageMetrics.covered++;if(analyzed.aboveMA20)coverageMetrics.aboveMA20++;if(analyzed.row)rows.push(analyzed.row);}
    if(analyzed.row||tracked.has(stock.symbol))series[stock.symbol]=received.bars;
    const industryPrice=observeSectorPrice(received.bars,industryReference);
    if(industryPrice)industryPrices.set(stock.symbol,industryPrice);
    const last=received.bars.at(-1);if(last?.date===target.date&&last.close>0)prices[stock.symbol]={close:last.close,asOf:target.closeTime,sourceDate:target.date,sourceId,permissionsVerified:dataPolicy.permissionsVerified,derivedPublic:dataPolicy.derivedPublic,accessScope:dataPolicy.accessScope,turnover20:industryPrice?received.bars.slice(-20).reduce((sum,bar)=>sum+bar.close*bar.volume,0)/20:null};
   }
   await progress({phase:'daily_bars',processed:Math.min(offset+50,universe.length),covered:coverageMetrics.covered,missing:diagnostics.length,candidates:rows.length,message:'采集并计算日线 '+Math.min(offset+50,universe.length)+'/'+universe.length});
  }
  // Recently tracked delisted/removed symbols retain their records and are not assumed to have exited on missing data.
  for(const symbol of tracked)if(!series[symbol]){const stored=await optionalJson(join(directory,'raw/history',encodeURIComponent(symbol)+'.json.gz'));series[symbol]=stored?.bars||[];diagnostics.push({symbol,reason:'不在当前来源名册，后续行情待核'});}
  changes.end();await finished(output);changes=null;output=null;
  await progress({status:'computing',phase:'tracking',message:'更新首次观察后的交易日跟踪'});
  const source={...dataPolicy,sourceTime:target.closeTime,sourceTimeKind:'scheduled_regular_close',providerPublishedAt:null,sourceBarTime:referenceResult.get('SPY').sourceBarTime||null,fetchedAt,dataAsOf:target.date,coverage:'provider_listed_equity_pool',volumeNote:'US成交量按来源股数；amount为0时用收盘价×成交量作代理，不冒充实际成交额',rawArchive:'private_incremental_gzip',collectionMode:state.collectionMode};
  const {snapshot,ledger}=buildSelection({asOf:target.date,universe,series,benchmarks,scope,source,screenedRows:rows,coverageMetrics,diagnostics},{previousLedger,previousSnapshot,now:now()});
  if(options.fromCache)snapshot.recomputedFrom={generation:pointer.generation,asOf:pointer.asOf,sourceId:previousSnapshot.source.id,previousRulesVersion:previousSnapshot.version};
  const enrich=options.enrich||(await import('./us-fundamentals.mjs')).collectFundamentals;
  if(enrich){await progress({phase:'fundamentals',message:'核对公开财报与估值'});Object.assign(snapshot,await enrich({directory,universe,prices,asOf:target.date,now,onProgress:async update=>{await progress({fundamentalsProgress:update,message:typeof update==='string'?update:'核对公开财报与估值'});},fetch:options.fetch||fetch}));}
  if(snapshot.fundamentals){
   await progress({phase:'fundamentals',message:'核对产业低谷及同行估值'});
   const latest=snapshot.fundamentals,previous=previousSnapshot?.fundamentals;
   if(latest.scope?.expansionFailed&&previous?.scope?.basis==='sec_exchange_listing_and_report_industry'){
    snapshot.fundamentals={...previous,status:'partial',scope:{...previous.scope,stale:true,expansionFailure:latest.scope.expansionFailure},lastAttemptAt:latest.lastAttemptAt,failures:latest.failures};
   }else{
    snapshot.fundamentals=evaluateSectorValue(latest,{priceObservations:industryPrices,benchmark:industryReference,asOf:target.date,source});
   }
  }
  state.fundamentalsStatus=snapshot.fundamentals?.status||'not_configured';state.dcaStatus=snapshot.dca?.status||'not_configured';
  const failures=[...(snapshot.fundamentals?.failures||[]),...(snapshot.dca?.failures||[])];
  state.fundamentalsFailures=failures.filter((failure,index)=>failures.findIndex(item=>item.source===failure.source&&item.symbol===failure.symbol&&item.reason===failure.reason)===index).map(({source,symbol,reason})=>({source:source||null,symbol:symbol||null,reason:reason||'来源失败'}));
  state.warning=state.fundamentalsStatus==='ready'&&state.dcaStatus==='ready'?null:'短线收盘结果已完成；基本面或长期候选仍有缺项，详见来源失败原因';
  snapshot.generatedAt=new Date(now()).toISOString();
  await atomicJson(join(batchDir,'snapshot.json.gz'),snapshot);await atomicJson(join(batchDir,'ledger.json.gz'),ledger);
  const completed={schema:'books.us.selection.pointer.v1',generation,asOf:target.date,generatedAt:snapshot.generatedAt,snapshot:batchName+'/snapshot.json.gz',ledger:batchName+'/ledger.json.gz'};
  await atomicJson(join(directory,'published.json'),completed);
  await progress({status:'ready',phase:'complete',message:'美股收盘批次已完成',finishedAt:new Date(now()).toISOString(),lastSuccess:completed,error:null,countsAsOf:snapshot.asOf,countsBasis:'last_completed_batch',lastCompletedCounts:{asOf:snapshot.asOf,expected:snapshot.scope.expected,covered:snapshot.scope.covered,missing:snapshot.scope.expected-snapshot.scope.covered,candidates:snapshot.short.rows.length}});return state;
 }catch(error){
  if(changes){changes.end();await finished(output).catch(()=>{});}
  await progress({status:state.sourceHold?'source_blocked':'error',message:'本轮未发布，保留上次完成结果',error:error.message,failedAt:new Date(now()).toISOString()});
  if(options.throwOnError)throw error;return state;
 }finally{await lock.close();await unlink(join(directory,'worker.lock'));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const controller=new AbortController();for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort(Error('US worker interrupted by '+signal)));
 const result=await runDaily({signal:controller.signal,force:process.argv.includes('--force'),fromCache:process.argv.includes('--from-cache'),onProgress:state=>process.stdout.write(JSON.stringify({status:state.status,phase:state.phase,processed:state.processed,expected:state.expected,message:state.message})+'\n')});
 if(['error','source_blocked'].includes(result.status))process.exitCode=1;
}
