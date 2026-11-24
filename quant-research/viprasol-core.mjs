// Adapted from Viprasol's Pine indicators, copyright Viprasol.
// Source: https://github.com/Viprasol-Tech/tradingview-indicators
// Pinned commit: a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0
// This Source Code Form is subject to the Mozilla Public License, v. 2.0.
// If a copy was not distributed with this file, obtain one at https://mozilla.org/MPL/2.0/.
// JavaScript adaptation: closed-bar signals and reference levels, not execution or a backtest.

export const SOURCE_COMMIT = 'a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0';
const numeric = (label, value, min, max = null, integer = false) => ({label, value, min, max, type: integer ? 'integer' : 'number'});
const common = {
  atrLen: numeric('ATR周期', 14, 1, null, true),
  rr: numeric('目标风险倍数', 2, .5),
  slBuf: numeric('止损ATR缓冲', .3, 0),
  sigGap: numeric('信号最小间隔（严格大于）', 15, 0, null, true),
  oneAtATime: {label: '参考区间未结束时暂停新信号', value: true, type: 'boolean'},
};
const definitions = [
  {id: 'tyson', title: 'Tyson · 压缩弹簧突破', sourceFile: 'tyson-uppercut-compression-spring-breakout.pine', parameters: {
    compLen: numeric('压缩窗口', 10, 3, null, true),
    compFrac: numeric('压缩占双倍窗口比例上限', .6, .2),
    maxCompATR: numeric('压缩高度ATR上限', 3, .5),
    expMult: numeric('突破K振幅ATR下限', 1.3, .3),
    ...common,
  }},
  {id: 'ronaldo', title: 'Ronaldo · 轨道上缘突破', sourceFile: 'ronaldo-bicycle-kick-orbit-break-reversal.pine', parameters: {
    pL: numeric('枢轴左侧K数', 3, 1, null, true),
    pR: numeric('枢轴右侧确认K数', 3, 1, null, true),
    kSwings: numeric('轨道使用枢轴数', 6, 3, 10, true),
    minSwings: numeric('最少枢轴数', 5, 3, null, true),
    orbitMult: numeric('轨道半径倍数', 1, .2),
    minRadATR: numeric('最小轨道半径ATR', .8, .1),
    ...common,
  }},
  {id: 'khabib', title: 'Khabib · 嵌套分形破位', sourceFile: 'khabib-takedown-fractal-nest-breakdown.pine', parameters: {
    pL: numeric('枢轴左侧K数', 3, 1, null, true),
    pR: numeric('枢轴右侧确认K数', 3, 1, null, true),
    ratLo: numeric('小腿与大腿比例下限', .3, .1),
    ratHi: numeric('小腿与大腿比例上限', .75, .2),
    minBigATR: numeric('大腿最小ATR倍数', 1.5, .3),
    ...common,
  }},
];
export const catalog = Object.freeze(definitions.map(definition => {
  const parameters = Object.freeze(Object.entries(definition.parameters).map(([key, spec]) => Object.freeze({key, ...spec, integer: spec.type === 'integer'})));
  return Object.freeze({...definition, parameters, defaults: Object.freeze(Object.fromEntries(parameters.map(spec => [spec.key, spec.value])))});
}));

function parametersFor(definition, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须为对象');
  for (const name of Object.keys(input)) if (!Object.hasOwn(definition.defaults, name)) throw new Error('未知参数：' + name);
  const parameters = {...definition.defaults, ...input};
  for (const spec of definition.parameters) {
    const name = spec.key;
    const value = parameters[name];
    if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(name + '必须为布尔值');
    } else if (!Number.isFinite(value) || spec.type === 'integer' && !Number.isSafeInteger(value)
      || value < spec.min || spec.max !== null && value > spec.max) throw new Error(name + '超出原指标参数范围');
  }
  return parameters;
}

function checkBars(bars) {
  if (!Array.isArray(bars)) throw new Error('日线必须为数组');
  bars.forEach((bar, index) => {
    if (!bar || !Number.isSafeInteger(bar.time) || bar.time < 0 || index > 0 && bar.time <= bars[index - 1].time) throw new Error('K线时间无效、重复或未递增：' + index);
    if (['open', 'high', 'low', 'close', 'volume'].some(name => !Number.isFinite(bar[name]) || bar[name] < 0)
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.high < bar.low) throw new Error('K线OHLCV无效：' + index);
  });
}

function atrSeries(bars, length) {
  let seed = 0, previous = null;
  return bars.map((bar, index) => {
    const tr = index === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close));
    if (index < length) seed += (tr - seed) / (index + 1);
    if (index < length - 1) return null;
    previous = index === length - 1 ? seed : previous * (1 - 1 / length) + tr / length;
    return previous;
  });
}

function previousRange(bars, index, length) {
  let high = -Infinity, low = Infinity;
  for (let at = Math.max(0, index - length); at < index; at++) {
    high = Math.max(high, bars[at].high);
    low = Math.min(low, bars[at].low);
  }
  return index === 0 ? null : {high, low, range: high - low};
}

function confirmSwing(bars, index, parameters, swings) {
  const {pL, pR} = parameters;
  if (index < pL + pR) return;
  const at = index - pR, bar = bars[at];
  let high = true, low = true;
  for (let i = at - pL; i <= index; i++) {
    if (i === at) continue;
    // Equal extrema to the right supersede this candidate; equal left extrema do not.
    high = high && (i < at ? bar.high >= bars[i].high : bar.high > bars[i].high);
    low = low && (i < at ? bar.low <= bars[i].low : bar.low < bars[i].low);
  }
  if (!high && !low) return;
  const type = high ? 1 : -1, price = high ? bar.high : bar.low, last = swings.at(-1);
  if (last && last.type === type) {
    if (type === 1 && price > last.price || type === -1 && price < last.price) swings[swings.length - 1] = {type, price, index: at};
  } else {
    swings.push({type, price, index: at});
    if (swings.length > 12) swings.shift();
  }
}

function orbit(swings, atr, parameters) {
  const points = swings.slice(-parameters.kSwings);
  if (points.length < parameters.minSwings || atr === null) return null;
  const center = points.reduce((sum, point) => sum + point.price, 0) / points.length;
  const radius = Math.sqrt(points.reduce((sum, point) => sum + (point.price - center) ** 2, 0) / points.length) * parameters.orbitMult;
  if (radius < parameters.minRadATR * atr) return null;
  return {center, top: center + radius, bottom: center - radius, low: Math.min(...points.map(point => point.price))};
}

export function evaluateIndicator(id, bars, params = {}) {
  const definition = catalog.find(item => item.id === id);
  if (!definition) throw new Error('尚未移植的指标：' + id);
  const parameters = parametersFor(definition, params);
  checkBars(bars);
  const atr = atrSeries(bars, parameters.atrLen), signals = [], swings = [], active = [];
  const names = id === 'tyson' ? ['压缩高点', '压缩低点'] : id === 'ronaldo' ? ['轨道上缘', '轨道中心', '轨道下缘'] : ['分形破位参考', '后高参考'];
  const plots = names.map(name => ({name, values: Array(bars.length).fill(null)}));
  let lastSignal = -100000;

  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index], value = atr[index];
    let signal = false, stop = null;
    if (id !== 'tyson') confirmSwing(bars, index, parameters, swings);
    if (value !== null) {
      if (id === 'tyson') {
        const compression = previousRange(bars, index, parameters.compLen), wide = previousRange(bars, index, parameters.compLen * 2);
        const compressed = compression && compression.range > 0 && compression.range <= parameters.compFrac * wide.range && compression.range <= parameters.maxCompATR * value;
        if (compressed) {
          plots[0].values[index] = compression.high;
          plots[1].values[index] = compression.low;
          signal = bar.close > compression.high && bar.high - bar.low >= parameters.expMult * value && bar.close > bar.open;
          stop = compression.low - value * parameters.slBuf;
        }
      } else if (id === 'ronaldo') {
        const current = orbit(swings, value, parameters);
        if (current) {
          [current.top, current.center, current.bottom].forEach((point, i) => { plots[i].values[index] = point; });
          signal = index > 0 && bar.close > current.top && bars[index - 1].close <= current.top;
          stop = current.low - value * parameters.slBuf;
        }
      } else {
        const points = swings.slice(-4);
        if (points.length === 4 && points.every((point, i) => point.type === (i % 2 ? -1 : 1))) {
          const [s3, s2, s1, s0] = points.map(point => point.price), big = s3 - s2, small = s1 - s0;
          const ratio = big > 0 ? small / big : null;
          plots[0].values[index] = s0;
          plots[1].values[index] = s1;
          signal = s1 < s3 && s0 < s2 && big >= parameters.minBigATR * value && small > 0
            && ratio >= parameters.ratLo && ratio <= parameters.ratHi && bar.close < s0 && bar.close < bar.open;
          stop = s1 + value * parameters.slBuf;
        }
      }
      const blocked = parameters.oneAtATime && active.length > 0;
      if (signal && !blocked && index - lastSignal > parameters.sigGap) {
        const side = id === 'khabib' ? 'short' : 'long', entry = bar.close;
        const target = side === 'long' ? entry + parameters.rr * (entry - stop) : entry - parameters.rr * (stop - entry);
        const current = {index, time: bar.time, side, entry, stop, target};
        signals.push(current);
        active.push(current);
        lastSignal = index;
      }
    }
    // Preserve the upstream reference-zone lifecycle, including its same-bar checks.
    // These checks block later signals; they are never reported as trade fills or returns.
    for (let at = active.length - 1; at >= 0; at--) {
      const current = active[at];
      const hit = current.side === 'long' ? bar.high >= current.target || bar.low <= current.stop : bar.low <= current.target || bar.high >= current.stop;
      if (hit) active.splice(at, 1);
    }
  }
  return {id, parameters, signals, plots, zones: [], notes: [
    '只计算已完成K线的原指标信号及参考位，不是成交或回测收益。',
    'time保留输入K线时间；信号仅在该根收盘后可知，确认枢轴不回移发现时间。',
    '保留上游同根高低价结束参考区间及单区间阻塞规则；无法证明盘中先后顺序。',
    'ATR使用真实波幅的RMA；不足ATR周期时保留未知，不补零。',
  ]};
}
