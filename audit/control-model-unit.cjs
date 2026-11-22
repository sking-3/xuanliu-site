'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const model=require('../control/model.js'),engine=require('../screening/trend-screen.js');
const day='2026-11-20',asOf=day+'T18:00:00+08:00',fetchedAt='2026-11-21T00:01:00+08:00';
const copy=value=>JSON.parse(JSON.stringify(value));
function bars(n=61){const dates=[];for(let d=new Date(day+'T00:00:00Z');dates.length<n;d.setUTCDate(d.getUTCDate()-1))if(![0,6].includes(d.getUTCDay()))dates.unshift(d.toISOString().slice(0,10));let price=100;return dates.map((date,i)=>({date,close:price*=1+[.003,-.002,.004,-.001,.002][i%5],volume:100}));}
function dataset(total=120,count=Math.min(120,total)){
 const universe=Array.from({length:total},(_,i)=>({code:(600000+i)+'.SH',name:'测试股票'+i,sector:'测试行业'+i%3,exchange:'SH'}));
 const requested=engine.selectMarketSample(universe,count);
 return {schema:'books.research.dataset.v1',day,asOf,completed:true,collectionStatus:'complete',expectedCount:count,totalUniverseCount:total,universe,reference:{code:'000300.SH',adjustment:'index',bars:bars(),fetchedAt},records:requested.map(stock=>({stock,source:{status:'ready',day,adjustment:'qfq',bars:bars(),fetchedAt}}))};
}
const config=settings=>model.normalizeConfig({settings});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,actual+' != '+expected);

test('pure browser and CommonJS share the versioned model without network APIs',()=>{
 const scope={TextEncoder,setTimeout};vm.runInNewContext(fs.readFileSync(require.resolve('../control/model.js'),'utf8'),scope);
 assert.equal(typeof scope.BooksControlModel.normalizeDataset,'function');assert.equal(typeof model.engineVersion,'string');
 assert.doesNotMatch(fs.readFileSync(require.resolve('../control/model.js'),'utf8'),/\bfetch\s*\(|XMLHttpRequest|WebSocket|eval\s*\(|new Function/);
});
test('config normalization merges known defaults without mutating or sharing defaults',()=>{
 const c=model.normalizeConfig();assert.deepEqual(c,model.DEFAULT_CONFIG);c.settings.limits.maxReturn20=999;assert.equal(model.DEFAULT_CONFIG.settings.limits.maxReturn20,15);
 const partial=config({lookback:60,sampleSize:'240',mode:'market'});assert.equal(partial.settings.benchmark,'000300.SH');assert.equal(partial.settings.limits.maxVolumeRatio,2.5);
});
test('minimum breadth defaults preserve old configs and accept the inclusive zero-to-one boundaries',()=>{
 assert.match(model.engineVersion,/2026-11-22\.v4$/);assert.equal(model.DEFAULT_CONFIG.settings.minimumBreadth,.6);assert.equal(model.normalizeConfig().settings.minimumBreadth,.6);
 const legacy={name:'旧方案',settings:{lookback:60,sampleSize:'240',mode:'market',limits:{enabled:false,maxReturn20:15,maxReturn60:30,maxReturn5:8,maxDeviation:8,maxVolumeRatio:2.5}}},before=JSON.stringify(legacy),normalized=model.normalizeConfig(legacy);
 assert.equal(normalized.settings.minimumBreadth,.6);assert.equal(JSON.stringify(legacy),before);assert.equal(normalized.name,'旧方案');assert.equal(normalized.settings.lookback,60);assert.equal(normalized.settings.limits.enabled,false);
 for(const minimumBreadth of [0,.6,1])assert.equal(config({minimumBreadth}).settings.minimumBreadth,minimumBreadth);
 normalized.settings.minimumBreadth=.7;assert.equal(model.DEFAULT_CONFIG.settings.minimumBreadth,.6);
});
test('minimum breadth rejects nonnumeric and out-of-range values rather than coercing percentages',()=>{
 for(const minimumBreadth of [-.001,1.001,NaN,Infinity,-Infinity,'0.6','60%',null,true,false,[],{}])assert.throws(()=>config({minimumBreadth}),String(minimumBreadth));
});
test('configuration rejects unknown code, URLs, secrets and unsupported enums',()=>{
 for(const bad of [{url:'https://example.test'},{secret:'hidden'},{settings:{script:'alert(1)'}},{settings:{limits:{cookie:'hidden'}}},{name:'<script>x</script>'},{name:'https://example.test'},{module:'other'},{name:null},{settings:null},{settings:{limits:null}},{settings:{lookback:10}},{settings:{sampleSize:120}},{settings:{mode:'similar'}},{settings:{benchmark:'600519.SH'}}])assert.throws(()=>model.normalizeConfig(bad));
});
test('all limit values are finite positive bounded numbers including when disabled',()=>{
 for(const value of [0,-1,NaN,Infinity,'15',null,1001])assert.throws(()=>config({limits:{enabled:false,maxReturn20:value}}));
 for(const value of [0,101,NaN])assert.throws(()=>config({limits:{maxVolumeRatio:value}}));
 assert.equal(config({limits:{maxReturn20:1000,maxVolumeRatio:100}}).settings.limits.maxReturn20,1000);
 assert.throws(()=>config({limits:{enabled:'yes'}}));
});
test('normalization preserves actual prices, volumes and provenance while dropping extra display fields',()=>{
 const raw=dataset();raw.records[0].stock.price=999;raw.records[0].source.url='https://public.example.test/';raw.records[0].source.bars[0].close=143.76;raw.records[0].source.bars[0].volume=250.25;
 const before=JSON.stringify(raw),clean=model.normalizeDataset(raw);assert.equal(JSON.stringify(raw),before);assert.equal(clean.records[0].source.bars[0].close,143.76);assert.equal(clean.records[0].source.bars[0].volume,250.25);assert.equal(clean.reference.fetchedAt,fetchedAt);assert.equal(clean.records[0].stock.price,undefined);assert.equal(clean.records[0].source.url,undefined);
});
test('normalization preserves complete actual OHLC in private archives without inventing it for legacy close-only bars',()=>{
 const legacy=dataset(),old=model.normalizeDataset(legacy);
 assert.deepEqual(old.records[0].source.bars,legacy.records[0].source.bars);assert.deepEqual(Object.keys(old.records[0].source.bars[0]),['date','close','volume']);
 const raw=dataset();
 for(const series of [raw.reference.bars,...raw.records.map(record=>record.source.bars)])for(const bar of series)Object.assign(bar,{open:bar.close-.2,high:bar.close+.5,low:bar.close-.5});
 const before=JSON.stringify(raw),clean=model.normalizeDataset(raw);assert.equal(JSON.stringify(raw),before);
 assert.deepEqual(clean.reference.bars,raw.reference.bars);assert.deepEqual(clean.records[0].source.bars,raw.records[0].source.bars);
 assert.equal(clean.records[0].source.fetchedAt,fetchedAt);
});
test('partial OHLC histories, nonfinite values and invalid price ranges cannot enter archive replay',()=>{
 for(const mutate of [series=>{series[0].open=series[0].high+1;},series=>{delete series[0].open;},series=>{delete series[0].open;delete series[0].high;delete series[0].low;},series=>{series[0].high=series[0].close-.1;},series=>{series[0].low=series[0].close+.1;},series=>{series[0].open=NaN;},series=>{series[0].low=0;},series=>{series[0].high='100';}]){
  for(const reference of [false,true]){
   const raw=dataset(),series=reference?raw.reference.bars:raw.records[0].source.bars;
   for(const bar of series)Object.assign(bar,{open:bar.close-.2,high:bar.close+.5,low:bar.close-.5});
   mutate(series);assert.throws(()=>model.normalizeDataset(raw));
  }
 }
});
test('timestamp validation binds asOf to Beijing day while allowing later collection times',()=>{
 const raw=dataset();raw.asOf='2026-11-19T16:00:00Z';assert.equal(model.normalizeDataset(raw).day,day);
 for(const value of ['2026-11-20T16:00:00Z','2026-11-20 18:00:00','2026-02-30T18:00:00+08:00','2026-11-20T18:00:00+14:30']){raw.asOf=value;assert.throws(()=>model.normalizeDataset(raw));}
});
test('cancelled and incomplete batches cannot enter the model',()=>{
 for(const mutate of [d=>d.completed=false,d=>d.collectionStatus='cancelled',d=>d.expectedCount--,d=>d.records.pop(),d=>d.totalUniverseCount++]){const raw=dataset();mutate(raw);assert.throws(()=>model.normalizeDataset(raw));}
});
test('requested and universe stock codes must be unique genuine SH/SZ stock codes',()=>{
 for(const mutate of [d=>d.records[1]=d.records[0],d=>d.universe[1]=d.universe[0],d=>d.records[0].stock={...d.records[0].stock,code:'600999.SH'},d=>d.records[0].stock.code='000300.SH',d=>d.records[0].stock.code='399001.SZ',d=>d.records[0].stock.code='830001.BJ',d=>d.records[0].stock.exchange='SZ']){const raw=dataset();mutate(raw);assert.throws(()=>model.normalizeDataset(raw));}
});
test('ready sources require matching day, explicit qfq adjustment and a valid capture timestamp',()=>{
 for(const mutate of [s=>s.day='2026-11-19',s=>s.adjustment='day',s=>delete s.fetchedAt,s=>s.fetchedAt='yesterday',s=>s.status='pending']){const raw=dataset();mutate(raw.records[0].source);assert.throws(()=>model.normalizeDataset(raw));}
});
test('raw bars reject invalid numeric units, dates, missing endpoints and overlength history',()=>{
 for(const mutate of [b=>b.reverse(),b=>b[1].date=b[0].date,b=>b.at(-1).date='2026-11-23',b=>b.pop(),b=>b[0].date='2026-02-30',b=>b[0].close=0,b=>b[0].close=NaN,b=>b[0].volume=-1,b=>b.push({...b.at(-1)})]){const raw=dataset();mutate(raw.records[0].source.bars);assert.throws(()=>model.normalizeDataset(raw));}
});
test('prototype keys, accessors, sparse arrays, unsafe text and oversized JSON are rejected',()=>{
 const poisoned=dataset();Object.defineProperty(poisoned.records[0].stock,'__proto__',{value:{polluted:true},enumerable:true});assert.throws(()=>model.normalizeDataset(poisoned));assert.equal({}.polluted,undefined);
 const accessor=dataset();Object.defineProperty(accessor,'other',{get(){throw Error('getter executed');},enumerable:true});assert.throws(()=>model.normalizeDataset(accessor),/动态访问器/);
 const sparse=dataset();delete sparse.records[0];assert.throws(()=>model.normalizeDataset(sparse),/空缺/);
 const html=dataset();html.records[0].stock.name='<img src=x>';assert.throws(()=>model.normalizeDataset(html));
 const large=dataset();large.note='x'.repeat(64*1024*1024);assert.throws(()=>model.normalizeDataset(large),/大小/);
});
test('a finished batch may include unavailable sources without inventing bars',()=>{
 const raw=dataset();raw.records[0].source={status:'unavailable',day,bars:[],adjustment:null,fetchedAt:null,reason:'来源没有该日期'};
 const clean=model.normalizeDataset(raw);assert.deepEqual(clean.records[0].source,{status:'unavailable',day,reason:'来源没有该日期'});
});
test('one complete real-shape raw batch replays shared consensus with counts and capture times',async()=>{
 const raw=dataset(),before=JSON.stringify(raw),progress=[];const r=await model.evaluateDataset(raw,model.DEFAULT_CONFIG,engine,{onProgress:p=>progress.push(p.checked)});
 assert.equal(JSON.stringify(raw),before);assert.equal(r.status,'complete');assert.equal(r.summary.identified,true);assert.equal(r.summary.validCount,120);assert.equal(r.summary.coverage,1);assert.equal(r.summary.breadth,1);assert.equal(r.summary.fullMarket,true);assert.equal(r.counts.checked,120);assert.equal(r.counts.matched,120);assert.equal(r.records.length,120);assert.equal(r.sourceTimes.fetchedStart,fetchedAt);assert.equal(progress[0],0);assert.equal(progress.at(-1),120);
 near(r.summary.curveReturn,r.records[0].result.metrics.periodReturn);assert.equal(r.summary.period.startAt,raw.reference.bars.at(-21).date);
});
test('sample sizes cannot silently upgrade120 records to240 or full pool',async()=>{
 const raw=dataset(300);for(const sampleSize of ['240','all']){const r=await model.evaluateDataset(raw,config({sampleSize}),engine);assert.equal(r.status,'unavailable');assert.equal(r.summary.identified,false);assert.equal(r.records.length,0);}
 const r=await model.evaluateDataset(raw,model.DEFAULT_CONFIG,engine);assert.equal(r.status,'complete');assert.equal(r.summary.fullMarket,false);
});
test('a manually selected winner cohort cannot be relabeled stratified market consensus',async()=>{
 const raw=dataset(300);const actual=new Set(raw.records.map(r=>r.stock.code)),outside=raw.universe.find(s=>!actual.has(s.code));raw.records[0].stock=outside;
 const r=await model.evaluateDataset(raw,model.DEFAULT_CONFIG,engine);assert.equal(r.status,'unavailable');assert.match(r.reason,/分层/);assert.equal(r.summary.identified,false);
});
test('replay preserves raw percentages and volume ratios while excluding heat after breadth',async()=>{
 const raw=dataset();for(const record of raw.records){const b=record.source.bars;b.at(-21).close=100;b.at(-1).close=143.76;for(const row of b.slice(-5))row.volume=250;}
 const r=await model.evaluateDataset(raw,model.DEFAULT_CONFIG,engine);assert.equal(r.status,'complete');assert.equal(r.summary.breadth,1);assert.equal(r.summary.identified,true);assert.equal(r.counts.excluded,120);assert.equal(r.counts.matched,0);near(r.records[0].result.metrics.periodReturn,43.76);assert.equal(r.records[0].result.metrics.volumeRatio,2.5);
});
test('missing sources retain the original denominator and insufficient coverage cannot claim majority',async()=>{
 for(const missing of [24,25]){const raw=dataset();for(let i=0;i<missing;i++)raw.records[i].source={status:'unavailable',reason:'测试缺失'};
  const r=await model.evaluateDataset(raw,model.DEFAULT_CONFIG,engine);assert.equal(r.summary.validCount,120-missing);near(r.summary.coverage,(120-missing)/120);assert.equal(r.status,missing===24?'complete':'unavailable');assert.equal(r.summary.identified,missing===24);assert.equal(r.records.length,120);
 }
});
test('one unchanged raw batch retains candidates and breadth while a higher global threshold removes strict matches',async()=>{
 const raw=dataset();
 for(let i=72;i<raw.records.length;i++){let price=100;raw.records[i].source.bars=bars().map((bar,index)=>({...bar,close:price*=1-[.003,-.002,.004,-.001,.002][index%5]}));}
 const before=JSON.stringify(raw),low=await model.evaluateDataset(raw,config({minimumBreadth:.6,limits:{enabled:false}}),engine),high=await model.evaluateDataset(raw,config({minimumBreadth:.7,limits:{enabled:false}}),engine);
 assert.equal(JSON.stringify(raw),before);
 for(const [result,threshold,identified,strict]of [[low,.6,true,72],[high,.7,false,0]]){
  assert.equal(result.status,'complete');assert.equal(result.summary.minimumBreadth,threshold);assert.equal(result.summary.requestedCount,120);assert.equal(result.summary.totalUniverseCount,120);assert.equal(result.summary.validCount,120);assert.equal(result.summary.coverage,1);assert.equal(result.summary.commonCount,72);near(result.summary.breadth,.6);assert.equal(result.summary.identified,identified);assert.equal(result.counts.total,120);assert.equal(result.counts.checked,120);assert.equal(result.counts.ready,120);assert.equal(result.counts.candidate,72);assert.equal(result.counts.matched,strict);
  assert.equal(result.records.filter(record=>record.result.candidateMatched===true).length,72);assert.equal(result.records.filter(record=>record.result.matched===true).length,strict);
 }
 assert.deepEqual(low.records.map(record=>record.result.metrics),high.records.map(record=>record.result.metrics));
 assert.deepEqual(low.records.map(record=>record.result.candidateMatched),high.records.map(record=>record.result.candidateMatched));
});
test('zero minimum breadth cannot revive a batch below the unchanged data-coverage requirement',async()=>{
 const raw=dataset();for(let i=0;i<25;i++)raw.records[i].source={status:'unavailable',day,reason:'缺少本日真实数据'};const before=JSON.stringify(raw);
 const result=await model.evaluateDataset(raw,config({minimumBreadth:0,limits:{enabled:false}}),engine);
 assert.equal(JSON.stringify(raw),before);assert.equal(result.status,'unavailable');assert.equal(result.summary.minimumBreadth,0);assert.equal(result.summary.identified,false);assert.equal(result.summary.validCount,95);near(result.summary.coverage,95/120);assert.equal(result.summary.requestedCount,120);assert.equal(result.summary.totalUniverseCount,120);assert.equal(result.counts.total,120);assert.equal(result.counts.checked,120);assert.equal(result.counts.matched,0);assert.equal(result.counts.candidate,0);assert.equal(result.records.length,120);assert(result.records.every(record=>record.result.matched!==true&&record.result.candidateMatched!==true));
});
test('market and early-strength modes use the same normalized raw batch and shared engine',async()=>{
 for(const mode of ['market','strength']){const r=await model.evaluateDataset(dataset(),config({mode,limits:{enabled:false}}),engine);assert.equal(r.status,'complete');assert.equal(r.summary.identified,false);assert.equal(r.summary.breadth,null);assert.equal(r.counts.ready,120);assert.equal(r.summary.coverage,1);}
 const r=await model.evaluateDataset(dataset(),config({benchmark:'399001.SZ'}),engine);assert.equal(r.status,'unavailable');assert.match(r.reason,/基准/);
});
test('nonconsensus replay uses the archived scope independently of the consensus sample setting',async()=>{
 for(const raw of [dataset(300),dataset(300,300)])for(const mode of ['market','strength'])for(const sampleSize of ['120','240','all']){
  const r=await model.evaluateDataset(raw,config({mode,sampleSize,limits:{enabled:false}}),engine);
  assert.equal(r.status,'complete');assert.equal(r.counts.checked,raw.expectedCount);assert.equal(r.summary.requestedCount,raw.expectedCount);assert.equal(r.summary.totalUniverseCount,300);assert.equal(r.summary.fullMarket,raw.expectedCount===300);
 }
});
test('evaluation yields to stop signals and never publishes a complete majority conclusion after stop',async()=>{
 let stop=false;const progress=[];const r=await model.evaluateDataset(dataset(),model.DEFAULT_CONFIG,engine,{shouldStop:()=>stop,onProgress:p=>{progress.push(p.checked);if(p.checked===20)setTimeout(()=>{stop=true;},0);}});
 assert.equal(r.status,'stopped');assert.equal(r.counts.checked,20);assert.equal(r.summary.identified,false);assert.equal(r.records.length,20);assert.deepEqual(progress,[0,20]);
 const immediate=await model.evaluateDataset(dataset(),model.DEFAULT_CONFIG,engine,{shouldStop:()=>true});assert.equal(immediate.status,'stopped');assert.equal(immediate.counts.checked,0);assert.equal(immediate.summary.identified,false);
});
test('legacy configurations merge independent direction, strength and pattern defaults',()=>{
 const input={settings:{directionRules:{minimumReturnPercent:2},strength:{crossWithinDays:10},patterns:{crossWindow:20}}},before=JSON.stringify(input),c=model.normalizeConfig(input);
 assert.equal(c.settings.direction,'all');assert.deepEqual(c.settings.directionRules,{minimumReturnPercent:2,maximumSidewaysRangePercent:8});assert.deepEqual(c.settings.strength,{crossWithinDays:10,minReturn5:0});assert.equal(c.settings.patterns.crossWindow,20);assert.equal(c.settings.patterns.nearPct,2);assert.equal(JSON.stringify(input),before);
 for(const key of ['directionRules','strength','patterns']){c.settings[key][Object.keys(c.settings[key])[0]]=999;assert.notEqual(c.settings[key],model.DEFAULT_CONFIG.settings[key]);assert.equal(model.DEFAULT_CONFIG.settings.patterns.nearPct,2);}
 assert.deepEqual(model.normalizeConfig(JSON.parse(JSON.stringify(model.DEFAULT_CONFIG))),model.DEFAULT_CONFIG);
});
test('new config fields enforce finite bounds, enums, integer windows and meaningful parameter ordering',()=>{
 for(const settings of [{direction:'mixed'},{direction:null},{directionRules:null},{directionRules:{unknown:1}},{directionRules:{minimumReturnPercent:-1}},{directionRules:{minimumReturnPercent:101}},{directionRules:{maximumSidewaysRangePercent:1001}},{strength:{crossWithinDays:0}},{strength:{crossWithinDays:21}},{strength:{crossWithinDays:2.5}},{strength:{minReturn5:-101}},{strength:{minReturn5:'0'}},{patterns:{crossWindow:21}},{patterns:{nearPct:-1}},{patterns:{rangePct:101}},{patterns:{pullbackMinPct:9,pullbackMaxPct:8}},{patterns:{volumeExpandRatio:.8,volumeContractRatio:.8}},{patterns:{volumeContractRatio:101}},{patterns:{volumeExpandRatio:NaN}}])assert.throws(()=>config(settings),JSON.stringify(settings));
 const c=config({direction:'sideways',directionRules:{minimumReturnPercent:0,maximumSidewaysRangePercent:1000},strength:{crossWithinDays:20,minReturn5:-100},patterns:{nearPct:0,rangePct:100,crossWindow:1,pullbackMinPct:0,pullbackMaxPct:100,volumeContractRatio:0,volumeExpandRatio:100}});assert.equal(c.settings.strength.crossWithinDays,20);assert.equal(c.settings.patterns.volumeExpandRatio,100);
});
test('only enabled strength mode rejects an unsatisfiable recent-return interval',()=>{
 for(const minReturn5 of [8,9])assert.throws(()=>config({mode:'strength',strength:{minReturn5},limits:{maxReturn5:8}}),/近5日涨幅下限须小于上限/);
 assert.equal(config({mode:'strength',strength:{minReturn5:7.99},limits:{maxReturn5:8}}).settings.strength.minReturn5,7.99);
 assert.equal(config({mode:'strength',strength:{minReturn5:8},limits:{enabled:false,maxReturn5:8}}).settings.strength.minReturn5,8);
 for(const mode of ['consensus','market'])assert.equal(config({mode,strength:{minReturn5:9},limits:{maxReturn5:8}}).settings.strength.minReturn5,9);
});
test('replay applies selected direction without changing base candidates, denominator or source metrics',async()=>{
 const raw=dataset(),before=JSON.stringify(raw),all=await model.evaluateDataset(raw,config({limits:{enabled:false}}),engine),up=await model.evaluateDataset(raw,config({direction:'up',directionRules:{minimumReturnPercent:.5},limits:{enabled:false}}),engine),down=await model.evaluateDataset(raw,config({direction:'down',directionRules:{minimumReturnPercent:.5},limits:{enabled:false}}),engine);
 assert.equal(all.counts.candidate,120);assert.equal(up.counts.candidate,120);assert.equal(up.counts.matched,120);assert.equal(up.summary.directionSummary.breadth,1);assert.equal(up.summary.identified,true);assert.equal(down.counts.candidate,120);assert.equal(down.counts.matched,0);assert.equal(down.summary.directionSummary.breadth,0);assert.equal(down.summary.directionSummary.validCount,120);assert.equal(down.summary.breadth,1);assert.equal(down.summary.identified,false);assert.equal(JSON.stringify(raw),before);assert.deepEqual(up.records.map(r=>r.result.metrics),down.records.map(r=>r.result.metrics));
});
test('replay rejects wide V-shaped ranges from sideways while preserving them in all-direction observations',async()=>{
 const raw=dataset();for(const row of raw.records)row.source.bars.slice(-21).forEach((bar,i)=>bar.close=100+(i<=10?i:20-i)*5);
 const all=await model.evaluateDataset(raw,config({limits:{enabled:false}}),engine),flat=await model.evaluateDataset(raw,config({direction:'sideways',limits:{enabled:false}}),engine);
 assert.equal(all.counts.matched,120);assert.equal(flat.counts.candidate,120);assert.equal(flat.counts.matched,0);assert(flat.records.every(r=>r.result.direction==='unclassified'));assert.equal(flat.summary.directionSummary.validCount,120);
});
test('strength replay uses its adjustable crossover window and ignores consensus-only direction selection',async()=>{
 const raw=dataset();for(const row of raw.records){const b=row.source.bars;b.forEach(bar=>bar.close=100);const wave=[99,99,99,99,99,99.5,100,100.5,101,101.5],start=46;wave.forEach((close,i)=>b[start+i].close=close);for(let i=start+10;i<b.length;i++)b[i].close=101.5+(i-start-9)*.1;}
 const early=await model.evaluateDataset(raw,config({mode:'strength',direction:'down',limits:{enabled:false}}),engine),wide=await model.evaluateDataset(raw,config({mode:'strength',direction:'down',strength:{crossWithinDays:7},limits:{enabled:false}}),engine),hot=await model.evaluateDataset(raw,config({mode:'strength',strength:{crossWithinDays:7,minReturn5:1},limits:{enabled:false}}),engine);
 assert.equal(early.counts.matched,0);assert.equal(wide.counts.matched,120);assert.equal(wide.summary.directionSummary.direction,'all');assert.equal(wide.records[0].result.metrics.crossAgeDays,6);assert.equal(hot.counts.matched,0);
});
test('a short26-bar archive remains analyzable while an unsupported adjustable strength window stays unknown',async()=>{
 const raw=dataset();raw.reference.bars=raw.reference.bars.slice(-26);for(const row of raw.records)row.source.bars=row.source.bars.slice(-26);
 const market=await model.evaluateDataset(raw,config({mode:'market',limits:{enabled:false}}),engine),strength=await model.evaluateDataset(raw,config({mode:'strength',strength:{crossWithinDays:20},limits:{enabled:false}}),engine);
 assert.equal(market.counts.ready,120);assert.equal(market.counts.matched,120);assert.equal(strength.counts.ready,120);assert.equal(strength.counts.matched,0);assert(strength.records.every(row=>row.result.strengthKnown===false&&row.result.candidateMatched===null));
});
