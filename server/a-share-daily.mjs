import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, unlink, access, open } from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync,gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import {createTickflowSource,sourceId as tickflowSourceId,dataPolicy as tickflowPolicy,barSchema,hasOHLC,historyCount,diagnoseHistory} from './a-share-tickflow.mjs';
import {precomputePatternStatistics} from './a-share-pattern-precompute.mjs';
import {readTickflowUniverse,universeSchema} from './a-share-universe.mjs';
import {precomputeEntryEvidence} from './a-share-entry-precompute.mjs';
import {entryPolicyVersion} from './a-share-entry-bars.mjs';
import {entryValidationVersion} from './a-share-entry-validation.mjs';
import {signalChartVersion} from './a-share-signal-chart.mjs';
import {precomputeCurrentEntries,rebuildCurrentEntries,currentEntryDirectory} from './a-share-entry-current-precompute.mjs';
import {closeCandidateVersion} from './a-share-entry-current.mjs';
import {assertCollectionSpace,runRetention,readStoredJson} from './a-share-retention.mjs';
import {precomputeViprasolStudy,viprasolStudyDirectory} from './a-share-viprasol-precompute.mjs';
import {version as viprasolStudyVersion,familyId as viprasolFamilyId,sourceCommit as viprasolSourceCommit,definitions as viprasolRules} from './a-share-viprasol-study.mjs';
import {writeViprasolCurrentChart} from './a-share-entry-current-chart.mjs';

const require = createRequire(import.meta.url);
export const MARKET_URL = 'https://raw.githubusercontent.com/wenyuanw/a-share-heatmap/main/src/lib/data/market-heatmap-fallback.json';
export const INDICES = ['000300.SH', '000001.SH', '399001.SZ'];
const INDEX_NAMES = { '000300.SH': '沪深300', '000001.SH': '上证指数', '399001.SZ': '深证成指' };
export const SCHEDULE = '工作日 15:10–23:50（北京时间）每10分钟检查已收盘日线；来源就绪后自动全量采集和计算，未就绪保留上次成功结果';
const legacySourceId='tencent-public-history-v1';
const legacyPolicy={rawPublic:true,derivedPublic:true};

function nextVerifiedSession(calendar,day){
  if(typeof calendar.session!=='function')return null;
  for(let i=1;i<=14;i++){
    const candidate=new Date(Date.parse(day+'T00:00:00Z')+i*86400000).toISOString().slice(0,10),session=calendar.session('CN',candidate);
    if(!session.verified)return null;if(session.open)return candidate;
  }
  return null;
}
function entryKnownAt(db,now,key='entry-policy-known-at:'+entryPolicyVersion){
  const prior=db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if(prior)return prior.value;
  const value=new Date(now()).toISOString();db.prepare('INSERT INTO settings VALUES(?,?)').run(key,value);return value;
}
async function viprasolImplementation(siteDir){
  let build;
  try{build=JSON.parse(await readFile(join(siteDir,'quant-research/viprasol-build.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!build||typeof build!=='object'||Array.isArray(build))throw Error('Viprasol build manifest is malformed');
  return typeof build.implementationCommit==='string'&&/^[a-f0-9]{40}$/.test(build.implementationCommit)?build.implementationCommit:null;
}
const viprasolKnownKey=implementation=>'viprasol-policy-known-at:'+viprasolStudyVersion+':'+(implementation||'unverified');

async function atomicJson(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value));
  await rename(path + '.tmp', path);
}

export function retryAfter(value, now) {
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(until) ? new Date(Math.max(now, until)).toISOString() : null;
}

export function createGuard({ db, fetch: request, now = Date.now, wait = sleep, interval = 1500, signal, sourceId='', onRequest = () => {} }) {
  let previous = null;
  const get = db.prepare('SELECT value FROM settings WHERE key=?');
  const set = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
  return async function guardedFetch(url, options = {}) {
    signal?.throwIfAborted();
    const holdKey=sourceId?'source-hold:'+sourceId:'source-hold';
    const hold = get.get(holdKey);
    if (hold) throw Error('来源访问已暂停：' + JSON.parse(hold.value).reason);
    if (previous !== null) await wait(Math.max(0, previous + interval - now()));
    signal?.throwIfAborted();
    previous = now();
    onRequest();
    const requestSignal = options.signal || AbortSignal.timeout(15000);
    const response = await request(url, { ...options, signal: signal ? AbortSignal.any([signal, requestSignal]) : requestSignal, redirect: 'error' });
    if ([401, 403, 418, 429, 451].includes(response.status)) {
      const record = { reason: 'HTTP ' + response.status, httpStatus: response.status, stoppedAt: new Date(now()).toISOString(), retryAfter: retryAfter(response.headers.get('retry-after'), now()) };
      set.run(holdKey, JSON.stringify(record));
      throw Error('来源拒绝访问：' + record.reason + (record.retryAfter ? '；Retry-After 至 ' + record.retryAfter : '') + '。已停止，不自动重试。');
    }
    return response;
  };
}

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history(day TEXT NOT NULL,code TEXT NOT NULL,as_of TEXT NOT NULL,source_json TEXT NOT NULL,PRIMARY KEY(day,code));
    CREATE TABLE IF NOT EXISTS history_v2(source_id TEXT NOT NULL,day TEXT NOT NULL,code TEXT NOT NULL,as_of TEXT NOT NULL,source_json TEXT NOT NULL,PRIMARY KEY(source_id,day,code,as_of));
    CREATE TABLE IF NOT EXISTS batches_v2(source_id TEXT NOT NULL,day TEXT NOT NULL,as_of TEXT NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(source_id,day));`);
  return db;
}

export async function precompute({ dir, siteDir, snapshot, universe, sources, references, historyRecords,historyFile,day, asOf, startedAt, sourceId=legacySourceId, dataPolicy=legacyPolicy,policyKnownAt=null,viprasolPolicyKnownAt=null,viprasolImplementationCommit,nextSessionDay=null, now = Date.now, onProgress = () => {},signal }) {
  const engine = require(join(siteDir, 'screening/trend-screen.js'));
  const patterns=require(join(siteDir,'screening/trend-patterns.js'));
  const {riskName}=require(join(siteDir,'screening/market-pool.js'));
  const completeOHLC=[...sources.values()].filter(source=>source.status==='ready').every(source=>hasOHLC(source.bars))&&INDICES.every(code=>hasOHLC(references.get(code)?.bars));
  const storedBarSchema=completeOHLC?barSchema:'close-volume-v1';
  const generation = day + '-' + now();
  const target = join(dir, 'generations', generation);
  await mkdir(join(dir,'generations'),{recursive:true});
  await mkdir(target);
  async function save(name, value, location=target) {
    const body = JSON.stringify(value);
    await writeFile(join(location, name + '.json'), body);
    await writeFile(join(location, name + '.json.gz'), gzipSync(body));
  }
  const rawTarget=dataPolicy.rawPublic===false?join(dir,'private','generations',generation):target;
  if(rawTarget!==target)await mkdir(rawTarget,{recursive:true});
  let historyRequested=0,historyGeneration,universePolicy=snapshot?.universePolicy||null;
  if(dataPolicy.rawPublic===false){
    const output=await open(join(rawTarget,'history-all.ndjson'),'wx');
    try{
      if(historyFile){
        let header=true,count=0;
        for await(const line of createInterface({input:createReadStream(historyFile),crlfDelay:Infinity})){
          if(!line)continue;
          if(header){
            const value=JSON.parse(line);
            if(value.schema!=='books.a-share.history.v1'||value.sourceId!==sourceId||value.day!==day||value.asOf!==asOf||value.total!==universe.length)throw Error('长历史归档与重算批次不符');
            historyRequested=value.historyRequested;historyGeneration=value.generation;universePolicy=value.universePolicy;
            await output.write(JSON.stringify({...value,generation})+'\n');header=false;
          }else{await output.write(line+'\n');count++;}
        }
        if(header||count!==universe.length)throw Error('长历史归档记录数不完整');
      }else{
        const reference=references.get('000300.SH');historyRequested=reference.historyRequested||reference.bars.length;
        await output.write(JSON.stringify({schema:'books.a-share.history.v1',generation,sourceId,day,asOf,historyRequested,total:universe.length,universePolicy,reference:{code:'000300.SH',adjustment:'index',bars:reference.bars,fetchedAt:reference.fetchedAt}})+'\n');
        let count=0;
        const rows=historyRecords?historyRecords():universe.map(stock=>({stock,source:sources.get(stock.code)}));
        for await(const row of rows){await output.write(JSON.stringify(row)+'\n');count++;}
        if(count!==universe.length)throw Error('长历史归档记录数不完整');
      }
    }finally{await output.close();}
  }
  // Existing 20/60-day screens retain their bounded input; older suspensions only affect historical windows.
  sources=new Map([...sources].map(([code,source])=>[code,{...source,bars:source.bars?.slice(-61)||[]}]));
  references=new Map([...references].map(([code,source])=>[code,{...source,bars:source.bars.slice(-61)}]));
  if(dataPolicy.rawPublic!==false)await save('market', snapshot);
  const finishedAt = new Date(now()).toISOString();
  for (const benchmark of INDICES) {
    const anchor = references.get(benchmark);
    const classified=new Map();
    for (const sampleSize of ['120', '240', 'all']) {
      const selected = engine.selectMarketSample(universe, sampleSize === 'all' ? Infinity : Number(sampleSize));
      const records = selected.map(stock => ({ stock, source: sources.get(stock.code) }));
      const dataset = { schema: 'books.research.dataset.v1',barSchema:storedBarSchema,day, asOf, completed: true, collectionStatus: 'complete', expectedCount: records.length, totalUniverseCount: universe.length, universe, reference: { code: benchmark, adjustment: 'index', bars: anchor.bars, fetchedAt: anchor.fetchedAt }, records, startedAt, finishedAt };
      await save('dataset-' + sampleSize + '-' + benchmark, dataset,rawTarget);
      for (const lookback of [20, 60]) {
        const relativePool=engine.buildConsensus({records:records.filter(r=>r.source.status==='ready').map(r=>({stock:r.stock,bars:r.source.bars})),calendar:anchor.bars,lookback,day,expectedCount:records.length,totalUniverseCount:universe.length});
        const modes = sampleSize === 'all' ? ['consensus', 'market', 'strength'] : ['consensus'];
        for (const mode of modes) {
          onProgress({ stage: 'precomputing', currentCode: mode + '/' + lookback + '/' + sampleSize + '/' + benchmark });
          const consensus = mode === 'consensus' ? relativePool : null;
          const times = records.map(r => r.source.fetchedAt).filter(Boolean).sort();
          const resultRecords = records.map(({ stock, source }) => {
            let result=source.status==='ready'?engine.evaluate({mode,bars:source.bars,referenceBars:anchor.bars,lookback,day,code:stock.code,consensus,limits:{enabled:false}}):{status:'unavailable',matched:null,reason:source.reason};
            if(result.status==='ready'){
              const relative=relativePool.perCode?.[stock.code];
              if(relative)for(const key of ['relativeBaseline','excessReturn','recentExcessReturn','relativeStrengthChange','downsideExcess','downsideDays'])result.metrics[key]=relative[key];
              result.structure=engine.deriveSupportResistance({bars:source.bars,calendar:anchor.bars,day});
            }
            if(result.status==='ready'&&riskName(stock)){
              const ruleFailure='未满足：风险名称不在筛选资格内';
              const ruleReasons=[...(result.ruleReasons||result.reasons||[]),ruleFailure];
              result={...result,eligible:false,eligibilityCodes:['risk_name'],baseMatched:false,matched:false,ruleFailure,ruleReasons,reason:ruleFailure,reasons:ruleReasons};
            }
            if(dataPolicy.rawPublic===false&&result.metrics){const {startClose,endClose,...metrics}=result.metrics;result={...result,metrics};}
            const key=lookback+'/'+stock.code;
            if(!classified.has(key))classified.set(key,patterns.classify({bars:source.status==='ready'?source.bars:[],calendar:anchor.bars,day,lookback}));
            return {stock,fetchedAt:source.fetchedAt||null,referenceFetchedAt:anchor.fetchedAt,result,patterns:classified.get(key)};
          });
          const { perCode, memberCodes, ...summary } = consensus || {};
          const status = consensus && consensus.status !== 'ready' ? 'unavailable' : 'complete';
          await save('result-' + mode + '-' + lookback + '-' + sampleSize + '-' + benchmark, { generation,sourceId,dataPolicy,patternVersion:patterns.version,patternProfile:patterns.profile,patternDefinitions:patterns.definitions, mode, lookback, day, asOf, reference: { code: benchmark, name: INDEX_NAMES[benchmark] }, limits: { enabled: false }, status, phase: 'evaluated', records: resultRecords, total: records.length, marketUniverseCount: universe.length, fullMarket: sampleSize === 'all', consensus: consensus ? summary : null, referenceFetchedAt: anchor.fetchedAt, poolFetchedStart: times[0] || null, poolFetchedEnd: times.at(-1) || null, requests: 0, startedAt, finishedAt, reason: consensus?.reason || '' });
        }
      }
    }
  }
  let patternStatisticsVersion,entrySummary,viprasolReport;
  if(dataPolicy.rawPublic===false&&storedBarSchema===barSchema){
    onProgress({stage:'pattern-statistics',checked:0,total:universe.length,currentCode:null});
    const statistics=await precomputePatternStatistics({historyFile:join(rawTarget,'history-all.ndjson'),target,generation,sourceId,day,asOf,patterns,now,onProgress});
    patternStatisticsVersion=statistics.version;
    entrySummary=await precomputeEntryEvidence({historyFile:join(rawTarget,'history-all.ndjson'),target,privateTarget:rawTarget,generation,sourceId,day,asOf,patterns,engine,riskName,policyKnownAt,nextSessionDay,effectivePatternIds:statistics.patterns.filter(item=>item.status==='effective').map(item=>item.id),now,onProgress});
    await precomputeCurrentEntries({target,privateTarget:rawTarget,batch:{generation,sourceId,day,asOf,total:universe.length},siteDir,nextSessionDay,now,onProgress:fields=>onProgress({stage:'entry-current',...fields})});
    if(historyRequested===500){
      const implementationCommit=await viprasolImplementation(siteDir);
      if(viprasolImplementationCommit!==undefined&&viprasolImplementationCommit!==implementationCommit)throw Error('Viprasol implementation changed after its policy-known timestamp; rerun from the unchanged cache');
      let marketMetadata={};
      if(historyFile){
        try{marketMetadata=await readStoredJson(join(dirname(historyFile),'market-metadata.json'));}
        catch(error){if(error.code!=='ENOENT')throw error;}
        if(!marketMetadata||typeof marketMetadata!=='object'||Array.isArray(marketMetadata))throw Error('Viprasol archived market metadata is malformed');
        const codes=new Set(universe.map(stock=>stock.code));
        for(const [code,item]of Object.entries(marketMetadata))if(!codes.has(code)||!item||item.sourceKind!=='exchange-rule-derived'||item.generation!==historyGeneration||item.sourceId!==sourceId||item.sourceDay!==day||item.sourceAsOf!==asOf)throw Error('Viprasol archived metadata does not bind the unchanged source/day/asOf');
        marketMetadata=Object.fromEntries(Object.entries(marketMetadata).map(([code,item])=>[code,{...item,generation,reboundFromGeneration:item.reboundFromGeneration||item.generation}]));
        if(Object.keys(marketMetadata).length)await save('market-metadata',marketMetadata,rawTarget);
      }
      onProgress({stage:'viprasol-study',checked:0,total:universe.length,currentCode:null});
      viprasolReport=await precomputeViprasolStudy({historyFile:join(rawTarget,'history-all.ndjson'),target,batch:{generation,sourceId,day,asOf,total:universe.length},siteDir,marketMetadata,policyKnownAt:viprasolPolicyKnownAt,nextSessionDay,now,onProgress,signal,writeCurrentChart:writeViprasolCurrentChart});
      if(viprasolReport.implementationCommit!==implementationCommit)throw Error('Viprasol implementation changed during the study; completed marker was not published');
    }
  }
  const ready = universe.filter(stock => sources.get(stock.code)?.status === 'ready').length;
  const completed = { generation,sourceId,dataPolicy,barSchema:storedBarSchema,historyRequested,universePolicy,...(patternStatisticsVersion?{patternStatisticsVersion}:{}),...(entrySummary?{entryPolicyVersion,entryValidationVersion,signalChartVersion,closeCandidateVersion,entrySummary}:{}),...(viprasolReport?{viprasolStudyVersion:viprasolReport.version,viprasolImplementationCommit:viprasolReport.implementationCommit}:{}),patternVersion:patterns.version,patternProfile:patterns.profile, day, asOf, startedAt, finishedAt: new Date(now()).toISOString(), total: universe.length, ready,missing:universe.length-ready,coverage:ready/universe.length,fullMarket:true };
  await atomicJson(join(target, 'complete.json'), { ...completed, completed: true });
  return completed;
}

async function optionalJson(path){
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
}
async function completedManifest(dir,value,{sourceOnly=false}={}){
  if(!value||typeof value.generation!=='string'||!/^[0-9TZ-]{1,80}$/.test(value.generation))return null;
  const marker=await optionalJson(join(dir,'generations',value.generation,'complete.json'));
  if(marker?.completed!==true||marker.generation!==value.generation||marker.day!==value.day||marker.asOf!==value.asOf||!Number.isFinite(Date.parse(marker.asOf))||marker.total!==value.total||marker.ready!==value.ready||marker.barSchema!==value.barSchema||marker.fullMarket===false||!Number.isInteger(marker.total)||!Number.isInteger(marker.ready)||marker.total<1000||marker.ready>marker.total||marker.ready/marker.total<.8||(marker.sourceId||legacySourceId)!==(value.sourceId||legacySourceId))return null;
  const required=[];
  if(marker.patternStatisticsVersion)for(const suffix of ['.json','.json.gz'])required.push(join(dir,'generations',value.generation,'pattern-regimes'+suffix));
  if(marker.entryPolicyVersion)for(const name of ['entry-summary','coverage'])for(const suffix of ['.json','.json.gz'])required.push(join(dir,'generations',value.generation,name+suffix));
  if(marker.entryValidationVersion)for(const suffix of ['.json','.json.gz'])required.push(join(dir,'generations',value.generation,'entry-validation'+suffix));
  if(marker.closeCandidateVersion)for(const suffix of ['.json','.json.gz'])required.push(join(dir,'generations',value.generation,marker.closeCandidateVersion===closeCandidateVersion?currentEntryDirectory:'entry-current-v1','report'+suffix));
  if(!sourceOnly&&marker.viprasolStudyVersion){
    if(marker.viprasolStudyVersion!==value.viprasolStudyVersion||marker.viprasolImplementationCommit!==value.viprasolImplementationCommit)return null;
    const path=join(dir,'generations',value.generation,viprasolStudyDirectory,'report.json');
    try{
      const plain=await readFile(path),compressed=await readFile(path+'.gz'),report=JSON.parse(plain);
      if(!gunzipSync(compressed).equals(plain)||report.schema!=='books.a-share.viprasol-study.v1'||report.completed!==true||report.datasetBound!==true||report.familyId!==viprasolFamilyId||report.sourceCommit!==viprasolSourceCommit||report.version!==marker.viprasolStudyVersion||report.implementationCommit!==marker.viprasolImplementationCommit||['generation','sourceId','day','asOf'].some(key=>report[key]!==marker[key])||report.sourceDay!==marker.day||report.coverage?.universeCount!==marker.total||!Array.isArray(report.rules)||report.rules.length!==viprasolRules.length||new Set(report.rules.map(rule=>rule.id)).size!==viprasolRules.length||report.rules.some(rule=>!viprasolRules.some(definition=>definition.id===rule.id))||!Array.isArray(report.current)||!Array.isArray(report.charts))return null;
    }catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError||error.code==='Z_DATA_ERROR'||error.code==='Z_BUF_ERROR')return null;throw error;}
  }else if(!sourceOnly&&value.viprasolStudyVersion)return null;
  for(const code of INDICES)for(const mode of ['consensus','market','strength'])for(const lookback of [20,60])for(const suffix of ['.json','.json.gz'])required.push(join(dir,'generations',value.generation,'result-'+mode+'-'+lookback+'-all-'+code+suffix));
  try{await Promise.all(required.map(path=>access(path)));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  return value;
}

/** Normalize one archive at a time; only the first record set keeps its small source sidecar. */
async function readReplayDataset(file,model,sourceId,keepSourceMetadata=false){
  const raw=await optionalJson(file),dataset=model.normalizeDataset(raw);
  if(raw.records.some(record=>record.source.sourceId!==sourceId))throw Error('私有归档的来源、日期、完整名册或指数不一致，未发布重算结果。');
  const sourceMetadata=keepSourceMetadata?raw.records.map(record=>({adjustmentMethod:record.source.adjustmentMethod||null,volumeUnit:record.source.volumeUnit||null})):null;
  return {dataset,sourceMetadata};
}
/** Recomputes only the completed private batch. It never enters collection or calls an external source. */
export async function recomputeFromCache({dir,siteDir,now=Date.now,signal,compute=precompute,onProgress=()=>{}}={}){
  const previous=await completedManifest(dir,await optionalJson(join(dir,'current.json')),{sourceOnly:true});
  if(!previous||previous.sourceId!==tickflowSourceId||previous.dataPolicy?.rawPublic!==false)throw Error('没有可离线重算的完整同源私有批次。');
  const model=require(join(siteDir,'control/model.js'));
  const location=join(dir,'private','generations',previous.generation),first=await readReplayDataset(join(location,'dataset-all-'+INDICES[0]+'.json'),model,previous.sourceId,true),base=first.dataset,references=new Map();
  for(const [i,code]of INDICES.entries()){
    const {dataset}=i===0?first:await readReplayDataset(join(location,'dataset-all-'+code+'.json'),model,previous.sourceId);
    if(dataset.day!==previous.day||dataset.asOf!==previous.asOf||dataset.reference.code!==code||dataset.expectedCount!==previous.total||dataset.totalUniverseCount!==previous.total||dataset.records.some((record,index)=>JSON.stringify(record)!==JSON.stringify(base.records[index]))||dataset.universe.some((stock,index)=>JSON.stringify(stock)!==JSON.stringify(base.universe[index])))throw Error('私有归档的来源、日期、完整名册或指数不一致，未发布重算结果。');
    references.set(code,{...dataset.reference,sourceId:previous.sourceId});
  }
  const sources=new Map(base.records.map((record,i)=>[record.stock.code,{...record.source,sourceId:previous.sourceId,...first.sourceMetadata[i]}]));
  if([...sources.values()].filter(source=>source.status==='ready').length!==previous.ready)throw Error('私有归档有效数量与完成回执不一致。');
  const startedAt=new Date(now()).toISOString();signal?.throwIfAborted();
  const archived=join(dir,'private','generations',previous.generation,'history-all.ndjson');
  let historyFile;try{await access(archived);historyFile=archived;}catch(error){if(error.code!=='ENOENT')throw error;}
  const implementationCommit=await viprasolImplementation(siteDir),db=openStore(join(dir,'collector.sqlite'));let policyKnownAt,viprasolPolicyKnownAt;
  try{policyKnownAt=entryKnownAt(db,now);viprasolPolicyKnownAt=entryKnownAt(db,now,viprasolKnownKey(implementationCommit));}finally{db.close();}
  const nextSessionDay=nextVerifiedSession(require(join(siteDir,'market-calendar.js')),base.day);
  const result=await compute({dir,siteDir,snapshot:null,universe:base.universe,sources,references,historyFile,sourceId:previous.sourceId,dataPolicy:previous.dataPolicy,policyKnownAt,viprasolPolicyKnownAt,viprasolImplementationCommit:implementationCommit,nextSessionDay,day:base.day,asOf:base.asOf,startedAt,now,onProgress,signal});
  signal?.throwIfAborted();
  if(result.day!==base.day||result.asOf!==base.asOf||result.sourceId!==previous.sourceId||!await completedManifest(dir,result))throw Error('离线重算未完整结束，保留上次成功结果。');
  const current=await optionalJson(join(dir,'current.json'));
  if(current?.generation!==previous.generation)throw Error('重算期间已有新批次发布，未覆盖当前结果。');
  const published={...result,recomputedFrom:previous.generation};
  await atomicJson(join(dir,'generations',result.generation,'complete.json'),{...published,completed:true});
  await atomicJson(join(dir,'current.json'),published);
  return {attempt:{status:'complete',jobType:'recompute',day:base.day,total:base.expectedCount,checked:base.expectedCount,ready:previous.ready,missing:previous.total-previous.ready,requests:0,startedAt,finishedAt:result.finishedAt},lastSuccess:published};
}

export async function collect({ dir, siteDir, fetch: request = globalThis.fetch, now = Date.now, wait = sleep, interval = 1500, signal, calendar, pool, technicalFactory, sourceFactory=createTickflowSource, universeFactory=readTickflowUniverse,compute = precompute } = {}) {
  await mkdir(dir, { recursive: true });
  const db = openStore(join(dir, 'collector.sqlite'));
  const sourceId=technicalFactory?legacySourceId:tickflowSourceId,dataPolicy=technicalFactory?legacyPolicy:tickflowPolicy;
  const attempt = { sourceId,dataPolicy,status: 'running', stage: 'calendar', day: null, total: 0, checked: 0, ready: 0, missing: 0, requests: 0, resumed: 0, currentCode: null, startedAt: new Date(now()).toISOString(), finishedAt: null, error: null,errorDetails:null };
  let pending = Promise.resolve();
  function progress(fields = {}) {
    Object.assign(attempt, fields);
    const status = { configured: true, schedule: SCHEDULE, attempt: { ...attempt } };
    pending = pending.then(() => atomicJson(join(dir, 'status.json'), status));
  }
  const sourceFetch = createGuard({ db, fetch: request, now, wait, interval, signal,sourceId, onRequest: () => progress({ requests: attempt.requests + 1 }) });
  try {
    calendar ||= require(join(siteDir, 'market-calendar.js'));
    pool ||= require(join(siteDir, 'screening/market-pool.js'));
    const latest = calendar.latestClosed('CN', now());
    if (!latest) throw Error('交易日历未核验，不能推断目标收盘日期。');
    const published=await optionalJson(join(dir,'current.json')),completePrevious=await completedManifest(dir,published);
    const previous=completePrevious||await completedManifest(dir,published,{sourceOnly:true});
    let longArchive=false;
    if(previous?.historyRequested>=historyCount){try{await access(join(dir,'private','generations',previous.generation,'history-all.ndjson'));longArchive=true;}catch(error){if(error.code!=='ENOENT')throw error;}}
    if (previous?.day === latest.date &&(previous.sourceId||legacySourceId)===sourceId&&(technicalFactory||previous.barSchema===barSchema&&longArchive)&&Date.parse(previous.asOf) >= Date.parse(latest.closeTime)) {
      if(!technicalFactory&&compute===precompute){
        const implementationCommit=await viprasolImplementation(siteDir);
        if(!completePrevious||previous.entryPolicyVersion!==entryPolicyVersion||previous.entryValidationVersion!==entryValidationVersion||previous.signalChartVersion!==signalChartVersion||previous.viprasolStudyVersion!==viprasolStudyVersion||previous.viprasolImplementationCommit!==implementationCommit){
          progress({stage:'viprasol-recompute',day:latest.date,total:previous.total});
          const replay=await recomputeFromCache({dir,siteDir,now,signal,onProgress:progress});
          progress({...replay.attempt,stage:'published',currentCode:null});await pending;return {attempt,lastSuccess:replay.lastSuccess};
        }
      }
      if(!technicalFactory&&compute===precompute)await precomputeCurrentEntries({target:join(dir,'generations',previous.generation),privateTarget:join(dir,'private','generations',previous.generation),batch:previous,siteDir,nextSessionDay:nextVerifiedSession(calendar,latest.date),now,onProgress:fields=>progress({stage:'entry-current',...fields}),signal});
      progress({ status: 'no_new_day', stage: 'waiting', day: latest.date, total: previous.total, finishedAt: new Date(now()).toISOString() });
      await pending;
      return { attempt, lastSuccess: previous };
    }
    progress({ day: latest.date, stage: 'market' });
    const getSetting = db.prepare('SELECT value FROM settings WHERE key=?');
    const implementationCommit=technicalFactory?null:await viprasolImplementation(siteDir);
    const policyKnownAt=technicalFactory?null:entryKnownAt(db,now),viprasolPolicyKnownAt=technicalFactory?null:entryKnownAt(db,now,viprasolKnownKey(implementationCommit)),nextSessionDay=nextVerifiedSession(calendar,latest.date);
    const holdKey='source-hold:'+sourceId;
    if(getSetting.get(holdKey))throw Error('来源访问已暂停：'+JSON.parse(getSetting.get(holdKey).value).reason);
    const frozen=db.prepare('SELECT snapshot_json FROM batches_v2 WHERE source_id=? AND day=?').get(sourceId,latest.date);
    let snapshot=frozen?JSON.parse(frozen.snapshot_json):null;
    if(!snapshot||!technicalFactory&&snapshot.schema!==universeSchema){
      if(technicalFactory){
        const response=await sourceFetch(MARKET_URL);if(!response.ok)throw Error('市场名册 HTTP '+response.status);snapshot=await response.json();
      }else{
        const old=db.prepare('SELECT snapshot_json FROM batches_v2 WHERE source_id=? ORDER BY day DESC LIMIT 1').get(sourceId),sectors=new Map();let sectorAsOf=null;
        if(old){
          const value=JSON.parse(old.snapshot_json);
          if(value.schema===universeSchema){for(const stock of value.universe)if(stock.sector!=='未分类')sectors.set(stock.code,stock.sector);sectorAsOf=value.universePolicy.sectorAsOf;}
          else if(Array.isArray(value.stocks)){for(const stock of pool.build(value).rows)if(stock.sector!=='未分类')sectors.set(stock.code,stock.sector);sectorAsOf=value.updatedAt;}
        }
        snapshot=await universeFactory({fetch:sourceFetch,day:latest.date,now,sectors,sectorAsOf});
      }
    }
    let universe,asOf;
    if(technicalFactory){
      const market=pool.build(snapshot);asOf=new Date(snapshot.updatedAt).toISOString();
      if(market.day!==latest.date||Date.parse(asOf)<Date.parse(latest.closeTime)||Date.parse(asOf)>now())throw Error('市场名册日期 '+market.day+' 未覆盖最近收盘日 '+latest.date+'；未覆盖上次结果。');
      universe=pool.select(market.rows,{universe:'main',excludeRiskNames:false}).filter(r=>r.exchange!=='BJ').map(({code,name,sector,exchange})=>({code,name,sector,exchange}));
    }else{
      if(snapshot.schema!==universeSchema||snapshot.day!==latest.date||!Array.isArray(snapshot.universe)||!Number.isFinite(Date.parse(snapshot.retrievedAt))||Date.parse(snapshot.retrievedAt)>now())throw Error('官方名册身份、目标交易日或读取时间无效');
      universe=snapshot.universe;asOf=new Date(Math.max(Date.parse(latest.closeTime),previous?.day===latest.date?Date.parse(previous.asOf):0)).toISOString();
      progress({universeRetrievedAt:snapshot.retrievedAt,universePolicy:snapshot.universePolicy});
    }
    if (universe.length < 1000) throw Error('沪深主板名册覆盖不足。');
    if(!frozen||!technicalFactory&&JSON.parse(frozen.snapshot_json).schema!==universeSchema)db.prepare('INSERT OR REPLACE INTO batches_v2 VALUES(?,?,?,?)').run(sourceId,latest.date,asOf,JSON.stringify(snapshot));
    progress({ total: universe.length, stage: 'indices' });
    const storage = { getItem: key => getSetting.get(key)?.value || null, setItem: (key, value) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value), removeItem: key => db.prepare('DELETE FROM settings WHERE key=?').run(key) };
    const source=technicalFactory?technicalFactory({fetch:sourceFetch,localStorage:storage,now,preferSuccessfulHost:true}):sourceFactory({fetch:sourceFetch,now});
    const read = db.prepare('SELECT source_json FROM history_v2 WHERE source_id=? AND day=? AND code=? AND as_of=?');
    const save = db.prepare('INSERT OR REPLACE INTO history_v2 VALUES(?,?,?,?,?)');
    const references = new Map(), sources = new Map();
    function accept(stock,record,index,cached=false){
      signal?.throwIfAborted();
      const hold = getSetting.get(holdKey);
      if (hold || record.sourceStopped) {
        const stopped = hold ? JSON.parse(hold.value) : null;
        throw Error(stopped ? stopped.reason + (stopped.retryAfter ? '；Retry-After 至 ' + stopped.retryAfter : '') + '：来源已暂停，不重试。' : record.reason);
      }
      if(record.transportError)throw Error('日线传输失败（'+stock.code+'）：'+record.reason+'；本轮已停止，已成功记录留待续跑。');
      if(!['ready','unavailable'].includes(record.status)||!technicalFactory&&(record.sourceId!==sourceId||record.day!==latest.date||record.status==='ready'&&record.adjustment!==(index?'index':'qfq')))throw Error('日线来源身份、日期或复权口径不符：'+stock.code);
      if(!technicalFactory&&record.status==='ready'&&!hasOHLC(record.bars))throw Error('日线开高低收不完整或无效：'+stock.code+'；未发布本轮结果。');
      const clean={status:record.status,sourceId,day:latest.date,adjustment:record.adjustment||null,adjustmentMethod:record.adjustmentMethod||null,volumeUnit:record.volumeUnit||null,historyRequested:record.historyRequested||0,bars:record.bars?.slice(-historyCount)||[],fetchedAt:record.fetchedAt||null,reason:record.reason||null};
      if(!technicalFactory)clean.diagnostic=diagnoseHistory(clean);
      if(!cached)save.run(sourceId,latest.date,stock.code,asOf,JSON.stringify(clean));
      else attempt.resumed++;
      if(index){if(technicalFactory&&clean.status!=='ready')throw Error('指数 '+stock.code+'：'+clean.reason);references.set(stock.code,clean);}
      else{sources.set(stock.code,{...clean,bars:clean.bars.slice(-61)});progress({currentCode:stock.code,checked:attempt.checked+1,ready:attempt.ready+Number(clean.status==='ready'),missing:attempt.missing+Number(clean.status!=='ready')});}
    }
    async function readGroup(stocks,index){
      const pending=[];
      for(const stock of stocks){const cached=read.get(sourceId,latest.date,stock.code,asOf),record=cached&&JSON.parse(cached.source_json);if(record?.status==='ready'&&(technicalFactory||hasOHLC(record.bars)&&record.historyRequested>=historyCount))accept(stock,record,index,true);else pending.push(stock);}
      if(!pending.length)return;
      progress({currentCode:pending[0].code});
      if(technicalFactory){for(const stock of pending)accept(stock,await source.history({...stock,asOf},latest.date,signal||new AbortController().signal,{minBars:61,index}),index);return;}
      const batch=await source.historyBatch(pending,latest.date,{index});
      for(const stock of pending){const record=batch.get(stock.code);if(!record)throw Error('日线批次缺少明确的证券状态：'+stock.code);accept(stock,record,index);}
    }
    await readGroup(INDICES.map(code=>({code})),true);
    const pendingIndices=INDICES.filter(code=>references.get(code).status!=='ready');
    if(pendingIndices.length){
      if(!technicalFactory&&pendingIndices.every(code=>references.get(code).diagnostic.code==='target_day_missing')){
        const observedAt=new Date(now()).toISOString(),sourcePending={requestedDay:latest.date,observedAt,indices:INDICES.map(code=>{const source=references.get(code);return {code,status:source.status,sourceDay:source.diagnostic.lastDay,fetchedAt:source.fetchedAt,diagnostic:source.diagnostic};})};
        progress({status:'waiting_source',stage:'indices',sourcePending,message:'来源尚未发布 '+latest.date+' 的完整日线；已保留上次成功结果，等待下一次定时检查。',currentCode:null,error:null,errorDetails:null,finishedAt:observedAt});
        await pending;return {attempt,lastSuccess:previous};
      }
      const code=pendingIndices.find(code=>references.get(code).diagnostic.code!=='target_day_missing')||pendingIndices[0];throw Error('指数 '+code+'：'+references.get(code).reason);
    }
    progress({ stage: 'collecting' });
    for(let offset=0;offset<universe.length;offset+=50)await readGroup(universe.slice(offset,offset+50),false);
    if (attempt.ready / universe.length < .8) throw Error('同日有效日线覆盖不足80%：' + attempt.ready + '/' + universe.length + '；保留上次成功结果。');
    const historyRecords=async function*(){for(const stock of universe){const cached=read.get(sourceId,latest.date,stock.code,asOf);if(!cached)throw Error('已收集证券缺少原始历史归档：'+stock.code);yield {stock,source:JSON.parse(cached.source_json)};}};
    const result = await compute({ dir, siteDir, snapshot, universe, sources, references,historyRecords,sourceId,dataPolicy,policyKnownAt,viprasolPolicyKnownAt,viprasolImplementationCommit:implementationCommit,nextSessionDay, day: latest.date, asOf, startedAt: attempt.startedAt, now, onProgress: progress,signal });
    signal?.throwIfAborted();
    if((result.sourceId||legacySourceId)!==sourceId||!await completedManifest(dir,result))throw Error('预计算批次未完整结束或来源不符，保留上次成功结果。');
    if (previous && (previous.day > result.day || Date.parse(previous.asOf) > Date.parse(result.asOf))) throw Error('新批次日期早于已发布结果，拒绝回退。');
    await atomicJson(join(dir, 'current.json'), result);
    progress({ status: 'complete', stage: 'published', total: result.total, checked: result.total, ready: result.ready, missing: result.total-result.ready, currentCode: null, finishedAt: new Date(now()).toISOString() });
    await pending;
    return { attempt, lastSuccess: result };
  } catch (error) {
    progress({ status: 'failed', stage: attempt.stage, error: error.message,errorDetails:error.details||null, finishedAt: new Date(now()).toISOString() });
    await pending;
    return { attempt };
  } finally { db.close(); }
}

async function main() {
  const dir = process.env.BOOKS_A_SHARE_DIR || '/var/lib/books/a-share-daily';
  const siteDir = resolve(process.env.BOOKS_SITE_DIR || '/opt/books/site');
  await mkdir(dir, { recursive: true });
  const lock = join(dir, 'worker.lock');
  try { await writeFile(lock, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    try { process.kill(pid, 0); throw Error('已有采集进程运行：' + pid); }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    await unlink(lock);
    await writeFile(lock, String(process.pid), { flag: 'wx' });
  }
  try {
    const control = new AbortController();
    for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => control.abort(Error('任务被停止，已完成日线留待续跑；正式结果保持不变。')));
    const run=process.argv.includes('--rebuild-current-entry')?rebuildCurrentEntries:process.argv.includes('--recompute-cache')?recomputeFromCache:collect;
    const retention={dir,booksDb:process.env.BOOKS_DB,hotGenerations:Number(process.env.A_SHARE_HOT_GENERATIONS||2),reserveBytes:Number(process.env.A_SHARE_ARCHIVE_RESERVE_BYTES||1073741824)};
    await runRetention(retention);
    try{await assertCollectionSpace({dir,reserveBytes:retention.reserveBytes,batchBytes:Number(process.env.A_SHARE_BATCH_RESERVE_BYTES||1073741824)});}
    catch(error){
      const old=await optionalJson(join(dir,'status.json'));
      await atomicJson(join(dir,'status.json'),{configured:true,schedule:SCHEDULE,attempt:{...old?.attempt,status:'failed',stage:'capacity',finishedAt:new Date().toISOString(),error:error.message,errorDetails:error.details||null}});
      throw error;
    }
    let result,taskError;
    try{
      result=await run({dir,siteDir,signal:control.signal});
      if(process.env.BOOKS_DB&&result.attempt.jobType!=='entry-current'&&['complete','no_new_day'].includes(result.attempt.status)){
        const {runSavedSchemes}=await import('./a-share-scheme-runner.mjs');
        result.schemes=await runSavedSchemes({dbFile:process.env.BOOKS_DB,dir,siteDir});
        if(result.schemes.status==='failed')process.exitCode=1;
      }
    }catch(error){taskError=error;throw error;}
    finally{
      try{const maintained=await runRetention(retention);if(result)result.retention=maintained;}
      catch(error){if(taskError)console.error('采集后存储维护失败：'+error.message);else throw error;}
    }
    console.log(JSON.stringify(result));
    if (!['complete', 'no_new_day', 'waiting_source'].includes(result.attempt.status)) process.exitCode = 1;
  } finally { await unlink(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
