import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog, evaluateIndicator, SOURCE_COMMIT} from '../quant-research/viprasol-core.mjs';

const DAY = 86400000;
const bar = (index, patch = {}) => ({time: Date.UTC(2020, 0, 1) + index * DAY, open: 100, high: 101, low: 99, close: 100, volume: 0, ...patch});
function spring(second = 56, firstPatch = {}) {
  const bars = Array.from({length: second + 1}, (_, index) => bar(index, index < 30 ? {high: 108, low: 92} : {}));
  bars[40] = bar(40, {open: 100, high: 111, low: 99, close: 110, ...firstPatch});
  bars[second] = bar(second, {open: 100, high: 111, low: 99, close: 110});
  return bars;
}
function orbitFixture() {
  const bars = Array.from({length: 40}, (_, index) => bar(index));
  for (const [index, high] of [[10, 105], [20, 104], [30, 103]]) bars[index] = bar(index, {high});
  for (const [index, low] of [[15, 95], [25, 96], [35, 97]]) bars[index] = bar(index, {low});
  bars[39] = bar(39, {open: 100, high: 107, low: 99, close: 106});
  return bars;
}
function nestFixture() {
  const bars = Array.from({length: 33}, (_, index) => bar(index, {open: 103, high: 104, low: 102, close: 103}));
  for (const [index, patch] of [[10, {high: 110}], [16, {low: 100}], [22, {high: 105}], [28, {low: 99}]]) Object.assign(bars[index], patch);
  bars[32] = bar(32, {open: 102, high: 103, low: 97, close: 98});
  return bars;
}

test('catalog pins the original source and exposes every computational default and numeric bound', () => {
  assert.equal(SOURCE_COMMIT, 'a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0');
  assert.deepEqual(catalog.map(item => item.id), ['tyson', 'ronaldo', 'khabib']);
  for (const item of catalog) {
    assert.ok(Object.isFrozen(item.defaults));
    for (const spec of item.parameters) assert.equal(item.defaults[spec.key], spec.value);
    assert.equal(item.defaults.sigGap, 15);
    assert.equal(item.defaults.oneAtATime, true);
  }
  assert.equal(catalog[0].defaults.compFrac, .6);
  assert.equal(catalog[1].parameters.find(item => item.key === 'kSwings').max, 10);
});

test('invalid parameters, unknown indicators and invalid, duplicate or unordered bars are rejected rather than coerced', () => {
  for (const params of [null, [], {compLen: 2}, {compLen: 3.1}, {compLen: '10'}, {compFrac: NaN}, {rr: 0}, {slBuf: -.1}, {oneAtATime: 1}, {unknown: 1}]) assert.throws(() => evaluateIndicator('tyson', spring(), params));
  assert.throws(() => evaluateIndicator('unknown', []));
  assert.throws(() => evaluateIndicator('ronaldo', [], {kSwings: 11}));
  for (const patch of [{time: NaN}, {low: 105}, {volume: -1}, {close: Infinity}, {time: 0}]) {
    const bars = spring(); Object.assign(bars[3], patch); assert.throws(() => evaluateIndicator('tyson', bars));
  }
});

test('flat prices, real zero and zero volume never manufacture an ATR breakout or pivot', () => {
  for (const value of [0, 100]) {
    const bars = Array.from({length: 80}, (_, index) => bar(index, {open: value, high: value, low: value, close: value}));
    for (const item of catalog) {
      const result = evaluateIndicator(item.id, bars);
      assert.deepEqual(result.signals, []);
      assert.ok(result.plots.every(plot => plot.values.every(value => value === null)));
    }
  }
  assert.deepEqual(evaluateIndicator('tyson', []).signals, []);
  assert.ok(evaluateIndicator('tyson', spring().slice(0, 13)).plots.every(plot => plot.values.every(value => value === null)));
});

test('Tyson uses the inclusive double-size past window, current ATR and the original bullish release rule', () => {
  const bars = spring(), result = evaluateIndicator('tyson', bars);
  assert.equal(result.signals.length, 1);
  const signal = result.signals[0];
  assert.equal(signal.index, 40); assert.equal(signal.time, bars[40].time); assert.equal(signal.side, 'long'); assert.equal(signal.entry, 110);
  const priorAtr = 2 + 14 * (13 / 14) ** 10, currentAtr = priorAtr * 13 / 14 + 12 / 14;
  assert.ok(Math.abs(signal.stop - (99 - .3 * currentAtr)) < 1e-12);
  assert.ok(Math.abs(signal.target - (110 + 2 * (110 - signal.stop))) < 1e-12);
  assert.equal(result.plots[0].values[40], 101); assert.equal(result.plots[1].values[40], 99);
  const bearish = spring(); bearish[40].open = 110; assert.equal(evaluateIndicator('tyson', bearish).signals.some(s => s.index === 40), false);
});

test('Tyson previous-window series preserve native NA masks at compLen-1 and twice-compLen-1', () => {
  const bars = Array.from({length: 25}, (_, index) => bar(index));
  const trace = evaluateIndicator('tyson', bars, {}, {auditTrace: true}).auditTrace;
  assert.ok(trace.slice(0, 9).every(row => row.compHigh === null && row.compLow === null));
  assert.equal(trace[9].compHigh, 101);
  assert.equal(trace[9].compLow, 99);
  assert.ok(trace.slice(0, 19).every(row => row.wideRange === null));
  assert.equal(trace[19].wideRange, 2);
  assert.ok(trace.slice(0, 13).every(row => row.atr === null));
  assert.equal(trace[13].atr, 2);
});

test('ATR-ready bars cannot emit compression or an early B before the wide window is ready', () => {
  const bars = [
    bar(0, {open: 10, high: 20, low: 0, close: 10}),
    ...[1, 2, 3].map(index => bar(index, {open: 10, high: 11, low: 9, close: 10})),
    bar(4, {open: 10, high: 20, low: 9, close: 19}),
    bar(5, {open: 19, high: 20, low: 18, close: 19}),
  ];
  const result = evaluateIndicator('tyson', bars, {compLen: 3, atrLen: 3}, {auditTrace: true});
  assert.ok(result.auditTrace.slice(2).every(row => row.atr !== null));
  assert.equal(result.auditTrace[4].compHigh, 11);
  assert.equal(result.auditTrace[4].compLow, 9);
  assert.equal(result.auditTrace[4].wideRange, null);
  assert.equal(result.auditTrace[4].release, true);
  assert.equal(result.auditTrace[4].compressed, false);
  assert.equal(result.auditTrace[4].signalLong, false);
  assert.equal(result.auditTrace[5].wideRange, 20);
  assert.equal(result.plots[0].values[4], null);
  assert.deepEqual(result.signals, []);
});

test('the cooldown is strictly greater than fifteen, while oneAtATime keeps an unexpired zone blocking', () => {
  assert.deepEqual(evaluateIndicator('tyson', spring(55), {oneAtATime: false}).signals.map(s => s.index), [40]);
  assert.deepEqual(evaluateIndicator('tyson', spring(56), {oneAtATime: false}).signals.map(s => s.index), [40, 56]);
  assert.deepEqual(evaluateIndicator('tyson', spring(56)).signals.map(s => s.index), [40]);
});

test('same-bar stop/target reference checks and exit-before-next-bar blocking remain faithful without creating fills', () => {
  for (const patch of [{low: 0}, {high: 160, low: 0}]) {
    const result = evaluateIndicator('tyson', spring(56, patch));
    assert.deepEqual(result.signals.map(s => s.index), [40, 56]);
    assert.ok(!Object.hasOwn(result, 'trades') && !Object.hasOwn(result, 'returns'));
    assert.match(result.notes.join(' '), /同根.*无法证明盘中先后/);
  }
});

test('Ronaldo confirms pivots before a causal orbit escape and uses population spread, not a new center-drift filter', () => {
  const bars = orbitFixture(), result = evaluateIndicator('ronaldo', bars);
  assert.deepEqual(result.signals.map(s => s.index), [39]);
  assert.equal(result.signals[0].entry, 106);
  const values = [105, 95, 104, 96, 103, 97], center = 100;
  const radius = Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
  assert.equal(result.plots[0].values[39], center + radius);
  assert.equal(result.plots[1].values[39], center);
  assert.equal(result.plots[2].values[39], center - radius);
  assert.ok(result.signals[0].stop < 95);
});

test('Khabib waits for the right-side pivot confirmation and preserves the lower-high/lower-low short geometry', () => {
  const bars = nestFixture(), result = evaluateIndicator('khabib', bars);
  assert.deepEqual(result.signals.map(s => s.index), [32]);
  assert.equal(result.signals[0].side, 'short'); assert.equal(result.signals[0].entry, 98);
  assert.equal(result.plots[0].values[30], null); assert.equal(result.plots[0].values[31], 99);
  assert.ok(result.signals[0].stop > 105); assert.ok(result.signals[0].target < 98);
  assert.equal(evaluateIndicator('khabib', bars.slice(0, 31)).signals.length, 0);
  assert.equal(evaluateIndicator('khabib', bars, {ratHi: .5}).signals.length, 0);
});

test('future bars cannot revise earlier signals or plots and all source inputs remain unchanged', () => {
  for (const [id, source] of [['tyson', spring()], ['ronaldo', orbitFixture()], ['khabib', nestFixture()]]) {
    const saved = structuredClone(source), bars = Object.freeze(source.map(value => Object.freeze(value))), params = Object.freeze({});
    const result = evaluateIndicator(id, bars, params), later = [...bars];
    for (let i = bars.length; i < bars.length + 30; i++) later.push(bar(i, {open: 200, high: 220, low: 190, close: 215}));
    const expanded = evaluateIndicator(id, later);
    assert.deepEqual(expanded.signals.filter(signal => signal.index < bars.length), result.signals);
    assert.deepEqual(expanded.plots.map(plot => plot.values.slice(0, bars.length)), result.plots.map(plot => plot.values));
    assert.deepEqual(source, saved);
  }
});
