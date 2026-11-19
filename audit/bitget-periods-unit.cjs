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
const day=24*60*60*1000;
model.parse(snapshot,asOf);
function evidence(ref) {
  const bytes=fs.readFileSync(path.join(root,ref.evidencePath));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.evidenceSha256);
  return JSON.parse(bytes).data;
}
for (const row of snapshot.accounts) {
  assert.equal(model.trader(row).accountId,row.portfolioId);
  for(const [period,part] of Object.entries(row.performance)) assert.equal(model.performance(row,period,asOf).fullPeriod,Date.parse(row.profileEvidence.fetchedAt)<=Date.parse(part.fetchedAt) && row.leadDays>=model.days[period]);
  const profile=evidence(row.profileEvidence);
  assert.equal(profile.publicDetail.portfolioId,row.portfolioId);
  assert.equal(model.trader(row).avatarUrl,model.avatarUrl(profile.headPic));
  assert.equal(profile.publicDetail.tradingDays,row.leadDays);
  if(row.balance) {
    assert.equal(profile.publicDetail.showBalance,true);
    assert.equal(row.balance.value,Number(evidence(row.balance).totalEquity));
  }
  if(row.transfers) {
    const matches=row.transfers.pages.flatMap(p=>evidence(p).rows.map(r=>({
      time:new Date(r.transferTime).toISOString(),kind:r.transferType===0?'in':'out',amount:Number(r.transferAmount),
      currency:r.tokenName,from:r.fromAccountType,to:r.toAccountType,evidencePath:p.evidencePath})));
    for(const r of row.transfers.rows)assert.ok(matches.some(m=>JSON.stringify(r)===JSON.stringify(m)));
  }
  for (const [period,part] of Object.entries(row.performance)) {
    const raw=evidence(part);
    assert.equal(part.roi,Number(raw.roi));
    assert.equal(part.pnl,Number(raw.profit));
    if(raw.winRate!=null)assert.ok(Math.abs(100*Number(raw.winRate)-part.winRate)<0.000001);
    if(raw.maxDrawDown!=null)assert.ok(Math.abs(100*Number(raw.maxDrawDown)-part.mdd)<0.000001);
    const evidenceCurve=evidence({evidencePath:part.curveEvidencePath,evidenceSha256:part.curveEvidenceSha256}),curve=evidenceCurve.roiRows;
    assert.equal(curve.dataCycle,model.days[period]);
    assert.deepEqual(part.curve,curve.rows.map(point=>({time:new Date(point.dataTime).toISOString(),value:Number(point.amount)})));
    if(part.pnlCurve)assert.deepEqual(part.pnlCurve,evidenceCurve.pnlRows.rows.map(p=>({time:new Date(p.dataTime).toISOString(),value:Number(p.amount)})));
    // A new directory read may retain historical period data from an earlier successful read.
    const lastSuccess=Date.parse(part.lastSuccessAt);
    assert.equal(model.performance(row,period,asOf).status,asOf-lastSuccess>day?'stale':'ready');
    assert.equal(model.performance(row,period,lastSuccess+day).status,'ready');
    assert.equal(model.performance(row,period,lastSuccess+day+1).status,'stale');
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
    if(Object.hasOwn(position,'grossPnl')) {
      assert.equal(position.grossPnl,Number(raw.pnl));
      assert.equal(position.openFee,Number(raw.openFee));
      assert.equal(position.closeFee,Number(raw.closeFee));
      assert.equal(position.fundingFee,Number(raw.capitalFeeTotal));
      assert.equal(position.stockDividend,raw.stockId?Number(raw.scdTotal):null);
    }
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
for(const bad of [undefined,'http://img.bgstatic.com/otc/images/invalid.png','https://img.bgstatic.com.evil.example/otc/images/a.png','https://img.bgstatic.com/image/other.png'])
  assert.equal(model.trader({...snapshot.accounts[0],avatarUrl:bad}).avatarUrl,null);
assert.equal(model.avatarUrl('https://img.bgstatic.com/image/third/avatar-default-1747644203.png'),'https://img.bgstatic.com/image/third/avatar-default-1747644203.png');
// A fresh profile must never upgrade a retained, shorter historical sample.
const short=structuredClone(snapshot.accounts.find(r=>r.performance['180D']));
const profileAtCapture=structuredClone(short.profileEvidence);
short.performance['180D'].accountAgeDaysAtCapture=98;
short.performance['180D'].accountAgeEvidence=profileAtCapture;
short.leadDays=200;
short.profileEvidence.fetchedAt=new Date(Date.parse(short.performance['180D'].fetchedAt)+86400000).toISOString();
assert.equal(model.performance(short,'180D',asOf).fullPeriod,false);
assert.equal(model.performance(short,'180D',asOf).accountAgeDays,98);
short.performance['180D'].accountAgeDaysAtCapture=180;
assert.equal(model.performance(short,'180D',asOf).fullPeriod,true);
delete short.performance['180D'].accountAgeDaysAtCapture;
delete short.performance['180D'].accountAgeEvidence;
assert.equal(model.performance(short,'180D',asOf).fullPeriod,false); // old archive: coverage unknown
short.profileEvidence=profileAtCapture;
assert.equal(model.performance(short,'180D',asOf).fullPeriod,true); // legacy profile observed before sample
const captured=structuredClone(snapshot);
const part=captured.accounts.find(r=>r.performance['180D']);
part.performance['180D'].accountAgeDaysAtCapture=part.leadDays;
part.performance['180D'].accountAgeEvidence=structuredClone(part.profileEvidence);
model.parse(captured,asOf);
part.performance['180D'].accountAgeEvidence.fetchedAt=new Date(Date.parse(part.performance['180D'].fetchedAt)+1000).toISOString();
assert.throws(()=>model.parse(captured,asOf));
const invalid=structuredClone(snapshot);
invalid.accounts[0].performance['365D']=invalid.accounts[0].performance['90D'];
assert.throws(()=>model.parse(invalid,asOf));
const replaced=structuredClone(snapshot);
replaced.accounts[0].performance['90D'].curveEvidencePath=replaced.accounts[0].performance['30D'].curveEvidencePath;
assert.throws(()=>model.parse(replaced,asOf));
assert.throws(()=>collector.activity({data:{strategySafe:true,rows:[{}]}},false,'irrelevant'),/protected/);
assert.throws(()=>collector.receipt('test','performance',{portfolioId:'1'},Buffer.from('{}'),{method:'POST',url:'bad'}),/receipt/);
(async()=>{
  const rankData=evidence(snapshot.rankEvidence);
  const rank={...snapshot.rankEvidence,fetchedAt:snapshot.generatedAt,bytes:Buffer.from('{}'),data:rankData};
  let calls=[];
  await assert.rejects(collector.collect(async(name)=>{calls.push(name);if(name==='leaders-aum')return {...rank,data:{...rankData,nextFlag:true}};throw Object.assign(Error('blocked'),{stopReason:'http_429'});}),/blocked/);
  assert.deepEqual(calls,['leaders-aum','leaders-aum-2']);
  calls=[];
  const old=structuredClone(snapshot);
  const result=await collector.collect(async(name)=>{calls.push(name);if(name==='leaders-aum')return rank;throw Error('temporary failure');},undefined,old);
  assert.deepEqual(result.bundle.accounts.map(r=>r.portfolioId),old.accounts.map(r=>r.portfolioId));
  assert.ok(result.bundle.accounts.every(r=>r.catalogStatus==='retained'));
  assert.equal(result.bundle.accounts[0].profileEvidence.fetchedAt,old.accounts[0].profileEvidence.fetchedAt);
  const os=require('node:os'),fsp=require('node:fs/promises');const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'bitget-stop-'));
  try {assert.equal(await collector.readStop(dir),null);await collector.writeStop(dir,'http_403');assert.equal((await collector.readStop(dir)).reason,'http_403');await assert.rejects(collector.writeStop(dir,'invalid'));}finally{await fsp.rm(dir,{recursive:true,force:true});}
  console.log('Bitget public evidence, period coverage, partial failures and source stop verified');
})().catch(err=>{console.error(err);process.exitCode=1});
