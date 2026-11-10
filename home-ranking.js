(function (global) {
'use strict';
const PERIODS=['30D','90D','365D'];
const LABELS={'30D':'月度','90D':'季度','365D':'年度'};
const FILES={feed:{url:'trader/feed.json',limit:2097152,validate:'validateFeed'},portfolios:{url:'trader/portfolios.json',limit:4194304,validate:'validatePortfolios'},analytics:{url:'trader/analytics.json',limit:2097152,validate:'validateAnalytics'}};
function dataAPI(){return typeof module!=='undefined'&&module.exports?require('./home-trader-data.js'):global.HomeTraderData;}
function fail(){throw Error('Invalid ranking snapshot');}
function decimal(value,digits=2){return value.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits});}
function amount(value){if(!Number.isFinite(value))return '—';const prefix=value>0?'+':value<0?'−':'',n=Math.abs(value);return prefix+(n>=1e8?decimal(n/1e8)+'亿':n>=1e4?decimal(n/1e4)+'万':decimal(n));}
function percent(value,signed=false){return Number.isFinite(value)?(signed&&value>0?'+':'')+decimal(value)+'%':'—';}
function time(value,full=false){if(!value||!Number.isFinite(Date.parse(value)))return '—';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(full?{year:'numeric'}:{}),month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));}
function day(value,year=false){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(year?{year:'numeric'}:{}),month:'2-digit',day:'2-digit'}).format(new Date(value));}
function moreHref(period){if(!PERIODS.includes(period))period='30D';return 'trader/index.html?'+new URLSearchParams({period,exchange:'Hyperliquid',source:'public',sort:'pnl',currency:'USD'}).toString();}
function node(doc,tag,text,cls){const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function title(el,text){el.setAttribute('title',text);return el;}
function metric(doc,label,value,description,cls=''){const box=node(doc,'div',undefined,'home-rank-metric');box.append(node(doc,'span',label),title(node(doc,'strong',value,cls),description));return box;}
function roiDescription(row,period){
  if(period==='30D')return Number.isFinite(row.roi)?'来源公布的同期收益率。':'来源未提供同期收益率，不以收益额代替。';
  const e=row.roiEvidence;
  if(Number.isFinite(row.roi)&&e)return `自算收益率 = 区间盈亏 ÷ max(100 USD，期初权益 + 区间最大累计净入金) × 100%；公开资金流水与权益逐段对账，资金基准 ${decimal(e.capitalBase)} USD。实际区间 ${time(e.startAt,true)} 至 ${time(e.endAt,true)}；流水采集 ${time(e.ledgerFetchedAt,true)}。非 TWR、非官方直接值；仅核验返回的公开流水与采样，不承诺完整账户历史。`;
  const reasons={cash_flow_adjusted_return_unavailable:'尚无可核验的资金流水和资金基准',insufficient_history:'实际历史不足所选周期',insufficient_samples:'有效权益采样不足',unpaired_samples:'权益与盈亏采样未对齐',ledger_unavailable:'公开资金流水暂不可用',ledger_incomplete:'公开资金流水尚未完整读取',unknown_ledger_event:'存在尚未支持的资金流水类型',invalid_ledger_event:'资金流水字段未通过校验',ambiguous_ledger_order:'同一时间的流水顺序无法确定',ledger_reconciliation_failed:'资金流水与权益变化未能对账',invalid_capital_basis:'资金基准无法可靠计算',invalid_portfolio:'来源历史未通过校验'};
  return `自算收益率暂不可用：${reasons[row.roiUnavailableReason]||'计算证据不足或未通过校验'}；不以收益额代替。`;
}
function renderRow(doc,row,index,period,Data){
  const el=node(doc,'article',undefined,'home-rank-row');el.setAttribute('role','listitem');el.setAttribute('data-stale',String(!!row.stale));
  const top=node(doc,'div',undefined,'home-rank-top'),identity=node(doc,'a',undefined,'home-rank-identity');
  identity.href=Data.accountHref(row.accountId,period);identity.setAttribute('aria-label',`查看 ${row.name} 的${LABELS[period]}详情`);
  identity.append(node(doc,'span',String(index+1),'home-rank-number'),title(node(doc,'span',row.name,'home-rank-name'),row.name));
  const profit=node(doc,'div',undefined,'home-rank-profit');profit.append(title(node(doc,'strong',amount(row.pnl),row.pnl>=0?'home-rank-positive':'home-rank-negative'),decimal(row.pnl)+' USD · 同期盈亏'),node(doc,'small','USD'));
  top.append(identity,profit);
  const metrics=node(doc,'div',undefined,'home-rank-metrics');
  metrics.append(metric(doc,period==='30D'?'收益率':'自算收益率',percent(row.roi,true),roiDescription(row,period),Number.isFinite(row.roi)?row.roi>=0?'home-rank-positive':'home-rank-negative':''));
  metrics.append(metric(doc,'采样盈亏回撤',percent(row.mdd),'基于来源盈亏及权益采样的回撤口径，可能超过100%；不是资金流调整净值最大回撤。采样截至 '+time(row.mddAsOf,true)+'；采集 '+time(row.mddFetchedAt,true)+'。'+(row.mddStale?' 历史采样，等待更新。':'')));
  const winDescription=Number.isFinite(row.winRate)?`${row.winCount}个近期永续平仓片段；样本 ${time(row.winStart,true)} 至 ${time(row.winEnd,true)}；采集 ${time(row.winFetchedAt,true)}。已扣平仓手续费，未计开仓手续费及资金费；独立于所选周期，不参与排行。`:`有效平仓片段不足20笔或尚无可核验样本。近期片段胜率不代表所选周期完整胜率，不参与排行。`;
  metrics.append(metric(doc,'近期片段胜率',percent(row.winRate),winDescription));
  const notes=[];
  if(row.performanceStale)notes.push('历史收益快照');
  if(period!=='30D'&&row.startAt&&row.endAt)notes.push(day(row.startAt,period==='365D')+'—'+day(row.endAt,period==='365D')+(Number.isFinite(row.coverageDays)?' · '+decimal(row.coverageDays,1)+'天':''));
  notes.push('收益截至 '+time(row.performanceAsOf));
  if(Number.isFinite(row.mdd)&&row.mddStale)notes.push('回撤旧采样 '+time(row.mddFetchedAt));
  if(Number.isFinite(row.winRate))notes.push('胜率 '+row.winCount+'片段 · 采集 '+time(row.winFetchedAt)+(row.winStale?' · 旧样本':''));
  if(!row.currentHolding)notes.push('当前持仓待核验');
  const timing=node(doc,'p',notes.join(' · '),'home-rank-timing');
  title(timing,(row.startAt&&row.endAt?'实际采样区间 '+time(row.startAt,true)+' 至 '+time(row.endAt,true)+'；':'')+'收益采集 '+time(row.performanceFetchedAt,true)+'；持仓核验 '+time(row.positionCheckedAt,true)+'。各项更新时间独立，刷新页面不会刷新来源数据。');
  el.append(top,metrics,timing);return el;
}
function render(doc,view,period,Data,pending=false){
  const root=doc.getElementById('home-trader-ranking'),list=doc.getElementById('home-ranking-list'),status=doc.getElementById('home-ranking-status'),note=doc.getElementById('home-ranking-note'),more=doc.getElementById('home-ranking-more');
  const focused=doc.activeElement,focusedHref=list.contains?.(focused)?focused?.href:null;
  root.setAttribute('aria-busy',String(pending));list.setAttribute('aria-busy',String(pending));root.setAttribute('data-stale',String(!!view?.stale));
  for(const button of root.querySelectorAll('[data-ranking-period]'))button.setAttribute('aria-pressed',String(button.getAttribute('data-ranking-period')===period));
  more.href=moreHref(period);more.textContent='查看'+LABELS[period]+'榜单 ↗';
  list.replaceChildren();
  if(!view){list.append(node(doc,'p',pending?'正在读取榜单…':'暂未取得可用榜单','home-rank-empty'));status.textContent=pending?'正在读取广场快照…':'榜单暂不可用';note.textContent='与带单员广场共用公开数据快照。';return;}
  if(view.rows.length){view.rows.forEach((row,index)=>list.append(renderRow(doc,row,index,period,Data)));}
  else list.append(node(doc,'p',pending?'正在读取当前周期数据…':'暂无符合条件的盈利账户','home-rank-empty'));
  status.textContent=(view.stale?'历史快照 · ':'')+(view.rows.length?'近'+parseInt(period,10)+'天收益额前'+Math.min(3,view.rows.length)+'名':'当前周期暂无符合条件排名')+(view.eligibleCount?' · '+view.eligibleCount+'个符合条件账户':'');
  note.textContent=[view.scope,view.note].filter(Boolean).join(' · ');
  if(focusedHref){const replacement=[...list.querySelectorAll('a')].find(a=>a.href===focusedHref);replacement?.focus();}
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
    compare(next.generatedAt,before.generatedAt);
    for(const [address,row]of Object.entries(next.accounts||{})){const old=before.accounts?.[address];if(old?.fetchedAt)compare(row.fetchedAt,old.fetchedAt);}
  }
}
async function readJSON(fetcher,spec){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetcher(spec.url,{cache:'no-cache',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!response.ok||!/application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>spec.limit)fail();
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>spec.limit){await reader.cancel();fail();}chunks.push(value);}
    return JSON.parse(await new Blob(chunks).text());
  }finally{clearTimeout(timer);}
}
function mount(doc,options={}){
  const root=doc.getElementById('home-trader-ranking');if(!root)return null;
  for(const id of ['home-ranking-list','home-ranking-status','home-ranking-note','home-ranking-more'])if(!doc.getElementById(id))return null;
  const Data=options.data||dataAPI();if(!Data)return null;
  const now=options.now||Date.now,fetcher=options.fetch||global.fetch.bind(global);
  const snapshots={feed:null,portfolios:null,analytics:null},raw={feed:null,portfolios:null,analytics:null},failures={feed:false,portfolios:false,analytics:false};
  let period='30D',inflight=null,destroyed=false,pending=false;
  const view=()=>snapshots.feed?Data.rank({...snapshots,failures:{...failures}},period,now()):null;
  function draw(){if(!destroyed)render(doc,view(),period,Data,pending);}
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
  refresh();return {refresh,render:draw,getPeriod:()=>period,getView:view,destroy(){destroyed=true;clearInterval(timer);doc.removeEventListener?.('visibilitychange',onVisibility);for(const[button,listener]of listeners)button.removeEventListener?.('click',listener);}};
}
const api={PERIODS,FILES,amount,percent,time,moreHref,renderRow,render,rejectOlder,readJSON,mount};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(global.document)mount(global.document);
})(typeof window!=='undefined'?window:globalThis);
