'use strict';
const assert=require('node:assert/strict');
const {browser}=require('../trader/source-policy.js');
const live=require('../trader/account-live.js');
const storage=new Map(),root={localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},addEventListener(){}};
const gate=browser(root);
assert.equal(gate.reason(),'snapshot_unverified');
for(const file of ['feed','analytics','portfolios'])gate.inspect(file,require('../trader/'+file+'.json'));
const actual=gate.reason();
assert.equal(actual,require('../scripts/hyperliquid_run_guard.cjs').decision({
 feed:require('../trader/feed.json'),analytics:require('../trader/analytics.json'),portfolios:require('../trader/portfolios.json')
}).reason);
gate.inspect('analytics',{source:{stopCode:'http_429'}});
assert.equal(gate.reason(),actual||'http_429');
assert.equal(browser(root).reason(),actual||'http_429');
const base={coin:'BTC',side:'B',dir:'Close Short',time:123,px:'1',sz:'0.1',startPosition:'-0.100000000000000001',closedPnl:'0',fee:'0',feeToken:'USDC',tid:1,oid:2,hash:'abc'};
const action=patch=>live.normalize.fills([{...base,...patch}],'0x'+'1'.repeat(40),234)[0].positionAction;
assert.equal(action({}),'减空');
assert.equal(action({startPosition:'-0.1'}),'平空');
assert.equal(action({dir:'Open Long',startPosition:'0'}),'开多');
assert.equal(action({dir:'Open Long',startPosition:'1'}),'加多');
assert.equal(action({dir:'Short > Long',startPosition:'-0.05'}),'空转多');
assert.equal(action({startPosition:undefined}),null);
assert.equal(action({dir:'Buy'}),null);
console.log('PASS persisted stops and exact-decimal fill actions');
