'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const repository = 'sking-3/xuanliu-site';
const sha40 = /^[0-9a-f]{40}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const MiB = 1024 * 1024;
const files = [
  ['okx/trades.json', 'okx-trades.js', 32 * MiB],
  ['okx/period-returns.json', 'okx-period-data.js', MiB],
  ['bitget/period-returns.json', 'bitget-period-data.js', 32 * MiB],
];

async function mainRevision() {
  const { stdout } = await run('git', ['ls-remote', '--refs', 'https://github.com/' + repository + '.git', 'refs/heads/main'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeout: 20000,
    maxBuffer: 4096,
  });
  const result = /^([0-9a-f]{40})\s+refs\/heads\/main$/.exec(stdout.trim());
  if (!result) throw Error('Unable to pin GitHub main');
  return result[1];
}

async function githubFile(revision, file, limit) {
  const response = await fetch('https://raw.githubusercontent.com/' + repository + '/' + revision + '/trader/' + file, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Error(file + ' could not be read within the size limit, HTTP ' + response.status);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw Error(file + ' exceeds the download limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function readLocal(file, limit) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > limit) throw Error(file + ' is not a bounded regular file');
    return await fs.readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function parseCatalog(bytes, parser, file) {
  try { return parser.parse(JSON.parse(bytes.toString('utf8'))); }
  catch (error) { throw Error(file + ' failed its deployed schema validator', { cause: error }); }
}

function retainPublished(previous, next, file) {
  if (!previous) return;
  if (Date.parse(next.generatedAt) < Date.parse(previous.generatedAt)) throw Error(file + ' snapshot time would regress');
  const id = account => account.uniqueCode || account.portfolioId;
  const byAccount = new Map(next.accounts.map(account => [id(account), account]));
  for (const old of previous.accounts) {
    const account = byAccount.get(id(old));
    if (!account) throw Error(file + ' would remove account ' + id(old));
    for (const [period, part] of Object.entries(old.performance || {})) {
      if (part.lastSuccessAt && !(Date.parse(account.performance?.[period]?.lastSuccessAt) >= Date.parse(part.lastSuccessAt))) {
        throw Error(file + ' would regress ' + id(old) + ' ' + period);
      }
    }
    // Positions may become hidden or flat. Keep the check's order, not the old open rows.
    for (const [key, part] of Object.entries(old.activity || {})) {
      if (part?.checkedAt && !(Date.parse(account.activity?.[key]?.checkedAt) >= Date.parse(part.checkedAt))) {
        throw Error(file + ' would regress ' + id(old) + ' ' + key + ' observation');
      }
    }
    const history = new Set((account.activity?.history?.rows || []).map(row => row.id));
    if (old.activity?.history?.rows.some(row => !history.has(row.id))) {
      throw Error(file + ' would remove previous closed positions for ' + id(old));
    }
  }
}

function collectEvidence(record, exchange, evidence) {
  if (!record || typeof record !== 'object') return;
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith('EvidencePath') || key === 'evidencePath') {
      if (value == null) continue;
      const match = typeof value === 'string' && /^(okx|bitget)\/(evidence|trade-evidence)\/[a-zA-Z0-9_-]+-([a-f0-9]{64})\.json$/.exec(value);
      const digest = record[key.slice(0, -4) + 'Sha256'] || record.sha256;
      if (!match || match[1] !== exchange || (digest && digest !== match[3])) throw Error('Invalid public evidence reference');
      evidence.set(value, match[3]);
    } else if (value && typeof value === 'object') {
      collectEvidence(value, exchange, evidence);
    }
  }
}

async function sync({
  root, staging, stateFile, check = false, getRevision = mainRevision, loadFile = githubFile,
}) {
  const revision = await getRevision();
  if (!sha40.test(revision)) throw Error('Invalid GitHub revision');
  const snapshots = [];
  const evidence = new Map();
  for (const [file, model, limit] of files) {
    const parser = require(path.join(root, model));
    const bytes = await loadFile(revision, file, limit);
    if (bytes.length > limit) throw Error(file + ' exceeds the download limit');
    const incoming = parseCatalog(bytes, parser, file);
    const last = await readLocal(path.join(root, file), limit);
    retainPublished(last && parseCatalog(last, parser, file), incoming, file);
    collectEvidence(incoming, file.split('/')[0], evidence);
    snapshots.push({ file, bytes, last, changed: !last || !bytes.equals(last), count: incoming.accounts.length, generatedAt: incoming.generatedAt });
  }

  const staged = await fs.mkdtemp(path.join(staging, 'sync-'));
  try {
    const replace = [];
    for (const [file, digest] of evidence) {
      const destination = path.join(root, file);
      const present = await readLocal(destination, 3 * MiB);
      if (present) {
        if (sha256(present) !== digest) throw Error(file + ' existing evidence hash mismatch');
        continue;
      }
      const bytes = await loadFile(revision, file, 3 * MiB);
      if (bytes.length > 3 * MiB || sha256(bytes) !== digest) throw Error(file + ' downloaded evidence hash mismatch');
      const stagedFile = path.join(staged, file);
      await fs.mkdir(path.dirname(stagedFile), { recursive: true });
      await fs.writeFile(stagedFile, bytes, { mode: 0o644 });
      replace.push(file);
    }

    const changed = snapshots.filter(snapshot => snapshot.changed);
    const actions = { revision, check, evidence: replace.length, catalogs: Object.fromEntries(snapshots.map(({file, count, generatedAt}) => [file, { count, generatedAt }])), updated: changed.map(({file}) => file) };
    if (check) return actions;

    // Install immutable evidence before changing the pointers that refer to it.
    for (const file of replace) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      try { await fs.link(path.join(staged, file), path.join(root, file)); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (sha256(await readLocal(path.join(root, file), 3 * MiB)) !== evidence.get(file)) {
          throw Error(file + ' changed during publication');
        }
      }
    }

    for (const { file, bytes, last } of changed) {
      const target = path.join(staged, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { mode: 0o644 });
      const before = await readLocal(path.join(root, file), 32 * MiB);
      if (last ? !before?.equals(last) : before) throw Error(file + ' changed while validating');
    }
    const installed = [];
    try {
      // trades.json is replaced before the OKX catalog advertises a new account.
      for (const snapshot of changed) {
        await fs.rename(path.join(staged, snapshot.file), path.join(root, snapshot.file));
        installed.push(snapshot);
      }
    } catch (error) {
      for (const { file, last } of installed.reverse()) {
        if (!last) await fs.unlink(path.join(root, file));
        else {
          await fs.writeFile(path.join(staged, file), last, { mode: 0o644 });
          await fs.rename(path.join(staged, file), path.join(root, file));
        }
      }
      throw error;
    }
    if (stateFile) {
      const temporary = stateFile + '.' + process.pid + '.tmp';
      await fs.writeFile(temporary, JSON.stringify({ ...actions, checkedAt: new Date().toISOString() }) + '\n', { mode: 0o644 });
      await fs.rename(temporary, stateFile);
    }
    return actions;
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--check')) {
    console.error('Usage: node publish-books-trader-snapshots.cjs [--check]');
    process.exitCode = 2;
  } else {
    sync({
      root: path.resolve(process.env.BOOKS_TRADER_ROOT || '/opt/books/site/trader'),
      staging: path.resolve(process.env.BOOKS_TRADER_PUBLISH_STAGE || '/opt/books/trader-publisher-stage'),
      stateFile: process.env.BOOKS_TRADER_PUBLISH_STATE,
      check: args.includes('--check'),
    }).then(result => console.log(JSON.stringify(result)), error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { sync };
