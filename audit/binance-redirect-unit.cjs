'use strict';
const assert = require('node:assert/strict');
const api = require('../trader/binance/redirect.js');
const base = 'https://sking-3.github.io/xuanliu-site/trader/binance/';
assert.equal(api.destination(base), 'https://sking-3.github.io/xuanliu-site/trader/?exchange=Binance');
assert.ok(api.IDS.includes('5075281354358777856'));
for (const id of api.IDS) {
  const target = new URL(api.destination(base + '?portfolioId=' + id));
  assert.equal(target.pathname, '/xuanliu-site/trader/');
  assert.equal(target.searchParams.get('exchange'), 'Binance');
  assert.equal(target.searchParams.get('q'), id);
}
for (const suffix of ['?portfolioId=unknown', '?portfolioId=', '?portfolioId=5156287639231681792&portfolioId=5139646755272846081'])
  assert.equal(api.destination(base + suffix), null);
const navigation = [], note = {textContent: ''};
const env = { location: {href: base, replace: url => navigation.push(url)}, document: {getElementById: () => note} };
api.start(env);
assert.equal(navigation.length, 1);
env.location.href = base + '?portfolioId=unknown';
api.start(env);
assert.equal(navigation.length, 1);
assert.match(note.textContent, /不在已收录名单/);
console.log('PASS legacy Binance links reach the unified plaza without identity fallback');
