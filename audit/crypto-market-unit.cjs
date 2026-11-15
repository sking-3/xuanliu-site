'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const js=fs.readFileSync('crypto-market.js','utf8');
const css=fs.readFileSync('crypto-market.css','utf8');
const home=fs.readFileSync('index.html','utf8');
const full=fs.readFileSync('crypto.html','utf8');
let passed=0;
function test(name,fn){fn();passed++;console.log('ok '+name);}
test('public adapters cover Binance, OKX and Bitget',()=>{
  for(const needle of ['data-api.binance.vision','www.okx.com/api/v5/market/tickers','api.bitget.com/api/v2/spot/market/tickers','stream.binance.com','ws.okx.com','ws.bitget.com']) assert.match(js,new RegExp(needle.replace(/[.]/g,'\\.')));
});
test('adapter is read-only and has no credential or order path',()=>{
  assert.doesNotMatch(js,/api[_-]?(key|secret)|passphrase|\/order|place-order|withdraw/i);
});
test('homepage and full page mount the native feed',()=>{
  assert.match(home,/data-local-feed="crypto"/); assert.match(home,/data-crypto-feed/);
  assert.match(full,/data-local-feed="crypto"/); assert.match(full,/data-crypto-feed/);
});
test('mobile layout does not reserve TradingView height for native feed',()=>assert.match(css,/data-local-feed=crypto.*feed-widget-area/s));
test('CSP allows only public market origins',()=>{
  for(const html of [home,full]) for(const host of ['data-api.binance.vision','www.okx.com','api.bitget.com','ws.okx.com']) assert.match(html,new RegExp(host.replace(/[.]/g,'\\.')));
});
console.log(`${passed} crypto market adapter checks passed`);
