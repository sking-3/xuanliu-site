(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BinanceData = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Pure adapter for saved public copy-trade snapshots. No network or DOM work.
  const PORTFOLIOS = Object.freeze({
    '5156287639231681792': '爱喝快乐肥宅水',
    '5139646755272846081': '0xEggg',
    '5178595252342363392': 'FaribaFinance'
  });
  const REFERENCE_PORTFOLIOS = Object.freeze({
    '5075281354358777856': Object.freeze({name:'熬鹰资本',note:'公开操作记录独立观察；此前记录未公开持仓',avatarUrl:'https://public.bnbstatic.com/image/pgc/202412/e891a1e22f14b5223e15f43c4b195abc.png',avatarSourceUrl:'https://www.binance.com/zh-CN/square/profile/god_of_trader_tony'})
  });
  const SOURCE_BASE = 'https://www.binance.com/en/copy-trading/lead-details/';
  const MAX_AGE = 30 * 60 * 1000;
  const LIMIT = 5000;
  const PERFORMANCE_MAX_AGE = 60 * 60 * 1000;
  const CHART_MAX_AGE = 60 * 60 * 1000;
  const STATES = ['ready', 'stale', 'unavailable', 'restricted'];
  const KINDS = ['baseline', 'appeared', 'increased', 'decreased', 'absent'];
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.length <= 500;
  const decimal = value => typeof value === 'string' && value.length <= 100 && /^[+-]?\d+(?:\.\d+)?$/.test(value);
  const nonzero = value => !/^[+-]?0+(?:\.0+)?$/.test(value);
  const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  const nullableTime = value => value === null || iso(value);
  const code = value => value === null || (typeof value === 'string' && /^[a-z0-9_]{1,100}$/.test(value));
  const ms = value => Number.isSafeInteger(value) && value > 0;
  const allowed = id => typeof id === 'string' && Object.hasOwn(PORTFOLIOS, id);
  const old = (value, now) => !iso(value) || now - Date.parse(value) > MAX_AGE || Date.parse(value) > now + 300000;
  const sourceUrl = id => allowed(id) ? SOURCE_BASE + id : null;

  function avatarUrl(value) {
    if(typeof value!=='string'||value.length>2048||/[\s\u0000-\u001f\u007f\\]/.test(value))return null;
    try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&['public.bnbstatic.com','public-1306379396.file.myqcloud.com'].includes(url.hostname)&&url.pathname.startsWith('/image/')?url.href:null;}catch(_){return null;}
  }
  function validPosition(p) {
    return record(p) && text(p.key) && text(p.symbol) && ['LONG', 'SHORT', 'BOTH'].includes(p.side) &&
      ['quantity', 'entryPrice', 'markPrice', 'unrealizedPnl'].every(key => decimal(p[key])) &&
      typeof p.leverage === 'number' && Number.isFinite(p.leverage) && p.leverage > 0 && text(p.collateral);
  }
  function validSnapshot(snapshot) {
    return record(snapshot) && snapshot.complete === true && iso(snapshot.observedAt) &&
      Number.isSafeInteger(snapshot.rawCount) && snapshot.rawCount >= 0 &&
      Array.isArray(snapshot.positions) && snapshot.positions.length <= LIMIT &&
      snapshot.rawCount >= snapshot.positions.length && snapshot.positions.every(validPosition) &&
      new Set(snapshot.positions.map(p => p.key)).size === snapshot.positions.length;
  }
  function parseFeed(data) {
    if (!record(data) || data.schemaVersion !== 1 || data.sourceType !== 'copy_trade' || !allowed(data.portfolioId) ||
        !record(data.profile) || data.profile.id !== data.portfolioId || !text(data.profile.name) ||
        data.profile.sourceUrl !== sourceUrl(data.portfolioId) ||
        !['public', 'restricted', 'unknown'].includes(data.profile.visibility) ||
        !record(data.source) || !STATES.includes(data.source.status) ||
        typeof data.source.refreshStopped !== 'boolean' || !code(data.source.errorCode) ||
        !nullableTime(data.source.lastAttemptAt) || !nullableTime(data.source.lastSuccessAt) ||
        (data.snapshot !== null && !validSnapshot(data.snapshot)) ||
        (data.source.status === 'ready' && !validSnapshot(data.snapshot))) {
      throw new Error('BINANCE_FEED_SCHEMA');
    }
    return data;
  }
  function parsePerformance(value) {
    if (value === undefined) return {schemaVersion:1,byPeriod:{}};
    if (!record(value) || value.schemaVersion !== 1 || !record(value.byPeriod) || Object.keys(value.byPeriod).some(period => period !== '30D')) throw new Error('BINANCE_PERFORMANCE_SCHEMA');
    const output={schemaVersion:1,byPeriod:{}};
    for (const [period,part] of Object.entries(value.byPeriod)) {
      if (!record(part) || !['ready','stale','unavailable'].includes(part.status) ||
          !iso(part.lastAttemptAt) || !nullableTime(part.lastSuccessAt) || !nullableTime(part.sourceAsOf) ||
          part.sourcePeriod !== period || part.currency !== 'USDT' || !code(part.errorCode)) throw new Error('BINANCE_PERFORMANCE_SCHEMA');
      const metrics={};
      for (const key of ['roi','pnl','mdd','winRate']) {
        const metric=part[key];
        if (metric !== undefined && metric !== null && (typeof metric !== 'number' || !Number.isFinite(metric))) throw new Error('BINANCE_PERFORMANCE_SCHEMA');
        if (key==='winRate' && metric!==undefined && metric!==null && (metric<0 || metric>100)) throw new Error('BINANCE_PERFORMANCE_SCHEMA');
        metrics[key]=metric ?? null;
      }
      const evidence=part.evidence;
      if (evidence !== null && (!record(evidence) || !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
          !Number.isSafeInteger(evidence.bytes) || evidence.bytes <= 0 || evidence.bytes > 2097152 ||
          evidence.httpStatus !== 200 || evidence.code !== '000000' || !iso(evidence.receivedAt))) throw new Error('BINANCE_PERFORMANCE_SCHEMA');
      if (part.status==='unavailable' ? part.lastSuccessAt!==null||evidence!==null||Object.values(metrics).some(metric=>metric!==null) : !iso(part.lastSuccessAt)||!evidence||evidence.receivedAt!==part.lastSuccessAt) throw new Error('BINANCE_PERFORMANCE_SCHEMA');
      output.byPeriod[period]={status:part.status,lastAttemptAt:part.lastAttemptAt,lastSuccessAt:part.lastSuccessAt,sourceAsOf:part.sourceAsOf,sourcePeriod:period,currency:'USDT',...metrics,errorCode:part.errorCode,evidence:evidence?{sha256:evidence.sha256,bytes:evidence.bytes,httpStatus:200,code:'000000',receivedAt:evidence.receivedAt}:null};
    }
    return output;
  }
  function performance(feed,period,options) {
    const opt=optionsView(options),base={status:'unavailable',periodSupported:period==='30D',sourcePeriod:period,currency:'USDT',lastAttemptAt:null,lastSuccessAt:null,sourceAsOf:null,roi:null,pnl:null,mdd:null,winRate:null,errorCode:null,evidence:null};
    if (!feed || period !== '30D') return base;
    const data=parseFeed(feed);
    if (data.profile.visibility==='restricted'||data.source.status==='restricted'||data.source.errorCode==='restricted') return {...base,status:'restricted'};
    if (data.profile.visibility!=='public') return base;
    let part;
    try {part=parsePerformance(data.performance).byPeriod[period];} catch (_) {return {...base,errorCode:'performance_schema'};}
    if (!part) return base;
    const stopped=data.source.refreshStopped||opt.batchStopped;
    const success=Date.parse(part.lastSuccessAt),fresh=Number.isFinite(success)&&opt.now-success<=PERFORMANCE_MAX_AGE&&success<=opt.now+300000;
    const status=part.status==='unavailable'||!part.lastSuccessAt?'unavailable':part.status==='ready'&&fresh&&!stopped&&!opt.requestFailed?'ready':'stale';
    return {...base,...part,status,...(status==='unavailable'?{roi:null,pnl:null,mdd:null,winRate:null}:{}),errorCode:part.errorCode||(stopped?(opt.batchErrorCode||data.source.errorCode):null)||(opt.requestFailed?'snapshot_read_failed':null)};
  }
  function parseChart(value) {
    if(value===undefined)return {schemaVersion:1,byPeriod:{}};
    if(!record(value)||value.schemaVersion!==1||!record(value.byPeriod)||Object.keys(value.byPeriod).some(period=>period!=='30D'))throw new Error('BINANCE_CHART_SCHEMA');
    const output={schemaVersion:1,byPeriod:{}};
    for(const [period,part]of Object.entries(value.byPeriod)){
      if(!record(part)||!['ready','stale','unavailable'].includes(part.status)||!iso(part.lastAttemptAt)||!nullableTime(part.lastSuccessAt)||part.sourceAsOf!==null||part.sourcePeriod!==period||part.dataType!=='PNL'||part.currency!=='USDT'||!code(part.errorCode)||!Array.isArray(part.points)||part.points.length>1000)throw new Error('BINANCE_CHART_SCHEMA');
      const evidence=part.evidence;
      if(evidence!==null&&(!record(evidence)||!/^[a-f0-9]{64}$/.test(evidence.sha256)||!Number.isSafeInteger(evidence.bytes)||evidence.bytes<=0||evidence.bytes>2097152||evidence.httpStatus!==200||evidence.code!=='000000'||!iso(evidence.receivedAt)))throw new Error('BINANCE_CHART_SCHEMA');
      if(part.status==='unavailable'?part.lastSuccessAt!==null||evidence!==null||part.points.length!==0:!iso(part.lastSuccessAt)||!evidence||evidence.receivedAt!==part.lastSuccessAt)throw new Error('BINANCE_CHART_SCHEMA');
      let previous=-Infinity;const points=part.points.map(point=>{
        const time=Date.parse(point?.time);if(!record(point)||!iso(point.time)||time<=0||time<=previous||time>Date.parse(part.lastSuccessAt)+300000||typeof point.value!=='number'||!Number.isFinite(point.value))throw new Error('BINANCE_CHART_SCHEMA');
        previous=time;return {time:point.time,value:point.value};
      });
      output.byPeriod[period]={status:part.status,lastAttemptAt:part.lastAttemptAt,lastSuccessAt:part.lastSuccessAt,sourceAsOf:null,sourcePeriod:period,dataType:'PNL',currency:'USDT',points,errorCode:part.errorCode,evidence:evidence?{sha256:evidence.sha256,bytes:evidence.bytes,httpStatus:200,code:'000000',receivedAt:evidence.receivedAt}:null};
    }
    return output;
  }
  function chart(feed,period,options){
    const opt=optionsView(options),base={status:'unavailable',periodSupported:period==='30D',sourcePeriod:period,dataType:'PNL',currency:'USDT',lastAttemptAt:null,lastSuccessAt:null,sourceAsOf:null,points:[],pointCount:null,startAt:null,endAt:null,errorCode:null,evidence:null};
    if(!feed||period!=='30D')return base;
    const data=parseFeed(feed);if(data.profile.visibility==='restricted'||data.source.status==='restricted'||data.source.errorCode==='restricted')return {...base,status:'restricted'};
    if(data.profile.visibility!=='public')return base;
    let part;try{part=parseChart(data.chart).byPeriod[period];}catch(_){return {...base,errorCode:'chart_schema'};}if(!part)return base;
    const stopped=data.source.refreshStopped||opt.batchStopped,success=Date.parse(part.lastSuccessAt),fresh=Number.isFinite(success)&&opt.now-success<=CHART_MAX_AGE&&success<=opt.now+300000;
    const status=part.status==='unavailable'||!part.lastSuccessAt?'unavailable':part.status==='ready'&&fresh&&!stopped&&!opt.requestFailed?'ready':'stale';
    const points=status==='unavailable'?[]:part.points;
    return {...base,...part,status,points,pointCount:status==='unavailable'?null:points.length,startAt:points[0]?.time||null,endAt:points.at(-1)?.time||null,errorCode:part.errorCode||(stopped?(opt.batchErrorCode||data.source.errorCode):null)||(opt.requestFailed?'snapshot_read_failed':null)};
  }
  function parseCollection(data) {
    if (!record(data) || data.schemaVersion !== 1 || !iso(data.generatedAt) ||
        !record(data.source) || typeof data.source.refreshStopped !== 'boolean' || !code(data.source.errorCode) ||
        !Array.isArray(data.portfolios) || data.portfolios.length > Object.keys(PORTFOLIOS).length) {
      throw new Error('BINANCE_COLLECTION_SCHEMA');
    }
    const seen = new Set();
    data.portfolios.forEach(feed => {
      parseFeed(feed);
      if (feed.profile.visibility==='public'&&feed.source.status!=='restricted'&&feed.source.errorCode!=='restricted'&&!feed.source.refreshStopped&&!data.source.refreshStopped) {parsePerformance(feed.performance);parseChart(feed.chart);}
      if (seen.has(feed.portfolioId)) throw new Error('BINANCE_COLLECTION_SCHEMA');
      seen.add(feed.portfolioId);
    });
    return data;
  }
  function validOrder(r) {
    return record(r) && ['symbol', 'side', 'positionSide', 'type'].every(key => text(r[key])) &&
      ['executedQty', 'avgPrice', 'totalPnl'].every(key => decimal(r[key])) && ms(r.orderTime) && ms(r.orderUpdateTime) &&
      (r.sampleFirstSeenAt===undefined || iso(r.sampleFirstSeenAt)) &&
      (r.orderId===undefined || (typeof r.orderId==='string' && /^\d{1,30}$/.test(r.orderId) && iso(r.firstSeenAt) && ['seen','baseline','new_order'].includes(r.observation)));
  }
  function validClosed(r) {
    return record(r) && ['symbol', 'side', 'status'].every(key => text(r[key])) &&
      ['avgCost', 'avgClosePrice', 'closingPnl', 'closedVolume', 'leverage'].every(key => decimal(r[key])) &&
      ms(r.opened) && (r.closed === null || r.closed === 0 || ms(r.closed));
  }
  function validObservation(o) {
    return record(o) && text(o.id) && KINDS.includes(o.kind) && text(o.symbol) && text(o.side) &&
      iso(o.to) && (o.from === null || iso(o.from)) &&
      (o.before === null || decimal(o.before)) && (o.after === null || decimal(o.after));
  }
  function coverageView(value) {
    if (!record(value) || !Number.isSafeInteger(value.page) || value.page < 1 ||
        !Number.isSafeInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > LIMIT ||
        !nullableTime(value.requestedFrom) || !nullableTime(value.requestedTo) ||
        !(value.sourceTotal === null || (Number.isSafeInteger(value.sourceTotal) && value.sourceTotal >= 0)) ||
        !(value.indexValue === null || text(value.indexValue)) ||
        typeof value.truncated !== 'boolean' || value.identity !== 'source_page_sample_no_cross_run_deduplication') return null;
    return {
      page: value.page, pageSize: value.pageSize,
      requestedFrom: value.requestedFrom, requestedTo: value.requestedTo,
      sourceTotal: value.sourceTotal, indexValue: value.indexValue,
      truncated: value.truncated, identity: value.identity
    };
  }
  function emptyHistory() {
    return { status: 'unavailable', fetchedAt: null, rows: [], complete: false, coverage: null };
  }
  function historyView(part, validator, now, uncertain, orders) {
    if (!record(part) || !['ready', 'stale', 'unavailable'].includes(part.status) || part.complete !== false ||
        !nullableTime(part.fetchedAt) || !Array.isArray(part.rows) || part.rows.length > LIMIT ||
        !part.rows.every(validator) || part.status === 'unavailable' || !iso(part.fetchedAt)) return emptyHistory();
    // Preserve same-looking rows: these page samples have no reliable cross-run order ID.
    const rows = part.rows.map(row => ({ ...row })).sort(orders ?
      ((a, b) => b.orderUpdateTime - a.orderUpdateTime || b.orderTime - a.orderTime) :
      ((a, b) => (b.closed || b.opened) - (a.closed || a.opened)));
    return {
      status: part.status === 'stale' || uncertain || old(part.fetchedAt, now) ? 'stale' : 'ready',
      fetchedAt: part.fetchedAt, rows, complete: false, coverage: coverageView(part.coverage)
    };
  }
  function optionsView(options) {
    const value = options || {};
    return {
      now: Number.isFinite(value.now) ? value.now : Date.now(),
      requestFailed: value.requestFailed === true || value.readFailed === true,
      checkedAt: iso(value.checkedAt) ? value.checkedAt :
        (ms(value.checkedAt) ? new Date(value.checkedAt).toISOString() : null),
      batchStopped: value.batchStopped === true,
      batchErrorCode: code(value.batchErrorCode) ? value.batchErrorCode : null
    };
  }
  function detail(feed, options) {
    const opt = optionsView(options);
    if (feed === null || feed === undefined) return {
      status: 'unavailable', visibility: 'unknown', checkedAt: opt.checkedAt,
      lastAttemptAt: null, lastSuccessAt: null, observedAt: null,
      currentPositionCount: null, lastPositionCount: null,
      positions: [], observations: [], orders: emptyHistory(), closedPositions: emptyHistory(),
      refreshStopped: opt.batchStopped, errorCode: opt.batchErrorCode || (opt.requestFailed ? 'snapshot_read_failed' : null)
    };
    const data = parseFeed(feed);
    const restricted = data.profile.visibility === 'restricted' || data.source.status === 'restricted' || data.source.errorCode === 'restricted';
    const visible = !restricted && data.profile.visibility === 'public';
    const snapshot = visible && validSnapshot(data.snapshot) ? data.snapshot : null;
    const stopped = data.source.refreshStopped || opt.batchStopped;
    let status = restricted ? 'restricted' : 'unavailable';
    if (snapshot) status = data.source.status === 'ready' && !stopped && !opt.requestFailed &&
      !old(snapshot.observedAt, opt.now) && !old(data.source.lastSuccessAt, opt.now) ? 'ready' : 'stale';
    const positions = snapshot ? snapshot.positions.filter(p => nonzero(p.quantity)).map(p => ({ ...p })) : [];
    const observations = visible && Array.isArray(data.observations) && data.observations.length <= LIMIT ?
      data.observations.filter(validObservation).map(o => ({ ...o })).sort((a, b) => Date.parse(b.to) - Date.parse(a.to)) : [];
    const uncertain = stopped || opt.requestFailed || data.source.status !== 'ready';
    return {
      status, visibility: restricted ? 'restricted' : data.profile.visibility,
      checkedAt: opt.checkedAt,
      lastAttemptAt: data.source.lastAttemptAt, lastSuccessAt: data.source.lastSuccessAt,
      observedAt: snapshot ? snapshot.observedAt : null,
      currentPositionCount: status === 'ready' ? positions.length : null,
      lastPositionCount: snapshot ? positions.length : null,
      positions, observations,
      orders: visible ? historyView(data.history && data.history.orders, validOrder, opt.now, uncertain, true) : emptyHistory(),
      closedPositions: visible ? historyView(data.history && data.history.closedPositions, validClosed, opt.now, uncertain, false) : emptyHistory(),
      refreshStopped: stopped,
      errorCode: data.source.errorCode || (opt.batchStopped ? opt.batchErrorCode : null) || (opt.requestFailed ? 'snapshot_read_failed' : null)
    };
  }
  function missingFeed(id) {
    return {
      schemaVersion: 1, sourceType: 'copy_trade', portfolioId: id, generatedAt: null,
      profile: { id, name: PORTFOLIOS[id], sourceUrl: sourceUrl(id), visibility: 'unknown', status: 'UNKNOWN' },
      source: { status: 'unavailable', lastAttemptAt: null, lastSuccessAt: null, refreshStopped: false, errorCode: null },
      snapshot: null, observations: [], history: { orders: emptyHistory(), closedPositions: emptyHistory() }
    };
  }
  function toTraders(collection, options) {
    const data = parseCollection(collection);
    const rows = Object.entries(PORTFOLIOS).map(([id, name]) => {
      // Keep the identity card when a registered feed is absent; invent no trading data.
      const feed = data.portfolios.find(item => item.portfolioId === id) || missingFeed(id);
      const view = detail(feed, { ...options, batchStopped: data.source.refreshStopped, batchErrorCode: data.source.errorCode });
      return {
        id: 'binance-' + id, name, accountId: id, exchange: 'Binance', currency: 'USDT',
        sourceKind: 'copy_trade', featured: false, paid: false, observedAt: view.observedAt,
        sourceUrl: sourceUrl(id), sourceName: feed.profile.name.trim(), avatarUrl:avatarUrl(feed.profile.avatarUrl),
        windows: {}, positions: [], points: [], orders: [],
        binance: feed,
        binanceBatchSource: { refreshStopped: data.source.refreshStopped, errorCode: data.source.errorCode }
      };
    });
    for (const [id, reference] of Object.entries(REFERENCE_PORTFOLIOS)) rows.push({
      id:'binance-'+id,name:reference.name,accountId:id,exchange:'Binance',currency:'USDT',
      sourceKind:'copy_trade',featured:false,paid:false,observedAt:null,sourceUrl:SOURCE_BASE+id,sourceName:null,avatarUrl:avatarUrl(reference.avatarUrl),avatarSourceUrl:reference.avatarSourceUrl,
      windows:{},positions:[],points:[],orders:[],binance:null,referenceOnly:true,referenceNote:reference.note,
      binanceBatchSource:{refreshStopped:false,errorCode:null}
    });
    return rows;
  }
  return Object.freeze({ PORTFOLIOS, REFERENCE_PORTFOLIOS, MAX_AGE, PERFORMANCE_MAX_AGE, CHART_MAX_AGE, parseCollection, toTraders, detail, performance, chart });
});
