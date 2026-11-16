'use strict';
(() => {
  const feeds = {
    'SSE:000001': ['sh000001', 'fqkline', 'Asia/Shanghai', '150000'],
    'SZSE:399001': ['sz399001', 'fqkline', 'Asia/Shanghai', '150000'],
    'SZSE:399006': ['sz399006', 'fqkline', 'Asia/Shanghai', '150000'],
    'SSE:000688': ['sh000688', 'fqkline', 'Asia/Shanghai', '150000'],
    'HSI:HSI': ['hkHSI', 'hkfqkline', 'Asia/Hong_Kong', '161000'],
    'FRED:NDQCOM': ['us.IXIC', 'usfqkline', 'America/New_York', '160000']
  };
  const hosts = ['https://web.ifzq.gtimg.cn', 'https://proxy.finance.qq.com/ifzqgtimg'];

  function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const stamp = Date.parse(value+'T00:00:00Z');
    return Number.isFinite(stamp) && new Date(stamp).toISOString().startsWith(value+'T');
  }

  function positive(value) {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return false;
    return Number.isFinite(Number(value)) && Number(value)>0;
  }

  function endpoint(host, feed) {
    const url = new URL(host + '/appstock/app/' + feed[1] + '/get');
    url.searchParams.set('param', [feed[0], 'day', '', '', 6, 'qfq'].join(','));
    return url.href;
  }

  const clocks = new Map();
  function marketTime(zone, now) {
    if (!clocks.has(zone)) clocks.set(zone,new Intl.DateTimeFormat('en-US', {
      timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
    }));
    const p = Object.fromEntries(clocks.get(zone).formatToParts(now).map(x=>[x.type,x.value]));
    return {date:p.year+'-'+p.month+'-'+p.day, time:p.hour+p.minute+p.second};
  }

  function inSession(zone, clock) {
    const weekday = new Date(clock.date+'T12:00:00Z').getUTCDay();
    if (weekday === 0 || weekday === 6) return false;
    const t = clock.time;
    if (zone==='America/New_York') return t>='093000' && t<'160000';
    const hk = zone==='Asia/Hong_Kong';
    return t>='093000' && t<(hk?'120000':'113000') || t>='130000' && t<(hk?'161000':'150000');
  }

  const seconds = time => Number(time.slice(0,2))*3600 + Number(time.slice(2,4))*60 + Number(time.slice(4,6));
  function quote(symbol, payload, now = new Date()) {
    const feed = feeds[symbol];
    if (!feed || ![0,'0'].includes(payload?.code)) return null;
    const [ticker, , zone, closeTime] = feed;
    const entry = payload.data?.[ticker];
    const rows = entry?.qfqday ?? entry?.day;
    if (!Array.isArray(rows)) return null;
    const clock = marketTime(zone,now);
    const qt = entry.qt?.[ticker];
    const code = String(qt?.[2] || '').toUpperCase(), expected = ticker.slice(2).toUpperCase();
    // Tencent uses both formatted exchange-local times and compact timestamps.
    const stamp = String(qt?.[30] || '').replace(/[-: ]/g,'');
    const today = clock.date;
    const stampToday = (code===expected || code===ticker.toUpperCase())
      && /^\d{8}(?:[01]\d|2[0-3])(?:[0-5]\d){2}$/.test(stamp) && stamp.slice(0,8) === today.replaceAll('-','');
    const quoteTime = stamp.slice(8);
    const closedToday = stampToday && clock.time>=closeTime && quoteTime>=closeTime && quoteTime<=clock.time;
    const closes = [];
    for (const row of rows) {
      if (!Array.isArray(row) || !validDay(row[0])) return null;
      if (row[0] > today || row[0] === today && !closedToday) continue;
      if (!positive(row[2])) return null;
      closes.push({date:row[0],close:Number(row[2])});
    }
    closes.sort((a,b) => a.date.localeCompare(b.date));
    if (closes.length < 2 || closes.some((bar,i)=>i>0 && bar.date===closes[i-1].date)) return null;
    const closing = {...closes.at(-1),previousClose:closes.at(-2).close,previousDate:closes.at(-2).date};
    let delayed = null;
    const age = seconds(clock.time) - seconds(quoteTime);
    if (stampToday && inSession(zone,clock) && inSession(zone,{date:today,time:quoteTime})
        && age>=0 && age<=1800 && positive(qt[3]) && positive(qt[4])
        && closing.date<today && Math.abs(Number(qt[4])-closing.close)<=0.015) {
      delayed = {date:today, instant:new Date(Math.floor(now.getTime()/1000)*1000-age*1000).toISOString(),
        price:Number(qt[3]),previousClose:Number(qt[4]),previousDate:closing.date};
    }
    return {closing,delayed};
  }

  function fresh(symbol, row, closing, now = new Date()) {
    if (!row || !positive(row.price) || !positive(row.previousClose) || !validDay(row.date)
        || row.previousDate!==closing.date || row.date<=closing.date || Math.abs(row.previousClose-closing.close)>0.015) return false;
    const age = now.getTime()-Date.parse(row.instant);
    if (!Number.isFinite(age) || age<0 || age>30*60*1000) return false;
    const zone=feeds[symbol][2], stamp=marketTime(zone,new Date(row.instant)), current=marketTime(zone,now);
    return stamp.date===row.date && current.date===stamp.date && inSession(zone,current) && inSession(zone,stamp);
  }

  const change = (value,previous) => (value / previous - 1) * 100;
  if (typeof module === 'object' && module.exports) { module.exports = {feeds,quote,fresh,change,endpoint}; return; }

  const tape = document.querySelector('.tape');
  const track = tape.querySelector('.tape-track');
  const group = track.querySelector('[data-tape-group]');
  const copy = group.cloneNode(true);
  copy.setAttribute('aria-hidden','true');
  for (const a of copy.querySelectorAll('a')) a.tabIndex = -1;
  track.append(copy);
  tape.dataset.loop = '';
  const toggle = tape.querySelector('.tape-toggle');
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    const paused = tape.toggleAttribute('data-paused');
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? '继续滚动行情' : '暂停滚动行情');
    toggle.title = toggle.getAttribute('aria-label');
  });
  function measure() {
    if (parent !== window) parent.postMessage({type:'books-market-strip-size',height:tape.getBoundingClientRect().height+1},location.origin);
  }
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === parent && event.data?.type === 'books-market-strip-measure') measure();
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(tape);
  measure();

  const cacheKey = 'books.indexTape.v1';
  const symbols = Object.keys(feeds);
  const closing = {}, delayed = {}, attempted = {};
  const links = new Map();
  for (const a of group.querySelectorAll('[data-symbol]')) {
    const symbol = a.dataset.symbol;
    links.set(symbol,[a,copy.querySelector('[data-symbol="'+symbol+'"]')]);
    closing[symbol] = {date:a.querySelector('time').dateTime,close:Number(a.dataset.close),
      previousClose:Number(a.dataset.previousClose),previousDate:a.dataset.previousDate,url:a.dataset.sourceUrl};
  }
  function acceptClose(symbol,data) {
    if (!data || !validDay(data.date) || !validDay(data.previousDate) || data.previousDate>=data.date
        || data.date>marketTime(feeds[symbol][2],new Date()).date || data.date<closing[symbol].date
        || !positive(data.close) || !positive(data.previousClose)) return false;
    if (!hosts.some(host=>endpoint(host,feeds[symbol])===data.url)) return false;
    closing[symbol]=data;
    return true;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(cacheKey));
    if (stored) for (const symbol of symbols) {
      acceptClose(symbol,stored.closing?.[symbol]);
      if (fresh(symbol,stored.delayed?.[symbol],closing[symbol])) delayed[symbol]=stored.delayed[symbol];
      const last = stored.attempted?.[symbol];
      if (Number.isFinite(last) && last<=Date.now()) attempted[symbol]=last;
    }
  } catch {}
  const number = new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  function display(symbol) {
    const base = closing[symbol];
    const live = fresh(symbol,delayed[symbol],base) ? delayed[symbol] : null;
    const data = live || base, value = live ? live.price : base.close;
    const pct = change(value, data.previousClose);
    const label = live?'延时报价':'收盘';
    let asOf = data.date;
    if (live) {
      const t = marketTime(feeds[symbol][2],new Date(live.instant)).time;
      asOf += ' '+t.slice(0,2)+':'+t.slice(2,4);
    }
    for (const item of links.get(symbol)) {
      item.querySelector('.tape-price').textContent = number.format(value);
      const delta = item.querySelector('.tape-change');
      delta.textContent = (pct>0?'+':'') + number.format(pct) + '%';
      delta.dataset.direction = pct>0?'up':pct<0?'down':'flat';
      const time = item.querySelector('time');
      time.dateTime = live ? live.instant : base.date;
      time.textContent = asOf;
      item.querySelector('.tape-kind').textContent = label;
      item.dataset.quoteKind = live?'delayed':'close';
      item.dataset.price = String(value);
      item.dataset.close = String(base.close);
      item.dataset.previousClose = String(data.previousClose);
      item.dataset.previousDate = data.previousDate;
      item.dataset.sourceUrl = base.url;
      item.title = '腾讯行情 · 市场当地 '+asOf+' '+label+' · 前收 '+number.format(data.previousClose);
    }
  }

  async function refreshSymbol(symbol) {
    const feed = feeds[symbol];
    const active = inSession(feed[2],marketTime(feed[2],new Date()));
    const since = Date.now() - (attempted[symbol] || 0);
    if (since < (active ? 2 : 15)*60*1000) return;
    attempted[symbol] = Date.now();
    for (const host of hosts) {
      const controller = new AbortController();
      const timeout = setTimeout(()=>controller.abort(),5500);
      try {
        const url = endpoint(host,feed);
        const response = await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal});
        if ([401,403,429].includes(response.status)) return;
        if (!response.ok) continue;
        const result = quote(symbol,await response.json());
        if (result) {
          result.closing.url = url;
          if (acceptClose(symbol,result.closing)) delayed[symbol] = result.delayed;
          display(symbol);
          return;
        }
      } catch {} finally { clearTimeout(timeout); }
    }
  }
  async function refresh() {
    if (document.hidden) return;
    symbols.forEach(display);
    await Promise.all(symbols.map(refreshSymbol));
    try { localStorage.setItem(cacheKey,JSON.stringify({closing,delayed,attempted})); } catch {}
  }
  refresh();
  window.addEventListener('pageshow',refresh);
  document.addEventListener('visibilitychange',refresh);
  setInterval(refresh,60000);
})();
