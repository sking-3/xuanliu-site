// Copyright Viprasol. JavaScript adaptation of the four named Pine indicators.
// https://github.com/Viprasol-Tech/tradingview-indicators/tree/a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0
// This Source Code Form is subject to the Mozilla Public License, v. 2.0.
// Obtain the license at https://mozilla.org/MPL/2.0/.
import {atr, pivots, sma, validateBars, parameters as readParameters, crossOver, crossUnder} from './viprasol-math.mjs';

const number = (key, label, value, min, max, integer = false) => ({key, label, value, type: integer ? 'integer' : 'number', integer, ...(min === undefined ? {} : {min}), ...(max === undefined ? {} : {max})});
const boolean = (key, label, value) => ({key, label, value, type: 'boolean'});
const select = (key, label, value, options) => ({key, label, value, type: 'select', options});
const definitions = [
  {id: 'double-tap-double-top-bottom', title: 'Double Tap · 双顶与双底', parameters: [
    number('pivLen', '枢轴确认宽度', 20, 2, undefined, true), number('tol', '同层容差占形态高度%', 12, 1, 50),
    number('minW', '形态最小K数', 8, 2, undefined, true), number('maxW', '形态最大K数', 150, 10, undefined, true),
    boolean('detTop', '检测双顶', true), boolean('detBot', '检测双底', true),
    number('targFib', '目标占形态高度%', 100, 10), number('atrLen', 'ATR周期', 14, 1, undefined, true),
    number('slBuf', '止损ATR缓冲', .5, 0), number('maxKeep', '保留参考形态数', 8, 1, 30, true),
    number('zoneLen', '参考区间延伸K数', 30, 5, undefined, true),
  ]},
  {id: 'wave-structure-pro-v2', title: 'Wave Structure PRO v2 · 波浪结构', parameters: [
    number('depth', '左右枢轴确认宽度', 8, 2, 50, true), number('w3ext', 'W3投射倍数', 1.618),
    number('w5ext', 'W5投射倍数', 1), number('minQual', '高质量提示阈值', 60, 0, 100, true),
  ]},
  {id: 'z-score-stats', title: 'Z-Score & Stats · 标准分与统计', parameters: [
    select('i_source', '价格序列', 'close', ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4']),
    number('i_length', '标准分窗口', 20, 2, undefined, true),
    select('i_stats_period', '年度统计口径', 'Calendar year', ['Calendar year', 'Fixed bar count (classic)']),
    number('i_yearly_bars', '固定块K数', 252, 1, undefined, true), number('i_rank_length', '绝对Z历史分位窗口', 500, 50, 2000, true),
    number('i_vol_length', '成交量均值周期', 20, 2, undefined, true), number('i_vol_threshold', '缩量比例上限', .7, .1, 1),
    number('i_projection_bars', '线性外推K数', 10, 1, 50, true), number('i_momentum_factor', '外推动量系数', .5, .1, 2),
    number('i_div_lookback', '背离枢轴左右宽度', 5, 1, 20, true), number('i_div_range', '背离最大间隔', 60, 10, 200, true),
    number('i_div_min_range', '背离最小间隔', 5, 1, 50, true), boolean('i_show_hidden_div', '包含隐藏背离', false),
    number('i_div_gap', '背离提示最小间隔', 10, 0, 100, true), number('i_reentry_level', '回归带阈值', 2.5, 1, 4),
    number('i_reentry_gap', '回归带提示最小间隔', 10, 1, 100, true),
  ]},
  {id: 'goal-setting-strategies', title: 'Goal Setting · 目标进度', parameters: [
    {key: 'vip_goal_name', label: '主要目标', value: 'Elite Trading Goal', type: 'string'},
    number('vip_total_goals', '显示目标数', 4, 1, 20, true),
    {key: 'goals', label: '20项目标与完成状态', type: 'goals', value: Object.freeze(Array.from({length: 20}, (_, i) => Object.freeze({label: 'Milestone ' + (i + 1), done: false})))},
  ]},
];
export const catalog = Object.freeze(definitions.map(item => Object.freeze({...item, sourceFile: item.id + '.pine',
  defaults: Object.freeze(Object.fromEntries(item.parameters.map(spec => [spec.key, spec.value]))),
  parameters: Object.freeze(item.parameters.map(spec => Object.freeze(spec))),
})));
const plot = (name, values, pane = 'price', unit = 'price') => ({name, values, pane, unit});
const researchNotes = [
  '原作者为Viprasol，原始Pine版本已固定；这些是指标提示，不是交易执行或已验证盈利策略。',
  'time保留原始K线时间；仅在当前K线收盘后读取，确认枢轴不回移发现时间。',
];
function result(id, parameters, signals, plots = [], zones = [], notes = [], extra = {}) {
  return {id, parameters, signals, plots, zones, notes: [...researchNotes, ...notes], status: 'ready', missingDependencies: [], ...extra};
}
const event = (bars, index, side, type, patch = {}) => ({index, time: bars[index].time, side, type, entry: bars[index].close, stop: null, target: null, ...patch});

function doubleTap(id, bars, params) {
  const range = atr(bars, params.atrLen), highs = pivots(bars.map(bar => bar.high), params.pivLen), lows = pivots(bars.map(bar => bar.low), params.pivLen, params.pivLen, 'low');
  const signals = [], patterns = [], topLine = [], bottomLine = [];
  let lastHigh = null, previousHigh = null, lastLow = null, previousLow = null, top = null, bottom = null, wins = 0, losses = 0;
  for (let i = 0; i < bars.length; i++) {
    if (highs[i]) {previousHigh = lastHigh; lastHigh = highs[i];}
    if (lows[i]) {previousLow = lastLow; lastLow = lows[i];}
    if (highs[i] && params.detTop && previousHigh && lastLow) {
      const width = lastHigh.index - previousHigh.index, height = (previousHigh.value + lastHigh.value) / 2 - lastLow.value;
      if (lastLow.index > previousHigh.index && lastLow.index < lastHigh.index && width >= params.minW && width <= params.maxW
        && height > 0 && Math.abs(previousHigh.value - lastHigh.value) <= height * params.tol / 100) top = {first: previousHigh, second: lastHigh, neck: lastLow, height};
    }
    if (lows[i] && params.detBot && previousLow && lastHigh) {
      const width = lastLow.index - previousLow.index, height = lastHigh.value - (previousLow.value + lastLow.value) / 2;
      if (lastHigh.index > previousLow.index && lastHigh.index < lastLow.index && width >= params.minW && width <= params.maxW
        && height > 0 && Math.abs(previousLow.value - lastLow.value) <= height * params.tol / 100) bottom = {first: previousLow, second: lastLow, neck: lastHigh, height};
    }
    if (top && bars[i].high > Math.max(top.first.value, top.second.value)) top = null;
    if (bottom && bars[i].low < Math.min(bottom.first.value, bottom.second.value)) bottom = null;
    topLine.push(top ? top.neck.value : null); bottomLine.push(bottom ? bottom.neck.value : null);
    const topSignal = top && i > 0 && bars[i].close < top.neck.value && bars[i - 1].close >= top.neck.value;
    const bottomSignal = bottom && i > 0 && bars[i].close > bottom.neck.value && bars[i - 1].close <= bottom.neck.value;
    if (topSignal || bottomSignal) {
      const current = topSignal ? top : bottom, side = topSignal ? 'short' : 'long', twin = topSignal ? Math.max(current.first.value, current.second.value) : Math.min(current.first.value, current.second.value);
      const stop = range[i] === null ? null : twin + (topSignal ? 1 : -1) * range[i] * params.slBuf;
      const target = current.neck.value + (topSignal ? -1 : 1) * current.height * params.targFib / 100;
      const marker = event(bars, i, side, topSignal ? 'double_top' : 'double_bottom', {stop, target});
      signals.push(marker);
      patterns.push({...marker, startIndex: current.first.index, secondIndex: current.second.index, neckIndex: current.neck.index, neck: current.neck.value, height: current.height, active: true, endIndex: i + params.zoneLen, outcome: null});
      if (patterns.length > params.maxKeep) patterns.shift();
      if (topSignal) top = null; else bottom = null;
    }
    for (const current of patterns) if (current.active) {
      current.endIndex = i + params.zoneLen;
      const hitTarget = current.side === 'short' ? bars[i].low <= current.target : bars[i].high >= current.target;
      const hitStop = Number.isFinite(current.stop) && (current.side === 'short' ? bars[i].high >= current.stop : bars[i].low <= current.stop);
      if (hitTarget || hitStop) {
        current.active = false; current.outcome = hitTarget && !hitStop ? 'target_only' : 'stop_or_ambiguous';
        if (current.outcome === 'target_only') wins++; else losses++;
      }
    }
  }
  const total = wins + losses;
  return result(id, params, signals, [plot('待确认双顶颈线', topLine), plot('待确认双底颈线', bottomLine)], patterns,
    ['颈线收盘交叉才提示，错误方向先破坏形态则撤销；同根TP/SL仅是上游参考区间统计，两者同触计失败，不代表真实成交。'],
    {summary: {referenceWins: wins, referenceLosses: losses, referenceHitRate: total ? wins / total * 100 : null, armedTop: Boolean(top), armedBottom: Boolean(bottom)}});
}

function pushSwing(swings, point, type) {
  if (!point) return false;
  const next = {price: point.value, index: point.index, type}, last = swings.at(-1);
  if (last && last.type === type) {
    if (!(type === 1 ? next.price > last.price : next.price < last.price)) return false;
    swings[swings.length - 1] = next;
  } else swings.push(next);
  if (swings.length > 32) swings.shift();
  return true;
}
function validImpulse(points, start) {
  const [p0, p1, p2, p3, p4, p5] = points.slice(start, start + 6).map(point => point.price), up = points[start].type === -1;
  const w1 = Math.abs(p1 - p0), w3 = Math.abs(p3 - p2), w5 = Math.abs(p5 - p4);
  const direction = up ? p1 > p0 && p3 > p1 && p5 > p3 && p2 < p1 && p4 < p3 : p1 < p0 && p3 < p1 && p5 < p3 && p2 > p1 && p4 > p3;
  return direction && (up ? p2 > p0 : p2 < p0) && !(w3 < w1 && w3 < w5) && (up ? p4 > p1 : p4 < p1);
}
function validCorrection(points, start, up) {
  const [p5, a, b, c] = points.slice(start, start + 4).map(point => point.price);
  return up ? a < p5 && b > a && c < b && b < p5 : a > p5 && b < a && c > b && b > p5;
}
function waveCount(swings, parameters) {
  let start = -1, full = false, end = -1;
  for (let e = swings.length - 1; e >= 5; e--) {
    if (e >= 8 && validImpulse(swings, e - 8) && validCorrection(swings, e - 3, swings[e - 8].type === -1)) {start = e - 8; full = true; end = e; break;}
    if (validImpulse(swings, e - 5)) {start = e - 5; end = e; break;}
  }
  if (start < 0) return null;
  const points = swings.slice(start, start + (full ? 9 : 6)), [p0, p1, p2, p3, p4, p5] = points.map(point => point.price);
  const up = points[0].type === -1, w1 = Math.abs(p1 - p0), w3 = Math.abs(p3 - p2);
  const ratios = {w2: Math.abs(p2 - p1) / w1, w3: w3 / w1, w4: Math.abs(p4 - p3) / w3, w5: Math.abs(p5 - p4) / w1};
  const fit = (actual, ideal, tolerance) => Math.max(0, 1 - Math.abs(actual - ideal) / tolerance);
  const q2 = fit(ratios.w2, .559, .3), q3 = ratios.w3 >= 1.618 ? 1 : Math.max(0, ratios.w3 / 1.618), q4 = fit(ratios.w4, .382, .3);
  const q5a = fit(ratios.w5, 1, .5), q5b = fit(ratios.w5, .618 * (w1 + w3) / w1, .5), q5 = Math.max(q5a, q5b);
  const projectedW3 = p2 + (up ? 1 : -1) * w1 * parameters.w3ext, projectedW5 = p4 + (up ? 1 : -1) * w1 * parameters.w5ext;
  const channelSlope = (p4 - p2) / (points[4].index - points[2].index), channelEnd = points[5].index + parameters.depth * 3;
  const channelOffset = p3 - (p2 + channelSlope * (points[3].index - points[2].index));
  return {valid: true, up, full, startIndex: points[0].index, current: end === swings.length - 1, quality: (q2 + q3 + q4 + q5) / 4 * 100,
    invalidation: p0, ratios, alternation: Math.abs(ratios.w2 - Math.abs(p4 - p3) / w1) > .2,
    extendedFifth: q5b > q5a, projectedW3, projectedW5, points,
    baseChannel: {type: 'wave_base_channel', startIndex: points[2].index, endIndex: channelEnd, slope: channelSlope, start: p2,
      end: p2 + channelSlope * (channelEnd - points[2].index), parallelOffset: channelOffset},
    retracement: full ? null : {startIndex: points[5].index, endIndex: points[5].index + parameters.depth * 4,
      high: Math.max(p5 - (p5 - p0) * .382, p5 - (p5 - p0) * .618), low: Math.min(p5 - (p5 - p0) * .382, p5 - (p5 - p0) * .618)}};
}
function waves(id, bars, params) {
  const highs = pivots(bars.map(bar => bar.high), params.depth), lows = pivots(bars.map(bar => bar.low), params.depth, params.depth, 'low');
  const swings = [], signals = [], quality = [], direction = [], stage = [], invalidation = [], target3 = [], target5 = [];
  let state = null;
  for (let i = 0; i < bars.length; i++) {
    const changedHigh = pushSwing(swings, highs[i], 1), changedLow = pushSwing(swings, lows[i], -1);
    if (changedHigh || changedLow) {
      const previous = state;
      state = waveCount(swings, params);
      const found = state && (!previous || state.startIndex !== previous.startIndex), lost = previous && !state, full = state && state.full && !(previous && previous.full);
      if (found) signals.push(event(bars, i, state.up ? 'long' : 'short', 'count_found', {stop: state.invalidation, quality: state.quality, highQuality: state.quality >= params.minQual}));
      if (lost) signals.push(event(bars, i, previous.up ? 'long' : 'short', 'count_invalidated'));
      if (full) signals.push(event(bars, i, state.up ? 'long' : 'short', 'abc_complete', {stop: state.invalidation, quality: state.quality}));
    }
    quality.push(state ? state.quality : null); direction.push(state ? state.up ? 1 : -1 : 0);
    stage.push(state ? state.full ? 2 : 1 : 0); invalidation.push(state ? state.invalidation : null);
    target3.push(state ? state.projectedW3 : null); target5.push(state ? state.projectedW5 : null);
  }
  return result(id, params, signals, [plot('Count Quality', quality, 'oscillator', 'percent'), plot('Count Direction', direction, 'oscillator', 'direction'), plot('Count Stage', stage, 'oscillator', 'stage'), plot('Invalidation Level', invalidation), plot('W3参考投射', target3), plot('W5参考投射', target5)],
    state ? [state.baseChannel, ...(state.retracement ? [{type: 'wave_retracement', ...state.retracement}] : [])] : [], ['波浪会在新枢轴确认后重新计数；优先最新结束枢轴，同一结束点优先完整ABC，不按收益选择计数。',
      '发现、失效、ABC完成是结构事件，不是原生买卖策略；失效仅指新枢轴重数后无有效计数。'], {summary: state});
}

function sourceSeries(bars, key) {
  return bars.map(bar => key === 'hl2' ? (bar.high + bar.low) / 2 : key === 'hlc3' ? (bar.high + bar.low + bar.close) / 3 : key === 'ohlc4' ? (bar.open + bar.high + bar.low + bar.close) / 4 : bar[key]);
}
function zSeries(values, length) {
  const queue = [];
  let sum = 0, squares = 0;
  return values.map(value => {
    if (queue.length === length) {const old = queue.shift(); sum -= old; squares -= old * old;}
    queue.push(value); sum += value; squares += value * value;
    if (queue.length < 2) return null;
    const mean = sum / queue.length, population = Math.max(0, squares / queue.length - mean * mean);
    const variance = population < 1e-10 ? 0 : population * queue.length / (queue.length - 1), sd = Math.sqrt(variance);
    return sd > 1e-10 ? (value - mean) / sd : Math.abs(value - mean) < 1e-10 ? 0 : null;
  });
}
function divergence(points, current, source, params, bullish) {
  if (!current) return null;
  points.unshift({value: current.value, index: current.index, price: source[current.index]});
  if (points.length > 10) points.pop();
  for (let at = 1; at <= Math.min(points.length - 1, 5); at++) {
    const now = points[0], previous = points[at], distance = now.index - previous.index;
    if (distance < params.i_div_min_range || distance > params.i_div_range) continue;
    const regular = bullish ? now.price < previous.price && now.value > previous.value : now.price > previous.price && now.value < previous.value;
    const hidden = params.i_show_hidden_div && (bullish ? now.price > previous.price && now.value < previous.value : now.price < previous.price && now.value > previous.value);
    if (regular || hidden) return {type: regular ? 'regular_divergence' : 'hidden_divergence', pivotIndex: now.index, startIndex: previous.index, z: now.value};
  }
  return null;
}
function zscore(id, bars, params, context) {
  const source = sourceSeries(bars, params.i_source), z = zSeries(source, params.i_length), volumeAverage = sma(bars.map(bar => bar.volume), params.i_vol_length);
  const highs = pivots(z, params.i_div_lookback), lows = pivots(z, params.i_div_lookback, params.i_div_lookback, 'low');
  const signals = [], lowPoints = [], highPoints = [], projected = [], ratios = [], contracted = [], ranks = [], maxZ = [], averageMax = [], coverage = [], years = [];
  const zone = context.timeZone || 'UTC', yearOf = new Intl.DateTimeFormat('en', {timeZone: zone, year: 'numeric'});
  let lastDivergence = null, lastReentry = null, yearHigh = null, yearLow = null, blockCount = 0, firstYearPartial = true, lastDivergenceInfo = null;
  for (let i = 0; i < bars.length; i++) {
    const value = z[i], before = i > 0 && Number.isFinite(z[i - 1]) ? z[i - 1] : 0;
    projected.push(value === null ? null : Math.max(-4, Math.min(4, value + (value - before) * params.i_momentum_factor * params.i_projection_bars)));
    const volumeRatio = volumeAverage[i] > 0 ? bars[i].volume / volumeAverage[i] : null;
    ratios.push(volumeRatio); contracted.push(volumeRatio !== null && volumeRatio < params.i_vol_threshold);
    const bull = divergence(lowPoints, lows[i], source, params, true), bear = divergence(highPoints, highs[i], source, params, false);
    const gap = params.i_div_gap === 0 || lastDivergence === null || i - lastDivergence >= params.i_div_gap;
    if (gap && (bull || bear)) {
      lastDivergence = i;
      if (bull) {signals.push(event(bars, i, 'long', bull.type, bull)); lastDivergenceInfo = {...bull, side: 'long', confirmedIndex: i};}
      if (bear) {signals.push(event(bars, i, 'short', bear.type, bear)); lastDivergenceInfo = {...bear, side: 'short', confirmedIndex: i};}
    }
    const reentryGap = lastReentry === null || i - lastReentry >= params.i_reentry_gap;
    const down = crossUnder(z, params.i_reentry_level, i), up = crossOver(z, -params.i_reentry_level, i);
    if (reentryGap && (up || down)) {
      lastReentry = i; signals.push(event(bars, i, up ? 'long' : 'short', up ? 'band_reentry_up' : 'band_reentry_down'));
    }
    if (value !== null) {
      for (const level of [3.5, 4]) {
        if (value >= level && before < level) signals.push(event(bars, i, 'short', 'extreme_above_' + level));
        if (value <= -level && before > -level) signals.push(event(bars, i, 'long', 'extreme_below_' + level));
      }
      if (value <= -3.5 && contracted[i] && !(before <= -3.5 && contracted[i - 1])) signals.push(event(bars, i, 'long', 'oversold_low_volume'));
      if (value >= 3.5 && contracted[i] && !(before >= 3.5 && contracted[i - 1])) signals.push(event(bars, i, 'short', 'overbought_low_volume'));
    }
    if (params.i_stats_period === 'Fixed bar count (classic)') {
      blockCount++;
      if (blockCount === 1) {yearHigh = value; yearLow = value;}
      if (value !== null) {yearHigh = yearHigh === null ? value : Math.max(yearHigh, value); yearLow = yearLow === null ? value : Math.min(yearLow, value);}
      if (blockCount >= params.i_yearly_bars) {
        if (yearHigh !== null) years.push(Math.max(Math.abs(yearHigh), Math.abs(yearLow)));
        yearHigh = value; yearLow = value; blockCount = 0;
      }
    } else {
      if (i > 0 && yearOf.format(bars[i].time) !== yearOf.format(bars[i - 1].time)) {
        if (!firstYearPartial && yearHigh !== null) years.push(Math.max(Math.abs(yearHigh), Math.abs(yearLow)));
        firstYearPartial = false; yearHigh = null; yearLow = null;
      }
      if (value !== null) {yearHigh = yearHigh === null ? value : Math.max(yearHigh, value); yearLow = yearLow === null ? value : Math.min(yearLow, value);}
    }
    maxZ.push(Math.max(Math.abs(yearHigh ?? 0), Math.abs(yearLow ?? 0)));
    averageMax.push(years.length ? years.reduce((sum, value) => sum + value, 0) / years.length : null);
    const history = z.slice(Math.max(0, i - params.i_rank_length + 1), i + 1);
    ranks.push(value !== null && history.length === params.i_rank_length && history.every(Number.isFinite) ? history.filter(item => Math.abs(item) <= Math.abs(value)).length / history.length * 100 : null);
    const magnitude = Math.abs(value ?? 0);
    coverage.push(magnitude >= 3 ? 99.7 : magnitude >= 2.5 ? 98.8 : magnitude >= 2 ? 95.4 : magnitude >= 1.5 ? 86.6 : magnitude >= 1 ? 68.3 : magnitude >= .5 ? 38.3 : 0);
  }
  return result(id, params, signals, [plot('Z-score', z, 'oscillator', 'z'), plot('Projected Z（线性外推，非预测）', projected, 'oscillator', 'z'), plot('成交量比', ratios, 'oscillator', 'ratio'), plot('Year Max |Z|', maxZ, 'oscillator', 'z'), plot('Avg Yearly Max |Z|', averageMax, 'oscillator', 'z'), plot('|Z| Rank %', ranks, 'oscillator', 'percent'), plot('Normal Coverage %（非反转概率）', coverage, 'oscillator', 'percent')], [],
    ['标准分采用包含当前K的可用窗口和N−1样本标准差；只有1根时未知，平价窗口为0。',
      '极值、回归带和背离为原告警事件，没有原生止盈止损；投射值仅按最近变化线性外推并限制在−4至4。',
      '历年统计使用时区 ' + zone + '；首个不完整自然年不计入历年均值。'],
    {summary: {z: z.at(-1) ?? null, projected: projected.at(-1) ?? null, volumeRatio: ratios.at(-1) ?? null, contracted: contracted.at(-1) ?? false,
      yearMaxAbs: maxZ.at(-1) ?? null, averageYearMaxAbs: averageMax.at(-1) ?? null, rank: ranks.at(-1) ?? null, normalCoverage: coverage.at(-1) ?? null, lastDivergence: lastDivergenceInfo}});
}

function goals(id, params) {
  if (!Array.isArray(params.goals) || params.goals.length < 1 || params.goals.length > 20 || params.vip_total_goals > params.goals.length
    || params.goals.some(goal => !goal || typeof goal.label !== 'string' || typeof goal.done !== 'boolean')) throw Error('目标必须为1至20条名称与布尔完成状态，且覆盖显示目标数');
  const shown = params.goals.slice(0, params.vip_total_goals).map(goal => ({label: goal.label, done: goal.done}));
  const complete = shown.filter(goal => goal.done).length;
  return result(id, {...params, goals: params.goals.map(goal => ({...goal}))}, [], [], [], ['原脚本为用户勾选的目标看板，不读取行情、不生成入场信号。',
    '进度仅统计当前显示的前 ' + params.vip_total_goals + ' 项：' + complete + '/' + params.vip_total_goals + '。'],
    {progress: {name: params.vip_goal_name, goals: shown, total: params.vip_total_goals, complete, percent: complete / params.vip_total_goals * 100}});
}

export function evaluateIndicator(id, bars = [], input = {}, context = {}) {
  const definition = catalog.find(item => item.id === id);
  if (!definition) throw Error('尚未移植的指标：' + id);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('参数必须为对象');
  const parameters = readParameters(definition.parameters, definition.defaults, input);
  if (id === 'goal-setting-strategies') return goals(id, parameters);
  validateBars(bars);
  if (id === 'double-tap-double-top-bottom') return doubleTap(id, bars, parameters);
  if (id === 'wave-structure-pro-v2') return waves(id, bars, parameters);
  return zscore(id, bars, parameters, context);
}
