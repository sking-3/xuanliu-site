'use strict';

(() => {
  const status = document.querySelector('[data-watch-status]');
  const tags = [...document.querySelectorAll('[data-watch-symbol] tv-ticker-tag')];
  const expected = 8;
  let interval;
  let deadline;
  let finished = false;

  function hasQuote(tag) {
    const pill = tag.shadowRoot?.querySelector('tv-ticker-pill');
    const value = pill?.shadowRoot?.querySelector('.change');
    return Boolean(value && value.getClientRects().length && getComputedStyle(value).visibility === 'visible'
      && /^[+−-]?\d+(?:[.,]\d+)?\s*%$/.test(value.textContent.trim()));
  }

  function finish(state, count) {
    if (finished) return;
    finished = true;
    clearInterval(interval);
    clearTimeout(deadline);
    document.documentElement.dataset.watchState = state;
    if (state === 'ready') {
      status.hidden = true;
    } else {
      status.textContent = '日涨跌暂未完整返回，可在「报价」中查看。';
    }
    if (window.parent !== window)
      window.parent.postMessage({type:'books:watch-widget',status:state,count},location.origin);
  }

  function verify(atDeadline = false) {
    const count = tags.filter(hasQuote).length;
    if (count === expected && tags.length === expected) finish('ready',count);
    else if (atDeadline) finish('unavailable',count);
  }

  deadline = setTimeout(() => verify(true),14000);
  import('https://widgets.tradingview-widget.com/w/zh_CN/tv-ticker-tag.js')
    .then(() => {
      if (finished) return;
      interval = setInterval(verify,350);
      verify();
    })
    .catch(() => finish('unavailable',tags.filter(hasQuote).length));
  window.addEventListener('pagehide',() => {
    clearInterval(interval);
    clearTimeout(deadline);
  },{once:true});
})();
