'use strict';

// Independently implements the turtle_trade and keep_increasing conditions from
// myhhub/stock (Apache-2.0), revision b6e0ca2268cfbadd02f5ed052159c187b6670231.
(function (root) {
  const hosts = ['https://web.ifzq.gtimg.cn', 'https://proxy.finance.qq.com/ifzqgtimg'];
  const path = '/appstock/app/fqkline/get';
  const dayMs = 86400000;
  const shanghaiOffset = 8 * 3600000;

  function validDay(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const time = Date.parse(day + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
  }

  function unavailable(code, day, reason) {
    return {code, day, status: 'unavailable', reason};
  }

  function decimal(value) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return NaN;
    return Number(value);
  }

  function readBars(entry, day) {
    if (!entry || typeof entry !== 'object') throw Error('该代码没有日线');
    // Tencent returns "day" alone for securities with no adjustment in the requested period.
    const rows = Object.hasOwn(entry, 'qfqday') ? entry.qfqday : entry.day;
    if (!Array.isArray(rows) || !rows.length) throw Error('没有可用前复权日线');
    const bars = [];
    const dates = new Set();
    for (const row of rows) {
      if (!Array.isArray(row) || !validDay(row[0])) throw Error('日线日期异常');
      const date = row[0];
      if (date > day) continue;
      if (dates.has(date)) throw Error('日线日期重复');
      dates.add(date);
      const volume = decimal(row[5]);
      if (!Number.isFinite(volume) || volume < 0) throw Error('成交量缺失或异常');
      if (volume === 0) {
        if (date === day) throw Error('目标日无成交，可能停牌');
        continue;
      }
      const [open, close, high, low] = row.slice(1, 5).map(decimal);
      if (![open, close, high, low].every(v => Number.isFinite(v) && v > 0)
          || high < Math.max(open, close) || low > Math.min(open, close)) throw Error('日线价格缺失或异常');
      bars.push({date, close});
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    if (bars.at(-1)?.date !== day) throw Error('缺少目标交易日日线，可能停牌或来源滞后');
    if (bars.length < 60) throw Error('不足 60 根有效日线');
    return bars.slice(-60).map(bar => bar.close);
  }

  function evaluate(closes) {
    const close = closes[59];
    const high60 = Math.max(...closes);
    // Upstream samples the first, 11th, 21st and last points of the final 30 MA30s.
    const [first, second, third, last] = [1, 11, 21, 30].map(start =>
      closes.slice(start, start + 30).reduce((total, value) => total + value, 0) / 30);
    const above = (a, b) => a - b > Number.EPSILON * 64 * Math.max(a, b);
    const increasing = above(second, first) && above(third, second) && above(last, third) && above(last, first * 1.2);
    return {close, high60, turtle: close >= high60, increasing, ma30GrowthPct: (last / first - 1) * 100};
  }

  function abortIfNeeded(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
  }

  async function load(url, signal) {
    abortIfNeeded(signal);
    const control = new AbortController();
    const cancel = () => control.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    const timeout = setTimeout(cancel, 8000);
    try {
      const response = await fetch(url, {
        signal: control.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'
      });
      if ([401, 403, 429].includes(response.status)) return {restricted: true};
      if (!response.ok) throw Error('行情服务暂不可用');
      return {payload: await response.json()};
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async function run(stock, day, signal) {
    abortIfNeeded(signal);
    const code = stock?.code;
    const fail = reason => unavailable(code, day, reason);
    if (typeof code !== 'string' || !/^\d{6}\.(?:SH|SZ|BJ)$/.test(code)) return fail('证券代码或交易所无效');
    if (code.endsWith('.BJ')) return fail('腾讯前复权日线未覆盖北交所');
    if (!validDay(day)) return fail('目标交易日无效');
    const now = Date.now();
    const marketClose = Date.parse(day + 'T15:00:00+08:00');
    if (now < marketClose) return fail('目标交易日尚未收盘');
    if (stock.asOf != null) {
      const stamp = stock.asOf, cutoff = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) || !Number.isFinite(cutoff) || cutoff > now
          || cutoff < marketClose || new Date(cutoff + shanghaiOffset).toISOString().slice(0, 10) !== day)
        return fail('候选快照未提供该交易日的收盘时点');
    }
    const ticker = code.slice(-2).toLowerCase() + code.slice(0, 6);
    const today = new Date(now + shanghaiOffset).toISOString().slice(0, 10);
    const start = new Date(Date.parse(day + 'T00:00:00Z') - 360 * dayMs).toISOString().slice(0, 10);
    let reason = '腾讯日线连接失败或超时';
    for (const host of hosts) {
      const url = new URL(host + path);
      url.searchParams.set('param', [ticker, 'day', start, day, 640, 'qfq'].join(','));
      let result;
      try { result = await load(url, signal); }
      catch { abortIfNeeded(signal); continue; }
      abortIfNeeded(signal);
      if (result.restricted) return fail('腾讯暂时限制访问，请稍后重试');
      const payload = result.payload;
      if (payload?.code !== 0 && payload?.code !== '0') { reason = '腾讯未返回该标的日线'; continue; }
      const entry = payload.data?.[ticker];
      try {
        const closes = readBars(entry, day);
        if (today === day) {
          const quote = entry.qt?.[ticker];
          const stamp = quote?.[30];
          if (!Array.isArray(quote) || quote[2] !== code.slice(0, 6) || typeof stamp !== 'string'
              || !/^\d{8}(?:[01]\d|2[0-3])(?:[0-5]\d){2}$/.test(stamp)
              || stamp.slice(0, 8) !== day.replaceAll('-', '') || stamp.slice(8) < '150000')
            throw Error('来源尚未确认目标日收盘');
        }
        return {code, day, status: 'ready', ...evaluate(closes)};
      } catch (error) { reason = error.message; }
    }
    return fail(reason);
  }

  const api = {run};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksTechnicalScreen = api;
})(globalThis);
