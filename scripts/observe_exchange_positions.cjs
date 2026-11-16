'use strict';
const okx=require('../trader/okx-trades.js');
const bitget=require('../trader/bitget-period-data.js');
function snapshotsFromOKX(catalog) {
  const data=okx.parse(catalog,Date.parse(catalog.generatedAt));
  return data.accounts.map(account=>{
    const part=account.activity.positions;
    const status=({ready:'complete',empty:'complete',partial:'partial',unavailable:'unavailable',stale:'stale'})[part.status];
    const report=part.pages.find(p=>p.evidencePath===part.evidencePath);
    return {exchange:'OKX',accountId:account.uniqueCode,scope:'public_swap_subpositions',sourceUrl:part.sourceUrl,
      observedAt:['stale','unavailable'].includes(status)?part.checkedAt:part.fetchedAt,status,
      evidenceSha256:report?.sha256,positions:['complete','partial'].includes(status)?part.rows.map(r=>({
        key:r.id,sourcePositionId:r.id,symbol:r.symbol,side:r.side,quantity:r.quantity,quantityUnit:r.unit,
        entryPrice:r.entryPrice,markPrice:r.markPrice,unrealizedPnl:r.unrealizedPnl,leverage:r.leverage,currency:r.currency
      })):[]};
  });
}
function snapshotsFromBitget(catalog) {
  const data=bitget.parse(catalog,Date.parse(catalog.generatedAt)), result=[];
  for(const a of data.accounts) {
    const part=a.activity.positions,status=part.status==='restricted'?'hidden':part.status==='empty'?'partial':'complete';
    // Non-followers receive delayed public positions; an empty response does not establish the account held nothing.
    const positions=part.rows.map(r=>{
      const linear=/^[A-Z0-9]+USDT$/.test(r.symbol),validMark=linear&&Number.isFinite(r.markPrice);
      return {key:[r.symbol,r.side,r.openedAt].join('|'),symbol:r.symbol,side:r.side,quantity:r.quantity,
        quantityUnit:linear?r.symbol.slice(0,-4):null,entryPrice:r.entryPrice,markPrice:r.markPrice,leverage:r.leverage,
        currency:linear?'USDT':null,notional:validMark?Number((r.markPrice*r.quantity).toFixed(10)):null,
        unrealizedPnl:validMark?Number(((r.markPrice-r.entryPrice)*r.quantity*(r.side==='long'?1:-1)).toFixed(10)):null};
    });
    result.push({exchange:'Bitget',accountId:a.portfolioId,scope:'public_futures_delayed',observedAt:part.fetchedAt,
      sourceUrl:part.sourceUrl,evidenceSha256:part.evidenceSha256,status,positions});
    if(a.balance)result.push({exchange:'Bitget',accountId:a.portfolioId,scope:'public_portfolio_equity',
      sourceUrl:a.sourceUrl,observedAt:a.balance.fetchedAt,evidenceSha256:a.balance.evidenceSha256,status:'partial',
      equity:{value:a.balance.value,currency:a.balance.currency},positions:[]});
  }
  return result;
}
module.exports={snapshotsFromOKX,snapshotsFromBitget};
