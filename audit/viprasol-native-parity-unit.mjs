// SYNTHETIC ONLY. These are parser/rejection fixtures, never native TV evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {parseCsv, parsePineLogs, compareNativeEvidence, SOURCE_COMMIT} from '../quant-research/viprasol-native-parity.mjs';
import {evaluateIndicator as evaluateCore} from '../quant-research/viprasol-core.mjs';

// Written as literal CSV, independently of candidate arrays and indicator code.
const CSV = `audit.time_ms,audit.close_time_ms,audit.seed_time_ms,audit.bar_index,audit.confirmed,audit.mintick,audit.interval_seconds,audit.open,audit.high,audit.low,audit.close,audit.volume,audit.input.compLen,audit.input.compFrac,audit.input.maxCompATR,audit.input.expMult,audit.input.atrLen,audit.input.rr,audit.input.slBuf,audit.input.sigGap,audit.input.oneAtATime,audit.comp_high,audit.comp_low,audit.signal_long,audit.entry,audit.stop,audit.target
1609459200000,1609545600000,1609459200000,0,1,0.1,86400,10,11,9,10,100,10,0.6,3,1.3,14,2,0.3,15,1,NaN,NaN,0,,,
1609545600000,1609632000000,1609459200000,1,1,0.1,86400,10,12,9,11,110,10,0.6,3,1.3,14,2,0.3,15,1,11,9,0,,,
1609632000000,1609718400000,1609459200000,2,1,0.1,86400,11,13,10,12,120,10,0.6,3,1.3,14,2,0.3,15,1,12,9,1,12,8,20
`;
function fixture() {
  const binding = {indicatorId: 'tyson', sourceCommit: SOURCE_COMMIT,
    sourceFile: 'indicators/tyson-uppercut-compression-spring-breakout.pine', symbol: 'SYNTHETIC:TEST',
    timeframe: '1D', chartType: 'candles', session: 'synthetic', chartTimezone: 'UTC',
    exchangeTimezone: 'UTC', adjustment: 'none', priceCurrency: 'SYNTHETIC', volumeUnit: 'synthetic-units', seedTimeMs: 1609459200000, seedBarIndex: 0,
    lastConfirmedCloseTimeMs: 1609718400000, mintick: .1,
    parameters: {compLen: 10, compFrac: .6, maxCompATR: 3, expMult: 1.3, atrLen: 14, rr: 2, slBuf: .3, sigGap: 15, oneAtATime: true}};
  const bars = [
    {time: 1609459200000, closeTime: 1609545600000, open: 10, high: 11, low: 9, close: 10, volume: 100},
    {time: 1609545600000, closeTime: 1609632000000, open: 10, high: 12, low: 9, close: 11, volume: 110},
    {time: 1609632000000, closeTime: 1609718400000, open: 11, high: 13, low: 10, close: 12, volume: 120},
  ];
  return {csv: CSV,
    manifest: {schemaVersion: 1, evidenceKind: 'synthetic-test', binding: structuredClone(binding)},
    candidate: {schemaVersion: 1, binding: structuredClone(binding),
      inputSource: {kind: 'official', name: 'SYNTHETIC CONTRACT TEST ONLY', url: 'https://example.invalid/synthetic'},
      bars, series: {compHigh: [null, 11, 12], compLow: [null, 9, 9], signalLong: [false, false, true], entry: [null, null, 12], stop: [null, null, 8], target: [null, null, 20]}}};
}

test('CSV parser preserves BOM, quoted commas/newlines/escaped quotes and numeric zero', () => {
  assert.deepEqual(parseCsv('\uFEFFtime,"a,b",note\r\n0,0,"hello\n""world"""\r\n'), {
    headers: ['time', 'a,b', 'note'], rows: [{time: '0', 'a,b': '0', note: 'hello\n"world"'}]});
});

test('CSV parser rejects ambiguous headers, truncated rows and broken quoting', () => {
  for (const csv of ['', 'a,a\n1,2', 'a,\n1,2', 'a,b\n1', 'a\n"unterminated', 'a\n"x"bad', 'a\nx"y']) assert.throws(() => parseCsv(csv));
});

test('CLI file I/O failures emit not_verified JSON and a failing gate exit code', () => {
  const command = new URL('../quant-research/viprasol-native-parity.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [command.pathname, '/nonexistent-native.csv', '/nonexistent-manifest.json', '/nonexistent-candidate.json'], {encoding: 'utf8'});
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'not_verified');
  assert.equal(report.nativeVerified, false);
  assert.equal(report.numericalMatch, false);
  assert.match(report.reasons[0], /ENOENT/);
});

test('synthetic matching numbers remain explicitly not verified and cannot approve selection', () => {
  const report = compareNativeEvidence(fixture());
  assert.equal(report.numericalMatch, true);
  assert.equal(report.comparedBars, 3);
  assert.equal(report.status, 'not_verified');
  assert.equal(report.nativeVerified, false);
  assert.equal(report.eligibleForSelection, false);
  assert.equal(report.firstDivergence, null);
});

test('missing native CSV and provenance-only claims cannot pass native evidence gate', () => {
  const missing = fixture(); delete missing.csv;
  assert.equal(compareNativeEvidence(missing).numericalMatch, false);
  const claimed = fixture(); claimed.manifest.evidenceKind = 'tradingview-native-csv';
  let report = compareNativeEvidence(claimed);
  assert.equal(report.status, 'not_verified');
  assert.match(report.reasons.join(' '), /provenance text alone/);
  claimed.manifest.capture = {method: 'TradingView Download chart data', exportedAt: '2020-01-01T00:00:00Z'};
  claimed.evidenceFiles = ['chart', 'inputs', 'pine-source', 'csv-export'].map(role => ({role, bytes: 1}));
  report = compareNativeEvidence(claimed);
  assert.equal(report.status, 'matched_pending_native_review');
  assert.equal(report.nativeVerified, false);
  assert.equal(report.eligibleForSelection, false);
});

test('symbol, source, adjustment, timezone, seed, input parameters and official input bindings are strict', () => {
  for (const key of ['symbol', 'sourceCommit', 'adjustment', 'priceCurrency', 'volumeUnit', 'chartTimezone', 'exchangeTimezone', 'seedTimeMs', 'lastConfirmedCloseTimeMs']) {
    const data = fixture(); data.candidate.binding[key] = 'different';
    assert.match(compareNativeEvidence(data).reasons.join(' '), new RegExp('Binding mismatch: ' + key));
  }
  const parameters = fixture(); parameters.candidate.binding.parameters.compLen = 11;
  assert.match(compareNativeEvidence(parameters).reasons.join(' '), /input parameters/);
  const missing = fixture(); delete missing.manifest.binding.parameters.rr;
  assert.match(compareNativeEvidence(missing).reasons.join(' '), /incomplete/);
  const source = fixture(); source.candidate.inputSource.kind = 'local-generated';
  assert.match(compareNativeEvidence(source).reasons.join(' '), /shared input provenance/);
  for (const key of ['priceCurrency', 'volumeUnit']) {
    const missing = fixture(); delete missing.manifest.binding[key]; delete missing.candidate.binding[key];
    assert.match(compareNativeEvidence(missing).reasons.join(' '), new RegExp('Binding mismatch: ' + key));
    const nullUnit = fixture(); nullUnit.manifest.binding[key] = null; nullUnit.candidate.binding[key] = null;
    assert.match(compareNativeEvidence(nullUnit).reasons.join(' '), new RegExp('Binding mismatch: ' + key));
  }
});

test('native metadata, parameters and complete history cannot be overwritten by matching manifest strings', () => {
  for (const [before, after, reason] of [
    [',0,1,0.1,86400,', ',4,1,0.1,86400,', /seed\/history/],
    [',1,1,0.1,86400,', ',1,1,0.2,86400,', /market\/timeframe/],
    [',10,0.6,3,1.3,14,2,0.3,15,1,', ',11,0.6,3,1.3,14,2,0.3,15,1,', /Native input plot mismatch/],
  ]) {
    const data = fixture(); data.csv = data.csv.replace(before, after);
    assert.match(compareNativeEvidence(data).reasons.join(' '), reason);
  }
  const partial = fixture(); partial.csv = partial.csv.split('\n').filter((_, i) => i !== 1).join('\n');
  assert.match(compareNativeEvidence(partial).reasons.join(' '), /seed\/history/);
});

test('exact official OHLCV and confirmation timestamps reject before formula comparison', () => {
  for (const key of ['open', 'high', 'low', 'close', 'volume', 'time', 'closeTime']) {
    const data = fixture(); data.candidate.bars[1][key] += .001;
    const report = compareNativeEvidence(data);
    assert.equal(report.comparedBars, 0);
    assert.match(report.reasons.join(' '), /Input (time|OHLCV) mismatch/);
  }
  const bad = fixture(); bad.csv = bad.csv.replace(',0,1,0.1,86400,', ',0,0,0.1,86400,');
  assert.match(compareNativeEvidence(bad).reasons.join(' '), /Unconfirmed bar occurs inside/);
});

test('one trailing unconfirmed raw candle is reported, never treated as an official confirmed signal', () => {
  const data = fixture(); data.csv += '1609718400000,1609804800000,1609459200000,3,0,0.1,86400,12,14,11,13,130,10,0.6,3,1.3,14,2,0.3,15,1,13,9,0,,,\n';
  const report = compareNativeEvidence(data);
  assert.equal(report.ignoredUnconfirmedBars, 1);
  assert.equal(report.comparedBars, 3);
  assert.equal(report.numericalMatch, true);
  assert.equal(report.status, 'not_verified');
});

test('NA, booleans, entry, stop and target compare on every bar and retain first divergence/max error', () => {
  const na = fixture(); na.candidate.series.compHigh[0] = 0;
  assert.equal(compareNativeEvidence(na).firstDivergence.reason, 'na_mask');
  for (const [value, reason] of [[0, 'boolean_type'], [true, 'boolean_value']]) {
    const data = fixture(); data.candidate.series.signalLong[0] = value;
    assert.equal(compareNativeEvidence(data).firstDivergence.reason, reason);
  }
  for (const key of ['entry', 'stop', 'target']) {
    const data = fixture(); data.candidate.series[key][2] += .25;
    const report = compareNativeEvidence(data);
    assert.deepEqual(report.firstDivergence, {index: 2, time: 1609632000000, field: key, reason: 'numeric_value', native: {entry: 12, stop: 8, target: 20}[key], candidate: data.candidate.series[key][2]});
    assert.equal(report.maxError[key], .25);
    assert.equal(report.divergenceCount, 1);
    assert.equal(report.numericalMatch, false);
  }
});

test('NaN and infinity cannot impersonate missing values or enlarge tolerance', () => {
  const numeric = fixture(); numeric.candidate.series.target[2] = NaN;
  assert.equal(compareNativeEvidence(numeric).firstDivergence.reason, 'candidate_not_finite');
  const csv = fixture(); csv.csv = csv.csv.replace(',12,8,20\n', ',12,8,Infinity\n');
  assert.match(compareNativeEvidence(csv).reasons.join(' '), /Invalid numeric CSV cell/);
});

test('audit Pine preserves the original source as an exact byte prefix and adds no branch changes', async () => {
  const original = await readFile(new URL('../quant-research/viprasol-source/indicators/tyson-uppercut-compression-spring-breakout.pine', import.meta.url));
  const audit = await readFile(new URL('../quant-research/native-audit/tyson-native-audit.pine', import.meta.url));
  assert.deepEqual(audit.subarray(0, original.length), original);
  const appendix = audit.subarray(original.length).toString('utf8');
  assert.match(appendix, /auditLogs = input.bool\(false/);
  assert.match(appendix, /plot\(compHigh, "audit.comp_high"/);
  assert.doesNotMatch(appendix, /\bsig\s*:=|\bcompHigh\s*:=|\bcompLow\s*:=|\blastSig\s*:=/);
  assert.match(appendix, /AUDIT_END\|/);
  assert.match(appendix, /tyson-native-log-v2/);
});

// Independently hand-worked SYNTHETIC trace, not copied from JS or TV output.
// ATR length 1: the signal at index 5 is blocked on index 6; the same index-6
// candle touches both reference stop and target, leaving zero active zones.
function logFixture() {
  const data = fixture(), seed = 1609459200000, day = 86400000;
  const parameters = {compLen: 3, compFrac: .6, maxCompATR: 3, expMult: 1, atrLen: 1, rr: 2, slBuf: .3, sigGap: 0, oneAtATime: true};
  const binding = {...data.manifest.binding, session: 'regular', priceCurrency: 'USD', volumeUnit: 'BTC', parameters,
    lastConfirmedCloseTimeMs: seed + 8 * day};
  const body = [
    '10,20,0,10,100,na,na,0,na,na,na,20,na,0,0,0,0,0,-100000,-100000,1',
    '10,11,9,10,100,na,na,0,na,na,na,2,na,0,0,0,0,0,-100000,-100000,1',
    '10,11,9,10,100,20,0,0,na,na,na,2,na,0,0,0,0,0,-100000,-100000,1',
    '10,11,9,10,100,20,0,0,na,na,na,2,na,0,0,0,0,0,-100000,-100000,1',
    '10,11,9,10,100,11,9,0,na,na,na,2,na,0,0,0,0,0,-100000,-100000,1',
    '10,14,9,13,100,11,9,1,13,7.5,24,5,20,1,1,0,0,1,5,-100000,1',
    '13,25,7,24,100,14,9,0,na,na,na,18,20,1,1,1,1,0,5,5,1',
    '24,27,23,26,100,25,7,0,na,na,na,4,18,0,1,0,0,0,5,5,1',
  ];
  const logs = [
    'Pine Logs — SYNTHETIC CONTRACT TEST ONLY',
    `[prefix] AUDIT_META|format=tyson-native-log-v2|source=${SOURCE_COMMIT}|indicator=tyson|symbol=SYNTHETIC:TEST|timeframe=D|exchange_timezone=UTC|session=regular|seed_ms=${seed}|seed_index=0|mintick=0.1|interval_seconds=86400|price_currency=USD|base_currency=BTC|volume_type=base`,
    'AUDIT_INPUTS|compLen=3|compFrac=0.6|maxCompATR=3|expMult=1|atrLen=1|rr=2|slBuf=0.3|sigGap=0|oneAtATime=true',
    ...body.map((row, i) => `AUDIT_ROW|${seed + i * day},${seed + (i + 1) * day},${seed},${i},${row}`),
    `AUDIT_END|seed_ms=${seed}|seed_index=0|time_ms=${seed + 7 * day}|close_time_ms=${seed + 8 * day}|bar_index=7|row_count=8`,
  ].join('\n');
  return {logs, manifest: {schemaVersion: 1, evidenceKind: 'synthetic-pine-logs', binding}};
}

function changeLogCell(logs, row, column, value) {
  let index = -1;
  return logs.split('\n').map(line => {
    if (!line.startsWith('AUDIT_ROW|') || ++index !== row) return line;
    const values = line.slice(10).split(','); values[column] = String(value);
    return 'AUDIT_ROW|' + values.join(',');
  }).join('\n');
}

function logsCsv(logs, headers = '日期,消息') {
  const messages = logs.split('\n').filter(line => line.includes('AUDIT_'));
  return headers + '\r\n' + messages.map(message => '2021-01-01T09:30:00.000+08:00,"' + message.replaceAll('"', '""') + '"').join('\r\n');
}

test('raw Pine Logs remain a distinct evidence type and run existing JS on their shared OHLCV', () => {
  const data = logFixture(), raw = data.logs;
  const parsed = parsePineLogs(raw);
  assert.equal(parsed.rows.length, 8);
  assert.equal(parsed.parameters.atrLen, 1);
  const report = compareNativeEvidence(data);
  assert.equal(report.referenceType, 'pine-logs');
  assert.equal(report.candidateComputation, 'existing-js-core-on-shared-raw-input');
  assert.equal(report.sharedInput, true);
  assert.equal(report.numericalMatch, true);
  assert.equal(report.coverage.nativeLongSignals, 1);
  assert.equal(report.comparedBars, 8);
  assert.equal(report.status, 'not_verified');
  assert.equal(report.nativeVerified, false);
  assert.equal(data.logs, raw);
  assert.match(compareNativeEvidence({...data, csv: CSV}).reasons.join(' '), /chart CSV input mode/);
  assert.match(compareNativeEvidence({...data, candidate: fixture().candidate}).reasons.join(' '), /must be recomputed by existing JS/);
});

test('official Date/Message Logs CSV is unwrapped without pretending to be chart CSV', () => {
  const data = logFixture();
  for (const headers of ['日期,消息', 'Date,Message']) {
    const logs = logsCsv(data.logs, headers), original = logs;
    const parsed = parsePineLogs(logs);
    const report = compareNativeEvidence({...data, logs});
    assert.equal(parsed.containerType, 'pine-logs-csv');
    assert.equal(parsed.rows.length, 8);
    assert.equal(report.referenceType, 'pine-logs');
    assert.equal(report.containerType, 'pine-logs-csv');
    assert.equal(report.numericalMatch, true);
    assert.equal(report.nativeVerified, false);
    assert.equal(logs, original);
  }
  assert.throws(() => parsePineLogs('日期,消息\nbad-date,AUDIT_META|x=1'), /invalid dates/);
  assert.throws(() => parsePineLogs('日期,消息\n2021-01-01,'), /empty messages/);
  assert.throws(() => parsePineLogs('日期,消息,extra\n2021-01-01,x,y'), /expected Date\/Message/);
});

test('stock-style empty base currency is legitimate; n/a volume stays in unspecified native units', () => {
  const data = logFixture();
  data.logs = logsCsv(data.logs.replace('base_currency=BTC', 'base_currency=').replace('volume_type=base', 'volume_type=n/a'));
  data.manifest.binding.volumeUnit = 'native units unspecified';
  const parsed = parsePineLogs(data.logs), report = compareNativeEvidence(data);
  assert.equal(parsed.meta.base_currency, '');
  assert.equal(report.numericalMatch, true);
  assert.equal(report.sharedInput, true);
  data.manifest.binding.volumeUnit = 'shares';
  assert.match(compareNativeEvidence(data).reasons.join(' '), /volumeUnit/);
  for (const key of ['source', 'symbol', 'exchange_timezone', 'price_currency', 'volume_type']) {
    const raw = logFixture(), bad = raw.logs.replace(new RegExp(key + '=[^|\\n]*'), key + '=');
    assert.match(compareNativeEvidence({...raw, logs: bad}).reasons.join(' '), /Invalid.*metadata|metadata missing/);
  }
});

test('missing seed, END, truncated tail, repeated runs, rows after END and gaps cannot become a partial pass', () => {
  const data = logFixture(), lines = data.logs.split('\n');
  for (const logs of [
    lines.filter(line => !line.startsWith('AUDIT_END|')).join('\n'),
    lines.filter((_, index) => index !== 3).join('\n'),
    lines.filter((_, index) => index !== lines.length - 2).join('\n'),
    data.logs + '\n' + data.logs,
    data.logs + '\n' + lines[3],
    data.logs.replace('row_count=8', 'row_count=7'),
    changeLogCell(data.logs, 4, 3, 8),
    changeLogCell(data.logs, 4, 0, 1609459200000),
    changeLogCell(data.logs, 4, 2, 0),
  ]) {
    const report = compareNativeEvidence({...data, logs});
    assert.equal(report.numericalMatch, false);
    assert.equal(report.status, 'not_verified');
    assert.ok(report.reasons.length);
  }
});

test('Pine Logs reject incomplete traces, NaN numeric syntax and changed metadata/units/inputs', () => {
  const data = logFixture();
  for (const [logs, reason] of [
    [data.logs.replace('format=tyson-native-log-v2', 'format=old-v1'), /Unsupported/],
    [data.logs.replace('|volume_type=base', ''), /metadata missing/],
    [data.logs.replace('base_currency=BTC', 'base_currency=ETH'), /volumeUnit/],
    [data.logs.replace('symbol=SYNTHETIC:TEST', 'symbol=OTHER:TEST'), /symbol/],
    [data.logs.replace('expMult=1|', 'expMult=1.1|'), /input parameters/],
    [changeLogCell(data.logs, 0, 9, 'Infinity'), /Invalid numeric/],
    [data.logs.replace(',-100000,-100000,1\n', ',-100000,-100000\n'), /truncated trace/],
  ]) assert.match(compareNativeEvidence({...data, logs}).reasons.join(' '), reason);
});

test('ATR, NA, boolean event/state, active lifecycle and lastSig differences are compared per bar', () => {
  const data = logFixture();
  for (const [row, column, value, field, reason] of [
    [5, 15, 6, 'atr', 'numeric_value'],
    [0, 9, 0, 'compHigh', 'na_mask'],
    [5, 11, 0, 'signalLong', 'boolean_value'],
    [6, 19, 0, 'blocked', 'boolean_value'],
    [6, 20, 0, 'activeBefore', 'integer_value'],
    [6, 21, 1, 'activeAfter', 'integer_value'],
    [5, 22, 4, 'lastSig', 'integer_value'],
    [6, 23, 4, 'lastSigBefore', 'integer_value'],
    [6, 24, 0, 'cooldownAllowed', 'boolean_value'],
    [5, 11, 'na', 'signalLong', 'boolean_type'],
  ]) {
    const report = compareNativeEvidence({...data, logs: changeLogCell(data.logs, row, column, value)});
    assert.equal(report.numericalMatch, false);
    assert.equal(report.firstDivergence.field, field);
    assert.equal(report.firstDivergence.reason, reason);
    assert.equal(report.firstDivergence.index, row);
  }
});

test('changing shared OHLCV changes JS output rather than copying the native reference event columns', () => {
  const data = logFixture();
  const report = compareNativeEvidence({...data, logs: changeLogCell(data.logs, 5, 7, 12)});
  assert.equal(report.firstDivergence.field, 'entry');
  assert.equal(report.firstDivergence.native, 13);
  assert.equal(report.firstDivergence.candidate, 12);
  assert.equal(report.maxError.target, 3);
});

test('opt-in trace reveals raw ranges but preserves all normal outputs and immutable inputs', () => {
  const parsed = parsePineLogs(logFixture().logs);
  const bars = parsed.rows.map(row => ({time: Number(row['audit.time_ms']), ...Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(key => [key, Number(row['audit.' + key])]))}));
  const original = structuredClone(bars);
  const normal = evaluateCore('tyson', bars, parsed.parameters);
  const traced = evaluateCore('tyson', bars, parsed.parameters, {auditTrace: true});
  const {auditTrace, ...withoutTrace} = traced;
  assert.deepEqual(normal, withoutTrace);
  assert.equal(Object.hasOwn(normal, 'auditTrace'), false);
  assert.equal(normal.plots[0].values[1], null);
  assert.equal(auditTrace[1].compHigh, null);
  assert.equal(auditTrace[2].compHigh, 20);
  assert.equal(auditTrace[6].activeBefore, 1);
  assert.equal(auditTrace[6].activeAfter, 0);
  assert.deepEqual(bars, original);
  const warmup = evaluateCore('tyson', Array.from({length: 20}, (_, i) => ({time: 1609459200000 + i * 86400000, open: 10, high: 11, low: 9, close: 10, volume: 0})), {}, {auditTrace: true}).auditTrace;
  assert.ok(warmup.slice(0, 13).every(row => row.atr === null));
  assert.equal(warmup[13].atr, 2);
});
