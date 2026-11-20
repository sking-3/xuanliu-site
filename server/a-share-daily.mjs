import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
export const MARKET_URL = 'https://raw.githubusercontent.com/wenyuanw/a-share-heatmap/main/src/lib/data/market-heatmap-fallback.json';
export const INDICES = ['000300.SH', '000001.SH', '399001.SZ'];
const INDEX_NAMES = { '000300.SH': '沪深300', '000001.SH': '上证指数', '399001.SZ': '深证成指' };
export const SCHEDULE = '工作日 16:30（北京时间）；按最近已收盘日校验，失败保留上次成功结果';

async function atomicJson(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value));
  await rename(path + '.tmp', path);
}

export function retryAfter(value, now) {
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(until) ? new Date(Math.max(now, until)).toISOString() : null;
}

export function createGuard({ db, fetch: request, now = Date.now, wait = sleep, interval = 1500, signal, onRequest = () => {} }) {
  let previous = null;
  const get = db.prepare('SELECT value FROM settings WHERE key=?');
  const set = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
  return async function guardedFetch(url, options = {}) {
    signal?.throwIfAborted();
    const hold = get.get('source-hold');
    if (hold) throw Error('来源访问已暂停：' + JSON.parse(hold.value).reason);
    if (previous !== null) await wait(Math.max(0, previous + interval - now()));
    signal?.throwIfAborted();
    previous = now();
    onRequest();
    const requestSignal = options.signal || AbortSignal.timeout(15000);
    const response = await request(url, { ...options, signal: signal ? AbortSignal.any([signal, requestSignal]) : requestSignal, redirect: 'error' });
    if ([401, 403, 418, 429, 451].includes(response.status)) {
      const record = { reason: 'HTTP ' + response.status, httpStatus: response.status, stoppedAt: new Date(now()).toISOString(), retryAfter: retryAfter(response.headers.get('retry-after'), now()) };
      set.run('source-hold', JSON.stringify(record));
      throw Error('来源拒绝访问：' + record.reason + (record.retryAfter ? '；Retry-After 至 ' + record.retryAfter : '') + '。已停止，不自动重试。');
    }
    return response;
  };
}

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history(day TEXT NOT NULL,code TEXT NOT NULL,as_of TEXT NOT NULL,source_json TEXT NOT NULL,PRIMARY KEY(day,code));`);
  return db;
}

export async function precompute({ dir, siteDir, snapshot, universe, sources, references, day, asOf, startedAt, now = Date.now, onProgress = () => {} }) {
  const engine = require(join(siteDir, 'screening/trend-screen.js'));
  const generation = day + '-' + now();
  const target = join(dir, 'generations', generation);
  await mkdir(target, { recursive: true });
  async function save(name, value) {
    const body = JSON.stringify(value);
    await writeFile(join(target, name + '.json'), body);
    await writeFile(join(target, name + '.json.gz'), gzipSync(body));
  }
  await save('market', snapshot);
  const finishedAt = new Date(now()).toISOString();
  for (const benchmark of INDICES) {
    const anchor = references.get(benchmark);
    for (const sampleSize of ['120', '240', 'all']) {
      const selected = engine.selectMarketSample(universe, sampleSize === 'all' ? Infinity : Number(sampleSize));
      const records = selected.map(stock => ({ stock, source: sources.get(stock.code) }));
      const dataset = { schema: 'books.research.dataset.v1', day, asOf, completed: true, collectionStatus: 'complete', expectedCount: records.length, totalUniverseCount: universe.length, universe, reference: { code: benchmark, adjustment: 'index', bars: anchor.bars, fetchedAt: anchor.fetchedAt }, records, startedAt, finishedAt };
      await save('dataset-' + sampleSize + '-' + benchmark, dataset);
      for (const lookback of [20, 60]) {
        const modes = sampleSize === 'all' ? ['consensus', 'market', 'strength'] : ['consensus'];
        for (const mode of modes) {
          onProgress({ stage: 'precomputing', currentCode: mode + '/' + lookback + '/' + sampleSize + '/' + benchmark });
          const consensus = mode === 'consensus' ? engine.buildConsensus({ records: records.filter(r => r.source.status === 'ready').map(r => ({ stock: r.stock, bars: r.source.bars })), calendar: anchor.bars, lookback, day, expectedCount: records.length, totalUniverseCount: universe.length }) : null;
          const times = records.map(r => r.source.fetchedAt).filter(Boolean).sort();
          const resultRecords = records.map(({ stock, source }) => ({ stock, fetchedAt: source.fetchedAt || null, referenceFetchedAt: anchor.fetchedAt, result: source.status === 'ready' ? engine.evaluate({ mode, bars: source.bars, referenceBars: anchor.bars, lookback, day, code: stock.code, consensus, limits: { enabled: false } }) : { status: 'unavailable', matched: null, reason: source.reason } }));
          const { perCode, memberCodes, ...summary } = consensus || {};
          const status = consensus && consensus.status !== 'ready' ? 'unavailable' : 'complete';
          await save('result-' + mode + '-' + lookback + '-' + sampleSize + '-' + benchmark, { generation, mode, lookback, day, asOf, reference: { code: benchmark, name: INDEX_NAMES[benchmark] }, limits: { enabled: false }, status, phase: 'evaluated', records: resultRecords, total: records.length, marketUniverseCount: universe.length, fullMarket: sampleSize === 'all', consensus: consensus ? summary : null, referenceFetchedAt: anchor.fetchedAt, poolFetchedStart: times[0] || null, poolFetchedEnd: times.at(-1) || null, requests: 0, startedAt, finishedAt, reason: consensus?.reason || '' });
        }
      }
    }
  }
  const ready = universe.filter(stock => sources.get(stock.code)?.status === 'ready').length;
  const completed = { generation, day, asOf, startedAt, finishedAt: new Date(now()).toISOString(), total: universe.length, ready };
  await atomicJson(join(target, 'complete.json'), { ...completed, completed: true });
  return completed;
}

export async function collect({ dir, siteDir, fetch: request = globalThis.fetch, now = Date.now, wait = sleep, interval = 1500, signal, calendar, pool, technicalFactory, compute = precompute } = {}) {
  await mkdir(dir, { recursive: true });
  const db = openStore(join(dir, 'collector.sqlite'));
  const attempt = { status: 'running', stage: 'calendar', day: null, total: 0, checked: 0, ready: 0, missing: 0, requests: 0, resumed: 0, currentCode: null, startedAt: new Date(now()).toISOString(), finishedAt: null, error: null };
  let pending = Promise.resolve();
  function progress(fields = {}) {
    Object.assign(attempt, fields);
    const status = { configured: true, schedule: SCHEDULE, attempt: { ...attempt } };
    pending = pending.then(() => atomicJson(join(dir, 'status.json'), status));
  }
  const sourceFetch = createGuard({ db, fetch: request, now, wait, interval, signal, onRequest: () => progress({ requests: attempt.requests + 1 }) });
  try {
    calendar ||= require(join(siteDir, 'market-calendar.js'));
    pool ||= require(join(siteDir, 'screening/market-pool.js'));
    technicalFactory ||= require(join(siteDir, 'screening/technical-screen.js')).createClient;
    const latest = calendar.latestClosed('CN', now());
    if (!latest) throw Error('交易日历未核验，不能推断目标收盘日期。');
    let previous = null;
    try { previous = JSON.parse(await readFile(join(dir, 'current.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous?.day === latest.date && Date.parse(previous.asOf) >= Date.parse(latest.closeTime)) {
      progress({ status: 'no_new_day', stage: 'waiting', day: latest.date, total: previous.total, finishedAt: new Date(now()).toISOString() });
      await pending;
      return { attempt, lastSuccess: previous };
    }
    progress({ day: latest.date, stage: 'market' });
    const response = await sourceFetch(MARKET_URL);
    if (!response.ok) throw Error('市场名册 HTTP ' + response.status);
    const snapshot = await response.json();
    const market = pool.build(snapshot);
    const asOf = new Date(snapshot.updatedAt).toISOString();
    if (market.day !== latest.date || Date.parse(asOf) < Date.parse(latest.closeTime) || Date.parse(asOf) > now()) throw Error('市场名册日期 ' + market.day + ' 未覆盖最近收盘日 ' + latest.date + '；未覆盖上次结果。');
    const universe = pool.select(market.rows, { universe: 'main', excludeRiskNames: true }).filter(r => r.exchange !== 'BJ').map(({ code, name, sector, exchange }) => ({ code, name, sector, exchange }));
    if (universe.length < 1000) throw Error('沪深主板名册覆盖不足。');
    progress({ total: universe.length, stage: 'indices' });
    const getSetting = db.prepare('SELECT value FROM settings WHERE key=?');
    const storage = { getItem: key => getSetting.get(key)?.value || null, setItem: (key, value) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value), removeItem: key => db.prepare('DELETE FROM settings WHERE key=?').run(key) };
    const technical = technicalFactory({ fetch: sourceFetch, localStorage: storage, now, preferSuccessfulHost: true });
    const read = db.prepare('SELECT source_json FROM history WHERE day=? AND code=? AND as_of=?');
    const save = db.prepare('INSERT OR REPLACE INTO history(day,code,as_of,source_json) VALUES(?,?,?,?)');
    const references = new Map(), sources = new Map();
    async function history(stock, index) {
      signal?.throwIfAborted();
      const cached = read.get(latest.date, stock.code, asOf);
      if (cached) { attempt.resumed++; return JSON.parse(cached.source_json); }
      const source = await technical.history({ ...stock, asOf }, latest.date, new AbortController().signal, { minBars: 61, index });
      signal?.throwIfAborted();
      const hold = getSetting.get('source-hold');
      if (hold || source.sourceStopped) {
        const stopped = hold ? JSON.parse(hold.value) : null;
        throw Error(stopped ? stopped.reason + (stopped.retryAfter ? '；Retry-After 至 ' + stopped.retryAfter : '') + '：来源已暂停，不重试。' : source.reason);
      }
      if (source.transportError) throw Error('日线传输失败（' + stock.code + '）：' + source.reason + '；本轮已停止，已成功记录留待续跑。');
      const clean = { status: source.status, day: latest.date, adjustment: source.adjustment || null, bars: source.bars?.slice(-61) || [], fetchedAt: source.fetchedAt || null, reason: source.reason || null };
      if (clean.status === 'ready') save.run(latest.date, stock.code, asOf, JSON.stringify(clean));
      return clean;
    }
    for (const code of INDICES) {
      progress({ currentCode: code });
      const source = await history({ code }, true);
      if (source.status !== 'ready') throw Error('指数 ' + code + '：' + source.reason);
      references.set(code, source);
    }
    progress({ stage: 'collecting' });
    for (const stock of universe) {
      progress({ currentCode: stock.code });
      const source = await history(stock, false);
      sources.set(stock.code, source);
      progress({ checked: attempt.checked + 1, ready: attempt.ready + Number(source.status === 'ready'), missing: attempt.missing + Number(source.status !== 'ready') });
    }
    if (attempt.ready / universe.length < .8) throw Error('同日有效日线覆盖不足80%：' + attempt.ready + '/' + universe.length + '；保留上次成功结果。');
    const result = await compute({ dir, siteDir, snapshot, universe, sources, references, day: latest.date, asOf, startedAt: attempt.startedAt, now, onProgress: progress });
    signal?.throwIfAborted();
    if (previous && (previous.day > result.day || Date.parse(previous.asOf) > Date.parse(result.asOf))) throw Error('新批次日期早于已发布结果，拒绝回退。');
    await atomicJson(join(dir, 'current.json'), result);
    progress({ status: 'complete', stage: 'published', currentCode: null, finishedAt: new Date(now()).toISOString() });
    await pending;
    return { attempt, lastSuccess: result };
  } catch (error) {
    progress({ status: 'failed', stage: attempt.stage, error: error.message, finishedAt: new Date(now()).toISOString() });
    await pending;
    return { attempt };
  } finally { db.close(); }
}

async function main() {
  const dir = process.env.BOOKS_A_SHARE_DIR || '/var/lib/books/a-share-daily';
  const siteDir = resolve(process.env.BOOKS_SITE_DIR || '/opt/books/site');
  await mkdir(dir, { recursive: true });
  const lock = join(dir, 'worker.lock');
  try { await writeFile(lock, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    try { process.kill(pid, 0); throw Error('已有采集进程运行：' + pid); }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    await unlink(lock);
    await writeFile(lock, String(process.pid), { flag: 'wx' });
  }
  try {
    const control = new AbortController();
    for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => control.abort(Error('任务被停止，已完成日线留待续跑；正式结果保持不变。')));
    const result = await collect({ dir, siteDir, signal: control.signal });
    console.log(JSON.stringify(result));
    if (!['complete', 'no_new_day'].includes(result.attempt.status)) process.exitCode = 1;
  } finally { await unlink(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
