/* Pure, read-only projections of the plaza's committed snapshots. No provider calls. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HomeTraderData=api;})(typeof globalThis==='undefined'?this:globalThis,function(){
'use strict';
const PERIODS=['30D','90D','365D'],ALL_PERIODS=['7D','30D','90D','180D','365D','ALL'];
const LIMITS={feed:2097152,portfolios:4194304,analytics:2097152};
const HOUR=3600000,DAY=86400000,ADDRESS=/^0x[0-9a-f]{40}$/;
const SCOPE='Hyperliquid · 本站月度盈亏前200候选中的已核验记录，非全市场';
function fail(){throw Error('Invalid home trader snapshot');}
function object(v){if(!v||typeof v!=='object'||Array.isArray(v))fail();return v;}
function number(v,nullable=true){if(v===null&&nullable)return null;if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>=1e20)fail();return v;}
function count(v,max=20000){if(!Number.isSafeInteger(v)||v<0||v>max)fail();return v;}
function text(v,max=200){if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f\u007f]/.test(v))fail();return v.trim();}
function stamp(v,now,nullable=false){if(v===null&&nullable)return null;if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v))fail();const [y,m,d]=v.slice(0,10).split('-').map(Number),t=Date.parse(v);if(y<1990||m<1||m>12||d<1||d>new Date(Date.UTC(y,m,0)).getUTCDate()||!Number.isFinite(t)||t>now+5000)fail();return v;}
function address(v){if(typeof v!=='string'||!ADDRESS.test(v))fail();return v;}
function decode(raw,kind){let p=raw,encoded;if(typeof raw==='string'){encoded=raw;try{p=JSON.parse(raw);}catch(_){fail();}}else{try{encoded=JSON.stringify(raw);}catch(_){fail();}}if(typeof encoded!=='string'||new TextEncoder().encode(encoded).length>LIMITS[kind])fail();object(p);return p;}
function timeOrder(a,b){if(a&&b&&Date.parse(a)>Date.parse(b)+5000)fail();}
function validateFeed(raw,now=Date.now()){
 const p=decode(raw,'feed'),s=object(p.source);
 if(p.schemaVersion!==1||!['ready','unavailable'].includes(p.status)||!Array.isArray(p.traders)||p.traders.length>200||s.id!=='hyperliquid'||s.url!=='https://app.hyperliquid.xyz/leaderboard'||!['ok','stale','error'].includes(s.status))fail();
 const source={id:s.id,url:s.url,label:text(s.label,80),selection:text(s.selection,250),status:s.status,fetchedAt:stamp(s.fetchedAt,now,true),snapshotAt:stamp(s.snapshotAt,now,true),lastAttemptAt:stamp(s.lastAttemptAt,now),refreshIntervalMinutes:s.refreshIntervalMinutes,staleAfterMinutes:s.staleAfterMinutes,totalAccounts:count(s.totalAccounts,1000000),selectedAccounts:count(s.selectedAccounts,200)};
 if(source.selectedAccounts!==p.traders.length||source.totalAccounts<source.selectedAccounts||source.refreshIntervalMinutes!==30||source.staleAfterMinutes!==120)fail();
 if(p.status==='unavailable'){if(p.traders.length||source.fetchedAt!==null||source.status!=='error')fail();return {schemaVersion:1,status:p.status,source,traders:[]};}
 if(!source.fetchedAt||source.status==='error')fail();timeOrder(source.snapshotAt,source.fetchedAt);timeOrder(source.fetchedAt,source.lastAttemptAt);
 if(s.positionVerification!==undefined){const v=object(s.positionVerification);if(v.scope!=='default_perp_dex'||v.maxAgeMinutes!==60)fail();const clean={scope:v.scope,maxAgeMinutes:60,completedAt:stamp(v.completedAt,now)};for(const k of ['candidateAccounts','checkedAccounts','holdingAccounts','emptyAccounts','failedAccounts','unattemptedAccounts'])clean[k]=count(v[k],200);if(clean.holdingAccounts!==p.traders.length||clean.candidateAccounts>source.totalAccounts||clean.checkedAccounts!==clean.holdingAccounts+clean.emptyAccounts||clean.checkedAccounts+clean.failedAccounts+clean.unattemptedAccounts!==clean.candidateAccounts)fail();source.positionVerification=clean;}
 const ids=new Set(),traders=p.traders.map(rawRow=>{const r=object(rawRow),accountId=address(r.accountId),id='hl-'+accountId;
  if(r.id!==id||ids.has(id)||r.exchange!=='Hyperliquid'||r.currency!=='USD'||r.sourceKind!=='public_account'||r.sourceUrl!=='https://app.hyperliquid.xyz/explorer/address/'+accountId||r.observedAt!==source.fetchedAt)fail();ids.add(id);
  const windows={};for(const [period,w0]of Object.entries(object(r.windows))){const w=object(w0),sourcePeriod=({'7D':'week','30D':'month',ALL:'allTime'})[period];if(!sourcePeriod||w.sourcePeriod!==sourcePeriod||w.asOf!==(source.snapshotAt||source.fetchedAt)||w.asOfType!==(source.snapshotAt?'source':'observed'))fail();windows[period]={asOf:stamp(w.asOf,now),sourcePeriod,asOfType:w.asOfType,pnl:number(w.pnl),roi:number(w.roi)};}
  const row={id,accountId,name:text(r.name,100),exchange:'Hyperliquid',currency:'USD',sourceKind:'public_account',sourceUrl:r.sourceUrl,observedAt:source.fetchedAt,windows,positionCheck:null};
  if(r.positionCheck!==undefined){const c=object(r.positionCheck);if(c.scope!=='default_perp_dex'||count(c.count,1000)<1)fail();const checkedAt=stamp(c.checkedAt,now),sourceTime=stamp(c.sourceTime,now),lag=Date.parse(checkedAt)-Date.parse(sourceTime);if(lag>120000||lag< -5000)fail();if(!source.positionVerification)fail();timeOrder(checkedAt,source.positionVerification.completedAt);row.positionCheck={scope:c.scope,count:c.count,checkedAt,sourceTime};}
  return row;
 });return {schemaVersion:1,status:p.status,source,traders};
}
function cacheBase(raw,kind,method,now){const p=decode(raw,kind),s=object(p.source);if(p.schemaVersion!==1||p.methodVersion!==method||s.id!=='hyperliquid'||s.endpoint!=='https://api.hyperliquid.xyz/info'||!['ready','partial','unavailable'].includes(s.status)||s.staleAfterMinutes!==60)fail();const generatedAt=stamp(p.generatedAt,now),accounts=object(p.accounts);if(Object.keys(accounts).length>200)fail();const source={id:s.id,endpoint:s.endpoint,status:s.status,staleAfterMinutes:60,stopCode:s.stopCode===null?null:text(s.stopCode,80),startedAt:stamp(s.startedAt,now),completedAt:stamp(s.completedAt,now)};timeOrder(source.startedAt,source.completedAt);timeOrder(source.completedAt,generatedAt);return {p,accounts,result:{schemaVersion:1,methodVersion:method,generatedAt,source,accounts:Object.create(null)}};}
function cacheEntry(raw,generatedAt,now){const e=object(raw);if(!['ready','stale','unavailable'].includes(e.status))fail();const clean={status:e.status,fetchedAt:stamp(e.fetchedAt,now,true),lastAttemptAt:stamp(e.lastAttemptAt,now,true),errorCode:e.errorCode===null?null:text(e.errorCode,80)};timeOrder(clean.fetchedAt,generatedAt);timeOrder(clean.lastAttemptAt,generatedAt);return clean;}
function validatePortfolios(raw,now=Date.now()){
 const {accounts,result}=cacheBase(raw,'portfolios','portfolio-periods-v2',now);
 for(const [key,rawEntry]of Object.entries(accounts)){address(key);const e=cacheEntry(rawEntry,result.generatedAt,now);if(rawEntry.portfolio===null){if(e.fetchedAt!==null||e.status!=='unavailable')fail();result.accounts[key]={...e,portfolio:null};continue;}if(!e.fetchedAt||e.status==='unavailable')fail();const rawWindows=object(object(rawEntry.portfolio).windows),windows={};if(!Object.keys(rawWindows).length||Object.keys(rawWindows).length>6)fail();
  for(const [period,w0]of Object.entries(rawWindows)){const w=object(w0),derived=['90D','180D','365D'].includes(period),sourcePeriod=derived||period==='ALL'?'perpAllTime':period==='7D'?'perpWeek':'perpMonth';if(!ALL_PERIODS.includes(period)||w.derived!==derived||w.sourcePeriod!==sourcePeriod||w.scope!=='perp_account'||w.curveUnit!=='USD'||w.curveBasis!=='pnl_change_from_first_sample'||w.mddUnit!=='percent'||w.mddMethod!==(derived?'window_pnl_peak_equity':'hyperliquid_ui_pnl_peak_equity'))fail();
   if(w.requestedDays!==(derived?parseInt(period,10):null)||!['source_window','full','sampled_boundary','insufficient_history'].includes(w.coverageStatus)||(!derived&&w.coverageStatus!=='source_window')||(derived&&w.coverageStatus==='source_window'))fail();
   const c={sourcePeriod,derived,scope:w.scope,curveUnit:w.curveUnit,curveBasis:w.curveBasis,mddMethod:w.mddMethod,mddUnit:w.mddUnit,requestedDays:w.requestedDays,coverageStatus:w.coverageStatus,points:[]};
   for(const field of ['startAt','endAt','requestedStartAt','requestedEndAt','sourceHistoryStartAt','sourceHistoryEndAt']){c[field]=stamp(w[field],now,true);timeOrder(c[field],e.fetchedAt);}
   for(const field of ['sampleCount','sourceSampleCount','mddPairedSampleCount'])c[field]=count(w[field]);
   for(const field of ['pnl','mdd','coverageDays','maxSampleGapMs'])c[field]=number(w[field]);
   c.mddUnavailableReason=w.mddUnavailableReason===null?null:text(w.mddUnavailableReason,100);
   if(c.coverageDays===null||c.coverageDays<0||(c.maxSampleGapMs!==null&&c.maxSampleGapMs<0)||c.sourceSampleCount<c.sampleCount||c.mddPairedSampleCount>c.sampleCount||c.mdd!==null&&c.mdd<0)fail();
   if(c.mdd===null?(!['insufficient_samples','unpaired_samples','non_positive_peak_equity','no_valid_peak','invalid_denominator'].includes(c.mddUnavailableReason)||c.mddPairedSampleCount!==0):(c.mddUnavailableReason!==null||c.sampleCount<2||c.mddPairedSampleCount!==c.sampleCount))fail();
   if(derived){if(w.roi!==null||w.roiUnavailableReason!=='cash_flow_adjusted_return_unavailable')fail();c.roi=null;c.roiUnavailableReason=w.roiUnavailableReason;}
   if(!Array.isArray(w.points)||w.points.length>240||w.points.length>c.sampleCount||c.sampleCount>1&&w.points.length<2)fail();let previous=-Infinity;
   for(const rawPoint of w.points){const point=object(rawPoint),t=stamp(point.time,now),value=number(point.value,false),ms=Date.parse(t);if(ms<=previous||!c.startAt||!c.endAt||ms<Date.parse(c.startAt)||ms>Date.parse(c.endAt))fail();previous=ms;c.points.push({time:t,value});}
   if(!c.sampleCount){if(c.startAt!==null||c.endAt!==null||c.points.length||c.pnl!==null||c.coverageDays!==0)fail();}
   else{if(!c.startAt||!c.endAt||!c.sourceHistoryStartAt||!c.sourceHistoryEndAt||Date.parse(c.startAt)>Date.parse(c.endAt)||Date.parse(c.startAt)<Date.parse(c.sourceHistoryStartAt)||Date.parse(c.endAt)>Date.parse(c.sourceHistoryEndAt)||c.points[0]?.time!==c.startAt||c.points.at(-1)?.time!==c.endAt||c.points[0]?.value!==0||Math.abs(c.coverageDays-(Date.parse(c.endAt)-Date.parse(c.startAt))/DAY)>1e-8)fail();if(c.sampleCount===1?c.pnl!==null:c.pnl===null||Math.abs(c.pnl-c.points.at(-1).value)>1e-8*Math.max(1,Math.abs(c.pnl)))fail();}
   if(derived){if(!c.sampleCount){if(c.requestedStartAt!==null||c.requestedEndAt!==null||c.sourceHistoryStartAt!==null||c.sourceHistoryEndAt!==null||c.sourceSampleCount!==0||c.coverageStatus!=='insufficient_history')fail();}else{if(!c.requestedStartAt||!c.requestedEndAt||c.requestedEndAt!==c.sourceHistoryEndAt||Date.parse(c.requestedEndAt)-Date.parse(c.requestedStartAt)!==c.requestedDays*DAY||c.endAt!==c.requestedEndAt||Date.parse(c.startAt)<Date.parse(c.requestedStartAt))fail();if(c.coverageStatus==='full'&&c.startAt!==c.requestedStartAt||c.coverageStatus==='sampled_boundary'&&(Date.parse(c.sourceHistoryStartAt)>Date.parse(c.requestedStartAt)||Date.parse(c.startAt)<=Date.parse(c.requestedStartAt))||c.coverageStatus==='insufficient_history'&&Date.parse(c.sourceHistoryStartAt)<=Date.parse(c.requestedStartAt))fail();}}
   else if(c.requestedStartAt!==null||c.requestedEndAt!==c.endAt||c.sourceSampleCount!==c.sampleCount||c.sourceHistoryStartAt!==c.startAt||c.sourceHistoryEndAt!==c.endAt)fail();
   windows[period]=c;
  }result.accounts[key]={...e,portfolio:{windows}};
 }return result;
}
function validateAnalytics(raw,now=Date.now()){
 const {accounts,result}=cacheBase(raw,'analytics','closing-fill-v1',now);
 for(const [key,rawEntry]of Object.entries(accounts)){address(key);const e=cacheEntry(rawEntry,result.generatedAt,now);if(rawEntry.win===null){if(e.fetchedAt!==null||e.status!=='unavailable')fail();result.accounts[key]={...e,win:null};continue;}if(!e.fetchedAt||e.status==='unavailable')fail();const w=object(rawEntry.win);if(w.method!=='closing_fill_net_of_closing_fee'||w.scope!=='default_perp_dex'||w.unit!=='percent'||w.feeToken!=='USDC'||w.historyComplete!==false||w.includesOpeningFees!==false||w.includesFunding!==false||typeof w.capped!=='boolean')fail();const c={method:w.method,scope:w.scope,unit:w.unit,feeToken:w.feeToken,historyComplete:false,includesOpeningFees:false,includesFunding:false,capped:w.capped};
  for(const field of ['winning','losing','breakeven','eligibleCount','totalFills','receivedFills','duplicateCount','excludedCount'])c[field]=count(w[field],2000);
  if(c.winning+c.losing+c.breakeven!==c.eligibleCount||c.eligibleCount+c.excludedCount!==c.totalFills||c.totalFills+c.duplicateCount!==c.receivedFills||c.capped!==(c.receivedFills===2000))fail();c.value=number(w.value);if(c.eligibleCount===0?c.value!==null:c.value===null||c.value<0||c.value>100||Math.abs(c.value-c.winning/c.eligibleCount*100)>1e-8)fail();
  for(const field of ['startAt','endAt','sourceSampleStartAt','sourceSampleEndAt']){c[field]=stamp(w[field],now,true);timeOrder(c[field],e.fetchedAt);}
  for(const [n,start,end]of [[c.eligibleCount,c.startAt,c.endAt],[c.totalFills,c.sourceSampleStartAt,c.sourceSampleEndAt]])if(n===0?(start!==null||end!==null):(!start||!end||Date.parse(start)>Date.parse(end)))fail();if(c.startAt&&(Date.parse(c.startAt)<Date.parse(c.sourceSampleStartAt)||Date.parse(c.endAt)>Date.parse(c.sourceSampleEndAt)))fail();result.accounts[key]={...e,win:c};
 }return result;
}
function aged(at,now,limit){return !at||!Number.isFinite(Date.parse(at))||now-Date.parse(at)>limit||Date.parse(at)>now+5000;}
function cacheStale(cache,entry,failed,now){return !!failed||!entry||entry.status!=='ready'||cache?.source?.status!=='ready'||cache?.source?.stopCode!==null||aged(entry.fetchedAt,now,HOUR);}
function rank(input,period,now=Date.now()){
 if(!PERIODS.includes(period)||!Number.isFinite(now))fail();const {feed,portfolios,analytics,failures={}}=input||{},rows=[];
 if(!feed)return {period,rows,eligibleCount:0,stale:true,asOf:null,scope:SCOPE,note:'暂无可核验的榜单快照'};
 const source=feed.source,feedStale=!!failures.feed||source.status!=='ok'||aged(source.fetchedAt,now,2*HOUR)||aged(source.snapshotAt||source.fetchedAt,now,2*HOUR);
 for(const r of feed.traders){const pc=r.positionCheck;if(!source.positionVerification||!pc||pc.count<1)continue;
  const pe=portfolios?.accounts?.[r.accountId],w=pe?.portfolio?.windows?.[period],long=period!=='30D',native=r.windows['30D'];
  if(long&&(!w||!['full','sampled_boundary'].includes(w.coverageStatus)||w.sampleCount<2))continue;
  const pnl=long?w.pnl:native?.pnl;if(typeof pnl!=='number'||!Number.isFinite(pnl)||pnl<=0)continue;
  const currentHolding=!failures.feed&&source.status==='ok'&&!aged(pc.checkedAt,now,HOUR),performanceAsOf=long?w.endAt:native.asOf,performanceFetchedAt=long?pe.fetchedAt:source.fetchedAt;
  const performanceStale=long?cacheStale(portfolios,pe,failures.portfolios,now)||aged(w.endAt,now,HOUR):feedStale;
  const ae=analytics?.accounts?.[r.accountId],win=ae?.win,winRate=win&&win.eligibleCount>=20?win.value:null,winStale=cacheStale(analytics,ae,failures.analytics,now);
  const mdd=w&&w.mddUnavailableReason===null&&w.sampleCount>=2&&w.mddPairedSampleCount===w.sampleCount&&Number.isFinite(w.mdd)?w.mdd:null;
  rows.push({id:r.id,name:r.name,accountId:r.accountId,currency:'USD',pnl,roi:long?null:native.roi,mdd,mddFetchedAt:pe?.fetchedAt||null,mddAsOf:w?.endAt||null,mddStale:cacheStale(portfolios,pe,failures.portfolios,now)||aged(w?.endAt,now,HOUR),mddMethod:w?.mddMethod||null,winRate,winCount:win?.eligibleCount??0,winStart:win?.startAt||null,winEnd:win?.endAt||null,winFetchedAt:ae?.fetchedAt||null,winStale,winMethod:win?.method||null,winIncludesOpeningFees:false,winIncludesFunding:false,winHistoryComplete:false,performanceAsOf,performanceFetchedAt,performanceStale,coverageDays:w?.coverageDays??null,startAt:long?w.startAt:null,endAt:performanceAsOf,positionCheckedAt:pc.checkedAt,currentHolding,stale:performanceStale||!currentHolding});
 }
 rows.sort((a,b)=>b.pnl-a.pnl||a.id.localeCompare(b.id));const eligibleCount=rows.length,top=rows.slice(0,3),asOf=top.length?top.map(r=>r.performanceAsOf).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]:null;
 return {period,rows:top,eligibleCount,stale:top.some(r=>r.stale)||!!failures.feed,asOf,scope:SCOPE,note:'按正盈亏 USD 排序；胜率为近期片段，非完整周期；采样回撤非净值回撤。'+(period==='30D'?'':' 长期收益率缺可靠资金基准，不估算。')};
}
function accountHref(id,period){if(!PERIODS.includes(period))fail();const account=address(typeof id==='string'&&id.startsWith('hl-')?id.slice(3):id);const params=new URLSearchParams({account,period,exchange:'Hyperliquid',source:'public',sort:'pnl',currency:'USD',q:account});return 'trader/index.html?'+params.toString();}
return {PERIODS,LIMITS,validateFeed,validatePortfolios,validateAnalytics,rank,accountHref};
});
