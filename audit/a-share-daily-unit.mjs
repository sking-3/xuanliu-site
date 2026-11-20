import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collect, createGuard, openStore, precompute, retryAfter, INDICES } from '../server/a-share-daily.mjs';

const now = () => Date.parse('2026-11-21T00:00:00Z');
const asOf = '2026-11-20T08:15:00.000Z';
const latest = { date: '2026-11-20', closeTime: '2026-11-20T07:00:00.000Z' };
const stocks = Array.from({ length: 1000 }, (_, i) => ({ code: String(600000 + i) + '.SH', name: '测试' + i, exchange: 'SH', sector: '测试' }));
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'books-daily-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function options(dir, changes = {}) {
  return { dir, siteDir: resolve('.'), now, wait: async () => {}, calendar: { latestClosed: () => latest }, pool: { build: value => ({ day: value.updatedAt.slice(0, 10), rows: stocks }), select: rows => rows }, fetch: async () => Response.json({ updatedAt: asOf }), technicalFactory: () => ({ history: async (stock, day, signal, settings) => ({ status: 'ready', adjustment: settings.index ? 'index' : 'qfq', bars: [{ date: day, close: 1, volume: 1 }], fetchedAt: new Date(now()).toISOString() }) }), compute: async input => ({ generation: '2026-11-20-1', day: input.day, asOf: input.asOf, total: input.universe.length, ready: input.sources.size }), ...changes };
}

test('429 reads full Retry-After and prevents every subsequent request, including after restart', async () => fixture(async dir => {
  let calls = 0;
  let db = openStore(join(dir, 'test.sqlite'));
  let fetch = createGuard({ db, now, fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); } });
  await assert.rejects(fetch('https://example.test'), /429/);
  const hold = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('source-hold').value);
  assert.equal(hold.retryAfter, '2026-11-21T00:02:00.000Z');
  await assert.rejects(fetch('https://example.test'), /暂停/);
  db.close();
  db = openStore(join(dir, 'test.sqlite'));
  fetch = createGuard({ db, now, fetch: async () => { calls++; } });
  await assert.rejects(fetch('https://example.test'), /暂停/);
  assert.equal(calls, 1);
  db.close();
}));

test('418, 403 and 451 stop without fallback requests', async () => fixture(async dir => {
  for (const status of [418, 403, 451]) {
    const db = openStore(join(dir, status + '.sqlite'));
    let calls = 0;
    const fetch = createGuard({ db, fetch: async () => { calls++; return new Response('', { status }); } });
    await assert.rejects(fetch('https://example.test'), new RegExp(String(status)));
    await assert.rejects(fetch('https://other.test'), /暂停/);
    assert.equal(calls, 1);
    db.close();
  }
}));

test('all external requests share the minimum interval', async () => fixture(async dir => {
  const db = openStore(join(dir, 'test.sqlite')); let time = 0; const waits = [];
  const fetch = createGuard({ db, now: () => time, wait: async ms => { waits.push(ms); time += ms; }, fetch: async () => new Response('{}') });
  await fetch('https://example.test'); await fetch('https://example.test'); await fetch('https://example.test');
  assert.deepEqual(waits, [1500, 1500]); db.close();
}));

test('Retry-After HTTP date is retained', () => {
  assert.equal(retryAfter('Sat, 21 Nov 2026 00:10:00 GMT', now()), '2026-11-21T00:10:00.000Z');
  assert.equal(retryAfter('invalid', now()), null);
});

test('interrupted compute resumes same-day history; completed day skips all external requests', async () => fixture(async dir => {
  let historyCalls = 0, computes = 0;
  let externalCalls = 0;
  const input = options(dir, { fetch: async () => { externalCalls++; return Response.json({ updatedAt: asOf }); }, technicalFactory: () => ({ history: async () => { historyCalls++; return { status: 'ready', adjustment: 'qfq', bars: [], fetchedAt: new Date(now()).toISOString() }; } }), compute: async value => { computes++; assert.equal(value.sources.size, 1000); assert.equal(value.references.size, 3); if (computes === 1) throw Error('interrupted'); return { generation: '2026-11-20-1', day: value.day, asOf: value.asOf, total: 1000, ready: 1000 }; } });
  assert.equal((await collect(input)).attempt.status, 'failed');
  assert.equal(historyCalls, 1003);
  assert.equal((await collect(input)).attempt.resumed, 1003);
  assert.equal(historyCalls, 1003); assert.equal(computes, 2);
  assert.equal((await collect(input)).attempt.status, 'no_new_day'); assert.equal(externalCalls, 2);
  assert.equal(JSON.parse(await readFile(join(dir, 'current.json'))).day, latest.date);
}));

test('late market date fails before stock requests and retains last success', async () => fixture(async dir => {
  const old = { generation: '2026-11-19-1', day: '2026-11-19', asOf: '2026-11-19T08:00:00Z' };
  await writeFile(join(dir, 'current.json'), JSON.stringify(old));
  let calls = 0;
  const result = await collect(options(dir, { fetch: async () => Response.json({ updatedAt: '2026-11-19T08:00:00Z' }), technicalFactory: () => ({ history: () => { calls++; } }) }));
  assert.equal(result.attempt.status, 'failed'); assert.match(result.attempt.error, /未覆盖最近收盘日/);
  assert.equal(calls, 0); assert.deepEqual(JSON.parse(await readFile(join(dir, 'current.json'))), old);
}));

test('coverage below 80% does not precompute or overwrite last success', async () => fixture(async dir => {
  await writeFile(join(dir, 'current.json'), '{"generation":"2026-11-19-1"}');
  let computed = false;
  const result = await collect(options(dir, { technicalFactory: () => ({ history: async (stock, day, signal, settings) => settings.index ? { status: 'ready', bars: [] } : { status: 'unavailable', reason: '缺目标日' } }), compute: async () => { computed = true; } }));
  assert.equal(result.attempt.status, 'failed'); assert.match(result.attempt.error, /覆盖不足80%/); assert.equal(computed, false);
  assert.equal(JSON.parse(await readFile(join(dir, 'current.json'))).generation, '2026-11-19-1');
}));

test('unverified calendar makes zero external requests', async () => fixture(async dir => {
  let calls = 0;
  const result = await collect(options(dir, { calendar: { latestClosed: () => null }, fetch: async () => { calls++; } }));
  assert.match(result.attempt.error, /交易日历未核验/); assert.equal(calls, 0);
}));

test('failed precompute retains previous pointer and reports exact stage', async () => fixture(async dir => {
  await writeFile(join(dir, 'current.json'), '{"generation":"2026-11-19-1"}');
  const result = await collect(options(dir, { compute: async ({ onProgress }) => { onProgress({ stage: 'precomputing' }); throw Error('disk full'); } }));
  assert.equal(result.attempt.status, 'failed'); assert.equal(result.attempt.stage, 'precomputing'); assert.equal(result.attempt.error, 'disk full');
  assert.equal(JSON.parse(await readFile(join(dir, 'current.json'))).generation, '2026-11-19-1');
}));

test('actual archived bars generate all three modes and both periods without external requests', { skip: !process.env.BOOKS_TEST_DATASET }, async () => fixture(async dir => {
  const file = process.env.BOOKS_TEST_DATASET;
  if (!file) return;
  const archived = JSON.parse(await readFile(file));
  const universe = archived.records.map(r => r.stock);
  const sources = new Map(archived.records.map(r => [r.stock.code, r.source]));
  const references = new Map(INDICES.map(code => [code, archived.reference]));
  const published = await precompute({ dir, siteDir: resolve('.'), snapshot: {}, universe, sources, references, day: archived.day, asOf: archived.asOf, startedAt: asOf, now });
  for (const mode of ['consensus', 'market', 'strength']) for (const lookback of [20, 60]) {
    const value = JSON.parse(await readFile(join(dir, 'generations', published.generation, 'result-' + mode + '-' + lookback + '-all-000300.SH.json')));
    assert.equal(value.day, archived.day); assert.equal(value.total, universe.length); assert.equal(value.status, 'complete');
    assert(value.records.every(r => r.result.status !== 'ready' || r.result.metrics.endAt === archived.day));
  }
  assert.equal(JSON.parse(await readFile(join(dir, 'generations', published.generation, 'complete.json'))).completed, true);
  for (const stock of universe.slice(0, 50)) sources.set(stock.code, { status: 'unavailable', reason: '缺日线', bars: [] });
  const limited = await precompute({ dir, siteDir: resolve('.'), snapshot: {}, universe, sources, references, day: archived.day, asOf: archived.asOf, startedAt: asOf, now: () => now() + 1 });
  const result = JSON.parse(await readFile(join(dir, 'generations', limited.generation, 'result-consensus-20-120-000300.SH.json')));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /覆盖不足/);
}));

test('stopping collection records a failure, retains last result and makes no subsequent request', async () => fixture(async dir => {
  await writeFile(join(dir, 'current.json'), '{"generation":"2026-11-19-1","day":"2026-11-19"}');
  const control = new AbortController(); let calls = 0;
  const result = await collect(options(dir, { signal: control.signal, technicalFactory: () => ({ history: async () => { calls++; control.abort(Error('任务被停止')); return { status: 'ready', bars: [] }; } }) }));
  assert.equal(result.attempt.status, 'failed'); assert.match(result.attempt.error, /任务被停止/); assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'current.json'))).day, '2026-11-19');
}));

test('transport failure ends the batch immediately rather than counting every stock as missing', async () => fixture(async dir => {
  let calls=0;
  const result=await collect(options(dir,{technicalFactory:()=>({history:async(stock,day,signal,settings)=>{calls++;return settings.index?{status:'ready',bars:[]}:{status:'unavailable',transportError:true,reason:'HTTP 501'};}})}));
  assert.equal(result.attempt.status,'failed');assert.match(result.attempt.error,/HTTP 501/);assert.equal(calls,4);assert.equal(result.attempt.checked,0);assert.equal(result.attempt.missing,0);
}));
