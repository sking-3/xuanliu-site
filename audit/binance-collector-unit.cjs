'use strict';
const assert=require('node:assert/strict');
const {ID,initial,positions,profile,changes,compare,collect,request,performance,validPerformance,validateState}=require('../scripts/collect_binance.cjs');
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
const TIME=Date.UTC(2026,10,10,1);
const iso=n=>new Date(TIME+n).toISOString();
const raw=(quantity='1',symbol='BTCUSDT',side='LONG')=>({symbol,positionSide:side,positionAmount:quantity,entryPrice:'100',markPrice:'102',unrealizedProfit:'2',leverage:10,collateral:'USDT'});
const pd={leadPortfolioId:ID,nickname:'爱喝快乐肥宅水',positionShow:true,status:'ACTIVE'};
function fake({rows=[raw()],details=pd,fail=null,orders=[],closed=[],performanceData={timeRange:'30D',roi:'12.34',pnl:123.45,mdd:'-4.5',winRate:'66.67'}}={}){const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,options});if(fail&&url.includes(fail.path)){if(fail.throw)throw Error(fail.throw);return new Response(fail.body||'blocked',{status:fail.status||503,headers:{'content-type':fail.type||'text/plain'}});}
 const data=url.includes('/detail?')?details:url.includes('/positions?')?rows:url.includes('/performance?')?performanceData:{list:url.endsWith('/order-history')?orders:closed,total:30,indexValue:'1794243309037'};
 return new Response(JSON.stringify({code:'000000',success:true,data}),{status:200,headers:{'content-type':'application/json'}});};return {fetchImpl,calls};}
const run=(p,f,time=TIME)=>collect(p,{fetchImpl:f.fetchImpl,now:()=>time,sleep:async()=>{}});
(async()=>{
await test('ID remains exact string and mismatched identity rejected',()=>{assert.equal(typeof ID,'string');assert.equal(profile(pd).id,'5156287639231681792');assert.throws(()=>profile({...pd,leadPortfolioId:'5156287639231681793'}),/identity_mismatch/);});
await test('decimal comparison retains precision and handles short quantity',()=>{assert.equal(compare('9007199254740993.01','9007199254740993.00'),1);assert.equal(positions([raw('-0.20','BTCUSDT','SHORT')],iso(0)).positions[0].quantity,'0.20');});
await test('zero positions filtered; malformed and duplicates rejected',()=>{assert.equal(positions([raw('0'),raw('1','ETHUSDT')],iso(0)).positions.length,1);assert.throws(()=>positions([raw(),raw()],iso(0)),/schema_changed/);assert.throws(()=>positions([{...raw(),positionAmount:'NaN'}],iso(0)),/schema_changed/);assert.throws(()=>positions(null,iso(0)),/schema_changed/);});
await test('initial successful sample has baseline and incomplete history',async()=>{const f=fake(),v=await run(null,f);assert.equal(v.source.status,'ready');assert.equal(v.observations[0].kind,'baseline');assert.equal(v.history.orders.complete,false);assert.equal(v.history.orders.coverage.truncated,true);assert.equal(f.calls.length,5);assert(!f.calls.some(c=>c.options.headers.cookie||c.options.headers.authorization));assert.equal(JSON.parse(f.calls[2].options.body).portfolioId,ID);});
await test('complete empty snapshot is valid',async()=>{const v=await run(null,fake({rows:[]}));assert.equal(v.source.status,'ready');assert.equal(v.snapshot.complete,true);assert.equal(v.snapshot.positions.length,0);assert.equal(v.observations.length,0);});
await test('quantity differences; price and leverage changes not additions',()=>{const a=positions([raw('1')],iso(0)),b=positions([raw('1.5')],iso(1000));assert.equal(changes(a,b).events[0].kind,'increased');assert.equal(changes(b,a).events[0].kind,'decreased');const c=positions([{...raw(),leverage:20,markPrice:'110'}],iso(2000));assert.equal(changes(a,c).events.length,0);});
await test('absence requires two complete snapshots and is observation only',()=>{const a=positions([raw()],iso(0)),b=positions([],iso(1000)),c=positions([],iso(2000));const one=changes(a,b);assert.equal(one.events.length,0);const two=changes(b,c,one.pending);assert.equal(two.events[0].kind,'absent');assert.equal(two.events[0].from,a.observedAt);assert(!('price' in two.events[0]));assert.equal(changes(b,a,one.pending).events.length,0);});
const good=await run(null,fake());
await test('source failure preserves last success and never emits closure',async()=>{for(const fail of [{path:'/positions?',status:503},{path:'/positions?',status:200,body:'<html/>',type:'text/html'},{path:'/positions?',throw:'network_error'},{path:'/positions?',status:200,type:'application/json',body:'{"code":"000002","success":false,"data":null}'}]){const v=await run(good,fake({fail}),TIME+60000);assert.equal(v.source.status,'stale');assert.deepEqual(v.snapshot,good.snapshot);assert.equal(v.source.lastSuccessAt,good.source.lastSuccessAt);assert.deepEqual(v.observations,good.observations);}});
await test('hidden profile stops positions and persists stop across runs',async()=>{const f=fake({details:{...pd,positionShow:false}}),v=await run(good,f,TIME+60000);assert.equal(v.source.status,'restricted');assert.equal(v.source.refreshStopped,true);assert.equal(f.calls.length,1);const g=fake();await run(v,g,TIME+120000);assert.equal(g.calls.length,0);});
await test('access refusal and rate limit stop all further calls persistently',async()=>{for(const status of [202,401,403,418,429,451]){const f=fake({fail:{path:'/positions?',status}}),v=await run(good,f,TIME+60000);assert.equal(v.source.refreshStopped,true);assert.equal(f.calls.length,2);const g=fake();await run(v,g,TIME+120000);assert.equal(g.calls.length,0);}});
await test('long gap resets baseline; histories remain page samples',async()=>{const v=await run(good,fake({rows:[raw('2')]}),TIME+7200000);assert.equal(v.observations.at(-1).kind,'baseline');assert.equal(v.history.orders.complete,false);assert.equal(v.history.closedPositions.coverage.page,1);});
await test('history failure retains earlier sample; refusal halts remaining endpoint',async()=>{const f=fake({fail:{path:'/order-history',status:403}}),v=await run(good,f,TIME+60000);assert.equal(v.source.status,'ready');assert.equal(v.source.refreshStopped,true);assert.equal(v.history.orders.status,'stale');assert.equal(v.history.orders.fetchedAt,good.history.orders.fetchedAt);assert.equal(f.calls.length,3);});
await test('identical orders without IDs are preserved; no false unique key',async()=>{const o={symbol:'BTCUSDT',side:'BUY',positionSide:'LONG',type:'LIMIT',executedQty:'1',avgPrice:'100',totalPnl:'0',orderTime:TIME-10000,orderUpdateTime:TIME-5000};const v=await run(null,fake({orders:[o,o]}));assert.equal(v.history.orders.rows.length,2);assert.equal(v.history.orders.complete,false);assert(!('orderId' in v.history.orders.rows[0]));});
await test('oversized response rejected',async()=>{await assert.rejects(()=>request('lead-data/positions',{fetchImpl:async()=>new Response(' '.repeat(2*1024*1024+1),{headers:{'content-type':'application/json'}})}),/response_too_large/);});

await test('one-way position reversal preserves signed direction',()=>{const a=positions([raw('1','BTCUSDT','BOTH')],iso(0)),b=positions([raw('-1','BTCUSDT','BOTH')],iso(1000));assert.equal(a.positions[0].side,'LONG');assert.equal(b.positions[0].side,'SHORT');const d=changes(a,b);assert.equal(d.events[0].kind,'appeared');assert.equal(d.events[0].side,'SHORT');assert.equal(Object.keys(d.pending).length,1);});
await test('business refusal halts subsequent runs',async()=>{const f=fake({fail:{path:'/positions?',status:200,type:'application/json',body:'{"code":"429","success":false,"message":"Too many requests"}'}}),v=await run(good,f,TIME+60000);assert.equal(v.source.refreshStopped,true);assert.equal(v.source.errorCode,'source_error_429');const g=fake();await run(v,g,TIME+120000);assert.equal(g.calls.length,0);});
await test('visibility withdrawal removes old public payload records',async()=>{const v=await run(good,fake({details:{...pd,positionShow:false}}),TIME+60000);assert.equal(v.source.status,'restricted');assert.equal(v.snapshot,null);assert.equal(v.snapshots.length,0);assert.equal(v.observations.length,0);assert.equal(v.history.orders.rows.length,0);assert.equal(v.history.closedPositions.rows.length,0);assert.equal(v.source.lastSuccessAt,good.source.lastSuccessAt);});
await test('uncertain previous publication stops before any source request',async()=>{const f=fake(),v=await collect(good,{fetchImpl:f.fetchImpl,now:()=>TIME+60000,sleep:async()=>{},stopBeforeRequest:true});assert.equal(f.calls.length,0);assert.equal(v.source.refreshStopped,true);assert.equal(v.source.errorCode,'previous_run_unverified');assert.equal(v.snapshot,null);assert.equal(v.profile.visibility,'unknown');});
await test('30D performance uses exact public GET after existing requests with no credentials',async()=>{
 const f=fake(),v=await run(null,f),w=v.performance.byPeriod['30D'],call=f.calls[4];
 assert.equal(call.url,'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId='+ID+'&timeRange=30D');
 assert.equal(call.options.method,'GET');assert.equal(call.options.body,undefined);assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'manual');
 assert.deepEqual(Object.keys(v.performance.byPeriod),['30D']);assert.equal(w.roi,12.34);assert.equal(w.pnl,123.45);assert.equal(w.mdd,-4.5);assert.equal(w.winRate,66.67);
 assert.equal(w.sourceAsOf,null);assert.equal(w.sourcePeriod,'30D');assert.equal(w.currency,'USDT');assert.equal(w.status,'ready');assert.equal(w.errorCode,null);assert.equal(w.evidence.httpStatus,200);assert.match(w.evidence.sha256,/^[a-f0-9]{64}$/);assert.equal(w.evidence.receivedAt,w.lastSuccessAt);assert(validPerformance(v.performance));
});
await test('performance clock never renews source or position observation times',async()=>{
 let time=TIME;const f=fake();const v=await collect(null,{fetchImpl:f.fetchImpl,now:()=>time,sleep:async ms=>{time+=ms;}}),w=v.performance.byPeriod['30D'];
 assert.equal(v.source.lastAttemptAt,iso(0));assert.equal(v.source.lastSuccessAt,iso(2000));assert.equal(v.snapshot.observedAt,iso(2000));assert.equal(w.lastAttemptAt,iso(8000));assert.equal(w.lastSuccessAt,iso(8000));
});
await test('missing fields remain null, extra statistics ignored and percentages are not scaled',()=>{
 assert.deepEqual(performance({roi:'0.4',pnl:null,winOrders:10,totalOrder:20}),{roi:0.4,pnl:null,mdd:null,winRate:null});
 assert.deepEqual(performance({timeRange:'30D',roi:0,pnl:'-0.1',mdd:0,winRate:100}),{roi:0,pnl:-0.1,mdd:0,winRate:100});
 for(const data of [null,[],{}, {timeRange:'30D'}])if(data&& !Array.isArray(data))assert.deepEqual(performance(data),{roi:null,pnl:null,mdd:null,winRate:null});else assert.throws(()=>performance(data),/schema_changed/);
 for(const x of [true,false,[],{},'', ' 1','1e2','Infinity',NaN,Infinity])assert.throws(()=>performance({roi:x}),/schema_changed/);
 for(const winRate of [0,100,'0','100'])assert.equal(performance({winRate}).winRate,Number(winRate));
 for(const winRate of [-1,100.01,'-1','100.01'])assert.throws(()=>performance({winRate}),/schema_changed/);
 for(const timeRange of ['7D','90D','ALL',null,30])assert.throws(()=>performance({timeRange}),/schema_changed/);
});
await test('performance failure retains only its prior success without retry or renewed time',async()=>{
 const f=fake({fail:{path:'/performance?',status:503}}),v=await run(good,f,TIME+60000),w=v.performance.byPeriod['30D'];
 assert.equal(f.calls.length,5);assert.equal(v.source.refreshStopped,false);assert.equal(w.status,'stale');assert.equal(w.lastAttemptAt,iso(60000));assert.equal(w.lastSuccessAt,good.performance.byPeriod['30D'].lastSuccessAt);assert.equal(w.roi,good.performance.byPeriod['30D'].roi);assert.deepEqual(w.evidence,good.performance.byPeriod['30D'].evidence);assert.equal(w.errorCode,'http_503');assert(validPerformance(v.performance));
 const first=await run(null,fake({fail:{path:'/performance?',throw:'network_error'}}));assert.equal(first.performance.byPeriod['30D'].status,'unavailable');assert.equal(first.performance.byPeriod['30D'].lastSuccessAt,null);assert.equal(first.performance.byPeriod['30D'].roi,null);assert.equal(first.performance.byPeriod['30D'].evidence,null);assert(validPerformance(first.performance));
});
await test('performance schema and period mismatches halt after one request',async()=>{
 for(const performanceData of [null,[],{timeRange:'7D'},{roi:'bad'},{winRate:true},{winRate:-1},{winRate:100.01}]){
  const f=fake({performanceData}),v=await run(good,f,TIME+60000);assert.equal(f.calls.length,5);assert.equal(v.source.refreshStopped,true);assert.equal(v.source.errorCode,'schema_changed');assert.equal(v.performance.byPeriod['30D'].status,'stale');assert.equal(v.performance.byPeriod['30D'].lastSuccessAt,good.performance.byPeriod['30D'].lastSuccessAt);const next=fake();await run(v,next);assert.equal(next.calls.length,0);
 }
});
await test('performance HTTP and business refusals keep stop semantics and never retry',async()=>{
 for(const fail of [...[202,401,403,418,429,451].map(status=>({path:'/performance?',status})),{path:'/performance?',status:200,type:'application/json',body:'{"code":"403","success":false,"data":null}'},{path:'/performance?',status:200,type:'application/json',body:'null'}]){
  const f=fake({fail}),v=await run(good,f,TIME+60000);assert.equal(f.calls.length,5);assert.equal(v.source.refreshStopped,true);assert.equal(v.source.lastSuccessAt,iso(60000));assert.equal(v.performance.byPeriod['30D'].lastSuccessAt,good.performance.byPeriod['30D'].lastSuccessAt);const next=fake();await run(v,next);assert.equal(next.calls.length,0);
 }
});
await test('profile and historical guards prevent any performance request',async()=>{
 for(const options of [{details:{...pd,positionShow:false}},{details:{...pd,positionShow:null}},{details:{...pd,status:'INACTIVE'}},{details:{...pd,leadPortfolioId:'5075281354358777856'}},{fail:{path:'/positions?',status:403}},{fail:{path:'/order-history',status:403}},{fail:{path:'/position-history',status:429}}]){
  const f=fake(options);await run(good,f,TIME+60000);assert.equal(f.calls.some(c=>c.url.includes('/performance?')),false);
 }
});
await test('new unknown visibility immediately clears old performance and all trading payload',async()=>{
 const f=fake({details:{...pd,positionShow:null}}),out=await run(good,f,TIME+60000);
 assert.equal(f.calls.length,1);assert.equal(out.profile.visibility,'unknown');assert.equal(out.source.status,'unavailable');assert.equal(out.source.errorCode,'schema_changed');assert.equal(out.source.refreshStopped,true);assert.equal(out.source.lastSuccessAt,good.source.lastSuccessAt);
 assert.deepEqual(out.performance,{schemaVersion:1,byPeriod:{}});assert.equal(out.snapshot,null);assert.deepEqual(out.snapshots,[]);assert.deepEqual(out.observations,[]);assert.deepEqual(out.history.orders.rows,[]);assert.deepEqual(out.history.closedPositions.rows,[]);assert.deepEqual(out.pendingAbsent,{});
 const next=fake();await run(out,next,TIME+120000);assert.equal(next.calls.length,0);
});
await test('restricted and unverified states clear performance while preserving source stop',async()=>{
 const hidden=await run(good,fake({details:{...pd,positionShow:false}}),TIME+60000);assert.deepEqual(hidden.performance,{schemaVersion:1,byPeriod:{}});
 const f=fake(),out=await collect(good,{fetchImpl:f.fetchImpl,now:()=>TIME+60000,sleep:async()=>{},stopBeforeRequest:true});assert.equal(f.calls.length,0);assert.deepEqual(out.performance,{schemaVersion:1,byPeriod:{}});assert.equal(out.source.lastSuccessAt,good.source.lastSuccessAt);assert.equal(out.source.refreshStopped,true);
});
await test('old states migrate without invented metrics and malformed saved performance is rejected',()=>{
 const legacy=structuredClone(good);delete legacy.performance;assert.deepEqual(validateState(legacy).performance,{schemaVersion:1,byPeriod:{}});
 for(const mutate of [p=>p.byPeriod['7D']=p.byPeriod['30D'],p=>p.byPeriod['30D'].roi='12.34',p=>p.byPeriod['30D'].winRate=-1,p=>p.byPeriod['30D'].winRate=100.01,p=>p.byPeriod['30D'].evidence.sha256='bad',p=>p.byPeriod['30D'].sourceAsOf=iso(0)]){const value=structuredClone(good);mutate(value.performance);assert.throws(()=>validateState(value),/invalid_previous_state/);}
 for(const winRate of [0,100]){const value=structuredClone(good);value.performance.byPeriod['30D'].winRate=winRate;assert(validPerformance(value.performance));assert.equal(validateState(value).performance.byPeriod['30D'].winRate,winRate);}
 const hidden=structuredClone(good);hidden.profile.visibility='restricted';hidden.source.status='restricted';hidden.source.refreshStopped=true;hidden.performance={broken:true};assert.deepEqual(validateState(hidden).performance,{schemaVersion:1,byPeriod:{}});
});
console.log('PASS '+passed+' Binance collector checks');
})().catch(e=>{console.error(e);process.exitCode=1;});
