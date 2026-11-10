'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../trader/binance-data.js');

const NOW = Date.parse('2026-11-10T08:00:00.000Z');
const stamp = new Date(NOW).toISOString();
const IDS = Object.keys(api.PORTFOLIOS);
const clone = value => JSON.parse(JSON.stringify(value));
let passed = 0;
function test(name, run) { run(); passed += 1; console.log('ok ' + passed + ' - ' + name); }
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function sampleFeed(id = IDS[0]) {
  return {
    schemaVersion: 1, sourceType: 'copy_trade', portfolioId: id, generatedAt: stamp,
    profile: { id, name: api.PORTFOLIOS[id], status: 'ACTIVE', visibility: 'public',
      sourceUrl: 'https://www.binance.com/en/copy-trading/lead-details/' + id },
    source: { status: 'ready', lastAttemptAt: stamp, lastSuccessAt: stamp, errorCode: null, refreshStopped: false },
    snapshot: { observedAt: stamp, complete: true, rawCount: 10, positions: [{
      key: 'BTCUSDT:LONG:USDT', symbol: 'BTCUSDT', side: 'LONG', quantity: '0.0100',
      entryPrice: '65000.123456789', markPrice: '66000.0000', leverage: 10, unrealizedPnl: '9.99876543211', collateral: 'USDT'
    }] },
    observations: [{ id: 'baseline-1', kind: 'baseline', symbol: 'BTCUSDT', side: 'LONG',
      from: null, to: stamp, before: null, after: '0.0100' }],
    history: {
      orders: { status: 'ready', fetchedAt: stamp, errorCode: null, complete: false,
        coverage: { page: 1, pageSize: 20, requestedFrom: '2026-11-03T08:00:00.000Z',
          requestedTo: stamp, sourceTotal: 50, indexValue: '123', truncated: true,
          identity: 'source_page_sample_no_cross_run_deduplication' },
        rows: [{ symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT',
          executedQty: '0.0100', avgPrice: '65000.123456789', totalPnl: '0.0000',
          orderTime: NOW - 10 * 86400000, orderUpdateTime: NOW - 1000 }] },
      closedPositions: { status: 'ready', fetchedAt: stamp, errorCode: null, complete: false,
        coverage: { page: 1, pageSize: 20, requestedFrom: null, requestedTo: null,
          sourceTotal: 30, indexValue: null, truncated: true,
          identity: 'source_page_sample_no_cross_run_deduplication' },
        rows: [{ symbol: 'ETHUSDT', side: 'Long', opened: NOW - 86400000, closed: NOW - 10000,
          avgCost: '2000', avgClosePrice: '2010', closingPnl: '10', closedVolume: '1', status: 'All Closed', leverage: '5' }] }
    }
  };
}
function sampleCollection() {
  return { schemaVersion: 1, generatedAt: stamp, source: { refreshStopped: false, errorCode: null },
    portfolios: IDS.map(id => sampleFeed(id)) };
}
function view(feed, options = {}) { return api.detail(feed, { now: NOW, ...options }); }

test('saved real collection is compatible and keeps three source identities and one reference identity', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '../trader/binance/portfolios.json'), 'utf8'));
  const rows = api.toTraders(api.parseCollection(real), { now: Date.parse(real.generatedAt) });
  assert.deepEqual(rows.map(row => row.accountId), [...IDS,...Object.keys(api.REFERENCE_PORTFOLIOS)]);
  rows.forEach(row => {
    assert.equal(row.name, api.PORTFOLIOS[row.accountId] || api.REFERENCE_PORTFOLIOS[row.accountId].name);
    assert.equal(row.id, 'binance-' + row.accountId);
    assert.equal(row.sourceUrl, 'https://www.binance.com/en/copy-trading/lead-details/' + row.accountId);
    assert.deepEqual(row.windows, {});
    assert.deepEqual(row.positions, []);
    assert.deepEqual(row.points, []);
    assert.deepEqual(row.orders, []);
  });
});
test('profile ID, source type, canonical URL and allowlist cannot be substituted', () => {
  for (const mutate of [
    f => { f.profile.id = IDS[1]; },
    f => { f.profile.sourceUrl = 'https://www.binance.com/en/copy-trading/lead-details/' + IDS[1]; },
    f => { f.sourceType = 'smart_money'; },
    f => { f.portfolioId = '5184709519277757184'; }
  ]) {
    const data = sampleCollection(); mutate(data.portfolios[0]);
    assert.throws(() => api.parseCollection(data), /BINANCE_FEED_SCHEMA/);
  }
});
test('duplicate identities and malformed batch/source state fail closed', () => {
  const duplicate = sampleCollection(); duplicate.portfolios[1] = clone(duplicate.portfolios[0]);
  assert.throws(() => api.parseCollection(duplicate), /BINANCE_COLLECTION_SCHEMA/);
  for (const source of [null, { refreshStopped: 'false', errorCode: null }, { refreshStopped: false, errorCode: {} }]) {
    const data = sampleCollection(); data.source = source;
    assert.throws(() => api.parseCollection(data), /BINANCE_COLLECTION_SCHEMA/);
  }
  const data = sampleCollection(); data.portfolios[0].source.lastSuccessAt = 'invalid';
  assert.throws(() => api.parseCollection(data), /BINANCE_FEED_SCHEMA/);
});
test('fresh complete positions and valid empty snapshot have known current counts', () => {
  const feed = sampleFeed();
  assert.equal(view(feed).currentPositionCount, 1);
  feed.snapshot.positions = [];
  const result = view(feed);
  assert.equal(result.status, 'ready');
  assert.equal(result.currentPositionCount, 0);
  assert.equal(result.lastPositionCount, 0);
});
test('30 minute boundary uses both observedAt and lastSuccessAt', () => {
  const feed = sampleFeed();
  assert.equal(view(feed, { now: NOW + api.MAX_AGE }).status, 'ready');
  assert.equal(view(feed, { now: NOW + api.MAX_AGE + 1 }).status, 'stale');
  feed.source.lastSuccessAt = new Date(NOW - api.MAX_AGE - 1).toISOString();
  assert.equal(view(feed).currentPositionCount, null);
  feed.source.lastSuccessAt = null;
  assert.equal(view(feed).status, 'stale');
});
test('stale zero remains current unknown and last known zero', () => {
  const feed = sampleFeed(); feed.snapshot.positions = [];
  const result = view(feed, { now: NOW + api.MAX_AGE + 1 });
  assert.equal(result.status, 'stale');
  assert.equal(result.currentPositionCount, null);
  assert.equal(result.lastPositionCount, 0);
});
test('local checkedAt and collection generatedAt never refresh source observation', () => {
  const data = sampleCollection();
  data.generatedAt = new Date(NOW + 86400000).toISOString();
  const result = view(data.portfolios[0], { now: NOW + 86400000, checkedAt: NOW + 86400000 });
  assert.equal(result.status, 'stale');
  assert.equal(result.observedAt, stamp);
  assert.equal(result.lastSuccessAt, stamp);
  assert.equal(result.lastAttemptAt, stamp);
  assert.equal(result.checkedAt, data.generatedAt);
  assert.equal(api.toTraders(data, { now: NOW + 86400000 })[0].observedAt, stamp);
});
test('failed local read preserves public rows and original times but current count is null', () => {
  const result = view(sampleFeed(), { requestFailed: true, checkedAt: NOW + 1000 });
  assert.equal(result.status, 'stale');
  assert.equal(result.currentPositionCount, null);
  assert.equal(result.lastPositionCount, 1);
  assert.equal(result.positions.length, 1);
  assert.equal(result.orders.status, 'stale');
  assert.equal(result.orders.fetchedAt, stamp);
  assert.equal(result.errorCode, 'snapshot_read_failed');
});
test('per-account halt remains stopped regardless of mode or retry options', () => {
  const feed = sampleFeed(); feed.source.refreshStopped = true; feed.source.errorCode = 'http_429';
  for (const mode of ['positions', 'full', 'ui-only']) {
    const result = view(feed, { mode, retry: true, checkedAt: NOW });
    assert.equal(result.refreshStopped, true);
    assert.equal(result.currentPositionCount, null);
    assert.equal(result.errorCode, 'http_429');
    assert.equal(result.orders.status, 'stale');
  }
});
test('collection halt is carried by every row and makes details stale', () => {
  const data = sampleCollection(); data.source = { refreshStopped: true, errorCode: 'http_403' };
  api.toTraders(data, { now: NOW }).filter(row => !row.referenceOnly).forEach(row => {
    const result = view(row.binance, { batchStopped: row.binanceBatchSource.refreshStopped, batchErrorCode: row.binanceBatchSource.errorCode });
    assert.equal(result.refreshStopped, true);
    assert.equal(result.currentPositionCount, null);
    assert.equal(result.lastPositionCount, 1);
    assert.equal(result.orders.status, 'stale');
    assert.equal(result.errorCode, 'http_403');
  });
});
test('visibility, restricted status or restricted error hides all trading payload', () => {
  for (const mutate of [
    f => { f.profile.visibility = 'restricted'; },
    f => { f.source.status = 'restricted'; },
    f => { f.source.errorCode = 'restricted'; }
  ]) {
    const feed = sampleFeed(); mutate(feed);
    const result = view(feed);
    assert.equal(result.status, 'restricted');
    assert.equal(result.observedAt, null);
    assert.equal(result.currentPositionCount, null);
    assert.equal(result.lastPositionCount, null);
    assert.deepEqual(result.positions, []);
    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.orders.rows, []);
    assert.deepEqual(result.closedPositions.rows, []);
  }
});
test('unknown visibility suppresses old payload without declaring empty', () => {
  const feed = sampleFeed(); feed.profile.visibility = 'unknown';
  const result = view(feed);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.currentPositionCount, null);
  assert.equal(result.lastPositionCount, null);
  assert.equal(result.observedAt, null);
  assert.deepEqual(result.positions, []);
  assert.deepEqual(result.orders.rows, []);
});
test('missing registered accounts retain identity cards with unknown counts', () => {
  const data = sampleCollection(); data.portfolios = [];
  const rows = api.toTraders(data, { now: NOW });
  assert.equal(rows.length, 4);
  rows.forEach(row => {
    const result = view(row.binance);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.currentPositionCount, null);
    assert.equal(row.observedAt, null);
    assert.deepEqual(row.windows, {});
  });
  assert.equal(view(null).currentPositionCount, null);
});
test('incomplete, duplicate-key, invalid decimal and nonfinite snapshot rows are rejected', () => {
  for (const mutate of [
    f => { f.snapshot.complete = false; },
    f => { f.snapshot.positions.push(clone(f.snapshot.positions[0])); },
    f => { f.snapshot.positions[0].quantity = 'NaN'; },
    f => { f.snapshot.positions[0].leverage = Infinity; }
  ]) {
    const feed = sampleFeed(); mutate(feed);
    assert.throws(() => view(feed), /BINANCE_FEED_SCHEMA/);
  }
});
test('decimal text is unchanged and zero rows do not inflate current count', () => {
  const feed = sampleFeed();
  feed.snapshot.positions.push({ ...feed.snapshot.positions[0], key: 'ETHUSDT:LONG:USDT', symbol: 'ETHUSDT', quantity: '-0.000' });
  const result = view(feed);
  assert.equal(result.currentPositionCount, 1);
  assert.equal(result.positions[0].quantity, '0.0100');
  assert.equal(result.positions[0].entryPrice, '65000.123456789');
  assert.equal(result.positions[0].unrealizedPnl, '9.99876543211');
});
test('no-ID duplicate orders and earlier-created recently-updated orders are retained', () => {
  const feed = sampleFeed();
  feed.history.orders.rows.push(clone(feed.history.orders.rows[0]));
  const result = view(feed);
  assert.equal(result.orders.rows.length, 2);
  assert.deepEqual(result.orders.rows[0], result.orders.rows[1]);
  assert.equal(result.orders.rows[0].orderTime, NOW - 10 * 86400000);
  assert.equal(Object.hasOwn(result.orders.rows[0], 'id'), false);
});
test('history coverage and distinct order timestamps remain exact and incomplete', () => {
  const feed = sampleFeed(), result = view(feed);
  assert.deepEqual(result.orders.coverage, feed.history.orders.coverage);
  assert.deepEqual(result.closedPositions.coverage, feed.history.closedPositions.coverage);
  assert.equal(result.orders.complete, false);
  assert.equal(result.closedPositions.complete, false);
  assert.notEqual(result.orders.rows[0].orderTime, result.orders.rows[0].orderUpdateTime);
});
test('malformed or falsely complete history is unavailable and does not erase valid positions', () => {
  for (const mutate of [
    f => { f.history.orders.complete = true; },
    f => { f.history.orders.rows[0].avgPrice = {}; },
    f => { f.history.orders.fetchedAt = null; }
  ]) {
    const feed = sampleFeed(); mutate(feed);
    const result = view(feed);
    assert.equal(result.currentPositionCount, 1);
    assert.equal(result.orders.status, 'unavailable');
    assert.deepEqual(result.orders.rows, []);
    assert.equal(result.orders.complete, false);
  }
});
test('history expiry is independent and never declares a complete account history', () => {
  const feed = sampleFeed(); feed.history.orders.fetchedAt = new Date(NOW - api.MAX_AGE - 1).toISOString();
  const result = view(feed);
  assert.equal(result.status, 'ready');
  assert.equal(result.orders.status, 'stale');
  assert.equal(result.orders.complete, false);
  feed.history.closedPositions.coverage = { complete: true };
  assert.equal(view(feed).closedPositions.coverage, null);
  assert.equal(view(feed).closedPositions.complete, false);
});
test('baseline and snapshot differences remain observations, never synthesized orders', () => {
  const feed = sampleFeed();
  feed.observations.push({ ...feed.observations[0], id: 'difference-1', kind: 'increased', from: stamp, before: '0.01', after: '0.02' });
  const result = view(feed);
  assert.equal(result.observations[0].kind, 'baseline');
  assert.equal(result.observations[1].kind, 'increased');
  assert.equal(result.orders.rows.length, 1);
});
test('source display nickname cannot rebind canonical identity', () => {
  const data = sampleCollection();
  data.portfolios[0].profile.name = 'FaribaFinance ';
  const rows = api.toTraders(data, { now: NOW });
  assert.equal(rows[0].name, '爱喝快乐肥宅水');
  assert.equal(rows[0].sourceName, 'FaribaFinance');
  assert.equal(rows[0].accountId, IDS[0]);
});
test('future timestamps beyond five minutes cannot be treated as current', () => {
  const feed = sampleFeed(); feed.snapshot.observedAt = new Date(NOW + 300001).toISOString();
  assert.equal(view(feed).currentPositionCount, null);
});
test('frozen inputs remain unchanged and output sorting does not mutate saved rows', () => {
  const data = freeze(sampleCollection()), before = JSON.stringify(data);
  const rows = api.toTraders(data, { now: NOW });
  const result = view(rows[0].binance);
  result.positions[0].quantity = '999';
  result.orders.rows[0].avgPrice = '999';
  result.orders.coverage.page = 2;
  assert.equal(JSON.stringify(data), before);
});
test('browser export has no DOM, network, timer or storage side effects', () => {
  const source = fs.readFileSync(path.join(__dirname, '../trader/binance-data.js'), 'utf8');
  const context = { console };
  for (const key of ['document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'localStorage', 'sessionStorage']) {
    Object.defineProperty(context, key, { get() { throw Error('SIDE_EFFECT_' + key); } });
  }
  vm.runInNewContext(source, context, { timeout: 1000 });
  assert.equal(typeof context.BinanceData.parseCollection, 'function');
  assert.equal(typeof context.BinanceData.toTraders, 'function');
  assert.equal(typeof context.BinanceData.detail, 'function');
  assert.equal(context.BinanceData.MAX_AGE, 30 * 60 * 1000);
});
test('reference identity cannot be substituted into the three-account source allowlist', () => {
 const id='5075281354358777856';assert.equal(Object.hasOwn(api.PORTFOLIOS,id),false);assert.equal(api.REFERENCE_PORTFOLIOS[id].name,'熬鹰资本');assert.equal(Object.keys(api.PORTFOLIOS).length,3);
 const data=sampleCollection(),feed=sampleFeed();feed.portfolioId=id;feed.profile={...feed.profile,id,name:'熬鹰资本',sourceUrl:'https://www.binance.com/en/copy-trading/lead-details/'+id};data.portfolios=[feed];assert.throws(()=>api.parseCollection(data),/BINANCE_FEED_SCHEMA/);assert.throws(()=>view(feed),/BINANCE_FEED_SCHEMA/);
});
test('reference identity always carries no trading feed or synthetic evidence time', () => {
 const data=sampleCollection();data.portfolios=[];data.source={refreshStopped:true,errorCode:'http_429'};
 const row=api.toTraders(data,{now:NOW,requestFailed:true,checkedAt:stamp}).find(row=>row.referenceOnly);
 assert.equal(row.accountId,'5075281354358777856');assert.equal(row.name,'熬鹰资本');assert.equal(row.binance,null);assert.equal(row.observedAt,null);assert.deepEqual(row.binanceBatchSource,{refreshStopped:false,errorCode:null});assert.match(row.referenceNote,/此前记录未公开持仓/);
 const result=api.detail(row.binance);for(const key of ['checkedAt','observedAt','lastAttemptAt','lastSuccessAt','currentPositionCount','lastPositionCount'])assert.equal(result[key],null);
 assert.equal(result.visibility,'unknown');assert.deepEqual(result.positions,[]);assert.deepEqual(result.orders.rows,[]);assert.equal(result.orders.status,'unavailable');
});
function performancePart(at=stamp,metrics={roi:12.34,pnl:1234.56,mdd:-7.89,winRate:65.43}) {return {status:'ready',lastAttemptAt:at,lastSuccessAt:at,sourceAsOf:null,sourcePeriod:'30D',currency:'USDT',...metrics,errorCode:null,evidence:{sha256:'a'.repeat(64),bytes:120,httpStatus:200,code:'000000',receivedAt:at}};}
function withPerformance(feed=sampleFeed(),part=performancePart()) {feed.performance={schemaVersion:1,byPeriod:{'30D':part}};return feed;}
test('source performance preserves percent units, decimal PnL, drawdown sign and its evidence',()=>{
 const feed=withPerformance(),result=api.performance(feed,'30D',{now:NOW});assert.equal(result.status,'ready');assert.equal(result.roi,12.34);assert.equal(result.pnl,1234.56);assert.equal(result.mdd,-7.89);assert.equal(result.winRate,65.43);assert.equal(result.sourceAsOf,null);assert.equal(result.currency,'USDT');assert.deepEqual(result.evidence,feed.performance.byPeriod['30D'].evidence);
});
test('performance supports exactly 30D and never borrows values for another period or reference',()=>{
 const feed=withPerformance();for(const period of ['7D','90D','180D','365D','ALL']){const result=api.performance(feed,period,{now:NOW});assert.equal(result.periodSupported,false);for(const key of ['roi','pnl','mdd','winRate'])assert.equal(result[key],null);}
 assert.equal(api.performance(null,'30D').roi,null);assert.equal(api.performance(sampleFeed(),'30D').roi,null);
});
test('performance expires independently at the 60-minute boundary without refreshing positions',()=>{
 const feed=withPerformance();for(const [offset,status]of [[3599999,'ready'],[3600000,'ready'],[3600001,'stale']]){assert.equal(api.performance(feed,'30D',{now:NOW+offset}).status,status);assert.equal(api.performance(feed,'30D',{now:NOW+offset}).roi,12.34);assert.equal(api.detail(feed,{now:NOW+offset}).currentPositionCount,null);}
 feed.snapshot.observedAt=new Date(NOW-api.MAX_AGE-1).toISOString();assert.equal(api.performance(feed,'30D',{now:NOW}).status,'ready');assert.equal(api.detail(feed,{now:NOW}).currentPositionCount,null);
});
test('performance missing metric fields and explicit null remain null, never zero',()=>{
 const feed=withPerformance(sampleFeed(),performancePart(stamp,{roi:null,pnl:null}));const result=api.performance(feed,'30D',{now:NOW});for(const key of ['roi','pnl','mdd','winRate'])assert.equal(result[key],null);
});
test('invalid public performance types, evidence, period and currency reject the aggregate',()=>{
 for(const mutate of [p=>p.roi='12.3',p=>p.pnl=Infinity,p=>p.mdd={},p=>p.winRate=false,p=>p.winRate=-0.01,p=>p.winRate=100.01,p=>p.sourcePeriod='7D',p=>p.currency='USD',p=>p.evidence.sha256='bad',p=>p.evidence.bytes=0,p=>p.lastSuccessAt=null,p=>p.sourceAsOf='not-a-time',p=>p.evidence.receivedAt=new Date(NOW-1).toISOString(),p=>p.status='unavailable']){
 const feed=withPerformance();mutate(feed.performance.byPeriod['30D']);const data=sampleCollection();data.portfolios=[feed];assert.throws(()=>api.parseCollection(data),/BINANCE_PERFORMANCE_SCHEMA/);assert.equal(api.performance(feed,'30D',{now:NOW}).roi,null);}
 const feed=withPerformance();feed.performance.byPeriod['7D']=performancePart();const data=sampleCollection();data.portfolios=[feed];assert.throws(()=>api.parseCollection(data),/BINANCE_PERFORMANCE_SCHEMA/);
});
test('privacy hides all performance and permits safety downgrade despite malformed metric payload',()=>{
 for(const visibility of ['restricted','unknown']){const feed=withPerformance();feed.profile.visibility=visibility;feed.performance.byPeriod['30D'].roi='unsafe';const data=sampleCollection();data.portfolios=[feed];assert.doesNotThrow(()=>api.parseCollection(data));const result=api.performance(feed,'30D',{now:NOW});for(const key of ['roi','pnl','mdd','winRate','lastSuccessAt','evidence'])assert.equal(result[key],null);}
});
test('read failure, per-account stop and batch stop retain performance only as stale',()=>{
 const feed=withPerformance();for(const options of [{requestFailed:true},{batchStopped:true,batchErrorCode:'http_429'}]){const result=api.performance(feed,'30D',{now:NOW,...options});assert.equal(result.status,'stale');assert.equal(result.roi,12.34);assert.equal(result.lastSuccessAt,stamp);}
 feed.source.refreshStopped=true;assert.equal(api.performance(feed,'30D',{now:NOW}).status,'stale');
});
test('positions refresh cannot refresh older performance or replace its success time',()=>{
 const feed=withPerformance(sampleFeed(),performancePart(new Date(NOW-3600001).toISOString()));const result=api.performance(feed,'30D',{now:NOW});assert.equal(result.status,'stale');assert.equal(result.lastSuccessAt,new Date(NOW-3600001).toISOString());assert.equal(api.detail(feed,{now:NOW}).status,'ready');
});
test('win rate includes zero and 100 but does not cap ROI or source drawdown',()=>{for(const winRate of [0,100]){const feed=withPerformance(sampleFeed(),performancePart(stamp,{roi:1250,pnl:-10000,mdd:-150,winRate}));const result=api.performance(feed,'30D',{now:NOW});assert.equal(result.winRate,winRate);assert.equal(result.roi,1250);assert.equal(result.mdd,-150);}});
test('real profile avatar URLs are normalized without replacing identity or source times',()=>{for(const url of ['https://public.bnbstatic.com/image/pgc/source.png','https://public-1306379396.file.myqcloud.com/image/avatar/source.jpg']){const data=sampleCollection();data.portfolios[0].profile.avatarUrl=url;const row=api.toTraders(data,{now:NOW})[0];assert.equal(row.avatarUrl,url);assert.equal(row.accountId,IDS[0]);assert.equal(row.observedAt,stamp);}assert.equal(api.toTraders(sampleCollection())[0].avatarUrl,null);});
test('unknown or unsafe avatar URLs fall back without invalidating trading snapshots',()=>{for(const value of [null,0,'data:image/svg+xml,x','javascript:alert(1)','//public.bnbstatic.com/image/a.png','http://public.bnbstatic.com/image/a.png','https://public.bnbstatic.com.evil/image/a.png','https://public.bnbstatic.com:444/image/a.png','https://x:y@public.bnbstatic.com/image/a.png','https://public.bnbstatic.com/other/a.png','https://public.bnbstatic.com/image/a.png#x','https://static.okx.com/cdn/okex/users/headimages/a.png','https://public.bnbstatic.com/image/a'+String.fromCharCode(0)+'.png']){const data=sampleCollection();data.portfolios[0].profile.avatarUrl=value;assert.equal(api.toTraders(api.parseCollection(data),{now:NOW})[0].avatarUrl,null);}});
test('Aoying public identity avatar never supplies a source feed or a trading timestamp',()=>{const row=api.toTraders(sampleCollection(),{now:NOW}).find(r=>r.referenceOnly);assert.equal(row.avatarUrl,'https://public.bnbstatic.com/image/pgc/202412/e891a1e22f14b5223e15f43c4b195abc.png');assert.equal(row.avatarSourceUrl,'https://www.binance.com/zh-CN/square/profile/god_of_trader_tony');assert.equal(row.binance,null);assert.equal(row.observedAt,null);assert.equal(api.performance(row.binance,'30D').roi,null);assert.equal(Object.hasOwn(api.PORTFOLIOS,row.accountId),false);});
console.log('Binance plaza adapter: ' + passed + ' tests passed');
