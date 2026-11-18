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
const hyperliquidFiles = [
  ['analytics', 2 * MiB, 'win'],
  ['portfolios', 12 * MiB, 'portfolio'],
  ['feed', 2 * MiB],
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

function compareTime(previous, next, label) {
  if (previous && !(Date.parse(next) >= Date.parse(previous))) {
    throw Error(label + ' would regress');
  }
}

function addressIndex(feed) {
  const rows = new Map(feed.traders.map(row => [row.accountId, row]));
  if (rows.size !== feed.traders.length) throw Error('Hyperliquid feed contains duplicate accounts');
  return rows;
}

function validateAggregateSource(data, field) {
  const source = data.source;
  const validCounters = ['accounts', 'available', 'cached', 'attempted', 'succeeded', 'failed', 'unattempted'].every(key =>
    Number.isSafeInteger(source?.[key]) && source[key] >= 0 && source[key] <= 200);
  if (!validCounters || source.completedAt !== data.generatedAt ||
      !(Date.parse(source.startedAt) <= Date.parse(data.generatedAt)) ||
      source.available !== Object.values(data.accounts).filter(entry => entry[field]).length ||
      source.accounts !== source.cached + source.attempted + source.unattempted ||
      source.attempted !== source.succeeded + source.failed) {
    throw Error('Invalid Hyperliquid aggregate collection counters');
  }
}

function validateHyperliquidTransition(before, after) {
  const priorFeed = before.feed;
  const feed = after.feed;
  const priorRows = priorFeed ? addressIndex(priorFeed) : new Map();
  const rows = addressIndex(feed);
  const added = [...rows.keys()].filter(address => !priorRows.has(address)).sort();
  const removed = [...priorRows.keys()].filter(address => !rows.has(address)).sort();
  if (priorFeed) {
    if (priorFeed.status === 'ready' && feed.status !== 'ready') {
      throw Error('Hyperliquid unavailable feed would replace the last verified directory');
    }
    for (const key of ['fetchedAt', 'snapshotAt', 'lastAttemptAt']) {
      compareTime(priorFeed.source[key], feed.source[key], 'Hyperliquid feed ' + key);
    }
    const priorVerification = priorFeed.source.positionVerification;
    const verification = feed.source.positionVerification;
    compareTime(priorVerification?.completedAt, verification?.completedAt, 'Hyperliquid verification time');
    if (removed.length && (verification?.failedAccounts || verification?.unattemptedAccounts)) {
      throw Error('Hyperliquid incomplete verification would remove previously published accounts');
    }
    for (const [address, row] of rows) {
      compareTime(priorRows.get(address)?.positionCheck?.checkedAt, row.positionCheck?.checkedAt,
        'Hyperliquid position check for ' + address);
    }
  }
  const coverage = {};
  for (const [kind, , field] of hyperliquidFiles) {
    if (!field) continue;
    const previous = before[kind];
    const incoming = after[kind];
    compareTime(previous?.generatedAt, incoming.generatedAt, 'Hyperliquid ' + kind + ' snapshot');
    let available = 0;
    const omitted = [];
    for (const address of rows.keys()) {
      const last = previous?.accounts[address];
      const next = incoming.accounts[address];
      if (next?.[field]) available++;
      if (last?.[field] && !next) omitted.push(address);
      if (last && next) {
        compareTime(last.lastAttemptAt, next.lastAttemptAt, 'Hyperliquid ' + kind + ' attempt for ' + address);
        compareTime(last.fetchedAt, next.fetchedAt, 'Hyperliquid ' + kind + ' observation for ' + address);
        if (last[field] && !next[field]) throw Error('Hyperliquid ' + kind + ' would erase a verified sample for ' + address);
      }
    }
    coverage[kind] = { available, missing: rows.size - available, omittedPreviouslyAvailable: omitted.sort() };
  }
  return { accounts: rows.size, added, removed, coverage };
}

async function stageHyperliquid(root, revision, loadFile) {
  const validators = require(path.join(root, 'plaza.js'));
  const policy = require(path.join(root, 'source-policy.js'));
  const snapshots = [];
  const before = {};
  const after = {};
  for (const [kind, limit, field] of hyperliquidFiles) {
    const file = kind + '.json';
    const bytes = await loadFile(revision, file, limit);
    if (bytes.length > limit) throw Error(file + ' exceeds the download limit');
    const parse = value => {
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
      if (kind === 'feed') {
        validators.validateSource(data, validators.validate(data));
        // The list parser checks representation, but automatic publication also
        // needs to reject a corrupt timestamp that could lock subsequent updates.
        if (Date.parse(data.source?.lastAttemptAt) > Date.now() + 5000) {
          throw Error('Hyperliquid feed observation is in the future');
        }
      }
      else {
        if (kind === 'analytics') validators.validateWinCache(data);
        else validators.validatePortfolioCache(data);
        validateAggregateSource(data, field);
      }
      return data;
    };
    let incoming;
    let last;
    try {
      incoming = parse(bytes);
      last = await readLocal(path.join(root, file), limit);
      before[kind] = last && parse(last);
    } catch (error) {
      throw Error(file + ' failed its deployed Hyperliquid schema validator', { cause: error });
    }
    after[kind] = incoming;
    snapshots.push({
      file, bytes, last, changed: !last || !bytes.equals(last),
      count: field ? Object.keys(incoming.accounts).length : incoming.traders.length,
      generatedAt: field ? incoming.generatedAt : incoming.source.lastAttemptAt,
    });
  }
  const decision = policy.decision(after);
  const summary = validateHyperliquidTransition(before, after);
  return { snapshots, summary: { status: 'verified', ...summary, sourceStop: decision.allowed ? null : decision } };
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
  // Hyperliquid and copy-platform catalogs may be published by separate jobs.
  // A rejected Hyperliquid batch keeps all three of its previous production files.
  let hyperliquid;
  try {
    const batch = await stageHyperliquid(root, revision, loadFile);
    snapshots.push(...batch.snapshots);
    hyperliquid = batch.summary;
  } catch (error) {
    hyperliquid = { status: 'retained', reason: error.message };
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
    const actions = { revision, check, evidence: replace.length, hyperliquid, catalogs: Object.fromEntries(snapshots.map(({file, count, generatedAt}) => [file, { count, generatedAt }])), updated: changed.map(({file}) => file) };
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
      // Install account detail data before the list that advertises an account.
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
