'use strict';
(() => {
const $ = id => document.getElementById(id);
const periods = ['7D','30D','90D','180D','365D','ALL'];
const exchanges = ['Binance','OKX','Hyperliquid','Gate','Bitget','Bybit','Polymarket'];
const currencies = ['USDT','USD','USDC','BTC','ETH'];
const controls = ['period','exchange','source','sort','currency'];
const storageKey = 'books.trader.records.v1', maxBytes = 2097152;
const state = {status:'unavailable', publicRows:[], localRows:[], rows:[], page:1, detail:null, window:'30D', tab:'analysis', loading:false, explicitPeriod:false, editor:null, storageReadError:false, revealId:null};
const fail = () => { throw Error('数据格式未通过校验，未展示此批记录。'); };
const text = (v, n=200) => typeof v === 'string' && v.trim().length > 0 && v.length <= n ? v.trim() : fail();
const optionalText = (v,n) => v === undefined || v === '' ? '' : text(v,n);
const num = v => v === null ? null : typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e15 ? v : fail();
const integer = v => v === null ? null : Number.isSafeInteger(v) && v >= 0 ? v : fail();
function date(v) {
  if(typeof v !== 'string') return fail();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/);
  if(!m || +m[2]<1 || +m[2]>12 || +m[3]<1 || +m[3]>new Date(Date.UTC(+m[1],+m[2],0)).getUTCDate() || !Number.isFinite(Date.parse(v)) || Date.parse(v)>Date.now()+300000) return fail();
  return v;
}
function validate(p) {
  if(p?.schemaVersion !== 1 || !['ready','unavailable'].includes(p.status) || !Array.isArray(p.traders) || p.traders.length > 500) fail();
  if(p.status === 'unavailable' && p.traders.length) fail();
  const ids = new Set();
  return p.traders.map(r => {
    if(!r || typeof r !== 'object' || Array.isArray(r)) fail();
    const id = text(r.id,100), name = text(r.name,100);
    if(ids.has(id)) fail(); ids.add(id);
    if(!exchanges.includes(r.exchange) || !currencies.includes(r.currency) || typeof r.featured !== 'boolean' || typeof r.paid !== 'boolean') fail();
    const observedAt = date(r.observedAt);
    let url; try { url = new URL(r.sourceUrl); } catch { fail(); }
    if(url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) fail();
    if(!r.windows || typeof r.windows !== 'object' || Array.isArray(r.windows)) fail();
    const windows = {};
    for(const [k,w] of Object.entries(r.windows)) {
      if(!periods.includes(k) || !w || typeof w !== 'object' || Array.isArray(w)) fail();
      const asOf = date(w.asOf);
      if(Date.parse(asOf)>Date.parse(observedAt)) fail();
      const clean = {asOf, roi:num(w.roi), pnl:num(w.pnl), mdd:num(w.mdd), wins:integer(w.wins), closedTrades:integer(w.closedTrades), curve:[]};
      if(w.asOfType !== undefined) {
        if(!['source','observed','imported'].includes(w.asOfType)) fail();
        clean.asOfType = w.asOfType;
      }
      if(clean.mdd !== null && (clean.mdd<0 || clean.mdd>100)) fail();
      if(clean.wins !== null && (clean.closedTrades === null || clean.wins>clean.closedTrades)) fail();
      if(!Array.isArray(w.curve) || w.curve.length>1000) fail();
      let previous = -Infinity;
      for(const pt of w.curve) {
        if(!pt || typeof pt !== 'object' || Array.isArray(pt)) fail();
        const time = date(pt.time), value = num(pt.value), stamp = Date.parse(time);
        if(value === null || stamp<=previous || stamp>Date.parse(asOf) || (k!=='ALL' && stamp<Date.parse(asOf)-parseInt(k,10)*86400000)) fail();
        previous = stamp; clean.curve.push({time,value});
      }
      windows[k] = clean;
    }
    const clean = {id,name,exchange:r.exchange,currency:r.currency,featured:r.featured,paid:r.paid,observedAt,sourceUrl:url.href,windows,accountId:optionalText(r.accountId,100),note:optionalText(r.note,500)};
    for(const k of ['positions','points','orders']) {
      if(!Array.isArray(r[k]) || r[k].length>1000) fail();
      clean[k] = r[k].map(row => {
        if(!row || typeof row !== 'object' || Array.isArray(row)) fail();
        const time = date(row.time), symbol = text(row.symbol,40);
        if(Date.parse(time)>Date.parse(observedAt) || !['long','short','buy','sell'].includes(row.side)) fail();
        const item = {time,symbol,side:row.side,price:num(row.price),quantity:num(row.quantity),pnl:num(row.pnl)};
        if(item.price !== null && item.price<0 || item.quantity !== null && item.quantity<0) fail();
        return item;
      });
    }
    return clean;
  });
}
function feed(rows) { return {schemaVersion:1,status:'ready',traders:rows}; }
function mergeRows() { state.rows = [...state.publicRows.map(r=>({...r,_local:false})),...state.localRows.map(r=>({...r,_local:true}))]; }
function node(tag,content,cls) { const n=document.createElement(tag); if(content!==undefined)n.textContent=content; if(cls)n.className=cls; return n; }
function button(label, action, cls) { const b=node('button',label,cls); b.type='button'; b.addEventListener('click',action); return b; }
function sourceLink(r) { const a=node('a','查看来源 ↗','source-link'); a.href=r.sourceUrl; a.target='_blank'; a.rel='noopener noreferrer'; return a; }
function pct(x) { return x==null?'—':x.toFixed(2)+'%'; }
function value(x) { return x==null?'—':x!==0&&Math.abs(x)<1e-8?x.toExponential(2):x.toLocaleString('en-US',{maximumFractionDigits:8}); }
function win(w) { return w?.wins!=null&&w?.closedTrades>0?w.wins/w.closedTrades*100:null; }
function periodLabel(p) { return p==='ALL'?'累计':p; }
function hasMetrics(w) { return !!w && (['roi','pnl','mdd','wins','closedTrades'].some(k=>w[k]!=null)||w.curve.length>0); }
function stampLabel(w) {
  if(!w) return '';
  const stamp = new Date(w.asOf).toLocaleString('zh-CN',{hour12:false});
  if(w.asOfType==='imported') return `记录于 ${stamp} · 快照日期未知`;
  if(w.asOfType==='observed') return `读取于 ${stamp} · 来源更新时间未提供`;
  return `数据截至 ${stamp}`;
}
function feedback(message) { $('local-feedback').textContent=message; }
function empty(target,title,body,allowAdd=false) {
  const e=node('div',undefined,'empty'); e.append(node('strong',title),node('span',body));
  if(allowAdd)e.append(button('添加带单员',()=>openEditor(), 'primary'));
  target.append(e);
}
function chart(w) {
  const el=node('div',undefined,'chart'), pts=w?.curve||[];
  if(pts.length<2) { el.textContent='暂无收益曲线'; return el; }
  const values=pts.map(p=>p.value),lo=Math.min(...values),hi=Math.max(...values),start=Date.parse(pts[0].time),end=Date.parse(pts.at(-1).time);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 300 90'); svg.setAttribute('role','img');
  svg.setAttribute('aria-label',`来源收益曲线：${pts.length} 个样本，起点 ${pts[0].value}%，终点 ${pts.at(-1).value}%；${pts[0].time} 至 ${pts.at(-1).time}`);
  const line=document.createElementNS(svg.namespaceURI,'polyline');
  line.setAttribute('points',pts.map(p=>`${8+284*(Date.parse(p.time)-start)/(end-start)},${hi===lo?45:80-70*(p.value-lo)/(hi-lo)}`).join(' ')); svg.append(line); el.append(svg); return el;
}
function metrics(w,currency,includeROI=false) {
  const el=node('div',undefined,'metrics');
  const items=[['盈亏 '+currency,value(w?.pnl)],['最大回撤',pct(w?.mdd)],['逐笔胜率',pct(win(w))]];
  if(includeROI)items.unshift(['收益率',pct(w?.roi)]);
  for(const [label,v]of items) { const c=node('div'); c.append(node('small',label),node('strong',v)); el.append(c); }
  return el;
}
function card(r,period) {
  const w=r.windows[period],c=node('article',undefined,'card'),top=node('div',undefined,'card-top'),identity=node('div');
  identity.append(node('h3',r.name),node('div',`${r.exchange} · ${r.accountId||r.id}${r.paid?' · 付费来源':''}`,'meta'));
  top.append(node('div',r.exchange.slice(0,2),'avatar'),identity); c.append(top);
  const tags=node('div',undefined,'coverage-tags');
  tags.append(node('span',r.currency)); if(r._local)tags.append(node('span','我的资料','local-label'));
  for(const key of periods.filter(k=>hasMetrics(r.windows[k])))tags.append(node('span',periodLabel(key)));
  c.append(tags);
  if(r.note)c.append(node('p',r.note,'profile-note'));
  if(hasMetrics(w)) {
    c.append(node('div',pct(w.roi),'roi '+(w.roi>0?'positive':w.roi<0?'negative':'')),node('div',`${periodLabel(period)} 收益率`,'meta'),metrics(w,r.currency));
    if(w.curve.length>1)c.append(chart(w));
    c.append(node('p',stampLabel(w),'meta'));
  } else c.append(node('p',Object.keys(r.windows).length?`${periodLabel(period)} 表现 —`:'账号与来源已保存','meta'));
  const actions=node('div',undefined,'card-actions'); actions.append(button('研究详情',()=>openDetail(r,period),'detail-button'),sourceLink(r));
  if(r._local)actions.append(button('编辑',()=>openEditor(r)),button('删除',()=>removeRecord(r)));
  c.append(actions); return c;
}
function readURL() {
  const p=new URL(location.href).searchParams, defaults={period:'30D',exchange:'all',source:'all',sort:'roi',currency:'all'};
  state.explicitPeriod=periods.includes(p.get('period'));
  for(const id of controls) { const el=$(id); el.value=[...el.options].some(o=>o.value===p.get(id))?p.get(id):defaults[id]; }
  $('search').value=(p.get('q')||'').slice(0,100); const page=Number(p.get('page')); state.page=Number.isSafeInteger(page)&&page>0?page:1;
}
function saveURL(replace=false) {
  const url=new URL(location.href); for(const id of controls)url.searchParams.set(id,$(id).value);
  const q=$('search').value.trim(); if(q)url.searchParams.set('q',q);else url.searchParams.delete('q');
  if(state.page>1)url.searchParams.set('page',state.page);else url.searchParams.delete('page');
  if(url.href!==location.href)history[replace?'replaceState':'pushState'](null,'',url.pathname+url.search+url.hash);
}
function choosePeriod() {
  if(state.explicitPeriod)return;
  const available=periods.filter(p=>state.rows.some(r=>hasMetrics(r.windows[p])));
  if(available.length && !available.includes($('period').value))$('period').value=available.includes('90D')?'90D':available[0];
}
function render() {
  const q=$('search').value.trim().toLocaleLowerCase(),p=$('period').value,source=$('source').value,currency=$('currency').value;
  let rows=state.rows.filter(r=>(r.name+' '+r.id+' '+r.accountId+' '+r.exchange+' '+r.note).toLocaleLowerCase().includes(q) && ($('exchange').value==='all'||r.exchange===$('exchange').value) && (source==='all'||source==='local'&&r._local||source==='paid'&&r.paid||source==='public'&&!r._local&&!r.paid) && (currency==='all'||r.currency===currency));
  const sort=$('sort').value,grouped=sort==='pnl'&&currency==='all';
  rows.sort((a,b)=>{
    if(grouped&&a.currency!==b.currency)return currencies.indexOf(a.currency)-currencies.indexOf(b.currency);
    const wa=a.windows[p],wb=b.windows[p],va=sort==='winRate'?win(wa):wa?.[sort],vb=sort==='winRate'?win(wb):wb?.[sort];
    if(va==null&&vb==null)return a.id.localeCompare(b.id);if(va==null)return 1;if(vb==null)return -1;
    return (sort==='mdd'?va-vb:vb-va)||a.id.localeCompare(b.id);
  });
  const pages=Math.max(1,Math.ceil(rows.length/12));if(state.revealId){const at=rows.findIndex(r=>r.id===state.revealId);if(at>=0)state.page=Math.floor(at/12)+1;state.revealId=null;}if(!state.loading)state.page=Math.max(1,Math.min(state.page,pages));
  $('leaders').replaceChildren();for(const r of rows.slice((state.page-1)*12,state.page*12))$('leaders').append(card(r,p));
  if(!rows.length)empty($('leaders'),state.rows.length?'没有符合条件的资料':'暂无带单员资料',state.rows.length?'调整筛选条件，查看其他记录。':'获取数据后将在这里显示表现和交易记录。');
  $('featured').replaceChildren();const featured=state.rows.filter(r=>r.featured);$('featured-section').hidden=!featured.length;
  for(const r of featured) { const best=hasMetrics(r.windows.ALL)?'ALL':hasMetrics(r.windows[p])?p:periods.find(k=>hasMetrics(r.windows[k]))||p; $('featured').append(card(r,best)); }
  $('total-count').textContent=state.rows.length;$('coverage-count').textContent=state.rows.filter(r=>Object.values(r.windows).some(hasMetrics)).length;$('local-count').textContent=state.localRows.length;
  $('count').textContent=`${rows.length} 位带单员${state.rows.length!==rows.length?' · 共 '+state.rows.length+' 位':''}${grouped?' · 按币种分组':''}`;
  $('page').textContent=rows.length?`${state.page} / ${pages}`:'0 / 0';$('prev').disabled=state.loading||!rows.length||state.page===1;$('next').disabled=state.loading||!rows.length||state.page>=pages;
}
function statusText() {
  if(state.status==='error')return state.localRows.length?'公开资料暂不可用；我的资料仍可查看。':'公开资料暂不可用，可添加自己的研究资料。';
  if(state.publicRows.length)return `公开资料 ${state.publicRows.length} 位 · 我的资料 ${state.localRows.length} 位`;
  return state.localRows.length?'我的资料保存在当前浏览器。':'公开资料 0 位';
}
function updateView(message) { mergeRows();choosePeriod();render();$('status').textContent=statusText();if(message)feedback(message); }
function openDetail(r,p) {
  state.detail=r;state.window=p;state.tab='analysis';$('detail-title').textContent=r.name;
  $('detail-meta').textContent=`${r.exchange} · ${r.accountId||r.id} · ${r.currency}${r._local?' · 我的资料':''}`;
  renderDetail();$('detail').showModal();$('close').focus();
}
function renderDetail() {
  const r=state.detail,b=$('detail-body');if(!r)return;b.replaceChildren();
  document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.tab===state.tab)));
  if(state.tab==='analysis') {
    const w=r.windows[state.window];b.append(node('h3',`${periodLabel(state.window)} 表现`));
    if(hasMetrics(w)) { b.append(metrics(w,r.currency,true),node('p',stampLabel(w),'meta'));if(w.curve.length>1)b.append(chart(w));if(w.closedTrades!=null||w.wins!=null)b.append(node('p',`已关闭交易 ${value(w.closedTrades)} 笔 · 盈利交易 ${value(w.wins)} 笔`)); }
    else b.append(node('p','当前周期暂无表现记录。'));
    if(r.note)b.append(node('h3','研究备注'),node('p',r.note,'profile-note'));
    b.append(sourceLink(r));return;
  }
  const rows=r[state.tab];b.append(node('p',`${rows.length} 条来源记录 · 未按广场周期裁剪`));
  if(!rows.length){empty(b,'暂无记录','此来源尚未提供该项数据。');return;}
  const wrap=node('div',undefined,'table-wrap'),table=node('table'),head=node('thead'),tr=node('tr');
  for(const title of ['时间（含时区）','品种','方向','价格','数量','盈亏 '+r.currency])tr.append(node('th',title));head.append(tr);
  const tbody=node('tbody');for(const row of rows){const t=node('tr');for(const v of [row.time,row.symbol,row.side,value(row.price),value(row.quantity),value(row.pnl)])t.append(node('td',v));tbody.append(t);}
  table.append(head,tbody);wrap.append(table);b.append(wrap);
}
function loadLocal() {
  try { const saved=localStorage.getItem(storageKey);if(saved){if(new Blob([saved]).size>maxBytes)fail();state.localRows=validate(JSON.parse(saved));}state.storageReadError=false; }
  catch { state.storageReadError=true;feedback('本机资料读取失败，原有存储未改动。本次已暂停写入，请稍后刷新重试。'); }
  mergeRows();
}
function commitLocal(rows) {
  if(state.storageReadError)throw Error('旧资料尚未成功读取，原有存储未改动，暂不能写入。请稍后刷新重试。');
  const checked=validate(feed(rows)),serialized=JSON.stringify(feed(checked));
  if(new Blob([serialized]).size>maxBytes)throw Error('本机资料超过 2 MB，本次未保存。请先整理已有资料。');
  try { localStorage.setItem(storageKey,serialized); } catch { throw Error('浏览器未能保存资料，请检查存储权限或剩余空间。现有资料未改动。'); }
  state.localRows=checked;mergeRows();return checked;
}
function localDateValue(iso) {
  if(!iso)return '';const d=new Date(iso),pad=v=>String(v).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fillWindow(period) {
  const w=state.editor.windows[period];state.editor.period=period;
  $('record-period').value=period;$('record-asof').value=localDateValue(w?.asOf);
  for(const [id,key]of [['roi','roi'],['pnl','pnl'],['mdd','mdd'],['wins','wins'],['trades','closedTrades']])$('record-'+id).value=w?.[key]??'';
}
function openEditor(record) {
  const r=record?validate(feed([record]))[0]:null;
  state.editor={id:r?.id||'',original:r,windows:r?JSON.parse(JSON.stringify(r.windows)):{},period:'30D'};
  $('record-editor-title').textContent=r?'编辑带单员':'添加带单员';$('record-error').textContent='';
  for(const [field,v]of Object.entries({id:r?.id||'',name:r?.name||'',account:r?.accountId||'',exchange:r?.exchange||'OKX',currency:r?.currency||'USDT',source:r?.sourceUrl||'',note:r?.note||''}))$('record-'+field).value=v;
  $('record-featured').checked=r?.featured||false;
  const p=r&&r.windows[$('period').value]?$('period').value:r&&Object.keys(r.windows).length?Object.keys(r.windows)[0]:$('period').value;
  fillWindow(p);$('record-editor').showModal();$('record-name').focus();
}
function captureWindow() {
  const editor=state.editor,p=editor.period,previous=editor.windows[p],rawDate=$('record-asof').value;
  const values={};for(const [id,key]of [['roi','roi'],['pnl','pnl'],['mdd','mdd'],['wins','wins'],['trades','closedTrades']]) { const raw=$('record-'+id).value.trim();values[key]=raw===''?null:Number(raw); }
  const any=Object.values(values).some(v=>v!==null),curve=previous?.curve||[];
  if(!any&&!curve.length&&!rawDate){delete editor.windows[p];return;}
  if(!rawDate)throw Error('填写表现数值后，请同时填写数据截至时间。');
  let asOf;
  if(previous&&rawDate===localDateValue(previous.asOf))asOf=previous.asOf;
  else {const timestamp=Date.parse(rawDate);if(!Number.isFinite(timestamp))throw Error('请填写有效的数据时间。');asOf=new Date(timestamp).toISOString();}
  const candidate={asOf,...values,curve};
  if(previous?.asOfType&&asOf===previous.asOf)candidate.asOfType=previous.asOfType;
  const trial={id:'validation',name:'validation',exchange:'OKX',currency:'USDT',featured:false,paid:false,observedAt:new Date().toISOString(),sourceUrl:'https://example.com/',windows:{[p]:candidate},positions:[],points:[],orders:[]};
  try {validate(feed([trial]));} catch {throw Error('请检查表现数值、交易笔数与日期；最大回撤应为 0–100，盈利笔数不能超过已关闭交易数，日期须覆盖已有曲线。');}
  editor.windows[p]=candidate;
}
function changeEditorPeriod() {
  const next=$('record-period').value,previous=state.editor.period;
  try {captureWindow();fillWindow(next);$('record-error').textContent='';} catch(e){$('record-period').value=previous;$('record-error').textContent=e.message;}
}
function saveRecord(event) {
  event?.preventDefault();if(!state.editor)return;
  try {
    captureWindow();const original=state.editor.original;
    if(original&&original.currency!==$('record-currency').value&&(Object.keys(state.editor.windows).length||['positions','points','orders'].some(k=>original[k].length)))throw Error('已有表现或交易记录时不能直接更换计价币种，请为新币种添加另一份资料。');
    const r={id:state.editor.id||'local-'+crypto.randomUUID(),name:$('record-name').value.trim(),accountId:$('record-account').value.trim(),exchange:$('record-exchange').value,currency:$('record-currency').value,sourceUrl:$('record-source').value.trim(),note:$('record-note').value.trim(),featured:$('record-featured').checked,paid:original?.paid||false,observedAt:new Date().toISOString(),windows:state.editor.windows,positions:original?.positions||[],points:original?.points||[],orders:original?.orders||[]};
    let checked;try {checked=validate(feed([r]))[0];}catch {throw Error('请检查名称、账号和来源链接；来源须为不含账号密码的 HTTPS 地址。');}
    const rows=state.localRows.filter(item=>item.id!==checked.id);rows.push(checked);commitLocal(rows);
    $('search').value='';$('exchange').value='all';$('source').value='local';$('currency').value='all';$('period').value=state.editor.period;state.explicitPeriod=true;state.page=1;state.revealId=checked.id;
    $('record-editor').close();state.editor=null;updateView('已保存到当前浏览器。');saveURL();
  }catch(e){$('record-error').textContent=e.message;const details=$('record-asof').closest('details');if(details)details.open=true;if(!$('record-asof').value&&['roi','pnl','mdd','wins','trades'].some(k=>$('record-'+k).value!==''))$('record-asof').focus();}
}
function removeRecord(r) {
  if(!r._local||!confirm(`删除「${r.name}」的本机资料？`))return;
  try {commitLocal(state.localRows.filter(item=>item.id!==r.id));if(state.detail?.id===r.id){$('detail').close();state.detail=null;}updateView('已删除这份本机资料。');saveURL(true);}catch(e){feedback(e.message);}
}
async function refresh() {
  if(state.loading)return;const restoreFocus=document.activeElement===$('refresh')||$('detail').open;
  state.loading=true;$('refresh').disabled=true;$('leaders').setAttribute('aria-busy','true');$('status').textContent='正在读取资料…';
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch('feed.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});if(!response.ok)throw Error('公开资料暂不可用');
    if(Number(response.headers.get('content-length'))>maxBytes)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();fail();}chunks.push(value);}
    const data=JSON.parse(await new Blob(chunks).text());state.publicRows=validate(data);state.status=data.status;
  } catch(e) {state.status='error';state.publicRows=[];}
  finally {
    clearTimeout(timeout);state.loading=false;$('refresh').disabled=false;$('leaders').setAttribute('aria-busy','false');
    if(state.detail&&!state.detail._local){if($('detail').open)$('detail').close();state.detail=null;}
    updateView();saveURL(true);if(restoreFocus&&document.activeElement===document.body)$('refresh').focus();
  }
}
for(const id of controls)$(id).addEventListener('change',()=>{if(id==='period')state.explicitPeriod=true;state.page=1;render();saveURL();});
$('search').addEventListener('input',()=>{state.page=1;render();saveURL(true);});
$('reset').onclick=()=>{$('search').value='';$('period').value='30D';$('exchange').value='all';$('source').value='all';$('sort').value='roi';$('currency').value='all';state.explicitPeriod=false;state.page=1;choosePeriod();render();saveURL();};
$('prev').onclick=()=>{state.page--;render();saveURL();};$('next').onclick=()=>{state.page++;render();saveURL();};$('refresh').onclick=refresh;
$('add-trader').onclick=()=>openEditor();
$('record-form').addEventListener('invalid',e=>{const details=e.target.closest('details');if(details)details.open=true;},true);
$('record-form').addEventListener('submit',saveRecord);$('record-period').addEventListener('change',changeEditorPeriod);
for(const id of ['editor-close','editor-cancel'])$(id).onclick=()=>$('record-editor').close();
$('record-editor').addEventListener('close',()=>{state.editor=null;});$('close').onclick=()=>$('detail').close();
const tabs=[...$('tabs').querySelectorAll('[data-tab]')];
function selectTab(b){if(!state.detail||!tabs.includes(b))return;state.tab=b.dataset.tab;renderDetail();}
$('tabs').addEventListener('click',e=>selectTab(e.target.closest('[data-tab]')));
$('tabs').addEventListener('keydown',e=>{const i=tabs.indexOf(e.target);if(i<0)return;let n;if(e.key==='ArrowRight')n=(i+1)%tabs.length;else if(e.key==='ArrowLeft')n=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')n=0;else if(e.key==='End')n=tabs.length-1;else return;e.preventDefault();tabs[n].focus();selectTab(tabs[n]);});
$('detail').addEventListener('close',()=>{state.detail=null;});
addEventListener('popstate',()=>{if($('detail').open)$('detail').close();readURL();choosePeriod();render();});
readURL();loadLocal();state.loading=true;choosePeriod();render();state.loading=false;refresh();
})();
