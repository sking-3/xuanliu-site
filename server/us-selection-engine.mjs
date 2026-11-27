export const version='books.us.selection.rules.2026-11-26.v1';
export const trendExitVersion='books.us.trend-exit.v1';
export const horizons=[1,2,3,5,15];
export const parameters=Object.freeze({minPrice:5,minDollarVolume20:10000000,breakVolume:1.5,maxExtension:.15,nearHigh:.03,pullbackDistanceMA20:.02,pullbackMaxExtension:.06,pullbackMaxReturn20:.15,pullbackMaxReturn5:.08,pullbackCloseLocation:.6,maxEntryATR:.5});
const finite=Number.isFinite,mean=a=>a.reduce((sum,x)=>sum+x,0)/a.length,round=x=>Math.round((x+Number.EPSILON)*100)/100;
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&finite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export function validBars(bars){return Array.isArray(bars)&&bars.length>0&&bars.every((b,i)=>validDate(b.date)&&(!i||b.date>bars[i-1].date)&&['open','high','low','close','volume'].every(k=>finite(b[k])&&(k==='volume'?b[k]>=0:b[k]>0))&&b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close));}
export function latestSession(calendar,now=Date.now()){
 const latest=calendar.latestClosed('US',now);
 if(!latest)throw Error('US calendar is unverified for this year; no session inferred');
 return latest;
}
export function metrics(bars,benchmark){
 const last=bars.at(-1),closes=bars.map(b=>b.close),ma20=mean(closes.slice(-20)),ma50=mean(closes.slice(-50)),reference=new Map(benchmark.map(b=>[b.date,b.close]));
 const start=reference.get(bars.at(-21).date),end=reference.get(last.date);
 const tr=bars.slice(1).map((b,i)=>Math.max(b.high-b.low,Math.abs(b.high-bars[i].close),Math.abs(b.low-bars[i].close)));
 let atr=mean(tr.slice(0,14));for(const value of tr.slice(14))atr=(atr*13+value)/14;
 const exactAmount=bars.slice(-20).every(b=>finite(b.amount)&&b.amount>0);
 return {close:last.close,ma20,ma50,ma50Up:ma50>mean(closes.slice(-51,-1)),rvol:last.volume/mean(bars.slice(-21,-1).map(b=>b.volume)),high20:Math.max(...bars.slice(-21,-1).map(b=>b.high)),return20Percent:(last.close/bars.at(-21).close-1)*100,return5Percent:(last.close/bars.at(-6).close-1)*100,excess20Percent:start&&end?(last.close/bars.at(-21).close-end/start)*100:null,atr14:atr,atrMethod:'wilder_true_range_14',dollarVolume20Proxy:mean(bars.slice(-20).map(b=>b.close*b.volume)),dollarVolume20:exactAmount?mean(bars.slice(-20).map(b=>b.amount)):null,turnoverMethod:exactAmount?'provider_amount':'close_times_provider_volume_proxy'};
}
export function classify(bars,reference){
 const m=metrics(bars,reference),last=bars.at(-1),prior=bars.at(-2),hits=[];
 const liquidity=m.dollarVolume20??m.dollarVolume20Proxy;
 if(m.close<parameters.minPrice||liquidity<parameters.minDollarVolume20)return {metrics:m,hits,reasons:['价格或20日均成交额不满足原门槛']};
 const trend=m.close>m.ma20&&m.ma20>m.ma50&&m.ma50Up&&m.excess20Percent!==null&&m.excess20Percent>0;
 const add=(rule,label,trigger,invalidation,status)=>hits.push({rule,label,status,qualified:false,signalDate:last.date,trigger:round(trigger+.01),invalidation:round(invalidation),maxEntry:round(trigger+.01+parameters.maxEntryATR*m.atr14),researchOnly:true});
 if(trend&&m.close/m.ma20-1<=parameters.maxExtension){
  if(m.close>m.high20&&m.rvol>=parameters.breakVolume)add('U2','放量突破',m.high20,Math.min(...bars.slice(-5).map(b=>b.low)),'B');
  if(m.close/m.high20>=1-parameters.nearHigh&&m.close/m.high20<=1)add('U3','临近突破',m.high20,Math.min(...bars.slice(-5).map(b=>b.low)),'waiting');
 }
 if(trend&&last.low<=m.ma20*(1+parameters.pullbackDistanceMA20)&&m.close/m.ma20<=1+parameters.pullbackMaxExtension&&last.close>prior.high&&last.close>last.open&&m.return20Percent<=parameters.pullbackMaxReturn20*100&&m.return5Percent<=parameters.pullbackMaxReturn5*100&&(last.close-last.low)/(last.high-last.low||1)>=parameters.pullbackCloseLocation)add('PULLBACK','趋势回踩后转强',last.high,last.low,'waiting');
 for(const hit of hits){if(hit.status==='B'&&m.close<hit.trigger)hit.status='waiting';}
 for(const hit of hits)if(hit.invalidation>=hit.trigger||m.close>hit.maxEntry){hit.status='invalid';hit.reason=m.close>hit.maxEntry?'已超过追价上限':'触发与失效结构无效';}
 return {metrics:m,hits,reasons:[]};
}
function followup(record,bars,dates,previous){
 const start=dates.indexOf(record.referenceDate),future=start<0?[]:dates.slice(start+1),byDate=new Map(bars.map(b=>[b.date,b])),result={};
 const sameAnchor=previous?.referenceDate===record.referenceDate&&previous.referenceClose===record.referenceClose;
 for(const horizon of horizons){
  if(sameAnchor&&previous.horizons?.[horizon]?.status==='ready'){result[horizon]=previous.horizons[horizon];continue;}
  if(start<0||future.length<horizon){result[horizon]={status:'pending',remainingSessions:Math.max(0,horizon-future.length)};continue;}
  const expected=future.slice(0,horizon),path=expected.map(date=>byDate.get(date));
  if(path.some(b=>!b)){result[horizon]={status:'data_missing',date:expected.at(-1)};continue;}
  let peak=record.referenceClose,drawdown=0;for(const b of path){peak=Math.max(peak,b.close);drawdown=Math.min(drawdown,b.close/peak-1);}
  result[horizon]={status:'ready',date:expected.at(-1),returnPercent:(path.at(-1).close/record.referenceClose-1)*100,maxAdversePercent:Math.min(0,...path.map(b=>b.low/record.referenceClose-1))*100,maxCloseDrawdownPercent:drawdown*100};
 }
 return {referenceDate:record.referenceDate,referenceClose:record.referenceClose,firstSeenAt:record.firstSeenAt,elapsedSessions:Math.max(future.length,sameAnchor?previous.elapsedSessions||0:0),basis:'first_observed_close_not_trade_fill',horizons:result};
}
function triggeredFollowup(record,bars,dates){
 const pending=Object.fromEntries(horizons.map(horizon=>[horizon,{status:'pending'}]));
 const base={referenceDate:record.triggerDate||null,referenceClose:record.triggerClose||null,firstSeenAt:record.triggerObservedAt||null,basis:'trigger_day_close_not_execution',researchOnly:true};
 if(!record.triggerDate)return {...base,status:'not_triggered',horizons:pending};
 if(!finite(record.triggerClose)){
  const saved=bars.find(bar=>bar.date===record.triggerDate);
  if(saved?.close>0){record.triggerClose=saved.close;record.triggerPriceSource='restored_saved_daily_close';record.triggerObservedAt=record.markers.find(marker=>marker.type==='B'&&marker.date===record.triggerDate)?.observedAt||null;}
 }
 if(!finite(record.triggerClose)||!dates.includes(record.triggerDate)&&record.triggerFollowup?.referenceDate!==record.triggerDate)return {...base,status:'price_missing',horizons:pending};
 const result=followup({referenceDate:record.triggerDate,referenceClose:record.triggerClose,firstSeenAt:record.triggerObservedAt||null},bars,dates,record.triggerFollowup);
 return {...result,status:horizons.every(horizon=>result.horizons[horizon].status==='ready')?'complete':'tracking',basis:base.basis,researchOnly:true,priceSource:record.triggerPriceSource||'recorded_daily_close'};
}
const validClose=bar=>bar&&validBars([bar])&&bar.volume>0;
const legacyExit=record=>record.markers?.some(marker=>marker.type==='S'&&marker.exitVersion!==trendExitVersion);
const positionOpen=record=>Boolean(record.triggerDate&&!legacyExit(record)&&record.trendPosition?.state!=='sold');

export function needsTrendHistory(record){
 const unfinished=follow=>!finite(follow?.elapsedSessions)||follow.elapsedSessions<15;
 return positionOpen(record)||unfinished(record.followup)||Boolean(record.triggerDate&&unfinished(record.triggerFollowup));
}

/** Evaluate only the target close; intermediate or future dates cannot create an exit. */
export function evaluateTrendExit({bars,dates,asOf,entryDate,invalidation}){
 const index=dates.indexOf(asOf),byDate=new Map(bars.map(bar=>[bar.date,bar])),today=byDate.get(asOf);
 if(index<0||!validClose(today))return {state:'data_missing',close:null,reason:'缺少本批有效收盘'};
 const holding={state:'holding',close:today.close};
 if(asOf<=entryDate)return holding;
 const exit=(rule,reason,level)=>({state:'sold',close:today.close,exit:{date:asOf,price:today.close,rule,reason,level}});
 if(finite(invalidation)&&today.close<invalidation)return exit('structure_close','收盘跌破B时冻结的保护位',invalidation);
 if(!dates[index-1]||dates[index-1]<=entryDate)return holding;
 const window=dates.slice(Math.max(0,index-20),index+1).map(date=>byDate.get(date));
 if(window.length!==21||!window.every(validClose))return {state:'data_missing',close:today.close,reason:'MA20核验缺少连续交易日日线'};
 const closes=window.map(bar=>bar.close),ma20=mean(closes.slice(1)),previousMa20=mean(closes.slice(0,20));
 if(today.close<ma20&&closes.at(-2)<previousMa20)return {...exit('ma20_two_closes','连续两个收盘低于各自MA20',ma20),previousMa20};
 return holding;
}

function targetCloseTime(asOf,observedAt,sessionClose){
 const closeTime=Date.parse(sessionClose||observedAt);
 return (!sessionClose||sessionClose.slice(0,10)===asOf)&&finite(closeTime)&&closeTime<=Date.parse(observedAt)?closeTime:null;
}

function updateTrend(record,bars,dates,asOf,observedAt,closeTime){
 if(!record.triggerDate||legacyExit(record)||record.trendPosition?.state==='sold')return;
 const entry={date:record.triggerDate,price:record.triggerClose,observedAt:record.triggerObservedAt||record.markers.find(marker=>marker.type==='B'&&marker.date===record.triggerDate)?.observedAt||null};
 if(!finite(entry.price)||entry.price<=0)return;
 const seen=Date.parse(entry.observedAt);
 const seenBefore=finite(seen)&&seen<closeTime;
 const result=finite(closeTime)&&(entry.date===asOf||seenBefore)?evaluateTrendExit({bars,dates,asOf,entryDate:entry.date,invalidation:record.invalidation}):
  {state:'data_missing',close:null,reason:'本批收盘时点或B的事前确认时间待核'};
 const from=dates.indexOf(entry.date),to=dates.indexOf(asOf),prior=record.trendPosition,previousIndex=dates.indexOf(prior?.asOf);
 const heldSessions=from>=0&&to>=from?to-from:previousIndex>=0&&to>=previousIndex&&finite(prior.heldSessions)?prior.heldSessions+to-previousIndex:null;
 const exit=result.exit?{...result.exit,observedAt,researchOnly:true,...(result.previousMa20?{previousMa20:result.previousMa20}:{})}:null;
 const reference={trigger:record.trigger,defense:record.invalidation,maxEntry:record.maxEntry};
 record.trendPosition={state:result.state,entry,exit,reference,heldSessions,returnPercent:finite(result.close)?(result.close/entry.price-1)*100:null,exitVersion:trendExitVersion,asOf,reason:exit?.reason||result.reason||null};
 if(exit)record.markers.push({date:asOf,type:'S',price:exit.price,observedAt,researchOnly:true,exitVersion:trendExitVersion,exitRule:exit.rule,reason:exit.reason});
}

function advance(record,bars,dates,asOf,observedAt,closeTime){
 const next={...record,markers:record.markers.slice(),followup:followup(record,bars,dates,record.followup)};
 if(record.membership==='active'&&!record.triggerDate){
  const first=dates.indexOf(record.referenceDate),eligible=new Set(first<0?[]:dates.slice(first+1,first+16));
  const future=bars.filter(b=>eligible.has(b.date)&&b.date<=asOf&&(!record.checkedThrough||b.date>record.checkedThrough));
  for(const b of future){
   if(next.status==='invalid')break;
   if(b.low<next.invalidation){next.status='invalid';next.markers.push({date:b.date,type:'X',price:b.close,observedAt,researchOnly:true,label:b.close<next.invalidation?'收盘失效观察':'日线触及失效位，盘中先后未知'});next.reason='结构失效或同日触发先后不可核验';break;}
   if(b.close>=next.trigger&&b.close<=next.maxEntry){
    if(b.date<asOf){next.status='invalid';next.reason='较早交易日已越过冻结B位，缺少当日确认记录';break;}
    if(!validClose(b)||!finite(closeTime)||!(Date.parse(next.firstSeenAt)<closeTime))break;
    next.triggerDate=b.date;next.triggerClose=b.close;next.triggerObservedAt=observedAt;next.status='B';next.markers.push({date:b.date,type:'B',price:b.close,observedAt,researchOnly:true,label:'收盘越过已冻结触发位，非成交'});break;
   }
   if(b.close>next.maxEntry){next.status='invalid';next.reason='超过事前冻结追价上限';}
  }
 }
 if(next.membership==='active'){
  if(next.status==='invalid')next.membership='invalidated';
  else if(next.followup.elapsedSessions>=15){next.membership='completed';if(!next.triggerDate){next.status='invalid';next.reason='15个交易日观察窗口到期，未形成B';}}
 }
 next.checkedThrough=asOf;
 next.triggerFollowup=triggeredFollowup(next,bars,dates);
 updateTrend(next,bars,dates,asOf,observedAt,closeTime);
 return next;
}

function appendTrendRows(rows,records,series,reference,asOf){
 const bySymbol=new Map(),present=new Set(rows.map(row=>row.symbol));
 for(const record of records){
  if(!bySymbol.has(record.symbol))bySymbol.set(record.symbol,[]);
  bySymbol.get(record.symbol).push(record);
 }
 function positionFor(list,currentHit){
  const tracked=list.filter(record=>record.trendPosition&&(positionOpen(record)||record.trendPosition.exit?.date===asOf));
  return tracked.find(record=>record.id===currentHit&&record.triggerDate===asOf)||
   tracked.findLast(record=>record.triggerDate===asOf)||tracked.findLast(record=>record.trendPosition.exit?.date===asOf)||
   tracked.reduce((latest,record)=>!latest||record.triggerDate>=latest.triggerDate?record:latest,null);
 }
 function show(row,list,record){
  if(record){
   row.trendPosition=record.trendPosition;
   row.triggerFollowup=record.triggerFollowup;
  }
  const markers=list.flatMap(item=>item.markers);
  const unique=new Map();
  for(const marker of markers){
   const key=marker.date+'|'+marker.type,existing=unique.get(key);
   if(!existing||marker.exitVersion===trendExitVersion&&existing.exitVersion!==trendExitVersion)unique.set(key,marker);
  }
  row.markers=[...unique.values()];
 }
 for(const row of rows){
  const list=bySymbol.get(row.symbol)||[],currentHit=row.hits.find(hit=>hit.rule===row.rule)?.trackingId;
  show(row,list,positionFor(list,currentHit));
 }
 for(const [symbol,list] of bySymbol){
  if(present.has(symbol))continue;
  const record=positionFor(list);
  if(!record)continue;
  const bars=(series[symbol]||[]).filter(bar=>bar.date<=asOf),last=bars.at(-1),hasClose=last?.date===asOf&&validClose(last);
  const label={U2:'放量突破',U3:'临近突破',PULLBACK:'趋势回踩后转强'}[record.rule]||record.rule;
  const hit={rule:record.rule,label,trackingId:record.id,trigger:record.trigger,invalidation:record.invalidation,maxEntry:record.maxEntry,
   signalDate:record.triggerDate,status:'B',phase:'tracking',isNewB:record.triggerDate===asOf,followup:record.followup,triggerFollowup:record.triggerFollowup,trendPosition:record.trendPosition};
  const row={...hit,symbol,name:record.name||symbol,exchange:'US',asOf:last?.date||record.triggerDate,close:hasClose?last.close:null,qualified:false,trackingOnly:true,
   hits:[hit],metrics:hasClose&&bars.length>=61?metrics(bars,reference):{},bars:bars.slice(-200),membership:'continuing',reasons:['已确认B的趋势跟踪，本批未入选买入筛选']};
  show(row,list,record);rows.push(row);
 }
}

export function updateTracking(previous,rows,series,reference,asOf,generatedAt,unavailable=new Set(),sessionClose){
 const dates=reference.map(b=>b.date),current=new Set(rows.flatMap(row=>row.hits.map(hit=>row.symbol+'|'+hit.rule))),priorRecords=previous?.records||[],byId=new Map();
 const closeTime=targetCloseTime(asOf,generatedAt,sessionClose);
 for(const record of priorRecords){
  const saved=byId.get(record.id);
  if(!saved||Date.parse(record.firstSeenAt)<Date.parse(saved.firstSeenAt))byId.set(record.id,record);
 }
 const duplicateIdsCollapsed=priorRecords.length-byId.size,records=[...byId.values()].map(record=>advance(record,series[record.symbol]||[],dates,asOf,generatedAt,closeTime));
 for(const row of rows){
  for(const hit of row.hits){
   const key=row.symbol+'|'+hit.rule,id=[version,row.symbol,hit.rule,asOf].join('|');
   let record=records.find(item=>item.id===id)||records.findLast(item=>item.key===key&&item.trendPosition?.exit?.date===asOf)||
    records.findLast(item=>item.key===key&&item.membership==='active'&&item.status!=='invalid'&&item.trendPosition?.state!=='sold'&&item.followup?.elapsedSessions<15);
   if(!record){
    const status=hit.status==='B'&&!finite(closeTime)?'waiting':hit.status,isB=status==='B';
    record={id,key,symbol:row.symbol,name:row.name,rule:hit.rule,referenceDate:asOf,referenceClose:row.close,firstSeenAt:generatedAt,lastSeenAt:generatedAt,trigger:hit.trigger,invalidation:hit.invalidation,maxEntry:hit.maxEntry,status,triggerDate:isB?asOf:null,triggerClose:isB?row.close:null,triggerObservedAt:isB?generatedAt:null,checkedThrough:asOf,membership:'active',markers:isB?[{date:asOf,type:'B',price:row.close,observedAt:generatedAt,researchOnly:true,label:'当批收盘突破观察，非实际成交'}]:[]};
    record.followup=followup(record,series[row.symbol],dates);record.triggerFollowup=triggeredFollowup(record,series[row.symbol],dates);
    updateTrend(record,series[row.symbol],dates,asOf,generatedAt,closeTime);records.push(record);
   }
   record.lastSeenAt=generatedAt;hit.trackingId=record.id;hit.firstSeenAt=record.firstSeenAt;hit.frozenTrigger=record.trigger;hit.frozenInvalidation=record.invalidation;
   hit.followup=record.followup;hit.triggerFollowup=record.triggerFollowup;hit.status=record.status;hit.trigger=record.trigger;hit.invalidation=record.invalidation;hit.maxEntry=record.maxEntry;hit.signalDate=record.triggerDate||record.referenceDate;hit.isNewB=record.triggerDate===asOf;hit.phase=record.triggerDate&&record.triggerDate!==asOf?'tracking':record.status==='B'?'current_B':'waiting';
   if(record.trendPosition)hit.trendPosition=record.trendPosition;
  }
  row.followup=null;
  const primary=row.hits.find(hit=>hit.status==='B'&&hit.isNewB)||row.hits.find(hit=>hit.rule===row.rule)||row.hits[0];
  row.followup=primary.followup;row.triggerFollowup=primary.triggerFollowup;row.membership=primary.followup.referenceDate===asOf?'new':'continuing';
  for(const key of ['rule','label','status','trigger','invalidation','maxEntry','signalDate','isNewB','phase'])row[key]=primary[key];
  if(row.phase==='tracking')row.label='B后跟踪 · '+row.signalDate;
  row.reasons.push('观察价位冻结于 '+(primary.followup?.referenceDate||asOf));
 }
 for(const record of records)if(record.membership==='active'&&!current.has(record.key)&&!unavailable.has(record.symbol)){record.membership='exited';record.exitObservedAt=generatedAt;}
 appendTrendRows(rows,records,series,reference,asOf);
 const matured=records.filter(record=>record.followup?.horizons?.[3]?.status==='ready'),maturedTriggered=records.filter(record=>record.triggerFollowup?.horizons?.[3]?.status==='ready');
 return {schema:'books.us.tracking.v1',version,asOf,generatedAt,records,summary:{observations:records.length,duplicateIdsCollapsed,active:records.filter(r=>r.membership==='active').length,matured3:matured.length,maturedTriggered3:maturedTriggered.length,meanTriggeredReturn3Percent:maturedTriggered.length?mean(maturedTriggered.map(r=>r.triggerFollowup.horizons[3].returnPercent)):null,meanReturn3Percent:matured.length?mean(matured.map(r=>r.followup.horizons[3].returnPercent)):null,basis:'first_observed_close_not_execution'}};
}
export function buildSelection(input,{previousLedger=null,previousSnapshot=null,now=Date.now()}={}){
 const {asOf,universe,series,benchmarks,scope,source}=input,generatedAt=new Date(now).toISOString();
 if(previousLedger&&(previousLedger.version!==version||previousLedger.sourceId&&previousLedger.sourceId!==source.id))throw Error('US tracking policy/source changed; explicit migration required');
 if(!validDate(asOf)||!Array.isArray(universe)||!universe.length||new Set(universe.map(s=>s.symbol)).size!==universe.length)throw Error('US universe/date is missing or duplicated');
 for(const symbol of ['SPY','QQQ'])if(!validBars(benchmarks[symbol])||benchmarks[symbol].length<201||benchmarks[symbol].at(-1).date!==asOf)throw Error(symbol+' benchmark history/date is incomplete');
 const reference=benchmarks.SPY,rows=[],diagnostics=input.diagnostics?.slice()||[],seriesForTracking={...series};
 let covered=input.coverageMetrics?.covered||0,aboveMA20=input.coverageMetrics?.aboveMA20||0;
 if(input.screenedRows)rows.push(...input.screenedRows);
 else for(const stock of universe){
  const analyzed=analyzeStock(stock,series[stock.symbol],reference,asOf,source);
  if(analyzed.diagnostic){diagnostics.push(analyzed.diagnostic);continue;}
  covered++;if(analyzed.aboveMA20)aboveMA20++;if(analyzed.row)rows.push(analyzed.row);
 }
 rows.sort((a,b)=>Math.abs(a.trigger/a.close-1)-Math.abs(b.trigger/b.close-1));
 const marketBenchmarks=Object.fromEntries(['SPY','QQQ'].map(symbol=>{const bars=benchmarks[symbol],closes=bars.map(b=>b.close);return [symbol,{date:asOf,close:closes.at(-1),ma20:mean(closes.slice(-20)),ma50:mean(closes.slice(-50)),ma200:mean(closes.slice(-200)),return20Percent:(closes.at(-1)/closes.at(-21)-1)*100}];}));
 const states=Object.values(marketBenchmarks).map(m=>m.close>m.ma20&&m.ma20>m.ma50?'strong':m.close<m.ma20&&m.ma20<m.ma50?'weak':'mixed'),market={regime:states.every(s=>s==='weak')?'weak':states.every(s=>s==='strong')?'strong':'mixed',benchmarks:marketBenchmarks,breadth:{aboveMA20,total:covered,percent:covered?aboveMA20/covered*100:null},usedForEligibility:false};
 const ledger=updateTracking(previousLedger,rows,seriesForTracking,reference,asOf,generatedAt,new Set(diagnostics.map(d=>d.symbol)),source.sourceTime),hitCounts={U2:0,U3:0,PULLBACK:0};for(const row of rows)if(!row.trackingOnly)for(const hit of row.hits)hitCounts[hit.rule]++;
 ledger.sourceId=source.id;
 const snapshot={schema:'books.us.selection.v1',version,generatedAt,asOf,scope:{...scope,expected:universe.length,covered},source,market,short:{parameters,rows,hitCounts,diagnostics,status:covered?'ready':'empty',qualification:'unvalidated_research_observations',originalRulesUnchanged:true},tracking:{...ledger.summary,horizons,rows:ledger.records.map(({markers,...record})=>record)},previousAsOf:previousSnapshot?.asOf||null};
 return {snapshot,ledger};
}

export function analyzeStock(stock,bars,reference,asOf,source={}){
 const dates=reference.slice(-61).map(b=>b.date);
 if(!validBars(bars)||bars.length<61||bars.slice(-61).some(b=>b.volume<=0)||bars.at(-1).date!==asOf||JSON.stringify(bars.slice(-61).map(b=>b.date))!==JSON.stringify(dates))return {diagnostic:{symbol:stock.symbol,reason:'缺少同日连续61根有效日线',lastDate:bars?.at(-1)?.date||null,bars:bars?.length||0}};
 const result=classify(bars,reference),aboveMA20=result.metrics.close>result.metrics.ma20;
 if(!result.hits.length)return {aboveMA20,row:null};
 const hit=result.hits.find(item=>item.status==='B')||result.hits[0];
 return {aboveMA20,row:{symbol:stock.symbol,name:stock.name||stock.symbol,exchange:stock.exchange||'US',asOf,close:result.metrics.close,rule:hit.rule,label:hit.label,status:hit.status,qualified:false,trigger:hit.trigger,invalidation:hit.invalidation,maxEntry:hit.maxEntry,hits:result.hits,metrics:result.metrics,reasons:['固定规则技术观察；尚无独立滚动验证优势','不代表实际委托或成交',...(stock.securityQualified?[]:['普通股交易资格尚未独立核验']),...(source.corporateActionsVerified?[]:['免费源历史复权因子明细不可逐笔核验'])],bars:bars.slice(-200),markers:[],followup:null}};
}
