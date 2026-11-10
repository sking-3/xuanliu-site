'use strict';
// An embedded provider frame is not proof of fresh or available quotes.
(() => {
  const sourceScript = 'https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js';
  const states = new Map();
  // Normal/loading states have no extra action rows. Recovery is error-only.
  function recovery(s, visible) {
    s.controls.hidden = !visible;
    if (s.shortcuts) s.shortcuts.hidden = !visible;
  }
  function fail(s, message) {
    clearTimeout(s.timer);
    s.observer?.disconnect();
    s.retry.disabled = false;
    s.status.textContent = message;
    s.area.hidden = true;
    recovery(s, true);
  }
  function mount(s) {
    const generation = ++s.generation;
    clearTimeout(s.timer);
    s.observer?.disconnect();
    s.retry.disabled = true;
    s.status.textContent = '正在加载行情组件…';
    s.area.hidden = false;
    recovery(s, false);
    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    container.append(widget);
    s.area.replaceChildren(container);
    s.observer = new MutationObserver(() => {
      const frame = container.querySelector('iframe');
      if (!frame || generation !== s.generation) return;
      frame.title = s.label + '（TradingView）';
      s.observer.disconnect();
    });
    s.observer.observe(container, {childList: true, subtree: true});
    const script = document.createElement('script');
    script.src = sourceScript;
    script.async = true;
    script.textContent = JSON.stringify(s.config);
    script.onerror = () => {
      if (generation === s.generation) fail(s, '组件加载失败，已收起空白区域。请重试或查看来源。');
    };
    s.timer = setTimeout(() => {
      if (generation !== s.generation) return;
      s.retry.disabled = false;
      if (s.area.querySelector('iframe')) {
        s.status.textContent = '组件已嵌入，报价与时效以来源显示为准。若空白可重试。';
      } else {
        fail(s, '组件未能建立，已收起空白区域。可重试或查看来源。');
      }
    }, 15000);
    container.append(script);
  }
  document.querySelectorAll('.public-feed').forEach((section, index) => {
    const area = section.querySelector('.feed-widget-area');
    const status = section.querySelector('.feed-status');
    const controls = section.querySelector('.feed-controls');
    const shortcuts = section.querySelector('.symbol-shortcuts');
    const retry = section.querySelector('.feed-retry');
    const configNode = section.querySelector('script[data-feed-config]');
    if (!area || !status || !controls || !retry || !configNode) return;
    const s = {area, status, controls, shortcuts, retry, generation: 0, timer: null, observer: null,
      label: section.querySelector('h2,h3')?.textContent || '市场行情'};
    if (!area.id) area.id = 'market-feed-area-' + index;
    try { s.config = JSON.parse(configNode.textContent); }
    catch { fail(s, '行情配置无法读取，请查看来源。'); retry.disabled = true; return; }
    retry.addEventListener('click', () => mount(s));
    states.set(section, s);
    mount(s);
  });
  window.addEventListener('message', event => {
    if (event.origin !== 'https://www.tradingview-widget.com') return;
    for (const s of states.values()) {
      const frame = s.area.querySelector('iframe');
      if (!frame || event.source !== frame.contentWindow) continue;
      const name = event.data && event.data.name;
      if (name === 'tv-widget-ready' || name === 'tv-widget-load') {
        clearTimeout(s.timer);
        s.retry.disabled = false;
        s.status.textContent = '组件已响应，价格、延迟与可用性以来源显示为准。';
        s.area.hidden = false;
        recovery(s, false);
      } else if (name === 'tv-widget-no-data') {
        fail(s, '来源暂无可用数据。没有以零值或示例行情替代，可重试或查看来源。');
      }
    }
  });
})();
