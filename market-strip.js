'use strict';
(() => {
  const widget = document.querySelector('.tradingview-widget-container');
  const links = document.querySelector('.strip-links');
  const vendor = 'https://www.tradingview-widget.com';
  let available = false;

  function reportSize() {
    const current = document.body.dataset.stripMode === 'provider' ? widget : links;
    const height = current.getBoundingClientRect().height;
    if (height >= 24) parent.postMessage({type:'books-market-strip-size',height:height + 1}, location.origin);
  }

  function display() {
    const show = available && !links.contains(document.activeElement);
    document.body.dataset.stripMode = show ? 'provider' : 'links';
    widget.inert = !show;
    reportSize();
  }

  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === parent && event.data?.type === 'books-market-strip-measure') {
      reportSize();
      return;
    }
    if (event.origin !== vendor || !event.source || event.source !== widget.querySelector('iframe')?.contentWindow) return;
    if (event.data?.name === 'tv-widget-ready') available = true;
    else if (event.data?.name === 'tv-widget-no-data') available = false;
    else return;
    display();
  });
  links.addEventListener('focusout', () => setTimeout(display, 0));
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(reportSize);
    observer.observe(widget);
    observer.observe(links);
  }
  window.addEventListener('resize', reportSize);
  window.addEventListener('load', reportSize);
  display();
})();
