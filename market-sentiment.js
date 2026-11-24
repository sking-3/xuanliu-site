(function (global) {
'use strict';
const SOURCES = {
  cn: ['东方财富股吧 · Books 融合模型', 'https://guba.eastmoney.com/list,szzs.html'],
  us: ['Cboe · VIX', 'https://www.cboe.com/tradable_products/vix/vix_historical_data'],
  crypto: ['Alternative.me', 'https://alternative.me/crypto/fear-and-greed-index/']
};
const MAX_AGE = {cn:4*86400000, us:7*86400000, crypto:3*86400000};
const CLASSIFICATIONS = {'Extreme Fear':'极度恐惧', Fear:'恐惧', Neutral:'中性', Greed:'贪婪', 'Extreme Greed':'极度贪婪'};
const SCORES = ['momHeat','baoma','novice','retail','composite','bullishRatio','bearishRatio','chaseRatio','panicRatio'];
// Display scales encode heat or risk; they do not invent provider ratings.
const SCALES = {
  cn: {max:100, low:'低热度', high:'高热度', stops:[[0,'#35668e'],[25,'#287c7a'],[50,'#936e18'],[75,'#af5d28'],[100,'#b43c4b']]},
  crypto: {max:100, low:'恐惧', high:'贪婪', stops:[[0,'#b43c4b'],[25,'#b8612c'],[50,'#92751d'],[75,'#4b8050'],[100,'#24724f']]},
  us: {max:60, low:'低波动', high:'高波动 · 60+', stops:[[0,'#24724f'],[15,'#4b8050'],[30,'#936e18'],[45,'#af4a35'],[60,'#b43c4b']]}
};
function displayScale(market, value) {
  if (value===null) return null;
  const definition=SCALES[market];
  number(value,market==='us'?1000:100);
  const clamped=Math.min(value,definition.max);
  const upper=definition.stops.findIndex(([point])=>point>=clamped);
  const [end, endColor]=definition.stops[upper];
  const [start, startColor]=definition.stops[Math.max(0,upper-1)];
  const weight=end===start?0:(clamped-start)/(end-start);
  const rgb=hex=>[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16));
  const from=rgb(startColor),to=rgb(endColor);
  const color='rgb('+from.map((channel,index)=>Math.round(channel+(to[index]-channel)*weight)).join(', ')+')';
  const gradient='linear-gradient(90deg in srgb, '+definition.stops.map(([point,hex])=>hex+' '+point/definition.max*100+'%').join(', ')+')';
  return {...definition,value,clamped,color,gradient,position:clamped/definition.max*100};
}
function invalid() { throw Error('Invalid sentiment snapshot'); }
function number(value, max=100, min=0) {
  if (typeof value!=='number' || !Number.isFinite(value) || value<min || value>max) invalid();
  return value;
}
function time(value, now) {
  if (typeof value!=='string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))?$/.test(value)) invalid();
  const date=Date.parse(value);
  if (!Number.isFinite(date) || date>now+300000 || new Date(value.slice(0,10)).toISOString().slice(0,10)!==value.slice(0,10)) invalid();
  return date;
}
function empty(market, errorCode=null) {
  return {status:'unavailable', sourceName:SOURCES[market][0], sourceUrl:SOURCES[market][1], asOf:null, fetchedAt:null, lastAttemptAt:null, errorCode, data:null};
}
function validateCard(market, card, generatedAt, now) {
  if (!card || !['ready','stale','unavailable'].includes(card.status) || card.sourceName!==SOURCES[market][0] || card.sourceUrl!==SOURCES[market][1]) invalid();
  if (card.lastAttemptAt) time(card.lastAttemptAt,now);
  if (card.data===null) {
    if (card.status!=='unavailable' || card.asOf!==null || card.fetchedAt!==null) invalid();
    return {...card};
  }
  if (!card.data || card.status==='unavailable') invalid();
  const asOf=time(card.asOf,now), fetched=time(card.fetchedAt,now);
  if (asOf>fetched+300000 || fetched>generatedAt+5000) invalid();
  const data=card.data;
  if (market==='cn') {
    if (data.methodVersion!=='books-community-v1' || !Number.isInteger(data.sampleCount) || data.sampleCount<20 || data.sampleCount>240 || data.windowHours!==72 || data.sourceCount!==1 || data.boardCount!==3) invalid();
    for (const key of SCORES) if (data[key]!==null) number(data[key]);
    for (const key of ['directionalCount','bullishCount','bearishCount','neutralCount']) {
      if (!Number.isInteger(data[key])) invalid();
      number(data[key],data.sampleCount);
    }
    if (data.bullishCount+data.bearishCount!==data.directionalCount || data.directionalCount+data.neutralCount!==data.sampleCount) invalid();
    if (data.directionalCount<5 && ['bullishRatio','bearishRatio','baoma','novice','retail','composite'].some(key=>data[key]!==null)) invalid();
    if (data.directionalCount>=5 && (data.bullishRatio===null || data.bearishRatio===null
      || Math.abs(data.bullishRatio-data.bullishCount/data.directionalCount*100)>.06
      || Math.abs(data.bearishRatio-data.bearishCount/data.directionalCount*100)>.06)) invalid();
    if (time(data.windowStart,now)>time(data.windowEnd,now) || time(data.windowEnd,now)!==asOf) invalid();
  } else {
    number(data.value, market==='crypto'?100:1000, market==='us'?0.001:0);
    if (data.previous!==null) number(data.previous,market==='crypto'?100:1000);
    if (market==='crypto' && (!Number.isInteger(data.value) || !Object.hasOwn(CLASSIFICATIONS,data.classification))) invalid();
    if (market==='us' && (data.sessionDate!==card.asOf || !/^\d{4}-\d\d-\d\d$/.test(data.sessionDate))) invalid();
  }
  return {...card, data:{...data}};
}
function merge(previous, payload, now=Date.now()) {
  if (!payload || payload.schemaVersion!==1 || payload.demoData!==false || !payload.markets) invalid();
  const generated=time(payload.generatedAt,now);
  if (previous && generated<time(previous.generatedAt,now)) invalid();
  const markets={};
  for (const market of Object.keys(SOURCES)) {
    const before=previous?.markets[market];
    let next;
    try { next=validateCard(market,payload.markets[market],generated,now); }
    catch (_) { next=empty(market,'snapshot_invalid'); }
    if (before?.data && (!next.data || time(next.asOf,now)<time(before.asOf,now) || time(next.fetchedAt,now)<time(before.fetchedAt,now))) {
      next={...before,status:'stale',errorCode:next.errorCode||'source_time_regressed',lastAttemptAt:next.lastAttemptAt};
    }
    markets[market]=next;
  }
  return {schemaVersion:1,demoData:false,generatedAt:payload.generatedAt,markets};
}
function state(market, card, now=Date.now()) {
  if (!card?.data) return 'unavailable';
  return card.status!=='ready' || now-time(card.asOf,now)>MAX_AGE[market] ? 'stale' : 'ready';
}
function formatted(value, suffix='', digits=1) { return value===null?'样本不足':value.toLocaleString('zh-CN',{maximumFractionDigits:digits})+suffix; }
function date(value) {
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
}
function node(doc, tag, text, className) {
  const el=doc.createElement(tag);
  if (text!==undefined) el.textContent=text;
  if (className) el.className=className;
  return el;
}
function link(doc, title, url) {
  const el=node(doc,'a',title);
  el.href=url; el.target='_blank'; el.rel='noopener noreferrer';
  return el;
}
function scaleElement(doc, market, value) {
  const scale=displayScale(market,value);
  const figure=node(doc,'div',undefined,'sentiment-scale');
  figure.style.setProperty('--sentiment-gradient',scale.gradient);
  figure.style.setProperty('--sentiment-color',scale.color);
  figure.style.setProperty('--sentiment-position',scale.position+'%');
  const track=node(doc,'div',undefined,'sentiment-track');
  track.setAttribute('role','meter');
  track.setAttribute('aria-label',market==='us'?'VIX 展示刻度':market==='cn'?'A 股社区综合热度':'比特币恐惧与贪婪指数');
  track.setAttribute('aria-valuemin','0');
  track.setAttribute('aria-valuemax',String(scale.max));
  track.setAttribute('aria-valuenow',String(scale.clamped));
  track.setAttribute('aria-valuetext',String(value)+(market==='us'?' 点'+(value>60?'，超出 60 点展示上限':''):' / 100'));
  track.append(node(doc,'span',undefined,'sentiment-pointer'));
  const ticks=node(doc,'ol',undefined,'sentiment-ticks');
  for (const [point] of scale.stops) {
    const tick=node(doc,'li',market==='us'&&point===60?'60+':String(point));
    tick.style.color=displayScale(market,point).color;
    ticks.append(tick);
  }
  const caption=node(doc,'p',undefined,'sentiment-scale-caption');
  caption.append(node(doc,'span',scale.low),node(doc,'span',scale.high));
  figure.append(track,ticks,caption);
  return figure;
}
function render(doc, root, snapshot, readFailed=false, now=Date.now(), activeMarket='cn', loading=false, methodExpanded=false) {
  const focused=doc.activeElement, focusedHref=root.contains(focused)?focused?.href:null;
  const methodFocused=focused?.tagName==='SUMMARY'&&root.contains(focused);
  for (const market of Object.keys(SOURCES)) {
    const selected=market===activeMarket;
    root.querySelector('[data-sentiment-market="'+market+'"]').hidden=!selected;
    const tab=root.querySelector('[data-sentiment-select="'+market+'"]');
    tab.setAttribute('aria-selected',String(selected));
    tab.tabIndex=selected?0:-1;
  }
  if (loading && !snapshot) {
    root.querySelector('[data-sentiment-market="'+activeMarket+'"] .sentiment-body').replaceChildren(node(doc,'p','正在读取市场情绪…','sentiment-status'));
    root.querySelector('[data-sentiment-state]').textContent='读取中';
    root.setAttribute('aria-busy','true');
    return;
  }
  const market=activeMarket,card=snapshot?.markets[market]||empty(market);
  const status=readFailed&&card.data?'stale':state(market,card,now);
  const section=root.querySelector('[data-sentiment-market="'+market+'"]');
  const body=section.querySelector('.sentiment-body');
  const previousContent=body.querySelector('.sentiment-content');
  const scrollTop=previousContent?.scrollTop||0,contentFocused=previousContent&&doc.activeElement===previousContent;
  const parts=[];
  const note=text=>parts.push(node(doc,'p',text,'sentiment-note'));
  const comparison=(label,value)=>{
    const row=node(doc,'p',undefined,'sentiment-comparison');
    row.append(node(doc,'span',label),node(doc,'strong',value));parts.push(row);
  };
  if (card.data) {
    const data=card.data,value=market==='cn'?data.composite:data.value;
    const scale=displayScale(market,value);
    body.style.setProperty('--sentiment-color',scale?.color||'#536174');
    const numberLine=node(doc,'div',undefined,'sentiment-number');
    numberLine.append(node(doc,'strong',formatted(value,'',market==='us'?2:1)));
    if (value!==null) numberLine.append(node(doc,'span',market==='us'?'点':'/ 100'));
    const primary=node(doc,'div',undefined,'sentiment-primary');
    const reading=market==='cn'?'社区综合热度':market==='us'?'VIX · 30 天预期波动率':CLASSIFICATIONS[data.classification];
    primary.append(numberLine,node(doc,'p',reading,'sentiment-reading'));parts.push(primary);
    if (value!==null) parts.push(scaleElement(doc,market,value));
    if (market==='cn') {
      const metrics=node(doc,'dl',undefined,'sentiment-metrics');
      for (const [key,label] of [['baoma','宝妈热度'],['novice','小白热度'],['retail','散户热度']]) {
        const group=node(doc,'div'),color=displayScale('cn',data[key]);
        if (color) group.style.setProperty('--sentiment-color',color.color);
        group.append(node(doc,'dt',label),node(doc,'dd',formatted(data[key])));metrics.append(group);
      }
      parts.push(metrics);
      if (data.directionalCount>=5) {
        comparison('方向表达 · '+data.directionalCount+' 条',`偏多 ${formatted(data.bullishRatio,'%')} · 偏空 ${formatted(data.bearishRatio,'%')}`);
      } else note('方向样本不足 5 条，暂不生成多空比例。');
      note(data.sampleCount+' 条标题 · 单社区样本，可靠度有限。');
      const details=node(doc,'details',undefined,'sentiment-method');
      details.dataset.sentimentMethod=market;
      details.open=methodExpanded;
      details.append(node(doc,'summary','样本与方法'));
      const information=node(doc,'div');
      information.append(node(doc,'p','表达热度 '+formatted(data.momHeat)+' · 追涨 '+formatted(data.chaseRatio,'%')+' / 恐慌 '+formatted(data.panicRatio,'%'),'sentiment-note'));
      information.append(node(doc,'p','近 72 小时 · 3 个指数吧。多空比例仅来自方向样本。','sentiment-note'));
      const methods=node(doc,'p',undefined,'sentiment-note');
      methods.append(link(doc,'宝妈方法','https://github.com/mihang123/mom-index'),doc.createTextNode(' · '),link(doc,'社区方法','https://github.com/xzrd021/baoma-xiaobai-sanhu-zhishu'));
      information.append(methods);details.append(information);parts.push(details);
    } else {
      comparison(market==='us'?'前一交易日':'昨日',data.previous===null?'—':formatted(data.previous,'',market==='us'?2:1));
      note(market==='us'?'展示刻度 0–60+ 点':'日度情绪指标 · 非盘中报价');
    }
  } else note('尚未取得可核验数据，可打开来源核对。');
  if (status!=='ready' || readFailed) {
    const text=readFailed?(card.data?'页面读取失败，保留已有数据':'页面读取失败，尚无有效数据'):status==='stale'?(card.errorCode?'来源读取失败，保留上次数据':'历史数据，等待来源更新'):'尚无有效数据';
    const warning=node(doc,'p',text,'sentiment-status');warning.setAttribute('data-state',status);parts.push(warning);
  }
  const meta=node(doc,'footer',undefined,'sentiment-meta');
  meta.append(link(doc,(market==='cn'?'东方财富股吧':card.sourceName)+' ↗',card.sourceUrl));
  if (market==='us') meta.append(link(doc,'CNN 恐贪 ↗','https://www.cnn.com/markets/fear-and-greed'));
  if (card.asOf) meta.append(node(doc,'span',market==='us'?'美东交易日 '+card.asOf:'数据截至 '+date(card.asOf)));
  if (card.fetchedAt) meta.append(node(doc,'span','采集 '+date(card.fetchedAt)+'（北京）'));
  if (card.errorCode && card.lastAttemptAt) meta.append(node(doc,'span','最近尝试 '+date(card.lastAttemptAt)+'（北京）'));
  const content=node(doc,'div',undefined,'sentiment-content');
  content.setAttribute('role','region');content.setAttribute('tabindex','0');content.setAttribute('aria-label','市场情绪内容');
  content.append(...parts);
  body.replaceChildren(content,meta);
  content.scrollTop=scrollTop;
  if(contentFocused)content.focus({preventScroll:true});
  section.setAttribute('data-state',status);
  root.querySelector('[data-sentiment-state]').textContent=status==='ready'?({cn:'社区样本',us:'日收盘',crypto:'日度'})[market]:status==='stale'?'历史数据 · 待更新':'暂无数据';
  root.setAttribute('aria-busy','false');
  if (focusedHref) [...body.querySelectorAll('a')].find(a=>a.href===focusedHref)?.focus();
  else if (methodFocused) body.querySelector('.sentiment-method > summary')?.focus();
}
function mount(doc, options={}) {
  const root=doc.getElementById('market-sentiment');
  if (!root) return null;
  const fetcher=options.fetch||global.fetch.bind(global), clock=options.now||Date.now;
  const view={snapshot:null,activeMarket:'cn',readFailed:false,loading:true,expanded:{cn:false,us:false,crypto:false}};
  let inflight=null;
  const paint=()=>render(doc,root,view.snapshot,view.readFailed,clock(),view.activeMarket,view.loading,view.expanded[view.activeMarket]);
  const toggle=event=>{if(event.target.dataset.sentimentMethod)view.expanded[event.target.dataset.sentimentMethod]=event.target.open;};
  function selectMarket(market, focus=false) {
    view.activeMarket=market;
    paint();
    if (focus) root.querySelector('[data-sentiment-select="'+market+'"]').focus();
  }
  function click(event) {
    const button=event.target.closest('[data-sentiment-select]');
    if (button) selectMarket(button.dataset.sentimentSelect);
  }
  function keydown(event) {
    const button=event.target.closest('[data-sentiment-select]');
    if (!button || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const markets=Object.keys(SOURCES),index=markets.indexOf(view.activeMarket);
    const next=event.key==='Home'?0:event.key==='End'?markets.length-1:(index+(event.key==='ArrowRight'?1:markets.length-1))%markets.length;
    selectMarket(markets[next],true);
  }
  root.addEventListener('click',click);
  root.addEventListener('keydown',keydown);
  root.addEventListener('toggle',toggle,true);
  async function read() {
    view.loading=true;
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),10000);
    try {
      const response=await fetcher('sentiment-data/latest.json',{cache:'no-store',redirect:'error',signal:controller.signal});
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) invalid();
      const text=await response.text();
      if (text.length>131072) invalid();
      view.snapshot=merge(view.snapshot,JSON.parse(text),clock());
      view.readFailed=false;
    } catch (_) { view.readFailed=true; }
    finally { clearTimeout(timeout);view.loading=false; }
    paint();
  }
  function refresh() {
    if (!inflight) inflight=read().finally(()=>{inflight=null;});
    return inflight;
  }
  const interval=setInterval(()=>{if(doc.visibilityState==='visible')refresh();},600000);
  const visible=()=>{if(doc.visibilityState==='visible')refresh();};
  doc.addEventListener('visibilitychange',visible);
  refresh();
  return {refresh,getSnapshot:()=>view.snapshot,destroy:()=>{
    clearInterval(interval);
    root.removeEventListener('click',click);
    root.removeEventListener('keydown',keydown);
    root.removeEventListener('toggle',toggle,true);
    doc.removeEventListener('visibilitychange',visible);
  }};
}
const api={merge,validateCard,state,displayScale,render,mount};
if (typeof module!=='undefined'&&module.exports) module.exports=api;
if (global.document) mount(global.document);
})(typeof window!=='undefined'?window:globalThis);
