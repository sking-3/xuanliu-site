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
const parse = bytes => JSON.parse(bytes.toString());
const json = record => Buffer.from(JSON.stringify(record, null, 2) + '\n');

async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'books-trader-sync-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'trader');
  const staging = path.join(tmp, 'stage');
  const stateFile = path.join(tmp, 'state.json');
  await Promise.all([staging, path.join(root, 'okx'), path.join(root, 'bitget')].map(folder => fs.mkdir(folder, { recursive: true })));
  for (const model of ['okx-trades.js', 'okx-period-data.js', 'bitget-period-data.js']) {
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
  const getRevision = async () => revision;
  const loadFile = async (pinned, file) => {
    assert.equal(pinned, revision);
    return next.get(file) || fs.readFile(path.join(source, file));
  };
  const options = { root, staging, stateFile, getRevision, loadFile };
  async function unchanged() {
    for (const file of files) assert.deepEqual(await fs.readFile(path.join(root, file)), previous.get(file));
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

test('does not expose any new catalog when one evidence receipt fails its hash', async t => {
  const f = await fixture(t);
  const file = parse(f.next.get('bitget/period-returns.json')).accounts.at(-1).profileEvidence.evidencePath;
  const loadFile = (...args) => args[1] === file ? Buffer.from('{}') : f.options.loadFile(...args);
  await assert.rejects(sync({ ...f.options, loadFile }), /downloaded evidence hash mismatch/);
  await f.unchanged();
  await assert.rejects(fs.access(path.join(f.root, 'okx/evidence')), { code: 'ENOENT' });
});

test('rejects a disappearing account and a regressing performance observation', async t => {
  const f = await fixture(t);
  const file = 'okx/period-returns.json';
  const original = f.next.get(file);
  const removed = parse(original);
  removed.accounts.shift();
  f.next.set(file, json(removed));
  await assert.rejects(sync(f.options), /would remove account/);
  const older = parse(original);
  const current = older.accounts.at(0).performance['90D'];
  current.lastSuccessAt = new Date(Date.parse(current.lastSuccessAt) - 1000).toISOString();
  f.next.set(file, json(older));
  await assert.rejects(sync(f.options), /would regress/);
  await f.unchanged();
});
