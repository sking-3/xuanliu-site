'use strict';
(() => {
  const section = document.getElementById('index-ticker');
  if (!section) return;
  const host = document.getElementById('index-ticker-widget');
  const status = document.getElementById('index-ticker-status');
  const retry = document.getElementById('index-ticker-retry');
  const config = JSON.parse(section.querySelector('[data-ticker-config]').textContent);
  let generation = 0, timer, observer;
  function mount() {
    const current = ++generation;
    clearTimeout(timer);
    if (observer) observer.disconnect();
    host.replaceChildren();
    status.textContent = '正在加载指数报价…';
    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    const slot = document.createElement('div');
    slot.className = 'tradingview-widget-container__widget';
    container.append(slot);
    const credit = document.createElement('div');
    credit.className = 'tradingview-widget-copyright';
    const link = document.createElement('a');
    link.href = 'https://www.tradingview.com/markets/indices/';
    link.target = '_blank'; link.rel = 'noopener nofollow';
    link.textContent = 'Indices by TradingView';
    credit.append(link); container.append(credit); host.append(container);
    observer = new MutationObserver(() => {
      const frame = container.querySelector('iframe');
      if (frame && current === generation) {
        frame.title = '指数点位与涨跌幅（TradingView 日终行情）';
        status.textContent = '报价与更新状态以行情条内显示为准；若为空白或出现错误，可重新加载。';
        clearTimeout(timer); observer.disconnect();
      }
    });
    observer.observe(container, {childList:true, subtree:true});
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js';
    script.async = true;
    script.textContent = JSON.stringify(config);
    script.onerror = () => {
      if (current !== generation) return;
      clearTimeout(timer);
      status.textContent = '指数行情未能加载，请检查网络后重试。';
    };
    timer = setTimeout(() => {
      if (current === generation) status.textContent = '行情条尚未确认加载，可重试；无报价不代表零价格。';
    }, 15000);
    container.append(script);
  }
  retry.addEventListener('click', mount);
  mount();
})();
