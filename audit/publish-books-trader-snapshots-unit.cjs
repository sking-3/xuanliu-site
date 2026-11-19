'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sync } = require('../scripts/publish-books-trader-snapshots.cjs');

const source = path.resolve(__dirname, '../trader');
const revision = 'abcd'.repeat(10);
const files = ['okx/trades.json', 'okx/period-returns.json', 'bitget/period-returns.json'];
const hyperliquidFiles = ['analytics.json', 'portfolios.json', 'feed.json', 'period-samples.json'];
const parse = bytes => JSON.parse(bytes.toString());
const json = record => Buffer.from(JSON.stringify(record, null, 2) + '\n');

function periodSamples(feed) {
  const accounts = {};
  for (const row of feed.traders) {
    accounts[row.accountId] = {};
    for (const period of ['7D', '30D', '90D', '180D', '365D', 'ALL']) {
      const metric = row.windows[period];
      const anchorAt = metric?.asOf || row.windows.ALL.asOf;
      const sample = { anchorAt, observedAt: feed.source.fetchedAt, curve: [], mdd: null, win: null };
      if (metric) sample.native = { roi: metric.roi, pnl: metric.pnl, sourceAt: anchorAt,
        observedAt: feed.source.fetchedAt, sourcePeriod: metric.sourcePeriod, sha256: feed.source.rawSha256 };
      accounts[row.accountId][period] = sample;
    }
  }
  return json({ schemaVersion: 1, generatedAt: feed.source.lastAttemptAt, accounts });
}

async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'books-trader-sync-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'trader');
  const staging = path.join(tmp, 'stage');
  const stateFile = path.join(tmp, 'state.json');
  await Promise.all([staging, path.join(root, 'okx'), path.join(root, 'bitget')].map(folder => fs.mkdir(folder, { recursive: true })));
  for (const model of ['okx-trades.js', 'okx-period-data.js', 'bitget-period-data.js', 'plaza.js', 'period-roi.js', 'source-policy.js', 'period-metrics.js']) {
    await fs.copyFile(path.join(source, model), path.join(root, model));
  }
  const next = new Map();
  const previous = new Map();
  for (const file of files) {
    const incoming = parse(await fs.readFile(path.join(source, file)));
    const old = { ...incoming, accounts: incoming.accounts.slice(0, -1) };
    previous.set(file, json(old));
    next.set(file, json(incoming));
    await fs.writeFile(path.join(root, file), previous.get(file));
  }
  for (const file of hyperliquidFiles) {
    const bytes = file === 'period-samples.json' ? periodSamples(parse(next.get('feed.json'))) : await fs.readFile(path.join(source, file));
    previous.set(file, bytes);
    next.set(file, bytes);
    await fs.writeFile(path.join(root, file), bytes);
  }
  const getRevision = async () => revision;
  const loadFile = async (pinned, file) => {
    assert.equal(pinned, revision);
    return next.get(file) || fs.readFile(path.join(source, file));
  };
  const options = { root, staging, stateFile, getRevision, loadFile };
  async function unchanged() {
    for (const file of [...files, ...hyperliquidFiles]) assert.deepEqual(await fs.readFile(path.join(root, file)), previous.get(file));
    await assert.rejects(fs.access(stateFile), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(staging), []);
  }
  return { root, stateFile, staging, next, previous, options, unchanged };
}

test('stages a new account per catalog and verifies pinned evidence before publishing', async t => {
  const f = await fixture(t);
  assert.ok(f.next.get('bitget/period-returns.json').length > 1048576, 'fixture crosses the former frontend catalog budget');
  const check = await sync({ ...f.options, check: true });
  assert.ok(check.evidence > 0);
  assert.deepEqual(check.updated, files);
  await f.unchanged();

  const release = await sync(f.options);
  assert.deepEqual(release.updated, files);
  for (const file of files) {
    const installed = await fs.readFile(path.join(f.root, file));
    assert.deepEqual(installed, f.next.get(file));
    assert.equal(parse(installed).accounts.length, parse(f.previous.get(file)).accounts.length + 1);
  }
  const okx = parse(f.next.get('okx/period-returns.json'));
  const evidence = okx.accounts.at(-1).performance['90D'].evidencePath;
  assert.deepEqual(await fs.readFile(path.join(f.root, evidence)), await fs.readFile(path.join(source, evidence)));
  assert.equal(parse(await fs.readFile(f.stateFile)).revision, revision);
  assert.deepEqual((await sync(f.options)).updated, []);
  assert.deepEqual(await fs.readdir(f.staging), []);
});

test('keeps the affected platform catalog unchanged when its evidence fails, while other platforms can publish', async t => {
  const f = await fixture(t);
  const catalog = 'bitget/period-returns.json';
  const file = parse(f.next.get(catalog)).accounts.at(-1).profileEvidence.evidencePath;
  const loadFile = (...args) => args[1] === file ? Buffer.from('{}') : f.options.loadFile(...args);
  const result = await sync({ ...f.options, loadFile });
  assert.equal(result.platforms.Bitget.status, 'retained');
  assert.match(result.platforms.Bitget.reason, /downloaded evidence hash mismatch/);
  assert.deepEqual(await fs.readFile(path.join(f.root, catalog)), f.previous.get(catalog));
  assert.deepEqual(result.updated, files.filter(file => file.startsWith('okx/')));
  for (const file of result.updated) assert.deepEqual(await fs.readFile(path.join(f.root, file)), f.next.get(file));
  for (const file of hyperliquidFiles) assert.deepEqual(await fs.readFile(path.join(f.root, file)), f.previous.get(file));
  await assert.rejects(fs.access(path.join(f.root, 'bitget/evidence')), { code: 'ENOENT' });
});

test('retains a platform on disappearing accounts or regressing performance observations', async t => {
  const f = await fixture(t);
  const file = 'okx/period-returns.json';
  const original = f.next.get(file);
  const removed = parse(original);
  removed.accounts.shift();
  f.next.set(file, json(removed));
  const missing = await sync({ ...f.options, check: true });
  assert.equal(missing.platforms.OKX.status, 'retained');
  assert.match(missing.platforms.OKX.reason, /would remove account/);
  const older = parse(original);
  const current = older.accounts.at(0).performance['90D'];
  current.lastSuccessAt = new Date(Date.parse(current.lastSuccessAt) - 1000).toISOString();
  f.next.set(file, json(older));
  const regression = await sync({ ...f.options, check: true });
  assert.equal(regression.platforms.OKX.status, 'retained');
  assert.match(regression.platforms.OKX.reason, /would regress/);
  assert.equal(regression.platforms.Bitget.status, 'verified');
  await f.unchanged();
});

function replaceFeedRows(feed, rows, failed = 0) {
  feed.traders = rows;
  feed.source.selectedAccounts = rows.length;
  const verification = feed.source.positionVerification;
  verification.failedAccounts = failed;
  verification.checkedAccounts = verification.candidateAccounts - failed - verification.unattemptedAccounts;
  verification.holdingAccounts = rows.length;
  verification.emptyAccounts = verification.checkedAccounts - verification.holdingAccounts;
  return feed;
}

test('publishes the verified Hyperliquid roster as-is when qualification changes; older aggregate cohorts are allowed', async t => {
  const f = await fixture(t);
  const next = parse(f.next.get('feed.json'));
  const before = parse(f.previous.get('feed.json'));
  const departed = '0x' + 'f'.repeat(40);
  assert.ok(!next.traders.some(row => row.accountId === departed));
  const oldRow = {
    ...before.traders.at(-1),
    accountId: departed,
    id: 'hl-' + departed,
    sourceUrl: 'https://app.hyperliquid.xyz/explorer/address/' + departed,
  };
  const earlier = json(replaceFeedRows(before, [...before.traders.slice(0,-2), oldRow]));
  await fs.writeFile(path.join(f.root, 'feed.json'), earlier);
  f.previous.set('feed.json', earlier);
  const earlierSamples = periodSamples(parse(earlier));
  await fs.writeFile(path.join(f.root, 'period-samples.json'), earlierSamples);
  f.previous.set('period-samples.json', earlierSamples);
  // A positions-only refresh has a newer or different cohort than the full run.
  const cache = parse(f.next.get('portfolios.json'));
  const added = next.traders.slice(-2).map(row => row.accountId).sort();
  for (const address of added) {
    if (Object.hasOwn(cache.accounts, address)) {
      const entry = cache.accounts[address];
      if (entry.portfolio) cache.source.available--;
      delete cache.accounts[address];
      cache.source.accounts--;
    }
  }
  Object.assign(cache.source, {
    cached: cache.source.available, attempted: 0, succeeded: 0, failed: 0,
    unattempted: cache.source.accounts - cache.source.available,
  });
  f.next.set('portfolios.json', json(cache));
  const check = await sync({ ...f.options, check: true });
  assert.equal(check.hyperliquid.status, 'verified');
  assert.deepEqual(check.hyperliquid.added, added);
  assert.deepEqual(check.hyperliquid.removed, [departed]);
  assert.ok(check.hyperliquid.coverage.portfolios.missing >= 2);
  await f.unchanged();
  const published = await sync(f.options);
  assert.deepEqual(published.updated.slice(-3), ['portfolios.json', 'period-samples.json', 'feed.json']);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'feed.json')), f.next.get('feed.json'));
  assert.deepEqual(await fs.readFile(path.join(f.root, 'portfolios.json')), f.next.get('portfolios.json'));
});

test('keeps the current Hyperliquid bundle on incomplete removals, invalid samples and regressing sample times', async t => {
  const f = await fixture(t);
  const incoming = parse(f.next.get('feed.json'));
  const missing = replaceFeedRows(incoming, incoming.traders.slice(1), 1);
  f.next.set('feed.json', json(missing));
  f.next.set('period-samples.json', periodSamples(missing));
  const incomplete = await sync({ ...f.options, check: true });
  assert.equal(incomplete.hyperliquid.status, 'retained');
  assert.match(incomplete.hyperliquid.reason, /incomplete verification would remove/);
  assert.ok(!incomplete.updated.includes('feed.json'));
  f.next.set('feed.json', f.previous.get('feed.json'));

  const malformed = parse(f.previous.get('period-samples.json'));
  Object.values(malformed.accounts)[0]['30D'].curve = [{ time: '2020-01-01T00:00:00Z', value: 0 }];
  f.next.set('period-samples.json', json(malformed));
  const invalid = await sync({ ...f.options, check: true });
  assert.equal(invalid.hyperliquid.status, 'retained');
  assert.match(invalid.hyperliquid.reason, /period-samples.json failed its deployed/);

  const older = parse(f.previous.get('period-samples.json'));
  older.generatedAt = new Date(Date.parse(older.generatedAt)-1).toISOString();
  f.next.set('period-samples.json', json(older));
  const disjoint = await sync(f.options);
  assert.match(disjoint.hyperliquid.reason, /period samples snapshot would regress/);
  assert.deepEqual(disjoint.updated, files, 'the copy-trader releases may still advance');
  for (const file of hyperliquidFiles) assert.deepEqual(await fs.readFile(path.join(f.root, file)), f.previous.get(file));
});

test('keeps legacy analytics unchanged on invalid or older data without blocking the current bundle', async t => {
  const f = await fixture(t);
  const malformed = parse(f.next.get('analytics.json'));
  const win = Object.values(malformed.accounts).find(entry => entry.win?.value > 0);
  win.win.value += 0.1;
  f.next.set('analytics.json', json(malformed));
  const invalid = await sync({ ...f.options, check: true });
  assert.equal(invalid.hyperliquid.status, 'verified');
  assert.ok(invalid.hyperliquid.legacyRetained.analytics);
  assert.ok(!invalid.updated.includes('analytics.json'));

  const older = parse(f.previous.get('analytics.json'));
  older.generatedAt = new Date(Date.parse(older.generatedAt)-1).toISOString();
  older.source.completedAt = older.generatedAt;
  f.next.set('analytics.json', json(older));
  const old = await sync({ ...f.options, check: true });
  assert.equal(old.hyperliquid.status, 'verified');
  assert.match(old.hyperliquid.legacyRetained.analytics, /analytics snapshot would regress/);
  await f.unchanged();
});

test('rejects oversized current sample downloads while retaining the full prior bundle', async t => {
  const f = await fixture(t);
  const loadFile = (...args) => args[1] === 'period-samples.json' ? Buffer.alloc(8*1024*1024+1) : f.options.loadFile(...args);
  const result = await sync({ ...f.options, loadFile, check: true });
  assert.equal(result.hyperliquid.status, 'retained');
  assert.match(result.hyperliquid.reason, /period-samples.json failed its deployed/);
  assert.ok(!result.updated.includes('period-samples.json'));
  await f.unchanged();
});
