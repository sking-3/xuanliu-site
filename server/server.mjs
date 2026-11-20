import { createServer } from 'node:http';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createControlService } from './control-service.mjs';
import { createAShareCache } from './a-share-cache.mjs';

const scrypt = promisify(scryptCb);
const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SITE_DIR = resolve(ROOT, '../site');
const SESSION_COOKIE = 'books_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const requireModule = createRequire(import.meta.url);
async function readControlJson(req, limit) {
  if (Number(req.headers['content-length'] || 0) > limit) throw Object.assign(Error('request_too_large'), { status: 413 });
  const parts = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Object.assign(Error('request_too_large'), { status: 413 });
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw Object.assign(Error('invalid_json'), { status: 400 }); }
}
const AVATAR_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);
const AUTH_PROVIDERS = [
  { id: 'email_password', name: '邮箱和密码', enabled: true, mode: 'local' },
  { id: 'qq_email', name: 'QQ 邮箱', enabled: true, mode: 'local_email' },
  { id: 'phone_sms', name: '手机号短信', enabled: false, mode: 'sms' },
  { id: 'google', name: 'Google', enabled: false, mode: 'oauth' },
  { id: 'wechat', name: '微信', enabled: false, mode: 'oauth' },
  { id: 'qq', name: 'QQ', enabled: false, mode: 'oauth' },
];
const AVATAR_KEYS = new Set(['fox', 'book', 'alpha', 'initials']);

function buildEnvPaymentProvider({ provider, network, addresses }) {
  if (!provider || !network || !addresses?.USDT || !addresses?.USDC) return null;
  return {
    id: provider,
    network,
    addresses,
    async createDepositIntent({ currency }) {
      // A configured provider must supply a real address per currency. The
      // server never fabricates an address or credits a balance from a client
      // request; confirmation is accepted only through the signed webhook.
      return { address: addresses[currency], network };
    },
  };
}

function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=')) .filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function setCookie(res, name, value, maxAge) {
  res.setHeader('set-cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Max-Age=${maxAge}${cookieSuffix()}`);
}

function clearCookie(res, name) {
  res.setHeader('set-cookie', `${name}=; Path=/; HttpOnly; Max-Age=0${cookieSuffix()}`);
}

function cookieSuffix() {
  return process.env.BOOKS_COOKIE_SAMESITE === 'none'
    ? '; Secure; SameSite=None'
    : `${process.env.NODE_ENV === 'production' ? '; Secure' : ''}; SameSite=Lax`;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

function normalizeName(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length <= 80 ? name : null;
}

function normalizeAvatarUrl(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

function normalizeAvatarKey(value) {
  if (value === undefined) return 'initials';
  return typeof value === 'string' && AVATAR_KEYS.has(value) ? value : null;
}

function validCurrency(value) {
  return value === 'USDT' || value === 'USDC';
}

function validAmountMinor(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000_000;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 200;
}

async function passwordHash(password, salt = randomBytes(16)) {
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString('base64')}.${Buffer.from(derived).toString('base64')}`;
}

async function verifyPassword(password, encoded) {
  const [saltText, hashText] = String(encoded).split('.');
  if (!saltText || !hashText) return false;
  const salt = Buffer.from(saltText, 'base64');
  const expected = Buffer.from(hashText, 'base64');
  const actual = Buffer.from(await scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1 }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function userView(row) {
  return {
    id: row.id,
    accountNo: Number.isInteger(row.account_no) ? String(row.account_no).padStart(3, '0') : null,
    email: row.email,
    displayName: row.display_name,
    avatarKey: row.avatar_key || 'initials',
    avatarUrl: row.avatar_url || '',
    role: row.role,
    status: row.status,
    createdAt: row.created_at
  };
}

function permissionsFor(row) {
  return { read: row?.status === 'active', manageUsers: row?.role === 'admin', trade: false };
}

function initDb(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_key TEXT NOT NULL DEFAULT 'initials',
      avatar_url TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK(role IN ('admin','user')) DEFAULT 'user',
      status TEXT NOT NULL CHECK(status IN ('active','disabled')) DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS wallet_accounts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      currency TEXT NOT NULL CHECK(currency IN ('USDT','USDC')),
      balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(balance_minor >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, currency)
    );
    CREATE TABLE IF NOT EXISTS recharge_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      currency TEXT NOT NULL CHECK(currency IN ('USDT','USDC')),
      status TEXT NOT NULL CHECK(status IN ('pending','completed','cancelled')),
      provider TEXT NOT NULL DEFAULT 'onchain',
      network TEXT NOT NULL DEFAULT '',
      deposit_address TEXT NOT NULL DEFAULT '',
      payment_url TEXT NOT NULL DEFAULT '',
      tx_hash TEXT NOT NULL DEFAULT '',
      confirmations INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(user_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS recharge_orders_user_idx ON recharge_orders(user_id, created_at DESC);
  `);
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (!columns.some((column) => column.name === 'account_no')) db.exec('ALTER TABLE users ADD COLUMN account_no INTEGER');
  if (!columns.some((column) => column.name === 'avatar_key')) db.exec("ALTER TABLE users ADD COLUMN avatar_key TEXT NOT NULL DEFAULT 'initials'");
  if (!columns.some((column) => column.name === 'avatar_url')) db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
  // Keep the internal UUID primary key, while exposing a stable readable number in the UI/API.
  const missingAccountNumbers = db.prepare('SELECT id FROM users WHERE account_no IS NULL ORDER BY created_at ASC, id ASC').all();
  if (missingAccountNumbers.length) {
    const next = db.prepare('SELECT COALESCE(MAX(account_no), 0) AS value FROM users').get().value;
    const assign = db.prepare('UPDATE users SET account_no=? WHERE id=?');
    db.exec('BEGIN');
    try {
      missingAccountNumbers.forEach((row, index) => assign.run(Number(next) + index + 1, row.id));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_account_no_idx ON users(account_no)');
  const rechargeColumns = db.prepare('PRAGMA table_info(recharge_orders)').all();
  if (!rechargeColumns.some((column) => column.name === 'network')) db.exec("ALTER TABLE recharge_orders ADD COLUMN network TEXT NOT NULL DEFAULT ''");
  if (!rechargeColumns.some((column) => column.name === 'deposit_address')) db.exec("ALTER TABLE recharge_orders ADD COLUMN deposit_address TEXT NOT NULL DEFAULT ''");
  if (!rechargeColumns.some((column) => column.name === 'payment_url')) db.exec("ALTER TABLE recharge_orders ADD COLUMN payment_url TEXT NOT NULL DEFAULT ''");
  if (!rechargeColumns.some((column) => column.name === 'tx_hash')) db.exec("ALTER TABLE recharge_orders ADD COLUMN tx_hash TEXT NOT NULL DEFAULT ''");
  if (!rechargeColumns.some((column) => column.name === 'confirmations')) db.exec("ALTER TABLE recharge_orders ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 0");
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('base64url');
}

async function parseBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

async function readBytes(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('avatar_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validImageBytes(type, bytes) {
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function allowedOriginSet(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

export function createApp({ dbFile = ':memory:', siteDir = DEFAULT_SITE_DIR, aShareDir = process.env.BOOKS_A_SHARE_DIR || '/var/lib/books/a-share-daily', avatarDirectory = process.env.BOOKS_AVATAR_DIR || '', allowedOrigins = process.env.BOOKS_ALLOWED_ORIGINS, paymentProvider = null, paymentNetwork = process.env.BOOKS_PAYMENT_NETWORK || '', paymentWebhookSecret = process.env.BOOKS_PAYMENT_WEBHOOK_SECRET || '' } = {}) {
  if (dbFile !== ':memory:') mkdirSync(dirname(resolve(dbFile)), { recursive: true });
  const avatarDir = resolve(avatarDirectory || resolve(siteDir, 'media', 'avatars'));
  mkdirSync(avatarDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  initDb(db);
  let researchControl = null;
  const aShareCache = createAShareCache({directory:aShareDir});
  const attempts = new Map();
  const corsOrigins = allowedOriginSet(allowedOrigins);
  const configuredPaymentProvider = paymentProvider || buildEnvPaymentProvider({
    provider: process.env.BOOKS_PAYMENT_PROVIDER || '',
    network: paymentNetwork,
    addresses: { USDT: process.env.BOOKS_USDT_DEPOSIT_ADDRESS || '', USDC: process.env.BOOKS_USDC_DEPOSIT_ADDRESS || '' },
  });

  function paymentProviderReady(currency) {
    return Boolean(configuredPaymentProvider && (configuredPaymentProvider.addresses?.[currency] || typeof configuredPaymentProvider.createDepositIntent === 'function'));
  }

  function cleanupSessions() { db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()); }

  function currentUser(req) {
    cleanupSessions();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    return db.prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash(token), Date.now()) || null;
  }

  function requireUser(req, res) {
    const user = currentUser(req);
    if (!user || user.status !== 'active') { json(res, 401, { error: 'sign_in_required' }); return null; }
    return user;
  }

  function requireAdmin(req, res) {
    const user = requireUser(req, res);
    if (!user) return null;
    if (user.role !== 'admin') { json(res, 403, { error: 'admin_required' }); return null; }
    return user;
  }

  function ensureWallet(userId) {
    const now = new Date().toISOString();
    for (const currency of ['USDT', 'USDC']) {
      db.prepare('INSERT OR IGNORE INTO wallet_accounts(user_id,currency,balance_minor,updated_at) VALUES (?,?,0,?)').run(userId, currency, now);
    }
  }

  function walletView(userId) {
    ensureWallet(userId);
    return db.prepare('SELECT currency,balance_minor AS balanceMinor,updated_at AS updatedAt FROM wallet_accounts WHERE user_id=? ORDER BY currency').all(userId);
  }

  function rechargeView(row) {
    return { id: row.id, requestId: row.request_id, amountMinor: row.amount_minor, currency: row.currency, status: row.status, provider: row.provider, settlementMode: 'production', simulationOnly: false, network: row.network || '', depositAddress: row.deposit_address || '', paymentUrl: row.payment_url || '', txHash: row.tx_hash || '', confirmations: row.confirmations || 0, createdAt: row.created_at, completedAt: row.completed_at };
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    try {
      const requestOrigin = req.headers.origin;
      const sameSite = sameOrigin(req);
      const corsAllowed = requestOrigin && corsOrigins.has(requestOrigin);
      if (requestOrigin && !sameSite && !corsAllowed) return json(res, 403, { error: 'invalid_origin' });
      if (corsAllowed) {
        res.setHeader('access-control-allow-origin', requestOrigin);
        res.setHeader('access-control-allow-credentials', 'true');
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('vary', 'Origin');
      }
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      if (await aShareCache.handle(req, res, {path,url,json})) return;
      if (path.startsWith('/api/research-control/')) {
        const user = requireAdmin(req, res); if (!user) return;
        if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        if (req.method === 'POST') {
          let expected; try { expected = new URL(req.headers.origin); } catch {}
          const protocol = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
          if (!expected || expected.host !== req.headers.host || expected.protocol !== protocol + ':' || String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') return json(res, 403, { error: 'invalid_origin' });
        }
        const modelPath = join(siteDir, 'control/model.js'), enginePath = join(siteDir, 'screening/trend-screen.js');
        if (!existsSync(modelPath) || !existsSync(enginePath)) return json(res, 503, { error: 'control_not_configured' });
        if (!researchControl) researchControl = createControlService({ db, model: requireModule(modelPath), engine: requireModule(enginePath) });
        if (await researchControl.handle(req, res, { user, path, url, readJson: readControlJson, json })) return;
        return json(res, 404, { error: 'not_found' });
      }
      if (path.startsWith('/control/')) {
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('x-frame-options', 'DENY');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      }
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, mode: 'production', settlementMode: 'production', paymentConfigured: Boolean(configuredPaymentProvider), liveTradingEnabled: false });
      if (req.method === 'GET' && path === '/api/session') {
        const user = currentUser(req);
        return json(res, 200, { authenticated: Boolean(user && user.status === 'active'), user: user ? userView(user) : null, mode: 'production', settlementMode: 'production', liveTradingEnabled: false });
      }
      if (req.method === 'GET' && path === '/api/auth/me') {
        const user = currentUser(req);
        return json(res, 200, { authenticated: Boolean(user && user.status === 'active'), user: user ? userView(user) : null, permissions: permissionsFor(user) });
      }
      if (req.method === 'GET' && path === '/api/auth/providers') {
        return json(res, 200, { providers: AUTH_PROVIDERS, liveTradingEnabled: false });
      }
      const providerMatch = path.match(/^\/api\/auth\/provider\/([a-z_]+)$/);
      if (req.method === 'POST' && providerMatch) {
        const provider = AUTH_PROVIDERS.find((item) => item.id === providerMatch[1]);
        if (!provider) return json(res, 404, { error: 'provider_not_found' });
        if (!provider.enabled) return json(res, 501, { error: 'provider_not_configured', provider: provider.id });
        return json(res, 400, { error: 'use_email_password_registration' });
      }
      if (req.method === 'POST' && path === '/api/auth/register') {
        const body = await parseBody(req);
        const email = normalizeEmail(body.email);
        const displayName = normalizeName(body.displayName);
        if (!email || !validPassword(body.password) || displayName === null) return json(res, 400, { error: 'invalid_registration' });
        const now = new Date().toISOString();
        const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
        if (exists) return json(res, 409, { error: 'email_already_registered' });
        const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
        const accountNo = db.prepare('SELECT COALESCE(MAX(account_no), 0) + 1 AS value FROM users').get().value;
        const user = { id: randomUUID(), accountNo: String(accountNo).padStart(3, '0'), email, displayName, avatarKey: 'initials', avatarUrl: '', role: count === 0 ? 'admin' : 'user', status: 'active', createdAt: now };
        const hash = await passwordHash(body.password);
        db.prepare('INSERT INTO users(id,account_no,email,password_hash,display_name,avatar_key,avatar_url,role,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(user.id, accountNo, user.email, hash, user.displayName, user.avatarKey, user.avatarUrl, user.role, user.status, user.createdAt);
        ensureWallet(user.id);
        const token = randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), user.id, tokenHash(token), Date.now() + SESSION_TTL_MS, now);
        setCookie(res, SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
        return json(res, 201, { user, permissions: permissionsFor(user) });
      }
      if (req.method === 'POST' && path === '/api/auth/login') {
        const body = await parseBody(req);
        const email = normalizeEmail(body.email);
        if (!email || typeof body.password !== 'string') return json(res, 400, { error: 'invalid_login' });
        const now = Date.now();
        const entry = attempts.get(email) || { count: 0, until: 0 };
        if (entry.until > now) return json(res, 429, { error: 'too_many_attempts' });
        const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        if (!row || !(await verifyPassword(body.password, row.password_hash))) {
          entry.count += 1;
          if (entry.count >= 5) { entry.count = 0; entry.until = now + 60_000; }
          attempts.set(email, entry);
          return json(res, 401, { error: 'invalid_credentials' });
        }
        attempts.delete(email);
        if (row.status !== 'active') return json(res, 403, { error: 'account_disabled' });
        const token = randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), row.id, tokenHash(token), now + SESSION_TTL_MS, new Date(now).toISOString());
        setCookie(res, SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
        return json(res, 200, { user: userView(row), permissions: permissionsFor(row) });
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
        clearCookie(res, SESSION_COOKIE);
        return json(res, 200, { loggedOut: true });
      }
      if (req.method === 'GET' && path === '/api/account/profile') {
        const user = requireUser(req, res); if (!user) return;
        return json(res, 200, { user: userView(user) });
      }
      if (req.method === 'POST' && path === '/api/account/profile/avatar') {
        const user = requireUser(req, res); if (!user) return;
        const body = await parseBody(req);
        const avatarKey = normalizeAvatarKey(body.avatarKey);
        const avatarUrl = normalizeAvatarUrl(body.avatarUrl);
        if (body.avatarKey !== undefined && body.avatarUrl !== undefined) return json(res, 400, { error: 'choose_avatar_key_or_url' });
        if (body.avatarKey !== undefined && avatarKey === null) return json(res, 400, { error: 'invalid_avatar_key' });
        if (body.avatarUrl !== undefined && avatarUrl === null) return json(res, 400, { error: 'invalid_avatar_url' });
        if (body.avatarKey === undefined && body.avatarUrl === undefined) return json(res, 400, { error: 'avatar_required' });
        if (body.avatarKey !== undefined) db.prepare("UPDATE users SET avatar_key=?,avatar_url='' WHERE id=?").run(avatarKey, user.id);
        else db.prepare("UPDATE users SET avatar_key='initials',avatar_url=? WHERE id=?").run(avatarUrl, user.id);
        const updated = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        return json(res, 200, { user: userView(updated) });
      }
      if (req.method === 'POST' && path === '/api/account/profile/avatar-upload') {
        const user = requireUser(req, res); if (!user) return;
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        const extension = AVATAR_TYPES.get(contentType);
        if (!extension) return json(res, 415, { error: 'unsupported_avatar_type', allowed: [...AVATAR_TYPES.keys()] });
        const bytes = await readBytes(req, MAX_AVATAR_BYTES);
        if (!bytes.length || !validImageBytes(contentType, bytes)) return json(res, 400, { error: 'invalid_avatar_image' });
        const fileName = `${randomUUID()}.${extension}`;
        const filePath = resolve(avatarDir, fileName);
        await writeFile(filePath, bytes, { flag: 'wx', mode: 0o640 });
        const previousUrl = user.avatar_url || '';
        const avatarUrl = `/media/avatars/${fileName}`;
        db.prepare("UPDATE users SET avatar_key='initials',avatar_url=? WHERE id=?").run(avatarUrl, user.id);
        if (previousUrl.startsWith('/media/avatars/')) {
          const previousPath = resolve(avatarDir, basename(previousUrl));
          if (previousPath.startsWith(avatarDir + '/') && basename(previousPath) !== fileName) await unlink(previousPath).catch(() => {});
        }
        const updated = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        return json(res, 201, { user: userView(updated), maxBytes: MAX_AVATAR_BYTES });
      }
      if (req.method === 'GET' && path === '/api/wallet') {
        const user = requireUser(req, res); if (!user) return;
        return json(res, 200, { settlementMode: 'production', paymentConfigured: Boolean(configuredPaymentProvider), balances: walletView(user.id) });
      }
      if (req.method === 'GET' && path === '/api/wallet/recharges') {
        const user = requireUser(req, res); if (!user) return;
        const rows = db.prepare('SELECT * FROM recharge_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id);
        return json(res, 200, { settlementMode: 'production', paymentConfigured: Boolean(configuredPaymentProvider), orders: rows.map(rechargeView) });
      }
      if (req.method === 'POST' && path === '/api/wallet/recharge') {
        const user = requireUser(req, res); if (!user) return;
        const body = await parseBody(req);
        const currency = body.currency;
        const amountMinor = body.amountMinor;
        const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(body.requestId) ? body.requestId : randomUUID();
        if (!validCurrency(currency) || !validAmountMinor(amountMinor)) return json(res, 400, { error: 'invalid_recharge' });
        const existing = db.prepare('SELECT * FROM recharge_orders WHERE user_id=? AND request_id=?').get(user.id, requestId);
        if (existing) return json(res, 200, { settlementMode: 'production', order: rechargeView(existing), balances: walletView(user.id), idempotent: true });
        if (!paymentProviderReady(currency)) return json(res, 503, { error: 'payment_provider_not_configured', settlementMode: 'production', currency, message: '正式充值服务尚未配置，未创建订单且不会增加余额。' });
        const now = new Date().toISOString();
        const id = randomUUID();
        let intent;
        try { intent = await configuredPaymentProvider.createDepositIntent({ id, userId: user.id, requestId, amountMinor, currency }); }
        catch { return json(res, 502, { error: 'payment_provider_unavailable', settlementMode: 'production' }); }
        if (!intent || typeof intent.address !== 'string' || !intent.address) return json(res, 502, { error: 'invalid_payment_provider_response', settlementMode: 'production' });
        const provider = String(configuredPaymentProvider.id || 'onchain').slice(0, 80);
        const network = String(intent.network || configuredPaymentProvider.network || '').slice(0, 80);
        const paymentUrl = typeof intent.paymentUrl === 'string' ? intent.paymentUrl.slice(0, 500) : '';
        db.prepare('INSERT INTO recharge_orders(id,user_id,request_id,amount_minor,currency,status,provider,network,deposit_address,payment_url,tx_hash,confirmations,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, user.id, requestId, amountMinor, currency, 'pending', provider, network, intent.address, paymentUrl, '', 0, now, null);
        const order = db.prepare('SELECT * FROM recharge_orders WHERE id=?').get(id);
        return json(res, 201, { settlementMode: 'production', order: rechargeView(order), balances: walletView(user.id) });
      }
      if (req.method === 'POST' && path === '/api/payments/webhook') {
        if (!paymentWebhookSecret || req.headers['x-books-webhook-secret'] !== paymentWebhookSecret) return json(res, 401, { error: 'invalid_webhook_signature' });
        const body = await parseBody(req);
        if (typeof body.orderId !== 'string' || !['confirmed', 'failed'].includes(body.status)) return json(res, 400, { error: 'invalid_payment_event' });
        const row = db.prepare('SELECT * FROM recharge_orders WHERE id=?').get(body.orderId);
        if (!row) return json(res, 404, { error: 'recharge_not_found' });
        if (row.status === 'completed' || row.status === 'cancelled') return json(res, 200, { settlementMode: 'production', order: rechargeView(row), idempotent: true });
        const now = new Date().toISOString();
        if (body.status === 'failed') {
          db.prepare("UPDATE recharge_orders SET status='cancelled',tx_hash=?,confirmations=? WHERE id=?").run(typeof body.txHash === 'string' ? body.txHash.slice(0, 200) : '', Number.isSafeInteger(body.confirmations) ? body.confirmations : 0, row.id);
        } else {
          const txHash = typeof body.txHash === 'string' ? body.txHash.trim() : '';
          if (!txHash) return json(res, 400, { error: 'tx_hash_required' });
          db.exec('BEGIN IMMEDIATE');
          try {
            const updated = db.prepare("UPDATE recharge_orders SET status='completed',tx_hash=?,confirmations=?,completed_at=? WHERE id=? AND status='pending'").run(txHash.slice(0, 200), Number.isSafeInteger(body.confirmations) ? body.confirmations : 0, now, row.id);
            if (updated.changes) db.prepare('UPDATE wallet_accounts SET balance_minor=balance_minor+?,updated_at=? WHERE user_id=? AND currency=?').run(row.amount_minor, now, row.user_id, row.currency);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        }
        const updated = db.prepare('SELECT * FROM recharge_orders WHERE id=?').get(row.id);
        return json(res, 200, { settlementMode: 'production', order: rechargeView(updated) });
      }
      if (req.method === 'GET' && path === '/api/admin/users') {
        if (!requireAdmin(req, res)) return;
        const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
        return json(res, 200, { users: rows.map(userView) });
      }
      if (req.method === 'POST' && path === '/api/admin/users/disable') {
        const admin = requireAdmin(req, res); if (!admin) return;
        const body = await parseBody(req);
        if (typeof body.userId !== 'string' || body.userId === admin.id) return json(res, 400, { error: 'invalid_user' });
        const result = db.prepare(`UPDATE users SET status='disabled' WHERE id=?`).run(body.userId);
        if (!result.changes) return json(res, 404, { error: 'user_not_found' });
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(body.userId);
        return json(res, 200, { updated: true });
      }
      if (req.method === 'POST' && (path.startsWith('/api/orders') || path.startsWith('/api/trades') || path.startsWith('/api/copy'))) {
        return json(res, 403, { error: 'live_trading_disabled', liveTradingEnabled: false });
      }
      if (req.method === 'GET' && (path === '/auth' || path === '/auth/')) {
        // Keep /auth and /auth.html on the same canonical account page. The
        // old public/auth.html is only a fallback for custom site directories
        // that have not been populated yet.
        const canonical = resolve(siteDir, 'auth.html');
        const source = existsSync(canonical) ? canonical : join(ROOT, 'public/auth.html');
        const body = await readFile(source, 'utf8');
        return html(res, 200, body);
      }
      if (req.method === 'GET' && path.startsWith('/media/avatars/')) {
        const fileName = basename(path);
        if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(fileName)) return json(res, 404, { error: 'not_found' });
        const candidate = resolve(avatarDir, fileName);
        if (!candidate.startsWith(avatarDir + '/') || !existsSync(candidate)) return json(res, 404, { error: 'not_found' });
        const type = fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        const body = await readFile(candidate);
        res.writeHead(200, { 'cache-control': 'public, max-age=31536000, immutable', 'content-type': type });
        res.end(body);
        return;
      }
      if (req.method === 'GET') {
        const relative = path === '/' ? 'index.html' : path.replace(/^\//, '');
        const candidate = resolve(siteDir, normalize(relative));
        if (!candidate.startsWith(resolve(siteDir) + '/') && candidate !== resolve(siteDir, 'index.html')) return html(res, 403, 'Forbidden');
        if (existsSync(candidate)) {
          const body = await readFile(candidate);
          const type = candidate.endsWith('.html') ? 'text/html' : candidate.endsWith('.css') ? 'text/css' : candidate.endsWith('.js') ? 'application/javascript' : candidate.endsWith('.png') ? 'image/png' : candidate.endsWith('.jpg') || candidate.endsWith('.jpeg') ? 'image/jpeg' : candidate.endsWith('.webp') ? 'image/webp' : 'application/octet-stream';
          res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); res.end(body); return;
        }
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      return json(res, error.status || 500, { error: error.message === 'invalid_json' || error.message === 'request_too_large' ? error.message : 'request_failed' });
    }
  }

  return { db, handle, server: createServer(handle), close: () => { researchControl?.close(); db.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbFile = process.env.BOOKS_DB || resolve(ROOT, 'data/books.sqlite');
  const app = createApp({ dbFile, siteDir: process.env.BOOKS_SITE_DIR || DEFAULT_SITE_DIR });
  const port = Number(process.env.PORT || 8930);
  app.server.listen(port, '127.0.0.1', () => console.log(`Books test server listening on http://127.0.0.1:${port}`));
}
