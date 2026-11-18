const test = require('node:test');
const assert = require('node:assert/strict');
const { score, mount } = require('../trader/detail-performance-radar.js');

const time = Date.parse('2026-11-16T07:36:39Z');
const day = 86_400_000;
const series = values => values.map((value, index) => ({ time: time + index * day, value }));

test('scores finite values on fixed scales and preserves missing provenance and values', () => {
  const axes = score({
    roi: '0', mdd: 160, winRate: 0, winAxisLabel: '盈利日比例', winLabel: '7 个有记录交易日',
    aum: 1_000_000, currency: 'USDT', leverage: 4, leverageCount: 7, metricsAt: time, winAt: null,
  });
  assert.deepEqual(axes.map(axis => axis.score), [50, 0, 0, 60, null, 85]);
  assert.equal(axes[1].time, time);
  assert.equal(axes[2].time, null);
  assert.equal(axes[2].label, '盈利日比例');
  assert.equal(axes[2].source, '7 个有记录交易日');
  assert.equal(axes[3].time, null);
  assert.equal(axes[5].raw, '4× · 7 笔');
  assert.deepEqual(score({ roi: '', winRate: -1, mdd: -1, aum: 250000, currency: 'BTC', leverage: 4 })
    .map(axis => axis.score), [null, null, null, null, null, null]);
});

test('requires a contiguous observed series for the trend score', () => {
  assert.equal(score({ points: series([0, 2, 1, 2, 2, 3, 4]) })[4].score, 67);
  assert.equal(score({ points: series([6, 5, 4, 3, 2, 1, 0]) })[4].score, 0);
  assert.equal(score({ points: series([0, 0, 0, 0, 0, 0, 0]) })[4].score, null);
  assert.equal(score({ points: series([0, 2, 1, 2, 2, 3]) })[4].score, null);
  const gapped = series([0, 2, 1, 2, 2, 3, 4]);
  gapped.at(-1).time += 4 * day;
  assert.equal(score({ points: gapped })[4].score, null);
  gapped.at(-1).time = gapped.at(-2).time;
  assert.equal(score({ points: gapped })[4].score, null);
});

class TestElement {
  constructor(ownerDocument, tag) {
    this.ownerDocument = ownerDocument;
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
  }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  get text() { return (this.textContent || '') + this.children.map(child => child.text).join(' '); }
  find(className) {
    const matches = this.className === className || this.attributes.get('class') === className ? [this] : [];
    return matches.concat(this.children.flatMap(child => child.find(className)));
  }
}

const document = {
  createElement: tag => new TestElement(document, tag),
  createElementNS: (_, tag) => new TestElement(document, tag),
};

test('shows measured scores without drawing across missing radar axes', () => {
  const panel = document.createElement('section');
  mount(panel, { roi: 10, winRate: 0, winAt: time, winLabel: '来源样本', periodLabel: '30D' });
  assert.equal(panel.find('bdr-point').length, 2);
  assert.equal(panel.find('bdr-area').length, 0);
  assert.equal(panel.find('bdr-edge').length, 0);
  assert.equal(panel.find('bdr-score').filter(row => row.attributes.get('data-available') === 'false').length, 4);
  assert.match(panel.text, /30D/);
  assert.match(panel.text, /2026\/11\/16 15:36/);
  assert.match(panel.text, /0% · 来源样本/);
});

test('uses a closed area only with six known axes and omits the chart when all axes are unknown', () => {
  const panel = document.createElement('section');
  mount(panel, {
    roi: 10, mdd: 40, winRate: 10, aum: 0, currency: 'USDT', leverage: 1, leverageCount: 3,
    points: series([1, 2, 3, 4, 5, 6, 7]),
  });
  assert.equal(panel.find('bdr-area').length, 1);
  assert.equal(panel.find('bdr-point').length, 6);

  const empty = document.createElement('section');
  mount(empty);
  assert.equal(empty.find('bdr-chart').length, 0);
  assert.match(empty.text, /暂无可用于评分的资料/);
});
