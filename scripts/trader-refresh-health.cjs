'use strict';
// Records completed workflow steps; it never contacts an exchange.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'trader/refresh-health.json');
function read(file) { try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); } catch (_) { return null; } }
function combine(a, b) {
  if (a === 'failure' || b === 'failure') return 'failure';
  if (a === 'cancelled' || b === 'cancelled') return 'cancelled';
  if (a === 'success' && b === 'success') return 'success';
  if (a === 'skipped' && b === 'skipped') return 'skipped';
  return 'unknown';
}
function makeHealth(previous, env, now = new Date().toISOString(), readFile = read) {
  const health = { schemaVersion: 1, recordedAt: now, mode: env.REFRESH_MODE || 'unknown', platforms: {} };
  const config = {
    Binance: { status: env.BINANCE_OUTCOME, data: 'trader/binance/period-returns.json' },
    OKX: { status: combine(env.OKX_OUTCOME, env.OKX_POSITIONS_OUTCOME), data: 'trader/okx/period-returns.json', stop: 'trader/okx/source-stop.json' },
    Bitget: { status: env.BITGET_OUTCOME, data: 'trader/bitget/period-returns.json', stop: 'trader/bitget/source-stop.json' },
    Hyperliquid: { status: env.HYPERLIQUID_OUTCOME, data: 'trader/feed.json' },
  };
  const policy = readFile('scripts/source-holds.json');
  for (const [name, entry] of Object.entries(config)) {
    const old = previous?.schemaVersion === 1 ? previous.platforms?.[name] : null;
    const stop = entry.stop && readFile(entry.stop);
    const sourceHeld = name === 'Binance' && (!policy || policy.binancePublicCollector !== 'approved' || policy.githubRunInventory !== 'approved');
    const guardBlocked = (name === 'Binance' && env.BINANCE_GUARD_ALLOWED !== 'true') || (name === 'Hyperliquid' && env.HYPERLIQUID_ALLOWED === 'false');
    const stopped = sourceHeld || guardBlocked || (stop && stop.status === 'stopped');
    const result = ['success', 'failure', 'cancelled', 'skipped'].includes(entry.status) ? entry.status : 'unknown';
    const data = readFile(entry.data);
    health.platforms[name] = {
      outcome: stopped ? 'stopped' : result,
      stopReason: sourceHeld ? 'source_policy' : guardBlocked ? 'source_guard' : stopped ? stop.reason : null,
      stopAt: stopped && stop ? stop.at || null : null,
      lastCompletedAt: result === 'success' && !stopped ? now : old?.lastCompletedAt || null,
      dataAt: data?.rankFetchedAt || data?.rankEvidence?.fetchedAt || data?.generatedAt || data?.source?.fetchedAt || null,
    };
  }
  return health;
}
if (require.main === module) {
  const result = makeHealth(read('trader/refresh-health.json'), process.env);
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n');
}
module.exports = { makeHealth };
