'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');

async function run(source, html) {
  const moduleStub = { exports: {} };
  vm.runInNewContext(source, { module: moduleStub, URL, Date, Set, Object, console }, { filename: 'monitor.js' });
  const api = moduleStub.exports;
  const now = Date.parse('2026-11-10T12:00:00Z');
  const stamp = new Date(now - 60000).toISOString();
  const base = () => ({
    schemaVersion: 1, sourceType: 'copy_trade', portfolioId: api.PORTFOLIO_ID,
    profile: { id: api.PORTFOLIO_ID, name: '爱喝快乐肥宅水', status: 'ACTIVE', visibility: 'public', sourceUrl: 'https://www.binance.com/en/copy-trading/lead-details/' + api.PORTFOLIO_ID },
    generatedAt: stamp, source: { status: 'ready', lastAttemptAt: stamp, lastSuccessAt: stamp, errorCode: null, refreshStopped: false },
    snapshot: { observedAt: stamp, complete: true, rawCount: 1, positions: [{ key: 'BTCUSDT:LONG', symbol: 'BTCUSDT', side: 'LONG', quantity: '0.00000001', entryPrice: '100.01', markPrice: '101.00', leverage: 3, unrealizedPnl: '0', collateral: 'USDT' }] },
    observations: [{ id: 'base', kind: 'baseline', symbol: 'BTCUSDT', side: 'LONG', from: null, to: stamp, before: null, after: '0.00000001' }],
    history: {
      orders: { status: 'ready', fetchedAt: stamp, errorCode: null, complete: false, rows: [{ symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', executedQty: '0.00000001', avgPrice: '100.01', totalPnl: '0', orderTime: now - 60000, orderUpdateTime: now - 60000 }] },
      closedPositions: { status: 'ready', fetchedAt: stamp, errorCode: null, complete: false, rows: [{ symbol: 'BTCUSDT', side: 'LONG', opened: now - 600000, closed: now - 120000, avgCost: '99', avgClosePrice: '100', closingPnl: '1', closedVolume: '1', status: 'CLOSED', leverage: '3' }] }
    }
  });
  let count = 0;
  const check = (name, fn) => { fn(); count++; console.log('ok ' + count + ' - ' + name); };
  check('accept known source identity and complete fresh snapshot', () => {
    const view = api.viewModel(base(), now, false);
    assert.equal(view.state, 'ready'); assert.equal(view.positions[0].quantity, '0.00000001');
  });
  check('reject another portfolio and schema version', () => {
    const data = base(); data.portfolioId = '5075281354358777856';
    assert.throws(() => api.parseFeed(data), /SNAPSHOT_SCHEMA/);
    data.portfolioId = api.PORTFOLIO_ID; data.schemaVersion = 2;
    assert.throws(() => api.parseFeed(data), /SNAPSHOT_SCHEMA/);
  });
  check('data ages out locally after 30 minutes', () => {
    assert.equal(api.viewModel(base(), now + api.MAX_AGE, false).state, 'stale');
    const data = base(); data.snapshot.observedAt = new Date(now + 600000).toISOString();
    assert.equal(api.viewModel(data, now, false).state, 'stale');
  });
  check('source failure and stopped refresh never look current', () => {
    const data = base(); data.source.status = 'unavailable';
    assert.equal(api.viewModel(data, now, false).state, 'stale');
    data.source.status = 'ready'; data.source.refreshStopped = true;
    assert.equal(api.viewModel(data, now, false).state, 'stale');
    assert.equal(api.viewModel(base(), now, true).state, 'stale');
  });
  check('restricted and unknown visibility hide cached sensitive rows', () => {
    for (const visibility of ['restricted', 'unknown']) {
      const data = base(); data.profile.visibility = visibility;
      const view = api.viewModel(data, now, false);
      assert.equal(view.positions, null); assert.equal(view.orders.rows.length, 0);
      assert.equal(view.closed.rows.length, 0); assert.equal(view.observations.length, 0);
    }
    const data = base(); data.source.status = 'restricted';
    assert.equal(api.viewModel(data, now, false).state, 'restricted');
  });
  check('missing, malformed and incomplete snapshots never mean empty', () => {
    for (const mutate of [d => { d.snapshot = null; }, d => { d.snapshot.complete = false; }, d => { d.snapshot.positions[0].quantity = null; }, d => { d.snapshot.rawCount = 0; }]) {
      const data = base(); mutate(data);
      assert.equal(api.viewModel(data, now, false).positions, null);
      assert.equal(api.viewModel(data, now, false).state, 'unavailable');
    }
  });
  check('successful empty snapshot stays distinct from missing data', () => {
    const data = base(); data.snapshot.positions = []; data.snapshot.rawCount = 0;
    const view = api.viewModel(data, now, false);
    assert.equal(view.state, 'ready'); assert.equal(view.positions.length, 0);
    assert.equal(api.viewModel(null, now, false).positions, null);
  });
  check('zero placeholders are filtered without rounding tiny nonzero values', () => {
    const data = base(); data.snapshot.positions[0].quantity = '-0.000';
    assert.equal(api.viewModel(data, now, false).positions.length, 0);
    data.snapshot.positions[0].quantity = '0.' + '0'.repeat(60) + '1';
    assert.equal(api.viewModel(data, now, false).positions.length, 1);
  });
  check('baseline and absent observation wording does not assert execution', () => {
    const item = base().observations[0];
    assert.match(api.changeText(item), /基线.*不作为新开仓/);
    assert.match(api.changeText({ ...item, kind: 'absent', before: '1', after: '0' }), /观察到归零/);
    assert.doesNotMatch(api.changeText({ ...item, kind: 'absent' }), /已平仓|确认成交/);
  });
  check('history ages independently and order sample retains only seven-day window', () => {
    const data = base(); const order = data.history.orders.rows[0];
    data.history.orders.rows.push({ ...order, orderTime: now - 8 * 86400000 });
    let view = api.viewModel(data, now, false);
    assert.equal(view.orders.rows.length, 1);
    view = api.viewModel(data, now + api.MAX_AGE, false);
    assert.equal(view.orders.state, 'stale'); assert.equal(view.closed.state, 'stale');
    data.history.orders.rows[0].executedQty = '';
    assert.equal(api.viewModel(data, now, false).orders.state, 'unavailable');
  });
  check('external or executable source links are not accepted', () => {
    for (const link of ['javascript:alert(1)', 'https://evil.example/', 'https://www.binance.com.evil.example/en/copy-trading/lead-details/' + api.PORTFOLIO_ID, 'https://u:p@www.binance.com/en/copy-trading/lead-details/' + api.PORTFOLIO_ID]) {
      assert.equal(api.sourceUrl(link), base().profile.sourceUrl);
    }
  });
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.text = ''; this.disabled = false; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('Unsafe innerHTML'); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.text = ''; }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    removeEventListener(event) { delete this.listeners[event]; }
  }
  function fakeDoc() {
    const elements = new Map();
    return { visibilityState: 'visible', listeners: {}, createElement: tag => new Element(tag),
      getElementById: id => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); },
      addEventListener(event, callback) { this.listeners[event] = callback; },
      removeEventListener(event) { delete this.listeners[event]; }
    };
  }
  check('DOM renders hostile text literally and empty/stale messages truthfully', () => {
    const doc = fakeDoc(), data = base();
    data.profile.name = '<img src=x onerror=alert(1)>';
    data.snapshot.positions[0].symbol = '<script>alert(1)</script>';
    api.render(doc, data, now, false);
    assert.equal(doc.getElementById('trader-name').textContent, data.profile.name);
    assert.match(doc.getElementById('positions-body').textContent, /<script>/);
    data.snapshot.positions = []; data.snapshot.rawCount = 0;
    api.render(doc, data, now, false);
    assert.match(doc.getElementById('positions-body').textContent, /该次完整快照未见非零仓位/);
    api.render(doc, data, now, true);
    assert.match(doc.getElementById('positions-body').textContent, /当前状态未知/);
    data.profile.visibility = 'restricted';
    api.render(doc, data, now, false);
    assert.doesNotMatch(doc.getElementById('positions-body').textContent, /未见非零仓位/);
    assert.equal(doc.getElementById('orders-body').children.length, 1);
  });
  check('CSP and transport prohibit direct exchange fetches and inline code', () => {
    assert.match(html, /connect-src 'self';/);
    assert.match(html, /script-src 'self';/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(source, /\.innerHTML\s*=|eval\s*\(/);
    assert.match(source, /fetch\('\.\/snapshot\.json'/);
    assert.equal(api.POLL_MS, 300000);
  });
  const doc = fakeDoc(), requests = [], intervals = new Map(), timeouts = new Map();
  let nextId = 0, failing = false;
  const env = {
    AbortController,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (failing) throw new Error('offline');
      return { ok: true, text: async () => JSON.stringify(base()) };
    },
    setInterval: (fn, delay) => { const id = ++nextId; intervals.set(id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, delay) => { const id = ++nextId; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout: id => timeouts.delete(id)
  };
  doc.visibilityState = 'hidden';
  const app = api.start(doc, env);
  await app.refresh();
  check('hidden page performs no network calls', () => assert.equal(requests.length, 0));
  doc.visibilityState = 'visible';
  await app.refresh();
  check('visible page fetches only same-origin file without credentials or redirects', () => {
    assert.equal(requests.length, 1); assert.equal(requests[0].url, './snapshot.json');
    assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.redirect, 'error');
    assert.equal(timeouts.size, 0);
  });
  failing = true; await app.refresh();
  check('transport failure preserves prior successful rows and marks stale', () => {
    assert.equal(doc.getElementById('status-badge').dataset.state, 'stale');
    assert.match(doc.getElementById('positions-body').textContent, /BTCUSDT/);
  });
  app.destroy();
  check('destroy cleans timers and event handlers', () => {
    assert.equal(intervals.size, 0);
    assert.equal(Object.keys(doc.listeners).length, 0);
    assert.equal(Object.keys(doc.getElementById('refresh').listeners).length, 0);
  });
  console.log(count + ' Binance UI checks passed.');
  return count;
}
module.exports = { run };
if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  run(fs.readFileSync(path.join(__dirname, '../trader/binance/monitor.js'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '../trader/binance/index.html'), 'utf8')).catch(error => {
    console.error(error); process.exitCode = 1;
  });
}
