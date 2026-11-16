import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBars, runBacktest, runResearch, STRATEGY_GRID } from './engine.mjs';

const DAY = 86400000;
function fixture(length = 600) {
  return Array.from({ length }, (_, i) => {
    const open = 100 + i * .035 + 12 * Math.sin(i / 8) + 4 * Math.sin(i / 29);
    const close = open + 1.8 * Math.sin(i / 3);
    return { timestamp: Date.UTC(2020, 0, 1) + i * DAY, open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: 1000 + i };
  });
}
const strategy = { id: 'test-trend', family: 'trend', fast: 5, slow: 20 };

test('strict OHLCV checks reject duplicates, disorder, gaps, malformed numbers and ranges', () => {
  for (const mutate of [
    bars => { bars[2].timestamp = bars[1].timestamp; },
    bars => { [bars[2], bars[3]] = [bars[3], bars[2]]; },
    bars => { bars.splice(2, 1); },
    bars => { bars[2].close = NaN; },
    bars => { bars[2].open = ''; },
    bars => { bars[2].low = bars[2].high + 1; },
    bars => { bars[2].volume = -1; },
    bars => { bars[2].timestamp = '2020-02-30'; },
    bars => { bars[2].timestamp = '2020-01-03T00:00:00'; },
  ]) {
    const bars = fixture(20); mutate(bars);
    assert.throws(() => normalizeBars(bars));
  }
});

test('normalization accepts Unix seconds and explicit UTC ISO without altering input', () => {
  const bars = fixture(10);
  const mixed = bars.map((bar, i) => ({ ...bar, timestamp: i % 2 ? new Date(bar.timestamp).toISOString() : bar.timestamp / 1000 }));
  assert.deepEqual(normalizeBars(mixed).bars, bars);
  assert.equal(typeof mixed[1].timestamp, 'string');
});

test('future prices cannot change fills, returns, or selection in earlier ranges', () => {
  const original = fixture();
  const changed = structuredClone(original);
  for (let i = 400; i < changed.length; i++) {
    for (const key of ['open', 'high', 'low', 'close']) changed[i][key] *= 10;
  }
  assert.deepEqual(runBacktest(original, strategy, {}, { end: 400 }), runBacktest(changed, strategy, {}, { end: 400 }));
  const a = runResearch(original), b = runResearch(changed);
  assert.deepEqual(a.experiments, b.experiments);
  assert.equal(a.selected.strategyId, b.selected.strategyId);
  assert.deepEqual(a.training, b.training);
});

test('same-bar close cannot influence its opening fill', () => {
  const original = fixture(100), changed = structuredClone(original);
  changed[50].close = changed[50].high = 10000;
  const a = runBacktest(original, strategy), b = runBacktest(changed, strategy);
  assert.deepEqual(a.fills.filter(fill => fill.index <= 50), b.fills.filter(fill => fill.index <= 50));
  for (const fill of a.fills.filter(fill => fill.reason === 'signal')) {
    assert.equal(fill.signalTimestamp, original[fill.index - 1].timestamp);
  }
});

test('fees and slippage are applied on both entry and exit, and reduce net results', () => {
  const bars = fixture();
  const free = runBacktest(bars, strategy, { feeBps: 0, slippageBps: 0 });
  const costly = runBacktest(bars, strategy, { feeBps: 20, slippageBps: 15 });
  assert.equal(free.metrics.tradeCount, costly.metrics.tradeCount);
  assert.ok(costly.metrics.finalEquity < free.metrics.finalEquity);
  assert.ok(costly.fills.every(fill => fill.fee > 0));
  assert.ok(costly.metrics.slippageCost > 0);
  assert.ok(Math.abs(costly.metrics.fees - costly.trades.reduce((sum, trade) => sum + trade.fees, 0)) < 1e-8);
  assert.ok(Math.abs(costly.metrics.finalEquity - 10000 - costly.trades.reduce((sum, trade) => sum + trade.netPnl, 0)) < 1e-8);
});

test('buy and hold matches the analytical round-trip equation including both costs', () => {
  const bars = fixture(10);
  const result = runBacktest(bars, { family: 'buyHold' }, { feeBps: 10, slippageBps: 5 });
  const expected = 10000 / (bars[0].open * 1.0005 * 1.001) * bars.at(-1).close * .9995 * .999;
  assert.ok(Math.abs(result.metrics.finalEquity - expected) < 1e-8);
  assert.equal(result.trades[0].exitReason, 'segmentEnd');
});

test('holdout never changes selected parameters or any expanding window experiment', () => {
  const original = fixture(), changed = structuredClone(original);
  for (let i = 480; i < changed.length; i++) {
    const price = 1000 * Math.exp((i - 480) / 100);
    Object.assign(changed[i], { open: price, close: price + 1, low: price - 1, high: price + 2 });
  }
  const a = runResearch(original), b = runResearch(changed);
  assert.deepEqual(a.selected, b.selected);
  assert.deepEqual(a.validation, b.validation);
  assert.deepEqual(a.walkForward, b.walkForward);
  assert.notDeepEqual(a.holdout, b.holdout);
  assert.equal(a.experiments.length, 24);
  assert.equal(STRATEGY_GRID.length, 24);
  assert.equal(a.walkForward.at(-1).test.range.end, a.splits.holdout.start);
  for (const fold of a.walkForward) {
    assert.equal(fold.trainRange.end, fold.test.range.start);
    assert.ok(fold.test.trades.every(trade => trade.entryIndex >= fold.trainRange.end));
  }
});

test('zero-variance no-trade returns have null Sharpe, not fabricated infinite statistics', () => {
  const bars = fixture(400).map(bar => ({ ...bar, open: 100, close: 100, high: 100, low: 100 }));
  const result = runResearch(bars);
  assert.equal(result.training.metrics.sharpe, null);
  assert.equal(result.training.metrics.tradeCount, 0);
  assert.equal(result.selected.role, 'diagnosticOnly');
  assert.ok(result.warnings.some(warning => warning.includes('No strategy meets')));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
});

test('results are reproducible, immutable with respect to inputs, and use explicit source hashes', () => {
  const bars = fixture();
  const before = JSON.stringify(bars);
  const config = { dataHash: 'a'.repeat(64), source: 'fixture', snapshotId: 'fixture-v1' };
  assert.deepEqual(runResearch(bars, config), runResearch(bars, config));
  assert.equal(JSON.stringify(bars), before);
  assert.equal(runResearch(bars, config).data.suppliedSha256, config.dataHash);
});

test('invalid costs, too few bars and unknown strategies fail clearly', () => {
  assert.throws(() => runResearch(fixture(299)), /300 bars/);
  assert.throws(() => runResearch(fixture(), { feeBps: -1 }), /feeBps/);
  assert.throws(() => runBacktest(fixture(), { family: 'broker' }), /Unknown/);
  assert.throws(() => runBacktest(fixture(), strategy, {}, { start: 50, end: 40 }), /range/);
});
