import test from 'node:test';
import assert from 'node:assert/strict';
import {joinSecListings, parseSecExchangeDirectory, parseSecIndustrySub, pickExpandingMembers} from '../server/us-sec-universe.mjs';

const sec = rows => ({fields: ['cik', 'name', 'ticker', 'exchange'], data: rows});
const tick = symbol => ({symbol, providerSymbol: symbol + '.US', name: symbol, exchange: 'US'});

test('only unique official exchange matches enter the expanded securities pool', () => {
  const directory = parseSecExchangeDirectory(JSON.stringify(sec([
    [1001, 'Issuer A', 'AAA', 'Nasdaq'],
    [1002, 'Issuer B', 'BBB', 'NYSE'],
    [1003, 'Issuer C', 'CCC', 'OTC'],
    [1004, 'Issuer D', 'DDD', null],
    [1005, 'Issuer E', 'EEE', 'NYSE American'],
  ])));
  const result = joinSecListings(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'MISSING'].map(tick), directory);
  assert.deepEqual(result.members.map(row => [row.symbol, row.cik, row.listingExchange]), [
    ['AAA', '0000001001', 'Nasdaq'], ['BBB', '0000001002', 'NYSE'], ['EEE', '0000001005', 'NYSE American'],
  ]);
  assert.deepEqual([result.matched, result.unmatched, result.companyCount], [3, 3, 3]);
  assert(result.members.every(row => row.listingVerified === true));
});

test('ticker aliases retain original provider keys and stock classes count as one company', () => {
  const directory = parseSecExchangeDirectory(sec([
    [1001, 'Two stock classes', 'TEST-A', 'NYSE'],
    [1001, 'Two stock classes', 'TEST-B', 'NYSE'],
  ]));
  const result = joinSecListings([tick('TEST.A'), tick('TEST-B')], directory);
  assert.deepEqual(result.members.map(row => row.providerSymbol), ['TEST.A.US', 'TEST-B.US']);
  assert.equal(result.matched, 2);
  assert.equal(result.companyCount, 1);
});

test('conflicting SEC identities and duplicate provider aliases stay unverified', () => {
  const directory = parseSecExchangeDirectory(sec([
    [1001, 'First', 'ZZZ.A', 'NYSE'],
    [1002, 'Conflict', 'ZZZ-A', 'OTC'],
    [1003, 'Alias', 'TST-A', 'Nasdaq'],
    [1004, 'Unique', 'GOOD', 'CBOE'],
  ]));
  const result = joinSecListings(['ZZZ.A', 'TST-A', 'TST.A', 'GOOD'].map(tick), directory);
  assert.deepEqual(result.members.map(row => row.symbol), ['GOOD']);
  assert.equal(result.unmatched, 3);
});

test('missing fields or no valid official listings reject the directory', () => {
  assert.throws(() => parseSecExchangeDirectory({fields: ['ticker'], data: [['AAA']]}), /字段/);
  assert.throws(() => parseSecExchangeDirectory(sec([[1001, 'OTC issuer', 'AAA', 'OTC']])), /无可核/);
  assert.throws(() => parseSecExchangeDirectory(sec([null])), /格式/);
});

test('SEC quarterly industry index uses the latest eligible annual or quarterly filing before close', () => {
  const sub = [
    ['adsh', 'cik', 'name', 'sic', 'form', 'period', 'filed', 'accepted'],
    ['0000001001-26-000001', 1001, 'Company', 7389, '10-K', '20251231', '20260212', '2026-02-12 16:30:00.0'],
    ['0000001001-26-000002', 1001, 'Company', 3674, '10-Q', '20260630', '20260813', '2026-08-13 16:00:00.0'],
    ['0000001001-26-000003', 1001, 'Company', 3571, '8-K', '20260820', '20260820', '2026-08-20 16:00:00.0'],
    ['0000001001-26-000004', 1001, 'Company', 3571, '10-Q', '20260930', '20261125', '2026-11-25 08:00:00.0'],
    ['0000001002-26-000001', 1002, 'Future', 3571, '10-Q', '20260930', '20261126', '2026-11-24 16:00:00.0'],
    ['0000001003-26-000001', 1003, 'Unknown SIC', '', '10-Q', '20260630', '20260813', '2026-08-13 16:00:00.0'],
  ].map(row => row.join('\t')).join('\r\n');
  const result = parseSecIndustrySub(sub, '2026-11-25T21:00:00.000Z');
  assert.deepEqual([...result], [['0000001001', {sic: '3674', name: 'Company', periodEnd: '2026-06-30', acceptedDay: '2026-08-13', accession: '0000001001-26-000002'}]]);
  assert.throws(() => parseSecIndustrySub('cik\tsic\n1001\t3571', '2026-11-25'), /字段/);
});

test('expansion preserves prior companies and fills seeded SIC peers before spare slots', () => {
  const stock = (symbol, cik) => ({...tick(symbol), cik: String(cik).padStart(10, '0')});
  const old = stock('OLD', 1), duplicate = stock('OLDB', 1);
  const seedPeers = Array.from({length: 6}, (_, index) => stock('PEER' + index, index + 2));
  const other = Array.from({length: 8}, (_, index) => stock('OTHER' + index, index + 20));
  const members = [...other, duplicate, ...seedPeers, old];
  const industryByCik = new Map([...seedPeers, old].map(member => [member.cik, {sic: '3674'}]));
  for (const member of other) industryByCik.set(member.cik, {sic: '3571'});
  const close = {close: 1, sourceDate: '2026-11-25'};
  const prices = Object.fromEntries(members.map(member => [member.symbol, close]));
  delete prices.OLD;
  prices.PEER0 = {...close, sourceDate: '2026-11-24'};
  prices.PEER4 = {...close, turnover20: 2500000};
  const result = pickExpandingMembers(members, {
    prices, asOf: '2026-11-25', industryByCik, priorRows: [{...old, sic: '3674', status: 'candidate'}],
    cachedCiks: new Set([other[1].cik]), maxNew: 5, maxTotal: 8,
  });
  assert.deepEqual(result.members.map(member => member.symbol), ['OLD', 'OTHER1', 'PEER4', 'PEER1', 'PEER2', 'PEER3', 'PEER5']);
  assert.equal(result.counts.new, 5);
  assert.equal(result.counts.companyCount, 7);
  assert.equal(result.counts.priced, members.length - 2);
  assert.deepEqual(result.members[2].industryEvidence, {sic: '3674'});
});
