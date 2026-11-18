import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const route = '/api/public/okx/lead-positions';
const catalog = process.env.BOOKS_OKX_CATALOG || '/opt/books/site/trader/okx/period-returns.json';
const stopRecord = process.env.BOOKS_OKX_STOP_RECORD || '/var/lib/books-okx-public/source-stop';
const port = Number(process.env.BOOKS_OKX_RELAY_PORT || 8932);
const maxBody = 384 * 1024;
const cache = new Map();
let pending = null;
let blocked = existsSync(stopRecord);
let lastAttempt = 0;

function send(res, status, data, readAt) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(readAt ? { 'X-Books-Source-Read-At': readAt } : {}),
    ...(data.error === 'upstream_stopped' ? { 'X-Books-Source-Error': 'source_stopped' } : {}),
  });
  res.end(JSON.stringify(data));
}

async function readPositions(account) {
  const url = new URL('https://www.okx.com/api/v5/copytrading/public-current-subpositions');
  url.searchParams.set('instType', 'SWAP');
  url.searchParams.set('uniqueCode', account);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
    });
    if (response.status === 403 || response.status === 429) {
      blocked = true;
      try { writeFileSync(stopRecord, new Date().toISOString() + ' HTTP ' + response.status + '\n', { mode: 0o600 }); }
      catch { console.error('OKX source blocked; stop record write failed'); }
      return { status: response.status, data: { error: 'upstream_stopped' } };
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBody) {
      return { status: 502, data: { error: 'upstream_unavailable' } };
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBody) return { status: 502, data: { error: 'upstream_invalid' } };
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (data?.code === '50011' || data?.code === '50040') {
      blocked = true;
      try { writeFileSync(stopRecord, new Date().toISOString() + ' OKX rate limit\n', { mode: 0o600 }); }
      catch { console.error('OKX source blocked; stop record write failed'); }
      return { status: 429, data: { error: 'upstream_stopped' } };
    }
    if (data?.code !== '0' || !Array.isArray(data.data)) return { status: 502, data: { error: 'upstream_invalid' } };
    return { status: 200, data: { code: '0', data: data.data }, readAt: new Date().toISOString() };
  } catch (error) {
    return { status: error.name === 'TimeoutError' ? 504 : 502, data: { error: 'upstream_unavailable' } };
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' || url.pathname !== route) return send(res, 404, { error: 'not_found' });
  const account = url.searchParams.get('account');
  if ([...url.searchParams].length !== 1 || !/^(?:[A-Za-z0-9]{16}|[A-Za-z0-9]{18})$/.test(account || '')) {
    return send(res, 400, { error: 'invalid_account' });
  }
  let known;
  try { known = JSON.parse(readFileSync(catalog, 'utf8')).accounts.some(row => row.uniqueCode === account); }
  catch { return send(res, 503, { error: 'catalog_unavailable' }); }
  if (!known) return send(res, 404, { error: 'unknown_account' });
  if (blocked) return send(res, 503, { error: 'upstream_stopped' });
  const now = Date.now();
  const previous = cache.get(account);
  if (previous && now - previous.cachedAt < (previous.status === 200 ? 25000 : 10000)) {
    return send(res, previous.status, previous.data, previous.readAt);
  }
  if (pending?.account !== account) {
    if (pending || now - lastAttempt < 500) return send(res, 503, { error: 'relay_busy' });
    lastAttempt = now;
    const task = readPositions(account).then(result => {
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(account, { ...result, cachedAt: Date.now() });
      return result;
    }).finally(() => { pending = null; });
    pending = { account, task };
  }
  const result = await pending.task;
  send(res, result.status, result.data, result.readAt);
}).listen(port, '127.0.0.1');
