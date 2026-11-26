import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSectorValue, observeSectorPrice, sectorBenchmark} from '../server/us-sector-value.mjs';

const asOf = '2026-11-25';
const sourceTime = asOf + 'T21:00:00.000Z';
const source = {
  id: 'test-provider', name: 'Test provider', sourceTime, dataAsOf: asOf,
  permissionsVerified: true, derivedPublic: true,
};
const dates = Array.from({length: 61}, (_, index) => new Date(Date.parse(asOf) - (60 - index) * 86400000).toISOString().slice(0, 10));
const reference = dates.map(date => ({date, close: 100}));
const benchmark = sectorBenchmark(reference, asOf);
const weakPrice = observeSectorPrice(dates.map((date, index) => ({date, close: 100 - index / 4})), benchmark);
const strongPrice = observeSectorPrice(reference, benchmark);

function row(index, overrides = {}) {
  return {
    symbol: 'TEST' + index, cik: String(index).padStart(10, '0'), sic: '3674', sicDescription: 'Semiconductors',
    industry: 'Information Technology', status: index === 1 ? 'candidate' : 'excluded', financialPassed: true,
    valuationStatus: index === 1 ? 'low_multiple' : 'not_low', asOf: '2026-09-30',
    sourceTime: '2026-10-30T22:00:00Z', sourceTimePrecision: 'timestamp',
    operatingCycle: {periodEnd: '2026-09-30', basis: 'fiscal_ytd', revenueGrowthPct: -9, profitGrowthPct: -12},
    valuationBasis: {priceAsOf: sourceTime, priceSource: source.id, financialPeriod: '2026-09-30'},
    metrics: {currency: 'USD', normalizedPe: index === 1 ? 10 : 20, normalizedFcfYield: index === 1 ? 8 : 4},
    ...overrides,
  };
}

function evaluate(rows, priceObservations = new Map(rows.map(stock => [stock.symbol, weakPrice])), overrides = {}) {
  return evaluateSectorValue({scope: {name: 'Reference pool', stale: false}, parameters: {maxReportAgeDays: 200}, rows}, {
    priceObservations, benchmark, asOf, source, ...overrides,
  });
}

test('sector price observations align 61 consecutive reference sessions and never fill gaps', () => {
  assert.equal(weakPrice.belowMa50, true);
  assert(Math.abs(weakPrice.return60Pct + 15) < 1e-10);
  assert.equal(observeSectorPrice(reference.slice(1), benchmark), null);
  const wrongDay = reference.map((bar, index) => index === 2 ? {...bar, date: dates[1]} : bar);
  assert.equal(observeSectorPrice(wrongDay, benchmark), null);
  assert.equal(sectorBenchmark(wrongDay, asOf), null);
  assert.equal(sectorBenchmark(reference, '2026-11-27'), null);
});

test('trough and relative discounts both require source-backed evidence and count companies once', () => {
  const comparable = [1, 2, 3, 4, 5, 6].map(index => row(index));
  const duplicate = {...comparable[1], symbol: 'SECONDCLASS'};
  const unrelated = row(7, {sic: '3571', metrics: {currency: 'USD', normalizedPe: 1000, normalizedFcfYield: 0.01}});
  const result = evaluate([...comparable, duplicate, unrelated]);
  const sector = result.sectors.groups.find(group => group.name === 'Semiconductors');
  assert.equal(result.sectors.status, 'ready');
  assert.equal(sector.state, 'trough');
  assert.equal(sector.members, 6);
  assert.equal(sector.financialSamples, 6);
  assert.deepEqual(sector.financialPeriodRange, {first: '2026-09-30', last: '2026-09-30'});
  assert.equal(sector.candidates, 1);
  assert.deepEqual(result.sectors.candidateCounts, {confirmedRelative: 1, troughOpportunities: 1});
  const item = result.rows[0].sectorValue;
  assert.equal(item.peerCount, 5);
  assert.equal(item.peerMedianPe, 20);
  assert.equal(item.peerMedianPriceToFcf, 25);
  assert.equal(item.peDiscountPct, 50);
  assert.equal(item.fcfMultipleDiscountPct, 50);
  assert.equal(item.opportunity, true);
  assert.equal(result.rows[5].status, 'excluded');
});

test('future filings, stale prices and other industries cannot supply missing peer observations', () => {
  const stocks = [1, 2, 3, 4, 5, 6, 7].map(index => row(index));
  stocks[4].sourceTime = '2026-11-25T22:00:00Z';
  stocks[5].valuationBasis.priceAsOf = '2026-11-24T21:00:00Z';
  stocks[6].sic = '3571';
  const result = evaluate(stocks);
  assert.equal(result.rows[0].sectorValue.state, 'insufficient_peers');
  assert.equal(result.rows[0].sectorValue.peerCount, 3);
  assert.equal(result.sectors.groups.find(group => group.name === 'Semiconductors').financialSamples, 5);
  assert.equal(result.rows[0].status, 'candidate');
  assert.equal(result.rows[0].sectorValue.opportunity, false);
});

test('relative undervaluation remains separate from a low sector, and price permission is enforced', () => {
  const stocks = [1, 2, 3, 4, 5, 6].map(index => row(index));
  const price = new Map(stocks.map(stock => [stock.symbol, strongPrice]));
  const relativeOnly = evaluate(stocks, price);
  assert.equal(relativeOnly.sectors.groups[0].state, 'weak_business');
  assert.equal(relativeOnly.rows[0].sectorValue.state, 'confirmed_relative');
  assert.equal(relativeOnly.rows[0].sectorValue.opportunity, false);

  stocks[0].metrics.normalizedFcfYield = 4.5;
  const oneRatio = evaluate(stocks, price);
  assert.equal(oneRatio.rows[0].sectorValue.state, 'peer_discount_not_met');
  assert.equal(oneRatio.sectors.candidateCounts.confirmedRelative, 0);

  const blocked = evaluate(stocks, price, {source: {...source, derivedPublic: false}});
  assert.equal(blocked.sectors.status, 'pending');
  assert.equal(blocked.sectors.groups.length, 0);
  assert.equal(blocked.rows[0].sectorValue, undefined);
});

test('precise SEC subindustries split a broad industry and keep missing filings in the coverage denominator', () => {
  const stocks = Array.from({length: 9}, (_, index) => row(index + 1, {
    sic: '3571', sicDescription: 'Electronic Computers', operatingCycle: index < 5 ? row(index + 1).operatingCycle : null,
  }));
  stocks.push(row(10), row(11, {sic: null}));
  const result = evaluate(stocks);
  const computers = result.sectors.groups.find(group => group.classificationCode === '3571');
  assert.equal(computers.name, 'Electronic Computers · SIC 3571');
  assert.equal(computers.members, 9);
  assert.equal(computers.priceSamples, 9);
  assert.equal(computers.financialSamples, 5);
  assert.equal(computers.state, 'pending');
  assert.equal(result.sectors.groups.find(group => group.classificationCode === '3674').members, 1);
  assert.equal(result.sectors.unclassifiedCompanyCount, 1);
});

test('miscellaneous business services cannot establish industry troughs or comparable valuation', () => {
  const stocks = [1, 2, 3, 4, 5, 6].map(index => row(index, {
    sic: '7389', sicDescription: 'Services-Business Services, NEC',
  }));
  const result = evaluate(stocks);
  const group = result.sectors.groups[0];
  assert.equal(group.members, 6);
  assert.equal(group.financialSamples, 6);
  assert.equal(group.state, 'pending');
  assert.equal(group.classificationVerified, false);
  assert.match(group.reasons[0], /缺主营业务证据/);
  assert.equal(result.rows[0].sectorValue.peerGroup.memberCompanies, 6);
  assert.equal(result.rows[0].sectorValue.state, 'insufficient_peers');
  assert.equal(result.rows[0].sectorValue.peerCount, 0);
  assert.equal(result.rows[0].sectorValue.peerMedianPe, null);
  assert.equal(result.rows[0].status, 'candidate');
  assert.deepEqual(result.sectors.candidateCounts, {confirmedRelative: 0, troughOpportunities: 0});
});
