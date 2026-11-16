'use strict';
const assert = require('node:assert/strict');

function parseScan(rawRequest, payload) {
  // The provider's jQuery call sends raw JSON with a form content type.
  const query = JSON.parse(rawRequest);
  assert.ok(Array.isArray(query?.columns) && query.columns.includes('change'), 'scan has no daily change column');
  assert.ok(Array.isArray(payload?.data), 'scan has no result rows');
  const change = query.columns.indexOf('change'), close = query.columns.indexOf('close');
  const rows = new Map();
  for (const entry of payload.data) {
    if (typeof entry?.s !== 'string' || !Array.isArray(entry.d)) continue;
    const pct = entry.d[change], price = entry.d[close];
    if (!Number.isFinite(pct)) continue;
    const sourceFields = {};
    for (const key of ['update_mode','current_session','time','last_bar_update_time']) {
      const index=query.columns.indexOf(key);
      if (index >= 0 && entry.d[index] != null) sourceFields[key]=entry.d[index];
    }
    rows.set(entry.s,{pct,price,...sourceFields});
  }
  return {rows,columns:query.columns,sort:query.sort,preset:query.preset,dataRestrictions:query.options?.data_restrictions??null};
}

function matches(batch, quotes) {
  return quotes.length>0 && quotes.every(quote => {
    const tick = batch.rows.get(quote.symbol);
    // The screened rows in these checks display two decimals for USD and percent.
    return tick && Number.isFinite(quote.pct) && Math.abs(tick.pct-quote.pct)<=.005000001 &&
      (quote.price===undefined || Number.isFinite(tick.price) && tick.price>0 && Math.abs(tick.price-quote.price)<=.005000001);
  });
}

function observeScans(page) {
  const scans=[];
  page.on('response', response => {
    const request=response.request(), url=new URL(response.url());
    if (url.origin!=='https://scanner.tradingview.com' || !/^\/(america|global)\/scan\/?$/.test(url.pathname) || request.method()!=='POST') return;
    const frame=request.frame(), origin=new URL(frame.url());
    if (origin.protocol!=='https:' || !/(^|\.)tradingview(-widget)?\.com$/.test(origin.hostname) || !/^\/embed-widget\/screener\/?$/.test(origin.pathname)) return;
    const sample={frame,receivedAt:new Date().toISOString(),requestAt:new Date(request.timing().startTime).toISOString(),
      source:url.origin+url.pathname,widget:origin.origin+origin.pathname,httpDate:response.headers().date??null,status:response.status()};
    scans.push(sample);
    if (response.ok()) sample.read=response.json().then(payload=>{sample.batch=parseScan(request.postData(),payload);})
      .catch(error=>{sample.error=error.message;});
  });
  return async (quotes,frame) => {
    const candidates=scans.filter(scan=>!frame || scan.frame===frame);
    await Promise.all(candidates.map(scan=>scan.read));
    const sample=candidates.slice().reverse().find(scan=>scan.batch && matches(scan.batch,quotes));
    const diagnostics=candidates.map(({status,error,batch})=>({status,error,rows:batch?.rows.size,
      ticks:quotes.map(({symbol})=>[symbol,batch?.rows.get(symbol)])}));
    assert.ok(sample,'No matching provider screener response for rendered '+JSON.stringify(quotes)+'; observed '+JSON.stringify(diagnostics));
    const {source,widget,httpDate,status,requestAt,receivedAt,batch}=sample;
    return {source,widget,httpDate,status,requestAt,receivedAt,columns:batch.columns,sort:batch.sort,preset:batch.preset,
      dataRestrictions:batch.dataRestrictions,verified:quotes.map(({symbol})=>({symbol,...batch.rows.get(symbol)}))};
  };
}

module.exports={observeScans,parseScan,matches};
