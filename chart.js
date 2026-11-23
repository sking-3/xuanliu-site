'use strict';
(() => {
  const symbols = new Map([
    ['SSE:000001','上证指数'], ['SZSE:399001','深证成指'], ['SZSE:399006','创业板指'],
    ['SSE:000688','科创50'], ['HSI:HSI','恒生指数'], ['FRED:NDQCOM','纳斯达克综合'],
    ['SSE:000300','沪深300'], ['SSE:000905','中证500'], ['HSI:HSCEI','恒生国企指数'],
    ['NASDAQ:IXIC','纳斯达克综合'], ['NASDAQ:NDX','纳斯达克100'], ['SP:SPX','标普500'], ['DJ:DJI','道琼斯工业平均指数'],
    ['SSE:600519','贵州茅台'], ['SSE:601398','工商银行'], ['SSE:600036','招商银行'], ['SSE:601318','中国平安'],
    ['SZSE:000858','五粮液'], ['SZSE:000333','美的集团'], ['SZSE:002594','比亚迪'], ['SZSE:000001','平安银行'], ['SZSE:300750','宁德时代'],
    ['NASDAQ:AAPL','Apple'], ['NASDAQ:MSFT','Microsoft'], ['NASDAQ:NVDA','NVIDIA'],
    ['NASDAQ:AMZN','Amazon'], ['NASDAQ:GOOGL','Alphabet'], ['NASDAQ:META','Meta'], ['NASDAQ:TSLA','Tesla'],
      ['BITGET:BTCUSDT','Bitcoin / USDT'], ['BITGET:ETHUSDT','Ethereum / USDT'], ['BITGET:SOLUSDT','Solana / USDT'], ['BITGET:XRPUSDT','XRP / USDT'], ['BITGET:DOGEUSDT','Dogecoin / USDT'], ['BITGET:ADAUSDT','Cardano / USDT'], ['BITGET:AVAXUSDT','Avalanche / USDT'], ['BITGET:LINKUSDT','Chainlink / USDT'], ['BITGET:DOTUSDT','Polkadot / USDT'], ['BITGET:LTCUSDT','Litecoin / USDT'], ['BITGET:BCHUSDT','Bitcoin Cash / USDT'], ['BITGET:UNIUSDT','Uniswap / USDT'], ['BITGET:AAVEUSDT','Aave / USDT'], ['BITGET:NEARUSDT','NEAR / USDT'], ['BITGET:ATOMUSDT','Cosmos / USDT'], ['BITGET:FILUSDT','Filecoin / USDT'], ['BITGET:XLMUSDT','Stellar / USDT'], ['BITGET:SHIBUSDT','Shiba Inu / USDT'], ['BITGET:SUIUSDT','Sui / USDT'], ['BITGET:PEPEUSDT','Pepe / USDT'],
  ]);
  const params = new URLSearchParams(location.search);
  const requested = params.get('tvwidgetsymbol');
  const requestedKind = params.get('kind');
  const qualified = /^[A-Z][A-Z0-9_]{0,19}:[A-Z0-9][A-Z0-9._-]{0,26}$/;
  const declared = ['stock','index'].includes(requestedKind);
  const knownIndex = key => globalThis.BooksChartOutlook?.isIndex(key)
    || /^(?:SSE:000|SZSE:399)\d{3}$/.test(key);
  let symbol = requested && requested.toUpperCase();
  const title = document.getElementById('chart-title');
  const status = document.getElementById('chart-status');
  const retry = document.getElementById('chart-retry');
  const form = document.getElementById('chart-symbol-form');
  form?.addEventListener('submit',event => {
    event.preventDefault();
    const code = form.elements.tvwidgetsymbol.value.trim().toUpperCase();
    const kind = form.elements.kind.value;
    const error = document.getElementById('chart-symbol-error');
    if (!qualified.test(code)) {
      error.textContent = '请输入带市场前缀的代码，例如 SP:SPX 或 NASDAQ:AAPL。';
      error.hidden = false;
      return;
    }
    const url = new URL('chart.html',location.href);
    url.searchParams.set('tvwidgetsymbol',code);
    url.searchParams.set('kind',knownIndex(code) ? 'index' : kind);
    location.assign(url.href);
  });
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
  const typedSymbol = declared && qualified.test(symbol || '');
  if (!symbols.has(symbol) && !aShareSymbol && !usSymbol && !typedSymbol) {
    title.textContent = '请选择行情标的';
    status.textContent = '此链接未包含本站支持的标的。请返回市场，从行情列表选择。';
    retry.hidden = true;
    document.getElementById('chart-widget').hidden = true;
    document.getElementById('chart-picker').open = true;
    return;
  }
  const kind = knownIndex(symbol) ? 'index' : symbols.has(symbol) ? 'stock' : declared ? requestedKind : 'stock';
  if (form?.elements) {
    form.elements.tvwidgetsymbol.value = symbol;
    form.elements.kind.value = kind;
  }
  if (requested !== symbol || declared && requestedKind !== kind) {
    const canonicalUrl = new URL(location.href);
    canonicalUrl.searchParams.set('tvwidgetsymbol', symbol);
    if (declared) canonicalUrl.searchParams.set('kind', kind);
    history.replaceState(history.state, '', canonicalUrl.href);
  }
  document.querySelectorAll('[data-chart-symbol]').forEach(link => {
    if (link.dataset.chartSymbol === symbol) link.setAttribute('aria-current', 'page');
  });
  const marketBack = document.querySelector('.chart-back');
  if (usSymbol) { marketBack.href = 'us.html'; marketBack.textContent = '← 返回美股行情'; }
  else if (symbol.startsWith('BITGET:')) { marketBack.href = 'crypto.html'; marketBack.textContent = '← 返回加密行情'; }
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
    : symbol.startsWith('BITGET:') ? 'Bitget 现货 / USDT。报价时间与可用性以图表显示为准。'
    : usSymbol ? '美股行情可能延迟。报价时间与可用性以图表显示为准。'
    : '行情日期、时区与可用范围以图表显示为准。';
  const sourceLink = document.getElementById('chart-source');
  sourceLink.href = symbol.startsWith('BITGET:')
    ? 'https://www.bitget.com/spot/' + symbol.split(':')[1]
    : symbol.startsWith('FRED:') ? 'https://fred.stlouisfed.org/series/' + symbol.split(':')[1]
    : 'https://www.tradingview.com/symbols/' + symbol.replace(':','-') + '/';
  sourceLink.hidden = false;
  let generation = 0, timer, observer;
  function mount() {
    const current = ++generation;
    clearTimeout(timer);
    if (observer) observer.disconnect();
    const host = document.getElementById('chart-widget');
    host.hidden = false;
    host.dataset.chartState = 'loading';
    host.replaceChildren();
    retry.disabled = true;
    status.textContent = '正在连接图表来源…';
    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    const slot = document.createElement('div');
    slot.className = 'tradingview-widget-container__widget';
    container.append(slot);
    host.append(container);
    function unavailable() {
      if (current !== generation || host.dataset.chartState !== 'loading') return;
      observer.disconnect();
      clearTimeout(timer);
      host.dataset.chartState = 'unavailable';
      host.replaceChildren();
      host.hidden = true;
      retry.disabled = false;
      status.textContent = '图表来源未响应。可重试，或打开此标的的来源页。';
    }
    observer = new MutationObserver(() => {
      const frame = container.querySelector('iframe');
      if (!frame || current !== generation) return;
      observer.disconnect();
      frame.title = symbolName + ' ' + chartKind + '（TradingView）';
      frame.addEventListener('load', () => {
        if (current !== generation || host.dataset.chartState !== 'loading') return;
        host.dataset.chartState = 'frame-loaded';
        clearTimeout(timer);
        retry.disabled = false;
        status.textContent = '来源图表已打开。价格与行情日期见图内标注。';
      }, {once:true});
      frame.addEventListener('error', unavailable, {once:true});
    });
    observer.observe(container, {childList:true, subtree:true});
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.textContent = JSON.stringify({autosize:true, symbol, interval:'D', timezone:'Asia/Shanghai', theme:'light', style:closeOnly ? '3' : '1', locale:'zh_CN', allow_symbol_change:false, calendar:false, hide_top_toolbar:false, hide_legend:false, support_host:'https://www.tradingview.com'});
    script.onerror = unavailable;
    timer = setTimeout(unavailable, 15000);
    container.append(script);
  }
  retry.addEventListener('click', mount);
  mount();
  if (!symbol.startsWith('BITGET:')) globalThis.BooksChartOutlook?.mount({symbol,name:symbolName,kind});
})();
