/* Public observations are not an account ledger. Keep their coverage explicit. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksTradeReplayModel=api;})(globalThis,function(){
'use strict';
const decimal=x=>typeof x==='string'&&x.length<100&&/^-?\d+(?:\.\d+)?$/.test(x)&&Number.isFinite(Number(x));
function number(x){return decimal(String(x))?String(x):null;}
function parts(x){const negative=x.startsWith('-'),[a,b='']=x.replace(/^-/, '').split('.');return [BigInt(a+b)*(negative?-1n:1n),b.length];}
function add(a,b){const [x,s]=parts(a),[y,t]=parts(b),p=Math.max(s,t),z=x*10n**BigInt(p-s)+y*10n**BigInt(p-t);const raw=(z<0n?-z:z).toString().padStart(p+1,'0'),out=p?raw.slice(0,-p)+'.'+raw.slice(-p):raw;return (z<0n?'-':'')+out.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');}
const neg=x=>Number(x)===0?'0':x.startsWith('-')?x.slice(1):'-'+x;
const abs=x=>x.startsWith('-')?x.slice(1):x;
const side=x=>Number(x)>0?'long':Number(x)<0?'short':'unknown';
const time=x=>Number.isSafeInteger(x)&&x>0&&x<=Date.now()+300000;
const symbol=x=>typeof x==='string'&&/^[A-Za-z0-9._:@/\-]{1,80}$/.test(x);
function binanceEvents(rows){
 const list=[];
 for(const [i,r]of (rows||[]).entries()){
  const t=r.updatedAt??r.orderUpdateTime,q=number(r.quantity??r.executedQty),p=number(r.price??r.avgPrice),s=r.symbol;
  if(!time(t)||!symbol(s)||q===null||p===null||Number(q)<=0||Number(p)<=0)continue;
  const d=r.sourceDirection||r.direction,positionSide=r.positionSide||(/_long$/.test(d)?'LONG':/_short$/.test(d)?'SHORT':'BOTH');
  const buy=r.side==='BUY'||d==='opening_or_increasing_long'||d==='reducing_or_closing_short';
  const sell=r.side==='SELL'||d==='opening_or_increasing_short'||d==='reducing_or_closing_long';
  if(!buy&&!sell)continue;
  const pos=positionSide.toLowerCase(),increase=pos==='long'?buy:pos==='short'?sell:null;
  list.push({id:r.id||r.fingerprint||'bn:'+i+':'+s+':'+t,identity:r.identity||null,symbol:s,side:buy?'buy':'sell',positionSide:pos,
   quantity:q,price:p,time:t,createdAt:r.createdAt??r.orderTime,firstSeenAt:r.firstSeenAt||null,
   pnl:number(r.sourcePnl??r.totalPnl),fee:null,quote:r.quoteAsset||'USDT',source:'Binance 公开操作记录',orderId:null,
   effect:increase===null?'unknown':increase?'increase':'decrease',action:increase===null?'开平方向未知':increase?'开仓 / 加仓方向':'减仓 / 平仓方向',precision:'来源订单更新时间；均价为聚合成交价'});
 }
 // Same identity with several versions is unresolved, never silently summed.
 const counts=new Map();for(const e of list)if(e.identity)counts.set(e.identity,(counts.get(e.identity)||0)+1);
 for(const e of list)e.ambiguous=!!e.identity&&counts.get(e.identity)>1;
 return list.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
}
function hyperliquidEvents(rows){
 const seen=new Set(),list=[];
 for(const r of rows||[]){
  const t=r.time,q=number(r.sz),p=number(r.px),start=number(r.startPosition),s=r.coin;
  if(!time(t)||!symbol(s)||s.startsWith('@')||s.includes('/')||q===null||p===null||start===null||Number(q)<=0||Number(p)<=0||!['B','A'].includes(r.side))continue;
  const key=JSON.stringify([s,t,r.tid??null,r.oid??null,r.hash??null]);if(seen.has(key))continue;seen.add(key);
  const delta=r.side==='B'?q:neg(q),end=add(start,delta),flip=Number(start)*Number(end)<0;
  const effect=Number(start)===0?'open':flip?'reverse':Number(end)===0?'close':Number(abs(end))>Number(abs(start))?'increase':'decrease';
  list.push({id:'hl:'+key,symbol:s,side:r.side==='B'?'buy':'sell',positionSide:side(Number(start)===0?end:start),quantity:q,price:p,time:t,
   createdAt:t,firstSeenAt:r.firstSeenAt||null,startPosition:start,endPosition:end,pnl:number(r.closedPnl),fee:number(r.fee),feeToken:r.feeToken||null,
   quote:'USDC',source:'Hyperliquid 官方逐笔成交',orderId:r.oid??null,effect,action:({open:'开仓',close:'平仓',increase:'加仓',decrease:'减仓',reverse:'反转'})[effect],precision:'来源逐笔成交时间',ambiguous:false});
 }
 return list.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
}
function finish(c){
 const es=c.events;c.firstTime=c.opened??es[0]?.time??null;c.lastTime=c.closed??es.at(-1)?.time??null;
 c.quote=es[0]?.quote||c.quote||'USDT';c.ambiguous=es.some(e=>e.ambiguous);
 c.observedChange=c.ambiguous?null:es.reduce((sum,e)=>add(sum,e.effect==='decrease'||e.effect==='close'?neg(e.quantity):e.effect==='unknown'||e.effect==='reverse'?'0':e.quantity),'0');
 if(!c.official){c.pnl=c.ambiguous||es.some(e=>e.pnl===null)?null:es.reduce((v,e)=>v+Number(e.pnl),0);c.quantity=null;c.avgEntry=null;c.avgExit=null;
  if(c.status==='样本内闭合'&&!c.ambiguous){const opens=es.filter(e=>['open','increase'].includes(e.effect)),closes=es.filter(e=>['close','decrease'].includes(e.effect)),weighted=rows=>rows.reduce((v,e)=>v+Number(e.quantity)*Number(e.price),0)/rows.reduce((v,e)=>v+Number(e.quantity),0);c.quantity=closes.reduce((v,e)=>add(v,e.quantity),'0');c.avgEntry=weighted(opens);c.avgExit=weighted(closes);}
 }
 return c;
}
function cycles(events,official=[]){
 const out=[],used=new Set();
 for(const [i,r]of official.entries()){
  if(!symbol(r.symbol)||!time(r.opened)||!time(r.closed)||r.closed<r.opened||!['Long','Short'].includes(r.side)||r.status!=='All Closed')continue;
  if(!['avgCost','avgClosePrice','closedVolume','closingPnl'].every(k=>number(r[k])!==null))continue;
  const positionSide=r.side.toLowerCase(),es=events.filter(e=>e.symbol===r.symbol&&e.positionSide===positionSide&&e.time>=r.opened&&e.time<=r.closed);
  for(const e of es)used.add(e.id);
  out.push(finish({id:'official:'+r.symbol+':'+r.opened+':'+r.closed+':'+i,symbol:r.symbol,positionSide,official:true,status:'官方已平仓',coverage:'官方仓位汇总；逐条操作为本站有限样本',opened:r.opened,closed:r.closed,quantity:r.closedVolume,avgEntry:r.avgCost,avgExit:r.avgClosePrice,pnl:Number(r.closingPnl),events:es,quote:'USDT'}));
 }
 const grouped=new Map();for(const e of events)if(!used.has(e.id)){const k=e.symbol+'|'+(e.startPosition!==undefined?'hl':e.positionSide);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(e);}
 for(const es of grouped.values()){
  if(es[0].startPosition===undefined){out.push(finish({id:'fragment:'+es[0].id,symbol:es[0].symbol,positionSide:es[0].positionSide,official:false,status:'观测片段 · 期初未知',coverage:'缺少可信期初仓位；净变化不等于当前仓位',events:es}));continue;}
  let c=null,expected=null;
  for(const e of es){
   const gap=expected!==null&&add(expected,neg(e.startPosition))!=='0';
   if(c&&(gap||Number(e.startPosition)===0)){c.status=gap?'记录有缺口':'未确认闭合';c.coverage='成交序列未连续覆盖';out.push(finish(c));c=null;}
   if(!c)c={id:'cycle:'+e.id,symbol:e.symbol,positionSide:e.positionSide,official:false,status:Number(e.startPosition)===0?'样本未闭合':'起点前已有仓位',coverage:Number(e.startPosition)===0?'样本内从零仓位开始；不代表完整账户历史':'期初仓位非零，开仓历史未覆盖',opened:Number(e.startPosition)===0?e.time:null,events:[]};
   c.events.push(e);expected=e.endPosition;
   if(Number(e.endPosition)===0||e.effect==='reverse'){
    const complete=c.opened!=null&&e.effect!=='reverse';c.status=complete?'样本内闭合':e.effect==='reverse'?'反转边界 · 部分记录':'左侧缺失 · 已到零仓位';c.closed=e.time;out.push(finish(c));c=null;
    if(e.effect==='reverse')expected=null;
   }
  }
  if(c)out.push(finish(c));
 }
 return out.sort((a,b)=>(b.lastTime||0)-(a.lastTime||0));
}
function candles(raw,kind){
 if(!Array.isArray(raw)||raw.length>1500)throw Error('kline_schema');const out=[],seen=new Set();
 for(const r of raw){const t=kind==='binance'?r[0]:r.t,o=Number(kind==='binance'?r[1]:r.o),h=Number(kind==='binance'?r[2]:r.h),l=Number(kind==='binance'?r[3]:r.l),c=Number(kind==='binance'?r[4]:r.c);
  if(!time(t)||![o,h,l,c].every(x=>Number.isFinite(x)&&x>0)||l>Math.min(o,c)||h<Math.max(o,c)||l>h||seen.has(t))throw Error('kline_schema');seen.add(t);out.push({time:Math.floor(t/1000),open:o,high:h,low:l,close:c});}
 return out.sort((a,b)=>a.time-b.time);
}
return {add,neg,binanceEvents,hyperliquidEvents,cycles,candles};
});
