'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const calendar = require('../market-calendar.js');
const {feed,fromQuotes,fromCsv,analyze} = require('../chart-outlook.js');

const day = ms => new Date(ms).toISOString().slice(0,10);
const marketDays = (market, end) => Array.from({length:65},(_,i) =>
  day(Date.parse(end + 'T00:00:00Z') - (64 - i) * 86400000)
).filter(date => calendar.session(market,date).open);
const now = Date.parse('2026-11-23T10:45:00Z');

function sample(symbol,kind,end,quoteAt) {
  const source = feed(symbol,kind);
  const dates = marketDays(source.market,end);
  const bars = dates.map((date,i) => [date,100+i,101+i,102+i,99+i]);
  const quote = [];
  quote[2] = source.code;
  quote[3] = String(bars.at(-1)[2]);
  quote[30] = quoteAt;
  const payload = {code:0,data:{[source.ticker]:{day:bars,qt:{[source.ticker]:quote}}}};
  return {source,payload,bars,quote};
}

test('a stock and market indices keep separate results, units and closing sessions', () => {
  for (const [symbol,kind,end,stamp,unit] of [
    ['SSE:600519','stock','2026-11-23','20261123161500','元'],
    ['HSI:HSI','index','2026-11-23','2026/11/23 18:12:20','点'],
    ['SP:SPX','index','2026-11-20','2026-11-20 16:02:00','点'],
    ['NYSE:IBM','stock','2026-11-20','2026-11-20 16:05:30','美元'],
  ]) {
    const {source,payload,bars} = sample(symbol,kind,end,stamp);
    const result = fromQuotes(payload,source,calendar,now);
    const analysis = analyze(result.bars);
    const priorRange = bars.slice(-21,-1);
    assert.equal(source.unit,unit);
    assert.equal(result.latestDate,end);
    assert.equal(result.bars.at(-1).date,end);
    assert.equal(analysis.close,bars.at(-1)[2]);
    assert.equal(analysis.high,Math.max(...priorRange.map(bar => bar[3])));
    assert.equal(analysis.low,Math.min(...priorRange.map(bar => bar[4])));
    assert.equal(analysis.short.bias,'偏多');
    assert.equal(analysis.medium.bias,'偏多');
  }
});

test('intraday or unconfirmed same-session data never overwrites a completed close', () => {
  const {source,payload,quote} = sample('SSE:600519','stock','2026-11-23','20261123161500');
  const intraday = fromQuotes(payload,source,calendar,Date.parse('2026-11-23T03:00:00Z'));
  assert.equal(intraday.bars.at(-1).date,'2026-11-20');
  quote[30] = '20261123145900';
  const stale = fromQuotes(payload,source,calendar,now);
  assert.equal(stale.latestDate,'2026-11-23');
  assert.equal(stale.bars.at(-1).date,'2026-11-20');
  quote[2] = '000001';
  assert.throws(() => fromQuotes(payload,source,calendar,now),/匹配标的/);
});

test('international index imports validate identity, chronology and the required price basis', () => {
  assert.equal(feed('TVC:NI225','index'),null);
  const lines = marketDays('CN','2026-11-20').map((date,i) => 'TVC:NI225,'+date+','+(2000+i));
  const csv = 'symbol,date,close\n'+lines.join('\n');
  assert.equal(fromCsv(csv,'TVC:NI225','index',now).closeOnly,true);
  assert.throws(() => fromCsv(csv,'HSI:HSI','index',now),/其他标的/);
  assert.throws(() => fromCsv(csv,'TVC:NI225','stock',now),/表头/);
  assert.throws(() => fromCsv(csv+'\n'+lines.at(-1),'TVC:NI225','index',now),/重复/);
  assert.throws(() => fromCsv(csv+'\nTVC:NI225,2027-03-01,2900','TVC:NI225','index',now),/未来日期/);
});
