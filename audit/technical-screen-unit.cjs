'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {run} = require('../screening/technical-screen.js');

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

test('a failed primary transport can use the second host; a day-only response supports an unadjusted security',async t=>{
  let attempts=0;
  const request=call(t,null,async()=>{
    if (attempts++===0) throw Error('network down');
    return succeed({day:rows(Array(60).fill(10))});
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
  assert.match(result.reason,/限制/);assert.equal(request.mock.calls.length,1);
});
