'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const API=require('../screening/trend-screen.js');
const day='2026-11-20';
function dates(n){const result=[];for(let d=new Date(day+'T00:00:00Z');result.length<n;d.setUTCDate(d.getUTCDate()-1))if(![0,6].includes(d.getUTCDay()))result.unshift(d.toISOString().slice(0,10));return result;}
function bars(daily,n=61){let price=100;return dates(n).map((date,i)=>{if(i)price*=1+daily(i);return {date,close:price,volume:100};});}
const varied=i=>[.02,-.006,.008,-.002,.015][i%5];
const run=(overrides={})=>API.evaluate({mode:'market',bars:bars(varied),referenceBars:bars(varied),lookback:20,day,code:'600519.SH',referenceCode:'000300.SH',...overrides});

test('browser and CommonJS share a pure engine without a network dependency',()=>{
 const scope={};vm.runInNewContext(fs.readFileSync(require.resolve('../screening/trend-screen.js'),'utf8'),scope);
 assert.equal(typeof scope.BooksTrendScreen.evaluate,'function');assert.equal(API.RULES.correlation,.65);
 assert.doesNotMatch(fs.readFileSync(require.resolve('../screening/trend-screen.js'),'utf8'),/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
test('identical variable return series match market and expose correctly scaled dated metrics',()=>{
 const r=run();assert.equal(r.status,'ready');assert.equal(r.matched,true);assert.ok(Math.abs(r.metrics.correlation-1)<1e-12);assert.equal(r.metrics.directionAgreement,1);
 const input=bars(varied);assert.equal(r.metrics.sampleCount,21);assert.equal(r.metrics.startAt,input.at(-21).date);assert.equal(r.metrics.endAt,day);
 assert.ok(Math.abs(r.metrics.periodReturn-(input.at(-1).close/input.at(-21).close-1)*100)<1e-10);assert.equal(r.metrics.volumeRatio,null);
});
test('market tracking is allowed during a jointly declining market',()=>{
 const falling=i=>[-.02,.002,-.01,.001,-.005][i%5],r=run({bars:bars(falling),referenceBars:bars(falling)});
 assert.equal(r.matched,true);assert.ok(r.metrics.periodReturn<0);assert.ok(r.metrics.referenceReturn<0);
});
test('inverse daily returns do not match and retain measured negative correlation',()=>{
 const r=run({bars:bars(i=>-varied(i))});assert.equal(r.status,'ready');assert.equal(r.matched,false);assert.ok(Math.abs(r.metrics.correlation+1)<1e-12);assert.equal(r.metrics.directionAgreement,0);
 assert.match(r.reason,/未满足/);
});
test('same direction threshold includes60 percent and independently rejects55 percent',()=>{
 for(const agreed of [12,11]){
  const ref=bars(i=>i<=agreed?(i%2?.02:-.015):.00001,21);
  const candidate=bars(i=>i<=agreed?(i%2?.02:-.015):-.00001,21);
  const r=run({bars:candidate,referenceBars:ref});assert.equal(r.status,'ready');assert.ok(r.metrics.correlation>.99);assert.equal(r.metrics.directionAgreement,agreed/20);assert.equal(r.matched,agreed===12);
 }
});
test('constant price and constant daily returns cannot invent a correlation score',()=>{
 for(const b of [bars(()=>0),bars(()=>.01)]){const r=run({bars:b});assert.equal(r.status,'unavailable');assert.equal(r.matched,null);assert.equal(r.metrics.correlation,null);assert.match(r.reason,/波动不足/);}
});
test('20-day and 60-day periods require 21 and 61 observations and never borrow the shorter period',()=>{
 const short=bars(varied,21);assert.equal(run({bars:short,referenceBars:short}).matched,true);
 const missing=run({bars:short,lookback:60});assert.equal(missing.status,'unavailable');assert.match(missing.reason,/61/);
 const full=run({lookback:60});assert.equal(full.status,'ready');assert.equal(full.metrics.sampleCount,61);assert.equal(full.metrics.startAt,bars(varied)[0].date);
});
test('missing or extra trading dates cannot be bridged across a reference gap',()=>{
 const all=bars(varied),missing=all.filter((_,i)=>i!==all.length-8);assert.equal(run({bars:missing}).status,'unavailable');
 assert.equal(run({referenceBars:missing}).status,'unavailable');
});
test('reverse, duplicate, future, invalid calendar dates and missing target dates stay unavailable',()=>{
 const b=bars(varied);
 for(const invalid of [[...b].reverse(),[...b,b.at(-1)],[...b,{date:'2026-11-23',close:100,volume:100}],b.slice(0,-1),b.map((r,i)=>i===4?{...r,date:'2026-02-30'}:r)])assert.equal(run({bars:invalid}).status,'unavailable');
});
test('similar shape uses both curve and return correlation and excludes the reference stock itself',()=>{
 const r=run({mode:'similar',referenceCode:'000001.SZ'});assert.equal(r.matched,true);assert.ok(r.metrics.curveCorrelation>.9999);assert.equal(r.reasons.length,3);
 const self=run({mode:'similar',referenceCode:'600519.sh'});assert.equal(self.status,'unavailable');assert.equal(self.matched,null);assert.match(self.reason,/自身/);
});
test('similarity rejects smooth-looking curves with uncorrelated daily changes',()=>{
 const pattern=[.04,-.02,.03,-.015,.025,-.01,.015,-.005,.035,-.025];
 const r=run({mode:'similar',bars:bars(i=>pattern[(i+1)%pattern.length]),referenceBars:bars(i=>pattern[i%pattern.length])});
 assert.equal(r.status,'ready');assert.equal(r.matched,false);assert.ok(r.metrics.correlation<.65);
});
function strong(){const b=bars(varied);for(let i=b.length-5;i<b.length;i++)b[i].volume=150;return b;}
test('joint strength requires rising price, moving averages and independent completed volume evidence',()=>{
 const r=run({mode:'strength',bars:strong(),referenceBars:bars(varied)});assert.equal(r.status,'ready');assert.equal(r.matched,true);assert.equal(r.metrics.volumeRatio,1.5);
 assert.ok(r.metrics.ma5>r.metrics.ma20);assert.equal(r.metrics.correlation,null);assert.equal(r.reasons.length,6);
});
test('joint strength does not pass by price alone and uses previous20 excluding recent5 for volume ratio',()=>{
 const b=strong();for(let i=b.length-5;i<b.length;i++)b[i].volume=119;
 const r=run({mode:'strength',bars:b,referenceBars:bars(varied)});assert.equal(r.status,'ready');assert.equal(r.matched,false);assert.equal(r.metrics.volumeRatio,1.19);
 for(let i=b.length-5;i<b.length;i++)b[i].volume=120;assert.equal(run({mode:'strength',bars:b,referenceBars:bars(varied)}).matched,true);
});
test('missing volume is unknown rather than a false no-match, and strength needs26 bars',()=>{
 for(const v of [null,undefined,NaN,0,-1]){const b=strong();b.at(-3).volume=v;const r=run({mode:'strength',bars:b,referenceBars:bars(varied)});assert.equal(r.status,'unavailable');assert.equal(r.matched,null);assert.equal(r.metrics.volumeRatio,null);}
 assert.match(run({mode:'strength',bars:strong().slice(-25),referenceBars:bars(varied)}).reason,/26/);
});
test('strength period return remains selected20 or60 days rather than the volume window',()=>{
 const b=strong(),r20=run({mode:'strength',bars:b,referenceBars:bars(varied)}),r60=run({mode:'strength',lookback:60,bars:b,referenceBars:bars(varied)});
 assert.equal(r20.metrics.sampleCount,21);assert.equal(r60.metrics.sampleCount,61);assert.notEqual(r20.metrics.periodReturn,r60.metrics.periodReturn);assert.equal(r20.metrics.volumeRatio,r60.metrics.volumeRatio);
});
test('bad options and nonfinite or nonpositive prices stay empty without mutating inputs',()=>{
 for(const change of [{mode:'unknown'},{lookback:30},{day:'bad'},{day:'2026-13-40'}])assert.equal(run(change).status,'unavailable');
 for(const value of [0,-1,NaN,Infinity]){const b=bars(varied);b[4].close=value;assert.equal(run({bars:b}).status,'unavailable');}
 const input={mode:'market',bars:bars(varied),referenceBars:bars(varied),lookback:20,day};const before=JSON.stringify(input);API.evaluate(input);assert.equal(JSON.stringify(input),before);
});
test('arithmetic overflow cannot escape as a finite-looking strength result',()=>{
 const b=strong();for(const row of b)row.volume=1e308;assert.equal(run({mode:'strength',bars:b,referenceBars:bars(varied)}).status,'unavailable');
});
test('strength requires an independent complete calendar anchor and never bridges suspension dates',()=>{
 const stock=strong(),calendar=bars(varied);
 const withoutReference=run({mode:'strength',bars:stock,referenceBars:undefined});assert.equal(withoutReference.status,'unavailable');assert.equal(withoutReference.matched,null);
 for(const lookback of [20,60]){
  const suspended=stock.filter((_,i)=>i!==stock.length-10);
  const r=run({mode:'strength',lookback,bars:suspended,referenceBars:calendar});
  assert.equal(r.status,'unavailable');assert.equal(r.matched,null);assert.equal(r.metrics.periodReturn,null);
 }
 const calendarGap=calendar.filter((_,i)=>i!==calendar.length-10);assert.equal(run({mode:'strength',bars:stock,referenceBars:calendarGap}).status,'unavailable');
});
test('strength aligns all26 support days even when the missing date predates the20-return window',()=>{
 const stock=strong().filter((_,i)=>i!==61-24),r=run({mode:'strength',bars:stock,referenceBars:bars(varied)});
 assert.equal(r.status,'unavailable');assert.match(r.reason,/交易日不齐/);
});
test('strength calendar prices do not enter price metrics and a26-date anchor is sufficient',()=>{
 const calendar=bars(varied).slice(-26).map(({date})=>({date}));
 const r=run({mode:'strength',bars:strong(),referenceBars:calendar});assert.equal(r.status,'ready');assert.equal(r.matched,true);assert.equal(r.metrics.sampleCount,21);assert.equal(r.metrics.referenceReturn,null);
 assert.equal(run({mode:'strength',bars:strong(),referenceBars:calendar.slice(-25)}).status,'unavailable');
});
