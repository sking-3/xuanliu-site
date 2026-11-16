'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = require('../trader/public-executions.js');

const target = path.resolve(__dirname, '../trader/replay-seed.js');
const assignment = 'globalThis.BooksPublicRecordSeed=';
const identityKeys = ['symbol','baseAsset','quoteAsset','side','positionSide','type','orderTime'];
const fingerprintKeys = [...identityKeys,'orderUpdateTime','executedQty','avgPrice','totalPnl','sourceOrderId','identity'];
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function checksum(row, keys) {
  return digest(JSON.stringify(Object.fromEntries([...keys].sort().map(k => [k, row[k]]))));
}
function verify(key, row) {
  if (!row || row.fingerprint !== key || checksum(row, identityKeys) !== row.identity ||
      checksum(row, fingerprintKeys) !== key) throw Error('checkpoint_fingerprint_mismatch');
  const direction = {
    BUY_LONG:'opening_or_increasing_long', SELL_SHORT:'opening_or_increasing_short',
    SELL_LONG:'reducing_or_closing_long', BUY_SHORT:'reducing_or_closing_short',
    BUY_BOTH:'one_way_direction_unresolved', SELL_BOTH:'one_way_direction_unresolved'
  }[row.side + '_' + row.positionSide];
  if (!direction || row.direction !== direction) throw Error('checkpoint_direction_mismatch');
}
function decode(text) {
  const start = text.indexOf(assignment);
  if (start < 0) throw Error('archive_assignment_missing');
  return JSON.parse(text.slice(start + assignment.length).trim().replace(/;$/, ''));
}
function extend(archive, checkpoint, receipt) {
  source.parseArchive(archive);
  source.parse(checkpoint);
  if (!checkpoint.lastSuccessAt || checkpoint.initialized !== true) throw Error('checkpoint_without_success');
  const events = checkpoint.events;
  if (!Array.isArray(events) || events.length > 200) throw Error('invalid_checkpoint_events');
  const rows = Object.assign(Object.create(null), archive.records);
  const verifyStored = Object.entries(rows);
  for (const [key, row] of verifyStored) verify(key, row);
  let added = 0;
  const fromEvents = Object.create(null);
  for (const event of events) {
    if (!event || !event.record || event.id !== event.record.fingerprint) throw Error('invalid_checkpoint_event_record');
    verify(event.id, event.record);
    fromEvents[event.id] = event.record;
  }
  source.parse({...checkpoint, records:fromEvents});
  for (const [key, row] of [...Object.entries(fromEvents), ...Object.entries(checkpoint.records)]) {
    verify(key, row);
    if (Object.hasOwn(rows, key)) continue;
    rows[key] = row;
    added++;
  }
  if (!added) return {archive, added};
  const latest = Date.parse(checkpoint.lastSuccessAt) >= Date.parse(archive.lastSuccessAt) ? checkpoint : archive;
  return {added, archive:{...archive, lastSuccessAt:latest.lastSuccessAt, stopped:latest.stopped,
    errorCode:latest.errorCode || null, records:rows,
    archiveReceipts:[...(archive.archiveReceipts || []), {...receipt, checkedAt:checkpoint.lastSuccessAt, added}]}};
}
function save(checkpointPath, commit, archivePath=target) {
  if (commit && !/^[a-f0-9]{40}$/.test(commit)) throw Error('invalid_state_commit');
  const buffer = fs.readFileSync(checkpointPath);
  if (buffer.length > 900000) throw Error('checkpoint_too_large');
  const checkpoint = JSON.parse(buffer.toString('utf8'));
  const old = decode(fs.readFileSync(archivePath, 'utf8'));
  const receipt = {sha256:digest(buffer), ...(commit ? {commit} : {})};
  const result = extend(old, checkpoint, receipt);
  if (result.added) {
    const tmp = archivePath + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, '/* Archived Binance public execution observations. Original source times and record fingerprints are preserved. */\n' + assignment + JSON.stringify(result.archive) + ';\n', {flag:'wx'});
      fs.renameSync(tmp, archivePath);
    } finally {fs.rmSync(tmp, {force:true});}
  }
  return {added:result.added, retained:Object.keys(result.archive.records).length};
}
if (require.main === module) {
  if (!process.argv[2]) throw Error('Usage: node scripts/archive_aoying_records.cjs CHECKPOINT_JSON [STATE_COMMIT_SHA]');
  console.log(JSON.stringify(save(process.argv[2], process.argv[3])));
}
module.exports = {decode, extend, save};
