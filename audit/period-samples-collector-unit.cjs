'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {collect,main,PublicSource,retryTime}=require('../scripts/collect_period_samples.cjs');
const DAY=86400000,now=Date.parse('2026-11-20T00:00:00Z'),iso=t=>new Date(t).toISOString();
const address=i=>'0x'+String(i).repeat(40),sha='a'.repeat(64);
function fixture(ids=[address(1)]){
  return {feed:{schemaVersion:1,status:'ready',source:{id:'hyperliquid',url:'https://app.hyperliquid.xyz/leaderboard',
    status:'ok',selectedAccounts:ids.length,fetchedAt:iso(now),rawSha256:sha,
    positionVerification:{scope:'default_perp_dex',stopCode:null}},traders:ids.map(accountId=>({
      accountId,sourceKind:'public_account',exchange:'Hyperliquid',windows:Object.fromEntries(['7D','30D','ALL'].map(period=>[period,
        {asOf:iso(now),asOfType:'source',roi:20,pnl:200}]))}))},
    analyticsState:{schemaVersion:1,methodVersion:'closing-fill-v1',source:{id:'hyperliquid',endpoint:'https://api.hyperliquid.xyz/info',status:'ready',stopCode:null,accounts:0},accounts:{}},
    portfolioState:{schemaVersion:1,methodVersion:'portfolio-periods-v2',source:{id:'hyperliquid',endpoint:'https://api.hyperliquid.xyz/info',status:'ready',stopCode:null,accounts:0},accounts:{}},
    feedSha256:sha};
}
const portfolio=()=>['perpWeek','perpMonth','perpAllTime'].map(name=>[name,{
  pnlHistory:[[now-31*DAY,'100'],[now-20*DAY,'110'],[now-DAY,'120'],[now,'115']],
  accountValueHistory:[[now-31*DAY,'1000'],[now-20*DAY,'1100'],[now-DAY,'1200'],[now,'1150']],vlm:'0'}]);
const fill=(at,pnl,tid=1)=>({coin:'BTC',time:at,dir:'Close Long',side:'A',sz:'1',startPosition:'2',closedPnl:String(pnl),fee:'0',
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
