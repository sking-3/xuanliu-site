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
const okxPeriodsFile = 'okx/period-returns.json';
const files = [
  ['okx/trades.json', 'okx-trades.js', 32 * MiB],
  [okxPeriodsFile, 'okx-period-data.js', MiB],
  ['bitget/period-returns.json', 'bitget-period-data.js', 32 * MiB],
];
const periodSamplesFile = 'period-samples.json';
const periodSamplesLimit = 8 * MiB;
const periods = ['7D', '30D', '90D', '180D', '365D', 'ALL'];
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
      const nextPart = account.performance?.[period];
      for (const key of ['lastSuccessAt', 'curveFetchedAt'])
        compareTime(part[key], nextPart?.[key], file + ' ' + id(old) + ' ' + period + ' ' + key);
      compareTime(part.winRateEvidence?.lastSuccessAt, nextPart?.winRateEvidence?.lastSuccessAt,
        file + ' ' + id(old) + ' ' + period + ' win-rate observation');
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

function validatePeriodBundle(before, after) {
  const rows = addressIndex(after.feed), samples = after.samples;
  const addresses = Object.keys(samples.accounts).sort();
  if (addresses.length !== rows.size || addresses.some(address => !rows.has(address))) {
    throw Error('Hyperliquid feed and period samples must have identical accounts');
  }
  compareTime(before.samples?.generatedAt, samples.generatedAt, 'Hyperliquid period samples snapshot');
  for (const [address, row] of rows) {
    const windows = samples.accounts[address], previous = before.samples?.accounts[address];
    for (const period of periods) {
      const next = windows[period], old = previous?.[period];
      if (!next || !Number.isFinite(Date.parse(next.observedAt)) ||
          Date.parse(next.observedAt) > Date.parse(samples.generatedAt) + 5000) {
        throw Error('Hyperliquid missing current period observation for ' + address + ' ' + period);
      }
      compareTime(old?.anchorAt, next.anchorAt, 'Hyperliquid ' + address + ' ' + period + ' cutoff');
      compareTime(old?.observedAt, next.observedAt, 'Hyperliquid ' + address + ' ' + period + ' observation');
      for (const key of ['mdd', 'win', 'native']) {
        if (!next[key]) continue;
        compareTime(old?.[key]?.observedAt, next[key].observedAt,
          'Hyperliquid ' + address + ' ' + period + ' ' + key + ' observation');
        if (Date.parse(next[key].observedAt) > Date.parse(samples.generatedAt) + 5000) {
          throw Error('Hyperliquid period metric observation is newer than its snapshot');
        }
      }
      if (['7D', '30D', 'ALL'].includes(period)) {
        const native = next.native, metric = row.windows[period];
        if (!native || !metric || Date.parse(native.sourceAt) !== Date.parse(metric.asOf) ||
            Date.parse(next.anchorAt) !== Date.parse(metric.asOf) ||
            native.roi !== metric.roi || native.pnl !== metric.pnl) {
          throw Error('Hyperliquid native metric and sample cutoff differ for ' + address + ' ' + period);
        }
        compareTime(before.feed?.traders.find(prior => prior.accountId === address)?.windows[period]?.asOf,
          metric.asOf, 'Hyperliquid ' + address + ' ' + period + ' source time');
        compareTime(old?.native?.sourceAt, native.sourceAt, 'Hyperliquid ' + address + ' ' + period + ' native source time');
      }
    }
  }
}

async function stageHyperliquid(root, revision, loadFile) {
  const validators = require(path.join(root, 'plaza.js'));
  const policy = require(path.join(root, 'source-policy.js'));
  const periodMetrics = require(path.join(root, 'period-metrics.js'));
  const snapshots = [], before = {}, after = {}, legacyRetained = {};
  const parse = (kind, bytes, field) => {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (kind === 'feed') {
      validators.validateSource(data, validators.validate(data));
      if (Date.parse(data.source?.lastAttemptAt) > Date.now() + 5000) throw Error('Future feed observation');
    } else if (kind === 'samples') periodMetrics.parseSamples(data);
    else {
      if (kind === 'analytics') validators.validateWinCache(data);
      else validators.validatePortfolioCache(data);
      validateAggregateSource(data, field);
    }
    return data;
  };
  // Legacy analytics can remain at their previous capture times. The newly
  // collected feed and six-window samples are the indivisible current bundle.
  for (const [kind, limit, field] of [...hyperliquidFiles, ['samples', periodSamplesLimit]]) {
    const file = kind === 'samples' ? periodSamplesFile : kind + '.json';
    const last = await readLocal(path.join(root, file), limit);
    before[kind] = last && parse(kind, last, field);
    let bytes, incoming;
    try {
      bytes = await loadFile(revision, file, limit);
      if (bytes.length > limit) throw Error(file + ' exceeds the download limit');
      incoming = parse(kind, bytes, field);
      if (field) {
        compareTime(before[kind]?.generatedAt, incoming.generatedAt, 'Hyperliquid ' + kind + ' snapshot');
        for (const [address, prior] of Object.entries(before[kind]?.accounts || {})) {
          const next = incoming.accounts[address];
          if (!next) continue;
          compareTime(prior.lastAttemptAt, next.lastAttemptAt, 'Hyperliquid ' + kind + ' attempt for ' + address);
          compareTime(prior.fetchedAt, next.fetchedAt, 'Hyperliquid ' + kind + ' observation for ' + address);
          if (prior[field] && !next[field]) throw Error(kind + ' would erase a verified legacy sample');
        }
      }
    } catch (error) {
      if (!field || !before[kind]) throw Error(file + ' failed its deployed Hyperliquid schema validator', { cause: error });
      bytes = last; incoming = before[kind]; legacyRetained[kind] = error.message;
    }
    after[kind] = incoming;
    snapshots.push({ file, bytes, last, changed: !last || !bytes.equals(last),
      count: field || kind === 'samples' ? Object.keys(incoming.accounts).length : incoming.traders.length,
      generatedAt: kind === 'feed' ? incoming.source.lastAttemptAt : incoming.generatedAt });
  }
  const decision = policy.decision(after);
  if (!decision.allowed) throw Error('Hyperliquid source policy: ' + decision.reason);
  const summary = validateHyperliquidTransition(before, after);
  validatePeriodBundle(before, after);
  // Serve samples before the directory that advertises their matching cutoff.
  snapshots.sort((a, b) => Number(a.file === 'feed.json') - Number(b.file === 'feed.json'));
  return { snapshots, summary: { status: 'verified', ...summary, sourceStop: null, legacyRetained } };
}

async function sync({
  root, staging, stateFile, check = false, localOkxPeriods = false, localBitgetPeriods = false, getRevision = mainRevision, loadFile = githubFile,
}) {
  const revision = await getRevision();
  if (!sha40.test(revision)) throw Error('Invalid GitHub revision');
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const staged = await fs.mkdtemp(path.join(staging, 'sync-'));
  const groups = [], platforms = {};
  let hyperliquid;
  const prepareEvidence = async evidence => {
    const replace = [];
    for (const [file, digest] of evidence) {
      const present = await readLocal(path.join(root, file), 3 * MiB);
      if (present) {
        if (sha256(present) !== digest) throw Error(file + ' existing evidence hash mismatch');
        continue;
      }
      const bytes = await loadFile(revision, file, 3 * MiB);
      if (bytes.length > 3 * MiB || sha256(bytes) !== digest) throw Error(file + ' downloaded evidence hash mismatch');
      const target = path.join(staged, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { mode: 0o644 });
      replace.push(file);
    }
    return replace;
  };
  try {
    // One platform's unavailable/older catalog or evidence must not suppress
    // independently verified data from the other public sources.
    for (const [name, exchange] of [['OKX', 'okx'], ['Bitget', 'bitget']]) {
      try {
        const snapshots = [], evidence = new Map();
        for (const [file, model, limit] of files.filter(entry => entry[0].startsWith(exchange + '/'))) {
          const parser = require(path.join(root, model));
          if (localOkxPeriods && file === okxPeriodsFile || localBitgetPeriods && file === 'bitget/period-returns.json') {
            const bytes = await readLocal(path.join(root, file), limit);
            if (!bytes) throw Error(file + ' is missing from the local collector');
            const local = parseCatalog(bytes, parser, file);
            snapshots.push({ file, count: local.accounts.length, generatedAt: local.generatedAt, source: 'local', changed: false });
            continue;
          }
          const bytes = await loadFile(revision, file, limit);
          if (bytes.length > limit) throw Error(file + ' exceeds the download limit');
          const incoming = parseCatalog(bytes, parser, file);
          const last = await readLocal(path.join(root, file), limit);
          retainPublished(last && parseCatalog(last, parser, file), incoming, file);
          collectEvidence(incoming, exchange, evidence);
          snapshots.push({ file, bytes, last, changed: !last || !bytes.equals(last), count: incoming.accounts.length, generatedAt: incoming.generatedAt });
        }
        groups.push({ name, snapshots, evidence, replace: await prepareEvidence(evidence) });
        platforms[name] = { status: 'verified' };
      } catch (error) { platforms[name] = { status: 'retained', reason: error.message }; }
    }
    try {
      const batch = await stageHyperliquid(root, revision, loadFile);
      groups.push({ name: 'Hyperliquid', snapshots: batch.snapshots, evidence: new Map(), replace: [] });
      hyperliquid = batch.summary;
    } catch (error) { hyperliquid = { status: 'retained', reason: error.message }; }

    const updated = [], catalogs = {};
    let evidenceCount = 0;
    for (const group of groups) {
      const changed = group.snapshots.filter(snapshot => snapshot.changed);
      try {
        for (const snapshot of changed) {
          const target = path.join(staged, snapshot.file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, snapshot.bytes, { mode: 0o644 });
          const before = await readLocal(path.join(root, snapshot.file), 32 * MiB);
          if (snapshot.last ? !before?.equals(snapshot.last) : before) throw Error(snapshot.file + ' changed while validating');
        }
        if (!check) {
          for (const file of group.replace) {
            await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
            try { await fs.link(path.join(staged, file), path.join(root, file)); }
            catch (error) {
              if (error.code !== 'EEXIST') throw error;
              if (sha256(await readLocal(path.join(root, file), 3 * MiB)) !== group.evidence.get(file)) {
                throw Error(file + ' changed during publication');
              }
            }
          }
          const installed = [];
          try {
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
        }
        updated.push(...changed.map(snapshot => snapshot.file)); evidenceCount += group.replace.length;
        for (const { file, count, generatedAt, source } of group.snapshots) {
          catalogs[file] = { count, generatedAt, ...(source ? { source } : {}) };
        }
      } catch (error) {
        const retained = { status: 'retained', reason: error.message };
        if (group.name === 'Hyperliquid') hyperliquid = retained;
        else platforms[group.name] = retained;
      }
    }
    const actions = { revision, check, evidence: evidenceCount, hyperliquid, platforms, catalogs, updated };
    if (!check && stateFile) {
      const temporary = stateFile + '.' + process.pid + '.tmp';
      await fs.writeFile(temporary, JSON.stringify({ ...actions, checkedAt: new Date().toISOString() }) + '\n', { mode: 0o644 });
      await fs.rename(temporary, stateFile);
    }
    return actions;
  } finally { await fs.rm(staged, { recursive: true, force: true }); }
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
      localOkxPeriods: process.env.BOOKS_OKX_PERIODS_SOURCE === 'local',
      localBitgetPeriods: process.env.BOOKS_BITGET_PERIODS_SOURCE === 'local',
    }).then(result => console.log(JSON.stringify(result)), error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { sync, mainRevision, githubFile, validatePeriodBundle };
