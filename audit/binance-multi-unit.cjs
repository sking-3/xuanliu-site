'use strict';
const assert=require('node:assert/strict');
const {PORTFOLIOS,createCollector,validateCollection,collectAll,reconcileLegacy}=require('../scripts/collect_binance.cjs');
const TIME=Date.UTC(2026,10,10,1,20),initial=()=>validateCollection(null);
const raw=id=>({symbol:id===PORTFOLIOS[0].id?'BTCUSDT':'ETHUSDT',positionSide:'LONG',positionAmount:'1',entryPrice:'100',markPrice:'101',unrealizedProfit:'1',leverage:10,collateral:'USDT'});
let passed=0;
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
function fake({hidden=[],blocked=null,badIdentity=null,avatars={}}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const id=options.body?JSON.parse(options.body).portfolioId:new URL(url).searchParams.get('portfolioId');
  calls.push({id,url,options});
  if(blocked===id)return new Response('Forbidden',{status:403});
  const data=url.includes('/detail?')?{leadPortfolioId:id===badIdentity?PORTFOLIOS[0].id:id,nickname:PORTFOLIOS.find(p=>p.id===id).name,status:'ACTIVE',positionShow:!hidden.includes(id),avatarUrl:avatars[id]}:
   url.includes('/positions?')?[raw(id)]:url.includes('/chart-data?')?[{dateTime:TIME-86400000,value:-5,dataType:'PNL'},{dateTime:TIME,value:id===PORTFOLIOS[0].id?123:456,dataType:'PNL'}]:url.includes('/performance?')?{timeRange:'30D',roi:id===PORTFOLIOS[0].id?'1.2':2.3,pnl:'100',mdd:'-3',winRate:50}:{list:[],total:0,indexValue:'0'};
  return new Response(JSON.stringify({code:'000000',success:true,data}),{status:200,headers:{'content-type':'application/json'}});
 };
 return {calls,fetchImpl};
}
const run=(p,f,extra={})=>collectAll(p,{fetchImpl:f.fetchImpl,sleep:async()=>{},now:()=>TIME,...extra});
(async()=>{
 await test('three allowlisted identities get separate requests, histories and source URLs',async()=>{
  const f=fake(),out=await run(null,f);
  assert.equal(out.portfolios.length,3);assert.equal(f.calls.length,18);
  for(const p of out.portfolios){assert.equal(p.profile.id,p.portfolioId);assert(p.profile.sourceUrl.endsWith('/'+p.portfolioId));assert.equal(p.source.status,'ready');assert.equal(f.calls.filter(c=>c.id===p.portfolioId).length,6);}
  assert.equal(out.portfolios[0].snapshot.positions[0].symbol,'BTCUSDT');
  assert.equal(out.portfolios[1].snapshot.positions[0].symbol,'ETHUSDT');
 });
 await test('avatars stay scoped to the same three portfolio IDs without new requests',async()=>{
  const avatars={
   '5156287639231681792':'https://public.bnbstatic.com/image/pgc/first.png',
   '5139646755272846081':'https://public-1306379396.file.myqcloud.com/image/avatar/second.jpg',
   '5178595252342363392':'https://untrusted.test/image/third.png'
  },f=fake({avatars}),out=await run(null,f);
  assert.equal(f.calls.length,18);assert.equal(f.calls.some(c=>c.id==='5075281354358777856'),false);
  for(const [index,p] of out.portfolios.entries()){assert.equal(typeof p.profile.id,'string');assert.equal(p.profile.id,PORTFOLIOS[index].id);assert.equal(p.profile.avatarUrl,index<2?avatars[p.portfolioId]:null);assert.equal(p.source.status,'ready');}
  out.portfolios[1].source.refreshStopped=true;out.portfolios[1].source.errorCode='schema_changed';
  const next=fake({avatars}),kept=await run(out,next);assert.equal(next.calls.length,12);assert.equal(next.calls.some(c=>c.id===PORTFOLIOS[1].id),false);assert.equal(kept.portfolios[1].profile.avatarUrl,avatars[PORTFOLIOS[1].id]);
 });
 await test('unsupported, duplicate and mismatched records fail before any request',async()=>{
  const f=fake(),a=initial();a.portfolios[1]=a.portfolios[0];
  await assert.rejects(()=>run(a,f),/invalid_collection/);assert.equal(f.calls.length,0);
  const b=initial();b.portfolios[1].profile.id=b.portfolios[0].portfolioId;
  await assert.rejects(()=>run(b,f),/invalid_collection/);
  assert.throws(()=>createCollector('5075281354358777856'),/unsupported_portfolio/);
 });
 await test('hidden account is stopped and cleared without blocking other public accounts',async()=>{
  const good=await run(null,fake()),id=PORTFOLIOS[1].id,f=fake({hidden:[id]}),out=await run(good,f);
  assert.equal(out.portfolios[1].source.status,'restricted');assert.equal(out.portfolios[1].snapshot,null);
  assert.equal(f.calls.filter(c=>c.id===id).length,1);assert.equal(out.portfolios[2].source.status,'ready');
 });
 await test('an account already stopped is never requested while other identities refresh',async()=>{
  const previous=initial(),id=PORTFOLIOS[1].id;
  previous.portfolios[1].source={...previous.portfolios[1].source,refreshStopped:true,errorCode:'schema_changed'};
  const f=fake(),out=await run(previous,f);assert.equal(f.calls.some(c=>c.id===id),false);assert.equal(out.portfolios[1].source.errorCode,'schema_changed');assert.equal(f.calls.length,12);
 });
 await test('HTTP refusal halts the batch before remaining identities and stays stopped next run',async()=>{
  const id=PORTFOLIOS[1].id,f=fake({blocked:id}),out=await run(null,f);
  assert.equal(f.calls.length,7);assert.equal(out.source.refreshStopped,true);
  assert(out.portfolios.every(p=>p.source.refreshStopped));
  assert.equal(out.portfolios[0].source.status,'stale');assert.equal(out.portfolios[0].source.lastSuccessAt,new Date(TIME).toISOString());
  const again=fake();await run(out,again);assert.equal(again.calls.length,0);
 });
 await test('a legacy account refusal also stops the collection before its first request',async()=>{
  const p=initial();p.portfolios[2].source.refreshStopped=true;p.portfolios[2].source.errorCode='http_429';
  const f=fake(),out=await run(p,f);assert.equal(f.calls.length,0);assert.equal(out.source.refreshStopped,true);
 });
 await test('uncertain preceding workflow prevents all source requests',async()=>{
  const f=fake(),out=await run(null,f,{stopBeforeRequest:true});
  assert.equal(f.calls.length,0);assert(out.portfolios.every(p=>p.source.refreshStopped&&p.snapshot===null));assert.equal(out.source.errorCode,'previous_run_unverified');
 });
 await test('wrong returned identity stops only that account and never publishes another account under it',async()=>{
  const f=fake({badIdentity:PORTFOLIOS[1].id}),out=await run(null,f);
  assert.equal(out.portfolios[1].source.errorCode,'identity_mismatch');assert.equal(out.portfolios[1].snapshot,null);assert.equal(out.portfolios[2].source.status,'ready');
 });
 await test('newer legacy snapshots are retained without clearing either stopped state',async()=>{
  const old=initial(),legacy=createCollector(PORTFOLIOS[0].id).initial();
  legacy.generatedAt=new Date(TIME).toISOString();legacy.source.errorCode='older_detail';
  const newer=reconcileLegacy(old,legacy);assert.equal(newer.portfolios[0].generatedAt,legacy.generatedAt);
  newer.portfolios[0].source.refreshStopped=true;newer.portfolios[0].source.errorCode='schema_changed';
  const kept=reconcileLegacy(newer,legacy);assert.equal(kept.portfolios[0].source.errorCode,'schema_changed');
  legacy.source.refreshStopped=true;legacy.source.errorCode='http_429';
  const blocked=reconcileLegacy(old,legacy);assert.equal(blocked.source.refreshStopped,true);
  const f=fake();await run(blocked,f);assert.equal(f.calls.length,0);
 });
 await test('privacy withdrawal wins when both states are halted and never resurrects cached rows',async()=>{
  const current=await run(null,fake());
  current.portfolios[0].source.refreshStopped=true;current.portfolios[0].source.errorCode='schema_changed';
  const hidden=JSON.parse(JSON.stringify(current.portfolios[0]));
  hidden.generatedAt=new Date(TIME+10000).toISOString();hidden.profile.visibility='restricted';
  hidden.source.status='restricted';hidden.source.errorCode='restricted';hidden.snapshot=null;hidden.snapshots=[];hidden.observations=[];
  hidden.history.orders.rows=[];hidden.history.closedPositions.rows=[];
  const merged=reconcileLegacy(current,hidden);
  assert.equal(merged.portfolios[0].profile.visibility,'restricted');assert.equal(merged.portfolios[0].snapshot,null);
  assert.equal(merged.portfolios[0].source.refreshStopped,true);
  const f=fake(),out=await run(merged,f);
  assert.equal(f.calls.some(c=>c.id===PORTFOLIOS[0].id),false);assert.equal(out.portfolios[0].snapshot,null);
  const reverse=reconcileLegacy(merged,current.portfolios[0]);
  assert.equal(reverse.portfolios[0].source.status,'restricted');assert.equal(reverse.portfolios[0].snapshot,null);
 });
 await test('privacy merge retains a preexisting account-level refusal as a batch stop',async()=>{
  const current=await run(null,fake());
  current.portfolios[0].source.refreshStopped=true;current.portfolios[0].source.errorCode='http_429';
  const hidden=JSON.parse(JSON.stringify(current.portfolios[0]));
  hidden.profile.visibility='restricted';hidden.source.status='restricted';hidden.source.errorCode='restricted';
  hidden.snapshot=null;hidden.snapshots=[];hidden.observations=[];
  const merged=reconcileLegacy(current,hidden);
  assert.equal(merged.source.refreshStopped,true);assert.equal(merged.source.errorCode,'http_429');
  assert.equal(merged.portfolios[0].source.status,'restricted');
  const f=fake();await run(merged,f);assert.equal(f.calls.length,0);
 });
 await test('performance remains scoped to each of the same three identities',async()=>{
  const f=fake(),out=await run(null,f);assert.equal(out.portfolios[0].performance.byPeriod['30D'].roi,1.2);assert.equal(out.portfolios[1].performance.byPeriod['30D'].roi,2.3);
  assert.equal(f.calls.filter(c=>c.url.includes('/performance?')).length,3);assert.equal(f.calls.some(c=>c.id==='5075281354358777856'),false);
  for(const p of out.portfolios)assert.deepEqual(Object.keys(p.performance.byPeriod),['30D']);
 });
 await test('performance refusal halts remaining identities and survives the next batch',async()=>{
  const f=fake(),fetchImpl=async(url,options)=>url.includes('/performance?')?new Response('blocked',{status:429}):f.fetchImpl(url,options);
  let calls=0;const out=await run(null,{fetchImpl:async(...args)=>{calls++;return fetchImpl(...args);}});assert.equal(calls,5);assert.equal(out.source.refreshStopped,true);assert.equal(out.source.errorCode,'http_429');assert(out.portfolios.every(p=>p.source.refreshStopped));assert.equal(out.portfolios[0].performance.byPeriod['30D'].status,'unavailable');assert.deepEqual(out.portfolios[1].performance.byPeriod,{});
  const again=fake();await run(out,again);assert.equal(again.calls.length,0);
 });
 await test('hidden legacy data clears performance in both merge directions',async()=>{
  const current=await run(null,fake()),hidden=structuredClone(current.portfolios[0]);hidden.profile.visibility='restricted';hidden.source.status='restricted';hidden.source.errorCode='restricted';hidden.source.refreshStopped=true;
  const merged=reconcileLegacy(current,hidden);assert.deepEqual(merged.portfolios[0].performance,{schemaVersion:1,byPeriod:{}});
  const reverse=reconcileLegacy(merged,current.portfolios[0]);assert.deepEqual(reverse.portfolios[0].performance,{schemaVersion:1,byPeriod:{}});assert.equal(reverse.portfolios[0].source.refreshStopped,true);
 });
 await test('legacy updates retain newer performance independently without clearing source stop',async()=>{
  const current=await run(null,fake()),legacy=structuredClone(current.portfolios[0]);legacy.generatedAt=new Date(TIME+10000).toISOString();delete legacy.performance;
  const merged=reconcileLegacy(current,legacy);assert.deepEqual(merged.portfolios[0].performance,current.portfolios[0].performance);assert.equal(merged.portfolios[0].source.lastSuccessAt,current.portfolios[0].source.lastSuccessAt);
  const halted=structuredClone(legacy);halted.source.refreshStopped=true;halted.source.errorCode='schema_changed';const blocked=reconcileLegacy(current,halted);assert.equal(blocked.portfolios[0].source.refreshStopped,true);assert.equal(blocked.portfolios[0].performance.byPeriod['30D'].status,'stale');assert.equal(blocked.portfolios[0].performance.byPeriod['30D'].lastSuccessAt,current.portfolios[0].performance.byPeriod['30D'].lastSuccessAt);
 });
 await test('newer performance failure preserves its error and the latest success during legacy merge',async()=>{
  const current=await run(null,fake()),legacy=structuredClone(current.portfolios[0]),w=legacy.performance.byPeriod['30D'];w.status='stale';w.lastAttemptAt=new Date(TIME+10000).toISOString();w.errorCode='http_503';
  const merged=reconcileLegacy(current,legacy),result=merged.portfolios[0].performance.byPeriod['30D'];assert.equal(result.status,'stale');assert.equal(result.errorCode,'http_503');assert.equal(result.lastAttemptAt,w.lastAttemptAt);assert.equal(result.lastSuccessAt,current.portfolios[0].performance.byPeriod['30D'].lastSuccessAt);
 });
 await test('PNL charts are scoped to the three allowed identities and exact 30D query',async()=>{
  const f=fake(),out=await run(null,f),calls=f.calls.filter(c=>c.url.includes('/chart-data?'));assert.equal(calls.length,3);assert.equal(f.calls.length,18);
  assert.equal(out.portfolios[0].chart.byPeriod['30D'].points.at(-1).value,123);assert.equal(out.portfolios[1].chart.byPeriod['30D'].points.at(-1).value,456);
  assert.equal(calls.some(c=>c.id==='5075281354358777856'),false);
  for(const c of calls){const q=new URL(c.url).searchParams;assert.equal(q.get('portfolioId'),c.id);assert.equal(q.get('timeRange'),'30D');assert.equal(q.get('dataType'),'PNL');}
  for(const p of out.portfolios)assert.deepEqual(Object.keys(p.chart.byPeriod),['30D']);
 });
 await test('chart refusal halts the remaining batch and survives legacy reconciliation',async()=>{
  const f=fake();let calls=0;const out=await run(null,{fetchImpl:async(url,options)=>{calls++;return url.includes('/chart-data?')?new Response('blocked',{status:429}):f.fetchImpl(url,options);}});
  assert.equal(calls,6);assert.equal(out.source.refreshStopped,true);assert.equal(out.source.errorCode,'http_429');assert(out.portfolios.every(p=>p.source.refreshStopped));assert.equal(out.portfolios[0].chart.byPeriod['30D'].status,'unavailable');assert.deepEqual(out.portfolios[1].chart.byPeriod,{});
  const prior=initial(),merged=reconcileLegacy(prior,out.portfolios[0]),again=fake();assert.equal(merged.source.refreshStopped,true);await run(merged,again);assert.equal(again.calls.length,0);
 });
 await test('hidden and unknown chart data is cleared and never restored from legacy',async()=>{
  const current=await run(null,fake()),hidden=structuredClone(current.portfolios[0]);hidden.profile.visibility='restricted';hidden.source.status='restricted';hidden.source.errorCode='restricted';hidden.source.refreshStopped=true;
  const merged=reconcileLegacy(current,hidden);assert.deepEqual(merged.portfolios[0].chart,{schemaVersion:1,byPeriod:{}});assert.deepEqual(reconcileLegacy(merged,current.portfolios[0]).portfolios[0].chart,{schemaVersion:1,byPeriod:{}});
  const unknown=structuredClone(current.portfolios[0]);unknown.profile.visibility='unknown';unknown.source.refreshStopped=true;unknown.source.errorCode='schema_changed';assert.deepEqual(reconcileLegacy(current,unknown).portfolios[0].chart,{schemaVersion:1,byPeriod:{}});
 });
 await test('legacy chart merge keeps independent attempt and success watermarks without resuming source',async()=>{
  const current=await run(null,fake()),legacy=structuredClone(current.portfolios[0]);legacy.generatedAt=new Date(TIME+10000).toISOString();delete legacy.chart;
  const merged=reconcileLegacy(current,legacy);assert.deepEqual(merged.portfolios[0].chart,current.portfolios[0].chart);assert.equal(merged.portfolios[0].source.lastSuccessAt,current.portfolios[0].source.lastSuccessAt);
  const failure=structuredClone(current.portfolios[0]),w=failure.chart.byPeriod['30D'];w.status='stale';w.lastAttemptAt=new Date(TIME+10000).toISOString();w.errorCode='http_503';
  const result=reconcileLegacy(current,failure).portfolios[0].chart.byPeriod['30D'];assert.equal(result.lastAttemptAt,w.lastAttemptAt);assert.equal(result.errorCode,'http_503');assert.equal(result.status,'stale');assert.equal(result.lastSuccessAt,current.portfolios[0].chart.byPeriod['30D'].lastSuccessAt);assert.deepEqual(result.points,current.portfolios[0].chart.byPeriod['30D'].points);
  legacy.source.refreshStopped=true;legacy.source.errorCode='schema_changed';const stopped=reconcileLegacy(current,legacy);assert.equal(stopped.portfolios[0].source.refreshStopped,true);assert.equal(stopped.portfolios[0].chart.byPeriod['30D'].status,'stale');const f=fake();await run(stopped,f);assert.equal(f.calls.some(c=>c.id===PORTFOLIOS[0].id),false);
 });
 await test('newer unknown legacy state clears an already stopped public feed without reversal',async()=>{
  const current=await run(null,fake());current.portfolios[0].source.refreshStopped=true;current.portfolios[0].source.errorCode='schema_changed';
  const prior=structuredClone(current.portfolios[0]),unknown=structuredClone(prior);unknown.profile.visibility='unknown';unknown.source.status='unavailable';unknown.source.errorCode='schema_changed';unknown.generatedAt=new Date(TIME+10000).toISOString();unknown.source.lastAttemptAt=unknown.generatedAt;unknown.chart={schemaVersion:1,byPeriod:{}};
  const merged=reconcileLegacy(current,unknown),hidden=merged.portfolios[0];
  assert.equal(hidden.profile.visibility,'unknown');assert.equal(hidden.source.status,'unavailable');assert.equal(hidden.source.refreshStopped,true);assert.equal(hidden.source.errorCode,'schema_changed');assert.equal(hidden.source.lastSuccessAt,prior.source.lastSuccessAt);assert.equal(hidden.source.lastAttemptAt,unknown.source.lastAttemptAt);
  assert.equal(hidden.snapshot,null);assert.deepEqual(hidden.snapshots,[]);assert.deepEqual(hidden.observations,[]);assert.deepEqual(hidden.pendingAbsent,{});assert.deepEqual(hidden.history.orders.rows,[]);assert.deepEqual(hidden.history.closedPositions.rows,[]);assert.deepEqual(hidden.performance,{schemaVersion:1,byPeriod:{}});assert.deepEqual(hidden.chart,{schemaVersion:1,byPeriod:{}});
  const reverse=reconcileLegacy(merged,prior);assert.equal(reverse.portfolios[0].profile.visibility,'unknown');assert.equal(reverse.portfolios[0].snapshot,null);assert.deepEqual(reverse.portfolios[0].performance,{schemaVersion:1,byPeriod:{}});assert.deepEqual(reverse.portfolios[0].chart,{schemaVersion:1,byPeriod:{}});assert.equal(reverse.portfolios[0].source.refreshStopped,true);
  const f=fake();await run(reverse,f);assert.equal(f.calls.some(c=>c.id===PORTFOLIOS[0].id),false);
 });
 await test('initial or older unknown records do not replace a stopped public cache',async()=>{
  const current=await run(null,fake());current.portfolios[0].source.refreshStopped=true;current.portfolios[0].source.errorCode='schema_changed';
  const placeholder=createCollector(PORTFOLIOS[0].id).initial();placeholder.generatedAt=new Date(TIME+10000).toISOString();
  const older=structuredClone(placeholder);older.source.refreshStopped=true;older.source.errorCode='schema_changed';older.generatedAt=new Date(TIME-10000).toISOString();older.source.lastAttemptAt=older.generatedAt;
  for(const legacy of [placeholder,older]){const kept=reconcileLegacy(current,legacy).portfolios[0];assert.equal(kept.profile.visibility,'public');assert.deepEqual(kept.snapshot,current.portfolios[0].snapshot);assert.deepEqual(kept.chart.byPeriod['30D'].points,current.portfolios[0].chart.byPeriod['30D'].points);assert.equal(kept.source.refreshStopped,true);}
  const accepted=reconcileLegacy(initial(),current.portfolios[0]);assert.equal(accepted.portfolios[0].profile.visibility,'public');assert.deepEqual(accepted.portfolios[0].chart.byPeriod['30D'].points,current.portfolios[0].chart.byPeriod['30D'].points);
 });
 await test('unknown merge cannot downgrade restricted state or discard either batch refusal',async()=>{
  const current=await run(null,fake()),unknown=structuredClone(current.portfolios[0]);unknown.profile.visibility='unknown';unknown.source.refreshStopped=true;unknown.source.errorCode='schema_changed';unknown.generatedAt=new Date(TIME+10000).toISOString();unknown.source.lastAttemptAt=unknown.generatedAt;
  current.portfolios[0].source.refreshStopped=true;current.portfolios[0].source.errorCode='http_429';
  const merged=reconcileLegacy(current,unknown);assert.equal(merged.portfolios[0].profile.visibility,'unknown');assert.equal(merged.source.refreshStopped,true);assert.equal(merged.source.errorCode,'http_429');assert.deepEqual(merged.portfolios[0].chart,{schemaVersion:1,byPeriod:{}});
  const f=fake();await run(merged,f);assert.equal(f.calls.length,0);
  const restricted=structuredClone(current.portfolios[0]);restricted.profile.visibility='restricted';restricted.source.status='restricted';restricted.source.errorCode='restricted';
  const privacy=reconcileLegacy(merged,restricted);assert.equal(privacy.portfolios[0].profile.visibility,'restricted');assert.equal(privacy.portfolios[0].source.errorCode,'restricted');assert.deepEqual(privacy.portfolios[0].chart,{schemaVersion:1,byPeriod:{}});
  assert.equal(reconcileLegacy(privacy,unknown).portfolios[0].profile.visibility,'restricted');
  const stopped=structuredClone(unknown);stopped.source.errorCode='http_403';assert.equal(reconcileLegacy(current,stopped).source.refreshStopped,true);
 });
 console.log('PASS '+passed+' Binance multi-portfolio checks');
})().catch(e=>{console.error(e);process.exitCode=1;});
