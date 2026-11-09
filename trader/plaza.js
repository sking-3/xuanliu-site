'use strict';
(() => {
const $ = id => document.getElementById(id);
const periods = ['7D','30D','90D','180D','365D','ALL'], derivedPeriods=['90D','180D','365D'];
const exchanges = ['Binance','OKX','Hyperliquid','Gate','Bitget','Bybit','Polymarket'];
const currencies = ['USDT','USD','USDC','BTC','ETH'];
const controls = ['period','exchange','source','sort','currency'];
const storageKey = 'books.trader.records.v1', maxBytes = 2097152;
const state = {status:'unavailable', publicRows:[], localRows:[], rows:[], page:1, detail:null, window:'30D', tab:'analysis', loading:false, explicitPeriod:false, editor:null, storageReadError:false, revealId:null, source:null, lastReadFailed:false, feedText:null, liveClient:null, liveUser:null, liveData:null, liveView:null, liveVersion:0, positionExclusions:Object.create(null), analytics:Object.create(null), analyticsClient:null, analyticsViews:[], analyticsTargets:[], winCache:Object.create(null), winCacheLoading:false, winCacheReadFailed:false, winCacheGeneratedAt:null, portfolioCache:Object.create(null), portfolioCacheLoading:false, portfolioCacheAttempted:false, portfolioCacheReadFailed:false, portfolioCacheGeneratedAt:null, performanceOrderPending:false, chartSeq:0};
const fail = () => { throw Error('数据格式未通过校验，未展示此批记录。'); };
const text = (v, n=200) => typeof v === 'string' && v.trim().length > 0 && v.length <= n ? v.trim() : fail();
const optionalText = (v,n) => v === undefined || v === '' ? '' : text(v,n);
const num = v => v === null ? null : typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e15 ? v : fail();
const integer = v => v === null ? null : Number.isSafeInteger(v) && v >= 0 ? v : fail();
function date(v) {
  if(typeof v !== 'string') return fail();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/);
  if(!m || +m[2]<1 || +m[2]>12 || +m[3]<1 || +m[3]>new Date(Date.UTC(+m[1],+m[2],0)).getUTCDate() || !Number.isFinite(Date.parse(v)) || Date.parse(v)>Date.now()+300000) return fail();
  return v;
}
function validate(p) {
  if(p?.schemaVersion !== 1 || !['ready','unavailable'].includes(p.status) || !Array.isArray(p.traders) || p.traders.length > 500) fail();
  if(p.status === 'unavailable' && p.traders.length) fail();
  const ids = new Set();
  return p.traders.map(r => {
    if(!r || typeof r !== 'object' || Array.isArray(r)) fail();
    const id = text(r.id,100), name = text(r.name,100);
    if(ids.has(id)) fail(); ids.add(id);
    if(!exchanges.includes(r.exchange) || !currencies.includes(r.currency) || typeof r.featured !== 'boolean' || typeof r.paid !== 'boolean') fail();
    const observedAt = date(r.observedAt);
    let url; try { url = new URL(r.sourceUrl); } catch { fail(); }
    if(url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) fail();
    if(!r.windows || typeof r.windows !== 'object' || Array.isArray(r.windows)) fail();
    const windows = {};
    for(const [k,w] of Object.entries(r.windows)) {
      if(!periods.includes(k) || !w || typeof w !== 'object' || Array.isArray(w)) fail();
      const asOf = date(w.asOf);
      if(Date.parse(asOf)>Date.parse(observedAt)) fail();
      const clean = {asOf, roi:num(w.roi), pnl:num(w.pnl), mdd:num(w.mdd), wins:integer(w.wins), closedTrades:integer(w.closedTrades), curve:[]};
      if(w.sourcePeriod !== undefined) {
        if(r.sourceKind!=='public_account'||r.exchange!=='Hyperliquid'||!({week:'7D',month:'30D',allTime:'ALL'}[w.sourcePeriod] === k)) fail();
        clean.sourcePeriod = w.sourcePeriod;
      }
      if(w.asOfType !== undefined) {
        if(!['source','observed','imported'].includes(w.asOfType)) fail();
        clean.asOfType = w.asOfType;
      }
      if(clean.mdd !== null && (clean.mdd<0 || clean.mdd>100)) fail();
      if(clean.wins !== null && (clean.closedTrades === null || clean.wins>clean.closedTrades)) fail();
      if(!Array.isArray(w.curve) || w.curve.length>1000) fail();
      let previous = -Infinity;
      for(const pt of w.curve) {
        if(!pt || typeof pt !== 'object' || Array.isArray(pt)) fail();
        const time = date(pt.time), value = num(pt.value), stamp = Date.parse(time);
        if(value === null || stamp<=previous || stamp>Date.parse(asOf) || (k!=='ALL' && stamp<Date.parse(asOf)-parseInt(k,10)*86400000)) fail();
        previous = stamp; clean.curve.push({time,value});
      }
      windows[k] = clean;
    }
    const clean = {id,name,exchange:r.exchange,currency:r.currency,featured:r.featured,paid:r.paid,observedAt,sourceUrl:url.href,windows,accountId:optionalText(r.accountId,100),note:optionalText(r.note,500)};
    if(r.sourceKind !== undefined) { if(r.sourceKind !== 'public_account')fail();clean.sourceKind=r.sourceKind; }
    if(r.accountValue !== undefined)clean.accountValue=num(r.accountValue);
    if(r.positionCheck !== undefined) {
      const check=r.positionCheck;
      if(r.sourceKind!=='public_account'||!check||typeof check!=='object'||Array.isArray(check)||check.scope!=='default_perp_dex'||!Number.isSafeInteger(check.count)||check.count<1||check.count>1000)fail();
      const checkedAt=date(check.checkedAt),sourceTime=date(check.sourceTime),lag=Date.parse(checkedAt)-Date.parse(sourceTime);
      if(lag>120000||lag< -5000)fail();
      clean.positionCheck={scope:'default_perp_dex',checkedAt,sourceTime,count:check.count};
    }
    for(const k of ['positions','points','orders']) {
      if(!Array.isArray(r[k]) || r[k].length>1000) fail();
      clean[k] = r[k].map(row => {
        if(!row || typeof row !== 'object' || Array.isArray(row)) fail();
        const time = date(row.time), symbol = text(row.symbol,40);
        if(Date.parse(time)>Date.parse(observedAt) || !['long','short','buy','sell'].includes(row.side)) fail();
        const item = {time,symbol,side:row.side,price:num(row.price),quantity:num(row.quantity),pnl:num(row.pnl)};
        if(item.price !== null && item.price<0 || item.quantity !== null && item.quantity<0) fail();
        return item;
      });
    }
    return clean;
  });
}
function validateSource(p,rows) {
  if(!p.source) { if(rows.some(r=>r.sourceKind==='public_account'))fail();return null; }
  const s=p.source;
  if(!s||typeof s!=='object'||Array.isArray(s)||s.id!=='hyperliquid'||s.url!=='https://app.hyperliquid.xyz/leaderboard'||!['ok','stale','error'].includes(s.status))fail();
  if(p.status==='unavailable'&&!rows.length&&s.status==='error'&&!s.fetchedAt)return null;
  const fetchedAt=date(s.fetchedAt),snapshotAt=s.snapshotAt===null?null:date(s.snapshotAt),lastAttemptAt=date(s.lastAttemptAt);
  const totalAccounts=integer(s.totalAccounts),selectedAccounts=integer(s.selectedAccounts);
  if(totalAccounts===null||selectedAccounts!==rows.length||totalAccounts<selectedAccounts||totalAccounts>1000000||s.refreshIntervalMinutes!==30||s.staleAfterMinutes!==120||Date.parse(lastAttemptAt)<Date.parse(fetchedAt)||(snapshotAt&&Date.parse(snapshotAt)>Date.parse(fetchedAt))||(s.status==='error'&&rows.length))fail();
  for(const r of rows) {
    if(r.exchange!=='Hyperliquid'||r.currency!=='USD'||r.sourceKind!=='public_account'||!/^0x[0-9a-f]{40}$/.test(r.accountId)||r.sourceUrl!==`https://app.hyperliquid.xyz/explorer/address/${r.accountId}`||r.observedAt!==fetchedAt)fail();
    for(const w of Object.values(r.windows))if(!w.sourcePeriod||w.asOf!==(snapshotAt||fetchedAt)||w.asOfType!==(snapshotAt?'source':'observed'))fail();
  }
  let positionVerification;
  if(s.positionVerification!==undefined) {
    const v=s.positionVerification;
    if(!v||typeof v!=='object'||Array.isArray(v)||v.scope!=='default_perp_dex'||v.maxAgeMinutes!==60)fail();
    positionVerification={scope:v.scope,maxAgeMinutes:60,completedAt:date(v.completedAt)};
    for(const k of ['candidateAccounts','checkedAccounts','holdingAccounts','emptyAccounts','failedAccounts','unattemptedAccounts']) {
      if(!Number.isSafeInteger(v[k])||v[k]<0||v[k]>200)fail();positionVerification[k]=v[k];
    }
    if(v.candidateAccounts>totalAccounts||v.holdingAccounts!==rows.length||v.checkedAccounts!==v.holdingAccounts+v.emptyAccounts||v.checkedAccounts+v.failedAccounts+v.unattemptedAccounts!==v.candidateAccounts)fail();
    for(const r of rows)if(!r.positionCheck||Date.parse(r.positionCheck.checkedAt)>Date.parse(positionVerification.completedAt))fail();
  }
  const result={id:s.id,url:s.url,label:text(s.label,80),selection:text(s.selection,250),totalAccounts,selectedAccounts,fetchedAt,snapshotAt,lastAttemptAt,refreshIntervalMinutes:30,staleAfterMinutes:120,status:s.status};
  if(positionVerification)result.positionVerification=positionVerification;
  return result;
}
function validatePortfolioCache(p) {
  if(!p||typeof p!=='object'||Array.isArray(p)||p.schemaVersion!==1||p.methodVersion!=='portfolio-periods-v1'||!p.accounts||typeof p.accounts!=='object'||Array.isArray(p.accounts)||Object.keys(p.accounts).length>200)fail();
  const generatedAt=date(p.generatedAt),generated=Date.parse(generatedAt),accounts=Object.create(null),now=Date.now();if(generated>now+5000)fail();
  const metric=v=>v===null?null:typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<1e20?v:fail();
  const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=20000?v:fail();
  const stamp=v=>v===null?null:date(v);
  for(const [address,entry] of Object.entries(p.accounts)) {
    if(!/^0x[0-9a-f]{40}$/.test(address)||!entry||typeof entry!=='object'||Array.isArray(entry)||!['ready','stale','unavailable'].includes(entry.status))fail();
    const fetchedAt=stamp(entry.fetchedAt),lastAttemptAt=stamp(entry.lastAttemptAt),errorCode=entry.errorCode==null?null:text(entry.errorCode,80);
    for(const value of [fetchedAt,lastAttemptAt])if(value&&(Date.parse(value)>generated+5000||Date.parse(value)>now+5000))fail();
    if(entry.portfolio===null){if(fetchedAt!==null||entry.status!=='unavailable')fail();accounts[address]={status:'unavailable',fetchedAt:null,lastAttemptAt,errorCode,portfolio:null};continue;}
    if(!fetchedAt||entry.status==='unavailable'||!entry.portfolio||typeof entry.portfolio!=='object'||Array.isArray(entry.portfolio)||!entry.portfolio.windows||typeof entry.portfolio.windows!=='object'||Array.isArray(entry.portfolio.windows)||Object.keys(entry.portfolio.windows).length>6)fail();
    const windows={};
    for(const [period,w]of Object.entries(entry.portfolio.windows)) {
      if(!periods.includes(period)||!w||typeof w!=='object'||Array.isArray(w))fail();
      const derived=derivedPeriods.includes(period),expectedSource=derived||period==='ALL'?'allTime':period==='7D'?'week':'month';
      if(w.derived!==derived||w.sourcePeriod!==expectedSource||w.scope!=='all_account'||w.curveUnit!=='USD'||w.curveBasis!=='pnl_change_from_first_sample'||w.mddUnit!=='percent'||w.mddMethod!==(derived?'window_pnl_peak_equity':'hyperliquid_ui_pnl_peak_equity'))fail();
      if(w.requestedDays!==(derived?parseInt(period,10):null)||!['source_window','full','sampled_boundary','insufficient_history'].includes(w.coverageStatus)||(!derived&&w.coverageStatus!=='source_window')||(derived&&w.coverageStatus==='source_window'))fail();
      const clean={derived,sourcePeriod:w.sourcePeriod,scope:w.scope,curveUnit:w.curveUnit,curveBasis:w.curveBasis,mddUnit:w.mddUnit,mddMethod:w.mddMethod,requestedDays:w.requestedDays,coverageStatus:w.coverageStatus,points:[]};
      for(const key of ['startAt','endAt','requestedStartAt','requestedEndAt','sourceHistoryStartAt','sourceHistoryEndAt']){clean[key]=stamp(w[key]);if(clean[key]&&(Date.parse(clean[key])>Date.parse(fetchedAt)+5000||Date.parse(clean[key])>now+5000))fail();}
      for(const key of ['sampleCount','sourceSampleCount','mddPairedSampleCount'])clean[key]=count(w[key]);
      for(const key of ['pnl','mdd','coverageDays','maxSampleGapMs'])clean[key]=metric(w[key]);
      clean.mddUnavailableReason=w.mddUnavailableReason===null?null:text(w.mddUnavailableReason,100);
      if(clean.coverageDays===null||clean.coverageDays<0||clean.maxSampleGapMs!==null&&clean.maxSampleGapMs<0||clean.mdd!==null&&clean.mdd<0||clean.mdd===null&&!clean.mddUnavailableReason||clean.mdd!==null&&clean.mddUnavailableReason!==null||clean.sourceSampleCount<clean.sampleCount||clean.mddPairedSampleCount>clean.sampleCount)fail();
      if(clean.mdd===null?(!['insufficient_samples','unpaired_samples','non_positive_peak_equity','no_valid_peak','invalid_denominator'].includes(clean.mddUnavailableReason)||clean.mddPairedSampleCount!==0):(clean.sampleCount<2||clean.mddPairedSampleCount!==clean.sampleCount))fail();
      if(!derived&&(clean.sourceSampleCount!==clean.sampleCount||clean.sourceHistoryStartAt!==clean.startAt||clean.sourceHistoryEndAt!==clean.endAt))fail();
      if(derived){if(w.roi!==null||w.roiUnavailableReason!=='cash_flow_adjusted_return_unavailable')fail();clean.roi=null;clean.roiUnavailableReason=w.roiUnavailableReason;}
      if(!Array.isArray(w.points)||w.points.length>240||w.points.length>clean.sampleCount||(clean.sampleCount>1&&w.points.length<2))fail();
      let previous=-Infinity;
      for(const point of w.points){if(!point||typeof point!=='object'||Array.isArray(point))fail();const time=date(point.time),value=metric(point.value),t=Date.parse(time);if(value===null||t<=previous||!clean.startAt||!clean.endAt||t<Date.parse(clean.startAt)||t>Date.parse(clean.endAt))fail();previous=t;clean.points.push({time,value});}
      if(!clean.sampleCount){if(clean.startAt!==null||clean.endAt!==null||clean.points.length||clean.pnl!==null||clean.coverageDays!==0)fail();}
      else {
        if(!clean.startAt||!clean.endAt||!clean.sourceHistoryStartAt||!clean.sourceHistoryEndAt||Date.parse(clean.startAt)>Date.parse(clean.endAt)||Date.parse(clean.startAt)<Date.parse(clean.sourceHistoryStartAt)||Date.parse(clean.endAt)>Date.parse(clean.sourceHistoryEndAt)||clean.points[0]?.time!==clean.startAt||clean.points.at(-1)?.time!==clean.endAt||clean.points[0]?.value!==0||Math.abs(clean.coverageDays-(Date.parse(clean.endAt)-Date.parse(clean.startAt))/86400000)>1e-8)fail();
        if(clean.sampleCount===1?clean.pnl!==null:clean.pnl===null||Math.abs(clean.pnl-clean.points.at(-1).value)>1e-8*Math.max(1,Math.abs(clean.pnl)))fail();
        if(derived){if(!clean.requestedStartAt||clean.requestedEndAt!==clean.sourceHistoryEndAt||clean.endAt!==clean.requestedEndAt||Date.parse(clean.startAt)<Date.parse(clean.requestedStartAt)||Date.parse(clean.endAt)>Date.parse(clean.requestedEndAt)||Date.parse(clean.requestedEndAt)-Date.parse(clean.requestedStartAt)!==clean.requestedDays*86400000)fail();if(clean.coverageStatus==='full'&&clean.startAt!==clean.requestedStartAt||clean.coverageStatus==='sampled_boundary'&&(Date.parse(clean.sourceHistoryStartAt)>Date.parse(clean.requestedStartAt)||Date.parse(clean.startAt)<=Date.parse(clean.requestedStartAt))||clean.coverageStatus==='insufficient_history'&&Date.parse(clean.sourceHistoryStartAt)<=Date.parse(clean.requestedStartAt))fail();}
        else if(clean.requestedStartAt!==null||clean.requestedEndAt!==clean.endAt)fail();
      }
      windows[period]=clean;
    }
    accounts[address]={status:entry.status,fetchedAt,lastAttemptAt,errorCode,portfolio:{windows}};
  }
  return {generatedAt,accounts};
}
function portfolioSection(r) {
  if(!isPublicAccount(r))return null;
  const live=state.analytics[r.accountId]?.portfolio,entry=state.portfolioCache[r.accountId];
  if(live?.status==='ready'&&(!entry?.portfolio||Date.parse(live.fetchedAt||'')>=Date.parse(entry.fetchedAt)))return live;
  if(entry?.portfolio)return {...entry.portfolio,status:'ready',fetchedAt:entry.fetchedAt,lastAttemptAt:entry.lastAttemptAt,stale:state.portfolioCacheReadFailed||entry.status!=='ready'||Date.now()-Date.parse(entry.fetchedAt)>3600000};
  return live||null;
}
function performanceWindow(r,period) {
  if(!isPublicAccount(r)||!derivedPeriods.includes(period))return r.windows[period];
  const part=portfolioSection(r),w=part?.status==='ready'?part.windows[period]:null;
  return w?{...w,asOf:w.endAt,roi:null,wins:null,closedTrades:null,curve:[]}:null;
}
function periodName(period,w) {return w?.derived?parseInt(period,10)+'天':displayPeriod(period,w);}
function historyDate(value) {return new Date(value).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});}
function performanceRange(r,period) {
  const part=portfolioSection(r),w=part?.status==='ready'?part.windows[period]:null;
  if(w?.sampleCount>1){const range=`${historyDate(w.startAt)} — ${historyDate(w.endAt)}`,coverage=derivedPeriods.includes(period)?` · 覆盖 ${w.coverageDays.toLocaleString('zh-CN',{maximumFractionDigits:1})} 天${w.coverageStatus==='insufficient_history'?' · 历史不足':w.coverageStatus==='sampled_boundary'?' · 采样边界':''}`:'';return `${period==='ALL'?'来源覆盖':'实际区间'} ${range}${coverage}${part.stale?' · 旧采样':''}`;}
  if(part?.status==='queued'||part?.status==='loading'||state.portfolioCacheLoading&&!state.portfolioCacheAttempted)return '正在读取区间历史';
  return part?.status==='error'?'区间历史暂不可用':'暂无该区间的有效历史样本';
}
function fillPerformanceSummary(r,period,view) {
  const w=performanceWindow(r,period),derived=isPublicAccount(r)&&derivedPeriods.includes(period),part=portfolioSection(r),history=part?.status==='ready'?part.windows[period]:null;
  const amount=derived?w?.pnl:w?.roi,formatted=derived?compactMoney(amount,'USD'):pct(amount),formattedSigned=signedValue(amount,formatted);
  view.roi.textContent=formattedSigned;view.roi.className='roi '+directionClass(amount)+(formattedSigned.length>8?' long-roi':'');
  view.roi.setAttribute('title',derived?`${periodName(period,w)} 区间盈亏 ${money(amount,'USD')} USD；收益率缺少可核验的出入金调整口径`: `${periodName(period,w)} 收益率 ${formattedSigned}`);
  view.roiLabel.textContent=derived?`${parseInt(period,10)}天区间盈亏 · USD`:`${periodName(period,w)} 收益率`;
  if(view.rangeNote){view.rangeNote.textContent=performanceRange(r,period);view.rangeNote.hidden=!(derived||period==='ALL');view.rangeNote.setAttribute('title',history?`${performanceRange(r,period)}；采集时间 ${part?.fetchedAt?timeLabel(part.fetchedAt):'—'}；来源真实 ${history.sampleCount} 个采样点`:'暂无可核验的区间历史采样');}
  if(view.cardRoot)view.cardRoot.className='card'+(derived&&!(history?.sampleCount>1)?' compact-history':'');
}
function sortValue(r,period,sort) {
  const w=performanceWindow(r,period),part=portfolioSection(r);
  if(isPublicAccount(r)&&sort==='mdd')return part?.status==='ready'?part.windows[period]?.mdd:null;
  if(isPublicAccount(r)&&sort==='winRate')return cachedWin(r)?.win?.value??null;
  return sort==='winRate'?win(w):w?.[sort];
}
function renderPreservingCardFocus() {
  const focused=state.analyticsViews.find(v=>v.kind==='card'&&(v.detailButton===document.activeElement||v.sourceLink===document.activeElement)),kind=focused?.detailButton===document.activeElement?'detailButton':'sourceLink';
  render();if(focused){const replacement=state.analyticsViews.find(v=>v.kind==='card'&&v.r.id===focused.r.id);(replacement?.[kind]||$('sort')).focus();}
}
function schedulePerformanceOrder() {
  if(state.performanceOrderPending||state.loading||!['pnl','mdd'].includes($('sort').value)||!derivedPeriods.includes($('period').value)||$('source').value==='local')return;
  state.performanceOrderPending=true;setTimeout(()=>{state.performanceOrderPending=false;if(!state.loading&&['pnl','mdd'].includes($('sort').value)&&derivedPeriods.includes($('period').value))renderPreservingCardFocus();},0);
}
async function refreshPortfolioCache() {
  if(state.portfolioCacheLoading)return;state.portfolioCacheLoading=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000),limit=12*1024*1024;let orderChanged=false;
  try {
    const response=await fetch('portfolios.json',{cache:'no-cache',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok||!/application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>limit)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit){await reader.cancel();fail();}chunks.push(value);}
    const payload=validatePortfolioCache(JSON.parse(await new Blob(chunks).text()));if(state.portfolioCacheGeneratedAt&&Date.parse(payload.generatedAt)<Date.parse(state.portfolioCacheGeneratedAt))fail();
    const before=state.rows.map(r=>sortValue(r,$('period').value,$('sort').value));
    for(const [address,incoming]of Object.entries(payload.accounts)){const previous=state.portfolioCache[address];if(previous?.portfolio&&(!incoming.portfolio||Date.parse(incoming.fetchedAt)<Date.parse(previous.fetchedAt)))payload.accounts[address]={...previous,status:'stale',lastAttemptAt:incoming.lastAttemptAt||previous.lastAttemptAt,errorCode:incoming.errorCode||'older_result'};}
    state.portfolioCache=payload.accounts;state.portfolioCacheGeneratedAt=payload.generatedAt;state.portfolioCacheReadFailed=false;
    orderChanged=state.rows.some((r,i)=>before[i]!==sortValue(r,$('period').value,$('sort').value));
  } catch {state.portfolioCacheReadFailed=true;}
  finally {clearTimeout(timeout);state.portfolioCacheLoading=false;state.portfolioCacheAttempted=true;for(const address of new Set(state.analyticsViews.map(v=>v.r.accountId)))refreshAnalyticsViews(address);if(orderChanged)schedulePerformanceOrder();startVisibleAnalytics(state.analyticsViews.filter(v=>v.kind==='card').slice(0,12).map(v=>v.r),true);}
}
// This same-origin file contains only precomputed public-account aggregates.
// A fetched snapshot never starts per-account成交 requests in the visitor's browser.
function validateWinCache(p) {
  if(!p||typeof p!=='object'||Array.isArray(p)||p.schemaVersion!==1||p.methodVersion!=='closing-fill-v1'||!p.accounts||typeof p.accounts!=='object'||Array.isArray(p.accounts)||Object.keys(p.accounts).length>200)fail();
  const generatedAt=date(p.generatedAt),generated=Date.parse(generatedAt),accounts=Object.create(null);if(generated>Date.now()+5000)fail();
  for(const [address,entry] of Object.entries(p.accounts)) {
    if(!/^0x[0-9a-f]{40}$/.test(address)||!entry||typeof entry!=='object'||Array.isArray(entry)||!['ready','stale','unavailable'].includes(entry.status))fail();
    const fetchedAt=entry.fetchedAt===null?null:date(entry.fetchedAt),lastAttemptAt=entry.lastAttemptAt===null?null:date(entry.lastAttemptAt);
    if(fetchedAt&&(Date.parse(fetchedAt)>generated+5000||Date.parse(fetchedAt)>Date.now()+5000)||lastAttemptAt&&(Date.parse(lastAttemptAt)>generated+5000||Date.parse(lastAttemptAt)>Date.now()+5000))fail();
    const errorCode=entry.errorCode==null?null:text(entry.errorCode,80);
    if(entry.win===null) {if(fetchedAt!==null||entry.status!=='unavailable')fail();accounts[address]={status:'unavailable',fetchedAt:null,lastAttemptAt,errorCode,win:null};continue;}
    if(!fetchedAt||entry.status==='unavailable')fail();
    const w=entry.win;
    if(!w||typeof w!=='object'||Array.isArray(w)||w.method!=='closing_fill_net_of_closing_fee'||w.scope!=='default_perp_dex'||w.unit!=='percent'||w.feeToken!=='USDC'||w.historyComplete!==false||w.includesOpeningFees!==false||w.includesFunding!==false||typeof w.capped!=='boolean')fail();
    const clean={method:w.method,scope:w.scope,unit:w.unit,feeToken:w.feeToken,historyComplete:false,includesOpeningFees:false,includesFunding:false,capped:w.capped};
    for(const key of ['winning','losing','breakeven','eligibleCount','totalFills','receivedFills','duplicateCount','excludedCount']) {
      if(!Number.isSafeInteger(w[key])||w[key]<0||w[key]>2000)fail();clean[key]=w[key];
    }
    if(w.winning+w.losing+w.breakeven!==w.eligibleCount||w.eligibleCount+w.excludedCount!==w.totalFills||w.totalFills+w.duplicateCount!==w.receivedFills||w.capped!==(w.receivedFills===2000))fail();
    clean.value=num(w.value);
    if(w.eligibleCount===0?clean.value!==null:clean.value===null||clean.value<0||clean.value>100||Math.abs(clean.value-w.winning/w.eligibleCount*100)>1e-8)fail();
    for(const key of ['startAt','endAt','sourceSampleStartAt','sourceSampleEndAt']) {
      clean[key]=w[key]===null?null:date(w[key]);if(clean[key]&&(Date.parse(clean[key])>Date.parse(fetchedAt)+5000||Date.parse(clean[key])>Date.now()+5000))fail();
    }
    for(const [count,start,end]of [[w.eligibleCount,clean.startAt,clean.endAt],[w.totalFills,clean.sourceSampleStartAt,clean.sourceSampleEndAt]]) {
      if(count===0?(start!==null||end!==null):(!start||!end||Date.parse(start)>Date.parse(end)))fail();
    }
    if(clean.startAt&&(Date.parse(clean.startAt)<Date.parse(clean.sourceSampleStartAt)||Date.parse(clean.endAt)>Date.parse(clean.sourceSampleEndAt)))fail();
    accounts[address]={status:entry.status,fetchedAt,lastAttemptAt,errorCode,win:clean};
  }
  return {generatedAt,accounts};
}
function cachedWin(r) {return isPublicAccount(r)?state.winCache[r.accountId]||null:null;}
function winCacheIsStale(entry,now=Date.now()) {return !!entry?.win&&(state.winCacheReadFailed||entry.status!=='ready'||now-Date.parse(entry.fetchedAt)>3600000);}
function compactCacheTime(stamp,stale=false) {
  const d=new Date(stamp),today=new Date(),sameDay=d.toDateString()===today.toDateString();
  return d.toLocaleString('zh-CN',{hour12:false,...(!sameDay||stale?{month:'2-digit',day:'2-digit'}:{}),hour:'2-digit',minute:'2-digit'});
}
function fillWinCacheNote(r,target) {
  const entry=cachedWin(r),w=entry?.win,stale=winCacheIsStale(entry);
  target.textContent=w?`平仓样本 ${w.eligibleCount} 笔 · ${stale?'陈旧':'采集'} ${compactCacheTime(entry.fetchedAt,stale)}`:'平仓样本 —';
  target.setAttribute('data-state',stale?'stale':w?'ready':'unavailable');
  target.setAttribute('title',w?`后台采集 ${timeLabel(entry.fetchedAt)}；${w.eligibleCount?`平仓样本 ${timeLabel(w.startAt)} 至 ${timeLabel(w.endAt)}`:'来源没有可统计的平仓样本'}；与所选表现周期独立${stale?'；显示上次成功结果，等待后台更新':''}`:'后台尚未取得有效平仓样本；资料不足时留空');
}
async function refreshWinCache() {
  if(state.winCacheLoading)return;state.winCacheLoading=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);let orderChanged=false;
  try {
    const response=await fetch('analytics.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok||!/application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>maxBytes)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();fail();}chunks.push(value);}
    const payload=validateWinCache(JSON.parse(await new Blob(chunks).text()));
    if(state.winCacheGeneratedAt&&Date.parse(payload.generatedAt)<Date.parse(state.winCacheGeneratedAt))fail();
    for(const [address,incoming]of Object.entries(payload.accounts)) {
      const previous=state.winCache[address];
      if(previous?.win&&(!incoming.win||Date.parse(incoming.fetchedAt)<Date.parse(previous.fetchedAt)))payload.accounts[address]={...previous,status:'stale',lastAttemptAt:incoming.lastAttemptAt||previous.lastAttemptAt,errorCode:incoming.errorCode||'older_result'};
    }
    orderChanged=state.rows.some(r=>isPublicAccount(r)&&qualifiedPosition(r)&&(state.winCache[r.accountId]?.win?.value??null)!==(payload.accounts[r.accountId]?.win?.value??null));
    state.winCache=payload.accounts;state.winCacheGeneratedAt=payload.generatedAt;state.winCacheReadFailed=false;
  } catch {state.winCacheReadFailed=true;}
  finally {
    clearTimeout(timeout);state.winCacheLoading=false;
    // When the feed wins the network race, apply the selected order as soon as
    // aggregate values arrive. Metadata-only refreshes preserve card nodes/focus.
    if(orderChanged&&!state.loading&&$('sort').value==='winRate'&&$('source').value!=='local') {
      const focused=state.analyticsViews.find(v=>v.kind==='card'&&(v.detailButton===document.activeElement||v.sourceLink===document.activeElement));
      const focusKind=focused?.detailButton===document.activeElement?'detailButton':'sourceLink';
      render();
      if(focused){const replacement=state.analyticsViews.find(v=>v.kind==='card'&&v.r.id===focused.r.id);(replacement?.[focusKind]||$('sort')).focus();}
    }
    for(const address of new Set(state.analyticsViews.map(v=>v.r.accountId)))refreshAnalyticsViews(address);
  }
}
function sourceIsStale(now=Date.now()) {
  if(state.lastReadFailed)return true;
  const s=state.source;if(!s)return false;
  return s.status!=='ok'||now-Math.min(Date.parse(s.fetchedAt),s.snapshotAt?Date.parse(s.snapshotAt):Infinity)>s.staleAfterMinutes*60000;
}
function isPublicAccount(r) {return r.sourceKind==='public_account'&&!r._local;}
function qualifiedPosition(r,now=Date.now()) {
  if(!isPublicAccount(r))return true;
  const check=r.positionCheck;
  if(!state.source?.positionVerification||!check||check.scope!=='default_perp_dex'||check.count<1)return false;
  const checked=Date.parse(check.checkedAt),source=Date.parse(check.sourceTime);
  return Number.isFinite(checked)&&Number.isFinite(source)&&now-checked<=3600000&&checked-now<=5000&&checked-source<=120000&&source-checked<=5000&&checked>(state.positionExclusions[r.accountId]??-Infinity);
}
function eligiblePublicRows() {return state.publicRows.filter(r=>qualifiedPosition(r));}
function reevaluatePositions() {mergeRows();render();renderSource();}
function observeEmptyPositions(r,part) {
  if(!isPublicAccount(r)||part?.status!=='ready'||!Array.isArray(part.rows)||part.rows.length!==0)return;
  const checked=Number(part.fetchedAt),source=Number(part.sourceTime),now=Date.now();
  if(!Number.isFinite(checked)||!Number.isFinite(source)||checked<=0||source<=0||now-checked>120000||checked-now>5000||checked-source>120000||source-checked>5000)return;
  if(checked<Date.parse(r.positionCheck?.checkedAt||''))return;
  const excluded=Math.max(checked,Date.parse(r.positionCheck?.checkedAt||'')||0);
  if(excluded<=(state.positionExclusions[r.accountId]??-Infinity))return;
  state.positionExclusions[r.accountId]=excluded;reevaluatePositions();
}
function compactAccount(r) {return isPublicAccount(r)?r.accountId.slice(0,8)+'…'+r.accountId.slice(-6):r.accountId||r.id;}
function displayPeriod(p,w) {return w?.derived?parseInt(p,10)+'天':({week:'周度',month:'月度',allTime:'来源累计'})[w?.sourcePeriod]||periodLabel(p);}
function timeLabel(iso) {return new Date(iso).toLocaleString('zh-CN',{hour12:false});}
function renderSource() {
  const s=state.source,stale=sourceIsStale();
  $('source-summary').hidden=!s;
  if(s) {
    $('source-name').textContent=s.label;
    const v=s.positionVerification,eligible=eligiblePublicRows().length;
    $('source-selection').textContent=v?`${eligible} 个可看持仓 · ${v.candidateAccounts} 个候选 · ${v.emptyAccounts} 个空仓${v.failedAccounts?' · '+v.failedAccounts+' 个读取失败':''}${v.unattemptedAccounts?' · '+v.unattemptedAccounts+' 个待核验':''}`:`${s.selection} · 持仓待核验`;
    $('source-timing').textContent=`${s.snapshotAt?'快照文件更新 '+timeLabel(s.snapshotAt):'快照文件时间未提供'} · 采集于 ${timeLabel(s.fetchedAt)}`;
    $('source-cadence').textContent='约 30 分钟核验 · 超过 60 分钟自动移出名单';
  }
  $('status').textContent=statusText();$('status').setAttribute('data-state',stale?'stale':eligiblePublicRows().length?'ready':'empty');
  $('source-universe').textContent=s?.positionVerification?s.positionVerification.candidateAccounts.toLocaleString('zh-CN'):'—';
  if(state.detail&&$('detail').open)renderDetailStatus();
}
function feed(rows) { return {schemaVersion:1,status:'ready',traders:rows}; }
function mergeRows() { state.rows = [...eligiblePublicRows().map(r=>({...r,_local:false})),...state.localRows.map(r=>({...r,_local:true}))]; }
function node(tag,content,cls) { const n=document.createElement(tag); if(content!==undefined)n.textContent=content; if(cls)n.className=cls; return n; }
function button(label, action, cls) { const b=node('button',label,cls); b.type='button'; b.addEventListener('click',action); return b; }
function sourceLink(r) { const a=node('a','查看来源 ↗','source-link'); a.href=r.sourceUrl; a.target='_blank'; a.rel='noopener noreferrer'; return a; }
function pct(x) { return x==null?'—':x.toFixed(2)+'%'; }
function signedValue(x,formatted) {return x>0?'+'+formatted:formatted;}
function directionClass(x) {return x>0?'positive':x<0?'negative':'';}
function value(x) { return x==null?'—':x!==0&&Math.abs(x)<1e-8?x.toExponential(2):x.toLocaleString('en-US',{maximumFractionDigits:8}); }
function money(x,currency) {return x==null?'—':['USD','USDT','USDC'].includes(currency)?x.toLocaleString('en-US',{maximumFractionDigits:2}):value(x);}
function compactMoney(x,currency) {
  if(x==null)return '—';
  if(!['USD','USDT','USDC'].includes(currency)||Math.abs(x)<10000)return money(x,currency);
  const scale=Math.abs(x)>=100000000?100000000:10000,unit=scale===100000000?'亿':'万';
  return (x/scale).toLocaleString('zh-CN',{maximumFractionDigits:2})+unit;
}
function win(w) { return w?.wins!=null&&w?.closedTrades>0?w.wins/w.closedTrades*100:null; }
function periodLabel(p) { return p==='ALL'?'累计':p; }
function hasMetrics(w) { return !!w && (['roi','pnl','mdd','wins','closedTrades'].some(k=>w[k]!=null)||w.curve.length>0); }
function stampLabel(w) {
  if(!w) return '';
  const stamp = timeLabel(w.asOf);
  if(w.sourcePeriod)return `${w.asOfType==='source'?'来源快照':'采集于'} ${stamp}`;
  if(w.asOfType==='imported') return `记录于 ${stamp} · 快照日期未知`;
  if(w.asOfType==='observed') return `读取于 ${stamp} · 来源更新时间未提供`;
  return `数据截至 ${stamp}`;
}
function feedback(message) { $('local-feedback').textContent=message; }
function empty(target,title,body,allowAdd=false) {
  const e=node('div',undefined,'empty'); e.append(node('strong',title),node('span',body));
  if(allowAdd)e.append(button('添加带单员',()=>openEditor(), 'primary'));
  target.append(e);
}
function chart(w,kind='return') {
  const el=node('div',undefined,'chart'), pts=w?.curve||[];
  if(pts.length<2) { el.textContent='暂无收益曲线'; return el; }
  const values=pts.map(p=>p.value),lo=Math.min(...values,...(kind==='pnl'?[0]:[])),hi=Math.max(...values,...(kind==='pnl'?[0]:[])),start=Date.parse(pts[0].time),end=Date.parse(pts.at(-1).time);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 300 90'); svg.setAttribute('role','img');
  svg.setAttribute('aria-label',`${kind==='pnl'?'来源盈亏变化曲线':'来源收益曲线'}：${pts.length} 个样本，起点 ${pts[0].value}${kind==='pnl'?' USD':'%' }，终点 ${pts.at(-1).value}${kind==='pnl'?' USD':'%'}；${pts[0].time} 至 ${pts.at(-1).time}`);
  const y=value=>hi===lo?45:80-70*(value-lo)/(hi-lo),coordinates=pts.map(p=>`${8+284*(Date.parse(p.time)-start)/(end-start)},${y(p.value)}`).join(' ');
  if(kind==='pnl') {
    svg.setAttribute('preserveAspectRatio','none');
    const zero=y(0),id='pnl-'+(++state.chartSeq),defs=document.createElementNS(svg.namespaceURI,'defs');
    for(const [name,top,height]of [['positive',0,zero],['negative',zero,90-zero]]) {
      const clip=document.createElementNS(svg.namespaceURI,'clipPath'),rect=document.createElementNS(svg.namespaceURI,'rect');clip.setAttribute('id',id+'-'+name);
      for(const [k,v]of Object.entries({x:0,y:top,width:300,height}))rect.setAttribute(k,String(v));clip.append(rect);defs.append(clip);
    }
    svg.append(defs);
    const baseline=document.createElementNS(svg.namespaceURI,'line');for(const [k,v]of Object.entries({x1:8,x2:292,y1:zero,y2:zero,class:'pnl-baseline'}))baseline.setAttribute(k,String(v));svg.append(baseline);
    for(const name of ['positive','negative']) {
      const area=document.createElementNS(svg.namespaceURI,'polygon'),line=document.createElementNS(svg.namespaceURI,'polyline');
      area.setAttribute('points',`8,${zero} ${coordinates} 292,${zero}`);area.setAttribute('class','pnl-area-'+name);area.setAttribute('clip-path',`url(#${id}-${name})`);
      line.setAttribute('points',coordinates);line.setAttribute('class','pnl-line-'+name);line.setAttribute('clip-path',`url(#${id}-${name})`);svg.append(area,line);
    }
  } else {const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',coordinates);svg.append(line);}
  el.append(svg); return el;
}
function mddReason(reason) {return ({non_positive_peak_equity:'该窗口部分峰值权益无效，无法计算完整回撤',unpaired_samples:'盈亏与权益采样时间不一致，无法计算回撤',insufficient_samples:'有效来源样本不足，无法计算回撤',no_valid_peak:'缺少有效峰值权益，无法计算回撤',invalid_denominator:'权益分母无效，无法计算回撤'})[reason]||'来源未提供可计算的完整回撤数据';}
function metrics(w,currency,includeROI=false,r=null,period=null) {
  const el=node('div',undefined,'metrics');
  const publicAccount=r&&isPublicAccount(r),part=publicAccount?portfolioSection(r):null,window=part?.status==='ready'?part.windows[period]:null;
  const drawdown=publicAccount?window?.mdd:w?.mdd,winEntry=publicAccount?cachedWin(r):null;
  const items=[['盈亏 '+currency,signedValue(w?.pnl,includeROI?money(w?.pnl,currency):compactMoney(w?.pnl,currency)),w?.pnl==null?'—':signedValue(w.pnl,money(w.pnl,currency))+' '+currency,directionClass(w?.pnl)],[publicAccount?(derivedPeriods.includes(period)?'区间采样回撤':'来源采样回撤'):'最大回撤',pct(drawdown),undefined,drawdown==null?'':'negative'],[publicAccount?'平仓成交胜率':'逐笔胜率',pct(publicAccount?winEntry?.win?.value:win(w))]];
  if(includeROI&&!(publicAccount&&derivedPeriods.includes(period)))items.unshift(['收益率',signedValue(w?.roi,pct(w?.roi)),undefined,directionClass(w?.roi)]);
  for(const [label,v,exact,color]of items) {
    const c=node('div'),amount=node('strong',v,color);amount.setAttribute('title',exact||v);c.append(node('small',label),amount);
    if(publicAccount&&['来源采样回撤','区间采样回撤'].includes(label))amount.setAttribute('title',window?.mdd==null?mddReason(window?.mddUnavailableReason):`${pct(window.mdd)} · 来源采样口径，非策略净值回撤`);
    if(publicAccount&&label==='平仓成交胜率')amount.setAttribute('title',winEntry?.win?`${winEntry.win.eligibleCount} 笔平仓成交样本，独立于所选表现周期；后台采集 ${timeLabel(winEntry.fetchedAt)}${winCacheIsStale(winEntry)?'；上次成功结果，待更新':''}`:'尚未取得有效后台统计；资料不足时留空');
    el.append(c);
  }
  return el;
}
function ensureAnalyticsClient() {
  if(!state.analyticsClient&&typeof BooksAccountAnalytics!=='undefined')state.analyticsClient=BooksAccountAnalytics.create({visible:document.visibilityState!=='hidden',onChange:record=>{const row=state.rows.find(r=>r.accountId===record.address),before=row?sortValue(row,$('period').value,$('sort').value):null;state.analytics[record.address]=record;refreshAnalyticsViews(record.address);if(row&&before!==sortValue(row,$('period').value,$('sort').value))schedulePerformanceOrder();}});
  return state.analyticsClient;
}
function fillPerformanceGraph(r,period,graph) {
  graph.replaceChildren();
  const part=portfolioSection(r),w=part?.status==='ready'?part.windows[period]:null;
  if(isPublicAccount(r)&&w?.points?.length>1)graph.append(node('span','盈亏变化 · USD','curve-label'),chart({curve:w.points},'pnl'));
  else if(!isPublicAccount(r)&&r.windows[period]?.curve.length>1)graph.append(chart(r.windows[period]));
  else graph.append(node('span',isPublicAccount(r)?'盈亏曲线':'收益曲线','curve-label'),node('span','—','curve-unavailable'));
}
function refreshAnalyticsViews(address) {
  for(const view of state.analyticsViews.filter(v=>v.r.accountId===address)) {
    const fresh=metrics(performanceWindow(view.r,view.period),view.r.currency,view.kind==='detail',view.r,view.period);
    view.metrics.replaceChildren(...fresh.children);fillPerformanceGraph(view.r,view.period,view.graph);
    if(view.winNote)fillWinCacheNote(view.r,view.winNote);if(view.roi)fillPerformanceSummary(view.r,view.period,view);
    if(view.kind==='detail') {
      const portfolio=portfolioSection(view.r),window=portfolio?.windows?.[view.period],entry=cachedWin(view.r),win=entry?.win;
      view.portfolioStatus.textContent=portfolio?.status==='ready'?(window?.sampleCount>1?`来源采样 ${window.sampleCount} 点 · ${timeLabel(window.startAt)} 至 ${timeLabel(window.endAt)}${window.mdd==null?' · '+mddReason(window.mddUnavailableReason):''}${derivedPeriods.includes(view.period)?' · '+performanceRange(view.r,view.period):''}${portfolio.fetchedAt?' · 采集 '+timeLabel(portfolio.fetchedAt):''}${portfolio.stale?' · 上次成功采样':''}`:'来源未提供当前周期的有效曲线样本。'):portfolio?.status==='error'?'曲线读取失败，尚未取得可用数据。':portfolio?.status==='queued'?'正在排队读取来源盈亏曲线…':portfolio?.status==='loading'?'正在读取来源盈亏曲线…':'尚未取得当前窗口的盈亏曲线。';
      view.winStatus.textContent=win?(win.eligibleCount?`平仓成交 ${win.eligibleCount} 笔 · 盈利 ${win.winning} · 亏损 ${win.losing} · 持平 ${win.breakeven}；样本 ${timeLabel(win.startAt)} 至 ${timeLabel(win.endAt)}`:'最近成交中没有可统计的永续平仓样本。')+` · 后台采集 ${timeLabel(entry.fetchedAt)}${entry.lastAttemptAt?' · 最近尝试 '+timeLabel(entry.lastAttemptAt):''}${winCacheIsStale(entry)?' · 上次成功结果，等待后台更新':''}`:'后台尚未取得有效平仓样本；取得后自动显示。'+(entry?.lastAttemptAt?' · 最近尝试 '+timeLabel(entry.lastAttemptAt):'');
      view.winStatus.setAttribute('data-state',winCacheIsStale(entry)?'stale':win?'ready':'unavailable');
      view.portfolioButton.hidden=portfolio?.status!=='error';view.portfolioButton.disabled=['queued','loading'].includes(portfolio?.status);

    }
  }
}
function startVisibleAnalytics(rows,onlyChanged=false) {
  const visible=rows.filter(r=>canReadLive(r)&&qualifiedPosition(r)),waiting=state.portfolioCacheLoading&&!state.portfolioCacheAttempted;
  const accounts=[...new Set((waiting?[]:visible.filter(r=>{const entry=state.portfolioCache[r.accountId];return !entry?.portfolio||Date.now()-Date.parse(entry.fetchedAt)>3600000;})).map(r=>r.accountId))].slice(0,12),client=accounts.length?ensureAnalyticsClient():state.analyticsClient;
  if(onlyChanged&&accounts.length===state.analyticsTargets.length&&accounts.every((address,i)=>address===state.analyticsTargets[i]))return;
  state.analyticsTargets=accounts;client?.setPortfolioTargets(accounts);
}
function card(r,period) {
  const w=performanceWindow(r,period),c=node('article',undefined,'card'),top=node('div',undefined,'card-top'),identity=node('div',undefined,'card-identity'),links=node('div',undefined,'card-links');
  const name=node('h3',r.name);name.setAttribute('title',r.name);
  const identityMeta=node('div',`${r.exchange}${r.paid?' · 付费来源':''}${r._local?' · 我的资料':''}`,'meta');identityMeta.setAttribute('title',r.accountId||r.id);identity.append(name,identityMeta);
  const detail=button('详情',()=>openDetail(r,period),'detail-button'),source=sourceLink(r);detail.setAttribute('aria-label',`查看 ${r.name} 的研究详情`);source.textContent='来源 ↗';source.setAttribute('title',`打开 ${r.exchange} 来源账户`);links.append(detail,source);
  top.append(node('div',r.exchange.slice(0,2),'avatar'),identity,links);c.append(top);
  const context=node('div',undefined,'card-context');context.append(node('span',periodName(period,w)));
  let timing=w?.derived?performanceRange(r,period):stampLabel(w);
  if(isPublicAccount(r)&&r.positionCheck){const check=node('span',`持仓 ${r.positionCheck.count} · 核验 ${new Date(r.positionCheck.checkedAt).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'})}`,'position-check');context.append(check);timing+=` · 永续主市场持仓核验 ${timeLabel(r.positionCheck.checkedAt)} · 持仓来源时间 ${timeLabel(r.positionCheck.sourceTime)}`;}
  else context.append(node('span',r.currency));
  context.setAttribute('title',timing);c.append(context);
  if(hasMetrics(w)||isPublicAccount(r)) {
    const performance=node('div',undefined,'performance-body'),stats=node('div',undefined,'performance-stats'),graph=node('div',undefined,'performance-chart'),roiText=signedValue(w?.roi,pct(w?.roi));
    const roi=node('div',roiText,'roi '+directionClass(w?.roi)+(roiText.length>8?' long-roi':''));roi.setAttribute('title',`${displayPeriod(period,w)} 收益率 ${roiText}`);
    const roiLabel=node('div',undefined,'roi-label');stats.append(roi,roiLabel);
    const figures=metrics(w,r.currency,false,r,period);stats.append(figures);fillPerformanceGraph(r,period,graph);
    performance.append(stats,graph);c.append(performance);
    if(isPublicAccount(r)){const rangeNote=node('p',undefined,'performance-range'),winNote=node('p',undefined,'win-cache-note'),view={kind:'card',r,period,metrics:figures,graph,winNote,rangeNote,roi,roiLabel,cardRoot:c,detailButton:detail,sourceLink:source};fillWinCacheNote(r,winNote);fillPerformanceSummary(r,period,view);c.append(rangeNote,winNote);state.analyticsViews.push(view);}else{roiLabel.textContent=`${displayPeriod(period,w)} 收益率`;}
  } else c.append(node('p',Object.keys(r.windows).length?`${displayPeriod(period,w)} 表现 —`:'账号与来源已保存','meta'));
  if(r.note)c.append(node('p',r.note,'profile-note'));
  if(r._local){const actions=node('div',undefined,'card-actions');actions.append(button('编辑',()=>openEditor(r)),button('删除',()=>removeRecord(r)));c.append(actions);}
  return c;
}
function readURL() {
  const p=new URL(location.href).searchParams, defaults={period:'30D',exchange:'all',source:'all',sort:'pnl',currency:'all'};
  state.explicitPeriod=periods.includes(p.get('period'));
  for(const id of controls) { const el=$(id); el.value=[...el.options].some(o=>o.value===p.get(id))?p.get(id):defaults[id]; }
  $('search').value=(p.get('q')||'').slice(0,100); const page=Number(p.get('page')); state.page=Number.isSafeInteger(page)&&page>0?page:1;
}
function saveURL(replace=false) {
  const url=new URL(location.href); for(const id of controls)url.searchParams.set(id,$(id).value);
  const q=$('search').value.trim(); if(q)url.searchParams.set('q',q);else url.searchParams.delete('q');
  if(state.page>1)url.searchParams.set('page',state.page);else url.searchParams.delete('page');
  if(url.href!==location.href)history[replace?'replaceState':'pushState'](null,'',url.pathname+url.search+url.hash);
}
function choosePeriod() {
  if(state.explicitPeriod)return;
  const available=periods.filter(p=>state.rows.some(r=>hasMetrics(r.windows[p])));
  if(available.length && !available.includes($('period').value))$('period').value=available.includes('90D')?'90D':available[0];
}
function render() {
  const q=$('search').value.trim().toLocaleLowerCase(),p=$('period').value,source=$('source').value,currency=$('currency').value;
  const available=state.rows.filter(r=>qualifiedPosition(r)&&((source==='local')?r._local:!r._local));
  let rows=available.filter(r=>(r.name+' '+r.id+' '+r.accountId+' '+r.exchange+' '+r.note).toLocaleLowerCase().includes(q) && ($('exchange').value==='all'||r.exchange===$('exchange').value) && (source==='all'||source==='local'&&r._local||source==='paid'&&r.paid||source==='public'&&!r._local&&!r.paid) && (currency==='all'||r.currency===currency));
  $('sort-hint').textContent=$('sort').value==='winRate'?'按后台平仓样本胜率排序 · 缺数账户排在后面':$('sort').value==='mdd'?'按已有回撤排序 · 缺数账户排在后面 · 新结果在重新选择排序后应用':'仅显示已核验持仓账户 · 永续主市场';
  const sort=$('sort').value,grouped=sort==='pnl'&&currency==='all'&&new Set(rows.map(r=>r.currency)).size>1;
  rows.sort((a,b)=>{
    if(grouped&&a.currency!==b.currency)return currencies.indexOf(a.currency)-currencies.indexOf(b.currency);
    const va=sortValue(a,p,sort),vb=sortValue(b,p,sort);
    if(va==null&&vb==null)return a.id.localeCompare(b.id);if(va==null)return 1;if(vb==null)return -1;
    return (sort==='mdd'?va-vb:vb-va)||a.id.localeCompare(b.id);
  });
  const pages=Math.max(1,Math.ceil(rows.length/12));if(state.revealId){const at=rows.findIndex(r=>r.id===state.revealId);if(at>=0)state.page=Math.floor(at/12)+1;state.revealId=null;}if(!state.loading)state.page=Math.max(1,Math.min(state.page,pages));
  state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='card');
  const visibleRows=rows.slice((state.page-1)*12,state.page*12);
  $('leaders').replaceChildren();for(const r of visibleRows)$('leaders').append(card(r,p));
  if(!rows.length) {
    if(source==='local')empty($('leaders'),available.length?'没有符合条件的资料':'暂无本机资料',available.length?'调整筛选条件，查看其他记录。':'已保存的个人资料仅在这里显示。');
    else if(!available.length&&state.source)empty($('leaders'),'暂无有效持仓账户',state.source.positionVerification?'当前没有仍在 60 分钟核验有效期内的持仓账户；新一轮核验后自动更新。':'现有快照尚未核验持仓，核验完成后显示账户。');
    else empty($('leaders'),available.length?'没有符合条件的账户':'暂无持仓账户',available.length?'调整筛选条件，查看其他账户。':'取得有效持仓数据后显示账户。');
  }
  $('featured').replaceChildren();const featured=available.filter(r=>r.featured);$('featured-section').hidden=!featured.length;
  for(const r of featured) { const best=hasMetrics(r.windows.ALL)?'ALL':hasMetrics(r.windows[p])?p:periods.find(k=>hasMetrics(r.windows[k]))||p; $('featured').append(card(r,best)); }
  $('total-count').textContent=state.rows.filter(r=>!r._local&&qualifiedPosition(r)).length;$('coverage-count').textContent=state.rows.filter(r=>!r._local&&qualifiedPosition(r)&&Object.values(r.windows).some(hasMetrics)).length;$('local-count').textContent=state.localRows.length;
  $('count').textContent=`${rows.length} 个研究账户${available.length!==rows.length?' · 共 '+available.length+' 个':''}${grouped?' · 按币种分组':''}`;
  $('page').textContent=rows.length?`${state.page} / ${pages}`:'0 / 0';$('prev').disabled=state.loading||!rows.length||state.page===1;$('next').disabled=state.loading||!rows.length||state.page>=pages;
  startVisibleAnalytics(visibleRows);
}
function statusText() {
  if(state.source&&state.publicRows.some(isPublicAccount)&&!eligiblePublicRows().length)return state.source.positionVerification?'持仓核验已过期或账户已空仓，等待新一轮核验。':'持仓尚未核验，公开账户暂不显示。';
  if(state.source?.positionVerification&&!state.publicRows.length)return '本次核验没有可展示的持仓账户。';
  if(state.publicRows.length&&sourceIsStale())return state.lastReadFailed?'更新失败 · 仍显示上次验证的快照':'快照待更新 · 以下为最近一次成功采集的数据';
  if(state.status==='error')return state.localRows.length?'公开资料暂不可用；我的资料仍可查看。':'公开资料暂不可用。';
  if(state.publicRows.length)return state.source?'已接入真实公开数据':`公开资料 ${state.publicRows.length} 个`;
  return state.localRows.length?'我的资料保存在当前浏览器。':'公开资料 0 个';
}
function updateView(message) { mergeRows();choosePeriod();render();renderSource();if(message)feedback(message); }
function renderDetailStatus() {
  const r=state.detail;let message='';
  if(r&&isPublicAccount(r)) {
    if((state.positionExclusions[r.accountId]??-Infinity)>=Date.parse(r.positionCheck?.checkedAt||'1970-01-01T00:00:00Z'))message='当前已空仓，已从名单移除。';
    else if(!qualifiedPosition(r))message='持仓核验已过期或尚未完成，已从名单移除；历史表现仍可查看。';
    else if(!state.publicRows.some(item=>item.id===r.id))message='该账户已不在本次收录范围，详情保留上次验证的记录。';
    else if(sourceIsStale())message='此处显示上次验证的快照，最新数据暂未取得。';
  }
  if(message&&state.tab==='live'&&qualifiedPosition(r))message='排行快照待更新；下方账户明细独立读取。';
  $('detail-data-status').textContent=message;$('detail-data-status').hidden=!message;
}
function canReadLive(r) {return !!r&&isPublicAccount(r)&&r.exchange==='Hyperliquid'&&/^0x[0-9a-f]{40}$/.test(r.accountId);}
function stopLive() {
  state.liveVersion++;const client=state.liveClient;state.liveClient=null;state.liveUser=null;state.liveData=null;state.liveView=null;
  if(client)client.stop();
}
function liveTime(stamp) {if(stamp==null)return '—';const d=new Date(stamp);return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN',{hour12:false}):'—';}
function liveDirection(direction) {return ({'Open Long':'开多','Close Long':'平多','Open Short':'开空','Close Short':'平空','Long > Short':'多转空','Short > Long':'空转多','Buy':'买入','Sell':'卖出'})[direction]||direction||'—';}
function liveOrderStatus(status) {return ({open:'挂单中',filled:'已成交',canceled:'已撤销',triggered:'已触发',rejected:'已拒绝',marginCanceled:'保证金原因撤销',vaultWithdrawalCanceled:'金库提取导致撤销',openInterestCapCanceled:'持仓限额撤销',selfTradeCanceled:'自成交保护撤销',reduceOnlyCanceled:'只减仓限制撤销',siblingFilledCanceled:'关联订单成交后撤销',delistedCanceled:'下架撤销'})[status]||status||'—';}
function liveCoin(coin,data) {const symbol=data.symbols?.spot?.[coin];return symbol?`${symbol.label} (${coin})`:coin;}
function liveAmount(amount,coin,data) {const quote=data.symbols?.spot?.[coin]?.quote;return value(amount)+(quote?' '+quote:'');}
function livePnl(amount,coin,data) {const quote=data.symbols?.spot?.[coin]?.quote;if(quote)return value(amount)+' '+quote;if(!coin.includes(':')&&!coin.startsWith('@')&&!coin.includes('/'))return value(amount)+' USDC';return value(amount);}
function liveSide(side) {return ({buy:'买',sell:'卖',long:'多',short:'空'})[side]||'—';}
function liveSection(title,columns) {
  const section=node('section',undefined,'live-section'),heading=node('div',undefined,'live-section-head'),status=node('p',undefined,'live-section-status'),count=node('span',undefined,'live-count'),wrap=node('div',undefined,'table-wrap live-table-wrap'),table=node('table'),thead=node('thead'),tr=node('tr'),tbody=node('tbody'),emptyMessage=node('p',undefined,'live-empty');
  heading.append(node('h3',title),count);for(const label of columns){const th=node('th',label);th.setAttribute('scope','col');tr.append(th);}thead.append(tr);table.append(thead,tbody);wrap.append(table);section.append(heading,status,emptyMessage,wrap);return {section,status,count,wrap,tbody,emptyMessage};
}
function buildLivePanel(r,b) {
  const root=node('div',undefined,'live-panel'),toolbar=node('div',undefined,'live-toolbar'),connection=node('p','正在连接…','live-connection'),retry=button('刷新连接',()=>state.liveClient?.refresh(),'live-refresh'),scope=node('p','持仓与挂单每 60 秒对齐 · 成交与订单事件实时推送 · 持仓范围：永续主市场','live-scope'),gap=node('p',undefined,'live-gap');
  connection.setAttribute('role','status');connection.setAttribute('aria-live','polite');toolbar.append(connection,retry);root.append(toolbar,scope,gap);
  const sections={
    positions:liveSection('当前持仓',['品种','方向','数量','开仓均价（报价币）','仓位价值（报价币）','未实现盈亏（USDC）','杠杆']),
    orders:liveSection('当前挂单',['挂单时间','品种','买卖','限价','剩余数量','名义金额（报价币）','类型','只减仓']),
    fills:liveSection('最近成交',['成交时间','品种','动作','买卖','成交价格','成交数量','成交额（报价币）','手续费','已实现盈亏（结算币）','订单 ID']),
    events:liveSection('订单事件',['事件时间','品种','状态','买卖','限价','剩余数量','订单 ID'])
  };
  for(const item of Object.values(sections))root.append(item.section);
  root.append(node('p','每行成交为一笔实际撮合，可能只是订单的一部分；当前最多显示最近 200 笔，非完整历史。主市场永续价格采用来源报价，盈亏以 USDC 记账；现货采用来源交易对报价币，@ 开头的品种保留现货代码。未确认的其他市场结算币不强行标注。仅在本面板打开且页面可见时连接，离开后不后台留存。','live-footnote'));
  b.append(root);state.liveView={root,connection,retry,gap,sections};state.liveUser=r.accountId;const version=++state.liveVersion;
  if(typeof BooksAccountLive==='undefined'){connection.textContent='实时数据模块暂未加载，请刷新页面。';retry.disabled=true;return;}
  try {
    state.liveClient=BooksAccountLive.create({visible:document.visibilityState!=='hidden',onChange:data=>{
      if(version!==state.liveVersion||state.tab!=='live'||state.detail?.accountId!==r.accountId||!state.liveView||data.address!==r.accountId)return;
      state.liveData=data;observeEmptyPositions(r,data.positions);renderLiveData();
    }});
    state.liveClient.start(r.accountId);
  } catch {connection.textContent='实时连接暂不可用，可重新打开此面板。';}
}
function renderLiveData() {
  const data=state.liveData,view=state.liveView;if(!data||!view)return;
  const c=data.connection||{},labels={idle:'准备连接',connecting:'正在连接实时流…',connected:'连接已建立，等待订阅确认…',live:'实时推送已连接',error:'实时连接中断',reconnecting:'正在重新连接…',paused:'页面不可见，更新已暂停',closed:'实时连接已关闭'};
  view.connection.textContent=(labels[c.status]||'实时状态暂不可用')+(c.lastMessageAt?' · 最近接收 '+liveTime(c.lastMessageAt):'');view.connection.setAttribute('data-state',c.status||'idle');
  view.retry.disabled=['connecting','reconnecting'].includes(c.status);
  view.gap.textContent=c.gap?'重连或暂停期间可能有记录缺口；当前展示重新取得的近期记录，不代表完整历史。':'';view.gap.hidden=!c.gap;
  const emptyMessages={positions:'当前没有持仓（永续主市场）。',orders:'当前没有未成交挂单。',fills:'来源未返回近期成交。',events:'连接期间尚未收到订单事件。'};
  for(const key of ['positions','orders','fills','events']) {
    const part=data[key]||{status:'idle',rows:[]},target=view.sections[key],rows=Array.isArray(part.rows)?part.rows:[];
    const stamp=(part.sourceTime?' · 来源时间 '+liveTime(part.sourceTime):'')+(part.fetchedAt?' · 读取于 '+liveTime(part.fetchedAt):'');
    target.status.textContent=part.status==='error'?'本项更新失败'+(rows.length?'，保留上次读取的记录。':'，尚未取得有效数据。')+stamp:part.status==='loading'?'正在读取'+(rows.length?'，暂显示上次记录。':'…'):part.status==='ready'?(key==='fills'?`最近 ${rows.length} 笔逐笔成交${part.receivedCount>rows.length?' · 来源本次返回 '+part.receivedCount+' 笔':''}`:key==='events'?`本次连接期间最近 ${rows.length} 条订单变化（最多保留 200 条）`:'已读取当前快照')+stamp:'等待来源数据…';
    const oldSource=part.sourceTime!=null&&Date.now()-part.sourceTime>120000;
    if(part.status==='ready'&&oldSource)target.status.textContent='来源快照较旧，暂保留已读取记录'+stamp;
    target.status.setAttribute('data-state',part.status==='error'?'error':oldSource?'stale':part.status);
    target.count.textContent=part.status==='ready'||rows.length?String(rows.length):'—';target.emptyMessage.hidden=rows.length>0;target.emptyMessage.textContent=part.status==='ready'?emptyMessages[key]:part.status==='error'?'暂不可用':'正在读取…';target.wrap.hidden=!rows.length;target.tbody.replaceChildren();
    for(const row of rows) {
      let cells;
      if(key==='positions')cells=[liveCoin(row.coin,data),liveSide(row.side),value(row.quantity),value(row.entryPrice),value(row.positionValue),value(row.unrealizedPnl),row.leverage?`${value(row.leverage.value)}× ${row.leverage.type==='cross'?'全仓':row.leverage.type==='isolated'?'逐仓':row.leverage.type}`:'—'];
      if(key==='orders')cells=[liveTime(row.time),liveCoin(row.coin,data),liveSide(row.side),liveAmount(row.price,row.coin,data),value(row.quantity),liveAmount(row.notional,row.coin,data),row.orderType||'—',row.reduceOnly==null?'—':row.reduceOnly?'是':'否'];
      if(key==='fills')cells=[liveTime(row.time),liveCoin(row.coin,data),liveDirection(row.direction),liveSide(row.side),liveAmount(row.price,row.coin,data),value(row.quantity),liveAmount(row.notional,row.coin,data),row.fee==null?'—':value(row.fee)+' '+(row.feeToken||''),livePnl(row.closedPnl,row.coin,data),row.orderId??'—'];
      if(key==='events')cells=[liveTime(row.statusTime),liveCoin(row.coin,data),liveOrderStatus(row.status),liveSide(row.side),liveAmount(row.price,row.coin,data),value(row.quantity),row.orderId??'—'];
      const tr=node('tr');for(const cell of cells)tr.append(node('td',String(cell??'—')));target.tbody.append(tr);
    }
  }
}
function activateDetailTab(tab) {
  if(!state.detail||!['analysis','live','positions','points','orders'].includes(tab)||tab===state.tab)return;
  if(tab==='live'&&!canReadLive(state.detail))return;
  if(canReadLive(state.detail)&&!['analysis','live'].includes(tab))return;
  if(state.tab==='live')stopLive();state.tab=tab;renderDetail();
}
function openDetail(r,p) {
  stopLive();state.detail=r;state.window=p;state.tab='analysis';$('detail-title').textContent=r.name;
  $('detail-meta').textContent=`${r.exchange} · ${r.accountId||r.id} · ${r.currency}${r._local?' · 我的资料':''}`;
  renderDetail();$('detail').showModal();$('close').focus();
}
function renderDetail() {
  const r=state.detail,b=$('detail-body');if(!r)return;
  $('detail-title').textContent=r.name;$('detail-meta').textContent=`${r.exchange} · ${r.accountId||r.id} · ${r.currency}${r._local?' · 我的资料':''}`;
  renderDetailStatus();
  document.querySelectorAll('[data-tab]').forEach(x=>{x.hidden=canReadLive(r)?!['analysis','live'].includes(x.dataset.tab):x.dataset.tab==='live';x.setAttribute('aria-pressed',String(x.dataset.tab===state.tab));});
  if(state.tab==='live'&&canReadLive(r)){state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='detail');if(!state.liveView||state.liveUser!==r.accountId){stopLive();b.replaceChildren();buildLivePanel(r,b);}return;}
  b.replaceChildren();state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='detail');
  if(state.tab==='analysis') {
    const w=performanceWindow(r,state.window);b.append(node('h3',`${periodName(state.window,w)} 表现`));
    if(isPublicAccount(r)) {
      b.append(node('p','来源自填昵称与链上地址；未核验真人身份或带单资格。','detail-method'));
      if(r.accountValue!=null)b.append(node('p',`账户权益 ${money(r.accountValue,'USD')} USD`,'account-equity'));
    }
    if(hasMetrics(w)||isPublicAccount(r)) {
      const figures=metrics(w,r.currency,true,r,state.window);b.append(figures,node('p',w?.derived?performanceRange(r,state.window):stampLabel(w),'meta'));if(isPublicAccount(r)&&derivedPeriods.includes(state.window))b.append(node('p','区间盈亏来自实际首末采样差；该窗口缺少可核验的出入金调整收益率，收益率留空。','detail-method'));
      if(isPublicAccount(r)) {
        const graph=node('div',undefined,'detail-pnl-chart'),portfolioStatus=node('p',undefined,'meta'),portfolioButton=button('重试曲线',()=>ensureAnalyticsClient()?.ensurePortfolio(r.accountId,{force:true}),'portfolio-retry'),winStatus=node('p',undefined,'meta win-cache-status');
        portfolioButton.hidden=true;b.append(graph,portfolioStatus,portfolioButton,winStatus);state.analyticsViews.push({kind:'detail',r,period:state.window,metrics:figures,graph,portfolioStatus,portfolioButton,winStatus});refreshAnalyticsViews(r.accountId);if(state.analyticsTargets.includes(r.accountId))ensureAnalyticsClient()?.ensurePortfolio(r.accountId);
      }else {if(w.curve.length>1)b.append(chart(w));if(w.closedTrades!=null||w.wins!=null)b.append(node('p',`已关闭交易 ${value(w.closedTrades)} 笔 · 盈利交易 ${value(w.wins)} 笔`));}
    }
    else b.append(node('p','当前周期暂无表现记录。'));
    if(isPublicAccount(r))b.append(node('p','收益率与盈亏采用来源榜单值。来源采样回撤以来源盈亏从峰值的回落额除以峰值时账户权益，不是剔除出入金后的策略净值回撤，可能超过 100%。曲线显示实际来源样本的盈亏变化。90/180/365天区间取来源累计历史中实际落入窗口的采样，不插值、不把累计收益率改名为区间收益率。来源累计仅代表已返回历史，非完整账户历史。平仓成交胜率按最近最多 2000 笔成交中的永续平仓样本统计，按该笔已实现盈亏扣平仓成交手续费判断盈亏，未扣除对应开仓手续费和资金费；持平计入分母。它不等同于完整订单、开平仓回合或当前所选周期的胜率。资料不足时留空。','detail-method'));
    if(r.note)b.append(node('h3','研究备注'),node('p',r.note,'profile-note'));
    b.append(sourceLink(r));return;
  }
  const rows=r[state.tab];b.append(node('p',`${rows.length} 条来源记录 · 未按广场周期裁剪`));
  if(!rows.length){empty(b,'暂无记录','此来源尚未提供该项数据。');return;}
  const wrap=node('div',undefined,'table-wrap'),table=node('table'),head=node('thead'),tr=node('tr');
  for(const title of ['时间（含时区）','品种','方向','价格','数量','盈亏 '+r.currency])tr.append(node('th',title));head.append(tr);
  const tbody=node('tbody');for(const row of rows){const t=node('tr');for(const v of [row.time,row.symbol,row.side,value(row.price),value(row.quantity),value(row.pnl)])t.append(node('td',v));tbody.append(t);}
  table.append(head,tbody);wrap.append(table);b.append(wrap);
}
function loadLocal() {
  try { const saved=localStorage.getItem(storageKey);if(saved){if(new Blob([saved]).size>maxBytes)fail();state.localRows=validate(JSON.parse(saved));}state.storageReadError=false; }
  catch { state.storageReadError=true;feedback('本机资料读取失败，原有存储未改动。本次已暂停写入，请稍后刷新重试。'); }
  mergeRows();
}
function commitLocal(rows) {
  if(state.storageReadError)throw Error('旧资料尚未成功读取，原有存储未改动，暂不能写入。请稍后刷新重试。');
  const checked=validate(feed(rows)),serialized=JSON.stringify(feed(checked));
  if(new Blob([serialized]).size>maxBytes)throw Error('本机资料超过 2 MB，本次未保存。请先整理已有资料。');
  try { localStorage.setItem(storageKey,serialized); } catch { throw Error('浏览器未能保存资料，请检查存储权限或剩余空间。现有资料未改动。'); }
  state.localRows=checked;mergeRows();return checked;
}
function localDateValue(iso) {
  if(!iso)return '';const d=new Date(iso),pad=v=>String(v).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fillWindow(period) {
  const w=state.editor.windows[period];state.editor.period=period;
  $('record-period').value=period;$('record-asof').value=localDateValue(w?.asOf);
  for(const [id,key]of [['roi','roi'],['pnl','pnl'],['mdd','mdd'],['wins','wins'],['trades','closedTrades']])$('record-'+id).value=w?.[key]??'';
}
function openEditor(record) {
  const r=record?validate(feed([record]))[0]:null;
  state.editor={id:r?.id||'',original:r,windows:r?JSON.parse(JSON.stringify(r.windows)):{},period:'30D'};
  $('record-editor-title').textContent=r?'编辑带单员':'添加带单员';$('record-error').textContent='';
  for(const [field,v]of Object.entries({id:r?.id||'',name:r?.name||'',account:r?.accountId||'',exchange:r?.exchange||'OKX',currency:r?.currency||'USDT',source:r?.sourceUrl||'',note:r?.note||''}))$('record-'+field).value=v;
  $('record-featured').checked=r?.featured||false;
  const p=r&&r.windows[$('period').value]?$('period').value:r&&Object.keys(r.windows).length?Object.keys(r.windows)[0]:$('period').value;
  fillWindow(p);$('record-editor').showModal();$('record-name').focus();
}
function captureWindow() {
  const editor=state.editor,p=editor.period,previous=editor.windows[p],rawDate=$('record-asof').value;
  const values={};for(const [id,key]of [['roi','roi'],['pnl','pnl'],['mdd','mdd'],['wins','wins'],['trades','closedTrades']]) { const raw=$('record-'+id).value.trim();values[key]=raw===''?null:Number(raw); }
  const any=Object.values(values).some(v=>v!==null),curve=previous?.curve||[];
  if(!any&&!curve.length&&!rawDate){delete editor.windows[p];return;}
  if(!rawDate)throw Error('填写表现数值后，请同时填写数据截至时间。');
  let asOf;
  if(previous&&rawDate===localDateValue(previous.asOf))asOf=previous.asOf;
  else {const timestamp=Date.parse(rawDate);if(!Number.isFinite(timestamp))throw Error('请填写有效的数据时间。');asOf=new Date(timestamp).toISOString();}
  const candidate={asOf,...values,curve};
  if(previous?.asOfType&&asOf===previous.asOf)candidate.asOfType=previous.asOfType;
  const trial={id:'validation',name:'validation',exchange:'OKX',currency:'USDT',featured:false,paid:false,observedAt:new Date().toISOString(),sourceUrl:'https://example.com/',windows:{[p]:candidate},positions:[],points:[],orders:[]};
  try {validate(feed([trial]));} catch {throw Error('请检查表现数值、交易笔数与日期；最大回撤应为 0–100，盈利笔数不能超过已关闭交易数，日期须覆盖已有曲线。');}
  editor.windows[p]=candidate;
}
function changeEditorPeriod() {
  const next=$('record-period').value,previous=state.editor.period;
  try {captureWindow();fillWindow(next);$('record-error').textContent='';} catch(e){$('record-period').value=previous;$('record-error').textContent=e.message;}
}
function saveRecord(event) {
  event?.preventDefault();if(!state.editor)return;
  try {
    captureWindow();const original=state.editor.original;
    if(original&&original.currency!==$('record-currency').value&&(Object.keys(state.editor.windows).length||['positions','points','orders'].some(k=>original[k].length)))throw Error('已有表现或交易记录时不能直接更换计价币种，请为新币种添加另一份资料。');
    const r={id:state.editor.id||'local-'+crypto.randomUUID(),name:$('record-name').value.trim(),accountId:$('record-account').value.trim(),exchange:$('record-exchange').value,currency:$('record-currency').value,sourceUrl:$('record-source').value.trim(),note:$('record-note').value.trim(),featured:$('record-featured').checked,paid:original?.paid||false,observedAt:new Date().toISOString(),windows:state.editor.windows,positions:original?.positions||[],points:original?.points||[],orders:original?.orders||[]};
    let checked;try {checked=validate(feed([r]))[0];}catch {throw Error('请检查名称、账号和来源链接；来源须为不含账号密码的 HTTPS 地址。');}
    const rows=state.localRows.filter(item=>item.id!==checked.id);rows.push(checked);commitLocal(rows);
    $('search').value='';$('exchange').value='all';$('source').value='local';$('currency').value='all';$('period').value=state.editor.period;state.explicitPeriod=true;state.page=1;state.revealId=checked.id;
    $('record-editor').close();state.editor=null;updateView('已保存到当前浏览器。');saveURL();
  }catch(e){$('record-error').textContent=e.message;const details=$('record-asof').closest('details');if(details)details.open=true;if(!$('record-asof').value&&['roi','pnl','mdd','wins','trades'].some(k=>$('record-'+k).value!==''))$('record-asof').focus();}
}
function removeRecord(r) {
  if(!r._local||!confirm(`删除「${r.name}」的本机资料？`))return;
  try {commitLocal(state.localRows.filter(item=>item.id!==r.id));if(state.detail?.id===r.id){$('detail').close();state.detail=null;}updateView('已删除这份本机资料。');saveURL(true);}catch(e){feedback(e.message);}
}
async function refresh(background=false) {
  if(state.loading)return;const winRequest=refreshWinCache(),portfolioRequest=refreshPortfolioCache();const restoreFocus=!background&&document.activeElement===$('refresh');
  state.loading=true;$('refresh').disabled=true;$('leaders').setAttribute('aria-busy','true');if(!background)$('status').textContent='正在检查最新快照…';
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);let changed=false;
  try {
    const response=await fetch('feed.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});if(!response.ok)throw Error('公开资料暂不可用');
    if(Number(response.headers.get('content-length'))>maxBytes)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();fail();}chunks.push(value);}
    const serialized=await new Blob(chunks).text(),data=JSON.parse(serialized),rows=validate(data),source=validateSource(data,rows);
    if(data.status==='unavailable'&&state.publicRows.length)throw Error('最新快照不可用');
    changed=state.feedText!==serialized;state.feedText=serialized;state.publicRows=rows;state.source=source;state.status=data.status==='unavailable'&&data.source?.status==='error'?'error':data.status;state.lastReadFailed=state.status==='error';
    if(state.detail&&!state.detail._local) {const latest=rows.find(r=>r.id===state.detail.id);if(latest)state.detail={...latest,_local:false};}
  } catch(e) {state.status='error';state.lastReadFailed=true;}
  finally {
    clearTimeout(timeout);state.loading=false;$('refresh').disabled=false;$('leaders').setAttribute('aria-busy','false');
    if(changed||!background)updateView();else reevaluatePositions();
    if(changed&&state.detail&&!state.detail._local&&$('detail').open)renderDetail();
    saveURL(true);if(restoreFocus&&document.activeElement===document.body)$('refresh').focus();
  }
  await Promise.all([winRequest,portfolioRequest]);
}
for(const id of controls)$(id).addEventListener('change',()=>{if(id==='period')state.explicitPeriod=true;state.page=1;render();saveURL();});
$('search').addEventListener('input',()=>{state.page=1;render();saveURL(true);});
$('reset').onclick=()=>{$('search').value='';$('period').value='30D';$('exchange').value='all';$('source').value='all';$('sort').value='pnl';$('currency').value='all';state.explicitPeriod=false;state.page=1;choosePeriod();render();saveURL();};
$('prev').onclick=()=>{state.page--;render();saveURL();};$('next').onclick=()=>{state.page++;render();saveURL();};$('refresh').onclick=()=>refresh();
$('add-trader').onclick=()=>openEditor();
$('record-form').addEventListener('invalid',e=>{const details=e.target.closest('details');if(details)details.open=true;},true);
$('record-form').addEventListener('submit',saveRecord);$('record-period').addEventListener('change',changeEditorPeriod);
for(const id of ['editor-close','editor-cancel'])$(id).onclick=()=>$('record-editor').close();
$('record-editor').addEventListener('close',()=>{state.editor=null;});$('close').onclick=()=>$('detail').close();
const tabs=[...$('tabs').querySelectorAll('[data-tab]')];
function selectTab(b){if(!state.detail||!tabs.includes(b)||b.hidden)return;activateDetailTab(b.dataset.tab);}
$('tabs').addEventListener('click',e=>selectTab(e.target.closest('[data-tab]')));
$('tabs').addEventListener('keydown',e=>{const visibleTabs=tabs.filter(b=>!b.hidden),i=visibleTabs.indexOf(e.target);if(i<0)return;let n;if(e.key==='ArrowRight')n=(i+1)%visibleTabs.length;else if(e.key==='ArrowLeft')n=(i+visibleTabs.length-1)%visibleTabs.length;else if(e.key==='Home')n=0;else if(e.key==='End')n=visibleTabs.length-1;else return;e.preventDefault();visibleTabs[n].focus();selectTab(visibleTabs[n]);});
$('detail').addEventListener('close',()=>{stopLive();state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='detail');state.detail=null;});
addEventListener('popstate',()=>{if($('detail').open)$('detail').close();readURL();choosePeriod();render();});
readURL();loadLocal();state.loading=true;choosePeriod();render();state.loading=false;refresh();
setInterval(()=>{reevaluatePositions();if(document.visibilityState==='visible')refresh(true);},60000);
document.addEventListener('visibilitychange',()=>{state.analyticsClient?.setVisible(document.visibilityState==='visible');state.liveClient?.setVisible(document.visibilityState==='visible');if(document.visibilityState==='visible'){reevaluatePositions();refresh(true);}});
})();
