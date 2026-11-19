'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {collect,main,PublicSource,retryTime,atomicBundle}=require('../scripts/collect_period_samples.cjs');
const {fromEvidence,validateState:validateFills}=require('../scripts/collect_hyperliquid_fills.cjs');
const {createHash}=require('node:crypto');
const DAY=86400000,now=Date.parse('2026-11-20T00:00:00Z'),iso=t=>new Date(t).toISOString();
const address=i=>'0x'+String(i).repeat(40),sha='a'.repeat(64);
function fixture(ids=[address(1)]){
  return {feed:{schemaVersion:1,status:'ready',source:{id:'hyperliquid',url:'https://app.hyperliquid.xyz/leaderboard',
    status:'ok',selectedAccounts:ids.length,fetchedAt:iso(now),rawSha256:sha,
    positionVerification:{scope:'default_perp_dex',stopCode:null,completedAt:iso(now-1000),failedAccounts:0,unattemptedAccounts:0}},traders:ids.map(accountId=>({
      accountId,sourceKind:'public_account',exchange:'Hyperliquid',positionCheck:{scope:'default_perp_dex',count:1},windows:Object.fromEntries(['7D','30D','ALL'].map(period=>[period,
        {asOf:iso(now),asOfType:'source',roi:20,pnl:200}]))}))},
    analyticsState:{schemaVersion:1,methodVersion:'closing-fill-v1',source:{id:'hyperliquid',endpoint:'https://api.hyperliquid.xyz/info',status:'ready',stopCode:null,accounts:0},accounts:{}},
    portfolioState:{schemaVersion:1,methodVersion:'portfolio-periods-v2',source:{id:'hyperliquid',endpoint:'https://api.hyperliquid.xyz/info',status:'ready',stopCode:null,accounts:0},accounts:{}},
    feedSha256:sha};
}
const portfolio=()=>['perpWeek','perpMonth','perpAllTime'].map(name=>[name,{
  pnlHistory:[[now-31*DAY,'100'],[now-20*DAY,'110'],[now-DAY,'120'],[now,'115']],
  accountValueHistory:[[now-31*DAY,'1000'],[now-20*DAY,'1100'],[now-DAY,'1200'],[now,'1150']],vlm:'0'}]);
const fill=(at,pnl,tid=1)=>({coin:'BTC',time:at,dir:'Close Long',side:'A',px:'70000',sz:'1',startPosition:'2',closedPnl:String(pnl),fee:'0',
  feeToken:'USDC',tid,oid:tid,hash:'0x'+String(tid).repeat(64)});
function mocks(overrides={}){
  const requests=[];let clock=now;
  return {requests,now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    return new Response(JSON.stringify(overrides[body.type]|| (body.type==='portfolio'?portfolio():[
      fill(now-40*DAY,-2),fill(now-20*DAY,2,2),fill(now-DAY,0,3)])),{headers:{'content-type':'application/json'}});
  }};
}
test('six periods contain only actual same-window source points and closing fills',async()=>{
  const m=mocks(),result=await collect({...fixture(),...m}),w=result.accounts[address(1)];
  assert.equal(m.requests.length,2);assert.equal(w['30D'].native.roi,20);
  assert.equal(w['30D'].win.value,50);assert.equal(w['30D'].win.count,2);
  assert.equal(w['7D'].win.value,0);assert.equal(w['7D'].win.count,1);
  assert.equal(w.ALL.win.count,3);assert.equal(w['30D'].mdd.startAt,iso(now-20*DAY));
  assert(w['30D'].curve.every(p=>Date.parse(p.time)>=now-30*DAY));
});
test('existing samples are not replayed: every batch reads every address anew',async()=>{
  const first=mocks(),old=await collect({...fixture(),...first});
  const second=mocks(),fresh=await collect({...fixture(),...second,previous:old});
  assert.equal(second.requests.length,2);assert.notEqual(fresh.runId,old.runId);
  assert.equal(fresh.sourcePolicy.requestCount,2);
});
test('newly added account follows the same dynamic feed and native windows',async()=>{
  const m=mocks(),result=await collect({...fixture([address(1),address(2)]),...m});
  assert.deepEqual(Object.keys(result.accounts),[address(1),address(2)]);
  assert.equal(m.requests.length,4);assert.equal(result.accounts[address(2)]['30D'].native.pnl,200);
});
test('a legitimate account without perpetual history keeps six honest empty windows and real closing fills',async()=>{
  const m=mocks(),result=await collect({...fixture([address(1),address(2)]),...m,
    fetch:async(url,options)=>{
      const body=JSON.parse(options.body);
      if(body.user===address(2)&&body.type==='portfolio')return new Response('[]',{headers:{'content-type':'application/json'}});
      return m.fetch(url,options);
    }});
  const windows=result.accounts[address(2)];assert.equal(Object.keys(windows).length,6);
  assert.equal(result.sourcePolicy.requestCount,4);assert.notEqual(result.accounts[address(1)]['30D'].mdd,null);
  for(const row of Object.values(windows)){
    assert.equal(row.mdd,null);assert.deepEqual(row.curve,[]);
    assert.equal(row.historyStartAt,null);assert.equal(row.historyEndAt,null);
    assert.equal(row.anchorAt,iso(now));assert.notEqual(row.observedAt,null);
    assert.equal(row.missingReasons.history,'missing_perp_all_time_history');
  }
  assert.equal(windows['30D'].native.roi,20);assert.equal(windows['30D'].native.pnl,200);
  assert.equal(windows['30D'].win.value,50);assert.equal(windows['7D'].win.value,0);
});
test('empty perpetual arrays are accepted but malformed portfolio schema still rejects the batch',async()=>{
  const empty=mocks({portfolio:[['perpAllTime',{pnlHistory:[],accountValueHistory:[]}]]});
  const result=await collect({...fixture(),...empty});assert.equal(Object.keys(result.accounts[address(1)]).length,6);
  assert.equal(result.accounts[address(1)].ALL.missingReasons.history,'missing_perp_all_time_history');
  const invalid=mocks({portfolio:{unexpected:'object'}});
  await assert.rejects(collect({...fixture(),...invalid}),/invalid_response/);
  assert.equal(invalid.requests.length,1);
});
for(const status of [401,403,418,429,451])test('HTTP '+status+' stops the complete batch on its first response',async()=>{
  const m=mocks(),stops=[];let count=0;
  await assert.rejects(collect({...fixture([address(1),address(2)]),...m,
    fetch:async()=>{count++;return new Response('{}',{status,headers:{'Retry-After':'120'}});},
    saveStop:async record=>stops.push(record)}),new RegExp('http_'+status));
  assert.equal(count,1);assert.equal(stops.length,1);assert.equal(stops[0].errorCode,'http_'+status);
  assert.equal(stops[0].retryAfterAt,iso(now+120000));
});
test('persistent refusal and older native source time both prevent any requests',async()=>{
  const m=mocks();
  await assert.rejects(collect({...fixture(),...m,previousStop:{status:'stopped'}}),/source_stop_persisted/);
  assert.equal(m.requests.length,0);
  const prior=await collect({...fixture(),...m});
  prior.accounts[address(1)]['30D'].native.sourceAt=iso(now+1000);
  prior.accounts[address(1)]['30D'].anchorAt=iso(now+1000);
  const next=mocks();await assert.rejects(collect({...fixture(),...next,previous:prior}),/source_time_regression/);
  assert.equal(next.requests.length,0);
});
test('one shared serial limiter respects a 900-weight rolling minute',async()=>{
  let clock=now;const starts=[];
  const source=new PublicSource({now:()=>clock,sleep:async ms=>{clock+=ms;},runId:'test',saveEvidence:async()=>{},saveStop:async()=>{},
    fetch:async()=>{starts.push(clock);return new Response('[]',{headers:{'content-type':'application/json'}});}});
  for(let i=0;i<8;i++)await source.request({type:'userFills',user:address(1)});
  assert(starts[7]-starts[0]>=60000);
  for(const start of starts)assert(starts.filter(t=>t>=start&&t<start+60000).length*120<=900);
});
test('failed CLI keeps the previous JSON and generatedAt byte-for-byte, persists refusal',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'period-collector-test-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const f=fixture(),m=mocks(),old=await collect({...f,...m}),out=path.join(temp,'period-samples.json');
  for(const [file,data]of [['feed.json',f.feed],['analytics.json',f.analyticsState],['portfolios.json',f.portfolioState],['period-samples.json',old]])
    await fs.writeFile(path.join(temp,file),JSON.stringify(data));
  const before=await fs.readFile(out);let calls=0;
  const args=['--feed',path.join(temp,'feed.json'),'--out',out,'--evidence',path.join(temp,'private')];
  await assert.rejects(main(args,{...m,fetch:async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'60'}});},log:()=>{}}),/http_429/);
  assert.deepEqual(await fs.readFile(out),before);
  const stop=JSON.parse(await fs.readFile(path.join(temp,'period-samples-stop.json'),'utf8'));
  assert.equal(stop.status,'stopped');assert.equal(stop.errorCode,'http_429');
  await assert.rejects(main(args,{...m,fetch:async()=>{calls++;throw Error('must not request');}}),/source_stop_persisted/);
  assert.equal(calls,1);
});
test('Retry-After supports both delta seconds and HTTP dates',()=>{
  assert.equal(retryTime('120',now),iso(now+120000));
  assert.equal(retryTime(new Date(now+120000).toUTCString(),now),iso(now+120000));
  assert.equal(retryTime('bad',now),null);
});
test('two CLI rounds use different evidence directories and request fresh responses',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'period-fresh-test-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const f=fixture(),out=path.join(temp,'period-samples.json'),evidence=path.join(temp,'private');
  for(const [file,data]of [['feed.json',f.feed],['analytics.json',f.analyticsState],['portfolios.json',f.portfolioState]])
    await fs.writeFile(path.join(temp,file),JSON.stringify(data));
  const args=['--feed',path.join(temp,'feed.json'),'--out',out,'--evidence',evidence],one=mocks(),two=mocks();
  const first=await main(args,{...one,log:()=>{}}),second=await main(args,{...two,log:()=>{}});
  assert.equal(one.requests.length,2);assert.equal(two.requests.length,2);assert.notEqual(first.runId,second.runId);
  const dirs=await fs.readdir(evidence);assert.equal(dirs.length,2);
  for(const dir of dirs)assert.equal((await fs.readdir(path.join(evidence,dir))).length,4);
  assert.equal((await fs.stat(out)).mode&0o777,0o644);
});
test('a later account failure never publishes an incomplete replacement',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'period-atomic-test-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const f=fixture([address(1),address(2)]),m=mocks(),out=path.join(temp,'period-samples.json');
  const old=await collect({...f,...m});
  for(const [file,data]of [['feed.json',f.feed],['analytics.json',f.analyticsState],['portfolios.json',f.portfolioState],['period-samples.json',old]])
    await fs.writeFile(path.join(temp,file),JSON.stringify(data));
  const before=await fs.readFile(out),fresh=mocks();let calls=0;
  await assert.rejects(main(['--feed',path.join(temp,'feed.json'),'--out',out,'--evidence',path.join(temp,'private')],{
    ...fresh,log:()=>{},fetch:async(...args)=>++calls===3?new Response('{}',{status:418}):fresh.fetch(...args),
  }),/http_418/);
  assert.equal(calls,3);assert.deepEqual(await fs.readFile(out),before);
});

function archiveFeed(ids,at){
  const feed=fixture(ids).feed;
  feed.source.fetchedAt=iso(at);feed.source.positionVerification.completedAt=iso(at-1000);
  for(const account of feed.traders)for(const part of Object.values(account.windows))part.asOf=iso(at);
  return feed;
}
function capturedFills(accountId,rows,at=now){
  const bytes=Buffer.from(JSON.stringify(rows));
  return {bytes,receipt:{runId:'saved-evidence',httpStatus:200,startedAt:iso(at),receivedAt:iso(at+100),
    request:{type:'userFills',user:accountId,aggregateByTime:false},bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex')}};
}
const validFill=(time,tid=1)=>({...fill(time,tid%2?1:-1,1),tid,oid:tid});

test('saved fill evidence updates new accounts without requests or processing-time timestamps',()=>{
  const ids=[address(1),address(2)],feed=archiveFeed(ids,now);
  const evidence=ids.map((id,i)=>capturedFills(id,[validFill(now-1000,i+1)],now+i*200));
  const result=fromEvidence({feed,evidence,runId:'saved-evidence',now:now+60000});
  validateFills(result,now+60000);
  assert.deepEqual(Object.keys(result.accounts),ids);
  assert.equal(result.accounts[ids[0]].coveredThrough,now);
  assert.equal(result.accounts[ids[0]].lastSuccessAt,iso(now+100));
  assert.equal(result.accounts[ids[1]].coveredThrough,now+200);
  assert.equal(result.source.checkedAt,iso(now+300));
  assert.equal(result.source.status,'ready');
});

test('seed accounts without this batch evidence keep their exact previous record and time',()=>{
  const ids=[address(1),address(2)],before=now-60000;
  const prior=fromEvidence({feed:archiveFeed(ids,before),evidence:ids.map(id=>capturedFills(id,[validFill(before-1000)],before)),now});
  const previous=JSON.stringify(prior),seed={schemaVersion:1,fetchedAt:iso(before-1000),positionVerifiedAt:iso(before),addresses:ids};
  const next=fromEvidence({feed:archiveFeed([ids[0]],now),previous:prior,seed,
    evidence:[capturedFills(ids[0],[validFill(before-1000),validFill(now-1000,2),validFill(now-1000,2)])],now:now+1000});
  assert.deepEqual(next.accounts[ids[1]],prior.accounts[ids[1]]);
  assert.equal(next.accounts[ids[0]].rows.length,2);
  assert.equal(next.accounts[ids[0]].rows[0].tid,2);
  assert.equal(next.source.status,'partial');
  assert.equal(JSON.stringify(prior),previous);
});

test('two hundred historical caches cannot block one new account, while pinned records retain their time',()=>{
  const ids=Array.from({length:200},(_,i)=>'0x'+(i+1).toString(16).padStart(40,'0'));
  const before=now-60000,newId='0x'+'f'.repeat(40);
  const prior=fromEvidence({feed:archiveFeed(ids,before),
    evidence:ids.map((id,i)=>capturedFills(id,[],before+i)),now});
  const original=JSON.stringify(prior),seed={schemaVersion:1,fetchedAt:iso(before-1000),
    positionVerifiedAt:iso(before),addresses:[ids[0]]};
  const result=fromEvidence({feed:archiveFeed([newId],now),previous:prior,seed,
    evidence:[capturedFills(newId,[validFill(now-1000)])],now:now+1000});
  assert.equal(Object.keys(result.accounts).length,200);
  assert.equal(result.accounts[newId].checkedAt,iso(now+100));
  assert.deepEqual(result.accounts[ids[0]],prior.accounts[ids[0]]);
  assert.equal(result.accounts[ids[1]],undefined);
  assert.deepEqual(result.accounts[ids.at(-1)],prior.accounts[ids.at(-1)]);
  assert.equal(result.source.status,'partial');
  assert.equal(JSON.stringify(prior),original);
});

test('a 2000-fill cap retains a visible coverage gap while merging real recent events',()=>{
  const id=address(1),before=now-3600000;
  const prior=fromEvidence({feed:archiveFeed([id],before),evidence:[capturedFills(id,[validFill(before-1000)],before)],now:before+1000});
  const rows=Array.from({length:2000},(_,i)=>validFill(now-i-1,i+2));
  const next=fromEvidence({feed:archiveFeed([id],now),previous:prior,evidence:[capturedFills(id,rows)],now:now+1000});
  const record=next.accounts[id];
  assert.equal(record.rows.length,50);
  assert.equal(record.coveredThrough,now);
  assert.deepEqual(record.gap,{from:before-60000,to:now-2001,reason:'response_cap'});
  assert.equal(next.source.status,'partial');
  assert.equal(record.lastSuccessAt,iso(now+100));
});

test('evidence hashes, identities, clock regressions and permanent stops fail before promotion',()=>{
  const id=address(1),feed=archiveFeed([id],now),good=capturedFills(id,[validFill(now-1)]);
  assert.throws(()=>fromEvidence({feed,evidence:[{...good,bytes:Buffer.from('[]')}],now:now+1000}),/invalid_fills_evidence/);
  assert.throws(()=>fromEvidence({feed,evidence:[good],runId:'a-different-run',now:now+1000}),/invalid_fills_evidence/);
  assert.throws(()=>fromEvidence({feed,evidence:[],now:now+1000}),/missing_fills_evidence/);
  const previous=fromEvidence({feed,evidence:[good],now:now+1000});
  assert.throws(()=>fromEvidence({feed,previous,evidence:[capturedFills(id,[],now-1)],now:now+1000}),/fills_time_regression/);
  const stopped=structuredClone(previous);stopped.source.status='stopped';stopped.source.stopCode='http_403';
  assert.throws(()=>fromEvidence({feed,previous:stopped,evidence:[good],now:now+1000}),/http_403/);
});

test('failed second installation restores both output files byte for byte',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'period-fill-transaction-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const periodFile=path.join(temp,'period-samples.json'),fillsFile=path.join(temp,'hyperliquid-fills.json');
  const oldPeriod=Buffer.from('{"previous":"period"}\n'),oldFills=Buffer.from('{"previous":"fills"}\n');
  await fs.writeFile(periodFile,oldPeriod);await fs.writeFile(fillsFile,oldFills);
  let failed=false;
  const io={...fs,rename:async(from,to)=>{
    if(to===fillsFile&&!failed){failed=true;throw Object.assign(Error('installation interrupted'),{code:'EIO'});}
    return fs.rename(from,to);
  }};
  await assert.rejects(atomicBundle([{file:periodFile,data:{new:1}},{file:fillsFile,data:{new:2}}],io),/installation interrupted/);
  assert.deepEqual(await fs.readFile(periodFile),oldPeriod);
  assert.deepEqual(await fs.readFile(fillsFile),oldFills);
  assert.deepEqual((await fs.readdir(temp)).sort(),['hyperliquid-fills.json','period-samples.json']);
});

test('malformed raw fills leave both published CLI outputs untouched',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'period-fill-validation-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const f=fixture(),old=await collect({...f,...mocks()}),out=path.join(temp,'period-samples.json'),fillsOut=path.join(temp,'hyperliquid-fills.json');
  const saved=fromEvidence({feed:f.feed,evidence:[capturedFills(address(1),[validFill(now-1000)])],now:now+1000});
  for(const [file,data]of [['feed.json',f.feed],['analytics.json',f.analyticsState],['portfolios.json',f.portfolioState],['period-samples.json',old],['hyperliquid-fills.json',saved]])
    await fs.writeFile(path.join(temp,file),JSON.stringify(data)+'\n');
  const beforePeriod=await fs.readFile(out),beforeFills=await fs.readFile(fillsOut);
  const malformed=validFill(now-1000);delete malformed.px;
  const m=mocks({userFills:[malformed]});
  await assert.rejects(main(['--feed',path.join(temp,'feed.json'),'--out',out,'--evidence',path.join(temp,'private')],{...m,log:()=>{}}),/invalid_response/);
  assert.equal(m.requests.length,2);
  assert.deepEqual(await fs.readFile(out),beforePeriod);
  assert.deepEqual(await fs.readFile(fillsOut),beforeFills);
});

test('a stopped existing fill archive prevents CLI source requests',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'period-fill-stop-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const f=fixture(),out=path.join(temp,'period-samples.json');
  const saved=fromEvidence({feed:f.feed,evidence:[capturedFills(address(1),[])],now:now+1000});
  saved.source.status='stopped';saved.source.stopCode='http_429';
  for(const [file,data]of [['feed.json',f.feed],['analytics.json',f.analyticsState],['portfolios.json',f.portfolioState],['hyperliquid-fills.json',saved]])
    await fs.writeFile(path.join(temp,file),JSON.stringify(data));
  const m=mocks();
  await assert.rejects(main(['--feed',path.join(temp,'feed.json'),'--out',out],{...m,log:()=>{}}),/http_429/);
  assert.equal(m.requests.length,0);
});
