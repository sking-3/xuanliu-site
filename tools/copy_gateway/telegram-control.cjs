'use strict';

// Telegram is a control and alert channel only. It never signs or sends an
// exchange order, and the bot token must be supplied outside the repository.
const COMMANDS = new Set(['/status', '/pause', '/resume_dryrun', '/kill']);
const MAX_MESSAGE = 1000;
const clampText = value => String(value ?? '').slice(0, MAX_MESSAGE);
const safeChat = value => (typeof value === 'number' || typeof value === 'string') && /^-?\d+$/.test(String(value));

function validateConfig(config) {
  if (!config || typeof config !== 'object' || typeof config.token !== 'string' ||
      !config.token.trim() || config.token.length > 256 || /[\x00-\x1f\x7f]/.test(config.token) ||
      !safeChat(config.chatId)) throw Error('telegram_config_invalid');
  if (config.userId !== undefined && !safeChat(config.userId)) throw Error('telegram_user_invalid');
  return {token: config.token.trim(), chatId: String(config.chatId), userId: config.userId === undefined ? null : String(config.userId)};
}

function redact(value, secrets = []) {
  let text = clampText(value);
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(?:api[_-]?key|api[_-]?secret|passphrase|private[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function createTelegramControl(rawConfig, options = {}) {
  const config = validateConfig(rawConfig);
  const transport = options.transport || (async (method, body, signal) => {
    const response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal,
    });
    if (!response.ok) throw Error(`telegram_http_${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw Error('telegram_api_error');
    return payload.result;
  });
  const callbacks = options.callbacks || {};
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());
  const secrets = [config.token, ...(options.redactSecrets || [])];
  let stopped = true, loop = null, controller = null, offset = 0, backoff = 1000, lastCommandAt = 0;

  async function send(text) {
    return transport('sendMessage', {chat_id: config.chatId, text: redact(text, secrets), disable_web_page_preview: true});
  }
  async function handle(update) {
    if (!update || !Number.isSafeInteger(update.update_id)) return null;
    offset = Math.max(offset, update.update_id + 1);
    const message = update.message;
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    if (String(chatId) !== config.chatId || (config.userId && String(userId) !== config.userId)) return 'ignored';
    const command = typeof message.text === 'string' ? message.text.trim().split(/\s+/, 1)[0] : '';
    if (!COMMANDS.has(command)) return 'unknown';
    if (now() - lastCommandAt < 500) return 'rate_limited';
    lastCommandAt = now();
    if (command === '/status') {
      const value = typeof callbacks.status === 'function' ? await callbacks.status() : '网关状态接口未连接。';
      await send(value);
    } else if (command === '/pause') {
      if (typeof callbacks.pause === 'function') await callbacks.pause();
      await send('已请求暂停跟单。请以本机网关状态为准。');
    } else if (command === '/resume_dryrun') {
      if (typeof callbacks.resumeDryRun === 'function') await callbacks.resumeDryRun();
      await send('已请求恢复 dry-run。不会恢复实盘下单。');
    } else if (command === '/kill') {
      if (typeof callbacks.kill === 'function') await callbacks.kill();
      await send('已触发本机熔断请求。实盘开关保持关闭。');
    }
    return command;
  }
  async function poll() {
    if (stopped) return;
    controller = new AbortController();
    try {
      const updates = await transport('getUpdates', {offset, timeout: 30, limit: 50, allowed_updates: ['message']}, controller.signal);
      if (Array.isArray(updates)) for (const update of updates) await handle(update);
      backoff = 1000;
    } catch (error) {
      if (!stopped) { await wait(backoff); backoff = Math.min(backoff * 2, 30000); }
    } finally {
      controller = null;
      if (!stopped) loop = poll();
    }
  }
  return {
    start() { if (stopped) { stopped = false; loop = poll(); } return {running: true, mode: 'control_only'}; },
    stop() { stopped = true; controller?.abort(); return {running: false}; },
    sendAlert(text) { return send(text); },
    handle,
    state() { return {running: !stopped, offset, mode: 'control_only'}; },
    get loop() { return loop; },
  };
}

module.exports = {COMMANDS, validateConfig, redact, createTelegramControl};
