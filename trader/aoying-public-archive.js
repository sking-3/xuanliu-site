(function(root,factory) {
  const api=factory();
  if (typeof module==='object' && module.exports) module.exports=api;
  else root.BooksAoyingPublicArchive=api;
})(globalThis,function() {
  'use strict';
  const portfolioId='5075281354358777856', sourceId='bn-'+portfolioId;
  const sourceUrl='https://www.alphafox.app/api/radar/snapshot?sourceId='+sourceId+'&include=lifecycle';
  const source='AlphaFox 公开归档';
  const positionFields=['lifecycleId','symbol','side','status','realizedPnl','pnlEstimated','openPrice','closeAvgPrice',
    'closedQty','openTime','closeTime','origin','officialLeverage'];
  const orderFields=['symbol','side','positionSide','canonicalAction','avgPrice','executedQty','time'];
  const positive=n=>typeof n==='number' && Number.isFinite(n) && n>0;
  const symbol=s=>typeof s==='string' && /^[A-Z0-9_]{1,40}USDT$/.test(s);
  const timestamp=(ms,end)=>Number.isSafeInteger(ms) && ms>0 && ms<=end;
  const only=(obj,keys)=>!!obj && typeof obj==='object' && Object.keys(obj).every(key=>keys.includes(key));
  function check(ok) {if (!ok) throw Error('Invalid AlphaFox public archive');}
  function parse(raw,now=Date.now()) {
    const fields=['schemaVersion','sourceId','sourceUrl','portfolioId','sourceBodySha256','projection','polledAt','fetchedAt',
      'eventPnlAvailable','latestOrders','closedPositions','archiveReceipts','positionSnapshots'];
    check(only(raw,fields) && raw.schemaVersion===1 && raw.projection==='public-historical-records-v1'
      && raw.sourceId===sourceId && raw.portfolioId===portfolioId && raw.sourceUrl===sourceUrl && raw.eventPnlAvailable===false
      && typeof raw.sourceBodySha256==='string' && /^[a-f0-9]{64}$/.test(raw.sourceBodySha256));
    const polled=Date.parse(raw.polledAt),fetched=Date.parse(raw.fetchedAt);
    check(timestamp(fetched,now+5000) && timestamp(polled,fetched+5000));
    if (Object.hasOwn(raw,'archiveReceipts')) {
      const receipts=raw.archiveReceipts;
      check(Array.isArray(receipts) && receipts.length>=2);
      let previous=0;
      for (const r of receipts) {
        check(only(r,['sourceBodySha256','polledAt','fetchedAt']) && typeof r.sourceBodySha256==='string'
          && /^[a-f0-9]{64}$/.test(r.sourceBodySha256));
        const poll=Date.parse(r.polledAt),received=Date.parse(r.fetchedAt);
        check(timestamp(received,now+5000) && timestamp(poll,received+5000) && poll>previous);
        previous=poll;
      }
      const last=receipts[receipts.length-1];
      check(last.sourceBodySha256===raw.sourceBodySha256 && last.polledAt===raw.polledAt && last.fetchedAt===raw.fetchedAt);
    }
    if(Object.hasOwn(raw,'positionSnapshots')) {
      const timeframe=new Map((raw.archiveReceipts||[raw]).map(r=>[r.sourceBodySha256,r]));
      check(Array.isArray(raw.positionSnapshots));let last=0;
      for(const s of raw.positionSnapshots){
        const receipt=timeframe.get(s.sourceBodySha256),at=Date.parse(s.polledAt);
        check(only(s,['sourceUrl','sourceBodySha256','polledAt','fetchedAt','sourceTime','status','sourcePositionShow','rows','totals','quote','official'])
          && receipt && s.sourceUrl===sourceUrl && s.official===false && s.quote==='USDT' && at>last
          && receipt.polledAt===s.polledAt && receipt.fetchedAt===s.fetchedAt
          && (s.sourceTime===null||timestamp(Date.parse(s.sourceTime),at+5000))
          && ['reported','reported_empty','hidden','unavailable'].includes(s.status)
          && (s.sourcePositionShow===null||typeof s.sourcePositionShow==='boolean') && Array.isArray(s.rows)
          && s.rows.length<=1000 && (s.status==='reported')===(s.rows.length>0)
          && (s.status!=='reported_empty'||s.sourcePositionShow===true));
        const totals=['marginBalance','notional','unrealizedPnl','effectiveLeverage'];
        check(only(s.totals,totals)&&totals.every(k=>s.totals[k]===null||Number.isFinite(s.totals[k])));
        const ids=new Set();
        for(const r of s.rows){
          check(only(r,['symbol','baseAsset','side','quantity','entryPrice','markPrice','notional','unrealizedPnl','leverage','sourceOpenedAt','origin'])
            && symbol(r.symbol)&&typeof r.baseAsset==='string'&&/^[A-Z0-9_]{1,40}$/.test(r.baseAsset)
            && ['long','short'].includes(r.side)&&positive(r.quantity)
            && [r.entryPrice,r.markPrice,r.leverage].every(x=>x===null||positive(x))
            && (r.notional===null||Number.isFinite(r.notional)&&r.notional>=0)&&(r.unrealizedPnl===null||Number.isFinite(r.unrealizedPnl))
            && (r.sourceOpenedAt===null||timestamp(Date.parse(r.sourceOpenedAt),at+5000))
            && typeof r.origin==='string'&&/^[A-Za-z0-9_-]{1,60}$/.test(r.origin));
          const key=[r.symbol,r.side,r.sourceOpenedAt,r.origin].join(':');check(!ids.has(key));ids.add(key);
        }
        last=at;
      }
    }
    check(Array.isArray(raw.closedPositions) && raw.closedPositions.length>0 && raw.closedPositions.length<=10000
      && Array.isArray(raw.latestOrders) && raw.latestOrders.length>0 && raw.latestOrders.length<=25000);
    const positionIds=new Set(),fingerprints=new Set();
    for (const r of raw.closedPositions) {
      check(only(r,positionFields) && typeof r.lifecycleId==='string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(r.lifecycleId)
        && !positionIds.has(r.lifecycleId) && r.status==='closed' && symbol(r.symbol) && ['LONG','SHORT'].includes(r.side)
        && timestamp(r.openTime,polled) && timestamp(r.closeTime,polled) && r.openTime<=r.closeTime
        && [r.openPrice,r.closeAvgPrice,r.closedQty].every(positive)
        && (r.realizedPnl===null || Number.isFinite(r.realizedPnl)) && typeof r.pnlEstimated==='boolean'
        && typeof r.origin==='string' && /^[A-Za-z0-9_-]{1,60}$/.test(r.origin)
        && (r.officialLeverage==null || positive(r.officialLeverage)));
      positionIds.add(r.lifecycleId);
    }
    for (const r of raw.latestOrders) {
      check(only(r,[...orderFields,'fingerprint']) && typeof r.fingerprint==='string' && /^[a-f0-9]{64}$/.test(r.fingerprint)
        && !fingerprints.has(r.fingerprint) && symbol(r.symbol) && ['BUY','SELL'].includes(r.side)
        && ['LONG','SHORT'].includes(r.positionSide) && timestamp(r.time,polled) && positive(r.avgPrice) && positive(r.executedQty));
      const increase=r.side===(r.positionSide==='LONG'?'BUY':'SELL');
      check(r.canonicalAction===(increase?'open_':'close_')+r.positionSide.toLowerCase());
      fingerprints.add(r.fingerprint);
    }
    return raw;
  }
  function events(raw) {
    return raw.latestOrders.map(r=>{
      const increase=r.canonicalAction.startsWith('open_');
      return {id:'af:'+r.fingerprint,symbol:r.symbol,positionSide:r.positionSide.toLowerCase(),side:r.side.toLowerCase(),
        quantity:String(r.executedQty),price:String(r.avgPrice),time:r.time,effect:increase?'increase':'decrease',
        action:increase?'开仓 / 加仓方向':'减仓 / 平仓方向',precision:'第三方来源记录时间，价格为聚合均价',
        firstSeenAt:null,source,reference:true,official:false,orderId:null,fee:null,pnl:null,quote:'USDT',ambiguous:false};
    }).sort((a,b)=>a.time-b.time || a.id.localeCompare(b.id));
  }
  function cycles(raw,observations=events(raw)) {
    const out=raw.closedPositions.map(r=>({
      id:'af-position:'+r.lifecycleId,sourcePositionId:r.lifecycleId,symbol:r.symbol,positionSide:r.side.toLowerCase(),
      source,origin:r.origin,reference:true,official:false,status:'第三方已平仓',coverage:'按合约、方向和开平时间区间关联公开操作',
      opened:r.openTime,closed:r.closeTime,firstTime:r.openTime,lastTime:r.closeTime,quantity:String(r.closedQty),
      avgEntry:r.openPrice,avgExit:r.closeAvgPrice,pnl:r.realizedPnl,pnlEstimated:r.pnlEstimated,
      leverage:r.officialLeverage??null,quote:'USDT',observedChange:null,ambiguous:false,events:[]
    }));
    const byMarket=new Map();
    for (const position of out) {
      const key=position.symbol+'|'+position.positionSide;
      if (!byMarket.has(key)) byMarket.set(key,[]);
      byMarket.get(key).push(position);
    }
    for (const event of observations) {
      if (event.source!==source || event.reference!==true) continue;
      const matches=(byMarket.get(event.symbol+'|'+event.positionSide)||[]).filter(p=>p.opened<=event.time && event.time<=p.closed);
      // An operation without a provider position ID can only be assigned to a unique matching interval.
      if (matches.length===1) matches[0].events.push(event);
    }
    return out.sort((a,b)=>b.closed-a.closed || a.id.localeCompare(b.id));
  }
  return {parse,events,cycles,sourceId,sourceUrl,portfolioId,positionFields,orderFields};
});
