'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const m=require('../trader/okx-period-data.js');
const {select,curve,receipt,collect,publish}=require('../scripts/collect_okx_periods.cjs');
const day=86400000, end=Date.parse('2026-01-01T00:00:00Z'),received=new Date(end+1800000).toISOString();
const id='5B123E456F789A11';
function series(period,ratio='0.34'){
  const n=m.days[period];
  return {code:'0',data:Array.from({length:n+1},(_,i)=>({beginTs:String(end-i*day),pnl:i===n?'0':'100',pnlRatio:i===n?'0':ratio}))};
}
const leader={uniqueCode:id,nickName:'Public A',ccy:'USDT',leadDays:'400',copyTraderNum:'11',pnl:'100',pnlRatio:'0.34',pnlRatios:[{beginTs:String(end),pnlRatio:'0.34'}]};
function board(list){return {code:'0',data:[{dataVer:'20260101000000',ranks:list}]};}
function fixture(receipts={}){return async(name,url)=>{
  const p=Object.entries(m.ranges).find(([,code])=>name===id+'-'+code)?.[0];
  const data=receipts[name]||(name==='leaders'?board([leader]):series(p,p==='365D'?'0.81':'0.34'));
  const bytes=Buffer.from(JSON.stringify(data));
  return receipt(name,url,bytes,{name,sourceUrl:url,httpStatus:200,code:'0',receivedAt:received,bytes:bytes.length});
};}
test('public sample verifies eligibility, deterministic rank, and six-account maximum',()=>{
  const list=Array.from({length:10},(_,i)=>({...leader,uniqueCode:'A'+String(i).padStart(15,'0'),pnlRatio:String(i/100)}));
  list[9].copyTraderNum='0';list[8].leadDays='89';list[7].ccy='BTC';
  assert.deepEqual(select(board(list)).map(r=>r.uniqueCode),list.slice(1,7).reverse().map(r=>r.uniqueCode));
  assert.throws(()=>select(board([leader,leader])),/duplicate/);
});
test('curves require full elapsed days and zero baseline, independently of requested period name',()=>{
  const raw=series('365D');assert.equal(curve(raw,'365D',received).roi,34);
  assert.equal(curve(raw,'90D',received),null);
  raw.data.at(-1).pnl='1';assert.equal(curve(raw,'365D',received),null);raw.data.at(-1).pnl='0';
  raw.data[5].beginTs=raw.data[6].beginTs;assert.equal(curve(raw,'365D',received),null);
  assert.equal(curve(series('30D'),'30D',new Date(end+3*day).toISOString()),null);
});
test('snapshot links authentic bytes, receiver times and ratios per selected window',async()=>{
  const result=await collect(fixture()),snap=m.parse(result.bundle,end+day);
  assert.equal(result.archive.length,4);
  assert.equal(snap.accounts[0].performance['365D'].roi,81);
  assert.equal(m.performance(snap.accounts[0],'365D',end+3*day).status,'stale');
  assert.equal(m.trader(snap.accounts[0]).sourceKind,'okx_public_lead');
  const otherDay=series('365D');
  otherDay.data.forEach(p=>{p.beginTs=String(Number(p.beginTs)-day);});
  assert.deepEqual(Object.keys((await collect(fixture({[id+'-4']:otherDay}))).bundle.accounts[0].performance),['90D','30D']);
  const wrong=series('90D','0.32');
  await assert.rejects(()=>collect(fixture({[id+'-3']:wrong})));
  snap.accounts[0].performance['90D'].evidencePath='okx/fake.json';
  assert.throws(()=>m.parse(snap),/Invalid OKX/);
});
test('published evidence remains intact on a rejected replacement, supports retry',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'okx-periods-'));
  try{
    const good=await collect(fixture());
    await publish(dir,good);await publish(dir,good);
    const out=path.join(dir,'period-returns.json'),old=await fs.readFile(out,'utf8');
    await assert.rejects(()=>publish(dir,{...good,bundle:{...good.bundle,rankFetchedAt:'2025-01-01T00:00:00.000Z'}}));
    assert.equal(await fs.readFile(out,'utf8'),old);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('directory photos map each portfolio to its head image in the hash-verified rank archive',async()=>{
  const root=path.join(__dirname,'../trader');
  const raw=JSON.parse(await fs.readFile(path.join(root,'okx/period-returns.json')));
  const bytes=await fs.readFile(path.join(root,raw.rankEvidencePath));
  assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),raw.rankEvidenceSha256);
  const rank=JSON.parse(bytes).data[0].ranks;
  for(const row of m.parse(raw,Date.parse(raw.generatedAt)).accounts){
    const pub=rank.find(r=>r.uniqueCode===row.uniqueCode);
    assert.ok(pub);
    assert.equal(m.trader(row).avatarUrl,m.avatarUrl(pub.portLink));
  }
  const url='https://static.okx.com/cdn/okex/users/headimages/predefined/0008.png';
  const good=await collect(fixture({leaders:board([{...leader,portLink:url}])}));
  assert.equal(m.trader(good.bundle.accounts[0]).avatarUrl,url);
  for(const bad of [undefined,'https://static.okx.com.other.com/cdn/okex/users/headimages/1','https://static.okx.com/cdn/unrelated'])
    assert.equal(m.trader({...good.bundle.accounts[0],avatarUrl:bad}).avatarUrl,null);
});
