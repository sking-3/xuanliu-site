'use strict';
(() => {
  const indices = {
    'SSE:000001':['sh000001','CN'],
    'SSE:000688':['sh000688','CN'],
    'SSE:000300':['sh000300','CN'],
    'SSE:000905':['sh000905','CN'],
    'SZSE:399001':['sz399001','CN'],
    'SZSE:399006':['sz399006','CN'],
    'HSI:HSI':['hkHSI','HK'],
    'HSI:HSCEI':['hkHSCEI','HK'],
    'FRED:NDQCOM':['us.IXIC','US'],
    'NASDAQ:IXIC':['us.IXIC','US'],
    'NASDAQ:NDX':['us.NDX','US'],
    'SP:SPX':['us.INX','US'],
    'DJ:DJI':['us.DJI','US'],
  };
  const minimumBars = 26;
  const digits = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:6});

  function feed(symbol, kind) {
    const [venue, code] = symbol.split(':');
    let ticker, market, method = 'fqkline';
    if (kind === 'index') {
      if (!Object.hasOwn(indices,symbol)) return null;
      [ticker,market] = indices[symbol];
      if (market === 'HK') method = 'hkfqkline';
      if (market === 'US') method = 'usfqkline';
    } else if (['SSE','SZSE'].includes(venue) && /^\d{6}$/.test(code)) {
      ticker = (venue === 'SSE' ? 'sh' : 'sz') + code;
      market = 'CN';
    } else {
      const suffix = {NASDAQ:'OQ',NYSE:'N',AMEX:'AM'}[venue];
      if (!suffix || !/^[A-Z][A-Z0-9]{0,14}$/.test(code)) return null;
      ticker = 'us' + code + '.' + suffix;
      market = 'US';
    }
    const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/' + method + '/get');
    url.searchParams.set('param',[ticker,'day','','',60,method === 'fqkline' ? '' : 'qfq'].join(','));
    return {url,ticker,market,code:ticker.slice(2),unit:kind === 'index' ? '点' : market === 'CN' ? '元' : '美元'};
  }

  function bar(date, open, high, low, close) {
    const day = new Date(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+day) || day.toISOString().slice(0,10) !== date) throw Error('交易日期无效');
    const prices = [open,high,low,close].map(value => {
      if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return NaN;
      return typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    });
    const [o,h,l,c] = prices;
    if (!prices.every(v => Number.isFinite(v) && v > 0) || l > Math.min(o,c) || h < Math.max(o,c)) throw Error('价格字段无效');
    return {date,open:o,high:h,low:l,close:c};
  }

  function ordered(bars) {
    bars.sort((a,b) => a.date.localeCompare(b.date));
    if (bars.length < minimumBars) throw Error('已收盘日线不足 ' + minimumBars + ' 个交易日');
    if (bars.some((item,i) => i > 0 && item.date === bars[i-1].date)) throw Error('交易日期重复');
    return bars;
  }

  function fromQuotes(payload, source, calendar, now) {
    const entry = payload.data?.[source.ticker];
    const quote = entry?.qt?.[source.ticker];
    if (payload.code !== 0 || quote?.[2] !== source.code || !Array.isArray(entry.day)) throw Error('来源未返回匹配标的的原始日线');
    const latest = calendar.latestClosed(source.market,now);
    if (!latest) throw Error('本地交易日历待更新');
    // Field 30 is the provider's market-local quote timestamp in these three feeds.
    const stamp = String(quote[30] || '').replace(/[-/:\s]/g,'');
    const clock = calendar.clock(source.market, now);
    const closed = entry.day.map(([date,open,close,high,low]) => bar(date,open,high,low,close))
      .filter(item => {
        if (item.date > latest.date) return false;
        if (item.date !== clock.date) return true;
        const published = /^\d{14}$/.test(stamp) && stamp.slice(0,8) === clock.date.replaceAll('-','')
          && stamp.slice(8) >= calendar.session(source.market,clock.date).close && stamp.slice(8) <= clock.time;
        return published && Number(quote[3]) === item.close;
      });
    return {bars:ordered(closed),latestDate:latest.date};
  }

  function fromCsv(raw, symbol, kind, now) {
    const lines = raw.trim().split(/\r?\n/).filter(line => line.trim());
    const cells = line => line.split(',').map(value => value.trim().replace(/^"([^"]*)"$/,'$1'));
    const fields = cells(lines.shift());
    const full = 'symbol,date,open,high,low,close';
    const closeOnly = kind === 'index' && fields.join(',') === 'symbol,date,close';
    if (!closeOnly && fields.join(',') !== full) throw Error('CSV 表头与所列格式不符');
    const maxDate = new Date(now + 14 * 3600000).toISOString().slice(0,10);
    const bars = lines.map(line => {
      const row = cells(line);
      const [key,date] = row;
      if (row.length !== fields.length || key.toUpperCase() !== symbol) throw Error('CSV 中有其他标的或缺少字段，请核对 ' + symbol);
      if (date > maxDate) throw Error('CSV 含未来日期');
      return closeOnly ? bar(date,row[2],row[2],row[2],row[2]) : bar(date,...row.slice(2));
    });
    return {bars:ordered(bars),closeOnly};
  }

  function analyze(bars) {
    const latest = bars.at(-1);
    const average = list => list.reduce((sum,item) => sum + item.close,0) / list.length;
    function trend(length) {
      const mean = average(bars.slice(-length));
      const prior = average(bars.slice(-length-5,-5));
      const above = latest.close > mean, rising = mean > prior;
      const below = latest.close < mean, falling = mean < prior;
      return {bias:above && rising ? '偏多' : below && falling ? '偏空' : '震荡',mean,prior};
    }
    const range = bars.slice(-21,-1);
    return {
      close:latest.close,
      short:trend(5),
      medium:trend(20),
      high:Math.max(...range.map(item => item.high)),
      low:Math.min(...range.map(item => item.low)),
    };
  }

  function evidence(close, trend, length) {
    const relative = Math.sign(close-trend.mean)+1;
    const slope = Math.sign(trend.mean-trend.prior)+1;
    return '收盘 '+digits.format(close)+'，'+['低于','等于','高于'][relative]+length+' 日均线 '
      +digits.format(trend.mean)+'。均线较 5 个交易日前'+['下移','持平','上移'][slope]+'。';
  }

  function mount({symbol,name,kind}) {
    const el = id => document.getElementById(id);
    const text = (id,value) => { el(id).textContent = value; };
    const source = feed(symbol,kind);
    const index = kind === 'index';
    const file = el('outlook-file');
    const state = {phase:'loading',message:'',data:null,sourceText:'',fileMessage:''};
    let generation = 0;

    function render() {
      const {phase,message,data,sourceText,fileMessage} = state;
      text('outlook-symbol', (index ? '指数' : '股票') + ' · ' + (name === symbol ? symbol : name + ' · ' + symbol));
      text('outlook-status',message);
      text('outlook-source',sourceText);
      text('outlook-file-status',fileMessage);
      el('outlook-file-status').hidden = !fileMessage;
      el('outlook-retry').hidden = !source || phase !== 'unavailable';
      el('outlook-results').hidden = !data;
      el('outlook-import').hidden = phase === 'loading';
      if (!data) return;
      const {high,low,close,short,medium,closeOnly,unit} = data;
      text('outlook-short',short.bias);
      text('outlook-short-evidence',evidence(close,short,5));
      text('outlook-medium',medium.bias);
      text('outlook-medium-evidence',evidence(close,medium,20));
      const boundary = closeOnly ? '此前 20 日收盘区间' : '此前 20 日日线区间';
      text('outlook-level-title',(index ? '指数观察点位' : '买卖观察价')+' · '+boundary);
      const value = price => digits.format(price) + (unit ? ' '+unit : '');
      const levels = [
        [index ? '向上突破' : '买入观察', '收盘高于 '+value(high)+'，再观察回踩能否守住该位。'],
        ['区间内', '收盘介于 '+value(low)+' 至 '+value(high)+'，等待方向确认。'],
        [index ? '向下跌破' : '减仓或退出观察', '收盘低于 '+value(low)+'，观察反抽能否收回。'],
        ['情景失效', '突破后收盘跌回 '+value(high)+' 下方，或跌破后收盘重回 '+value(low)+' 上方。'],
      ];
      el('outlook-levels').replaceChildren(...levels.map(([label,description]) => {
        const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
        term.textContent = label;
        detail.textContent = description;
        row.append(term,detail);
        return row;
      }));
    }

    function update(next) {
      Object.assign(state,next);
      render();
    }

    async function read() {
      if (!source) {
        update({phase:'unavailable',message:'证据不足 · 当前标的暂无自动日线，可导入已收盘日线。'});
        return;
      }
      const request = ++generation;
      update({phase:'loading',message:'正在读取已收盘日线…',data:null,sourceText:'',fileMessage:''});
      try {
        const response = await fetch(source.url,{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(9000)});
        if (!response.ok) throw Error('行情来源 HTTP '+response.status);
        const payload = await response.json();
        const received = new Date();
        const {bars,latestDate} = fromQuotes(payload,source,globalThis.BooksMarketCalendar,+received);
        if (request !== generation) return;
        const date = bars.at(-1).date;
        const time = received.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
        const sourceText = '腾讯财经 · '+(index ? '指数点位' : '不复权日线')+' · 日线截至 '+date+' · 读取于 '+time+'（北京时间）';
        if (date !== latestDate) {
          update({phase:'unavailable',message:'证据不足 · 尚未取得 '+latestDate+' 的可核验收盘日线。',sourceText});
          return;
        }
        update({phase:'ready',message:'已核验最近收盘 · '+date,sourceText,data:{...analyze(bars),unit:source.unit}});
      } catch (error) {
        if (request !== generation) return;
        const reason = error.name === 'TimeoutError' ? '日线读取超时' : error instanceof TypeError ? '日线请求失败' : error.message;
        update({phase:'unavailable',message:'证据不足 · '+reason+'。可重试或导入日线。'});
      }
    }

    file.addEventListener('change',async () => {
      const chosen = file.files[0];
      if (!chosen) return;
      const request = ++generation;
      try {
        if (chosen.size > 512000) throw Error('CSV 请小于 500 KB');
        const {bars,closeOnly} = fromCsv(await chosen.text(),symbol,kind,Date.now());
        if (request !== generation) return;
        const date = bars.at(-1).date;
        update({phase:'imported',message:'导入日线 · 历史复盘 · '+date,
          sourceText:'本地 CSV · '+(closeOnly ? '收盘序列' : '日线')+' · 截至 '+date+(index ? '' : ' · 原文件计价')+' · 未校验来源及更新状态',
          fileMessage:'',data:{...analyze(bars),closeOnly,unit:index ? '点' : ''}});
      } catch (error) {
        if (request === generation) update({fileMessage:error.message});
      }
      if (request === generation) file.value = '';
    });
    el('outlook-retry').addEventListener('click',read);
    el('chart-outlook').hidden = false;
    el('chart-outlook-jump').hidden = false;
    read();
  }

  if (typeof module === 'object' && module.exports) module.exports = {feed,fromQuotes,fromCsv,analyze};
  else globalThis.BooksChartOutlook = {mount,isIndex:symbol => Object.hasOwn(indices,symbol)};
})();
