'use strict';

(function (root) {
  function summarize(snapshot, now = Date.now()) {
    const stocks = snapshot?.stocks;
    if (!Array.isArray(stocks) || stocks.length < 5000 || snapshot.stockCount !== stocks.length) {
      throw new Error('A 股名册覆盖不足或记录数不一致');
    }
    const stamp = snapshot.updatedAt;
    const zonedTimestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
    if (typeof stamp !== 'string' || !zonedTimestamp.test(stamp)) throw new Error('快照日期未注明时区或格式错误');
    const time = Date.parse(stamp);
    const day = stamp.slice(0,10);
    const midnight = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(time) || !Number.isFinite(now) || time > now ||
        !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0,10) !== day) {
      throw new Error('快照日期无效');
    }
    const asOf = new Date(time).toISOString();

    const codes = new Set();
    const exchanges = new Set();
    const priced = [];
    for (const stock of stocks) {
      const match = typeof stock?.code === 'string' && /^(\d{6})\.(SH|SZ|BJ)$/.exec(stock.code);
      if (!match || stock.exchange !== match[2] || codes.has(match[1]) ||
          typeof stock.name !== 'string' || !stock.name.trim()) {
        throw new Error('证券代码、交易所或名称未通过校验');
      }
      codes.add(match[1]);
      if (!Number.isFinite(stock.price) || stock.price <= 0 || !Number.isFinite(stock.changePct)) continue;
      exchanges.add(stock.exchange);
      priced.push({code:match[1], name:stock.name.trim(), change:stock.changePct});
    }
    if (exchanges.size !== 3 || priced.length < stocks.length * 0.9) {
      throw new Error('有效报价未达到沪深北快照覆盖要求');
    }

    function leaders(direction) {
      return priced.filter(row => direction * row.change > 0)
        .sort((a, b) => direction * (b.change - a.change) || a.code.localeCompare(b.code))
        .slice(0, 3)
        .map(({code, name}) => ({code, name}));
    }
    return {asOf, priced:priced.length, gainers:leaders(1), losers:leaders(-1)};
  }

  if (typeof module === 'object' && module.exports) module.exports = {summarize};
  else root.BooksDailyMovers = {summarize};
})(globalThis);
