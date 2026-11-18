(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksLeadPositionCandles = api;
})(globalThis, function () {
  'use strict';

  const day = 86400000;
  const maxBars = 600;
  const intervals = {
    '15m': [900000, '15m'],
    '1h': [3600000, '1H'],
    '4h': [14400000, '4H'],
    '1d': [day, '1Dutc'],
  };
  const venues = {
    okx: {
      url: 'https://www.okx.com/api/v5/market/history-candles',
      source: 'OKX 永续合约',
      success: '0',
      pageSize: 300,
    },
    bitget: {
      url: 'https://api.bitget.com/api/v2/mix/market/history-candles',
      source: 'Bitget 永续合约',
      success: '00000',
      pageSize: 200,
    },
  };

  function normalizePage(raw, start, end, step, kind) {
    const rows = new Map();
    let earliest = Infinity;
    for (const item of raw) {
      if (!Array.isArray(item) || item.length < (kind === 'okx' ? 9 : 7)) throw Error('kline_schema');
      const [stamp, open, high, low, close, volume] = item.map(Number);
      if (!Number.isSafeInteger(stamp) || stamp <= 0 || stamp % step !== 0) throw Error('kline_schema');
      earliest = Math.min(earliest, stamp);
      if (stamp < start || stamp >= end || (kind === 'okx' && item[8] === '0')) continue;
      if ((kind === 'okx' && item[8] !== '1') || rows.has(stamp) ||
          ![open, high, low, close].every(price => Number.isFinite(price) && price > 0) ||
          low > Math.min(open, close) || high < Math.max(open, close) ||
          item[5] === null || item[5] === '' || !Number.isFinite(volume) || volume < 0) {
        throw Error('kline_schema');
      }
      rows.set(stamp, {time: stamp / 1000, open, high, low, close, volume});
    }
    return {rows, earliest};
  }

  function create(env = globalThis) {
    const cache = new Map();
    const pending = new Map();
    const restrictedUntil = new Map();

    async function request(venue, query, limit) {
      const restriction = restrictedUntil.get(venue);
      if (restriction && Date.now() < restriction.until) throw Error(restriction.code);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await env.fetch(venue.url + '?' + new URLSearchParams(query), {
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) {
          const code = 'source_http_' + response.status;
          if (response.status === 429) restrictedUntil.set(venue, {code, until: Date.now() + 60000});
          if (response.status === 403) restrictedUntil.set(venue, {code, until: Infinity});
          throw Error(code);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', {fatal: true});
        let body = '';
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 128000) {
            await reader.cancel();
            throw Error('source_too_large');
          }
          body += decoder.decode(chunk.value, {stream: true});
        }
        const payload = JSON.parse(body + decoder.decode());
        if (payload?.code !== venue.success) throw Error('source_response');
        if (!Array.isArray(payload.data) || payload.data.length > limit) throw Error('kline_schema');
        return payload.data;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function readCandles(kind, venue, symbol, product, interval, bar, step, start, end) {
      const bars = [];
      let until = end;
      const pageSize = Math.min(venue.pageSize, Math.floor(90 * day / step));
      const pages = Math.ceil((end - start) / (pageSize * step)) + 1;
      for (let pageNumber = 0; pageNumber < pages && until > start; pageNumber++) {
        const limit = Math.min(pageSize, (until - start) / step);
        const from = until - limit * step;
        const query = kind === 'okx'
          ? {instId: symbol, bar, after: until, limit}
          : {symbol, productType: product, granularity: bar, startTime: from, endTime: until, limit};
        const data = await request(venue, query, limit);
        // OKX pages by candle timestamp. Bitget accepts explicit half-open time ranges.
        const page = normalizePage(data, kind === 'okx' ? start : from, until, step, kind);
        bars.push(...page.rows.values());
        if (kind === 'bitget') until = from;
        else if (data.length === 0) break;
        else if (page.earliest >= until) throw Error('kline_schema');
        else until = page.earliest;
      }
      bars.sort((a, b) => a.time - b.time);
      return {bars, fetchedAt: Date.now(), interval, source: venue.source, symbol};
    }

    async function candles(exchange, symbol, interval, startMs, endMs) {
      const kind = String(exchange).toLowerCase();
      const venue = Object.hasOwn(venues, kind) && venues[kind];
      if (!venue || typeof symbol !== 'string') throw Error('unsupported_contract');
      const product = kind === 'bitget' && /^(?:[A-Z0-9]{1,24})(USDT|PERP)$/.exec(symbol);
      if (kind === 'okx'
        ? !/^[A-Z0-9]{1,24}-[A-Z0-9]{1,12}-SWAP$/.test(symbol) : !product) throw Error('unsupported_contract');
      const timing = Object.hasOwn(intervals, interval) && intervals[interval];
      if (!timing || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) ||
          startMs <= 0 || endMs <= startMs || endMs > Number.MAX_SAFE_INTEGER - day) throw Error('invalid_kline_window');
      const [step, bar] = timing;
      if (endMs - startMs > maxBars * step) throw Error('invalid_kline_window');
      const start = Math.floor(startMs / step) * step;
      const end = (Math.floor(endMs / step) + 1) * step;
      const key = [kind, symbol, interval, start, end].join('|');
      const previous = cache.get(key);
      if (previous && Date.now() - previous.fetchedAt < 60000) return previous;
      if (pending.has(key)) return pending.get(key);
      // Bitget uses names such as ETHPERP for its USDC-settled contracts.
      const settlement = product?.[1] === 'PERP' ? 'USDC-FUTURES' : 'USDT-FUTURES';
      const task = readCandles(kind, venue, symbol, settlement, interval, bar, step, start, end);
      pending.set(key, task);
      try {
        const value = await task;
        if (cache.size >= 12) cache.delete(cache.keys().next().value);
        cache.set(key, value);
        return value;
      } finally {
        pending.delete(key);
      }
    }

    return {candles};
  }

  return {create, maxBars};
});
