export const secExchangeDirectoryUrl = 'https://www.sec.gov/files/company_tickers_exchange.json';

const markets = new Set(['NASDAQ', 'NYSE', 'NYSE AMERICAN', 'NYSE ARCA', 'NYSE NATIONAL', 'CBOE', 'CBOE BZX', 'IEX', 'MEMX', 'LTSE']);

function tickerKey(value) {
  if (typeof value !== 'string') return null;
  const ticker = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/.test(ticker)) return null;
  return ticker.replace('-', '.');
}

/** The SEC list identifies filers and exchanges. Security class and filing evidence are checked separately. */
export function parseSecExchangeDirectory(payload) {
  const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!Array.isArray(value?.fields) || !Array.isArray(value.data) || !value.data.length) {
    throw Error('SEC ticker/exchange 名册缺少字段或记录');
  }
  const [cikAt, nameAt, tickerAt, exchangeAt] = ['cik', 'name', 'ticker', 'exchange'].map(field => value.fields.indexOf(field));
  if ([cikAt, nameAt, tickerAt, exchangeAt].includes(-1) || new Set(value.fields).size !== value.fields.length) {
    throw Error('SEC ticker/exchange 名册字段异常');
  }

  const records = new Map();
  const ambiguous = new Set();
  for (const row of value.data) {
    if (!Array.isArray(row)) throw Error('SEC ticker/exchange 名册记录格式异常');
    const key = tickerKey(row[tickerAt]);
    const cik = String(row[cikAt] ?? '');
    if (!key || !/^\d{1,10}$/.test(cik) || Number(cik) === 0) continue;
    const exchange = typeof row[exchangeAt] === 'string' ? row[exchangeAt].trim() : '';
    const record = {
      cik: cik.padStart(10, '0'), name: String(row[nameAt] || row[tickerAt]), exchange,
      allowed: markets.has(exchange.toUpperCase()),
    };
    const previous = records.get(key);
    if (previous && (previous.cik !== record.cik || (previous.allowed && record.allowed && previous.exchange.toUpperCase() !== exchange.toUpperCase()))) {
      ambiguous.add(key);
    }
    if (!previous || (!previous.allowed && record.allowed)) records.set(key, record);
  }

  const directory = new Map();
  for (const [key, {cik, name, exchange, allowed}] of records) {
    if (allowed && !ambiguous.has(key)) directory.set(key, {cik, name, exchange});
  }
  if (!directory.size) throw Error('SEC ticker/exchange 名册无可核交易所记录');
  return directory;
}

export function joinSecListings(universe, directory) {
  const counts = new Map();
  for (const stock of universe) {
    const key = tickerKey(stock.symbol);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }

  const members = [];
  for (const stock of universe) {
    const key = tickerKey(stock.symbol);
    const record = directory.get(key);
    if (!record || counts.get(key) !== 1) continue;
    members.push({...stock, cik: record.cik, name: record.name, listingExchange: record.exchange, listingVerified: true});
  }
  const companyCount = new Set(members.map(stock => stock.cik)).size;
  return {members, matched: members.length, unmatched: universe.length - members.length, companyCount};
}

const cikKey = value => /^\d{1,10}$/.test(String(value ?? '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const sicKey = value => /^\d{3,4}$/.test(String(value ?? '')) && Number(value) > 0 ? String(value).padStart(4, '0') : null;

function validDay(day) {
  const time = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}

export function parseSecIndustrySub(text, asOf) {
  const closeDay = String(asOf).slice(0, 10);
  if (!validDay(closeDay)) throw Error('SEC行业核验缺少有效收盘日');
  const [header, ...lines] = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const fields = header.split('\t');
  const [cikAt, sicAt, nameAt, formAt, periodAt, accessionAt, acceptedAt, filedAt] =
    ['cik', 'sic', 'name', 'form', 'period', 'adsh', 'accepted', 'filed'].map(field => fields.indexOf(field));
  if ([cikAt, sicAt, nameAt, formAt, periodAt, accessionAt, acceptedAt, filedAt].includes(-1)) {
    throw Error('SEC SUB 行业索引字段异常');
  }

  const industries = new Map();
  const timestamps = new Map();
  for (const line of lines) {
    if (!line) continue;
    const row = line.split('\t');
    const cik = cikKey(row[cikAt]), sic = sicKey(row[sicAt]);
    const accession = row[accessionAt], accepted = row[acceptedAt];
    if (!cik || !sic || !/^10-[KQ](?:\/A)?$/.test(row[formAt]) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const periodEnd = row[periodAt]?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const filedDay = row[filedAt]?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(accepted)) continue;
    const acceptedDay = accepted.slice(0, 10);
    // SEC SUB has no time-zone offset. An accepted same-day filing needs independent timestamps from submissions.
    if (!validDay(acceptedDay) || acceptedDay >= closeDay || !validDay(filedDay) || filedDay > closeDay ||
        !validDay(periodEnd) || periodEnd > filedDay) continue;
    const order = accepted + '|' + accession;
    if (timestamps.has(cik) && timestamps.get(cik) >= order) continue;
    timestamps.set(cik, order);
    industries.set(cik, {sic, name: row[nameAt], acceptedDay, periodEnd, accession});
  }
  return industries;
}

export function pickExpandingMembers(members, {
  prices, asOf, industryByCik, priorRows = [], cachedCiks = new Set(), maxNew = 360, maxTotal = 750,
}) {
  const closeDay = String(asOf).slice(0, 10);
  const priorBySymbol = new Map(priorRows.map(row => [row.symbol, row]));
  const priorCiks = new Set(priorRows.map(row => cikKey(row.cik)));
  const preferredSics = new Set(priorRows.filter(row => row.status === 'candidate' || row.financialPassed).map(row => sicKey(row.sic)));
  const retained = [], groups = new Map(), unclassified = [];
  const counts = {matched: members.length, priced: 0, classified: 0, selected: 0, companyCount: 0, new: 0};
  const turnover = new Map();
  maxNew = Math.min(maxNew, 360);
  maxTotal = Math.min(maxTotal, 750);

  for (const stock of members) {
    const filing = industryByCik.get(stock.cik);
    const previous = priorBySymbol.get(stock.symbol);
    const prior = cikKey(previous?.cik) === stock.cik ? previous : null;
    const sic = filing?.sic || sicKey(prior?.sic);
    const price = prices[stock.symbol] || prices[stock.symbol + '.US'];
    const sameDay = (price?.sourceDate || price?.asOf?.slice(0, 10)) === closeDay;
    const priced = sameDay && Number.isFinite(price.close) && price.close > 0;
    if (priced) counts.priced++;
    if (priced && Number.isFinite(price.turnover20)) turnover.set(stock.symbol, price.turnover20);
    if (sic) counts.classified++;
    const member = {...stock, sic, industryEvidence: filing || null};
    const warm = cachedCiks.has(stock.cik) || priorCiks.has(stock.cik);
    if (prior || (warm && priced)) {
      retained.push({member, prior: Boolean(prior), priced});
    } else if (priced && sic) {
      if (!groups.has(sic)) groups.set(sic, []);
      groups.get(sic).push(member);
    } else if (priced) {
      unclassified.push(member);
    }
  }

  const selected = [], companies = new Set(), selectedBySic = new Map();
  const room = () => counts.new < maxNew && selected.length < maxTotal;
  function include(member, fresh = false) {
    if (companies.has(member.cik) || selected.length >= maxTotal) return;
    companies.add(member.cik);
    selected.push(member);
    if (member.sic) selectedBySic.set(member.sic, (selectedBySic.get(member.sic) || 0) + 1);
    if (fresh) counts.new++;
  }
  const liquidityOrder = (a, b) => (turnover.get(b.symbol) || 0) - (turnover.get(a.symbol) || 0) || a.symbol.localeCompare(b.symbol);
  retained.sort((a, b) => Number(b.prior) - Number(a.prior) || Number(b.priced) - Number(a.priced) || liquidityOrder(a.member, b.member));
  for (const {member} of retained) include(member);

  const queues = [...groups].map(([sic, stocks]) => {
    const unique = new Map();
    for (const stock of stocks.sort(liquidityOrder)) {
      if (!companies.has(stock.cik) && !unique.has(stock.cik)) unique.set(stock.cik, stock);
    }
    return {sic, stocks: [...unique.values()]};
  });
  const enough = group => group.stocks.length + (selectedBySic.get(group.sic) || 0) >= 6;
  queues.sort((a, b) => Number(preferredSics.has(b.sic) && enough(b)) - Number(preferredSics.has(a.sic) && enough(a)) ||
    Number(enough(b)) - Number(enough(a)) || b.stocks.length - a.stocks.length || a.sic.localeCompare(b.sic));

  // Oversample viable groups because some companies will fail the unchanged five-peer financial check.
  for (const group of queues) {
    if (!room()) break;
    const count = selectedBySic.get(group.sic) || 0;
    const take = Math.min(12 - count, group.stocks.length, maxNew - counts.new, maxTotal - selected.length);
    if (take <= 0 || count + take < 6) continue;
    for (let index = 0; index < take; index++) include(group.stocks.shift(), true);
  }
  let remaining = queues.filter(group => group.stocks.length);
  while (room() && remaining.length) {
    for (const group of remaining) {
      if (!room()) break;
      include(group.stocks.shift(), true);
    }
    remaining = remaining.filter(group => group.stocks.length);
  }
  for (const member of unclassified.sort(liquidityOrder)) {
    if (!room()) break;
    include(member, true);
  }

  counts.selected = selected.length;
  counts.companyCount = companies.size;
  return {members: selected, counts};
}
