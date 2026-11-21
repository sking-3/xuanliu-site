'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const API=require('../screening/trend-screen.js');
const day='2026-11-20',varied=i=>[.012,-.006,.008,-.002,.005][i%5];
function dates(n){const result=[];for(let d=new Date(day+'T00:00:00Z');result.length<n;d.setUTCDate(d.getUTCDate()-1))if(![0,6].includes(d.getUTCDay()))result.unshift(d.toISOString().slice(0,10));return result;}
function bars(daily=varied,n=61){let price=100;return dates(n).map((date,i)=>{if(i)price*=1+daily(i);return {date,close:price,volume:100};});}
const run=(overrides={})=>API.evaluate({mode:'market',bars:bars(),referenceBars:bars(),lookback:20,day,code:'600519.SH',limits:{enabled:false},...overrides});
const stocks=n=>Array.from({length:n},(_,i)=>({code:String(600000+i)+'.SH',exchange:'SH',sector:'行业'+(i%3),name:'股票'+i,changePct:i,price:i+10}));
function consensus(patterns,options={}){const rows=stocks(patterns.length);return API.buildConsensus({records:rows.map((stock,i)=>({stock,bars:bars(patterns[i])})),calendar:bars(),lookback:20,day,expectedCount:rows.length,totalUniverseCount:rows.length,...options});}
function early(){const b=bars(()=>0);[99,99,99,99,99,99.5,100,100.5,101,101.5].forEach((close,i)=>b[b.length-10+i].close=close);return b;}
const closeTo=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('browser and CommonJS expose the shared pure engine without a request dependency',()=>{
 const scope={};vm.runInNewContext(fs.readFileSync(require.resolve('../screening/trend-screen.js'),'utf8'),scope);assert.equal(typeof scope.BooksTrendScreen.buildConsensus,'function');assert.equal(API.RULES.minimumMembers,30);assert.deepEqual(API.MODES,['market','consensus','strength']);assert.doesNotMatch(fs.readFileSync(require.resolve('../screening/trend-screen.js'),'utf8'),/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
test('market sampling cannot change when quote winners or input order change',()=>{
 const rows=stocks(300);for(let i=150;i<rows.length;i++){rows[i].exchange='SZ';rows[i].code=String(200000+i)+'.SZ';}
 const chosen=API.selectMarketSample(rows,120).map(r=>r.code);assert.equal(chosen.length,120);assert.equal(new Set(chosen).size,120);
 const changed=rows.map((r,i)=>({...r,price:999-i,changePct:i%2?100:-100,totalMarketCap:1e15})).reverse();assert.deepEqual(API.selectMarketSample(changed,120).map(r=>r.code),chosen);
});
test('proportional exchange-sector strata use largest remainders and spread across stock codes',()=>{
 const rows=stocks(100).map((r,i)=>({...r,sector:i<75?'大行业':'小行业'})),sample=API.selectMarketSample(rows,40);
 assert.equal(sample.filter(r=>r.sector==='大行业').length,30);assert.equal(sample.filter(r=>r.sector==='小行业').length,10);assert.ok(sample.filter(r=>r.sector==='大行业').at(-1).code>'600070.SH');assert.ok(sample[0].code>'600000.SH');
 assert.equal(API.selectMarketSample(rows,Infinity).length,100);assert.deepEqual(API.selectMarketSample(rows,0),[]);assert.deepEqual(API.selectMarketSample([],120),[]);
});
test('single stock, tiny subset, undersized requests and stale or missing calendars cannot represent a market',()=>{
 for(const n of [1,20,29]){const c=consensus(Array(n).fill(varied));assert.equal(c.status,'unavailable');assert.equal(c.identified,false);assert.match(c.reason,/30/);}
 assert.equal(consensus(Array(30).fill(varied),{calendar:bars().slice(0,-1)}).status,'unavailable');
});
test('at least80 percent coverage and30 aligned constituents are required',()=>{
 const rows=stocks(50),records=rows.map(stock=>({stock,bars:bars()}));
 for(const n of [39,40]){const c=API.buildConsensus({records:records.slice(0,n),calendar:bars(),lookback:20,day,expectedCount:50,totalUniverseCount:3000});assert.equal(c.status,n===40?'ready':'unavailable');assert.equal(c.validCount,n);closeTo(c.coverage,n/50);}
 const c=consensus(Array(40).fill(varied),{records:records.slice(0,40).map((r,i)=>i<10?{...r,bars:r.bars.slice(0,-1)}:r)});assert.equal(c.status,'unavailable');assert.equal(c.validCount,30);
});
test('a genuine broad pattern is derived from equal-stock daily medians with no single reference stock',()=>{
 const c=consensus(Array(40).fill(varied));assert.equal(c.status,'ready');assert.equal(c.identified,true);assert.equal(c.breadth,1);assert.equal(c.commonCount,40);assert.equal(c.memberCodes.length,40);assert.equal(c.dates.length,21);assert.equal(c.supportDates.length,26);
 for(let i=0;i<20;i++)closeTo(c.medianReturns[i],varied(i+41));
 const b=bars();const r=run({mode:'consensus',consensus:c,bars:b,code:c.memberCodes[0]});assert.equal(r.matched,true);closeTo(r.metrics.correlation,1);assert.equal(r.metrics.directionAgreement,1);
});
test('a50/50 split cannot be promoted to majority; exactly60 percent may form a shared pattern',()=>{
 const opposite=i=>-varied(i);
 const divided=consensus([...Array(20).fill(varied),...Array(20).fill(opposite)]);assert.equal(divided.status,'ready');assert.equal(divided.identified,false);assert.match(divided.reason,/分化/);
 const majority=consensus([...Array(24).fill(varied),...Array(16).fill(opposite)]);assert.equal(majority.identified,true);closeTo(majority.breadth,.6);assert.equal(majority.commonCount,24);
 const minority=run({mode:'consensus',consensus:divided,code:divided.memberCodes[0]});assert.equal(minority.status,'ready');assert.equal(minority.matched,false);
});
test('consensus correlations use an exact leave-self-out median even for the boundary member',()=>{
 const low=i=>varied(i),mid=i=>varied(i)*2,high=i=>varied(i)*3;
 const patterns=[...Array(15).fill(low),mid,...Array(14).fill(high)],c=consensus(patterns);
 const code=c.memberCodes[15];
 // Removing the sole middle constituent leaves15 low and14 high, so the
 // middle order statistic is the low-return path, not its own medium path.
 const expected=run({bars:bars(mid),referenceBars:bars(low)});
 closeTo(c.perCode[code].referenceReturn,expected.metrics.referenceReturn);closeTo(c.perCode[code].correlation,expected.metrics.correlation);
 const fullMedianReturn=c.medianReturns.reduce((n,r)=>n*(1+r),1);assert.ok(Math.abs(c.perCode[code].referenceReturn-(fullMedianReturn-1)*100)>.01);
});
test('zero-variance valid stocks stay in the breadth denominator and cannot inflate it',()=>{
 const c=consensus([...Array(30).fill(varied),...Array(10).fill(()=>0)]);assert.equal(c.validCount,40);assert.equal(c.commonCount,30);assert.equal(c.breadth,.75);assert.equal(c.perCode[c.memberCodes.at(-1)].correlation,null);
});
test('a candidate outside the market sample is compared against the full median without rewriting it',()=>{
 const c=consensus(Array(40).fill(varied)),before=JSON.stringify(c),r=run({mode:'consensus',consensus:c,code:'000001.SZ'});assert.equal(r.matched,true);assert.equal(JSON.stringify(c),before);
});
test('duplicates, missing prices or volumes and trading gaps cannot enter valid market coverage',()=>{
 const rows=stocks(40),records=rows.map(stock=>({stock,bars:bars()}));records[0].bars=records[0].bars.filter((_,i)=>i!==53);records[1].bars.at(-3).volume=0;records[2].bars.at(-1).close=NaN;
 const c=API.buildConsensus({records,calendar:bars(),lookback:20,day,expectedCount:40,totalUniverseCount:100});assert.equal(c.status,'ready');assert.equal(c.validCount,37);
 records[3].stock=records[4].stock;assert.equal(API.buildConsensus({records,calendar:bars(),lookback:20,day,expectedCount:40}).status,'unavailable');
});
test('raw percentage and volume math are auditable and are never clipped to safety caps',()=>{
 const b=bars(()=>0);b[b.length-21].close=100;b.at(-1).close=143.76;for(let i=b.length-5;i<b.length;i++)b[i].volume=250;
 const r=run({mode:'strength',bars:b,limits:{enabled:true}});assert.equal(r.status,'ready');closeTo(r.metrics.startClose,100);closeTo(r.metrics.endClose,143.76);closeTo(r.metrics.periodReturn,43.76);closeTo(r.metrics.volumeAvg5,250);closeTo(r.metrics.volumeAvgPrevious20,100);closeTo(r.metrics.volumeRatio,2.5);assert.equal(r.excluded,true);assert.equal(r.matched,false);assert.match(r.exclusionReasons.join(' '),/43.76/);
 const uncapped=run({mode:'strength',bars:b,limits:{enabled:false}});assert.equal(uncapped.excluded,false);assert.deepEqual(uncapped.metrics,r.metrics);
});
test('heat limits distinguish period gain, recent gain, positive deviation and actual volume ratio',()=>{
 const b=early();for(let i=b.length-5;i<b.length;i++)b[i].volume=300;
 const r=run({mode:'strength',bars:b,limits:{maxReturn20:100,maxReturn60:100,maxReturn5:100,maxDeviation:100,maxVolumeRatio:2.5}});assert.equal(r.excluded,true);assert.equal(r.exclusionReasons.length,1);assert.match(r.exclusionReasons[0],/成交量比/);assert.equal(r.metrics.volumeRatio,3);
 const ratioBoundary=run({mode:'strength',bars:b,limits:{maxVolumeRatio:3}});assert.equal(ratioBoundary.excluded,false);
 for(const value of [0,-1,NaN,Infinity,null])assert.equal(run({limits:{maxReturn20:value}}).status,'unavailable');
 assert.equal(run({limits:{enabled:'yes'}}).status,'unavailable');
});
test('cached heat filtering matches direct evaluation and leaves raw metrics and source result unchanged',()=>{
 const b=early();for(let i=b.length-5;i<b.length;i++)b[i].volume=300;
 for(const lookback of [20,60]){
  const base=run({mode:'strength',bars:b,lookback,limits:{enabled:false}}),before=JSON.stringify(base),limits={enabled:true,maxReturn20:15,maxReturn60:30,maxReturn5:8,maxDeviation:8,maxVolumeRatio:2.5};
  const cached=API.applyLimits(base,limits,lookback),direct=run({mode:'strength',bars:b,lookback,limits});assert.deepEqual(cached,direct);assert.equal(JSON.stringify(base),before);assert.notEqual(cached.metrics,base.metrics);assert.notEqual(cached.reasons,base.reasons);assert.deepEqual(cached.metrics,base.metrics);assert.equal(cached.metrics.volumeRatio,3);
 }
});
test('cached heat limits use the selected period and preserve boundary values without clipping',()=>{
 const base=run({mode:'strength',bars:early(),limits:{enabled:false}});base.metrics.periodReturn=25;
 const short=API.applyLimits(base,{enabled:true},20),long=API.applyLimits(base,{enabled:true},60);assert.equal(short.excluded,true);assert.equal(long.excluded,false);assert.equal(long.matched,true);assert.equal(short.metrics.periodReturn,25);assert.equal(long.metrics.periodReturn,25);
 base.metrics.periodReturn=15;base.metrics.return5=8;base.metrics.ma20Deviation=8;base.metrics.volumeRatio=2.5;assert.equal(API.applyLimits(base,{enabled:true},20).excluded,false);
 base.metrics.volumeRatio=2.50001;assert.match(API.applyLimits(base,{enabled:true},20).exclusionReasons[0],/成交量比/);assert.equal(base.metrics.volumeRatio,2.50001);
});
test('repeated cached heat toggles restore the underlying rule outcome and do not accumulate reasons',()=>{
 for(const base of [run({mode:'strength',bars:early(),limits:{enabled:false}}),run({mode:'strength',limits:{enabled:false}})]){
  const before=JSON.stringify(base);base.metrics.volumeRatio=3;
  const capped=API.applyLimits(base,{enabled:true}),disabled=API.applyLimits(capped,{enabled:false}),again=API.applyLimits(disabled,{enabled:true});assert.equal(capped.excluded,true);assert.equal(disabled.excluded,false);assert.equal(disabled.matched,base.matched);assert.equal(disabled.exclusionReasons.length,0);assert.deepEqual(again.exclusionReasons,capped.exclusionReasons);assert.deepEqual(again.reasons,capped.reasons);assert.equal(base.excluded,false);assert.deepEqual(base.reasons,JSON.parse(before).reasons);
 }
});
test('cached unavailable results remain unknown and cannot become matches when heat is disabled',()=>{
 const base=run({bars:[]}),before=JSON.stringify(base),filtered=API.applyLimits(base,{enabled:false});assert.deepEqual(filtered,base);assert.equal(filtered.status,'unavailable');assert.equal(filtered.matched,null);assert.equal(JSON.stringify(base),before);assert.notEqual(filtered,base);
});
test('market majority is computed before heat filtering, so excluding hot members cannot manufacture breadth',()=>{
 const c=consensus(Array(40).fill(i=>varied(i)*5));assert.equal(c.identified,true);assert.equal(c.breadth,1);
 const r=run({mode:'consensus',consensus:c,bars:bars(i=>varied(i)*5),code:c.memberCodes[0],limits:{enabled:true}});assert.equal(r.excluded,true);assert.equal(r.matched,false);assert.equal(c.breadth,1);
});
test('early strength accepts a recent modest crossover without requiring abnormal volume or positive fullperiod gain',()=>{
 const b=early(),r=run({mode:'strength',bars:b,limits:{enabled:true}});assert.equal(r.status,'ready');assert.equal(r.matched,true);assert.equal(r.metrics.volumeRatio,1);assert.equal(r.metrics.crossedUpRecently,true);
 const underwater=bars(()=>0);for(let i=0;i<underwater.length;i++)underwater[i].close=i<=40?110:90;
 [90,90.5,91,91.5,92].forEach((close,i)=>underwater[56+i].close=close);
 const recovery=run({mode:'strength',bars:underwater,limits:{enabled:true}});assert.equal(recovery.matched,true);assert.ok(recovery.metrics.periodReturn<0);
});
test('already mature uptrends fail the recent-crossover rule even with heat filters disabled',()=>{
 const r=run({mode:'strength'});assert.equal(r.status,'ready');assert.equal(r.matched,false);assert.equal(r.metrics.crossedUpRecently,false);assert.match(r.reason,/上穿/);
});
test('20/60-day returns keep exact endpoints while MA and volume use their independent supportwindow',()=>{
 const b=bars(),a=run({bars:b}),z=run({lookback:60,bars:b});assert.equal(a.metrics.sampleCount,21);assert.equal(z.metrics.sampleCount,61);assert.equal(a.metrics.startAt,b.at(-21).date);assert.equal(z.metrics.startAt,b[0].date);assert.equal(a.metrics.volumeRatio,z.metrics.volumeRatio);
 assert.equal(run({bars:b.slice(-21)}).status,'unavailable');assert.equal(run({lookback:60,bars:b.slice(-60)}).status,'unavailable');
});
test('date validation, missing support days and nonpositive values remain unknown rather than zero',()=>{
 const b=bars();for(const invalid of [[...b].reverse(),[...b,b.at(-1)],b.slice(0,-1),b.filter((_,i)=>i!==61-24),b.map((r,i)=>i===4?{...r,date:'2026-02-30'}:r)]){const r=run({bars:invalid});assert.equal(r.status,'unavailable');assert.equal(r.matched,null);assert.equal(r.metrics.periodReturn,null);}
 for(const key of ['close','volume'])for(const value of [0,-1,NaN,Infinity]){const bad=bars();bad.at(-3)[key]=value;assert.equal(run({bars:bad}).status,'unavailable');}
 assert.equal(run({mode:'similar'}).status,'unavailable');
});
test('strength uses independent calendar dates without incorporating its prices into candidate arithmetic',()=>{
 const ref=bars().slice(-26).map(({date})=>({date})),r=run({mode:'strength',bars:early(),referenceBars:ref});assert.equal(r.matched,true);assert.equal(r.metrics.referenceReturn,null);
 assert.equal(run({mode:'strength',bars:early(),referenceBars:undefined}).status,'unavailable');
});
test('inputs are not mutated and arithmetic overflow stays unavailable',()=>{
 const input={mode:'market',bars:bars(),referenceBars:bars(),lookback:20,day,limits:{enabled:false}},before=JSON.stringify(input);API.evaluate(input);assert.equal(JSON.stringify(input),before);
 const huge=early();for(const b of huge)b.volume=1e308;assert.equal(run({mode:'strength',bars:huge}).status,'unavailable');
});
test('leave-self-out even medians correctly average both middle peers and are not rankshifted',()=>{
 const low=varied,mid=i=>varied(i)*2,high=i=>varied(i)*3,c=consensus([...Array(15).fill(low),mid,...Array(15).fill(high)]);
 const expected=run({bars:bars(high),referenceBars:bars(i=>varied(i)*1.5)}),actual=c.perCode[c.memberCodes.at(-1)];
 closeTo(actual.referenceReturn,expected.metrics.referenceReturn);closeTo(actual.correlation,expected.metrics.correlation);
});
test('consensus evaluation requires a concrete candidate code for self-exclusion',()=>{
 const c=consensus(Array(40).fill(varied)),r=run({mode:'consensus',consensus:c,code:undefined});assert.equal(r.status,'unavailable');assert.match(r.reason,/排除自身/);
});
test('the adjustable market threshold changes qualification without changing the sampled denominator or candidate arithmetic',()=>{
 const patterns=[...Array(24).fill(varied),...Array(16).fill(i=>-varied(i))];
 const accepted=consensus(patterns,{minimumBreadth:.6}),observed=consensus(patterns,{minimumBreadth:.7});
 assert.equal(accepted.identified,true);assert.equal(observed.identified,false);assert.equal(observed.minimumBreadth,.7);assert.equal(observed.breadth,.6);assert.equal(observed.commonCount,24);assert.equal(observed.validCount,40);assert.deepEqual(observed.perCode,accepted.perCode);
 for(const value of [0,1])assert.equal(consensus(patterns,{minimumBreadth:value}).status,'ready');
 for(const value of [null,'60',-.01,1.01,NaN,Infinity])assert.equal(consensus(patterns,{minimumBreadth:value}).status,'unavailable');
});
test('cached old false results regain a typed candidate from metrics rather than old display text or matched flags',()=>{
 const c=consensus([...Array(24).fill(varied),...Array(16).fill(i=>-varied(i))],{minimumBreadth:.7});
 const raw=run({mode:'consensus',consensus:c,code:c.memberCodes[0]}),legacy={status:raw.status,metrics:raw.metrics,matched:false,excluded:false,reasons:['THIS IS TRANSLATED OR ARBITRARY DISPLAY TEXT'],reason:'untrusted label'},before=JSON.stringify(legacy);
 const observed=API.applyConsensusThreshold(legacy,{consensus:c,minimumBreadth:.7});assert.equal(observed.candidateMatched,true);assert.equal(observed.marketQualified,false);assert.equal(observed.matched,false);assert.equal(observed.eligible,true);
 const accepted=API.applyConsensusThreshold(legacy,{consensus:c,minimumBreadth:.6});assert.equal(accepted.candidateMatched,true);assert.equal(accepted.marketQualified,true);assert.equal(accepted.matched,true);assert.doesNotMatch(accepted.reasons.join(' '),/ARBITRARY|TRANSLATED/);assert.equal(JSON.stringify(legacy),before);assert.deepEqual(accepted.metrics,legacy.metrics);assert.notEqual(accepted.metrics,legacy.metrics);
});
test('observation candidates preserve independent risk and heat annotations while strict matching requires every gate',()=>{
 const c=consensus(Array(40).fill(varied)),base=run({mode:'consensus',consensus:c,code:c.memberCodes[0]});base.metrics.volumeRatio=3;
 const heated=API.applyLimits(base,{enabled:true},20),risk=API.applyConsensusThreshold(heated,{consensus:c,minimumBreadth:0,eligible:false,eligibilityCodes:['risk_name']});
 assert.equal(risk.candidateMatched,true);assert.equal(risk.marketQualified,true);assert.equal(risk.eligible,false);assert.equal(risk.excluded,true);assert.equal(risk.matched,false);assert.deepEqual(risk.eligibilityCodes,['risk_name']);
 risk.reasons=['满足：伪造的展示文本'];
 const cooler=API.applyLimits(risk,{enabled:false},20);assert.equal(cooler.excluded,false);assert.equal(cooler.matched,false);assert.equal(cooler.eligible,false);
 const stillRisk=API.applyConsensusThreshold(cooler,{consensus:c,minimumBreadth:0});assert.equal(stillRisk.eligible,false);assert.equal(stillRisk.matched,false);
 const qualified=API.applyConsensusThreshold(cooler,{consensus:c,minimumBreadth:0,eligible:true});assert.equal(qualified.matched,true);assert.deepEqual(qualified.eligibilityCodes,[]);
});
test('a zero market threshold cannot revive insufficient coverage, mismatched periods or unavailable stock metrics',()=>{
 const c=consensus(Array(40).fill(varied)),base=run({mode:'consensus',consensus:c,code:c.memberCodes[0]});
 for(const invalid of [{...c,status:'unavailable'},{...c,requestedCount:51,coverage:40/51},{...c,lookback:60},{...c,day:'2026-11-19'},{...c,commonCount:41}]){
  const result=API.applyConsensusThreshold(base,{consensus:invalid,minimumBreadth:0});assert.equal(result.status,'unavailable');assert.equal(result.candidateMatched,null);assert.equal(result.marketQualified,null);assert.equal(result.matched,null);
 }
 const result=API.applyConsensusThreshold(run({bars:[]}),{consensus:c,minimumBreadth:0});assert.equal(result.status,'unavailable');assert.equal(result.candidateMatched,null);
 for(const minimumBreadth of [null,-1,2,NaN,'0.6'])assert.throws(()=>API.applyConsensusThreshold(base,{consensus:c,minimumBreadth}));
});
test('typed heat toggles do not infer rule outcomes from Chinese or translated presentation strings',()=>{
 const base=run({mode:'strength',bars:early(),limits:{enabled:false}});base.metrics.volumeRatio=3;const capped=API.applyLimits(base,{enabled:true});
 capped.reasons=['未满足：任意文本'];capped.ruleReasons=['TRANSLATED DISPLAY ONLY'];
 const restored=API.applyLimits(capped,{enabled:false});assert.equal(restored.matched,true);assert.equal(restored.excluded,false);assert.equal(restored.candidateMatched,true);
 const blocked={...capped,candidateMatched:false,matched:true,baseMatched:true,reasons:['满足：任意文本']};assert.equal(API.applyLimits(blocked,{enabled:false}).matched,false);
 const legacy={status:'ready',matched:true,excluded:false,metrics:base.metrics,reasons:['legacy rule label']};const oldCap=API.applyLimits(legacy,{enabled:true}),oldRestore=API.applyLimits(oldCap,{enabled:false});assert.equal(oldRestore.matched,true);assert.deepEqual(oldRestore.ruleReasons,['legacy rule label']);
});
