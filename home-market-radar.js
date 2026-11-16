'use strict';
(function (root, factory) {
  const radar = factory();
  if (typeof module === 'object' && module.exports) module.exports = radar;
  else for (const host of document.querySelectorAll('[data-home-radar]')) radar.mount(host, root);
})(globalThis, function () {
  const minute = 60000;
  const fresh = (ts, now, maxAge) => Number.isFinite(ts) && ts <= now + 5000 && ts >= now - maxAge;
  const percent = value => (value > 0 ? '+' : '') + value.toFixed(2) + '%';
  const localTime = ts => new Date(ts).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false});
  const stamp = ts => new Date(ts).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false});

  // Keep one exchange-timestamped sample per five seconds. A suspended tab cannot bridge a gap.
  function track(history, quotes, now) {
    for (const quote of quotes) {
      if (!fresh(quote.ts, now, 90000) || !(quote.price > 0)) continue;
      const series = (history.get(quote.id) || []).filter(point => point.ts >= quote.ts - 70000);
      if (series.length && series[series.length-1].ts >= quote.ts) continue;
      if (series.length && Math.floor(series[series.length-1].ts / 5000) === Math.floor(quote.ts / 5000)) series.pop();
      series.push({ts:quote.ts, price:quote.price});
      history.set(quote.id, series);
    }
  }
  function cryptoRows(history, quotes, now) {
    return quotes.filter(q => fresh(q.ts, now, 90000) && q.price > 0).map(q => {
      const historyPoints = history.get(q.id) || [];
      let base = null;
      for (const point of historyPoints) {
        const lag = Math.abs((q.ts - point.ts) - minute);
        if (lag <= 5000 && (!base || lag < Math.abs((q.ts - base.ts) - minute))) base = point;
      }
      return {...q, delta:base ? 100 * (q.price / base.price - 1) : null};
    });
  }

  function stockView(data, market, now) {
    const records = [...(data.observations || []), ...(data.alerts || [])].filter(row =>
      row.market === market && Date.parse(row.sourceTime) <= now + 5000);
    const recent = records.filter(row => fresh(Date.parse(row.sourceTime), now, 120000));
    const alerts = (data.alerts || []).filter(row => row.market === market && fresh(Date.parse(row.sourceTime),now,120000))
      .sort((a,b) => Date.parse(b.sourceTime) - Date.parse(a.sourceTime));
    const last = records.reduce((max,item) => Math.max(max, Date.parse(item.sourceTime)), 0);
    return {last, count:new Set(recent.map(row => row.symbol)).size, alerts};
  }

  const markets = {a:{id:'china', path:'china', name:'A 股'}, us:{id:'america', path:'usa', name:'美股'}};
  function moverConfig(market, direction) {
    const spec = markets[market];
    if (!spec || !['gainers','losers'].includes(direction)) throw Error('未知榜单');
    return {
      label:spec.name + (direction === 'gainers' ? '涨幅榜' : '跌幅榜'),
      source:'https://www.tradingview.com/markets/stocks-' + spec.path + '/market-movers-' + direction + '/',
      widget:{market:spec.id,defaultScreen:'top_' + direction,defaultColumn:'overview',
        width:'100%',height:'100%',showToolbar:true,locale:'zh_CN',colorTheme:'light'}
    };
  }

  function mount(host, env) {
    const doc = host.ownerDocument;
    const el = (tag, text, cls) => {
      const node = doc.createElement(tag);
      if (text != null) node.textContent = text;
      if (cls) node.className = cls;
      return node;
    };
    const link = (label, href) => {
      const anchor = el('a', label);
      anchor.href = href;
      return anchor;
    };
    const title = el('h2', '市场异动');
    const header = el('header', null, 'radar-head');
    header.append(title, el('span', '行情时间均为北京时间'));
    const crypto = el('section', null, 'radar-crypto');
    const cryptoHead = el('div', null, 'radar-section-heading');
    cryptoHead.append(el('h3','加密现货'), link('Bitget 行情 ↗','crypto.html'));
    const cryptoStatus = el('p','正在连接 Bitget 现货报价…','radar-status');
    const cryptoRowsNode = el('ul',null,'radar-rows');
    const cryptoRule = el('p','页面打开时监测近 1 分钟涨跌，绝对值达到 1% 提示异动。','radar-rule');
    crypto.append(cryptoHead, cryptoStatus, cryptoRowsNode, cryptoRule);

    const stockNodes = {};
    const stocks = el('div', null, 'radar-stocks');
    for (const [market, name, href] of [['a','A 股','screening/index.html#public-market-title'],['us','美股','us.html#public-market-title']]) {
      const section = el('section'), heading = el('div',null,'radar-section-heading');
      heading.append(el('h3',name),link('行情筛选 →',href));
      const status = el('p','正在读取分钟记录…','radar-status');
      const list = el('ul',null,'radar-rows');
      section.append(heading,status,list); stocks.append(section); stockNodes[market] = {status,list};
    }
    const controls = el('div',null,'radar-mover-tabs');
    const moverTitle = el('h3');
    const moverHead = el('div',null,'radar-section-heading');
    const close = el('button','收起榜单'); close.type = 'button';
    moverHead.append(moverTitle,close);
    const stage = el('div',null,'radar-mover-stage');
    const note = el('p',null,'radar-status');
    note.setAttribute('role','status');
    const sources = el('nav',null,'radar-mover-sources');
    sources.setAttribute('aria-label','TradingView 来源榜单');
    const movers = el('section',null,'radar-movers');
    movers.hidden = true;
    movers.id = 'home-stock-movers';
    movers.append(moverHead,controls,note,stage,sources);
    const launchers = {};
    let selected, direction, cleanup;
    for (const [market,nodes] of Object.entries(stockNodes)) {
      const launch = el('button','查看涨跌榜'); launch.type = 'button';
      launch.setAttribute('aria-expanded','false'); launch.setAttribute('aria-controls',movers.id);
      launch.onclick = () => openMovers(market,'gainers');
      nodes.status.after(launch);
      launchers[market] = launch;
    }
    for (const [key,label] of [['gainers','涨幅'],['losers','跌幅']]) {
      const tab = el('button',label); tab.type = 'button'; tab.dataset.kind = key;
      tab.onclick = () => openMovers(selected,key);
      controls.append(tab);
    }
    close.onclick = () => {
      cleanup?.(); movers.hidden = true;
      launchers[selected].setAttribute('aria-expanded','false');
      launchers[selected].focus();
      selected = null;
    };
    function openMovers(market,kind) {
      if (selected === market && direction === kind && !movers.hidden) return;
      cleanup?.();
      const config = moverConfig(market,kind);
      selected = market; direction = kind; movers.hidden = false;
      for (const [id,button] of Object.entries(launchers)) button.setAttribute('aria-expanded',String(id === market));
      for (const tab of controls.children) tab.setAttribute('aria-pressed',String(tab.dataset.kind === kind));
      moverTitle.textContent = config.label;
      note.textContent = market === 'a' ? '按交易日涨跌排序 · 沪深免费组件为日终行情' :
        '按交易日涨跌排序 · 报价时效以来源标记为准';
      sources.replaceChildren();
      for (const type of ['gainers','losers']) {
        const source = moverConfig(market,type);
        const direct = link('TradingView ' + source.label + ' ↗',source.source);
        direct.target = '_blank'; direct.rel = 'noopener nofollow'; sources.append(direct);
      }
      const wrapper = el('div',null,'tradingview-widget-container');
      const target = el('div',null,'tradingview-widget-container__widget');
      wrapper.append(target); stage.hidden = false; stage.replaceChildren(wrapper);
      let active = true, timer;
      const observer = new env.MutationObserver(() => {
        const frame = wrapper.querySelector('iframe');
        if (frame && active) {
          observer.disconnect();
          frame.addEventListener('load', () => { if (active) clearTimeout(timer); },{once:true});
        }
      });
      observer.observe(wrapper,{subtree:true,childList:true});
      const script = el('script');
      script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-screener.js';
      script.async = true;
      script.textContent = JSON.stringify(config.widget);
      function unavailable() {
        if (!active) return;
        active = false; clearTimeout(timer); observer.disconnect(); stage.replaceChildren(); stage.hidden = true;
        note.textContent = '嵌入来源未响应，请直接打开下方的涨幅榜或跌幅榜。';
      }
      cleanup = () => {active = false; clearTimeout(timer); observer.disconnect(); stage.replaceChildren();};
      script.addEventListener('error',unavailable,{once:true});
      timer = setTimeout(unavailable,9000);
      wrapper.append(script);
    }
    host.replaceChildren(header,crypto,stocks,movers);
    const history = new Map();
    let feed = {quotes:[], total:20, unavailable:false};
    let snapshot, stockError = false, pending = false;
    const openedAt = Date.now();
    function renderCrypto() {
      const now = Date.now();
      const rows = cryptoRows(history,feed.quotes,now);
      cryptoRowsNode.replaceChildren();
      if (!rows.length) {
        const last = feed.quotes.reduce((t,row)=>Math.max(t,row.ts),0);
        cryptoStatus.textContent = last ? '报价已过期 · 最近来源时间 ' + stamp(last) :
          feed.unavailable || now - openedAt > 9000 ? '暂时连不上 Bitget · 页面打开时会重试' : '正在连接 Bitget 现货报价…';
        return;
      }
      const comparable = rows.filter(r => r.delta !== null);
      const alerts = comparable.filter(r => Math.abs(r.delta) >= 1).sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta));
      const observed = rows.filter(r => Number.isFinite(r.change)).sort((a,b) => Math.abs(b.change) - Math.abs(a.change));
      const latest = Math.max(...rows.map(r => r.ts));
      const minuteState = alerts.length ? alerts.length + ' 个分钟异动' : comparable.length ?
        comparable.length + ' 对有分钟对照，未触发 1%' : '正在积累 1 分钟对照';
      cryptoStatus.textContent = rows.length + '/' + feed.total + ' 对有报价 · ' + minuteState + ' · ' + localTime(latest);
      for (const row of (alerts.length ? alerts : observed).slice(0,3)) {
        const item = el('li'), value = alerts.length ? row.delta : row.change;
        item.append(el('strong',row.id),el('span',alerts.length ? '近 1 分钟异动' : '24 小时涨跌'),el('b',percent(value),value>0?'radar-up':value<0?'radar-down':''));
        cryptoRowsNode.append(item);
      }
    }
    doc.addEventListener('books:bitget-quotes', event => {
      feed = event.detail;
      track(history,feed.quotes,Date.now());
      renderCrypto();
    });
    function renderStocks() {
      for (const [market, nodes] of Object.entries(stockNodes)) {
        nodes.list.replaceChildren();
        if (!snapshot) {
          nodes.status.textContent = stockError ? '公开分钟文件暂时无法读取' : '正在读取分钟记录…';
          continue;
        }
        const info = stockView(snapshot,market,Date.now());
        nodes.status.textContent = !info.last ? '尚未发布可公开展示的分钟样本' :
          !info.count ? '最近分钟样本 ' + stamp(info.last) + ' · 已过期' :
          info.count + ' 只证券有分钟样本 · ' + (info.alerts.length ? info.alerts.length + ' 条异动' : '本批无已发布异动') + ' · ' + localTime(info.last);
        if (stockError) nodes.status.textContent += ' · 本次刷新失败';
        for (const row of info.alerts.slice(0,3)) {
          const item = el('li');
          item.append(el('strong',row.name ? row.name + ' ' + row.symbol : row.symbol),el('span',row.level==='confirmed'?'量价异动':'放量观察'),el('b',percent(row.priceChange1m*100)));
          nodes.list.append(item);
        }
      }
    }
    async function read() {
      if (pending || doc.hidden) return;
      pending = true;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await env.fetch('research-data/snapshot.json',{cache:'no-cache', credentials:'omit',redirect:'error', signal:controller.signal});
        if (!response.ok) throw Error();
        const next = env.BooksStockWorkspace.validate(await response.json());
        if (snapshot && Date.parse(next.publishedAt) < Date.parse(snapshot.publishedAt)) throw Error();
        snapshot = next; stockError = false;
      } catch {stockError = true;}
      finally {clearTimeout(timeout); pending = false; renderStocks();}
    }
    let clock, poll;
    function resume() {
      clearInterval(clock); clearInterval(poll);
      if (doc.hidden) return;
      read(); renderCrypto();
      clock = setInterval(() => {renderCrypto();renderStocks();},10000);
      poll = setInterval(read,60000);
    }
    doc.addEventListener('visibilitychange',resume);
    resume();
  }
  return {track,cryptoRows,stockView,moverConfig,mount};
});
