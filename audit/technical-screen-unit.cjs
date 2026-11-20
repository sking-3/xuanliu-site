'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createClient} = require('../screening/technical-screen.js');
function memoryStorage(){const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
let run;
test.beforeEach(()=>{run=createClient({fetch:(...args)=>globalThis.fetch(...args),now:()=>Date.now(),localStorage:memoryStorage()}).run;});

const day = '2026-11-13';
const closing = day + 'T07:00:00Z';
const stock = {code:'600519.SH', asOf:closing};
const endpointHosts = ['web.ifzq.gtimg.cn','proxy.finance.qq.com'];
const addDays = (day,n) => new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);

function rows(prices, end=day) {
  const dates = [];
  for (let date=end; dates.length<prices.length; date=addDays(date,-1)) {
    if (![0,6].includes(new Date(date+'T00:00:00Z').getUTCDay())) dates.unshift(date);
  }
  return prices.map((value,i) => [dates[i],String(value),String(value),String(value),String(value),'100']);
}
const sequence = Array.from({length:60}, (_,i)=>100+i*2);
const succeed = entry => ({ok:true, status:200, json:async()=>({code:0,data:{sh600519:entry}})});
const call = (t, input, fn) => {
  t.mock.method(Date,'now',()=>Date.parse('2026-11-16T08:00:00Z'));
  const request=t.mock.method(global,'fetch', fn || (async()=>succeed(input)));
  return request;
};

test('browser and CommonJS expose the same entry point',()=>{
  const scope={};
  vm.runInNewContext(fs.readFileSync(require.resolve('../screening/technical-screen.js'),'utf8'),scope);
  assert.equal(typeof scope.BooksTechnicalScreen.run,'function');
  assert.equal(typeof scope.BooksTechnicalScreen.history,'function');
  assert.equal(typeof createClient({}).history,'function');
  assert.equal(typeof run,'function');
});

test('adjusted closes, not intraday highs, produce source MA offsets and turtle ties',async t=>{
  const adjusted=rows(sequence);
  adjusted[50][3]='888.00';
  adjusted[58][2]=adjusted[58][3]=adjusted[59][2];
  const request=call(t,{qfqday:adjusted,day:rows(Array(60).fill(3))});
  const result=await run(stock,day);
  const closes=adjusted.map(row=>Number(row[2]));
  const target = (closes.slice(30).reduce((a,b)=>a+b)/closes.slice(1,31).reduce((a,b)=>a+b)-1)*100;
  assert.equal(result.status,'ready');assert.equal(result.close,218);assert.equal(result.high60,218);
  assert.equal(result.turtle,true);assert.equal(result.increasing,true);assert.ok(Math.abs(result.ma30GrowthPct-target)<1e-9);
  const url=request.mock.calls[0].arguments[0];
  assert.equal(url.hostname,endpointHosts[0]);
  assert.deepEqual(url.searchParams.get('param').split(','),['sh600519','day','2025-11-18',day,'640','qfq']);
  assert.equal(request.mock.calls.length,1);
});

test('a failed primary transport can use the second host with explicit adjusted bars',async t=>{
  let attempts=0;
  const request=call(t,null,async()=>{
    if (attempts++===0) throw Error('network down');
    return succeed({qfqday:rows(Array(60).fill(10))});
  });
  const result=await run(stock,day);
  assert.deepEqual(request.mock.calls.map(c=>c.arguments[0].hostname),endpointHosts);
  assert.deepEqual([result.status,result.high60,result.turtle,result.increasing,result.ma30GrowthPct],['ready',10,true,false,0]);
});

test('an empty adjustment key cannot be replaced by raw prices',async t=>{
  call(t,{qfqday:[],day:rows(sequence)});
  assert.match((await run(stock,day)).reason,/前复权/);
});

test('the 20-percent MA growth threshold is strict, and ties at intermediate checkpoints fail',async t=>{
  // Mean at offset 1 = 100; mean at offset 30 = 120.
  const exact=Array(31).fill(100).concat(Array(28).fill(120),140);
  const entry={qfqday:rows(exact)};
  call(t,entry);
  const boundary=await run(stock,day);
  assert.ok(Math.abs(boundary.ma30GrowthPct-20)<1e-9);
  assert.equal(boundary.increasing,false);
  const late=Array(41).fill(100).concat(Array(19).fill(200));
  entry.qfqday=rows(late);
  const tied=await run(stock,day);
  assert.ok(tied.ma30GrowthPct>20);assert.equal(tied.increasing,false);
});

test('future rows and rows before the 60-session window do not supply a signal',async t=>{
  const data=rows([999,...sequence]);
  data.push([addDays(day,3),'999','999','999','999','100']);
  call(t,{qfqday:data.reverse()});
  const result=await run(stock,day);
  assert.equal(result.status,'ready');assert.equal(result.high60,218);assert.equal(result.turtle,true);
});

test('stale, short, halted and malformed series are unresolved instead of negative signals',async t=>{
  const entry={qfqday:null};
  call(t,entry);
  const badVolume=rows(sequence);badVolume.at(-1)[5]='0';
  const duplicate=rows(sequence);duplicate[4][0]=duplicate[3][0];
  const malformed=rows(sequence);malformed[38][2]='1x';
  const gap=rows(sequence);gap[38][5]='0';
  const badRange=rows(sequence);badRange[20][3]='1';
  for(const [series,pattern] of [[rows(sequence,addDays(day,-1)),/目标交易日/],[rows(sequence.slice(1)),/60/],[badVolume,/停牌/],[duplicate,/重复/],[malformed,/价格/],[badRange,/价格/],[gap,/60/]]) {
    entry.qfqday=series;const result=await run(stock,day);
    assert.equal(result.status,'unavailable');assert.match(result.reason,pattern);assert.equal(result.turtle,undefined);
  }
});

test('refuse dates, codes and intraday candidate snapshots before any network call',async t=>{
  const request=call(t,null);
  for (const [candidate,date] of [[{code:'920111.BJ'},day],[{code:'anything'},day],[stock,'2026-02-30'],[stock,'2026-11-17'],[{...stock,asOf:day+'T06:59:59Z'},day],[{...stock,asOf:'2026-11-14T15:00:00+08:00'},day],[{...stock,asOf:day+'T15:00:00'},day]]) {
    assert.equal((await run(candidate,date)).status,'unavailable');
  }
  assert.equal(request.mock.calls.length,0);
});

test('today requires a quote for the same symbol at or after Shanghai close',async t=>{
  const entry={qfqday:rows(sequence),qt:{sh600519:[]}};
  const q=entry.qt.sh600519;
  q[2]='600519';q[30]='20261113145959';
  t.mock.method(Date,'now',()=>Date.parse(day+'T07:10:00Z'));
  t.mock.method(global,'fetch',async()=>succeed(entry));
  assert.match((await run(stock,day)).reason,/收盘/);
  q[30]='20261113150000';q[2]='000858';
  assert.match((await run(stock,day)).reason,/收盘/);
  q[2]='600519';assert.equal((await run(stock,day)).status,'ready');
});

test('caller aborts the in-flight fetch and does not start a fallback',async t=>{
  const control=new AbortController();
  const request=call(t,null,async (url,opt)=>new Promise((resolve,reject)=>{
    opt.signal.addEventListener('abort',()=>reject(Error('request aborted')),{once:true});
  }));
  const pending=run(stock,day,control.signal);
  control.abort();
  await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(run(stock,day,control.signal),{name:'AbortError'});
  assert.equal(request.mock.calls.length,1);
});

test('honor an explicit access or rate limit response',async t=>{
  const request=call(t,null,async()=>({ok:false,status:429}));
  const result=await run(stock,day);
  assert.match(result.reason,/停止访问/);assert.equal(request.mock.calls.length,1);
});

 test('day-only history cannot establish forward-adjustment evidence',async t=>{
  call(t,{day:rows(sequence)});
  const result=await run(stock,day);
  assert.equal(result.status,'unavailable');assert.match(result.reason,/前复权口径未确认/);assert.equal(result.turtle,undefined);
 });

const frozenNow=()=>Date.parse('2026-11-16T08:00:00Z');
test('401, 403, 418 and 429 persist across repeated calls and a new client without any fallback',async()=>{
 for(const status of [401,403,418,429]){
  const storage=memoryStorage();let requests=0;
  const env={localStorage:storage,now:frozenNow,fetch:async()=>{requests++;return {ok:false,status}}};
  const first=createClient(env);
  for(let i=0;i<2;i++){const r=await first.run(stock,day);assert.equal(r.sourceStopped,true);assert.match(r.reason,/停止访问/);}
  const afterReload=createClient(env);assert.equal((await afterReload.run(stock,day)).sourceStopped,true);
  assert.equal(requests,1);assert.equal(afterReload.sourceState().record.httpStatus,status);
  assert.equal(first.clearStop,undefined,'no one-click bypass');
 }
});
test('concurrent late success loses to a source denial',async()=>{
 const storage=memoryStorage();let requests=0,resolveLate;
 const client=createClient({localStorage:storage,now:frozenNow,fetch:async()=>{
  requests++;return requests===1?new Promise(resolve=>resolveLate=resolve):{ok:false,status:429};
 }});
 const late=client.run(stock,day);const denied=await client.run(stock,day);assert.equal(denied.sourceStopped,true);
 resolveLate(succeed({qfqday:rows(sequence)}));assert.equal((await late).sourceStopped,true);
 await client.run(stock,day);assert.equal(requests,2);
});
test('storage that cannot preserve a stop fails closed before any source request',async()=>{
 let requests=0;const client=createClient({now:frozenNow,fetch:async()=>{requests++},localStorage:{getItem:()=>null,setItem(){throw Error('quota')},removeItem(){}}});
 assert.equal((await client.run(stock,day)).sourceStopped,true);assert.equal(requests,0);assert.equal(client.sourceState().status,'unavailable');
});
test('existing or malformed stop records cannot be silently cleared',async()=>{
 const storage=memoryStorage();storage.setItem('books.screening.tencent-source-stop.v1','unparseable');let requests=0;
 const client=createClient({localStorage:storage,now:frozenNow,fetch:async()=>{requests++}});
 assert.equal((await client.run(stock,day)).sourceStopped,true);assert.equal(requests,0);assert.match(client.sourceState().reason,/人工核对/);
});

function historyClient(reply,options={}){
 const storage=options.localStorage||memoryStorage(),calls=[];
 const client=createClient({localStorage:storage,now:options.now||frozenNow,fetch:async(url,opt)=>{calls.push({url,opt});return reply(url,opt);}});
 return {client,calls,storage};
}
function historyResponse(url,entry){
 const ticker=url.searchParams.get('param').split(',')[0];
 return {ok:true,status:200,json:async()=>({code:0,data:{[ticker]:entry}})};
}
const historySequence=Array.from({length:61},(_,i)=>100+i);
test('history exposes chronological dated closes and source volumes without changing the legacy signal result',async()=>{
 const raw=rows(historySequence);raw.forEach((row,i)=>row[5]=String(100+i));
 const {client,calls}=historyClient(url=>historyResponse(url,{qfqday:[...raw].reverse()}));
 const result=await client.history(stock,day);
 assert.equal(result.status,'ready');assert.equal(result.adjustment,'qfq');assert.equal(result.bars.length,61);
 assert.deepEqual(result.bars.at(-1),{date:day,close:160,volume:160});
 assert.equal(result.bars[0].date,raw[0][0]);assert.equal(result.fetchedAt,'2026-11-16T08:00:00.000Z');
 assert.equal(result.sourceUrl,calls[0].url.href);assert.equal(calls[0].url.searchParams.get('param').split(',').at(-1),'qfq');
 const legacy=await client.run(stock,day);assert.equal(legacy.close,160);assert.equal(legacy.bars,undefined);
});
test('history enforces requested 61 and 26 bar minimums and skips inactive historical days',async()=>{
 const entry={qfqday:rows(historySequence)};
 const {client}=historyClient(url=>historyResponse(url,entry));
 entry.qfqday=rows(historySequence.slice(1));assert.match((await client.history(stock,day)).reason,/61/);
 entry.qfqday=rows(historySequence.slice(0,26));const short=await client.history(stock,day,undefined,{minBars:26});
 assert.equal(short.status,'ready');assert.equal(short.bars.length,26);
 entry.qfqday=rows(historySequence.slice(0,25));assert.match((await client.history(stock,day,undefined,{minBars:26})).reason,/26/);
 entry.qfqday=rows(Array.from({length:62},(_,i)=>100+i));const gap=entry.qfqday[5][0];entry.qfqday[5][5]='0';
 const active=await client.history(stock,day);assert.equal(active.bars.length,61);assert.ok(!active.bars.some(b=>b.date===gap));
});
test('stock history never infers qfq adjustment from raw day or a requested qfq parameter',async()=>{
 const {client}=historyClient(url=>historyResponse(url,{day:rows(historySequence)}));
 const result=await client.history(stock,day);assert.equal(result.status,'unavailable');assert.match(result.reason,/前复权口径未确认/);
});
test('only three explicitly selected benchmark indices accept raw index day bars',async()=>{
 const {client,calls}=historyClient(url=>historyResponse(url,{day:rows(historySequence),qfqday:rows(historySequence.map(x=>x*5))}));
 for(const code of ['000001.SH','399001.SZ','000300.SH']){
  const result=await client.history({code,asOf:closing},day,undefined,{index:true});
  assert.equal(result.status,'ready');assert.equal(result.adjustment,'index');assert.equal(result.bars.at(-1).close,160);
  const param=calls.at(-1).url.searchParams.get('param').split(',');
  assert.equal(param[0],code.slice(-2).toLowerCase()+code.slice(0,6));assert.equal(param[5],'');
 }
 const count=calls.length;
 for(const code of ['600519.SH','399006.SZ','000300.SZ','920111.BJ']){
  const result=await client.history({code},day,undefined,{index:true});assert.equal(result.status,'unavailable');
 }
 assert.equal(calls.length,count);
});
test('index history cannot silently substitute qfqday when raw index day evidence is missing',async()=>{
 const {client}=historyClient(url=>historyResponse(url,{qfqday:rows(historySequence)}));
 const result=await client.history({code:'000300.SH'},day,undefined,{index:true});
 assert.equal(result.status,'unavailable');assert.match(result.reason,/指数原始日线/);
});
test('history refuses invalid options, nonclosed dates and intraday snapshot cutoffs before requests',async()=>{
 const {client,calls}=historyClient(()=>{throw Error('unexpected request')});
 for(const options of [{minBars:0},{minBars:1},{minBars:641},{minBars:61.5},{index:'yes'}])assert.equal((await client.history(stock,day,undefined,options)).status,'unavailable');
 for(const [candidate,date] of [[stock,'2026-11-17'],[stock,'2026-02-30'],[{...stock,asOf:day+'T06:59:59Z'},day]])assert.equal((await client.history(candidate,date)).status,'unavailable');
 assert.equal(calls.length,0);
});
test('history rejects duplicate, malformed, stopped or oversized data and ignores future bars',async()=>{
 const entry={qfqday:rows(historySequence)}, {client}=historyClient(url=>historyResponse(url,entry));
 const duplicate=rows(historySequence);duplicate[3][0]=duplicate[4][0];
 const badVolume=rows(historySequence);badVolume[3][5]='-1';
 const badPrice=rows(historySequence);badPrice[3][3]='1';
 const halted=rows(historySequence);halted.at(-1)[5]='0';
 const wrongEnd=rows(historySequence,addDays(day,-1));
 for(const [bad,pattern] of [[duplicate,/重复/],[badVolume,/成交量/],[badPrice,/价格/],[halted,/停牌/],[wrongEnd,/目标交易日/],[rows(Array(641).fill(1)),/640/]]){
  entry.qfqday=bad;const result=await client.history(stock,day);assert.equal(result.status,'unavailable');assert.match(result.reason,pattern);
 }
 entry.qfqday=rows(historySequence).concat([[addDays(day,3),'999','999','999','999','10']]);
 const result=await client.history(stock,day);assert.equal(result.status,'ready');assert.equal(result.bars.length,61);assert.equal(result.bars.at(-1).close,160);
});
test('today history still requires same-symbol after-close source confirmation for stocks and indices',async()=>{
 const entry={qfqday:rows(historySequence),day:rows(historySequence),qt:{}};
 const {client}=historyClient(url=>historyResponse(url,entry),{now:()=>Date.parse(day+'T07:10:00Z')});
 for(const [candidate,options] of [[stock,{}],[{code:'000300.SH',asOf:closing},{index:true}]]){
  const ticker=candidate.code.slice(-2).toLowerCase()+candidate.code.slice(0,6),quote=[];quote[2]=candidate.code.slice(0,6);quote[30]='20261113145959';entry.qt[ticker]=quote;
  assert.match((await client.history(candidate,day,undefined,options)).reason,/收盘/);
  quote[30]='20261113150000';assert.equal((await client.history(candidate,day,undefined,options)).status,'ready');
 }
});
test('history and legacy run share persisted 401,403,418,429 stops without immediate retries or fallback',async()=>{
 for(const status of [401,403,418,429]){
  const {client,calls,storage}=historyClient(()=>({ok:false,status}));
  const first=await client.history(stock,day);assert.equal(first.sourceStopped,true);
  assert.equal((await client.run(stock,day)).sourceStopped,true);assert.equal((await client.history(stock,day)).sourceStopped,true);
  const reloaded=createClient({localStorage:storage,now:frozenNow,fetch:async()=>{throw Error('must stay stopped')}});
  assert.equal((await reloaded.history(stock,day)).sourceStopped,true);assert.equal(calls.length,1);
 }
});
test('history cancellation aborts its request and never falls back',async()=>{
 const control=new AbortController();
 const {client,calls}=historyClient((url,opt)=>new Promise((resolve,reject)=>opt.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));
 const pending=client.history(stock,day,control.signal);control.abort();
 await assert.rejects(pending,{name:'AbortError'});await assert.rejects(client.history(stock,day,control.signal),{name:'AbortError'});
 assert.equal(calls.length,1);
});
