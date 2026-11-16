'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {track,cryptoRows,stockView} = require('../home-market-radar.js');
const now = Date.parse('2026-11-16T05:30:00Z');
const q = (ts, price) => ({id:'TEST-USDT', ts, price, change:4});
const row = (ts,symbol,extra={}) => ({market:'a', symbol, sourceTime:new Date(ts).toISOString(), ...extra});

test('minute comparisons require two genuine timestamps about a minute apart', () => {
  const history = new Map();
  track(history,[q(now-60000,100)],now-60000);
  const live = q(now,102);
  track(history,[live],now);
  assert.ok(Math.abs(cryptoRows(history,[live],now)[0].delta-2) < 0.0001);
  const later = q(now+150000,118);
  track(history,[later],later.ts);
  assert.equal(cryptoRows(history,[later],later.ts)[0].delta,null);
});
test('stale, future and nonpositive quotes cannot enter the radar', () => {
  const quotes = [q(now-100000,100),q(now+120000,100),q(now,0)];
  const history = new Map();track(history,quotes,now);
  assert.equal(history.size,0);assert.deepEqual(cryptoRows(history,quotes,now),[]);
});
test('stock coverage counts distinct symbols including samples without a hit', () => {
  const rows = [row(now-60000,'000001'), row(now-30000,'000001'), row(now-30000,'000002')];
  const data = {observations:rows,alerts:[]};
  const a = stockView(data,'a',now);
  assert.equal(a.count,2);assert.equal(a.alerts.length,0);
  assert.equal(stockView(data,'us',now).count,0);
  const old = stockView(data,'a',now+180000);
  assert.equal(old.count,0);assert.equal(old.last,now-30000);
});
test('future and historical alerts do not count as active signals', () => {
  const data = {observations:[],alerts:[row(now,'000001',{level:'watch'}),row(now+60000,'000002',{level:'confirmed'}),row(now-180000,'000003',{level:'confirmed'})]};
  const a = stockView(data,'a',now);
  assert.deepEqual(a.alerts.map(item=>item.symbol),['000001']);assert.equal(a.last,now);
});
test('A-share board opens the day map and an eight-stock Shanghai and Shenzhen watchlist', () => {
  const {moverConfig} = require('../home-market-radar.js');
  const map = new URL(moverConfig('a').frame);
  assert.equal(map.origin,'https://dapan.app');
  assert.equal(map.searchParams.get('market'),'all');
  assert.equal(map.searchParams.get('period'),'day');
  const watch = moverConfig('watch');
  assert.equal(watch.script,'market-overview');
  const codes = watch.widget.tabs[0].symbols.map(row=>row.s);
  assert.equal(new Set(codes).size,8);
  assert.equal(codes.filter(code=>code.startsWith('SSE:')).length,4);
  assert.equal(codes.filter(code=>code.startsWith('SZSE:')).length,4);
});
test('US gainers and losers map to the proper screen and original list', () => {
  const {moverConfig} = require('../home-market-radar.js');
  for (const direction of ['gainers','losers']) {
    const list = moverConfig('us',direction);
    assert.equal(list.widget.market,'america');
    assert.equal(list.widget.defaultScreen,'top_'+direction);
    assert.equal(list.source,'https://www.tradingview.com/markets/stocks-usa/market-movers-'+direction+'/');
  }
  assert.throws(()=>moverConfig('unrecognised','gainers'));
});
