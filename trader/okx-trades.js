/* Public SWAP lead-position snapshots. A completed subposition is not an individual fill. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BooksOKXTrades=api;
})(globalThis,function(){
  'use strict';
  const root='https://www.okx.com/api/v5/copytrading/';
  const routes={positions:'public-current-subpositions',history:'public-subpositions-history'};
  const validId=id=>typeof id==='string'&&/^(?:[A-Za-z0-9]{16}|[A-Za-z0-9]{18})$/.test(id);
  const validSubId=id=>typeof id==='string'&&/^\d{1,28}$/.test(id);
  const time=t=>typeof t==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t)&&Number.isFinite(Date.parse(t));
  const url=(id,kind,after='')=>root+routes[kind]+'?instType=SWAP&uniqueCode='+id+'&limit=100'+(after?'&after='+after:'');
  const evidence=(id,kind,sha)=>'okx/trade-evidence/'+id+'-'+kind+'-'+sha+'.json';
  function requireField(condition){if(!condition)throw Error('Invalid OKX public lead position data');}
  function checkGroup(id,kind,s,generatedAt){
    requireField(s&&['ready','empty','partial','stale','unavailable'].includes(s.status)&&Array.isArray(s.rows)&&Array.isArray(s.pages));
    requireField(time(s.checkedAt)&&Date.parse(s.checkedAt)<=Date.parse(generatedAt)&&s.sourceUrl===url(id,kind));
    requireField(s.fetchedAt===null||time(s.fetchedAt)&&Date.parse(s.fetchedAt)<=Date.parse(s.checkedAt));
    requireField(Number.isSafeInteger(s.hiddenCount)&&s.hiddenCount>=0&&typeof s.truncated==='boolean');
    const receipts=new Map();
    for(const p of s.pages){
      requireField(p&&/^[a-f0-9]{64}$/.test(p.sha256)&&p.evidencePath===evidence(id,kind,p.sha256));
      requireField((p.after===''||validSubId(p.after))&&p.sourceUrl===url(id,kind,p.after));
      requireField(time(p.receivedAt)&&Date.parse(p.receivedAt)<=Date.parse(s.checkedAt)&&Number.isSafeInteger(p.bytes)&&p.bytes>0);
      receipts.set(p.evidencePath,p);
    }
    requireField(s.evidencePath===null||receipts.has(s.evidencePath));
    requireField(!['empty','unavailable'].includes(s.status)||!s.rows.length);
    requireField(s.status!=='empty'||s.pages.length>0&&s.hiddenCount===0&&!s.truncated&&s.fetchedAt!==null);
    requireField(s.status!=='ready'||s.rows.length>0&&s.fetchedAt!==null&&s.evidencePath!==null);
    const ids=new Set();
    for(const row of s.rows){
      const page=receipts.get(row.evidencePath);
      requireField(page&&row.sourceUrl===page.sourceUrl&&validSubId(row.id)&&!ids.has(row.id));
      ids.add(row.id);
      requireField(/^[A-Z0-9][A-Z0-9.-]{0,75}-SWAP$/.test(row.symbol)&&/^[A-Z0-9]{1,20}$/.test(row.currency)&&row.unit==='张');
      requireField(['long','short'].includes(row.side)&&['long','short','net'].includes(row.sourceSide));
      requireField(time(row.openedAt)&&Date.parse(row.openedAt)<=Date.parse(page.receivedAt)+300000&&Number.isFinite(row.quantity)&&row.quantity>0&&Number.isFinite(row.entryPrice)&&row.entryPrice>0);
      requireField(row.leverage===null||Number.isFinite(row.leverage)&&row.leverage>0);
      if(kind==='history')requireField(time(row.closedAt)&&Date.parse(row.closedAt)>=Date.parse(row.openedAt)&&Date.parse(row.closedAt)<=Date.parse(page.receivedAt)+300000&&Number.isFinite(row.exitPrice)&&row.exitPrice>0&&(row.realizedPnl===null||Number.isFinite(row.realizedPnl)));
      else requireField((row.markPrice===null||Number.isFinite(row.markPrice)&&row.markPrice>0)&&(row.unrealizedPnl===null||Number.isFinite(row.unrealizedPnl)));
    }
  }
  function parse(raw,now=Date.now()){
    requireField(raw&&raw.schemaVersion===1&&raw.source==='okx_public_lead_subpositions'&&time(raw.generatedAt)&&Array.isArray(raw.accounts));
    const ids=new Set();
    for(const a of raw.accounts){
      requireField(validId(a.uniqueCode)&&!ids.has(a.uniqueCode)&&typeof a.name==='string'&&a.name.length>0&&a.activity);
      ids.add(a.uniqueCode);
      for(const kind of Object.keys(routes))checkGroup(a.uniqueCode,kind,a.activity[kind],raw.generatedAt);
      const o=a.activity.orders;
      requireField(o&&o.status==='unsupported'&&Array.isArray(o.rows)&&o.rows.length===0&&o.fetchedAt===null&&o.sourceUrl===null&&o.evidencePath===null);
    }
    return {...raw,accounts:raw.accounts.map(a=>{
      const s=a.activity.positions;
      if(!s.fetchedAt||s.status==='unavailable'||s.status==='stale'||now-Date.parse(s.fetchedAt)<=30*60*1000)return a;
      return {...a,activity:{...a.activity,positions:{...s,status:'stale',reason:'持仓快照已超过 30 分钟；当前仓位待核验。'}}};
    })};
  }
  return {parse,url,evidence,validId,validSubId};
});
