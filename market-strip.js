'use strict';
(() => {
  const widget = document.querySelector('.tradingview-widget-container');
  const reportSize = () => {
    const height = widget.getBoundingClientRect().height;
    if (height > 0) parent.postMessage({type:'books-market-strip-size',height:height + 1}, location.origin);
  };
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === parent && event.data?.type === 'books-market-strip-measure') reportSize();
  });
  new ResizeObserver(reportSize).observe(widget);
  window.addEventListener('load', reportSize);
  reportSize();
})();
