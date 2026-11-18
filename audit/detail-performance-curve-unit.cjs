const assert = require('node:assert/strict');
const { test } = require('node:test');

class Element {
  constructor(tag) {
    this.tag = tag;
    this.attributes = {};
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.events = {};
    this.ownerDocument = document;
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.events[name] = callback; }
  getBoundingClientRect() { return { left: 100, width: 300 }; }
}
const document = {
  createElement: tag => new Element(tag),
  createElementNS: (ns, tag) => new Element(tag),
};
require('../trader/detail-performance-curve.js');
const chart = globalThis.BooksDetailPerformanceCurve;

test('curve selects only real dated samples by mouse, touch and range input', () => {
  const target = new Element('section');
  const start = '2026-10-01T00:00:00Z';
  const middle = '2026-10-08T00:02:41.004Z';
  const end = '2026-11-09T21:25:12Z';
  const points = [
    { time: end, value: 998019.541 },
    { time: start, value: -23.5001 },
    { time: middle, value: 1100 },
    { time: middle, value: 1100 },
    { time: '2026-10-07T00:00:00Z', value: 4 },
    { time: '2026-10-07T00:00:00Z', value: 5 },
    { time: '2026-10-09T00:02:41', value: 100 },
    { time: '2026-11-12T08:00:00Z', value: null },
  ];
  assert.equal(chart.mount(target, points.slice(0, 1)), false);
  assert.equal(chart.mount(target, {}), false);
  assert.equal(target.children.length, 0);
  assert.equal(chart.mount(target, points, { unit: 'USDT', label: '来源盈亏曲线' }), true);
  const instance = target.children[0];
  const [readout, board] = instance.children;
  const [value, time] = readout.children;
  const [plot] = board.children;
  const [svg, marker, range] = plot.children;
  assert.equal(value.textContent, '+998,019.541 USDT');
  assert.equal(range.max, '2');
  assert.equal(instance.dataset.direction, 'up');
  plot.events.pointermove({ clientX: 163, pointerType: 'mouse' });
  assert.equal(time.dateTime, '2026-10-08T00:02:41.004Z');
  assert.equal(value.textContent, '+1,100 USDT');
  assert.match(range.attributes['aria-valuetext'], /2026\/10\/08 08:02:41\.004（北京），\+1,100 USDT/);
  plot.events.pointerdown({ clientX: 100, pointerType: 'touch' });
  assert.equal(value.textContent, '-23.5001 USDT');
  assert.equal(instance.dataset.direction, 'down');
  range.valueAsNumber = 2;
  range.events.input();
  assert.equal(value.textContent, '+998,019.541 USDT');
  assert.equal(marker.style.left, '99.375%');
  assert.equal(svg.children[0].children.length, 2);
});

test('a valid flat zero-percent curve preserves zero', () => {
  const start = Date.UTC(2026, 9, 1);
  const end = Date.UTC(2026, 10, 9);
  const flat = new Element('section');
  assert.equal(chart.mount(flat, [{ time: start, value: 0 }, { time: end, value: 0 }], { unit: '%' }), true);
  assert.equal(flat.children[0].dataset.flat, 'true');
  assert.equal(flat.children[0].children[1].children[1].children.length, 1);
  assert.equal(flat.children[0].children[0].children[0].textContent, '0%');
});
