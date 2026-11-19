'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { mainRevision, githubFile } = require('./publish-books-trader-snapshots.cjs');
const {
  PORTFOLIO_ID, DETAIL_URL, PERIODS, performanceUrl, chartUrl,
  normalizeProfile, normalizePerformance, normalizeChart,
} = require('./collect_aoying.cjs');

const limit = 2 * 1024 * 1024;
const legacyFile = 'aoying-history.js';
const jsonFile = 'binance/aoying-reference.json';
const sourceEvidence = 'binance/evidence/aoying-analysis-current';
const archivedEvidence = 'binance/evidence/aoying-reference-v1';
const assignment = 'globalThis.BooksAoyingHistory=';
const wrapperComment = '/* Generated from Binance public Aoying profile/performance/chart endpoints. Positions are intentionally not requested. */\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

function requireValid(condition, message) {
  if (!condition) throw Error(message);
}

function parseArchive(bytes) {
  const code = bytes.toString('utf8');
  requireValid(code.startsWith(wrapperComment + assignment) && code.endsWith(';\n'), 'Invalid Aoying archive wrapper');
  const data = JSON.parse(code.slice(wrapperComment.length + assignment.length, -2));
  requireValid(data?.schemaVersion === 2 && data.portfolioId === PORTFOLIO_ID &&
    data.scope === 'official_historical_positions_only' && data.positionRows === null &&
    Array.isArray(data.rows), 'Invalid Aoying archive scope');
  return data;
}

async function readLocal(file) {
  try {
    const stat = await fs.lstat(file);
    requireValid(stat.isFile() && stat.size <= limit, 'Invalid local Aoying archive file');
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(file, bytes, immutable = false) {
  const previous = await readLocal(file);
  if (previous?.equals(bytes)) return false;
  requireValid(!immutable || !previous, 'Existing Aoying evidence differs from its digest');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), '.aoying-' + randomUUID());
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
    if (immutable) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
    return true;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function sameOrNewer(part, previous, label) {
  if (!previous) return;
  const before = timestamp(previous.fetchedAt);
  const next = timestamp(part.fetchedAt);
  requireValid(next > before || next === before && part.evidenceSha256 === previous.evidenceSha256,
    label + ' would regress or replace evidence at the same time');
}

async function verifiedSnapshot(incoming, previous, read, now) {
  const observed = timestamp(incoming.latestPublicFetchAt);
  requireValid(observed > 0 && observed <= now + 300000, 'Invalid Aoying observation time');
  requireValid(isDeepStrictEqual(incoming.performance, incoming.performanceByPeriod?.['30D']) &&
    isDeepStrictEqual(incoming.curve, incoming.curveByPeriod?.['30D']), 'Aoying 30D aliases do not match the period records');

  const evidence = new Map();
  async function verify(part, old, name, normalize, validateSource) {
    const relative = sourceEvidence + '/' + name + '.json';
    requireValid(part?.evidencePath === relative && timestamp(part.fetchedAt) === observed &&
      /^[a-f0-9]{64}$/.test(part.evidenceSha256 || ''), name + ' has invalid receipt metadata');
    sameOrNewer(part, old, name);
    const bytes = await read(relative);
    requireValid(bytes.length <= limit && digest(bytes) === part.evidenceSha256, name + ' receipt digest mismatch');
    const raw = JSON.parse(bytes.toString('utf8'));
    requireValid(validateSource(raw?.data), name + ' has unexpected source data');
    // Reuse the collector normalization and compare every archived field to its receipt.
    const checked = normalize(raw, part.fetchedAt, {
      path: path.resolve(__dirname, '..', 'trader', relative), sha256: part.evidenceSha256,
    });
    requireValid(isDeepStrictEqual(checked, part), name + ' differs from its official receipt');
    const evidencePath = archivedEvidence + '/' + name + '-' + part.evidenceSha256 + '.json';
    evidence.set(evidencePath, bytes);
    return { ...checked, evidencePath };
  }

  const profile = await verify(incoming.profile, previous.profile, 'profile',
    (raw, at, receipt) => normalizeProfile(raw, DETAIL_URL, at, receipt),
    data => data?.leadPortfolioId === PORTFOLIO_ID && data?.portfolioType === 'PUBLIC');
  const performanceByPeriod = {};
  const curveByPeriod = {};
  for (const period of PERIODS) {
    performanceByPeriod[period] = await verify(incoming.performanceByPeriod[period], previous.performanceByPeriod?.[period], 'performance-' + period,
      (raw, at, receipt) => normalizePerformance(raw, period, performanceUrl(period), at, receipt), data => data?.timeRange === period);
    const curve = await verify(incoming.curveByPeriod[period], previous.curveByPeriod?.[period], 'curve-' + period,
      (raw, at, receipt) => normalizeChart(raw, period, chartUrl(period), at, receipt),
      data => Array.isArray(data) && data.every(point => point.dataType === 'PNL'));
    const lastPoint = timestamp(curve.points.at(-1).time);
    const priorPoint = timestamp(previous.curveByPeriod?.[period]?.points?.at(-1)?.time);
    requireValid(lastPoint <= observed && !(lastPoint < priorPoint), period + ' last source curve point is outside its expected range');
    curveByPeriod[period] = curve;
  }

  return { evidence, data: {
    // Historical closed positions have their own archive and collection date.
    ...previous, profile, performanceByPeriod, curveByPeriod,
    performance: performanceByPeriod['30D'], curve: curveByPeriod['30D'],
    latestPublicFetchAt: incoming.latestPublicFetchAt,
    positionRows: null, positionStatus: profile.positionShow ? 'public' : 'restricted',
    positionAsOf: profile.lastTradeTime,
    positionNote: profile.positionShow ? 'Position visibility is public. Current holdings require an independent source.' :
      'Binance marks positions private for this profile.',
  } };
}

async function sync({ root, stateFile, getRevision = mainRevision, loadFile = githubFile, now = Date.now() }) {
  const afterCheck = new Date(now).toISOString();
  const oldState = await readLocal(stateFile);
  const prior = oldState ? JSON.parse(oldState.toString('utf8')) : {};
  if (prior.status === 'stopped') return prior;

  const writeState = async result => {
    const state = { ...result, checkedAt: afterCheck };
    await atomicWrite(stateFile, Buffer.from(JSON.stringify(state) + '\n'));
    return state;
  };
  try {
    const revision = await getRevision();
    requireValid(/^[0-9a-f]{40}$/.test(revision), 'Invalid GitHub revision');
    const current = await readLocal(path.join(root, jsonFile));
    const previous = current
      ? JSON.parse(current.toString('utf8'))
      : parseArchive(await readLocal(path.join(root, legacyFile)));
    if (current && revision === prior.revision && digest(current) === prior.snapshotSha256) {
      return writeState({ ...prior, changed: false });
    }
    const read = file => loadFile(revision, file, limit);
    const archive = await read(legacyFile);
    requireValid(archive.length <= limit, 'Aoying archive exceeds the download limit');
    const { data, evidence } = await verifiedSnapshot(parseArchive(archive), previous, read, now);
    const bytes = Buffer.from(JSON.stringify(data) + '\n');
    for (const [relative, body] of evidence) await atomicWrite(path.join(root, relative), body, true);
    await atomicWrite(path.join(root, legacyFile), Buffer.from(wrapperComment + assignment + JSON.stringify(data) + ';\n'));
    const changed = await atomicWrite(path.join(root, jsonFile), bytes);
    return writeState({ status: 'verified', revision, changed, snapshotSha256: digest(bytes), observedAt: data.latestPublicFetchAt,
      curve365AsOf: data.curveByPeriod['365D'].points.at(-1).time });
  } catch (error) {
    const denial = /(?:HTTP\s+|returned error:\s*)(401|403|418|429|451)\b/i.exec(error.message);
    if (!denial) throw error;
    return writeState({ ...prior, status: 'stopped', reason: 'GitHub archive HTTP ' + denial[1], changed: false });
  }
}

if (require.main === module) {
  sync({
    root: process.env.BOOKS_TRADER_ROOT || '/opt/books/site/trader',
    stateFile: process.env.BOOKS_AOYING_PUBLISH_STATE || '/var/lib/books-aoying-reference/state.json',
  }).then(result => console.log(JSON.stringify(result)), error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArchive, sync };
