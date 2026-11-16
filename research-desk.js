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

  async function readRanks() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch('../research-data/a-daily-movers.json', {signal: controller.signal, cache: 'no-cache'});
      if (!response.ok) throw Error('snapshot unavailable');
      const batch = await response.json();
      const date = new Date(batch.asOf);
      const valid = side => Array.isArray(batch[side]) && batch[side].length <= 3 &&
        batch[side].every(row => row && typeof row.name === 'string' && row.name.trim() && /^\d{6}$/.test(row.code));
      if (!batch.asOf || !Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 300000 ||
          !Number.isInteger(batch.priced) || batch.priced < 1 || !valid('gainers') || !valid('losers')) throw Error('invalid snapshot');
      const day = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(date);
      status.textContent = day + ' 收盘 · ' + batch.priced.toLocaleString('zh-CN') + ' 只有效报价';
      lists.replaceChildren(rankGroup('涨幅前三',batch.gainers), rankGroup('跌幅前三',batch.losers));
      host.dataset.state = 'ready';
    } catch {
      status.textContent = '本站收盘快照暂时无法读取，可打开来源核对。';
      host.dataset.state = 'unavailable';
    } finally {
      clearTimeout(timeout);
    }
  }
  readRanks();
})();
