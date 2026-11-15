'use strict';

// Offline copy gateway. This module intentionally has no network, credential,
// exchange, signing, or order transport code. It only validates source events
// and applies a deterministic dry-run ledger.
const VERSION = 'copy-gateway-dry-run-v1';
const ACTIONS = new Set(['open', 'increase', 'decrease', 'close']);
const SIDES = new Set(['long', 'short']);
const MAX_EVENTS = 4000;
const MAX_EVENT_AGE_MS = 120000;
const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw Error(code); };
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const finiteNonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const safeText = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max;
const safeTime = (value, now) => Number.isSafeInteger(value) && value > 0 && value <= now + 1000;

function validateEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('event_schema');
  const event = {
    schemaVersion: raw.schemaVersion ?? 1,
    source: raw.source,
    eventId: raw.eventId,
    identity: raw.identity,
    symbol: raw.symbol,
    side: raw.side,
    action: raw.action,
    quantity: raw.quantity,
    price: raw.price,
    sourceTime: raw.sourceTime,
    observedAt: raw.observedAt,
    firstSeenAt: raw.firstSeenAt,
    sequence: raw.sequence ?? null,
    positionBefore: raw.positionBefore ?? null,
    positionAfter: raw.positionAfter ?? null,
  };
  if (event.schemaVersion !== 1 || !safeText(event.source, 80) || !safeText(event.eventId, 240) ||
      !safeText(event.identity, 240) || !safeText(event.symbol, 80) || !SIDES.has(event.side) ||
      !ACTIONS.has(event.action) || !finitePositive(event.quantity) || !finitePositive(event.price) ||
      !safeTime(event.sourceTime, now) || !safeTime(event.observedAt, now) || !safeTime(event.firstSeenAt, now) ||
      event.firstSeenAt < event.sourceTime || event.observedAt < event.firstSeenAt ||
      (event.sequence !== null && (!Number.isSafeInteger(event.sequence) || event.sequence < 0)) ||
      (event.positionBefore !== null && !finiteNonNegative(event.positionBefore)) ||
      (event.positionAfter !== null && !finiteNonNegative(event.positionAfter))) fail('event_schema');
  if (event.observedAt - event.sourceTime > MAX_EVENT_AGE_MS) fail('event_stale');
  return event;
}

function createLedger({ initialCapital = 10000, maxExposure = 30000 } = {}, now = Date.now()) {
  if (!finitePositive(initialCapital) || !finitePositive(maxExposure)) fail('ledger_config');
  return {
    schemaVersion: 1,
    method: VERSION,
    mode: 'dry_run',
    paperOnly: true,
    createdAt: now,
    status: 'baseline',
    cash: initialCapital,
    realized: 0,
    fees: 0,
    maxExposure,
    positions: {},
    seen: [],
    identities: {},
    decisions: [],
  };
}

function key(event) { return `${event.source}|${event.eventId}`; }
function positionKey(event) { return `${event.symbol}|${event.side}`; }
function round(value) { return Number(value.toFixed(10)); }

function decision(event, status, reason, extra = {}) {
  return {
    mode: 'dry_run',
    sent: false,
    eventId: event.eventId,
    source: event.source,
    sourceIdentity: event.identity,
    sourceTime: event.sourceTime,
    observedAt: event.observedAt,
    sequence: event.sequence,
    observedLagMs: event.observedAt - event.sourceTime,
    action: event.action,
    symbol: event.symbol,
    side: event.side,
    quantity: event.quantity,
    price: event.price,
    status,
    ...(reason ? { reason } : {}),
    ...extra,
  };
}

function baseline(state, rawEvents, now = Date.now()) {
  const s = copy(state);
  if (s.status !== 'baseline' || s.seen.length) fail('baseline_already_set');
  const events = rawEvents.map(event => validateEvent(event, now));
  const keys = new Set();
  for (const event of events) {
    const k = key(event);
    if (keys.has(k)) fail('duplicate_event');
    keys.add(k);
    s.seen.push(k);
    s.identities[event.identity] = k;
    s.decisions.push(decision(event, 'baseline', 'historical_baseline'));
  }
  if (s.seen.length > MAX_EVENTS) fail('ledger_full');
  s.status = 'running';
  return s;
}

function apply(state, rawEvents, now = Date.now()) {
  if (!state || state.mode !== 'dry_run' || state.paperOnly !== true || state.status !== 'running') fail('ledger_not_running');
  const s = copy(state);
  if (s.seen.length >= MAX_EVENTS) fail('ledger_full');
  const events = rawEvents.map(event => validateEvent(event, now));
  // Source timestamps without an explicit sequence are not enough to order
  // same-time fills. Mark the entire group ambiguous rather than inventing a
  // causal order that could consume different simulated book depth.
  const groups = new Map();
  for (const event of events) {
    const group = `${event.source}|${event.symbol}|${event.side}|${event.sourceTime}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(event);
  }
  const priorTimes = new Set((s.decisions || []).filter(d => d.sourceTime !== undefined && d.symbol && d.side && d.sequence === null)
    .map(d => `${d.source || 'fixture'}|${d.symbol}|${d.side}|${d.sourceTime}`));
  const ambiguousTimes = new Set();
  for (const [group, list] of groups) {
    if ((list.length > 1 && list.some(e => e.sequence === null)) || priorTimes.has(group)) ambiguousTimes.add(group);
  }
  const incoming = events.filter(event => !s.seen.includes(key(event)))
    .sort((a, b) => a.sourceTime - b.sourceTime || (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.eventId.localeCompare(b.eventId));
  const identityCounts = new Map();
  for (const event of incoming) identityCounts.set(event.identity, (identityCounts.get(event.identity) || 0) + 1);
  for (const event of incoming) {
    const k = key(event);
    let d;
    if (ambiguousTimes.has(`${event.source}|${event.symbol}|${event.side}|${event.sourceTime}`)) d = decision(event, 'skipped', 'ambiguous_event_order');
    else if (identityCounts.get(event.identity) > 1 || (s.identities[event.identity] && s.identities[event.identity] !== k)) d = decision(event, 'skipped', 'ambiguous_source_version');
    else d = execute(s, event, now);
    s.decisions.push(d);
    s.seen.push(k);
    if (!d.reason && d.status !== 'skipped') s.identities[event.identity] = k;
    if (s.seen.length >= MAX_EVENTS) { s.status = 'paused'; s.decisions.push({ mode: 'dry_run', sent: false, status: 'paused', reason: 'ledger_full' }); break; }
  }
  return s;
}

function execute(state, event, now) {
  const keyName = positionKey(event);
  const opposite = `${event.symbol}|${event.side === 'long' ? 'short' : 'long'}`;
  const current = state.positions[keyName] || { symbol: event.symbol, side: event.side, quantity: 0, averagePrice: 0 };
  const opp = state.positions[opposite];
  const increase = event.action === 'open' || event.action === 'increase';
  const reduce = event.action === 'decrease' || event.action === 'close';
  if (!increase && !reduce) return decision(event, 'skipped', 'event_schema');
  if (increase && opp?.quantity > 0) return decision(event, 'skipped', 'opposite_position');
  if (reduce && current.quantity <= 0) return decision(event, 'skipped', 'no_paper_position');
  if (reduce && event.quantity > current.quantity) return decision(event, 'skipped', 'position_mismatch', { paperQuantity: current.quantity });
  const notional = event.quantity * event.price;
  if (increase && Object.values(state.positions).reduce((sum, p) => sum + p.quantity * p.averagePrice, 0) + notional > state.maxExposure) return decision(event, 'skipped', 'exposure_limit');
  if (increase) {
    const total = current.quantity + event.quantity;
    current.averagePrice = (current.quantity * current.averagePrice + notional) / total || event.price;
    current.quantity = total;
    state.positions[keyName] = current;
  } else {
    const pnl = (event.price - current.averagePrice) * event.quantity * (event.side === 'long' ? 1 : -1);
    current.quantity -= event.quantity;
    state.realized = round(state.realized + pnl);
    if (current.quantity <= 0) delete state.positions[keyName];
    else state.positions[keyName] = current;
  }
  return decision(event, 'simulated', null, { paperQuantity: increase ? current.quantity : Math.max(0, current.quantity), notional, decidedAt: now });
}

function validateLedger(state) {
  if (!state || state.schemaVersion !== 1 || state.method !== VERSION || state.mode !== 'dry_run' || state.paperOnly !== true || !['baseline', 'running', 'paused'].includes(state.status)) fail('ledger_schema');
  if (!Array.isArray(state.seen) || new Set(state.seen).size !== state.seen.length || state.seen.length > MAX_EVENTS) fail('ledger_schema');
  for (const d of state.decisions || []) if (d.sent !== false || d.mode !== 'dry_run') fail('ledger_schema');
  return true;
}

module.exports = { VERSION, MAX_EVENT_AGE_MS, validateEvent, createLedger, baseline, apply, validateLedger };
