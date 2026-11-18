'use strict';
(() => {
const $ = id => document.getElementById(id);
const publicListPage = typeof document!=='undefined'&&document.body.dataset.publicList==='true';
const periods = ['7D','30D','90D','180D','365D','ALL'], derivedPeriods=['90D','180D','365D'];
const exchanges = ['Binance','OKX','Hyperliquid','Gate','Bitget','Bybit','Polymarket'];
const currencies = ['USDT','USD','USDC','BTC','ETH'];
const controls = ['period','exchange','source','sort','currency'];
const storageKey = 'books.trader.records.v1', maxBytes = 2097152;
const publicCacheKeys={feed:'books.trader.public.feed.v1',win:'books.trader.public.analytics.v1',binance:'books.trader.public.binance.v1'},publicSnapshots={feed:null,win:null,binance:null};
const state = {status:'unavailable', publicRows:[], binanceRows:[], binanceCollection:null, binanceReadFailed:false, binanceCheckedAt:null, binanceText:null, localRows:[], rows:[], page:1, detail:null, window:'30D', tab:'analysis', loading:false, explicitPeriod:false, editor:null, storageReadError:false, revealId:null, source:null, lastReadFailed:false, feedText:null, liveClient:null, liveUser:null, liveData:null, liveView:null, liveVersion:0, positionExclusions:Object.create(null), analytics:Object.create(null), analyticsClient:null, analyticsViews:[], cardControls:[], analyticsTargets:[], winCache:Object.create(null), winCacheLoading:false, winCacheReadFailed:false, winCacheGeneratedAt:null, portfolioCache:Object.create(null), portfolioCacheLoading:false, portfolioCacheAttempted:false, portfolioCacheReadFailed:false, portfolioCacheGeneratedAt:null, performanceOrderPending:false, chartSeq:0};
const fail = () => { throw Error('数据格式未通过校验，未展示此批记录。'); };
// Decode bounded response bytes directly. Blob.text() can start an internal
// blob-URL read in WebKit that outlives rapid account-page navigation.
function decodeChunks(chunks){
  const bytes=new Uint8Array(chunks.reduce((sum,chunk)=>sum+chunk.byteLength,0));let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
let linkedAccount=null;
let periodReturns=null,periodReturnsFailed=false,okxReturns=null,okxReturnsFailed=false,bitgetReturns=null,bitgetReturnsFailed=false,okxTrades=null,okxTradesFailed=false;
const publicFocus={record:typeof BooksPublicFocus==='undefined'?null:BooksPublicFocus.identity(),snapshot:null,fromLive:false,readFailed:false,unknownReason:null,renderKey:null};
const mk4Address='0x77375a8c9d13bf79afb2a87f1b0ac1dfd5f5bf66';
const mk4Research={id:'research-'+mk4Address,accountId:mk4Address,name:'mk4',exchange:'Hyperliquid',currency:'USD',
  sourceKind:'research_account',sourceUrl:'https://app.hyperliquid.xyz/explorer/address/'+mk4Address,
  windows:{},positions:[],points:[],orders:[],featured:false,paid:false};
function isPublicFocus(r) {return !!r&&r===publicFocus.record;}
function focusStatus(now=Date.now()) {
  const s=publicFocus.snapshot;
  if(!s)return '尚无有效持仓快照 · 可打开实时交易读取官方数据';
  const maxAge=publicFocus.fromLive?120000:3600000;
  const stale=publicFocus.readFailed||now-Date.parse(s.fetchedAt)>maxAge||now-Date.parse(s.sourceTime)>maxAge;
  return (publicFocus.readFailed?(publicFocus.unknownReason||'快照读取失败')+' · ':stale?'快照已过期 · ':'')+
    '默认永续市场 · '+(stale?'上次快照':'最近快照')+(s.positions.length?'持仓 '+s.positions.length+' 项':'为空仓')+
    (stale?' · 当前仓位未知':'')+' · 来源 '+timeLabel(s.sourceTime)+' · 读取 '+timeLabel(s.fetchedAt);
}
function appendFocusSnapshot(target) {
  const s=publicFocus.snapshot;
  target.append(node('p',focusStatus(),'public-focus-status'));
  if(!s)return;
  const figures=node('div',undefined,'public-focus-figures');
  if(s.accountValue!==null)figures.append(node('p','永续账户权益（快照） '+value(s.accountValue)+' USDC'));
  for(const p of s.positions)figures.append(node('p',`${p.coin} · ${p.side==='short'?'空头':'多头'} ${value(p.quantity)} · 均价 ${value(p.entryPrice)} · ${value(p.leverage.value)}× ${p.leverage.type==='cross'?'全仓':'逐仓'}`));
  target.append(figures);
}
function openFocusLive() {
  if(!publicFocus.record)return;
  openDetail(publicFocus.record,$('period').value);activateDetailTab('live');
}
function renderPublicFocus() {
  const section=$('public-focus-section'),target=$('public-focus-card'),r=publicFocus.record;
  section.hidden=!r;if(!r)return;
  const key=JSON.stringify(publicFocus.snapshot)+publicFocus.readFailed+focusStatus();if(key===publicFocus.renderKey)return false;
  const card=node('article',undefined,'public-focus-card'),head=node('div',undefined,'public-focus-head'),identity=node('div'),actions=node('div',undefined,'actions');
  identity.append(node('h3',r.name),node('p','Hyperliquid · 公开账户','meta'));
  actions.append(button('实时交易',openFocusLive,'detail-button'),button('详情',()=>openDetail(r,$('period').value)),sourceLink(r));
  head.append(avatar(r),identity,actions);card.append(head,node('p',r.accountId,'public-focus-address'));
  appendFocusSnapshot(card);
  card.append(node('p','独立关注记录；空仓时仍保留，不代表认证带单员。实时交易面板打开后读取公开持仓、挂单和最近成交。','hint'));
  target.replaceChildren(card);publicFocus.renderKey=key;return true;
}
function syncPublicFocusLive(r,data,now=Date.now()) {
  if(!isPublicFocus(r)||data?.address!==r.accountId)return false;
  const part=data.positions;
  if(part?.status==='error'||(data.defaultStream!==undefined&&(data.defaultStream!=='live'||data.connection?.status!=='live'))){
    publicFocus.readFailed=true;publicFocus.unknownReason=part?.status==='error'?'快照读取失败':'默认市场实时连接未确认';renderPublicFocus();return false;
  }
  if(part?.status==='ready'&&part.sourceTime===null&&publicFocus.snapshot){
    publicFocus.readFailed=true;publicFocus.unknownReason='实时推送未提供来源时间';renderPublicFocus();return false;
  }
  if(part?.status!=='ready'||part.error||!Number.isSafeInteger(part.sourceTime)||!Number.isSafeInteger(part.fetchedAt)||now-part.sourceTime>120000||now-part.fetchedAt>120000)return false;
  try{
    // The live client reads the default perpetual DEX. Its normalized holdings
    // carry source/read times but no account equity, so equity stays unknown.
    const snapshot=BooksPublicFocus.validate({schemaVersion:1,address:r.accountId,scope:'default_perp_dex',sourceTime:new Date(part.sourceTime).toISOString(),fetchedAt:new Date(part.fetchedAt).toISOString(),accountValue:null,positions:part.rows},now),previous=publicFocus.snapshot;
    if(previous&&(part.fetchedAt<Date.parse(previous.fetchedAt)||part.sourceTime<Date.parse(previous.sourceTime)))return false;
    if(previous&&part.fetchedAt===Date.parse(previous.fetchedAt)&&part.sourceTime===Date.parse(previous.sourceTime))return false;
    publicFocus.snapshot=snapshot;publicFocus.fromLive=true;publicFocus.readFailed=false;publicFocus.unknownReason=null;renderPublicFocus();return true;
  }catch(_){return false;}
}
function refreshPublicFocus() {return sharedRequest('focusRequest',async()=>{
  if(!publicFocus.record)return;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch('public-focus.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok||Number(response.headers.get('content-length'))>BooksPublicFocus.maxBytes)throw Error('focus_unavailable');
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>BooksPublicFocus.maxBytes){await reader.cancel();throw Error('focus_oversized');}chunks.push(value);}
    const snapshot=BooksPublicFocus.validate(JSON.parse(decodeChunks(chunks))),previous=publicFocus.snapshot;
    if(publicFocus.fromLive&&previous&&(Date.parse(snapshot.fetchedAt)<=Date.parse(previous.fetchedAt)||Date.parse(snapshot.sourceTime)<=Date.parse(previous.sourceTime)))return;
    if(previous&&(Date.parse(snapshot.fetchedAt)<Date.parse(previous.fetchedAt)||Date.parse(snapshot.sourceTime)<Date.parse(previous.sourceTime)))throw Error('focus_older');
    publicFocus.snapshot=snapshot;publicFocus.fromLive=false;publicFocus.readFailed=false;publicFocus.unknownReason=null;
  }catch(_){if(!publicFocus.fromLive){publicFocus.readFailed=true;publicFocus.unknownReason='快照读取失败';}}
  finally{clearTimeout(timer);const changed=renderPublicFocus();if(changed&&isPublicFocus(state.detail)&&$('detail').open&&state.tab!=='live')renderDetail();}
});}
// Only validated same-origin public snapshots enter these keys. Original source
// timestamps, failures and position exclusions survive a reload; cache age never
// renews the 60-minute holdings qualification.
function savePublicSnapshot(kind,payload=publicSnapshots[kind],readFailed=false) {
  if(!payload)return;
  publicSnapshots[kind]=payload;
  try {
    const envelope={cacheVersion:1,payload,readFailed};
    if(kind==='feed') {
      const addresses=new Set(payload.traders.map(r=>r.accountId));
      envelope.positionExclusions=Object.fromEntries(Object.entries(state.positionExclusions).filter(([address])=>addresses.has(address)));
    }
    if(kind==='binance')envelope.checkedAt=state.binanceCheckedAt;
    const serialized=JSON.stringify(envelope);
    if(new Blob([serialized]).size>maxBytes)return;
    localStorage.setItem(publicCacheKeys[kind],serialized);
  }catch(_){} // Private mode/quota must not prevent network revalidation.
}
function readPublicSnapshot(kind) {
  try {
    const serialized=localStorage.getItem(publicCacheKeys[kind]);if(!serialized||new Blob([serialized]).size>maxBytes)return null;
    const cached=JSON.parse(serialized);
    if(!cached||cached.cacheVersion!==1||typeof cached.readFailed!=='boolean')return null;
    return cached;
  }catch(_){return null;}
}
function hydratePublicSnapshots() {
  let hydrated=false;
  const feed=readPublicSnapshot('feed'),win=readPublicSnapshot('win');
  if(feed)try {
    const p=feed.payload,rows=validate(p),source=validateSource(p,rows);
    if(!source||rows.some(r=>r.sourceKind!=='public_account'))fail();
    const exclusions=feed.positionExclusions||{},clean=Object.create(null);
    if(typeof exclusions!=='object'||Array.isArray(exclusions)||Object.keys(exclusions).length>200)fail();
    for(const [address,at]of Object.entries(exclusions)){if(!/^0x[0-9a-f]{40}$/.test(address)||!Number.isFinite(at)||at<0||at>Date.now()+5000)fail();clean[address]=at;}
    const snapshot={schemaVersion:1,status:p.status,source:p.source,traders:rows};
    state.publicRows=rows;state.source=source;state.status=p.status;state.feedText=JSON.stringify(snapshot);state.lastReadFailed=feed.readFailed;state.positionExclusions=clean;
    publicSnapshots.feed=snapshot;hydrated=true;
  }catch(_){}
  if(win)try {
    const p=validateWinCache(win.payload);
    state.winCache=p.accounts;state.winCacheGeneratedAt=p.generatedAt;state.winCacheReadFailed=win.readFailed;publicSnapshots.win=win.payload;
  }catch(_){}
  if(typeof BinanceData!=='undefined'){const cached=readPublicSnapshot('binance');if(cached)try{const collection=BinanceData.parseCollection(cached.payload);installBinance(collection,cached.readFailed,cached.checkedAt||null);publicSnapshots.binance=collection;hydrated=true;}catch(_){}}
  ensureBinanceIdentities();mergeRows();return hydrated;
}
function sharedRequest(key,operation) {
  if(state[key])return state[key];
  const request=operation();state[key]=request.finally(()=>{state[key]=null;});return state[key];
}
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
    const clean = {id,name,exchange:r.exchange,currency:r.currency,featured:r.featured,paid:r.paid,observedAt,sourceUrl:url.href,windows,accountId:optionalText(r.accountId,100),avatarUrl:safeAvatarUrl(r.avatarUrl,r.exchange),note:optionalText(r.note,500)};
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
  if(!p||typeof p!=='object'||Array.isArray(p)||p.schemaVersion!==1||p.methodVersion!=='portfolio-periods-v2'||!p.accounts||typeof p.accounts!=='object'||Array.isArray(p.accounts)||Object.keys(p.accounts).length>200)fail();
  const generatedAt=date(p.generatedAt),generated=Date.parse(generatedAt),accounts=Object.create(null),now=Date.now();if(generated>now+5000)fail();
  const metric=v=>v===null?null:typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<1e20?v:fail();
  const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=20000?v:fail();
  const stamp=v=>v===null?null:date(v);
  for(const [address,entry] of Object.entries(p.accounts)) {
    if(!/^0x[0-9a-f]{40}$/.test(address)||!entry||typeof entry!=='object'||Array.isArray(entry)||!['ready','stale','unavailable'].includes(entry.status))fail();
    const fetchedAt=stamp(entry.fetchedAt),lastAttemptAt=stamp(entry.lastAttemptAt),errorCode=entry.errorCode==null?null:text(entry.errorCode,80);
    for(const value of [fetchedAt,lastAttemptAt])if(value&&(Date.parse(value)>generated+5000||Date.parse(value)>now+5000))fail();
    if(entry.portfolio===null){if(fetchedAt!==null||entry.status!=='unavailable')fail();accounts[address]={status:'unavailable',fetchedAt:null,lastAttemptAt,errorCode,portfolio:null};continue;}
    if(!fetchedAt||entry.status==='unavailable'||!entry.portfolio||typeof entry.portfolio!=='object'||Array.isArray(entry.portfolio)||!entry.portfolio.windows||typeof entry.portfolio.windows!=='object'||Array.isArray(entry.portfolio.windows)||!Object.keys(entry.portfolio.windows).length||Object.keys(entry.portfolio.windows).length>6)fail();
    const windows={};
    for(const [period,w]of Object.entries(entry.portfolio.windows)) {
      if(!periods.includes(period)||!w||typeof w!=='object'||Array.isArray(w))fail();
      const derived=derivedPeriods.includes(period),expectedSource=derived||period==='ALL'?'perpAllTime':period==='7D'?'perpWeek':'perpMonth';
      if(w.derived!==derived||w.sourcePeriod!==expectedSource||w.scope!=='perp_account'||w.curveUnit!=='USD'||w.curveBasis!=='pnl_change_from_first_sample'||w.mddUnit!=='percent'||w.mddMethod!==(derived?'window_pnl_peak_equity':'hyperliquid_ui_pnl_peak_equity'))fail();
      if(w.requestedDays!==(derived?parseInt(period,10):null)||!['source_window','full','sampled_boundary','insufficient_history'].includes(w.coverageStatus)||(!derived&&w.coverageStatus!=='source_window')||(derived&&w.coverageStatus==='source_window'))fail();
      const clean={derived,sourcePeriod:w.sourcePeriod,scope:w.scope,curveUnit:w.curveUnit,curveBasis:w.curveBasis,mddUnit:w.mddUnit,mddMethod:w.mddMethod,requestedDays:w.requestedDays,coverageStatus:w.coverageStatus,points:[]};
      for(const key of ['startAt','endAt','requestedStartAt','requestedEndAt','sourceHistoryStartAt','sourceHistoryEndAt']){clean[key]=stamp(w[key]);if(clean[key]&&(Date.parse(clean[key])>Date.parse(fetchedAt)+5000||Date.parse(clean[key])>now+5000))fail();}
      for(const key of ['sampleCount','sourceSampleCount','mddPairedSampleCount'])clean[key]=count(w[key]);
      for(const key of ['pnl','mdd','coverageDays','maxSampleGapMs'])clean[key]=metric(w[key]);
      clean.mddUnavailableReason=w.mddUnavailableReason===null?null:text(w.mddUnavailableReason,100);
      if(clean.coverageDays===null||clean.coverageDays<0||clean.maxSampleGapMs!==null&&clean.maxSampleGapMs<0||clean.mdd!==null&&clean.mdd<0||clean.mdd===null&&!clean.mddUnavailableReason||clean.mdd!==null&&clean.mddUnavailableReason!==null||clean.sourceSampleCount<clean.sampleCount||clean.mddPairedSampleCount>clean.sampleCount)fail();
      if(clean.mdd===null?(!['insufficient_samples','unpaired_samples','non_positive_peak_equity','no_valid_peak','invalid_denominator'].includes(clean.mddUnavailableReason)||clean.mddPairedSampleCount!==0):(clean.sampleCount<2||clean.mddPairedSampleCount!==clean.sampleCount))fail();
      if(!derived&&(clean.sourceSampleCount!==clean.sampleCount||clean.sourceHistoryStartAt!==clean.startAt||clean.sourceHistoryEndAt!==clean.endAt))fail();
      if(derived){const adapter=typeof document==='undefined'?require('./period-roi.js'):globalThis.BooksPeriodROI;if(!adapter)fail();Object.assign(clean,adapter.validateWindow(w,address,now));if(clean.roiEvidence&&Date.parse(clean.roiEvidence.ledgerFetchedAt)>Date.parse(fetchedAt)+5000)fail();}
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
function hasPortfolioWindowContract(w,period,address,fetchedAt) {
  const derived=derivedPeriods.includes(period),sourcePeriod=derived||period==='ALL'?'perpAllTime':period==='7D'?'perpWeek':'perpMonth';
  if(!(periods.includes(period)&&w?.scope==='perp_account'&&w.sourcePeriod===sourcePeriod&&w.derived===derived&&w.mddMethod===(derived?'window_pnl_peak_equity':'hyperliquid_ui_pnl_peak_equity')&&w.mddUnit==='percent'))return false;
  if(derived)try{if(typeof BooksPeriodROI==='undefined')return false;const {roiEvidence}=BooksPeriodROI.validateWindow(w,address);if(roiEvidence&&(!Number.isFinite(Date.parse(fetchedAt))||Date.parse(roiEvidence.ledgerFetchedAt)>Date.parse(fetchedAt)+5000))return false;}catch(_){return false;}
  return true;
}
function portfolioSection(r,period) {
  if(!isPublicAccount(r))return null;
  const live=state.analytics[r.accountId]?.portfolio,entry=state.portfolioCache[r.accountId];
  const validLive=live?.status==='ready'&&live.windows&&Object.keys(live.windows).length>0&&Object.entries(live.windows).every(([key,w])=>hasPortfolioWindowContract(w,key,r.accountId,live.fetchedAt));
  // Keep the entire verified window together. A foreground curve has no ledger
  // proof and must not replace saved ROI, or attach it to newer PnL and dates.
  const preserveROI=derivedPeriods.includes(period)&&Number.isFinite(entry?.portfolio?.windows?.[period]?.roi)&&!Number.isFinite(validLive?live.windows[period]?.roi:null);
  if(validLive&&!preserveROI&&(!entry?.portfolio||Date.parse(live.fetchedAt||'')>=Date.parse(entry.fetchedAt)))return live;
  if(entry?.portfolio)return {...entry.portfolio,status:'ready',fetchedAt:entry.fetchedAt,lastAttemptAt:entry.lastAttemptAt,stale:state.portfolioCacheReadFailed||entry.status!=='ready'||Date.now()-Date.parse(entry.fetchedAt)>3600000};
  return live?.status==='ready'&&!validLive?{status:'error',error:'portfolio_scope'}:live||null;
}
function performanceWindow(r,period) {
  if(!isPublicAccount(r)||!derivedPeriods.includes(period))return r.windows[period];
  const part=portfolioSection(r,period),w=part?.status==='ready'?part.windows[period]:null;
  return w?{...BooksPeriodROI.forDisplay(w),asOf:w.endAt,wins:null,closedTrades:null,curve:[]}:null;
}
function periodName(period,w) {return derivedPeriods.includes(period)&&(w?.derived||!w)?({'90D':'季度','180D':'半年','365D':'年度'})[period]:displayPeriod(period,w);}
function historyDate(value) {return new Date(value).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});}
function periodROIDescription(w) {
  if(w?.roiEvidence)w=BooksPeriodROI.forDisplay(w);
  const e=w?.roiEvidence;
  if(Number.isFinite(w?.roi)&&e)return `自算收益率 = 区间盈亏 ÷ max(100 USD，期初权益 + 区间最大累计净入金) × 100%；公开资金流水与权益逐段对账，资金基准 ${money(e.capitalBase,'USD')} USD。实际区间 ${timeLabel(e.startAt)} 至 ${timeLabel(e.endAt)}；流水采集 ${timeLabel(e.ledgerFetchedAt)}。非 TWR、非官方直接值；仅核验返回的公开流水与采样，不承诺完整账户历史。`;
  const reasons={history_unverified:'完整资金流水和周期边界尚未证实',cash_flow_adjusted_return_unavailable:'尚无可核验的资金流水和资金基准',insufficient_history:'实际历史不足所选周期',insufficient_samples:'有效权益采样不足',unpaired_samples:'权益与盈亏采样未对齐',ledger_unavailable:'公开资金流水暂不可用',ledger_incomplete:'公开资金流水尚未完整读取',unknown_ledger_event:'存在尚未支持的资金流水类型',invalid_ledger_event:'资金流水字段未通过校验',ambiguous_ledger_order:'同一时间的流水顺序无法确定',ledger_reconciliation_failed:'资金流水与权益变化未能对账',invalid_capital_basis:'资金基准无法可靠计算',invalid_portfolio:'来源历史未通过校验'};
  return `自算收益率暂不可用：${reasons[w?.roiUnavailableReason]||'计算证据不足或未通过校验'}；区间盈亏另列。`;
}
function performanceRange(r,period) {
  const part=portfolioSection(r,period),w=part?.status==='ready'?part.windows[period]:null;
  if(w?.sampleCount>1){const range=`${historyDate(w.startAt)} — ${historyDate(w.endAt)}`,coverage=derivedPeriods.includes(period)?` · 覆盖 ${w.coverageDays.toLocaleString('zh-CN',{maximumFractionDigits:1})} 天${w.coverageStatus==='insufficient_history'?' · 历史不足':w.coverageStatus==='sampled_boundary'?' · 采样边界':''}`:'';return `${period==='ALL'?'来源覆盖':'实际区间'} ${range}${coverage}${part.stale?' · 旧采样':''}`;}
  if(part?.status==='queued'||part?.status==='loading'||state.portfolioCacheLoading&&!state.portfolioCacheAttempted)return '正在读取区间历史';
  return part?.status==='error'?'区间历史暂不可用':'暂无该区间的有效历史样本';
}
function fillPerformanceSummary(r,period,view) {
  const w=performanceWindow(r,period),derived=isPublicAccount(r)&&derivedPeriods.includes(period),part=portfolioSection(r,period),history=part?.status==='ready'?part.windows[period]:null;
  const amount=w?.roi,formattedSigned=signedValue(amount,pct(amount));
  view.roi.hidden=!Number.isFinite(amount);view.roiLabel.hidden=false;
  view.roi.textContent=formattedSigned;view.roi.className='roi '+directionClass(amount)+(formattedSigned.length>8?' long-roi':'');
  view.roi.setAttribute('title',derived?periodROIDescription(w):`${periodName(period,w)} 来源收益率 ${formattedSigned}`);
  view.roiLabel.textContent=`${periodName(period,w)} ${derived?'自算收益率':'收益率'}${!Number.isFinite(amount)?' · 暂缺':''}`;
  if(view.rangeNote){view.rangeNote.textContent=performanceRange(r,period);view.rangeNote.hidden=!(history?.sampleCount>1&&(derived||period==='ALL'));view.rangeNote.setAttribute('title',history?`${performanceRange(r,period)}；采集时间 ${part?.fetchedAt?timeLabel(part.fetchedAt):'—'}；来源真实 ${history.sampleCount} 个采样点`:'暂无可核验的区间历史采样');}
  if(view.detailButton){const description=winCacheDescription(r);view.detailButton.setAttribute('title',description);view.detailButton.setAttribute('aria-label',`查看 ${r.name} 的研究详情${Number.isFinite(cachedWin(r)?.win?.value)?'':'。'+description}`);}
  if(view.cardRoot)view.cardRoot.className='card'+(derived&&!(history?.sampleCount>1)?' compact-history':'');
}
function sortValue(r,period,sort) {
  if(isBinanceTrader(r)||isPublicLead(r)){
    const stats=isPublicLead(r)?leadPeriod(r,period):binancePerformance(r,period);
    if(!stats)return null;
    if(['roi','pnl'].includes(sort)&&isPublicLead(r)&&stats.fullPeriod!==true)return null;
    if(sort==='roi'&&isBinanceTrader(r)&&['90D','365D'].includes(period)&&stats.fullPeriod!==true)return null;
    return stats[sort]??null;
  }
  const w=performanceWindow(r,period),part=portfolioSection(r,period);
  if(isPublicAccount(r)&&sort==='mdd')return sampledDrawdown(part?.status==='ready'?part.windows[period]:null,period);
  if(isPublicAccount(r)&&sort==='winRate')return cachedWin(r)?.win?.value??null;
  return sort==='winRate'?win(w):w?.[sort];
}
function renderPreservingCardFocus() {
  const keys=['detailButton','paperLink','followLink','sourceLink'];
  const focused=state.cardControls.find(v=>keys.some(k=>v[k]&&v[k]===document.activeElement));
  const key=focused&&keys.find(k=>focused[k]===document.activeElement);
  render();if(focused){const replacement=state.cardControls.find(v=>v.r.id===focused.r.id);(replacement?.[key]||$('sort')).focus();}
}
function isPortfolioSort() {return $('sort').value==='mdd'||['pnl','roi'].includes($('sort').value)&&derivedPeriods.includes($('period').value);}
function schedulePerformanceOrder() {
  if(state.performanceOrderPending||state.loading||!isPortfolioSort()||$('source').value==='local')return;
  state.performanceOrderPending=true;setTimeout(()=>{state.performanceOrderPending=false;if(!state.loading&&isPortfolioSort()&&$('source').value!=='local')renderPreservingCardFocus();},0);
}
function refreshPortfolioCache() {return sharedRequest('portfolioCacheRequest',readPortfolioCache);}
async function readPortfolioCache() {
  state.portfolioCacheLoading=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000),limit=12*1024*1024;let orderChanged=false;
  try {
    const response=await fetch('portfolios.json',{cache:'no-cache',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok||!/application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>limit)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit){await reader.cancel();fail();}chunks.push(value);}
    const raw=JSON.parse(decodeChunks(chunks));globalThis.BooksSourcePolicy?.inspect('portfolios',raw);const payload=validatePortfolioCache(raw);if(state.portfolioCacheGeneratedAt&&Date.parse(payload.generatedAt)<Date.parse(state.portfolioCacheGeneratedAt))fail();
    const before=state.rows.map(r=>sortValue(r,$('period').value,$('sort').value));
    for(const [address,incoming]of Object.entries(payload.accounts)){const previous=state.portfolioCache[address];if(previous?.portfolio&&(!incoming.portfolio||Date.parse(incoming.fetchedAt)<Date.parse(previous.fetchedAt)))payload.accounts[address]={...previous,status:'stale',lastAttemptAt:incoming.lastAttemptAt||previous.lastAttemptAt,errorCode:incoming.errorCode||'older_result'};}
    state.portfolioCache=payload.accounts;state.portfolioCacheGeneratedAt=payload.generatedAt;state.portfolioCacheReadFailed=false;
    orderChanged=state.rows.some((r,i)=>before[i]!==sortValue(r,$('period').value,$('sort').value));
  } catch {globalThis.BooksSourcePolicy?.inspect('portfolios',null);state.portfolioCacheReadFailed=true;}
  finally {clearTimeout(timeout);state.portfolioCacheLoading=false;state.portfolioCacheAttempted=true;for(const address of new Set(state.analyticsViews.map(v=>v.r.accountId)))refreshAnalyticsViews(address);if(state.detail&&$('detail').open&&state.tab==='analysis'&&globalThis.BooksTradeAnalysis)renderDetail();if(orderChanged)schedulePerformanceOrder();startVisibleAnalytics(state.analyticsViews.filter(v=>v.kind==='card').slice(0,12).map(v=>v.r),true);}
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
function winCacheDescription(r) {
  const entry=cachedWin(r),w=entry?.win;
  if(!w)return (entry?'平仓片段胜率暂缺：'+hyperliquidSnapshotReason(entry,'本批未取得可用成交样本'):'平仓片段胜率暂缺：本次公开成交快照尚未覆盖此账户。')+(entry?.lastAttemptAt?' · 最近尝试 '+timeLabel(entry.lastAttemptAt):'');
  const sample=`来源返回 ${w.receivedFills} 条成交，有效 ${w.eligibleCount}、排除 ${w.excludedCount}${w.duplicateCount?'、重复 '+w.duplicateCount:''}`;
  const coverage=w.sourceSampleStartAt?`来源成交样本 ${timeLabel(w.sourceSampleStartAt)} 至 ${timeLabel(w.sourceSampleEndAt)}；`:'';
  const result=w.eligibleCount?`${w.eligibleCount} 笔近期永续平仓片段，独立于所选表现周期；不含现货、开仓及其他不符合口径的成交，非完整订单或开平仓回合；样本 ${timeLabel(w.startAt)} 至 ${timeLabel(w.endAt)}；盈利 ${w.winning} · 亏损 ${w.losing} · 持平 ${w.breakeven}；仅扣平仓成交手续费，未扣开仓手续费和资金费；`:'平仓片段胜率暂缺：返回的近期成交中，没有符合当前口径的永续平仓片段；不能据此判断账户从未平仓；';
  return result+sample+'；'+coverage+(w.capped?'达到 2000 条上限，可能截断更早历史；':'仅近期样本，非完整历史；')+`采集 ${timeLabel(entry.fetchedAt)}${winCacheIsStale(entry)?'；上次成功结果，待更新':''}`;
}
function refreshWinCache() {return sharedRequest('winCacheRequest',readWinCache);}
async function readWinCache() {
  state.winCacheLoading=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);let orderChanged=false;
  try {
    const response=await fetch('analytics.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok||!/application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>maxBytes)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();fail();}chunks.push(value);}
    const raw=JSON.parse(decodeChunks(chunks));globalThis.BooksSourcePolicy?.inspect('analytics',raw);const payload=validateWinCache(raw);
    if(state.winCacheGeneratedAt&&Date.parse(payload.generatedAt)<Date.parse(state.winCacheGeneratedAt))fail();
    for(const [address,incoming]of Object.entries(payload.accounts)) {
      const previous=state.winCache[address];
      const olderAttempt=previous?.lastAttemptAt&&(!incoming.lastAttemptAt||Date.parse(incoming.lastAttemptAt)<Date.parse(previous.lastAttemptAt));
      if(previous?.win&&(!incoming.win||Date.parse(incoming.fetchedAt)<Date.parse(previous.fetchedAt)||olderAttempt))payload.accounts[address]={...previous,status:'stale',lastAttemptAt:olderAttempt?previous.lastAttemptAt:incoming.lastAttemptAt||previous.lastAttemptAt,errorCode:incoming.errorCode||'older_result'};
    }
    orderChanged=state.rows.some(r=>isPublicAccount(r)&&qualifiedPosition(r)&&(state.winCache[r.accountId]?.win?.value??null)!==(payload.accounts[r.accountId]?.win?.value??null));
    state.winCache=payload.accounts;state.winCacheGeneratedAt=payload.generatedAt;state.winCacheReadFailed=false;
    savePublicSnapshot('win',{...raw,accounts:payload.accounts},false);
  } catch {globalThis.BooksSourcePolicy?.inspect('analytics',null);state.winCacheReadFailed=true;savePublicSnapshot('win',undefined,true);}
  finally {
    clearTimeout(timeout);state.winCacheLoading=false;
    // When the feed wins the network race, apply the selected order as soon as
    // aggregate values arrive. Metadata-only refreshes preserve card nodes/focus.
    if(orderChanged&&!state.loading&&$('sort').value==='winRate'&&$('source').value!=='local') {
      renderPreservingCardFocus();
    }
    for(const address of new Set(state.analyticsViews.map(v=>v.r.accountId)))refreshAnalyticsViews(address);if(state.detail&&$('detail').open&&state.tab==='analysis'&&globalThis.BooksTradeAnalysis)renderDetail();
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
function retainedPublicRows() {return state.publicRows.filter(r=>!isPublicAccount(r)||state.source?.positionVerification&&r.positionCheck);}
function isPublicLead(r){
  return !!r && !r._local && ((r.sourceKind==='okx_public_lead'&&r.exchange==='OKX') ||
    (r.sourceKind==='bitget_public_lead'&&r.exchange==='Bitget'));
}
function leadRecord(r){return r.exchange==='OKX'?r.okxRecord:r.bitgetRecord;}
function leadPeriod(r,period){
  const okx=r.exchange==='OKX',adapter=okx?globalThis.BooksOKXPeriodData:globalThis.BooksBitgetPeriodData;
  const stats=adapter?.performance(leadRecord(r),period,Date.now());
  return stats&&(okx?okxReturnsFailed:bitgetReturnsFailed)?{...stats,status:'stale'}:stats;
}
function isBinanceTrader(r) {return r?.sourceKind==='copy_trade'&&!r._local;}
function binanceView(r) {if(r.referenceOnly||r.periodOnly||r.periodRecord?.positionShow===false)return BinanceData.detail(null);return BinanceData.detail(r.binance,{requestFailed:state.binanceReadFailed,checkedAt:state.binanceCheckedAt,batchStopped:r.binanceBatchSource?.refreshStopped===true,batchErrorCode:r.binanceBatchSource?.errorCode||null});}
function binancePerformance(r,period) {
  const stats=BinanceData.recordedPeriod?.(r.periodRecord,period,Date.now(),periodReturnsFailed);if(stats)return stats;
  if(r.referenceOnly&&globalThis.BooksReferenceData)return BooksReferenceData.performance(globalThis.BooksAoyingHistory,r.accountId,period);return BinanceData.performance(r.referenceOnly?null:r.binance,period,{requestFailed:state.binanceReadFailed,batchStopped:r.binanceBatchSource?.refreshStopped===true,batchErrorCode:r.binanceBatchSource?.errorCode||null});}
function hasBinancePerformance(r) {return ['30D','90D','365D'].some(period=>['roi','pnl','mdd','winRate'].some(key=>Number.isFinite(binancePerformance(r,period)[key])));}
function rejectOlderBinancePerformance(incoming,previous) {
  if(hiddenBinanceFeed(incoming))return;
  if(BinanceData.performance(incoming,'30D',{batchStopped:true}).errorCode==='performance_schema')fail();
  for(const [period,old]of Object.entries(previous?.performance?.byPeriod||{})){
    const next=incoming.performance?.byPeriod?.[period];
    if(!next){if(old.lastSuccessAt)fail();continue;}
    for(const key of ['lastAttemptAt','lastSuccessAt','sourceAsOf'])if(old[key]&&(!next[key]||Date.parse(next[key])<Date.parse(old[key])))fail();
    if(old.lastSuccessAt&&next.status!=='ready'&&['roi','pnl','mdd','winRate'].some(key=>old[key]!=null&&next[key]!==old[key]))fail();
  }
}
function binanceChart(r,period) {if(r.referenceOnly&&globalThis.BooksReferenceData)return BooksReferenceData.chart(globalThis.BooksAoyingHistory,r.accountId,period);return BinanceData.chart(r.referenceOnly?null:r.binance,period,{requestFailed:state.binanceReadFailed,batchStopped:r.binanceBatchSource?.refreshStopped===true,batchErrorCode:r.binanceBatchSource?.errorCode||null});}
function rejectOlderBinanceChart(incoming,previous) {
  if(hiddenBinanceFeed(incoming))return;
  if(BinanceData.chart(incoming,'30D',{batchStopped:true}).errorCode==='chart_schema')fail();
  for(const [period,old]of Object.entries(previous?.chart?.byPeriod||{})){
    const next=incoming.chart?.byPeriod?.[period];if(!next){if(old.lastSuccessAt)fail();continue;}
    for(const key of ['lastAttemptAt','lastSuccessAt','sourceAsOf'])if(old[key]&&(!next[key]||Date.parse(next[key])<Date.parse(old[key])))fail();
    if(old.lastSuccessAt&&(next.status!=='ready'||Date.parse(next.lastSuccessAt)===Date.parse(old.lastSuccessAt))&&JSON.stringify(next.points)!==JSON.stringify(old.points))fail();
  }
}
function currentHolding(r,now=Date.now()) {
  if(r._local)return false;
  if(isBinanceTrader(r))return binanceView(r).currentPositionCount>0;
  return isPublicAccount(r)&&!state.lastReadFailed&&state.source?.status==='ok'&&qualifiedPosition(r,now);
}
function retainedStatus(r) {
  const at=r.positionCheck?.checkedAt,excluded=state.positionExclusions[r.accountId]??-Infinity;
  if(excluded>=Date.parse(at||''))return Date.now()-excluded<=3600000?`最近读取确认空仓 · ${timeLabel(new Date(excluded).toISOString())} · 保留历史资料`:`上次空仓核验 ${timeLabel(new Date(excluded).toISOString())} · 当前仓位未知`;
  if(!at)return '持仓尚未核验 · 当前仓位未知';
  return `上次持仓核验 ${timeLabel(at)} · ${state.lastReadFailed?'快照读取失败，当前仓位未知':state.source?.status!=='ok'?'采集更新失败，当前仓位未知':qualifiedPosition(r)?'核验仍在有效期内':'核验已过期，当前仓位未知'}`;
}
function selectPlatform(exchange) {
  if(!['all','Hyperliquid','Binance','OKX','Bitget'].includes(exchange))return;
  $('exchange').value=exchange;$('source').value='all';$('currency').value='all';$('search').value='';state.page=1;render();renderSource();saveURL();
}
function mixPlatforms(rows) {
  const binance=rows.filter(isBinanceTrader).sort((a,b)=>Number(b.referenceOnly===true)-Number(a.referenceOnly===true)),others=rows.filter(r=>!isBinanceTrader(r)),mixed=[];
  while(binance.length)mixed.push(binance.shift(),...others.splice(0,2));
  return [...mixed,...others];
}
function ensureBinanceIdentities() {
  if(typeof BinanceData==='undefined'||state.binanceRows.length)return;
  // Local identity wrapper only: its creation time is never saved or shown as source data.
  state.binanceRows=BinanceData.toTraders({schemaVersion:1,generatedAt:new Date().toISOString(),source:{refreshStopped:false,errorCode:null},portfolios:[]},{requestFailed:true});
}
function installBinance(collection,requestFailed=false,checkedAt=null) {
  state.binanceCollection=collection;state.binanceReadFailed=requestFailed;state.binanceCheckedAt=checkedAt;
  state.binanceRows=BinanceData.toTraders(collection,{requestFailed,checkedAt});state.binanceText=JSON.stringify(collection);
}
function hiddenBinanceFeed(feed) {return feed.profile.visibility!=='public'||feed.source.status==='restricted'||feed.source.errorCode==='restricted';}
function binanceSafetyWatermark(feed) {
  return Math.max(0,...[feed?.source.lastAttemptAt,feed?.source.lastSuccessAt,feed?.snapshot?.observedAt,feed?.clientSafety?.resumeAfterAt].map(value=>Date.parse(value)||0));
}
function hideBinancePayload(feed) {
  if(!hiddenBinanceFeed(feed))return feed;
  const restricted=feed.profile.visibility==='restricted'||feed.source.status==='restricted'||feed.source.errorCode==='restricted';
  const empty={status:'unavailable',fetchedAt:null,errorCode:feed.source.errorCode,complete:false,rows:[],coverage:null};
  return {schemaVersion:feed.schemaVersion,sourceType:feed.sourceType,portfolioId:feed.portfolioId,profile:{...feed.profile},generatedAt:feed.generatedAt,source:{...feed.source,status:restricted?'restricted':'unavailable'},snapshot:null,observations:[],history:{orders:{...empty},closedPositions:{...empty}},performance:{schemaVersion:1,byPeriod:{}},chart:{schemaVersion:1,byPeriod:{}}};
}
function withBinanceSafety(feed,previous) {
  const resumeAfter=Math.max(binanceSafetyWatermark(feed),binanceSafetyWatermark(previous));
  return {...feed,clientSafety:{resumeAfterAt:resumeAfter?new Date(resumeAfter).toISOString():null}};
}
function preserveBinanceSafety(incoming) {
  const previous=state.binanceCollection;if(!previous)return;
  let changed=false;const byId=new Map(previous.portfolios.map(feed=>[feed.portfolioId,feed]));
  for(const feed of incoming.portfolios){
    const old=byId.get(feed.portfolioId);
    if(hiddenBinanceFeed(feed)){byId.set(feed.portfolioId,withBinanceSafety(withBinanceSafety(hideBinancePayload(feed),feed),old));changed=true;}
    else if(feed.source.refreshStopped){byId.set(feed.portfolioId,withBinanceSafety(old?{...old,source:{...old.source,status:hiddenBinanceFeed(old)?old.source.status:'stale',refreshStopped:true,errorCode:feed.source.errorCode}}:feed,feed));changed=true;}
  }
  if(incoming.source.refreshStopped){changed=true;for(const [id,feed]of byId)byId.set(id,withBinanceSafety(feed,incoming.portfolios.find(p=>p.portfolioId===id)));}
  if(!changed)return;
  const safe={...previous,source:incoming.source.refreshStopped?{...incoming.source}:previous.source,portfolios:[...byId.values()]};
  installBinance(BinanceData.parseCollection(safe),state.binanceReadFailed,state.binanceCheckedAt);savePublicSnapshot('binance',safe,state.binanceReadFailed);
}
function refreshBinance() {
  if(typeof BinanceData==='undefined')return Promise.resolve();
  return sharedRequest('binanceRequest',async()=>{
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);let changed=false;
    try {
      const response=await fetch('binance/portfolios.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});
      if(!response.ok||Number(response.headers.get('content-length'))>maxBytes)fail();
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();fail();}chunks.push(value);}
      const parsed=BinanceData.parseCollection(JSON.parse(decodeChunks(chunks)));
      const collection={...parsed,portfolios:parsed.portfolios.map(feed=>{const next=hideBinancePayload(feed);return hiddenBinanceFeed(feed)||feed.source.refreshStopped||parsed.source.refreshStopped?withBinanceSafety(withBinanceSafety(next,feed),state.binanceCollection?.portfolios.find(p=>p.portfolioId===feed.portfolioId)):next;})};
      preserveBinanceSafety(collection);
      if(state.binanceCollection){const previous=state.binanceCollection,newer=Date.parse(collection.generatedAt)>Date.parse(previous.generatedAt);if(previous.source.refreshStopped&&!collection.source.refreshStopped&&(!newer||previous.portfolios.some(old=>{const next=collection.portfolios.find(p=>p.portfolioId===old.portfolioId);return !next||!(Date.parse(next.source.lastAttemptAt)>binanceSafetyWatermark(old));})))fail();for(const incoming of collection.portfolios){const old=previous.portfolios.find(p=>p.portfolioId===incoming.portfolioId);if(old&&((hiddenBinanceFeed(old)&&!hiddenBinanceFeed(incoming))||(old.source.refreshStopped&&!incoming.source.refreshStopped))&&(!newer||!(Date.parse(incoming.source.lastAttemptAt)>binanceSafetyWatermark(old))))fail();}}
      if(Date.parse(collection.generatedAt)>Date.now()+5000)fail();
      if(state.binanceCollection&&Date.parse(collection.generatedAt)<Date.parse(state.binanceCollection.generatedAt))fail();
      for(const incoming of collection.portfolios){const old=state.binanceCollection?.portfolios.find(p=>p.portfolioId===incoming.portfolioId);if(!collection.source.refreshStopped&&incoming.profile.visibility==='public'&&!incoming.source.refreshStopped&&incoming.source.status==='ready'&&old?.source.lastAttemptAt&&incoming.source.lastAttemptAt&&Date.parse(incoming.source.lastAttemptAt)<Date.parse(old.source.lastAttemptAt))fail();}
      for(const incoming of collection.portfolios){const previous=state.binanceCollection?.portfolios.find(p=>p.portfolioId===incoming.portfolioId);rejectOlderBinancePerformance(incoming,previous);rejectOlderBinanceChart(incoming,previous);}
      changed=state.binanceText!==JSON.stringify(collection)||state.binanceReadFailed;
      installBinance(collection,false,new Date().toISOString());savePublicSnapshot('binance',collection,false);
    }catch(_){state.binanceReadFailed=true;state.binanceCheckedAt=new Date().toISOString();ensureBinanceIdentities();savePublicSnapshot('binance',undefined,true);changed=true;}
    finally{
      clearTimeout(timeout);mergeRows();renderPreservingCardFocus();renderSource();
      if(isBinanceTrader(state.detail)){const latest=state.rows.find(r=>r.id===state.detail.id);if(latest)state.detail=latest;if($('detail').open)renderDetail();}
    }
  });
}
function binanceStatus(view,r) {
  if(r?.periodRecord?.positionShow===false)return '币安当前未公开仓位 · 已收录公开周期绩效';
  if(r?.periodOnly)return '仅收录周期绩效 · 当前仓位未知';
  if(r?.referenceOnly){
    const profile=globalThis.BooksReferenceData?.profile(globalThis.BooksAoyingHistory,r.accountId);
    const latest=profile?.lastTradeAt?`最近公开交易 ${timeLabel(profile.lastTradeAt)}`:'最近公开交易时间未取得';
    return `官方当前仓位未公开 · ${latest}`;
  }
  if(view.status==='restricted')return '资料不可见 · 当前仓位未知';
  if(state.binanceReadFailed)return '本站快照读取失败 · 当前仓位未知';
  if(view.refreshStopped)return '来源已停止刷新 · 当前仓位未知';
  if(view.status==='unavailable')return '尚无可用持仓快照 · 当前仓位未知';
  if(view.status==='stale')return (view.errorCode?'采集未成功':'快照已过期')+' · 当前仓位未知';
  return view.currentPositionCount===0?'最近核验空仓':'持仓核验有效';
}
function binanceTiming(view,r) {
  if(r?.periodOnly)return '仓位与订单未采集';
  if(r?.referenceOnly){
    const profile=globalThis.BooksReferenceData?.profile(globalThis.BooksAoyingHistory,r.accountId);
    return profile?.fetchedAt?`资料读取 ${timeLabel(profile.fetchedAt)} · ${profile.lastTradeAt?'最近公开交易 '+timeLabel(profile.lastTradeAt):'最近公开交易时间未取得'}`:'资料读取时间未取得';
  }
  return view.observedAt?'仓位采集 '+timeLabel(view.observedAt):'尚无成功仓位采集';
}
function binanceChartCaption(view) {
  if(!view.periodSupported)return '未接入该周期的币安曲线';
  if(view.status==='restricted')return '曲线资料不可见';
  if(view.pointCount===null)return '尚未取得该周期的币安盈亏采样';
  return '来源采样 '+view.pointCount+' 点'+(view.startAt?' · '+timeLabel(view.startAt)+' 至 '+timeLabel(view.endAt):'')+(view.lastSuccessAt?' · 曲线采集 '+timeLabel(view.lastSuccessAt):'')+(view.status==='stale'?' · 上次成功样本，待更新':'')+' · 来源未提供整体更新时间';
}
function binanceChartArea(r,period) {
  const view=binanceChart(r,period),graph=node('div',undefined,'performance-chart'+(view.points.length<2?' binance-curve-unavailable':''));
  graph.append(node('span',period+' 盈亏 · USDT'+(view.status==='stale'?' · 旧采样':''),'curve-label'));graph.setAttribute('title',binanceChartCaption(view));graph.setAttribute('data-state',view.status);
  if(view.points.length<2){graph.append(node('span',view.pointCount===0?'来源返回 0 个采样点':view.pointCount===1?'仅 1 个来源采样点，无法构成曲线':view.status==='restricted'?'曲线不可见':view.periodSupported?'尚无可用曲线':'未接入该周期曲线','curve-unavailable'));return graph;}
  const points=view.points,start=Date.parse(points[0].time),end=Date.parse(points.at(-1).time),values=points.map(p=>p.value),lo=Math.min(...values),hi=Math.max(...values),scale=Math.max(Math.abs(lo),Math.abs(hi),1),span=hi/scale-lo/scale;
  const coordinates=points.map(p=>[8+284*(Date.parse(p.time)-start)/(end-start),span===0?45:80-70*(p.value/scale-lo/scale)/span]);
  const wrapper=node('div',undefined,'chart'),svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),line=document.createElementNS('http://www.w3.org/2000/svg','polyline');
  svg.setAttribute('viewBox','0 0 300 90');svg.setAttribute('role','img');svg.setAttribute('aria-label',period+' 来源盈亏采样曲线 · USDT：'+points.length+' 个点，首点 '+points[0].value+' USDT，末点 '+points.at(-1).value+' USDT；'+points[0].time+' 至 '+points.at(-1).time+'；原值未归零，非逐笔成交或账户净值');
  line.setAttribute('points',coordinates.map(p=>p.join(',')).join(' '));svg.append(line);
  for(const [i,point]of points.entries()){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle'),title=document.createElementNS('http://www.w3.org/2000/svg','title');dot.setAttribute('cx',String(coordinates[i][0]));dot.setAttribute('cy',String(coordinates[i][1]));dot.setAttribute('r','1.5');dot.setAttribute('fill','currentColor');title.textContent=timeLabel(point.time)+' · '+point.value+' USDT';dot.append(title);svg.append(dot);}
  wrapper.append(svg);graph.append(wrapper);return graph;
}
function renderBinanceChartDetails(r,parent,period){
  const view=binanceChart(r,period),note=node('p',binanceChartCaption(view)+'。按来源时间连接原始盈亏采样，不减首点、不拼接旧片段；不是逐笔成交记录、收益率曲线或账户净值。','detail-method');note.setAttribute('data-state',view.status);parent.append(note);
  if(view.pointCount===1)binanceTable(parent,'来源唯一采样点',['来源采样时间','原始盈亏 USDT'],view.points.map(p=>[timeLabel(p.time),String(p.value)]),'单个采样点不构成曲线。');
}
function renderLeadPerformance(r,parent,period,compact=false){
  const part=leadPeriod(r,period),record=leadRecord(r);
  if(compact){
    const context=node('div',undefined,'card-context');
    context.append(node('span',periodLabel(period)),node('span',r.currency));parent.append(context);
  }
  if(!Number.isFinite(part?.roi)){parent.append(node('p',periodLabel(period)+' 暂无已核验收益率','detail-method'));return;}
  const body=node('div',undefined,'performance-body'),stats=node('div',undefined,'performance-stats');
  const roi=signedValue(part.roi,pct(part.roi));
  stats.append(node('div',roi,'roi '+directionClass(part.roi)+(roi.length>8?' long-roi':'')),node('div',r.exchange+' '+period+' 收益率','roi-label'));
  if(part.fullPeriod===false)stats.append(node('p',(Number.isFinite(part.accountAgeDays)?'带单未满所选周期':'周期覆盖待核验')+' · 来源窗口数值，不参与同期排名','detail-method'));
  const figures=node('div',undefined,'metrics'),unit=part.currency||r.currency;
  const fields=[['同期盈亏 '+unit,signedValue(part.pnl,compact?compactMoney(part.pnl,unit):money(part.pnl,unit)),directionClass(part.pnl)]];
  if(compact){
    if(Number.isFinite(part.mdd))fields.push(['来源回撤',pct(part.mdd)]);
    if(Number.isFinite(part.winRate))fields.push(['来源胜率',pct(part.winRate)]);
    if(Number.isFinite(record.copyTraderNum))fields.push(['公开跟随人数',value(record.copyTraderNum)+' 人']);
    if(Number.isFinite(record.balance?.value)&&record.balance.currency)fields.push(['组合净值 '+record.balance.currency,compactMoney(record.balance.value,record.balance.currency)]);
  }
  for(const [label,amount,tone] of fields){
    const item=node('div');item.append(node('small',label),node('strong',amount,tone));figures.append(item);
  }
  stats.append(figures);body.append(stats);parent.append(body);
  if(!compact)return;
  const graph=node('div',undefined,'performance-chart');graph.append(node('span','每日收益率','curve-label'));
  const plot=node('div');graph.append(plot);body.append(graph);
  if(part.curve?.length>1){plot.append(chart({curve:part.curve}));}
  else if(r.exchange==='OKX'&&part.evidencePath){renderOKXCardCurve(plot,part);}
  else plot.append(node('small','此周期日线未公开'));
  const footer=node('div',undefined,'card-footer');
  const activity=r.activity?.positions,count=r.activity?.history?.rows?.length;
  const coverage=[activity?leadActivityNote(r,'positions',activity):null,Number.isInteger(count)&&count>0?'已归档 '+count+' 条历史仓位':null].filter(Boolean);
  if(coverage.length)footer.append(node('p',coverage.join(' · '),'lead-card-coverage'));
  if(part.lastSuccessAt)footer.append(node('p','绩效采集 '+timeLabel(part.lastSuccessAt),'performance-range'));
  parent.append(footer);
}
const cardCurveRequests=new Map();
function renderOKXCardCurve(plot,part){
  plot.textContent='读取日线…';
  let pending=cardCurveRequests.get(part.evidencePath);
  if(!pending){
    pending=okxEvidenceCurve(part).finally(()=>cardCurveRequests.delete(part.evidencePath));
    cardCurveRequests.set(part.evidencePath,pending);
  }
  pending.then(curves=>plot.replaceChildren(chart({curve:curves.roi})),()=>{plot.textContent='日线读取失败';});
}
function renderBinancePerformance(r,parent,period,compact=false) {
  const value=binancePerformance(r,period),context=node('div',undefined,'card-context');context.append(node('span',periodLabel(period)),node('span','币安来源 · USDT'));if(!compact)parent.append(context);
  const body=node('div',undefined,'performance-body binance-performance'),stats=node('div',undefined,'performance-stats'),roiText=signedValue(value.roi,pct(value.roi)),roi=node('div',roiText,'roi '+directionClass(value.roi)+(roiText.length>8?' long-roi':''));
  roi.setAttribute('title',periodLabel(period)+' 收益率 '+roiText);if(!compact||Number.isFinite(value.roi))stats.append(roi,node('div',value.coverageLabel||'收益率','roi-label'));
  const figures=node('div',undefined,'metrics');
  for(const [label,key,display]of [['盈亏 USDT','pnl',signedValue(value.pnl,compactMoney(value.pnl,'USDT'))],['币安来源回撤','mdd',pct(value.mdd)],['已平仓仓位胜率','winRate',pct(value.winRate)]]){
    if(compact&&!Number.isFinite(value[key]))continue;
    const item=node('div'),amount=node('strong',display,key==='pnl'?directionClass(value.pnl):key==='mdd'&&value.mdd!==null?'negative':'');
    amount.setAttribute('title',key==='pnl'?(value.pnl===null?'—':signedValue(value.pnl,money(value.pnl,value.currency||r.currency))+' '+(value.currency||r.currency)):label+' · '+display);item.append(node('small',label),amount);figures.append(item);
  }
  stats.append(figures);body.append(stats);if(!compact||binanceChart(r,period).pointCount>1)body.append(binanceChartArea(r,period));parent.append(body);
  let note=!value.periodSupported?'未接入该周期的币安表现':value.status==='restricted'?'表现资料不可见':value.lastSuccessAt?'表现采集 '+timeLabel(value.lastSuccessAt)+(value.status==='ready'?' · 有效期 60 分钟':' · 上次成功结果，待更新'):'尚未取得该周期的币安表现';
  if(value.lastSuccessAt&&!value.sourceAsOf)note+=' · 来源未提供统计截止时间';
  body.setAttribute('title',note);
  const summary=!value.periodSupported?'未接入该周期的币安表现':value.status==='restricted'?'表现资料不可见':value.lastSuccessAt?'表现采集 '+timeLabel(value.lastSuccessAt)+(value.status==='ready'?'':' · 上次成功结果，待更新'):'尚未取得该周期的币安表现';
  const status=node('p',compact?summary:note,'binance-performance-note');status.setAttribute('title',note);status.setAttribute('data-state',value.status);if(!compact)parent.append(status);return status;
}
function renderBinanceCard(r,c,period=$('period').value,compact=false) {
  const view=binanceView(r),status=node('p',binanceStatus(view,r)+' · '+binanceTiming(view,r),'card-data-status');status.setAttribute('data-state',view.status);
  if(compact){
    const context=node('div',undefined,'card-context');
    context.append(node('span',periodLabel(period)),node('span',r.referenceOnly&&!hasBinancePerformance(r)?'身份关注':r.currency));
    context.setAttribute('title',status.textContent);c.append(context);
    const performance=binancePerformance(r,period);
    if(['roi','pnl','mdd','winRate'].some(key=>Number.isFinite(performance[key])) || binanceChart(r,period).pointCount>1){
      renderBinancePerformance(r,c,period,true);
      if(!Number.isFinite(performance.roi))c.append(node('p',periodLabel(period)+' 暂无已核实收益率','detail-method'));
    }else{
      const other=['7D','30D','90D','180D','365D'].filter(key=>key!==period&&Number.isFinite(binancePerformance(r,key).roi));
      c.append(node('p',periodLabel(period)+' 暂无已核实收益率'+(other.length?' · 可查 '+other.join(' / '):''),'detail-method'));
    }
    return;
  }
  c.append(status);renderBinancePerformance(r,c,period);
  const figures=node('div',undefined,'binance-card-summary');
  for(const [label,count]of [[r.referenceOnly?'持仓样本':view.status==='ready'?'核验时持仓':'上次持仓',view.currentPositionCount??view.lastPositionCount],['订单样本',view.orders.status==='unavailable'?null:view.orders.rows.length],['历史仓位样本',view.closedPositions.status==='unavailable'?null:view.closedPositions.rows.length]]){const item=node('div');item.append(node('strong',count===null?'—':String(count)),node('small',label));figures.append(item);}
  c.append(figures,node('p',r.referenceOnly?'— 表示数据未取得，不代表空仓或零订单':'仓位与订单为有限样本 · 非完整交割单','binance-sample-note'));
}
function binanceTable(parent,title,columns,rows,note) {
  const section=node('section',undefined,'binance-data-section');section.append(node('h3',title));if(note)section.append(node('p',note));
  if(!rows.length){section.append(node('p','没有可展示的样本。'));parent.append(section);return;}
  const wrap=node('div',undefined,'table-wrap'),table=node('table'),head=node('thead'),header=node('tr');
  for(const column of columns)header.append(node('th',column));head.append(header);const body=node('tbody');
  for(const values of rows){const tr=node('tr');for(const value of values)tr.append(node('td',value===null||value===undefined?'—':String(value)));body.append(tr);}
  table.append(head,body);wrap.append(table);section.append(wrap);parent.append(section);
}
function sourceTime(value) {return value===null||value===undefined||value===0?'—':timeLabel(value);}
let publicExecutionReader=null;
function renderPublicExecutions(r,parent){
  const section=node('section',undefined,'binance-data-section'),status=node('p','正在读取后台保存的公开记录…','detail-method'),table=node('div');
  section.append(status,table);parent.append(section);
  if(typeof BooksBinancePublicRecords==='undefined'){status.textContent='公开记录组件未加载，未取得可用记录；当前仓位未知。';return;}
  publicExecutionReader ||= BooksBinancePublicRecords.reader(globalThis);
  const current=()=>state.detail===r&&$('detail').open&&['analysis','orders'].includes(state.tab)&&section.isConnected;
  function draw(data,failed=false){
    const stale=data.checkedAt&&Date.now()-Date.parse(data.checkedAt)>300000;
    status.textContent=(failed?'结果读取失败，保留上次记录 · ':data.stopped?'后台已停止，保留历史 · ':stale?'保存结果待更新 · ':'')+(data.checkedAt?'已保存 '+data.retainedRecords+' 条记录 · 最近检查 '+timeLabel(data.checkedAt):'后台尚未建立基线');
    table.replaceChildren();
    binanceTable(table,'公开操作记录',['来源更新时间','方向口径','品种','成交数量','均价','来源已实现盈亏','记录首次发现'],data.rows.map(x=>[timeLabel(x.updatedAt),x.direction,x.symbol,x.quantity+' '+x.baseAsset,x.price+' '+x.quoteAsset,x.sourcePnl+' '+x.quoteAsset,timeLabel(x.versionFirstSeenAt)]),'展示最近 20 条记录；来源无订单 ID，方向不区分新开/加仓或减仓/平仓。');
  }
  const saved=publicExecutionReader.last();
  if(saved)draw(saved);
  async function update(){
    if(!current())return;
    if(document.visibilityState==='visible'){
      try{const data=await publicExecutionReader.read();if(current())draw(data);}
      catch{if(!current())return;const last=publicExecutionReader.last();if(last)draw(last,true);else status.textContent='公开记录暂不可读；没有可展示的保存结果。';}
    }
    if(current()&&!publicExecutionReader.reason())setTimeout(update,60000);
  }
  // The section is attached when the dialog opens later in this same task.
  setTimeout(update,0);
}
function renderBinanceDetail(r,b) {
  const view=binanceView(r);b.replaceChildren();
  if(r.referenceOnly){
    if(state.tab==='analysis'){
      b.append(node('p',binanceTiming(view,r),'detail-method'));
      b.append(node('h3','熬鹰资本 · 官方公开表现'));
      b.append(node('p','各周期收益、盈亏、回撤和胜率均来自币安公开接口。开户不足一年的 365D 窗口只覆盖已有带单历史。当前仓位未公开。','detail-method'));
      renderBinanceCard(r,b,state.window);
      const rows=[];
      for(const period of ['7D','30D','90D','180D','365D']){
        const value=binancePerformance(r,period);
        rows.push([value.coverageLabel||periodLabel(period),pct(value.roi),compactMoney(value.pnl,'USDT'),pct(value.mdd),pct(value.winRate),value.lastSuccessAt?timeLabel(value.lastSuccessAt):'—']);
      }
      binanceTable(b,'完整周期表现',['周期','收益率','盈亏 · USDT','来源回撤','已平仓胜率','采集时间'],rows,'币安 365D 是来源独立返回值；页面不会用 180D 或其他周期补写一年数据。');
      renderBinanceChartDetails(r,b,state.window);
      b.append(sourceLink(r));
      return;
    }
    if(state.tab==='orders')renderPublicExecutions(r,b);
    else if(state.tab==='positions'){
      const history=globalThis.BooksAoyingHistory;
      if(history?.portfolioId===r.accountId&&Array.isArray(history.rows)&&history.rows.length)
        binanceTable(b,'官方历史仓位',['开仓时间','结束时间','合约','方向','开仓均价','平仓均价','平仓数量','已实现盈亏'],history.rows.map(p=>[sourceTime(p.opened),sourceTime(p.closed),p.symbol,liveSide(p.side.toLowerCase()),p.avgCost,p.avgClosePrice,p.closedVolume,p.closingPnl]),'已归档 '+history.rows.length+' 条 · '+timeLabel(history.fetchedAt));
      else b.append(node('p','历史仓位资料暂不可读。','detail-method'));
    }else b.append(node('p','交易图表暂不可读，可在成交流水中查看已归档操作。','detail-method'));
    b.append(node('p','币安将当前仓位标记为不可见，未取得当前持仓快照，不代表空仓或零订单。页面只展示独立读取的公开操作记录、官方收益和曲线。','detail-method'),sourceLink(r));return;
  }
  b.append(node('p',binanceTiming(view,r)+(view.lastAttemptAt?' · 来源最近尝试 '+timeLabel(view.lastAttemptAt):''),'detail-method'));
  if(state.tab==='analysis'){
    b.append(node('h3','公开带单组合'),node('p','表现直接采用币安所选周期的来源字段；币安来源回撤与已平仓仓位胜率采用其平台口径，不等同于 Hyperliquid 的采样盈亏回撤或平仓片段胜率。仓位与订单样本不用于推算表现；盈亏曲线按 7D、30D、90D、180D、365D 分别读取币安 PNL 原始采样，统计时间独立。','detail-method'));
    renderBinanceCard(r,b,state.window);renderBinanceChartDetails(r,b,state.window);b.append(sourceLink(r));return;
  }
  if(state.tab==='positions'){
    binanceTable(b,view.status==='ready'?'最近核验持仓':'上次持仓快照（非当前）',['品种','方向','数量','开仓均价','标记价','杠杆','未实现盈亏'],view.positions.map(p=>[p.symbol,liveSide(p.side.toLowerCase()),p.quantity,p.entryPrice,p.markPrice,p.leverage+'×',p.unrealizedPnl+' '+p.collateral]),view.currentPositionCount===0?'最近一次有效核验为空仓。':binanceStatus(view,r));return;
  }
  if(state.tab==='points'){
    const kinds={baseline:'首次观察（非开仓）',appeared:'观察到持仓出现',increased:'观察到增仓',decreased:'观察到减仓',absent:'观察到归零（非确认成交）'};
    binanceTable(b,'持仓变化观察',['观察时间','品种','方向','观察结果','之前数量','之后数量'],view.observations.map(o=>[sourceTime(o.to),o.symbol,liveSide(o.side.toLowerCase()),kinds[o.kind]||o.kind,o.before,o.after]),'变化由快照比较得出；首次观察不是开仓，归零不代表已确认成交。');return;
  }
  const orderNote='仅第一页，最多 20 行。成交数量为订单累计值，不能拆成逐笔成交。限价类型不能证明当前仍挂单。无可靠订单 ID 的行仅展示历史样本。'+(view.orders.fetchedAt?' 采集 '+timeLabel(view.orders.fetchedAt):'')+(view.orders.status==='stale'?' · 上次成功样本，待更新':'');
  binanceTable(b,'订单样本',['订单时间','更新时间','连续样本首次见到','识别结果','品种','买卖','持仓方向','类型','成交数量','成交均价','已实现盈亏'],view.orders.rows.map(o=>[sourceTime(o.orderTime),sourceTime(o.orderUpdateTime),o.firstSeenAt||o.sampleFirstSeenAt?timeLabel(o.firstSeenAt||o.sampleFirstSeenAt):'—',({baseline:'基线或历史',seen:'已见订单',new_order:'新订单'})[o.observation]||'无稳定 ID',o.symbol,liveSide(o.side.toLowerCase()),liveSide(o.positionSide.toLowerCase()),o.type,o.executedQty,o.avgPrice,o.totalPnl]),orderNote);
  binanceTable(b,'历史仓位样本',['开仓时间','结束时间','品种','方向','开仓均价','平仓均价','平仓数量','已实现盈亏'],view.closedPositions.rows.map(p=>[sourceTime(p.opened),sourceTime(p.closed),p.symbol,liveSide(p.side.toLowerCase()),p.avgCost,p.avgClosePrice,p.closedVolume,p.closingPnl]),'有限历史样本，非完整交割单。'+(view.closedPositions.fetchedAt?' 采集 '+timeLabel(view.closedPositions.fetchedAt):'')+(view.closedPositions.status==='stale'?' · 上次成功样本，待更新':''));
}
function positionSummary(now=Date.now()) {
  const summary={eligible:0,expired:0,excluded:0,pending:0,batchExpired:false};
  for(const r of state.publicRows) {
    if(qualifiedPosition(r,now)&&(!isPublicAccount(r)||currentHolding(r,now))){summary.eligible++;continue;}
    const checked=Date.parse(r.positionCheck?.checkedAt||'');
    const excludedAt=state.positionExclusions[r.accountId]??-Infinity;
    if(checked<=excludedAt){if(now-excludedAt>3600000)summary.expired++;else summary.excluded++;}
    else if(Number.isFinite(checked)&&now-checked>3600000)summary.expired++;
    else summary.pending++;
  }
  const v=state.source?.positionVerification;
  summary.batchExpired=!!v&&!state.publicRows.length&&now-Date.parse(v.completedAt)>3600000;
  return summary;
}
function positionStatus(summary=positionSummary()) {
  const v=state.source?.positionVerification;
  if(sourceIsStale()||summary.expired||summary.batchExpired||summary.pending||(!summary.eligible&&(v?.failedAccounts||v?.unattemptedAccounts)))return 'stale';
  return summary.eligible?'ready':'empty';
}
function reevaluatePositions() {mergeRows();renderPreservingCardFocus();renderSource();if(isBinanceTrader(state.detail)&&$('detail').open)renderDetail();}
function observeEmptyPositions(r,part) {
  if(!isPublicAccount(r)||part?.status!=='ready'||!Array.isArray(part.rows)||part.rows.length!==0)return;
  const checked=Number(part.fetchedAt),source=Number(part.sourceTime),now=Date.now();
  if(!Number.isFinite(checked)||!Number.isFinite(source)||checked<=0||source<=0||now-checked>120000||checked-now>5000||checked-source>120000||source-checked>5000)return;
  if(checked<Date.parse(r.positionCheck?.checkedAt||''))return;
  const excluded=Math.max(checked,Date.parse(r.positionCheck?.checkedAt||'')||0);
  if(excluded<=(state.positionExclusions[r.accountId]??-Infinity))return;
  state.positionExclusions[r.accountId]=excluded;savePublicSnapshot('feed',undefined,state.lastReadFailed);reevaluatePositions();
}
function compactAccount(r) {return isPublicAccount(r)?r.accountId.slice(0,8)+'…'+r.accountId.slice(-6):r.accountId||r.id;}
function displayPeriod(p,w) {return w?.derived?parseInt(p,10)+'天':({week:'周度',month:'月度',allTime:'来源累计',perpWeek:'周度',perpMonth:'月度',perpAllTime:'来源累计'})[w?.sourcePeriod]||periodLabel(p);}
function timeLabel(iso) {return new Date(iso).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});}
function renderSource() {
  if(publicListPage){if(state.detail&&$('detail').open)renderDetailStatus();return;}
  const s=state.source,summary=positionSummary();
  $('source-summary').hidden=!s&&!state.lastReadFailed;
  if(s) {
    $('source-name').textContent=s.label;
    const v=s.positionVerification;
    $('source-selection').textContent=v?`${s.selection} · 当前有效：${summary.eligible} 个可看持仓${summary.expired?' · '+summary.expired+' 个持仓核验已过期':''}${summary.excluded?' · '+summary.excluded+' 个已确认空仓（保留历史）':''}`:`${s.selection} · 持仓待核验`;
    $('source-verification').hidden=!v;
    $('source-verification').textContent=v?`上次核验：${v.candidateAccounts} 个候选 · ${v.holdingAccounts} 个持仓 · ${v.emptyAccounts} 个空仓 · ${v.failedAccounts} 个读取失败 · ${v.unattemptedAccounts} 个待核验 · 完成于 ${timeLabel(v.completedAt)}`:'';
    $('source-timing').textContent=`${s.snapshotAt?'快照文件更新 '+timeLabel(s.snapshotAt):'快照文件时间未提供'} · 采集于 ${timeLabel(s.fetchedAt)}`;
    $('source-cadence').textContent='持仓核验有效期 60 分钟';
  }
  $('source-state').textContent=statusText(summary);
  const notice=$('position-notice');notice.hidden=!s&&!state.lastReadFailed;notice.textContent='Hyperliquid · '+statusText(summary)+(s?.positionVerification?' 上次批次完成 '+timeLabel(s.positionVerification.completedAt)+'；历史收益资料继续保留，逐账户核验在详情查看。':'');
  if(!s&&state.lastReadFailed)$('source-name').textContent='Hyperliquid 公开账户';
  $('status').textContent=statusText(summary);$('status').setAttribute('data-state',positionStatus(summary));
  $('source-universe').textContent=s?.positionVerification?s.positionVerification.candidateAccounts.toLocaleString('zh-CN'):'—';
  $('binance-source-summary').hidden=typeof BinanceData==='undefined';
  if(typeof BinanceData!=='undefined'){
    const binanceRows=state.rows.filter(isBinanceTrader),views=binanceRows.map(binanceView),
      referenceCount=binanceRows.filter(r=>r.referenceOnly).length,periodOnly=binanceRows.filter(r=>r.periodOnly).length,
      current=views.filter(v=>v.currentPositionCount>0).length,empty=views.filter(v=>v.currentPositionCount===0).length;
    $('binance-source-state').textContent=binanceRows.length?`已收录 ${views.length} 个身份 · 样本接入 ${views.length-referenceCount-periodOnly} 个 · 有效持仓 ${current} 个 · 有效空仓 ${empty} 个 · 样本账户当前未知 ${views.length-referenceCount-periodOnly-current-empty} 个${periodReturns?' · 独立绩效 '+periodReturns.accounts.length+' 个，包括 '+periodOnly+' 个仅绩效账户':' · 仅身份收录 '+referenceCount+' 个'}`:(state.binanceReadFailed?'币安快照读取失败，尚无可用资料。':'正在读取本站币安快照…');
    $('binance-source-timing').textContent=binanceRows.map((r,i)=>`${r.name}：${binanceTiming(views[i],r)} · ${binanceStatus(views[i],r)}`).join('；');
    if(binanceRows.length){$('status').textContent=`已收录 ${state.rows.filter(r=>!r._local).length} 个公开账户 · 当前有效持仓 ${state.rows.filter(r=>currentHolding(r)).length} 个。历史资料按原时间保留，过期不代表空仓。`;$('status').setAttribute('data-state',positionStatus(summary)==='stale'||views.some((v,i)=>!binanceRows[i].referenceOnly&&v.status!=='ready')?'stale':'ready');}
  }
  const platform=$('exchange').value,local=$('source').value==='local';
  if(local||platform&&platform!=='all'){
    $('source-summary').hidden=local||platform!=='Hyperliquid'||(!s&&!state.lastReadFailed);
    $('binance-source-summary').hidden=local||platform!=='Binance'||typeof BinanceData==='undefined';
    if(local||platform!=='Hyperliquid'){notice.hidden=true;notice.textContent='';}
    if(local){$('status').textContent='本机资料 '+state.localRows.length+' 个';$('status').setAttribute('data-state','local');}
    else if(platform==='Hyperliquid'){$('status').textContent=statusText(summary);$('status').setAttribute('data-state',positionStatus(summary));}
    else{
      const count=state.rows.filter(r=>!r._local&&r.exchange===platform).length;
      const catalog=platform==='OKX'?okxReturns:platform==='Bitget'?bitgetReturns:platform==='Binance'?state.binanceCollection:null;
      const failed=platform==='OKX'?okxReturnsFailed:platform==='Bitget'?bitgetReturnsFailed:platform==='Binance'&&state.binanceReadFailed;
      $('status').textContent=platform+' · 收录 '+count+' 个公开账户'+(catalog?.generatedAt?' · 来源资料采集 '+timeLabel(catalog.generatedAt):'')+(failed?' · 本轮更新失败':'');
      $('status').setAttribute('data-state',failed?'stale':'ready');
    }
  }
  if(state.detail&&$('detail').open)renderDetailStatus();
}
function feed(rows) { return {schemaVersion:1,status:'ready',traders:rows}; }
function mergeRows() {
  const known=new Map(state.binanceRows.map(row=>[row.accountId,row]));
  for(const record of periodReturns?.accounts||[]){
    const row=known.get(record.portfolioId);
    known.set(record.portfolioId,row?{...row,avatarUrl:row.avatarUrl || record.avatarUrl,periodRecord:record}:BinanceData.periodTrader(record));
  }
  const okxActivity=new Map((okxTrades?.accounts||[]).map(row=>[row.uniqueCode,row.activity]));
  const leads=[];
  for(const [catalog,adapter] of [[okxReturns,globalThis.BooksOKXPeriodData],[bitgetReturns,globalThis.BooksBitgetPeriodData]]){
    for(const record of catalog?.accounts||[]){
      const row=adapter.trader(record);
      leads.push({...row,activity:row.exchange==='OKX'?okxActivity.get(row.accountId):record.activity,
        windows:{},positions:[],points:[],orders:[]});
    }
  }
  state.rows=[...retainedPublicRows().map(r=>({...r,_local:false})),...known.values(),...leads,...state.localRows.map(r=>({...r,_local:true}))];
}
async function fetchPeriodText(url){
  // These two archives include per-account histories and can grow to 100 accounts.
  const limit=(url==='bitget/period-returns.json'||url==='okx/trades.json'?32:1)*1048576;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(url,{cache:'no-cache',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok){
      const error=Error('HTTP '+response.status);
      error.retryable=[404,408,425,429].includes(response.status)||response.status>=500;
      throw error;
    }
    if(!response.body||Number(response.headers.get('content-length'))>limit)fail();
    const reader=response.body.getReader(),chunks=[];
    let size=0;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel();fail();}
      chunks.push(value);
    }
    return decodeChunks(chunks);
  }finally{clearTimeout(timer);}
}
async function readPeriodFile(url,parse,old,exchange){
  let body;
  try{body=await fetchPeriodText(url);}catch(e){
    if(!exchange||!(e.retryable||e.name==='TypeError'||e.name==='AbortError'))throw e;
    if(linkedAccount&&linkedExchange()===exchange)linkedStatus('正在重试读取'+exchange+'账户资料…');
    await new Promise(resolve=>setTimeout(resolve,450));
    body=await fetchPeriodText(url);
  }
  const fresh=parse(JSON.parse(body));
  if(old&&Date.parse(fresh.generatedAt)<Date.parse(old.generatedAt))fail();
  const previous=new Map((old?.accounts||[]).map(row=>[row.portfolioId||row.uniqueCode,row.performance]));
  for(const row of fresh.accounts){
    const prior=previous.get(row.portfolioId||row.uniqueCode);
    const incoming=row.performance?.byPeriod||row.performance;
    for(const [period,part] of Object.entries(prior?.byPeriod||prior||{})){
      if(part.lastSuccessAt&&!(Date.parse(incoming[period]?.lastSuccessAt)>=Date.parse(part.lastSuccessAt)))fail();
    }
  }
  return fresh;
}
function tryCatalogLink(){
  if(linkedAccount){mergeRows();openLinkedAccount();}
}
function refreshOKXArchive(){
  if(!globalThis.BooksOKXTrades)return Promise.resolve();
  return sharedRequest('okxArchiveRequest',async()=>{
    try {
      okxTrades=await readPeriodFile('okx/trades.json',BooksOKXTrades.parse,okxTrades);
      okxTradesFailed=false;
    }catch{okxTradesFailed=true;}
    mergeRows();
    if(state.detail?.exchange==='OKX'&&$('detail').open){
      state.detail=state.rows.find(row=>row.id===state.detail.id)||state.detail;
      renderDetail();
    }
  });
}
async function refreshPeriodReturns(){
  const jobs=[];
  if(globalThis.BinanceData?.parsePeriodReturns)jobs.push(
    readPeriodFile('binance/period-returns.json',BinanceData.parsePeriodReturns,periodReturns,'Binance')
      .then(data=>{periodReturns=data;periodReturnsFailed=false;tryCatalogLink();},()=>{periodReturnsFailed=true;}));
  if(globalThis.BooksOKXPeriodData)jobs.push(
    readPeriodFile('okx/period-returns.json',BooksOKXPeriodData.parse,okxReturns,'OKX')
      .then(data=>{okxReturns=data;okxReturnsFailed=false;tryCatalogLink();},()=>{okxReturnsFailed=true;}));
  if(globalThis.BooksBitgetPeriodData)jobs.push(
    readPeriodFile('bitget/period-returns.json',BooksBitgetPeriodData.parse,bitgetReturns,'Bitget')
      .then(data=>{bitgetReturns=data;bitgetReturnsFailed=false;tryCatalogLink();},()=>{bitgetReturnsFailed=true;}));
  if(!publicListPage||state.detail?.exchange==='OKX'||linkedAccount&&linkedExchange()==='OKX')jobs.push(refreshOKXArchive());
  await Promise.all(jobs);
}
function node(tag,content,cls) { const n=document.createElement(tag); if(content!==undefined)n.textContent=content; if(cls)n.className=cls; return n; }
function button(label, action, cls) { const b=node('button',label,cls); b.type='button'; b.addEventListener('click',action); return b; }
function safeAvatarUrl(value,exchange) {
  if(exchange==='Bitget')return globalThis.BooksBitgetPeriodData?.avatarUrl(value) ?? null;
  if(typeof value!=='string'||value.length>2048||/[\s\u0000-\u001f\u007f\\]/.test(value))return null;
  try{const url=new URL(value),trusted=exchange==='Binance'?['public.bnbstatic.com','public-1306379396.file.myqcloud.com'].includes(url.hostname)&&url.pathname.startsWith('/image/'):exchange==='OKX'&&url.hostname==='static.okx.com'&&url.pathname.startsWith('/cdn/okex/users/headimages/');return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&trusted?url.href:null;}catch(_){return null;}
}
function sourceIdentity(r) {const label=r.exchange==='Binance'&&isBinanceTrader(r)?'组合 ID':r.exchange==='Hyperliquid'&&canReadLive(r)?'钱包地址':r.exchange==='OKX'?'带单代码':r.exchange==='Bitget'?'组合 ID':'来源账号';return r.accountId?label+' '+r.accountId:label+' 未提供';}
function avatar(r) {
  const wrapper=node('div',undefined,'avatar'),fallback=node('span',r.exchange.slice(0,2));wrapper.append(fallback);
  const url=safeAvatarUrl(r.avatarUrl,r.exchange);if(!url)return wrapper;
  const image=node('img');image.alt='';image.loading='eager';image.decoding='async';image.referrerPolicy='no-referrer';image.hidden=true;image.width=40;image.height=40;
  let failed=false;image.addEventListener('load',()=>{if(!failed){fallback.hidden=true;image.hidden=false;}},{once:true});image.addEventListener('error',()=>{failed=true;wrapper.replaceChildren(fallback);fallback.hidden=false;},{once:true});image.src=url;wrapper.append(image);return wrapper;
}
const positionSnapshotMaxAge=120000;
let detailLiveSnapshot=null,detailPositionExpiry=null,ledgerView=null,historyView=null;
let leadPointFocus=null,leadPointPanel=null,leadPointClient=null;
function resetDetailWidgets(){
  clearLeadPointChart();leadPointFocus=null;
  clearTimeout(detailPositionExpiry);detailPositionExpiry=null;
  ledgerView?.handle?.destroy();historyView?.handle?.destroy();
  ledgerView=null;historyView=null;
  for(const id of ['detail-ledger','detail-history']){const box=$(id);if(box){box.hidden=true;box.replaceChildren();}}
}
function syncDetailWidgets(r){
  const account=isBinanceTrader(r)||isPublicLead(r)||canReadLive(r);
  const eligible=account&&state.tab==='analysis'&&!publicListPage,scope=r.exchange+'/'+r.accountId;
  const widgets=[
    ['detail-ledger',eligible&&canReadLive(r),globalThis.BooksStrategyAnalysisView,ledgerView,scope+'/'+state.window],
    ['detail-history',account&&!publicListPage&&['analysis','live'].includes(state.tab),globalThis.BooksPositionHistoryView,historyView,scope],
  ];
  for(const [id,show,api,previous,key] of widgets){
    const box=$(id);if(!box)continue;
    if(show&&api&&previous?.key===key){box.hidden=false;continue;}
    previous?.handle?.destroy();box.replaceChildren();box.hidden=!show||!api;
    const next=box.hidden?null:{key,handle:api.mount(box,r,state.window)};
    if(id==='detail-ledger')ledgerView=next;else historyView=next;
  }
}
function detailPositionSnapshot(r){
  const observed=detailLiveSnapshot&&detailLiveSnapshot.accountId===r.accountId?detailLiveSnapshot.part:null;
  if(canReadLive(r)){
    const point=observed|| (isPublicFocus(r)&&publicFocus.snapshot?{rows:publicFocus.snapshot.positions,sourceTime:publicFocus.snapshot.sourceTime}:null);
    if(point?.rows){
      return {at:point.sourceTime,rows:point.rows.map(p=>({...p,notional:p.positionValue,currency:'USDC'})),label:'默认永续市场 · 观测时 '+point.rows.length+' 个仓位',source:'Hyperliquid',unit:'USDC'};
    }
    const check=r.positionCheck;
    return {at:check?.sourceTime,label:check?'默认永续市场 · 最近核验 '+check.count+' 个仓位':'默认永续市场 · 仓位尚待核验',source:'Hyperliquid'};
  }
  if(isPublicLead(r)){
    const part=r.activity?.positions;
    return {at:part?.fetchedAt,label:leadActivityNote(r,'positions',part)||'未取得公开仓位',source:r.exchange,
      rows:part?.rows,partial:part?.status==='partial'||part?.hiddenCount>0};
  }
  if(isBinanceTrader(r)){
    const view=binanceView(r),privateProfile=r.referenceOnly?globalThis.BooksReferenceData?.profile(globalThis.BooksAoyingHistory,r.accountId):null;
    const restricted=r.periodRecord?.positionShow===false||privateProfile?.positionShow===false||view.status==='restricted';
    const rows=view.positions.map(p=>({...p,side:p.side.toLowerCase(),currency:p.collateral,unrealizedPnl:Number(p.unrealizedPnl),
      notional:p.collateral==='USDT'&&p.symbol.endsWith('USDT')?Math.abs(Number(p.quantity)*Number(p.markPrice)):null}));
    return {at:view.observedAt||privateProfile?.fetchedAt||r.periodRecord?.profileFetchedAt,label:restricted?'币安未公开当前仓位':view.observedAt?'观测时 '+rows.length+' 个公开仓位'+(view.status==='stale'?' · 当前状态待更新':''):'未取得公开仓位',source:'币安',rows};
  }
  return null;
}
let alphaPositionArchive=null,alphaPositionsPending=null,alphaPositionsAttempt=0,alphaPositionsFailed=false;
function hasAlphaPositionArchive(r){return r?.referenceOnly&&r.accountId==='5075281354358777856'&&!!globalThis.BooksAoyingPublicArchive;}
function lastAlphaPosition(r){
  if(!hasAlphaPositionArchive(r))return null;
  return (alphaPositionArchive?.positionSnapshots||[]).findLast(x=>x.rows?.length)||null;
}
function alphaPositionLabel(held){
  const row=held.rows[0],side=({long:'多仓',short:'空仓'})[row.side]||'';
  return row.symbol+' '+side+' · '+value(row.quantity)+(row.baseAsset?' '+row.baseAsset:'')+(held.rows.length>1?' 等 '+held.rows.length+' 笔':'');
}
function appendAlphaPositions(r,root){
  if(!hasAlphaPositionArchive(r))return;
  const path='binance/aoying-public-archive.json',held=lastAlphaPosition(r),latest=alphaPositionArchive?.positionSnapshots?.at(-1);
  if(held){
    const section=node('details',undefined,'reference-positions');section.setAttribute('data-source','alphafox');section.open=state.tab==='live';
    section.append(node('summary','查看仓位明细与来源'));
    const unit=held.quote,at=held.sourceTime||held.polledAt;
    binanceTable(section,'AlphaFox 最后观测到的仓位',['合约','方向','数量','来源开仓时间（北京）','开仓均价','标记价','名义金额 '+unit,'浮动盈亏 '+unit,'仓位杠杆'],
      held.rows.map(p=>[p.symbol,p.side==='long'?'多':p.side==='short'?'空':'—',value(p.quantity)+(p.baseAsset?' '+p.baseAsset:''),p.sourceOpenedAt?timeLabel(p.sourceOpenedAt):null,value(p.entryPrice),value(p.markPrice),value(p.notional),value(p.unrealizedPnl),p.leverage==null?null:value(p.leverage)+'×']),
      '第三方公开档案 · 来源观察 '+timeLabel(at)+'（北京） · 档案采集 '+timeLabel(held.fetchedAt)+'（北京）。币安当前仓位仍未公开。');
    const totals=held.totals||{},metrics=node('div',undefined,'lead-detail-metrics');
    for(const [field,label,multiplier] of [['marginBalance','快照保证金余额',false],['notional','快照名义敞口',false],['unrealizedPnl','快照浮动盈亏',false],['effectiveLeverage','快照实际杠杆',true]]){
      if(!Number.isFinite(totals[field]))continue;
      const item=node('div');item.append(node('small',label),node('strong',value(Math.round(totals[field]*100)/100)+(multiplier?'×':' '+unit)));metrics.append(item);
    }
    if(metrics.children.length)section.append(metrics);
    if(latest!==held)section.append(node('p','此后一次第三方查询于 '+timeLabel(latest.sourceTime||latest.polledAt)+'，'+({reported_empty:'当次未列仓位',hidden:'返回仓位不可见',unavailable:'未取得仓位'}[latest.status]||'当前仓位待核')+'。','detail-method'));
    const links=node('div',undefined,'lead-source-links');links.append(evidenceLink('AlphaFox 归档',path),evidenceLink('第三方公开来源 ↗',held.sourceUrl));
    section.append(links);root.append(section);
  }else if(alphaPositionsFailed)root.append(node('p','本次未能读取 AlphaFox 历史仓位档案。','detail-method'));
  if(alphaPositionsPending||Date.now()-alphaPositionsAttempt<60000)return;
  alphaPositionsAttempt=Date.now();
  alphaPositionsPending=(async()=>{
    const response=await fetch(path,{credentials:'omit',redirect:'error',cache:'no-cache'});
    const limit=8*1024*1024;if(!response.ok||Number(response.headers.get('content-length'))>limit)throw Error('reference_positions');
    const raw=await response.text();if(raw.length>limit)throw Error('reference_size');
    alphaPositionArchive=BooksAoyingPublicArchive.parse(JSON.parse(raw));alphaPositionsFailed=false;
  })().catch(()=>{alphaPositionsFailed=true;}).finally(()=>{
    alphaPositionsPending=null;if(state.detail?.accountId===r.accountId&&$('detail').open)renderDetail();
  });
}
function renderDetailOverview(r){
  const root=$('detail-overview');if(!root)return;
  const snap=detailPositionSnapshot(r);root.replaceChildren();root.hidden=!snap;if(!snap)return;
  const held=lastAlphaPosition(r);
  if(held&&!binanceView(r).observedAt){
    const title=node('div',undefined,'overview-heading');
    title.append(node('strong','最后观测持仓'),node('span','AlphaFox 第三方快照 · '+timeLabel(held.sourceTime||held.polledAt)+'（北京）','meta'));
    root.append(title,node('p',alphaPositionLabel(held),'overview-position-state'));appendAlphaPositions(r,root);return;
  }
  const title=node('div',undefined,'overview-heading');title.append(node('strong','持仓概览'),node('span',snap.source+(snap.at?' · '+timeLabel(snap.at):''),'meta'));root.append(title);
  root.append(node('p',snap.label,'overview-position-state'));
  appendAlphaPositions(r,root);
  if(!snap.rows?.length)return;
  const dirs=snap.rows.map(p=>String(p.side).toLowerCase()),summary=node('div',undefined,'overview-figures');
  function fact(label,amount){const cell=node('div');cell.append(node('small',label),node('strong',amount));summary.append(cell);}
  fact('可见多仓 / 空仓',dirs.filter(v=>v==='long').length+' / '+dirs.filter(v=>v==='short').length);
  const groups=new Map();
  for(const p of snap.rows){if(!p.currency)continue;const group=groups.get(p.currency)||[];group.push(p);groups.set(p.currency,group);}
  for(const [unit,rows] of groups){
    for(const [field,name] of [['notional','可见名义敞口'],['unrealizedPnl','可见浮动盈亏']]){
      if(!rows.every(x=>Number.isFinite(x[field])))continue;
      const total=rows.reduce((sum,x)=>sum+(field==='notional'?Math.abs(x[field]):x[field]),0);
      if(Number.isFinite(total))fact(name,value(Math.round(total*100)/100)+' '+unit);
    }
  }
  root.append(summary);
}
function acceptDetailPositions(r,part,maxAge=positionSnapshotMaxAge){
  if(!canReadLive(r)||state.detail?.accountId!==r.accountId||part?.status!=='ready'||part.error||!Array.isArray(part.rows))return;
  const {sourceTime,fetchedAt}=part,now=Date.now();
  if(!Number.isSafeInteger(sourceTime)||sourceTime<=0||!Number.isSafeInteger(fetchedAt)||fetchedAt<=0||fetchedAt>now+5000||sourceTime>Math.min(now,fetchedAt)+5000)return;
  if(detailLiveSnapshot?.accountId===r.accountId&&detailLiveSnapshot.part.sourceTime>=sourceTime)return;
  clearTimeout(detailPositionExpiry);
  const expiresAt=Math.min(sourceTime,fetchedAt)+maxAge;
  detailLiveSnapshot={accountId:r.accountId,part,expiresAt};renderDetailOverview(r);renderDetailStatus();
  if(!isPublicFocus(r)&&expiresAt>=now)detailPositionExpiry=setTimeout(()=>{if(state.detail?.accountId===r.accountId)renderDetailStatus();},expiresAt-now+1);
}
function renderDetailIdentity(r) {$('detail-avatar').replaceChildren(avatar(r));$('detail-title').textContent=r.name;$('detail-meta').textContent=r.exchange+' · '+sourceIdentity(r)+' · '+r.currency+(r._local?' · 我的资料':'');}
function sourceLink(r) { const a=node('a',isPublicLead(r)?r.exchange+' 官方收益数据 ↗':'查看来源 ↗','source-link'); a.href=isPublicLead(r)?(leadPeriod(r,state.detail===r?state.window:$('period').value)?.sourceUrl||r.sourceUrl):r.sourceUrl; a.target='_blank'; a.rel='noopener noreferrer'; return a; }
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
function chart(w,kind='return',unit='USD') {
  const el=node('div',undefined,'chart'), pts=w?.curve||[];
  if(pts.length<2) { el.textContent='暂无收益曲线'; return el; }
  const values=pts.map(p=>p.value),lo=Math.min(...values,...(kind==='pnl'?[0]:[])),hi=Math.max(...values,...(kind==='pnl'?[0]:[])),start=Date.parse(pts[0].time),end=Date.parse(pts.at(-1).time);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 300 90'); svg.setAttribute('role','img');
  svg.setAttribute('aria-label',`${kind==='pnl'?'来源盈亏变化曲线':'来源收益曲线'}：${pts.length} 个样本，起点 ${value(pts[0].value)}${kind==='pnl'?' '+unit:'%' }，终点 ${value(pts.at(-1).value)}${kind==='pnl'?' '+unit:'%'}；${pts[0].time} 至 ${pts.at(-1).time}`);
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
function mddReason(reason) {return ({non_positive_peak_equity:'峰值时的永续账户权益非正，无法计算采样盈亏回撤',unpaired_samples:'盈亏与永续权益采样时间不一致，无法计算采样盈亏回撤',insufficient_samples:'有效来源样本不足，无法计算采样盈亏回撤',no_valid_peak:'缺少有效的峰值权益，无法计算采样盈亏回撤',invalid_denominator:'永续权益分母无效，无法计算采样盈亏回撤'})[reason]||'尚未取得可核验的永续账户历史，采样盈亏回撤暂缺';}
function sampledDrawdown(w,period) {
  if(!hasPortfolioWindowContract(w,period)||w.mddUnavailableReason!==null||!Number.isFinite(w.mdd)||w.mdd<0||!Number.isSafeInteger(w.sampleCount)||w.sampleCount<2||w.mddPairedSampleCount!==w.sampleCount)return null;
  return w.mdd;
}
function drawdownDescription(w,period) {
  const value=sampledDrawdown(w,period);
  return value===null?mddReason(w?.mddUnavailableReason):'采样盈亏回撤：累计盈亏从此前运行峰值的下跌额 ÷ 峰值时的永续账户权益，仅按有效正权益峰值取区间内最大比值；可能超过 100%，不是资金流调整净值的最大回撤。'+(derivedPeriods.includes(period)?'按所选实际采样区间重算，并非 Hyperliquid 官方直接发布的区间指标。':'参考 Hyperliquid 实际界面的计算方式。');
}
function metrics(w,currency,includeROI=false,r=null,period=null) {
  const el=node('div',undefined,'metrics');
  const publicAccount=r&&isPublicAccount(r),part=publicAccount?portfolioSection(r,period):null,window=part?.status==='ready'?part.windows[period]:null;
  const drawdown=publicAccount?sampledDrawdown(window,period):w?.mdd,winEntry=publicAccount?cachedWin(r):null;
  const items=[['盈亏 '+currency,signedValue(w?.pnl,includeROI?money(w?.pnl,currency):compactMoney(w?.pnl,currency)),w?.pnl==null?'—':signedValue(w.pnl,money(w.pnl,currency))+' '+currency,directionClass(w?.pnl)],[publicAccount?'采样盈亏回撤':'最大回撤',pct(drawdown),undefined,drawdown==null?'':'negative'],[publicAccount?'平仓片段胜率':'逐笔胜率',pct(publicAccount?winEntry?.win?.value:win(w))]];
  if(includeROI)items.unshift([publicAccount&&derivedPeriods.includes(period)?'自算收益率':'收益率',signedValue(w?.roi,pct(w?.roi)),publicAccount&&derivedPeriods.includes(period)?periodROIDescription(w):undefined,directionClass(w?.roi)]);
  for(const [label,v,exact,color]of items) {
    if(!includeROI&&v==='—')continue;
    const c=node('div'),amount=node('strong',v,color);amount.setAttribute('title',exact||v);c.append(node('small',label),amount);
    if(publicAccount&&label==='采样盈亏回撤')amount.setAttribute('title',drawdownDescription(window,period));
    if(publicAccount&&label==='平仓片段胜率')amount.setAttribute('title',winCacheDescription(r));
    el.append(c);
  }
  return el;
}
function ensureAnalyticsClient() {
  if(!state.analyticsClient&&typeof BooksAccountAnalytics!=='undefined')state.analyticsClient=BooksAccountAnalytics.create({visible:document.visibilityState!=='hidden',onChange:record=>{const row=state.rows.find(r=>r.accountId===record.address),before=row?sortValue(row,$('period').value,$('sort').value):null;state.analytics[record.address]=record;refreshAnalyticsViews(record.address);if(row&&before!==sortValue(row,$('period').value,$('sort').value))schedulePerformanceOrder();}});
  return state.analyticsClient;
}
function fillPerformanceGraph(r,period,graph,compact=false) {
  graph.replaceChildren();graph.hidden=false;
  const part=portfolioSection(r,period),w=part?.status==='ready'?part.windows[period]:null;
  if(isPublicAccount(r)&&w?.points?.length>1)graph.append(node('span','盈亏变化 · USD','curve-label'),chart({curve:w.points},'pnl'));
  else if(!isPublicAccount(r)&&r.windows[period]?.curve.length>1)graph.append(chart(r.windows[period]));
  else if(compact)graph.hidden=true;
  else graph.append(node('span',isPublicAccount(r)?'盈亏曲线':'收益曲线','curve-label'),node('span','—','curve-unavailable'));
}
function refreshAnalyticsViews(address) {
  for(const view of state.analyticsViews.filter(v=>v.r.accountId===address)) {
    const fresh=metrics(performanceWindow(view.r,view.period),view.r.currency,view.kind==='detail',view.r,view.period);
    view.metrics.replaceChildren(...fresh.children);fillPerformanceGraph(view.r,view.period,view.graph,view.kind==='card');
    if(view.roi)fillPerformanceSummary(view.r,view.period,view);
    if(view.kind==='detail') {
      const portfolio=portfolioSection(view.r,view.period),window=portfolio?.windows?.[view.period],entry=cachedWin(view.r),win=entry?.win;
      if(view.roiMethodNote)view.roiMethodNote.textContent=`${parseInt(view.period,10)}天滚动窗口，非自然季度或年度；区间盈亏来自实际首末采样差。${periodROIDescription(window)}`;
      view.portfolioStatus.textContent=portfolio?.status==='ready'?(window?.sampleCount>1?`来源采样 ${window.sampleCount} 点 · ${timeLabel(window.startAt)} 至 ${timeLabel(window.endAt)}${derivedPeriods.includes(view.period)?' · '+performanceRange(view.r,view.period):''}${portfolio.fetchedAt?' · 采集 '+timeLabel(portfolio.fetchedAt):''}${portfolio.stale?' · 上次成功采样':''}`:'来源未提供当前周期的有效曲线样本。'):portfolio?.status==='error'?'曲线读取失败，尚未取得可用数据。':portfolio?.status==='queued'?'正在排队读取来源盈亏曲线…':portfolio?.status==='loading'?'正在读取来源盈亏曲线…':'尚未取得当前窗口的盈亏曲线。';
      if(portfolio?.status==='ready'&&window)view.portfolioStatus.textContent+=' · '+drawdownDescription(window,view.period);
      view.winStatus.textContent=win?(win.eligibleCount?`永续平仓片段 ${win.eligibleCount} 笔 · 盈利 ${win.winning} · 亏损 ${win.losing} · 持平 ${win.breakeven}；样本 ${timeLabel(win.startAt)} 至 ${timeLabel(win.endAt)}`:'平仓片段胜率暂缺：最近返回的成交中，没有符合当前口径的永续平仓片段；不能据此判断账户从未平仓。')+` · 来源返回 ${win.receivedFills} 条 → 有效 ${win.eligibleCount}、排除 ${win.excludedCount}${win.duplicateCount?'、重复 '+win.duplicateCount:''}${win.sourceSampleStartAt?' · 来源成交样本 '+timeLabel(win.sourceSampleStartAt)+' 至 '+timeLabel(win.sourceSampleEndAt):''}${win.capped?' · 达到 2000 条上限，可能截断更早历史':' · 仅近期样本，非完整历史'} · 后台采集 ${timeLabel(entry.fetchedAt)}${entry.lastAttemptAt?' · 最近尝试 '+timeLabel(entry.lastAttemptAt):''}${winCacheIsStale(entry)?' · 上次成功结果，等待后台更新':''}`:'后台尚未取得有效平仓样本；取得后自动显示。'+(entry?.lastAttemptAt?' · 最近尝试 '+timeLabel(entry.lastAttemptAt):'');
      view.winStatus.setAttribute('data-state',winCacheIsStale(entry)?'stale':win?'ready':'unavailable');
      view.portfolioButton.hidden=portfolio?.status!=='error';view.portfolioButton.disabled=['queued','loading'].includes(portfolio?.status);

    }
  }
}
function startVisibleAnalytics(rows,onlyChanged=false) {
  const visible=rows.filter(r=>canReadLive(r)&&currentHolding(r)),waiting=!state.portfolioCacheAttempted;
  const accounts=[...new Set((waiting?[]:visible.filter(r=>{const entry=state.portfolioCache[r.accountId];return !entry?.portfolio||Date.now()-Date.parse(entry.fetchedAt)>3600000;})).map(r=>r.accountId))].slice(0,12),client=accounts.length?ensureAnalyticsClient():state.analyticsClient;
  if(onlyChanged&&accounts.length===state.analyticsTargets.length&&accounts.every((address,i)=>address===state.analyticsTargets[i]))return;
  state.analyticsTargets=accounts;client?.setPortfolioTargets(accounts);
}
const privateResearchOrigin='https://books-private-follow.rr7jp4d56w.chatgpt.site';
// Enable after the private site verifies the selected leader for both modes.
const privateLeaderRoutingReady=false;
function showPrivateActionNotice(r,mode,label){
  const dialog=node('dialog',undefined,'private-action-notice');
  const heading=node('h2',r.name+' · '+label),message=node('p','账户设置暂不可用，请稍后重试。');
  heading.id='private-action-title';message.id='private-action-message';
  dialog.setAttribute('aria-labelledby',heading.id);dialog.setAttribute('aria-describedby',message.id);
  const close=button('关闭',()=>dialog.close());
  dialog.addEventListener('close',()=>{
    dialog.remove();
    const controls=state.cardControls.find(item=>item.r.id===r.id);
    controls?.[mode==='paper'?'paperLink':'followLink']?.focus();
  },{once:true});
  dialog.append(heading,message,close);document.body.append(dialog);dialog.showModal();close.focus();
}
function privateCardActions(r,ready=privateLeaderRoutingReady){
  const id=r.accountId,valid=isBinanceTrader(r)&&/^\d{19}$/.test(id)||canReadLive(r)||isPublicLead(r)&&(r.exchange==='OKX'?/^(?:[A-Za-z0-9]{16}|[A-Za-z0-9]{18})$/:/^[1-9]\d{18}$/).test(id);
  if(!valid||r._local)return null;
  function action(mode,label){
    if(!ready){
      const control=button(label,()=>showPrivateActionNotice(r,mode,label),'private-'+mode);
      control.setAttribute('aria-haspopup','dialog');control.setAttribute('aria-label',label+' · '+r.name);
      return control;
    }
    const target=new URL('/',privateResearchOrigin);
    for(const [key,v] of Object.entries({exchange:r.exchange,sourceAccountId:id,name:r.name,mode}))target.searchParams.set(key,v);
    const link=node('a',label,'private-'+mode);link.href=target.href;link.target='_blank';link.rel='noopener noreferrer';
    link.setAttribute('aria-label',label+' · '+r.name+'（私人站）');return link;
  }
  return {paperLink:action('paper','模拟'),followLink:action('follow','跟单')};
}
function cardSourceTimes(r,period) {
  const when=t=>t&&Number.isFinite(Date.parse(t))?timeLabel(t):null;
  if(r._local)return ['来源：本浏览器手动资料',when(r.observedAt)?'记录时间：'+when(r.observedAt):'记录时间未知'];
  if(isBinanceTrader(r)){
    const performance=binancePerformance(r,period),view=binanceView(r),at=when(performance?.lastSuccessAt),profile=r.referenceOnly?globalThis.BooksReferenceData?.profile(globalThis.BooksAoyingHistory,r.accountId):null;
    const position=r.periodRecord?.positionShow===false||profile?.positionShow===false||view.status==='restricted'?'来源未公开持仓':r.periodOnly?'仓位未采集':view.refreshStopped?'仓位采集已停止':state.binanceReadFailed?'仓位快照读取失败':view.status==='stale'?'仓位快照已过期':view.status==='unavailable'?'仓位未取得':'仓位快照已采集';
    return ['来源：币安公开资料',period+' 收益采集：'+(at||'未取得'),position+' · '+binanceTiming(view,r)];
  }
  if(isPublicLead(r)){
    const performance=leadPeriod(r,period),positions=r.activity?.positions,at=when(performance?.lastSuccessAt),positionAt=when(positions?.fetchedAt);
    const position=leadActivityNote(r,'positions',positions)||'持仓未取得';
    const minutes=positions?.publicDelayMinutes,delay=r.exchange==='Bitget'&&positions?.rows?.length?(Number.isFinite(minutes)&&minutes>=0?' · 来源标注延迟 '+minutes+' 分钟':' · 来源延迟未标注'):'';
    return ['来源：'+r.exchange+' 公开资料',period+' 收益采集：'+(at||'未取得'),position+(positionAt?' · 采集 '+positionAt:'')+delay];
  }
  if(isPublicAccount(r)){
    const w=performanceWindow(r,period),part=portfolioSection(r,period),at=when(w?.derived?part?.fetchedAt:w?.asOf),check=r.positionCheck;
    return ['来源：Hyperliquid 公开资料',period+(w?.derived?' 收益采集：':w?.asOfType==='source'?' 收益来源快照：':' 收益采集：')+(at||'未取得'),check?'仓位核验：'+(when(check.checkedAt)||'时间未知')+' · 来源 '+(when(check.sourceTime)||'未知')+' · '+(!state.lastReadFailed&&state.source?.status==='ok'&&qualifiedPosition(r)?'有效期内':'当前状态待更新'):'仓位未核验'];
  }
  return ['来源：'+r.exchange+' 公开资料','更新时间：'+(when(r.observedAt)||'未取得')];
}
function card(r,period) {
  const w=performanceWindow(r,period),c=node('article',undefined,'card'),top=node('div',undefined,'card-top'),identity=node('div',undefined,'card-identity'),links=node('div',undefined,'card-links');
  const name=node('h3'),detail=button(r.name,()=>openDetail(r,period),'detail-button trader-name-button');
  detail.setAttribute('title',r.name);detail.setAttribute('aria-label','查看 '+r.name+' 的研究详情');name.append(detail);
  const identityMeta=node('div',r.exchange+(r.paid?' · 付费来源':'')+(r._local?' · 我的资料':''),'meta');identityMeta.setAttribute('title',r.accountId||r.id);
  const idLine=node('div',isPublicAccount(r)?'钱包 '+r.accountId.slice(0,8)+'…'+r.accountId.slice(-6):sourceIdentity(r),'platform-id');
  idLine.setAttribute('title',sourceIdentity(r));identity.append(name,identityMeta,idLine);
  const sourceTimes=node('div',undefined,'card-data-status');
  for(const line of cardSourceTimes(r,period))sourceTimes.append(node('div',line));
  if(r.exchange==='Bitget'&&r.catalogStatus==='retained')identity.append(node('div','历史收录 · 待重新筛选','platform-id'));
  if(r.exchange==='OKX'&&r.selectionStatus==='historical')identity.append(node('div','历史收录 · 资料为旧快照','platform-id'));
  const actions=privateCardActions(r),controls={r,detailButton:detail};
  if(actions){links.append(actions.paperLink,actions.followLink);Object.assign(controls,actions);}
  else{controls.sourceLink=sourceLink(r);links.append(controls.sourceLink);}
  top.append(avatar(r),identity,links,sourceTimes);c.setAttribute('data-layout','aligned');c.append(top);state.cardControls.push(controls);
  c.addEventListener('click',event=>{
    if(event.target.closest('a,button,input,select,textarea,summary,details')||globalThis.getSelection?.()?.toString())return;
    openDetail(r,period);
  });
  if(isPublicLead(r)){renderLeadPerformance(r,c,period,true);return c;}
  if(isBinanceTrader(r)){renderBinanceCard(r,c,period,true);return c;}
  const context=node('div',undefined,'card-context');context.append(node('span',periodName(period,w)));
  let timing=w?.derived?performanceRange(r,period):stampLabel(w);
  if(isPublicAccount(r)&&r.positionCheck){timing+=` · 永续主市场持仓核验 ${timeLabel(r.positionCheck.checkedAt)} · 持仓来源时间 ${timeLabel(r.positionCheck.sourceTime)}`;}
  else context.append(node('span',r.currency));
  context.setAttribute('title',timing);c.append(context);
  const footer=node('div',undefined,'card-footer');
  if(hasMetrics(w)||isPublicAccount(r)) {
    const performance=node('div',undefined,'performance-body'),stats=node('div',undefined,'performance-stats'),graph=node('div',undefined,'performance-chart'),roiText=signedValue(w?.roi,pct(w?.roi));
    const roi=node('div',roiText,'roi '+directionClass(w?.roi)+(roiText.length>8?' long-roi':''));roi.setAttribute('title',`${displayPeriod(period,w)} 收益率 ${roiText}`);
    const roiLabel=node('div',undefined,'roi-label');stats.append(roi,roiLabel);
    const figures=metrics(w,r.currency,false,r,period);stats.append(figures);fillPerformanceGraph(r,period,graph,true);
    performance.append(stats,graph);c.append(performance);
    if(isPublicAccount(r)){const rangeNote=node('p',undefined,'performance-range'),view={kind:'card',r,period,metrics:figures,graph,rangeNote,roi,roiLabel,cardRoot:c,detailButton:detail};fillPerformanceSummary(r,period,view);footer.append(rangeNote);state.analyticsViews.push(view);}else{roi.hidden=!Number.isFinite(w?.roi);roiLabel.textContent=`${displayPeriod(period,w)} 收益率${roi.hidden?' · 暂缺':''}`;}
  } else c.append(node('p',`${displayPeriod(period,w)} 收益率 · 暂缺`,'performance-body meta'));
  if(r.note)footer.append(node('p',r.note,'profile-note'));
  if(r._local){const actions=node('div',undefined,'card-actions');actions.append(button('编辑',()=>openEditor(r)),button('删除',()=>removeRecord(r)));footer.append(actions);}
  c.append(footer);return c;
}
function linkedExchange(params=new URL(location.href).searchParams){
  return params.get('detailExchange')||params.get('exchange')||'all';
}
function writeListQuery(url){
  const query=$('search').value.trim();
  if(query)url.searchParams.set('q',query);else url.searchParams.delete('q');
  if(state.page>1)url.searchParams.set('page',state.page);else url.searchParams.delete('page');
}
function writePublicFilters(url){
  for(const [id,defaultValue] of [['period','30D'],['exchange','all'],['sort','roi']]){
    const value=$(id).value;
    if(value===defaultValue)url.searchParams.delete(id);else url.searchParams.set(id,value);
  }
  writeListQuery(url);
}
function detailURL(row,period,view='analysis'){
  const url=new URL(location.href);
  if(publicListPage)writePublicFilters(url);
  url.searchParams.set('account',row.accountId);
  url.searchParams.set('detailExchange',row.exchange);
  url.searchParams.set('detailPeriod',period);
  if(view==='analysis')url.searchParams.delete('view');else url.searchParams.set('view',view);
  return url;
}
function saveDetailURL(){
  const url=new URL(location.href);
  if(url.searchParams.get('account')!==state.detail?.accountId)return;
  history.replaceState(history.state,'',detailURL(state.detail,state.window,state.tab));
}
function readURL() {
  const p=new URL(location.href).searchParams, defaults={period:'30D',exchange:'all',source:'all',sort:'roi',currency:'all'};
  const rawAccount=p.get('account')||'',account=linkedExchange(p)==='OKX'?rawAccount:rawAccount.toLowerCase();
  const okxCode=linkedExchange(p)==='OKX'&&/^(?:[A-Za-z0-9]{16}|[A-Za-z0-9]{18})$/.test(account);
  linkedAccount=/^(?:0x[0-9a-f]{40}|\d{19})$/.test(account)||okxCode?account:null;
  linkedStatus(linkedAccount?'正在读取链接所指的账户资料…':'');
  state.explicitPeriod=periods.includes(p.get('period'));
  for(const id of controls) { const el=$(id); el.value=[...el.options].some(o=>o.value===p.get(id))?p.get(id):defaults[id]; }
  $('search').value=(p.get('q')||'').slice(0,100); const page=Number(p.get('page')); state.page=Number.isSafeInteger(page)&&page>0?page:1;
}
function linkedStatus(message){
  let status=$('linked-account-status');
  if(!message&&!status)return;
  if(!status){status=node('p');status.id='linked-account-status';status.setAttribute('role','status');$(publicListPage?'public-list-status':'status').after(status);}
  status.hidden=!message;status.textContent=message;
}
function linkedSourceFailed(exchange){
  const failed={Binance:periodReturnsFailed||state.binanceReadFailed,OKX:okxReturnsFailed,Bitget:bitgetReturnsFailed,Hyperliquid:state.lastReadFailed};
  return Object.hasOwn(failed,exchange)?failed[exchange]:Object.values(failed).some(Boolean);
}
function openLinkedAccount(finalRead=false) {
  if(!linkedAccount)return false;
  // The URL can select only an already validated public account. It cannot
  // supply a profile, external destination or a new account to fetch.
  const selected=linkedExchange(),match=r=>r&&r.accountId===linkedAccount&&(!['OKX','Bitget','Binance','Hyperliquid'].includes(selected)||r.exchange===selected);
  const row=state.rows.find(r=>(isPublicAccount(r)||isBinanceTrader(r)||isPublicLead(r))&&match(r))||[publicFocus.record,mk4Research].find(match);
  if(!row){
    if(finalRead){
      if(linkedSourceFailed(selected))linkedStatus('账户资料暂未读到。可点击刷新重试，读取成功后会打开详情。');
      else {linkedStatus('在已核实的公开账户中没有找到这个账户。');linkedAccount=null;}
    }
    return false;
  }
  linkedAccount=null;linkedStatus('');
  const params=new URL(location.href).searchParams,period=params.get('detailPeriod'),view=params.get('view');
  openDetail(row,periods.includes(period)?period:$('period').value,view);
  return true;
}
function saveURL(replace=false,filterChanged=false) {
  const url=new URL(location.href);
  if(publicListPage){
    if(filterChanged){for(const key of ['account','view','detailExchange','detailPeriod'])url.searchParams.delete(key);linkedAccount=null;linkedStatus('');}
    writePublicFilters(url);
  }else{
    for(const id of controls)url.searchParams.set(id,$(id).value);
    writeListQuery(url);
  }
  if(url.href!==location.href)history[replace?'replaceState':'pushState'](replace?history.state:null,'',url.pathname+url.search+url.hash);
}
function choosePeriod() {
  if(publicListPage||state.explicitPeriod)return;
  const available=periods.filter(p=>state.rows.some(r=>hasMetrics(r.windows[p])));
  if(available.length && !available.includes($('period').value))$('period').value=available.includes('90D')?'90D':available[0];
}
const publicPlatforms=['Hyperliquid','Binance','OKX','Bitget'];
const notProvided='该来源未提供';
let publicReadAt=null,publicRefreshMessage='正在读取本站已发布快照…',publicWorkflow=null;
function publicReadFailures(){
  return {Hyperliquid:state.lastReadFailed,Binance:state.binanceReadFailed||periodReturnsFailed,OKX:okxReturnsFailed,Bitget:bitgetReturnsFailed};
}
function latestPublicDate(values){
  const latest=Math.max(0,...values.map(value=>Date.parse(value)||0));
  return latest?new Date(latest).toISOString():null;
}
function publicSnapshotVersion(){
  return JSON.stringify([state.feedText,state.binanceCollection?.generatedAt,periodReturns?.generatedAt,
    okxReturns?.generatedAt,bitgetReturns?.generatedAt,state.portfolioCacheGeneratedAt,state.winCacheGeneratedAt]);
}
async function readPublicWorkflow(){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
  try {
    const response=await fetch('refresh-health.json',{cache:'no-store',credentials:'omit',signal:controller.signal});
    if(!response.ok)throw Error('workflow status unavailable');
    const data=await response.json();
    publicWorkflow=data?.schemaVersion===1&&data.platforms&&Number.isFinite(Date.parse(data.recordedAt))?data:null;
  }catch{publicWorkflow=null;}
  finally{clearTimeout(timeout);}
}
function renderPublicUpdate(rows,failures){
  const list=$('public-platform-status');
  const outcomes={success:'流程已完成',failure:'流程失败',cancelled:'流程取消',skipped:'本轮未采集',stopped:'采集暂停'};
  const hl=state.source, binance=state.binanceCollection?.source;
  list.replaceChildren(...publicPlatforms.map(platform=>{
    const accounts=rows.filter(row=>row.exchange===platform);
    const records=platform==='Hyperliquid'?[]:accounts.flatMap(row=>periods.map(period=>publicPerformance(row,period)).filter(Boolean));
    const source=platform==='Hyperliquid'?hl?.snapshotAt:latestPublicDate(records.map(w=>w.sourceAsOf));
    const collected=platform==='Hyperliquid'?hl?.fetchedAt:latestPublicDate(records.map(w=>w.lastSuccessAt));
    const attempt=platform==='Hyperliquid'?hl?.lastAttemptAt:latestPublicDate(records.map(w=>w.lastAttemptAt));
    const current=records.some(w=>Number.isFinite(w.roi)&&w.status==='ready');
    const stale=platform==='Hyperliquid'?sourceIsStale():!current;
    const run=publicWorkflow?.platforms?.[platform];
    const status=failures[platform]?(accounts.length?'读取失败，保留历史资料':'读取失败，暂无资料'):
      !accounts.length?'暂无可展示资料':stale?'历史快照，待更新':'快照未超过来源有效期';
    const stopped=platform==='Binance'&&binance?.refreshStopped;
    const runStatus=stopped?'仓位采集已暂停'+(binance.errorCode==='http_403'?'（来源拒绝 403）':''):
      outcomes[run?.outcome]||'后台执行无可核验记录';
    const item=node('li');
    item.append(node('strong',platform+' · '+status),node('div',[
      source?'来源快照 '+timeLabel(source):'来源快照时间未提供',
      collected?'最近已知采集 '+timeLabel(collected):'采集时间未提供',
      attempt?'快照记录的最近采集尝试 '+timeLabel(attempt):null,
      runStatus,
      Number.isFinite(Date.parse(run?.lastCompletedAt))?'最近流程完成 '+timeLabel(run.lastCompletedAt):null
    ].filter(Boolean).join(' · ')));
    return item;
  }));
  $('public-refresh-result').textContent=publicRefreshMessage+(publicReadAt?' · 本站检查 '+timeLabel(publicReadAt)+'（北京时间）':'');
  $('public-workflow-note').textContent=publicWorkflow?'后台状态记录生成于 '+timeLabel(publicWorkflow.recordedAt)+'（北京时间）。流程完成与资料更新分别记录。':
    '本站未取得后台采集任务记录。下列时间来自已发布快照，用于核对资料时效。';
}
function publicPerformance(row,period){
  if(isPublicLead(row))return leadPeriod(row,period);
  if(isBinanceTrader(row))return binancePerformance(row,period);
  return performanceWindow(row,period);
}
function publicCardData(row,period){
  const record=publicPerformance(row,period),history=portfolioSection(row,period);
  const sample=history?.status==='ready'?history.windows[period]:null;
  return {row,record,history,sample,sampleMdd:sampledDrawdown(sample,period),wins:cachedWin(row),
    currency:record?.currency||row.currency};
}
function publicRankValue(entry,sort,platform){
  const {record,sample,sampleMdd,wins}=entry;
  if(sort==='winRate'&&platform==='Hyperliquid')return wins?.win?.value;
  if(sort==='mdd'&&platform==='Hyperliquid')return sample?.coverageStatus==='insufficient_history'?null:sampleMdd;
  if(!record||record.fullPeriod===false||(record.derived&&record.coverageStatus!=='full'))return null;
  return record[sort];
}
function publicRank(entries,sort,platform){
  if(sort==='directory')return entries;
  const ranked=entries.map(entry=>({...entry,rank:publicRankValue(entry,sort,platform)}));
  return ranked.sort((a,b)=>{
    const validA=Number.isFinite(a.rank),validB=Number.isFinite(b.rank);
    if(!validA||!validB)return Number(validB)-Number(validA);
    if(sort==='pnl'&&a.currency!==b.currency)return a.currency.localeCompare(b.currency);
    if(Boolean(a.record?.derived)!==Boolean(b.record?.derived))return Number(Boolean(a.record?.derived))-Number(Boolean(b.record?.derived));
    return sort==='mdd'?a.rank-b.rank:b.rank-a.rank;
  });
}
function publicAccountMatches(row,terms){
  const id=row.accountId||'', name=(row.name||'').toLowerCase();
  const platform=(row.exchange==='Binance'?'binance 币安':row.exchange).toLowerCase();
  return terms.every(term=>name.includes(term)||id.toLowerCase().includes(term)||platform.includes(term));
}
function okxPeriodGap(row,period){
  const days=globalThis.BooksOKXPeriodData?.days;
  if(row.exchange!=='OKX'||!days)return null;
  if(!Object.hasOwn(days,period))return {summary:'OKX 不提供此周期',curve:'来源无此周期曲线'};
  const age=leadRecord(row)?.leadDays;
  return Number.isSafeInteger(age)&&age<days[period]?
    {summary:`采集时已带单 ${age} 天，未满 ${days[period]} 天`,curve:'未覆盖完整周期'}:null;
}
function binanceCollectionPaused(row){
  return publicWorkflow?.platforms?.Binance?.outcome==='stopped'||
    state.binanceCollection?.source?.refreshStopped===true||
    row.binanceBatchSource?.refreshStopped===true;
}
function publicDetailLink(row,period,label,style){
  const link=node('a',label,style);
  link.href=detailURL(row,period).href;
  link.addEventListener('click',event=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();
    globalThis.history.pushState({...globalThis.history.state,booksDetail:true},'',link.href);
    openDetail(row,period);
  });
  return link;
}
function hyperliquidSnapshotReason(entry,fallback){
  return ({batch_timeout:'采集批次超时',rate_limited:'来源限流',http_429:'来源限流',http_403:'来源拒绝读取',request_timeout:'来源读取超时'})[entry?.errorCode]||fallback;
}
function publicListCard(entry,period,failed){
  const {row,record,history,sample,sampleMdd,wins,currency}=entry;
  const lead=isPublicLead(row),binance=isBinanceTrader(row),publicAccount=isPublicAccount(row);
  const periodText=periodLabel(period),sampleWin=wins?.win,derived=publicAccount&&derivedPeriods.includes(period);
  const card=node('article',undefined,'public-trader-card');
  card.setAttribute('data-public-card',row.id);
  const identity=node('div',undefined,'public-identity'),name=node('h3',row.name),heading=node('div');
  name.title=row.accountId||row.name;
  if(row.accountId){name.textContent='';name.append(publicDetailLink(row,period,row.name,'public-detail-trigger'));}
  heading.append(name,node('p',row.exchange,'public-trader-source'));
  identity.append(avatar(row),heading);card.append(identity);
  const performance=node('div',undefined,'public-performance'),result=node('div',undefined,'public-return');
  const roi=Number.isFinite(record?.roi)?signedValue(record.roi,pct(record.roi)):'—';
  result.append(node('span',`${periodText} ${derived?'采样收益率':'来源收益率'}`,'public-return-label'),
    node('strong',roi,'public-return-value '+(roi==='—'?'public-missing':directionClass(record.roi))));
  if(record?.fullPeriod===false&&(roi!=='—'||Number.isFinite(record?.pnl)))result.append(node('small','周期覆盖不足或待核验','public-sample-range'));
  const okxGap=!record?okxPeriodGap(row,period):null;
  if(roi==='—'&&!Number.isFinite(record?.pnl)){
    result.append(node('small',failed?'业绩快照读取失败':okxGap?.summary||'该周期暂无业绩','public-sample-range'));
    if(okxGap&&row.accountId&&!failed){
      const requestedDays=period==='ALL'?Infinity:Number.parseInt(period,10);
      const fallback=['365D','90D','30D','7D'].find(candidate=>
        Number.parseInt(candidate,10)<requestedDays&&Number.isFinite(publicPerformance(row,candidate)?.roi));
      if(fallback)result.append(publicDetailLink(row,fallback,'查看 '+fallback,'public-sample-range'));
    }
  }
  performance.append(result);card.append(performance);

  const explanations=node('details',undefined,'public-sample-status');
  explanations.append(node('summary','数据说明'));
  explanations.append(node('p','来源收益率沿用平台公布的数值。原始快照缺少期初权益、收益率分母或资金流明细时，本站无法独立复算。'));
  const evidenceUrl=record?.sourceUrl||row.sourceUrl;
  if(evidenceUrl){
    try {
      const url=new URL(evidenceUrl);
      if(url.protocol==='https:'&&!url.username&&!url.password){
        const link=node('a','查看来源');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';explanations.append(link);
      }
    }catch{}
  }

  const metrics=node('dl',undefined,'public-metrics');
  const appendMetric=(label,value)=>{
    const item=node('div');item.append(node('dt',label),node('dd',value));metrics.append(item);
  };
  if(Number.isFinite(record?.pnl))appendMetric(record.derived?'采样盈亏':'来源盈亏',signedValue(record.pnl,money(record.pnl,currency))+' '+currency);
  if(Number.isFinite(record?.mdd)&&!record.derived)appendMetric('来源回撤',pct(record.mdd));
  if(Number.isFinite(sampleMdd))appendMetric('采样回撤',pct(sampleMdd));
  if(Number.isFinite(record?.winRate))appendMetric('来源胜率',pct(record.winRate));
  if(Number.isFinite(sampleWin?.value))appendMetric('片段胜率',pct(sampleWin.value));
  if(metrics.children.length)card.append(metrics);

  const graph=node('figure',undefined,'public-history'),plot=node('div',undefined,'public-curve-plot');
  let missingCurve=failed?'快照读取失败':okxGap?.curve||'暂无该周期曲线';
  if(sample?.points?.length>1){
    graph.append(node('figcaption','盈亏采样 · USD'),chart({curve:sample.points},'pnl'));
    explanations.append(node('p',`盈亏采样 ${timeLabel(sample.startAt)} 至 ${timeLabel(sample.endAt)} · ${sample.sampleCount} 点 · 末点 ${money(sample.points.at(-1).value,'USD')} USD。曲线以首个采样点为基准，和来源周期盈亏的统计范围、截止时间可能不同。`));
    explanations.append(node('p',`盈亏采集 ${timeLabel(history.fetchedAt)}${state.portfolioCacheReadFailed?' · 本次读取失败，保留上次有效值':history.stale?' · 历史采样，待更新':''}`));
    if(sample.coverageStatus==='insufficient_history'||sample.coverageStatus==='sampled_boundary')explanations.append(node('p','采样未覆盖完整请求周期，详见实际起止时间。'));
  }else if(lead&&row.exchange==='OKX'&&record?.evidencePath){
    graph.append(node('figcaption','累计收益率 · 日采样'),plot);renderOKXCardCurve(plot,record);
  }else if(lead&&record?.curve?.length>1){
    graph.append(node('figcaption','来源日收益率'),chart({curve:record.curve}));
    explanations.append(node('p',`曲线采样 ${historyDate(record.curve[0].time)} 至 ${historyDate(record.curve.at(-1).time)}`));
  }else if(binance){
    const view=binanceChart(row,period);
    if(!failed&&view.periodSupported===false)missingCurve='该周期曲线未接入';
    if(!failed&&binanceCollectionPaused(row))missingCurve='来源采集暂停，此周期曲线未取得';
    if(view.status==='restricted')missingCurve='曲线未公开';
    if(view.points?.length>1){
      graph.append(node('figcaption','盈亏采样 · USDT'),binanceChartArea(row,period));
      explanations.append(node('p',binanceChartCaption(view)));
    }
  }
  if(!graph.children.length){
    if(publicAccount){
      const cached=state.portfolioCache[row.accountId];
      missingCurve=cached?hyperliquidSnapshotReason(cached,'暂无该周期有效曲线'):'曲线快照尚未覆盖此账户';
      if(state.portfolioCacheLoading)missingCurve='读取曲线…';
    }
    if(publicAccount&&state.portfolioCacheReadFailed)missingCurve='曲线快照读取失败';
    graph.append(node('figcaption','业绩曲线'),node('p',missingCurve,'public-curve-empty'));
  }
  performance.append(graph);
  if(publicAccount){
    const drawdownNote=sampleMdd===null&&state.portfolioCacheReadFailed?'曲线快照读取失败，采样回撤暂缺。':drawdownDescription(sample,period);
    explanations.append(node('p',drawdownNote));
    explanations.append(node('p',winCacheDescription(row)+(state.winCacheReadFailed?' · 本次成交快照读取失败':'')));
    if(derived)explanations.append(node('p',periodROIDescription(record)));
  }
  const days=lead?leadRecord(row)?.leadDays:binance?record?.accountAgeDays:null;
  const range=Number.isFinite(record?.beginTs)&&Number.isFinite(record?.endTs)?`${timeLabel(record.beginTs)} 至 ${timeLabel(record.endTs)}`:null;
  const missing=[!Number.isFinite(record?.mdd)&&'来源最大回撤',!publicAccount&&!Number.isFinite(record?.winRate)&&'来源胜率',!Number.isFinite(days)&&'带单天数',!range&&'来源业绩统计区间'].filter(Boolean);
  if(Number.isFinite(days))explanations.append(node('p',`带单 ${days} 天`));
  if(range)explanations.append(node('p','来源业绩统计区间 '+range));
  if(missing.length)explanations.append(node('p',missing.join('、')+' · '+(record?notProvided:'该周期暂无资料')));
  const collected=record?.lastSuccessAt||(record?.asOfType==='observed'?record.asOf:null)||(publicAccount?state.source?.fetchedAt:null);
  const sourceTime=record?.sourceAsOf||(record?.asOfType==='source'?record.asOf:null);
  const dated=sourceTime||collected;
  const stale=record?.status==='stale'||(publicAccount&&sourceIsStale());
  const status=failed?'读取失败':stale?'历史快照':dated?'公开快照':okxGap?'所选周期无快照':'时间未提供';
  const times=[sourceTime&&`来源时间 ${timeLabel(sourceTime)}`,collected&&`采集时间 ${timeLabel(collected)}`].filter(Boolean);
  if(times.length)explanations.append(node('p',times.join(' · ')+'（北京时间）'));
  if(failed)explanations.append(node('p',dated?'本次快照读取失败，保留上次有效资料。':'本次快照读取失败，暂无已核验表现。'));
  const footer=node('footer',undefined,'public-card-footer');
  footer.append(node('p',status+(dated?' · '+new Date(dated).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'}):''),'public-trader-status'),explanations);
  card.append(footer);
  return card;
}
function renderPublicList(){
  const failures=publicReadFailures();
  const directory=state.rows.filter(row=>!row._local&&!row.paid&&publicPlatforms.includes(row.exchange));
  const platform=$('exchange').value,period=$('period').value,sort=$('sort').value;
  const terms=$('search').value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches=directory.filter(row=>(platform==='all'||row.exchange===platform)&&publicAccountMatches(row,terms));
  const rows=publicRank(matches.map(row=>publicCardData(row,period)),sort,platform);
  const pages=Math.max(1,Math.ceil(rows.length/12));
  if(!state.loading)state.page=Math.max(1,Math.min(state.page,pages));
  const visible=rows.slice((state.page-1)*12,state.page*12);
  const leaders=$('leaders'),expanded=new Set(),active=document.activeElement;
  let focusedCard=null,focusTarget=null;
  for(const details of leaders.querySelectorAll('.public-sample-status')){
    const id=details.closest('[data-public-card]').getAttribute('data-public-card');
    if(details.open)expanded.add(id);
    if(details.contains(active)){focusedCard=id;focusTarget=active.tagName.toLowerCase();}
  }
  leaders.replaceChildren(...visible.map(entry=>publicListCard(entry,period,failures[entry.row.exchange])));
  for(const details of leaders.querySelectorAll('.public-sample-status')){
    const id=details.closest('[data-public-card]').getAttribute('data-public-card');
    details.open=expanded.has(id);
    if(id===focusedCard)(details.querySelector(focusTarget)||details.querySelector('summary')).focus({preventScroll:true});
  }
  const sampledRisk=platform==='Hyperliquid';
  for(const option of $('sort').options){
    if(option.value==='mdd')option.textContent=sampledRisk?'采样回撤 ↑':'来源回撤 ↑';
    if(option.value==='winRate')option.textContent=sampledRisk?'片段胜率 ↓':'来源胜率 ↓';
  }
  const note=sort==='pnl'&&platform==='all'?'盈亏按币种分别排序。':sort==='winRate'&&sampledRisk?'片段胜率按独立成交样本排序。':'';
  $('public-sort-note').textContent=note;$('public-sort-note').hidden=!note;
  const failed=publicPlatforms.filter(key=>failures[key]);
  if(state.portfolioCacheReadFailed)failed.push('Hyperliquid 曲线');
  if(state.winCacheReadFailed)failed.push('Hyperliquid 成交样本');
  const listStatus=$('public-list-status');
  const message=failed.length?`${failed.join('、')}快照读取失败。${directory.length?'显示已读资料。':'暂无可用快照。'}`:
    !directory.length?(state.loading?'正在读取公开快照…':'暂无公开快照。'):'';
  listStatus.textContent=message;listStatus.hidden=!message;
  if(directory.length&&!rows.length&&!state.loading)empty(leaders,'没有匹配的账户','试试其他昵称、账户 ID 或平台。');
  renderPublicUpdate(directory,failures);
  $('count').textContent=terms.length||platform!=='all'?`${rows.length} / ${directory.length} 个账户`:`${rows.length} 个公开账户`;
  $('page').textContent=rows.length?`${state.page} / ${pages}`:'0 / 0';
  $('public-pagination').hidden=pages===1;
  $('prev').disabled=state.loading||state.page<=1;
  $('next').disabled=state.loading||state.page>=pages;
}
function render() {
  if(publicListPage){renderPublicList();return;}
  renderPublicFocus();
  const q=$('search').value.trim().toLocaleLowerCase(),p=$('period').value,source=$('source').value,currency=$('currency').value;
  const platform=$('exchange').value;
  const selectionNote=$('bitget-selection');
  if(selectionNote){selectionNote.hidden=platform!=='Bitget';selectionNote.textContent=bitgetReturns?.selection||'Bitget 筛选资料暂不可用';}
  const available=state.rows.filter(r=>(source==='local'?r._local:!r._local)&&(platform==='all'||r.exchange===platform));
  let rows=available.filter(r=>(r.name+' '+r.id+' '+r.accountId+' '+r.exchange+' '+r.note).toLocaleLowerCase().includes(q) && (source==='all'||source==='local'&&r._local||source==='paid'&&r.paid||source==='public'&&!r._local&&!r.paid) && (currency==='all'||r.currency===currency));
  const winSortOption=[...$('sort').options].find(option=>option.value==='winRate');if(winSortOption)winSortOption.textContent=source==='local'?'逐笔胜率 ↓':platform==='Hyperliquid'?'平仓片段胜率 ↓':platform==='Binance'?'已平仓仓位胜率 ↓':'胜率 ↓';
  const mddSortOption=[...$('sort').options].find(option=>option.value==='mdd');if(mddSortOption)mddSortOption.textContent=source==='local'?'最大回撤 ↑':platform==='Hyperliquid'?'采样盈亏回撤 ↑':platform==='Binance'?'币安来源回撤 ↑':'来源回撤 ↑';
  $('sort-hint').textContent=$('sort').value==='winRate'?(source==='local'?'按已记录逐笔胜率排序 · 缺数账户排在后面':platform==='Hyperliquid'?'按近期永续平仓片段胜率排序 · 缺数账户排在后面':'按各平台来源胜率排序 · 口径见卡片 · 缺数账户排在后面'):$('sort').value==='mdd'?($('source').value==='local'?'按已记录最大回撤排序 · 缺数账户排在后面':platform==='Hyperliquid'?'按采样盈亏回撤排序 · 缺数账户排在后面':'按各平台来源回撤排序 · 口径见卡片 · 缺数账户排在后面'):'历史资料按原时间展示 · 当前持仓须在核验有效期内';
  const sort=$('sort').value,grouped=sort==='pnl'&&currency==='all'&&new Set(rows.map(r=>r.currency)).size>1;
  if(sort==='roi'&&source!=='local'){
    $('sort-hint').textContent=q?'搜索匹配账户；缺少所选周期收益率的资料保留在后，不计入收益率排名。':'按已核实的同期收益率排序，缺数及覆盖不足的账户列在其后。';
  }
  rows.sort((a,b)=>{
    if(sort==='directory')return 0;
    if(grouped&&a.currency!==b.currency)return currencies.indexOf(a.currency)-currencies.indexOf(b.currency);
    const va=sortValue(a,p,sort),vb=sortValue(b,p,sort);
    if(va==null&&vb==null)return a.id.localeCompare(b.id);if(va==null)return 1;if(vb==null)return -1;
    return (sort==='mdd'?va-vb:vb-va)||a.id.localeCompare(b.id);
  });
  if(sort==='directory')rows=mixPlatforms(rows);
  const pages=Math.max(1,Math.ceil(rows.length/12));if(state.revealId){const at=rows.findIndex(r=>r.id===state.revealId);if(at>=0)state.page=Math.floor(at/12)+1;state.revealId=null;}if(!state.loading)state.page=Math.max(1,Math.min(state.page,pages));
  state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='card');
  const visibleRows=rows.slice((state.page-1)*12,state.page*12);
  state.cardControls=[];$('leaders').replaceChildren();for(const r of visibleRows)$('leaders').append(card(r,p));
  if(!rows.length) {
    if(source==='local')empty($('leaders'),available.length?'没有符合条件的资料':'暂无本机资料',available.length?'调整筛选条件，查看其他记录。':'已保存的个人资料仅在这里显示。');
    else if(!available.length&&state.source)empty($('leaders'),'暂无有效持仓账户',statusText());
    else empty($('leaders'),available.length?'没有符合条件的账户':'暂无持仓账户',available.length?'调整筛选条件，查看其他账户。':'取得有效持仓数据后显示账户。');
  }
  $('featured').replaceChildren();const featured=available.filter(r=>r.featured);$('featured-section').hidden=!featured.length;
  for(const r of featured) { const best=hasMetrics(r.windows.ALL)?'ALL':hasMetrics(r.windows[p])?p:periods.find(k=>hasMetrics(r.windows[k]))||p; $('featured').append(card(r,best)); }
  const scoped=state.rows.filter(r=>!r._local&&(!platform||platform==='all'||r.exchange===platform));
  const leadPlatform=platform==='OKX'||platform==='Bitget';
  $('total-count').textContent=scoped.length;
  $('current-count-label').textContent=leadPlatform?'有可见持仓快照':'有效持仓账户';
  $('current-count').textContent=scoped.filter(r=>leadPlatform?Boolean(r.activity?.positions?.rows?.length):currentHolding(r)).length;
  $('coverage-count').textContent=scoped.filter(r=>isPublicLead(r)?['30D','90D','365D'].some(p=>Number.isFinite(leadPeriod(r,p)?.roi)):isBinanceTrader(r)?hasBinancePerformance(r):Object.values(r.windows).some(hasMetrics)).length;
  $('local-count').textContent=state.localRows.length;
  for(const [id,exchange,label]of [['platform-all','all','全部平台'],['platform-hl','Hyperliquid','Hyperliquid'],['platform-binance','Binance','币安'],['platform-okx','OKX','OKX'],['platform-bitget','Bitget','Bitget']]){if(!$(id))continue;const n=state.rows.filter(r=>!r._local&&(exchange==='all'||r.exchange===exchange)).length;$(id).textContent=label+' '+n;$(id).setAttribute('aria-pressed',String($('exchange').value===exchange));}
  $('count').textContent=`${rows.length} 个研究账户${available.length!==rows.length?' · 共 '+available.length+' 个':''}${grouped?' · 按币种分组':''}`;
  $('page').textContent=rows.length?`${state.page} / ${pages}`:'0 / 0';
  $('public-pagination').hidden=pages===1;$('prev').disabled=state.loading||!rows.length||state.page===1;$('next').disabled=state.loading||!rows.length||state.page>=pages;
  // Retaining unranked accounts must not start new foreground source requests.
  const analyticsRows=sort==='roi'&&source!=='local'&&!q&&platform!=='Binance'?visibleRows.filter(r=>Number.isFinite(sortValue(r,p,'roi'))):visibleRows;
  startVisibleAnalytics(analyticsRows);
}
function statusText(summary=positionSummary()) {
  const v=state.source?.positionVerification,expired=summary.expired||summary.batchExpired;
  const retained=expired&&!summary.eligible?'上次持仓核验已过期，当前仓位未知。':summary.eligible?'仍显示有效期内的上次核验结果。':'当前仓位未知。';
  if(state.lastReadFailed)return '快照读取失败 · '+retained;
  if(state.source&&state.source.status!=='ok')return '采集更新失败 · '+retained;
  if(expired&&!summary.eligible)return '上次持仓核验已过期，当前仓位未知。';
  if(summary.expired)return `部分持仓核验已过期，当前可看 ${summary.eligible} 个持仓账户。`;
  if(state.source&&!summary.eligible) {
    if(!v||summary.pending)return '持仓尚未核验，公开账户暂不显示。';
    if(v.failedAccounts)return `上次持仓核验有 ${v.failedAccounts} 个账户读取失败；当前没有可展示的持仓账户。`;
    if(v.unattemptedAccounts)return `还有 ${v.unattemptedAccounts} 个账户待核验；当前没有可展示的持仓账户。`;
    if(summary.excluded)return '最近读取确认空仓的账户保留历史资料，等待新一轮核验。';
    return `本次核验没有可展示的持仓账户（已核验 ${v.emptyAccounts} 个空仓）。`;
  }
  if(state.publicRows.length&&sourceIsStale())return '快照待更新 · 以下为最近一次成功采集的数据';
  if(state.status==='error')return state.localRows.length?'公开资料暂不可用；我的资料仍可查看。':'公开资料暂不可用。';
  if(state.publicRows.length)return state.source?'已接入真实公开数据':`公开资料 ${state.publicRows.length} 个`;
  return state.localRows.length?'我的资料保存在当前浏览器。':'公开资料 0 个';
}
function updateView(message) { mergeRows();choosePeriod();render();renderSource();if(message)feedback(message); }
function renderDetailStatus() {
  const r=state.detail;let message='';
  if(isPublicFocus(r)){$('detail-data-status').textContent=state.tab==='live'?'公开重点关注 · 下方明细独立读取，不计入持仓排行榜':focusStatus();$('detail-data-status').hidden=false;return;}
  if(r&&detailLiveSnapshot&&detailLiveSnapshot.accountId===r.accountId){
    const {part,expiresAt}=detailLiveSnapshot,at=timeLabel(part.sourceTime)+'（北京）';
    message=Date.now()>expiresAt?'上次仓位快照已过期 · 来源 '+at:'默认永续市场 · 观测时 '+part.rows.length+' 个仓位 · 来源 '+at;
    $('detail-data-status').textContent=message;$('detail-data-status').hidden=false;return;
  }
  if(isPublicLead(r)){$('detail-data-status').hidden=true;return;}
  if(isBinanceTrader(r)&&lastAlphaPosition(r)&&!binanceView(r).observedAt){$('detail-data-status').hidden=true;return;}
  if(isBinanceTrader(r)){const view=binanceView(r);message=binanceStatus(view,r)+' · '+binanceTiming(view,r);$('detail-data-status').textContent=message;$('detail-data-status').hidden=false;return;}
  if(r&&isPublicAccount(r)) {
    if((state.positionExclusions[r.accountId]??-Infinity)>=Date.parse(r.positionCheck?.checkedAt||'1970-01-01T00:00:00Z'))message=Date.now()-state.positionExclusions[r.accountId]>3600000?'上次空仓核验已过期，当前仓位未知；保留历史资料，等待新一轮核验。':'最近读取确认空仓；保留历史资料。';
    else if(!qualifiedPosition(r))message='持仓核验已过期或尚未完成，当前仓位未知；历史表现仍可查看。';
    else if(!state.publicRows.some(item=>item.id===r.id))message='该账户已不在本次收录范围，详情保留上次验证的记录。';
    else if(sourceIsStale())message='此处显示上次验证的快照，最新数据暂未取得。';
  }
  if(message&&state.tab==='live'&&qualifiedPosition(r))message='排行快照待更新；下方账户明细独立读取。';
  $('detail-data-status').textContent=message;$('detail-data-status').hidden=!message;
}
function canReadLive(r) {return !!r&&(isPublicAccount(r)||isPublicFocus(r)||r===mk4Research)&&r.exchange==='Hyperliquid'&&/^0x[0-9a-f]{40}$/.test(r.accountId);}
function stopLive() {
  state.liveVersion++;const client=state.liveClient;state.liveClient=null;state.liveUser=null;state.liveData=null;state.liveView=null;
  if(client)client.stop();
}
function liveTime(stamp) {return stamp==null||!Number.isFinite(new Date(stamp).getTime())?'—':timeLabel(stamp);}
function liveDirection(direction) {return ({'Open Long':'买入 · 开仓或加多','Close Long':'卖出 · 减仓或平多','Open Short':'卖出 · 开仓或加空','Close Short':'买入 · 减仓或平空','Long > Short':'多转空','Short > Long':'空转多','Buy':'买入','Sell':'卖出'})[direction]||direction||'—';}
function liveOrderStatus(status) {return ({open:'挂单中',filled:'已成交',canceled:'已撤销',triggered:'已触发',rejected:'已拒绝',marginCanceled:'保证金原因撤销',vaultWithdrawalCanceled:'金库提取导致撤销',openInterestCapCanceled:'持仓限额撤销',selfTradeCanceled:'自成交保护撤销',reduceOnlyCanceled:'只减仓限制撤销',siblingFilledCanceled:'关联订单成交后撤销',delistedCanceled:'下架撤销'})[status]||status||'—';}
function liveCoin(coin,data) {const symbol=data.symbols?.spot?.[coin];return symbol?`${symbol.label} (${coin})`:coin;}
function liveAmount(amount,coin,data) {const quote=data.symbols?.spot?.[coin]?.quote;return value(amount)+(quote?' '+quote:'');}
function livePnl(amount,coin,data) {const quote=data.symbols?.spot?.[coin]?.quote;if(quote)return value(amount)+' '+quote;if(!coin.includes(':')&&!coin.startsWith('@')&&!coin.includes('/'))return value(amount)+' USDC';return value(amount);}
function liveSide(side) {return ({buy:'买',sell:'卖',long:'多',short:'空',both:'净持仓'})[side]||'—';}
function liveSection(title,columns) {
  const section=node('section',undefined,'live-section'),heading=node('div',undefined,'live-section-head'),status=node('p',undefined,'live-section-status'),count=node('span',undefined,'live-count'),wrap=node('div',undefined,'table-wrap live-table-wrap'),table=node('table'),thead=node('thead'),tr=node('tr'),tbody=node('tbody'),emptyMessage=node('p',undefined,'live-empty');
  heading.append(node('h3',title),count);for(const label of columns){const th=node('th',label);th.setAttribute('scope','col');tr.append(th);}thead.append(tr);table.append(thead,tbody);wrap.append(table);section.append(heading,status,emptyMessage,wrap);return {section,status,count,wrap,tbody,emptyMessage};
}
function buildLivePanel(r,b) {
  const focus=isPublicFocus(r);
  const root=node('div',undefined,'live-panel'),toolbar=node('div',undefined,'live-toolbar'),connection=node('p','正在连接…','live-connection'),retry=button('刷新连接',()=>state.liveClient?.refresh(),'live-refresh'),scope=node('p',focus?'Hyperliquid 官方实时数据 · 默认永续市场和 xyz 市场分别读取 · 其他市场未覆盖':'持仓、成交与订单事件实时推送 · 持仓与挂单每 60 秒对齐 · 持仓范围：永续主市场','live-scope'),gap=node('p',undefined,'live-gap');
  connection.setAttribute('role','status');connection.setAttribute('aria-live','polite');toolbar.append(connection,retry);root.append(toolbar,scope,gap);
  const sections={
    positions:liveSection(focus?'当前持仓 · 默认永续市场':'当前持仓',['品种','方向','数量','开仓均价（报价币）','仓位价值（报价币）','未实现盈亏（USDC）','杠杆']),
    orders:liveSection('当前挂单',['挂单时间','品种','买卖','限价','剩余数量','名义金额（报价币）','类型','只减仓']),
    fills:liveSection('最近成交',['成交时间','本页首次发现','品种','动作','买卖','成交价格','成交数量','成交额（报价币）','手续费','已实现盈亏（结算币）','订单 ID']),
    events:liveSection('订单事件',['事件时间','本页首次发现','品种','状态','买卖','限价','剩余数量','订单 ID'])
  };
  root.append(sections.positions.section);
  if(focus){
    sections.xyzPositions=liveSection('当前持仓 · xyz 市场',['品种','方向','数量','开仓均价（报价币）','仓位价值（报价币）','未实现盈亏（结算币）','杠杆']);
    root.append(sections.xyzPositions.section);
  }
  root.append(sections.orders.section);
  const more=node('details',undefined,'public-detail-context');
  more.append(node('summary','实时成交与订单变化'),sections.fills.section,sections.events.section);
  root.append(more);
  root.append(node('p','每行成交为一笔实际撮合，可能只是订单的一部分；当前最多显示最近 200 笔，非完整历史。主市场永续价格采用来源报价，盈亏以 USDC 记账；现货采用来源交易对报价币，@ 开头的品种保留现货代码。未确认的其他市场结算币不强行标注。仅在本面板打开且页面可见时连接，离开后不后台留存。','live-footnote'));
  b.append(root);state.liveView={root,connection,retry,gap,sections};state.liveUser=r.accountId;const version=++state.liveVersion;
  if(typeof BooksAccountLive==='undefined'){connection.textContent='实时数据模块暂未加载，请刷新页面。';retry.disabled=true;return;}
  try {
    state.liveClient=BooksAccountLive.create({visible:document.visibilityState!=='hidden',onChange:data=>{
      if(version!==state.liveVersion||state.tab!=='live'||state.detail?.accountId!==r.accountId||!state.liveView||data.address!==r.accountId)return;
      state.liveData=data;syncPublicFocusLive(r,data);observeEmptyPositions(r,data.positions);renderLiveData();
    }});
    state.liveClient.start(r.accountId);
  } catch {connection.textContent='实时连接暂不可用，可重新打开此面板。';}
}
function renderLiveData() {
  const data=state.liveData,view=state.liveView;if(!data||!view)return;
  if(state.detail&&canReadLive(state.detail)&&data.address===state.detail.accountId&&data.positions?.status==='ready')acceptDetailPositions(state.detail,data.positions);
  const c=data.connection||{},labels={idle:'准备连接',connecting:'正在连接实时流…',connected:'连接已建立，等待订阅确认…',live:'实时推送已连接',error:'实时连接中断',reconnecting:'正在重新连接…',paused:'页面不可见，更新已暂停',closed:'实时连接已关闭',blocked:'来源请求已停止'};
  view.connection.textContent=(labels[c.status]||'实时状态暂不可用')+(c.status==='blocked'?' · '+({snapshot_unverified:'等待同站停止记录核验',storage_unavailable:'无法保存停止记录'}[c.reason]||c.reason):'')+(c.lastMessageAt?' · 最近接收 '+liveTime(c.lastMessageAt):'');view.connection.setAttribute('data-state',c.status||'idle');
  view.retry.disabled=['connecting','reconnecting'].includes(c.status)||(c.status==='blocked'&&c.reason!=='snapshot_unverified');
  view.gap.textContent=c.gap?'重连或暂停期间可能有记录缺口；当前展示重新取得的近期记录，不代表完整历史。':'';view.gap.hidden=!c.gap;
  const emptyMessages={positions:'当前没有持仓（永续主市场）。',xyzPositions:'当前没有持仓（xyz 市场）。',orders:'当前没有未成交挂单。',fills:'来源未返回近期成交。',events:'连接期间尚未收到订单事件。'};
  for(const key of Object.keys(view.sections)) {
    const part=data[key]||{status:'idle',rows:[]},target=view.sections[key],rows=Array.isArray(part.rows)?part.rows:[];
    const position=key==='positions'||key==='xyzPositions',market=key==='xyzPositions'?'xyz 市场':'默认永续市场';
    const stamp=(part.sourceTime?' · 来源时间 '+liveTime(part.sourceTime):position&&part.status==='ready'&&part.fetchedAt?' · 来源时间未提供':'')+(part.fetchedAt?' · 读取于 '+liveTime(part.fetchedAt):'');
    target.status.textContent=part.status==='error'?'本项更新失败'+(rows.length?'，保留上次读取的记录。':'，尚未取得有效数据。')+stamp:part.status==='loading'?'正在读取'+(rows.length?'，暂显示上次记录。':'…'):part.status==='ready'?(key==='fills'?`最近 ${rows.length} 笔逐笔成交${part.receivedCount>rows.length?' · 来源本次返回 '+part.receivedCount+' 笔':''}`:key==='events'?`本次连接期间最近 ${rows.length} 条订单变化（最多保留 200 条）`:'已读取当前快照')+stamp:'等待来源数据…';
    const referenceTime=part.sourceTime??part.fetchedAt;
    const oldSource=referenceTime!=null&&Date.now()-referenceTime>positionSnapshotMaxAge;
    const stream=key==='xyzPositions'?data.xyzStream:data.defaultStream;
    const streamUncertain=position&&isPublicFocus(state.detail)&&(stream!=='live'||c.status!=='live');
    if(part.status==='ready'&&oldSource)target.status.textContent='来源快照较旧，暂保留已读取记录'+stamp;
    if(streamUncertain)target.status.textContent=market+'实时连接未确认，当前仓位未知'+(rows.length?'，保留上次记录':'')+stamp;
    target.status.setAttribute('data-state',part.status==='error'?'error':oldSource||streamUncertain?'stale':part.status);
    target.count.textContent=part.status==='ready'||rows.length?String(rows.length):'—';target.emptyMessage.hidden=rows.length>0;target.emptyMessage.textContent=streamUncertain?'实时连接未确认，当前仓位未知。':part.status==='ready'&&oldSource&&position?'历史快照为空，当前仓位未知。':part.status==='ready'&&oldSource&&key==='orders'?'历史挂单快照为空，当前挂单未知。':part.status==='ready'?emptyMessages[key]:part.status==='error'?'暂不可用':'正在读取…';target.wrap.hidden=!rows.length;target.tbody.replaceChildren();
    for(const row of rows) {
      let cells;
      if(position)cells=[liveCoin(row.coin,data),liveSide(row.side),value(row.quantity),value(row.entryPrice),value(row.positionValue),value(row.unrealizedPnl),row.leverage?`${value(row.leverage.value)}× ${row.leverage.type==='cross'?'全仓':row.leverage.type==='isolated'?'逐仓':row.leverage.type}`:'—'];
      if(key==='orders')cells=[liveTime(row.time),liveCoin(row.coin,data),liveSide(row.side),liveAmount(row.price,row.coin,data),value(row.quantity),liveAmount(row.notional,row.coin,data),row.orderType||'—',row.reduceOnly==null?'—':row.reduceOnly?'是':'否'];
      if(key==='fills')cells=[liveTime(row.time),liveTime(row.firstSeenAt),liveCoin(row.coin,data),row.positionAction||liveDirection(row.direction),liveSide(row.side),liveAmount(row.price,row.coin,data),value(row.quantity),liveAmount(row.notional,row.coin,data),row.fee==null?'—':value(row.fee)+' '+(row.feeToken||''),livePnl(row.closedPnl,row.coin,data),row.orderId??'—'];
      if(key==='events')cells=[liveTime(row.statusTime),liveTime(row.firstSeenAt),liveCoin(row.coin,data),liveOrderStatus(row.status),liveSide(row.side),liveAmount(row.price,row.coin,data),value(row.quantity),row.orderId??'—'];
      const tr=node('tr');for(const cell of cells)tr.append(node('td',String(cell??'—')));target.tbody.append(tr);
    }
  }
}
const activityTabs={analysis:'收益分析',positions:'历史仓位',live:'持仓快照',orders:'成交流水'};
const activityKeys={positions:'history',live:'positions',orders:'orders'};
function leadTabs(r){
  const tabs={analysis:activityTabs.analysis};
  for(const [tab,key] of Object.entries(activityKeys)){
    const part=r.activity?.[key];
    if(['ready','partial','stale'].includes(part?.status)&&part.rows?.length)tabs[tab]=activityTabs[tab];
  }
  return tabs;
}
const researchTabNames={analysis:'表现',live:'当前持仓',positions:'历史仓位',points:'交易点位',orders:'成交'};
function detailTabs(r){
  if(publicListPage&&(isPublicLead(r)||isBinanceTrader(r)||canReadLive(r)))return researchTabNames;
  if(isPublicLead(r))return leadTabs(r);
  if(r.periodOnly)return {analysis:researchTabNames.analysis};
  const active={analysis:researchTabNames.analysis};
  if(canReadLive(r)||isBinanceTrader(r)&&(binanceView(r).observedAt||hasAlphaPositionArchive(r)))active.live=researchTabNames.live;
  if(!canReadLive(r)||globalThis.BooksTradeAnalysis){
    for(const key of ['positions','points','orders'])active[key]=researchTabNames[key];
  }
  return active;
}
function paintDetailTabs(r){
  const available=detailTabs(r);
  if(!Object.hasOwn(available,state.tab))state.tab='analysis';
  $('tabs').querySelectorAll('[data-tab]').forEach(control=>{
    const key=control.dataset.tab,enabled=Object.hasOwn(available,key);
    control.hidden=false;control.disabled=!enabled;control.textContent=researchTabNames[key];
    control.setAttribute('aria-pressed',String(state.tab===key));
    control.title=enabled?'':researchTabNames[key]+'暂无可核实记录';
  });
}
function detailPeriod(r,period){return isPublicLead(r)?leadPeriod(r,period):binancePerformance(r,period);}
function evidenceLink(label,url){
  const a=node('a',label,'source-link');a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;
}
function leadActivityNote(r,key,part){
  if(!part){
    if(r.exchange==='OKX'&&okxTradesFailed)return '本站公开仓位档案读取失败';
    if(r.exchange==='OKX'&&!okxTrades&&state.okxArchiveRequest)return '正在读取本站公开仓位档案…';
    return '本站尚未取得该账户的公开交易记录';
  }
  const title=key==='positions'?'持仓快照':key==='history'?'历史仓位':'成交流水';
  const observed=part.rows?.length||0,hidden=part.hiddenCount||0;
  if(part.status==='restricted')return title+' · 策略保护，平台未公开仓位';
  if(part.status==='empty')return title+' · 本次查询未显示公开记录';
  if(part.status==='unavailable')return title+' · 官方数据暂不可读';
  if(part.status==='unsupported')return key==='orders'?'平台未提供逐笔成交流水':'';
  if(!observed&&hidden)return title+' · 来源隐藏了 '+hidden+' 条明细';
  const old=part.status==='stale'||(key==='positions'&&Date.now()-Date.parse(part.fetchedAt)>1800000);
  return title+' · '+observed+' 条公开记录'+(hidden?' · 另有 '+hidden+' 条隐藏明细':'')+(part.pagesFetched?' · 本轮读取 '+part.pagesFetched+' 页':'')+(part.truncated||part.hasMore?' · 平台还有更早记录':'')+(old?' · 上次观察，当前状态待更新':'');
}
function renderLeadActivity(r,b,key,part=r.activity?.[key],freshPublic=false){
  const current=key==='positions',orders=key==='orders';
  if(!part?.rows?.length){
    empty(b,activityTabs[orders?'orders':current?'live':'positions'],leadActivityNote(r,key,part)+(part?.fetchedAt?' · 采集 '+timeLabel(part.fetchedAt)+'（北京）':''));
    return;
  }
  const when=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):null;
  const columns=orders?['来源时间（北京）','合约','买卖','成交均价','数量','已实现盈亏']:
    ['合约','方向','开仓时间（北京）',current?'标记价':'平仓时间（北京）','开仓均价',...(current?[]:['平仓均价']),'数量','杠杆',current?'未实现盈亏':'已实现盈亏'];
  const more=current?[['marginMode','保证金模式'],['margin','保证金'],['notional','名义金额'],['pnlRatioPct','仓位收益率']]:
    [['marginMode','保证金模式'],['margin','保证金'],['pnlRatioPct','仓位收益率'],['grossPnl','毛盈亏'],['openFee','开仓手续费'],['closeFee','平仓手续费'],['fundingFee','资金费'],['stockDividend','股票分红']];
  const extra=orders?[]:more.filter(([field])=>part.rows.some(row=>row[field]!=null));
  columns.push(...extra.map(([,label])=>label));
  const note=leadActivityNote(r,key,part)+(part.fetchedAt?' · 采集于 '+when(part.fetchedAt)+'（北京）':'');
  const monetary=(value,unit)=>value==null?null:String(value)+(unit?' '+unit:'');
  const rows=part.rows.map(row=>{
    if(orders)return [when(row.time),row.symbol,liveSide(row.side),row.price,monetary(row.quantity,row.unit),monetary(row.realizedPnl,row.currency)];
    const direction=({long:'多',short:'空',net:'净持仓'})[row.side]||'—';
    return [row.symbol,direction,when(row.openedAt),current?row.markPrice:when(row.closedAt),row.entryPrice,...(current?[]:[row.exitPrice]),monetary(row.quantity,row.unit),row.leverage==null?null:row.leverage+'×',monetary(current?row.unrealizedPnl:row.realizedPnl,row.currency),...extra.map(([field])=>{
      if(field==='marginMode')return ({cross:'全仓',isolated:'逐仓'})[row.marginMode]||null;
      if(field==='pnlRatioPct')return row[field]==null?null:pct(row[field]);
      return monetary(row[field],row.currency);
    })];
  });
  if(current&&publicListPage){
    const list=node('section',undefined,'public-position-list');
    const precise=new Intl.NumberFormat('zh-CN',{maximumSignificantDigits:9});
    const cash=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4});
    for(const row of part.rows){
      const item=node('article',undefined,'public-position-item'),fields=node('dl');
      item.append(node('h3',row.symbol+' · '+(liveSide(row.side)==='—'?'净持仓':liveSide(row.side))));
      for(const [label,amount,formatter,unit] of [['数量',row.quantity,precise,row.unit],['开仓均价',row.entryPrice,precise],
        ['标记价',row.markPrice,precise],['浮动盈亏',row.unrealizedPnl,cash,row.currency],
        ['杠杆',row.leverage,precise,'×'],['开仓时间',when(row.openedAt)]]){
        if(amount==null)continue;
        const suffix=unit==='×'?'×':unit?' '+unit:'';
        const value=node('dd',(formatter?formatter.format(amount):String(amount))+suffix);
        if(formatter)value.title=String(amount)+suffix;
        const field=node('div');field.append(node('dt',label),value);fields.append(field);
      }
      item.append(fields);
      if(row.openedAt&&Number.isFinite(row.entryPrice)){
        item.append(button('查看开仓点',()=>{
          leadPointFocus={accountId:r.accountId,row:{...row,closedAt:null,exitPrice:null}};
          activateDetailTab('points');
        },'detail-button'));
      }
      list.append(item);
    }
    if(!freshPublic)b.append(node('p',note,'live-scope'));
    b.append(list);
  }else binanceTable(b,activityTabs[key==='history'?'positions':current?'live':'orders'],columns,rows,note);
  if(current&&r.exchange==='Bitget')b.append(node('p','Bitget 向非跟随者公开的仓位延迟约 1 小时。名义金额与浮动盈亏按有来源标记价的线性仓位计算。','detail-method'));
  if(key==='history')b.append(node('p','每条记录为平台汇总的已平仓仓位，数量和开平均价沿用来源字段。','detail-method'));
  const proofs=[...new Set([part.evidencePath,...part.rows.map(row=>row.evidencePath)].filter(Boolean))];
  const links=node('div',undefined,'lead-source-links');
  proofs.forEach((url,i)=>links.append(evidenceLink(proofs.length===1?'原始仓位记录':'原始记录 · 第 '+(i+1)+' 页',url)));
  if(part.sourceUrl)links.append(evidenceLink(r.exchange+' 官方记录 ↗',part.sourceUrl));
  b.append(links);
}
const leadCurveCache=new Map();
async function okxEvidenceCurve(part){
  if(leadCurveCache.has(part.evidencePath))return leadCurveCache.get(part.evidencePath);
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
  let raw;
  try {
    const response=await fetch(part.evidencePath,{credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok||Number(response.headers.get('content-length'))>524288)throw Error('curve_unavailable');
    raw=await response.arrayBuffer();
  }finally{clearTimeout(timeout);}
  if(raw.byteLength>524288)throw Error('curve_size');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(digest!==part.evidenceSha256)throw Error('curve_evidence');
  const reply=JSON.parse(new TextDecoder().decode(raw)),points=reply.data;
  if(reply.code!=='0'||!Array.isArray(points)||points.length!==part.pointCount)throw Error('curve_shape');
  const sorted=[...points].sort((a,b)=>Number(a.beginTs)-Number(b.beginTs));
  const curves={roi:[],pnl:[]};
  sorted.forEach((point,i)=>{
    const time=Number(point.beginTs);
    if(time!==part.beginTs+i*86400000||i===sorted.length-1&&time!==part.endTs)throw Error('curve_window');
    for(const [field,key,scale] of [['pnlRatio','roi',100],['pnl','pnl',1]]){
      if(typeof point[field]!=='string'||!point[field].trim()||!Number.isFinite(Number(point[field])))throw Error('curve_value');
      curves[key].push({time:new Date(time).toISOString(),value:Number(point[field])*scale});
    }
  });
  if(Math.abs(curves.roi.at(-1).value-part.roi)>1e-7||Math.abs(curves.pnl.at(-1).value-part.pnl)>1e-6)throw Error('curve_endpoint');
  leadCurveCache.set(part.evidencePath,curves);return curves;
}
function renderLeadCurve(r,b,part){
  if(!part||r.exchange!=='OKX'&&!part.curve?.length)return;
  const section=node('section',undefined,'lead-curve'),plot=node('div'),controls=node('div',undefined,'lead-metric-switch'),heading=node('h4',r.exchange==='OKX'?'累计收益率 · 日采样':'来源收益率曲线');
  controls.setAttribute('role','group');controls.setAttribute('aria-label','官方日线指标');section.append(heading,controls,plot);b.append(section);
  const draw=curves=>{
    function select(metric){
      const data=curves[metric];if(!data||data.length<2)return;
      const isPnl=metric==='pnl',unit=isPnl?(part.currency||r.currency):'%',latest=data.at(-1);
      heading.textContent=r.exchange==='OKX'?(isPnl?'累计盈亏 · 日采样':'累计收益率 · 日采样'):(isPnl?'来源盈亏曲线':'来源收益率曲线');
      const description=data[0].time.slice(0,10)+' 至 '+latest.time.slice(0,10)+' · '+data.length+' 个来源日点 · 单位 '+unit;
      plot.replaceChildren(chart({curve:data},isPnl?'pnl':'return',unit),node('small',description));
      if(part.curveEvidencePath||part.evidencePath)plot.append(evidenceLink('曲线凭证',part.curveEvidencePath||part.evidencePath));
      for(const entry of choices)entry.button.setAttribute('aria-pressed',String(entry.metric===metric));
    }
    const choices=[];
    for(const [metric,label] of [['roi','收益率'],['pnl','盈亏']]){
      if(!curves[metric]?.length)continue;
      const control=button(label,()=>select(metric));choices.push({metric,button:control});controls.append(control);
    }
    controls.hidden=choices.length<2;select('roi');
  };
  if(part.curve?.length){draw({roi:part.curve,pnl:part.pnlCurve});section.append(node('small','日线截止最近的来源日点，周期收益率取平台最新统计。'));return;}
  plot.textContent='正在读取已归档日线…';
  okxEvidenceCurve(part).then(draw,()=>{plot.textContent='日线暂不可读，可打开收益凭证核对。';});
}
function renderLeadCapital(r,b,period){
  const record=leadRecord(r),balance=record.balance,transfers=record.transfers;
  if(!balance&&!transfers)return;
  const section=node('section',undefined,'lead-capital');section.append(node('h4','组合资产与资金调拨'));b.append(section);
  if(balance&&Number.isFinite(balance.value)&&balance.currency){
    const line=node('p','组合净值 '+value(balance.value)+' '+balance.currency+' · 采集 '+timeLabel(balance.fetchedAt),'account-equity');
    if(balance.evidencePath)line.append(evidenceLink(' 净值凭证',balance.evidencePath));section.append(line);
  }
  if(!transfers)return;
  const end=Date.parse(transfers.fetchedAt),start=end-parseInt(period,10)*86400000;
  if(!Number.isFinite(start)||!Array.isArray(transfers.rows))return;
  const rows=transfers.rows.filter(x=>Date.parse(x.time)>=start&&Date.parse(x.time)<=end);
  const receipt=[...new Set([transfers.evidencePath,...rows.map(row=>row.evidencePath)].filter(Boolean))];
  const detail=node('details'),summary=node('summary','已归档的组合调拨 · 近 '+parseInt(period,10)+' 天 '+rows.length+' 条');detail.append(summary);
  const flags=transfers.truncated?' · 来源尚有更早记录':'';
  detail.append(node('p',r.exchange+' 站内资金调拨 · 采集 '+timeLabel(transfers.fetchedAt)+flags,'meta'));
  if(!rows.length)detail.append(node('p',['restricted','unavailable'].includes(transfers.status)?'平台未提供可核实的资金调拨明细。':'此窗口的已归档记录中未见调拨。','detail-method'));
  else{
    const sums=new Map();
    for(const row of rows){
      if(!['in','out'].includes(row.kind)||!Number.isFinite(row.amount)||!row.currency)continue;
      const total=sums.get(row.currency)||{in:0,out:0};total[row.kind]+=row.amount;sums.set(row.currency,total);
    }
    for(const [unit,total] of sums)detail.append(node('p','已见转入 '+value(total.in)+' '+unit+' · 已见转出 '+value(total.out)+' '+unit,'detail-method'));
    binanceTable(detail,'资金调拨明细',['时间（北京）','方向','金额','币种','转出账户','转入账户'],rows.map(x=>[timeLabel(x.time),x.kind==='in'?'转入':'转出',value(x.amount),x.currency,x.from,x.to]));
  }
  const links=node('div',undefined,'lead-source-links');receipt.forEach((url,i)=>links.append(evidenceLink('调拨凭证 '+(i+1),url)));
  if(transfers.sourceUrl)links.append(evidenceLink('交易所调拨记录 ↗',transfers.sourceUrl));detail.append(links);section.append(detail);
}
function renderLeadSample(r,b,period){
  const section=r.activity?.history,days=parseInt(period,10),end=Date.parse(section?.fetchedAt);
  if(!section?.rows?.length||!Number.isFinite(end)||!Number.isFinite(days))return;
  const start=end-days*86400000,rows=section.rows.filter(p=>{const at=Date.parse(p.closedAt);return at>=start&&at<=end;});
  const root=node('section',undefined,'lead-sample-analysis');root.append(node('h4','已平仓样本分析'));b.append(root);
  root.append(node('p',timeLabel(new Date(start))+' 至 '+timeLabel(new Date(end))+' · 按平仓时间 · 本站已归档 '+rows.length+' 条','detail-method'));
  if(!rows.length)return;
  const durations=rows.map(p=>Date.parse(p.closedAt)-Date.parse(p.openedAt)).filter(v=>Number.isFinite(v)&&v>=0);
  const figures=node('div',undefined,'lead-detail-metrics');
  function figure(label,count){const item=node('div');item.append(node('small',label),node('strong',count));figures.append(item);}
  const longs=rows.filter(p=>p.side==='long').length,shorts=rows.filter(p=>p.side==='short').length;
  figure('多仓 / 空仓样本',longs+' / '+shorts);
  if(durations.length){const hours=durations.reduce((sum,x)=>sum+x,0)/durations.length/3600000;figure('平均持仓时间 · '+durations.length+' 条',value(Math.round(hours*100)/100)+' 小时');}
  const outcomes=rows.filter(p=>Number.isFinite(p.realizedPnl));
  if(outcomes.length)figure('盈利 / 亏损 / 持平仓位',[outcomes.filter(p=>p.realizedPnl>0).length,outcomes.filter(p=>p.realizedPnl<0).length,outcomes.filter(p=>p.realizedPnl===0).length].join(' / '));
  const units=[...new Set(outcomes.map(p=>p.currency).filter(Boolean))];
  for(const unit of units){const total=outcomes.filter(p=>p.currency===unit).reduce((sum,p)=>sum+p.realizedPnl,0);figure('样本已实现盈亏 · '+unit,signedValue(total,money(total,unit)));}
  root.append(figures);
  const symbols=new Map();for(const p of rows)symbols.set(p.symbol,(symbols.get(p.symbol)||0)+1);
  const bar=node('div',undefined,'sample-contract-list');
  for(const [symbol,count]of [...symbols].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5)){
    const line=node('div'),scale=node('progress');scale.max=rows.length;scale.value=count;scale.setAttribute('aria-label',symbol+' 占归档样本 '+count+' / '+rows.length);line.append(node('small',symbol),scale,node('span',count+' 条'));bar.append(line);
  }
  root.append(node('h5','主要交易合约 · 按样本数'),bar);
}
let okxCurrent=null;
function stopOKXCurrent(){
  if(!okxCurrent)return;
  clearInterval(okxCurrent.timer);
  okxCurrent.controller?.abort();
  okxCurrent=null;
}
function okxCurrentContent(r,view){
  const {host,result,last,controller,retry}=view;
  const focused=document.activeElement===retry;
  host.replaceChildren();
  const toolbar=node('div',undefined,'live-toolbar');
  const status=node('p',result?.reason||(!result?'正在读取 OKX 公开持仓…':'OKX 官方公开持仓快照'),'live-connection');
  status.setAttribute('role','status');
  const next=button(controller?'读取中…':'刷新持仓',()=>readOKXCurrent(r,view),'live-refresh');
  next.disabled=!!controller||result?.reason?.includes('已暂停')===true;
  toolbar.append(status,next);host.append(toolbar);view.retry=next;
  if(focused&&!next.disabled)next.focus({preventScroll:true});
  if(result?.fetchedAt)host.append(node('p','官方 API · 最近读取 '+timeLabel(result.fetchedAt)+'（北京）'+
    (result.hiddenCount?' · 隐藏 '+result.hiddenCount+' 条':''),'live-scope'));
  if(result?.rows.length){renderLeadActivity(r,host,'positions',result,true);return;}
  if(!result||result.status==='unavailable'){
    const historical=last||r.activity?.positions;
    if(historical?.rows.length){
      host.append(node('p','以下为上次成功读取，当前仓位待核。','detail-method'));
      renderLeadActivity(r,host,'positions',{...historical,status:'stale'});
    }
    return;
  }
  empty(host,result.status==='restricted'?'持仓未公开':'未返回公开持仓',
    result.status==='restricted'?'部分账户会隐藏合约、数量或价格等字段。':'该查询只覆盖来源公开的跟单仓位。');
}
async function readOKXCurrent(r,view){
  if(view!==okxCurrent||view.controller||document.visibilityState==='hidden'||view.result?.reason?.includes('已暂停'))return;
  if(!globalThis.BooksOKXPublicPositions){
    view.result={status:'unavailable',rows:[],reason:'持仓读取模块暂未加载。'};okxCurrentContent(r,view);return;
  }
  const controller=new AbortController();view.controller=controller;okxCurrentContent(r,view);
  try{
    const result=await BooksOKXPublicPositions.read(r.accountId,{signal:controller.signal});
    if(view!==okxCurrent||controller.signal.aborted)return;
    view.result=result;
    if(result.status!=='unavailable')view.last=result.rows.length?result:null;
  }catch{if(view===okxCurrent&&!controller.signal.aborted)view.result={status:'unavailable',rows:[],reason:'OKX 公开仓位读取失败。'};}
  finally{
    if(view===okxCurrent){
      view.controller=null;
      okxCurrentContent(state.detail||r,view);
    }
  }
}
function renderOKXCurrent(r,b){
  if(okxCurrent?.accountId!==r.accountId){
    stopOKXCurrent();
    const view={accountId:r.accountId,host:node('div',undefined,'live-panel'),result:null,last:null,controller:null};
    okxCurrent=view;
    view.timer=setInterval(()=>readOKXCurrent(state.detail||r,view),45000);
    readOKXCurrent(r,view);
  }
  b.append(okxCurrent.host);okxCurrentContent(r,okxCurrent);
}
function clearLeadPointChart(){
  if(!leadPointPanel)return;
  leadPointPanel.chart?.destroy();
  leadPointPanel=null;
}
function leadPointTimes(row){
  const opened=Date.parse(row.openedAt),closed=row.closedAt?Date.parse(row.closedAt):null;
  if(!Number.isFinite(opened)||opened>Date.now()||closed!==null&&(!Number.isFinite(closed)||closed<opened||closed>Date.now()))return null;
  return {opened,closed};
}
function renderLeadPoints(r,b){
  const history=r.activity?.history;
  const focused=leadPointFocus?.accountId===r.accountId?leadPointFocus.row:null;
  const key=[r.id,history?.fetchedAt,history?.rows?.length,focused?.symbol,focused?.openedAt].join('|');
  if(leadPointPanel?.key===key&&leadPointPanel.root.isConnected)return;
  clearLeadPointChart();
  b.replaceChildren();
  const saved=history?.rows||[];
  const choices=[...(focused?[focused]:[]),...saved].filter(row=>leadPointTimes(row)&&
    ['long','short'].includes(row.side)&&Number.isFinite(row.entryPrice)&&row.entryPrice>0);
  if(!saved.length&&!choices.length){empty(b,'暂无可核验的开平仓价',leadActivityNote(r,'history',history));return;}
  const root=node('section',undefined,'trade-analysis');
  b.append(root);
  if(choices.length&&globalThis.BooksLeadPositionCandles&&globalThis.BooksTradeChart&&globalThis.LightweightCharts){
    const panel={root,key,chart:null,version:0};
    leadPointPanel=panel;
    const client=leadPointClient??=BooksLeadPositionCandles.create(globalThis);
    const filters=node('div',undefined,'ta-chart-tools');
    const symbol=node('select'),position=node('select'),interval=node('select');
    symbol.setAttribute('aria-label','选择交易合约');
    position.setAttribute('aria-label','选择仓位记录');
    interval.setAttribute('aria-label','K 线周期');
    const symbols=[...new Set(choices.map(row=>row.symbol))];
    for(const name of symbols){const o=node('option',name);o.value=name;symbol.append(o);}
    filters.append(symbol,position,interval);
    const note=node('p','开仓、平仓标记取自仓位汇总时间和均价，逐笔成交未公开。','detail-method');
    const area=node('div',undefined,'ta-replay-main'),toolbar=node('div',undefined,'ta-chart-tools');
    const chartRoot=node('div',undefined,'ta-chart'),playback=node('div',undefined,'ta-playback'),status=node('p',undefined,'detail-method');
    status.setAttribute('role','status');
    area.append(filters,note,toolbar,chartRoot,playback,status);root.append(area);
    const intervals={'15m':900,'1h':3600,'4h':14400,'1d':86400};
    function selectIntervals(){
      const row=choices[Number(position.value)],range=leadPointTimes(row);
      const span=(range.closed??range.opened)-range.opened;
      interval.replaceChildren();
      for(const [code,seconds] of Object.entries(intervals)){
        if(code!=='1d'&&span/(seconds*1000)>140)continue;
        const option=node('option',code==='15m'?'15 分钟':code==='1h'?'1 小时':code==='4h'?'4 小时':'日线');
        option.value=code;interval.append(option);
      }
      redraw();
    }
    function selectPositions(){
      position.replaceChildren();
      for(const [i,row] of choices.entries()){
        if(row.symbol!==symbol.value)continue;
        const option=node('option',(row===focused?'当前 · ':'')+timeLabel(row.openedAt)+' · '+liveSide(row.side));
        option.value=String(i);position.append(option);
      }
      selectIntervals();
    }
    async function redraw(){
      panel.chart?.destroy();panel.chart=null;
      chartRoot.replaceChildren();toolbar.replaceChildren();playback.replaceChildren();
      const version=++panel.version,row=choices[Number(position.value)],span=leadPointTimes(row),code=interval.value;
      const seconds=intervals[code],step=seconds*1000;
      const last=span.closed??span.opened;
      const end=Math.min(Date.now(),last+14*step);
      const start=Math.max(span.opened-14*step,end-(code==='1d'?500:170)*step);
      chartRoot.hidden=false;
      status.textContent='正在读取该交易所的公开 K 线…';
      try{
        const result=await client.candles(r.exchange,row.symbol,code,start,end);
        if(leadPointPanel!==panel||version!==panel.version||!chartRoot.isConnected)return;
        if(!result.bars?.length){chartRoot.hidden=true;status.textContent='该合约在所选时间暂无可用 K 线，仓位时间和均价仍可查看。';return;}
        const event=(effect,time,price)=>({id:effect+':'+time,time,price,effect,positionSide:row.side,
          side:effect==='open'?(row.side==='long'?'buy':'sell'):(row.side==='long'?'sell':'buy'),
          action:effect==='open'?'开仓汇总':'平仓汇总',quote:row.currency||r.currency});
        const events=[event('open',span.opened,row.entryPrice)];
        if(span.closed!==null&&Number.isFinite(row.exitPrice)&&row.exitPrice>0)events.push(event('close',span.closed,row.exitPrice));
        const cycle={symbol:row.symbol,official:true,avgEntry:row.entryPrice,avgExit:row.exitPrice??null};
        panel.chart=BooksTradeChart.mount(chartRoot,playback,{bars:result.bars,events,seconds,cycle,name:r.name,toolbar,aggregate:true});
        const mapped=BooksTradeReplayModel.markerGroups(events,result.bars,seconds).length;
        status.textContent=result.source+' · '+result.bars.length+' 根 K 线 · 已对应 '+mapped+' / '+events.length+
          ' 个仓位汇总点 · 读取 '+timeLabel(result.fetchedAt)+'（北京）'+(mapped<events.length?' · 有点位超出 K 线覆盖或位于同一根 K 线':'');
      }catch(error){
        if(leadPointPanel===panel&&version===panel.version){
          chartRoot.hidden=true;
          const reason={'source_http_429':'行情来源限流，请一分钟后再试。','source_http_403':'行情来源拒绝访问。','unsupported_contract':'该来源未提供此类合约的 K 线。'}[error?.message]||'本次 K 线读取失败，可切换周期重试。';
          status.textContent=reason+'可在下方查看仓位时间和均价。';
        }
      }
    }
    symbol.addEventListener('change',selectPositions);position.addEventListener('change',selectIntervals);interval.addEventListener('change',redraw);
    selectPositions();
  }else if(choices.length){
    root.append(node('p','行情图暂未加载，仍可查看来源的开平仓时间及均价。','detail-method'));
  }
  const rows=[...(focused?[focused]:[]),...saved];
  const tableDetails=node('details',undefined,'public-detail-context');
  tableDetails.append(node('summary','开平仓均价档案'));root.append(tableDetails);
  if(!leadPointPanel)tableDetails.open=true;
  binanceTable(tableDetails,'开平仓汇总',['合约','方向','开仓时间（北京）','开仓均价','平仓时间（北京）','平仓均价'],
    rows.map(row=>[row.symbol,liveSide(row.side),row.openedAt?timeLabel(row.openedAt):null,row.entryPrice,
      row.closedAt?timeLabel(row.closedAt):null,row.exitPrice]),leadActivityNote(r,'history',history)+(history?.fetchedAt?' · 采集 '+timeLabel(history.fetchedAt):''));
}
function renderLeadDetail(r,b){
  const provider=isPublicLead(r),tabs=detailTabs(r);
  if(!Object.hasOwn(tabs,state.tab))state.tab='analysis';
  if(state.tab==='points'){renderLeadPoints(r,b);return;}
  b.replaceChildren();
  if(state.tab==='live'&&r.exchange==='OKX'){renderOKXCurrent(r,b);return;}
  if(state.tab!=='analysis'){renderLeadActivity(r,b,activityKeys[state.tab]);return;}
  const candidates=provider?['7D','30D','90D','180D','365D']:['30D','90D','365D'];
  const available=candidates.filter(period=>Number.isFinite(detailPeriod(r,period)?.roi));
  if(!available.includes(state.window)){
    const gap=okxPeriodGap(r,state.window);
    b.append(node('p',gap?gap.summary+'，可切换已收录周期。':periodLabel(state.window)+' 暂无可核实的收益率，可切换已收录周期。','detail-method'));
  }
  const buttons=node('div',undefined,'period-switch');buttons.setAttribute('role','group');buttons.setAttribute('aria-label','收益统计周期');
  for(const period of candidates){
    const has=available.includes(period);
    const control=button(publicListPage?period:('近 '+parseInt(period,10)+' 天'+(has?'':' · 暂缺')),()=>{state.window=period;state.requestedDetailPeriod=period;saveDetailURL();renderDetail();},'detail-button');
    control.disabled=!has;if(!has)control.title='此周期暂无可核实收益率';control.setAttribute('aria-pressed',String(has&&state.window===period));buttons.append(control);
  }
  b.append(buttons);
  if(provider)renderLeadPerformance(r,b,state.window);else renderBinancePerformance(r,b,state.window,true);
  const part=detailPeriod(r,state.window);
  if(provider&&part){
    const metrics=node('div',undefined,'lead-detail-metrics');
    for(const [label,n,suffix] of [['公开跟随人数',leadRecord(r).copyTraderNum,' 人'],['来源胜率',part.winRate,'%'],['来源回撤',part.mdd,'%'],['来源统计交易数',part.totalTrades,'']]){
      if(Number.isFinite(n)||['来源胜率','来源回撤'].includes(label)){const item=node('div');item.append(node('small',label),node('strong',Number.isFinite(n)?value(n)+suffix:'平台未提供'));metrics.append(item);}
    }
    if(metrics.children.length)b.append(metrics);
  }
  if(Number.isFinite(part?.accountAgeDays))b.append(node('p','采集时已带单 '+part.accountAgeDays+' 天 · '+timeLabel(part.lastSuccessAt),'binance-performance-note'));
  const links=node('div',undefined,'lead-source-links');
  if(part?.evidencePath)links.append(evidenceLink('收益凭证',part.evidencePath));
  if(provider){renderLeadCurve(r,b,part);renderLeadCapital(r,b,state.window);renderLeadSample(r,b,state.window);}
  else if(r.periodRecord?.profileEvidencePath)links.append(evidenceLink('带单起始资料',r.periodRecord.profileEvidencePath));
  links.append(sourceLink(r));b.append(links);
  if(provider&&!publicListPage){
    if(!r.activity)b.append(node('p','仓位和交易记录暂不可读。','binance-performance-note'));
    for(const key of ['positions','history','orders']){
      const section=r.activity?.[key],label=leadActivityNote(r,key,section);
      if(label&&!Object.keys(tabs).some(tab=>activityKeys[tab]===key)){
        const detail=node('p',label+(section?.fetchedAt?' · '+timeLabel(section.fetchedAt):''),'binance-performance-note');
        if(section?.evidencePath)detail.append(evidenceLink(' 查看原始记录',section.evidencePath));
        b.append(detail);
      }
    }
  }else if(!provider)b.append(node('p',binanceStatus(binanceView(r),r),'detail-method'));
}
function activateDetailTab(tab) {
  if(!state.detail||!['analysis','live','positions','points','orders'].includes(tab)||tab===state.tab)return;
  if(!Object.hasOwn(detailTabs(state.detail),tab))return;
  if(state.tab==='live'){stopLive();stopOKXCurrent();}
  if(state.tab==='points')clearLeadPointChart();
  state.tab=tab;
  saveDetailURL();
  renderDetail();
  $('detail').scrollTop=0;
}
let detailOpener=null;
function openDetail(r,p,view='analysis') {
  linkedAccount=null;linkedStatus('');
  globalThis.BooksTradeAnalysis?.dispose();
  const dialog=$('detail');
  if(!dialog.open)detailOpener=document.activeElement;
  resetDetailWidgets();detailLiveSnapshot=null;stopLive();stopOKXCurrent();
  state.detail=r;state.window=p;state.requestedDetailPeriod=p;state.tab=Object.hasOwn(detailTabs(r),view)?view:'analysis';
  if(r.exchange==='OKX'&&(!okxTrades||okxTradesFailed))refreshOKXArchive();
  renderDetail();
  if(!dialog.open)dialog.showModal();
  dialog.scrollTop=0;$('close').focus({preventScroll:true});
}
function renderDetail() {
  const r=state.detail,b=$('detail-body');if(!r)return;
  renderDetailIdentity(r);paintDetailTabs(r);
  const context=$('public-detail-context'),record=publicPerformance(r,state.window);
  const collected=record?.lastSuccessAt||(record?.asOfType==='observed'?record.asOf:null)||(isPublicAccount(r)?state.source?.fetchedAt:null);
  const asOf=record?.sourceAsOf||(record?.asOfType==='source'?record.asOf:null);
  context.hidden=state.tab!=='analysis';
  context.textContent=[periodLabel(state.window),asOf?'来源 '+timeLabel(asOf):null,collected?'采集 '+timeLabel(collected):null,
    asOf||collected?'北京时间':'业绩时间未提供'].filter(Boolean).join(' · ');
  renderDetailOverview(r);syncDetailWidgets(r);
  if(publicListPage&&state.tab!=='live')$('detail-overview').hidden=true;
  if(isPublicLead(r)&&state.tab==='live')$('detail-overview').hidden=true;
  renderDetailStatus();
  if(isPublicLead(r)||r.periodOnly&&state.tab==='analysis'){
    renderLeadDetail(r,b);
    return;
  }
  if(typeof BooksTradeAnalysis!=='undefined'){
    if(state.tab!=='live'){
      if(!canReadLive(r))$('detail-data-status').hidden=true;
      state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='detail');
      publicExecutionReader ||= BooksBinancePublicRecords.reader(globalThis);
      const w=isBinanceTrader(r)?binancePerformance(r,state.window):performanceWindow(r,state.window),cached=cachedWin(r),portfolio=isPublicAccount(r)?portfolioSection(r,state.window):null,history=portfolio?.status==='ready'?portfolio.windows[state.window]:null;
      const curve=isBinanceTrader(r)?binanceChart(r,state.window):history?{points:history.points,lastSuccessAt:portfolio.fetchedAt,status:portfolio.stale?'stale':'ready',currency:history.curveUnit,basis:history.curveBasis}:null;
      const held=lastAlphaPosition(r),positionLabel=held?alphaPositionLabel(held)+' · AlphaFox '+timeLabel(held.sourceTime||held.polledAt):null;
      BooksTradeAnalysis.render(b,{r,tab:state.tab,period:state.window,periodLabel:periodName(state.window,w),compact:publicListPage,positionLabel,metrics:w?{...w,mdd:isPublicAccount(r)?sampledDrawdown(history,state.window):w.mdd,winRate:isPublicAccount(r)?cached?.win?.value??null:w.winRate}:null,curve,profile:r.referenceOnly?globalThis.BooksReferenceData?.profile(globalThis.BooksAoyingHistory,r.accountId):null,binanceView:isBinanceTrader(r)?binanceView(r):null,publicReader:publicExecutionReader,onPositions:p=>{if(state.detail?.accountId===r.accountId&&state.tab==='analysis'&&isPublicFocus(r))syncPublicFocusLive(r,{address:r.accountId,positions:p});acceptDetailPositions(r,p,globalThis.BooksFloatingPnl?.FRESH);},activate:activateDetailTab,setPeriod:p=>{if(periods.includes(p)){state.window=p;saveDetailURL();renderDetail();}},metricNote:r.exchange==='Hyperliquid'?'收益率与盈亏沿用已核验周期数据；长期区间对账未通过时收益率留空。采样盈亏回撤不是标准净值最大回撤。'+winCacheDescription(r):'收益率、回撤、胜率沿用币安来源字段与周期；不以操作样本推算账户表现。',winNote:r.exchange==='Binance'?'币安所选周期平台统计':cached?.win?.eligibleCount?'近期 '+cached.win.eligibleCount+' 个片段 · 独立于所选周期':'缺少有效成交样本'});
      return;
    }
    BooksTradeAnalysis.pause();

  }
  if(state.tab==='live'&&isBinanceTrader(r)){
    const view=binanceView(r);b.replaceChildren();
    if(!view.observedAt&&!hasAlphaPositionArchive(r)){
      empty(b,'当前持仓未知',r.periodRecord?.positionShow===false?'带单员未公开当前持仓。':'本站尚未取得有效的 Binance 当前持仓快照。');return;
    }
    if(!view.observedAt&&hasAlphaPositionArchive(r)){
      if(!lastAlphaPosition(r)&&alphaPositionsPending)b.append(node('p','正在读取历史持仓快照…','detail-method'));
      else empty(b,'币安当前仓位未知',lastAlphaPosition(r)?'上方提供最后一次第三方观测记录。':'币安未公开当前仓位。');
      return;
    }
    binanceTable(b,'持仓快照',['合约','方向','数量','开仓均价','标记价','杠杆','未实现盈亏'],view.positions.map(p=>[p.symbol,p.side==='LONG'?'多':'空',p.quantity,p.entryPrice,p.markPrice,p.leverage+'×',p.unrealizedPnl+' '+p.collateral]),binanceStatus(view,r)+' · '+binanceTiming(view,r));return;
  }
  if(isBinanceTrader(r)){state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='detail');renderBinanceDetail(r,b);return;}
  if(state.tab==='live'&&canReadLive(r)){state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='detail');if(!state.liveView||state.liveUser!==r.accountId){stopLive();b.replaceChildren();buildLivePanel(r,b);}return;}
  b.replaceChildren();state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='detail');
  if(isPublicFocus(r)) {
    b.append(node('h3','公开重点关注'),node('p',r.accountId,'public-focus-address'));
    appendFocusSnapshot(b);
    b.append(node('p','该记录独立于排行榜与持仓资格。最近一次快照不代表开仓事件，也不推断开仓时间；未接入的收益率和胜率不填值。','detail-method'),button('打开实时交易',()=>activateDetailTab('live'),'detail-button'),sourceLink(r));return;
  }
  if(state.tab==='analysis') {
    const w=performanceWindow(r,state.window);b.append(node('h3',`${periodName(state.window,w)} 表现`));
    if(isPublicAccount(r)) {
      b.append(node('p','来源自填昵称与链上地址；未核验真人身份或带单资格。','detail-method'));
      if(r.accountValue!=null)b.append(node('p',`账户权益 ${money(r.accountValue,'USD')} USD`,'account-equity'));
    }
    if(hasMetrics(w)||isPublicAccount(r)) {
      const figures=metrics(w,r.currency,true,r,state.window);b.append(figures,node('p',w?.derived?performanceRange(r,state.window):stampLabel(w),'meta'));const roiMethodNote=isPublicAccount(r)&&derivedPeriods.includes(state.window)?node('p',`${parseInt(state.window,10)}天滚动窗口，非自然季度或年度；区间盈亏来自实际首末采样差。${periodROIDescription(w)}`,'detail-method'):null;if(roiMethodNote)b.append(roiMethodNote);
      if(isPublicAccount(r)) {
        const graph=node('div',undefined,'detail-pnl-chart'),portfolioStatus=node('p',undefined,'meta'),portfolioButton=button('重试曲线',()=>ensureAnalyticsClient()?.ensurePortfolio(r.accountId,{force:true}),'portfolio-retry'),winStatus=node('p',undefined,'meta win-cache-status');
        portfolioButton.hidden=true;b.append(graph,portfolioStatus,portfolioButton,winStatus);state.analyticsViews.push({kind:'detail',r,period:state.window,metrics:figures,graph,portfolioStatus,portfolioButton,winStatus,roiMethodNote});refreshAnalyticsViews(r.accountId);if(state.analyticsTargets.includes(r.accountId))ensureAnalyticsClient()?.ensurePortfolio(r.accountId);
      }else {if(w.curve.length>1)b.append(chart(w));if(w.closedTrades!=null||w.wins!=null)b.append(node('p',`已关闭交易 ${value(w.closedTrades)} 笔 · 盈利交易 ${value(w.wins)} 笔`));}
    }
    else b.append(node('p','当前周期暂无表现记录。'));
    if(isPublicAccount(r))b.append(node('p','周度、月度及来源累计的收益率沿用来源榜单，盈亏也沿用来源榜单。90/180/365天采用公开资金流水与权益逐段对账后的自算收益率，非 TWR 或官方直接值，核验失败时留空。曲线与采样盈亏回撤采用永续账户历史，90/180/365天的区间盈亏按永续历史的实际首末采样计算。采样盈亏回撤参考 Hyperliquid 实际界面算法：累计盈亏从此前运行峰值的下跌额除以峰值时的永续权益，仅按有效正权益峰值取最大比值；可以超过 100%，不代表资金流调整净值的最大回撤。周度、月度及来源累计按对应来源窗口计算，90/180/365天按实际采样区间重算，并非官方直接发布的区间指标。90/180/365天区间取来源累计历史中实际落入窗口的采样，不插值、不把累计收益率改名为区间收益率。来源累计仅代表已返回历史，非完整账户历史。平仓片段胜率仅按最近最多 2000 笔成交中的永续平仓片段统计，不包括现货和开仓成交，按该笔已实现盈亏扣平仓成交手续费判断盈亏，未扣除对应开仓手续费和资金费；持平计入分母。它不等同于完整订单、开平仓回合或当前所选周期的胜率。资料不足时留空。','detail-method'));
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
    const r={id:state.editor.id||'local-'+crypto.randomUUID(),name:$('record-name').value.trim(),accountId:$('record-account').value.trim(),exchange:$('record-exchange').value,currency:$('record-currency').value,sourceUrl:$('record-source').value.trim(),note:$('record-note').value.trim(),featured:$('record-featured').checked,paid:original?.paid||false,avatarUrl:original?.avatarUrl||null,observedAt:new Date().toISOString(),windows:state.editor.windows,positions:original?.positions||[],points:original?.points||[],orders:original?.orders||[]};
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
function rejectOlderFeed(source,rows) {
  if(!state.source)return;
  if(!source)fail();
  for(const key of ['fetchedAt','snapshotAt','lastAttemptAt'])if(state.source[key]&&(!source[key]||Date.parse(source[key])<Date.parse(state.source[key])))fail();
  const previous=state.source.positionVerification?.completedAt;
  if(previous&&(!source.positionVerification||Date.parse(source.positionVerification.completedAt)<Date.parse(previous)))fail();
  const checks=new Map(state.publicRows.map(r=>[r.accountId,r.positionCheck?.checkedAt]));
  for(const r of rows)if(checks.get(r.accountId)&&(!r.positionCheck||Date.parse(r.positionCheck.checkedAt)<Date.parse(checks.get(r.accountId))))fail();
}
function refresh(background=false) {return sharedRequest('refreshRequest',()=>revalidate(background));}
async function revalidate(background=false) {
  const detailsRequested=!publicListPage||Boolean(linkedAccount||state.detail);
  const previousVersion=publicListPage?publicSnapshotVersion():null;
  if(publicListPage){
    publicRefreshMessage='正在检查本站已发布快照…';
    $('public-refresh-result').textContent=publicRefreshMessage;
  }
  const workflowRequest=publicListPage&&readPublicWorkflow();
  const winRequest=refreshWinCache(),portfolioRequest=refreshPortfolioCache(),binanceRequest=refreshBinance(),focusRequest=detailsRequested&&refreshPublicFocus(),periodRequest=refreshPeriodReturns();const restoreFocus=!background&&document.activeElement===$('refresh');
  state.loading=true;$('refresh').disabled=true;$('leaders').setAttribute('aria-busy','true');if(!background&&!state.publicRows.length)$('status').textContent='正在检查最新快照…';
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);let changed=false;
  try {
    const response=await fetch('feed.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});if(!response.ok)throw Error('公开资料暂不可用');
    if(Number(response.headers.get('content-length'))>maxBytes)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();fail();}chunks.push(value);}
    const serialized=decodeChunks(chunks),data=JSON.parse(serialized);globalThis.BooksSourcePolicy?.inspect('feed',data);const rows=validate(data),source=validateSource(data,rows);
    if(data.status==='unavailable'&&state.publicRows.length)throw Error('最新快照不可用');
    rejectOlderFeed(source,rows);
    const snapshot={schemaVersion:1,status:data.status,source:data.source,traders:rows},canonical=JSON.stringify(snapshot);
    changed=state.feedText!==canonical;state.feedText=canonical;state.publicRows=rows;state.source=source;state.status=data.status==='unavailable'&&data.source?.status==='error'?'error':data.status;state.lastReadFailed=state.status==='error';
    if(source&&rows.every(r=>r.sourceKind==='public_account'))savePublicSnapshot('feed',snapshot,state.lastReadFailed);
    if(state.detail&&!state.detail._local) {const latest=rows.find(r=>r.id===state.detail.id);if(latest)state.detail={...latest,_local:false};}
  } catch(e) {globalThis.BooksSourcePolicy?.inspect('feed',null);state.status='error';state.lastReadFailed=true;savePublicSnapshot('feed',undefined,true);}
  finally {
    clearTimeout(timeout);if(!publicListPage){state.loading=false;$('refresh').disabled=false;$('leaders').setAttribute('aria-busy','false');}
    if(!background&&!publicListPage)updateView();else {if(changed){mergeRows();choosePeriod();}reevaluatePositions();}
    if(changed&&state.detail&&!state.detail._local&&$('detail').open)renderDetail();
    saveURL(true);openLinkedAccount();if(restoreFocus&&document.activeElement===document.body)$('refresh').focus();
  }
  await Promise.all([winRequest,portfolioRequest,binanceRequest,focusRequest,periodRequest,workflowRequest]);
  if(publicListPage){
    const failed=Object.values(publicReadFailures()).some(Boolean)||state.portfolioCacheReadFailed||state.winCacheReadFailed;
    const updated=previousVersion!==publicSnapshotVersion();
    publicReadAt=new Date().toISOString();
    publicRefreshMessage=failed?(updated?'部分资料已读取，另有快照读取失败。':'有快照读取失败，详见下方状态。'):
      !state.publicRows.length&&!state.binanceRows.length&&!periodReturns?.accounts?.length&&!okxReturns?.accounts?.length&&!bitgetReturns?.accounts?.length?'已检查，暂无可用快照。':
      updated?'已读取本站发布的快照。':'检查完成，本站暂无新版快照。';
    state.loading=false;$('refresh').disabled=false;
    $('leaders').setAttribute('aria-busy','false');
    if(restoreFocus&&document.activeElement===document.body)$('refresh').focus();
  }
  if(publicListPage||periodReturns||okxReturns||bitgetReturns){
    mergeRows();choosePeriod();renderPreservingCardFocus();renderSource();
    if((isBinanceTrader(state.detail)||isPublicLead(state.detail))&&$('detail').open){const row=state.rows.find(r=>r.id===state.detail.id);if(row){state.detail=row;renderDetail();}}
  }
  if(publicListPage)saveURL(true);
  openLinkedAccount(true);
}
// Initialize the list in the browser or expose the same validators to the publisher.
if(typeof document==='undefined'&&typeof module==='object'&&module.exports){
  module.exports={validate,validateSource,validatePortfolioCache,validateWinCache};
  return;
}
for(const id of controls)$(id).addEventListener('change',()=>{if(id==='period')state.explicitPeriod=true;state.page=1;render();if(id==='exchange'||id==='source')renderSource();saveURL(false,true);});
for(const [id,exchange]of [['platform-all','all'],['platform-hl','Hyperliquid'],['platform-binance','Binance'],['platform-okx','OKX'],['platform-bitget','Bitget']])if($(id))$(id).onclick=()=>selectPlatform(exchange);
$('search').addEventListener('input',()=>{state.page=1;render();saveURL(true,true);});
$('reset').onclick=()=>{$('search').value='';$('period').value='30D';$('exchange').value='all';$('source').value='all';$('sort').value='roi';$('currency').value='all';state.explicitPeriod=false;state.page=1;choosePeriod();render();renderSource();saveURL(false,true);};
function turnListPage(step){
  state.page+=step;render();saveURL();
  if(publicListPage)$('plaza-title').focus();
}
$('prev').onclick=()=>turnListPage(-1);$('next').onclick=()=>turnListPage(1);$('refresh').onclick=()=>refresh();
$('add-trader').onclick=()=>openEditor();
$('record-form').addEventListener('invalid',e=>{const details=e.target.closest('details');if(details)details.open=true;},true);
$('record-form').addEventListener('submit',saveRecord);$('record-period').addEventListener('change',changeEditorPeriod);
for(const id of ['editor-close','editor-cancel'])$(id).onclick=()=>$('record-editor').close();
$('record-editor').addEventListener('close',()=>{state.editor=null;});$('close').onclick=()=>$('detail').close();
const tabs=[...$('tabs').querySelectorAll('[data-tab]')];
function selectTab(b){if(!state.detail||!tabs.includes(b)||b.hidden||b.disabled)return;activateDetailTab(b.dataset.tab);}
$('tabs').addEventListener('click',e=>selectTab(e.target.closest('[data-tab]')));
$('tabs').addEventListener('keydown',e=>{const visibleTabs=tabs.filter(b=>!b.hidden&&!b.disabled),i=visibleTabs.indexOf(e.target);if(i<0)return;let n;if(e.key==='ArrowRight')n=(i+1)%visibleTabs.length;else if(e.key==='ArrowLeft')n=(i+visibleTabs.length-1)%visibleTabs.length;else if(e.key==='Home')n=0;else if(e.key==='End')n=visibleTabs.length-1;else return;e.preventDefault();visibleTabs[n].focus();selectTab(visibleTabs[n]);});
$('detail').addEventListener('close',()=>{
  if($('detail').open)return;
  const closed=state.detail,opener=detailOpener;
  globalThis.BooksTradeAnalysis?.dispose();resetDetailWidgets();detailLiveSnapshot=null;stopLive();stopOKXCurrent();
  state.analyticsViews=state.analyticsViews.filter(v=>v.kind!=='detail');state.detail=null;detailOpener=null;
  const url=new URL(location.href);
  if(closed&&url.searchParams.get('account')===closed.accountId){
    if(history.state?.booksDetail)history.back();
    else{
      for(const key of ['account','view','detailExchange','detailPeriod'])url.searchParams.delete(key);
      history.replaceState(history.state,'',url);
    }
  }
  const replacement=[...$('leaders').querySelectorAll('[data-public-card]')].find(card=>card.dataset.publicCard===closed?.id);
  (opener?.isConnected?opener:replacement?.querySelector('.public-detail-trigger'))?.focus({preventScroll:true});
});
addEventListener('popstate',()=>{
  const listState=()=>JSON.stringify([state.page,$('search').value,...controls.map(id=>$(id).value)]);
  const previous=listState(),params=new URL(location.href).searchParams;
  if($('detail').open&&!params.has('account'))$('detail').close();
  readURL();choosePeriod();
  if(!publicListPage||listState()!==previous){render();renderSource();}
  openLinkedAccount();
});
readURL();loadLocal();const hydrated=hydratePublicSnapshots();state.loading=!hydrated;choosePeriod();render();renderSource();state.loading=false;openLinkedAccount();refresh(hydrated);
setInterval(()=>{reevaluatePositions();if(document.visibilityState==='visible')refresh(true);},60000);
document.addEventListener('visibilitychange',()=>{state.analyticsClient?.setVisible(document.visibilityState==='visible');state.liveClient?.setVisible(document.visibilityState==='visible');if(document.visibilityState==='visible'){if(okxCurrent&&state.detail?.exchange==='OKX')readOKXCurrent(state.detail,okxCurrent);reevaluatePositions();refresh(true);}});
})();
