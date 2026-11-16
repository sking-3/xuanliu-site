(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksBitgetPeriodData = api;
})(globalThis, function () {
  'use strict';
  const day = 86400000;
  const days = {'30D': 30, '90D': 90};
  const source = 'bitget_public_lead';
  const rankUrl = 'https://www.bitget.com/copy-trading/futures';
  const profileUrl = id => 'https://www.bitget.com/copy-trading/futures-trader/' + id;
  const validId = id => typeof id === 'string' && /^[1-9]\d{18}$/.test(id);
  const evidencePath = (name, sha) => 'bitget/evidence/' + name + '-' + sha + '.json';
  const number = Number.isFinite;
  const whole = value => Number.isSafeInteger(value) && value >= 0;
  function check(value) { if (!value) throw Error('Invalid Bitget public snapshot'); }
  function timestamp(value, now) {
    return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 5000;
  }
  function evidence(part, name, now) {
    check(part && /^[a-f0-9]{64}$/.test(part.evidenceSha256) && part.evidencePath === evidencePath(name, part.evidenceSha256)
      && timestamp(part.fetchedAt,now));
  }
  function checkHistory(part,id,now) {
    const url=profileUrl(id)+'/current';
    check(part.status==='ready' && part.sourceUrl===url && Array.isArray(part.rows));
    if (!part.pages) {check(part.rows.length<=10);return;} // Earlier published snapshots contain one page.
    check(Array.isArray(part.pages) && part.pages.length>=1 && part.pages.length<=20 && part.pagesFetched===part.pages.length
      && part.pages[0].evidencePath===part.evidencePath && part.truncated===part.hasMore
      && part.hasMore===part.pages[part.pages.length-1].hasMore);
    const pages=new Map();
    for (const page of [...part.pages,...(part.priorPages||[])]) {
      const body=page.postedBody, n=body?.pageNo;
      check(body?.portfolioId===id && body.pageSize===10 && whole(n) && n>=1 && n<=20
        && page.requestUrl==='https://www.bitget.com/v1/trigger/public/uta/historyPosition' && page.method==='POST'
        && typeof page.hasMore==='boolean' && whole(page.rowCount) && page.rowCount<=10 && !pages.has(page.evidencePath));
      evidence(page,id+'-closed'+(n===1?'':'-'+n),now);
      pages.set(page.evidencePath,page);
    }
    check(part.pages.every((p,i)=>p.postedBody.pageNo===i+1 && (i===part.pages.length-1 || p.hasMore)));
    const ids=new Set();
    for(const row of part.rows) {
      const page=pages.get(row.evidencePath);
      check(page && row.sourceUrl===url && row.postedBody?.portfolioId===id && row.postedBody?.pageSize===10
        && row.postedBody?.pageNo===page.postedBody.pageNo && validId(row.id) && !ids.has(row.id)
        && timestamp(row.closedAt,Date.parse(page.fetchedAt)));
      ids.add(row.id);
    }
  }
  function parse(raw, now = Date.now()) {
    check(raw && raw.schemaVersion === 1 && raw.source === source && timestamp(raw.generatedAt,now));
    const end = Date.parse(raw.generatedAt);
    check(raw.rankSourceUrl === rankUrl && Array.isArray(raw.accounts) && raw.accounts.length > 0 && raw.accounts.length <= 6);
    evidence(raw.rankEvidence,'leaders-aum',end);
    const seen = new Set();
    for (const row of raw.accounts) {
      const id = row.portfolioId;
      check(validId(id) && !seen.has(id) && typeof row.name === 'string' && row.name.trim() && row.name.length <= 150);
      seen.add(id);
      check(row.sourceUrl === profileUrl(id) && whole(row.leadDays) && row.leadDays >= 90
        && whole(row.copyTraderNum) && row.copyTraderNum > 0 && row.performance?.['90D']?.roi > 0);
      evidence(row.profileEvidence,id+'-profile',end);
      if(row.balance) {
        const value=row.balance,period=row.performance[value.sourcePeriod];
        check(period && value.sourceUrl===row.sourceUrl && value.evidencePath===period.evidencePath
          && value.fetchedAt===period.fetchedAt && value.currency==='USD' && number(value.value));
        evidence(value,id+'-p'+days[value.sourcePeriod],end);
      }
      if(row.transfers) {
        const t=row.transfers;
        check(t.sourceUrl===row.sourceUrl+'/balance' && t.sourceWindowDays===180 && timestamp(t.fetchedAt,end)
          && Array.isArray(t.pages) && t.pages.length>=1 && t.pages.length<=10 && Array.isArray(t.rows)
          && t.status===(t.rows.length?'ready':'empty') && t.truncated===t.pages.at(-1).hasMore);
        const receipts=new Map();
        for(const [i,p] of t.pages.entries()) {
          const n=i+1;check(p.method==='POST' && p.requestUrl==='https://www.bitget.com/v1/trigger/public/uta/getTransferHistory'
            && p.postedBody?.portfolioId===id && p.postedBody.pageNo===n && p.postedBody.pageSize===10);
          evidence(p,id+'-transfers'+(n===1?'':'-'+n),end);receipts.set(p.evidencePath,p);
        }
        for(const r of t.rows) {
          const p=receipts.get(r.evidencePath);
          check(p && timestamp(r.time,Date.parse(p.fetchedAt)) && ['in','out'].includes(r.kind) && number(r.amount) && r.amount>0
            && /^[A-Z0-9]{2,12}$/.test(r.currency) && typeof r.from==='string' && typeof r.to==='string');
        }
      }
      for (const [period,part] of Object.entries(row.performance)) {
        check(Object.hasOwn(days,period) && part.sourcePeriod === period && part.sourceUrl === row.sourceUrl
          && part.currency === 'USD' && part.sourceAsOf === null && part.lastSuccessAt === part.fetchedAt);
        evidence(part,id+'-p'+days[period],end);
        evidence({fetchedAt:part.curveFetchedAt,evidencePath:part.curveEvidencePath,evidenceSha256:part.curveEvidenceSha256},id+'-curve'+days[period],end);
        check(Array.isArray(part.curve) && part.curve.length>0 && part.curve.length<=days[period]+1
          && part.curve.every((point,i)=>number(point.value) && timestamp(point.time,Date.parse(part.curveFetchedAt))
            && (!i || part.curve[i-1].time<point.time)));
        check(part.pnlCurve===undefined || Array.isArray(part.pnlCurve) && part.pnlCurve.length===part.curve.length
          && part.pnlCurve.every((p,i)=>number(p.value) && p.time===part.curve[i].time));
        check(number(part.roi) && number(part.pnl) && (part.mdd === null || number(part.mdd) && part.mdd >= 0)
          && (part.winRate === null || number(part.winRate) && part.winRate >= 0 && part.winRate <= 100));
      }
      for (const [key,suffix] of [['positions','open'],['history','closed']]) {
        const part = row.activity?.[key];
        evidence(part,id+'-'+suffix,end);
        check(part.sourceUrl === row.sourceUrl+'/current' && Array.isArray(part.rows)
          && (part.rows.length ? part.status === 'ready' : ['empty','restricted'].includes(part.status)));
        if(key==='history') checkHistory(part,id,end);
        for (const trade of part.rows) {
          check(typeof trade.symbol === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(trade.symbol)
            && ['long','short'].includes(trade.side) && timestamp(trade.openedAt,Date.parse(part.fetchedAt))
            && number(trade.entryPrice) && trade.entryPrice > 0 && number(trade.quantity) && trade.quantity > 0
            && (trade.leverage === null || number(trade.leverage) && trade.leverage > 0));
          check(trade.marginMode==null || ['cross','isolated'].includes(trade.marginMode));
          for(const field of ['openFee','closeFee','fundingFee','stockDividend','grossPnl','margin','unrealizedPnl','notional'])
            check(trade[field]==null || number(trade[field]));
          if (key === 'history') check(timestamp(trade.closedAt,Date.parse(part.fetchedAt)) && trade.openedAt <= trade.closedAt
            && validId(trade.id) && number(trade.exitPrice) && trade.exitPrice > 0
            && number(trade.realizedPnl) && /^[A-Z0-9]{2,12}$/.test(trade.currency));
        }
      }
    }
    if(raw.archivedHistories) {
      check(Array.isArray(raw.archivedHistories));
      for(const entry of raw.archivedHistories) {
        check(validId(entry.portfolioId) && !seen.has(entry.portfolioId));
        seen.add(entry.portfolioId);
        checkHistory(entry.history,entry.portfolioId,end);
      }
    }
    return raw;
  }
  function performance(row, period, now = Date.now()) {
    const part = row?.performance?.[period];
    return part ? {...part, status: now-Date.parse(part.lastSuccessAt)>day?'stale':'ready',
      accountAgeDays:row.leadDays,fullPeriod:row.leadDays>=days[period],periodSupported:true} : null;
  }
  function trader(row) {
    return {id:'bitget-'+row.portfolioId,accountId:row.portfolioId,name:row.name,sourceKind:source,exchange:'Bitget',
      currency:'USD',sourceUrl:row.sourceUrl,bitgetRecord:row};
  }
  return {parse,performance,trader,validId,rankUrl,profileUrl,evidencePath,source,days};
});
