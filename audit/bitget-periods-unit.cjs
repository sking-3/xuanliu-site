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
  const open=evidence(row.activity.positions),history=evidence(row.activity.history);
  if(open.strategySafe)assert.equal(row.activity.positions.status,'restricted');
  assert.equal(row.activity.positions.rows.length,open.rows.length);
  assert.equal(row.activity.history.rows.length,Math.min(10,history.rows.length));
  row.activity.history.rows.forEach((position,i)=>{
    assert.equal(position.id,history.rows[i].id);
    assert.equal(position.realizedPnl,Number(history.rows[i].positionPnl));
    assert.equal(position.closedAt,new Date(history.rows[i].closeTime).toISOString());
  });
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
