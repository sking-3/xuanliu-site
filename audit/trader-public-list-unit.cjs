const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const read = (name) => fs.readFileSync(path.join(__dirname, '../trader', name), 'utf8');
const html = read('index.html');
const script = read('plaza.js');
assert.match(html, /data-public-list="true"/);
assert.match(html, /公开历史快照，不构成跟单建议，不代表未来收益/);
assert.match(read('plaza.css'), /\.public-disclaimer\{position:sticky/);
for (const asset of ['plaza.js', 'plaza.css']) {
  assert.ok(html.includes(asset + '?v=' + createHash('sha256').update(read(asset)).digest('hex').slice(0, 8)));
}

const element = (tag) => ({
  tag, children: [], textContent: '', attrs: {}, namespaceURI: 'http://www.w3.org/2000/svg',
  append(...children) { this.children.push(...children); },
  replaceChildren(...children) { this.children = children; },
  setAttribute(name, value) { this.attrs[name] = value; },
  addEventListener() {},
  querySelectorAll() { return []; },
});
const elements = new Map();
const document = {
  body: { dataset: { publicList: 'true' } },
  createElement: element,
  createElementNS(namespace, tag) { return element(tag); },
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  },
};
for(const [id,value,values] of [
  ['exchange','all',['all','Hyperliquid','Binance','OKX','Bitget']],['period','30D',['7D','30D','90D','180D','365D','ALL']],
  ['sort','roi',['roi','pnl','mdd','winRate','directory']],['source','all',['all']],['currency','all',['all']],['search','',[]]
]){
  Object.assign(document.getElementById(id),{value,options:values.map(value=>({value}))});
}
const location={href:'https://example.test/trader/index.html'};
const history={replaceState(_state,_title,url){location.href=new URL(url,location.href).href;}};
const context = {
  document, URL, location, history,
  BooksOKXPeriodData: { performance: (row, period) => row.performance[period] },
  BooksBitgetPeriodData: { performance: (row, period) => row.performance[period], avatarUrl: () => null },
  BinanceData: {
    recordedPeriod: (row, period) => row?.performance[period] || null,
    performance: () => null,
    chart: () => ({ pointCount: 0, periodSupported:false }),
  },
};
vm.runInNewContext(script.split('for(const id of controls)$(id).addEventListener')[0] +
  'globalThis.sample={publicListCard,publicCardData,publicRank,render,readURL,saveURL,state,validatePortfolioCache,validateWinCache};})();', context);
const { publicListCard, publicCardData, publicRank, render, readURL, saveURL, state, validatePortfolioCache, validateWinCache } = context.sample;
const makeCard=(row,failed=false,period='30D')=>publicListCard(publicCardData(row,period),period,failed);
const cut = '2026-11-16T12:00:00Z';
const children = (node) => [node, ...node.children.flatMap(children)];
const content = (node) => children(node).map((item) => item.textContent).join(' ');
const fields = (card) => Object.fromEntries(children(card).filter((item) => item.children[0]?.tag === 'dt')
  .map((item) => [item.children[0].textContent, item.children[1].textContent]));
const hl = { id:'hl', name: '示例公开钱包', accountId: '0x' + '1'.repeat(40), exchange: 'Hyperliquid', currency: 'USD', sourceKind: 'public_account',
  windows: { '30D': { roi: 0, pnl: 123.45, mdd: null, asOf: cut, asOfType: 'source', sourcePeriod: 'month', coverageDays: 21 } } };
const okx = { id:'okx', name: '示例 OKX', exchange: 'OKX', sourceKind: 'okx_public_lead', okxRecord: { leadDays: 120,
  performance: { '30D': { roi: 2, mdd: null, beginTs: Date.parse('2026-10-17T12:00:00Z'), endTs: Date.parse(cut), lastSuccessAt: cut } } } };
const bitget = { id:'bitget', name: '示例 Bitget', exchange: 'Bitget', sourceKind: 'bitget_public_lead', bitgetRecord: { leadDays: 180,
  performance: { '30D': { roi: 1, pnl: 0, mdd: 0, winRate: 0, currency: 'USD', lastSuccessAt: cut,
    curve: [{time: '2026-10-01T00:00:00Z', value: 0}, {time: cut, value: 1}] } } } };
const binance = { id:'binance', name: '示例 Binance', exchange: 'Binance', sourceKind: 'copy_trade', periodRecord: {
  performance: { '90D': { roi: 5, pnl: 55, mdd: 3, winRate: 62.5, currency: 'USDT', status: 'stale', lastSuccessAt: cut, accountAgeDays: 120 } } } };

const hlCard = makeCard(hl);
assert.match(content(hlCard), /30D 来源收益率.*0\.00%/);
const detailLink = children(hlCard).find(item=>item.className==='public-detail-trigger');
assert.match(detailLink.href,/account=0x1+&detailExchange=Hyperliquid&detailPeriod=30D/);
assert.equal(children(hlCard).find((item) => item.className === 'public-return-label').textContent, '30D 来源收益率');
assert.equal(fields(hlCard)['来源盈亏'], '+123.45 USD');
assert.equal(fields(hlCard)['来源回撤'], undefined);
assert.match(content(hlCard), /数据说明.*来源最大回撤、带单天数、来源业绩统计区间 · 该来源未提供.*来源时间/);
const okxCard=makeCard(okx);
assert.equal(fields(okxCard)['来源回撤'], undefined);
assert.match(content(okxCard), /带单 120 天.*来源业绩统计区间 2026.* 至 2026/);
const bitgetCard = makeCard(bitget,true);
assert.equal(fields(bitgetCard)['来源回撤'], '0.00%');
assert.equal(fields(bitgetCard)['来源胜率'], '0.00%');
assert.equal(fields(bitgetCard)['来源盈亏'], '0 USD');
assert.match(content(bitgetCard), /带单 180 天.*采集时间.*读取失败，保留上次有效资料/);
assert.equal(children(bitgetCard).filter((item) => item.tag === 'svg').length, 1);
const binanceCard = makeCard(binance,false,'90D');
assert.equal(children(binanceCard).find((item) => item.className === 'public-return-label').textContent, '90D 来源收益率');
assert.equal(fields(binanceCard)['来源回撤'], '3.00%');
assert.equal(fields(binanceCard)['来源盈亏'], '+55 USDT');
assert.equal(fields(binanceCard)['来源胜率'], '62.50%');
assert.match(content(binanceCard), /业绩曲线.*该周期曲线未接入.*历史快照/);
assert.match(content(makeCard(binance)), /30D 来源收益率.*该周期暂无业绩/);

// The leaderboard return and the independently sampled PnL must keep their own
// values and dates, even when both are available for the same displayed period.
const startAt = '2026-10-17T12:00:00Z';
const middleAt = '2026-11-01T12:00:00Z';
const window = {
  derived: false, sourcePeriod: 'perpMonth', scope: 'perp_account', curveUnit: 'USD',
  curveBasis: 'pnl_change_from_first_sample', mddUnit: 'percent',
  mddMethod: 'hyperliquid_ui_pnl_peak_equity', requestedDays: null,
  coverageStatus: 'source_window', startAt, endAt: cut, requestedStartAt: null,
  requestedEndAt: cut, sourceHistoryStartAt: startAt, sourceHistoryEndAt: cut,
  sampleCount: 3, sourceSampleCount: 3, mddPairedSampleCount: 3,
  pnl: 50, mdd: 4.5, mddUnavailableReason: null, coverageDays: 30,
  maxSampleGapMs: 15 * 86400000,
  points: [{time: startAt, value: 0}, {time: middleAt, value: -25}, {time: cut, value: 50}],
};
state.portfolioCache = validatePortfolioCache({
  schemaVersion: 1, methodVersion: 'portfolio-periods-v2', generatedAt: cut,
  accounts: {[hl.accountId]: {status: 'ready', fetchedAt: cut, lastAttemptAt: cut,
    errorCode: null, portfolio: {windows: {'30D': window}}}},
}).accounts;
state.winCache = validateWinCache({
  schemaVersion: 1, methodVersion: 'closing-fill-v1', generatedAt: cut,
  accounts: {[hl.accountId]: {status: 'ready', fetchedAt: cut, lastAttemptAt: cut, errorCode: null,
    win: {method: 'closing_fill_net_of_closing_fee', scope: 'default_perp_dex', unit: 'percent',
      feeToken: 'USDC', historyComplete: false, includesOpeningFees: false, includesFunding: false,
      capped: false, winning: 2, losing: 1, breakeven: 0, eligibleCount: 3,
      totalFills: 4, receivedFills: 4, duplicateCount: 0, excludedCount: 1,
      value: 200 / 3, startAt, endAt: cut, sourceSampleStartAt: startAt, sourceSampleEndAt: cut}}},
}).accounts;
const restoredCard = makeCard(hl);
const restoredFields = fields(restoredCard);
assert.equal(restoredFields['来源盈亏'], '+123.45 USD');
assert.equal(restoredFields['来源回撤'], undefined);
assert.equal(restoredFields['采样回撤'], '4.50%');
assert.equal(restoredFields['片段胜率'], '66.67%');
assert.match(content(restoredCard), /盈亏采样 2026.* 至 2026.*3 点.*末点 50 USD/);
assert.match(content(restoredCard), /3 笔近期永续平仓片段，独立于所选表现周期/);
assert.equal(children(restoredCard).filter((item) => item.tag === 'svg').length, 1);
state.portfolioCacheReadFailed = true;
state.winCacheReadFailed = true;
const failedSamples = makeCard(hl);
assert.equal(fields(failedSamples)['采样回撤'], '4.50%');
assert.equal(fields(failedSamples)['片段胜率'], '66.67%');
assert.match(content(failedSamples), /盈亏采集 .*本次读取失败，保留上次有效值/);
assert.match(content(failedSamples), /本次成交快照读取失败/);
assert.match(script, /const winRequest=refreshWinCache\(\),portfolioRequest=refreshPortfolioCache\(\)/);

state.rows = [hl, okx, bitget, binance, { ...hl, _local: true }, { ...hl, paid: true }];
render();
const list = elements.get('leaders');
assert.deepEqual(Array.from(list.children, (card) => content(children(card).find((item) => item.tag === 'h3')).trim()),
  [okx.name, bitget.name, hl.name, binance.name]);
assert.equal(children(list).some((item) => ['button', 'dialog', 'select'].includes(item.tag)), false);
state.lastReadFailed = true;
render();
assert.match(elements.get('public-list-status').textContent, /Hyperliquid.*读取失败/);
assert.equal(list.children.length, 4);
assert.match(content(elements.get('public-platform-status')), /Hyperliquid · 读取失败，保留历史资料/);
assert.match(elements.get('public-workflow-note').textContent, /未取得后台采集任务记录/);
assert.match(content(restoredCard), /数据说明.*末点 50 USD.*峰值时的永续账户权益.*仅扣平仓成交手续费/);
assert.ok(children(restoredCard).some(item => item.tag === 'summary'));
const names=()=>Array.from(list.children,card=>children(card).find(item=>item.tag==='h3')&&content(children(card).find(item=>item.tag==='h3')).trim());
const control=id=>elements.get(id);
control('exchange').value='Hyperliquid';
control('search').value=hl.accountId.toUpperCase();
control('sort').value='winRate';
render();
assert.deepEqual(names(),[hl.name]);
const filteredLink = children(list).find(item=>item.className==='public-detail-trigger');
assert.equal(new URL(filteredLink.href).searchParams.get('q'),hl.accountId.toUpperCase());
assert.equal(new URL(filteredLink.href).searchParams.get('exchange'),'Hyperliquid');
assert.match(content(elements.get('public-platform-status')), /OKX · 历史快照/);
assert.match(control('sort').options.find(option=>option.value==='winRate').textContent,/片段胜率/);
control('exchange').value='Binance';
control('search').value='币安';
control('period').value='90D';
render();
assert.deepEqual(names(),[binance.name]);
saveURL(true);
assert.match(location.href,/period=90D&exchange=Binance&sort=winRate&q=/);
control('search').value='wrong';
readURL();
assert.equal(control('search').value,'币安');
assert.equal(control('period').value,'90D');
control('search').value='找不到';
render();
assert.match(content(list),/没有匹配的账户/);
assert.equal(control('public-pagination').hidden,true);

const entry=(row,record,currency)=>({row,record,currency});
const entries=[entry(binance,{pnl:150},'USDT'),entry(okx,{pnl:200},'USDT'),
  entry(hl,{pnl:0},'USD'),entry(bitget,{pnl:10},'USD'),entry({id:'partial'},{pnl:9000,fullPeriod:false},'USD')];
assert.deepEqual(Array.from(publicRank(entries,'pnl','all'),e=>e.row.id),['bitget','hl','okx','binance','partial']);
assert.deepEqual(Array.from(publicRank([publicCardData(hl,'30D'),publicCardData(bitget,'30D')],'mdd','all'),e=>e.row.id),['bitget','hl']);
state.rows = [];
render();
assert.match(elements.get('public-list-status').textContent, /暂无可用快照/);
console.log('trader public list unit: ok');
