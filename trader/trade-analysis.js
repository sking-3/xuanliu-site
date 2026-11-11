/* A single public-data analysis surface for every trader. No trading permissions. */
(function(env){
'use strict';
// Preserve the existing saved-data detail when a dependency failed to load.
if(!env.BooksTradeReplayModel||!env.BooksTradeReplayData)return;
const M=env.BooksTradeReplayModel,D=env.BooksTradeReplayData.create(env);
let current=null;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const fmt=(x,d=4)=>x===null||x===undefined||!Number.isFinite(Number(x))?'—':Number(x).toLocaleString('zh-CN',{maximumFractionDigits:d});
const signed=(x,d=2)=>x===null||x===undefined?'—':(Number(x)>0?'+':'')+fmt(x,d);
const date=x=>x?new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const shortDate=x=>x?new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
const side=s=>({long:'多',short:'空',unknown:'开平未知',both:'净方向未知'})[s]||'—';
const btn=(text,fn,cls='ta-button')=>{const b=el('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;};
function tone(n,value){if(value!==null&&value!==undefined&&Number.isFinite(Number(value)))n.classList.add(Number(value)>=0?'ta-positive':'ta-negative');return n;}
function table(headers){const wrap=el('div',undefined,'ta-table-wrap'),t=el('table',undefined,'ta-table'),head=el('thead'),tr=el('tr'),body=el('tbody');for(const x of headers){const th=el('th',x);th.scope='col';tr.append(th);}head.append(tr);t.append(head,body);wrap.append(t);return {wrap,body};}
function cell(tr,text,cls){const td=el('td',text,cls);tr.append(td);return td;}
function note(text){return el('p',text,'ta-note');}
function empty(title,text){const n=el('div',undefined,'ta-empty');n.append(el('strong',title),note(text));return n;}
function isHL(r){return r.exchange==='Hyperliquid'&&/^0x[0-9a-f]{40}$/.test(r.accountId);}
function official(c){return c.context.binanceView?.closedPositions?.rows||[];}
function rebuild(c){
 c.events=c.context.r.exchange==='Binance'?M.binanceEvents(c.records?.allRows||c.context.binanceView?.orders?.rows||[]):isHL(c.context.r)?M.hyperliquidEvents(c.history?.rows||[]):[];
 const extra=c.context.r.accountId==='5075281354358777856'?c.officialHistory?.rows||[]:official(c);
 c.cycles=M.cycles(c.events,extra);
 if(!c.cycles.some(x=>x.id===c.selected))c.selected=c.cycles[0]?.id||null;
}
function status(c){
 const at=c.records?.checkedAt||c.history?.fetchedAt||c.officialHistory?.fetchedAt||c.context.binanceView?.orders?.fetchedAt;
 const old=at&&Date.now()-new Date(at).getTime()>120000;
 return [c.loading?'正在更新公开记录':c.error?'本次更新未成功，保留历史':old?'历史记录 · 待更新':'已保存的公开记录',`${c.events.length} 条操作 · ${c.cycles.filter(x=>x.official).length} 条官方历史仓位`,at?'最近读取 '+date(at):'尚未取得逐条记录'].join(' · ');
}
function teardown(c){if(c.playTimer)clearInterval(c.playTimer);c.playTimer=null;c.chart?.remove();c.chart=null;c.chartVersion=(c.chartVersion||0)+1;}
function draw(c){
 if(c!==current||!c.root.isConnected)return;
 teardown(c);c.root.replaceChildren();c.root.classList.add('trade-analysis');
 const toolbar=el('div',undefined,'ta-toolbar'),s=el('p',status(c),'ta-status');s.setAttribute('role','status');
 const refresh=btn(c.loading?'更新中…':'刷新记录',()=>load(c,true));refresh.disabled=!!c.loading;toolbar.append(s,refresh);c.root.append(toolbar);
 if(c.context.tab==='analysis')analysis(c);
 if(c.context.tab==='positions')positions(c);
 if(c.context.tab==='orders')orders(c,c.root,c.events);
 if(c.context.tab==='points')points(c);
 const details=el('details',undefined,'ta-method'),summary=el('summary','来源、覆盖范围与计算口径');details.append(summary);
 const r=c.context.r;
 details.append(note(r.exchange==='Binance'?'币安公开操作记录是聚合成交记录，没有订单 ID；更新时间不等于每笔撮合时间。“开仓 / 加仓方向”不能单独确认新开仓。历史仓位汇总来自币安官方历史接口，逐条操作只包含本站已保存的有限样本。当前持仓与挂单未取得时均显示未知。':'Hyperliquid 只读 userFills 返回最近最多 2000 笔成交；默认永续市场之外的现货不混入仓位重建。以每笔 startPosition 校验数量连续性，发生缺口便中断归组，不把样本当完整账户历史。'));
 details.append(note('观测数量净变化 = 已见开 / 加方向数量 − 已见减 / 平方向数量。期初仓位未知或记录版本存在歧义时，不据此断言当前持仓。官方仓位的开平均价只是汇总，不伪造成图上的逐笔买卖点。'));
 if(c.context.metricNote)details.append(note(c.context.metricNote));
 if(c.error)details.append(note('更新状态：'+c.error+'。403 / 429 会停止相应来源请求，不切换接口绕过。'));
 if(isHL(r))details.append(note('成交流水的来源已实现盈亏未扣手续费、资金费；手续费按原费用币单列。首次发现时间是本机读取此成交的时间，不当作开仓时间。'));
 if(c.officialHistory)details.append(note(`历史仓位分页：${c.officialHistory.rows.length} / 来源本次总数 ${c.officialHistory.sourceTotal}；${c.officialHistory.pages} 页，每页 20 条。读取 ${date(c.officialHistory.fetchedAt)}；不是账户完整交割单。`));
 if(c.officialHistory?.performance)details.append(note('熬鹰 30D 表现读取 '+date(c.officialHistory.performance.fetchedAt)+'；来源未提供独立统计截止时间。收益率、盈亏、回撤、胜率均为币安平台原值，不用操作样本估算。'));
 const link=el('a','打开官方来源 ↗');link.href=r.sourceUrl||r.url||(isHL(r)?'https://app.hyperliquid.xyz/explorer/address/'+r.accountId:'https://www.binance.com/zh-CN/copy-trading/lead-details/'+r.accountId);link.target='_blank';link.rel='noopener noreferrer';details.append(link);c.root.append(details);
}
function analysis(c){
 const w=(c.context.period==='30D'&&c.officialHistory?.performance)||c.context.metrics||{},grid=el('div',undefined,'ta-metrics');
 const data=[['所选周期收益率',w.roi===null||w.roi===undefined?'—':signed(w.roi)+'%',w.roi,c.context.periodLabel||c.context.period],
 ['来源盈亏 · '+(w.currency||c.context.r.currency||'USD'),signed(w.pnl),w.pnl,w.asOf||w.sourceAsOf?'数据截至 '+date(w.asOf||w.sourceAsOf):w.fetchedAt?'读取 '+date(w.fetchedAt):'缺少有效周期数据'],
 [c.context.r.exchange==='Binance'?'币安来源回撤':'采样盈亏回撤',w.mdd===null||w.mdd===undefined?'—':fmt(w.mdd,2)+'%',null,c.context.r.exchange==='Binance'?'沿用平台口径':'非标准净值最大回撤'],
 [c.context.r.exchange==='Binance'?'已平仓仓位胜率':'近期平仓片段胜率',w.winRate===null||w.winRate===undefined?'—':fmt(w.winRate,2)+'%',null,c.context.winNote||'资料不足时留空']];
 for(const [label,value,n,caption]of data){const item=el('div',undefined,'ta-metric');item.append(el('span',label),tone(el('strong',value),n),el('small',caption));grid.append(item);}c.root.append(grid);
 const heading=el('div',undefined,'ta-section-head');heading.append(el('h3','仓位观察'),el('span','实际当前仓位以官方新鲜快照为准'));c.root.append(heading);
 if(!c.events.length)c.root.append(empty('尚无可重建的操作记录',isHL(c.context.r)?'正在读取此账户官方近期成交；读取成功后会建立样本回放。':'该来源没有可用的逐条操作。历史汇总仍可在“历史仓位”查看。'));
 else{
  const t=table(['合约 / 方向','已见操作','观测数量净变化','覆盖情况','查看']);
  for(const group of c.cycles.filter(x=>!x.official).slice(0,20)){const tr=el('tr');cell(tr,group.symbol+' · '+side(group.positionSide),'ta-contract');cell(tr,String(group.events.length));cell(tr,group.ambiguous?'记录版本待核':signed(group.observedChange,8));cell(tr,group.status);cell(tr).append(btn('查看点位',()=>jump(c,group),'ta-link'));t.body.append(tr);}if(t.body.children.length)c.root.append(t.wrap);else c.root.append(note('当前操作已关联到官方历史仓位；当前仓位未知。'));
 }
 const foot=el('div',undefined,'ta-summary-links');foot.append(btn(`历史仓位与片段 ${c.cycles.length}`,()=>c.context.activate('positions')),btn(`成交流水 ${c.events.length}`,()=>c.context.activate('orders')));c.root.append(foot);
}
function duration(a,b){if(!a||!b)return '—';const m=Math.max(0,Math.round((b-a)/60000));return (m>=1440?Math.floor(m/1440)+'天 ':'')+(m>=60?Math.floor(m%1440/60)+'时 ':'')+m%60+'分';}
function positions(c){
 c.root.append(note('官方历史仓位与公开操作片段分开标注。展开查看已归档操作；回放仅使用这些操作，不补造缺失买卖点。'));
 if(!c.cycles.length){c.root.append(empty('暂无历史仓位或操作片段','数据读入后自动显示；未取得历史不代表账户没有交易。'));return;}
 const t=table(['合约','来源 / 状态','来源已实现盈亏','平仓数量','开仓均价','平仓均价','持有时长','结束 / 最近操作','操作']);
 for(const [i,x]of c.cycles.entries()){
  const tr=el('tr'),contract=cell(tr,undefined,'ta-contract');contract.append(el('span',side(x.positionSide),'ta-side ta-'+x.positionSide),el('strong',x.symbol));
  const coverage=cell(tr);coverage.append(el('span',x.status,'ta-tag'),el('small',x.official?'币安官方 · '+x.events.length+' 条已见操作':x.events.length+' 条操作 · 非完整仓位'));
  tone(cell(tr,signed(x.pnl)+' '+x.quote),x.pnl);cell(tr,fmt(x.quantity,8));cell(tr,fmt(x.avgEntry,8));cell(tr,fmt(x.avgExit,8));cell(tr,duration(x.opened,x.closed));cell(tr,shortDate(x.lastTime));
  const actions=cell(tr,undefined,'ta-row-actions'),replay=btn('回放',()=>jump(c,x),'ta-button ta-replay'),expand=btn('⌄',()=>{const open=!detail.hidden;detail.hidden=open;expand.setAttribute('aria-expanded',String(!open));expand.textContent=open?'⌄':'⌃';if(open)c.expanded.delete(x.id);else c.expanded.add(x.id);},'ta-button ta-expand');
  expand.setAttribute('aria-label','展开 '+x.symbol+' 的已见操作');expand.setAttribute('aria-expanded',String(c.expanded.has(x.id)));expand.setAttribute('aria-controls','ta-events-'+i);actions.append(replay,expand);t.body.append(tr);
  const detail=el('tr',undefined,'ta-expanded');detail.id='ta-events-'+i;detail.hidden=!c.expanded.has(x.id);const td=cell(detail);td.colSpan=9;td.append(note(x.coverage));orders(c,td,x.events,true);t.body.append(detail);
 }c.root.append(t.wrap);
}
function orders(c,target,events,compact=false){
 if(!compact)target.append(note('实际公开成交 / 聚合成交记录；不包含未成交挂单。来源时间与本系统首次发现时间独立展示。'));
 if(!events.length){target.append(empty('尚未归档逐条操作','仅有开平仓汇总时可查看均价；无法回放未取得的操作。'));return;}
 const t=table(['来源时间（北京）','合约','动作 / 方向','买卖','成交均价','数量','来源已实现盈亏','手续费',isHL(c.context.r)?'本机首次发现':'系统首次发现','订单 ID']);
 for(const x of [...events].reverse()){const tr=el('tr');cell(tr,date(x.time));cell(tr,x.symbol,'ta-contract');cell(tr,x.action+(x.ambiguous?' · 版本待核':''));cell(tr,x.side==='buy'?'买':'卖');cell(tr,fmt(x.price,8)+' '+x.quote);cell(tr,fmt(x.quantity,8));tone(cell(tr,signed(x.pnl)+' '+x.quote),x.pnl);cell(tr,x.fee===null?'—':fmt(x.fee,8)+' '+(x.feeToken||'来源费用币未知'));cell(tr,date(x.firstSeenAt));cell(tr,x.orderId===null?'来源未提供':String(x.orderId));t.body.append(tr);}target.append(t.wrap);
}
function jump(c,x){c.selected=x.id;c.filter='all';c.context.activate('points');}
function points(c){
 if(!c.cycles.length){c.root.append(empty('暂无可回放记录','取得公开历史或逐条成交后，此处显示真实 K 线与已记录的买卖点。'));return;}
 const layout=el('div',undefined,'ta-replay-layout'),left=el('aside',undefined,'ta-cycle-list'),right=el('section',undefined,'ta-replay-main');left.setAttribute('aria-label','选择历史仓位');
 const label=el('label','合约筛选','ta-filter'),select=el('select');select.setAttribute('aria-label','按合约筛选历史仓位');
 for(const s of ['all',...new Set(c.cycles.map(x=>x.symbol))]){const option=el('option',s==='all'?'全部合约':s);option.value=s;select.append(option);}select.value=c.filter||'all';select.onchange=()=>{c.filter=select.value;const matches=c.cycles.filter(x=>c.filter==='all'||x.symbol===c.filter);if(!matches.some(x=>x.id===c.selected))c.selected=matches[0]?.id;draw(c);};label.append(select);left.append(label);
 for(const x of c.cycles.filter(x=>!c.filter||c.filter==='all'||x.symbol===c.filter)){
  const b=btn('',()=>{c.selected=x.id;draw(c);},'ta-cycle');b.setAttribute('aria-pressed',String(c.selected===x.id));b.append(el('strong',side(x.positionSide)+' '+x.symbol),el('span',x.status),el('small',shortDate(x.firstTime)+' → '+shortDate(x.lastTime)),el('small',x.events.length+' 条已见操作'));left.append(b);
 }
 const x=c.cycles.find(x=>x.id===c.selected);layout.append(left,right);c.root.append(layout);if(!x)return;
 const head=el('div',undefined,'ta-replay-title');head.append(el('h3',x.symbol+' · '+side(x.positionSide)),el('span',x.status,'ta-tag'));right.append(head);
 const info=el('div',undefined,'ta-replay-info');for(const [name,value]of [['开仓均价',fmt(x.avgEntry,8)],['平仓均价',fmt(x.avgExit,8)],['已见操作',x.events.length+' 条'],['覆盖范围',x.official?'官方仓位 · 操作有限':x.status]]){const item=el('div');item.append(el('small',name),el('strong',value));info.append(item);}right.append(info);
 const tools=el('div',undefined,'ta-chart-tools'),interval=el('select');interval.setAttribute('aria-label','K 线周期');for(const v of ['15m','1h','4h','1d']){const o=el('option',({'15m':'15 分钟','1h':'1 小时','4h':'4 小时','1d':'日线'})[v]);o.value=v;interval.append(o);}interval.value=c.interval||'1h';interval.onchange=()=>{c.interval=interval.value;draw(c);};tools.append(el('span','K 线与已见买卖点'),interval);right.append(tools);
 const chart=el('div',undefined,'ta-chart'),message=note('正在读取官方 K 线…');chart.setAttribute('aria-label',x.symbol+' K 线及公开操作点位');right.append(chart,message);
 const attribution=el('p',undefined,'ta-attribution'),a=el('a','TradingView Lightweight Charts™');a.href='https://www.tradingview.com/';a.target='_blank';a.rel='noopener noreferrer';const license=el('a','Apache 2.0');license.href='../vendor/lightweight-charts-5.3.0/LICENSE';license.target='_blank';const notice=el('a','署名');notice.href='../vendor/lightweight-charts-5.3.0/NOTICE';notice.target='_blank';attribution.append(a,document.createTextNode(' · '),license,document.createTextNode(' · '),notice);right.append(attribution);
 if(!x.events.length)right.append(note('仅取得官方仓位汇总，暂无逐条操作；不会用开平均价伪造买卖点。'));
 else right.append(note(x.events[0].precision+'。买卖点来自实际保存记录；同一根 K 线内的多笔操作合并标记，逐条明细如下。'));
 const playback=el('div',undefined,'ta-playback');right.append(playback);
 const events=el('div',undefined,'ta-event-list');for(const e of x.events){const b=btn('',()=>c.focusEvent?.(e),'ta-event');b.append(el('span',e.side==='buy'?'买':'卖','ta-side '+(e.side==='buy'?'ta-long':'ta-short')),el('strong',e.action),el('span',fmt(e.price,8)+' '+e.quote),el('small',shortDate(e.time)+' · '+fmt(e.quantity,8)));events.append(b);}right.append(events);
 buildChart(c,x,chart,message,playback);
}
async function buildChart(c,x,container,message,playback){
 const version=++c.chartVersion,interval=c.interval||'1h',sec=({'15m':900,'1h':3600,'4h':14400,'1d':86400})[interval];
 const begin=Math.floor((x.firstTime-24*sec*1000)/(sec*1000))*sec*1000,end=Math.floor(Math.min(Date.now(),x.lastTime+24*sec*1000)/(sec*1000))*sec*1000,start=Math.max(begin,end-1480*sec*1000);
 try{
  const data=await D.candles(c.context.r.exchange,x.symbol,interval,Math.floor(start),Math.floor(end));
  if(current!==c||version!==c.chartVersion||!container.isConnected)return;
  if(!data.bars.length){message.textContent='官方来源未返回此区间的 K 线；保留操作记录，不绘制假行情。';return;}
  if(!env.LightweightCharts)throw Error('chart_library_unavailable');
  const lib=env.LightweightCharts,chart=lib.createChart(container,{autoSize:true,height:360,layout:{background:{type:'solid',color:'#ffffff'},textColor:'#677589',attributionLogo:true,fontFamily:'system-ui, sans-serif',fontSize:11},grid:{vertLines:{color:'#f1f3f6'},horzLines:{color:'#f1f3f6'}},rightPriceScale:{borderColor:'#dfe5eb'},timeScale:{borderColor:'#dfe5eb',timeVisible:true},localization:{locale:'zh-CN'}}),series=chart.addSeries(lib.CandlestickSeries,{upColor:'#16a085',downColor:'#e25371',borderVisible:false,wickUpColor:'#16a085',wickDownColor:'#e25371'}),markers=lib.createSeriesMarkers(series,[]);
  c.chart=chart;const bars=data.bars;let cursor=bars.length,playing=false;
  const grouped=new Map();for(const e of x.events){const t=Math.floor(e.time/1000/sec)*sec;if(!bars.some(b=>b.time===t))continue;const key=t+'|'+e.side;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(e);}
  const allMarkers=[...grouped.values()].map(es=>({time:Math.floor(es[0].time/1000/sec)*sec,position:es[0].side==='buy'?'belowBar':'aboveBar',color:es[0].side==='buy'?'#138772':'#ce4764',shape:es[0].side==='buy'?'arrowUp':'arrowDown',text:(es[0].side==='buy'?'买':'卖')+(es.length>1?' ×'+es.length:'')})).sort((a,b)=>a.time-b.time);
  const play=btn('▶ 回放',()=>{if(playing){stop();return;}if(cursor>=bars.length)cursor=1;playing=true;play.textContent='Ⅱ 暂停';c.playTimer=setInterval(()=>{cursor=Math.min(bars.length,cursor+1);paint();if(cursor===bars.length)stop();},450);paint();}),step=btn('下一根',()=>{stop();cursor=Math.min(bars.length,cursor+1);paint();}),reset=btn('完整区间',()=>{stop();cursor=bars.length;paint();chart.timeScale().fitContent();}),range=el('input'),caption=el('span',undefined,'ta-playback-time');range.type='range';range.min='1';range.max=String(bars.length);range.setAttribute('aria-label','回放进度');range.oninput=()=>{stop();cursor=Number(range.value);paint();};playback.append(play,step,reset,range,caption);
  function stop(){playing=false;clearInterval(c.playTimer);c.playTimer=null;play.textContent='▶ 回放';}
  function paint(){series.setData(bars.slice(0,cursor));markers.setMarkers(allMarkers.filter(m=>m.time<=bars[cursor-1].time));range.value=String(cursor);caption.textContent=shortDate(bars[cursor-1].time*1000)+' · '+cursor+'/'+bars.length;}
  c.focusEvent=e=>{stop();let i=bars.findIndex(b=>b.time>=Math.floor(e.time/1000/sec)*sec);if(i<0)i=bars.length-1;cursor=i+1;paint();chart.timeScale().setVisibleLogicalRange({from:Math.max(0,i-18),to:i+6});};
  paint();chart.timeScale().fitContent();message.textContent=`${data.source} · ${x.symbol} · ${interval} · ${bars.length} 根真实 K 线 · 读取 ${date(data.fetchedAt)} · 图轴 UTC，操作表为北京时间`+(start>begin?' · 受单次 1500 根限制，左侧区间已裁剪':'');
 }catch(e){if(current===c&&version===c.chartVersion)message.textContent='K 线暂不可用（'+e.message+'）。已归档的操作仍可查看。';}
}
async function load(c,force=false){
 if(c.loading)return;c.loading=true;c.error=null;const before=c.events.map(x=>x.id).join('|'),r=c.context.r;syncStatus(c);
 try{
  if(r.exchange==='Binance'&&r.accountId==='5075281354358777856'){const data=await c.context.publicReader.read();if(current!==c)return;c.records=data;}
  else if(isHL(r)){const data=await D.fills(r.accountId,force);if(current!==c)return;c.history=data;}
  // Other exchanges retain their validated saved samples; no speculative requests.
 }catch(e){c.error=e.message;}
 finally{c.loading=false;if(current===c){rebuild(c);if(!c.paused){if(before!==c.events.map(x=>x.id).join('|'))draw(c);else syncStatus(c);}}}
}
function syncStatus(c){if(c.paused)return;const s=c.root.querySelector('.ta-status'),b=c.root.querySelector('.ta-toolbar button');if(s){s.textContent=status(c);s.title=c.error||'';}if(b){b.textContent=c.loading?'更新中…':'刷新记录';b.disabled=!!c.loading;}}
function render(root,context){
 const key=context.r.exchange+':'+context.r.accountId;
 if(!current||current.key!==key){dispose();current={key,root,context,events:[],cycles:[],expanded:new Set(),filter:'all',selected:null,chartVersion:0};
  current.records=context.r.accountId==='5075281354358777856'?context.publicReader?.last():null;current.history=isHL(context.r)?D.cached(context.r.accountId):null;
  if(context.r.accountId==='5075281354358777856'&&env.BooksAoyingHistory)current.officialHistory=env.BooksAoyingHistory;
  rebuild(current);draw(current);load(current);const owner=current;current.refreshTimer=setInterval(()=>{if(current===owner&&!owner.paused&&document.visibilityState!=='hidden'&&root.closest('dialog').open&&owner.context.tab!=='live')load(owner);},60000);return;
 }
 const changed=current.context.tab!==context.tab,updated=context.tab==='analysis'&&JSON.stringify(current.context.metrics)!==JSON.stringify(context.metrics);current.context=context;current.root=root;current.paused=false;rebuild(current);if(changed||updated||current.needsDraw||!root.firstChild){current.needsDraw=false;draw(current);root.closest('dialog').scrollTop=0;}
}
function dispose(){if(current){teardown(current);clearInterval(current.refreshTimer);}current=null;}
env.BooksTradeAnalysis={render,dispose,pause(){if(current){teardown(current);current.needsDraw=true;current.paused=true;current.root.classList.remove('trade-analysis');}}};
})(globalThis);
