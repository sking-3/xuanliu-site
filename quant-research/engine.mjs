// Deterministic, dependency-free research only. No broker or account interfaces.
export const METHOD_VERSION = 'spot-research-1.0.0';
const DAY = 86400000;
const finite = (value) => Number.isFinite(value) ? value : null;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export const STRATEGY_GRID = Object.freeze([
  ...[5, 10, 20].flatMap(fast => [30, 60, 90].map(slow => Object.freeze({
    id: `trend-${fast}-${slow}`, family: 'trend', fast, slow,
  }))),
  ...[10, 20, 30].flatMap(lookback => [0.5, 1, 1.5, 2, 2.5].map(entryZ => Object.freeze({
    id: `reversion-${lookback}-${entryZ}`, family: 'meanReversion', lookback, entryZ, exitZ: 0,
  }))),
]);

function number(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`${label}: expected a finite number`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label}: expected a finite number`);
  return result;
}

function timestamp(value, row) {
  let result;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const numeric = number(value, `Row ${row} timestamp`);
    result = numeric < 1e11 ? numeric * 1000 : numeric;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    result = Date.parse(value);
    // Date.parse normalizes impossible dates, so validate the calendar date independently.
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
      throw new Error(`Row ${row}: invalid calendar date`);
    }
  } else {
    throw new Error(`Row ${row}: timestamp must be ISO with timezone, an ISO date, or Unix seconds/milliseconds`);
  }
  if (!Number.isSafeInteger(result) || result < 0 || result > 8640000000000000) throw new Error(`Row ${row}: invalid timestamp`);
  return result;
}

export function normalizeBars(input, options = {}) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 100000) {
    throw new Error('Data must contain between 2 and 100000 OHLCV rows');
  }
  const bars = input.map((raw, i) => {
    const value = Array.isArray(raw)
      ? { timestamp: raw[0], open: raw[1], high: raw[2], low: raw[3], close: raw[4], volume: raw[5] }
      : raw;
    if (!value || typeof value !== 'object') throw new Error(`Row ${i + 1}: expected an OHLCV object`);
    const bar = { timestamp: timestamp(value.timestamp ?? value.time ?? value.date, i + 1) };
    for (const key of ['open', 'high', 'low', 'close', 'volume']) bar[key] = number(value[key], `Row ${i + 1} ${key}`);
    if (bar.volume < 0 || ['open', 'high', 'low', 'close'].some(key => bar[key] <= 0)) {
      throw new Error(`Row ${i + 1}: prices must be positive and volume nonnegative`);
    }
    if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.high < bar.low) {
      throw new Error(`Row ${i + 1}: inconsistent OHLC range`);
    }
    return bar;
  });
  const differences = [];
  for (let i = 1; i < bars.length; i++) {
    const difference = bars[i].timestamp - bars[i - 1].timestamp;
    if (difference <= 0) throw new Error(`Row ${i + 1}: duplicate or unsorted timestamp; rows are never silently reordered`);
    differences.push(difference);
  }
  const frequencies = new Map();
  for (const difference of differences) frequencies.set(difference, (frequencies.get(difference) || 0) + 1);
  const inferred = [...frequencies].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const intervalMs = options.intervalMs === undefined ? inferred : number(options.intervalMs, 'intervalMs');
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('intervalMs must be a positive integer');
  const gaps = differences.flatMap((difference, i) => difference === intervalMs ? [] : [{
    afterRow: i + 1, expectedMs: intervalMs, actualMs: difference,
  }]);
  if (gaps.length && !options.allowGaps) throw new Error(`Data contains ${gaps.length} interval gaps or irregular bars; repair the source or explicitly allow gaps`);
  return { bars, quality: {
    rows: bars.length, start: bars[0].timestamp, end: bars.at(-1).timestamp,
    intervalMs, inferredInterval: options.intervalMs === undefined, gaps, zeroVolumeRows: bars.filter(bar => bar.volume === 0).length,
    duplicates: 0, invalidRows: 0, sorted: true,
  } };
}

function settings(config = {}, intervalMs = DAY) {
  const result = {
    initialCapital: config.initialCapital ?? 10000,
    feeBps: config.feeBps ?? 10,
    slippageBps: config.slippageBps ?? 5,
    barsPerYear: config.barsPerYear ?? 365.25 * DAY / intervalMs,
    minTrades: config.minTrades ?? 3,
    intervalMs,
  };
  for (const key of Object.keys(result)) result[key] = number(result[key], key);
  if (result.initialCapital <= 0 || result.initialCapital > 1e12) throw new Error('initialCapital must be in (0, 1e12]');
  if (result.feeBps < 0 || result.feeBps > 1000 || result.slippageBps < 0 || result.slippageBps > 1000) {
    throw new Error('feeBps and slippageBps must each be between 0 and 1000');
  }
  if (result.barsPerYear <= 0 || result.barsPerYear > 40000000) throw new Error('barsPerYear is outside the supported range');
  if (!Number.isInteger(result.minTrades) || result.minTrades < 1) throw new Error('minTrades must be a positive integer');
  return result;
}

function validateStrategy(strategy) {
  if (!strategy || !['trend', 'meanReversion', 'buyHold'].includes(strategy.family)) throw new Error('Unknown strategy family');
  if (strategy.family === 'trend' && (!Number.isInteger(strategy.fast) || !Number.isInteger(strategy.slow) || strategy.fast < 2 || strategy.slow <= strategy.fast || strategy.slow > 1000)) {
    throw new Error('Trend requires integer 2 <= fast < slow <= 1000');
  }
  if (strategy.family === 'meanReversion' && (!Number.isInteger(strategy.lookback) || strategy.lookback < 2 || strategy.lookback > 1000 || !Number.isFinite(strategy.entryZ) || strategy.entryZ <= 0 || !Number.isFinite(strategy.exitZ) || strategy.exitZ < 0)) {
    throw new Error('Mean reversion requires lookback 2..1000, positive entryZ and nonnegative exitZ');
  }
}

function targetPosition(bars, signalIndex, strategy, isLong) {
  if (strategy.family === 'buyHold') return true;
  const length = strategy.family === 'trend' ? strategy.slow : strategy.lookback;
  if (signalIndex < length - 1) return false;
  const prices = bars.slice(signalIndex - length + 1, signalIndex + 1).map(bar => bar.close);
  const average = mean(prices);
  if (strategy.family === 'trend') return mean(prices.slice(-strategy.fast)) > average;
  const deviation = Math.sqrt(mean(prices.map(price => (price - average) ** 2)));
  if (deviation === 0) return isLong;
  const z = (prices.at(-1) - average) / deviation;
  return isLong ? z < strategy.exitZ : z <= -strategy.entryZ;
}

function backtest(bars, strategy, config, range = {}) {
  validateStrategy(strategy);
  const start = range.start ?? 0;
  const end = range.end ?? bars.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > bars.length || end <= start) throw new Error('Invalid backtest range');
  const feeRate = config.feeBps / 10000;
  const slipRate = config.slippageBps / 10000;
  let cash = config.initialCapital, quantity = 0, entry = null;
  let peak = cash, maxDrawdown = 0, exposed = 0, fees = 0, slippageCost = 0, turnover = 0;
  const trades = [], equity = [], returns = [], fills = [];
  let previousEquity = cash;
  function buy(rawPrice, i) {
    const price = rawPrice * (1 + slipRate);
    const before = cash;
    quantity = cash / (price * (1 + feeRate));
    const fee = quantity * price * feeRate;
    fees += fee;
    slippageCost += quantity * (price - rawPrice);
    turnover += quantity * price;
    cash = 0;
    entry = { index: i, timestamp: bars[i].timestamp, signalTimestamp: strategy.family === 'buyHold' ? null : bars[i - 1]?.timestamp ?? null, price, fee, capital: before };
    fills.push({ side: 'buy', index: i, timestamp: bars[i].timestamp, signalTimestamp: entry.signalTimestamp, price, quantity, fee, reason: 'signal' });
  }
  function sell(rawPrice, i, reason) {
    const price = rawPrice * (1 - slipRate);
    const fee = quantity * price * feeRate;
    cash = quantity * price - fee;
    fees += fee;
    slippageCost += quantity * (rawPrice - price);
    turnover += quantity * price;
    const exitTime = bars[i].timestamp + (reason === 'segmentEnd' ? config.intervalMs : 0);
    fills.push({ side: 'sell', index: i, timestamp: exitTime, signalTimestamp: reason === 'signal' ? bars[i - 1]?.timestamp ?? null : null, price, quantity, fee, reason });
    trades.push({ entryIndex: entry.index, exitIndex: i, entryTimestamp: entry.timestamp, exitTimestamp: exitTime,
      entryPrice: entry.price, exitPrice: price, quantity, netPnl: cash - entry.capital,
      netReturn: cash / entry.capital - 1, fees: entry.fee + fee, exitReason: reason });
    quantity = 0;
    entry = null;
  }
  for (let i = start; i < end; i++) {
    const desired = targetPosition(bars, i - 1, strategy, quantity > 0);
    if (quantity > 0 && !desired) sell(bars[i].open, i, 'signal');
    else if (!quantity && desired) buy(bars[i].open, i);
    const wasLong = quantity > 0;
    if (wasLong) exposed++;
    if (i === end - 1 && quantity > 0) sell(bars[i].close, i, 'segmentEnd');
    const value = cash + quantity * bars[i].close;
    if (!Number.isFinite(value) || value <= 0) throw new Error('Backtest equity overflow or exhaustion');
    peak = Math.max(peak, value);
    const drawdown = 1 - value / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    returns.push(value / previousEquity - 1);
    equity.push({ timestamp: bars[i].timestamp + config.intervalMs, value, drawdown, exposed: wasLong });
    previousEquity = value;
  }
  const average = mean(returns);
  const variance = returns.length > 1 ? returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1) : 0;
  const wins = trades.filter(trade => trade.netPnl > 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = -trades.filter(trade => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  return {
    strategy, range: { start, end, startTimestamp: bars[start].timestamp, endTimestamp: bars[end - 1].timestamp + config.intervalMs },
    metrics: {
      initialCapital: config.initialCapital, finalEquity: cash,
      netReturn: cash / config.initialCapital - 1,
      annualizedReturn: finite((cash / config.initialCapital) ** (config.barsPerYear / (end - start)) - 1),
      sharpe: variance > 1e-24 ? finite(average / Math.sqrt(variance) * Math.sqrt(config.barsPerYear)) : null,
      maxDrawdown, tradeCount: trades.length, winRate: trades.length ? wins.length / trades.length : null,
      exposure: exposed / (end - start), fees, slippageCost,
      totalModeledCosts: fees + slippageCost, turnover: turnover / config.initialCapital,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      bars: end - start,
    }, equity, trades, fills,
  };
}

export function runBacktest(input, strategy, config = {}, range = {}) {
  const { bars, quality } = normalizeBars(input, config);
  return backtest(bars, strategy, settings(config, quality.intervalMs), range);
}

function trials(bars, config, end) {
  return STRATEGY_GRID.map(strategy => {
    const { metrics } = backtest(bars, strategy, config, { start: 0, end });
    const eligible = metrics.tradeCount >= config.minTrades && metrics.sharpe !== null;
    // Fixed before inspecting any validation/holdout result; no optimization on future segments.
    const score = metrics.sharpe === null ? null : metrics.sharpe - 2 * metrics.maxDrawdown;
    return { strategyId: strategy.id, strategy, metrics, score, eligible };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.score ?? -Infinity) - (a.score ?? -Infinity) || b.metrics.netReturn - a.metrics.netReturn || a.strategyId.localeCompare(b.strategyId));
}

// A non-cryptographic reproducibility checksum is always supplied. Callers may additionally
// supply SHA-256 of their original snapshot in dataHash; the label never pretends it was verified.
function checksum(bars) {
  let value = 0x811c9dc5;
  for (const bar of bars) {
    const line = `${bar.timestamp},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}\n`;
    for (let i = 0; i < line.length; i++) value = Math.imul(value ^ line.charCodeAt(i), 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

export function runResearch(input, options = {}) {
  const { bars, quality } = normalizeBars(input, options);
  if (bars.length < 300) throw new Error('Research needs at least 300 bars for training, validation and holdout');
  const config = settings(options, quality.intervalMs);
  const trainEnd = Math.floor(bars.length * 0.6);
  const validationEnd = Math.floor(bars.length * 0.8);
  const experiments = trials(bars, config, trainEnd);
  const winner = experiments[0];
  const selected = { ...winner, role: winner.eligible ? 'researchCandidate' : 'diagnosticOnly' };
  const training = backtest(bars, selected.strategy, config, { end: trainEnd });
  const validation = backtest(bars, selected.strategy, config, { start: trainEnd, end: validationEnd });
  const holdout = backtest(bars, selected.strategy, config, { start: validationEnd });
  const baseline = {
    training: backtest(bars, { id: 'buy-hold', family: 'buyHold' }, config, { end: trainEnd }),
    validation: backtest(bars, { id: 'buy-hold', family: 'buyHold' }, config, { start: trainEnd, end: validationEnd }),
    holdout: backtest(bars, { id: 'buy-hold', family: 'buyHold' }, config, { start: validationEnd }),
  };
  const firstTrainEnd = Math.floor(validationEnd / 2);
  const walkForward = Array.from({ length: 3 }, (_, index) => {
    const start = firstTrainEnd + Math.floor((validationEnd - firstTrainEnd) * index / 3);
    const end = firstTrainEnd + Math.floor((validationEnd - firstTrainEnd) * (index + 1) / 3);
    const chosen = trials(bars, config, start)[0];
    return { fold: index + 1, trainRange: { start: 0, end: start }, selected: chosen,
      test: backtest(bars, chosen.strategy, config, { start, end }),
      baseline: backtest(bars, { id: 'buy-hold', family: 'buyHold' }, config, { start, end }),
    };
  });
  const warnings = [
    'Research only: past results do not identify a future best strategy or authorize any live order.',
    'Final holdout is now revealed. Repeated parameter/design changes after viewing it contaminate the holdout; use new untouched data.',
    '24 predefined trials introduce selection bias; train/validation/walk-forward results overlap and are not independent evidence.',
    'Long/flat unlevered spot model with all-in fractional sizing. No shorting, leverage, funding, borrow, taxes, spreads beyond fixed slippage, liquidity/market-impact or intrabar stop model.',
    'Signals use the previous completed close; fills occur at the next open. Every segment starts in cash and liquidates at its last close with both costs.',
    'Drawdown and Sharpe use bar-close equity only; intrabar losses can be larger. Sharpe assumes zero risk-free rate and the configured annualization.',
  ];
  if (!selected.eligible) warnings.push(`No strategy meets the training minimum of ${config.minTrades} completed trades with finite Sharpe; the selection is diagnostic only.`);
  if (quality.gaps.length) warnings.push('Irregular intervals were explicitly accepted. Per-bar annualization and execution timing may be unsuitable for this calendar.');
  if (quality.zeroVolumeRows) warnings.push(`${quality.zeroVolumeRows} rows have zero volume; fills assume liquidity and may be infeasible.`);
  if (validation.metrics.tradeCount < config.minTrades || holdout.metrics.tradeCount < config.minTrades) warnings.push('Validation or holdout has too few completed trades for stable conclusions.');
  if (validation.metrics.netReturn <= 0 || holdout.metrics.netReturn <= 0) warnings.push('The frozen candidate loses money in validation or holdout after modeled costs.');
  if (holdout.metrics.netReturn < baseline.holdout.metrics.netReturn) warnings.push('The frozen candidate underperforms the cost-adjusted buy-and-hold baseline in holdout.');
  const configHash = JSON.stringify(config);
  return {
    schemaVersion: 1, methodVersion: METHOD_VERSION,
    config: { ...config, marketModel: 'unlevered-spot-long-flat', selectionRule: 'training Sharpe - 2 * training maxDrawdown; eligible trials first', gridSize: STRATEGY_GRID.length },
    data: { ...quality, checksum: checksum(bars), checksumAlgorithm: 'fnv1a32-canonical-ohlcv',
      suppliedSha256: options.dataHash ?? null, source: options.source ?? 'user-import',
      snapshotId: options.snapshotId ?? null,
    },
    reproduction: { methodVersion: METHOD_VERSION, config: configHash, inputOrdering: 'strictly chronological', randomness: 'none' },
    splits: { train: { start: 0, end: trainEnd }, validation: { start: trainEnd, end: validationEnd }, holdout: { start: validationEnd, end: bars.length }, holdoutRevealed: true },
    experiments, selected, training, validation, holdout, baseline, walkForward, warnings,
  };
}
