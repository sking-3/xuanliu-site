'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BooksTraderImport = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const SOURCE = 'okx-public-lead-traders';
  const SOURCE_URL = 'https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP';
  const MAX_BYTES = 1048576;
  const WINDOW_MS = 90 * 86400000;
  const fail = detail => { throw new Error('OKX 导入校验失败：' + detail); };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function iso(value) {
    if (typeof value !== 'string') fail('时间必须包含日期、时间和时区');
    const m = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!m) fail('时间格式无效');
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('不存在的日历日期');
    if (m[8] !== 'Z' && (Number(m[9]) > 14 || Number(m[10]) > 59 || (Number(m[9]) === 14 && Number(m[10]) !== 0))) fail('时区偏移无效');
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) fail('时间超出范围');
    return { timestamp, value: new Date(timestamp).toISOString() };
  }

  function number(value, multiplier = 1) {
    if (typeof value !== 'string' || value.length > 100 || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) fail('数值字段格式无效');
    const parsed = Number(value) * multiplier;
    if (!Number.isFinite(parsed) || Math.abs(parsed) >= 1e15) fail('数值字段超出范围');
    return parsed;
  }

  function curve(points, observedAt) {
    if (!Array.isArray(points) || points.length > 1000) fail('收益曲线数量无效');
    const seen = new Set();
    const normalized = points.map(point => {
      if (!object(point) || typeof point.beginTs !== 'string' || !/^\d{1,16}$/.test(point.beginTs)) fail('曲线时间格式无效');
      const time = Number(point.beginTs);
      if (!Number.isSafeInteger(time) || time <= 0 || time < observedAt - WINDOW_MS || time > observedAt || seen.has(time)) fail('曲线时间重复或超出90日范围');
      seen.add(time);
      return { time: new Date(time).toISOString(), value: number(point.pnlRatio, 100) };
    });
    normalized.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    return normalized;
  }

  function avatarUrl(value) {
    if(typeof value!=='string'||value.length>2048||/[\s\u0000-\u001f\u007f\\]/.test(value))return null;
    try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&url.hostname==='static.okx.com'&&url.pathname.startsWith('/cdn/okex/users/headimages/')?url.href:null;}catch(_){return null;}
  }

  function normalize(input, importedAtISO) {
    let serialized;
    try { serialized = JSON.stringify(input); } catch (_) { fail('输入不是JSON对象'); }
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_BYTES) fail('输入超过1 MiB或不是JSON对象');
    if (!object(input)) fail('输入必须是对象');
    const importedAt = iso(importedAtISO);
    if (importedAt.timestamp > Date.now() + 300000) fail('导入时间不能在未来');
    const wrapped = Object.prototype.hasOwnProperty.call(input, 'source') || Object.prototype.hasOwnProperty.call(input, 'payload') || Object.prototype.hasOwnProperty.call(input, 'observedAt');
    let payload = input, observedAt = importedAt, asOfType = 'imported';
    if (wrapped) {
      if (input.source !== SOURCE || !object(input.payload)) fail('来源包装格式无效');
      observedAt = iso(input.observedAt);
      if (observedAt.timestamp > importedAt.timestamp) fail('采集时间晚于导入时间');
      payload = input.payload;
      asOfType = 'observed';
    }
    if (payload.code !== '0' || !Array.isArray(payload.data) || payload.data.length !== 1 || !object(payload.data[0])) fail('来源响应未成功或结构无效');
    const data = payload.data[0];
    if (typeof data.dataVer !== 'string' || !/^\d{14}$/.test(data.dataVer) || !Array.isArray(data.ranks) || data.ranks.length > 20) fail('榜单版本或数量无效');
    const ids = new Set();
    const traders = data.ranks.map(row => {
      if (!object(row) || typeof row.uniqueCode !== 'string' || !/^(?:[A-Za-z0-9]{16}|\d{18})$/.test(row.uniqueCode)) fail('带单员ID无效');
      if (ids.has(row.uniqueCode)) fail('带单员ID重复');
      ids.add(row.uniqueCode);
      if (typeof row.nickName !== 'string' || !row.nickName.trim() || row.nickName.length > 100 || row.ccy !== 'USDT') fail('名称或币种无效');
      const note = 'OKX 数据版本 ' + data.dataVer + '（版本时区未知）；非实时报价。' + (wrapped ? '采集时间由导入文件提供，未经独立核验。' : '快照日期未知；仅记录导入时间，曲线需可靠采集时间。');
      return {
        id: 'okx-' + row.uniqueCode,
        accountId: row.uniqueCode,
        avatarUrl:avatarUrl(row.portLink),
        name: row.nickName,
        exchange: 'OKX', currency: 'USDT', featured: false, paid: false,
        sourceUrl: SOURCE_URL, observedAt: observedAt.value, note,
        windows: { '90D': {
          roi: number(row.pnlRatio, 100), pnl: number(row.pnl),
          mdd: null, wins: null, closedTrades: null,
          asOf: observedAt.value, asOfType,
          curve: wrapped ? curve(row.pnlRatios, observedAt.timestamp) : []
        } },
        positions: [], points: [], orders: []
      };
    });
    return { schemaVersion: 1, status: 'ready', traders };
  }
  return Object.freeze({ normalize });
});
