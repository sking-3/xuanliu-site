'use strict';

(() => {
  const status = document.querySelector('[data-watch-status]');
  const tags = [...document.querySelectorAll('[data-watch-symbol] tv-ticker-tag')];
  const fields = new Set(['quote/chp','symbolInfo/name']);
  const listeners = new AbortController();
  const completed = new Map();
  let deadline;
  let frame = 0;
  let finished = false;

  function readyCount() {
    return tags.filter(tag => completed.get(tag).size === fields.size
      && tag.getClientRects().length && getComputedStyle(tag).visibility === 'visible').length;
  }

  function finish(state, count) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    cancelAnimationFrame(frame);
    listeners.abort();
    document.documentElement.dataset.watchState = state;
    document.documentElement.dataset.watchCount = String(count);
    if (state === 'ready') status.hidden = true;
    else status.textContent = '日涨跌暂未完整返回，可在「报价」中查看。';
    if (window.parent !== window)
      window.parent.postMessage({type:'books:watch-widget',status:state,count},location.origin);
  }

  function check() {
    frame = 0;
    const count = readyCount();
    if (count === 8 && tags.length === 8) finish('ready',count);
  }

  // TradingView renders in closed shadow roots. Its composed loading events identify
  // the individual data consumer; completion of unrelated assets cannot qualify a row.
  for (const tag of tags) {
    const consumers = new Map();
    const current = new Map();
    const done = new Set();
    completed.set(tag,done);
    const options = {capture:true,signal:listeners.signal};
    tag.addEventListener('data-request',event => {
      const {dataType,consumerId} = event.detail || {};
      if (!fields.has(dataType) || consumerId == null) return;
      consumers.set(consumerId,dataType);
      current.set(dataType,consumerId);
      done.delete(dataType);
    },options);
    tag.addEventListener('loading-status-changed',event => {
      const {requestId,status} = event.detail || {};
      const type = consumers.get(requestId);
      if (!type || current.get(type) !== requestId) return;
      if (status === 'completed') done.add(type);
      else done.delete(type);
      if (!frame) frame = requestAnimationFrame(check);
    },options);
  }

  deadline = setTimeout(() => {
    check();
    if (!finished) finish('unavailable',readyCount());
  },14000);
  import('https://widgets.tradingview-widget.com/w/zh_CN/tv-ticker-tag.js')
    .catch(() => finish('unavailable',readyCount()));
})();
