'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {collect, validateState, LIMITS} = require('../scripts/collect_hyperliquid_fills.cjs');

const minute = 60000;
const start = Date.UTC(2026, 10, 19, 12);
const endpoint = 'https://api.hyperliquid.xyz/info';
const address = n => '0x' + n.toString(16).padStart(40, '0');
const scope = 'default_perp_dex';

function fill(time, tid = 1) {
  return {coin: 'BTC', time, tid, oid: tid, side: 'B', px: '70000.5', sz: '0.001',
    hash: '0x' + 'a'.repeat(64), dir: 'Open Long', closedPnl: '0', fee: '0.01', crossed: true};
}

function batch({at = start, previous = null, size = 1, members, verification = {}, seed, getRows, elapsed = 10}) {
  let time = at;
  const requests = [];
  const feed = {schemaVersion: 1, status: 'ready', source: {id: 'hyperliquid', status: 'ok',
    positionVerification: {completedAt: new Date(at - 1000).toISOString(), scope, ...verification}},
  traders: (members ?? Array.from({length: size}, (_, index) => index + 1)).map(index => ({accountId: address(index),
    exchange: 'Hyperliquid', sourceKind: 'public_account', positionCheck: {scope, count: 1}}))};
  const pending = collect({feed, previous, seed, now: () => time, clock: () => time - at,
    sleep: async ms => { time += ms; },
    fetch: async (url, init) => {
      assert.equal(url, endpoint);
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      const query = JSON.parse(init.body);
      assert.equal(query.type, 'userFillsByTime');
      assert.equal(query.aggregateByTime, false);
      const outcome = getRows(query);
      requests.push({time, query, weight: Array.isArray(outcome)
        ? 20 + Math.ceil(outcome.length / 20) : LIMITS.reservation});
      time += elapsed;
      if (typeof outcome === 'number') return new Response(null, {status: outcome});
      return new Response(JSON.stringify(outcome), {headers: {'content-type': 'application/json'}});
    }});
  return {pending, requests};
}

test('official window, overlap, and distinct fills at the same timestamp', async () => {
  const firstRows = Array.from({length: 60}, (_, index) => fill(start - 30000 + index, index + 1));
  const first = batch({getRows: () => firstRows});
  const previous = await first.pending;
  const account = address(1);
  assert.equal(previous.source.status, 'ready');
  assert.equal(previous.accounts[account].rows.length, LIMITS.rows);
  assert.equal(first.requests[0].query.startTime, start - LIMITS.initialWindow);
  assert.equal(first.requests[0].query.endTime, start);
  const next = batch({at: start + 30 * minute, previous, getRows: () => [
    firstRows.at(-1), fill(firstRows.at(-1).time, 61), fill(start + minute, 62),
  ]});
  const result = await next.pending;
  const record = result.accounts[account];
  assert.equal(next.requests[0].query.startTime, start - LIMITS.overlap);
  assert.equal(record.coveredThrough, start + 30 * minute);
  assert.equal(record.checkedAt, record.lastSuccessAt);
  assert.equal(record.rows.length, LIMITS.rows);
  assert.deepEqual(record.rows.slice(0, 3).map(row => row.tid), [62, 61, 60]);
  assert.deepEqual(record.rows[0], fill(start + minute, 62));
});

for (const status of [403, 429]) {
  test(`HTTP ${status} preserves last good and stops the next run`, async () => {
    const previous = await batch({size: 3, getRows: () => [fill(start - 5000)]}).pending;
    const failed = batch({at: start + minute, size: 3, previous, getRows: () => status});
    const result = await failed.pending;
    assert.equal(failed.requests.length, 1);
    assert.equal(result.source.status, 'stopped');
    assert.equal(result.source.stopCode, 'http_' + status);
    assert.equal(result.accounts[address(1)].errorCode, 'http_' + status);
    assert.deepEqual(result.accounts[address(1)].rows, previous.accounts[address(1)].rows);
    assert.equal(result.accounts[address(1)].coveredThrough, start);
    assert.deepEqual(result.accounts[address(2)], previous.accounts[address(2)]);
    const next = batch({at: start + 2 * minute, previous: result, getRows: () => []});
    assert.deepEqual(await next.pending, result);
    assert.equal(next.requests.length, 0);
  });
}

test('a capped window is split into adjacent inclusive subwindows', async () => {
  const from = start - LIMITS.initialWindow;
  const mid = (from + start) / 2;
  const source = Array.from({length: 400}, (_, index) => fill(mid - index, index))
    .concat(Array.from({length: 400}, (_, index) => fill(mid + index + 1, index + 400)));
  const split = batch({getRows: ({startTime, endTime}) => source.filter(row => row.time >= startTime && row.time <= endTime)});
  const result = await split.pending;
  assert.deepEqual(split.requests.map(({query}) => [query.startTime, query.endTime]),
    [[from, start], [from, mid], [mid + 1, start]]);
  const account = result.accounts[address(1)];
  assert.equal(result.source.status, 'ready');
  assert.equal(account.gap, null);
  assert.equal(account.coveredThrough, start);
  assert.deepEqual(account.rows.map(row => row.tid), Array.from({length: LIMITS.rows}, (_, i) => 799 - i));
});

test('a saturated single millisecond keeps the cursor and data until that window can be covered', async () => {
  const previous = await batch({getRows: () => [fill(start - 5000)]}).pending;
  const split = batch({at: start + minute, previous, getRows: ({startTime, endTime}) =>
    startTime <= start && start <= endTime ? Array(LIMITS.pageCap).fill(fill(start)) : []});
  const capped = await split.pending;
  assert.ok(split.requests.some(({query}) => query.startTime === start && query.endTime === start));
  const account = address(1);
  assert.equal(capped.source.status, 'partial');
  assert.equal(capped.accounts[account].coveredThrough, start);
  assert.deepEqual(capped.accounts[account].gap,
    {from: start - LIMITS.overlap, to: start + minute, reason: 'response_cap'});
  assert.deepEqual(capped.accounts[account].rows, previous.accounts[account].rows);
  const resumed = batch({at: Date.parse(capped.source.checkedAt) + minute, previous: capped,
    getRows: () => [fill(start + 1, 2)],
  });
  const result = await resumed.pending;
  assert.equal(result.source.status, 'ready');
  assert.equal(resumed.requests[0].query.startTime, start - LIMITS.overlap);
  assert.equal(result.accounts[account].gap, null);
  assert.equal(result.accounts[account].rows.length, 2);
});

test('a split interrupted by timeout or a source stop cannot advance the account cursor', async () => {
  const previous = await batch({size: 2, getRows: () => [fill(start - 5000)]}).pending;
  const raw = Array(LIMITS.pageCap).fill(fill(start));
  const timed = batch({at: start + minute, previous, getRows: () => raw, elapsed: LIMITS.round});
  const timeout = await timed.pending;
  assert.equal(timeout.source.status, 'partial');
  assert.equal(timeout.accounts[address(1)].errorCode, 'batch_timeout');
  assert.equal(timeout.accounts[address(1)].gap.reason, 'response_cap');
  assert.equal(timed.requests.length, 1);
  assert.equal(timeout.accounts[address(1)].coveredThrough, start);
  const refuse = batch({at: start + minute, previous, size: 2, getRows: ({startTime, endTime}) => {
    if (endTime - startTime === 2 * minute) return raw;
    return startTime < start ? [fill(start - 1, 2)] : 429;
  }});
  const stopped = await refuse.pending;
  assert.equal(stopped.source.stopCode, 'http_429');
  assert.equal(refuse.requests.length, 3);
  assert.equal(stopped.accounts[address(1)].coveredThrough, start);
  assert.deepEqual(stopped.accounts[address(1)].rows, previous.accounts[address(1)].rows);
  assert.deepEqual(stopped.accounts[address(2)], previous.accounts[address(2)]);
});

test('an incomplete roster reads verified accounts and preserves prior accounts it could not verify', async () => {
  const previous = await batch({size: 2, getRows: () => [fill(start - 1000)]}).pending;
  const incomplete = batch({at: start + minute, previous, members: [1, 3],
    verification: {failedAccounts: 1}, getRows: () => []});
  const partial = await incomplete.pending;
  assert.equal(partial.source.status, 'partial');
  assert.deepEqual(incomplete.requests.map(({query}) => query.user), [address(3), address(1)]);
  assert.deepEqual(partial.accounts[address(2)], previous.accounts[address(2)]);
  assert.equal(partial.accounts[address(3)].coveredThrough, start + minute);
  const complete = await batch({at: start + 2 * minute, previous: partial, members: [1, 3], getRows: () => []}).pending;
  assert.equal(complete.source.status, 'ready');
  assert.equal(complete.accounts[address(2)], undefined);
});

test('the explicit watchlist persists flat addresses while the verified live roster adds accounts', async () => {
  const roster = require('../scripts/hyperliquid-fills-roster.json');
  assert.equal(roster.addresses.length, 84);
  const first = batch({seed: roster, getRows: () => []});
  const result = await first.pending;
  const expected = [...roster.addresses, address(1)];
  assert.deepEqual(first.requests.map(({query}) => query.user), expected);
  assert.deepEqual(Object.keys(result.accounts), expected);
  const invalid = batch({seed: {...roster, addresses: [address(1), address(1)]}, getRows: () => []});
  await assert.rejects(invalid.pending, /invalid_fills_seed/);
  assert.equal(invalid.requests.length, 0);
});

test('a recovered long outage records the uncovered range', async () => {
  const previous = await batch({getRows: () => []}).pending;
  const recovered = await batch({at: start + LIMITS.lookback + minute, previous,
    getRows: () => [],
  }).pending;
  assert.equal(recovered.source.status, 'partial');
  assert.deepEqual(recovered.accounts[address(1)].gap,
    {from: start + 1, to: start + minute - 1, reason: 'lookback_limit'});
  assert.equal(recovered.accounts[address(1)].coveredThrough, start + LIMITS.lookback + minute);
});

test('all 84 accounts fit inside a round and stay inside the rolling rate budget', async () => {
  const sample = batch({size: 84, getRows: () => Array.from({length: 400}, (_, i) => fill(start - i, i))});
  const result = await sample.pending;
  assert.equal(result.source.status, 'ready');
  assert.equal(sample.requests.length, 84);
  for (const [index, request] of sample.requests.entries()) {
    if (index) assert.ok(request.time - sample.requests[index - 1].time >= LIMITS.spacing);
    const window = sample.requests.slice(0, index + 1).filter(row => request.time - row.time < minute);
    assert.ok(window.reduce((weight, row) => weight + row.weight, 0) <= LIMITS.weight);
  }
  const bad = structuredClone(result);
  bad.accounts[address(1)].rows[1] = bad.accounts[address(1)].rows[0];
  assert.throws(() => validateState(bad, start + LIMITS.round), /invalid_fills_checkpoint/);
});
