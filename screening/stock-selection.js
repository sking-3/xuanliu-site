'use strict';
(() => {
  const desk = document.querySelector('[data-selection]');
  if (!desk) return;
  const el = id => document.getElementById(id);
  const label = (id, value) => { el(id).textContent = value; };
  const size = 20;
  const fmt = (n, digits=2) => Number.isFinite(n) ? n.toLocaleString('zh-CN',{maximumFractionDigits:digits}) : '—';
  const pct = n => Number.isFinite(n) ? (n>0?'+':'')+fmt(n)+'%' : '—';
  const cacheKey = 'books.screening.marketSnapshot.v1', savedKey = 'books.screening.watchlist.v1';
  let pool, asOf = '', openedOnline = false, filtered = [], page = 0, runner, results = [], scanMemo = new Map();
  let saved = new Set();
  let segmentName='';
  let scanAll=false, scanTotal=0, techPage=0, stopReason='';
  try {
    const codes = JSON.parse(localStorage.getItem(savedKey));
    if (Array.isArray(codes)) saved = new Set(codes.filter(s=>/^\d{6}\.(SH|SZ|BJ)$/.test(s)));
  } catch {}
  const empty = (body,col,message) => {
    const tr=document.createElement('tr'), td=document.createElement('td');
    td.colSpan=col;td.textContent=message;tr.append(td);body.append(tr);
  };
  function cell(tr, value, mobileLabel='') {
    const td = document.createElement('td');
    if (mobileLabel) td.dataset.label=mobileLabel;
    if (typeof value==='string') td.textContent=value; else td.append(value);
    tr.append(td);return td;
  }
  function stockAnchor(row) {
    const a=document.createElement('a'), code=document.createElement('span');
    a.href='../company-dossier.html?symbol='+encodeURIComponent(row.code);
    code.className='stock-code';code.textContent=row.code;
    a.append(row.name,code);
    return a;
  }
  function scope() { return filtered.slice(page*size,(page+1)*size); }
  function halt() {
    if (runner) runner.abort();
    runner=null;
  }
  function controls() {
    return {chain:el('pick-chain').value,sector:el('pick-sector').value,venue:el('pick-venue').value,query:el('pick-query').value.trim(),
      minChange:el('pick-min-change').valueAsNumber,maxChange:el('pick-max-change').valueAsNumber,
      minCap:el('pick-cap-min').valueAsNumber,maxCap:el('pick-cap-max').valueAsNumber,
      onlySaved:el('pick-saved').checked,saved};
  }
  function validation(options) {
    for (const [min,max,name] of [['minChange','maxChange','涨跌幅'],['minCap','maxCap','总市值']]) {
      if (!Number.isFinite(options[min])) options[min]=null;
      if (!Number.isFinite(options[max])) options[max]=null;
      if (options[min]!==null && options[max]!==null && options[min]>options[max]) return name+'下限高于上限，请调整。';
    }
    if ((options.minCap??0)<0 || (options.maxCap??0)<0) return '总市值范围须为非负数。';
    return '';
  }
  function renderPage() {
    const body=el('pick-rows');body.replaceChildren();
    const rows=scope();
    for (const stock of rows) {
      const tr=document.createElement('tr');tr.dataset.code=stock.code;
      cell(tr,stockAnchor(stock));cell(tr,stock.sector,'行业');
      cell(tr,fmt(stock.price),'价格');cell(tr,pct(stock.changePct),'涨跌').className=stock.changePct>0?'change-up':stock.changePct<0?'change-down':'';
      cell(tr,Number.isFinite(stock.totalMarketCap)?fmt(stock.totalMarketCap/1e8):'—','市值/亿');
      const button=document.createElement('button');button.type='button';button.dataset.save=stock.code;
      button.setAttribute('aria-pressed', String(saved.has(stock.code)));
      button.setAttribute('aria-label',(saved.has(stock.code)?'移出自选 ':'加入自选 ')+stock.name);
      button.textContent=saved.has(stock.code)?'已自选':'＋ 自选';cell(tr,button);
      body.append(tr);
    }
    if (!rows.length) empty(body,6,pool?'没有符合当前条件的股票。':'等待可核验的行情快照。');
    const pages=Math.ceil(filtered.length/size);
    label('pick-count',pool?'符合 '+fmt(filtered.length)+' / '+fmt(pool.rows.length)+' 只有效报价':'暂无有效报价');
    label('pick-page',pages?'第 '+(page+1)+' / '+pages+' 页':'0 页');
    label('pick-saved-count','('+saved.size+')');
    el('pick-prev').disabled=page===0;el('pick-next').disabled=page+1>=pages;
    el('pick-run').disabled=!rows.length || Boolean(runner);
    el('pick-run-all').disabled=!filtered.length || Boolean(runner);
    el('pick-stop').hidden=!runner;
  }
  function renderTech() {
    const body=el('pick-tech-rows');body.replaceChildren();
    const rows=results.filter(Boolean), checked=rows.filter(r=>r.result.status==='ready').length;
    const matched=rows.filter(r=>r.result.turtle || r.result.increasing);
    const missing=rows.length-checked, title=scanAll?'全部筛选结果':'当前页';
    label('pick-tech-status',rows.length || runner || stopReason?
      title+' · '+(runner?'核验中':stopReason || '核验完成')+' · '+rows.length+' / '+scanTotal+' 只 · '+matched.length+' 只命中 · '+missing+' 只资料不足':
      (scope().length?'当前页 '+scope().length+' 只，可按同一批次日期核验。':'当前页没有可核验的股票。'));
    const onlyHits=el('pick-hits').checked, visible=onlyHits?matched:rows;
    const pages=Math.ceil(visible.length/size);
    techPage=Math.max(0,Math.min(techPage,pages-1));
    el('pick-tech-pages').hidden=pages<=1;
    label('pick-tech-page',(techPage+1)+' / '+pages);
    el('pick-tech-prev').disabled=techPage===0;el('pick-tech-next').disabled=techPage+1>=pages;
    for (const {stock,result} of visible.slice(techPage*size,(techPage+1)*size)) {
      const tr=document.createElement('tr');
      tr.dataset.code=stock.code;tr.dataset.status=result.status;
      cell(tr,stockAnchor(stock));
      if (result.status==='ready') {
        tr.dataset.turtle=String(result.turtle);tr.dataset.increasing=String(result.increasing);
        cell(tr,result.turtle?'命中':'未命中','60 日新高');cell(tr,result.increasing?'命中':'未命中','MA30');
        cell(tr,'前复权收盘 '+fmt(result.close)+' / 60 日最高收盘 '+fmt(result.high60)+' 元 · MA30 首末变化 '+pct(result.ma30GrowthPct));
      } else {
        cell(tr,'—','60 日新高');cell(tr,'—','MA30');cell(tr,result.reason || '同日有效样本不足');
      }
      body.append(tr);
    }
    if (onlyHits && rows.length && !body.children.length) empty(body,4,runner?'已核验部分暂无命中。':'已核验的股票中暂无命中。');
  }
  function update(resetPage=true) {
    halt();results=[];techPage=0;stopReason='';scanAll=false;
    if(resetPage) page=0;
    const options=controls(), invalid=validation(options);
    label('pick-notice',invalid);
    filtered=pool && !invalid ? window.BooksMarketPool.select(pool.rows,options) : [];
    const chain=window.BooksMarketPool.chains.find(c=>c.name===options.chain);
    const segment=chain?.segments.find(s=>s.name===segmentName);
    if (segment) filtered=filtered.filter(stock=>segment.codes.includes(stock.code));
    else segmentName='';
    const group=el('pick-segments');
    group.hidden=!chain;
    group.replaceChildren();
    if (chain) {
      for (const name of ['',...chain.segments.map(s=>s.name)]) {
        const b=document.createElement('button');
        b.type='button';b.textContent=name || '全部环节';
        b.setAttribute('aria-pressed',String(segmentName===name));
        b.addEventListener('click',()=>{segmentName=name;update();el('pick-segments').querySelector('[aria-pressed=true]')?.focus();});
        group.append(b);
      }
    }
    const order=el('pick-sort').value;
    if (order==='down') filtered.sort((a,b)=>a.changePct-b.changePct || a.code.localeCompare(b.code));
    if (order==='cap') filtered.sort((a,b)=>(b.totalMarketCap??-1)-(a.totalMarketCap??-1) || a.code.localeCompare(b.code));
    page=Math.max(0,Math.min(page,Math.ceil(filtered.length/size)-1));
    renderPage();renderTech();
  }
  async function scan(all=false) {
    halt();
    const batch=all?filtered.slice():scope(), day=pool?.day;
    if (!day || !batch.length) return;
    const controller=new AbortController();runner=controller;results=[];
    scanAll=all;scanTotal=batch.length;techPage=0;stopReason='';renderPage();renderTech();
    let index=0;
    async function worker() {
      while (!controller.signal.aborted && index<batch.length) {
        const i=index++, stock=batch[i], key=asOf+'/'+stock.code;
        let result=scanMemo.get(key);
        const fresh=!result;
        if (fresh) {
          try { result=await window.BooksTechnicalScreen.run({...stock,asOf},day,controller.signal); }
          catch { result={status:'unavailable',reason:'日线请求未完成，可重试。'}; }
        }
        if (controller.signal.aborted || runner!==controller) return;
        if (result.status==='ready') scanMemo.set(key,result);
        results[i]={stock,result};
        if (result.reason?.includes('限制访问')) {
          stopReason='来源限制访问，已停止';halt();renderPage();renderTech();return;
        }
        // In a long scan yield between provider requests and repaint cached hits in chunks.
        if (fresh || i%size===0) renderTech();
        if (all && fresh && stock.exchange!=='BJ' && index<batch.length && !controller.signal.aborted)
          await new Promise(resolve=>setTimeout(resolve,1000));
        else if (all && i%size===0) await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    await Promise.all(Array.from({length:Math.min(batch.length,all?1:3)},worker));
    if (runner!==controller) return;
    runner=null;renderPage();renderTech();
  }
  function sectorView() {
    const select=el('pick-sector'), before=select.value;
    select.replaceChildren(new Option('全部行业',''));
    for (const sector of pool.sectors) select.add(new Option(sector.name+'（'+sector.count+'）',sector.name));
    select.value=pool.sectors.some(s=>s.name===before)?before:'';
    const box=desk.querySelector('[data-sector-summary]');box.replaceChildren();
    const title=document.createElement('strong');title.textContent='行业平均涨幅前五';box.append(title);
    for (const s of pool.sectors.slice(0,5)) {
      const b=document.createElement('button');b.type='button';b.textContent=s.name+' '+pct(s.meanChange);
      b.title='等权均值 · '+s.count+' 只 · 涨 '+s.up+' / 平 '+s.flat+' / 跌 '+s.down;
      b.addEventListener('click',()=>{select.value=s.name;update();});box.append(b);
    }
  }
  function accept(snapshot, from) {
    const next=window.BooksMarketPool.build(snapshot);
    if (pool && Date.parse(snapshot.updatedAt)<Date.parse(asOf)) return;
    const changed = asOf!==snapshot.updatedAt;
    pool=next;asOf=snapshot.updatedAt;
    desk.dataset.state='ready';desk.dataset.day=pool.day;desk.dataset.origin=from;
    const clock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(asOf));
    label('pick-source',pool.day+' '+clock+' 北京时间 · '+(from==='cache'?'本机上次快照':'来源快照')+' · '+fmt(pool.rows.length)+' 只有效报价 · '+pool.sectors.length+' 个行业');
    sectorView();
    if (from==='upstream') {
      try { localStorage.setItem(cacheKey,JSON.stringify(snapshot)); } catch {}
    }
    if (changed) {scanMemo.clear();update();}
    if (!openedOnline && from==='upstream') {openedOnline=true;scan();}
  }
  function unavailable() {
    if (pool) { label('pick-source',el('pick-source').textContent.replace(/ · 刷新失败$/,'')+' · 刷新失败');return; }
    desk.dataset.state='unavailable';label('pick-source','行情来源暂不可用。可点击刷新快照重试。');
    update();
  }
  const chains=window.BooksMarketPool.chains;
  for (const chain of chains) el('pick-chain').add(new Option(chain.name+'（'+chain.codes.length+'）',chain.name));
  window.BooksStockSelection = {accept,unavailable};
  for (const id of ['pick-query','pick-min-change','pick-max-change','pick-cap-min','pick-cap-max']) el(id).addEventListener('input',()=>update());
  for (const id of ['pick-chain','pick-sector','pick-venue','pick-saved','pick-sort']) el(id).addEventListener('change',()=>update());
  el('pick-hits').addEventListener('change',()=>{techPage=0;renderTech();});
  el('pick-tech-prev').addEventListener('click',()=>{techPage--;renderTech();});
  el('pick-tech-next').addEventListener('click',()=>{techPage++;renderTech();});
  el('pick-prev').addEventListener('click',()=>{page--;if(scanAll) renderPage();else update(false);});
  el('pick-next').addEventListener('click',()=>{page++;if(scanAll) renderPage();else update(false);});
  el('pick-reset').addEventListener('click',()=>{
    for (const id of ['pick-chain','pick-sector','pick-venue','pick-query','pick-min-change','pick-max-change','pick-cap-min','pick-cap-max']) el(id).value='';
    el('pick-saved').checked=false;el('pick-sort').value='up';update();
  });
  el('pick-rows').addEventListener('click',event=>{
    const b=event.target.closest('button[data-save]');if (!b) return;
    const code=b.dataset.save;
    if(saved.has(code)) saved.delete(code);else saved.add(code);
    let persisted=true;
    try {localStorage.setItem(savedKey,JSON.stringify([...saved]));}catch{persisted=false;}
    if (el('pick-saved').checked) update(false);
    else renderPage();
    for (const btn of el('pick-rows').querySelectorAll('[data-save]')) if (btn.dataset.save===code) btn.focus();
    if (!persisted) label('pick-notice','自选仅保存在本次页面中，浏览器存储不可用。');
  });
  el('pick-run').addEventListener('click',()=>scan(false));
  el('pick-run-all').addEventListener('click',()=>scan(true));
  el('pick-stop').addEventListener('click',()=>{stopReason='已停止';halt();renderPage();renderTech();});
  el('pick-refresh').addEventListener('click',()=>window.dispatchEvent(new Event('books:refresh-selection')));
  window.addEventListener('pagehide',()=>{
    if (runner) {stopReason='已停止';halt();renderPage();renderTech();}
  });
  update();
  try {const last=localStorage.getItem(cacheKey);if(last) accept(JSON.parse(last),'cache');} catch {}
})();
