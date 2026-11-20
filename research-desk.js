'use strict';

(() => {
  const host = document.querySelector('[data-closing-ranks]');
  if (!host) return;
  const status = host.querySelector('[data-closing-status]');
  const lists = host.querySelector('[data-closing-lists]');

  function rankGroup(title, rows) {
    const group = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('ol');
    for (const {name, code} of rows) {
      const item = document.createElement('li');
      const company = document.createElement('strong');
      company.textContent = name;
      const ticker = document.createElement('span');
      ticker.textContent = code;
      item.append(company, ticker);
      list.append(item);
    }
    group.append(heading, list);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = '本批没有符合该方向的证券。';
      group.append(empty);
    }
    return group;
  }

  let displayedAt = -Infinity;
  function show(batch, origin) {
    const valid = side => Array.isArray(batch[side]) && batch[side].length <= 3 &&
      batch[side].every(row => row && typeof row.name === 'string' && row.name.trim() && /^\d{6}$/.test(row.code));
    const stamp = Date.parse(batch.asOf);
    if (!Number.isFinite(stamp) || stamp > Date.now() + 300000 || !Number.isInteger(batch.priced) ||
        batch.priced < 1 || !valid('gainers') || !valid('losers')) throw Error('invalid snapshot');
    if (stamp < displayedAt || stamp === displayedAt && host.dataset.origin === 'upstream') return;
    const day = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(stamp));
    const time = document.createElement('time');
    time.dateTime = batch.asOf;
    time.textContent = day;
    status.replaceChildren(time, ' 收盘 · ' + batch.priced.toLocaleString('zh-CN') + ' 只有效报价 · ' +
        (origin === 'upstream' ? '来源快照' : '本站归档'));
    lists.replaceChildren(rankGroup('涨幅前三',batch.gainers), rankGroup('跌幅前三',batch.losers));
    displayedAt = stamp;
    host.dataset.state = 'ready';
    host.dataset.origin = origin;
  }
  async function read(url, origin) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);
    try {
      const response = await fetch(url, {signal:controller.signal, cache:'no-cache', credentials:'omit', referrerPolicy:'no-referrer'});
      if (!response.ok) throw Error('snapshot unavailable');
      const snapshot = await response.json();
      show(origin === 'upstream' ? window.BooksDailyMovers.summarize(snapshot) : snapshot, origin);
      if (origin === 'upstream') window.BooksStockSelection?.accept(snapshot, origin);
    } finally {
      clearTimeout(timeout);
    }
  }
  const remote = '/api/a-share-daily/market';
  let pending, requestedGeneration = null;
  function refresh(event) {
    if (event?.detail?.generation) requestedGeneration = event.detail.generation;
    if (pending) return pending;
    const generation = requestedGeneration;
    const button=document.getElementById('pick-refresh');
    if (button) button.disabled=true;
    const url = generation ? remote+'?generation='+encodeURIComponent(generation) : remote;
    pending=read(url,'upstream').catch(()=>window.BooksStockSelection?.unavailable()).finally(()=>{
      pending=null;
      if (button) button.disabled=false;
      if (requestedGeneration !== generation) refresh();
    });
    return pending;
  }
  window.addEventListener('books:refresh-selection',refresh);
  Promise.allSettled([read('../research-data/a-daily-movers.json','bundled'),refresh()]).then(() => {
    if (Number.isFinite(displayedAt)) return;
    status.textContent = '本站与来源收盘快照均未能读取，可打开原始来源核对。';
    host.dataset.state = 'unavailable';
  });
})();

(() => {
  const host = document.querySelector('[data-issuer-research]');
  const source = window.BooksUsIssuerFeed;
  if (!host || !source) return;
  const rows = host.querySelector('[data-disclosure-rows]');
  const status = host.querySelector('[data-disclosure-status]');
  const button = host.querySelector('[data-disclosure-refresh]');
  const known = new Set(Array.from(rows.querySelectorAll('a'), link => link.href));
  const archiveMessage = '已有原文按发行人发布日期展示。';
  let pending = null;
  function note(message, state) {
    status.textContent = message;
    host.dataset.state = state;
  }
  function add(event) {
    if (known.has(event.sourceUrl)) return;
    const item = document.createElement('li');
    const day = event.publishedAt.slice(0,10);
    const date = document.createElement('time');
    date.dateTime = day;
    date.textContent = day;
    const detail = document.createElement('div');
    const company = document.createElement('span');
    company.textContent = '英伟达 · NVDA';
    const link = document.createElement('a');
    link.href = event.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = event.title;
    const kind = document.createElement('small');
    kind.textContent = event.kind === 'earnings_schedule' ? '财报会议预告 · 官方 RSS' : '业绩公告标题 · 官方 RSS';
    detail.append(company, link, kind);
    item.append(date, detail);
    const next = Array.from(rows.children).find(row => row.querySelector('time').dateTime < day);
    rows.insertBefore(item, next || null);
    known.add(event.sourceUrl);
  }
  async function refresh() {
    if (pending || document.hidden) return;
    try {
      if (localStorage.getItem(source.STOP_KEY)) {
        button.disabled = true;
        note('官方 RSS 已暂停访问。' + archiveMessage,'archive');
        return;
      }
    } catch {
      note('当前浏览器无法读取来源状态。' + archiveMessage,'archive');
      return;
    }
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    button.disabled = true;
    note('正在核对英伟达财报标题。' + archiveMessage, 'checking');
    try {
      const response = await fetch(source.FEED_URL, {credentials:'omit', redirect:'error', cache:'no-store', signal:controller.signal});
      if ([403,429].includes(response.status)) {
        host.dataset.stopped = 'true';
        try { localStorage.setItem(source.STOP_KEY,JSON.stringify({reason:'http_'+response.status,stoppedAt:new Date().toISOString()})); } catch {}
      }
      if (!response.ok || response.redirected) throw Error('RSS unavailable');
      const {xml} = await source.readResponse(response,controller.signal);
      const events = source.parse(xml);
      events.forEach(add);
      note('英伟达官方 RSS 已核对 · 本次含 ' + events.length + ' 条财报相关标题。' + archiveMessage,'ready');
    } catch {
      note('英伟达官方 RSS 本次未能读取。' + archiveMessage, 'archive');
    } finally {
      clearTimeout(timeout);
      pending = null;
      button.disabled = host.dataset.stopped === 'true';
    }
  }
  button.hidden = false;
  button.addEventListener('click', refresh);
  window.addEventListener('pagehide', () => pending?.abort());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pending?.abort();
    else if (!host.dataset.state) refresh();
  });
  refresh();
})();
