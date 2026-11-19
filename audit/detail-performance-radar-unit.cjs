const test = require('node:test');
const assert = require('node:assert/strict');
const { score, mount, mountPerformance } = require('../trader/detail-performance-radar.js');

const time = Date.parse('2026-11-16T07:36:39Z');
const day = 86_400_000;
const series = values => values.map((value, index) => ({ time: time + index * day, value }));

test('scores finite values on fixed scales and preserves missing provenance and values', () => {
  const axes = score({
    exchange: 'OKX', metrics: {roi: '0', mdd: 160, lastSuccessAt: time},
    winSample: {value: 0, label: '7 个有记录交易日'},
    capital: {aumAmount: 1_000_000, currency: 'USDT'}, leverage: {average: 4, count: 7},
  });
  assert.deepEqual(axes.map(axis => axis.score), [50, 0, 0, 60, null, 85]);
  assert.equal(axes[1].time, time);
  assert.equal(axes[2].time, null);
  assert.equal(axes[2].label, '盈利日比例');
  assert.equal(axes[2].source, '7 个有记录交易日');
  assert.equal(axes[3].time, null);
  assert.equal(axes[5].raw, '4× · 7 笔');
  assert.deepEqual(score({ metrics: {roi: '', winRate: -1, mdd: -1}, capital: {aumAmount: 250000, currency: 'BTC'}, leverage: {average: 4} })
    .map(axis => axis.score), [null, null, null, null, null, null]);
});

test('requires a contiguous observed series for the trend score', () => {
  assert.equal(score({ curve: {points: series([0, 2, 1, 2, 2, 3, 4])} })[4].score, 67);
  assert.equal(score({ curve: {points: series([6, 5, 4, 3, 2, 1, 0])} })[4].score, 0);
  assert.equal(score({ curve: {points: series([0, 0, 0, 0, 0, 0, 0])} })[4].score, null);
  assert.equal(score({ curve: {points: series([0, 2, 1, 2, 2, 3])} })[4].score, null);
  const gapped = series([0, 2, 1, 2, 2, 3, 4]);
  gapped.at(-1).time += 4 * day;
  assert.equal(score({ curve: {points: gapped} })[4].score, null);
  gapped.at(-1).time = gapped.at(-2).time;
  assert.equal(score({ curve: {points: gapped} })[4].score, null);
});

class TestElement {
  constructor(ownerDocument, tag) {
    this.ownerDocument = ownerDocument;
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  get text() { return (this.textContent || '') + this.children.map(child => child.text).join(' '); }
  find(className) {
    const classes = this.className || this.attributes.get('class') || '';
    const matches = classes.split(' ').includes(className) ? [this] : [];
    return matches.concat(this.children.flatMap(child => child.find(className)));
  }
}

const document = {
  createElement: tag => new TestElement(document, tag),
  createElementNS: (_, tag) => new TestElement(document, tag),
};

test('shows measured scores without drawing across missing radar axes', () => {
  const panel = document.createElement('section');
  mount(panel, { metrics: {roi: 10}, winSample: {value: 0, fetchedAt: time, label: '来源样本'}, periodLabel: '30D' });
  assert.equal(panel.find('bdr-point').length, 2);
  assert.equal(panel.find('bdr-area').length, 0);
  assert.equal(panel.find('bdr-edge').length, 0);
  assert.equal(panel.find('bdr-score').filter(row => row.attributes.get('data-available') === 'false').length, 4);
  assert.match(panel.text, /30D/);
  assert.match(panel.text, /2026\/11\/16 15:36/);
  assert.match(panel.text, /0% · 来源样本/);
});

test('partial adjacent metrics use separate stems and distinguish real zero from missing data', () => {
  const panel = document.createElement('section');
  mount(panel, { metrics: {roi: 246.11494238, mdd: 55.076538, winRate: 75}, leverage: {average: 24, count: 1} });
  assert.equal(panel.find('bdr-point').length, 4);
  assert.equal(panel.find('bdr-stem').length, 3);
  assert.equal(panel.find('bdr-axis-missing').length, 2);
  assert.equal(panel.find('bdr-edge').length, 0);
  assert.equal(panel.find('bdr-area').length, 0);
  assert.equal(panel.find('bdr-chart')[0].attributes.get('aria-hidden'), 'true');
  assert.match(panel.find('bdr-meta')[0].text, /4\/6 项已评分/);
  assert.match(panel.find('bdr-score')[0].text, /100 分.*246\.11% · 封顶/);
  assert.match(panel.find('bdr-score')[5].text, /0 分.*24×/);
  assert.match(panel.find('bdr-score')[3].text, /暂无评分/);
});

test('collapses a repeated displayed minute and keeps source and sample timestamps distinct', () => {
  const panel = document.createElement('section');
  const points = series([1, 2, 3, 4, 5, 6, 7]);
  const captured = points.at(-1).time + day;
  mount(panel, {
    exchange: 'Binance', metrics: {roi: 10, lastSuccessAt: captured, sourceAsOf: captured - 180000},
    curve: {points, lastSuccessAt: captured + 12000}
  });
  const headline = panel.find('bdr-meta')[0].text;
  assert.match(headline, /快照 2026\/11\/23 15:36（北京）/);
  assert.equal(headline.match(/15:36/g).length, 1);
  assert.doesNotMatch(headline, /至/);
  const method = panel.find('bdr-method')[0].text;
  assert.match(method, /采集 2026\/11\/23 15:36:39（北京）/);
  assert.match(method, /数据截至 2026\/11\/23 15:33:39（北京）/);
  assert.match(method, /币安原始盈亏采样 · 采集 2026\/11\/23 15:36:51（北京）/);
  assert.match(method, /曲线采样 2026\/11\/16 15:36:39 至 2026\/11\/22 15:36:39（北京）/);
});

test('a different displayed minute shows both snapshot boundaries', () => {
  const panel = document.createElement('section');
  mount(panel, { metrics: {roi: 10, lastSuccessAt: time}, winSample: {value: 75, fetchedAt: time + 90000} });
  assert.match(panel.find('bdr-meta')[0].text, /快照 2026\/11\/16 15:36 至 2026\/11\/16 15:38（北京）/);
});

test('withholds short-window scores while independent assessment inputs and old unknown coverage remain usable', () => {
  const unqualified = {
    exchange: 'Hyperliquid', metrics: {roi: 120, mdd: 25, winRate: 75, fullPeriod: false, accountAgeDays: 10},
    curve: {points: series([1, 2, 3, 4, 5, 6, 7])}, leverage: {average: 4, count: 3},
  };
  const short = score(unqualified);
  assert.deepEqual(short.map(axis => axis.score), [null, null, 75, null, null, 85]);
  assert.deepEqual(short.map(axis => axis.blocked), [true, true, false, false, true, false]);
  assert.equal(short[0].raw, '120%');
  assert.equal(score({ ...unqualified, exchange: 'Binance' })[2].score, null);
  assert.equal(score({ ...unqualified, metrics: {...unqualified.metrics, accountAgeDays: null} })[0].score, 100);
});

test('uses a closed area only with six known axes and omits the chart when all axes are unknown', () => {
  const panel = document.createElement('section');
  mount(panel, {
    metrics: {roi: 10, mdd: 40, winRate: 10}, capital: {aumAmount: 0, currency: 'USDT'},
    leverage: {average: 1, count: 3}, curve: {points: series([1, 2, 3, 4, 5, 6, 7])},
  });
  assert.equal(panel.find('bdr-area').length, 1);
  assert.equal(panel.find('bdr-point').length, 6);

  const empty = document.createElement('section');
  mount(empty);
  assert.equal(empty.find('bdr-chart').length, 0);
  assert.match(empty.text, /暂无可用于评分的资料/);
});


test('a complete performance snapshot renders the same shared card and curve panels', () => {
  const root = document.createElement('section');
  mountPerformance(root, {
    exchange: 'Binance', periodLabel: '30D',
    metrics: {roi: 98.94, mdd: 48.83, winRate: 81.82, lastSuccessAt: time},
    curve: {points: series([0, 2, 1, 2, 2, 3, 4]), lastSuccessAt: time},
    capital: {aumAmount: '8192415.25', fetchedAt: time, currency: 'USDT'},
    leverage: {average: 8, count: 15, fetchedAt: time}
  }, profit => profit.append(document.createElement('canvas')));
  assert.equal(root.find('bdr-radar').length, 1);
  assert.equal(root.find('bdr-area').length, 1);
  assert.match(root.text, /6\/6 项已评分/);
  assert.match(root.find('bdr-score')[0].text, /99 分.*98.94%/);
  assert.equal(root.children[0].children[1].children[0].tag, 'canvas');
});

test('providers update one shared card with their verified curves, preserving source-specific windows', () => {
  for (const exchange of ['OKX', 'Bitget']) {
    const root = document.createElement('section');
    let update;
    mountPerformance(root, {
      exchange, periodLabel: '30D',
      metrics: {roi: 10, winRate: 55, lastSuccessAt: time, winRateEvidence: {lastSuccessAt: time + day}},
      capital: {balance: 12345, currency: 'USDT'}
    }, (_profit, reset) => { update = reset; });
    assert.match(root.text, /2\/6 项已评分/);
    assert.match(root.find('bdr-score')[3].text, /暂无评分/);
    update({points: series([0, 2, 1, 2, 2, 3, 4]), lastSuccessAt: time + day});
    assert.equal(root.find('bdr-radar').length, 1);
    assert.match(root.text, /3\/6 项已评分/);
    assert.match(root.find('bdr-score')[4].text, /67 分/);
    assert.match(root.text, new RegExp(exchange + ' 来源收益率日采样'));
    if (exchange === 'OKX') assert.match(root.find('bdr-score')[2].text, /盈利日比例/);
  }
});

test('the shared empty card matches the common layout without creating a synthetic score', () => {
  const root = document.createElement('section');
  mountPerformance(root, {exchange: 'Binance', periodLabel: '30D'});
  assert.equal(root.find('bdr-radar').length, 1);
  assert.equal(root.find('bdr-chart').length, 0);
  assert.equal(root.find('bdr-score').length, 6);
  assert.match(root.text, /0\/6 项已评分/);
});

test('Hyperliquid shows a separately collected win sample even when the period is short', () => {
  const root = document.createElement('section');
  mountPerformance(root, {
    exchange: 'Hyperliquid', periodLabel: '365D',
    metrics: {roi: 12, mdd: 10, derived: true, coverageStatus: 'insufficient_history'},
    winSample: {value: 55, fetchedAt: time, label: '近期闭合样本'}
  });
  assert.match(root.text, /1\/6 项已评分/);
  assert.match(root.find('bdr-score')[0].text, /覆盖不足/);
  assert.match(root.find('bdr-score')[2].text, /片段胜率 55 分/);
});
