(function (global) {
'use strict';
const PERIODS=['30D','90D','365D'];
const LABELS={'30D':'月度','90D':'季度','365D':'年度'};
const FILES={bitgetPeriods:{url:'trader/bitget/period-returns.json',limit:2097152,validate:'validateBitgetPeriods'},okxPeriods:{url:'trader/okx/period-returns.json',limit:1048576,validate:'validateOKXPeriods'},periodReturns:{url:'trader/binance/period-returns.json',limit:524288,validate:'validatePeriodReturns'},feed:{url:'trader/feed.json',limit:2097152,validate:'validateFeed'},portfolios:{url:'trader/portfolios.json',limit:4194304,validate:'validatePortfolios'},analytics:{url:'trader/analytics.json',limit:2097152,validate:'validateAnalytics'},binance:{url:'trader/binance/portfolios.json',limit:2097152,validate:'validateBinance'},reference:{url:'trader/aoying-history.js',limit:2097152,validate:'validateReference',wrapped:true}};
function dataAPI(){return typeof module!=='undefined'&&module.exports?require('./home-trader-data.js'):global.HomeTraderData;}
function fail(){throw Error('Invalid ranking snapshot');}
const numbers=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const dateOptions={timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false};
const shortTime=new Intl.DateTimeFormat('zh-CN',dateOptions),fullTime=new Intl.DateTimeFormat('zh-CN',{...dateOptions,year:'numeric'});
function decimal(value){return numbers.format(value);}
function amount(value){if(!Number.isFinite(value))return '—';const prefix=value>0?'+':value<0?'−':'',n=Math.abs(value);return prefix+(n>=1e8?decimal(n/1e8)+'亿':n>=1e4?decimal(n/1e4)+'万':decimal(n));}
function percent(value,signed=false){return Number.isFinite(value)?(signed&&value>0?'+':'')+decimal(value)+'%':'—';}
function time(value,full=false){if(!value||!Number.isFinite(Date.parse(value)))return '—';return (full?fullTime:shortTime).format(new Date(value));}
function day(value,year=false){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(year?{year:'numeric'}:{}),month:'2-digit',day:'2-digit'}).format(new Date(value));}
function moreHref(period){if(!PERIODS.includes(period))period='30D';return 'trader/index.html?'+new URLSearchParams({period,exchange:'all',source:'public',sort:'roi',currency:'all'}).toString();}
function node(doc,tag,text,cls){const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function title(el,text){el.setAttribute('title',text);return el;}
function metric(doc,label,value,description,cls=''){const box=node(doc,'div',undefined,'home-rank-metric');box.append(node(doc,'span',label),title(node(doc,'strong',value,cls),description));return box;}
function roiDescription(row,period){
  if(row.exchange==='Bitget')return 'Bitget 公布的近'+parseInt(period,10)+'天带单收益率。';
  if(row.exchange==='OKX')return 'OKX 公布的近'+parseInt(period,10)+'天带单收益率。';
  if(row.exchange==='Binance')return '币安公布的近'+parseInt(period,10)+'天收益率。';
  if(period==='30D')return Number.isFinite(row.roi)?'来源公布的同期收益率。':'来源未提供同期收益率，不以收益额代替。';
  const e=row.roiEvidence;
  if(Number.isFinite(row.roi)&&e)return `自算收益率 = 区间盈亏 ÷ max(100 USD，期初权益 + 区间最大累计净入金) × 100%；公开资金流水与权益逐段对账，资金基准 ${decimal(e.capitalBase)} USD。实际区间 ${time(e.startAt,true)} 至 ${time(e.endAt,true)}；流水采集 ${time(e.ledgerFetchedAt,true)}。非 TWR、非官方直接值；仅核验返回的公开流水与采样，不承诺完整账户历史。`;
  const reasons={history_unverified:'完整资金流水和周期边界尚未证实',cash_flow_adjusted_return_unavailable:'尚无可核验的资金流水和资金基准',insufficient_history:'实际历史不足所选周期',insufficient_samples:'有效权益采样不足',unpaired_samples:'权益与盈亏采样未对齐',ledger_unavailable:'公开资金流水暂不可用',ledger_incomplete:'公开资金流水尚未完整读取',unknown_ledger_event:'存在尚未支持的资金流水类型',invalid_ledger_event:'资金流水字段未通过校验',ambiguous_ledger_order:'同一时间的流水顺序无法确定',ledger_reconciliation_failed:'资金流水与权益变化未能对账',invalid_capital_basis:'资金基准无法可靠计算',invalid_portfolio:'来源历史未通过校验'};
  return `自算收益率暂不可用：${reasons[row.roiUnavailableReason]||'计算证据不足或未通过校验'}；不以收益额代替。`;
}
function renderRow(doc,row,index,period,Data){
  const el=node(doc,'article',undefined,'home-rank-row');el.setAttribute('role','listitem');el.setAttribute('data-stale',String(!!row.stale));
  const top=node(doc,'div',undefined,'home-rank-top'),identity=node(doc,'a',undefined,'home-rank-identity');
  identity.href=Data.accountHref(row.accountId,period,row.exchange,row.periodOnly);identity.setAttribute('aria-label',`查看 ${row.name} 的${LABELS[period]}详情`);
  identity.append(node(doc,'span',String(index+1),'home-rank-number'),title(node(doc,'span',row.name,'home-rank-name'),row.name));
  const headline=title(node(doc,'strong',percent(row.roi,true),row.roi<0?'home-rank-negative':'home-rank-positive'),roiDescription(row,period));
  const value=node(doc,'div',undefined,'home-rank-profit');value.append(headline);
  top.append(identity,value);
  const metrics=node(doc,'div',undefined,'home-rank-metrics');
  const platform=row.exchange==='Binance'?'币安':row.exchange||'Hyperliquid',sourcePeriod=['币安','OKX','Bitget'].includes(platform),currency=row.currency||'USD';
  if(Number.isFinite(row.pnl))metrics.append(metric(doc,'同期盈亏 · '+currency,amount(row.pnl),decimal(row.pnl)+' '+currency+' · 采集 '+time(row.performanceFetchedAt,true),row.pnl<0?'home-rank-negative':'home-rank-positive'));
  if(sourcePeriod){
    if(Number.isFinite(row.mdd))metrics.append(metric(doc,'同期最大回撤',percent(row.mdd),platform+'在所选周期公布的最大回撤。'));
    if(Number.isFinite(row.winRate))metrics.append(metric(doc,platform==='OKX'?'盈利日比例':'同期胜率',percent(row.winRate),platform==='OKX'?'OKX 在所选周期公布的盈利日占非持平日的比例。':platform+'在所选周期公布的胜率。'));
  }else{
  if(Number.isFinite(row.mdd))metrics.append(metric(doc,'采样盈亏回撤',percent(row.mdd),'基于来源盈亏及权益采样，可能超过100%；不是资金流调整净值最大回撤。采样截至 '+time(row.mddAsOf,true)+'；采集 '+time(row.mddFetchedAt,true)+'。'+(row.mddStale?' 历史采样，等待更新。':'')));
  if(Number.isFinite(row.winRate))metrics.append(metric(doc,'近期片段胜率',percent(row.winRate),`${row.winCount}个近期永续平仓片段；样本 ${time(row.winStart,true)} 至 ${time(row.winEnd,true)}；采集 ${time(row.winFetchedAt,true)}。已扣平仓手续费，未计开仓手续费及资金费；独立于所选周期，不参与排行。${row.winStale?' 历史样本，等待更新。':''}`));
  }
  const timing=row.performanceAsOf?'收益截至 '+time(row.performanceAsOf,true):'采集于 '+time(row.performanceFetchedAt,true);
  const meta=node(doc,'p',platform+' · '+timing+(row.performanceStale?' · 历史快照':''),'home-rank-timing');
  title(meta,sourcePeriod?platform+'周期统计 · '+(row.performanceAsOf?'来源标注截止时间。':'来源未标明统计截止时刻。'):(row.startAt&&row.endAt?'实际采样区间 '+time(row.startAt,true)+' 至 '+time(row.endAt,true)+'；':'')+'收益采集 '+time(row.performanceFetchedAt,true)+'；持仓核验 '+time(row.positionCheckedAt,true)+'。');
  if(row.evidencePath){
    const proof=node(doc,'a','收益凭证','home-rank-evidence');
    proof.href='trader/'+row.evidencePath;proof.setAttribute('target','_blank');proof.setAttribute('rel','noopener');
    meta.append(node(doc,'span',' · '),proof);
  }
  el.append(top);if(metrics.children.length)el.append(metrics);el.append(meta);return el;
}
function render(doc,view,period,Data,pending=false){
  const root=doc.getElementById('home-trader-ranking'),list=doc.getElementById('home-ranking-list'),status=doc.getElementById('home-ranking-status'),note=doc.getElementById('home-ranking-note'),more=doc.getElementById('home-ranking-more');
  const focused=doc.activeElement,focusedHref=list.contains?.(focused)?focused?.href:null;
  const scrollTop=list.getAttribute('data-period')===period ? list.scrollTop : 0;
  list.setAttribute('data-period',period);
  list.tabIndex=view?.rows.length>3 ? 0 : -1;
  root.setAttribute('aria-busy',String(pending));list.setAttribute('aria-busy',String(pending));root.setAttribute('data-stale',String(!!view?.stale));
  for(const button of root.querySelectorAll('[data-ranking-period]'))button.setAttribute('aria-pressed',String(button.getAttribute('data-ranking-period')===period));
  more.href=moreHref(period);more.textContent='查看'+LABELS[period]+'榜单 ↗';
  status.hidden=!!view&&!view.rows.length;note.hidden=!view?.rows.length;
  list.replaceChildren();
  const short=doc.getElementById('home-ranking-short');
  if(short){
    short.hidden=!view?.short?.length;
    const summary=short.querySelector('summary'),body=short.querySelector('[data-short-rows]');
    if(short.getAttribute('data-period')!==period){short.open=false;short.setAttribute('data-period',period);}
    body.replaceChildren();
    if(!short.hidden){
      summary.textContent='未满 '+parseInt(period,10)+' 天 · '+view.short.length+' 个账户';
      for(const row of view.short){
        const entry=node(doc,'p',undefined,'home-rank-short-row'),link=node(doc,'a',row.name);
        link.href=Data.accountHref(row.accountId,period,row.exchange,row.periodOnly);
        entry.append(link,node(doc,'span',' · 已带单 '+row.accountAgeDays+' 天 · 官方窗口 '+percent(row.roi,true)));
        if(row.evidencePath){
          const proof=node(doc,'a','收益凭证','home-rank-evidence');proof.href='trader/'+row.evidencePath;proof.target='_blank';proof.rel='noopener';
          entry.append(node(doc,'span',' · '),proof);
        }
        body.append(entry);
      }
    }
  }
  if(!view){list.append(node(doc,'p',pending?'正在读取榜单…':'暂未取得可用榜单','home-rank-empty'));status.textContent=pending?'正在读取广场快照…':'榜单暂不可用';note.textContent='与带单员广场共用公开数据快照。';return;}
  if(view.rows.length){view.rows.forEach((row,index)=>list.append(renderRow(doc,row,index,period,Data)));}
  else list.append(node(doc,'p',pending?'正在读取当前周期数据…':'该周期缺少可核验的收益率，暂无排名。','home-rank-empty'));
  const sample=view.eligibleCount===1?'仅 1 个账户有同期收益率':view.rows.length>3?view.eligibleCount+' 个账户按收益率排序':view.rows.length?'收益率前 '+view.rows.length+' 名 · '+view.eligibleCount+' 个账户可比较':'当前周期暂无符合条件排名';
  status.textContent=(view.stale?'历史快照 · ':'')+'近 '+parseInt(period,10)+' 天 · '+sample;
  note.textContent=[view.scope,view.note].filter(Boolean).join(' · ');
  if(focusedHref){const replacement=[...list.querySelectorAll('a')].find(a=>a.href===focusedHref);replacement?.focus({preventScroll:true});}
  list.scrollTop=scrollTop;
}
function stamp(value){const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:null;}
function rejectOlder(kind,next,before){
  if(!before)return;
  const compare=(a,b)=>{const newer=stamp(a),older=stamp(b);if(older!==null&&(newer===null||newer<older))fail();};
  if(kind==='feed'){
    compare(next.source?.fetchedAt,before.source?.fetchedAt);compare(next.source?.snapshotAt,before.source?.snapshotAt);compare(next.source?.positionVerification?.completedAt,before.source?.positionVerification?.completedAt);
    const old=new Map((before.traders||[]).map(row=>[row.accountId,row]));
    for(const row of next.traders||[]){const previous=old.get(row.accountId);if(previous)compare(row.positionCheck?.checkedAt,previous.positionCheck?.checkedAt);}
  }else{
    if(kind==='reference'){
      compare(next.latestPublicFetchAt||next.fetchedAt,before.latestPublicFetchAt||before.fetchedAt);
      for(const p of PERIODS){
        const incoming=p==='30D'?next.performance:next.performanceByPeriod?.[p];
        const prior=p==='30D'?before.performance:before.performanceByPeriod?.[p];
        if(incoming?.fetchedAt&&prior?.fetchedAt)compare(incoming.fetchedAt,prior.fetchedAt);
      }
      return;
    }
    compare(next.generatedAt,before.generatedAt);
    if(kind==='periodReturns'||kind==='okxPeriods'){
      const key=kind==='periodReturns'?'portfolioId':'uniqueCode';
      const older=new Map(before.accounts.map(row=>[row[key],row]));
      for(const item of next.accounts){
        const prior=older.get(item[key])?.performance,current=item.performance.byPeriod||item.performance;
        for(const [p,w] of Object.entries(prior?.byPeriod||prior||{}))compare(current[p]?.lastSuccessAt,w.lastSuccessAt);
      }
      return;
    }
    if(kind==='binance'){
      for(const item of next.portfolios){
        const old=before.portfolios.find(feed=>feed.portfolioId===item.portfolioId);
        if(item.profile.visibility!=='public'||item.source.status==='restricted'||item.source.errorCode==='restricted')continue;
        for(const p of PERIODS){
          const prior=old?.performance?.byPeriod?.[p],incoming=item.performance?.byPeriod?.[p];
          if(prior?.lastSuccessAt)compare(incoming?.lastSuccessAt,prior.lastSuccessAt);
        }
      }
      return;
    }
    for(const [address,row]of Object.entries(next.accounts||{})){const old=before.accounts?.[address];if(old?.fetchedAt)compare(row.fetchedAt,old.fetchedAt);}
  }
}
async function readJSON(fetcher,spec){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetcher(spec.url,{cache:'no-cache',credentials:'omit',redirect:'error',signal:controller.signal});
    const contentType=response.headers.get('content-type')||'';
    const appropriateType=spec.wrapped?/^(?:application|text)\/(?:x-)?javascript(?:;|$)/i.test(contentType):/application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(contentType);
    if(!response.ok||!appropriateType||Number(response.headers.get('content-length'))>spec.limit)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>spec.limit){await reader.cancel();fail();}chunks.push(value);}
    const payload=new Uint8Array(bytes);let offset=0;
    for(const chunk of chunks){payload.set(chunk,offset);offset+=chunk.byteLength;}
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(payload);
    let body=decoded;
    if(spec.wrapped){
      // The existing collector publishes a single JS assignment. Read its JSON as data only.
      const match=/^\s*(?:\/\*[\s\S]*?\*\/\s*)?globalThis\.BooksAoyingHistory\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(body);
      if(!match)fail();
      body=match[1];
    }
    return JSON.parse(body);
  }finally{clearTimeout(timer);}
}
function mount(doc,options={}){
  const root=doc.getElementById('home-trader-ranking');if(!root)return null;
  for(const id of ['home-ranking-list','home-ranking-status','home-ranking-note','home-ranking-more'])if(!doc.getElementById(id))return null;
  const Data=options.data||dataAPI();if(!Data)return null;
  const now=options.now||Date.now,fetcher=options.fetch||global.fetch.bind(global);
  const snapshots={},raw={},failures={};
  const desktop=doc.defaultView?.matchMedia('(min-width:1141px)');
  const radar=doc.getElementById('market-radar');
  function measureRadar(){
    if(desktop?.matches && radar)root.style.setProperty('--ranking-radar-height',radar.getBoundingClientRect().height+'px');
  }
  const observer=radar && doc.defaultView?.ResizeObserver ? new doc.defaultView.ResizeObserver(measureRadar) : null;
  observer?.observe(radar);
  measureRadar();
  let period='30D',inflight=null,destroyed=false,pending=false;
  const view=()=>snapshots.feed||snapshots.binance||snapshots.reference||snapshots.periodReturns||snapshots.okxPeriods?Data.rank({...snapshots,failures:{...failures}},period,now(),desktop?.matches?Infinity:3):null;
  function draw(){if(!destroyed)render(doc,view(),period,Data,pending);}
  function onLayout(){measureRadar();draw();}
  desktop?.addEventListener('change',onLayout);
  async function revalidate(){
    pending=true;draw();
    await Promise.all(Object.entries(FILES).map(async([kind,spec])=>{
      try{const payload=await readJSON(fetcher,spec),validated=Data[spec.validate](payload,now());rejectOlder(kind,payload,raw[kind]);if(destroyed)return;raw[kind]=payload;snapshots[kind]=validated;failures[kind]=false;}
      catch(_){if(!destroyed)failures[kind]=true;}
      draw();
    }));pending=false;draw();
  }
  function refresh(){if(destroyed)return Promise.resolve();if(inflight)return inflight;inflight=revalidate().finally(()=>{inflight=null;});return inflight;}
  const buttons=[...root.querySelectorAll('[data-ranking-period]')],listeners=[];
  for(const button of buttons){const select=()=>{const next=button.getAttribute('data-ranking-period');if(!PERIODS.includes(next))return;period=next;draw();};button.addEventListener('click',select);listeners.push([button,select]);}
  const onVisibility=()=>{if(doc.visibilityState==='visible'){draw();refresh();}};
  doc.addEventListener('visibilitychange',onVisibility);
  const timer=setInterval(()=>{if(doc.visibilityState==='visible')refresh();},60000);
  refresh();return {refresh,render:draw,getPeriod:()=>period,getView:view,destroy(){destroyed=true;clearInterval(timer);observer?.disconnect();desktop?.removeEventListener('change',onLayout);doc.removeEventListener?.('visibilitychange',onVisibility);for(const[button,listener]of listeners)button.removeEventListener?.('click',listener);}};
}
const api={PERIODS,FILES,amount,percent,time,moreHref,renderRow,render,rejectOlder,readJSON,mount};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(global.document){
  const panel=global.document.getElementById('home-trader-ranking');
  if(panel && global.IntersectionObserver){
    const observer=new global.IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();mount(global.document);}
    },{rootMargin:'160px 0px'});
    observer.observe(panel);
  }else mount(global.document);
}
})(typeof window!=='undefined'?window:globalThis);
