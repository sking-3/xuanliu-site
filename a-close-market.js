'use strict';

(() => {
  const root = document.querySelector('#a-market');
  const stamp = document.querySelector('#a-close-stamp');
  const input = document.querySelector('#a-close-query');
  const count = document.querySelector('#a-close-count');
  const matches = document.querySelector('#a-close-matches');
  const health = document.querySelector('#a-close-health');
  const upstream = 'https://raw.githubusercontent.com/wenyuanw/a-share-heatmap/main/src/lib/data/market-heatmap-fallback.json';
  let currentDate = 0, symbols = [], published = false;

  function stockLink(stock) {
    const exchange = stock.exchange || (/^6/.test(stock.code) ? 'SH' : /^[03]/.test(stock.code) ? 'SZ' : 'BJ');
    const link = document.createElement('a');
    const venue = {SH:'SSE', SZ:'SZSE', BJ:'BSE'}[exchange];
    if (venue === 'BSE') {
      link.href = 'https://www.bse.cn/disclosure/announcement.html';
      link.title = '北交所信息披露';
    } else {
      link.href = 'chart.html?tvwidgetsymbol=' + encodeURIComponent(venue + ':' + stock.code);
    }
    const name = document.createElement('strong');
    name.textContent = stock.name;
    const code = document.createElement('span');
    code.textContent = stock.code;
    link.append(name, code);
    return link;
  }

  function search() {
    const query = input.value.replace(/\s/g, '').toUpperCase();
    matches.hidden = !query;
    matches.replaceChildren();
    if (!query) {
      count.textContent = published ? symbols.length.toLocaleString('zh-CN') + ' 只可检索' : symbols.length ? '当前可查本站榜单' : '正在读取证券名册';
      return;
    }
    const result = symbols.filter(s => s.name.replace(/\s/g, '').toUpperCase().includes(query) || s.code.includes(query));
    count.textContent = result.length > 20 ? '共 ' + result.length + ' 条，显示前 20 条' : '找到 ' + result.length + ' 条' + (published ? '' : ' · 本站榜单');
    for (const stock of result.slice(0, 20)) {
      const li = document.createElement('li');
      li.append(stockLink(stock));
      matches.append(li);
    }
  }

  function show(summary, source, universe) {
    const date = Date.parse(summary.asOf);
    if (!Number.isFinite(date) || date > Date.now() || date < currentDate ||
        !Number.isInteger(summary.priced) || summary.priced <= 0 ||
        !['gainers','losers'].every(key => Array.isArray(summary[key]) && summary[key].length <= 3 &&
          summary[key].every(s => s && /^\d{6}$/.test(s.code) && typeof s.name === 'string' && s.name.trim()))) return;
    if (source === 'bundled' && published) return;
    currentDate = date;
    symbols = universe || [...summary.gainers, ...summary.losers];
    published = Boolean(universe);
    const time = document.createElement('time');
    time.dateTime = summary.asOf;
    time.textContent = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(date);
    stamp.replaceChildren(time, ' 收盘 · ' + summary.priced.toLocaleString('zh-CN') + ' 只有效报价');
    root.dataset.closeSource = source;
    for (const group of root.querySelectorAll('[data-close-direction]')) {
      const list = group.querySelector('ol');
      const rows = summary[group.dataset.closeDirection];
      list.replaceChildren();
      for (const stock of rows) {
        const item = document.createElement('li');
        item.dataset.code = stock.code;
        item.append(stockLink(stock));
        list.append(item);
      }
      if (!rows.length) {
        const item = document.createElement('li'); item.textContent = '本批无此方向标的'; list.append(item);
      }
    }
    search();
  }

  async function read(url, signal) {
    const response = await fetch(url, {signal, credentials:'omit', cache:'no-cache'});
    if (!response.ok) throw Error('行情未返回');
    return response.json();
  }
  let busy = false, lastAttempt = 0;
  async function refresh() {
    if (busy || document.hidden || Date.now() - lastAttempt < 900000) return;
    busy = true;
    lastAttempt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const snapshot = await read(upstream, controller.signal);
      const summary = window.BooksDailyMovers.summarize(snapshot);
      const universe = snapshot.stocks.map(stock => ({name:stock.name.replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,''),code:stock.code.slice(0,6),exchange:stock.exchange}));
      show(summary, 'upstream', universe);
      health.textContent = '';
    } catch {
      health.textContent = '完整证券名册暂未刷新，可查看最近一次发布的收盘榜或打开来源。';
    } finally {
      clearTimeout(timeout);
      busy = false;
    }
  }

  input.addEventListener('input', search);
  read('research-data/a-daily-movers.json').then(snapshot => show(snapshot, 'bundled')).catch(() => {
    if (!currentDate) stamp.textContent = '本站暂未读到收盘快照';
  });
  refresh();
  setInterval(refresh, 900000);
  document.addEventListener('visibilitychange', refresh);
})();
