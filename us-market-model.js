/* Calculations use actual vendor exports; no sample securities are seeded. */
(function(root,factory){const a=factory();if(typeof module==='object'&&module.exports)module.exports=a;else root.BooksResearchModel=a;})(globalThis,function(){
'use strict';
const finite=v=>typeof v==='number'&&Number.isFinite(v),mean=x=>x.reduce((s,v)=>s+v,0)/x.length;
const US_RULES_VERSION='books.stock.us.causal.v2';
const table=r=>{const {fields,items}=r.data;if(!Array.isArray(fields)||!Array.isArray(items))throw Error('供应商表格格式错误');return items.map(x=>Object.fromEntries(fields.map((k,i)=>[k,x[i]])));};
const isoDay=s=>s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8),num=x=>x===null||x===''?NaN:Number(x);
const localFormatters=Object.fromEntries(['Asia/Shanghai','America/New_York'].map(timeZone=>[timeZone,new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})]));
function localParts(time,market){return Object.fromEntries(localFormatters[market==='a'?'Asia/Shanghai':'America/New_York'].formatToParts(new Date(time)).map(x=>[x.type,x.value]));}
function localDay(time,market){const p=localParts(time,market);return p.year+'-'+p.month+'-'+p.day;}
function atMarket(day,clock,market){let t=Date.parse(day+'T'+clock+':00Z');for(let i=0;i<3;i++){const p=localParts(t,market),asUTC=Date.parse(p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':00Z');t+=Date.parse(day+'T'+clock+':00Z')-asUTC;}return new Date(t).toISOString();}
// Scheduled core-session evidence only; security halts/eligibility remain separate.
const US_CALENDAR_2026={version:'nyse-core-2026-2026-11-13',source:'https://www.nyse.com/trade/hours-calendars',verifiedAt:'2026-11-13',holidays:new Set(['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25']),early:new Set(['2026-11-27','2026-12-24'])};
function validDay(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function validTime(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&validDay(value.slice(0,10))&&Number.isFinite(Date.parse(value));}
function usCoreSession(date){
 if(!validDay(date)||!date.startsWith('2026-'))return null;
 const weekday=new Date(date+'T00:00:00Z').getUTCDay();if(weekday===0||weekday===6||US_CALENDAR_2026.holidays.has(date))return null;
 return {date,openTime:atMarket(date,'09:30','us'),closeTime:atMarket(date,US_CALENDAR_2026.early.has(date)?'13:00':'16:00','us'),calendarVerified:true,calendarSource:US_CALENDAR_2026.source,calendarVersion:US_CALENDAR_2026.version,calendarVerifiedAt:US_CALENDAR_2026.verifiedAt,scope:'scheduled_core_session'};
}
function knownUsDates(dates){
 if(!dates.every(d=>d.startsWith('2026-')))return null;
 const expected=[];for(let t=Date.parse(dates[0]+'T00:00:00Z');t<=Date.parse(dates.at(-1)+'T00:00:00Z');t+=86400000){const d=new Date(t).toISOString().slice(0,10);if(usCoreSession(d))expected.push(d);}
 return JSON.stringify(expected)===JSON.stringify(dates);
}
function orderedDates(dates){return Array.isArray(dates)&&dates.length>=61&&dates.every((d,i)=>validDay(d)&&(!i||d>dates[i-1]));}
function sessionEvidence(values){
 const last=values.at(-1)||{};return {date:last.date||null,...(validTime(last.openTime)?{openTime:last.openTime}:{}),closeTime:validTime(last.closeTime)?last.closeTime:null,calendarVerified:values.length>=61&&values.every(x=>x.calendarVerified===true),tradingDates:values.map(x=>x.date),calendarSource:last.calendarSource||null,calendarVersion:last.calendarVersion||null,calendarVerifiedAt:last.calendarVerifiedAt||null,scope:'scheduled_core_session'};
}
function sessions(response,market,now=Date.now()){
 if(!['a','us'].includes(market)||!finite(now))throw Error('交易日历市场或核验时间异常');
 const values=market==='a'?table(response).filter(x=>String(x.is_open)==='1').map(x=>({date:isoDay(x.cal_date),close:'15:00'})):response.data;
 if(!Array.isArray(values)||values.some(x=>!validDay(x.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.close)))throw Error('交易日历日期或收盘时间异常');
 const verified=response.provider===(market==='a'?'Tushare':'Alpaca')&&response.operation==='calendar'&&response.data.truncated!==true&&validTime(response.receivedAt)&&Date.parse(response.receivedAt)<=now;
 const rows=values.map(x=>({date:x.date,...(market==='us'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(x.open)?{openTime:atMarket(x.date,x.open,market)}:{}),closeTime:atMarket(x.date,x.close,market),calendarVerified:verified,calendarSource:market==='a'?'Tushare trade_cal + SSE/SZSE regular close':'Alpaca /v2/calendar',calendarVerifiedAt:validTime(response.receivedAt)?response.receivedAt:null,scope:'scheduled_core_session'}));
 if(market==='us')for(const item of rows){const scheduled=usCoreSession(item.date);if(item.date.startsWith('2026-')&&(!scheduled||Date.parse(scheduled.closeTime)!==Date.parse(item.closeTime)))throw Error('交易日历收盘时间或开市日与已核验时段冲突');}
 const result=rows.filter(x=>Date.parse(x.closeTime)<=now).sort((a,b)=>a.date.localeCompare(b.date));
 if(!orderedDates(result.map(x=>x.date)))throw Error('交易日历不足、异常或重复');
 const selected=result.slice(-61);if(market==='us'&&knownUsDates(selected.map(x=>x.date))===false)throw Error('交易日历缺少已核验交易日或包含休市日');
 return selected;
}
function benchmarkMap(benchmark,dates){
 if(!Array.isArray(benchmark))throw Error('基准行情格式异常');const ref=new Map();
 for(const b of benchmark){if(!b||typeof b!=='object'||!validDay(b.date)||!dates.includes(b.date)||!finite(b.close)||b.close<=0||ref.has(b.date))throw Error('基准行情日期、价格或重复记录异常');ref.set(b.date,b.close);}
 return ref;
}
function dayMetrics(bars,benchmark,dates){
 if(!orderedDates(dates)||!Array.isArray(bars)||bars.length!==dates.length||JSON.stringify(bars.map(x=>x.date))!==JSON.stringify(dates))throw Error('连续交易日日线不足、日期异常或存在额外记录');
 for(const b of bars)if(!['open','high','low','close','volume','turnover'].every(k=>finite(b[k]))||Math.min(b.open,b.high,b.low,b.close)<=0||Math.min(b.volume,b.turnover)<0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close))throw Error('日线字段异常');
 const a=bars.at(-1),p=bars.at(-2),v=mean(bars.slice(-21,-1).map(x=>x.volume)),ma20=mean(bars.slice(-20).map(x=>x.close)),ma50=mean(bars.slice(-50).map(x=>x.close));if(v<=0)throw Error('历史成交量不足');
 const ref=benchmarkMap(benchmark,dates),excess=ref.has(dates.at(-1))&&ref.has(dates.at(-21))?a.close/bars.at(-21).close-ref.get(dates.at(-1))/ref.get(dates.at(-21)):null;
 return {close:a.close,rvol:a.volume/v,ma20,ma50,ma50_up:ma50>mean(bars.slice(-51,-1).map(x=>x.close)),high20:Math.max(...bars.slice(-21,-1).map(x=>x.high)),gap:a.open/p.close-1,dayret:a.close/p.close-1,turnover:mean(bars.slice(-20).map(x=>x.turnover)),excess};
}
function causalUsEvent(security,session,asOf,received,now){
 const event=security.event;if(!event||event.symbol!==security.symbol||!['earnings','guidance'].includes(event.kind)||event.officialVerified!==true||!['sec','issuer'].includes(event.sourceType)||typeof event.sourceUrl!=='string'||!/^https:\/\/[^/\\]/i.test(event.sourceUrl)||/[\u0000-\u0020\u007f\\]/.test(event.sourceUrl))return false;
 // Official attribution is supplied evidence, not inferred from a URL or fetched here.
 try{const url=new URL(event.sourceUrl);if(url.protocol!=='https:'||!url.hostname||url.username||url.password)return false;}catch{return false;}
 if(![session.openTime,event.publishedAt,event.firstSeenAt,event.receivedAt].every(validTime))return false;
 const open=Date.parse(session.openTime),published=Date.parse(event.publishedAt),firstSeen=Date.parse(event.firstSeenAt),eventReceived=Date.parse(event.receivedAt);
 return localDay(open,'us')===asOf&&open<Date.parse(session.closeTime)&&published<open&&published<=firstSeen&&firstSeen<=eventReceived&&eventReceived<=received&&received<=now;
}
function screen(raw,now=Date.now()){
 if(!finite(now)||!['a','us'].includes(raw?.market))throw Error('分析市场或核验时间异常');
 const {market,asOf,dates,securities,benchmark=[],source}=raw,rows=[],session=raw.session||{},issues=[];
 const datesValid=orderedDates(dates)&&validDay(asOf)&&dates.at(-1)===asOf&&asOf<=localDay(now,market)&&(market!=='us'||knownUsDates(dates)!==false);
 if(!datesValid)issues.push('trading_dates_invalid_or_future');
 const received=validTime(source?.receivedAt)?Date.parse(source.receivedAt):NaN;
 const close=validTime(session.closeTime)?Date.parse(session.closeTime):NaN;
 const sameDates=JSON.stringify(session.tradingDates)===JSON.stringify(dates);
 let calendarVerified=datesValid&&session.calendarVerified===true&&session.date===asOf&&sameDates&&finite(close)&&localDay(close,market)===asOf;
 if(market==='us'&&usCoreSession(asOf)&&close!==Date.parse(usCoreSession(asOf).closeTime))calendarVerified=false;
 const closeVerified=calendarVerified&&close<=now&&finite(received)&&received>=close&&received<=now;
 if(!closeVerified)issues.push('complete_close_or_calendar_unverified');
 let benchmarkValid=true;try{benchmarkMap(benchmark,dates||[]);}catch{benchmarkValid=false;issues.push('benchmark_invalid_or_duplicate');}
 const complete=datesValid&&closeVerified&&benchmarkValid&&source.coverage==='full_universe'&&source.paginationComplete===true&&source.permissionsVerified===true&&source.dataAsOf===asOf&&source.expectedCount>0&&source.expectedCount===securities.length&&(market==='a'||source.feed==='sip');
 for(const s of securities){const e=s.eligibility||{},excluded=e.excluded===true,qualified=e.qualified===true;const r={symbol:s.symbol,name:String(s.name||s.symbol).slice(0,120),exchange:s.exchange,status:excluded?'excluded':'pending',qualification:excluded?'excluded':qualified?'qualified':'pending',hits:[],pending:market==='a'?['M1','M2','M3','M4','M5']:[],reasons:[...(e.reasons||[])],close:null,currency:market==='a'?'CNY':'USD',asOf,metrics:null,bars:[]};rows.push(r);if(market==='us')r.eligibleHits=[];if(excluded)continue;
  r.reasons.push(...issues);
  if(!closeVerified)continue;
  const latest=s.bars?.at(-1);if(validDay(asOf)&&asOf<=localDay(now,market)&&finite(received)&&received<=now&&latest?.date===asOf&&finite(latest.close)&&latest.close>0)r.close=latest.close;
  try{if(!datesValid)throw Error('连续交易日日期无效或超前');if(!s.adjustmentVerified)throw Error('复权待核');const m=dayMetrics(s.bars,benchmark,dates);if(market==='us'&&!Object.values(m).every(v=>v===null||typeof v==='boolean'||finite(v))){r.close=null;throw Error('derived_metrics_invalid');}r.close=m.close;r.metrics=m;
   if(market==='a'){r.reasons.push('five_mode_definitions_pending');continue;}
   const eligible=[];
   if(m.close<5||m.turnover<10000000){r.status='excluded';r.reasons.push('price_or_liquidity_below_threshold');continue;}
   if(m.gap>=.04&&m.rvol>=2&&m.dayret>0){r.hits.push('U1');if(causalUsEvent(s,session,asOf,received,now))eligible.push('U1');else{r.pending.push('U1');r.reasons.push('event_catalyst_requires_evidence');}}
   const trend=m.close>m.ma20&&m.ma20>m.ma50&&m.ma50_up&&m.excess!==null&&m.excess>0;if(trend&&m.close/m.ma20-1<=.15){if(m.close>m.high20&&m.rvol>=1.5){r.hits.push('U2');eligible.push('U2');}if(m.close/m.high20>=.97&&m.close/m.high20<=1){r.hits.push('U3');r.pending.push('U3');r.reasons.push('near_breakout_watch_only');}}
   if(m.excess===null)r.reasons.push('same_date_spy_benchmark_missing');if(!complete)r.reasons.push('batch_coverage_or_close_unverified');if(complete&&qualified){r.eligibleHits=eligible;r.status=eligible.length?'candidate':r.pending.length?'pending':'unmatched';}r.bars=r.hits.length?s.bars.slice(-8):[];
  }catch(err){r.reasons.push(err.message);}
 }
 return {status:complete?'ready':'partial',asOf,completeUniverse:complete,source,...(market==='us'?{rulesVersion:US_RULES_VERSION}:{}),session:{date:validDay(session.date)?session.date:null,...(market==='us'?{openTime:validTime(session.openTime)?session.openTime:null}:{}),closeTime:validTime(session.closeTime)?session.closeTime:null,calendarVerified,calendarSource:typeof session.calendarSource==='string'?session.calendarSource.slice(0,300):null,calendarVersion:typeof session.calendarVersion==='string'?session.calendarVersion.slice(0,80):null,calendarVerifiedAt:validDay(session.calendarVerifiedAt)||validTime(session.calendarVerifiedAt)?session.calendarVerifiedAt:null,scope:'scheduled_core_session',completeCloseVerified:closeVerified},parameters:{min_price:5,min_turnover:10000000,event_gap:.04,event_volume:2,break_volume:1.5,max_extension:.15,near_high:.03},rows};
}
function assembleA(parts){
 const dates=parts.sessions.map(x=>x.date),asOf=dates.at(-1),daily=new Map(),factor=new Map();for(const p of parts.daily)for(const r of table(p)){const key=r.ts_code+'|'+isoDay(r.trade_date);if(daily.has(key))throw Error('重复日线');daily.set(key,r);}for(const p of parts.factors)for(const r of table(p)){const key=r.ts_code+'|'+isoDay(r.trade_date);if(factor.has(key))throw Error('重复复权因子');factor.set(key,num(r.adj_factor));}
 const limit=parts.limits?new Map(table(parts.limits).filter(x=>isoDay(x.trade_date)===asOf).map(x=>[x.ts_code,x])):null,st=parts.st&&!parts.st.data.truncated&&table(parts.st).length>0?new Set(table(parts.st).map(x=>x.ts_code)):null,suspend=parts.suspensions&&!parts.suspensions.data.truncated?new Set(table(parts.suspensions).filter(x=>x.suspend_type==='S').map(x=>x.ts_code)):null;
 const universe=table(parts.universe).filter(x=>['SSE','SZSE'].includes(x.exchange)),seen=new Set();if(!universe.length)throw Error('证券目录为空');const securities=universe.map(x=>{if(seen.has(x.ts_code))throw Error('重复证券目录');seen.add(x.ts_code);let excluded=false,qualified=false;const reasons=[],a=daily.get(x.ts_code+'|'+asOf),lim=limit?.get(x.ts_code),anchor=factor.get(x.ts_code+'|'+asOf),bars=[];
  if(x.market!=='主板'||!/^(60[0135]\d{3}\.SH|00[0123]\d{3}\.SZ)$/.test(x.ts_code)){excluded=true;reasons.push('非沪深主板A股普通股');}
  if(st?.has(x.ts_code)||/ST|退/.test(x.name||'')){excluded=true;reasons.push('已证ST、风险警示或退市名称');}
  if(suspend?.has(x.ts_code)){excluded=true;reasons.push('当日存在停牌记录');}
  const pre=num(lim?.pre_close),normal=pre>0&&Math.abs(num(lim?.up_limit)-Math.round(pre*110)/100)<=.011&&Math.abs(num(lim?.down_limit)-Math.round(pre*90)/100)<=.011;
  if(!st||!suspend||!lim||!a||!normal||isoDay(x.list_date||'99991231')>asOf)reasons.push('normal_10pct_eligibility_unverified');else qualified=!excluded;
  for(const d of dates){const v=daily.get(x.ts_code+'|'+d),f=factor.get(x.ts_code+'|'+d);if(v&&anchor>0&&f>0)bars.push({date:d,open:num(v.open)*f/anchor,high:num(v.high)*f/anchor,low:num(v.low)*f/anchor,close:num(v.close)*f/anchor,volume:num(v.vol)*100,turnover:num(v.amount)*1000});}
  return {symbol:x.ts_code,name:x.name,exchange:x.exchange,eligibility:{excluded,qualified,reasons},adjustmentVerified:bars.length===dates.length,bars};});
 const receivedAt=parts.daily.at(-1).receivedAt;return {market:'a',asOf,dates,session:sessionEvidence(parts.sessions),securities,source:{id:'tushare',name:'Tushare Pro · 个人研究',dataAsOf:asOf,receivedAt,coverage:localDay(parts.universe.receivedAt,'a')!==asOf?'current_directory':universe.length>=6000||parts.universe.data.truncated||parts.daily.some(p=>p.data.truncated)?'partial':'full_universe',expectedCount:universe.length,paginationComplete:universe.length<6000&&!parts.universe.data.truncated&&!parts.daily.some(p=>p.data.truncated),permissionsVerified:true,redistributionAllowed:false,accessScope:'personal',feed:'tushare'}};
}
function assembleUS(parts){
 const dates=parts.sessions.map(x=>x.date),asOf=dates.at(-1),bars=new Map(),seen=new Set();for(const p of parts.pages)for(const [symbol,rows]of Object.entries(p.data.bars))for(const b of rows){const key=symbol+'|'+b.t;if(seen.has(key))throw Error('重复分页日线');seen.add(key);if(!bars.has(symbol))bars.set(symbol,[]);bars.get(symbol).push({date:localDay(b.t,'us'),open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v,turnover:b.v*b.vw});}
 for(const b of bars.values())b.sort((a,b)=>a.date.localeCompare(b.date));const universe=parts.universe.data;if(!universe.length)throw Error('证券目录为空');const receivedAt=parts.pages.at(-1).receivedAt,feed=parts.pages[0].feed==='sip_delayed'?'sip':'iex',metadataDay=localDay(parts.universe.receivedAt,'us');
 const securities=universe.map(x=>{const name=x.name||x.symbol,ordinary=/common (stock|shares)|ordinary shares/i.test(name)&&!/preferred|warrant|depositary|\bETF\b|\bunits?\b|\bfund\b/i.test(name),qualified=ordinary&&['NYSE','NASDAQ','AMEX'].includes(x.exchange)&&x.status==='active'&&x.tradable===true&&metadataDay===asOf;return {symbol:x.symbol,name,exchange:x.exchange,eligibility:{excluded:x.status!=='active'||/preferred|warrant|\bETF\b/i.test(name),qualified,reasons:qualified?[]:['us_security_type_unverified','证券目录为当前在市快照，非历史时点目录']},adjustmentVerified:true,bars:bars.get(x.symbol)||[]};});
 return {market:'us',asOf,dates,session:sessionEvidence(parts.sessions),securities,benchmark:bars.get('SPY')||[],source:{id:'alpaca',name:'Alpaca · '+(feed==='sip'?'SIP（延迟历史）':'IEX 单交易所')+' · 个人研究',dataAsOf:asOf,receivedAt,coverage:metadataDay===asOf?'full_universe':'current_directory',expectedCount:universe.length,paginationComplete:parts.complete===true,permissionsVerified:true,redistributionAllowed:false,accessScope:'personal',feed,delaySeconds:feed==='sip'?960:0}};
}
function massiveBenchmarkRows(response){
 if(response?.data?.paginationComplete!==true||!Array.isArray(response.data.results))throw Error('SPY实际日线分页未完成或格式异常');
 const rows=response.data.results.map(b=>{if(!b||!finite(b.t)||!finite(new Date(b.t).getTime())||!finite(b.c)||b.c<=0)throw Error('SPY实际日线日期或收盘价异常');return {date:localDay(b.t,'us'),close:b.c};}).sort((a,b)=>a.date.localeCompare(b.date));
 if(!orderedDates(rows.map(x=>x.date)))throw Error('SPY实际日线日期不足、异常或重复');
 return rows;
}
function massiveSessions(response){
 const dates=massiveBenchmarkRows(response).map(x=>x.date);
 const selected=dates.slice(-61);if(knownUsDates(selected)===false)throw Error('SPY实际日线日期缺少已核验交易日或包含休市日');
 return selected.map(date=>usCoreSession(date)||{date,closeTime:null,calendarVerified:false,calendarSource:'Massive SPY daily bar dates; scheduled close unverified',scope:'scheduled_core_session'});
}
function assembleMassive(parts){
 const dates=parts.sessions.map(x=>x.date),asOf=dates.at(-1),bars=new Map();for(const p of parts.daily){for(const b of p.data.results){const date=localDay(b.t,'us');if(!dates.includes(date))throw Error('日线日期不在批次范围');if(!bars.has(b.T))bars.set(b.T,[]);if(bars.get(b.T).some(x=>x.date===date))throw Error('重复日线');bars.get(b.T).push({date,open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v,turnover:finite(b.vw)?b.v*b.vw:NaN});}}
 for(const rows of bars.values())rows.sort((a,b)=>a.date.localeCompare(b.date));const directory=parts.universe.flatMap(p=>p.data.results);if(!directory.length||new Set(directory.map(x=>x.ticker)).size!==directory.length)throw Error('证券目录为空或分页重复');
 const securities=directory.map(x=>{const supported=['XNYS','XNAS','XASE'].includes(x.primary_exchange),ordinary=x.type==='CS'&&x.market==='stocks'&&x.locale==='us',qualified=supported&&ordinary&&x.active===true&&x.currency_name?.toLowerCase()==='usd';return {symbol:x.ticker,name:x.name||x.ticker,exchange:({XNYS:'NYSE',XNAS:'NASDAQ',XASE:'AMEX'}[x.primary_exchange]||x.primary_exchange||'待核'),adjustmentVerified:true,bars:bars.get(x.ticker)||[],eligibility:{excluded:!supported||!ordinary||x.active===false,qualified,reasons:qualified?[]:['us_security_type_unverified']}};});
 const benchmark=massiveBenchmarkRows(parts.benchmark).filter(b=>dates.includes(b.date));if(benchmark.length!==dates.length)throw Error('SPY实际日线批次日期不完整');return {market:'us',asOf,dates,session:sessionEvidence(parts.sessions),securities,benchmark,source:{id:'massive',name:'Massive Stocks Basic · 全市场日终 · 拆股复权 · 个人研究',dataAsOf:asOf,receivedAt:parts.daily.at(-1)?.receivedAt||parts.benchmark.receivedAt,coverage:'full_universe',expectedCount:directory.length,paginationComplete:parts.complete===true&&parts.universe.at(-1).data.nextCursor===null&&parts.daily.length===dates.length&&parts.daily.every(p=>p.data.paginationComplete),permissionsVerified:true,redistributionAllowed:false,accessScope:'personal',feed:'sip',recency:'end_of_day',sessionCalendar:'SPY实际日线交易日期',releaseTime:'after 00:00 America/New_York (previous calendar day)',delaySeconds:null}};
}
function observations(pages,market,now=Date.now(),options={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='replayDate'))throw Error('历史复核参数异常');
 const replayDate=Object.hasOwn(options,'replayDate')?options.replayDate:null;
 if(Object.hasOwn(options,'replayDate')&&(market!=='us'||!finite(now)||!validDay(replayDate)||replayDate>localDay(now,'us')||!usCoreSession(replayDate)?.calendarVerified))throw Error('历史复核日期须为已核验且非未来的美股交易日');
 const all=[];for(const p of pages){
  const provider=p.provider||(market==='a'?'Tushare':'Alpaca'),feed=typeof p.feed==='string'&&p.feed.trim()?p.feed:market==='a'?'tushare':null,coverage=typeof p.coverage==='string'?p.coverage:feed==='iex'?'single_exchange':['sip','sip_delayed'].includes(feed)?'consolidated':market==='a'?'watchlist':'unverified';
  const meta={provider,feed,coverage,receivedAt:p.receivedAt,delaySeconds:finite(p.delaySeconds)&&p.delaySeconds>=0?p.delaySeconds:feed==='sip_delayed'?960:0};
  if(market==='a')for(const r of table(p)){const t=r.time||r.trade_time,stamp=t.includes('T')?t:t.replace(' ','T')+'+08:00';all.push({...meta,symbol:r.ts_code,sourceTime:stamp,open:num(r.open),price:num(r.close),turnover:num(r.amount)});}
  else for(const [symbol,rows]of Object.entries(p.data.bars))for(const b of rows)all.push({...meta,symbol,sourceTime:b.t,open:b.o,price:b.c,turnover:b.v*b.vw});
 }
 const grouped=new Map();for(const q of all){
  const stamp=Date.parse(q.sourceTime),received=Date.parse(q.receivedAt);if(![q.open,q.price,q.turnover].every(finite)||q.open<=0||q.price<=0||q.turnover<0||!finite(stamp)||!finite(received))throw Error('分钟行情字段异常');
  const p=localParts(q.sourceTime,market),d=p.year+'-'+p.month+'-'+p.day,minute=p.hour+':'+p.minute;let session,scope;
  if(market==='a'){const regular=minute>='09:30'&&minute<='11:30'||minute>='13:00'&&minute<='15:00';session=regular?'regular':'extended';scope=regular?'core':'extended';}
  else if(!d.startsWith('2026-')){session='unverified';scope='unverified';}
  else{const core=usCoreSession(d);if(!core){session='closed';scope='non_trading_day';}else if(stamp<Date.parse(core.openTime)){session='extended';scope='before_core';}else if(stamp>=Date.parse(core.closeTime)){session='extended';scope='after_core';}else{session='regular';scope='core';}}
  const minuteStatus=stamp>now?'future':now<stamp+60000||received<stamp+60000?'forming':'complete';
  Object.assign(q,{market,date:d,minute,session,scope,minuteStatus,currency:market==='a'?'CNY':'USD',source:q.provider,priceChange1m:q.price/q.open-1});
  const key=JSON.stringify([q.provider,q.feed,q.symbol,stamp]);if(!grouped.has(key)||received>Date.parse(grouped.get(key).receivedAt))grouped.set(key,q);
 }
 const bySource=new Map(),latest=new Map(),alerts=new Map();for(const q of grouped.values()){
  const key=JSON.stringify([q.provider,q.feed,q.symbol]);if(!bySource.has(key))bySource.set(key,[]);bySource.get(key).push(q);
  const prior=latest.get(q.symbol);if((!replayDate||q.date===replayDate)&&(!prior||Date.parse(q.sourceTime)>Date.parse(prior.sourceTime)||Date.parse(q.sourceTime)===Date.parse(prior.sourceTime)&&Date.parse(q.receivedAt)>Date.parse(prior.receivedAt)))latest.set(q.symbol,q);
 }
 for(const rows of bySource.values()){
  rows.sort((a,b)=>Date.parse(a.sourceTime)-Date.parse(b.sourceTime));const history=new Map();
  for(const q of rows){
   const stamp=Date.parse(q.sourceTime),age=now-stamp,verified=q.feed&&q.minuteStatus==='complete'&&Date.parse(q.receivedAt)<=now&&['regular','extended'].includes(q.session),key=JSON.stringify([q.minute,q.session,q.scope]);
   if(!history.has(key))history.set(key,new Map());const prior=history.get(key);
   if(verified&&(replayDate?q.date===replayDate:age>=0&&age<=q.delaySeconds*1000+120000)){
    const base=[...prior.values()].filter(x=>x.date<q.date).slice(-20);
    if(base.length>=10){const sorted=base.map(x=>x.turnover).sort((a,b)=>a-b),middle=(sorted[Math.floor(sorted.length/2)]+sorted[Math.floor((sorted.length-1)/2)])/2,ratio=q.turnover/middle;
     if(finite(ratio)&&ratio>=3&&finite(q.priceChange1m)){const id=[q.market,q.provider,q.feed,q.symbol,new Date(stamp).toISOString()].join('|');alerts.set(id,{...q,id,ratio,baselineDays:base.length,detectedAt:new Date(now).toISOString(),...(replayDate?{historical:true}:{}),level:Math.abs(q.priceChange1m)>=.01?'confirmed':'watch',kind:'volume_acceleration'});}
    }
   }
   if(verified&&q.turnover>0){prior.set(q.date,q);if(prior.size>20)prior.delete(prior.keys().next().value);}
  }
 }
 return {observations:[...latest.values()],alerts:[...alerts.values()].sort((a,b)=>Date.parse(b.sourceTime)-Date.parse(a.sourceTime))};
}
function empty(){return {schema:'books.stock.workspace.v1',audience:'owner',publishedAt:new Date().toISOString(),markets:Object.fromEntries(['a','us'].map(k=>[k,{status:'not_configured',asOf:null,rows:[],source:null,completeUniverse:false}])),observations:[],alerts:[],execution:{backgroundEnabled:false,realOrdersSent:0}};}
return {table,localDay,atMarket,sessions,screen,assembleA,assembleUS,massiveSessions,assembleMassive,observations,empty};
});
