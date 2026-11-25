import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {catalog, evaluateIndicator, verifySnapshot} from '../quant-research/viprasol-registry.mjs';
import {pivots, highest, lowest, adx, atr, ema, rma, sma, wma, stdev, crossOver, crossUnder, vwap, linreg} from '../quant-research/viprasol-math.mjs';

const DAY = 86400000, begin = Date.UTC(2025, 0, 1);
const source = new URL('../quant-research/viprasol-source/', import.meta.url);
const rows = values => values.map((close, i) => ({time: begin + i * DAY, open: close, high: close + .5, low: close - .5, close, volume: 100}));
const bars = Object.freeze(Array.from({length: 360}, (_, i) => {
  const close = 100 + i * .03 + Math.sin(i / 5) * 4, open = close + Math.cos(i / 3) * .3;
  return Object.freeze({time: begin + i * DAY, open, high: Math.max(open, close) + .8, low: Math.min(open, close) - .8, close, volume: 100 + i % 11 * 13});
}));
const context = {symbol: 'BTC/USD', tickerid: 'KRAKEN:XBTUSD', timeframe: 'D', intervalMs: DAY, timeZone: 'UTC', mintick: .1, series: {}};
const near = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) <= epsilon, actual + ' != ' + expected);
const snapshot = (data = rows([100, 101, 102])) => ({schemaVersion: 1, status: 'ready', bars: data,
  source: {name: 'Kraken public OHLC', symbol: 'BTC/USD'}, latestClosedAt: new Date(data.at(-1).time + DAY).toISOString(),
  retrievedAt: new Date(data.at(-1).time + DAY + 60000).toISOString()});

test('the integrated catalog covers all 29 pinned Pine files exactly once and preserves valid source links', () => {
  const originals = readdirSync(new URL('indicators/', source)).filter(name => name.endsWith('.pine'));
  assert.equal(catalog.length, 29); assert.equal(new Set(catalog.map(item => item.id)).size, 29);
  assert.equal(new Set(catalog.map(item => item.sourceFile)).size, 29);
  assert.deepEqual(catalog.map(item => item.sourceFile).sort(), originals.sort());
  assert.equal(readFileSync(new URL('SOURCE_COMMIT', source), 'utf8').trim(), 'a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0');
  for (const item of catalog) {
    assert.match(item.sourceFile, /^[a-z0-9-]+\.pine$/);
    assert.match(readFileSync(new URL('indicators/' + item.sourceFile, source), 'utf8'), /\bindicator\(/);
    assert.ok(Array.isArray(item.parameters));
    for (const parameter of item.parameters) assert.ok(Object.hasOwn(item.defaults, parameter.key), item.id + ':' + parameter.key);
  }
});

test('all 29 registry dispatch paths preserve input bars and return bounded causal output', () => {
  const before = JSON.stringify(bars);
  for (const item of catalog) {
    const output = evaluateIndicator(item.id, bars, {}, context);
    assert.equal(output.id, item.id); assert.ok(['ready', 'blocked', 'missing_data'].includes(output.status), item.id);
    assert.ok(Array.isArray(output.missingDependencies)); assert.ok(Array.isArray(output.notes));
    for (const signal of output.signals) {
      assert.ok(Number.isInteger(signal.index) && signal.index >= 0 && signal.index < bars.length, item.id);
      assert.equal(signal.time, bars[signal.index].time, item.id);
      for (const key of ['entry', 'stop', 'target']) assert.ok(signal[key] === null || Number.isFinite(signal[key]), item.id + ':' + key);
    }
    for (const plot of output.plots) {assert.equal(plot.values.length, bars.length, item.id + ':' + plot.name); assert.ok(plot.values.every(value => value === null || Number.isFinite(value)), item.id + ':' + plot.name);}
  }
  assert.equal(JSON.stringify(bars), before);
  assert.throws(() => evaluateIndicator('unlisted-indicator', bars, {}, context));
});

test('missing external series, session metadata or mintick stop dependent indicators with zero signals', () => {
  const missing = new Set(['bitcoin-sniper-confluence', 'gold-sniper-confluence', 'cisd-delivery-shift', 'multi-timeframe-trend-signal-engine',
    'real-relative-strength', 'smc-flip-zone-engine', 'sniper-confluence-entry-exit', 'htf-peak-session-volume']);
  for (const id of missing) {
    const output = evaluateIndicator(id, bars, {}, context);
    assert.notEqual(output.status, 'ready', id); assert.ok(output.missingDependencies.length > 0, id);
    assert.deepEqual(output.signals, [], id); assert.deepEqual(output.zones, [], id);
  }
  const noTick = {...context}; delete noTick.mintick;
  for (const item of catalog.filter(item => item.dependencies?.includes('mintick'))) {
    const output = evaluateIndicator(item.id, bars, {}, noTick);
    assert.equal(output.status, 'blocked', item.id); assert.ok(output.missingDependencies.includes('official_mintick'));
    assert.deepEqual(output.signals, [], item.id);
  }
  const badBenchmark = {...context, series: {'SPY|D': [{...bars[0], high: bars[0].low - 1}]}};
  const relative = evaluateIndicator('real-relative-strength', bars, {}, badBenchmark);
  assert.equal(relative.status, 'missing_data'); assert.deepEqual(relative.signals, []);
  assert.ok(relative.missingDependencies.some(item => item.includes('valid ordered OHLCV')));
});

test('snapshot validation enforces completed-bar dates, a contiguous calendar and monotonic publication', () => {
  const initial = snapshot(); assert.equal(verifySnapshot(initial), initial);
  assert.equal(verifySnapshot({...initial, status: 'stale'}).status, 'stale');
  const next = snapshot(rows([100, 101, 102, 103])); assert.equal(verifySnapshot(next, initial), next);
  assert.throws(() => verifySnapshot(initial, next), /更旧/);
  const laterCapture = {...initial, retrievedAt: new Date(Date.parse(initial.retrievedAt) + 1000).toISOString()};
  assert.throws(() => verifySnapshot(initial, laterCapture), /更旧/);
  assert.throws(() => verifySnapshot({...initial, retrievedAt: new Date(Date.parse(initial.latestClosedAt) - 1).toISOString()}));
  assert.throws(() => verifySnapshot({...initial, retrievedAt: new Date(Date.now() + 3600000).toISOString()}));
  assert.throws(() => verifySnapshot({...initial, latestClosedAt: new Date(Date.parse(initial.latestClosedAt) - 1).toISOString()}));
  assert.throws(() => verifySnapshot(snapshot([initial.bars[0], initial.bars[2]])), /缺口/);
  assert.throws(() => verifySnapshot({...initial, source: {...initial.source, symbol: 'ETH/USD'}}));
  assert.throws(() => verifySnapshot({...initial, schemaVersion: 2}));
});

test('snapshot validation rejects malformed OHLC, nonfinite prices and duplicate or reversed dates', () => {
  const initial = snapshot();
  for (const patch of [{high: 99}, {low: 101}, {volume: -1}, {open: Infinity}, {close: NaN}]) {
    assert.throws(() => verifySnapshot({...initial, bars: [{...initial.bars[0], ...patch}, ...initial.bars.slice(1)]}));
  }
  assert.throws(() => verifySnapshot({...initial, bars: [initial.bars[0], initial.bars[0], initial.bars[2]]}));
  assert.throws(() => verifySnapshot({...initial, bars: [...initial.bars].reverse()}));
  assert.throws(() => verifySnapshot({...initial, bars: []}));
});

test('confirmed pivots appear only after their right bars; rightmost equal extrema win', () => {
  const values = [1, 3, 3, 2, 1];
  assert.deepEqual(pivots(values, 1, 1), [null, null, null, {value: 3, index: 2}, null]);
  assert.deepEqual(pivots(values.slice(0, 3), 1, 1), [null, null, null]);
  assert.deepEqual(pivots([3, 1, 1, 2, 3], 1, 1, 'low'), [null, null, null, {value: 1, index: 2}, null]);
  const delayed = pivots([1, 2, 5, 4, 3], 2, 2);
  assert.deepEqual(delayed.slice(0, 4), [null, null, null, null]); assert.deepEqual(delayed[4], {value: 5, index: 2});
  assert.ok(pivots([1, null, 5, 4, 3], 2, 2).every(value => value === null));
});

test('native extrema wait for full bar positions and EMA waits for its SMA seed', () => {
  assert.deepEqual(highest([3, 1, 2, 4], 3), [null, null, 3, 4]);
  assert.deepEqual(lowest([3, 1, 2, 4], 3), [null, null, 1, 1]);
  assert.deepEqual(highest([null, 2, null, 1], 2), [null, 2, 2, 1]);
  assert.deepEqual(sma([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(rma([1, 2, 3, 6], 3), [null, null, 2, 10 / 3]);
  assert.deepEqual(ema([1, 2, 3], 3), [null, null, 2]);
  near(wma([1, 2, 3], 3)[2], 14 / 6);
  near(stdev([1, 2, 3], 3)[2], Math.sqrt(2 / 3)); near(stdev([1, 2, 3], 3, false)[2], 1);
});

test('ADX keeps both Wilder warmups and ties in directional movement contribute neither direction', () => {
  const trend = rows([1, 2, 3, 4, 5, 6]), output = adx(trend, 3, 2);
  assert.deepEqual(output.plusDI.slice(0, 3), [null, null, null]);
  near(output.plusDI[3], 100 / 1.5); assert.equal(output.minusDI[3], 0);
  assert.deepEqual(output.adx.slice(0, 4), [null, null, null, null]); near(output.adx[4], 100);
  const expanding = Array.from({length: 6}, (_, i) => ({time: begin + DAY * i, open: 100, close: 100, high: 101 + i, low: 99 - i, volume: 100}));
  const tied = adx(expanding, 3, 2); assert.equal(tied.plusDI[3], 0); assert.equal(tied.minusDI[3], 0); assert.equal(tied.adx[4], 0);
  const defaults = adx(rows(Array.from({length: 35}, (_, i) => 100 + i)));
  assert.equal(defaults.plusDI.findIndex(Number.isFinite), 14); assert.equal(defaults.adx.findIndex(Number.isFinite), 27);
  assert.equal(atr(trend, 3).findIndex(Number.isFinite), 2);
});

test('crossings require a strict current crossing, preserve previous equality and reject missing values', () => {
  assert.equal(crossOver([0, 1], 0, 1), true); assert.equal(crossUnder([0, -1], 0, 1), true);
  assert.equal(crossOver([-1, 0], 0, 1), false); assert.equal(crossOver([null, 1], 0, 1), false);
  assert.equal(crossOver([3, 3], [3, 2], 1), true); assert.equal(crossUnder([3, 3], [3, 4], 1), true);
  assert.equal(crossOver([1], 0, 0), false);
});

test('VWAP resets only at the supplied session boundary and regression uses chronological slope', () => {
  const price = rows([10, 20, 30]).map((bar, i) => ({...bar, volume: [1, 3, 2][i]}));
  assert.deepEqual(vwap(price, () => 'same-session'), [10, 17.5, 130 / 6]);
  assert.deepEqual(vwap(price), [10, 20, 30]);
  assert.deepEqual(vwap(price.map(bar => ({...bar, volume: 0})), () => 'same-session'), [null, null, null]);
  assert.deepEqual(linreg([1, 3, 5, 7], 3), [null, null, 5, 7]);
  assert.deepEqual(linreg([1, 3, 5, 7], 3, 1), [null, null, 3, 5]);
});

test('structure plots carry separate physical units so quality, stages and Z metrics never share a price axis', () => {
  const wave = evaluateIndicator('wave-structure-pro-v2', bars, {}, context);
  for (const name of ['Count Quality', 'Count Direction', 'Count Stage']) assert.equal(wave.plots.find(plot => plot.name === name).pane, 'oscillator');
  for (const plot of wave.plots.filter(plot => !['Count Quality', 'Count Direction', 'Count Stage'].includes(plot.name))) assert.equal(plot.pane, 'price');
  assert.deepEqual(wave.plots.slice(0, 3).map(plot => plot.unit), ['percent', 'direction', 'stage']);
  const z = evaluateIndicator('z-score-stats', bars, {}, context);
  assert.ok(z.plots.every(plot => plot.pane === 'oscillator'));
  assert.deepEqual(z.plots.map(plot => plot.unit), ['z', 'z', 'ratio', 'z', 'z', 'percent', 'percent']);
});
