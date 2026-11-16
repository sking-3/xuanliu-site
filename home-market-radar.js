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

  function moverConfig(market, direction = 'gainers') {
    const common = {width:'100%', height:'100%', locale:'zh_CN', colorTheme:'light'};
    const china = 'https://www.tradingview.com/markets/stocks-china/';
    if (market === 'watch') return {
      label:'沪深观察', script:'market-overview', source:china,
      widget:{...common, showChart:false, showSymbolLogo:false, tabs:[{title:'沪深观察', symbols:[
        {s:'SSE:600519',d:'贵州茅台'}, {s:'SZSE:000858',d:'五粮液'},
        {s:'SSE:601398',d:'工商银行'}, {s:'SZSE:000333',d:'美的集团'},
        {s:'SSE:600036',d:'招商银行'}, {s:'SZSE:002594',d:'比亚迪'},
        {s:'SSE:601318',d:'中国平安'}, {s:'SZSE:300750',d:'宁德时代'}
      ]}]}
    };
    if (market !== 'us' || !['gainers','losers'].includes(direction)) throw Error('未知榜单');
    return {
      label:direction === 'gainers' ? '美股涨幅榜' : '美股跌幅榜', script:'screener',
      source:'https://www.tradingview.com/markets/stocks-usa/market-movers-' + direction + '/',
      widget:{...common, market:'america', defaultScreen:'top_' + direction,
        defaultColumn:'overview', showToolbar:false}
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
    const rules = el('details', null, 'radar-rules');
    rules.append(el('summary', '异动计算规则'),
      el('p', '加密现货比较最新价格与约 60 秒前的价格（允许相差 5 秒）。涨跌达到 ±1% 时，按涨跌绝对值列出最多 3 对。积累样本期间或没有触发时，展示滚动 24 小时涨跌绝对值最大的 3 对。'),
      el('p', '股票分钟成交额达到过去同一交易时段、同一分钟成交额中位数的 3 倍，标记为放量观察。最多取最近 20 个有效交易日，至少需 10 天。同时一分钟涨跌达到 ±1%，标记为量价异动。A 股日榜按同一批公开快照的日涨跌幅分别降序、升序排列，涨榜和跌榜各取 3 只，同幅按代码升序。仅纳入有有效价格和涨跌幅的证券。'));
    host.replaceChildren(header,crypto,stocks,rules);

    function mountQuotePanel(panel, market) {
      const tabs = el('div', null, 'radar-mover-tabs');
      tabs.setAttribute('role','group');
      tabs.setAttribute('aria-label', '美股榜单方向');
      const stage = el('div', null, 'radar-mover-stage');
      const source = link('', '');
      source.target = '_blank'; source.rel = 'noopener nofollow';
      const alternate = link('', '');
      alternate.hidden = true; alternate.target = '_blank'; alternate.rel = 'noopener nofollow';
      const sources = el('div', null, 'radar-mover-sources');
      sources.append(source, alternate);
      const feedback = el('p', '', 'radar-mover-feedback');
      feedback.setAttribute('role','status');
      const retry = el('button', '重新连接', 'radar-retry');
      retry.type = 'button'; retry.hidden = true;
      const recovery = el('div', null, 'radar-recovery');
      recovery.append(feedback, retry);
      if (market === 'us') panel.append(tabs);
      panel.append(stage, recovery, sources);

      let direction = 'gainers', cleanup, retryTimer, lastFailure = 0;
      const buttons = new Map();
      const choices = market === 'us' ? [['gainers','涨幅'],['losers','跌幅']] : [];
      for (const [kind, label] of choices) {
        const button = el('button',label);
        button.type = 'button';
        button.dataset.kind = kind;
        button.addEventListener('click', () => {
          if (kind === direction) return;
          direction = kind;
          load(true);
        });
        tabs.append(button);
        buttons.set(kind,button);
      }
      function load(autoRetry) {
        cleanup?.();
        clearTimeout(retryTimer);
        lastFailure = 0;
        const config = moverConfig(market,direction);
        for (const [kind, button] of buttons) button.setAttribute('aria-pressed',String(kind === direction));
        source.href = config.source;
        source.textContent = market === 'us' ? config.label + '原榜 ↗' : '中国股票行情 ↗';
        if (market === 'us') {
          const opposite = moverConfig('us', direction === 'gainers' ? 'losers' : 'gainers');
          alternate.href = opposite.source;
          alternate.textContent = opposite.label + '原榜 ↗';
        }
        alternate.hidden = true;
        retry.hidden = true;
        stage.hidden = false;
        stage.setAttribute('aria-busy','true');
        feedback.textContent = '正在读取' + config.label + '…';

        let active = true, timer, observer;
        function observeFrame(frame) {
          frame.addEventListener('load', () => {
            if (!active) return;
            clearTimeout(timer);
            stage.setAttribute('aria-busy','false');
            feedback.textContent = '';
          }, {once:true});
          frame.addEventListener('error', unavailable, {once:true});
        }
        function dispose() {
          active = false;
          clearTimeout(timer);
          observer?.disconnect();
          stage.replaceChildren();
        }
        function unavailable() {
          if (!active) return;
          dispose();
          stage.hidden = true;
          stage.setAttribute('aria-busy','false');
          lastFailure = Date.now();
          alternate.hidden = market !== 'us';
          feedback.textContent = config.label + (autoRetry ? '连接失败，稍后自动重试。' : '暂时无法加载，可打开行情来源。');
          retry.hidden = false;
          if (autoRetry) retryTimer = setTimeout(() => { if (!doc.hidden) load(false); }, 20000);
        }
        cleanup = dispose;
        timer = setTimeout(unavailable,15000);
        const wrapper = el('div',null,'tradingview-widget-container');
        const target = el('div',null,'tradingview-widget-container__widget');
        const credit = el('div',null,'tradingview-widget-copyright');
        const attribution = link(config.label + ' · TradingView',config.source);
        attribution.target = '_blank'; attribution.rel = 'noopener nofollow';
        credit.append(attribution);
        wrapper.append(target,credit);
        stage.replaceChildren(wrapper);
        observer = new env.MutationObserver(() => {
          const frame = wrapper.querySelector('iframe');
          if (!frame || !active) return;
          observer.disconnect();
          frame.title = config.label + ' · TradingView';
          observeFrame(frame);
        });
        observer.observe(wrapper, {subtree:true,childList:true});
        const script = el('script');
        script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-' + config.script + '.js';
        script.async = true;
        script.textContent = JSON.stringify(config.widget);
        script.addEventListener('error',unavailable,{once:true});
        wrapper.append(script);
      }
      retry.addEventListener('click', () => load(true));
      env.addEventListener('online', () => { if (lastFailure && !doc.hidden) load(true); });
      doc.addEventListener('visibilitychange', () => {
        if (!doc.hidden && lastFailure && Date.now()-lastFailure >= 20000) load(true);
      });
      load(true);
    }
    function mountDailyBoard(panel) {
      const path = 'wenyuanw/a-share-heatmap/main/src/lib/data/market-heatmap-fallback.json';
      const source = link('快照来源 ↗', 'https://github.com/' + path.replace('/main/', '/blob/main/'));
      source.target = '_blank'; source.rel = 'noopener';
      const footer = el('div', null, 'radar-mover-sources');
      const info = el('p', '正在读取最近收盘榜…', 'radar-cadence');
      const distribution = el('div', null, 'radar-day-lists');
      const refreshStatus = el('span', '', 'radar-cadence');
      footer.append(source, refreshStatus);
      panel.append(info, distribution, footer);
      const cacheKey = 'books-home-daily-ranks-v1';
      let current, origin, polling = false, lastCheck = 0;
      function show(data, nextOrigin) {
        if (!data || !Number.isFinite(Date.parse(data.asOf)) || Date.parse(data.asOf) > Date.now() + 300000 || !Number.isInteger(data.priced) || data.priced < 1) return;
        if (!['gainers','losers'].every(key => Array.isArray(data[key]) && data[key].length <= 3 &&
          data[key].every(row => row && /^\d{6}$/.test(row.code) && typeof row.name === 'string'))) return;
        if (current && (Date.parse(current.asOf) > Date.parse(data.asOf) ||
          (Date.parse(current.asOf) === Date.parse(data.asOf) && origin === 'upstream'))) return;
        current = data;
        origin = nextOrigin;
        if (origin === 'upstream') {
          refreshStatus.textContent = '';
          try { env.localStorage.setItem(cacheKey, JSON.stringify(data)); } catch {}
        }
        info.dataset.dailyOrigin = origin;
        const when = el('time', new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(data.asOf)));
        when.dateTime = data.asOf;
        when.dataset.dailyAsof = '';
        info.replaceChildren(when, ' 收盘快照 · ' + data.priced.toLocaleString('zh-CN') + ' 只有效报价');
        distribution.replaceChildren();
        for (const [key,title] of [['gainers','涨幅前三'],['losers','跌幅前三']]) {
          const group = el('section');
          group.dataset.dailySide = key;
          group.append(el('h4',title));
          const list = el('ol');
          for (const row of data[key]) {
            const item = el('li');
            item.dataset.code = row.code;
            item.append(el('strong',row.name),el('span',row.code));
            list.append(item);
          }
          if (list.childElementCount) group.append(list);
          else group.append(el('p','本批无符合方向的股票','radar-cadence'));
          distribution.append(group);
        }
      }
      async function json(url, signal) {
        const response = await env.fetch(url, {credentials:'omit',referrerPolicy:'no-referrer',cache:'no-cache',signal});
        if (!response.ok) throw Error('行情来源无法读取');
        return response.json();
      }
      async function refresh() {
        if (doc.hidden || polling || Date.now() - lastCheck < 15 * minute) return;
        polling = true;
        lastCheck = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(),15000);
        try {
          const snapshot = await json('https://raw.githubusercontent.com/' + path,controller.signal);
          show(env.BooksDailyMovers.summarize(snapshot), 'upstream');
        } catch {
          refreshStatus.textContent = '上游本次未能刷新';
        } finally {
          polling = false;
          clearTimeout(timer);
        }
      }
      try { show(JSON.parse(env.localStorage.getItem(cacheKey)), 'cached'); } catch {}
      json('research-data/a-daily-movers.json').then(data => show(data,'bundled')).catch(() => {
        if (!current) info.textContent = '本站快照暂不可用，可打开快照来源。';
      });
      refresh();
      setInterval(refresh, 15 * minute);
      doc.addEventListener('visibilitychange',refresh);
    }
    function mountStockBoard(market, href) {
      const board = el('section', null, 'radar-stock-board');
      board.dataset.moverMarket = market;
      const heading = el('div', null, 'radar-section-heading');
      heading.append(el('h3', market === 'a' ? 'A 股收盘涨跌榜' : '美股日涨跌榜'), link('行情筛选 →', href));
      const primary = el('div', null, 'radar-main-body');
      board.append(heading, el('p', market === 'a' ? '按日涨跌幅排序 · 含沪深北' :
        '按交易日涨跌幅排序 · 行情可能延迟', 'radar-cadence'), primary);
      stocks.append(board);
      if (market === 'a') {
        mountDailyBoard(primary);
        const watch = el('section', null, 'radar-equity-watch');
        watch.dataset.equityWatch = '';
        watch.append(el('h4', '沪深观察'), el('p', '8 只固定观察股 · 日终', 'radar-cadence'));
        board.append(watch);
        mountQuotePanel(watch, 'watch');
      } else {
        mountQuotePanel(primary, 'us');
      }
      const intraday = market === 'a' ?
        link('盘口异动 ↗', 'https://quote.eastmoney.com/changes/') :
        link('停复牌公告 ↗', 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts');
      intraday.target = '_blank'; intraday.rel = 'noopener';
      const status = el('p','正在读取分钟记录…','radar-status');
      const list = el('ul',null,'radar-rows');
      const foot = el('div', null, 'radar-section-heading');
      foot.append(status, intraday);
      board.append(foot, list);
      stockNodes[market] = {status, list};
    }
    mountStockBoard('a','screening/index.html#public-market-title');
    mountStockBoard('us','us.html#public-market-title');
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
        nodes.status.textContent = !info.last ? '分钟量价异动 · 暂无公开分钟样本' :
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
