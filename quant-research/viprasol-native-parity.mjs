// Consumes external TradingView evidence. It never creates a native reference.
import {readFile, stat} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

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

export function compareNativeEvidence({csv, manifest, candidate, evidenceFiles = []}) {
  const report = {schemaVersion: 1, status: 'not_verified', nativeVerified: false, eligibleForSelection: false,
    numericalMatch: false, comparedBars: 0, ignoredUnconfirmedBars: 0, divergenceCount: 0,
    firstDivergence: null, maxError: {}, reasons: [], tolerance: {absolute: ABS_TOLERANCE, relative: REL_TOLERANCE}};
  const reject = reason => { report.reasons.push(reason); return report; };
  if (!csv) return reject('Native CSV is missing; no native parity evidence exists');
  if (manifest?.schemaVersion !== 1 || candidate?.schemaVersion !== 1) return reject('Manifest/candidate schemaVersion must be 1');
  const native = manifest.evidenceKind === 'tradingview-native-csv';
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
  if (candidate.inputSource?.kind !== 'official' || !candidate.inputSource.name || !candidate.inputSource.url) return reject('Independent official input provenance is missing');
  if (!Array.isArray(candidate.bars) || !candidate.bars.length) return reject('Independent official input bars are missing');
  if (!candidate.series || TYSON_FIELDS.some(field => !Array.isArray(candidate.series[field.key]) || candidate.series[field.key].length !== candidate.bars.length)) return reject('Candidate is missing a required full-length output series');
  if (!Number.isSafeInteger(binding.seedTimeMs) || !Number.isSafeInteger(binding.seedBarIndex)
    || !Number.isSafeInteger(binding.lastConfirmedCloseTimeMs) || !Number.isFinite(binding.mintick) || binding.mintick <= 0) return reject('Invalid seed, completion time or minimum tick');
  let parsed;
  try { parsed = parseCsv(csv); } catch (error) { return reject(error.message); }
  const mandatory = ['audit.time_ms', 'audit.close_time_ms', 'audit.seed_time_ms', 'audit.bar_index',
    'audit.confirmed', 'audit.mintick', 'audit.interval_seconds',
    ...['open', 'high', 'low', 'close', 'volume'].map(key => `audit.${key}`),
    ...INPUTS.map(key => `audit.input.${key}`), ...TYSON_FIELDS.map(field => field.column)];
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
    if (!bar || bar.time !== row['audit.time_ms'] || bar.closeTime !== row['audit.close_time_ms']) return reject(`Official input time mismatch at row ${i}`);
    for (const key of ['open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(bar[key]) || bar[key] !== row[`audit.${key}`]) return reject(`Official input OHLCV mismatch: ${key} at row ${i}`);
    }
    if (bar.volume < 0 || bar.low < 0 || bar.low > Math.min(bar.open, bar.close)
      || bar.high < Math.max(bar.open, bar.close) || bar.high < bar.low) return reject(`Invalid official input OHLCV geometry at row ${i}`);
  }
  for (let i = 0; i < rows.length; i++) {
    for (const field of TYSON_FIELDS) {
      const actual = candidate.series[field.key][i], reference = rows[i][field.column];
      let reason = null, error = 0;
      if (field.kind === 'boolean') {
        if (typeof actual !== 'boolean' || ![0, 1].includes(reference)) reason = 'boolean_type';
        else if (Number(actual) !== reference) reason = 'boolean_value';
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
  report.numericalMatch = report.divergenceCount === 0;
  if (native) {
    const completeCapture = manifest.capture?.method === 'TradingView Download chart data'
      && Number.isFinite(Date.parse(manifest.capture.exportedAt))
      && CAPTURE_ROLES.every(role => evidenceFiles.some(file => file.role === role && file.bytes > 0));
    if (!completeCapture) report.reasons.push('Native UI/source/input/export capture files are missing; provenance text alone is insufficient');
    else if (report.numericalMatch) report.status = 'matched_pending_native_review';
  }
  if (!report.numericalMatch) report.reasons.push('Per-bar outputs diverge; thresholds/tolerance were not relaxed');
  if (report.numericalMatch) report.reasons.push('Numerical agreement is not source authenticity, profitability or selection approval');
  return report;
}

async function main(args) {
  if (args.length !== 3) throw Error('Usage: node quant-research/viprasol-native-parity.mjs native.csv manifest.json candidate.json');
  const [csvPath, manifestPath, candidatePath] = args.map(path => resolve(path));
  const [csv, manifestText, candidateText] = await Promise.all([readFile(csvPath, 'utf8'), readFile(manifestPath, 'utf8'), readFile(candidatePath, 'utf8')]);
  const manifest = JSON.parse(manifestText), candidate = JSON.parse(candidateText), evidenceFiles = [];
  for (const file of manifest.capture?.files || []) {
    const path = resolve(dirname(manifestPath), file.path), info = await stat(path);
    if (!info.isFile()) throw Error('Capture evidence is not a file: ' + path);
    evidenceFiles.push({role: file.role, path, bytes: info.size});
  }
  const report = compareNativeEvidence({csv, manifest, candidate, evidenceFiles});
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
