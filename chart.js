'use strict';
(() => {
  const symbols = new Map([
    ['SSE:000001','上证指数'], ['SZSE:399001','深证成指'], ['SZSE:399006','创业板指'],
    ['SSE:000688','科创50'], ['HSI:HSI','恒生指数'], ['FRED:NDQCOM','纳斯达克综合'],
    ['SSE:600519','贵州茅台'], ['SZSE:000001','平安银行'], ['SZSE:300750','宁德时代'],
    ['NASDAQ:AAPL','Apple'], ['NASDAQ:MSFT','Microsoft'], ['NASDAQ:NVDA','NVIDIA'],
    ['NASDAQ:AMZN','Amazon'], ['NASDAQ:GOOGL','Alphabet'], ['NASDAQ:META','Meta'], ['NASDAQ:TSLA','Tesla'],
    ['COINBASE:USDTUSD','Tether / USD'], ['COINBASE:BTCUSD','Bitcoin / USD'], ['COINBASE:ETHUSD','Ethereum / USD'], ['COINBASE:SOLUSD','Solana / USD']
  ]);
  const requested = new URLSearchParams(location.search).get('tvwidgetsymbol');
  let symbol = requested && requested.toUpperCase();
  const title = document.getElementById('chart-title');
  const status = document.getElementById('chart-status');
  const retry = document.getElementById('chart-retry');
  if (symbol && /^[A-Z0-9]+$/.test(symbol)) {
    const matches = [...symbols.keys()].filter(key => key.split(':')[1] === symbol);
    if (matches.length === 1) symbol = matches[0];
    else if (matches.length > 1) {
      title.textContent = '请选择具体标的';
      status.textContent = '此代码对应多个市场，请选择交易所与标的；本站不会自动猜测。';
      document.getElementById('chart-symbol').textContent = symbol;
      retry.hidden = true;
      const host = document.getElementById('chart-widget');
      host.classList.add('chart-widget-empty');
      document.getElementById('chart-picker').open = true;
      const choices = document.createElement('ul');
      for (const match of matches) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = 'chart.html?tvwidgetsymbol=' + encodeURIComponent(match);
        link.textContent = symbols.get(match) + '（' + match + '）';
        item.append(link); choices.append(item);
      }
      host.replaceChildren(choices);
      return;
    }
  }
  const aShareSymbol = symbol && symbol === symbol.trim() && /^(?:SSE|SZSE):[0-9]{6}$/.test(symbol);
  // A chart identifier is a request to the fixed provider, not proof of listing or screening eligibility.
  const usSymbol = symbol && symbol === symbol.trim() && /^(?:NASDAQ|NYSE|AMEX):[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)?$/.test(symbol) && symbol.split(':')[1].length <= 20;
  if (!symbols.has(symbol) && !aShareSymbol && !usSymbol) {
    title.textContent = '请选择行情标的';
    status.textContent = '此链接未包含本站支持的标的。请返回市场，从行情列表选择。';
    retry.hidden = true;
    document.getElementById('chart-widget').hidden = true;
    document.getElementById('chart-picker').open = true;
    return;
  }
  if (requested !== symbol) {
    const canonicalUrl = new URL(location.href);
    canonicalUrl.searchParams.set('tvwidgetsymbol', symbol);
    history.replaceState(history.state, '', canonicalUrl.href);
  }
  document.querySelectorAll('[data-chart-symbol]').forEach(link => {
    if (link.dataset.chartSymbol === symbol) link.setAttribute('aria-current', 'page');
  });
  const marketBack = document.querySelector('.chart-back');
  if (usSymbol) { marketBack.href = 'us.html'; marketBack.textContent = '← 返回美股行情'; }
  else if (symbol.startsWith('COINBASE:')) { marketBack.href = 'crypto.html'; marketBack.textContent = '← 返回加密行情'; }
  else if (symbol.startsWith('SSE:') || symbol.startsWith('SZSE:')) { marketBack.href = 'a-shares.html'; marketBack.textContent = '← 返回A股行情'; }
  const closeOnly = symbol.startsWith('FRED:');
  const chartKind = closeOnly ? '日终走势' : 'K线';
  const symbolName = symbols.get(symbol) || symbol;
  title.textContent = symbolName;
  document.title = symbolName + ' · ' + chartKind + ' · Books';
  document.getElementById('chart-symbol').textContent = symbol;
  document.getElementById('chart-data-note').textContent = symbol.startsWith('SSE:') || symbol.startsWith('SZSE:')
    ? 'A股日终数据，非盘中实时。可用性以图表显示为准。'
    : symbol.startsWith('HSI:') ? '恒生指数日终数据，非盘中实时。可用性以图表显示为准。'
    : closeOnly ? '纳斯达克综合指数 · FRED 每日收盘序列，仅绘制收盘走势，不表示盘中K线。更新日期与可用性以来源为准。'
    : symbol.startsWith('COINBASE:') ? 'Coinbase 现货 / USD。报价时间与可用性以图表显示为准。'
    : '美股行情可能延迟。报价时间与可用性以图表显示为准。';
  let generation = 0, timer, observer;
  function mount() {
    const current = ++generation;
    clearTimeout(timer);
    if (observer) observer.disconnect();
    const host = document.getElementById('chart-widget');
    host.replaceChildren();
    retry.disabled = true;
    status.textContent = '正在请求第三方图表。图表及数据是否可用，请以组件内显示为准。';
    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    const slot = document.createElement('div');
    slot.className = 'tradingview-widget-container__widget';
    container.append(slot);
    host.append(container);
    observer = new MutationObserver(() => {
      const frame = container.querySelector('iframe');
      if (frame && current === generation) {
        frame.title = symbolName + ' ' + chartKind + '（TradingView）';
        status.textContent = '已嵌入第三方图表；不代表已取得行情。数据、时间与错误提示以组件内显示为准。';
        clearTimeout(timer); retry.disabled = false; observer.disconnect();
      }
    });
    observer.observe(container, {childList:true, subtree:true});
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.textContent = JSON.stringify({autosize:true, symbol, interval:'D', timezone:'Asia/Shanghai', theme:'light', style:closeOnly ? '3' : '1', locale:'zh_CN', allow_symbol_change:false, calendar:false, hide_top_toolbar:false, hide_legend:false, support_host:'https://www.tradingview.com'});
    script.onerror = () => { if (current === generation) { clearTimeout(timer); observer.disconnect(); retry.disabled = false; status.textContent = '第三方图表脚本未能加载，请重试。本站不会用模拟K线替代。'; } };
    timer = setTimeout(() => { if (current === generation) { retry.disabled = false; status.textContent = '图表尚未确认加载，可能受网络或来源限制。可重试；空白不代表零价格。'; } }, 15000);
    container.append(script);
  }
  retry.addEventListener('click', mount);
  mount();
})();
