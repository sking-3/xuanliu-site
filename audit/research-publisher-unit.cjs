'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sync, githubFile } = require('../scripts/publish-books-research-snapshots.cjs');

const source = path.resolve(__dirname, '..');
const files = ['macro-cn.json', 'quant-research/data/latest.json'];
const branchRevision = 'a'.repeat(40);
const dataRevision = 'b'.repeat(40);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-research-publish-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'quant-research/data'), { recursive: true });
  for (const file of [...files, 'market-overview.js', 'market-overview.json', 'quant-research/engine.mjs']) {
    await fs.copyFile(path.join(source, file), path.join(root, file));
  }
  const incoming = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(root, file))])));
  const before = new Map(incoming);
  const macro = JSON.parse(incoming.get(files[0]));
  const research = JSON.parse(incoming.get(files[1]));
  const now = Math.max(Date.now(), Date.parse(macro.card.lastAttemptAt), Date.parse(research.lastAttempt)) + 86400000;
  const nextAttempt = new Date(now - 3600000).toISOString();
  const manifest = { schema: 'books.research-publication.v1', snapshots: {} };
  for (const file of files) manifest.snapshots[file] = { revision: dataRevision, digest: digest(incoming.get(file)), approvedAt: nextAttempt };
  const requests = [];
  const stateFile = path.join(root, 'state.json');
  const options = { root, stateFile, now: () => now, getRevision: async () => branchRevision,
    loadFile: async (revision, file) => {
      requests.push({ revision, file });
      assert.equal(revision, file === 'manifest.json' ? branchRevision : dataRevision);
      return file === 'manifest.json' ? json(manifest) : incoming.get(file);
    } };
  function approve(file, value) {
    incoming.set(file, json(value));
    manifest.snapshots[file].digest = digest(incoming.get(file));
  }
  async function unchanged(file) { assert.deepEqual(await fs.readFile(path.join(root, file)), before.get(file)); }
  return { root, stateFile, options, manifest, incoming, before, requests, approve, unchanged, nextAttempt };
}

test('uses approved branch and data revisions; identical snapshots preserve file mtime', async t => {
  const f = await fixture(t);
  const modified = new Date('2026-11-20T00:00:00Z');
  for (const file of files) await fs.utimes(path.join(f.root, file), modified, modified);
  const result = await sync(f.options);
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.updated, []);
  assert.deepEqual(f.requests.map(request => request.file), ['manifest.json', ...files]);
  for (const file of files) {
    await f.unchanged(file);
    assert.equal((await fs.stat(path.join(f.root, file))).mtimeMs, modified.getTime());
  }
  assert.equal(JSON.parse(await fs.readFile(f.stateFile)).revision, branchRevision);
});

test('check mode validates an approved update without replacing files or writing state', async t => {
  const f = await fixture(t);
  const macro = JSON.parse(f.incoming.get(files[0]));
  macro.generatedAt = macro.card.fetchedAt = macro.card.lastAttemptAt = f.nextAttempt;
  f.approve(files[0], macro);
  const checked = await sync({ ...f.options, check: true });
  assert.deepEqual(checked.updated, [files[0]]);
  await f.unchanged(files[0]);
  await assert.rejects(fs.access(f.stateFile), { code: 'ENOENT' });
  const published = await sync(f.options);
  assert.deepEqual(published.updated, [files[0]]);
  assert.deepEqual(await fs.readFile(path.join(f.root, files[0])), f.incoming.get(files[0]));
  assert.ok(!(await fs.readdir(f.root)).some(file => file.endsWith('.tmp')));
});

test('approval lookup failures or malformed manifests never request or replace snapshots', async t => {
  for (const invalid of [null, { schema: 'wrong', snapshots: {} }, { schema: 'books.research-publication.v1', snapshots: 42 }, { schema: 'books.research-publication.v1', snapshots: { '../other.json': {} } }]) {
    const f = await fixture(t);
    const result = await sync({ ...f.options, getRevision: async () => { if (invalid === null) throw Error('No verified branch'); return branchRevision; },
      loadFile: async (_revision, file) => { assert.equal(file, 'manifest.json'); return json(invalid); } });
    assert.equal(result.status, 'retained');
    assert.ok(result.reason);
    for (const file of files) await f.unchanged(file);
    assert.ok(JSON.parse(await fs.readFile(f.stateFile)).reason);
  }
});

test('rejects invalid approved revision, digest and timestamp before requesting snapshots', async t => {
  for (const change of [{ revision: 'main' }, { digest: 'bad' }, { approvedAt: '2026-02-30T00:00:00Z' }]) {
    const f = await fixture(t);
    Object.assign(f.manifest.snapshots[files[0]], change);
    const result = await sync(f.options);
    assert.equal(result.status, 'retained');
    assert.equal(f.requests.length, 1);
    for (const file of files) await f.unchanged(file);
  }
});

test('wrong digest or failed download preserves that snapshot while other approved data can publish', async t => {
  for (const unavailable of [false, true]) {
    const f = await fixture(t);
    const macro = JSON.parse(f.incoming.get(files[0]));
    macro.generatedAt = macro.card.fetchedAt = macro.card.lastAttemptAt = f.nextAttempt;
    f.approve(files[0], macro);
    f.manifest.snapshots[files[1]].digest = '0'.repeat(64);
    const result = await sync({ ...f.options, loadFile: async (...args) => {
      if (unavailable && args[1] === files[1]) throw Error('Network unavailable');
      return f.options.loadFile(...args);
    } });
    assert.deepEqual(result.updated, [files[0]]);
    assert.equal(result.snapshots[files[1]].status, 'retained');
    await f.unchanged(files[1]);
  }
});

test('rejects macro schema and source-clock regression without changing its published bytes', async t => {
  for (const kind of ['schema', 'asOf', 'lastAttemptAt']) {
    const f = await fixture(t);
    const macro = JSON.parse(f.incoming.get(files[0]));
    if (kind === 'schema') macro.card.data.latest.url = 'https://example.org/release';
    if (kind === 'asOf') macro.card.asOf = macro.card.data.latest.publishedAt = new Date(Date.parse(macro.card.asOf) - 86400000).toISOString();
    if (kind === 'lastAttemptAt') macro.card.lastAttemptAt = new Date(Date.parse(macro.card.lastAttemptAt) - 86400000).toISOString();
    f.approve(files[0], macro);
    const result = await sync(f.options);
    assert.equal(result.snapshots[files[0]].status, 'retained');
    assert.equal(result.snapshots[files[1]].status, 'verified');
    await f.unchanged(files[0]);
  }
});

test('rejects research schema, report digest and latestClosedAt or lastAttempt regression', async t => {
  for (const kind of ['schema', 'report', 'latestClosedAt', 'lastAttempt']) {
    const f = await fixture(t);
    const research = JSON.parse(f.incoming.get(files[1]));
    if (kind === 'schema') research.source.url = 'https://example.org/market';
    if (kind === 'report') research.reportHash = '0'.repeat(64);
    if (kind === 'latestClosedAt') {
      research.bars.pop();
      research.latestClosedAt = new Date(Date.parse(research.latestClosedAt) - 86400000).toISOString();
      research.dataHash = digest(JSON.stringify(research.bars));
      research.report.data.suppliedSha256 = research.dataHash;
      research.reportHash = digest(JSON.stringify(research.report));
    }
    if (kind === 'lastAttempt') research.lastAttempt = new Date(Date.parse(research.lastAttempt) - 86400000).toISOString();
    f.approve(files[1], research);
    const result = await sync(f.options);
    assert.equal(result.snapshots[files[1]].status, 'retained');
    if (['latestClosedAt', 'lastAttempt'].includes(kind)) assert.match(result.snapshots[files[1]].reason, /would regress/);
    await f.unchanged(files[1]);
  }
});

test('a first single-file approval does not touch the unapproved research snapshot', async t => {
  const f = await fixture(t);
  delete f.manifest.snapshots[files[1]];
  const result = await sync(f.options);
  assert.equal(result.status, 'waiting');
  assert.equal(result.snapshots[files[0]].status, 'verified');
  assert.equal(result.snapshots[files[1]].status, 'waiting');
  assert.match(result.snapshots[files[1]].reason, /No approved publication/);
  assert.deepEqual(f.requests.map(request => request.file), ['manifest.json', files[0]]);
  await f.unchanged(files[1]);
});

test('an empty valid approval manifest waits without downloading or changing either snapshot', async t => {
  const f = await fixture(t);
  f.manifest.snapshots = {};
  const result = await sync(f.options);
  assert.equal(result.status, 'waiting');
  assert.deepEqual(f.requests.map(request => request.file), ['manifest.json']);
  for (const file of files) {
    assert.equal(result.snapshots[file].status, 'waiting');
    await f.unchanged(file);
  }
});

test('an actual snapshot error remains retained even when another approval is still waiting', async t => {
  const f = await fixture(t);
  delete f.manifest.snapshots[files[1]];
  f.manifest.snapshots[files[0]].digest = '0'.repeat(64);
  const result = await sync(f.options);
  assert.equal(result.status, 'retained');
  assert.equal(result.snapshots[files[0]].status, 'retained');
  assert.equal(result.snapshots[files[1]].status, 'waiting');
  for (const file of files) await f.unchanged(file);
});

test('CLI waits with exit zero only for a successful empty branch lookup; real lookup errors exit one', async t => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  for (const [script, expectedStatus, expectedExit] of [
    ['exit 0', 'waiting', 0],
    ['echo invalid-branch-output', 'retained', 1],
    ['exit 2', 'retained', 1],
  ]) {
    await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
    const child = spawnSync(process.execPath, [path.join(source, 'scripts/publish-books-research-snapshots.cjs')], {
      encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, BOOKS_SITE_DIR: f.root, BOOKS_RESEARCH_PUBLISH_STATE: f.stateFile },
    });
    assert.equal(child.status, expectedExit, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, expectedStatus);
    assert.deepEqual(result.snapshots, {});
    assert.ok(result.reason);
    assert.equal(JSON.parse(await fs.readFile(f.stateFile)).status, expectedStatus);
    for (const file of files) await f.unchanged(file);
  }
});

test('download helper rejects unknown files and oversized HTTP bodies', async () => {
  await assert.rejects(githubFile(dataRevision, 'account.json', 20), /Invalid approved download/);
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('1234567890');
  try { await assert.rejects(githubFile(dataRevision, 'macro-cn.json', 5), /download limit/); }
  finally { global.fetch = originalFetch; }
});
