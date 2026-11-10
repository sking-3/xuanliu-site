(function (global) {
'use strict';
const IDS=['sentiment','valuation','flows','active','macro'];
const MAX_BYTES=262144;
const MAX_AGE_DAYS={sentiment:3,valuation:45,flows:120,active:2/24,macro:45};
const LABELS={sentiment:'市场温度',valuation:'核心估值',flows:'跨境资金',active:'活跃标的',macro:'宏观速递'};
const SCOPES={sentiment:'比特币 · 恐惧与贪婪',valuation:'沪深300 · 月末事实表',flows:'美国长期证券 · 外资净买入',active:'加密资产 · 24小时成交额',macro:'美国宏观 · 官方发布与日历'};
const HOSTS=['alternative.me','csindex.com.cn','treasury.gov','bls.gov'];
function fail(){throw Error('Invalid market overview snapshot');}
function plain(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function str(v,max=160){if(typeof v!=='string'||!v.trim()||v.length>max)fail();return v.trim();}
function number(v,min=-1e15,max=1e15){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail();return v;}
function stamp(v,now,future=false){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v))fail();const [year,month,day]=v.slice(0,10).split('-').map(Number),t=Date.parse(v);if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||!Number.isFinite(t)||t<0||(!future&&t>now+300000)||t>now+732*86400000)fail();return v;}
function link(v){let u;try{u=new URL(str(v,2048));}catch(_){fail();}if(u.protocol!=='https:'||u.username||u.password||u.port||!HOSTS.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))fail();return u.href;}
function data(id,d,now){
  if(!plain(d))fail();
  if(id==='sentiment'){
    const value=number(d.value,0,100),previous=d.previous===null?null:number(d.previous,0,100);
    if(!Number.isInteger(value)||(previous!==null&&!Number.isInteger(previous)))fail();
    if(!['Extreme Fear','Fear','Neutral','Greed','Extreme Greed'].includes(d.classification))fail();
    return {value,previous,classification:d.classification};
  }
  if(id==='valuation'){
    if(d.indexCode!=='000300')fail();
    return {name:str(d.name,30),indexCode:'000300',pe:number(d.pe,0.001,10000),pb:number(d.pb,0.001,1000),dividendYield:number(d.dividendYield,0,100)};
  }
  if(id==='flows'){
    if(typeof d.period!=='string'||!/^20\d\d-(?:0[1-9]|1[0-2])$/.test(d.period))fail();
    const out={period:d.period,netMillions:number(d.netMillions)};for(const k of ['treasuryMillions','agencyMillions','corporateMillions','equityMillions'])out[k]=d[k]===null?null:number(d[k]);
    return out;
  }
  if(id==='active'){
    if(!Array.isArray(d.items)||d.items.length<1||d.items.length>10)fail();
    const seen=new Set();return {universe:str(d.universe,200),items:d.items.map(r=>{
      if(!plain(r))fail();const symbol=str(r.symbol,24);if(seen.has(symbol))fail();seen.add(symbol);
      return {symbol,name:str(r.name,100),volumeUsd:number(r.volumeUsd,0),change24h:r.change24h===null?null:number(r.change24h,-100,1e6),lastUpdated:stamp(r.lastUpdated,now)};
    })};
  }
  if(!plain(d.latest)||!Array.isArray(d.events)||d.events.length>30)fail();
  return {latest:{title:str(d.latest.title,1000),url:link(d.latest.url),publishedAt:stamp(d.latest.publishedAt,now),updatedAt:d.latest.updatedAt===null?null:stamp(d.latest.updatedAt,now)},events:d.events.map(e=>{
    if(!plain(e))fail();return {title:str(e.title,160),startAt:stamp(e.startAt,now,true),url:link(e.url)};
  }).sort((a,b)=>Date.parse(a.startAt)-Date.parse(b.startAt))};
}
function validate(p,now=Date.now()){
  if(!plain(p)||p.schemaVersion!==1||!plain(p.cards))fail();
  const generatedAt=stamp(p.generatedAt,now),cards={};
  for(const id of IDS){
    const c=p.cards[id];if(!plain(c)||!['ready','stale','unavailable'].includes(c.status))fail();
    const card={status:c.status,sourceName:str(c.sourceName,80),sourceUrl:link(c.sourceUrl),sourceUpdatedAt:c.sourceUpdatedAt===null?null:stamp(c.sourceUpdatedAt,now),fetchedAt:c.fetchedAt===null?null:stamp(c.fetchedAt,now),lastAttemptAt:c.lastAttemptAt===null?null:stamp(c.lastAttemptAt,now),asOf:c.asOf===null?null:stamp(c.asOf,now),errorCode:c.errorCode===null?null:str(c.errorCode,80),data:null};
    for(const field of ['fetchedAt','lastAttemptAt'])if(card[field]&&Date.parse(card[field])>Date.parse(generatedAt)+5000)fail();
    if(c.status==='unavailable'){if(c.data!==null)fail();}
    else{
      if(!card.fetchedAt||!card.asOf||Date.parse(card.asOf)>Date.parse(card.fetchedAt)+300000)fail();card.data=data(id,c.data,now);
      if(card.sourceUpdatedAt&&Date.parse(card.sourceUpdatedAt)>Date.parse(card.fetchedAt)+300000)fail();
      if(id==='flows'&&new Date(card.asOf).toISOString().slice(0,7)!==card.data.period)fail();
      if(id==='active'){
        if(Date.parse(card.asOf)!==Math.min(...card.data.items.map(r=>Date.parse(r.lastUpdated))))fail();
        for(let i=1;i<card.data.items.length;i++)if(card.data.items[i].volumeUsd>card.data.items[i-1].volumeUsd)fail();
      }
      if(id==='macro'&&(Date.parse(card.asOf)!==Date.parse(card.data.latest.publishedAt)||(card.data.latest.updatedAt&&Date.parse(card.data.latest.updatedAt)<Date.parse(card.data.latest.publishedAt))))fail();
    }
    cards[id]=card;
  }
  return {schemaVersion:1,generatedAt,cards};
}
function stale(id,c,now=Date.now(),readFailed=false){return !!c.data&&(readFailed||c.status!=='ready'||now-Date.parse(c.asOf)>MAX_AGE_DAYS[id]*86400000);}
function dateLabel(v,time=false){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',...(time?{hour:'2-digit',minute:'2-digit',hour12:false}:{year:'numeric'})}).format(new Date(v));}
function decimal(v,n=2){return v.toLocaleString('zh-CN',{minimumFractionDigits:n,maximumFractionDigits:n});}
function signed(v,n=2){return (v>0?'+':'')+decimal(v,n);}
function compactUsd(v){return v>=1e8?decimal(v/1e8)+' 亿美元':v>=1e4?decimal(v/1e4)+' 万美元':decimal(v)+' 美元';}
function eventTitle(t){return ({'Consumer Price Index':'CPI 消费者物价','Producer Price Index':'PPI 生产者物价','Employment Situation':'非农就业报告'})[t]||t;}
function employmentHeadline(t){
  const m=t.match(/^Payroll employment (rises|falls) by ([\d,]+) in (\w+); unemployment rate (?:changes little at|is unchanged at|rises to|falls to) ([\d.]+)%\.?$/i);
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  if(!m||!months.includes(m[3]))return t;
  return `${months.indexOf(m[3])+1}月非农 ${m[1].toLowerCase()==='falls'?'−':'+'}${decimal(Number(m[2].replace(/,/g,''))/1e4,1)}万 · 失业率 ${m[4]}%`;
}
function node(doc,tag,text,cls){const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function anchor(doc,text,url,cls){const a=node(doc,'a',text,cls);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function renderCard(doc,host,id,c,now,readFailed){
  const status=stale(id,c,now,readFailed)?'stale':c.data?'ready':'unavailable';
  const head=node(doc,'div',undefined,'insight-heading');head.append(node(doc,'h2',LABELS[id]));
  head.append(node(doc,'span',status==='ready'?'已采集':status==='stale'?'待更新':'暂无数据','insight-state'));
  const scope=node(doc,'p',SCOPES[id],'insight-scope'),body=node(doc,'div',undefined,'insight-body');
  const metric=(value,unit,label)=>{const line=node(doc,'div',undefined,'insight-metric');line.append(node(doc,'strong',value));if(unit)line.append(node(doc,'span',unit));body.append(line);if(label)body.append(node(doc,'p',label,'insight-caption'));};
  const row=(label,value)=>{const r=node(doc,'div',undefined,'insight-row');r.append(node(doc,'span',label),node(doc,'strong',value));body.append(r);};
  if(c.data){const d=c.data;
    if(id==='sentiment'){
      const labels={'Extreme Fear':'极度恐惧',Fear:'恐惧',Neutral:'中性',Greed:'贪婪','Extreme Greed':'极度贪婪'};
      metric(String(d.value),'/ 100',labels[d.classification]);
      const meter=node(doc,'meter',undefined,'insight-meter');meter.min=0;meter.max=100;meter.value=d.value;meter.setAttribute('aria-label','比特币恐惧与贪婪指数');body.append(meter);
      if(d.previous!==null)row('昨日',String(d.previous));
    }else if(id==='valuation'){
      metric(decimal(d.pe),'倍','滚动市盈率 · PE(TTM)');row('市净率 PB',decimal(d.pb)+' 倍');row('股息率',decimal(d.dividendYield)+'%');
    }else if(id==='flows'){
      metric(signed(d.netMillions/100),'亿美元',d.period.replace('-','年')+'月 · 月度');row('美债净买入',d.treasuryMillions===null?'':signed(d.treasuryMillions/100)+' 亿');row('股票净买入',d.equityMillions===null?'':signed(d.equityMillions/100)+' 亿');
    }else if(id==='active'){
      const list=node(doc,'ol',undefined,'insight-ranking');for(const r of d.items.slice(0,3)){const li=node(doc,'li');const name=node(doc,'strong',r.symbol);
        if(['BTC','ETH','SOL','USDT'].includes(r.symbol)){const chart=node(doc,'a',r.symbol);chart.href='chart.html?tvwidgetsymbol='+encodeURIComponent('COINBASE:'+r.symbol+'USD');chart.setAttribute('aria-label',r.symbol+' · 查看 Coinbase 美元现货K线');name.replaceChildren(chart);}
        li.append(name,node(doc,'span',compactUsd(r.volumeUsd)));li.setAttribute('title',r.name+'；来源更新 '+dateLabel(r.lastUpdated,true));list.append(li);}body.append(list,node(doc,'p',d.universe,'insight-caption'));
    }else{
      const headline=anchor(doc,employmentHeadline(d.latest.title),d.latest.url,'insight-headline');headline.setAttribute('title',d.latest.title);body.append(headline,node(doc,'p','发布 '+dateLabel(d.latest.publishedAt),'insight-caption'));
      const events=d.events.filter(e=>Date.parse(e.startAt)>=now).slice(0,2);
      for(const e of events){const a=anchor(doc,eventTitle(e.title),e.url,'insight-event');a.append(node(doc,'time',dateLabel(e.startAt,true)+' 北京时间'));body.append(a);}
    }
  }
  const foot=node(doc,'footer',undefined,'insight-footer');foot.append(anchor(doc,c.sourceName+' ↗',c.sourceUrl,'insight-source'));
  if(c.asOf){const time=node(doc,'time','截至 '+dateLabel(c.asOf,id==='active'),'insight-asof');time.dateTime=c.asOf;time.setAttribute('title','来源统计时间（北京时间）；采集于 '+dateLabel(c.fetchedAt,true)+(c.sourceUpdatedAt?'；来源更新 '+dateLabel(c.sourceUpdatedAt,true):''));foot.append(time);}
  host.setAttribute('data-state',status);host.setAttribute('aria-busy','false');host.replaceChildren(head,scope,body,foot);
}
function mount(doc,options={}){
  const root=doc.getElementById('market-insights');if(!root)return null;
  const hosts=Object.fromEntries(IDS.map(id=>[id,doc.getElementById('insight-'+id)]));if(IDS.some(id=>!hosts[id]))return null;
  const fetcher=options.fetch||global.fetch.bind(global),now=options.now||Date.now;
  let snapshot=null,inflight=null,readFailed=false;
  function render(){if(!snapshot)return;const active=doc.activeElement,focusId=IDS.find(id=>hosts[id].contains?.(active)),href=active?.href;
    for(const id of IDS)renderCard(doc,hosts[id],id,snapshot.cards[id],now(),readFailed);
    if(focusId&&href){const replacement=[...hosts[focusId].querySelectorAll('a')].find(a=>a.href===href);replacement?.focus();}}
  async function read(){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const r=await fetcher('market-overview.json',{cache:'no-cache',credentials:'omit',redirect:'error',signal:controller.signal});
      if(!r.ok||!/application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(r.headers.get('content-type')||'')||Number(r.headers.get('content-length'))>MAX_BYTES)fail();
      const reader=r.body.getReader(),chunks=[];let bytes=0;for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();fail();}chunks.push(value);}
      const next=validate(JSON.parse(await new Blob(chunks).text()),now());
      if(snapshot&&Date.parse(next.generatedAt)<Date.parse(snapshot.generatedAt))fail();
      if(snapshot)for(const id of IDS){const before=snapshot.cards[id],after=next.cards[id];if(before.data&&(!after.data||Date.parse(after.fetchedAt)<Date.parse(before.fetchedAt)||Date.parse(after.asOf)<Date.parse(before.asOf)))next.cards[id]={...before,status:'stale',lastAttemptAt:after.lastAttemptAt,errorCode:after.errorCode||'older_snapshot'};}
      snapshot=next;readFailed=false;render();
    }catch(_){readFailed=true;if(snapshot)render();else for(const id of IDS){hosts[id].setAttribute('aria-busy','false');const status=hosts[id].querySelector('.insight-state');if(status)status.textContent='暂未取得数据';}}
    finally{clearTimeout(timer);}
  }
  function refresh(){if(inflight)return inflight;inflight=read().finally(()=>{inflight=null;});return inflight;}
  const interval=setInterval(()=>{if(doc.visibilityState==='visible')refresh();else render();},600000);
  doc.addEventListener('visibilitychange',()=>{if(doc.visibilityState==='visible'){render();refresh();}});
  refresh();return {refresh,render,getSnapshot:()=>snapshot,destroy:()=>clearInterval(interval)};
}
const api={IDS,MAX_BYTES,MAX_AGE_DAYS,validate,validateSnapshot:validate,stale,dateLabel,employmentHeadline,eventTitle,renderCard,mount};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(global.document)mount(global.document);
})(typeof window!=='undefined'?window:globalThis);
