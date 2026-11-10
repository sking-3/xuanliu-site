(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document) api.start(root.document, root);
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const PORTFOLIO_ID = '5156287639231681792';
  const SOURCE_URL = 'https://www.binance.com/en/copy-trading/lead-details/' + PORTFOLIO_ID;
  const MAX_AGE = 30 * 60 * 1000;
  const POLL_MS = 5 * 60 * 1000;
  const DAY = 86400000;
  const LIMIT = 100;
  const labels = { ready: '当前快照', stale: '数据过期', unavailable: '不可用', restricted: '访问受限' };
  const sides = { LONG: '多头', SHORT: '空头', BOTH: '单向仓位', Long: '多头', Short: '空头', BUY: '买入', SELL: '卖出' };
  const kinds = { baseline: '首次观察 · 基线', appeared: '观察到新仓位', increased: '观察到数量增加', decreased: '观察到数量减少', absent: '观察到归零' };
  const isText = value => typeof value === 'string' && value.length <= 500;
  const decimal = value => typeof value === 'string' && value.length <= 100 && /^[+-]?\d+(?:\.\d+)?$/.test(value);
  const nonzero = value => !/^[+-]?0+(?:\.0+)?$/.test(value);
  const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  const ms = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const old = (value, now) => !iso(value) || now - Date.parse(value) > MAX_AGE || Date.parse(value) > now + 300000;
  const str = value => value === null || value === undefined || value === '' ? '—' : String(value);
  function time(value) {
    const stamp = typeof value === 'number' ? value : (iso(value) ? Date.parse(value) : NaN);
    return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toLocaleString('zh-CN', { hour12: false }) : '—';
  }
  function sourceUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'www.binance.com' && !url.username && !url.password &&
        /^\/[a-z]{2}(?:-[A-Za-z]{2})?\/copy-trading\/lead-details\//.test(url.pathname) &&
        url.pathname.split('/').filter(Boolean).pop() === PORTFOLIO_ID ? url.href : SOURCE_URL;
    } catch (_) { return SOURCE_URL; }
  }
  function parseFeed(data) {
    if (!data || data.schemaVersion !== 1 || data.sourceType !== 'copy_trade' || data.portfolioId !== PORTFOLIO_ID ||
        !data.profile || String(data.profile.id) !== PORTFOLIO_ID || !isText(data.profile.name) ||
        !['public', 'restricted', 'unknown'].includes(data.profile.visibility) || !data.source ||
        !Object.hasOwn(labels, data.source.status) || typeof data.source.refreshStopped !== 'boolean') {
      throw new Error('SNAPSHOT_SCHEMA');
    }
    return data;
  }
  function validPosition(p) {
    return p && isText(p.key) && isText(p.symbol) && ['LONG', 'SHORT', 'BOTH'].includes(p.side) &&
      ['quantity', 'entryPrice', 'markPrice', 'unrealizedPnl'].every(key => decimal(p[key])) &&
      typeof p.leverage === 'number' && Number.isFinite(p.leverage) && p.leverage > 0 && isText(p.collateral);
  }
  function validSnapshot(snapshot) {
    return snapshot && snapshot.complete === true && iso(snapshot.observedAt) &&
      Number.isSafeInteger(snapshot.rawCount) && snapshot.rawCount >= 0 &&
      Array.isArray(snapshot.positions) && snapshot.positions.length <= 5000 &&
      snapshot.rawCount >= snapshot.positions.length && snapshot.positions.every(validPosition) &&
      new Set(snapshot.positions.map(p => p.key)).size === snapshot.positions.length;
  }
  function validOrder(r) {
    return r && ['symbol', 'side', 'positionSide', 'type'].every(key => isText(r[key])) &&
      ['executedQty', 'avgPrice', 'totalPnl'].every(key => decimal(r[key])) && ms(r.orderTime) && ms(r.orderUpdateTime);
  }
  function validClosed(r) {
    return r && ['symbol', 'side', 'status'].every(key => isText(r[key])) &&
      ['avgCost', 'avgClosePrice', 'closingPnl', 'closedVolume', 'leverage'].every(key => decimal(r[key])) &&
      ms(r.opened) && (r.closed === null || r.closed === 0 || ms(r.closed));
  }
  function historyView(part, validator, now, requestFailed, orders) {
    if (!part || !['ready', 'stale', 'unavailable'].includes(part.status) || part.complete !== false ||
        !iso(part.fetchedAt) || !Array.isArray(part.rows) || part.rows.length > 5000 || !part.rows.every(validator)) {
      return { state: 'unavailable', rows: [], fetchedAt: null, count: 0 };
    }
    if (part.status === 'unavailable') return { state: 'unavailable', rows: [], fetchedAt: part.fetchedAt, count: 0 };
    const state = part.status === 'stale' || requestFailed || old(part.fetchedAt, now) ? 'stale' : 'ready';
    const rows = orders ? part.rows.filter(r => r.orderTime >= Date.parse(part.fetchedAt) - 7 * DAY &&
      r.orderTime <= Date.parse(part.fetchedAt) + 300000).slice().sort((a, b) => b.orderTime - a.orderTime) :
      part.rows.slice().sort((a, b) => (b.closed || b.opened) - (a.closed || a.opened));
    return { state, fetchedAt: part.fetchedAt, rows: rows.slice(0, LIMIT), count: rows.length };
  }
  function viewModel(data, now, requestFailed) {
    const emptyHistory = { state: 'unavailable', rows: [], fetchedAt: null, count: 0 };
    if (!data) return { state: 'unavailable', reason: '尚无已核验快照，不能判断是否空仓。', positions: null,
      observations: [], orders: emptyHistory, closed: emptyHistory };
    parseFeed(data);
    const restricted = data.profile.visibility === 'restricted' || data.source.status === 'restricted';
    const visible = !restricted && data.profile.visibility === 'public';
    const snapshot = visible && validSnapshot(data.snapshot) ? data.snapshot : null;
    let state = restricted ? 'restricted' : 'unavailable';
    if (snapshot) state = data.source.status === 'ready' && !data.source.refreshStopped && !requestFailed &&
      !old(snapshot.observedAt, now) && !old(data.source.lastSuccessAt, now) ? 'ready' : 'stale';
    const reasons = {
      ready: '显示最近一次成功采集的完整仓位快照；并非逐笔实时成交。',
      stale: requestFailed ? '本站快照读取失败，保留上次资料及原时间；当前仓位未知。' :
        (data.source.refreshStopped ? '来源采集已停止，保留上次快照；当前仓位未知。' :
          '来源采集失败、未更新或超过 30 分钟，以下为上次快照；当前仓位未知。'),
      restricted: '仓位已隐藏或来源访问受限，暂停展示仓位与交易样本；不能判断是否空仓。',
      unavailable: visible ? '尚无有效的完整仓位快照，不能判断是否空仓。' : '仓位可见性尚未核验，不能判断是否空仓。'
    };
    const observations = visible && Array.isArray(data.observations) ? data.observations.filter(o =>
      o && isText(o.id) && Object.hasOwn(kinds, o.kind) && isText(o.symbol) && isText(o.side) && iso(o.to) &&
      (o.from === null || iso(o.from)) && (o.before === null || decimal(o.before)) && (o.after === null || decimal(o.after))
    ).slice().sort((a, b) => Date.parse(b.to) - Date.parse(a.to)).slice(0, LIMIT) : [];
    return { state, reason: reasons[state], positions: snapshot ? snapshot.positions.filter(p => nonzero(p.quantity)) : null,
      observedAt: snapshot && snapshot.observedAt, rawCount: snapshot && snapshot.rawCount, observations,
      orders: visible ? historyView(data.history && data.history.orders, validOrder, now, requestFailed, true) : emptyHistory,
      closed: visible ? historyView(data.history && data.history.closedPositions, validClosed, now, requestFailed, false) : emptyHistory };
  }
  function changeText(o) {
    const prefix = o.symbol + ' · ' + (sides[o.side] || o.side) + ' · ' + kinds[o.kind];
    if (o.kind === 'baseline') return prefix + '：' + str(o.after) + '（不作为新开仓）';
    return prefix + '：' + str(o.before) + ' → ' + str(o.after);
  }
  function render(doc, data, now, requestFailed) {
    const view = viewModel(data, now, requestFailed);
    const set = (id, value) => { doc.getElementById(id).textContent = str(value); };
    const badge = doc.getElementById('status-badge');
    badge.textContent = labels[view.state];
    badge.dataset.state = view.state;
    set('status-message', view.reason);
    set('trader-name', data ? data.profile.name : '爱喝快乐肥宅水');
    set('portfolio-id', PORTFOLIO_ID);
    doc.getElementById('source-link').href = sourceUrl(data && data.profile.sourceUrl);
    set('visibility', data ? ({ public: '公开', restricted: '受限 / 隐藏', unknown: '尚未核验' })[data.profile.visibility] : '尚未核验');
    set('profile-status', data && data.profile.status);
    set('last-success', time(data && data.source.lastSuccessAt));
    set('last-attempt', time(data && data.source.lastAttemptAt));
    set('positions-count', view.positions === null ? '状态未知' : view.positions.length + ' 个非零仓位');
    set('positions-note', view.positions === null ? '没有可展示的完整快照；数据缺失不等于空仓。' :
      (view.state === 'stale' ? '上次快照 · ' : '快照时间 · ') + time(view.observedAt) +
      ' · 来源 ' + view.rawCount + ' 条记录；只展示非零仓位。');
    function table(id, rows, width, message, fields) {
      const body = doc.getElementById(id);
      body.replaceChildren();
      if (!rows || !rows.length) {
        const tr = doc.createElement('tr'), td = doc.createElement('td');
        td.colSpan = width; td.className = 'empty-cell'; td.textContent = message; tr.append(td); body.append(tr); return;
      }
      rows.forEach(row => {
        const tr = doc.createElement('tr');
        fields(row).forEach(value => {
          const td = doc.createElement('td');
          if (value && typeof value === 'object') {
            td.textContent = str(value.value);
            if (decimal(value.value) && nonzero(value.value)) td.dataset.sign = value.value.startsWith('-') ? 'negative' : 'positive';
          } else td.textContent = str(value);
          tr.append(td);
        });
        body.append(tr);
      });
    }
    table('positions-body', view.positions, 8, view.positions === null ? '暂无有效仓位数据。' :
      (view.state === 'stale' ? '上次成功快照未见非零仓位，当前状态未知。' : '该次完整快照未见非零仓位。'),
    p => [p.symbol, sides[p.side] || p.side, p.quantity, p.entryPrice, p.markPrice, p.leverage + '×', { value: p.unrealizedPnl }, p.collateral]);
    const timeline = doc.getElementById('observations');
    timeline.replaceChildren();
    set('observations-note', view.observations.length ? '最近 ' + view.observations.length + ' 条观察；时间区间代表两次采样，不是成交时间。' : '暂无可展示的观察记录；不代表没有交易。');
    view.observations.forEach(o => {
      const li = doc.createElement('li'), title = doc.createElement('strong'), detail = doc.createElement('p');
      title.textContent = changeText(o);
      detail.textContent = (o.from ? time(o.from) + ' → ' : '记录于 ') + time(o.to);
      li.append(title, detail); timeline.append(li);
    });
    function sampleNote(part, orders) {
      if (part.state === 'unavailable') return '样本不可用或未核验；不能据此判断没有交易。';
      return (part.state === 'stale' ? '样本过期 · ' : '样本采集于 ') + time(part.fetchedAt) + ' · ' +
        (orders ? '窗口截至采样时刻，向前 7 天 · ' : '') + '展示 ' + part.rows.length + ' / ' + part.count +
        ' 条本地样本。来源历史未核实完整，不是完整交割单。';
    }
    set('orders-note', sampleNote(view.orders, true));
    set('history-note', sampleNote(view.closed, false));
    table('orders-body', view.orders.rows, 8, view.orders.state === 'unavailable' ? '订单样本暂不可用。' :
      '该次采样窗口内没有返回订单样本，不代表没有交易。',
    r => [time(r.orderTime), r.symbol, (sides[r.side] || r.side) + ' / ' + (sides[r.positionSide] || r.positionSide),
      r.type, r.executedQty, r.avgPrice, { value: r.totalPnl }, time(r.orderUpdateTime)]);
    table('history-body', view.closed.rows, 8, view.closed.state === 'unavailable' ? '历史仓位样本暂不可用。' :
      '该次采样没有返回历史仓位，不代表没有历史交易。',
    r => [r.symbol + ' / ' + (sides[r.side] || r.side), time(r.opened), time(r.closed), r.avgCost,
      r.avgClosePrice, r.closedVolume, { value: r.closingPnl }, r.status + ' / ' + r.leverage + '×']);
    return view;
  }
  function start(doc, env) {
    let feed = null, requestFailed = false, busy = false, stopped = false, controller = null;
    const button = doc.getElementById('refresh');
    function paint() { render(doc, feed, Date.now(), requestFailed); }
    async function refresh() {
      if (stopped || busy || doc.visibilityState !== 'visible') return;
      busy = true; button.disabled = true;
      controller = new env.AbortController();
      const timeout = env.setTimeout(() => controller && controller.abort(), 12000);
      doc.getElementById('refresh-status').textContent = '正在检查本站快照…';
      try {
        const response = await env.fetch('./snapshot.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
        if (!response.ok) throw new Error('HTTP_' + response.status);
        const text = await response.text();
        if (text.length > 2000000) throw new Error('SNAPSHOT_TOO_LARGE');
        const next = parseFeed(JSON.parse(text));
        if ((next.snapshot !== null && !validSnapshot(next.snapshot)) || (next.source.status === 'ready' && !validSnapshot(next.snapshot))) throw new Error('SNAPSHOT_SCHEMA');
        if (stopped || doc.visibilityState !== 'visible') return;
        feed = next; requestFailed = false;
        doc.getElementById('refresh-status').textContent = '已检查本站快照 · ' + time(Date.now());
      } catch (_) {
        if (stopped || doc.visibilityState !== 'visible') return;
        requestFailed = true;
        doc.getElementById('refresh-status').textContent = '读取本站快照失败；' + (feed ? '保留上次资料。' : '尚无可展示资料。');
      } finally {
        env.clearTimeout(timeout); controller = null; busy = false; button.disabled = false;
        if (!stopped) paint();
      }
    }
    function visibilityChanged() {
      if (doc.visibilityState === 'visible') { paint(); refresh(); }
      else if (controller) controller.abort();
    }
    button.addEventListener('click', refresh);
    doc.addEventListener('visibilitychange', visibilityChanged);
    const poll = env.setInterval(refresh, POLL_MS);
    const age = env.setInterval(() => { if (doc.visibilityState === 'visible') paint(); }, 60000);
    function destroy() {
      stopped = true;
      if (controller) controller.abort();
      env.clearInterval(poll); env.clearInterval(age);
      button.removeEventListener('click', refresh);
      doc.removeEventListener('visibilitychange', visibilityChanged);
    }
    paint(); refresh();
    return { refresh, destroy };
  }
  return { PORTFOLIO_ID, MAX_AGE, POLL_MS, parseFeed, viewModel, changeText, sourceUrl, render, start };
});
