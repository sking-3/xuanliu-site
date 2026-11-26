'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../us-selection.js');

const snapshot = {
  schema: 'books.us.selection.v1', asOf: '2026-11-25',
  source: { id: 'tickflow-free-us-forward-v1', sourceTimeKind: 'scheduled_regular_close', sourceTime: '2026-11-25T21:00:00Z', fetchedAt: '2026-11-26T00:00:00Z' },
  tracking: { observations: 2, matured3: 2, maturedTriggered3: 1, meanTriggeredReturn3Percent: 3 },
  short: { rows: [
    { symbol: 'FIRST', name: 'First Company', close: 20, rule: 'breakout', status: 'B', metrics: { dollarVolume20Proxy: 30e6, excess20Percent: 5 }, triggerFollowup: { status: 'tracking', referenceDate: '2026-11-20', referenceClose: 18, firstSeenAt: '2026-11-21T01:00:00Z', horizons: { 1: { status: 'ready', returnPercent: 1 }, 2: { status: 'ready', returnPercent: 2 }, 3: { status: 'ready', returnPercent: 3, maxAdversePercent: -2, maxCloseDrawdownPercent: -1 }, 5: { status: 'pending' }, 15: { status: 'pending' } } }, followup: { referenceDate: '2026-11-19', referenceClose: 10, firstSeenAt: '2026-11-20T01:00:00Z', horizons: { 1: { status: 'ready', returnPercent: 99 } } } },
    { symbol: 'SECOND', name: 'Second Company', close: 15, rule: 'pullback', status: 'waiting', metrics: { dollarVolume20Proxy: 20e6, excess20Percent: -2 } },
    { symbol: 'THIRD', name: 'Third Company', close: 12, rule: 'breakout', status: 'waiting', hits: [{ rule: 'pullback' }], maxEntry: 11, metrics: { dollarVolume20Proxy: 40e6, excess20Percent: 8 }, triggerFollowup: { status: 'not_triggered', referenceDate: null, referenceClose: null, firstSeenAt: null, horizons: {} }, followup: { referenceDate: '2026-11-19', referenceClose: 10, firstSeenAt: '2026-11-20T01:00:00Z', horizons: { 1: { status: 'ready', returnPercent: 77 } } } },
    { symbol: 'ILLIQUID', name: 'Thin Stock', close: 10, rule: 'breakout', status: 'waiting', metrics: { dollarVolume20Proxy: 9e6, excess20Percent: 10 } }
  ] },
  fundamentals: { rows: [
    { symbol: 'LOW', name: 'Low Multiple', status: 'candidate', financialPassed: true, valuationStatus: 'low_multiple', asOf: '2026-09-30', filedAt: '2026-10-28', metrics: { pe: 10, fcfYield: 9, normalizedPe: 12, normalizedFcfYield: 8, netDebtToFcf: 2 } },
    { symbol: 'EXPENSIVE', name: 'Expensive', status: 'excluded', financialPassed: true, valuationStatus: 'not_low', metrics: { pe: 18, fcfYield: 5, normalizedPe: 35, normalizedFcfYield: 2, netDebtToFcf: 1 } },
    { symbol: 'UNKNOWN', name: 'Price Missing', status: 'pending', financialPassed: true, valuationStatus: 'pending', metrics: { pe: null, fcfYield: null, normalizedPe: 80, normalizedFcfYield: .1, netDebtToFcf: 1 }, reasons: [{ message: '来源价格待核' }] }
  ] },
  dca: { rows: [
    { symbol: 'BROAD', kind: 'etf', status: 'candidate', metrics: { expenseRatio: .03 }, reasons: [{ message: '完整风险说明应在详情中保留' }] },
    { symbol: 'COSTLY', kind: 'etf', status: 'candidate', metrics: { expenseRatio: .75 } },
    { symbol: 'DURABLE', kind: 'stock', status: 'candidate', metrics: { annualProfitYears: 5 } },
    { symbol: 'NEW', kind: 'stock', status: 'pending', metrics: { annualProfitYears: 1 } }
  ] }
};
snapshot.short.rows[0].reasons = ['固定规则技术观察；尚无独立滚动验证优势', '普通股交易资格尚未独立核验', '免费源历史复权因子明细不可逐笔核验'];

assert.equal(ui.validateSnapshot(snapshot), snapshot);
assert.throws(() => ui.validateSnapshot({ ...snapshot, schema: 'old' }));
assert.throws(() => ui.validateSnapshot({ ...snapshot, short: { rows: [{ name: 'missing symbol' }] } }));

const state = ui.initialState();
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['FIRST', 'THIRD']);
const exactTurnover = structuredClone(snapshot);
exactTurnover.short.rows[3].metrics.dollarVolume20 = 11e6;
assert.ok(ui.filterRows(exactTurnover, state).some(row => row.symbol === 'ILLIQUID'), 'prefer provider turnover over close-times-volume proxy');
state.minStrength = -5;
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['FIRST', 'SECOND', 'THIRD']);
state.strategy = 'pullback';
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['SECOND', 'THIRD']);
state.shortStatus = 'overextended';
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['THIRD']);
state.search = 'second';
assert.equal(ui.filterRows(snapshot, state).length, 0);
state.shortStatus = ''; state.search = 'second';
assert.equal(ui.filterRows(snapshot, state)[0].symbol, 'SECOND');

Object.assign(state, ui.initialState(), { mode: 'value' });
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['LOW']);
state.valueStatus = '';
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['LOW', 'EXPENSIVE', 'UNKNOWN']);
state.valueStatus = 'low_multiple';
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['LOW']);
state.valueStatus = 'pending';
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['UNKNOWN']);
state.valueStatus = 'excluded';
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['EXPENSIVE'], 'excluded browsing does not reapply candidate numeric gates');
state.valueStatus = ''; state.valuePe = 40; state.valueFcf = 0;
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['LOW', 'EXPENSIVE', 'UNKNOWN']);
assert.deepEqual(ui.reviewCounts(snapshot, 'value'), { candidate: 1, pending: 1, excluded: 1, all: 3 });

Object.assign(state, ui.initialState(), { mode: 'dca' });
assert.equal(state.dcaStatus, 'candidate');
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['BROAD', 'DURABLE']);
state.strategy = 'etf';
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['BROAD']);
state.dcaFee = 1;
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['BROAD', 'COSTLY']);
Object.assign(state, ui.initialState(), { mode: 'dca', dcaStatus: 'pending' });
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['NEW'], 'pending long-term records remain visible despite candidate history thresholds');
state.dcaStatus = '';
assert.deepEqual(ui.filterRows(snapshot, state).map(row => row.symbol), ['BROAD', 'COSTLY', 'DURABLE', 'NEW']);
assert.equal(ui.percent(.06), '0.06%');
assert.equal(ui.percent(5, true), '+5%');
assert.equal(ui.percent(null), '待形成');
assert.equal(ui.number(null), '—');
assert.equal(ui.shortStatus({ status: 'B', phase: 'tracking', isNewB: false }), 'tracking', 'historical B remains tracking rather than a new B');
assert.equal(ui.shortStatus({ status: 'B', phase: 'current_B', isNewB: true }), 'triggered');

assert.deepEqual(ui.paginate([1, 2, 3], 'all', 20), { rows: [1, 2, 3], page: 1, pages: 1, total: 3 });
assert.deepEqual(ui.paginate(Array.from({ length: 26 }, (_, index) => index), '12', 9), { rows: [24, 25], page: 3, pages: 3, total: 26 });
assert.equal(ui.chartUrl('/api/us-selection/chart?symbol=FIRST&window=60', 'FIRST', 120), '/api/us-selection/chart?symbol=FIRST&window=120');
assert.equal(ui.chartUrl('https://other.example/api/us-selection/chart?symbol=FIRST', 'FIRST', 60), null);
assert.equal(ui.chartUrl('/api/us-selection/chart?symbol=OTHER', 'FIRST', 60), null);
assert.equal(ui.chartUrl('/api/us-selection/chart?symbol=FIRST', 'FIRST', 999), null);
assert.equal(ui.sourceUrl('javascript:alert(1)'), null);
assert.equal(ui.sourceUrl('https://user:password@example.com/'), null);
assert.equal(ui.sourceUrl('https://www.sec.gov/Archives/'), 'https://www.sec.gov/Archives/');
assert.ok(ui.taskParts({ status: 'collecting', processed: 50, expected: 200, phase: 'daily_bars', message: '采集中' }).includes('50/200'));
assert.ok(ui.taskParts({ status: 'computing', progress: { processed: 3, total: 10, phase: 'tracking' } }).includes('阶段 后续跟踪'));
assert.ok(ui.taskParts({ status: 'error', error: 'HTTP 503' }).includes('失败原因 HTTP 503'));
const idleParts = ui.taskParts({ status: 'idle', processed: 0, expected: 0, error: '保留旧失败记录' });
assert.ok(idleParts.includes('任务 已有最新批次'));
assert.ok(!idleParts.includes('0/0'));
assert.ok(idleParts.includes('失败原因 保留旧失败记录'));
assert.equal(ui.etfLabel('dividend_quality'), '红利风格ETF');
assert.equal(ui.etfLabel('broad_equity'), '宽基ETF');
assert.equal(ui.etfLabel('unknown'), 'ETF研究');
assert.equal(ui.valueLabel({ valuationStatus: 'low_multiple', status: 'candidate', financialPassed: true }), '低倍数候选');
assert.equal(ui.valueLabel({ valuationStatus: 'low_multiple', status: 'pending', financialPassed: false }), '资料待核');
assert.equal(ui.valueLabel({ valuationStatus: 'not_low', status: 'pending', financialPassed: false }), '资料待核');
assert.equal(ui.valueLabel({ valuationStatus: 'low_multiple', status: 'excluded', financialPassed: false }), '低倍数 · 财务未通过');
assert.equal(ui.sourceTimeLabel({ id: 'tickflow-free-us-forward-v1' }), '收盘时点');
assert.equal(ui.sourceTimeLabel({ sourceTimeKind: 'scheduled_regular_close' }), '收盘时点');
assert.equal(ui.sourceTimeLabel({}), '源时间');
const failedFinancials = structuredClone(snapshot);
failedFinancials.fundamentals.rows[0].financialPassed = false;
failedFinancials.fundamentals.rows[0].status = 'pending';
assert.equal(ui.filterRows(failedFinancials, { ...ui.initialState(), mode: 'value', valueStatus: 'low_multiple' }).length, 0, 'low multiple alone does not pass full candidate conditions');
const partialFinancials = ui.taskParts({ status: 'ready', fundamentalsStatus: 'partial', fundamentalsFailures: [{ source: 'SEC', reason: 'HTTP 403' }] });
assert.ok(partialFinancials.includes('任务 已完成'));
assert.ok(partialFinancials.includes('公开财报部分失败 · 1项'));
assert.ok(partialFinancials.includes('SEC：HTTP 403'));

const html = fs.readFileSync(path.join(__dirname, '../us.html'), 'utf8');
const oldHtml = require('node:child_process').execFileSync('git', ['show', 'HEAD:us.html'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
const csp = body => body.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)[0];
assert.equal(csp(html), csp(oldHtml), 'existing CSP remains byte-identical');
for (const id of ['us-issuer-refresh', 'us-issuer-status', 'us-issuer-body', 'review-rows', 'review-picker', 'research-file', 'back-page', 'next-page']) assert.ok(html.includes('id="' + id + '"'), 'preserve existing feature hook ' + id);
for (const mode of ['short', 'value', 'dca']) {
  assert.ok(html.includes('id="us-tab-' + mode + '"'));
  assert.ok(html.includes('id="us-panel-' + mode + '"'));
}
assert.ok(html.includes('value="all">全部展示'));
assert.ok(html.indexOf('id="us-selection"') < html.indexOf('class="stock-public-market"'));
assert.ok(html.includes('auth.html?next=us.html'));
assert.ok(html.includes('value="low_multiple" selected>低倍数候选'));
assert.ok(html.includes('value="candidate" selected>条件通过'));
const js = fs.readFileSync(path.join(__dirname, '../us-selection.js'), 'utf8');
assert.ok(!js.includes('localStorage'), 'private results are not persisted in browser storage');
assert.ok(!js.includes('innerHTML'), 'external company text uses DOM text nodes');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.value = ''; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  focus() { this.focused = true; }
}

async function stateFlow() {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag) };
  let fail = false, unauthorized = false;
  const requests = [];
  const env = {
    document, setTimeout, clearTimeout,
    fetch: async url => {
      requests.push(url);
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ status: 'ready', completed: 4, total: 4, fundamentalsStatus: 'partial', fundamentalsFailures: [{ source: 'SEC', reason: 'HTTP 403' }] }) };
      if (fail) throw Error('network unavailable');
      if (unauthorized) return { ok: false, status: 401 };
      return { ok: true, json: async () => structuredClone(snapshot) };
    }
  };
  const app = ui.mount(env);
  await app.ready;
  app.state.snapshot.fundamentals.rows.push({ symbol: 'FIRST', name: 'First Company', status: 'pending', valuationStatus: 'pending', financialPassed: false, metrics: {}, reasons: [{ message: '财报字段待核' }] });
  const currentTab = elements.get('us-tab-short'); currentTab.dataset.usTab = 'short';
  elements.get('us-selection').listeners.click({ target: { closest: () => currentTab } });
  assert.equal(app.state.phase, 'ready');
  assert.equal(elements.get('us-short-results').children.length, 2);
  assert.ok(elements.get('us-selection-source').textContent.includes('4/4'));
  assert.ok(elements.get('us-selection-source').textContent.includes('公开财报部分失败'));
  assert.ok(elements.get('us-selection-source').textContent.includes('SEC：HTTP 403'));
  assert.ok(elements.get('us-selection-source').textContent.includes('收盘时点'));
  assert.ok(!elements.get('us-selection-source').textContent.includes('源时间'));
  assert.ok(elements.get('us-short-results').textContent.includes('收盘时点'));
  app.state.snapshot.short.rows[0].close = 281.34;
  elements.get('us-selection-search').listeners.input({ target: { value: 'FIRST' } });
  elements.get('us-short-status').listeners.change({ target: { type: 'select-one', value: 'triggered' } });
  assert.equal(elements.get('us-short-results').children.length, 1);
  const priceInput = elements.get('us-min-price');
  Object.assign(priceInput, { type: 'number', value: '300', validity: { valid: true } });
  priceInput.listeners.input?.({ target: priceInput });
  assert.equal(app.state.minPrice, 300, 'typing a valid price updates the filter without relying on blur/change');
  assert.ok(elements.get('us-selection-count').textContent.startsWith('0只'), 'prices below the entered minimum disappear immediately');
  priceInput.value = '5';
  priceInput.listeners.input?.({ target: priceInput });
  assert.equal(app.state.minPrice, 5);
  assert.equal(elements.get('us-short-results').children.length, 1, 'restoring the valid minimum preserves search and status filters');
  elements.get('us-selection-search').listeners.input({ target: { value: '' } });
  elements.get('us-short-status').listeners.change({ target: { type: 'select-one', value: '' } });
  assert.equal(elements.get('us-short-results').children.length, 2, 'clearing search and status restores all matching rows');
  priceInput.value = '';
  priceInput.listeners.input?.({ target: priceInput });
  assert.equal(app.state.minPrice, 5, 'unfinished empty input does not change the last valid threshold');
  priceInput.value = '5';
  const firstCard = elements.get('us-short-results').children[0];
  const visibleCopy = firstCard.children.filter(child => child.tagName !== 'details').map(child => child.textContent).join('');
  assert.ok(!visibleCopy.includes('普通股交易资格尚未独立核验'), 'repeated technical checks stay out of the main chart area');
  assert.ok(visibleCopy.includes('未验证'), 'the concise research qualification remains visible');
  assert.ok(visibleCopy.includes('B 买入参考 >'));
  assert.ok(visibleCopy.includes('S 卖出参考 <'));
  assert.ok(firstCard.children.find(child => child.tagName === 'details').textContent.includes('普通股交易资格尚未独立核验'), 'technical checks remain available inside the existing details');
  assert.ok(firstCard.children.find(child => child.tagName === 'details').textContent.includes('财报字段待核'), 'matched financial checks are preserved alongside the short-rule checks');
  const firstTracking = firstCard.children.find(child => child.className === 'us-selection-tracking');
  assert.ok(firstTracking.textContent.includes('B后3个交易日+3%'));
  assert.ok(firstTracking.textContent.includes('B后15个交易日待形成'));
  assert.ok(!firstTracking.textContent.includes('+99%'), 'first-observation return is not presented as a B-trigger return');
  assert.ok(firstCard.textContent.includes('首次观察后复盘 · 非B触发口径'));
  assert.ok(firstCard.textContent.includes('观察后1个交易日+99%'));
  const waitingCard = elements.get('us-short-results').children[1];
  const waitingTracking = waitingCard.children.find(child => child.className === 'us-selection-tracking');
  assert.equal(waitingTracking.textContent, 'B尚未触发，收益待形成。触发样本0条。');
  assert.ok(!waitingTracking.textContent.includes('+77%'));
  assert.ok(elements.get('us-short-context').textContent.includes('观察后3日成熟2条'));
  assert.ok(elements.get('us-short-context').textContent.includes('B触发后3日成熟1条'));
  assert.deepEqual(requests, ['/api/us-selection/snapshot', '/api/us-selection/state']);
  const valueTab = elements.get('us-tab-value'); valueTab.dataset.usTab = 'value';
  elements.get('us-selection-search').listeners.input({ target: { value: 'FIRST' } });
  app.state.valuePe = 15;
  elements.get('us-selection').listeners.click({ target: { closest: () => valueTab } });
  assert.equal(app.state.search, '', 'switching workspaces clears the previous stock query');
  assert.equal(elements.get('us-selection-search').value, '');
  assert.equal(app.state.valuePe, 15, 'workspace switching preserves numeric conditions');
  assert.ok(elements.get('us-value-results').textContent.includes('财报期／TTM截至 2026-09-30'));
  assert.ok(elements.get('us-value-results').textContent.includes('财报公开 2026-10-28'));
  const statusClick = value => {
    const button = elements.get('us-value-results').children[0].children.find(child => child.dataset.usReviewStatus === value);
    assert.ok(button, 'status category exists: ' + value);
    elements.get('us-selection').listeners.click({ target: { closest: selector => selector === '[data-us-review-status]' ? button : null } });
  };
  app.state.snapshot.fundamentals.rows.find(row => row.symbol === 'UNKNOWN').valuationStatus = 'not_low';
  statusClick('pending');
  assert.equal(app.state.valueStatus, 'pending');
  assert.equal(elements.get('us-value-status').value, 'pending');
  assert.ok(elements.get('us-value-results').textContent.includes('UNKNOWN'));
  assert.ok(elements.get('us-value-results').textContent.includes('来源价格待核'));
  const pendingRow = elements.get('us-value-results').children.find(child => child.dataset.usSymbol === 'UNKNOWN');
  assert.equal(pendingRow.children.find(child => child.className === 'us-research-status').textContent, '资料待核');
  assert.ok(pendingRow.children.find(child => child.tagName === 'details').textContent.includes('估值核验：未达低倍数条件。'), 'valuation results remain in details without replacing the pending status');
  statusClick('excluded');
  assert.ok(elements.get('us-value-results').textContent.includes('EXPENSIVE'));
  statusClick('');
  assert.ok(elements.get('us-value-results').textContent.includes('LOW'));
  assert.ok(elements.get('us-value-results').textContent.includes('EXPENSIVE'));
  assert.ok(elements.get('us-value-results').textContent.includes('UNKNOWN'));
  const dcaTab = elements.get('us-tab-dca'); dcaTab.dataset.usTab = 'dca';
  elements.get('us-selection').listeners.click({ target: { closest: () => dcaTab } });
  const groups = elements.get('us-dca-results').children.filter(child => child.className === 'us-review-group');
  assert.equal(groups.length, 2);
  assert.ok(groups[0].textContent.includes('基金定投'));
  assert.ok(groups[1].textContent.includes('个股长期观察'));
  const etf = groups[0].children[1];
  assert.ok(!etf.children.filter(child => child.tagName !== 'details').map(child => child.textContent).join('').includes('完整风险说明应在详情中保留'));
  assert.ok(etf.children.find(child => child.tagName === 'details').textContent.includes('完整风险说明应在详情中保留'));
  const shortTab = elements.get('us-tab-short'); shortTab.dataset.usTab = 'short';
  elements.get('us-selection').listeners.click({ target: { closest: () => shortTab } });
  const old = app.state.snapshot;
  fail = true;
  await app.refresh();
  assert.equal(app.state.snapshot, old, 'failed reads preserve last successful result');
  assert.ok(elements.get('us-selection-source').textContent.includes('保留当前已完成结果'));
  fail = false; unauthorized = true;
  await app.refresh();
  assert.equal(app.state.snapshot.short.requiresAuth, true);
  assert.equal(elements.get('us-short-access').hidden, false);
  assert.ok(elements.get('us-short-results').textContent.includes('登录'));
  elements.get('us-selection').listeners.click({ target: { closest: () => valueTab } });
  assert.equal(app.state.mode, 'value');
  assert.equal(elements.get('us-panel-value').hidden, false);
  assert.equal(elements.get('us-panel-short').hidden, true);
  console.log('US selection UI: filters, ratio units, pending evidence, pagination, chart routes, retained results, auth state and legacy/CSP checks passed.');
}

stateFlow().catch(error => { console.error(error); process.exitCode = 1; });
