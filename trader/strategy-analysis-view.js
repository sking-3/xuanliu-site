/* Unified, read-only account capital analysis. No secret or order APIs. */
(function(root){'use strict';
const labels={insufficient_history:'来源历史不足所选周期',older_source:'新响应的来源时间更早',insufficient_samples:'来源采样不足',unpaired_samples:'权益与盈亏时间未对齐',ledger_unavailable:'资金流水暂未取得',ledger_incomplete:'资金流水分页尚未完整返回',unknown_ledger_event:'存在尚未核实的资金事件',invalid_ledger_event:'资金事件格式待核',ambiguous_ledger_order:'资金事件与采样边界顺序不明',ledger_reconciliation_failed:'权益、盈亏与资金流水尚未对平',invalid_capital_basis:'区间资本不足以计算收益',snapshot_unverified:'账户来源尚未核验',storage_unavailable:'浏览器无法读取来源访问状态',http_403:'来源拒绝访问',http_429:'来源请求受限',cancelled:'读取已暂停',invalid_response:'来源数据格式异常'};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const fmt=(x,d=2)=>Number.isFinite(x)?x.toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d}):'—';
const signed=(x,d=2)=>(x>0?'+':'')+fmt(x,d);
const date=x=>x?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(x)):'—';
const tone=(n,x)=>{if(Number.isFinite(x))n.classList.add(x>=0?'positive':'negative');return n;};
const svg=(tag,attrs={})=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
function mount(host,row,period='30D'){
 let alive=true,client=null,cacheController=null,report=null,mode='strategyReturnPct',filter='all',page=1,serial=0;
 const section=el('section',undefined,'strategy-analysis'),heading=el('div',undefined,'sa-heading'),title=el('h3','收益与资金分析'),refresh=el('button','刷新分析','btn');refresh.type='button';
 heading.append(title,refresh);const periods=el('div',undefined,'sa-chart-nav sa-periods');periods.setAttribute('aria-label','全账户分析周期');
 for(const [key,label]of [['1D','近 1 日'],['7D','近 1 周'],['30D','近 1 月'],['90D','近 90 天'],['180D','近 180 天'],['365D','近 365 天'],['ALL','全部历史']]){const b=el('button',label,'btn');b.type='button';b.dataset.period=key;b.setAttribute('aria-pressed',String(period===key));b.addEventListener('click',()=>{if(period===key)return;period=key;report=null;page=1;body.replaceChildren();for(const button of periods.children)button.setAttribute('aria-pressed',String(button.dataset.period===period));load();});periods.append(b);}
 const status=el('p','正在读取官方权益、盈亏与资金流水…','sa-status');status.setAttribute('role','status');const body=el('div');section.append(heading,periods,status,body);host.append(section);
 function graph(){
  const box=el('div',undefined,'sa-chart'),nav=el('div',undefined,'sa-chart-nav');nav.setAttribute('aria-label','资金分析图表');
  for(const [key,label]of [['strategyReturnPct','策略收益'],['equity','余额对照'],['pnl','盈亏金额']]){const b=el('button',label,'btn');b.type='button';b.setAttribute('aria-pressed',String(mode===key));b.addEventListener('click',()=>{mode=key;render();});nav.append(b);}box.append(nav);
  const percent=mode==='strategyReturnPct',label=percent?'策略累计收益率 · 估算':mode==='equity'?'账户权益 · USD':'累计盈亏 · USD';box.append(el('h4',label));
  const points=report.points.filter(p=>Number.isFinite(p[mode]));
  if(points.length<2){box.append(el('p',percent?'资金流水核对完成后显示收益率曲线，可先切换余额或盈亏。':'此周期暂无可用曲线。','sa-status'));return box;}
  const chart=svg('svg',{viewBox:'0 0 960 310',role:'img','aria-label':label+'，'+points.length+' 个实际采样点'}),values=points.map(p=>p[mode]),lo=Math.min(...values),hi=Math.max(...values),span=Math.max(hi-lo,Math.abs(hi)*0.01,percent?1:0.01),min=lo-span*.08,max=hi+span*.08,t0=Date.parse(points[0].time),t1=Date.parse(points.at(-1).time);
  const x=p=>68+(Date.parse(p.time)-t0)/(t1-t0)*868,y=v=>268-(v-min)/(max-min)*246;
  for(let i=0;i<=4;i++){const value=min+(max-min)*i/4,yy=y(value);chart.append(svg('line',{x1:68,x2:936,y1:yy,y2:yy,class:'sa-grid'}));const text=svg('text',{x:60,y:yy+4,'text-anchor':'end'});text.textContent=fmt(value,Math.abs(value)>10000?0:2)+(percent?'%':'');chart.append(text);}
  const path=svg('path',{d:points.map((p,i)=>(i?'L':'M')+x(p).toFixed(2)+','+y(p[mode]).toFixed(2)).join(' '),class:'sa-line'});chart.append(path);
  const stride=Math.max(1,Math.ceil(points.length/500));
  points.forEach((p,i)=>{if(i%stride&&i!==points.length-1)return;const dot=svg('circle',{cx:x(p),cy:y(p[mode]),r:3,class:'sa-point'}),tip=svg('title');tip.textContent=date(p.time)+' · '+label+' '+fmt(p[mode])+(percent?'%':'');dot.append(tip);chart.append(dot);});
  for(const [p,anchor]of [[points[0],'start'],[points.at(-1),'end']]){const text=svg('text',{x:x(p),y:299,'text-anchor':anchor});text.textContent=date(p.time);chart.append(text);}box.append(chart);
  box.append(el('p',report.summary.sampleCount+' 个来源采样点 · 最长间隔 '+fmt(report.summary.maxGapMs/3600000,1)+' 小时 · '+date(report.summary.startAt)+' — '+date(report.summary.endAt),'sa-caption'));return box;
 }
 function flows(){
  const wrap=el('section',undefined,'sa-flows'),head=el('div',undefined,'sa-heading');head.append(el('h4','资金流水 · '+report.cashflows.length+' 笔'));
  const select=el('select');select.setAttribute('aria-label','资金流水类型');for(const [v,t]of [['all','全部资金事件'],['in','转入'],['out','转出']]){const o=el('option',t);o.value=v;o.selected=filter===v;select.append(o);}select.addEventListener('change',()=>{filter=select.value;page=1;render();});head.append(select);wrap.append(head);
  const selected=report.cashflows.filter(r=>filter==='all'||(filter==='in'?r.value>0:r.value<0)).slice().reverse(),total=Math.max(1,Math.ceil(selected.length/30));page=Math.min(page,total);
  if(!selected.length){wrap.append(el('p',report.summary.netFlow===null?'资金流水尚未核实。':'已返回的查询范围内没有符合筛选的资金事件。','sa-status'));return wrap;}
  const scroll=el('div',undefined,'sa-table-scroll'),table=el('table'),thead=el('thead'),tr=el('tr');for(const h of ['时间 · 北京','类型','资金流 · USD','来源费用','交易'])tr.append(el('th',h));thead.append(tr);table.append(thead);const tbody=el('tbody');
  for(const r of selected.slice((page-1)*30,page*30)){const tr=el('tr');tr.append(el('td',date(r.time)),el('td',(r.value>0?'转入':'转出')+' · '+r.type),tone(el('td',signed(r.value)),r.value),el('td',r.fee===null?'—':fmt(r.fee)+(r.feeToken?' '+r.feeToken:'')));const td=el('td'),a=el('a',r.hash.slice(0,8)+'…'+r.hash.slice(-6));a.href='https://app.hyperliquid.xyz/explorer/tx/'+r.hash;a.target='_blank';a.rel='noopener noreferrer';td.append(a);tr.append(td);tbody.append(tr);}table.append(tbody);scroll.append(table);wrap.append(scroll);
  if(total>1){const nav=el('div',undefined,'sa-chart-nav'),previous=el('button','上一页','btn'),next=el('button','下一页','btn');previous.disabled=page===1;next.disabled=page===total;previous.addEventListener('click',()=>{page--;render();});next.addEventListener('click',()=>{page++;render();});nav.append(previous,el('span',page+' / '+total),next);wrap.append(nav);}return wrap;
 }
 function render(){
  if(!alive||!report)return;const s=report.summary;body.replaceChildren();
  status.textContent='官方 Hyperliquid · 全账户权益（现货 + 合约） · 读取 '+date(report.fetchedAt)+(report.reason?' · '+(labels[report.reason]||'资金调整收益待核'):'')+(report.latestAttempt?' · 最新核验 '+date(report.latestAttempt.fetchedAt)+'：'+(labels[report.latestAttempt.reason]||'新分析待核')+'，保留上次已核准分析。':'');
  const metrics=el('dl',undefined,'sa-metrics');
  for(const [label,value,caption,n]of [['策略收益率 · 估算',Number.isFinite(s.strategyReturnPct)?signed(s.strategyReturnPct)+'%':'待核','按采样区间加权资金流计算',s.strategyReturnPct],['采样最大回撤 · 估算',Number.isFinite(s.sampledMddPct)?'-'+fmt(s.sampledMddPct)+'%':'待核','采用上方估算收益曲线',null],['策略盈亏 · USD',signed(s.pnl),'来源累计 PnL 的区间差值',s.pnl],['账户权益变化',Number.isFinite(s.balanceChangePct)?signed(s.balanceChangePct)+'%':'—',fmt(s.startEquity)+' → '+fmt(s.endEquity),s.balanceChangePct]]){const item=el('div');item.append(el('dt',label),tone(el('dd',value),n),el('small',caption));metrics.append(item);}body.append(metrics,graph());
  const breakdown=el('section',undefined,'sa-breakdown');breakdown.append(el('h4','余额变化分解'));const list=el('dl');
  for(const [label,value]of [['期初权益',s.startEquity],['资金转入',s.deposits],['资金转出',s.withdrawals===null?null:-s.withdrawals],['策略盈亏',s.pnl],['期末权益',s.endEquity]]){const line=el('div');line.append(el('dt',label),el('dd',fmt(value)));list.append(line);}breakdown.append(list,el('p','期初权益 + 转入 − 转出 + 来源盈亏 = 期末权益。资金流按账户实际增减额计，来源已计入的费用不重复扣减。','sa-caption'));body.append(breakdown,flows());
  const details=el('details'),summary=el('summary','计算口径与来源');details.append(summary,el('p','使用官方 portfolio 中全账户权益（现货 + 合约）的配对权益与盈亏采样，以及 userNonFundingLedgerUpdates 公开资金事件。策略收益逐采样区间使用 Modified Dietz，再连乘区间收益；采样间转账的时点权重为估算。逐区间资金核对误差超过 0.02 USD、资本无效或事件类型待核时，不计算调整后收益和回撤。采样可能漏过区间内波动。分页查至已返回尾部不代表交易所保留了全部历史，本区包含现货与合约，和默认永续持仓面板的范围不同。'));body.append(details);
 }
 async function load(force=false){
  if(!alive||document.hidden)return;const version=++serial;client?.destroy();cacheController?.abort();client=root.BooksStrategyAnalytics.create();refresh.disabled=true;status.textContent='正在核对官方权益、盈亏与资金流水…';
  try{
   if(!report){const cacheRequest=new AbortController();cacheController=cacheRequest;try{const response=await fetch('strategy/'+encodeURIComponent(row.accountId.toLowerCase())+'/'+encodeURIComponent(period)+'.json',{credentials:'omit',signal:cacheRequest.signal});if(response.ok){const saved=root.BooksStrategyAnalytics.validate(await response.json(),row.accountId,period);if(alive&&version===serial){report=saved;render();}}}catch(_){/* A missing saved report does not block the direct official read. */}finally{if(cacheController===cacheRequest)cacheController=null;}}
   if(!alive||version!==serial)return;
   // Same-origin source-state files load alongside the dialog. Wait for their
   // gate briefly, without issuing any exchange request while it is unverified.
   for(let i=0;i<20&&root.BooksSourcePolicy?.reason()==='snapshot_unverified';i++){if(!alive||version!==serial||document.hidden)return;await new Promise(resolve=>setTimeout(resolve,150));}
   if(!alive||version!==serial||document.hidden)return;
   const next=await client.request(row.accountId,period,{force:force===true});if(alive&&version===serial){report=root.BooksStrategyAnalytics.prefer(report,next);render();}
  }
  catch(error){if(alive&&version===serial){status.textContent=(report?'官方 Hyperliquid · 全账户权益（现货 + 合约） · 读取 '+date(report.fetchedAt)+' · ':'')+(labels[error.message]||'资金分析暂时读取失败')+(report?'，保留上次已读分析。':'，可稍后刷新。');}}
  finally{if(alive&&version===serial)refresh.disabled=false;}
 }
 const visibility=()=>{if(document.hidden){serial++;client?.destroy();cacheController?.abort();refresh.disabled=false;status.textContent='页面不可见，资金分析读取已暂停。';}else load();};
 document.addEventListener('visibilitychange',visibility);refresh.addEventListener('click',()=>load(true));load();
 return {destroy(){alive=false;serial++;client?.destroy();cacheController?.abort();document.removeEventListener('visibilitychange',visibility);section.remove();}};
}
root.BooksStrategyAnalysisView={mount};
})(globalThis);
