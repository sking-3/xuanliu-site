'use strict';
// Provider frames update their own quotes; loading a frame never verifies prices.
(() => {
  if (window.BooksMarketFeeds) { window.BooksMarketFeeds.scan(); return; }
  const sourceScript = 'https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js';
  const states = new Map(), queue = [];
  let active = 0, suspended = false, pumping = false, viewport = null;
  function phase(s, value) { s.phase = value; s.section.setAttribute('data-feed-state', value); }
  function recovery(s, visible) {
    s.controls.hidden = !visible;
    if (s.shortcuts) s.shortcuts.hidden = !visible;
  }
  function stopWatching(s) {
    clearTimeout(s.timer); s.timer = null; s.observer?.disconnect(); s.observer = null;
    if (s.frame && s.onLoad) s.frame.removeEventListener?.('load', s.onLoad);
    s.onLoad = null;
  }
  function release(s) { if (s.loading) { s.loading = false; active--; } }
  function embedded(s, message) {
    stopWatching(s); release(s); phase(s, 'embedded');
    s.retry.disabled = false; s.status.textContent = message;
    s.area.hidden = false; recovery(s, false); pump();
  }
  function fail(s, message) {
    stopWatching(s); release(s); phase(s, 'error');
    s.retry.disabled = false; s.status.textContent = message;
    s.area.hidden = true; recovery(s, true); pump();
  }
  function watch(s) {
    const generation = s.generation, container = s.container;
    const observer = new MutationObserver(() => {
      const frame = container.querySelector('iframe');
      if (!frame || s.observer !== observer || generation !== s.generation || suspended) return;
      frame.title = s.label + '（TradingView）'; s.frame = frame;
      s.onLoad = () => {
        if (s.observer === observer && generation === s.generation && !suspended) embedded(s, '组件已载入，报价仍由来源逐项更新；价格、延迟与可用性以来源显示为准。');
      };
      frame.addEventListener('load', s.onLoad, {once:true});
      observer.disconnect();
    });
    s.observer = observer; observer.observe(container, {childList:true, subtree:true});
    s.timer = setTimeout(() => {
      if (s.observer !== observer || generation !== s.generation || suspended) return;
      if (s.area.querySelector('iframe')) embedded(s, '组件已建立，报价仍可能加载中；价格与时效以来源显示为准。');
      else fail(s, '组件未能建立，已收起空白区域。可重试或查看来源。');
    }, 15000);
  }
  function start(s) {
    const generation = ++s.generation;
    stopWatching(s); s.loading = true; active++; phase(s, 'loading');
    s.retry.disabled = true; s.status.textContent = '正在加载行情组件，报价将由来源逐项更新…';
    s.area.hidden = false; recovery(s, false); s.pendingError = false;
    const container = document.createElement('div'), widget = document.createElement('div');
    container.className = 'tradingview-widget-container'; widget.className = 'tradingview-widget-container__widget';
    container.append(widget); s.area.replaceChildren(container); s.container = container; s.frame = null;
    watch(s);
    const script = document.createElement('script'); script.src = sourceScript; script.async = true;
    script.textContent = JSON.stringify(s.config);
    script.onerror = () => {
      if (generation !== s.generation) return;
      if (suspended) s.pendingError = true;
      else fail(s, '组件加载失败，已收起空白区域。请重试或查看来源。');
    };
    container.append(script);
  }
  function eligible(s) { return s.near && !s.section.closest?.('details:not([open])'); }
  function pump() {
    if (pumping || suspended || document.hidden) return;
    pumping = true;
    try {
      while (active < 2) {
        const index = queue.findIndex(s => s.phase === 'queued' && eligible(s));
        if (index < 0) break;
        const [s] = queue.splice(index, 1); start(s);
      }
    } finally { pumping = false; }
  }
  function enqueue(s) {
    phase(s, 'queued'); s.retry.disabled = true;
    s.status.textContent = '行情组件等待载入；进入可视区域后连接来源。';
    recovery(s, false); if (!queue.includes(s)) queue.push(s); pump();
  }
  function observe(s) {
    if (viewport) viewport.observe(s.section);
    else { s.near = true; pump(); }
  }
  function createViewport() {
    if (!window.IntersectionObserver) return;
    viewport = new window.IntersectionObserver(entries => {
      for (const entry of entries) { const s = states.get(entry.target); if (s) s.near = entry.isIntersecting; }
      pump();
    }, {rootMargin:'240px 0px'});
  }
  function scan() {
    if (suspended) return;
    document.querySelectorAll('.public-feed').forEach((section, index) => {
      if (states.has(section)) return;
      const area = section.querySelector('.feed-widget-area'), status = section.querySelector('.feed-status');
      const controls = section.querySelector('.feed-controls'), retry = section.querySelector('.feed-retry');
      const configNode = section.querySelector('script[data-feed-config]');
      if (!area || !status || !controls || !retry || !configNode) return;
      const s = {section,area,status,controls,retry,shortcuts:section.querySelector('.symbol-shortcuts'),generation:0,timer:null,observer:null,frame:null,onLoad:null,loading:false,near:false,phase:null,
        label:section.querySelector('h2,h3')?.textContent || '市场行情'};
      states.set(section, s);
      if (!area.id) area.id = 'market-feed-area-' + index;
      try { s.config = JSON.parse(configNode.textContent); }
      catch { fail(s, '行情配置无法读取，请查看来源。'); retry.disabled = true; return; }
      retry.addEventListener('click', () => { if (s.phase === 'error') enqueue(s); });
      enqueue(s); observe(s);
    });
    pump();
  }
  window.addEventListener('message', event => {
    if (suspended || event.origin !== 'https://www.tradingview-widget.com') return;
    for (const s of states.values()) {
      const frame = s.area.querySelector('iframe');
      if (!frame || event.source !== frame.contentWindow) continue;
      const name = event.data && event.data.name;
      if (name === 'tv-widget-ready' || name === 'tv-widget-load') embedded(s, '组件已响应，报价由来源逐项更新；价格、延迟与可用性以来源显示为准。');
      else if (name === 'tv-widget-no-data') fail(s, '来源暂无可用数据。没有以零值或示例行情替代，可重试或查看来源。');
    }
  });
  document.addEventListener?.('visibilitychange', () => { if (!document.hidden) pump(); });
  document.addEventListener?.('toggle', event => { if (event.target?.open) pump(); }, true);
  window.addEventListener('pagehide', () => {
    suspended = true; viewport?.disconnect(); viewport = null;
    for (const s of states.values()) {
      // Retain unfinished embeds for BFCache; detaching an async script cannot cancel it safely.
      stopWatching(s); release(s);
    }
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !suspended) return;
    suspended = false;
    for (const s of states.values()) {
      if (s.phase === 'queued') s.near = false;
      if (s.phase === 'loading') { s.loading = true; active++; }
    }
    createViewport();
    for (const s of states.values()) {
      if (s.phase === 'queued') observe(s);
      else if (s.phase === 'loading') {
        if (s.pendingError) fail(s, '组件加载失败，已收起空白区域。请重试或查看来源。');
        else {
          const frame = s.area.querySelector('iframe');
          if (frame) { frame.title = s.label + '（TradingView）'; s.frame = frame; embedded(s, '已保留原组件，报价仍由来源逐项更新；价格与时效以来源显示为准。'); }
          else watch(s);
        }
      }
    }
    pump();
  });
  window.BooksMarketFeeds = {scan};
  createViewport(); scan();
})();
