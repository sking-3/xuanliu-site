import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog, evaluateIndicator} from '../quant-research/viprasol-structure.mjs';

const day = 86400000, start = Date.UTC(2024, 0, 1);
const rows = values => values.map((close, index) => ({time: start + index * day, open: close, high: close, low: close, close, volume: 100}));
const valuesOf = (output, name) => output.plots.find(plot => plot.name === name).values;
const near = (value, expected, epsilon = 1e-10) => assert.ok(Math.abs(value - expected) <= epsilon, value + ' != ' + expected);
function path(points, length = points.at(-1)[0] + 4) {
  const values = [];
  for (let i = 0; i < length; i++) {
    const next = points.findIndex(point => point[0] >= i);
    if (next < 0) {values.push(points.at(-1)[1] + (i - points.at(-1)[0]) * .2); continue;}
    if (next === 0) {values.push(points[0][1]); continue;}
    const [a, x] = points[next - 1], [b, y] = points[next];
    values.push(x + (y - x) * (i - a) / (b - a));
  }
  return rows(values);
}
const topBars = () => path([[0, 105], [5, 110], [10, 100], [15, 110], [18, 99], [22, 98]], 23);
const waveBars = (correction = false) => path([[0, 105], [5, 100], [10, 110], [15, 104.5], [20, 125], [25, 117], [30, 128],
  ...(correction ? [[35, 118], [40, 124], [45, 114]] : [[34, 123]])], correction ? 49 : 35);

test('four original indicators expose their computational defaults and reject invalid parameter changes', () => {
  assert.equal(catalog.length, 4);
  for (const item of catalog) {
    assert.ok(item.parameters.every(spec => Object.hasOwn(item.defaults, spec.key)));
    assert.ok(Object.isFrozen(item.defaults));
    assert.equal(item.sourceFile, item.id + '.pine');
  }
  assert.throws(() => evaluateIndicator('not-a-source', rows([1, 2])));
  assert.throws(() => evaluateIndicator('z-score-stats', rows([1, 2]), {i_length: 1}));
  assert.throws(() => evaluateIndicator('z-score-stats', rows([1, 2]), {i_length: 2.5}));
  assert.throws(() => evaluateIndicator('double-tap-double-top-bottom', rows([1, 2]), {detTop: 'true'}));
  assert.throws(() => evaluateIndicator('wave-structure-pro-v2', rows([1, 2]), {unlisted: 2}));
  assert.throws(() => evaluateIndicator('wave-structure-pro-v2', []));
});

test('Double Tap waits for confirmed twin pivots then crosses the neckline at close', () => {
  const bars = topBars(), params = {pivLen: 2, minW: 2, atrLen: 2};
  assert.equal(evaluateIndicator('double-tap-double-top-bottom', bars.slice(0, 17), params).signals.length, 0);
  const output = evaluateIndicator('double-tap-double-top-bottom', bars, params);
  assert.equal(output.signals.length, 1);
  const signal = output.signals[0];
  assert.equal(signal.type, 'double_top'); assert.equal(signal.side, 'short');
  assert.equal(signal.index, 18); assert.equal(signal.time, bars[18].time);
  assert.equal(signal.entry, 99); assert.equal(signal.target, 90);
  assert.ok(signal.stop > 110);
  assert.deepEqual([output.zones[0].startIndex, output.zones[0].secondIndex, output.zones[0].neckIndex], [5, 15, 10]);
  assert.equal(output.summary.referenceHitRate, null);
  const mirrored = bars.map(bar => ({...bar, open: 210 - bar.open, high: 210 - bar.low, low: 210 - bar.high, close: 210 - bar.close}));
  const bottom = evaluateIndicator('double-tap-double-top-bottom', mirrored, params).signals[0];
  assert.equal(bottom.type, 'double_bottom'); assert.equal(bottom.entry, 111); assert.equal(bottom.target, 120);
  assert.equal(evaluateIndicator('double-tap-double-top-bottom', bars, {...params, detTop: false}).signals.length, 0);
});

test('Double Tap invalidates the wrong-side wick first and preserves unknown ATR', () => {
  const bars = topBars(), params = {pivLen: 2, minW: 2};
  const invalid = bars.map(bar => ({...bar})); invalid[18].high = 111;
  assert.equal(evaluateIndicator('double-tap-double-top-bottom', invalid, params).signals.length, 0);
  const noATR = evaluateIndicator('double-tap-double-top-bottom', bars, {...params, atrLen: 100});
  assert.equal(noATR.signals[0].stop, null);
  assert.equal(noATR.signals[0].target, 90);
  const ambiguous = bars.map(bar => ({...bar})); ambiguous[19].high = 130; ambiguous[19].low = 85;
  const output = evaluateIndicator('double-tap-double-top-bottom', ambiguous, {...params, atrLen: 2});
  assert.equal(output.summary.referenceWins, 0); assert.equal(output.summary.referenceLosses, 1);
  assert.equal(output.zones[0].outcome, 'stop_or_ambiguous');
  assert.equal(output.signals[0].return, undefined);
});

test('Wave Structure confirms six pivots, preserves textbook-fit quality and supports arbitrary projection multiples', () => {
  const bars = waveBars(), parameters = {depth: 2};
  assert.equal(evaluateIndicator('wave-structure-pro-v2', bars.slice(0, 32), parameters).signals.length, 0);
  const output = evaluateIndicator('wave-structure-pro-v2', bars, parameters), state = output.summary;
  assert.equal(output.signals.length, 1); assert.equal(output.signals[0].type, 'count_found');
  assert.equal(output.signals[0].index, 32); assert.equal(state.startIndex, 5);
  assert.equal(state.up, true); assert.equal(state.full, false); assert.equal(state.current, true);
  near(state.ratios.w2, .55); near(state.ratios.w3, 2.05); near(state.ratios.w4, 8 / 20.5); near(state.ratios.w5, 1.1);
  const quality = ((1 - Math.abs(.55 - .559) / .3) + 1 + (1 - Math.abs(8 / 20.5 - .382) / .3) + .8) / 4 * 100;
  near(state.quality, quality); near(state.projectedW3, 120.68); near(state.projectedW5, 127);
  assert.equal(state.invalidation, 100);
  assert.equal(output.zones[0].type, 'wave_base_channel'); near(output.zones[0].slope, 1.25);
  near(output.zones[1].high, 128 - 28 * .382); near(output.zones[1].low, 128 - 28 * .618);
  const lowThreshold = evaluateIndicator('wave-structure-pro-v2', bars, {depth: 2, minQual: 0});
  const highThreshold = evaluateIndicator('wave-structure-pro-v2', bars, {depth: 2, minQual: 100, w3ext: -1});
  assert.equal(lowThreshold.signals.length, highThreshold.signals.length);
  assert.equal(highThreshold.signals[0].highQuality, false); near(highThreshold.summary.projectedW3, 94.5);
});

test('Wave Structure prefers a complete ABC at the same ending pivot and does not re-fire an unchanged start', () => {
  const bars = waveBars(true), output = evaluateIndicator('wave-structure-pro-v2', bars, {depth: 2});
  assert.equal(output.signals.filter(signal => signal.type === 'count_found').length, 1);
  const abc = output.signals.find(signal => signal.type === 'abc_complete');
  assert.equal(abc.index, 47); assert.equal(abc.time, bars[47].time);
  assert.equal(output.summary.full, true); assert.equal(output.summary.startIndex, 5); assert.equal(output.summary.points.length, 9);
  assert.equal(output.zones.length, 1); assert.equal(output.zones[0].type, 'wave_base_channel');
  const before = evaluateIndicator('wave-structure-pro-v2', bars.slice(0, 38), {depth: 2});
  assert.equal(before.summary.current, false); assert.equal(before.summary.full, false);
  const belowStart = waveBars(); belowStart.push({...belowStart.at(-1), time: belowStart.at(-1).time + day, high: 99, low: 99, open: 99, close: 99});
  const notYetRecounted = evaluateIndicator('wave-structure-pro-v2', belowStart, {depth: 2});
  assert.equal(notYetRecounted.summary.invalidation, 100);
  assert.equal(notYetRecounted.signals.some(signal => signal.type === 'count_invalidated'), false);
});

test('Z-score uses the available sample window with N-1 variance, rather than fabricating a full-window warmup', () => {
  const output = evaluateIndicator('z-score-stats', rows([10, 20, 30]));
  const z = valuesOf(output, 'Z-score'); assert.equal(z[0], null); near(z[1], Math.SQRT1_2); near(z[2], 1);
  assert.equal(valuesOf(output, 'Projected Z（线性外推，非预测）')[0], null);
  assert.equal(valuesOf(output, 'Projected Z（线性外推，非预测）')[1], 4);
  // The source compares raw IEEE-754 values: this fixture's Z is just below 1.
  assert.equal(output.summary.normalCoverage, 38.3);
  assert.equal(output.summary.averageYearMaxAbs, null);
  const flat = evaluateIndicator('z-score-stats', rows([0, 0, 0]).map(bar => ({...bar, volume: 0})));
  assert.deepEqual(valuesOf(flat, 'Z-score'), [null, 0, 0]);
  assert.deepEqual(valuesOf(flat, '成交量比'), [null, null, null]);
  assert.equal(flat.signals.length, 0);
});

test('Z-score preserves neckline-independent band re-entry and extreme alerts without invented risk targets', () => {
  const bars = rows([...Array(20).fill(100), 200, 100, 200, 100]);
  const output = evaluateIndicator('z-score-stats', bars, {i_reentry_level: 2, i_reentry_gap: 2, i_vol_length: 2});
  const events = output.signals.filter(signal => signal.type.startsWith('band_reentry'));
  assert.deepEqual(events.map(signal => signal.index), [21, 23]);
  assert.equal(output.signals.filter(signal => signal.type === 'extreme_above_3.5').length, 1);
  assert.equal(output.signals.filter(signal => signal.type === 'extreme_above_4').length, 1);
  for (const signal of output.signals) {assert.equal(signal.target, null); assert.equal(signal.stop, null);}
  const blocked = evaluateIndicator('z-score-stats', bars, {i_reentry_level: 2, i_reentry_gap: 3});
  assert.deepEqual(blocked.signals.filter(signal => signal.type.startsWith('band_reentry')).map(signal => signal.index), [21]);
});

test('Z-score calendar means skip the first loaded partial year; fixed blocks and volume contractions use their own raw series', () => {
  const bars = rows([10, 20, 30, 10, 40]).map((bar, i) => ({...bar, time: Date.UTC(2022 + Math.floor(i / 2), i % 2 ? 11 : 0, 2), volume: i === 4 ? 10 : 100}));
  const output = evaluateIndicator('z-score-stats', bars, {i_length: 2, i_vol_length: 2});
  const averages = valuesOf(output, 'Avg Yearly Max |Z|');
  assert.deepEqual(averages.slice(0, 4), [null, null, null, null]); near(averages[4], Math.SQRT1_2);
  near(output.summary.volumeRatio, 10 / 55); assert.equal(output.summary.contracted, true);
  const fixed = evaluateIndicator('z-score-stats', rows([10, 20, 30, 40]), {i_stats_period: 'Fixed bar count (classic)', i_yearly_bars: 2});
  const fixedMean = valuesOf(fixed, 'Avg Yearly Max |Z|'); assert.equal(fixedMean[0], null); near(fixedMean[1], Math.SQRT1_2);
  near(fixedMean[3], (Math.SQRT1_2 + 1.5 / Math.sqrt(5 / 3)) / 2);
});

test('Z-score confirms divergences on the right-side bar and preserves separate source prices', () => {
  const bars = rows(Array.from({length: 150}, (_, i) => 100 + Math.sin(i * .31) * (10 - i * .03) - i * .03));
  const output = evaluateIndicator('z-score-stats', bars, {i_length: 20, i_div_lookback: 2, i_div_min_range: 2, i_div_gap: 0});
  const divergences = output.signals.filter(signal => signal.type.includes('divergence'));
  assert.ok(divergences.length > 0);
  for (const signal of divergences) {
    assert.equal(signal.index - signal.pivotIndex, 2); assert.equal(signal.time, bars[signal.index].time);
    assert.equal(evaluateIndicator('z-score-stats', bars.slice(0, signal.index), {i_length: 20, i_div_lookback: 2, i_div_min_range: 2, i_div_gap: 0}).signals.some(previous => previous.index === signal.index), false);
  }
  const highSource = bars.map(bar => ({...bar, high: bar.high + 2}));
  const highResult = evaluateIndicator('z-score-stats', highSource, {i_source: 'high'});
  near(valuesOf(highResult, 'Z-score')[2], valuesOf(output, 'Z-score')[2]);
});

test('Goal Setting counts only displayed milestones, preserves all 20 and never invents market signals', () => {
  const defaults = catalog.find(item => item.id === 'goal-setting-strategies').defaults;
  const goals = defaults.goals.map((goal, i) => ({...goal, done: i === 0 || i === 19}));
  const output = evaluateIndicator('goal-setting-strategies', [], {goals, vip_goal_name: 'A股复盘', vip_total_goals: 4});
  assert.equal(output.progress.name, 'A股复盘'); assert.equal(output.progress.complete, 1); assert.equal(output.progress.percent, 25);
  assert.equal(output.parameters.goals.length, 20); assert.equal(output.signals.length, 0); assert.equal(output.plots.length, 0);
  assert.equal(evaluateIndicator('goal-setting-strategies', [], {goals, vip_total_goals: 20}).progress.percent, 10);
  output.parameters.goals[0].done = false; assert.equal(goals[0].done, true); assert.equal(defaults.goals[0].done, false);
  assert.throws(() => evaluateIndicator('goal-setting-strategies', [], {goals: [{label: 'bad', done: 1}]}));
  assert.throws(() => evaluateIndicator('goal-setting-strategies', [], {goals: []}));
  assert.throws(() => evaluateIndicator('goal-setting-strategies', [], {goals, vip_total_goals: 21}));
});

test('all price indicators preserve frozen source data and future appends cannot alter prior discovery signals or plots', () => {
  const bars = Object.freeze(waveBars(true).map(Object.freeze));
  const text = JSON.stringify(bars), extended = [...bars, ...rows([120, 119, 121, 118]).map((bar, i) => ({...bar, time: bars.at(-1).time + day * (i + 1)}))];
  for (const [id, params] of [['double-tap-double-top-bottom', {pivLen: 2}], ['wave-structure-pro-v2', {depth: 2}], ['z-score-stats', {i_div_lookback: 2}]]) {
    const before = evaluateIndicator(id, bars, params), after = evaluateIndicator(id, extended, params);
    assert.deepEqual(after.signals.filter(signal => signal.index < bars.length), before.signals);
    before.plots.forEach((plot, i) => assert.deepEqual(after.plots[i].values.slice(0, bars.length), plot.values));
  }
  assert.equal(JSON.stringify(bars), text);
});
