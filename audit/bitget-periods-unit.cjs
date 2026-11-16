'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const model=require('../trader/bitget-period-data.js');
const collector=require('../scripts/collect_bitget_periods.cjs');
const root=path.join(__dirname,'../trader');
const snapshot=JSON.parse(fs.readFileSync(path.join(root,'bitget/period-returns.json')));
const asOf=Date.parse(snapshot.generatedAt);
model.parse(snapshot,asOf);
function evidence(ref) {
  const bytes=fs.readFileSync(path.join(root,ref.evidencePath));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.evidenceSha256);
  return JSON.parse(bytes).data;
}
for (const row of snapshot.accounts) {
  assert.equal(model.trader(row).accountId,row.portfolioId);
  assert.equal(model.performance(row,'365D',asOf),null);
  const profile=evidence(row.profileEvidence);
  assert.equal(profile.publicDetail.portfolioId,row.portfolioId);
  assert.equal(profile.publicDetail.tradingDays,row.leadDays);
  for (const [period,part] of Object.entries(row.performance)) {
    const raw=evidence(part);
    assert.equal(part.roi,Number(raw.roi));
    assert.equal(part.pnl,Number(raw.profit));
    if(raw.winRate!=null)assert.ok(Math.abs(100*Number(raw.winRate)-part.winRate)<0.000001);
    if(raw.maxDrawDown!=null)assert.ok(Math.abs(100*Number(raw.maxDrawDown)-part.mdd)<0.000001);
    const curve=evidence({evidencePath:part.curveEvidencePath,evidenceSha256:part.curveEvidenceSha256}).roiRows;
    assert.equal(curve.dataCycle,model.days[period]);
    assert.deepEqual(part.curve,curve.rows.map(point=>({time:new Date(point.dataTime).toISOString(),value:Number(point.amount)})));
    assert.equal(model.performance(row,period,asOf).status,'ready');
    assert.equal(model.performance(row,period,asOf+86400001).status,'stale');
  }
  const open=evidence(row.activity.positions),history=row.activity.history;
  if(open.strategySafe)assert.equal(row.activity.positions.status,'restricted');
  assert.equal(row.activity.positions.rows.length,open.rows.length);
  const sourcePages=new Map();
  for(const page of [...history.pages,...(history.priorPages||[])]) {
    const data=evidence(page);
    assert.equal(page.rowCount,data.rows.length);
    assert.equal(page.hasMore,data.nextFlag);
    sourcePages.set(page.evidencePath,new Map(data.rows.map(r=>[r.id,r])));
  }
  assert.equal(history.pagesFetched,history.pages.length);
  assert.equal(history.truncated,history.pages.at(-1).hasMore);
  history.rows.forEach(position=>{
    const raw=sourcePages.get(position.evidencePath).get(position.id);
    assert.ok(raw);
    assert.equal(position.realizedPnl,Number(raw.positionPnl));
    assert.equal(position.closedAt,new Date(raw.closeTime).toISOString());
  });
  // A subsequent page may contain only the newest records. Preserve every earlier ID and its evidence.
  const first=history.pages[0],tail={...history,rows:history.rows.filter(r=>r.evidencePath===first.evidencePath),
    pages:[first],pagesFetched:1,hasMore:first.hasMore,truncated:first.hasMore};
  const merged=collector.mergeHistory(tail,history,row.portfolioId);
  assert.deepEqual(merged.rows.map(r=>r.id),history.rows.map(r=>r.id));
  assert.ok(history.pages.slice(1).every(p=>merged.priorPages.some(ref=>ref.evidencePath===p.evidencePath)));
  const proof=structuredClone(snapshot);proof.accounts.find(x=>x.portfolioId===row.portfolioId).activity.history=merged;
  model.parse(proof,asOf);
}
const invalid=structuredClone(snapshot);
invalid.accounts[0].performance['365D']=invalid.accounts[0].performance['90D'];
assert.throws(()=>model.parse(invalid,asOf));
const replaced=structuredClone(snapshot);
replaced.accounts[0].performance['90D'].curveEvidencePath=replaced.accounts[0].performance['30D'].curveEvidencePath;
assert.throws(()=>model.parse(replaced,asOf));
assert.throws(()=>collector.activity({data:{strategySafe:true,rows:[{}]}},false,'irrelevant'),/protected/);
assert.throws(()=>collector.receipt('test','performance',{portfolioId:'1'},Buffer.from('{}'),{method:'POST',url:'bad'}),/receipt/);
console.log('Bitget public portfolios, primary evidence, return units, daily curves and privacy states verified');
