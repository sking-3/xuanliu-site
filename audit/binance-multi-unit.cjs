'use strict';
const assert=require('node:assert/strict');
const {PORTFOLIOS,createCollector,validateCollection,collectAll,reconcileLegacy}=require('../scripts/collect_binance.cjs');
const TIME=Date.UTC(2026,10,10,1,20),initial=()=>validateCollection(null);
const raw=id=>({symbol:id===PORTFOLIOS[0].id?'BTCUSDT':'ETHUSDT',positionSide:'LONG',positionAmount:'1',entryPrice:'100',markPrice:'101',unrealizedProfit:'1',leverage:10,collateral:'USDT'});
let passed=0;
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
function fake({hidden=[],blocked=null,badIdentity=null}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const id=options.body?JSON.parse(options.body).portfolioId:new URL(url).searchParams.get('portfolioId');
  calls.push({id,url,options});
  if(blocked===id)return new Response('Forbidden',{status:403});
  const data=url.includes('/detail?')?{leadPortfolioId:id===badIdentity?PORTFOLIOS[0].id:id,nickname:PORTFOLIOS.find(p=>p.id===id).name,status:'ACTIVE',positionShow:!hidden.includes(id)}:
   url.includes('/positions?')?[raw(id)]:{list:[],total:0,indexValue:'0'};
  return new Response(JSON.stringify({code:'000000',success:true,data}),{status:200,headers:{'content-type':'application/json'}});
 };
 return {calls,fetchImpl};
}
const run=(p,f,extra={})=>collectAll(p,{fetchImpl:f.fetchImpl,sleep:async()=>{},now:()=>TIME,...extra});
(async()=>{
 await test('three allowlisted identities get separate requests, histories and source URLs',async()=>{
  const f=fake(),out=await run(null,f);
  assert.equal(out.portfolios.length,3);assert.equal(f.calls.length,12);
  for(const p of out.portfolios){assert.equal(p.profile.id,p.portfolioId);assert(p.profile.sourceUrl.endsWith('/'+p.portfolioId));assert.equal(p.source.status,'ready');assert.equal(f.calls.filter(c=>c.id===p.portfolioId).length,4);}
  assert.equal(out.portfolios[0].snapshot.positions[0].symbol,'BTCUSDT');
  assert.equal(out.portfolios[1].snapshot.positions[0].symbol,'ETHUSDT');
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
  const f=fake(),out=await run(previous,f);assert.equal(f.calls.some(c=>c.id===id),false);assert.equal(out.portfolios[1].source.errorCode,'schema_changed');assert.equal(f.calls.length,8);
 });
 await test('HTTP refusal halts the batch before remaining identities and stays stopped next run',async()=>{
  const id=PORTFOLIOS[1].id,f=fake({blocked:id}),out=await run(null,f);
  assert.equal(f.calls.length,5);assert.equal(out.source.refreshStopped,true);
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
 console.log('PASS '+passed+' Binance multi-portfolio checks');
})().catch(e=>{console.error(e);process.exitCode=1;});
