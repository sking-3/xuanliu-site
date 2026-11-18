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
const context = {
  document, URL,
  BooksOKXPeriodData: { performance: (row, period) => row.performance[period] },
  BooksBitgetPeriodData: { performance: (row, period) => row.performance[period], avatarUrl: () => null },
  BinanceData: {
    recordedPeriod: (row, period) => row?.performance[period] || null,
    performance: () => null,
    chart: () => ({ pointCount: 0 }),
  },
};
vm.runInNewContext(script.split('for(const id of controls)$(id).addEventListener')[0] +
  'globalThis.sample={publicListCard,render,state,validatePortfolioCache,validateWinCache};})();', context);
const { publicListCard, render, state, validatePortfolioCache, validateWinCache } = context.sample;
const cut = '2026-11-16T12:00:00Z';
const children = (node) => [node, ...node.children.flatMap(children)];
const content = (node) => children(node).map((item) => item.textContent).join(' ');
const fields = (card) => Object.fromEntries(children(card).filter((item) => item.children[0]?.tag === 'dt')
  .map((item) => [item.children[0].textContent, item.children[1].textContent]));
const hl = { name: '示例公开钱包', accountId: '0x' + '1'.repeat(40), exchange: 'Hyperliquid', currency: 'USD', sourceKind: 'public_account',
  windows: { '30D': { roi: 0, pnl: 123.45, mdd: null, asOf: cut, asOfType: 'source', sourcePeriod: 'month', coverageDays: 21 } } };
const okx = { name: '示例 OKX', exchange: 'OKX', sourceKind: 'okx_public_lead', okxRecord: { leadDays: 120,
  performance: { '30D': { roi: 2, mdd: null, beginTs: Date.parse('2026-10-17T12:00:00Z'), endTs: Date.parse(cut), lastSuccessAt: cut } } } };
const bitget = { name: '示例 Bitget', exchange: 'Bitget', sourceKind: 'bitget_public_lead', bitgetRecord: { leadDays: 180,
  performance: { '30D': { roi: 1, pnl: 0, mdd: 0, winRate: 0, currency: 'USD', lastSuccessAt: cut,
    curve: [{time: '2026-10-01T00:00:00Z', value: 0}, {time: cut, value: 1}] } } } };
const binance = { name: '示例 Binance', exchange: 'Binance', sourceKind: 'copy_trade', periodRecord: {
  performance: { '90D': { roi: 5, pnl: 55, mdd: 3, winRate: 62.5, currency: 'USDT', status: 'stale', lastSuccessAt: cut, accountAgeDays: 120 } } } };

const hlCard = publicListCard(hl, false);
assert.match(content(hlCard), /月度 收益率.*0\.00%/);
assert.equal(children(hlCard).find((item) => item.className === 'public-return-label').textContent, '月度 收益率');
assert.equal(fields(hlCard)['周期盈亏'], '+123.45 USD');
assert.equal(fields(hlCard)['最大回撤'], '该来源未提供');
assert.equal(fields(hlCard)['带单天数'], '该来源未提供');
assert.equal(fields(hlCard)['数据时间范围'], '该来源未提供');
assert.match(content(hlCard), /来源时间/);
const okxFields = fields(publicListCard(okx, false));
assert.equal(okxFields['最大回撤'], '该来源未提供');
assert.equal(okxFields['带单天数'], '120 天');
assert.match(okxFields['数据时间范围'], /2026.* 至 2026/);
const bitgetCard = publicListCard(bitget, true);
assert.equal(fields(bitgetCard)['最大回撤'], '0.00%（来源口径）');
assert.equal(fields(bitgetCard)['来源胜率'], '0.00%');
assert.equal(fields(bitgetCard)['周期盈亏'], '0 USD');
assert.equal(fields(bitgetCard)['带单天数'], '180 天');
assert.equal(fields(bitgetCard)['数据时间范围'], '该来源未提供');
assert.match(content(bitgetCard), /读取失败，保留上次有效值.*采集时间/);
assert.equal(children(bitgetCard).filter((item) => item.tag === 'svg').length, 1);
const binanceCard = publicListCard(binance, false);
assert.equal(children(binanceCard).find((item) => item.className === 'public-return-label').textContent, '90D 收益率');
assert.equal(fields(binanceCard)['最大回撤'], '3.00%（来源口径）');
assert.equal(fields(binanceCard)['周期盈亏'], '+55 USDT');
assert.equal(fields(binanceCard)['来源胜率'], '62.50%');
assert.match(content(binanceCard), /历史快照，待更新/);

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
const restoredCard = publicListCard(hl, false);
const restoredFields = fields(restoredCard);
assert.equal(restoredFields['周期盈亏'], '+123.45 USD');
assert.equal(restoredFields['最大回撤'], '该来源未提供');
assert.equal(restoredFields['采样盈亏回撤'], '4.50%');
assert.equal(restoredFields['平仓片段胜率'], '66.67%');
assert.equal(restoredFields['带单天数'], '该来源未提供');
assert.equal(restoredFields['数据时间范围'], '该来源未提供');
assert.match(content(restoredCard), /2026\/10\/17 至 2026\/11\/16 · 3 个采样点/);
assert.match(content(restoredCard), /近期平仓片段 3 笔 · 独立成交样本/);
assert.equal(children(restoredCard).filter((item) => item.tag === 'svg').length, 1);
state.portfolioCacheReadFailed = true;
state.winCacheReadFailed = true;
const failedSamples = publicListCard(hl, false);
assert.equal(fields(failedSamples)['采样盈亏回撤'], '4.50%');
assert.equal(fields(failedSamples)['平仓片段胜率'], '66.67%');
assert.match(content(failedSamples), /盈亏采样采集于 .*本次读取失败，保留上次有效值/);
assert.match(content(failedSamples), /近期平仓片段 .*本次读取失败，保留上次有效值/);
assert.match(script, /const winRequest=refreshWinCache\(\),portfolioRequest=refreshPortfolioCache\(\)/);

state.rows = [hl, okx, bitget, binance, { ...hl, _local: true }, { ...hl, paid: true }];
render();
const list = elements.get('leaders');
assert.deepEqual(Array.from(list.children, (card) => children(card).find((item) => item.tag === 'h3').textContent),
  [hl.name, okx.name, bitget.name, binance.name]);
assert.equal(children(list).some((item) => ['button', 'dialog', 'select'].includes(item.tag)), false);
state.lastReadFailed = true;
render();
assert.match(elements.get('public-list-status').textContent, /Hyperliquid.*读取失败/);
assert.equal(list.children.length, 4);
state.rows = [];
render();
assert.match(elements.get('public-list-status').textContent, /暂无可用快照/);
console.log('trader public list unit: ok');
