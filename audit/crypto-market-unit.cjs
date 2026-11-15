'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const js=fs.readFileSync('crypto-market.js','utf8');
const css=fs.readFileSync('crypto-market.css','utf8');
const home=fs.readFileSync('index.html','utf8');
const full=fs.readFileSync('crypto.html','utf8');
let passed=0;
function test(name,fn){fn();passed++;console.log('ok '+name);}
test('public adapter uses only Bitget',()=>{for(const needle of ['api.bitget.com/api/v2/spot/market/tickers','ws.bitget.com/v2/ws/public']) assert.match(js,new RegExp(needle.replace(/[.]/g,'\.')));for(const blocked of ['data-api.binance.vision','www.okx.com','stream.binance.com','ws.okx.com']) assert.doesNotMatch(js,new RegExp(blocked.replace(/[.]/g,'\.')));});
test('adapter is read-only and has no credential or order path',()=>{
  assert.doesNotMatch(js,/api[_-]?(key|secret)|passphrase|\/order|place-order|withdraw/i);
});
test('homepage copy names the single active crypto source',()=>{
  assert.match(home,/加密 · USDT/);
  assert.match(home,/加密行情仅接入 Bitget 公共现货源/);
  assert.doesNotMatch(home,/三家交易所|多交易所|Binance|OKX|Coinbase/);
});
test('homepage and full page mount the native feed',()=>{
  assert.match(home,/data-local-feed="crypto"/); assert.match(home,/data-crypto-feed/);
  assert.match(full,/data-local-feed="crypto"/); assert.match(full,/data-crypto-feed/);
});
test('mobile layout does not reserve TradingView height for native feed',()=>assert.match(css,/data-local-feed=crypto.*feed-widget-area/s));
test('CSP allows only Bitget public market origins',()=>{for(const html of [home,full]) {assert.match(html,/api\.bitget\.com/);assert.match(html,/ws\.bitget\.com/);for(const host of ['data-api.binance.vision','www.okx.com','ws.okx.com']) assert.doesNotMatch(html,new RegExp(host.replace(/[.]/g,'\.')));}});
console.log(`${passed} crypto market adapter checks passed`);
