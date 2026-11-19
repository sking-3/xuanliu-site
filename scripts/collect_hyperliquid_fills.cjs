#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { readBoundedJson, checkCommitted } = require('./hyperliquid_run_guard.cjs');
const { readJsonResponse } = require('./collect_trader_analytics.cjs');

const INFO = 'https://api.hyperliquid.xyz/info';
const MINUTE = 60000;
const FILE_BYTES = 4 * 1024 * 1024;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/i;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const LIMITS = Object.freeze({
  accounts: 200,
  rows: 50,
  pageCap: 500,
  responseLimit: 2000,
  initialWindow: 30 * MINUTE,
  lookback: 6 * 60 * MINUTE,
  overlap: MINUTE,
  weight: 600,
  reservation: 120,
  spacing: 3000,
  timeout: 12000,
  round: 15 * MINUTE,
});
const STOPS = new Set(['http_403', 'http_429']);
const ERRORS = new Set(['network_error', 'request_timeout', 'batch_timeout', 'invalid_response',
  'invalid_content_type', 'response_too_large', 'response_cap']);
const OPTIONAL_DECIMALS = ['startPosition', 'fee', 'closedPnl'];
const OPTIONAL_TEXT = ['dir', 'feeToken'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const epoch = value => integer(value) && value <= 8640000000000000;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const shortText = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const decimal = value => typeof value === 'string' && value.length <= 40 && DECIMAL.test(value);
const fail = code => { throw Error(code); };
const safeError = error => {
  const message = error?.message;
  return ERRORS.has(message) || /^http_[45]\d\d$/.test(message || '') ? message : 'invalid_response';
};
const identity = row => JSON.stringify([row.coin, row.time, row.tid, row.oid, row.side]);

function selectAccounts(feed, now) {
  if (!plain(feed) || feed.schemaVersion !== 1 || feed.status !== 'ready' || !Array.isArray(feed.traders) ||
      feed.traders.length > LIMITS.accounts || feed.source?.id !== 'hyperliquid' || feed.source.status !== 'ok' ||
      feed.source.positionVerification?.scope !== 'default_perp_dex') fail('invalid_fills_roster');
  const rosterTime = Date.parse(feed.source.positionVerification.completedAt);
  if (!epoch(rosterTime) || rosterTime > now + 5000 || now - rosterTime > 60 * MINUTE) fail('stale_fills_roster');
  const addresses = new Set();
  for (const row of feed.traders) {
    const address = row?.accountId;
    if (typeof address !== 'string' || !ADDRESS.test(address) || addresses.has(address) ||
        row.exchange !== 'Hyperliquid' || row.sourceKind !== 'public_account' ||
        row.positionCheck?.scope !== 'default_perp_dex' || !integer(row.positionCheck.count) ||
        row.positionCheck.count < 1) fail('invalid_fills_roster');
    addresses.add(address);
  }
  return [...addresses];
}

function validateSeed(seed, now) {
  const fetched = timestamp(seed?.fetchedAt), verified = timestamp(seed?.positionVerifiedAt);
  if (seed?.schemaVersion !== 1 || !epoch(fetched) || !epoch(verified) || fetched > verified ||
      verified > now + 5000 || !Array.isArray(seed.addresses) || !seed.addresses.length ||
      seed.addresses.length > LIMITS.accounts || seed.addresses.some(address => typeof address !== 'string' || !ADDRESS.test(address)) ||
      new Set(seed.addresses).size !== seed.addresses.length) fail('invalid_fills_seed');
  return seed.addresses;
}

function fill(raw, from, to) {
  if (!plain(raw) || !shortText(raw.coin) || !epoch(raw.time) || raw.time < from || raw.time > to ||
      !integer(raw.tid) || !integer(raw.oid) || !['A', 'B'].includes(raw.side) ||
      !decimal(raw.px) || Number(raw.px) < 0 || !decimal(raw.sz) || Number(raw.sz) < 0 ||
      typeof raw.hash !== 'string' || !HASH.test(raw.hash)) fail('invalid_response');
  const result = {coin: raw.coin, time: raw.time, tid: raw.tid, oid: raw.oid, side: raw.side,
    px: raw.px, sz: raw.sz, hash: raw.hash.toLowerCase()};
  for (const field of OPTIONAL_DECIMALS) {
    if (raw[field] === undefined) continue;
    if (!decimal(raw[field])) fail('invalid_response');
    result[field] = raw[field];
  }
  for (const field of OPTIONAL_TEXT) {
    if (raw[field] === undefined) continue;
    if (!shortText(raw[field])) fail('invalid_response');
    result[field] = raw[field];
  }
  if (raw.crossed !== undefined) {
    if (typeof raw.crossed !== 'boolean') fail('invalid_response');
    result.crossed = raw.crossed;
  }
  return result;
}

function validateState(raw, now = Date.now()) {
  const source = raw?.source;
  const started = timestamp(source?.startedAt), checked = timestamp(source?.checkedAt);
  if (raw?.schemaVersion !== 1 || source?.id !== 'hyperliquid' || source.endpoint !== INFO ||
      source.intervalMinutes !== 30 || !['ready', 'partial', 'stopped'].includes(source.status) ||
      (source.status === 'stopped' ? !STOPS.has(source.stopCode) : source.stopCode !== null) ||
      !epoch(started) || !epoch(checked) || started > checked || checked > now + 5000 ||
      !plain(raw.accounts) || Object.keys(raw.accounts).length > LIMITS.accounts) fail('invalid_fills_checkpoint');
  for (const [address, record] of Object.entries(raw.accounts)) {
    if (!ADDRESS.test(address) || !plain(record) || !Array.isArray(record.rows) || record.rows.length > LIMITS.rows ||
        (record.errorCode !== null && safeError({message: record.errorCode}) !== record.errorCode)) fail('invalid_fills_checkpoint');
    const attempted = timestamp(record.checkedAt), succeeded = timestamp(record.lastSuccessAt);
    if ((record.checkedAt !== null && (!epoch(attempted) || attempted > checked)) ||
        (record.lastSuccessAt === null ? record.coveredThrough !== null || record.rows.length !== 0 :
          !epoch(succeeded) || succeeded > attempted || !epoch(record.coveredThrough) ||
          record.coveredThrough > succeeded || !epoch(attempted))) fail('invalid_fills_checkpoint');
    const gap = record.gap;
    if (gap !== null && (!plain(gap) || !epoch(gap.from) || !epoch(gap.to) ||
        gap.from > gap.to || gap.to > checked ||
        !['lookback_limit', 'response_cap'].includes(gap.reason))) fail('invalid_fills_checkpoint');
    const keys = new Set();
    for (const [index, r] of record.rows.entries()) {
      const normalized = fill(r, 0, record.coveredThrough);
      const key = identity(r);
      if (keys.has(key) || Object.keys(r).length !== Object.keys(normalized).length ||
          (index > 0 && record.rows[index-1].time < r.time)) fail('invalid_fills_checkpoint');
      keys.add(key);
    }
  }
  return raw;
}

function empty() {
  return {checkedAt: null, lastSuccessAt: null, coveredThrough: null, gap: null, errorCode: null, rows: []};
}

function mergeRows(previous, fresh) {
  const byId = new Map(previous.map(row => [identity(row), row]));
  for (const row of fresh) byId.set(identity(row), row);
  return [...byId.values()].sort((a, b) => b.time - a.time || b.tid - a.tid).slice(0, LIMITS.rows);
}

async function collect({feed, previous = null, seed, fetch: fetcher = globalThis.fetch, now = Date.now,
  clock = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const start = now(), startClock = clock();
  if (previous) validateState(previous, start);
  if (previous?.source.stopCode) return previous;
  const verified = selectAccounts(feed, start);
  const addresses = new Set([...(seed === undefined ? [] : validateSeed(seed, start)), ...verified]);
  const verification = feed.source.positionVerification;
  const rosterComplete = !verification.failedAccounts && !verification.unattemptedAccounts;
  const accounts = rosterComplete ? {} : {...previous?.accounts};
  let accountCount = Object.keys(accounts).length;
  const queue = [];
  for (const address of addresses) {
    if (!Object.hasOwn(accounts, address)) {
      if (accountCount === LIMITS.accounts) continue;
      accounts[address] = previous?.accounts[address] || empty();
      accountCount++;
    }
    queue.push(address);
  }
  queue.sort((a, b) => (timestamp(accounts[a].checkedAt) || 0) - (timestamp(accounts[b].checkedAt) || 0));
  const ledger = [];
  let lastRequest = -Infinity, stopCode = null, complete = rosterComplete && addresses.size <= LIMITS.accounts;
  async function reserve() {
    while (true) {
      const current = clock();
      if (current - startClock >= LIMITS.round - LIMITS.timeout) fail('batch_timeout');
      while (ledger.length && current - ledger[0].at >= MINUTE) ledger.shift();
      const weight = ledger.reduce((sum, part) => sum + part.weight, 0);
      if (current - lastRequest >= LIMITS.spacing && weight + LIMITS.reservation <= LIMITS.weight) {
        lastRequest = current;
        const charge = {at: current, weight: LIMITS.reservation};
        ledger.push(charge);
        return charge;
      }
      await sleep(Math.max(1, lastRequest + LIMITS.spacing - current,
        weight + LIMITS.reservation > LIMITS.weight ? ledger[0].at + MINUTE - current : 0));
    }
  }
  async function readWindow(address, from, to) {
    const charge = await reserve();
    let response;
    try {
      response = await fetcher(INFO, {
        method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({type: 'userFillsByTime', user: address, startTime: from, endTime: to, aggregateByTime: false}),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(LIMITS.timeout),
      });
    } catch (error) {
      fail(error?.name === 'TimeoutError' ? 'request_timeout' : 'network_error');
    }
    if (!Number.isInteger(response?.status)) fail('invalid_response');
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch (_) {}
      fail('http_' + response.status);
    }
    const raw = await readJsonResponse(response, 2 * 1024 * 1024);
    if (!Array.isArray(raw) || raw.length > LIMITS.responseLimit) fail('invalid_response');
    charge.weight = 20 + Math.ceil(raw.length / 20);
    return raw;
  }
  for (const address of queue) {
    const prior = accounts[address];
    const expected = prior.coveredThrough === null ? start - LIMITS.initialWindow : prior.coveredThrough - LIMITS.overlap;
    const from = Math.max(0, expected, start - LIMITS.lookback);
    if (from > start) fail('invalid_fills_clock');
    let saturated = false;
    try {
      const pending = [[from, start]];
      let rows = prior.rows;
      while (pending.length) {
        const [first, last] = pending.pop();
        const raw = await readWindow(address, first, last);
        if (raw.length >= LIMITS.pageCap) {
          saturated = true;
          if (first === last) fail('response_cap');
          const split = first + Math.floor((last - first) / 2);
          pending.push([split + 1, last], [first, split]);
          continue;
        }
        rows = mergeRows(rows, raw.map(row => fill(row, first, last)));
      }
      const missed = prior.coveredThrough !== null && prior.coveredThrough + 1 < from;
      const gap = prior.gap?.reason === 'lookback_limit' ? prior.gap : missed
        ? {from: prior.coveredThrough + 1, to: from - 1, reason: 'lookback_limit'} : null;
      const checkedAt = iso(now());
      accounts[address] = {checkedAt, lastSuccessAt: checkedAt, coveredThrough: start, gap, errorCode: null, rows};
      if (gap) complete = false;
    } catch (error) {
      const code = safeError(error);
      complete = false;
      if (code === 'batch_timeout' && !saturated) break;
      const gap = (code === 'response_cap' || code === 'batch_timeout') && prior.gap?.reason !== 'lookback_limit'
        ? {from, to: start, reason: 'response_cap'} : prior.gap;
      accounts[address] = {...prior, checkedAt: iso(now()), gap, errorCode: code};
      if (code === 'batch_timeout') break;
      if (STOPS.has(code)) {
        stopCode = code;
        break;
      }
    }
  }
  const result = {schemaVersion: 1, source: {
    id: 'hyperliquid', endpoint: INFO, startedAt: iso(start), checkedAt: iso(now()),
    status: stopCode ? 'stopped' : complete ? 'ready' : 'partial', stopCode, intervalMinutes: 30,
  }, accounts};
  return validateState(result, now());
}

async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.length && args[0] !== '--gate') fail('invalid_arguments');
  const output = path.resolve(__dirname, '../trader/hyperliquid-fills.json');
  let previous = null;
  try { previous = validateState(await readBoundedJson(output, FILE_BYTES)); }
  catch (error) { if (error.message !== 'missing_file') throw error; }
  if (args.length) {
    console.log('allowed=' + !previous?.source.stopCode);
    return;
  }
  if (previous?.source.stopCode) fail(previous.source.stopCode);
  await checkCommitted();
  const feed = await readBoundedJson(path.resolve(__dirname, '../trader/feed.json'), 2 * 1024 * 1024);
  if (feed.source.status !== 'ok') {
    console.log('fills_skipped_roster_unavailable');
    return;
  }
  const seed = await readBoundedJson(path.resolve(__dirname, 'hyperliquid-fills-roster.json'), 20 * 1024);
  const result = await collect({feed, previous, seed});
  const bytes = JSON.stringify(result) + '\n';
  if (Buffer.byteLength(bytes) > FILE_BYTES) fail('checkpoint_too_large');
  const stage = output + '.' + process.pid + '.tmp';
  try {
    await fs.writeFile(stage, bytes, {flag: 'wx', mode: 0o644});
    await fs.rename(stage, output);
  } finally {
    await fs.rm(stage, {force: true});
  }
  console.log(JSON.stringify({...result.source, accounts: Object.keys(result.accounts).length}));
}

module.exports = {collect, validateState, LIMITS, FILE_BYTES};
if (require.main === module) main().catch(error => {
  // Only fixed codes and known upstream HTTP status values are public.
  const code = error?.message || '';
  console.error(/^[a-z0-9_]{1,64}$/.test(code) ? code : 'fills_collection_failed');
  process.exitCode = 1;
});
