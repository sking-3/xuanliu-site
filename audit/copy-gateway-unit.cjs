'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const G = require('../tools/copy_gateway/engine.cjs');
const T = Date.now() - 1000;
const event = (id, patch = {}) => ({schemaVersion:1,source:'fixture',eventId:id,identity:id,symbol:'ETHUSDT',side:'long',action:'open',quantity:1,price:100,sourceTime:T,firstSeenAt:T,observedAt:T+100,...patch});
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS '+name); }
test('event contract requires causal fields and rejects stale data', () => {
  assert.throws(() => G.validateEvent({...event('x'), eventId:null}), /event_schema/);
  assert.throws(() => G.validateEvent({...event('x'), sourceTime:T-G.MAX_EVENT_AGE_MS-1, firstSeenAt:T-G.MAX_EVENT_AGE_MS-1, observedAt:T}), /event_stale/);
  assert.throws(() => G.validateEvent({...event('x'), action:'reverse'}), /event_schema/);
});
test('baseline records history without simulating an order', () => {
  const s = G.baseline(G.createLedger(), [event('old')], T+1000);
  assert.equal(s.status, 'running'); assert.deepEqual(s.positions, {});
  assert.equal(s.decisions[0].reason, 'historical_baseline'); assert.equal(s.decisions[0].sent, false);
});
test('open increase decrease close completes a deterministic dry-run cycle', () => {
  let s = G.baseline(G.createLedger(), [], T+1000);
  s = G.apply(s, [event('open')], T+1000);
  s = G.apply(s, [event('add', {action:'increase',quantity:2,price:110,sourceTime:T+2000,firstSeenAt:T+2000,observedAt:T+2100})], T+2100);
  s = G.apply(s, [event('reduce', {action:'decrease',quantity:1,price:120,sourceTime:T+3000,firstSeenAt:T+3000,observedAt:T+3100})], T+3100);
  s = G.apply(s, [event('close', {action:'close',quantity:2,price:130,sourceTime:T+4000,firstSeenAt:T+4000,observedAt:T+4100})], T+4100);
  assert.deepEqual(s.positions, {}); assert.equal(s.decisions.filter(x=>x.status==='simulated').length, 4); assert.equal(s.realized, 60);
});
test('exact duplicates and revised identities never double count', () => {
  let s = G.baseline(G.createLedger(), [], T+1000);
  s = G.apply(s, [event('one')], T+1000); s = G.apply(s, [event('one')], T+1100);
  assert.equal(s.decisions.at(-1).status, 'simulated'); assert.equal(s.positions['ETHUSDT|long'].quantity, 1);
  s = G.apply(s, [event('revision', {identity:'one',quantity:2,sourceTime:T+2000,firstSeenAt:T+2000,observedAt:T+2100})], T+2100);
  assert.equal(s.decisions.at(-1).reason, 'ambiguous_source_version'); assert.equal(s.positions['ETHUSDT|long'].quantity, 1);
});
test('same-time events without a source sequence are not ordered by local event ID', () => {
  let s = G.baseline(G.createLedger(), [], T+1000);
  s = G.apply(s, [event('b'), event('a')], T+1000);
  assert.ok(s.decisions.slice(-2).every(x=>x.reason==='ambiguous_event_order')); assert.deepEqual(s.positions, {});
});
test('a late same-time event without a sequence is refused across batches', () => {
  let s = G.baseline(G.createLedger(), [], T+1000);
  s = G.apply(s, [event('first')], T+1000);
  s = G.apply(s, [event('late', {sourceTime:T, firstSeenAt:T, observedAt:T+200})], T+1200);
  assert.equal(s.decisions.at(-1).reason, 'ambiguous_event_order');
  assert.equal(s.positions['ETHUSDT|long'].quantity, 1);
});
test('invalid reduction, opposite side and stale source are skipped safely', () => {
  let s = G.baseline(G.createLedger(), [], T+1000);
  s = G.apply(s, [event('close', {action:'close'})], T+1000); assert.equal(s.decisions.at(-1).reason,'no_paper_position');
  s = G.apply(s, [event('short', {side:'short',sourceTime:T+2000,firstSeenAt:T+2000,observedAt:T+2100})], T+2100); assert.equal(s.decisions.at(-1).status,'simulated');
  assert.throws(() => G.apply(s, [event('bad', {sourceTime:T-200000,firstSeenAt:T-200000,observedAt:T})], T+2200), /event_stale/);
});
test('module is offline-only and every decision is dry-run', () => {
  const source = fs.readFileSync('tools/copy_gateway/engine.cjs','utf8');
  assert.doesNotMatch(source, /fetch\s*\(|WebSocket|privateKey|secretKey|apiSecret|\/order|signTypedData|axios/);
  const s = G.baseline(G.createLedger(), [], T+1000); assert.equal(G.validateLedger(s), true);
});
console.log(`${passed} copy-gateway dry-run checks passed`);
