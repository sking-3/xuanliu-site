'use strict';
(() => {
  const el = id => document.getElementById(id);
  const text = (id, value) => { el(id).textContent = value; };
  const fmt = (v, digits = 2) => Number.isFinite(v) ? v.toLocaleString('zh-CN', {maximumFractionDigits:digits}) : '未提供';
  const chinaDay = date => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(date);
  const today = () => chinaDay(new Date());
  const byCode = {'2001':'密钥不可用','2002':'密钥或权限不可用','2003':'需要有效的 API Key'};
  const valFields = [['pe_ttm','市盈率 TTM'],['pe_mrq','市盈率 MRQ'],['pb_mrq','市净率 MRQ'],['ps_ttm','市销率 TTM'],['pcf_ttm','市现率 TTM']];
  const api = 'https://fuyao.aicubes.cn/api/a-share/';
  let imported = '';
  const state = {bars:[], name:'', quoteUrl:'', financials:[], valuation:null, stamp:null, report:''};

  function stock(input) {
    const match = /^(\d{6})(?:\.(SH|SZ|BJ))?$/.exec(input.trim().toUpperCase());
    if (!match) return null;
    const code = match[1];
    const venue = /^(60|68)/.test(code) ? 'SH' : /^(00|30)/.test(code) ? 'SZ' : /^(4|8|92)/.test(code) ? 'BJ' : '';
    if (!venue || (match[2] && match[2] !== venue)) return null;
    return {code, venue, id:code + '.' + venue};
  }

  async function json(url, headers = {}) {
    const control = new AbortController();
    const timeout = setTimeout(() => control.abort(), 10000);
    try {
      const res = await fetch(url, {headers, signal:control.signal, redirect:'error', cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer'});
      if (!res.ok) throw Error('来源 HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timeout); }
  }

  function parseBars(raw) {
    if (!Array.isArray(raw) || !raw.length) throw Error('缺少日线');
    const bars = raw.map(row => {
      if (!Array.isArray(row) || row.length < 5) throw Error('日线字段缺失');
      const [date, ...prices] = row.slice(0,5);
      const [open, close, high, low] = prices.map(v => (typeof v === 'string' || typeof v === 'number') ? Number(v) : NaN);
      const ts = Date.parse(date + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(ts) || new Date(ts).toISOString().slice(0,10) !== date || date > today()
          || ![open,close,high,low].every(v => Number.isFinite(v) && v > 0) || low > Math.min(open,close) || high < Math.max(open,close)) throw Error('日线字段异常');
      return {date,open,close,high,low};
    }).sort((a,b) => a.date.localeCompare(b.date));
    if (new Set(bars.map(r => r.date)).size !== bars.length) throw Error('交易日重复');
    return bars.slice(-60);
  }

  function draw() {
    if (!state.bars.length) return;
    const canvas = el('trend'), width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(width*ratio);
    canvas.height = Math.round(height*ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio,ratio);
    const closes = state.bars.map(row => row.close), max = Math.max(...closes), min = Math.min(...closes);
    const left = 58, right = width-8, top = 14, bottom = height-23;
    ctx.font='12px sans-serif'; ctx.fillStyle='#536673'; ctx.strokeStyle='#dbe2e4';
    for (const [y,price] of [[top,max],[bottom,min]]) {
      ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText(fmt(price),1,y+4);
    }
    ctx.beginPath();ctx.strokeStyle='#14675c';ctx.lineWidth=2;
    closes.forEach((close,i) => {
      const x = left + (right-left)*i/Math.max(closes.length-1,1);
      const y = max===min ? (top+bottom)/2 : top+(bottom-top)*(max-close)/(max-min);
      if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y);
      if (closes.length===1) ctx.fillRect(x-2,y-2,4,4);
    });
    ctx.stroke();
    ctx.fillText(state.bars[0].date,left,height-4);
    ctx.textAlign='right';ctx.fillText(state.bars.at(-1).date,right,height-4);
  }

  function resetReport() {
    state.report = '';
    el('download').hidden = el('report').hidden = true;
    text('report',''); text('report-status','');
  }
  function pairs(rows) {
    const dl = document.createElement('dl');
    for (const [label,value] of rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; dl.append(dt,dd);
    }
    return dl;
  }
  function title() { text('company-title',(state.name ? state.name + ' · ' : '') + symbol.id); }
  async function quotes() {
    if (symbol.venue === 'BJ') { text('quote-status','腾讯日线未覆盖北交所，可继续查询同花顺财报与估值。'); return; }
    const ticker = symbol.venue.toLowerCase() + symbol.code;
    for (const base of ['https://web.ifzq.gtimg.cn','https://proxy.finance.qq.com/ifzqgtimg']) {
      const url = new URL(base+'/appstock/app/fqkline/get');
      url.searchParams.set('param',ticker+',day,,,60,');
      try {
        const result = await json(url);
        const entry = result.data?.[ticker];
        if (Number(result.code) !== 0 || !entry) throw Error('没有该标的');
        const bars = parseBars(entry.day);
        const profile = entry.qt?.[ticker];
        if (Array.isArray(profile) && profile[2] === symbol.code && typeof profile[1] === 'string') state.name = profile[1];
        state.bars = bars; state.quoteUrl = url.href;
        const latest = bars.at(-1);
        title(); resetReport();
        text('quote-status','腾讯财经 · '+bars.length+' 个交易日 · 不复权日线');
        text('last-price',fmt(latest.close));
        text('bar-day',latest.date + (latest.date===today() ? ' · 当日日线，盘中可能变化' : ' · 最近返回的交易日'));
        el('quote-source').href = url.href;
        el('quote-source').textContent = '本次数据原文 ↗';
        el('quote-source').target = '_blank'; el('quote-source').rel = 'noopener noreferrer';
        el('bars').replaceChildren(...bars.slice().reverse().map(bar => {
          const tr = document.createElement('tr');
          for (const val of [bar.date,bar.open,bar.high,bar.low,bar.close]) {
            const td = document.createElement('td'); td.textContent = typeof val==='number' ? fmt(val) : val; tr.append(td);
          }
          return tr;
        }));
        el('prices').hidden = false; draw(); return;
      } catch { /* Retry the alternate documented host. */ }
    }
    text('quote-status','腾讯暂未返回可核验日线。可重新查询该代码，财报与估值仍可单独使用。');
  }

  const incomeUrl = id => api+'financials/income-statements?thscode='+id+'&period=annual&limit=2';
  const valuationUrl = id => api+'valuations/snapshot?thscodes='+id;
  async function official(url,key) {
    const reply = await json(url, {'X-api-key':key});
    if (!Number.isInteger(reply?.code)) throw Error('响应格式异常');
    if (reply.code !== 0) throw Error((byCode[reply.code] || '同花顺未返回数据')+'（'+reply.code+'）');
    if (!Array.isArray(reply.data?.item)) throw Error('缺少数据列表');
    return reply.data;
  }
  function dayOf(ts) { return Number.isSafeInteger(ts) && ts > 0 && Number.isFinite(new Date(ts).getTime()) ? chinaDay(ts) : null; }
  const withUnit = (v,unit) => Number.isFinite(v) ? fmt(v,4)+unit : '未提供';
  function showIncome(data) {
    const rows = data.item.filter(r=>r.thscode===symbol.id && r.period==='annual' && r.currency==='CNY' && dayOf(r.period_end_ms) && dayOf(r.period_end_ms)<=today()).sort((a,b)=>b.period_end_ms-a.period_end_ms).slice(0,2);
    if (!rows.length) throw Error('未返回该标的年报');
    state.financials=rows;
    text('finance-status','同花顺 · 合并利润表 · 人民币');
    for (const row of rows) {
      const h = document.createElement('h4'); h.textContent = '报告期末 '+dayOf(row.period_end_ms);
      el('financials').append(h,pairs([['营业收入',withUnit(row.operating_income,' 元')],['归母净利润',withUnit(row.parent_holder_net_profit,' 元')],['基本 EPS',withUnit(row.basic_eps,' 元/股')]]));
    }
  }
  function showValue(data) {
    const row = data.item.find(r=>r.thscode===symbol.id);
    if (!row) throw Error('未返回该标的估值');
    state.valuation = row; state.stamp = dayOf(data.timestamp);
    if (row.name && typeof row.name==='string') {state.name=row.name;title();}
    text('value-status','同花顺 · 指标来源日期 '+(state.stamp || '未提供'));
    el('valuations').replaceChildren(...pairs(valFields.map(([field,label])=>[label,withUnit(row[field],' 倍')])).children);
  }
  function failure(id,err) { text(id,err instanceof TypeError || err.name==='AbortError' ? '连接未完成，请检查网络后重试。' : err.message); }

  const rawSymbol = new URLSearchParams(location.search).get('symbol') ?? '600519.SH';
  const symbol = stock(rawSymbol);
  el('symbol').value = symbol?.id || rawSymbol.slice(0,9);
  el('symbol-form').addEventListener('submit',event=>{
    event.preventDefault();
    const next = stock(el('symbol').value);
    if (!next) {text('symbol-error','请输入沪深北 A 股六位代码，可带 .SH、.SZ 或 .BJ。');return;}
    location.assign('?symbol='+next.id);
  });
  if (!symbol) {
    text('symbol-error','该代码或交易所后缀无效，请重新查询。');
    text('quote-status','等待有效代码。');
    for (const b of document.querySelectorAll('#finance-form button,#report-form button')) b.disabled=true;
    return;
  }
  title(); text('finance-status','待查询');text('value-status','待查询');
  el('fy').value = today().slice(0,4);
  el('finance-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const key = el('api-key').value.trim();
    if (!key) return;
    const button = event.currentTarget.querySelector('button');
    el('api-key').value='';button.disabled=true;resetReport();
    state.financials=[];state.valuation=null;state.stamp=null;
    el('financials').replaceChildren();el('valuations').replaceChildren();
    text('finance-status','正在查询年报…');text('value-status','正在查询估值…');
    await Promise.all([
      official(incomeUrl(symbol.id),key).then(showIncome).catch(e=>failure('finance-status',e)),
      official(valuationUrl(symbol.id),key).then(showValue).catch(e=>failure('value-status',e))
    ]);
    button.disabled=false;resetReport();
  });

  function forecastGroup(envelope, year) {
    const period='FY'+year;
    const fields=['eps_consensus_mean','eps_consensus_min','eps_consensus_max','eps_analyst_count'];
    const records=fields.map(field => {
      const matches=envelope.evidence.filter(e=>e && e.symbol===symbol.code && e.market===symbol.venue && e.period===period && e.field===field && e.source==='ths' && e.endpoint==='worth.html');
      if (matches.length!==1) throw Error(period+' 缺少可核对的一致预期字段或字段重复。');
      const e=matches[0], count=field==='eps_analyst_count';
      if (!Number.isFinite(e.value) || e.unit!==(count?'家':'元/股') || (!count && e.currency!=='CNY') || typeof e.id!=='string' || !/^ev-[0-9a-f]{12}$/.test(e.id)) throw Error(period+' 证据单位或编号无效。');
      return e;
    });
    const [mean,low,high,count]=records.map(e=>e.value);
    if (!(low<=mean && mean<=high && Number.isInteger(count) && count>=1)) throw Error(period+' 的预测区间或机构数无效。');
    return {mean,note:period+' · '+count+' 家 · EPS 区间 '+low+' 至 '+high+' 元/股'+(count<3?' · 少于三家，可靠性有限':'')+' · '+records.map(e=>e.id).join('、')};
  }

  el('vibe-file').addEventListener('change',async event=>{
    const file=event.target.files[0];
    if (!file) return;
    try {
      if (file.size>8*1024*1024) throw Error('请选择单个 fetch_estimates.json。');
      const data=JSON.parse(await file.text());
      if (data?.script!=='fetch_estimates' || data.symbol!==symbol.code || data.market!==symbol.venue || !['ok','partial'].includes(data.status) || data.primary_source!=='ths' || !Array.isArray(data.evidence)) throw Error('需要当前标的的一致预期文件。逐篇研报或其他标的不能作为本股的一致预期。');
      const match=/^FY(20[0-9]{2})$/.exec(data.extra?.current_fy);
      if (!match || !Number.isFinite(Date.parse(data.fetched_at))) throw Error('缺少预测财年或采集时间。');
      const year=Number(match[1]), base=forecastGroup(data,year), end=forecastGroup(data,year+2);
      resetReport();
      el('fy').value=year;el('eps-start').value=base.mean;el('eps-end').value=end.mean;
      el('estimate-source').value='Vibe Research · 同花顺一致预期 · 采集 '+data.fetched_at;
      imported=[base.note,end.note].join('\n');
      text('vibe-status','已导入 FY'+year+' 和 FY'+(year+2)+'，证据编号随报告导出。');
    } catch(e) {text('vibe-status','本次导入未应用。'+(e instanceof SyntaxError?'文件不是有效 JSON。':e.message));}
    event.target.value='';
  });
  for (const id of ['fy','eps-start','eps-end','estimate-source']) {
    el(id).addEventListener('input',()=>{
      if (imported) {
        imported='';
        el('estimate-source').value='';
        text('vibe-status','预测输入已手动修改，请重新填写出处。');
      }
    });
  }

  function buildReport() {
    const fy = el('fy').valueAsNumber, a = el('eps-start').valueAsNumber, b = el('eps-end').valueAsNumber;
    const src = el('estimate-source').value.trim(), latest = state.bars.at(-1);
    const entered = el('eps-start').value || el('eps-end').value || src;
    if (entered && !(Number.isInteger(fy) && src && Number.isFinite(a) && Number.isFinite(b))) throw Error('请填写两期预测 EPS、起始财年及预测出处，或清空预测输入后生成。');
    const gaps = [];
    const lines = ['# '+(state.name || symbol.id)+' 个股研究','标的 '+symbol.id+' · 生成日期 '+today(),'','## 公司与行情'];
    if (latest) lines.push('腾讯日线收盘字段 '+fmt(latest.close)+' 元（不复权，'+latest.date+'）。','数据原文 '+state.quoteUrl);
    else { lines.push(el('quote-status').textContent);gaps.push('日线价格'); }
    lines.push('','## 财务');
    if (state.financials.length) {
      for (const row of state.financials) lines.push(dayOf(row.period_end_ms)+' 年报 · 营收 '+withUnit(row.operating_income,' 元')+' · 归母净利润 '+withUnit(row.parent_holder_net_profit,' 元')+' · 基本 EPS '+withUnit(row.basic_eps,' 元/股'));
      lines.push('来源 同花顺合并利润表 '+incomeUrl(symbol.id));
    } else {lines.push('未取得同花顺年报。');gaps.push('年报');}
    lines.push('','## 盈利预期');
    if (entered) lines.push((imported?'文件证据 · ':'用户录入 · ')+src,'FY'+fy+' EPS '+a+' 元/股 · FY'+(fy+2)+' EPS '+b+' 元/股',
      '两年预测 EPS CAGR = (期末 EPS / 期初 EPS)^(1/2) − 1 · '+(a>0 && b>0 ? withUnit((Math.sqrt(b/a)-1)*100,'%') : 'EPS 非正，指标无意义'));
    else {lines.push('未录入带出处的预测 EPS。');gaps.push('盈利预期');}
    if (imported) lines.push(imported);
    lines.push('','## 估值');
    if (state.valuation) {
      lines.push('同花顺指标日期 '+(state.stamp||'未提供'),...valFields.map(([k,label])=>label+' '+withUnit(state.valuation[k],' 倍')),'来源 '+valuationUrl(symbol.id));
    } else {lines.push('未取得同花顺估值快照。');gaps.push('估值快照');}
    if (entered && latest) lines.push('基于 '+latest.date+' 日线价格的前瞻 PE = '+latest.close+' / '+a+' · '+(a>0 ? withUnit(latest.close/a,' 倍') : 'EPS 非正，指标无意义'));
    lines.push('','## 风险与反证',el('risk').value.trim()||'待补反证。','','## 下次核验',el('next-check').value.trim()||'待填写核验事项。','','## 数据缺口',gaps.join('、') || '以上栏目已取得输入，仍需核对财务口径和预测来源。');
    return lines.join('\n');
  }
  el('report-form').addEventListener('input',resetReport);
  el('report-form').addEventListener('submit',event=>{
    event.preventDefault();resetReport();
    try { state.report=buildReport();text('report',state.report);el('report').hidden=el('download').hidden=false;text('report-status','已生成本次研究记录。'); }
    catch(e) {failure('report-status',e);}
  });
  el('download').addEventListener('click',()=>{
    if (!state.report) return;
    const url=URL.createObjectURL(new Blob([state.report],{type:'text/markdown;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=symbol.id+'-个股研究-'+today()+'.md';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  window.addEventListener('pagehide',()=>{el('api-key').value='';});
  new ResizeObserver(draw).observe(el('trend'));
  quotes();
})();
