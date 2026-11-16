'use strict';
(() => {
  const input = document.querySelector('#crypto-query');
  const count = document.querySelector('#crypto-filter-count');
  const mount = document.querySelector('[data-crypto-feed]');
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let focused = '';

  function filter() {
    const term = input.value.trim().toUpperCase().replace(/[-/\s]/g,'');
    const rows = mount.querySelectorAll('[data-crypto-symbol]');
    let visible = 0;
    for (const row of rows) {
      const searchable = row.dataset.cryptoSymbol + ' ' + row.querySelector('a').textContent.toUpperCase();
      row.hidden = !searchable.includes(term);
      if (!row.hidden) visible++;
    }
    const message = rows.length ? term ? '匹配 ' + visible + ' / ' + rows.length : '' : '';
    if (count.textContent !== message) count.textContent = message;
  }

  function enhance(event) {
    const latest = new Map(event.detail.quotes.map(quote => [quote.id,quote]));
    const mostRecent = Math.max(0,...event.detail.quotes.map(q => q.ts));
    if (mostRecent) {
      const status = mount.querySelector('[data-crypto-status]');
      const prefix = mount.dataset.cryptoState === 'stale' ? '来源暂未更新 · 最近报价 ' : 'Bitget 最近报价 ';
      status.textContent = prefix + timeFormat.format(mostRecent) + ' 北京时间';
    }
    for (const row of mount.querySelectorAll('.crypto-quote-row')) {
      const name = row.querySelector('div:first-child strong');
      const id = row.querySelector('div:first-child small').textContent;
      const symbol = id.replace('-', '');
      row.dataset.cryptoSymbol = symbol;
      const link = document.createElement('a');
      link.href = 'chart.html?tvwidgetsymbol=' + encodeURIComponent('BITGET:' + symbol);
      link.dataset.coinLink = symbol;
      link.setAttribute('aria-label', name.textContent + ' ' + id + ' 图表');
      name.replaceWith(link);
      link.append(name);
      const quote = latest.get(id);
      if (quote) {
        const time = document.createElement('time');
        time.dateTime = new Date(quote.ts).toISOString();
        time.textContent = timeFormat.format(quote.ts);
        time.title = new Date(quote.ts).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) + ' 北京时间';
        row.querySelector('.crypto-quote-source').replaceChildren(time);
      }
    }
    filter();
    if (focused && document.activeElement === document.body) {
      const anchor = mount.querySelector('[data-coin-link="' + focused + '"]');
      if (anchor && !anchor.closest('[hidden]')) anchor.focus({preventScroll:true});
    }
  }
  document.addEventListener('focusin', e => { focused = e.target.closest('[data-coin-link]')?.dataset.coinLink || ''; });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('[data-coin-link]')) focused = ''; });
  input.addEventListener('input', filter);
  document.addEventListener('books:bitget-quotes', enhance);
})();
