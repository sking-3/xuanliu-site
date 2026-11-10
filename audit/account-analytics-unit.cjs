'use strict';
/* Entirely offline fixtures. No production accounts or captured responses needed. */
const assert=require('node:assert/strict');
const API=require('../trader/account-analytics.js');
const T=1800000000000,A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40);
const addr=i=>'0x'+i.toString(16).padStart(40,'0');
const sample=(pnl=[0,10,5],equity=[100,110,105],period='perpMonth')=>[[period,{pnlHistory:pnl.map((v,i)=>[T-3000+i*1000,String(v)]),accountValueHistory:equity.map((v,i)=>[T-3000+i*1000,String(v)])}]];
const baseFill={coin:'BTC',time:T-1000,dir:'Close Long',side:'A',sz:'1',startPosition:'2',closedPnl:'10',fee:'1',feeToken:'USDC',tid:1,oid:101,hash:'0x123'};
const fill=(changes={})=>({...baseFill,...changes});
function response(payload,status=200,headers={}) {
  const content=typeof payload==='string'?payload:JSON.stringify(payload);
  const map={'content-type':'application/json',...headers};
  return {status,headers:{get:key=>map[key.toLowerCase()]??null},text:async()=>content};
}
function env(handler,options={}) {
  let time=T,serial=0;const timers=new Map(),calls=[],events=[];
  const fetch=async(url,settings)=>{const call={url,settings,body:JSON.parse(settings.body)};calls.push(call);return handler?handler(call,calls.length):response(call.body.type==='portfolio'?sample():[fill()]);};
  const setTimer=(fn,delay)=>{const id=++serial;timers.set(id,{fn,at:time+delay});return id;};
  const clearTimer=id=>timers.delete(id);
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  const advance=async(ms)=>{const until=time+ms;for(;;){const ready=[...timers.entries()].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!ready)break;time=ready[1].at;timers.delete(ready[0]);ready[1].fn();await flush();}time=until;await flush();};
  const client=API.create({fetch,now:()=>time,setTimer,clearTimer,onChange:r=>events.push(r),...options});
  return {client,calls,timers,events,flush,advance,now:()=>time};
}
let count=0;
async function test(name,fn){await fn();count++;console.log('ok '+name);}
(async()=>{
await test('MDD uses equity at the running PnL peak, not cumulative PnL denominator',()=>{
  const result=API.normalize.portfolio(sample(),T).windows['30D'];
  assert.equal(result.mdd,5/110*100);assert.notEqual(result.mdd,50);
  assert.equal(result.sampleCount,3);assert.equal(result.sourcePeriod,'perpMonth');assert.equal(result.scope,'perp_account');
  assert.deepEqual(result.points.map(p=>p.value),[0,10,5]);assert.equal(result.mddUnit,'percent');
});
await test('sampled MDD may exceed 100 and is not clipped',()=>{
  assert.equal(API.normalize.portfolio(sample([0,100,-200],[100,100,1]),T).windows['30D'].mdd,300);
});
await test('native windows retain source periods while longer windows are explicitly derived',()=>{
  const p=[...sample([0,1],[100,101],'perpWeek'),...sample([0,2],[100,102],'perpMonth'),...sample([0,3],[100,103],'perpAllTime'),...sample([0,999],[100,999],'month')];
  const w=API.normalize.portfolio(p,T).windows;assert.deepEqual(Object.keys(w),['7D','30D','ALL','90D','180D','365D']);assert.equal(w['30D'].points[1].value,2);assert.equal(w['90D'].derived,true);assert.equal(w.ALL.derived,false);assert.equal(w['90D'].roi,null);assert.equal(w['90D'].sourcePeriod,'perpAllTime');
});
await test('all-account history cannot silently substitute for missing perp windows',()=>{
  const onlyAll=[...sample([0,999],[100,1099],'week'),...sample([0,999],[100,1099],'month'),...sample([0,999],[100,1099],'allTime')];
  assert.deepEqual(API.normalize.portfolio(onlyAll,T).windows,{});
  const w=API.normalize.portfolio([...onlyAll,...sample([0,20],[100,120],'perpAllTime')],T).windows;
  for(const period of ['ALL','90D','180D','365D']){assert.equal(w[period].scope,'perp_account');assert.equal(w[period].sourcePeriod,'perpAllTime');assert.equal(w[period].pnl,20);}
  assert.equal(w['30D'],undefined);
});
await test('real curve is rebased PnL in USD and does not recompute source ROI',()=>{
  const w=API.normalize.portfolio(sample([30,25,40]),T).windows['30D'];
  assert.deepEqual(w.points.map(p=>p.value),[0,-5,10]);assert.equal(w.roi,undefined);assert.equal(w.curveUnit,'USD');assert.equal(w.points[1].time,new Date(T-2000).toISOString());
});
await test('missing, zero-denominator, all-negative and single-sample windows stay unavailable',()=>{
  for(const p of [sample([],[]),sample([0],[100]),sample([-10,-20],[100,90]),sample([0,-5],[0,0]),sample([0,10],[0,100])])assert.equal(API.normalize.portfolio(p,T).windows['30D'].mdd,null);
  const p=sample();delete p[0][1].accountValueHistory;assert.equal(API.normalize.portfolio(p,T).windows['30D'].mddUnavailableReason,'unpaired_samples');
  assert.deepEqual(API.normalize.portfolio([],T).windows,{});
});
await test('mismatched sample timestamps never pair or interpolate',()=>{
  const p=sample();p[0][1].accountValueHistory[1][0]++;
  const w=API.normalize.portfolio(p,T).windows['30D'];assert.equal(w.mdd,null);assert.equal(w.mddUnavailableReason,'unpaired_samples');assert.equal(w.points.length,3);
});
await test('paired rising samples support actual zero drawdown',()=>{
  assert.equal(API.normalize.portfolio(sample([0,1,2],[100,101,102]),T).windows['30D'].mdd,0);
});
await test('malformed monetary numbers, duplicate/out-of-order timestamps and duplicate periods reject',()=>{
  for(const value of ['NaN','Infinity','',null,true,'1e30',{},'0x10']){const p=sample();p[0][1].pnlHistory[1][1]=value;assert.throws(()=>API.normalize.portfolio(p,T),/invalid_response/);}
  const p=sample();p[0][1].pnlHistory[1][0]=p[0][1].pnlHistory[0][0];assert.throws(()=>API.normalize.portfolio(p,T));
  assert.throws(()=>API.normalize.portfolio([...sample(),...sample()],T));
  assert.deepEqual(API.normalize.portfolio([['__proto__',{}],['constructor',{}]],T).windows,{});
});
await test('actual-point extrema downsampling is bounded and keeps original source count',()=>{
  const points=Array.from({length:2000},(_,i)=>({time:new Date(T-3000000+i*1000).toISOString(),value:i===627?9000:i===1120?-5000:i%31}));
  const plot=API.downsample(points);assert(plot.length<=240);assert.deepEqual(plot[0],points[0]);assert.deepEqual(plot.at(-1),points.at(-1));assert(plot.some(p=>p.value===9000));assert(plot.some(p=>p.value===-5000));
  const original=new Set(points.map(p=>JSON.stringify(p)));assert(plot.every(p=>original.has(JSON.stringify(p))));
  const histories=points.map(p=>[Date.parse(p.time),String(p.value)]);
  const w=API.normalize.portfolio([['perpMonth',{pnlHistory:histories,accountValueHistory:histories.map(([t])=>[t,'10000'])}]],T).windows['30D'];
  assert.equal(w.sampleCount,2000);assert(w.points.length<=240);assert.equal(w.mdd,140);
});
const DAY=86400000;
const longPortfolio=(days,values=days.map((_,i)=>i*10),equities=days.map(()=>100),end=T-10000)=>[['perpAllTime',{
  pnlHistory:days.map((day,i)=>[end-day*DAY,String(values[i])]),
  accountValueHistory:days.map((day,i)=>[end-day*DAY,String(equities[i])])}]];
await test('long windows anchor to source end and use exact real boundaries without lifetime ROI',()=>{
  const p=longPortfolio([400,365,180,90,0],[1000,20,30,40,50]);
  const w=API.normalize.portfolio(p,T).windows;
  for(const days of [90,180,365]) {
    const x=w[days+'D'];assert.equal(x.requestedEndAt,new Date(T-10000).toISOString());
    assert.equal(x.requestedStartAt,new Date(T-10000-days*DAY).toISOString());assert.equal(x.startAt,x.requestedStartAt);
    assert.equal(x.endAt,x.requestedEndAt);assert.equal(x.coverageDays,days);assert.equal(x.coverageStatus,'full');
    assert.equal(x.roi,null);assert.equal(x.roiUnavailableReason,'cash_flow_adjusted_return_unavailable');
    assert.equal(x.points[0].value,0);assert.equal(x.pnl,x.points.at(-1).value);assert.equal(x.sourceSampleCount,5);
    assert.equal(x.sourceHistoryStartAt,new Date(T-10000-400*DAY).toISOString());assert.equal(x.mddMethod,'window_pnl_peak_equity');
    assert(x.points.every(point=>p[0][1].pnlHistory.some(([time])=>time===Date.parse(point.time))));
  }
  assert.equal(w['90D'].pnl,10);assert.equal(w['180D'].pnl,20);assert.equal(w['365D'].pnl,30);
  assert.equal(w.ALL.roi,undefined);assert.equal(w.ALL.sourcePeriod,'perpAllTime');assert.equal(w.ALL.mddMethod,'hyperliquid_ui_pnl_peak_equity');
  assert.equal(w.ALL.pnl,-950);assert.equal(w.ALL.coverageDays,400);assert.equal(w.ALL.coverageStatus,'source_window');
  assert.equal(w.ALL.requestedStartAt,null);assert.equal(w.ALL.requestedEndAt,w.ALL.endAt);
});
await test('sparse boundaries omit out-of-window samples and describe actual coverage',()=>{
  const w=API.normalize.portfolio(longPortfolio([400,190,170,80,0],[500,600,100,150,120]),T).windows['180D'];
  assert.equal(w.coverageStatus,'sampled_boundary');assert.equal(w.coverageDays,170);assert.equal(w.sampleCount,3);
  assert.equal(w.startAt,new Date(T-10000-170*DAY).toISOString());assert.notEqual(w.startAt,w.requestedStartAt);
  assert.deepEqual(w.points.map(point=>point.value),[0,50,20]);assert.equal(w.pnl,20);assert.equal(w.maxSampleGapMs,90*DAY);
  assert.equal(w.mdd,30);assert.equal(w.mddPairedSampleCount,3);
});
await test('short histories keep actual interval PnL but never claim full long-period coverage or ROI',()=>{
  const w=API.normalize.portfolio(longPortfolio([20,10,0],[200,180,230]),T).windows;
  for(const period of ['90D','180D','365D']) {
    const x=w[period];assert.equal(x.coverageStatus,'insufficient_history');assert.equal(x.coverageDays,20);
    assert.equal(x.pnl,30);assert.equal(x.roi,null);assert.equal(x.sampleCount,3);assert.equal(x.mdd,20);
  }
});
await test('empty and single-point allTime remain explicit unavailable derived windows',()=>{
  const empty=API.normalize.portfolio(longPortfolio([],[],[]),T).windows['180D'];
  for(const field of ['pnl','mdd','startAt','endAt','requestedStartAt','requestedEndAt','sourceHistoryStartAt','sourceHistoryEndAt','maxSampleGapMs'])assert.equal(empty[field],null,field);
  assert.equal(empty.coverageDays,0);assert.equal(empty.sampleCount,0);assert.equal(empty.sourceSampleCount,0);assert.equal(empty.mddPairedSampleCount,0);
  assert.equal(empty.coverageStatus,'insufficient_history');assert.equal(empty.mddUnavailableReason,'insufficient_samples');assert.deepEqual(empty.points,[]);
  const single=API.normalize.portfolio(longPortfolio([0]),T).windows['180D'];
  assert.equal(single.pnl,null);assert.equal(single.mdd,null);assert.equal(single.coverageDays,0);assert.equal(single.sampleCount,1);assert.equal(single.maxSampleGapMs,null);
  assert.deepEqual(single.points.map(point=>point.value),[0]);assert.equal(single.coverageStatus,'insufficient_history');
  // The history spans the boundary but leaves only its final sample inside it.
  const gap=API.normalize.portfolio(longPortfolio([400,181,0]),T).windows['180D'];
  assert.equal(gap.coverageStatus,'sampled_boundary');assert.equal(gap.pnl,null);assert.equal(gap.mdd,null);assert.equal(gap.sampleCount,1);
});
await test('derived drawdown rebases at the actual boundary and requires exact equity timestamp pairs',()=>{
  const p=longPortfolio([400,180,90,0],[1000,100,80,110],[1000,100,80,110]);
  let w=API.normalize.portfolio(p,T).windows['180D'];assert.equal(w.mdd,20);assert.deepEqual(w.points.map(point=>point.value),[0,-20,10]);
  p[0][1].accountValueHistory[2][0]++;
  w=API.normalize.portfolio(p,T).windows['180D'];assert.equal(w.mdd,null);assert.equal(w.mddUnavailableReason,'unpaired_samples');assert.equal(w.pnl,10);assert.equal(w.mddPairedSampleCount,0);
  // An extra equity sample outside the actual selected PnL range is not paired.
  const sparse=longPortfolio([400,170,0],[1000,100,90]);sparse[0][1].accountValueHistory.splice(1,0,[T-10000-175*DAY,'500']);
  w=API.normalize.portfolio(sparse,T).windows['180D'];assert.equal(w.mdd,10);assert.equal(w.mddPairedSampleCount,2);
});
await test('no valid peak comparison stays unavailable; negative peak equity fails closed',()=>{
  for(const equity of [0,-5]) {
    const w=API.normalize.portfolio(longPortfolio([180,90,0],[100,90,110],[equity,100,120]),T).windows['180D'];
    assert.equal(w.mdd,null);assert.equal(w.mddUnavailableReason,equity<0?'non_positive_peak_equity':'no_valid_peak');
  }
  const rising=API.normalize.portfolio(longPortfolio([180,90,0],[100,110,120]),T).windows['180D'];assert.equal(rising.mdd,0);
});
await test('initial zero peak equity does not erase later valid source drawdown',()=>{
  const w=API.normalize.portfolio(sample([0,-1,10,5],[0,100,120,115]),T).windows['30D'];
  assert.equal(w.mdd,5/120*100);assert.equal(w.mddUnavailableReason,null);assert.equal(w.mddPairedSampleCount,4);
  // A negative peak denominator remains a failure, even if later peaks recover.
  const negative=API.normalize.portfolio(sample([0,-1,10,5],[-2,100,120,115]),T).windows['30D'];
  assert.equal(negative.mdd,null);assert.equal(negative.mddUnavailableReason,'non_positive_peak_equity');
});
await test('derived windows follow the same zero-peak convention without inventing zero risk',()=>{
  const w=API.normalize.portfolio(longPortfolio([180,120,60,0],[100,99,110,105],[0,100,120,115]),T).windows['180D'];
  assert.equal(w.mdd,5/120*100);assert.equal(w.mddPairedSampleCount,4);assert.equal(w.roi,null);
  const none=API.normalize.portfolio(sample([0,-1,10],[0,100,120]),T).windows['30D'];
  assert.equal(none.mdd,null);assert.equal(none.mddUnavailableReason,'no_valid_peak');
});
await test('long-window sampling counts and gaps are measured before plotting downsampling',()=>{
  const days=Array.from({length:1001},(_,i)=>(1000-i)/2),values=days.map((_,i)=>i===800?10000:i===850?-1000:i);
  const w=API.normalize.portfolio(longPortfolio(days,values,days.map(()=>10000)),T).windows['180D'];
  assert.equal(w.sampleCount,361);assert.equal(w.sourceSampleCount,1001);assert.equal(w.maxSampleGapMs,DAY/2);assert.equal(w.coverageDays,180);
  assert(w.points.length<=240);assert.equal(w.points[0].value,0);assert.equal(w.points.at(-1).value,360);assert.equal(w.pnl,360);
  assert(w.points.some(point=>point.value===9360));assert(w.points.some(point=>point.value===-1640));assert(Math.abs(w.mdd-110)<1e-10);
});
await test('zero gross PnL closing fills count losses from fees and rebates can win',()=>{
  const r=API.normalize.winRate([fill({closedPnl:'0',fee:'1'}),fill({tid:2,closedPnl:'0',fee:'-0.1'}),fill({tid:3,closedPnl:'0',fee:'0'})],T);
  assert.equal(r.winning,1);assert.equal(r.losing,1);assert.equal(r.breakeven,1);assert(Math.abs(r.value-100/3)<1e-10);assert.equal(r.eligibleCount,3);
});
await test('same-order partial fills remain separate; only exact duplicate fills collapse',()=>{
  const a=fill(),b=fill({tid:2,closedPnl:'-1'});const r=API.normalize.winRate([a,a,b],T);
  assert.equal(r.totalFills,2);assert.equal(r.receivedFills,3);assert.equal(r.duplicateCount,1);assert.equal(r.eligibleCount,2);assert.equal(r.value,50);
  assert.throws(()=>API.normalize.winRate([a,{...a,closedPnl:'999'}],T),/invalid_response/);
});
await test('spot, builder DEX, unknown fees, reversals and contradictory position signs excluded',()=>{
  const changes=[{coin:'@107'},{coin:'BTC/USDC'},{coin:'xyz:TSLA'},{dir:'Long > Short'},{dir:'Open Long'},{feeToken:'PURR'},{side:'B'},{startPosition:'-2'},{startPosition:'0'},{sz:'3'}];
  const r=API.normalize.winRate(changes.map((change,i)=>fill({tid:i+1,...change})),T);assert.equal(r.eligibleCount,0);assert.equal(r.excludedCount,10);assert.equal(r.value,null);
});
await test('legitimate Close Short and floating decimal size roundoff are accepted',()=>{
  const r=API.normalize.winRate([fill({dir:'Close Short',side:'B',startPosition:'-0.3',sz:0.1+0.2})],T);assert.equal(r.eligibleCount,1);assert.equal(r.value,100);
});
await test('sample coverage, fee scope, caps and empty samples are explicit',()=>{
  const r=API.normalize.winRate([fill({time:T-5000}),fill({tid:2,time:T-3000,dir:'Open Long'}),fill({tid:3,time:T-2000})],T);
  assert.equal(r.startAt,new Date(T-5000).toISOString());assert.equal(r.endAt,new Date(T-2000).toISOString());assert.equal(r.historyComplete,false);assert.equal(r.includesOpeningFees,false);assert.equal(r.includesFunding,false);assert.equal(r.method,'closing_fill_net_of_closing_fee');
  const capped=API.normalize.winRate(Array.from({length:2000},(_,i)=>fill({tid:i})),T);assert.equal(capped.capped,true);assert.equal(capped.totalFills,2000);
  const empty=API.normalize.winRate([],T);assert.equal(empty.value,null);assert.equal(empty.startAt,null);assert.equal(empty.eligibleCount,0);
});
await test('malformed fill numbers/future timestamps/unsafe IDs do not become zero wins',()=>{
  for(const changes of [{closedPnl:'NaN'},{fee:null},{sz:'0'},{startPosition:true},{time:T+300001},{tid:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>API.normalize.winRate([fill(changes)],T));
});
await test('only official read-only POST, no credentials, and source metadata reaches state',async()=>{
  const e=env();await e.client.ensurePortfolio(A);await e.client.ensureWinRate(A);
  assert.equal(e.calls.length,2);for(const c of e.calls){assert.equal(c.url,API.endpoints.info);assert.equal(c.settings.method,'POST');assert.equal(c.settings.credentials,'omit');assert.equal(c.settings.redirect,'error');assert.equal(c.settings.cache,'no-store');assert.equal(c.body.user,A);}
  assert.deepEqual(e.calls[1].body,{type:'userFills',user:A,aggregateByTime:false});assert.equal(e.client.get(A).portfolio.fetchedAt,new Date(T).toISOString());assert.equal(e.client.get(A).win.value,100);e.client.destroy();assert.equal(e.timers.size,0);
});
await test('inflight requests deduplicate and five-minute memory cache avoids extra API weight',async()=>{
  let release;const delayed=new Promise(r=>release=r);const e=env(async()=>{await delayed;return response(sample());});
  const p=e.client.ensurePortfolio(A),p2=e.client.ensurePortfolio(A.toUpperCase().replace('0X','0x'));assert.equal(p,p2);assert.equal(e.calls.length,1);release();await p;
  await e.client.ensurePortfolio(A);assert.equal(e.calls.length,1);await e.advance(300000);await e.client.ensurePortfolio(A);assert.equal(e.calls.length,2);e.client.destroy();
});
await test('at most two concurrent requests and queued work starts only when one settles',async()=>{
  const releases=[];const e=env(()=>new Promise(resolve=>releases.push(()=>resolve(response(sample())))));
  const p=[1,2,3,4].map(i=>e.client.ensurePortfolio(addr(i)));assert.equal(e.calls.length,2);assert.equal(e.client.get(addr(3)).portfolio.status,'queued');
  releases[0]();await e.flush();assert.equal(e.calls.length,3);releases[1]();await e.flush();assert.equal(e.calls.length,4);releases[2]();releases[3]();await Promise.all(p);e.client.destroy();
});
await test('rolling 400/min weight budget includes wins and resumes after actual expiry',async()=>{
  const e=env();for(let i=1;i<=3;i++)await e.client.ensureWinRate(addr(i));for(let i=4;i<=5;i++)await e.client.ensurePortfolio(addr(i));
  assert.equal(e.calls.length,5);const pending=e.client.ensurePortfolio(addr(6));await e.flush();assert.equal(e.calls.length,5);assert.equal(e.client.get(addr(6)).portfolio.status,'queued');
  await e.advance(59999);assert.equal(e.calls.length,5);await e.advance(1);await pending;assert.equal(e.calls.length,6);e.client.destroy();
});
await test('HTTP403 halts all queued/inflight automatic reads; only explicit retry can proceed',async()=>{
  let blocked=true;const e=env(()=>response(blocked?'blocked':sample(),blocked?403:200));
  const p=[A,B,addr(3)].map(a=>e.client.ensurePortfolio(a));await Promise.all(p);assert.equal(e.calls.length,2);assert.equal(e.client.get(A).portfolio.errorCode,'http_403');assert.equal(e.client.get(B).portfolio.errorCode,'http_403');
  await e.advance(120000);await e.client.ensurePortfolio(A);await e.client.ensurePortfolio(addr(4));assert.equal(e.calls.length,2);blocked=false;await e.client.ensurePortfolio(A,{force:true});assert.equal(e.calls.length,3);assert.equal(e.client.get(A).portfolio.status,'ready');e.client.destroy();
});
await test('HTTP429 obeys Retry-After even on a user retry and does not auto-resume',async()=>{
  let blocked=true;const e=env(()=>response(blocked?'slow':sample(),blocked?429:200,{'retry-after':'90'}));
  await e.client.ensurePortfolio(A);assert.equal(e.client.get(A).portfolio.retryAfterAt,new Date(T+90000).toISOString());
  blocked=false;await e.client.ensurePortfolio(A,{force:true});assert.equal(e.calls.length,1);await e.advance(90000);assert.equal(e.calls.length,1);await e.client.ensurePortfolio(A,{force:true});assert.equal(e.calls.length,2);e.client.destroy();
});
await test('network/CORS errors are visible, preserve old real data and never silently retry',async()=>{
  let fail=false;const e=env(()=>{if(fail)throw TypeError('Failed to fetch');return response(sample());});await e.client.ensurePortfolio(A);fail=true;await e.client.ensurePortfolio(A,{force:true});
  const s=e.client.get(A).portfolio;assert.equal(s.status,'error');assert.equal(s.errorCode,'network_error');assert.equal(s.windows['30D'].sampleCount,3);assert.equal(s.fetchedAt,new Date(T).toISOString());await e.advance(400000);await e.client.ensurePortfolio(A);assert.equal(e.calls.length,2);e.client.destroy();
});
await test('HTML, invalid JSON, declared oversized bodies and actual oversized bodies fail closed',async()=>{
  for(const resp of [response('<html>',200,{'content-type':'text/html'}),response('not json'),response({},200,{'content-length':String(API.limits.maxBytes+1)}),response(' '.repeat(API.limits.maxBytes+1))]){
    const e=env(()=>resp);await e.client.ensurePortfolio(A);assert.equal(e.client.get(A).portfolio.status,'error');assert.deepEqual(e.client.get(A).portfolio.windows,{});e.client.destroy();
  }
});
await test('stream response byte cap enforced before unbounded JSON parsing',async()=>{
  let cancelled=false,part=0;const e=env(()=>({status:200,headers:{get:()=> 'application/json'},body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(++part===1?API.limits.maxBytes:1)}),cancel:async()=>{cancelled=true;},releaseLock(){}})}}));
  await e.client.ensurePortfolio(A);assert.equal(e.client.get(A).portfolio.errorCode,'response_too_large');assert(cancelled);e.client.destroy();
});
await test('12s timeout includes stalled body consumption, not only response headers',async()=>{
  const e=env(()=>({status:200,headers:{get:k=>k==='content-type'?'application/json':null},text:()=>new Promise(()=>{})}));const p=e.client.ensurePortfolio(A);await e.flush();await e.advance(12000);await p;
  assert.equal(e.client.get(A).portfolio.errorCode,'request_timeout');assert(e.calls[0].settings.signal.aborted);assert.equal(e.timers.size,0);e.client.destroy();
});
await test('hidden page cancels pending work, ignores late replies, and resumes targets only',async()=>{
  const releases=[];const e=env(()=>new Promise(resolve=>releases.push(resolve)));e.client.setPortfolioTargets([A,B]);
  const p=e.client.ensurePortfolio(A),win=e.client.ensureWinRate(B);assert.equal(e.calls.length,2);e.client.setVisible(false);await Promise.all([p,win]);assert(e.calls.every(c=>c.settings.signal.aborted));assert.equal(e.timers.size,0);
  releases[0](response(sample()));releases[1](response([fill()]));await e.flush();assert.equal(e.client.get(A).portfolio.status,'idle');assert.equal(e.client.get(B).win.status,'idle');await e.advance(70000);assert.equal(e.calls.length,2);
  e.client.setVisible(true);assert.equal(e.calls.length,4);assert(e.calls.slice(2).every(c=>c.body.type==='portfolio'));e.client.destroy();for(const release of releases.slice(2))release(response(sample()));await e.flush();assert.equal(e.timers.size,0);
});
await test('page changes cancel departing targets and late A response cannot overwrite B',async()=>{
  const releases=[];const e=env(()=>new Promise(resolve=>releases.push(resolve)));e.client.setPortfolioTargets([A]);const a=e.client.ensurePortfolio(A);e.client.setPortfolioTargets([B]);const b=e.client.ensurePortfolio(B);await a;
  releases[1](response(sample([0,20],[100,120])));await b;releases[0](response(sample()));await e.flush();assert.equal(e.client.get(A).portfolio.status,'idle');assert.equal(e.client.get(B).portfolio.windows['30D'].points[1].value,20);
  await e.client.ensurePortfolio(A);assert.equal(e.calls.length,2);e.client.destroy();
});
await test('destroy resolves queued promises, aborts requests, clears timers and suppresses all late events',async()=>{
  const releases=[];const e=env(()=>new Promise(resolve=>releases.push(resolve)));const promises=[A,B,addr(3)].map(a=>e.client.ensurePortfolio(a));const n=e.events.length;e.client.destroy();await Promise.all(promises);assert.equal(e.timers.size,0);assert(e.calls.every(c=>c.settings.signal.aborted));
  releases.forEach(r=>r(response(sample())));await e.flush();assert.equal(e.events.length,n);await e.client.ensurePortfolio(addr(4));assert.equal(e.calls.length,2);
});
await test('record cache is bounded to 200 and callers cannot mutate internal data',async()=>{
  const e=env();await e.client.ensurePortfolio(A);const s=e.client.get(A);s.portfolio.windows['30D'].mdd=999;assert.notEqual(e.client.get(A).portfolio.windows['30D'].mdd,999);
  for(let i=3;i<204;i++)e.client.get(addr(i));assert.equal(e.client.get(A).portfolio.status,'idle');assert.throws(()=>e.client.get('not-an-account'));assert.throws(()=>e.client.setPortfolioTargets(Array(13).fill(A)));e.client.destroy();
});
await test('portfolio-only targets automatically fetch curves without requesting closing fills',async()=>{
  const e=env(),accounts=Array.from({length:12},(_,i)=>addr(i+1));e.client.setPortfolioTargets(accounts);
  for(let i=0;i<5;i++)await e.flush();
  assert.equal(e.calls.length,12);assert(e.calls.every(c=>c.body.type==='portfolio'));
  assert(accounts.every(a=>e.client.get(a).portfolio.status==='ready'&&e.client.get(a).win.status==='idle'));
  e.client.setPortfolioTargets(accounts);await e.flush();assert.equal(e.calls.length,12);
  e.client.setVisible(false);e.client.setVisible(true);await e.flush();assert.equal(e.calls.length,12);e.client.destroy();
});
await test('automatic targets load curves first and wins without clicks, with shared cache and budget',async()=>{
  const e=env(),accounts=Array.from({length:12},(_,i)=>addr(i+1));e.client.setTargets(accounts);
  for(let i=0;i<5;i++)await e.flush();
  assert.equal(e.calls.length,13);assert(e.calls.slice(0,12).every(c=>c.body.type==='portfolio'));assert.equal(e.calls[12].body.type,'userFills');
  assert.equal(e.calls.reduce((n,c)=>n+(c.body.type==='portfolio'?20:120),0),360);
  e.client.setTargets(accounts);await e.flush();assert.equal(e.calls.length,13);
  await e.client.ensureWinRate(addr(99));assert.equal(e.calls.length,13);assert.equal(e.client.get(addr(99)).win.status,'idle');
  for(let minute=0;minute<4;minute++){await e.advance(60000);for(let i=0;i<3;i++)await e.flush();}
  assert.equal(e.calls.length,24);assert(accounts.every(a=>e.client.get(a).win.status==='ready'));
  e.client.setTargets(accounts);await e.flush();assert.equal(e.calls.length,24);e.client.destroy();
});
await test('target changes cancel both active and queued automatic wins and ignore late replies',async()=>{
  const pending=[];const e=env(call=>call.body.type==='portfolio'?response(sample()):new Promise(resolve=>pending.push({account:call.body.user,resolve})));
  e.client.setTargets([A,B,addr(3)]);for(let i=0;i<3;i++)await e.flush();
  assert.equal(pending.length,2);assert.equal(e.client.get(addr(3)).win.status,'queued');
  e.client.setTargets([addr(4)]);await e.flush();assert.equal(e.client.get(A).win.status,'idle');assert.equal(e.client.get(B).win.status,'idle');assert.equal(e.client.get(addr(3)).win.status,'idle');
  assert(e.calls.filter(c=>c.body.type==='userFills').every(c=>c.settings.signal.aborted));
  pending[0].resolve(response([fill()]));pending[1].resolve(response([fill()]));await e.flush();assert.equal(e.client.get(A).win.status,'idle');
  await e.advance(60000);assert.equal(pending.length,3);assert.equal(pending[2].account,addr(4));pending[2].resolve(response([fill()]));await e.flush();assert.equal(e.client.get(addr(4)).win.value,100);e.client.destroy();
});
await test('visibility resumes both automatic metrics, not an off-page thirteenth account',async()=>{
  const pending=[];let delay=true;const e=env(call=>delay?new Promise(resolve=>pending.push({call,resolve})):response(call.body.type==='portfolio'?sample():[fill()]));
  e.client.setTargets([A]);assert.equal(e.calls.length,2);e.client.setVisible(false);assert(e.calls.every(c=>c.settings.signal.aborted));
  pending.forEach(p=>p.resolve(response(p.call.body.type==='portfolio'?sample():[fill()])));await e.flush();assert.equal(e.client.get(A).win.status,'idle');
  await e.advance(60000);assert.equal(e.calls.length,2);delay=false;e.client.setVisible(true);await e.flush();assert.equal(e.calls.length,4);assert.deepEqual(e.calls.slice(2).map(c=>c.body.type),['portfolio','userFills']);
  assert.equal(e.client.get(A).win.status,'ready');await e.client.ensureWinRate(B);assert.equal(e.calls.length,4);e.client.destroy();
});
await test('automatic targets remain paused after403 until an explicit error retry',async()=>{
  let blocked=true;const e=env(call=>response(blocked?'blocked':call.body.type==='portfolio'?sample():[fill()],blocked?403:200));e.client.setTargets([A,B]);await e.flush();assert.equal(e.calls.length,2);
  blocked=false;await e.advance(60000);e.client.setTargets([A,B]);e.client.setVisible(false);e.client.setVisible(true);await e.flush();assert.equal(e.calls.length,2);assert.equal(e.client.get(A).win.errorCode,'http_403');
  await e.client.ensureWinRate(A,{force:true});assert.equal(e.calls.length,3);assert.equal(e.client.get(A).win.value,100);e.client.destroy();
});
console.log(`${count} account-analytics tests passed. Offline fixtures only; no API calls.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
