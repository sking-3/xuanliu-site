(function(){
'use strict';
const fetch=(path,init)=>window.BooksPublicMarket.fetch(path,init);
const R=window.BooksResearchModel,$=id=>document.getElementById(id);if(!R||!$('us-live-panel'))return;
const WATCH_KEY='books.stock.watchlist.v1',controllers=new Set(),waits=new Map();
const state={generation:0,active:false,mode:null,timer:null,radarTimer:null,symbols:[],clock:null,clockAt:0,credential:null,cacheKey:null,context:null,history:null,lastSave:0,rows:[],saveQueue:Promise.resolve()};
const minuteFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const finite=x=>typeof x==='number'&&Number.isFinite(x),validTime=x=>typeof x==='string'&&Number.isFinite(Date.parse(x)),iso=x=>new Date(x).toISOString();
const write=(id,value)=>{const node=$(id);if(node)node.textContent=value;};
const cancelled=()=>Object.assign(Error('本页读取已停止'),{name:'AbortError'});
function check(g){if(g!==state.generation||!state.active||document.hidden)throw cancelled();}
function controls(busy){for(const id of ['us-live-read','us-live-replay'])if($(id))$(id).disabled=busy;if($('stop-watch'))$('stop-watch').disabled=!busy;}
function stop(reason='本页美股监控已停止 · 无后台任务'){
 state.active=false;state.generation++;clearTimeout(state.timer);clearTimeout(state.radarTimer);state.timer=state.radarTimer=null;
 for(const c of controllers)c.abort();controllers.clear();for(const [timer,reject]of waits){clearTimeout(timer);reject(cancelled());}waits.clear();controls(false);
 if(reason){write('us-live-status',reason);write('watch-status',reason);}return false;
}
function pause(ms,g){check(g);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waits.delete(timer);try{check(g);resolve();}catch(e){reject(e);}},ms);waits.set(timer,reject);});}
function errorText(e){return ({research_auth_failed:'Alpaca 未接受此凭证，请核对 Paper Key／Secret 后重新连接',research_credentials_missing:'尚未连接Alpaca行情，请在上方输入本人的Key和Secret',research_live_feed_required:'当前行情权限不是IEX，请核对本人Alpaca权限后重新连接',research_permission_denied:'行情接口权限不足',research_source_stopped:'行情来源已有停止记录，请先核查权限或限流原因',research_transport_error:'行情来源连接失败或超时',research_schema:'行情字段未通过核验',research_wait:'来源预算持续繁忙，请稍后手动读取',research_end_too_recent:'来源尚未提供所需的完成分钟'}[e.code]||e.message||'读取未完成');}
async function api(path,value,g){
 check(g);const c=new AbortController();controllers.add(c);const timer=setTimeout(()=>c.abort(),25000);
 try{
  const response=await fetch('/api/research/'+path,{method:value===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:value===undefined?{}:{'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value),signal:c.signal});
  check(g);const result=await response.json();check(g);if(!response.ok)throw Object.assign(Error('本页行情读取未完成'),{code:result.error||'research_request_failed',waitMs:result.waitMs,reason:result.reason});return result;
 }catch(e){if(g!==state.generation||document.hidden)throw cancelled();if(e.code)throw e;throw Object.assign(Error('本页行情服务连接失败或超时'),{code:'research_transport_error'});}finally{clearTimeout(timer);controllers.delete(c);}
}
async function read(operation,params,g){
 for(let i=0;i<20;i++){check(g);try{return await api('read',{provider:'Alpaca',operation,params},g);}catch(e){if(e.code!=='research_wait')throw e;if(!finite(e.waitMs)||e.waitMs<=0||e.waitMs>60000)throw e;await pause(e.waitMs,g);}}
 throw Object.assign(Error('来源预算持续繁忙'),{code:'research_wait'});
}
function watchlist(){
 let list;try{list=JSON.parse(localStorage.getItem(WATCH_KEY)||'[]');}catch{throw Error('本机自选格式异常，请先在美股工作台核对自选');}
 if(!Array.isArray(list))throw Error('本机自选格式异常');const symbols=[...new Set(list.filter(x=>x?.market==='us').map(x=>x.symbol))];
 if(!symbols.length)throw Error('美股自选为空，请先在“我的美股自选”加入股票代码');
 if(symbols.length>30||symbols.some(s=>typeof s!=='string'||!/^[A-Z][A-Z0-9.-]{0,14}$/.test(s)))throw Error('美股自选须为最多30个有效代码，请先缩小或核对名单');return symbols;
}
function cacheScope(){
 const key=['iex',state.credential,state.symbols.join(','),R.localDay(Date.now(),'us')].join('|');
 if(state.cacheKey!==key){state.cacheKey=key;state.context=null;state.history=null;}return key;
}
async function permissions(g){
 const status=await api('status',undefined,g),account=status.providers?.find(x=>x.provider==='Alpaca'&&x.saved===true);
 if(!account)throw Object.assign(Error('尚未配置Alpaca行情API'),{code:'research_credentials_missing'});
 if(account.feed!=='iex')throw Object.assign(Error('实时监控仅支持IEX'),{code:'research_live_feed_required'});
 if(status.stops?.some(x=>typeof x.source==='string'&&(x.source==='research:Alpaca'||x.source.startsWith('research:Alpaca:'))))throw Object.assign(Error('Alpaca已有来源停止记录'),{code:'research_source_stopped'});
 const fingerprint=String(account.savedAt)+'|'+account.feed;if(state.credential!==fingerprint){state.credential=fingerprint;state.cacheKey=null;state.context=null;state.history=null;}cacheScope();
}
function clockText(){
 const c=state.clock;write('us-live-clock',c?(c.data.is_open?'常规交易中':'常规休市（盘前／盘后成交仍按原时间显示）')+' · 官方时钟 '+c.data.timestamp+' · 下次开市 '+c.data.next_open+' · 下次收市 '+c.data.next_close+' · 读取 '+c.receivedAt:'交易状态尚未读取');
}
function useClock(value){if(value?.provider!=='Alpaca'||value.feed!=='iex'||!validTime(value.receivedAt)||typeof value.data?.is_open!=='boolean'||!['timestamp','next_open','next_close'].every(k=>validTime(value.data[k])))throw Object.assign(Error('官方时钟字段异常'),{code:'research_schema'});state.clock=value;state.clockAt=Date.now();clockText();}
function rowsFromSnapshot(result){
 if(result.provider!=='Alpaca'||result.feed!=='iex'||!validTime(result.receivedAt)||!result.data||typeof result.data!=='object')throw Object.assign(Error('快照来源或时间异常'),{code:'research_schema'});
 return state.symbols.map(symbol=>{
  const x=result.data[symbol],trade=x?.latestTrade,minute=x?.minuteBar,q={market:'us',provider:'Alpaca',source:'Alpaca',feed:'iex',coverage:'single_exchange',symbol,currency:'USD',delaySeconds:0,kind:'latest_trade',receivedAt:result.receivedAt};
  if(trade&&finite(trade.p)&&trade.p>0&&validTime(trade.t)){q.price=trade.p;q.sourceTime=trade.t;}
  if(minute&&finite(minute.o)&&minute.o>0&&finite(minute.c)&&minute.c>0&&validTime(minute.t)){
   const change=minute.c/minute.o-1;if(finite(change)){q.priceChange1m=change;q.minuteSourceTime=minute.t;q.minuteStatus=Date.now()>=Date.parse(minute.t)+60000&&Date.parse(result.receivedAt)>=Date.parse(minute.t)+60000?'complete':'forming';}
  }
  return q;
 });
}
function renderRows(rows,replay=false){
 const body=$('us-live-quotes');body.replaceChildren();for(const q of rows){
  const row=document.createElement('tr'),old=validTime(q.sourceTime)&&Date.now()-Date.parse(q.sourceTime)>120000,future=validTime(q.sourceTime)&&Date.parse(q.sourceTime)>Date.now();
  const values=[q.symbol,finite(q.price)?q.price.toLocaleString('zh-CN',{maximumFractionDigits:6}):'—',replay?'历史分钟收盘（非实时）':'最新成交',q.sourceTime||'无成交样本',finite(q.priceChange1m)?(q.priceChange1m*100).toFixed(2)+'%':'—',q.minuteSourceTime|| (replay?q.sourceTime:'—'),!q.sourceTime?'无成交样本；不以买卖报价中点代替':replay?'历史复核':future?'来源时间晚于本机，时点待核':old?'历史成交；本次读取不代表新成交':q.minuteStatus==='forming'?'分钟尚未完成':Math.max(0,(Date.now()-Date.parse(q.sourceTime))/1000).toFixed(1)+' 秒前的成交'];
  for(const value of values){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}body.append(row);
 }
}
function observationKey(q){return [q.market,q.provider||q.source,q.feed,q.symbol,q.kind||'minute_bar',q.historical?q.date:'current'].join('|');}
async function persist(observations,alerts,g){
 const job=state.saveQueue.catch(()=>{}).then(async()=>{
  check(g);const previous=await api('result',undefined,g);if(!previous||previous.schema!=='books.stock.workspace.v1'||!Array.isArray(previous.observations)||!Array.isArray(previous.alerts))throw Error('本页研究结果格式异常，未覆盖原结果');
  const quotes=new Map(previous.observations.map(q=>[observationKey(q),q]));for(const q of observations){if(!q.sourceTime||!finite(q.price))continue;const key=observationKey(q),old=quotes.get(key);if(!old||Date.parse(q.sourceTime)>=Date.parse(old.sourceTime))quotes.set(key,q);}
  const events=new Map(previous.alerts.map(a=>[a.id,a]));for(const a of alerts){const old=events.get(a.id);if(!old||old.historical===true&&a.historical!==true)events.set(a.id,a);}
  previous.observations=[...quotes.values()].sort((a,b)=>Date.parse(b.sourceTime)-Date.parse(a.sourceTime)).slice(0,2000);previous.alerts=[...events.values()].sort((a,b)=>Date.parse(b.sourceTime)-Date.parse(a.sourceTime)).slice(0,500);
  // Preserve the completed daily markets and their original publication/source times.
  await api('result',previous,g);check(g);for(const host of document.querySelectorAll('[data-stock-workspace]'))host.booksWorkspace?.refresh()?.catch?.(()=>{});
 });state.saveQueue=job;return job;
}
async function quoteTick(g){
 const started=Date.now();try{
  check(g);const symbols=watchlist();if(symbols.join(',')!==state.symbols.join(','))throw Error('自选名单已变化，请重新启动以核对基线');cacheScope();
  const result=await read('snapshots',{symbols:state.symbols},g);state.rows=rowsFromSnapshot(result);renderRows(state.rows);
  if(!state.clock||Date.now()-state.clockAt>=30000){await permissions(g);useClock(await read('clock',{},g));}
  write('us-live-status',(state.mode==='monitor'?'本页监控中 · 5秒报价轮询':'本次行情已读取')+' · Alpaca / IEX 单交易所 · '+state.symbols.length+'个自选 · 读取 '+result.receivedAt);
  write('watch-status',state.mode==='monitor'?'本页美股监控中 · 5秒报价 / 60秒完成分钟 · 隐藏即停止':'本次美股行情已读取 · 未启用持续监控');
  if(!state.lastSave||Date.now()-state.lastSave>=30000){await persist(state.rows,[],g);state.lastSave=Date.now();}
  return true;
 }catch(e){if(g===state.generation&&e.name!=='AbortError')stop('美股读取已停止：'+errorText(e)+'。已读取的真实行情保留。');return false;
 }finally{if(state.active&&state.mode==='monitor'&&g===state.generation)state.timer=setTimeout(()=>quoteTick(g),Math.max(0,5000-(Date.now()-started)));}
}
function minuteOf(time){return minuteFormat.format(new Date(time));}
async function calendar(g){
 const key=cacheScope();if(state.context?.key===key)return state.context;
 const today=R.localDay(Date.now(),'us'),start=new Date(Date.parse(today+'T12:00:00Z')-140*86400000).toISOString().slice(0,10),response=await read('calendar',{start,end:today},g),completed=R.sessions(response,'us',Date.now());
 const context={key,today,completed,all:response.data.map(x=>({date:x.date,openTime:R.atMarket(x.date,x.open,'us'),closeTime:R.atMarket(x.date,x.close,'us')}))};
 check(g);if(cacheScope()!==key)throw cancelled();state.context=context;return context;
}
async function minutePages(symbols,start,end,g,onPage,budget){
 let token=null;const seen=new Set();for(let page=0;page<40;page++){
  if(budget.pages>=80)throw Error('本轮分钟读取超过80页上限，基线仍有缺口；已停止');budget.pages++;
  const result=await read('bars',{symbols,timeframe:'1Min',start,end,...(token?{pageToken:token}:{})},g);
  if(result.provider!=='Alpaca'||result.feed!=='iex'||!validTime(result.receivedAt)||!result.data?.bars||typeof result.data.bars!=='object')throw Error('分钟来源或字段异常，已停止');
  const bars={};for(const [symbol,rows]of Object.entries(result.data.bars)){
   if(!symbols.includes(symbol)||!Array.isArray(rows))throw Error('分钟代码或字段异常，已停止');bars[symbol]=[];
   for(const b of rows){const stamp=Date.parse(b.t);if(stamp===Date.parse(end))continue;if(!validTime(b.t)||stamp<Date.parse(start)||stamp>=Date.parse(end)||!['o','c','v','vw'].every(k=>finite(b[k]))||b.o<=0||b.c<=0||b.v<0||b.vw<0||!finite(b.v*b.vw))throw Error('分钟样本不完整，基线不足；已停止');bars[symbol].push({t:b.t,o:b.o,c:b.c,v:b.v,vw:b.vw});}
  }
  await onPage({provider:'Alpaca',feed:'iex',coverage:'single_exchange',receivedAt:result.receivedAt,data:{bars}});check(g);
  const next=result.data.next_page_token;if(next===null)return;if(typeof next!=='string'||!next||seen.has(next)||next===token)throw Error('分钟分页未前进，已停止');seen.add(next);token=next;
 }
 throw Error('分钟分页超过40页上限，已停止');
}
async function history(context,target,g,budget){
 const key=context.key+'|'+target.date;if(state.history?.key===key)return state.history;
 state.history=null;
 const days=context.completed.filter(x=>x.date<target.date).slice(-20);if(days.length<10)throw Error('基线不足：至少需要10个此前交易日');
 const result={key,days:days.length,symbols:new Map(state.symbols.map(s=>[s,[]]))};
 for(let i=0;i<days.length;i++){
  check(g);write('us-live-note','首次补齐IEX常规时段同刻基线 '+(i+1)+' / '+days.length+' 个交易日 · '+days[i].date+'。最新成交快照独立更新。');
  await minutePages(state.symbols,days[i].openTime,days[i].closeTime,g,p=>{for(const symbol of state.symbols){const bars=p.data.bars[symbol];if(bars?.length)result.symbols.get(symbol).push({receivedAt:p.receivedAt,bars});}},budget);
 }
 check(g);if(cacheScope()!==context.key)throw cancelled();state.history=result;return result;
}
async function scan(base,pages,g,replayDate){
 const now=Date.now(),observations=[],events=[];let enough=0;
 for(const symbol of state.symbols){
  check(g);const current=pages.filter(p=>p.data.bars[symbol]?.length).map(p=>({...p,data:{bars:{[symbol]:p.data.bars[symbol]}}})),needed=new Set(current.flatMap(p=>p.data.bars[symbol].map(b=>minuteOf(b.t)))),prior=[];
  for(const p of base.symbols.get(symbol)||[]){const bars=p.bars.filter(b=>needed.has(minuteOf(b.t)));if(bars.length)prior.push({provider:'Alpaca',feed:'iex',coverage:'single_exchange',receivedAt:p.receivedAt,data:{bars:{[symbol]:bars}}});}
  const output=R.observations([...prior,...current],'us',now,replayDate?{replayDate}:{});
  for(const q of output.observations){q.kind='minute_bar';if(replayDate){q.historical=true;q.detectedAt=iso(now);}observations.push(q);const dates=new Set(prior.flatMap(p=>p.data.bars[symbol].filter(b=>minuteOf(b.t)===q.minute&&b.v*b.vw>0).map(b=>R.localDay(b.t,'us'))));if(dates.size>=10)enough++;}
  events.push(...output.alerts);if(events.length>500)events.sort((a,b)=>Date.parse(b.sourceTime)-Date.parse(a.sourceTime)).splice(500);await Promise.resolve();
 }
 return {observations,alerts:events,enough};
}
async function radarTick(g){
 try{
  const context=await calendar(g),target=context.all.find(x=>x.date===context.today),time=Date.now();
  if(!target||time<Date.parse(target.openTime)||time>=Date.parse(target.closeTime)){write('us-live-note','常规休市：最新成交保留来源时间；盘前／盘后尚无对应时段基线，不判放量。可手动“复核最近交易日”，历史结果会明确标记。');return;}
  const budget={pages:0},base=await history(context,target,g,budget),end=iso(Date.now()-60000),start=iso(Math.max(Date.parse(target.openTime),Date.now()-180000));if(Date.parse(start)>=Date.parse(end)){write('us-live-note','开市后尚无满足时间门槛的完成分钟，基线与报价分开保存。');return;}
  const pages=[];await minutePages(state.symbols,start,end,g,p=>pages.push(p),budget);const output=await scan(base,pages,g);await persist(output.observations,output.alerts,g);
  write('us-live-note','IEX常规时段完成分钟已核对 · '+output.observations.length+'个标的 · '+output.enough+'个具备至少10日同分钟基线 · '+output.alerts.length+'条本次异动。其余基线不足，不补造放量；行情时间以表格和雷达原始时间为准。');
 }catch(e){if(g===state.generation&&e.name!=='AbortError')stop('美股分钟监控已停止：'+errorText(e)+'。基线不足时仍保留已读取的真实报价。');
 }finally{if(state.active&&state.mode==='monitor'&&g===state.generation)state.radarTimer=setTimeout(()=>radarTick(g),60000);}
}
async function replay(g){
 useClock(await read('clock',{},g));const context=await calendar(g),target=context.completed.filter(x=>Date.parse(x.closeTime)<=Date.now()-60000).at(-1);if(!target)throw Error('尚无可读取的已完成交易日');
 const budget={pages:0},base=await history(context,target,g,budget),pages=[];write('us-live-note','读取 '+target.date+' 真实常规时段分钟，复核结果不是实时信号。');await minutePages(state.symbols,target.openTime,target.closeTime,g,p=>pages.push(p),budget);
 const output=await scan(base,pages,g,target.date);await persist(output.observations,output.alerts,g);renderRows(output.observations.map(q=>({...q,minuteSourceTime:q.sourceTime})),true);
 write('us-live-status','历史复核完成 · '+target.date+' · IEX 单交易所 · 非实时监控');write('us-live-note','已复核 '+output.observations.length+' 个自选、'+output.alerts.length+' 条历史异动；detectedAt记录本次实际复核时间，行情sourceTime保留历史原值。基线不足的分钟不生成放量结论；下方雷达可查看历史记录。');
}
async function start(mode='monitor'){
 if(!['monitor','once','replay'].includes(mode))return false;if($('run-a')?.disabled||$('run-us')?.disabled){write('us-live-status','收盘批次正在读取，请完成或停止后再启动美股监控');return false;}
 // Preserve and stop the incumbent A-share handler before taking over the shared control.
 window.BooksBrokerLive?.stop('已选择原IEX来源');window.BooksStopLegacyWatch?.();stop('');state.mode=mode;state.active=true;state.lastSave=0;const g=state.generation;controls(true);
 try{
  state.symbols=watchlist();await permissions(g);check(g);
  if(mode==='replay')await replay(g);else{if(!await quoteTick(g))return false;if(mode==='monitor')void radarTick(g);}
  if(mode!=='monitor'){state.active=false;controls(false);}return true;
 }catch(e){if(g===state.generation&&e.name!=='AbortError')stop('美股读取已停止：'+errorText(e)+'。未启用后台或实盘。');return false;}
}
function credentialsChanged(){stop('行情凭证发生变更，请重新读取以核对IEX权限');state.credential=state.cacheKey=state.context=state.history=state.clock=null;state.clockAt=0;state.rows=[];state.lastSave=0;}
window.BooksUsLive={start:()=>start('monitor'),stop,credentialsChanged};
$('us-live-read').onclick=()=>start('once');$('us-live-replay').onclick=()=>start('replay');if($('watch-us'))$('watch-us').onclick=()=>start('monitor');
$('stop-watch')?.addEventListener('click',()=>stop());for(const id of ['run-a','run-us','watch-a'])$(id)?.addEventListener('click',()=>stop(),true);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('页面已隐藏，美股监控已停止 · 返回后需手动启动');});window.addEventListener('pagehide',()=>stop('页面已离开，美股监控已停止'));
window.addEventListener('storage',e=>{if(e.key===WATCH_KEY){state.cacheKey=state.context=state.history=null;if(state.active)stop('自选名单已变化，请重新启动以核对基线');}});
})();
