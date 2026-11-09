'use strict';
(() => {
  const frame = document.querySelector('#index-ticker iframe');
  if (!frame) return;
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== 'books-market-strip-size' || !Number.isFinite(data.height)) return;
    // Size the entire provider component, including its own attribution.
    const height = Math.max(40, Math.ceil(data.height));
    document.documentElement.style.setProperty('--books-ticker-height', height + 'px');
  });
  const measure = () => frame.contentWindow?.postMessage({type:'books-market-strip-measure'}, location.origin);
  frame.addEventListener('load', measure);
  measure();
})();
