'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseArchive, sync } = require('../scripts/publish-books-aoying-reference.cjs');

const input = path.resolve(__dirname, '../trader');
const latest = 'aoying-history.js';
const companion = 'binance/aoying-reference.json';
const revision = 'a'.repeat(40);
const read = file => fs.readFile(path.join(input, file));
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const encode = (bytes, payload) => Buffer.from(bytes.toString().split('globalThis.BooksAoyingHistory=')[0] +
  'globalThis.BooksAoyingHistory=' + JSON.stringify(payload) + ';\n');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-aoying-publisher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = await read(latest);
  await fs.writeFile(path.join(root, latest), archive);
  return { root, archive, stateFile: path.join(root, 'state.json'), getRevision: async () => revision,
    loadFile: (_, file) => read(file) };
}

test('publishes all verified periods and receipts, then checks only the unchanged Git revision', async t => {
  const files = await fixture(t);
  const original = parseArchive(files.archive);
  const first = await sync(files);
  assert.equal(first.changed, true);
  assert.equal(first.observedAt, original.profile.fetchedAt);
  const data = JSON.parse(await fs.readFile(path.join(files.root, companion)));
  assert.equal(first.curve365AsOf, original.curveByPeriod['365D'].points.at(-1).time);
  assert.deepEqual(data.rows, original.rows);
  assert.equal(data.positionRows, null);
  assert.deepEqual(data.curve, data.curveByPeriod['30D']);
  assert.equal(new Set(Object.values(data.curveByPeriod).map(x => x.sourcePeriod)).size, 5);
  for (const part of [data.profile, ...Object.values(data.curveByPeriod), ...Object.values(data.performanceByPeriod)]) {
    assert.match(part.evidencePath, /^binance\/evidence\/aoying-reference-v1\/[a-zA-Z0-9-]+-[a-f0-9]{64}\.json$/);
    assert.equal(sha(await fs.readFile(path.join(files.root, part.evidencePath))), part.evidenceSha256);
  }
  assert.equal((await sync({ ...files, loadFile() { assert.fail('same revision downloaded'); } })).changed, false);
});

test('keeps the existing archive when receipt data was tampered with', async t => {
  const files = await fixture(t);
  const forged = parseArchive(files.archive);
  forged.performanceByPeriod['365D'].roi += 10;
  await assert.rejects(sync({ ...files, loadFile: (_, file) => file === latest ? encode(files.archive, forged) : read(file) }),
    /differs from its official receipt/);
  assert.deepEqual(await fs.readFile(path.join(files.root, latest)), files.archive);
  await assert.rejects(fs.readFile(path.join(files.root, companion)), { code: 'ENOENT' });
});

test('retains a newer local archive when the GitHub observation regresses', async t => {
  const files = await fixture(t);
  const existing = parseArchive(files.archive);
  existing.profile.fetchedAt = new Date(Date.parse(existing.profile.fetchedAt) + 3600000).toISOString();
  const local = encode(files.archive, existing);
  await fs.writeFile(path.join(files.root, latest), local);
  await assert.rejects(sync(files), /profile would regress/);
  assert.deepEqual(await fs.readFile(path.join(files.root, latest)), local);
});

test('latches a denied or rate limited archive check across scheduled runs', async t => {
  const files = await fixture(t);
  const result = await sync({ ...files, async loadFile() { throw Error('archive lookup HTTP 429'); } });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'GitHub archive HTTP 429');
  assert.deepEqual(await sync({ ...files, getRevision() { assert.fail('stopped publisher attempted another request'); } }), result);
  assert.deepEqual(await fs.readFile(path.join(files.root, latest)), files.archive);
});
