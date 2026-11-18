'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create, maxBars} = require('../trader/lead-position-candles.js');

const day = 86400000;
const hour = 3600000;
const start = Date.parse('2026-11-17T06:00:00Z');
const position = [Date.parse('2026-11-17T06:44:57.966Z'), Date.parse('2026-11-17T15:41:37.353Z')];
const okxBar = (time, confirmed = '1', prices = ['810', '812', '802', '807']) =>
  [String(time), ...prices, '45.23', '45.23', '36369.94', confirmed];
const bitgetBar = time => [String(time), '63100.1', '63107.7', '62250', '62739.9', '5427.3298', '339725339.83907'];
const sample = (code, data) => Response.json({code, data});

test('OKX fetches the original swap, sorts candles and includes the candles containing trade endpoints', async () => {
  let calls = 0;
  const api = create({fetch: async (input, options) => {
    calls++;
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://www.okx.com/api/v5/market/history-candles');
    assert.equal(url.searchParams.get('instId'), 'SNDK-USDT-SWAP');
    assert.equal(url.searchParams.get('bar'), '1H');
    assert.equal(url.searchParams.get('after'), String(start + 10 * hour));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return sample('0', [okxBar(start + 9 * hour), okxBar(start + hour, '0'), okxBar(start)]);
  }});
  const first = api.candles('OKX', 'SNDK-USDT-SWAP', '1h', ...position);
  const second = api.candles('okx', 'SNDK-USDT-SWAP', '1h', ...position);
  const [{bars}, copy] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(copy.bars, bars);
  assert.deepEqual(bars.map(bar => bar.time), [start / 1000, (start + 9 * hour) / 1000]);
  assert.deepEqual(bars[0], {time: start / 1000, open: 810, high: 812, low: 802, close: 807, volume: 45.23});
});

test('Bitget splits a long range and preserves the exact USDC product and UTC candle times', async () => {
  const windows = [];
  const first = Date.parse('2026-08-10');
  const last = first + 95 * day;
  const api = create({fetch: async input => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://api.bitget.com/api/v2/mix/market/history-candles');
    assert.equal(url.searchParams.get('productType'), 'USDC-FUTURES');
    assert.equal(url.searchParams.get('symbol'), 'ETHPERP');
    assert.equal(url.searchParams.get('granularity'), '1Dutc');
    const from = Number(url.searchParams.get('startTime'));
    const until = Number(url.searchParams.get('endTime'));
    assert.ok(until - from <= 90 * day);
    windows.push([from, until]);
    return sample('00000', [bitgetBar(from), bitgetBar(until - day)]);
  }});
  const data = await api.candles('Bitget', 'ETHPERP', '1d', first, last);
  assert.deepEqual(windows, [[first + 6 * day, last + day], [first, first + 6 * day]]);
  assert.equal(data.bars[0].time, first / 1000);
  assert.equal(data.bars.at(-1).time, last / 1000);
});

test('an unsupported series or oversized range never contacts a market endpoint', async () => {
  const api = create({fetch: async () => assert.fail('unexpected exchange request')});
  await assert.rejects(api.candles('Binance', 'BTCUSDT', '1h', ...position), /unsupported_contract/);
  await assert.rejects(api.candles('OKX', 'BTC-USDT', '1h', ...position), /unsupported_contract/);
  await assert.rejects(api.candles('Bitget', 'BTCUSDC', '1h', ...position), /unsupported_contract/);
  await assert.rejects(api.candles('Bitget', 'BTCUSDT', '1h', start, start + (maxBars + 1) * hour), /invalid_kline_window/);
});

test('a malformed candle cannot create an unverified chart or poison the retry cache', async () => {
  let attempts = 0;
  const api = create({fetch: async () => sample('0', [attempts++ === 0
    ? okxBar(start, '1', ['810', '809', '802', '807'])
    : okxBar(start)])});
  await assert.rejects(api.candles('OKX', 'SNDK-USDT-SWAP', '1h', ...position), /kline_schema/);
  assert.equal((await api.candles('OKX', 'SNDK-USDT-SWAP', '1h', ...position)).bars.length, 1);
  assert.equal(attempts, 2);
});

test('an unexpectedly sparse remote response cannot trigger unbounded pagination', async () => {
  let calls = 0;
  const api = create({fetch: async input => {
    calls++;
    const until = Number(new URL(input).searchParams.get('after'));
    return sample('0', [okxBar(until - hour)]);
  }});
  const result = await api.candles('OKX', 'SNDK-USDT-SWAP', '1h', start, start + 599 * hour);
  assert.equal(calls, 3);
  assert.equal(result.bars.length, 3);
});

test('a venue rate limit prevents another market request during the cooldown', async () => {
  let calls = 0;
  const api = create({fetch: async () => {
    calls++;
    return new Response(null, {status: 429});
  }});
  await assert.rejects(api.candles('Bitget', 'BTCUSDT', '1h', ...position), /source_http_429/);
  await assert.rejects(api.candles('Bitget', 'ETHUSDT', '1h', ...position), /source_http_429/);
  assert.equal(calls, 1);
});
