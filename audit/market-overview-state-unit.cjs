const assert = require('node:assert/strict');
const api = require('../market-overview.js');

const now = Date.parse('2026-11-18T00:00:00Z');
const base = {
  status: 'ready',
  sourceName: '国家统计局',
  sourceUrl: 'https://www.stats.gov.cn/sj/zxfb/',
  sourceUpdatedAt: '2026-11-17T00:00:00Z',
  fetchedAt: '2026-11-17T00:00:00Z',
  lastAttemptAt: '2026-11-17T00:00:00Z',
  asOf: '2026-11-17T00:00:00Z',
  errorCode: null,
  data: { latest: { title: '发布', url: 'https://www.stats.gov.cn/sj/zxfb/', publishedAt: '2026-11-17T00:00:00Z', updatedAt: null }, events: [] },
};

assert.equal(api.cardState('macro', base, now, false), 'ready');
assert.equal(api.cardState('macro', base, now, true), 'stale');
assert.equal(api.cardStateLabel('stale', true), '读取失败 · 保留旧值');
assert.equal(api.cardState('macro', { ...base, data: null }, now, true), 'unavailable');
assert.equal(api.cardStateLabel('unavailable', true), '来源读取失败');
assert.equal(api.cardStateLabel('unavailable', false), '暂无可核验数据');
console.log('market overview state tests passed');
