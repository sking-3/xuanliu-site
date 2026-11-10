(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.start(root);
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const IDS = Object.freeze(['5156287639231681792', '5139646755272846081', '5178595252342363392']);
  function destination(href) {
    const current = new URL(href), ids = current.searchParams.getAll('portfolioId');
    if (ids.length && (ids.length !== 1 || !IDS.includes(ids[0]))) return null;
    const target = new URL('../', current);
    target.searchParams.set('exchange', 'Binance');
    if (ids.length) target.searchParams.set('q', ids[0]);
    return target.href;
  }
  function start(env) {
    const target = destination(env.location.href);
    if (target) env.location.replace(target);
    else {
      const note = env.document.getElementById('redirect-note');
      if (note) note.textContent = '这个组合 ID 不在已接入名单中，请前往广场选择已有账号。';
    }
  }
  return { IDS, destination, start };
});
