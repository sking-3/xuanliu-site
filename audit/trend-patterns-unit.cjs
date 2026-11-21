'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const API=require('../screening/trend-patterns.js');
const day='2026-11-20';
const expectedIds=['trend-up','trend-down','close-pullback','near-ma-5','near-ma-10','near-ma-20','regain-ma-5','regain-ma-10','regain-ma-20','lose-ma-5','lose-ma-10','lose-ma-20','close-breakout','close-breakdown','volume-expand','volume-contract'];
function dates(n=61){
 const result=[];
 for(let value=new Date(day+'T00:00:00Z');result.length<n;value.setUTCDate(value.getUTCDate()-1))if(![0,6].includes(value.getUTCDay()))result.unshift(value.toISOString().slice(0,10));
 return result;
}
function bars(close=()=>100,n=61){return dates(n).map((date,i)=>({date,close:typeof close==='function'?close(i):close[i],volume:100}));}
const run=(values,options={})=>API.classify({bars:values,calendar:dates().map(date=>({date})),day,lookback:20,...options});
const ids=result=>result.labels.map(label=>label.id);
const missing=result=>result.unavailable.map(label=>label.id);
const has=(result,id)=>ids(result).includes(id);
function tail(values,closes){closes.forEach((close,i)=>{values[values.length-closes.length+i].close=close;});return values;}
function checkUnknown(result){assert.equal(result.status,'unavailable');assert.deepEqual(result.labels,[]);assert.equal(new Set(missing(result)).size,16);}

test('CommonJS and browser export the same sixteen independent definitions without source requests',()=>{
 assert.equal(typeof API.version,'string');assert.deepEqual(API.definitions.map(def=>def.id).sort(),expectedIds.slice().sort());assert.equal(new Set(API.definitions.map(def=>def.id)).size,16);
 const context={};vm.runInNewContext(fs.readFileSync(require.resolve('../screening/trend-patterns.js'),'utf8'),context);assert.equal(typeof context.BooksTrendPatterns.classify,'function');assert.equal(context.BooksTrendPatterns.version,API.version);
 assert.doesNotMatch(fs.readFileSync(require.resolve('../screening/trend-patterns.js'),'utf8'),/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
test('default profile states the shared periods and explicit research boundaries',()=>{
 const p=API.profile;assert.equal(p.fastPeriod,5);assert.equal(p.midPeriod,10);assert.equal(p.slowPeriod,20);assert.equal(p.slopeDays,5);assert.deepEqual(p.maPeriods,[5,10,20]);assert.equal(p.consolidationDays,5);assert.equal(p.nearPct,2);assert.equal(p.rangePct,4);assert.equal(p.crossWindow,3);assert.equal(p.pullbackMinPct,2);assert.equal(p.pullbackMaxPct,8);assert.equal(p.volumeRecentDays,5);assert.equal(p.volumePreviousDays,20);assert.equal(p.volumeExpandRatio,1.2);assert.equal(p.volumeContractRatio,.8);
});
test('a modest persistent trend can carry multiple independent labels rather than a single winning category',()=>{
 const values=bars(i=>100+i*.005);for(const bar of values.slice(-5))bar.volume=120;
 const result=run(values);assert.equal(result.status,'ready');assert.deepEqual(result.unavailable,[]);assert(has(result,'trend-up'));assert(!has(result,'trend-down'));assert(has(result,'close-breakout'));assert(has(result,'volume-expand'));for(const n of [5,10,20])assert(has(result,'near-ma-'+n));assert.equal(new Set(ids(result)).size,result.labels.length);
});
test('descending averages and five-session slopes identify a downtrend while a flat series does not',()=>{
 const down=run(bars(i=>200-i*.1)),flat=run(bars());assert(has(down,'trend-down'));assert(!has(down,'trend-up'));assert(!has(flat,'trend-up'));assert(!has(flat,'trend-down'));for(const n of [5,10,20])assert(has(flat,'near-ma-'+n));
});
test('regaining or losing averages requires a recent close cross and the current side still agrees',()=>{
 const regained=run(tail(bars(),[99,101])),lost=run(tail(bars(),[101,99]));
 for(const n of [5,10,20]){assert(has(regained,'regain-ma-'+n));assert(!has(regained,'lose-ma-'+n));assert(has(lost,'lose-ma-'+n));assert(!has(lost,'regain-ma-'+n));}
 const reversed=run(tail(bars(),[99,101,99]));for(const n of [5,10,20]){assert(!has(reversed,'regain-ma-'+n));assert(has(reversed,'lose-ma-'+n));}
});
test('the three-session crossover window includes its first session and excludes an older surviving cross',()=>{
 for(const [side,prefix]of [[101,'regain-ma-'],[99,'lose-ma-']]){
  const boundary=run(tail(bars(),Array(3).fill(side))),old=run(tail(bars(),Array(4).fill(side)));
  for(const n of [5,10,20]){assert(has(boundary,prefix+n),prefix+n+' at window boundary');assert(!has(old,prefix+n),prefix+n+' must not linger from four sessions ago');}
 }
});
test('near-average consolidation checks every recent session rather than only the final close',()=>{
 const flat=run(bars());for(const n of [5,10,20])assert(has(flat,'near-ma-'+n));
 const spike=run(tail(bars(),[105,100,100,100,100]));for(const n of [5,10,20])assert(!has(spike,'near-ma-'+n));
});
test('near-MA5 uses the inclusive two-percent boundary for the first consolidation session',()=>{
 const boundary=100*4*1.02/(5-1.02);
 assert(has(run(tail(bars(),Array(5).fill(boundary))),'near-ma-5'));
 assert(!has(run(tail(bars(),Array(5).fill(boundary+.0001))),'near-ma-5'));
});
test('consolidation close range uses the inclusive four-percent boundary independently of MA proximity',()=>{
 const options={parameters:{nearPct:10}};
 assert(has(run(tail(bars(),[100,104,100,100,100]),options),'near-ma-5'));
 assert(!has(run(tail(bars(),[100,104.0001,100,100,100]),options),'near-ma-5'));
});
test('closing breakout and breakdown are strict and use the previous selected window excluding today',()=>{
 const equal=run(bars());assert(!has(equal,'close-breakout'));assert(!has(equal,'close-breakdown'));
 const up=tail(bars(),[101]),down=tail(bars(),[99]);assert(has(run(up),'close-breakout'));assert(has(run(down),'close-breakdown'));
 up[up.length-22].close=200;down[down.length-22].close=50;assert(has(run(up),'close-breakout'));assert(has(run(down),'close-breakdown'));
 up[up.length-21].close=200;down[down.length-21].close=50;assert(!has(run(up),'close-breakout'));assert(!has(run(down),'close-breakdown'));
});
test('all 61 closes remain available for sixty-session closing boundaries instead of being trimmed to 26',()=>{
 const values=bars(i=>100+i*.1),full=run(values,{lookback:60}),short=run(values.slice(-26),{lookback:60});assert(has(full,'close-breakout'));assert(!missing(full).includes('close-breakout'));assert(missing(short).includes('close-breakout'));assert(missing(short).includes('close-breakdown'));assert(missing(short).includes('close-pullback'));assert(has(short,'trend-up'));
 values[0].close=1000;assert(!has(run(values,{lookback:60}),'close-breakout'));
});
test('pullback is the current close below the selected closing peak with inclusive two-to-eight-percent boundaries',()=>{
 for(const close of [98,92])assert(has(run(tail(bars(),[close])),'close-pullback'),String(close));
 for(const close of [98.0001,91.9999,100])assert(!has(run(tail(bars(),[close])),'close-pullback'),String(close));
 const recovered=tail(bars(),[90,100]);assert(!has(run(recovered),'close-pullback'),'an old drawdown is not a current pullback');
 const outside=tail(bars(),[98]);outside[outside.length-22].close=200;assert(has(run(outside),'close-pullback'));assert(!has(run(outside,{lookback:60}),'close-pullback'));
});
test('volume expansion and contraction compare disjoint five-day and prior-twenty-day means at inclusive boundaries',()=>{
 for(const [volume,id]of [[120,'volume-expand'],[80,'volume-contract']]){
  const values=bars();for(const bar of values.slice(-5))bar.volume=volume;values[values.length-26].volume=1e9;const result=run(values);assert(has(result,id));assert(!has(result,id==='volume-expand'?'volume-contract':'volume-expand'));
 }
 const within=bars();for(const bar of within.slice(-5))bar.volume=119.9999;assert(!has(run(within),'volume-expand'));for(const bar of within.slice(-5))bar.volume=80.0001;assert(!has(run(within),'volume-contract'));
});
test('intraday high, low and open fields do not substitute for closing boundaries',()=>{
 const plain=bars(),intraday=plain.map(bar=>({...bar,open:1,high:1e8,low:.001}));intraday.at(-1).high=1e12;intraday.at(-1).low=.000001;assert.deepEqual(run(intraday),run(plain));assert(!has(run(intraday),'close-breakout'));assert(!has(run(intraday),'close-breakdown'));
});
test('short valid series identify available short-period labels and report unsupported definitions explicitly',()=>{
 const result=run(bars(i=>100+i*.005,10));assert.equal(result.status,'ready');assert(has(result,'near-ma-5'));for(const id of ['trend-up','trend-down','near-ma-10','near-ma-20','volume-expand','volume-contract','close-breakout','close-breakdown','close-pullback'])assert(missing(result).includes(id),id);
 assert(result.unavailable.every(item=>typeof item.reason==='string'&&item.reason.length>0));
});
test('future, duplicate, reversed and impossible dates cannot generate labels',()=>{
 const original=bars(),future=[...original,{date:'2026-11-23',close:100,volume:100}];
 for(const values of [future,[...original,original.at(-1)],[...original].reverse(),original.map((bar,i)=>i===50?{...bar,date:'2026-02-30'}:bar)])checkUnknown(run(values));
 checkUnknown(run(original,{day:'2026-02-30'}));checkUnknown(run(original,{calendar:[...dates().map(date=>({date})),{date:'2026-11-23'}]}));
});
test('calendar gaps and a missing target session remain unknown rather than a false match',()=>{
 const original=bars();checkUnknown(run(original.filter((_,i)=>i!==original.length-12)));checkUnknown(run(original.slice(0,-1)));checkUnknown(run(original,{calendar:dates().slice(0,-1).map(date=>({date}))}));
});
test('invalid closing prices and volumes are not converted into zero indicators',()=>{
 for(const key of ['close','volume'])for(const value of [0,-1,NaN,Infinity,undefined,'100']){const values=bars();values[values.length-3][key]=value;checkUnknown(run(values));}
});
test('finite volume arithmetic cannot produce NaN evidence or simultaneous expansion and contraction',()=>{
 const values=bars();for(const bar of values)bar.volume=1e308;const result=run(values);assert.doesNotMatch(JSON.stringify(result),/NaN|Infinity/);assert(!(has(result,'volume-expand')&&has(result,'volume-contract')));
});
test('classification does not mutate raw inputs or leak raw prices and moving-average levels in evidence',()=>{
 const values=tail(bars(i=>100+i*.005),[99,101]),input={bars:values,calendar:dates().map(date=>({date})),day,lookback:20},before=JSON.stringify(input),result=API.classify(input);assert.equal(JSON.stringify(input),before);assert.equal(result.version,API.version);assert.equal(result.day,day);assert.equal(result.lookback,20);
 const forbidden=new Set(['close','open','high','low','price','startclose','endclose','ma5','ma10','ma20','movingaverage','volumeavg5','volumeavgprevious20','bars']);
 function inspect(value){if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){assert(!forbidden.has(key.toLowerCase()),'raw evidence key '+key);inspect(item);}}
 for(const label of result.labels){assert.equal(typeof label.label,'string');assert.equal(typeof label.group,'string');assert(label.evidence&&['string','object'].includes(typeof label.evidence));inspect(label.evidence);}
});
