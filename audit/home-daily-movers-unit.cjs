'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {summarize} = require('../home-daily-movers.js');
const now = Date.parse('2026-11-16T05:00:00.000Z');
const asOf = '2026-11-13T08:15:00.000Z';

function dataset() {
  const stocks = Array.from({length:5000}, (_, i) => {
    const exchange = ['SH','SZ','BJ'][i % 3];
    return {code:String(i).padStart(6,'0') + '.' + exchange, exchange, name:'样本' + i, price:10, changePct:0};
  });
  return {stocks, stockCount:stocks.length, updatedAt:asOf};
}

test('positive and negative top three use independent sorting, code tie-breaks and no flat entries', () => {
  const sample = dataset();
  for (const [i, change] of [0,2,3,3,1,-2,-3,-3,-1].entries()) sample.stocks[i].changePct = change;
  sample.stocks.reverse();
  const result = summarize(sample,now);
  assert.deepEqual(result.gainers.map(row => row.code), ['000002','000003','000001']);
  assert.deepEqual(result.losers.map(row => row.code), ['000006','000007','000005']);
  assert.deepEqual(result.gainers[0], {code:'000002',name:'样本2'});
  assert.equal(result.priced,5000);
  assert.equal(result.asOf,asOf);
  assert.deepEqual(summarize(dataset(),now).gainers,[]);
});

test('invalid numeric prices or returns are excluded, including numeric strings and missing values', () => {
  const sample = dataset();
  for (const [i, price] of [null,'9',NaN,0,-1,Infinity].entries()) {
    Object.assign(sample.stocks[i],{price,changePct:25});
  }
  for (const [i, changePct] of [null,'-9',NaN,Infinity].entries()) sample.stocks[i+6].changePct = changePct;
  const result = summarize(sample,now);
  assert.equal(result.priced,4990);
  assert.deepEqual(result.gainers,[]);
  assert.deepEqual(result.losers,[]);
});

test('bad snapshot dates and incomplete coverage fail instead of replacing the last good ranks', () => {
  for (const change of [
    s => {s.updatedAt = new Date(now+1).toISOString();},
    s => {s.updatedAt = 'invalid';},
    s => {s.updatedAt = '2026-02-30T08:00:00+08:00';},
    s => {s.updatedAt = '2026-11-13T08:15:00';},
    s => {s.stockCount--;},
    s => {s.stocks.pop(); s.stockCount--;},
    s => {s.stocks.slice(0,501).forEach(row => {row.price = 0;});},
    s => {s.stocks.filter(row => row.exchange === 'BJ').forEach(row => {row.price = 0;});},
    s => {s.stocks[0].code = s.stocks[1].code.split('.')[0]+'.SH';},
    s => {s.stocks[0].exchange = 'SZ';},
    s => {s.stocks[0].code = '600.SH';},
  ]) {
    const sample = dataset();
    change(sample);
    assert.throws(() => summarize(sample,now));
  }
});

test('equivalent explicit timezone offsets and timestamps without fractional seconds normalize to UTC', () => {
  const sample = dataset();
  for (const stamp of ['2026-11-13T16:15:00+08:00', '2026-11-13T08:15:00Z', '2026-11-13T03:15:00.0-05:00']) {
    sample.updatedAt = stamp;
    assert.equal(summarize(sample,now).asOf,asOf);
  }
});

test('browser exports the same summary API and the bundled list contains names and codes only', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../home-daily-movers.js'),'utf8'),context);
  const sample = dataset();
  assert.deepEqual(JSON.parse(JSON.stringify(context.BooksDailyMovers.summarize(sample,now))),summarize(sample,now));
  const bundled = require('../research-data/a-daily-movers.json');
  assert.ok(Number.isFinite(Date.parse(bundled.asOf)));
  assert.ok(bundled.priced >= 4500);
  for (const side of ['gainers','losers']) {
    assert.ok(Array.isArray(bundled[side]) && bundled[side].length <= 3);
    for (const row of bundled[side]) {
      assert.deepEqual(Object.keys(row).sort(),['code','name']);
      assert.match(row.code,/^\d{6}$/);
      assert.ok(typeof row.name === 'string' && row.name.length > 0);
    }
  }
});
