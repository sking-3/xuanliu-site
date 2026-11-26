const thresholds = Object.freeze({
  minMembers: 5,
  minCoveragePct: 60,
  maxReturn60Pct: 0,
  maxExcess60Pp: -5,
  minBelowMa50Pct: 60,
  minDecliningPct: 60,
  minPeers: 5,
  minDiscountPct: 25,
});

const finite = Number.isFinite;
const positive = value => finite(value) && value > 0;
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && finite(Date.parse(value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function sectorBenchmark(bars, asOf) {
  const window = bars.slice(-61);
  if (window.length !== 61 || window.at(-1).date !== asOf) return null;
  if (!window.every((bar, index) => positive(bar.close) && (!index || bar.date > window[index - 1].date))) return null;
  return {
    asOf,
    dates: window.map(bar => bar.date),
    return60Pct: (window.at(-1).close / window[0].close - 1) * 100,
  };
}

export function observeSectorPrice(bars, benchmark) {
  if (!benchmark) return null;
  const window = bars.slice(-61);
  if (window.length !== 61 || !window.every((bar, index) => bar.date === benchmark.dates[index] && positive(bar.close))) return null;
  const close = window.at(-1).close;
  return {
    asOf: benchmark.asOf,
    return60Pct: (close / window[0].close - 1) * 100,
    belowMa50: close < mean(window.slice(-50).map(bar => bar.close)),
  };
}

const companyKey = row => row.cik || row.symbol;

function companySamples(rows, readSample) {
  const samples = new Map();
  for (const row of rows) {
    const sample = readSample(row);
    const key = companyKey(row);
    if (sample && !samples.has(key)) samples.set(key, sample);
  }
  return [...samples.values()];
}

function hasCurrentFiling(row, asOf, closeTime) {
  if (!row.cik || row.stale || !row.sourceTime || !validDay(row.asOf) || row.asOf > asOf) return false;
  if (row.sourceTimePrecision === 'day') return validDay(row.sourceTime) && row.sourceTime < asOf;
  return row.sourceTimePrecision === 'timestamp' && Date.parse(row.sourceTime) <= Date.parse(closeTime);
}

function operatingEvidence(row, context) {
  const cycle = row.operatingCycle;
  if (!hasCurrentFiling(row, context.asOf, context.closeTime) || cycle?.periodEnd !== row.asOf) return null;
  if (!['fiscal_ytd', 'fiscal_year'].includes(cycle.basis)) return null;
  if (Date.parse(context.asOf) - Date.parse(cycle.periodEnd) > context.maxReportAgeDays * 86400000) return null;
  if (![cycle.revenueGrowthPct, cycle.profitGrowthPct].every(finite)) return null;
  return {...cycle, sourceTime: row.sourceTime, readAt: row.readAt};
}

function estimateGroup(name, rows, context) {
  const members = new Set(rows.map(companyKey)).size;
  const prices = companySamples(rows, row => {
    const price = context.priceObservations.get(row.symbol);
    return price?.asOf === context.asOf && finite(price.return60Pct) && typeof price.belowMa50 === 'boolean' ? price : null;
  });
  const financials = companySamples(rows, row => operatingEvidence(row, context));
  const priceSamples = prices.length;
  const financialSamples = financials.length;
  const return60Pct = priceSamples ? mean(prices.map(price => price.return60Pct)) : null;
  const excess60Pp = priceSamples ? return60Pct - context.benchmark.return60Pct : null;
  const belowMa50Pct = priceSamples ? 100 * prices.filter(price => price.belowMa50).length / priceSamples : null;
  const revenueGrowthMedianPct = financialSamples ? median(financials.map(cycle => cycle.revenueGrowthPct)) : null;
  const profitGrowthMedianPct = financialSamples ? median(financials.map(cycle => cycle.profitGrowthPct)) : null;
  const decliningRevenuePct = financialSamples ? 100 * financials.filter(cycle => cycle.revenueGrowthPct < 0).length / financialSamples : null;
  const decliningProfitPct = financialSamples ? 100 * financials.filter(cycle => cycle.profitGrowthPct < 0).length / financialSamples : null;
  const periods = financials.map(cycle => cycle.periodEnd).sort();
  const sourceTimes = financials.map(cycle => cycle.sourceTime).sort();
  const readTimes = financials.map(cycle => cycle.readAt).filter(Boolean).sort();
  const basisCounts = {
    fiscalYear: financials.filter(cycle => cycle.basis === 'fiscal_year').length,
    fiscalYtd: financials.filter(cycle => cycle.basis === 'fiscal_ytd').length,
  };

  const enough = count => count >= thresholds.minMembers && 100 * count / members >= thresholds.minCoveragePct;
  const priceReady = enough(priceSamples);
  const businessReady = enough(financialSamples);
  const priceWeak = priceReady && return60Pct <= thresholds.maxReturn60Pct &&
    excess60Pp <= thresholds.maxExcess60Pp && belowMa50Pct >= thresholds.minBelowMa50Pct;
  const businessWeak = businessReady && decliningRevenuePct >= thresholds.minDecliningPct && decliningProfitPct >= thresholds.minDecliningPct;
  const reasons = [];
  if (members < thresholds.minMembers) reasons.push('参考池公司的数量未达到最低样本数');
  if (!priceReady) reasons.push('同批收盘价覆盖不足');
  else if (!priceWeak) reasons.push('60日价格涨跌、相对SPY表现或低于50日均线的比例未达低谷条件');
  if (!businessReady) reasons.push('最近已公开、同期间的营收和净利同比覆盖不足');
  else if (!businessWeak) reasons.push('营收同比下降与净利同比下降的比例未同时达到门槛');

  let state = 'pending';
  if (priceReady && businessReady) {
    if (priceWeak && businessWeak) state = 'trough';
    else if (priceWeak) state = 'weak_price';
    else if (businessWeak) state = 'weak_business';
    else state = 'not_trough';
  }
  return {
    name, state, members, priceSamples, financialSamples, return60Pct, excess60Pp, belowMa50Pct,
    revenueGrowthMedianPct, profitGrowthMedianPct, decliningRevenuePct, decliningProfitPct,
    financialPeriodRange: periods.length ? {first: periods[0], last: periods.at(-1)} : null,
    financialSourceTimeRange: sourceTimes.length ? {first: sourceTimes[0], last: sourceTimes.at(-1)} : null,
    financialReadAtRange: readTimes.length ? {first: readTimes[0], last: readTimes.at(-1)} : null,
    financialBasisCounts: basisCounts, reasons, candidates: 0,
  };
}

function valuationMetrics(row, context) {
  const {normalizedPe, normalizedFcfYield} = row.metrics || {};
  const basis = row.valuationBasis;
  if (!row.financialPassed || !hasCurrentFiling(row, context.asOf, context.closeTime) || !/^[0-9]{4}$/.test(row.sic || '')) return null;
  if (Date.parse(context.asOf) - Date.parse(row.asOf) > context.maxReportAgeDays * 86400000) return null;
  if (!positive(normalizedPe) || !positive(normalizedFcfYield) || basis?.financialPeriod !== row.asOf) return null;
  if (Date.parse(basis.priceAsOf) !== Date.parse(context.closeTime) || basis.priceSource !== context.sourceId || row.metrics.currency !== 'USD') return null;
  return {symbol: row.symbol, pe: normalizedPe, priceToFcf: 100 / normalizedFcfYield};
}

function compareStock(row, sector, rows, context) {
  const result = {
    state: 'not_candidate', sector: sector?.name ?? null, sectorState: sector?.state ?? 'pending',
    sectorTrough: sector?.state === 'trough', opportunity: false,
    peerGroup: row.sic ? {code: row.sic, name: row.sicDescription || row.sic} : null,
    peerCount: 0, peerSymbols: [], peerMedianPe: null, peerMedianPriceToFcf: null,
    peDiscountPct: null, fcfMultipleDiscountPct: null, reasons: [],
  };
  if (row.status !== 'candidate' || row.valuationStatus !== 'low_multiple') return result;
  const stock = valuationMetrics(row, context);
  if (!stock) {
    result.state = 'low_multiple';
    result.reasons.push('低倍数条件已过，缺同批估值或SEC行业分类证据');
    return result;
  }
  const peers = companySamples(rows.filter(peer => peer.sic === row.sic && companyKey(peer) !== companyKey(row)), peer => valuationMetrics(peer, context));
  result.peerCount = peers.length;
  result.peerSymbols = peers.map(peer => peer.symbol);
  if (peers.length < thresholds.minPeers) {
    result.state = 'insufficient_peers';
    result.reasons.push('同SEC行业且财报、估值口径齐备的独立公司不足');
    return result;
  }
  result.peerMedianPe = median(peers.map(peer => peer.pe));
  result.peerMedianPriceToFcf = median(peers.map(peer => peer.priceToFcf));
  result.peDiscountPct = 100 * (1 - stock.pe / result.peerMedianPe);
  result.fcfMultipleDiscountPct = 100 * (1 - stock.priceToFcf / result.peerMedianPriceToFcf);
  if (result.peDiscountPct < thresholds.minDiscountPct || result.fcfMultipleDiscountPct < thresholds.minDiscountPct) {
    result.state = 'peer_discount_not_met';
    result.reasons.push('中周期市盈率与市值／自由现金流未同时达到同业折价门槛');
    return result;
  }
  result.state = 'confirmed_relative';
  result.opportunity = result.sectorTrough;
  return result;
}

export function evaluateSectorValue(fundamentals, {priceObservations, benchmark, asOf, source}) {
  const rows = fundamentals.rows;
  const scope = fundamentals.scope;
  const sectors = {
    status: 'pending', asOf, sourceTime: source.sourceTime, benchmark: 'SPY', benchmarkReturn60Pct: null,
    source: {
      price: {name: source.name, url: source.documentation, asOf: source.sourceTime, readAt: source.fetchedAt},
      financial: {name: 'SEC EDGAR', url: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces', readAt: fundamentals.lastAttemptAt},
      universe: {name: scope?.name, url: scope?.source, asOf: scope?.asOf},
    },
    thresholds, groups: [], candidateCounts: {confirmedRelative: 0, troughOpportunities: 0},
  };
  if (!scope || scope.stale || !rows.length || source.permissionsVerified !== true || source.derivedPublic !== true ||
      source.dataAsOf !== asOf || benchmark?.asOf !== asOf || !source.sourceTime?.startsWith(asOf + 'T') || !finite(Date.parse(source.sourceTime))) {
    sectors.reason = '缺少新鲜名册、同日基准或获准公开的行情批次，暂不认定行业低谷或同业折价';
    return {...fundamentals, sectors};
  }

  const context = {
    priceObservations, benchmark, asOf, closeTime: source.sourceTime, sourceId: source.id,
    maxReportAgeDays: fundamentals.parameters?.maxReportAgeDays,
  };
  const semiconductorRows = rows.filter(row => row.sic === '3674');
  const separateSemiconductors = new Set(semiconductorRows.map(companyKey)).size >= thresholds.minMembers;
  const groupName = row => separateSemiconductors && row.sic === '3674' ? 'Semiconductors' : row.industry;
  const byGroup = new Map();
  for (const row of rows) {
    const name = groupName(row);
    if (!name) continue;
    if (!byGroup.has(name)) byGroup.set(name, []);
    byGroup.get(name).push(row);
  }
  const groups = new Map([...byGroup].sort(([a], [b]) => a.localeCompare(b)).map(([name, members]) => {
    const group = estimateGroup(name, members, context);
    const classification = name === 'Semiconductors' && separateSemiconductors ? 'SEC SIC 3674' : 'OEF与现有行业参考池';
    return [name, {...group, classification}];
  }));
  const opportunities = new Map();
  const confirmed = new Set();
  const evaluated = rows.map(row => {
    const group = groups.get(groupName(row));
    const sectorValue = compareStock(row, group, rows, context);
    if (sectorValue.state === 'confirmed_relative') confirmed.add(companyKey(row));
    if (sectorValue.opportunity) {
      if (!opportunities.has(group.name)) opportunities.set(group.name, new Set());
      opportunities.get(group.name).add(companyKey(row));
    }
    return {...row, sectorValue};
  });
  for (const [name, companies] of opportunities) groups.get(name).candidates = companies.size;
  sectors.status = groups.size ? 'ready' : 'pending';
  sectors.groups = [...groups.values()];
  sectors.benchmarkReturn60Pct = benchmark.return60Pct;
  sectors.candidateCounts.confirmedRelative = confirmed.size;
  sectors.candidateCounts.troughOpportunities = new Set([...opportunities.values()].flatMap(companies => [...companies])).size;
  return {...fundamentals, sectors, rows: evaluated};
}
