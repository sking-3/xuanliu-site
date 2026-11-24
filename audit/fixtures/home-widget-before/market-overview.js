(function (global) {
'use strict';
const IDS=['sentiment','valuation','flows','active','macro'];
const MAX_BYTES=262144;
const MAX_AGE_DAYS={sentiment:3,valuation:45,flows:120,active:2/24,macro:45};
const LABELS={sentiment:'加密情绪',valuation:'核心估值',flows:'跨境资金',active:'活跃标的',macro:'宏观速递'};
const SCOPES={sentiment:'比特币 · 恐惧与贪婪',valuation:'沪深300 · 月末事实表',flows:'美国长期证券 · 月度净买入',active:'加密资产 · 24小时成交额',macro:'中国宏观 · 国家统计局发布'};
const CADENCE={sentiment:'日度情绪指标 · 非盘中报价',valuation:'月末估值 · 随来源事实表发布',flows:'月度统计 · 不代表盘中资金流',active:'成交额快照 · 盘中报价见行情区',macro:'中文官方发布 · 非盘中行情'};
const HOSTS=['alternative.me','csindex.com.cn','treasury.gov','bls.gov','stats.gov.cn'];
const SOURCES={
  sentiment:['Alternative.me','https://alternative.me/crypto/fear-and-greed-index/'],
  valuation:['中证指数','https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/000300factsheet.pdf'],
  flows:['美国财政部 TIC','https://home.treasury.gov/data/treasury-international-capital-tic-system-home-page/tic-forms-instructions/securities-a-us-transactions-with-foreign-residents-in-long-term-securities'],
  active:['Alternative.me','https://alternative.me/crypto/'],
  macro:['国家统计局','https://www.stats.gov.cn/sj/zxfb/']
};
function unavailableCard(id,errorCode){
  const [sourceName,sourceUrl]=SOURCES[id];
  return {status:'unavailable',sourceName,sourceUrl,sourceUpdatedAt:null,fetchedAt:null,lastAttemptAt:null,asOf:null,errorCode,data:null};
}
function readFailure(code){const error=Error('Market snapshot could not be read');error.snapshotCode=code;throw error;}
function failureCode(error){return /^(?:snapshot_(?:content_type|too_large|invalid_encoding|invalid_json|invalid_card|older|origin|body)|snapshot_http_[1-5]\d\d)$/.test(error?.snapshotCode||'')?error.snapshotCode:'snapshot_unreachable';}
function errorLabel(code){
  if(/^snapshot_http_[1-5]\d\d$/.test(code||''))return '站内快照返回 HTTP '+code.slice(-3);
  return ({snapshot_content_type:'站内快照响应格式不正确',snapshot_too_large:'站内快照超过大小限制',snapshot_invalid_encoding:'站内快照编码无效',snapshot_invalid_json:'站内快照不是有效 JSON',snapshot_invalid_card:'该项快照未通过数据校验',snapshot_older:'站内快照时间回退',snapshot_origin:'站内快照地址不匹配',snapshot_body:'站内快照没有响应正文',snapshot_unreachable:'站内快照无法读取'})[code]||'暂无有效快照';
}
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
function validateCard(id,c,generatedAt,now){
  if(!plain(c)||!['ready','stale','unavailable'].includes(c.status))fail();
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
  return card;
}
function validate(p,now=Date.now()){
  if(!plain(p)||p.schemaVersion!==1||!plain(p.cards))fail();
  const generatedAt=stamp(p.generatedAt,now),cards={};
  for(const id of IDS)cards[id]=validateCard(id,p.cards[id],generatedAt,now);
  return {schemaVersion:1,generatedAt,cards};
}
function isStatisticsLink(value){
  const hostname=new URL(value).hostname;
  return hostname==='www.stats.gov.cn'||hostname==='stats.gov.cn';
}
function stale(id,c,now=Date.now(),readFailed=false){
  const missedDailyChecks=id==='macro'&&isStatisticsLink(c.sourceUrl)&&now-Date.parse(c.fetchedAt)>2*86400000;
  return !!c.data&&(readFailed||c.status!=='ready'||missedDailyChecks||now-Date.parse(c.asOf)>MAX_AGE_DAYS[id]*86400000);
}
function cardState(id,c,now=Date.now(),readFailed=false){
  if(!c?.data)return 'unavailable';
  return stale(id,c,now,readFailed)?'stale':'ready';
}
function cardStateLabel(state,readFailed=false){
  if(state==='ready')return '已更新';
  if(state==='stale')return readFailed?'读取失败 · 保留旧值':'历史快照 · 待更新';
  return readFailed?'站内快照读取失败':'暂无可核验数据';
}
function dateLabel(v,time=false,withYear=!time){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',...(withYear?{year:'numeric'}:{}),...(time?{hour:'2-digit',minute:'2-digit',hour12:false}:{})}).format(new Date(v));}
function decimal(v,n=2){return v.toLocaleString('zh-CN',{minimumFractionDigits:n,maximumFractionDigits:n});}
function signed(v,n=2){return (v>0?'+':'')+decimal(v,n);}
function compactUsd(v){return v>=1e8?decimal(v/1e8)+' 亿美元':v>=1e4?decimal(v/1e4)+' 万美元':decimal(v)+' 美元';}
const MACRO_TITLE_LABELS={
  'Consumer Price Index':'CPI 消费者物价',
  'Producer Price Index':'PPI 生产者物价',
  'Employment Situation':'非农就业报告',
  'Federal Open Market Committee':'美联储 FOMC 利率决议',
  'Interest Rate Decision':'利率决议',
  'Retail Sales':'零售销售',
  'Initial Jobless Claims':'初请失业金人数',
  'GDP':'国内生产总值 GDP'
};
function eventTitle(t){
  const raw=String(t||'').trim();
  return MACRO_TITLE_LABELS[raw]||raw.replace(/\b(Advance|Preliminary|Final)\b/gi,'').replace(/\s{2,}/g,' ').trim();
}
function employmentHeadline(t){
  const m=t.match(/^Payroll employment (rises|falls) by ([\d,]+) in (\w+); unemployment rate (?:changes little at|is unchanged at|rises to|falls to) ([\d.]+)%\.?$/i);
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  if(!m||!months.includes(m[3]))return t;
  return `${months.indexOf(m[3])+1}月非农 ${m[1].toLowerCase()==='falls'?'−':'+'}${decimal(Number(m[2].replace(/,/g,''))/1e4,1)}万 · 失业率 ${m[4]}%`;
}
function chineseRelease(payload,now){
  if(!plain(payload)||payload.schemaVersion!==1)fail();
  const generatedAt=stamp(payload.generatedAt,now);
  const card=validateCard('macro',payload.card,generatedAt,now);
  if(!isStatisticsLink(card.sourceUrl)||card.sourceName!=='国家统计局')fail();
  if(card.data&&(!isStatisticsLink(card.data.latest.url)||card.data.events.some(event=>!isStatisticsLink(event.url))))fail();
  return {generatedAt,card};
}
function macroSnapshot(payload,base,now=Date.now()){
  try{
    const {generatedAt,card}=chineseRelease(payload,now);
    const latest=Date.parse(generatedAt)>Date.parse(base.generatedAt)?generatedAt:base.generatedAt;
    return {...base,generatedAt:latest,cards:{...base.cards,macro:card}};
  }catch(_){return null;}
}
function node(doc,tag,text,cls){const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function anchor(doc,text,url,cls){const a=node(doc,'a',text,cls);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function renderCard(doc,host,id,c,now,readFailed){
  const status=cardState(id,c,now,readFailed);
  const head=node(doc,'div',undefined,'insight-heading');head.append(node(doc,'h2',LABELS[id]));
  head.append(node(doc,'span',status==='ready'?({sentiment:'日度',valuation:'月末',flows:'月度',active:'快照',macro:'官方发布'})[id]:cardStateLabel(status,readFailed),'insight-state'));
  const foreignMacro=id==='macro'&&!isStatisticsLink(c.sourceUrl);
  const scope=node(doc,'p',foreignMacro?'美国宏观 · 备用发布与日历':SCOPES[id],'insight-scope'),body=node(doc,'div',undefined,'insight-body');
  const metric=(value,unit,label)=>{const line=node(doc,'div',undefined,'insight-metric');line.append(node(doc,'strong',value));if(unit)line.append(node(doc,'span',unit));body.append(line);if(label)body.append(node(doc,'p',label,'insight-caption'));};
  const row=(label,value)=>{const r=node(doc,'div',undefined,'insight-row');r.append(node(doc,'span',label),node(doc,'strong',value));body.append(r);};
  const secondary=entries=>{
    const list=node(doc,'dl',undefined,'insight-secondary');
    for(const [label,value] of entries){
      const item=node(doc,'div');
      item.append(node(doc,'dt',label),node(doc,'dd',value));
      list.append(item);
    }
    body.append(list);
  };
  const context=title=>{
    const section=node(doc,'section',undefined,'insight-context');
    section.append(node(doc,'h3',title));body.append(section);return section;
  };
  if(c.data){const d=c.data;
    if(id==='sentiment'){
      const labels={'Extreme Fear':'极度恐惧',Fear:'恐惧',Neutral:'中性',Greed:'贪婪','Extreme Greed':'极度贪婪'};
      metric(String(d.value),'/ 100',labels[d.classification]);
      const meter=node(doc,'meter',undefined,'insight-meter');meter.min=0;meter.max=100;meter.value=d.value;meter.setAttribute('aria-label','比特币恐惧与贪婪指数');body.append(meter);
      if(d.previous!==null)row('昨日',String(d.previous));
    }else if(id==='valuation'){
      metric(decimal(d.pe),'倍','滚动市盈率 · PE(TTM)');
      secondary([['市净率 PB',decimal(d.pb)+' 倍'],['股息率',decimal(d.dividendYield)+'%']]);
      const reading=context('盈利视角'),yieldRow=node(doc,'div',undefined,'insight-row');
      yieldRow.append(node(doc,'span','盈利收益率'),node(doc,'strong',decimal(100/d.pe)+'%'));
      reading.append(yieldRow,node(doc,'p','按 PE 倒数推算，表示滚动盈利相对指数价格的水平。'),node(doc,'p','盈利收益率与股息率口径不同，也不等于预期投资回报。'));

    }else if(id==='flows'){
      metric(signed(d.netMillions/100),'亿美元',d.period.replace('-','年')+'月 · 月度');
      const components=[
        ['美债净买入',d.treasuryMillions],['机构债净买入',d.agencyMillions],
        ['公司债净买入',d.corporateMillions],['股票净买入',d.equityMillions]
      ];
      secondary(components.map(([label,value])=>[label,value===null?'—':signed(value/100)+' 亿']));
      const structure=context('资金投向');
      const bondValues=components.slice(0,3).map(([,value])=>value);
      if(bondValues.every(value=>value!==null)){
        const bonds=bondValues.reduce((sum,value)=>sum+value,0);
        structure.append(node(doc,'p','债券合计 '+signed(bonds/100)+' 亿美元'));
      }
      const values=components.map(([,value])=>value),complete=values.every(value=>value!==null);
      const total=complete?values.reduce((sum,value)=>sum+value,0):0;
      if(complete&&values.every(value=>value>=0)&&total>0&&d.netMillions>0&&Math.abs(total-d.netMillions)<=4){
        const bar=node(doc,'div',undefined,'insight-flow-bar'),legend=node(doc,'ul',undefined,'insight-flow-legend');
        const colors=['#3e647e','#7891a4','#72a29a','#a68a56'];
        bar.setAttribute('aria-hidden','true');
        components.forEach(([label,value],index)=>{
          const share=value/total*100,text=label.replace('净买入','')+' '+decimal(share,1)+'%';
          const segment=node(doc,'span'),item=node(doc,'li',text);
          segment.setAttribute('style','flex: '+share+'; --flow-color: '+colors[index]);
          segment.setAttribute('title',text);item.setAttribute('style','--flow-color: '+colors[index]);
          bar.append(segment);legend.append(item);
        });
        structure.append(bar,legend);
      }else{
        const note=!complete?'分项尚未完整，暂不计算结构占比。':values.some(value=>value<0)?'部分资产为净卖出，保留各项正负净额。':total===0&&d.netMillions===0?'四类资产本期净额均为零。':'分项与合计尚未对齐，暂不计算占比。';
        structure.append(node(doc,'p',note));
      }

    }else if(id==='active'){
      const list=node(doc,'ol',undefined,'insight-ranking');for(const r of d.items.slice(0,3)){const li=node(doc,'li');const name=node(doc,'strong',r.symbol);
        if(['BTC','ETH','SOL','USDT'].includes(r.symbol)){const chart=node(doc,'a',r.symbol);const pair=r.symbol==='USDT'?'BTCUSDT':r.symbol+'USDT';chart.href='chart.html?tvwidgetsymbol='+encodeURIComponent('BITGET:'+pair);chart.setAttribute('aria-label',r.symbol+' · 查看 Bitget USDT 现货K线');name.replaceChildren(chart);}
        li.append(name,node(doc,'span',compactUsd(r.volumeUsd)));li.setAttribute('title',r.name+'；来源更新 '+dateLabel(r.lastUpdated,true));list.append(li);}body.append(list,node(doc,'p',d.universe,'insight-caption'));
    }else{
      const release=node(doc,'div',undefined,'insight-release');
      const published=d.latest.publishedAt,fullDate='发布 '+dateLabel(published)+'（北京时间）';
      const day=node(doc,'time',dateLabel(published,false,false),'insight-date');
      day.setAttribute('datetime',published);
      day.setAttribute('aria-label',fullDate);
      day.setAttribute('title',fullDate);
      const headline=anchor(doc,employmentHeadline(d.latest.title),d.latest.url,'insight-headline');
      headline.setAttribute('title',d.latest.title);
      release.append(day,headline);
      body.append(release);
      const events=d.events.filter(e=>Date.parse(e.startAt)>=now).slice(0,2);
      for(const e of events){const a=anchor(doc,eventTitle(e.title),e.url,'insight-event');a.append(node(doc,'time',dateLabel(e.startAt,true)+' 北京时间'));body.append(a);}
      if(!events.length&&foreignMacro)body.append(node(doc,'p','暂无未来已核验发布，等待下一次官方日历更新','insight-caption'));
      if(!foreignMacro){
        const followup=context('继续跟踪'),links=node(doc,'div',undefined,'insight-followup');
        for(const [label,detail,url] of [
          ['增长与物价','工业 · 消费 · CPI / PPI','https://www.stats.gov.cn/sj/zxfb/'],
          ['资金与信用','社融 · 货币 · 信贷','https://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html'],
          ['官方发布日程','查看数据公布安排','https://www.stats.gov.cn/sj/fbrc/']
        ]){
          const a=anchor(doc,undefined,url);
          a.append(node(doc,'strong',label+' ↗'),node(doc,'span',detail));links.append(a);
        }
        followup.append(links);
      }

    }
  }else body.append(node(doc,'p',readFailed?errorLabel(c.errorCode)+'，尚无有效快照。可打开来源核对。':'暂无可核验数据，可打开来源查看发布情况。','insight-empty'));
  const cadenceText=foreignMacro?'中文快照暂不可用 · 美国官方备用来源':CADENCE[id];
  const cadence=node(doc,'p',cadenceText+(c.errorCode?(c.errorCode==='http_403'||c.errorCode==='http_429'?' · 来源访问已停止':c.data?' · 本次读取失败，保留旧值':''):''),'insight-cadence');
  const foot=node(doc,'footer',undefined,'insight-footer');foot.append(anchor(doc,c.sourceName+' ↗',c.sourceUrl,'insight-source'));
  if(c.asOf){const time=node(doc,'time','数据截至 '+dateLabel(c.asOf,id==='active',true),'insight-asof');time.dateTime=c.asOf;time.setAttribute('title','来源统计时间（北京时间）'+(c.sourceUpdatedAt?'；来源更新 '+dateLabel(c.sourceUpdatedAt,true,true):''));foot.append(time);}
  else foot.append(node(doc,'span','数据时间未提供','insight-asof'));
  if(c.fetchedAt){const time=node(doc,'time','采集 '+dateLabel(c.fetchedAt,true,true)+'（北京）','insight-fetched');time.dateTime=c.fetchedAt;foot.append(time);}
  host.setAttribute('data-state',status);host.setAttribute('aria-busy','false');host.replaceChildren(head,scope,body,cadence,foot);
}
function mount(doc,options={}){
  const root=doc.getElementById('market-insights');if(!root)return null;
  const hosts=Object.fromEntries(IDS.map(id=>[id,doc.getElementById('insight-'+id)]).filter(([,host])=>host));
  const presentIds=Object.keys(hosts);if(!presentIds.length)return null;
  const fetcher=options.fetch||global.fetch.bind(global),now=options.now||Date.now;
  let aggregate=null,chinese=null,inflight=null,aggregateFailed=false,chineseFailed=false,aggregateError=null,chineseError=null,cardErrors={};
  function getSnapshot(){
    if(!aggregate||!chinese)return aggregate;
    const generatedAt=Date.parse(chinese.generatedAt)>Date.parse(aggregate.generatedAt)?chinese.generatedAt:aggregate.generatedAt;
    return {...aggregate,generatedAt,cards:{...aggregate.cards,macro:chinese.card}};
  }
  function render(){
    const active=doc.activeElement,focusId=presentIds.find(id=>hosts[id].contains?.(active)),href=active?.href;
    for(const id of presentIds){
      const source=id==='macro'&&chinese?chinese.card:aggregate?.cards[id];
      if(source){
        const failed=id==='macro'&&chinese?chineseFailed:aggregateFailed||!!cardErrors[id]||(id==='macro'&&chineseFailed);
        renderCard(doc,hosts[id],id,source,now(),failed);
      }else{
        const error=id==='macro'?(chineseError||aggregateError):aggregateError;
        renderCard(doc,hosts[id],id,unavailableCard(id,error),now(),!!error);
      }
    }
    if(focusId&&href){const replacement=[...hosts[focusId].querySelectorAll('a')].find(a=>a.href===href);replacement?.focus();}
  }
  async function readJson(path,signal){
    if(path!=='market-overview.json'&&path!=='macro-cn.json')readFailure('snapshot_origin');
    const response=await fetcher(path,{cache:'no-cache',credentials:'omit',redirect:'error',signal});
    const expected=global.location?new URL(path,global.location.href):null;
    if(expected&&response.url&&response.url!==expected.href)readFailure('snapshot_origin');
    if(!response.ok)readFailure('snapshot_http_'+response.status);
    // The VPS previously served these exact JSON files as octet-stream. Accept
    // that MIME only here; strict UTF-8, JSON and per-card validation still apply.
    const type=response.headers.get('content-type')||'';
    if(!/^application\/(?:(?:[\w.+-]*\+)?json|octet-stream)(?:\s*;|$)/i.test(type))readFailure('snapshot_content_type');
    if(Number(response.headers.get('content-length'))>MAX_BYTES)readFailure('snapshot_too_large');
    if(!response.body)readFailure('snapshot_body');
    const reader=response.body.getReader(),chunks=[];
    let bytes=0;
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>MAX_BYTES){await reader.cancel();readFailure('snapshot_too_large');}
      chunks.push(value);
    }
    const payload=new Uint8Array(bytes);let offset=0;
    for(const chunk of chunks){payload.set(chunk,offset);offset+=chunk.byteLength;}
    let decoded;
    try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(payload);}catch(_){readFailure('snapshot_invalid_encoding');}
    try{return JSON.parse(decoded);}catch(_){readFailure('snapshot_invalid_json');}
  }
  function regresses(before,after){
    return !!before?.data&&(!after.data||Date.parse(after.fetchedAt)<Date.parse(before.fetchedAt)||Date.parse(after.asOf)<Date.parse(before.asOf));
  }
  async function readAggregate(signal){
    const payload=await readJson('market-overview.json',signal),checkedAt=now();
    if(!plain(payload)||payload.schemaVersion!==1||!plain(payload.cards))readFailure('snapshot_invalid_card');
    let generatedAt;try{generatedAt=stamp(payload.generatedAt,checkedAt);}catch(_){readFailure('snapshot_invalid_card');}
    if(aggregate&&Date.parse(generatedAt)<Date.parse(aggregate.generatedAt))readFailure('snapshot_older');
    const next={schemaVersion:1,generatedAt,cards:{}},errors={};
    for(const id of IDS){
      try{next.cards[id]=validateCard(id,payload.cards[id],generatedAt,checkedAt);}
      catch(_){
        errors[id]='snapshot_invalid_card';
        const before=aggregate?.cards[id];
        next.cards[id]=before?.data?{...before,status:'stale',errorCode:'snapshot_invalid_card'}:unavailableCard(id,'snapshot_invalid_card');
      }
    }
    if(aggregate)for(const id of IDS){
      const before=aggregate.cards[id],after=next.cards[id];
      if(regresses(before,after))next.cards[id]={...before,status:'stale',lastAttemptAt:after.lastAttemptAt,errorCode:after.errorCode||'older_snapshot'};
    }
    aggregate=next;
    cardErrors=errors;
  }
  async function readChinese(signal){
    const payload=await readJson('macro-cn.json',signal);let next;
    try{next=chineseRelease(payload,now());}catch(_){readFailure('snapshot_invalid_card');}
    if(chinese&&(Date.parse(next.generatedAt)<Date.parse(chinese.generatedAt)||regresses(chinese.card,next.card)))readFailure('snapshot_older');
    chinese=next;
  }
  async function read(){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const [overview,release]=await Promise.allSettled([readAggregate(controller.signal),readChinese(controller.signal)]);
      aggregateFailed=overview.status==='rejected';
      chineseFailed=release.status==='rejected';
      aggregateError=aggregateFailed?failureCode(overview.reason):null;
      chineseError=chineseFailed?failureCode(release.reason):null;
      render();
    }finally{clearTimeout(timer);}
  }
  function refresh(){if(inflight)return inflight;inflight=read().finally(()=>{inflight=null;});return inflight;}
  const interval=setInterval(()=>{if(doc.visibilityState==='visible')refresh();else render();},600000);
  doc.addEventListener('visibilitychange',()=>{if(doc.visibilityState==='visible'){render();refresh();}});
  refresh();return {refresh,render,getSnapshot,destroy:()=>clearInterval(interval)};
}
const api={IDS,MAX_BYTES,MAX_AGE_DAYS,validate,validateSnapshot:validate,macroSnapshot,stale,cardState,cardStateLabel,dateLabel,employmentHeadline,eventTitle,renderCard,mount};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(global.document)mount(global.document);
})(typeof window!=='undefined'?window:globalThis);
