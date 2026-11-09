'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { normalize } = require('../trader/okx-import.js');
// Every record below is synthetic and is confined to this offline test process.
const imported = '2026-01-02T12:00:00.000Z';
const observed = '2026-01-01T00:00:00.000Z';
const stamp = Date.parse(observed);
function raw() {
  return { code: '0', data: [{ dataVer: '20260101080000', ranks: [{
    uniqueCode: 'SYNTHETIC0000001', nickName: 'Synthetic test only', ccy: 'USDT',
    pnlRatio: '0.125', pnl: '250.50', winRatio: '0.99',
    pnlRatios: [{ beginTs: String(stamp), pnlRatio: '0.125' }, { beginTs: String(stamp - 86400000), pnlRatio: '-6.0E-4' }],
    portLink: 'https://example.invalid/secret-avatar', apiKeyTag: 'must-not-copy', extra: { secret: 'must-not-copy' }
  }] }] };
}
function wrapped(payload = raw()) { return { source: 'okx-public-lead-traders', observedAt: observed, payload }; }
function reject(change, wrap = false) {
  const input = wrap ? wrapped() : raw();
  change(input);
  assert.throws(() => normalize(input, imported), /OKX 导入校验失败/);
}

test('raw snapshot records import time, excludes untrusted curve and never invents trade metrics', () => {
  const input = raw(), before = JSON.stringify(input), feed = normalize(input, imported), row = feed.traders[0], w = row.windows['90D'];
  assert.equal(feed.status, 'ready'); assert.equal(feed.schemaVersion, 1);
  assert.equal(row.id, 'okx-SYNTHETIC0000001'); assert.equal(row.accountId, 'SYNTHETIC0000001');
  assert.equal(row.observedAt, imported); assert.equal(w.asOf, imported); assert.equal(w.asOfType, 'imported');
  assert.equal(w.roi, 12.5); assert.equal(w.pnl, 250.5);
  assert.deepEqual([w.mdd, w.wins, w.closedTrades], [null, null, null]);
  assert.deepEqual(w.curve, []); assert.deepEqual([row.positions, row.points, row.orders], [[], [], []]);
  assert.match(row.note, /20260101080000/); assert.match(row.note, /快照日期未知/); assert.match(row.note, /曲线需可靠采集时间/);
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(JSON.stringify(feed), /secret-avatar|must-not-copy|apiKeyTag|winRatio|portLink/);
  assert.deepEqual(Object.keys(row).sort(), ['id','accountId','name','exchange','currency','featured','paid','sourceUrl','observedAt','note','windows','positions','points','orders'].sort());
});
test('raw snapshot ignores malformed untrusted curve rather than presenting it', () => {
  const input = raw(); input.data[0].ranks[0].pnlRatios = 'not a usable dated curve';
  assert.deepEqual(normalize(input, imported).traders[0].windows['90D'].curve, []);
});
test('wrapper retains supplied collection time and genuine sorted points with percentage conversion', () => {
  const input = wrapped(), before = JSON.stringify(input), row = normalize(input, imported).traders[0], w = row.windows['90D'];
  assert.equal(row.observedAt, observed); assert.equal(w.asOf, observed); assert.equal(w.asOfType, 'observed');
  assert.deepEqual(w.curve, [{ time: '2025-12-31T00:00:00.000Z', value: -0.06 }, { time: observed, value: 12.5 }]);
  assert.equal(JSON.stringify(input), before); assert.match(row.note, /未经独立核验/);
});
test('case-sensitive IDs and eighteen-digit IDs retain exact string identity', () => {
  const input = raw(); input.data[0].ranks[0].uniqueCode = '123456789012345678';
  const other = { ...input.data[0].ranks[0], uniqueCode: 'aBCDEFGHIJKLMNO1' };
  input.data[0].ranks.push(other, { ...other, uniqueCode: 'ABCDEFGHIJKLMNO1' });
  assert.equal(normalize(input, imported).traders.length, 3);
  assert.equal(normalize(input, imported).traders[0].accountId, '123456789012345678');
});
test('empty successful source and twenty records are accepted without claiming full coverage', () => {
  const input = raw(), row = input.data[0].ranks[0];
  input.data[0].ranks = []; assert.deepEqual(normalize(input, imported).traders, []);
  input.data[0].ranks = Array.from({ length: 20 }, (_, i) => ({ ...row, uniqueCode: String(i).padStart(18, '0') }));
  assert.equal(normalize(input, imported).traders.length, 20);
  input.data[0].ranks.push({ ...row, uniqueCode: '999999999999999999' });
  assert.throws(() => normalize(input, imported));
});
test('reject unsuccessful envelopes, duplicate IDs and malformed identities', () => {
  reject(p => { p.code = '500'; }); reject(p => { p.code = 0; });
  reject(p => { p.data.push(p.data[0]); });
  reject(p => { p.data[0].ranks.push({ ...p.data[0].ranks[0] }); });
  for (const id of ['short', 'ABCDEF12345678901X', 123456789012345678, 'abcdefghijklmn_1']) reject(p => { p.data[0].ranks[0].uniqueCode = id; });
  for (const name of ['', '   ', 'x'.repeat(101), null]) reject(p => { p.data[0].ranks[0].nickName = name; });
  reject(p => { p.data[0].ranks[0].ccy = 'USDC'; });
  reject(p => { p.data[0].dataVer = '20260101'; });
});
test('numeric conversion preserves zero, negative and scientific values but rejects invalid bounds', () => {
  const input = raw(); input.data[0].ranks[0].pnl = '0'; input.data[0].ranks[0].pnlRatio = '-6.0E-4';
  const w = normalize(input, imported).traders[0].windows['90D']; assert.equal(w.pnl, 0); assert.equal(w.roi, -0.06);
  for (const value of ['', ' ', null, 'NaN', 'Infinity', '1e999', '1000000000000000', '0x10', '1,000', 12]) reject(p => { p.data[0].ranks[0].pnl = value; });
  reject(p => { p.data[0].ranks[0].pnlRatio = '1e13'; });
});
test('ISO times require real calendar dates and valid zones; wrapper cannot postdate import', () => {
  for (const value of ['2026-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-00-01T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00','2026-01-01T00:00:00+14:01','2026-01-01T00:00:00+15:00']) {
    assert.throws(() => normalize(raw(), value));
    reject(p => { p.observedAt = value; }, true);
  }
  assert.throws(() => normalize(raw(), '2999-01-01T00:00:00Z'));
  reject(p => { p.observedAt = '2026-01-03T00:00:00Z'; }, true);
  const input = wrapped(); input.observedAt = '2026-01-01T08:00:00+08:00';
  assert.equal(normalize(input, imported).traders[0].observedAt, observed);
  assert.equal(normalize(raw(), '2024-02-29T00:00:00Z').traders[0].observedAt, '2024-02-29T00:00:00.000Z');
});
test('wrapper validates provenance shape and refuses accidental unsupported source wrappers', () => {
  reject(p => { p.source = 'other'; }, true); reject(p => { delete p.observedAt; }, true);
  reject(p => { p.payload = []; }, true); reject(p => { p.observedAt = observed; });
});
test('curve window has inclusive exact boundaries and rejects a single out-of-range point', () => {
  const input = wrapped(), r = input.payload.data[0].ranks[0];
  r.pnlRatios = [{ beginTs: String(stamp - 90 * 86400000), pnlRatio: '0' }, { beginTs: String(stamp), pnlRatio: '0.125' }];
  assert.equal(normalize(input, imported).traders[0].windows['90D'].curve.length, 2);
  r.pnlRatios[0].beginTs = String(stamp - 90 * 86400000 - 1); assert.throws(() => normalize(input, imported));
  r.pnlRatios[0].beginTs = String(stamp + 1); assert.throws(() => normalize(input, imported));
});
test('curve rejects duplicates, bad timestamps, null values and over 1000 points without clipping', () => {
  const row = p => p.payload.data[0].ranks[0];
  reject(p => { row(p).pnlRatios.push({ ...row(p).pnlRatios[0] }); }, true);
  for (const bad of ['not-time','1e12','0','17900000000000000', 1767225600000]) reject(p => { row(p).pnlRatios[0].beginTs = bad; }, true);
  reject(p => { row(p).pnlRatios[0].pnlRatio = null; }, true);
  reject(p => { row(p).pnlRatios = null; }, true);
  reject(p => { row(p).pnlRatios = Array.from({ length: 1001 }, (_, i) => ({ beginTs: String(stamp - i), pnlRatio: '0' })); }, true);
});
test('one MiB UTF-8 cap and JSON serializability apply before output', () => {
  reject(p => { p.extra = '汉'.repeat(350000); });
  const circular = raw(); circular.circular = circular; assert.throws(() => normalize(circular, imported));
  assert.throws(() => normalize(undefined, imported));
});
test('browser global works without network or storage facilities', () => {
  const source = fs.readFileSync(path.join(__dirname, '../trader/okx-import.js'), 'utf8');
  const context = { TextEncoder, input: raw(), imported };
  vm.createContext(context); vm.runInContext(source, context);
  const feed = vm.runInContext('BooksTraderImport.normalize(input, imported)', context);
  assert.equal(feed.traders.length, 1);
  assert.equal(typeof context.fetch, 'undefined'); assert.equal(typeof context.localStorage, 'undefined');
});
