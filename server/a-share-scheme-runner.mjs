import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createSchemeStore} from './a-share-schemes.mjs';

const require=createRequire(import.meta.url);
const horizons=[1,3,5,10,20];
const observationMethod='same_batch_forward_adjusted_close_change';
const stamp=now=>new Date(now()).toISOString();
async function json(path){return JSON.parse(await readFile(path,'utf8'));}
function derivedResult(result){
  if(!result.metrics)return {...result};
  const {startClose,endClose,ma5,ma20,volumeAvg5,volumeAvgPrevious20,...metrics}=result.metrics;
  return {...result,metrics};
}
function baselineReason(previous,scheme,manifest,engineVersion,patternVersion){
  if(!previous)return 'first_run';
  if(previous.revision!==scheme.revision)return 'revision_changed';
  if(previous.engineVersion!==engineVersion)return 'engine_changed';
  if(previous.patternVersion!==patternVersion)return 'pattern_engine_changed';
  if(previous.sourceId!==manifest.sourceId)return 'source_changed';
  return null;
}
function selectionState(record,scheme){
  const r=record.result,id=scheme.selection.patternId;
  if(r.status!=='ready'||r.candidateMatched===null||r.strengthKnown===false)return {selected:null,reason:r.reason||'本轮行情或筛选条件资料不足'};
  if(id&&(record.patterns.status!=='ready'||record.patterns.unavailable.some(item=>item.id===id)))return {selected:null,reason:'所选技术形态资料不足，未确认退出'};
  const basis=scheme.selection.qualification==='observation'&&scheme.config.settings.mode==='consensus'?r.candidateMatched===true&&r.directionMatched!==false:r.matched===true;
  const shape=!id||record.patterns.labels.some(item=>item.id===id);
  return {selected:basis&&shape,reason:basis&&!shape?'未满足所选技术形态':r.reason||''};
}
function compareMembership(current,previous,isBaseline,scheme,patterns,day){
  const old=new Map((previous?.records||[]).map(record=>[record.stock.code,record])),seen=new Set(),records=[];
  const summary={baseline:0,new:0,continued:0,exited:0,unknown:0,selected:0,confirmedSelected:0,total:current.length,ready:0};
  for(const record of current){
    const code=record.stock.code;seen.add(code);
    const last=old.get(code),before=isBaseline?null:last?(typeof last.confirmedSelected==='boolean'?last.confirmedSelected:null):previous?false:null;
    const {selected,reason}=selectionState(record,scheme),confirmedSelected=selected===null?before:selected;
    let change;
    if(selected===null)change='unknown';
    else if(selected)change=isBaseline||before===null?'baseline':before?'continued':'new';
    else if(!isBaseline&&before===true)change='exited';
    if(selected!==null)summary.ready++;
    if(selected)summary.selected++;
    if(confirmedSelected)summary.confirmedSelected++;
    if(change){summary[change]++;records.push({...record,selected,confirmedSelected,change,reason});}
  }
  if(previous&&!isBaseline)for(const record of previous.records||[]){
    if(seen.has(record.stock.code)||record.confirmedSelected!==true)continue;
    const reason='本轮完整名册未覆盖该股票，未确认退出';
    records.push({stock:record.stock,result:{status:'unavailable',matched:null,candidateMatched:null,reason},patterns:{version:patterns.version,day,lookback:scheme.config.settings.lookback,status:'unavailable',labels:[],unavailable:[]},selected:null,confirmedSelected:true,change:'unknown',reason});
    summary.unknown++;summary.confirmedSelected++;summary.total++;
  }
  return {records,summary};
}
function episodeFor(record,scheme,run,manifest,engineVersion,patternVersion,now){
  return {id:randomUUID(),schemeId:scheme.id,revision:scheme.revision,code:record.stock.code,name:record.stock.name,entryDay:run.day,knownAt:stamp(now),enteredRunId:run.id,exitDay:null,benchmark:scheme.config.settings.benchmark,sourceId:manifest.sourceId,engineVersion,patternVersion,anchorGeneration:manifest.generation,observationMethod,observations:{}};
}
function trackMembership(episodes,records,scheme,run,manifest,engineVersion,patternVersion,now){
  const next=episodes.map(episode=>({...episode,observations:{...episode.observations}}));
  for(const record of records){
    if(record.change==='exited')for(const episode of next)if(episode.revision===scheme.revision&&episode.code===record.stock.code&&episode.exitDay===null&&episode.engineVersion===engineVersion&&episode.patternVersion===patternVersion)episode.exitDay=run.day;
    if(record.selected!==true)continue;
    const existing=next.some(episode=>episode.revision===scheme.revision&&episode.code===record.stock.code&&episode.exitDay===null&&episode.engineVersion===engineVersion&&episode.patternVersion===patternVersion&&episode.sourceId===manifest.sourceId);
    if(!existing||record.change==='new')next.push(episodeFor(record,scheme,run,manifest,engineVersion,patternVersion,now));
  }
  return next;
}
async function observeTracks(episodes,manifest,loadDataset,now){
  const counts={episodes:episodes.length,ready:0,pending:0,unavailable:0,notObservable:0};
  const updated=[];
  for(const episode of episodes){
    const observations={...episode.observations};
    if(horizons.every(h=>['ready','not_observable'].includes(observations[h]?.status))){for(const h of horizons)counts[observations[h].status==='ready'?'ready':'notObservable']++;updated.push(episode);continue;}
    const dataset=await loadDataset(episode.benchmark||'000300.SH'),calendar=dataset.reference.bars.map(bar=>bar.date),anchorIndex=calendar.indexOf(episode.entryDay),source=dataset.records.find(record=>record.stock.code===episode.code)?.source;
    const byDay=new Map((source?.bars||[]).map(bar=>[bar.date,bar]));
    for(const horizon of horizons){
      const previous=observations[horizon];
      if(previous?.status==='ready'||previous?.status==='not_observable'){counts[previous.status==='ready'?'ready':'notObservable']++;continue;}
      const observation={horizon,targetDay:anchorIndex>=0?calendar[anchorIndex+horizon]||null:previous?.targetDay||null,status:'pending',returnPercent:null,reason:'等待后续已完成交易日',checkedAt:stamp(now),sourceId:manifest.sourceId,generation:manifest.generation,asOf:manifest.asOf,method:observationMethod};
      if(episode.sourceId!==manifest.sourceId||episode.observationMethod!==observationMethod){observation.status='unavailable';observation.reason='入选与观察数据来源或复权方法不一致';}
      else if(anchorIndex<0){observation.status='unavailable';observation.reason='入选锚日已超出本批已验证交易日历，无法同批核对';}
      else if(observation.targetDay){
        const closeTime=Date.parse(observation.targetDay+'T15:00:00+08:00');
        if(!Number.isFinite(Date.parse(episode.knownAt))||closeTime<=Date.parse(episode.knownAt)){observation.status='not_observable';observation.reason='该观察日收盘不晚于方案实际已知时间，不回填为后续走势';}
        else if(!source||source.status!=='ready'||source.adjustment!=='qfq'){observation.status='unavailable';observation.reason='本批缺少该股票有效前复权日线，可能停牌或来源缺失';}
        else{
          const aligned=calendar.slice(anchorIndex,anchorIndex+horizon+1).every(date=>{const bar=byDay.get(date);return bar&&Number.isFinite(bar.close)&&bar.close>0&&Number.isFinite(bar.volume)&&bar.volume>0;});
          if(!aligned){observation.status='unavailable';observation.reason='锚日至观察日存在停牌、缺失或无有效成交，未跳过缺口计算';}
          else{
            const value=(byDay.get(observation.targetDay).close/byDay.get(episode.entryDay).close-1)*100;
            if(Number.isFinite(value)){observation.status='ready';observation.returnPercent=value;observation.reason='同一完整批次前复权收盘变化；非交易收益';observation.observedAt=stamp(now);}
            else{observation.status='unavailable';observation.reason='同批收盘变化超出有限数值范围';}
          }
        }
      }
      observations[horizon]=observation;counts[observation.status==='not_observable'?'notObservable':observation.status]++;
    }
    updated.push({...episode,observations});
  }
  return {tracks:updated,summary:counts};
}

export async function runSavedSchemes({dbFile,dir,siteDir,now=Date.now,schemeIds}={}){
  if(!dbFile||!dir||!siteDir)throw Error('命名方案任务需要明确的数据库、行情缓存和代码目录');
  const model=require(join(siteDir,'control/model.js')),engine=require(join(siteDir,'screening/trend-screen.js')),patterns=require(join(siteDir,'screening/trend-patterns.js')),pool=require(join(siteDir,'screening/market-pool.js'));
  const db=new DatabaseSync(dbFile);db.exec('PRAGMA busy_timeout=5000');
  try{
    const store=createSchemeStore({db,model,patterns,now}),schemes=store.list().filter(scheme=>!schemeIds||schemeIds.includes(scheme.id));
    if(!schemes.length)return {status:'complete',schemes:[]};
    const manifest=await json(join(dir,'current.json'));
    if(typeof manifest.generation!=='string'||!/^[0-9TZ-]{1,80}$/.test(manifest.generation))throw Error('完整行情批次标识无效');
    const asOf=Date.parse(manifest.asOf),closeTime=Date.parse(manifest.day+'T15:00:00+08:00');
    if(!Number.isFinite(asOf)||!Number.isFinite(closeTime)||asOf<closeTime||asOf>now())throw Error('行情批次尚未完成收盘或晚于任务已知时间');
    const marker=await json(join(dir,'generations',manifest.generation,'complete.json'));
    if(marker.completed!==true||marker.fullMarket===false||marker.generation!==manifest.generation||marker.day!==manifest.day||marker.asOf!==manifest.asOf||marker.sourceId!==manifest.sourceId||!Number.isInteger(marker.total)||marker.total<1000||marker.ready!==manifest.ready||marker.total!==manifest.total||marker.ready/marker.total<.8)throw Error('行情完成回执或全市场覆盖不一致，保留已完成方案结果');
    const datasets=new Map();
    async function loadDataset(benchmark){
      if(datasets.has(benchmark))return datasets.get(benchmark);
      const raw=await json(join(dir,'private','generations',manifest.generation,'dataset-all-'+benchmark+'.json')),dataset=model.normalizeDataset(raw);
      if(dataset.day!==manifest.day||dataset.asOf!==manifest.asOf||dataset.reference.code!==benchmark||dataset.expectedCount!==manifest.total||dataset.totalUniverseCount!==manifest.total||dataset.records.some((record,i)=>raw.records[i].source.sourceId!==manifest.sourceId)||dataset.records.filter(record=>record.source.status==='ready').length!==manifest.ready)throw Error('私有日线与完整行情批次的日期、来源或名册不一致');
      datasets.set(benchmark,dataset);return dataset;
    }
    const outcomes=[];
    for(const scheme of schemes){
      let run;
      try{
        for(const prior of store.runs(scheme.id))if(prior.status==='running'&&now()-Date.parse(prior.startedAt)>6*3600000)store.failRun(prior.id,'process_interrupted');
        const episodes=store.tracks(scheme.id);
        if(!scheme.enabled){
          if(episodes.length){const tracking=await observeTracks(episodes,manifest,loadDataset,now);store.updateTracks(tracking.tracks);}
          outcomes.push({schemeId:scheme.id,status:'disabled'});continue;
        }
        const previous=store.latestRun(scheme.id),reason=baselineReason(previous,scheme,manifest,model.engineVersion,patterns.version);
        if(previous&&previous.day>manifest.day)throw Error('新行情日期早于上次成功方案结果，拒绝回退');
        run=store.beginRun({schemeId:scheme.id,revision:scheme.revision,day:manifest.day,generation:manifest.generation,sourceId:manifest.sourceId,asOf:manifest.asOf,engineVersion:model.engineVersion,patternVersion:patterns.version,kind:reason?'baseline':'daily'});
        if(run.skipped){
          if(episodes.length){const tracking=await observeTracks(episodes,manifest,loadDataset,now);store.updateTracks(tracking.tracks);}
          outcomes.push({schemeId:scheme.id,status:'skipped',runId:run.run.id});continue;
        }
        store.updateProgress(run.id,{stage:'reading',checked:0,total:manifest.total});
        const config=model.normalizeConfig({...scheme.config,settings:{...scheme.config.settings,sampleSize:'all'}}),dataset=await loadDataset(config.settings.benchmark);
        store.updateProgress(run.id,{stage:'evaluating',checked:0,total:dataset.expectedCount});
        const evaluated=await model.evaluateDataset(dataset,config,engine,{onProgress:value=>{if(value.checked%200===0||value.checked===value.total)store.updateProgress(run.id,{stage:'evaluating',checked:value.checked,total:value.total});}});
        if(evaluated.status!=='complete')throw Error(evaluated.reason||'方案所需完整周期数据不足');
        const sourceByCode=new Map(dataset.records.map(record=>[record.stock.code,record.source])),scope=scheme.selection.scopeCodes===null?null:new Set(scheme.selection.scopeCodes);
        const current=evaluated.records.filter(record=>config.settings.mode==='consensus'||scope===null||scope.has(record.stock.code)).map(record=>{
          let result=record.result;
          if(result.status==='ready'&&pool.riskName(record.stock))result={...result,eligible:false,eligibilityCodes:['risk_name'],baseMatched:false,matched:false,reason:'风险名称不在筛选资格内'};
          return {stock:record.stock,result:derivedResult(result),patterns:patterns.classify({bars:sourceByCode.get(record.stock.code)?.bars||[],calendar:dataset.reference.bars,day:dataset.day,lookback:config.settings.lookback,parameters:config.settings.patterns})};
        });
        store.updateProgress(run.id,{stage:'tracking',checked:dataset.expectedCount,total:dataset.expectedCount});
        const compared=compareMembership(current,previous,Boolean(reason),scheme,patterns,manifest.day),members=trackMembership(episodes,compared.records,scheme,run,manifest,model.engineVersion,patterns.version,now),tracking=await observeTracks(members,manifest,loadDataset,now);
        const summary={...compared.summary,isBaseline:Boolean(reason),baselineReason:reason,selection:scheme.selection,dataDay:manifest.day,generation:manifest.generation,sourceStatus:evaluated.status,market:evaluated.summary,tracking:tracking.summary,observationLabel:'入选后收盘走势，非交易收益'};
        store.finishRun({runId:run.id,records:compared.records,summary,tracks:tracking.tracks});outcomes.push({schemeId:scheme.id,status:'complete',runId:run.id,summary});
      }catch(error){
        if(run?.id)store.failRun(run.id,error);
        outcomes.push({schemeId:scheme.id,status:'failed',error:error.message});
      }
    }
    return {status:outcomes.some(outcome=>outcome.status==='failed')?'failed':'complete',day:manifest.day,generation:manifest.generation,schemes:outcomes};
  }finally{db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runSavedSchemes({dbFile:process.env.BOOKS_DB,dir:process.env.BOOKS_A_SHARE_DIR,siteDir:process.env.BOOKS_SITE_DIR,schemeIds:process.argv[2]?[process.argv[2]]:undefined})
    .then(result=>{console.log(JSON.stringify(result));if(result.status==='failed')process.exitCode=1;})
    .catch(error=>{console.error(error.message);process.exitCode=1;});
}
