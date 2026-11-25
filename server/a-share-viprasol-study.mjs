// Separate research family. This module does not collect, publish, or alter the 16 fixed shapes.
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {policy,evaluateEvent,summarizeEvents,walkForward} from './a-share-pattern-regimes.mjs';

const siteDir=process.env.BOOKS_SITE_DIR?resolve(process.env.BOOKS_SITE_DIR):fileURLToPath(new URL('../',import.meta.url));
const {catalog,evaluateIndicator}=await import(pathToFileURL(join(siteDir,'quant-research/viprasol-registry.mjs')).href);
export const version='books.viprasol-a-share-next-open.2026-11-25.v1';
export const sourceCommit='a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0';
export const familyId='viprasol-original-long-next-open-13';
const require=createRequire(import.meta.url),screen=require(join(siteDir,'screening/trend-screen.js')),pool=require(join(siteDir,'screening/market-pool.js'));
const ids=['tyson','ronaldo','double-tap-double-top-bottom','absorption-radar-pro','apex-trend-signal-engine','elite-flow-pro','equilibrium-confluence-engine','liquidity-hunt-pro','ma-confluence-engine','market-os','naive-bayes-order-flow','pressure-flow-pro','elite-advanced-pattern-scanner'];
// Only these three audited price-only sources are exempt. The flow rules keep
// their volume gate pending any separate dependency review; no inferred exemption.
const priceOnly=new Set(['tyson','ronaldo','double-tap-double-top-bottom']);
export const definitions=Object.freeze(ids.map(id=>{
 const item=catalog.find(item=>item.id===id);if(!item)throw Error('Frozen Viprasol rule missing: '+id);
 return Object.freeze({id,title:item.title,sourceFile:item.sourceFile,parameters:Object.freeze({...item.defaults}),dependencies:Object.freeze(item.dependencies||[]),volumeDependent:!priceOnly.has(id),prefixStable:id!=='elite-flow-pro'});
}));
export {policy};
const finite=Number.isFinite;
const dateKey=day=>Date.parse(day+'T00:00:00.000Z');
const closeAt=day=>day+'T15:00:00+08:00';
const validDay=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&finite(dateKey(day))&&new Date(dateKey(day)).toISOString().slice(0,10)===day;
const validBar=bar=>bar&&validDay(bar.date)&&['open','high','low','close','volume'].every(key=>finite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const equalParameters=(a,b)=>a&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(key=>a[key]===b[key]);
const positive=stats=>stats.sampleCount>0&&stats.meanReturnPercent>0&&stats.meanExcessPercent>0&&stats.positiveRate>=.5;
const adequate=(stats,kind)=>{const prefix=kind==='recent'?'minRecent':kind==='validation'?'minValidation':'minTrain';return ['Samples','Stocks','Dates'].every((suffix,i)=>stats[['sampleCount','stockCount','signalDayCount'][i]]>=policy[prefix+suffix]);};

/** One original long event per rule/stock/session; reserve holdings before reading outcomes. */
export function collectRuleEvents({signals,bars,reference,dates,code}){
 const positions=new Map(dates.map((day,index)=>[day,index])),byDay=new Map(bars.map(bar=>[bar.date,bar])),aligned=dates.map(day=>byDay.get(day)||null),events=[],reservations=[],today=[];
 const counts={longSignals:0,duplicateSession:0,overlapReserved:0,outsideReferenceHistory:0,ready:0,pending:0,unavailable:0,unexecutable:0};
 const ordered=signals.filter(signal=>signal.side==='long').slice().sort((a,b)=>a.index-b.index);let lastExit=-1,previous=-1;
 for(const signal of ordered){
  if(!Number.isInteger(signal.index)||signal.index<0||signal.index>=bars.length)throw Error('Viprasol original signal index invalid');
  const raw=bars[signal.index],signalIndex=positions.get(raw.date);
  if(signalIndex===undefined&&raw.date<dates[0]){counts.outsideReferenceHistory++;continue;}
  if(signal.time!==dateKey(raw.date)||signalIndex===undefined)throw Error('Viprasol original signal does not bind its source bar/calendar');
  counts.longSignals++;
  if(signalIndex===dates.length-1)today.push(signal);
  if(signalIndex===previous){counts.duplicateSession++;continue;}previous=signalIndex;
  if(signalIndex+1<=lastExit){counts.overlapReserved++;continue;}
  lastExit=signalIndex+policy.horizon;reservations.push({signalIndex,entryIndex:signalIndex+1,exitIndex:lastExit});
  const outcome=evaluateEvent({bars:aligned,reference,signalIndex,code});
  counts[outcome.status]++;
  if(outcome.status==='ready')events.push(outcome);
 }
 return {events,reservations,counts,today,aligned};
}

/** Statistical gate only: it cannot authorize an unreviewed native rule. */
export function validateViprasolEvents(events,dates){
 if(!Array.isArray(dates)||!dates.length||dates.some((day,i)=>!validDay(day)||i&&day<=dates[i-1]))throw Error('Viprasol needs the ordered actual reference calendar');
 const sorted=events.slice().sort((a,b)=>a.signalIndex-b.signalIndex||String(a.code).localeCompare(String(b.code))),lastExit=new Map();
 for(const event of sorted){
  if(!['string','number'].includes(typeof event.code)||event.code===''||!Number.isInteger(event.signalIndex)||event.signalIndex<0||event.entryIndex!==event.signalIndex+1||event.exitIndex!==event.signalIndex+policy.horizon||event.exitIndex>=dates.length||![3,5,10,15].every(horizon=>finite(event.returns?.[horizon]))||![event.returnPercent,event.excessPercent,event.drawdownPercent].every(finite)||event.drawdownPercent<0||event.returns[15]!==event.returnPercent)throw Error('Viprasol mature next-open event invalid');
  if(event.entryIndex<=(lastExit.get(event.code)??-1))throw Error('Viprasol holdings overlap; reserve at signal time before looking at outcomes');
  lastExit.set(event.code,event.exitIndex);
 }
 const matureEnd=dates.length-1-policy.horizon;
 const fit=summarizeEvents(sorted.filter(event=>event.signalIndex>matureEnd-policy.trainDays&&event.signalIndex<=matureEnd),dates);
 const recent=summarizeEvents(sorted.filter(event=>event.signalIndex>matureEnd-policy.recentDays&&event.signalIndex<=matureEnd),dates);
 const rolling=walkForward(sorted,dates,{patternCount:definitions.length});
 const {selectedEvents,stats,...rollingMetadata}=rolling,validation={...stats,...rollingMetadata};
 const checks=[];
 for(const [scope,value,kind]of [['fit',fit,'train'],['recent',recent,'recent'],['validation',validation,'validation']]){
  const prefix=kind==='train'?'minTrain':kind==='recent'?'minRecent':'minValidation';
  for(const [field,suffix]of [['sampleCount','Samples'],['stockCount','Stocks'],['signalDayCount','Dates']])checks.push({id:scope+'_'+field,scope,actual:value[field],operator:'>=',threshold:policy[prefix+suffix],passed:value[field]>=policy[prefix+suffix]});
  for(const field of ['meanReturnPercent','meanExcessPercent'])checks.push({id:scope+'_'+field,scope,actual:value[field],operator:'>',threshold:0,passed:value[field]!==null&&value[field]>0});
  checks.push({id:scope+'_positiveRate',scope,actual:value.positiveRate,operator:'>=',threshold:.5,passed:value.positiveRate!==null&&value.positiveRate>=.5});
 }
 checks.push({id:'history',scope:'validation',actual:rolling.status,operator:'=',threshold:'ready',passed:rolling.status==='ready'},
  {id:'positive_folds',scope:'validation',actual:rolling.positiveFoldCount||0,operator:'>=',threshold:policy.minPositiveFolds,passed:rolling.positiveFoldCount>=policy.minPositiveFolds},
  {id:'independent_blocks',scope:'validation',actual:rolling.blockCount,operator:'>=',threshold:policy.minIndependentBlocks,passed:rolling.blockCount>=policy.minIndependentBlocks},
  {id:'familywise_13',scope:'validation',actual:rolling.adjustedPValue,operator:'<=',threshold:policy.familywiseAlpha,passed:rolling.adjustedPValue!==null&&rolling.adjustedPValue<=policy.familywiseAlpha});
 const statisticalGatePassed=checks.every(check=>check.passed),reasons=checks.filter(check=>!check.passed).map(check=>check.id);
 return {fit,recent,validation,diagnostics:checks,statisticalGatePassed,reasons,status:statisticalGatePassed?'effective':!adequate(fit,'train')||!adequate(recent,'recent')||rolling.status!=='ready'?'insufficient':positive(fit)&&positive(recent)?'watch':'inactive'};
}

function approvalFor(rule,approvals,units,computed,implementationCommit){
 const found=approvals.find(item=>item.ruleId===rule.id),reasons=[];
 if(!implementationCommit)reasons.push('implementation_commit_unbound');
 if(!found)return {passed:false,approvedAt:null,implementationCommit,reasons:['native_review_allowlist_missing',...reasons]};
 if(found.nativeVerified!==true||found.coverageComplete!==true||found.evidenceKind!=='tradingview-pine-logs')reasons.push('native_scope_not_fully_reviewed');
 if(found.sourceCommit!==sourceCommit||found.studyVersion!==version||!equalParameters(found.parameters,rule.parameters))reasons.push('native_source_parameters_or_version_mismatch');
 if(typeof found.implementationCommit!=='string'||!/^[0-9a-f]{40}$/.test(found.implementationCommit)||found.implementationCommit!==implementationCommit)reasons.push('native_implementation_commit_mismatch');
 if(!Number.isInteger(found.nativeLongSignalCount)||found.nativeLongSignalCount<1)reasons.push('native_long_branch_unobserved');
 if(found.prefixStable!==true||!rule.prefixStable)reasons.push('native_prefix_stability_unverified');
 if(rule.volumeDependent&&(found.volumeSemanticsVerified!==true||typeof found.volumeUnit!=='string'||!found.volumeUnit||/unknown|unspecified|n\/a/i.test(found.volumeUnit)||!units.size||[...units].some(unit=>unit!==found.volumeUnit)))reasons.push('volume_semantics_unknown_or_mismatched');
 const approved=Date.parse(found.approvedAt);if(!finite(approved)||approved>computed)reasons.push('native_approval_time_unknown_or_future');
 return {passed:!reasons.length,approvedAt:finite(approved)?found.approvedAt:null,implementationCommit,reasons};
}
function currentWatch({stock,source,signal,aligned,reference,dates,day,asOf,computedAt,nextSessionDay,policyKnownAt}){
 if(!validDay(nextSessionDay)||nextSessionDay<=day)return null;
 const computed=Date.parse(computedAt),fetched=Date.parse(source.fetchedAt),asof=Date.parse(asOf),known=Date.parse(policyKnownAt),closed=Date.parse(closeAt(day)),until=nextSessionDay+'T09:30:00+08:00';
 if(![computed,fetched,asof,known].every(finite)||fetched<closed||asof<closed||fetched<asof||computed<Math.max(fetched,asof,known)||computed>=Date.parse(until))return null;
 if(aligned.slice(-61).length!==61||aligned.slice(-61).some(bar=>!validBar(bar))||aligned.at(-1).high===aligned.at(-1).low)return null;
 const strength=screen.evaluate({mode:'strength',bars:aligned.slice(-61),referenceBars:reference.slice(-61),day,lookback:20});if(strength.matched!==true)return null;
 return {code:stock.code,name:stock.name,signalDay:day,conditionKnownAfter:closeAt(day),sourceFetchedAt:source.fetchedAt,actualDiscoveryAt:computedAt,policyKnownAt,nextSessionDay,activeUntil:until,stage:'source_today_long_close',entryMode:'next_open_recheck_required',originalReference:{entry:scalar(signal.entry),stop:scalar(signal.stop),target:scalar(signal.target)},metrics:strength.metrics,actualFillVerified:false,requiresRecheck:true,nextOpenEligibility:'not_observed; apply the same next-open one-price/limit-up checks used by the outcome study'};
}
const scalar=value=>finite(value)?value:null;
function retainEvents(bucket,events,stockIndex){
 for(const event of events){const index=bucket.eventCount++,chunk=Math.floor(index/4096);bucket.chunks[chunk]||=new Float64Array(4096*8);bucket.chunks[chunk].set([stockIndex,event.signalIndex,event.returns[3],event.returns[5],event.returns[10],event.returns[15],event.excessPercent,event.drawdownPercent],index%4096*8);}
}
function expandEvents(bucket){
 const events=[];for(let index=0;index<bucket.eventCount;index++){const chunk=bucket.chunks[Math.floor(index/4096)],offset=index%4096*8,signalIndex=chunk[offset+1];events.push({code:chunk[offset],signalIndex,entryIndex:signalIndex+1,exitIndex:signalIndex+policy.horizon,returns:{3:chunk[offset+2],5:chunk[offset+3],10:chunk[offset+4],15:chunk[offset+5]},returnPercent:chunk[offset+5],excessPercent:chunk[offset+6],drawdownPercent:chunk[offset+7]});}bucket.chunks.length=0;return events;
}

/** Consumes an existing private batch; no network, publication, or historical-B fallback. */
export async function analyzeViprasolStudy({dataset,records=dataset?.records,day=dataset?.day,asOf=dataset?.asOf,sourceId,generation,implementationCommit=null,nativeApprovals=[],marketMetadata={},policyKnownAt=null,nextSessionDay=null,now=Date.now,evaluate=evaluateIndicator,onProgress=()=>{}}={}){
 const computed=now(),computedAt=new Date(computed).toISOString();
 const boundImplementation=typeof implementationCommit==='string'&&/^[0-9a-f]{40}$/.test(implementationCommit)?implementationCommit:null;
 if(!dataset||dataset.day!==day||dataset.asOf!==asOf||dataset.generation!==undefined&&dataset.generation!==generation||dataset.sourceId!==undefined&&dataset.sourceId!==sourceId||!validDay(day)||typeof sourceId!=='string'||!sourceId||typeof generation!=='string'||!generation||!finite(Date.parse(asOf))||Date.parse(asOf)<Date.parse(closeAt(day))||Date.parse(asOf)>computed||!Array.isArray(nativeApprovals)||new Set(nativeApprovals.map(item=>item.ruleId)).size!==nativeApprovals.length||nativeApprovals.some(item=>!ids.includes(item.ruleId)))throw Error('Viprasol study batch/approval binding invalid');
 const reference=dataset.reference;if(reference?.code!=='000300.SH'||!Array.isArray(reference.bars)||!reference.bars.length||reference.bars.length>500||reference.bars.some((bar,i)=>!validBar(bar)||i&&bar.date<=reference.bars[i-1].date)||reference.bars.at(-1).date!==day)throw Error('Viprasol needs the complete same-day bounded reference history');
 const dates=reference.bars.map(bar=>bar.date);if(dates.some(date=>date>day))throw Error('Viprasol reference contains future data');
 if(!records||!records[Symbol.iterator]&&!records[Symbol.asyncIterator])throw Error('Viprasol source records missing');
 const syntheticEvaluator=evaluate!==evaluateIndicator,buckets=new Map(definitions.map(rule=>[rule.id,{chunks:[],eventCount:0,current:[],units:new Set(),counts:{stocksEvaluated:0,longSignals:0,duplicateSession:0,overlapReserved:0,outsideReferenceHistory:0,ready:0,pending:0,unavailable:0,unexecutable:0,missingDependencies:0,prefixUnstable:0,unverifiedSourceTime:0}}])),seen=new Set();let riskExcluded=0,missingStocks=0;
 for await(const {stock,source}of records){
  if(!/^\d{6}\.(SH|SZ)$/.test(stock?.code||'')||seen.has(stock.code)||source?.sourceId!==sourceId||source.day!==day||!['ready','unavailable'].includes(source.status)||source.adjustment!=='qfq'||!Array.isArray(source.bars)||source.bars.length>500||source.bars.some((bar,i)=>!validDay(bar.date)||bar.date>day||i&&bar.date<=source.bars[i-1].date))throw Error('Viprasol source identity/date/order/adjustment mismatch');
  seen.add(stock.code);if(pool.riskName({name:stock.name||''})){riskExcluded++;continue;}
  if(!source.bars.length||source.bars.some(bar=>!validBar(bar))){missingStocks++;continue;}
  const bars=source.bars.map(bar=>({...bar,time:dateKey(bar.date)})),metadata=marketMetadata[stock.code]||{},context={symbol:stock.code,timeframe:'1D',intervalMs:86400000,...(metadata.mintickVerified===true&&finite(metadata.mintick)&&metadata.mintick>0?{mintick:metadata.mintick}:{})};
  for(const rule of definitions){
   const bucket=buckets.get(rule.id);if(!rule.prefixStable){bucket.counts.prefixUnstable++;continue;}
   const result=evaluate(rule.id,bars,rule.parameters,context);if(result.status!=='ready'){bucket.counts.missingDependencies++;continue;}
   if(!Array.isArray(result.signals))throw Error('Viprasol registry output missing original signals');
   const outcome=collectRuleEvents({signals:result.signals,bars:source.bars,reference:reference.bars,dates,code:stock.code});
   bucket.counts.stocksEvaluated++;bucket.units.add(source.volumeUnit||'unknown');retainEvents(bucket,outcome.events,seen.size);
   const fetched=Date.parse(source.fetchedAt);if(!finite(fetched)||fetched<Date.parse(asOf)||fetched>computed)bucket.counts.unverifiedSourceTime++;
   for(const [key,value]of Object.entries(outcome.counts))bucket.counts[key]+=value;
   if(source.status==='ready'&&source.bars.at(-1).date===day&&outcome.today.length){
    const candidate=currentWatch({stock,source,signal:outcome.today[0],aligned:outcome.aligned,reference:reference.bars,dates,day,asOf,computedAt,nextSessionDay,policyKnownAt});if(candidate)bucket.current.push(candidate);
   }
  }
  if(seen.size%50===0)await onProgress({stage:'viprasol-research',checked:seen.size,total:dataset.expectedCount||null});
 }
 if(dataset.expectedCount!==undefined&&dataset.expectedCount!==seen.size)throw Error('Viprasol source batch coverage incomplete');
 const rules=[],current=[];
 for(const rule of definitions){
  const bucket=buckets.get(rule.id),statistics=validateViprasolEvents(expandEvents(bucket),dates),native=approvalFor(rule,nativeApprovals,bucket.units,computed,boundImplementation),reasons=[...native.reasons,...statistics.reasons];
  if(!rule.prefixStable)reasons.push('original_lastbar_branch_is_not_prefix_stable');
  if(!bucket.counts.longSignals)reasons.push('no_original_long_signal_observed');
  if(bucket.counts.unverifiedSourceTime)reasons.push('source_fetch_time_unknown_or_not_bound_to_closed_batch');
  if(syntheticEvaluator)reasons.push('synthetic_evaluator_not_native_evidence');
  const eligible=native.passed&&statistics.statisticalGatePassed&&rule.prefixStable&&bucket.counts.longSignals>0&&!bucket.counts.unverifiedSourceTime&&!syntheticEvaluator;
  rules.push({...rule,counts:bucket.counts,volumeUnits:[...bucket.units],...statistics,nativeGate:native,eligibleForSelection:eligible,status:eligible?'effective':!native.passed||!rule.prefixStable?'blocked':statistics.status,reasons});
  for(const item of bucket.current)current.push({...item,ruleId:rule.id,day,asOf,sourceId,generation,eligibleForSelection:eligible,reasons:eligible?[]:reasons});
 }
 return {schema:'books.a-share.viprasol-study.v1',version,familyId,completed:true,sourceCommit,implementationCommit:boundImplementation,day,asOf,sourceId,generation,computedAt,policy,validationFamily:{id:familyId,hypothesisCount:definitions.length,correction:'Bonferroni',parameters:'original defaults frozen; original long branches pooled per indicator',separateFrom:['fixed-shape-next-open-v1','key-k-entry-16']},coverage:{universeCount:seen.size,historyDays:dates.length,historyStart:dates[0],historyEnd:day,riskExcluded,missingStocks,universeBasis:dataset.universeMetadata?.basis||'current-roster-retrospective'},rules,current,summary:{ruleCount:definitions.length,statisticalPassedCount:rules.filter(rule=>rule.statisticalGatePassed).length,nativeApprovedCount:rules.filter(rule=>rule.nativeGate.passed).length,effectiveCount:rules.filter(rule=>rule.eligibleForSelection).length,currentCount:current.length,qualifiedCurrentCount:current.filter(item=>item.eligibleForSelection).length},eligibleForSelection:current.some(item=>item.eligibleForSelection),method:{entry:'Original long condition known at source-day close; independent research entry is next actual open, exit source signal+15 sessions close. Original entry/SL/TP remain references, not assumed fills.',outcome:'3/5/10/15 net returns share the same mature 15-session cohort; close-path drawdown; 0.30 percentage-point cost; target >=5%. No simulated stop/target fills or same-day A-share sell.',validation:'Fixed 120/60/180 signal-day windows, 15-session purge, 20-session folds; only preselected training folds; 15-session nonoverlap anchors, >=3 stocks per anchor; fixed 13-hypothesis Bonferroni, all existing thresholds unchanged.',current:'Only original long event on the last source date plus existing early-strength and anti-chase defaults; next verified session recheck needed; no historical marker fallback.',timestamp:'Date-only provider bars use UTC date keys solely to call OHLCV arithmetic. These keys are not claimed as exchange open times. Condition known-after close, source fetch, discovery and next-session times are separate.',limitations:'Current-roster retrospective history has survivorship bias. Native review binds the exact JS implementation commit as well as original source/defaults/study version and covered long branch. Only the three explicitly audited price-only rules omit the volume-unit gate; other rules require reviewed volume semantics. Missing official tick metadata blocks dependent ports. No trading execution or publication occurs here.'}};
}
