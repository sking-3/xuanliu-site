'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const m=require('../trader/okx-period-data.js');
const {select,curve,receipt,collect,mergeDirectory,publish}=require('../scripts/collect_okx_periods.cjs');
const guard=require('../scripts/okx_source_guard.cjs');
const day=86400000, end=Date.parse('2026-01-01T00:00:00Z'),received=new Date(end+1800000).toISOString();
const id='5B123E456F789A11';
function series(period,ratio='0.34'){
  const n=m.days[period];
  return {code:'0',data:Array.from({length:n+1},(_,i)=>({beginTs:String(end-i*day),pnl:i===n?'0':'100',pnlRatio:i===n?'0':ratio}))};
}
const leader={uniqueCode:id,nickName:'Public A',ccy:'USDT',leadDays:'400',copyTraderNum:'11',pnl:'100',pnlRatio:'0.34',pnlRatios:[{beginTs:String(end),pnlRatio:'0.34'}]};
function board(list){return {code:'0',data:[{dataVer:'20260101000000',ranks:list}]};}
function fixture(receipts={},who=leader){return async(name,url)=>{
  if(name.includes('-stats-')&&!Object.hasOwn(receipts,name))throw Object.assign(Error('no saved stats receipt'),{code:'ENOENT'});
  const p=Object.entries(m.ranges).find(([,code])=>name===who.uniqueCode+'-'+code)?.[0];
  const data=receipts[name]||(name==='leaders'?board([who]):series(p,p==='365D'?'0.81':'0.34'));
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
test('rank-matched OKX curves can omit one daily bucket without shifting the source window',async()=>{
  const gapped=series('90D');
  gapped.data.splice(1,1);
  const result=await collect(fixture({[id+'-3']:gapped}));
  const snapshot=m.parse(result.bundle),window=snapshot.accounts[0].performance['90D'];
  assert.equal(window.pointCount,90);
  assert.equal(window.endTs-window.beginTs,90*day);
  assert.equal(window.roi,34);
  assert.equal(m.performance(snapshot.accounts[0],'90D').fullPeriod,true);
  const truncated=structuredClone(gapped);
  truncated.data.splice(0,1,{...truncated.data[0],beginTs:String(end-day)});
  assert.equal(curve(truncated,'90D',received),null);
  const shorter=structuredClone(gapped);
  shorter.data.splice(-2,1);
  assert.equal(curve(shorter,'90D',received),null);
  await assert.rejects(()=>collect(fixture({[id+'-3']:shorter})),/no OKX 90D curve matched/);
});
test('snapshot links authentic bytes, receiver times and ratios per selected window',async()=>{
  const result=await collect(fixture()),snap=m.parse(result.bundle,end+day);
  assert.equal(result.archive.length,5);
  assert.equal(snap.accounts[0].performance['7D'].roi,34);
  assert.equal(snap.accounts[0].performance['365D'].roi,81);
  assert.equal(m.performance(snap.accounts[0],'365D',end+3*day).status,'stale');
  assert.equal(m.trader(snap.accounts[0]).sourceKind,'okx_public_lead');
  const otherDay=series('365D');
  otherDay.data.forEach(p=>{p.beginTs=String(Number(p.beginTs)-day);});
  assert.deepEqual(Object.keys((await collect(fixture({[id+'-4']:otherDay}))).bundle.accounts[0].performance),['90D','7D','30D']);
  const wrong=series('90D','0.32');
  await assert.rejects(()=>collect(fixture({[id+'-3']:wrong})));
  snap.accounts[0].performance['90D'].evidencePath='okx/fake.json';
  assert.throws(()=>m.parse(snap),/Invalid OKX/);
});
test('official win ratio uses its own receipt for the same OKX period and account',async()=>{
  const stats=(winRatio,profitDays,lossDays,ccy='USDT')=>({code:'0',data:[{ccy,winRatio,profitDays,lossDays}]});
  const result=await collect(fixture({
    [m.statsName(id,'7D')]:stats('0','0','4'),
    [m.statsName(id,'30D')]:stats('0.6429','9','5'),
    [m.statsName(id,'90D')]:stats('0.10','7','1'),
    [m.statsName(id,'365D')]:stats('0.80','8','2','BTC')
  }));
  const account=result.bundle.accounts[0],windows=account.performance;
  assert.deepEqual(['7D','30D','90D','365D'].map(p=>m.performance(account,p).winRate),[0,64.29,null,null]);
  assert.ok(Object.values(windows).every(part=>part.mdd===null&&part.winRate===null));
  const evidence=windows['30D'].winRateEvidence;
  assert.equal(evidence.sourceUrl,m.statsUrl(id,'30D'));
  assert.equal(evidence.lastSuccessAt,received);
  assert.deepEqual([evidence.profitDays,evidence.lossDays],[9,5]);
  assert.ok(result.archive.some(row=>row.sha===evidence.evidenceSha256&&row.evidencePath===evidence.evidencePath));

  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'okx-win-ratio-'));
  try{
    await assert.rejects(()=>publish(dir,{...result,archive:result.archive.filter(row=>row.sha!==evidence.evidenceSha256)}),{code:'ENOENT'});
    await publish(dir,result);
    const saved=JSON.parse(await fs.readFile(path.join(dir,'period-returns.json'),'utf8'));
    assert.equal(m.performance(m.parse(saved).accounts[0],'30D').winRate,64.29);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
  evidence.sourceUrl=m.statsUrl(id,'7D');
  assert.throws(()=>m.parse(result.bundle),/Invalid OKX/);
});
test('an optional stats failure preserves curves while a durable source stop aborts collection',async()=>{
  const read=fixture();
  let statsAttempts=0;
  const result=await collect(async(name,url)=>{
    if(name.includes('-stats-')){statsAttempts++;throw Error('temporary stats read failure');}
    return read(name,url);
  });
  assert.equal(statsAttempts,1);
  assert.deepEqual(Object.keys(result.bundle.accounts[0].performance),['90D','7D','30D','365D']);
  assert.ok(Object.values(result.bundle.accounts[0].performance).every(part=>part.winRateEvidence===undefined));
  await assert.rejects(()=>collect(async(name,url)=>{
    if(name.includes('-stats-'))throw guard.error(429);
    return read(name,url);
  }),{code:'OKX_SOURCE_STOPPED'});
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
test('refresh retains departed traders and previously verified windows with their evidence and original time',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'okx-archive-'));
  try{
    const old=await collect(fixture());
    await publish(dir,old);
    const newer=await collect(fixture({}, {...leader,uniqueCode:'5B123E456F789A22',nickName:'Public B'}));
    await publish(dir,newer);
    const result=m.parse(JSON.parse(await fs.readFile(path.join(dir,'period-returns.json'),'utf8')));
    assert.equal(result.accounts.length,2);
    const archived=result.accounts.find(row=>row.uniqueCode===id);
    assert.equal(m.trader(archived).selectionStatus,'historical');
    assert.deepEqual(archived.performance,old.bundle.accounts[0].performance);
    assert.equal(archived.selection.rankEvidenceSha256,old.bundle.rankEvidenceSha256);
    assert.equal(archived.selection.rankFetchedAt,old.bundle.rankFetchedAt);
    assert.equal(m.performance(archived,'30D',end+day).status,'ready');
    assert.equal(m.performance(archived,'30D',Date.parse(received)+day+1).status,'stale');
    const later=structuredClone(old.bundle);delete later.accounts[0].performance['365D'];
    later.rankFetchedAt=new Date(Date.parse(later.rankFetchedAt)+day).toISOString();
    later.generatedAt=new Date(Date.parse(later.generatedAt)+day).toISOString();
    for(const part of Object.values(later.accounts[0].performance)){
      part.beginTs+=day;part.endTs+=day;
      part.lastSuccessAt=new Date(Date.parse(part.lastSuccessAt)+day).toISOString();
    }
    const restored=mergeDirectory(old.bundle,later).accounts[0];
    assert.deepEqual(restored.performance['365D'],old.bundle.accounts[0].performance['365D']);
    assert.notEqual(restored.performance['365D'].endTs,restored.performance['90D'].endTs);
    assert.notEqual(restored.performance['365D'].lastSuccessAt,restored.performance['90D'].lastSuccessAt);
    assert.equal(m.trader(restored).selectionStatus,'current');
    await fs.rm(path.join(dir,'evidence',path.basename(archived.performance['30D'].evidencePath)));
    const before=await fs.readFile(path.join(dir,'period-returns.json'),'utf8');
    await assert.rejects(()=>publish(dir,newer));
    assert.equal(await fs.readFile(path.join(dir,'period-returns.json'),'utf8'),before);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('provider refusal persists and prevents the next scheduled collection',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'okx-stop-')),file=path.join(dir,'source-stop.json');
  try{
    await guard.check(file);
    await assert.rejects(()=>guard.stop(429,file),{code:'OKX_SOURCE_STOPPED'});
    await assert.rejects(()=>guard.check(file),{code:'OKX_SOURCE_STOPPED'});
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).httpStatus,429);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the bounded directory refuses growth without discarding historical records',async()=>{
  const base=(await collect(fixture())).bundle;
  function clone(n,historical){
    const row=structuredClone(base.accounts[0]),id='A'+String(n).padStart(15,'0');
    row.uniqueCode=id;row.sourceUrl=m.accountSourceUrl(id);
    for(const [p,part] of Object.entries(row.performance)){
      part.sourceUrl=m.curveUrl(id,p);part.evidencePath=m.evidencePath(id+'-'+m.ranges[p],part.evidenceSha256);
    }
    if(historical)row.selection={status:'historical',rankEvidencePath:base.rankEvidencePath,rankEvidenceSha256:base.rankEvidenceSha256,
      rankSourceUrl:base.rankSourceUrl,rankFetchedAt:base.rankFetchedAt,rankVersion:base.rankVersion};
    return row;
  }
  const previous={...base,accounts:Array.from({length:m.archiveLimit},(_,i)=>clone(i,i>=m.limit))};
  const next={...base,accounts:[clone(m.archiveLimit,false)]};
  m.parse(previous);
  assert.throws(()=>mergeDirectory(previous,next),/archive limit/);
  assert.equal(previous.accounts.length,m.archiveLimit);
});

test('directory photos map each portfolio to its head image in the hash-verified rank archive',async()=>{
  const root=path.join(__dirname,'../trader');
  const raw=JSON.parse(await fs.readFile(path.join(root,'okx/period-returns.json')));
  for(const row of m.parse(raw,Date.parse(raw.generatedAt)).accounts){
    const rankRef=row.selection||raw;
    const bytes=await fs.readFile(path.join(root,rankRef.rankEvidencePath));
    assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),rankRef.rankEvidenceSha256);
    const rank=JSON.parse(bytes).data[0].ranks;
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

test('all saved OKX IDs refresh after leaving the positive ranking, with zero followers',async()=>{
  const old=await collect(fixture());
  const other={...leader,uniqueCode:'5B123E456F789A22',nickName:'New leader'};
  const read=fixture({},other),calls=[];
  const refreshed=await collect(async(name,url)=>{
    calls.push(name);
    if(name.startsWith(id+'-')){
      if(name.includes('-stats-'))throw Object.assign(Error('optional stats absent'),{code:'ENOENT'});
      const period=Object.entries(m.ranges).find(([,code])=>name===id+'-'+code)[0];
      const data=series(period,'-0.15'),bytes=Buffer.from(JSON.stringify(data));
      return receipt(name,url,bytes,{name,sourceUrl:url,httpStatus:200,code:'0',receivedAt:received,bytes:bytes.length});
    }
    return read(name,url);
  },undefined,old.bundle);
  const archived=refreshed.bundle.accounts.find(row=>row.uniqueCode===id);
  assert.ok(calls.includes(id+'-2'));
  assert.equal(archived.performance['90D'].roi,-15);
  assert.equal(archived.performance['30D'].roi,-15);
  assert.equal(archived.selection.status,'historical');
  assert.equal(m.performance(archived,'30D',Date.parse(received)+1000).status,'ready');
  archived.copyTraderNum=0;
  m.parse(refreshed.bundle);
});

test('OKX retains per-period timestamps and rejects an older returned window',async()=>{
  const current=await collect(fixture());
  const prior=structuredClone(current.bundle),period=prior.accounts[0].performance['30D'];
  period.endTs+=day;period.beginTs+=day;
  period.lastSuccessAt=new Date(Date.parse(received)+day).toISOString();
  prior.generatedAt=period.lastSuccessAt;
  const later=new Date(Date.parse(received)+2*day).toISOString();
  const result=mergeDirectory(prior,{...current.bundle,rankFetchedAt:later,generatedAt:later});
  assert.equal(result.accounts[0].performance['30D'].endTs,period.endTs);
  assert.equal(result.accounts[0].performance['30D'].lastSuccessAt,period.lastSuccessAt);
});

test('saved Bitget IDs refresh negative returns and zero followers even without closed history',async()=>{
  const BG=require('../trader/bitget-period-data.js'),C=require('../scripts/collect_bitget_periods.cjs');
  const root=path.join(__dirname,'../trader');
  const previous=JSON.parse(await fs.readFile(path.join(root,'bitget/period-returns.json'),'utf8'));
  const byId=new Map(previous.accounts.map(row=>[row.portfolioId,row]));
  const at=new Date(Date.parse(previous.generatedAt)+60000).toISOString(),calls=[];
  const original=async ref=>JSON.parse(await fs.readFile(path.join(root,ref.evidencePath),'utf8'));
  const result=await C.collect(async(name,route,body)=>{
    calls.push({name,route,id:body.portfolioId});
    let raw;
    if(route==='traderView')raw={code:'200',data:{rows:[],nextFlag:false}};
    else{
      const row=byId.get(body.portfolioId);
      if(route==='details'){
        raw=await original(row.profileEvidence);
        raw.data.publicDetail.curFollowCount=0;raw.data.publicDetail.aum=0;
        raw.data.publicDetail.showBalance=false;
      }else if(route==='historyPosition')raw={code:'200',data:{rows:[],nextFlag:false}};
      else if(route==='currentPosition')raw={code:'200',data:{rows:[],strategySafe:false}};
      else if(route==='performance'){
        raw=await original(row.performance[body.cycleTime+'D']);
        raw.data.roi=-15;raw.data.profit=-100;
      }else if(route==='cycleChartData')raw=await original({evidencePath:row.performance[body.cycleTime+'D'].curveEvidencePath});
      else throw Error('unexpected request '+route);
    }
    const bytes=Buffer.from(JSON.stringify(raw)),url='https://www.bitget.com/v1/trigger/public/uta/'+route;
    return C.receipt(name,route,body,bytes,{method:'POST',url,body,fetchedAt:at,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')});
  },undefined,previous);
  assert.equal(result.bundle.accounts.length,previous.accounts.length);
  assert.deepEqual(new Set(calls.filter(c=>c.route==='details').map(c=>c.id)),new Set(byId.keys()));
  for(const row of result.bundle.accounts){
    assert.equal(row.performance['90D'].roi,-15);
    assert.equal(row.performance['30D'].roi,-15);
    assert.equal(row.performance['30D'].lastSuccessAt,at);
    assert.equal(row.copyTraderNum,0);
    assert.equal(row.activity.history.status,'empty');
    assert.equal(row.catalogStatus,'retained');
    assert.equal(BG.performance(row,'30D',Date.parse(at)).status,'ready');
    assert.equal(BG.performance(row,'365D',Date.parse(at)).fullPeriod,false);
  }
  assert.ok(!calls.some(call=>call.name.endsWith('365')));
  BG.parse(result.bundle,Date.parse(at));
});

test('a Bitget source rejection halts the entire saved-account sweep',async()=>{
  const C=require('../scripts/collect_bitget_periods.cjs');
  const previous=JSON.parse(await fs.readFile(path.join(__dirname,'../trader/bitget/period-returns.json'),'utf8'));
  const at=previous.generatedAt,calls=[];
  await assert.rejects(()=>C.collect(async(name,route,body)=>{
    calls.push(name);
    if(route==='traderView'){
      const raw={code:'200',data:{rows:[],nextFlag:false}},bytes=Buffer.from(JSON.stringify(raw));
      return C.receipt(name,route,body,bytes,{method:'POST',url:'https://www.bitget.com/v1/trigger/public/uta/'+route,body,fetchedAt:at,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')});
    }
    throw Object.assign(Error('source refused'),{stopReason:'http_429'});
  },undefined,previous),/source refused/);
  assert.equal(calls.length,2);
});
