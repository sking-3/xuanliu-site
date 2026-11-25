// Consumes external TradingView evidence. It never creates a native reference.
import {readFile, stat} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {evaluateIndicator as evaluateCore} from './viprasol-core.mjs';

export const SOURCE_COMMIT = 'a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0';
export const TYSON_FIELDS = Object.freeze([
  {key: 'compHigh', column: 'audit.comp_high', kind: 'number'},
  {key: 'compLow', column: 'audit.comp_low', kind: 'number'},
  {key: 'signalLong', column: 'audit.signal_long', kind: 'boolean'},
  {key: 'entry', column: 'audit.entry', kind: 'number'},
  {key: 'stop', column: 'audit.stop', kind: 'number'},
  {key: 'target', column: 'audit.target', kind: 'number'},
]);
const BINDINGS = ['indicatorId', 'sourceCommit', 'sourceFile', 'symbol', 'timeframe', 'chartType',
  'session', 'chartTimezone', 'exchangeTimezone', 'adjustment', 'priceCurrency', 'volumeUnit', 'seedTimeMs', 'seedBarIndex',
  'lastConfirmedCloseTimeMs', 'mintick'];
const INPUTS = ['compLen', 'compFrac', 'maxCompATR', 'expMult', 'atrLen', 'rr', 'slBuf', 'sigGap', 'oneAtATime'];
const CAPTURE_ROLES = ['chart', 'inputs', 'pine-source', 'csv-export'];
const ABS_TOLERANCE = 1e-9, REL_TOLERANCE = 1e-10;
const TRACE_FIELDS = [
  {key: 'atr', column: 'audit.atr', kind: 'number'},
  {key: 'wideRange', column: 'audit.wide_range', kind: 'number'},
  ...['compressed', 'release', 'blocked', 'cooldownAllowed'].map(key => ({key, column: 'audit.' + key, kind: 'boolean'})),
  ...['activeBefore', 'activeAfter', 'lastSig', 'lastSigBefore'].map(key => ({key, column: 'audit.' + key, kind: 'integer'})),
];
const LOG_COLUMNS = ['audit.time_ms', 'audit.close_time_ms', 'audit.seed_time_ms', 'audit.bar_index',
  'audit.open', 'audit.high', 'audit.low', 'audit.close', 'audit.volume',
  'audit.comp_high', 'audit.comp_low', 'audit.signal_long', 'audit.entry', 'audit.stop', 'audit.target',
  'audit.atr', 'audit.wide_range', 'audit.compressed', 'audit.release', 'audit.blocked',
  'audit.activeBefore', 'audit.activeAfter', 'audit.lastSig', 'audit.lastSigBefore', 'audit.cooldownAllowed'];

export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw Error('CSV is empty');
  const rows = [], row = [];
  let field = '', quoted = false, closedQuote = false;
  text = text.replace(/^\uFEFF/, '');
  const finishField = () => { row.push(field); field = ''; closedQuote = false; };
  const finishRow = () => { finishField(); rows.push(row.splice(0)); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closedQuote = true; }
    } else if (char === '"') {
      if (field || closedQuote) throw Error('Unexpected CSV quote');
      quoted = true;
    } else if (char === ',') finishField();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRow();
    } else {
      if (closedQuote) throw Error('Text after closing CSV quote');
      field += char;
    }
  }
  if (quoted) throw Error('Unterminated CSV quote');
  if (field || row.length || closedQuote) finishRow();
  while (rows.at(-1)?.length === 1 && rows.at(-1)[0] === '') rows.pop();
  const headers = rows.shift()?.map(value => value.trim());
  if (!headers?.length || headers.some(value => !value) || new Set(headers).size !== headers.length) throw Error('CSV headers are empty or duplicated');
  if (!rows.length) throw Error('CSV has no data rows');
  if (rows.some(values => values.length !== headers.length)) throw Error('CSV row width differs from header');
  return {headers, rows: rows.map(values => Object.fromEntries(headers.map((header, i) => [header, values[i]])))};
}

function numberCell(value, column, row) {
  const text = value?.trim();
  if (text === '' || text === 'NaN' || text === 'na') return null;
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) throw Error(`Invalid numeric CSV cell ${column}, row ${row + 2}`);
  return Number(text);
}

function equalParameters(left, right) {
  return left && right && Object.keys(left).length === INPUTS.length && Object.keys(right).length === INPUTS.length
    && INPUTS.every(key => Object.hasOwn(left, key) && Object.hasOwn(right, key) && left[key] === right[key]);
}

function logPairs(text) {
  const values = {};
  for (const field of text.split('|')) {
    const at = field.indexOf('=');
    const key = field.slice(0, at), value = field.slice(at + 1);
    if (at <= 0 || !value && key !== 'base_currency' || Object.hasOwn(values, key)) throw Error('Invalid or repeated Pine Logs metadata');
    values[key] = value;
  }
  return values;
}

// Preserve the original .txt or official Date/Message Logs CSV. Neither is chart CSV.
export function parsePineLogs(text) {
  if (typeof text !== 'string' || !text.trim()) throw Error('Raw Pine Logs are missing');
  let lines = text.replace(/^\uFEFF/, '').split(/\r?\n/), containerType = 'pine-logs-text';
  if (/消息|Message/.test(lines[0])) {
    const container = parseCsv(text);
    const [date, message] = container.headers;
    if (container.headers.length !== 2 || !['日期,消息', 'Date,Message'].includes(container.headers.join(','))) throw Error('Unsupported Pine Logs CSV container; expected Date/Message columns');
    if (container.rows.some(row => !Number.isFinite(Date.parse(row[date])) || !row[message])) throw Error('Pine Logs CSV has invalid dates or empty messages');
    lines = container.rows.map(row => row[message]);
    containerType = 'pine-logs-csv';
  }
  let meta = null, inputs = null, end = null;
  const rows = [];
  for (const line of lines) {
    const at = line.indexOf('AUDIT_');
    if (at < 0) continue;
    const entry = line.slice(at).trim();
    if ((entry.match(/AUDIT_/g) || []).length !== 1) throw Error('Mixed Pine log messages on one line');
    if (entry.startsWith('AUDIT_META|')) {
      if (meta || inputs || rows.length || end) throw Error('Multiple or mixed Pine Logs runs');
      meta = logPairs(entry.slice(11));
    } else if (entry.startsWith('AUDIT_INPUTS|')) {
      if (!meta || inputs || rows.length || end) throw Error('Missing or repeated Pine Logs input header');
      inputs = logPairs(entry.slice(13));
    } else if (entry.startsWith('AUDIT_ROW|')) {
      if (!meta || !inputs || end) throw Error('Pine Logs row is outside its captured run');
      const values = entry.slice(10).split(',');
      if (values.length !== LOG_COLUMNS.length) throw Error('Pine Logs row has missing/truncated trace fields');
      rows.push(Object.fromEntries(LOG_COLUMNS.map((column, i) => [column, values[i]])));
    } else if (entry.startsWith('AUDIT_END|')) {
      if (!meta || !inputs || !rows.length || end) throw Error('Invalid Pine Logs END marker');
      end = logPairs(entry.slice(10));
    } else throw Error('Unrecognized audit log record');
  }
  if (!meta || !inputs || !rows.length || !end) throw Error('Pine Logs are incomplete: META, INPUTS, full rows and END are required');
  if (meta.format !== 'tyson-native-log-v2') throw Error('Unsupported Pine Logs trace format');
  for (const key of ['source', 'indicator', 'symbol', 'timeframe', 'exchange_timezone', 'session', 'seed_ms', 'seed_index', 'mintick', 'interval_seconds', 'price_currency', 'base_currency', 'volume_type']) {
    if (!Object.hasOwn(meta, key) || !meta[key] && key !== 'base_currency') throw Error('Pine Logs metadata missing: ' + key);
  }
  if (Object.keys(inputs).length !== INPUTS.length || INPUTS.some(key => !Object.hasOwn(inputs, key))) throw Error('Pine Logs inputs are incomplete');
  const parameters = Object.fromEntries(INPUTS.map(key => [key, key === 'oneAtATime'
    ? inputs[key] === 'true' ? true : inputs[key] === 'false' ? false : null
    : numberCell(inputs[key], 'input.' + key, 0)]));
  if (parameters.oneAtATime === null) throw Error('Invalid native boolean input');
  const seed = numberCell(meta.seed_ms, 'seed_ms', 0), seedIndex = numberCell(meta.seed_index, 'seed_index', 0);
  const firstTime = numberCell(rows[0]['audit.time_ms'], 'time_ms', 0);
  const lastTime = numberCell(rows.at(-1)['audit.time_ms'], 'time_ms', rows.length - 1);
  const lastClose = numberCell(rows.at(-1)['audit.close_time_ms'], 'close_time_ms', rows.length - 1);
  const lastIndex = numberCell(rows.at(-1)['audit.bar_index'], 'bar_index', rows.length - 1);
  if (firstTime !== seed || numberCell(rows[0]['audit.bar_index'], 'bar_index', 0) !== seedIndex) throw Error('Pine Logs do not start at the full calculation seed');
  if (numberCell(end.seed_ms, 'END.seed_ms', 0) !== seed || numberCell(end.seed_index, 'END.seed_index', 0) !== seedIndex
    || numberCell(end.time_ms, 'END.time_ms', 0) !== lastTime || numberCell(end.close_time_ms, 'END.close_time_ms', 0) !== lastClose
    || numberCell(end.bar_index, 'END.bar_index', 0) !== lastIndex || numberCell(end.row_count, 'END.row_count', 0) !== rows.length
    || rows.length !== lastIndex - seedIndex + 1) throw Error('Pine Logs END/count does not cover the complete captured history');
  for (const row of rows) {
    row['audit.confirmed'] = '1'; // AUDIT_ROW is emitted inside barstate.isconfirmed.
    row['audit.mintick'] = meta.mintick;
    row['audit.interval_seconds'] = meta.interval_seconds;
    for (const key of INPUTS) row['audit.input.' + key] = String(Number(parameters[key]));
  }
  return {meta, parameters, end, containerType, headers: Object.keys(rows[0]), rows};
}

function sharedLogCandidate(parsed, binding) {
  const bars = parsed.rows.map((row, i) => Object.fromEntries([
    ['time', numberCell(row['audit.time_ms'], 'time', i)], ['closeTime', numberCell(row['audit.close_time_ms'], 'closeTime', i)],
    ...['open', 'high', 'low', 'close', 'volume'].map(key => [key, numberCell(row['audit.' + key], key, i)]),
  ]));
  const result = evaluateCore('tyson', bars, parsed.parameters, {auditTrace: true});
  const series = Object.fromEntries([...TYSON_FIELDS, ...TRACE_FIELDS].map(field => [field.key, result.auditTrace.map(row => row[field.key])]));
  const meta = parsed.meta;
  const volumeUnit = meta.volume_type === 'base' ? meta.base_currency : meta.volume_type === 'quote' ? meta.price_currency
    : meta.volume_type === 'tick' ? 'ticks' : meta.volume_type === 'n/a' ? 'native units unspecified' : null;
  return {schemaVersion: 1, binding: {...binding, indicatorId: meta.indicator, sourceCommit: meta.source, symbol: meta.symbol,
    timeframe: meta.timeframe === 'D' ? '1D' : meta.timeframe, session: meta.session, exchangeTimezone: meta.exchange_timezone,
    seedTimeMs: Number(meta.seed_ms), seedBarIndex: Number(meta.seed_index), lastConfirmedCloseTimeMs: Number(parsed.end.close_time_ms),
    mintick: Number(meta.mintick), priceCurrency: meta.price_currency, volumeUnit, parameters: parsed.parameters},
  inputSource: {kind: 'tradingview-shared-input', name: 'Captured TradingView Pine Logs raw OHLCV', url: 'https://www.tradingview.com/chart/'}, bars, series};
}

export function compareNativeEvidence({csv, logs, manifest, candidate, evidenceFiles = []}) {
  const report = {schemaVersion: 1, status: 'not_verified', nativeVerified: false, eligibleForSelection: false,
    numericalMatch: false, comparedBars: 0, ignoredUnconfirmedBars: 0, divergenceCount: 0,
    firstDivergence: null, maxError: {}, reasons: [], tolerance: {absolute: ABS_TOLERANCE, relative: REL_TOLERANCE}};
  const reject = reason => { report.reasons.push(reason); return report; };
  const logMode = ['tradingview-pine-logs', 'synthetic-pine-logs'].includes(manifest?.evidenceKind);
  let parsed;
  if (logMode) {
    if (csv) return reject('Pass raw text or official Logs CSV through logs; chart CSV input mode is not Pine Logs');
    if (candidate) return reject('Pine Logs candidates must be recomputed by existing JS from shared raw OHLCV');
    try {
      parsed = parsePineLogs(logs);
      report.candidateComputation = 'existing-js-core-on-shared-raw-input';
      candidate = sharedLogCandidate(parsed, manifest.binding || {});
    } catch (error) { return reject(error.message); }
    report.referenceType = 'pine-logs';
    report.containerType = parsed.containerType;
    report.sharedInput = candidate.inputSource?.kind === 'tradingview-shared-input';
  } else {
    if (!csv) return reject('Native CSV is missing; no native parity evidence exists');
    try { parsed = parseCsv(csv); } catch (error) { return reject(error.message); }
    report.referenceType = 'chart-csv';
  }
  if (manifest?.schemaVersion !== 1 || candidate?.schemaVersion !== 1) return reject('Manifest/candidate schemaVersion must be 1');
  const native = ['tradingview-native-csv', 'tradingview-pine-logs'].includes(manifest.evidenceKind);
  if (!native) report.reasons.push('Synthetic or unspecified evidence is not TradingView verification');
  const binding = manifest.binding, expected = candidate.binding;
  if (!binding || !expected) return reject('Missing capture/input binding');
  for (const key of BINDINGS) {
    if (binding[key] === undefined || binding[key] === null || binding[key] === '' || binding[key] !== expected[key]) return reject(`Binding mismatch: ${key}`);
  }
  if (binding.indicatorId !== 'tyson' || binding.sourceCommit !== SOURCE_COMMIT
    || binding.sourceFile !== 'indicators/tyson-uppercut-compression-spring-breakout.pine') return reject('Unsupported or unpinned source; this pilot covers Tyson only');
  if (binding.timeframe !== '1D' || binding.chartType !== 'candles') return reject('Pilot requires standard 1D candles');
  if (!equalParameters(binding.parameters, expected.parameters)) return reject('Computational input parameters differ or are incomplete');
  if (typeof binding.parameters.oneAtATime !== 'boolean' || INPUTS.filter(key => key !== 'oneAtATime').some(key => !Number.isFinite(binding.parameters[key]))) return reject('Invalid computational input types');
  if (!['official', ...(logMode ? ['tradingview-shared-input'] : [])].includes(candidate.inputSource?.kind)
    || !candidate.inputSource.name || !candidate.inputSource.url) return reject('Official or captured shared input provenance is missing');
  if (!Array.isArray(candidate.bars) || !candidate.bars.length) return reject('Input bars are missing');
  const fields = logMode ? [...TYSON_FIELDS, ...TRACE_FIELDS] : TYSON_FIELDS;
  if (!candidate.series || fields.some(field => !Array.isArray(candidate.series[field.key]) || candidate.series[field.key].length !== candidate.bars.length)) return reject('Candidate is missing a required full-length output series');
  if (!Number.isSafeInteger(binding.seedTimeMs) || !Number.isSafeInteger(binding.seedBarIndex)
    || !Number.isSafeInteger(binding.lastConfirmedCloseTimeMs) || !Number.isFinite(binding.mintick) || binding.mintick <= 0) return reject('Invalid seed, completion time or minimum tick');
  const mandatory = ['audit.time_ms', 'audit.close_time_ms', 'audit.seed_time_ms', 'audit.bar_index',
    'audit.confirmed', 'audit.mintick', 'audit.interval_seconds',
    ...['open', 'high', 'low', 'close', 'volume'].map(key => `audit.${key}`),
    ...INPUTS.map(key => `audit.input.${key}`), ...fields.map(field => field.column)];
  if (mandatory.some(column => !parsed.headers.includes(column))) return reject('CSV is missing required raw/audit/input columns');
  let rows;
  try {
    rows = parsed.rows.map((row, i) => Object.fromEntries(mandatory.map(column => [column, numberCell(row[column], column, i)])));
  } catch (error) { return reject(error.message); }
  let openBarSeen = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], time = row['audit.time_ms'], closeTime = row['audit.close_time_ms'];
    if (!Number.isSafeInteger(time) || !Number.isSafeInteger(closeTime) || closeTime <= time
      || i > 0 && time <= rows[i - 1]['audit.time_ms']) return reject('Native timestamps are invalid, duplicated or unordered');
    if (row['audit.seed_time_ms'] !== binding.seedTimeMs || row['audit.bar_index'] !== binding.seedBarIndex + i) return reject('Native calculation seed/history is incomplete or differs');
    if (row['audit.mintick'] !== binding.mintick || row['audit.interval_seconds'] !== 86400) return reject('Native market/timeframe metadata differs');
    for (const key of INPUTS) if (row[`audit.input.${key}`] !== Number(binding.parameters[key])) return reject(`Native input plot mismatch: ${key}`);
    if (![0, 1].includes(row['audit.confirmed'])) return reject('Native confirmed flag must be 0 or 1');
    if (row['audit.confirmed'] === 0) openBarSeen = true;
    else if (openBarSeen) return reject('Unconfirmed bar occurs inside confirmed native history');
  }
  report.ignoredUnconfirmedBars = rows.filter(row => row['audit.confirmed'] === 0).length;
  if (report.ignoredUnconfirmedBars > 1) return reject('More than one unconfirmed trailing bar');
  rows = rows.filter(row => row['audit.confirmed'] === 1);
  if (rows.length !== candidate.bars.length || rows[0]?.['audit.time_ms'] !== binding.seedTimeMs
    || rows.at(-1)?.['audit.close_time_ms'] !== binding.lastConfirmedCloseTimeMs) return reject('Complete confirmed history count/start/end differs');
  for (let i = 0; i < rows.length; i++) {
    const bar = candidate.bars[i], row = rows[i];
    if (!bar || bar.time !== row['audit.time_ms'] || bar.closeTime !== row['audit.close_time_ms']) return reject(`Input time mismatch at row ${i}`);
    for (const key of ['open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(bar[key]) || bar[key] !== row[`audit.${key}`]) return reject(`Input OHLCV mismatch: ${key} at row ${i}`);
    }
    if (bar.volume < 0 || bar.low < 0 || bar.low > Math.min(bar.open, bar.close)
      || bar.high < Math.max(bar.open, bar.close) || bar.high < bar.low) return reject(`Invalid input OHLCV geometry at row ${i}`);
  }
  for (let i = 0; i < rows.length; i++) {
    for (const field of fields) {
      const actual = candidate.series[field.key][i], reference = rows[i][field.column];
      let reason = null, error = 0;
      if (field.kind === 'boolean') {
        if (typeof actual !== 'boolean' || ![0, 1].includes(reference)) reason = 'boolean_type';
        else if (Number(actual) !== reference) reason = 'boolean_value';
      } else if (field.kind === 'integer') {
        if (!Number.isSafeInteger(actual) || !Number.isSafeInteger(reference)) reason = 'integer_type';
        else if (actual !== reference) { reason = 'integer_value'; error = Math.abs(actual - reference); }
      } else if (actual === null || reference === null) {
        if (actual !== reference) reason = 'na_mask';
      } else if (!Number.isFinite(actual)) reason = 'candidate_not_finite';
      else {
        error = Math.abs(actual - reference);
        if (error > Math.max(ABS_TOLERANCE, REL_TOLERANCE * Math.max(Math.abs(actual), Math.abs(reference)))) reason = 'numeric_value';
      }
      report.maxError[field.key] = Math.max(report.maxError[field.key] || 0, error);
      if (reason) {
        report.divergenceCount++;
        report.firstDivergence ||= {index: i, time: candidate.bars[i].time, field: field.key, reason, native: reference, candidate: actual};
      }
    }
  }
  report.comparedBars = rows.length;
  report.coverage = {nativeLongSignals: rows.filter(row => row['audit.signal_long'] === 1).length};
  report.numericalMatch = report.divergenceCount === 0;
  if (native) {
    const roles = logMode ? ['chart', 'inputs', 'pine-source', 'pine-logs'] : CAPTURE_ROLES;
    const completeCapture = manifest.capture?.method === (logMode ? 'TradingView Pine Logs' : 'TradingView Download chart data')
      && Number.isFinite(Date.parse(manifest.capture.exportedAt))
      && roles.every(role => evidenceFiles.some(file => file.role === role && file.bytes > 0));
    if (!completeCapture) report.reasons.push('Native UI/source/input/export capture files are missing; provenance text alone is insufficient');
    else if (report.numericalMatch) report.status = 'matched_pending_native_review';
  }
  if (!report.numericalMatch) report.reasons.push('Per-bar outputs diverge; thresholds/tolerance were not relaxed');
  if (report.numericalMatch) report.reasons.push('Numerical agreement is not source authenticity, profitability or selection approval');
  return report;
}

async function main(args) {
  if (args.length !== 3) throw Error('Usage: native.csv manifest.json candidate.json OR --logs raw-native.txt manifest.json');
  let csv, logs, manifest, candidate, manifestPath;
  if (args[0] === '--logs') {
    const logsPath = resolve(args[1]); manifestPath = resolve(args[2]);
    if (!/\.(txt|csv)$/i.test(logsPath)) throw Error('Preserve the original Pine Logs text or official Logs CSV container');
    const [raw, metadata] = await Promise.all([readFile(logsPath, 'utf8'), readFile(manifestPath, 'utf8')]);
    logs = raw; manifest = JSON.parse(metadata);
    if (!['tradingview-pine-logs', 'synthetic-pine-logs'].includes(manifest.evidenceKind)) throw Error('Raw Logs require an explicit Pine Logs evidenceKind');
  } else {
    const csvPath = resolve(args[0]), candidatePath = resolve(args[2]); manifestPath = resolve(args[1]);
    const [raw, metadata, calculation] = await Promise.all([readFile(csvPath, 'utf8'), readFile(manifestPath, 'utf8'), readFile(candidatePath, 'utf8')]);
    csv = raw; manifest = JSON.parse(metadata); candidate = JSON.parse(calculation);
  }
  const evidenceFiles = [];
  for (const file of manifest.capture?.files || []) {
    const path = resolve(dirname(manifestPath), file.path), info = await stat(path);
    if (!info.isFile()) throw Error('Capture evidence is not a file: ' + path);
    evidenceFiles.push({role: file.role, path, bytes: info.size});
  }
  const report = compareNativeEvidence({csv, logs, manifest, candidate, evidenceFiles});
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // This pilot cannot grant the production/native gate, even for matching files.
  process.exitCode = report.nativeVerified ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stdout.write(JSON.stringify({status: 'not_verified', nativeVerified: false, eligibleForSelection: false, numericalMatch: false, reasons: [error.message]}, null, 2) + '\n');
    process.exitCode = 2;
  });
}
