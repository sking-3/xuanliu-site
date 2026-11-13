/* Calculations use actual vendor exports; no sample securities are seeded. */
(function(root,factory){const a=factory();if(typeof module==='object'&&module.exports)module.exports=a;else root.BooksResearchModel=a;})(globalThis,function(){
'use strict';
const finite=v=>typeof v==='number'&&Number.isFinite(v),mean=x=>x.reduce((s,v)=>s+v,0)/x.length;
const table=r=>{const {fields,items}=r.data;if(!Array.isArray(fields)||!Array.isArray(items))throw Error('供应商表格格式错误');return items.map(x=>Object.fromEntries(fields.map((k,i)=>[k,x[i]])));};
const isoDay=s=>s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8),num=x=>x===null||x===''?NaN:Number(x);
function localParts(time,market){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:market==='a'?'Asia/Shanghai':'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time)).map(x=>[x.type,x.value]));}
function localDay(time,market){const p=localParts(time,market);return p.year+'-'+p.month+'-'+p.day;}
function atMarket(day,clock,market){let t=Date.parse(day+'T'+clock+':00Z');for(let i=0;i<3;i++){const p=localParts(t,market),asUTC=Date.parse(p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':00Z');t+=Date.parse(day+'T'+clock+':00Z')-asUTC;}return new Date(t).toISOString();}
function sessions(response,market,now=Date.now()){
 const values=market==='a'?table(response).filter(x=>String(x.is_open)==='1').map(x=>({date:isoDay(x.cal_date),close:'15:00'})):response.data;
 const result=values.map(x=>({date:x.date,closeTime:atMarket(x.date,x.close,market)})).filter(x=>Date.parse(x.closeTime)<=now).sort((a,b)=>a.date.localeCompare(b.date));
 if(result.length<61||new Set(result.map(x=>x.date)).size!==result.length)throw Error('交易日历不足或重复');return result.slice(-61);
}
function dayMetrics(bars,benchmark,dates){
 if(bars.length<61||JSON.stringify(bars.slice(-61).map(x=>x.date))!==JSON.stringify(dates.slice(-61)))throw Error('连续交易日日线不足');
 for(const b of bars)if(!['open','high','low','close','volume','turnover'].every(k=>finite(b[k]))||Math.min(b.open,b.high,b.low,b.close)<=0||Math.min(b.volume,b.turnover)<0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close))throw Error('日线字段异常');
 const a=bars.at(-1),p=bars.at(-2),v=mean(bars.slice(-21,-1).map(x=>x.volume)),ma20=mean(bars.slice(-20).map(x=>x.close)),ma50=mean(bars.slice(-50).map(x=>x.close));if(v<=0)throw Error('历史成交量不足');
 const ref=new Map(benchmark.map(x=>[x.date,x.close])),excess=ref.has(dates.at(-1))&&ref.has(dates.at(-21))?a.close/bars.at(-21).close-ref.get(dates.at(-1))/ref.get(dates.at(-21)):null;
 return {close:a.close,rvol:a.volume/v,ma20,ma50,ma50_up:ma50>mean(bars.slice(-51,-1).map(x=>x.close)),high20:Math.max(...bars.slice(-21,-1).map(x=>x.high)),gap:a.open/p.close-1,dayret:a.close/p.close-1,turnover:mean(bars.slice(-20).map(x=>x.turnover)),excess};
}
function screen(raw){
 const {market,asOf,dates,securities,benchmark=[],source}=raw,rows=[];const complete=source.coverage==='full_universe'&&source.paginationComplete===true&&source.permissionsVerified===true&&source.dataAsOf===asOf&&source.expectedCount>0&&source.expectedCount===securities.length&&(market==='a'||source.feed==='sip');
 for(const s of securities){const e=s.eligibility||{},excluded=e.excluded===true,qualified=e.qualified===true;const r={symbol:s.symbol,name:String(s.name||s.symbol).slice(0,120),exchange:s.exchange,status:excluded?'excluded':'pending',qualification:excluded?'excluded':qualified?'qualified':'pending',hits:[],pending:market==='a'?['M1','M2','M3','M4','M5']:[],reasons:[...(e.reasons||[])],close:null,currency:market==='a'?'CNY':'USD',asOf,metrics:null,bars:[]};rows.push(r);if(excluded)continue;
  try{if(!s.adjustmentVerified)throw Error('复权待核');const m=dayMetrics(s.bars,benchmark,dates);r.close=m.close;r.metrics=m;
   if(market==='a'){r.reasons.push('five_mode_definitions_pending');continue;}
   if(m.close<5||m.turnover<10000000){r.status='excluded';r.reasons.push('price_or_liquidity_below_threshold');continue;}
   if(m.gap>=.04&&m.rvol>=2&&m.dayret>0){r.hits.push('U1');r.reasons.push('event_catalyst_requires_evidence');}
   const trend=m.close>m.ma20&&m.ma20>m.ma50&&m.ma50_up&&m.excess!==null&&m.excess>0;if(trend&&m.close/m.ma20-1<=.15){if(m.close>m.high20&&m.rvol>=1.5)r.hits.push('U2');if(m.close/m.high20>=.97&&m.close/m.high20<=1)r.hits.push('U3');}
   if(m.excess===null)r.reasons.push('same_date_spy_benchmark_missing');if(!complete)r.reasons.push('batch_coverage_or_close_unverified');if(complete&&qualified)r.status=r.hits.length?'candidate':'unmatched';r.bars=r.hits.length?s.bars.slice(-8):[];
  }catch(err){r.reasons.push(err.message);}
 }
 return {status:complete?'ready':'partial',asOf,completeUniverse:complete,source,parameters:{min_price:5,min_turnover:10000000,event_gap:.04,event_volume:2,break_volume:1.5,max_extension:.15,near_high:.03},rows};
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
 const receivedAt=parts.daily.at(-1).receivedAt;return {market:'a',asOf,dates,securities,source:{id:'tushare',name:'Tushare Pro · 个人研究',dataAsOf:asOf,receivedAt,coverage:localDay(parts.universe.receivedAt,'a')!==asOf?'current_directory':universe.length>=6000||parts.universe.data.truncated||parts.daily.some(p=>p.data.truncated)?'partial':'full_universe',expectedCount:universe.length,paginationComplete:universe.length<6000&&!parts.universe.data.truncated&&!parts.daily.some(p=>p.data.truncated),permissionsVerified:true,redistributionAllowed:false,accessScope:'personal',feed:'tushare'}};
}
function assembleUS(parts){
 const dates=parts.sessions.map(x=>x.date),asOf=dates.at(-1),bars=new Map(),seen=new Set();for(const p of parts.pages)for(const [symbol,rows]of Object.entries(p.data.bars))for(const b of rows){const key=symbol+'|'+b.t;if(seen.has(key))throw Error('重复分页日线');seen.add(key);if(!bars.has(symbol))bars.set(symbol,[]);bars.get(symbol).push({date:localDay(b.t,'us'),open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v,turnover:b.v*b.vw});}
 for(const b of bars.values())b.sort((a,b)=>a.date.localeCompare(b.date));const universe=parts.universe.data;if(!universe.length)throw Error('证券目录为空');const receivedAt=parts.pages.at(-1).receivedAt,feed=parts.pages[0].feed==='sip_delayed'?'sip':'iex',metadataDay=localDay(parts.universe.receivedAt,'us');
 const securities=universe.map(x=>{const name=x.name||x.symbol,ordinary=/common (stock|shares)|ordinary shares/i.test(name)&&!/preferred|warrant|depositary|\bETF\b|\bunits?\b|\bfund\b/i.test(name),qualified=ordinary&&['NYSE','NASDAQ','AMEX'].includes(x.exchange)&&x.status==='active'&&x.tradable===true&&metadataDay===asOf;return {symbol:x.symbol,name,exchange:x.exchange,eligibility:{excluded:x.status!=='active'||/preferred|warrant|\bETF\b/i.test(name),qualified,reasons:qualified?[]:['us_security_type_unverified','证券目录为当前在市快照，非历史时点目录']},adjustmentVerified:true,bars:bars.get(x.symbol)||[]};});
 return {market:'us',asOf,dates,securities,benchmark:bars.get('SPY')||[],source:{id:'alpaca',name:'Alpaca · '+(feed==='sip'?'SIP（延迟历史）':'IEX 单交易所')+' · 个人研究',dataAsOf:asOf,receivedAt,coverage:metadataDay===asOf?'full_universe':'current_directory',expectedCount:universe.length,paginationComplete:parts.complete===true,permissionsVerified:true,redistributionAllowed:false,accessScope:'personal',feed,delaySeconds:feed==='sip'?960:0}};
}
function observations(pages,market,now=Date.now()){
 const all=[];for(const p of pages){if(market==='a')for(const r of table(p)){const t=r.time||r.trade_time,stamp=t.includes('T')?t: t.replace(' ','T')+'+08:00';all.push({symbol:r.ts_code,sourceTime:stamp,open:num(r.open),price:num(r.close),turnover:num(r.amount),receivedAt:p.receivedAt,delaySeconds:0});}else for(const [symbol,rows]of Object.entries(p.data.bars))for(const b of rows)all.push({symbol,sourceTime:b.t,open:b.o,price:b.c,turnover:b.v*b.vw,receivedAt:p.receivedAt,delaySeconds:p.feed==='sip_delayed'?960:0});}
 const grouped=new Map();for(const q of all){if(![q.open,q.price,q.turnover].every(finite)||q.open<=0||q.price<=0||q.turnover<0||!Number.isFinite(Date.parse(q.sourceTime)))throw Error('分钟行情字段异常');const p=localParts(q.sourceTime,market),d=p.year+'-'+p.month+'-'+p.day,minute=p.hour+':'+p.minute,regular=market==='a'?(minute>='09:30'&&minute<='11:30'||minute>='13:00'&&minute<='15:00'):(minute>='09:30'&&minute<'16:00');Object.assign(q,{market,date:d,minute,session:regular?'regular':'extended',currency:market==='a'?'CNY':'USD',source:market==='a'?'Tushare':'Alpaca',priceChange1m:q.price/q.open-1});const key=q.symbol+'|'+q.sourceTime;if(!grouped.has(key)||Date.parse(q.receivedAt)>Date.parse(grouped.get(key).receivedAt))grouped.set(key,q);}
 const bySymbol=new Map();for(const q of grouped.values()){if(!bySymbol.has(q.symbol))bySymbol.set(q.symbol,[]);bySymbol.get(q.symbol).push(q);}const latest=[],alerts=[];
 for(const rows of bySymbol.values()){rows.sort((a,b)=>Date.parse(a.sourceTime)-Date.parse(b.sourceTime));const q=rows.at(-1);latest.push(q);const age=now-Date.parse(q.sourceTime),allowed=q.delaySeconds*1000+120000;if(age>allowed||age<0)continue;const base=rows.filter(x=>x.date<q.date&&x.minute===q.minute&&x.session===q.session&&x.turnover>0).slice(-20);if(base.length<10||new Set(base.map(x=>x.date)).size!==base.length)continue;const sorted=base.map(x=>x.turnover).sort((a,b)=>a-b),middle=(sorted[Math.floor(sorted.length/2)]+sorted[Math.floor((sorted.length-1)/2)])/2,ratio=q.turnover/middle;if(ratio<3)continue;alerts.push({...q,id:q.market+'|'+q.symbol+'|'+q.sourceTime,ratio,baselineDays:base.length,detectedAt:new Date(now).toISOString(),level:Math.abs(q.priceChange1m)>=.01?'confirmed':'watch',kind:'volume_acceleration'});}
 return {observations:latest,alerts};
}
function empty(){return {schema:'books.stock.workspace.v1',audience:'owner',publishedAt:new Date().toISOString(),markets:Object.fromEntries(['a','us'].map(k=>[k,{status:'not_configured',asOf:null,rows:[],source:null,completeUniverse:false}])),observations:[],alerts:[],execution:{backgroundEnabled:false,realOrdersSent:0}};}
return {table,localDay,atMarket,sessions,screen,assembleA,assembleUS,observations,empty};
});
