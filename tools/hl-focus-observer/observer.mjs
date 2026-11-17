import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Public observation only: there is no account credential, order or trading API here.
export const ADDRESS = '0x02665a064143936ba3b5e400147b6c92560f7b24';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const MAX_MESSAGE = 5 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5000;
const MAX_AGE_MS = 30000;
const ID = /^(?:0|[1-9]\d{0,23})$/;
const DECIMAL = /^-?\d{1,25}(?:\.\d{1,18})?$/;
const COIN = /^(?:[A-Za-z0-9@._-]+:)?[A-Za-z0-9@._-]{1,60}$/;
function fail(reason) { throw new Error(reason); }
function record(v) { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid_response'); return v; }
function identifier(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && ID.test(v)) return v;
  return fail('invalid_id');
}
function decimal(v) { if (typeof v !== 'string' || !DECIMAL.test(v)) fail('invalid_decimal'); return v; }
function action(fill) {
  const before = decimal(fill.startPosition), amount = decimal(fill.sz);
  if (amount.startsWith('-')) return null;
  const places = Math.max((before.split('.')[1] || '').length, (amount.split('.')[1] || '').length);
  const units = value => {
    const negative = value.startsWith('-'), unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    const n = BigInt(whole + fraction.padEnd(places, '0'));
    return negative ? -n : n;
  };
  const prior = units(before), size = units(amount), next = prior + (fill.side === 'B' ? size : -size);
  if (size === 0n) return null;
  if (fill.dir === 'Open Long' && fill.side === 'B' && prior >= 0n) return prior === 0n ? 'open_long' : 'increase_long';
  if (fill.dir === 'Open Short' && fill.side === 'A' && prior <= 0n) return prior === 0n ? 'open_short' : 'increase_short';
  if (fill.dir === 'Close Long' && fill.side === 'A' && prior > 0n && next >= 0n) return next === 0n ? 'close_long' : 'reduce_long';
  if (fill.dir === 'Close Short' && fill.side === 'B' && prior < 0n && next <= 0n) return next === 0n ? 'close_short' : 'reduce_short';
  if (fill.dir === 'Long > Short' && fill.side === 'A' && prior > 0n && next < 0n) return 'long_to_short';
  if (fill.dir === 'Short > Long' && fill.side === 'B' && prior < 0n && next > 0n) return 'short_to_long';
  return null;
}
export function normalizeFill(value, receivedAt) {
  const f = record(value);
  if (typeof f.coin !== 'string' || !COIN.test(f.coin) || f.coin.length > 80 || !['A', 'B'].includes(f.side)) fail('invalid_fill');
  if (typeof f.dir !== 'string' || !f.dir || f.dir.length > 100 || typeof f.hash !== 'string' || !f.hash || f.hash.length > 150) fail('invalid_fill');
  if (!Number.isSafeInteger(f.time) || f.time <= 0 || f.time > receivedAt + MAX_CLOCK_SKEW_MS) fail('invalid_time');
  const price = decimal(f.px), quantity = decimal(f.sz), startPosition = decimal(f.startPosition);
  if (price.startsWith('-') || quantity.startsWith('-') || Number(price) <= 0 || Number(quantity) <= 0) fail('invalid_fill');
  const tradeId = identifier(f.tid), orderId = identifier(f.oid);
  return { id: JSON.stringify([ADDRESS, f.coin, f.time, tradeId, orderId, f.hash]), coin: f.coin, side: f.side,
    direction: f.dir, action: action(f), price, quantity, startPosition, tradeId, orderId, hash: f.hash,
    sourceTime: f.time, observedAt: receivedAt, lagMs: receivedAt - f.time };
}

export function openStore(path) {
  if (path !== ':memory:') {
    path = resolve(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, source_time INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      kind TEXT NOT NULL, eligible INTEGER NOT NULL, event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transitions (at INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const insert = db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?)');
  const existingEvent = db.prepare('SELECT event_json FROM events WHERE id = ?');
  const transition = db.prepare('INSERT INTO transitions VALUES (?, ?, ?)');
  const count = db.prepare('SELECT COUNT(*) AS n FROM events');
  const hasRun = db.prepare("SELECT value FROM metadata WHERE key = 'has_run'");
  const markRun = db.prepare("INSERT INTO metadata(key,value) VALUES('has_run','1') ON CONFLICT(key) DO UPDATE SET value='1'");
  const gap = db.prepare("SELECT value FROM metadata WHERE key = 'reconciliation_required'");
  const markGap = db.prepare("INSERT INTO metadata(key,value) VALUES('reconciliation_required','1') ON CONFLICT(key) DO UPDATE SET value='1'");
  const stopReason = db.prepare("SELECT value FROM metadata WHERE key = 'source_stop'");
  const markStop = db.prepare("INSERT INTO metadata(key,value) VALUES('source_stop',?) ON CONFLICT(key) DO NOTHING");
  return {
    begin() { db.exec('BEGIN IMMEDIATE'); }, commit() { db.exec('COMMIT'); }, rollback() { db.exec('ROLLBACK'); },
    add(event, kind, eligible) {
      const prior=existingEvent.get(event.id);
      if(prior) {
        const saved=JSON.parse(prior.event_json);
        for(const field of ['coin','side','direction','action','price','quantity','startPosition','tradeId','orderId','hash','sourceTime'])
          if(saved[field]!==event[field])fail('identity_conflict');
        return false;
      }
      return insert.run(event.id,event.sourceTime,event.observedAt,kind,eligible ? 1 : 0,JSON.stringify(event)).changes === 1;
    },
    transition(at,state,reason=null) { transition.run(at,state,reason); },
    count() { return Number(count.get().n); },
    previousRun() { return !!hasRun.get(); }, markRun() { markRun.run(); },
    reconciliationRequired() { return !!gap.get(); }, markGap() { markGap.run(); },
    stopReason() { return stopReason.get()?.value || null; }, markSourceStop(reason) { markStop.run(reason); },
    all() { return db.prepare('SELECT source_time, observed_at, kind, eligible, event_json FROM events ORDER BY observed_at, id').all(); },
    transitions() { return db.prepare('SELECT * FROM transitions ORDER BY rowid').all(); }, close() { db.close(); }
  };
}

// A candidate is audit-only: no code in this module produces or submits orders.
// Unknown gaps, historical snapshots, stale events and unknown position actions are never candidates.
export function createObserver({store, now = Date.now, onEvent = () => {}}) {
  let baseline = false, connectionCount = store.previousRun() ? 1 : 0, hardStopped = !!store.stopReason();
  function connecting() { if (hardStopped) fail('stopped'); baseline = false; if (connectionCount) store.markGap(); connectionCount++; store.transition(now(), 'connecting'); }
  function disconnected(reason) { baseline = false; store.markGap(); store.transition(now(), 'disconnected',reason); }
  function stop(reason) { if (!hardStopped) {if(reason!=='manual_stop')store.markSourceStop(reason);store.markGap();store.transition(now(),'stopped',reason);} baseline = false; hardStopped = true; }
  function receive(message) {
    if (hardStopped) fail('stopped');
    const receivedAt = now(); record(message);
    if (message.channel === 'pong' || message.channel === 'subscriptionResponse') return [];
    if (message.channel === 'error') { stop('source_rejected'); return []; }
    if (message.channel !== 'userFills') return [];
    const data = record(message.data);
    if (typeof data.user !== 'string' || data.user.toLowerCase() !== ADDRESS || !Array.isArray(data.fills) || data.fills.length > 2000 || (data.isSnapshot !== undefined && typeof data.isSnapshot !== 'boolean')) fail('invalid_stream');
    const fills = data.fills.map(fill => normalizeFill(fill,receivedAt));
    // The API marks snapshots explicitly; its optional isSnapshot field may be
    // omitted on live updates. An omitted flag never establishes a baseline.
    const snapshot = data.isSnapshot === true, firstBaseline = connectionCount === 1;
    // Validate the entire message before making any durable changes.
    const decisions = [];
    store.begin();
    try {
      for (const fill of fills) {
        const kind = snapshot ? (firstBaseline ? 'initial_baseline' : 'reconnect_baseline') : !baseline ? 'before_baseline' : 'stream';
        if (kind === 'before_baseline') store.markGap();
        const eligible = kind === 'stream' && !store.reconciliationRequired() && fill.action !== null && fill.lagMs >= 0 && fill.lagMs <= MAX_AGE_MS;
        if (store.add(fill,kind,eligible)) decisions.push({ ...fill, kind, eligible, executable: false });
      }
      if (snapshot) { store.transition(receivedAt,firstBaseline ? 'baseline_ready' : 'reconnected_baseline','no historical execution'); store.markRun(); }
      store.commit();
    } catch (error) { store.rollback(); throw error; }
    if (snapshot) baseline = true;
    for (const event of decisions) onEvent(event);
    return decisions;
  }
  return { connecting, disconnected, stop, receive, status: () => ({ baseline, hardStopped, connectionCount, reconciliationRequired:store.reconciliationRequired() }) };
}

export function start({store, WebSocketImpl = globalThis.WebSocket, now = Date.now, log = console.log, reconnect = true, timers = {setTimeout,clearTimeout,setInterval,clearInterval}}) {
  if (typeof WebSocketImpl !== 'function') fail('websocket_unavailable');
  if (store.stopReason()) fail('source_stopped');
  const observer = createObserver({store,now,onEvent:event => log(JSON.stringify({type:'observation',...event}))});
  let socket, timer, heartbeat, baselineTimer, openTimer, stopped = false, attempts = 0, opened = false, openedAt = 0, lastInbound = 0;
  function cleanup() { timers.clearTimeout(timer); timers.clearTimeout(openTimer); timers.clearTimeout(baselineTimer); timers.clearInterval(heartbeat); timer = openTimer = baselineTimer = heartbeat = null; }
  function terminal(reason) { if (stopped) return; stopped=true; cleanup(); observer.stop(reason); if (socket) try {socket.close();} catch {} }
  function connect() {
    if (stopped) return;
    opened=false; observer.connecting();
    try { socket = new WebSocketImpl(WS_URL); } catch { terminal('connect_failed'); return; }
    const current = socket;
    openTimer = timers.setTimeout(()=>{if(!opened && socket===current) terminal('connect_timeout');},12000);
    current.addEventListener('open',()=>{
      if(stopped || socket!==current)return;
      opened=true; openedAt=now(); lastInbound=openedAt; timers.clearTimeout(openTimer);openTimer=null;
      current.send(JSON.stringify({method:'subscribe',subscription:{type:'userFills',user:ADDRESS,aggregateByTime:false}}));
      baselineTimer=timers.setTimeout(()=>{if(!observer.status().baseline && socket===current)terminal('baseline_timeout');},15000);
      heartbeat=timers.setInterval(()=>{
        if(stopped || socket!==current)return;
        if(now()-lastInbound>75000){try{current.close();}catch{}return;}
        if(current.readyState===1)current.send(JSON.stringify({method:'ping'}));
      },30000);
    });
    current.addEventListener('message',event=>{
      if(stopped || socket!==current)return;
      try {
        if(typeof event.data!=='string'||Buffer.byteLength(event.data)>MAX_MESSAGE)fail('invalid_stream');
        const message=JSON.parse(event.data); lastInbound=now(); observer.receive(message);
        if (observer.status().baseline) {timers.clearTimeout(baselineTimer);baselineTimer=null;}
        if(observer.status().hardStopped)terminal('source_rejected');
      } catch {terminal('invalid_stream');}
    });
    current.addEventListener('error',()=>{ if(!opened) terminal('connect_failed'); });
    current.addEventListener('close',event=>{
      timers.clearTimeout(openTimer);openTimer=null; if(stopped || socket!==current)return;
      cleanup(); observer.disconnected('stream_closed');
      if ([1008,1013].includes(event.code)) {terminal('source_rejected');return;}
      // Reconnect only after an established socket closes, with bounded backoff.
      // A rejected handshake or explicit source error remains stopped.
      if (opened && now()-openedAt >= 60000) attempts=0;
      if(!opened || !reconnect || ++attempts>8){terminal('reconnect_exhausted');return;}
      timer=timers.setTimeout(connect,Math.min(30000,1000*2**(attempts-1)));
    });
  }
  connect();
  return {stop:()=>terminal('manual_stop'),status:observer.status};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dbPath = process.env.HL_FOCUS_DB || resolve(process.cwd(),'hl-focus-observer.sqlite');
  const store = openStore(dbPath); const app = start({store});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{app.stop();store.close();process.exit(0);});
}
