'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const repository = 'sking-3/xuanliu-site';
const publicationBranch = 'research-publication-verified';
const files = ['macro-cn.json', 'quant-research/data/latest.json'];
const limits = { 'macro-cn.json': 262144, 'quant-research/data/latest.json': 2 * 1024 * 1024 };
const sha40 = /^[a-f0-9]{40}$/;
const sha64 = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const DAY = 86400000;

async function publicationRevision() {
  const ref = 'refs/heads/' + publicationBranch;
  const { stdout } = await run('git', ['ls-remote', '--refs', 'https://github.com/' + repository + '.git', ref], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeout: 20000,
    maxBuffer: 4096,
  });
  if (!stdout.trim()) throw Object.assign(Error('Waiting for the first approved research publication'), { code: 'not_approved' });
  const [revision, actualRef] = stdout.trim().split(/\s+/);
  if (!sha40.test(revision) || actualRef !== ref) throw Error('No verified research publication branch');
  return revision;
}

async function githubFile(revision, file, limit) {
  if (!sha40.test(revision) || !['manifest.json', ...files].includes(file)) throw Error('Invalid approved download');
  const response = await fetch('https://raw.githubusercontent.com/' + repository + '/' + revision + '/' + file, {
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
    if (bytes > limit) {
      await response.body.cancel().catch(() => {});
      throw Error(file + ' exceeds the download limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function timestamp(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) throw Error('Invalid publication timestamp');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + 300000 || new Date(time).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) throw Error('Invalid publication timestamp');
  return time;
}

function validateManifest(bytes, now) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest?.schema !== 'books.research-publication.v1' || !manifest.snapshots ||
      typeof manifest.snapshots !== 'object' || Array.isArray(manifest.snapshots)) throw Error('Invalid verified publication manifest');
  const names = Object.keys(manifest.snapshots);
  if (names.some(file => !files.includes(file))) throw Error('Unknown publication file set');
  for (const entry of Object.values(manifest.snapshots)) {
    if (!entry || typeof entry.revision !== 'string' || !sha40.test(entry.revision) ||
        typeof entry.digest !== 'string' || !sha64.test(entry.digest)) throw Error('Invalid approved revision or digest');
    timestamp(entry.approvedAt, now);
  }
  return manifest;
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

function retainTime(previous, incoming, label) {
  if (previous != null && !(Date.parse(incoming) >= Date.parse(previous))) throw Error(label + ' would regress');
}

async function validateSnapshot(root, file, bytes, previous, now) {
  const next = JSON.parse(bytes.toString('utf8'));
  const before = previous && JSON.parse(previous.toString('utf8'));
  if (file === 'macro-cn.json') {
    const { validate, macroSnapshot } = require(path.join(root, 'market-overview.js'));
    const base = validate(JSON.parse(await fs.readFile(path.join(root, 'market-overview.json'), 'utf8')), now);
    const checked = macroSnapshot(next, base, now);
    if (!checked || checked.cards.macro.status !== 'ready') throw Error('Invalid official macro snapshot');
    retainTime(before?.card?.asOf, next.card.asOf, 'Macro asOf');
    retainTime(before?.card?.lastAttemptAt, next.card.lastAttemptAt, 'Macro lastAttemptAt');
    return { asOf: next.card.asOf, lastAttemptAt: next.card.lastAttemptAt };
  }

  const { normalizeBars, METHOD_VERSION } = await import(pathToFileURL(path.join(root, 'quant-research/engine.mjs')).href);
  if (next?.schemaVersion !== 1 || !['ready', 'stale', 'blocked', 'stopped', 'error'].includes(next.status) ||
      next.source?.name !== 'Kraken public OHLC' || next.source.symbol !== 'BTC/USD' ||
      next.source.url !== 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440' ||
      next.source.documentation !== 'https://docs.kraken.com/api-reference/market-data/get-ohlc-data') throw Error('Invalid public research snapshot');
  if (next.lastAttempt !== null) timestamp(next.lastAttempt, now);
  if (next.bars === null) {
    if (next.report !== null || next.dataHash !== null || next.reportHash !== null || next.retrievedAt !== null ||
        next.latestClosedAt !== null || next.runAt !== null || next.status === 'ready') throw Error('Inconsistent empty research snapshot');
  } else {
    if (!Array.isArray(next.bars) || next.bars.length < 300 || next.bars.length > 720) throw Error('Invalid public daily-bar count');
    const { bars } = normalizeBars(next.bars, { intervalMs: DAY });
    const retrievedAt = timestamp(next.retrievedAt, now);
    const latestClosedAt = timestamp(next.latestClosedAt, now);
    timestamp(next.runAt, now);
    if (latestClosedAt !== bars.at(-1).timestamp + DAY || latestClosedAt > now || latestClosedAt > retrievedAt ||
        bars.some(bar => bar.timestamp % DAY !== 0)) throw Error('Research contains unfinished or inconsistent daily bars');
    if (next.dataHash !== digest(JSON.stringify(next.bars)) || next.reportHash !== digest(JSON.stringify(next.report)) ||
        next.report?.data?.suppliedSha256 !== next.dataHash || next.report?.methodVersion !== METHOD_VERSION) throw Error('Research data or report digest mismatch');
  }
  retainTime(before?.latestClosedAt, next.latestClosedAt, 'Research latestClosedAt');
  retainTime(before?.lastAttempt, next.lastAttempt, 'Research lastAttempt');
  return { status: next.status, latestClosedAt: next.latestClosedAt, lastAttempt: next.lastAttempt };
}

async function atomicWrite(file, bytes) {
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function sync({ root, stateFile, getRevision = publicationRevision, loadFile = githubFile, now = Date.now, check = false }) {
  const time = now();
  const result = { checkedAt: new Date(time).toISOString(), check, revision: null, status: 'retained', snapshots: {}, updated: [] };
  try {
    result.revision = await getRevision();
    if (!sha40.test(result.revision)) throw Error('Invalid verified publication branch revision');
    const bytes = await loadFile(result.revision, 'manifest.json', 16384);
    if (bytes.length > 16384) throw Error('Verified publication manifest exceeds the download limit');
    const manifest = validateManifest(bytes, time);
    for (const file of files) {
      const approval = manifest.snapshots[file];
      if (!approval) {
        result.snapshots[file] = { status: 'waiting', reason: 'No approved publication for this snapshot' };
        continue;
      }
      try {
        const incoming = await loadFile(approval.revision, file, limits[file]);
        if (incoming.length > limits[file] || digest(incoming) !== approval.digest) throw Error('Approved snapshot digest mismatch or download too large');
        const target = path.join(root, file);
        const previous = await readLocal(target, limits[file]);
        const details = await validateSnapshot(root, file, incoming, previous, time);
        const changed = !previous || !incoming.equals(previous);
        if (changed && !check) await atomicWrite(target, incoming);
        if (changed) result.updated.push(file);
        result.snapshots[file] = { status: 'verified', ...approval, changed, details };
      } catch (error) {
        result.snapshots[file] = { status: 'retained', ...approval, reason: error.message };
      }
    }
    const statuses = files.map(file => result.snapshots[file].status);
    result.status = statuses.includes('retained') ? 'retained' : statuses.includes('waiting') ? 'waiting' : 'verified';
  } catch (error) {
    if (error.code === 'not_approved') result.status = 'waiting';
    result.reason = error.message;
  }
  if (!check && stateFile) await atomicWrite(stateFile, Buffer.from(JSON.stringify(result) + '\n'));
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--check')) {
    console.error('Usage: node publish-books-research-snapshots.cjs [--check]');
    process.exitCode = 2;
  } else {
    sync({
      root: path.resolve(process.env.BOOKS_SITE_DIR || '/opt/books/site'),
      stateFile: process.env.BOOKS_RESEARCH_PUBLISH_STATE,
      check: args.includes('--check'),
    }).then(result => {
      console.log(JSON.stringify(result));
      if (result.status === 'retained') process.exitCode = 1;
    }, error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { sync, publicationRevision, githubFile, validateManifest };
