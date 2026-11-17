'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {capture,decode,profile,performance,merge,write,ids,urlFor,assertLiveAllowed}=require('../scripts/collect_binance_periods.cjs');
const id=ids[0], at='2024-02-18T10:00:00.000Z', later='2024-02-19T10:00:00.000Z';
const empty={schemaVersion:1,generatedAt:null,accounts:[]};
const profileData={leadPortfolioId:id,publicLeadPortfolioId:id,nickname:'测试账户',portfolioType:'PUBLIC',
  status:'ACTIVE',startTime:Date.parse('2023-10-01T00:00:00Z'),positionShow:false};
function receipt(period,data,receivedAt=at) {
  const body=Buffer.from(JSON.stringify({code:'000000',success:true,data})+'\n');
  return {portfolioId:id,period,sourceUrl:urlFor(id,period),receivedAt,httpStatus:200,bodyBase64:body.toString('base64')};
}
const person=receipt('profile',profileData);
const month=receipt('30D',{timeRange:'30D',roi:12.34,pnl:52,winRate:60});
const quarter=receipt('90D',{timeRange:'90D',roi:-2,pnl:95,winRate:0});
const annual=receipt('365D',{timeRange:'365D',roi:0,pnl:123});

test('live capture fails closed unless both source and run inventory are approved',()=>{
  assert.throws(()=>assertLiveAllowed(null),/paused/);
  assert.throws(()=>assertLiveAllowed({binancePublicCollector:'approved'}),/paused/);
  assert.throws(()=>assertLiveAllowed({binancePublicCollector:'approved',githubRunInventory:'stopped_after_queue_403'}),/paused/);
  assert.throws(()=>assertLiveAllowed({binancePublicCollector:'paused_pending_permission_and_frequency',githubRunInventory:'approved'}),/paused/);
  assert.doesNotThrow(()=>assertLiveAllowed({binancePublicCollector:'approved',githubRunInventory:'approved'}));
});

test('public identity and trading start date are verified independently from position visibility',()=>{
  const a=profile(decode(person));
  assert.equal(a.positionShow,false);assert.equal(a.startTime,profileData.startTime);
  for(const patch of [{leadPortfolioId:'999'},{portfolioType:'PRIVATE'},{status:'CLOSED'},{startTime:0}])
    assert.throws(()=>profile(decode(receipt('profile',{...profileData,...patch}))));
  assert.throws(()=>decode({...person,sourceUrl:urlFor(ids[1],'profile')}));
});
test('requires exact period and actual ROI; accepts a genuine zero or loss',()=>{
  const a=profile(decode(person));
  assert.equal(performance(decode(quarter),a).roi,-2);
  const x=performance(decode(annual),a);
  assert.equal(x.roi,0);assert.equal(x.sourceAsOf,null);assert.equal(x.mdd,null);assert.equal(x.evidence.bytes,Buffer.from(annual.bodyBase64,'base64').length);
  assert.equal(x.portfolioStartedAt,new Date(a.startTime).toISOString());
  for(const data of [{timeRange:'30D',roi:1},{timeRange:'365D',pnl:500},{timeRange:'365D',roi:1,portfolioId:ids[1]}])
    assert.throws(()=>performance(decode(receipt('365D',data)),a));
});
test('30-day public results are retained with the exact account, period and source evidence',()=>{
  const first=merge(empty,[person,month,quarter,annual]);
  const row=first.out.accounts[0], model=require('../trader/binance-data.js');
  assert.equal(row.performance.byPeriod['30D'].roi,12.34);
  assert.equal(row.performance.byPeriod['90D'].roi,-2);
  assert.equal(row.performance.byPeriod['365D'].roi,0);
  assert.equal(model.parsePeriodReturns(first.out,Date.parse(at)).accounts[0].performance.byPeriod['30D'].roi,12.34);
  assert.throws(()=>performance(decode(receipt('30D',{timeRange:'90D',roi:4})),profile(decode(person))),/wrong_period_or_account/);
  const denied=merge(first.out,[receipt('profile',profileData,later)],[{id,period:'30D',at:later,code:'http_403'}]);
  const kept=denied.out.accounts[0].performance.byPeriod;
  assert.equal(kept['30D'].status,'stale');assert.equal(kept['30D'].roi,12.34);
  assert.equal(kept['30D'].evidencePath,row.performance.byPeriod['30D'].evidencePath);
  assert.equal(kept['90D'].roi,-2);assert.equal(kept['365D'].roi,0);
});
test('stale windows retain their evidence, older input cannot replace fresher successful data',()=>{
  const first=merge(empty,[annual,person,quarter]);
  const before=first.out.accounts[0].performance.byPeriod['365D'];
  const next=merge(first.out,[receipt('profile',profileData,later)], [{id,period:'365D',at:later,code:'http_503'}]);
  const current=next.out.accounts[0].performance.byPeriod['365D'];
  assert.equal(current.status,'stale');assert.equal(current.lastSuccessAt,before.lastSuccessAt);
  assert.equal(current.evidencePath,before.evidencePath);
  assert.deepEqual(merge(next.out,[person,annual]).out,next.out);
  assert.throws(()=>merge(empty,[annual]),/missing_profile/);
  assert.throws(()=>merge(empty,[person,quarter,quarter]),/duplicate_receipt/);
});
test('atomically stores original bytes and only removes obsolete evidence after publishing the new references',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'period-proof-'));
  try {
    fs.mkdirSync(path.join(root,'binance'));
    const file=path.join(root,'binance','period-returns.json');
    const first=write(file,[person,month,quarter,annual],[]);
    const old=first.accounts[0].performance.byPeriod, prev=old['90D'].evidencePath;
    assert.deepEqual(fs.readFileSync(path.join(root,prev)),Buffer.from(quarter.bodyBase64,'base64'));
    assert.deepEqual(fs.readFileSync(path.join(root,old['30D'].evidencePath)),Buffer.from(month.bodyBase64,'base64'));
    const q=receipt('90D',{timeRange:'90D',roi:6,pnl:100},later);
    const profile2=receipt('profile',{...profileData,nickname:'新昵称'},later);
    write(file,[profile2,q],[]);
    assert.equal(fs.existsSync(path.join(root,prev)),false);
    // The other window still cites the earlier profile.
    assert.equal(fs.existsSync(path.join(root,old['365D'].profileEvidencePath)),true);
    assert.equal(fs.existsSync(path.join(root,old['30D'].evidencePath)),true);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('an explicit source restriction stops the run and never queries private trading endpoints',async()=>{
  let count=0;
  const {receipts,failures}=await capture(async(url,opts)=>{
    assert.notEqual(opts.method,'POST');
    assert.ok([urlFor(id,'profile'),urlFor(id,'30D')].includes(url));
    count++;
    return count===1?new Response(Buffer.from(person.bodyBase64,'base64'),{headers:{'content-type':'application/json'}}):new Response('',{status:451});
  },async()=>{});
  assert.equal(count,2);assert.equal(receipts.length,1);assert.equal(failures[0].code,'http_451');
});

test('period directory assigns each account its own archived Binance avatar',()=>{
  const model=require('../trader/binance-data.js');
  const root=path.join(__dirname,'../trader'),raw=JSON.parse(fs.readFileSync(path.join(root,'binance/period-returns.json')));
  const view=model.parsePeriodReturns(raw,Date.parse(raw.generatedAt));
  for (const row of view.accounts) {
    const bytes=fs.readFileSync(path.join(root,row.profileEvidencePath));
    assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),row.profileEvidenceSha256);
    const data=JSON.parse(bytes).data;
    assert.equal(data.leadPortfolioId,row.portfolioId);
    assert.equal(model.periodTrader(row).avatarUrl,model.avatarUrl(data.avatarUrl));
  }
  const avatar='https://public.bnbstatic.com/image/avatar/202407/official.jpg';
  assert.equal(profile(decode(receipt('profile',{...profileData,avatarUrl:avatar}))).avatarUrl,avatar);
  assert.equal(model.periodTrader({...view.accounts[0],avatarUrl:'https://example.org/other.png'}).avatarUrl,null);
  assert.equal(model.periodTrader({...view.accounts[0],avatarUrl:undefined}).avatarUrl,null);
});
