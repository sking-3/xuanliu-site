/* Deterministic local paper ledger. This module has no network or signing capability. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksPaperEngine=api;})(globalThis,function(){
'use strict';
const VERSION='paper-copy-v1',MAX_EVENTS=4000,MAX_GAP=120000;
const copy=x=>JSON.parse(JSON.stringify(x)),finite=x=>typeof x==='number'&&Number.isFinite(x),positive=x=>finite(x)&&x>0;
const safeKey=x=>typeof x==='string'&&!['__proto__','constructor','prototype'].includes(x),record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(safeKey),positionKey=x=>/^[A-Za-z0-9_-]{1,40}\|(long|short)$/.test(x),timestamp=x=>Number.isSafeInteger(x)&&x>0;
const round=x=>Number(x.toFixed(10)),error=code=>{throw Error(code);};
function config(raw={}){
 const c={initialCapital:10000,sizing:'fixed_notional',ratio:1,fixedNotional:100,sourceEquityAssumption:null,fixedCapital:null,mode:'incremental',leverage:5,feeBps:5,slippageBps:10,maxExposureRatio:3,roundUpMinimum:false,...raw};
 if(!['fixed_notional','equity_ratio','quantity_ratio'].includes(c.sizing)||!['incremental','target'].includes(c.mode)||!positive(c.initialCapital)||c.initialCapital>1e9||!positive(c.ratio)||c.ratio>10||!positive(c.fixedNotional)||c.fixedNotional>1e7||!Number.isSafeInteger(c.leverage)||c.leverage<1||c.leverage>40||![c.feeBps,c.slippageBps].every(x=>finite(x)&&x>=0)||c.feeBps>100||c.slippageBps>500||!positive(c.maxExposureRatio)||c.maxExposureRatio>20||typeof c.roundUpMinimum!=='boolean'||![c.sourceEquityAssumption,c.fixedCapital].every(x=>x===null||positive(x)&&x<=1e12))error('invalid_config');
 return Object.fromEntries(Object.keys({initialCapital:0,sizing:0,ratio:0,fixedNotional:0,sourceEquityAssumption:0,fixedCapital:0,mode:0,leverage:0,feeBps:0,slippageBps:0,maxExposureRatio:0,roundUpMinimum:0}).map(k=>[k,c[k]]));
}
function create(sourceKey,id,raw={},now=Date.now()){
 if(typeof sourceKey!=='string'||sourceKey.length>100||typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!Number.isSafeInteger(now))error('invalid_account');const c=config(raw);
 return {schemaVersion:1,method:VERSION,paperOnly:true,id,sourceKey,currency:'USDC',venue:'Hyperliquid',config:c,createdAt:now,status:'paused',reason:'not_started',revision:0,startedAt:null,lastTickAt:null,lastSourceAt:null,seen:[],identities:{},positions:{},tracked:{},orders:[],notices:[],cash:c.initialCapital,realized:0,fees:0};
}
function pause(state,reason='user_paused',now=Date.now()){const s=copy(state);s.status='paused';s.reason=reason;s.lastTickAt=now;s.revision++;return s;}
function feedReason(feed,now){if(!feed||feed.stopped)return feed?.reason||'source_stopped';if(!finite(feed.checkedAt)||feed.checkedAt>now+1000||now-feed.checkedAt>MAX_GAP)return 'source_stale';if(!Array.isArray(feed.events)||feed.events.length>2500||feed.events.some(e=>!e||typeof e.id!=='string'||e.id.length>1000||['__proto__','constructor','prototype'].includes(e.identity)))return 'source_schema';return null;}
function start(state,feed,now=Date.now()){
 const reason=feedReason(feed,now);if(reason)error(reason);const s=copy(state);if(new Set([...s.seen,...feed.events.map(e=>e.id)]).size>MAX_EVENTS)error('ledger_full');
 s.seen=[...new Set([...s.seen,...feed.events.map(e=>e.id)])];for(const e of feed.events)if(e.identity)s.identities[e.identity]=e.id;
 s.status='running';s.reason=null;s.startedAt=now;s.lastTickAt=now;s.lastSourceAt=feed.checkedAt;s.revision++;
 s.notices.push({at:now,reason:'baseline',records:feed.events.length});return s;
}
function units(q,dp){if(!finite(q)||q<0||q>1e12||!Number.isSafeInteger(dp)||dp<0||dp>8)return 0;let text=q.toString();if(text.includes('e')){const [mantissa,exp]=text.split('e'),digits=mantissa.replace('.',''),point=(mantissa.includes('.')?mantissa.indexOf('.'):mantissa.length)+Number(exp);text=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);}const [a,b='']=text.split('.');const n=Number(BigInt(a+b.padEnd(dp,'0').slice(0,dp)));return Number.isSafeInteger(n)?n:0;}
function marketReason(m,now){if(!m||!Number.isSafeInteger(m.szDecimals)||m.szDecimals<0||m.szDecimals>8||!positive(m.maxLeverage)||!positive(m.minNotional)||!finite(m.time)||m.time>now+1000||now-m.time>15000)return 'market_unavailable';for(const list of [m.bids,m.asks])if(!Array.isArray(list)||!list.length||list.length>100||list.some(x=>!Array.isArray(x)||!positive(x[0])||!positive(x[1])))return 'market_schema';if(m.bids[0][0]>m.asks[0][0])return 'crossed_book';return null;}
function valuation(s,markets,now){let unrealized=0,exposure=0,margin=0;for(const p of Object.values(s.positions)){if(!p.units)continue;const m=markets[p.coin];if(marketReason(m,now))return {equity:null,unrealized:null,exposure:null,margin:null};const mark=(m.bids[0][0]+m.asks[0][0])/2,q=p.units/10**p.dp;unrealized+=(mark-p.entry)*q*(p.side==='long'?1:-1);exposure+=q*mark;margin+=q*mark/s.config.leverage;}return {equity:round(s.cash+unrealized),unrealized:round(unrealized),exposure:round(exposure),margin:round(margin)};}
function signalReason(e,now){if(!e||typeof e.id!=='string'||e.id.length>1000||typeof e.symbol!=='string'||typeof e.coin!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(e.coin)||!['long','short'].includes(e.positionSide)||!['increase','decrease'].includes(e.effect)||!positive(e.quantity)||!finite(e.time)||!finite(e.firstSeenAt))return 'signal_unresolved';if(e.ambiguous)return 'ambiguous_source_version';if(e.time>now+1000||e.firstSeenAt>now+1000)return 'future_signal';return null;}
function plan(s,e,m,markets,now){
 const reference=markets[e.coin]||m,c=s.config,key=e.coin+'|'+e.positionSide,p=s.positions[key],before=(p?.units||0)/10**(p?.dp||0),bad=signalReason(e,now)||marketReason(m,now);if(bad)return {reason:bad};
 if(p&&p.dp!==m.szDecimals)return {reason:'precision_changed'};const v=valuation(s,markets,now),capital=c.fixedCapital??v.equity,sourceEquity=e.sourceEquityVerified?e.sourceEquity:c.sourceEquityAssumption;
 if(c.mode==='target'&&(!e.fullPositionVerified||!finite(e.sourceAfter)))return {reason:'full_source_position_unavailable'};
 let reduce=e.effect==='decrease',requested;
 const factor=c.sizing==='quantity_ratio'?c.ratio:c.sizing==='equity_ratio'&&positive(sourceEquity)&&positive(capital)?c.ratio*capital/sourceEquity:null;
 if(c.mode==='target'){
  if(c.sizing==='fixed_notional')return {reason:'target_requires_ratio'};if(factor===null)return {reason:'source_equity_missing'};
  const target=Math.abs(e.sourceAfter)*factor;reduce=target<before;requested=Math.abs(target-before);
 }else if(reduce){
  if(!before)return {reason:'no_paper_position'};
  if(e.fullPositionVerified&&e.sourceAfter===0)requested=before;
  else if(c.sizing==='fixed_notional'){const base=e.fullPositionVerified&&finite(e.sourceBefore)?Math.abs(e.sourceBefore):s.tracked[key]||0;if(!base)return {reason:'source_quantity_unknown'};requested=before*Math.min(1,e.quantity/base);}
  else {if(factor===null)return {reason:'source_equity_missing'};requested=e.quantity*factor;}
 }else{
  if(c.sizing==='fixed_notional')requested=c.fixedNotional*c.ratio/(e.positionSide==='long'?reference.asks[0][0]:reference.bids[0][0]);else{if(factor===null)return {reason:'source_equity_missing'};requested=e.quantity*factor;}
 }
 if(!positive(requested))return {reason:'no_change'};if(reduce)requested=Math.min(before,requested);
 const buy=reduce?e.positionSide==='short':e.positionSide==='long',best=buy?reference.asks[0][0]:reference.bids[0][0],dp=m.szDecimals,scale=10**dp,minUnits=Math.ceil(m.minNotional/best*scale),requestedUnits=units(requested,dp);
 let wanted=requestedUnits,minimumRaised=false;if(wanted<minUnits&&c.roundUpMinimum&&!reduce){wanted=minUnits;minimumRaised=true;}
 const common={requested,quantized:requestedUnits/scale,minQuantity:minUnits/scale,reduce,buy,minimumRaised,dp,before};
 if(wanted<minUnits)return {...common,reason:'below_minimum'};if(reduce)wanted=Math.min(wanted,p.units);
 if(!reduce){if(s.positions[e.coin+'|'+(e.positionSide==='long'?'short':'long')]?.units)return {...common,reason:'opposite_position'};if(c.leverage>m.maxLeverage)return {...common,reason:'leverage_limit'};if(v.equity===null)return {...common,reason:'mark_missing'};if(v.equity<=0)return {...common,reason:'equity_exhausted'};const worst=best*(1+(buy?1:-1)*c.slippageBps/10000),notional=wanted/scale*worst,fee=notional*c.feeBps/10000;if(v.exposure+notional>v.equity*c.maxExposureRatio)return {...common,reason:'exposure_limit'};if(v.margin+notional/c.leverage+fee>v.equity)return {...common,reason:'margin_insufficient'};}
 let remaining=wanted,notional=0,filled=0;const levels=[];const limit=best*(1+(buy?1:-1)*c.slippageBps/10000);
 for(const [px,sz]of (buy?m.asks:m.bids)){if(buy?px>limit:px<limit)break;const n=Math.min(remaining,units(sz,dp));filled+=n;remaining-=n;notional+=n/scale*px;if(n)levels.push([px,n]);if(!remaining)break;}
 if(!filled||notional<m.minNotional)return {...common,reason:'liquidity_insufficient'};
 return {...common,reason:null,levels,quantity:filled/scale,fillUnits:filled,price:notional/(filled/scale),notional,partial:filled<wanted,fee:notional*c.feeBps/10000,quoteAt:m.time,sourceEquity:sourceEquity??null,equityBasis:e.sourceEquityVerified?'source_snapshot':c.sourceEquityAssumption?'manual_assumption':'not_used'};
}
function advance(state,feed,markets,now=Date.now()){
 if(state.status!=='running')return copy(state);let s=copy(state),bad=feedReason(feed,now);
 if(!bad&&(now<s.lastTickAt||now-s.lastTickAt>MAX_GAP))bad='observation_gap';if(!bad&&feed.checkedAt<s.lastSourceAt)bad='source_rollback';if(bad)return pause(s,bad,now);
 const available=copy(markets),seen=new Set(s.seen),counts={};for(const e of feed.events)if(e.identity)counts[e.identity]=(counts[e.identity]||0)+1;
 const incoming=feed.events.filter(e=>!seen.has(e.id)).sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));if(s.seen.length+incoming.length>MAX_EVENTS||s.orders.length+incoming.length>MAX_EVENTS)return pause(s,'ledger_full',now);
 for(const e of incoming){
  let reason=signalReason(e,now);if(!reason&&(e.time<=s.startedAt||e.firstSeenAt<s.startedAt))reason='historical_baseline';if(!reason&&now-e.time>MAX_GAP)reason='signal_stale';if(!reason&&e.identity&&(counts[e.identity]>1||s.identities[e.identity]&&s.identities[e.identity]!==e.id))reason='ambiguous_source_version';
  const market=available[e.coin],result=reason?{reason}:plan(s,e,market,markets,now),key=e.coin+'|'+e.positionSide;
  const row={id:s.id+':'+e.id,sourceId:e.id,sourceIdentity:e.identity||null,sourceSymbol:e.symbol,coin:e.coin,positionSide:e.positionSide,effect:e.effect,sourceTime:e.time,firstSeenAt:e.firstSeenAt,decidedAt:now,observedLagMs:Math.max(0,now-e.time),sourceQuantity:e.quantity,status:result.reason?'skipped':result.partial?'partial':'simulated',...result};
  if(!result.reason){const sideKey=result.buy?'asks':'bids';for(const [price,filledUnits]of result.levels){const level=market[sideKey].find(x=>x[0]===price);level[1]=(units(level[1],result.dp)-filledUnits)/10**result.dp;}market[sideKey]=market[sideKey].filter(x=>x[1]>0);const p=s.positions[key]||{coin:e.coin,side:e.positionSide,dp:result.dp,units:0,entry:0};const q=result.quantity;
   const realized=result.reduce?(result.price-p.entry)*q*(p.side==='long'?1:-1):0;
   if(result.reduce)p.units-=result.fillUnits;else {p.entry=(p.entry*(p.units/10**p.dp)+result.notional)/(p.units/10**p.dp+q);p.units+=result.fillUnits;}
   s.positions[key]=p;s.cash=round(s.cash+realized-result.fee);s.realized=round(s.realized+realized);s.fees=round(s.fees+result.fee);row.realized=round(realized);row.paperAfter=p.units/10**p.dp;
  }
  // This quantity covers observed post-start actions, never a claimed source position.
  if(!reason&&!e.ambiguous)s.tracked[key]=Math.max(0,(s.tracked[key]||0)+(e.effect==='increase'?e.quantity:-e.quantity));
  s.orders.push(row);seen.add(e.id);if(e.identity)s.identities[e.identity]=e.id;
 }
 s.seen=[...seen];s.lastSourceAt=feed.checkedAt;s.lastTickAt=now;s.revision++;return s;
}
function preview(state,event,markets,now=Date.now()){return plan(copy(state),event,markets[event.coin],markets,now);}
function reconcile(s){
 if(!s||s.schemaVersion!==1||s.method!==VERSION||s.paperOnly!==true||s.currency!=='USDC'||s.venue!=='Hyperliquid'||!['paused','running'].includes(s.status)||typeof s.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(s.id)||typeof s.sourceKey!=='string'||s.sourceKey.length>100||!Number.isSafeInteger(s.revision)||s.revision<0||!timestamp(s.createdAt)||![s.startedAt,s.lastTickAt,s.lastSourceAt].every(x=>x===null||timestamp(x))||s.status==='running'&&![s.startedAt,s.lastTickAt,s.lastSourceAt].every(timestamp)||!Array.isArray(s.orders)||s.orders.length>MAX_EVENTS||!Array.isArray(s.seen)||s.seen.length>MAX_EVENTS||s.seen.some(x=>typeof x!=='string'||x.length>1000)||new Set(s.seen).size!==s.seen.length||!record(s.identities)||Object.entries(s.identities).some(([k,v])=>k.length>1000||typeof v!=='string'||v.length>1000)||!record(s.tracked)||Object.entries(s.tracked).some(([k,v])=>!positionKey(k)||!finite(v)||v<0)||!record(s.positions)||!Array.isArray(s.notices))error('invalid_ledger');
 const cfg=config(s.config);if(!record(s.config)||Object.keys(cfg).some(k=>s.config[k]!==cfg[k]))error('invalid_ledger');
 for(const [k,p]of Object.entries(s.positions))if(!positionKey(k)||!record(p)||k!==p.coin+'|'+p.side||!Number.isSafeInteger(p.units)||p.units<0||!Number.isSafeInteger(p.dp)||p.dp<0||p.dp>8||!positive(p.entry))error('invalid_ledger');
 const ids=new Set(),positions={};let realized=0,fees=0;
 for(const o of s.orders){if(!o||typeof o.id!=='string'||ids.has(o.id)||!['skipped','partial','simulated'].includes(o.status))error('invalid_ledger');ids.add(o.id);if(o.status==='skipped')continue;
  if(!positive(o.quantity)||!positive(o.price)||!finite(o.fee)||o.fee<0||!finite(o.realized)||!Number.isSafeInteger(o.fillUnits)||o.fillUnits<=0||!Number.isSafeInteger(o.dp)||o.dp<0||o.dp>8||o.quantity!==o.fillUnits/10**o.dp||!positionKey(o.coin+'|'+o.positionSide)||typeof o.reduce!=='boolean')error('invalid_ledger');
  const k=o.coin+'|'+o.positionSide,p=positions[k]||{coin:o.coin,side:o.positionSide,dp:o.dp,units:0,entry:0};if(p.dp!==o.dp||o.reduce&&o.fillUnits>p.units)error('ledger_position_mismatch');
  const calc=o.reduce?(o.price-p.entry)*o.quantity*(p.side==='long'?1:-1):0;if(Math.abs(calc-o.realized)>1e-6)error('ledger_pnl_mismatch');
  if(o.reduce)p.units-=o.fillUnits;else{p.entry=(p.entry*(p.units/10**p.dp)+o.price*o.quantity)/(p.units/10**p.dp+o.quantity);p.units+=o.fillUnits;}positions[k]=p;realized+=o.realized;fees+=o.fee;
 }
 if(![s.cash,s.realized,s.fees].every(finite)||Math.abs(s.realized-realized)>1e-6||Math.abs(s.fees-fees)>1e-6||Math.abs(s.cash-(s.config.initialCapital+realized-fees))>1e-6)error('ledger_cash_mismatch');
 for(const k of new Set([...Object.keys(positions),...Object.keys(s.positions||{})])){const a=positions[k],b=s.positions?.[k];if(!a||!b||a.units!==b.units||a.dp!==b.dp||Math.abs(a.entry-b.entry)>1e-6)error('ledger_position_mismatch');}
 return true;
}
function restore(raw,sourceKey){if(typeof raw!=='string'||raw.length>2500000)error('invalid_ledger');const s=JSON.parse(raw);if(s.sourceKey!==sourceKey)error('source_mismatch');reconcile(s);return pause(s,'restored_requires_baseline');}
return {VERSION,MAX_GAP,config,create,start,pause,advance,preview,valuation,reconcile,restore,units,feedReason};
});
