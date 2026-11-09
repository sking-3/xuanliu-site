'use strict';
(() => {
  const symbols = new Map([
    ['SSE:000001','上证指数'], ['SZSE:399001','深证成指'], ['SZSE:399006','创业板指'],
    ['SSE:600519','贵州茅台'], ['SZSE:000001','平安银行'], ['SZSE:300750','宁德时代'],
    ['NASDAQ:AAPL','Apple'], ['NASDAQ:MSFT','Microsoft'], ['NASDAQ:NVDA','NVIDIA'],
    ['NASDAQ:AMZN','Amazon'], ['NASDAQ:GOOGL','Alphabet'], ['NASDAQ:META','Meta'], ['NASDAQ:TSLA','Tesla'],
    ['COINBASE:BTCUSD','Bitcoin / USD'], ['COINBASE:ETHUSD','Ethereum / USD'], ['COINBASE:SOLUSD','Solana / USD']
  ]);
  const requested = new URLSearchParams(location.search).get('tvwidgetsymbol');
  const symbol = requested && requested.toUpperCase();
  const title = document.getElementById('chart-title');
  const status = document.getElementById('chart-status');
  const retry = document.getElementById('chart-retry');
  if (!symbols.has(symbol)) {
    title.textContent = '请选择行情标的';
    status.textContent = '此链接未包含本站支持的标的。请返回市场，从行情列表选择。';
    retry.hidden = true;
    return;
  }
  title.textContent = symbols.get(symbol);
  document.title = symbols.get(symbol) + ' · K线 · Books';
  document.getElementById('chart-symbol').textContent = symbol;
  document.getElementById('chart-data-note').textContent = symbol.startsWith('SSE:') || symbol.startsWith('SZSE:')
    ? 'A股日终数据，非盘中实时。可用性以 TradingView 组件为准。'
    : symbol.startsWith('COINBASE:') ? 'Coinbase 现货 / USD。报价时间与可用性以 TradingView 组件为准。'
    : '美股行情可能延迟。报价时间与可用性以 TradingView 组件为准。';
  let generation = 0, timer, observer;
  function mount() {
    const current = ++generation;
    clearTimeout(timer);
    if (observer) observer.disconnect();
    const host = document.getElementById('chart-widget');
    host.replaceChildren();
    status.textContent = '正在请求第三方K线。图表及数据是否可用，请以组件内显示为准。';
    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    const slot = document.createElement('div');
    slot.className = 'tradingview-widget-container__widget';
    container.append(slot);
    const credit = document.createElement('div');
    credit.className = 'tradingview-widget-copyright';
    const source = document.createElement('a');
    source.href = 'https://www.tradingview.com/';
    source.target = '_blank'; source.rel = 'noopener nofollow';
    source.textContent = 'Track all markets on TradingView';
    credit.append(source); container.append(credit); host.append(container);
    observer = new MutationObserver(() => {
      const frame = container.querySelector('iframe');
      if (frame && current === generation) {
        frame.title = symbols.get(symbol) + ' K线图（TradingView）';
        status.textContent = '已嵌入第三方图表；不代表已取得行情。数据、时间与错误提示以组件内显示为准。';
        clearTimeout(timer); observer.disconnect();
      }
    });
    observer.observe(container, {childList:true, subtree:true});
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.textContent = JSON.stringify({autosize:true, symbol, interval:'D', timezone:'Asia/Shanghai', theme:'light', style:'1', locale:'zh_CN', allow_symbol_change:false, calendar:false, hide_top_toolbar:false, hide_legend:false, support_host:'https://www.tradingview.com'});
    script.onerror = () => { if (current === generation) { clearTimeout(timer); status.textContent = '第三方图表脚本未能加载，请重试。本站不会用模拟K线替代。'; } };
    timer = setTimeout(() => { if (current === generation) status.textContent = '图表尚未确认加载，可能受网络或来源限制。可重试；空白不代表零价格。'; }, 15000);
    container.append(script);
  }
  retry.addEventListener('click', mount);
  mount();
})();
