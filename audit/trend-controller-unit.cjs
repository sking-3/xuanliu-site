'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRunner,createCachedRunner,sortRecords,mount}=require('../screening/trend-controller.js');
const day='2026-11-20',asOf='2026-11-20T08:00:00Z',fetchedAt='2026-11-20T10:00:00Z';
const stocks=[{code:'600519.SH',name:'贵州茅台'},{code:'000858.SZ',name:'五粮液'}];
const marketRows=Array.from({length:32},(_,i)=>({code:String(600000+i)+'.SH',name:'市场'+i,exchange:'SH',sector:i%2?'银行':'工业',changePct:32-i}));
function bars(n=65){return Array.from({length:n},(_,i)=>({date:new Date(Date.parse(day+'T00:00:00Z')-(n-i-1)*86400000).toISOString().slice(0,10),close:100+i,volume:1000}));}
const good=(code,index=false)=>({status:'ready',code,day,adjustment:index?'index':'qfq',bars:bars(),fetchedAt,sourceUrl:'https://web.ifzq.gtimg.cn/'});
const metrics={correlation:.8,directionAgreement:.8,periodReturn:12.3,return5:3,ma20Deviation:2,startClose:100,endClose:112.3,volumeAvg5:100,volumeAvgPrevious20:100,volumeRatio:1,startAt:'2026-10-20',endAt:day};
function fakeEngine(overrides={}){return {
 selectMarketSample:rows=>rows.slice().sort((a,b)=>a.code.localeCompare(b.code)),
 buildConsensus:({records,expectedCount})=>({status:records.length>=30?'ready':'unavailable',identified:records.length>=30,validCount:records.length,coverage:records.length/expectedCount,breadth:.8,commonCount:Math.floor(records.length*.8),reason:records.length>=30?'样本形成主流':'覆盖不足'}),
 evaluate:input=>({status:'ready',matched:input.mode!=='consensus'||input.consensus.identified,excluded:false,metrics:{...metrics},reasons:['共性条件'],reason:'研究条件'}),...overrides
};}
function setup(overrides={},engineOverrides={}){const calls=[],pauses=[],updates=[],engine=fakeEngine(engineOverrides);const technical={sourceState:()=>({status:'idle'}),history:async(stock,target,signal,options)=>{calls.push({stock,target,signal,options});return good(stock.code,options.index);},...overrides};const runner=createRunner({technical,engine,wait:async(ms,signal)=>{pauses.push(ms);assert.equal(signal.aborted,false);},now:()=>Date.parse(fetchedAt),onUpdate:s=>updates.push(s)});return {calls,pauses,updates,runner,technical,engine};}
const options=(extra={})=>({mode:'strength',lookback:20,day,asOf,stocks,marketRows,sampleSize:120,reference:{code:'000300.SH'},index:true,limits:{enabled:true,maxReturn20:15,maxReturn60:30,maxReturn5:8,maxDeviation:8,maxVolumeRatio:2.5},...extra});
test('construction and invalid scope make no requests; individual-stock mode is removed',async()=>{
 const s=setup();assert.equal(s.calls.length,0);assert.equal(mount({getElementById:()=>null}),null);
 for(const extra of [{stocks:[]},{mode:'similar'},{reference:{code:'600519.SH'}}])assert.equal((await s.runner.run(options(extra))).status,'unavailable');assert.equal(s.calls.length,0);
});
test('serial dated source reads use shared index calendar and bounded pauses',async()=>{
 const s=setup(),r=await s.runner.run(options());assert.equal(r.status,'complete');assert.equal(r.records.length,2);assert.equal(r.requests,3);assert.deepEqual(s.pauses,[1500,1500]);
 for(const [i,c] of s.calls.entries()){assert.equal(c.stock.asOf,asOf);assert.equal(c.target,day);assert.deepEqual(c.options,{minBars:26,index:i===0});}assert.equal(r.records[0].fetchedAt,fetchedAt);
});
test('a market reference always uses the independent market pool, never winners/currentpage/stocks',async()=>{
 const calls=[],s=setup({}, {buildConsensus:input=>{calls.push(input);return fakeEngine().buildConsensus(input);}});
 const r=await s.runner.run(options({mode:'consensus',stocks:[{code:'600999.SH',name:'单只领涨股'}]}));assert.equal(r.total,32);assert.equal(r.records.length,32);assert.equal(r.status,'complete');
 assert.deepEqual(s.calls.map(c=>c.stock.code),['000300.SH',...marketRows.map(r=>r.code)]);assert.equal(calls[0].expectedCount,32);assert.equal(calls[0].totalUniverseCount,32);assert.ok(calls[0].calendar.length>=26);assert.equal(calls[0].records.length,32);
 assert.ok(s.updates.filter(u=>u.status==='running').every(u=>u.consensus===null),'collecting cannot assert a partial majority');assert.equal(r.consensus.identified,true);
});
test('fewer than30 reference stocks cannot be called market consensus, even with a single winning target',async()=>{
 const s=setup(),r=await s.runner.run(options({mode:'consensus',marketRows:marketRows.slice(0,29)}));assert.equal(r.status,'unavailable');assert.match(r.reason,/不足30/);assert.equal(s.calls.length,0);
});
test('sample and full market settings reach the sampler explicitly without using scope lists',async()=>{
 const sizes=[],s=setup({}, {selectMarketSample:(rows,limit)=>{sizes.push(limit);return rows;}});
 await s.runner.run(options({mode:'consensus',sampleSize:240}));await s.runner.run(options({mode:'consensus',sampleSize:'all'}));assert.deepEqual(sizes,[240,Infinity]);
 const n=s.calls.length;assert.equal((await s.runner.run(options({mode:'consensus',sampleSize:20}))).status,'unavailable');assert.equal(s.calls.length,n);
});
test('source failure during consensus does not build a partial majority or retry',async()=>{
 let calls=0,built=0;const s=setup({history:async stock=>++calls<=4?good(stock.code):{status:'unavailable',sourceStopped:true,reason:'HTTP429'}},{buildConsensus:()=>{built++;return {};}});
 const r=await s.runner.run(options({mode:'consensus'}));assert.equal(r.status,'stopped');assert.equal(r.records.length,3);assert.equal(calls,5);assert.equal(built,0);assert.equal(r.consensus,null);assert.match(r.reason,/未判断市场共性/);
});
test('coverage failure remains unknown instead of a forced zero or false majority',async()=>{
 const s=setup({history:async(stock,target,signal,opts)=>opts.index?good(stock.code,true):{status:'unavailable',reason:'缺少同日数据'}});
 const r=await s.runner.run(options({mode:'consensus'}));assert.equal(r.status,'unavailable');assert.equal(r.consensus.identified,false);assert.ok(r.records.every(r=>r.result.status==='unavailable'&&r.result.matched===null));
});
test('a complete but divergent reference pool does not produce matched results',async()=>{
 const s=setup({}, {buildConsensus:input=>({...fakeEngine().buildConsensus(input),identified:false,breadth:.45,commonCount:14,reason:'市场走势分化'})});
 const r=await s.runner.run(options({mode:'consensus'}));assert.equal(r.status,'complete');assert.match(r.reason,/分化/);assert.ok(r.records.every(r=>r.result.matched===false));
});
test('heat caps are passed to the engine without clipping the original price or volume metrics',async()=>{
 const seen=[],s=setup({}, {evaluate:input=>{seen.push(input);return {status:'ready',matched:false,excluded:true,exclusionReasons:['阶段涨幅超过上限'],metrics:{...metrics,periodReturn:43.76,startClose:100,endClose:143.76,volumeRatio:5.48}};}});
 const r=await s.runner.run(options());assert.deepEqual(seen[0].limits,options().limits);assert.equal(r.records[0].result.metrics.periodReturn,43.76);assert.equal(r.records[0].result.metrics.volumeRatio,5.48);assert.equal(r.records[0].result.excluded,true);
});
test('source stop blocks all reads including cached histories and changed index roles stay distinct',async()=>{
 let restricted=false;const s=setup({sourceState:()=>({status:restricted?'restricted':'idle',reason:'HTTP418已停止'})});await s.runner.run(options());restricted=true;const before=s.calls.length;
 assert.equal((await s.runner.run(options())).status,'stopped');assert.equal(s.calls.length,before);
});
test('same batch shares stock history across modes and20/60 windows but a new snapshot re-reads',async()=>{
 const s=setup();await s.runner.run(options());const r=await s.runner.run(options({mode:'market',lookback:60}));assert.equal(r.requests,0);assert.equal(s.calls.length,3);await s.runner.run(options({asOf:'2026-11-20T09:00:00Z'}));assert.equal(s.calls.length,6);
});
test('cancellation cannot leak a late result, a majority claim or another source read',async()=>{
 let release,calls=0;const s=setup({history:async stock=>{calls++;return new Promise(resolve=>release=()=>resolve(good(stock.code)));}}),pending=s.runner.run(options({mode:'consensus'}));
 s.runner.cancel('用户停止');release();await pending;assert.equal(calls,1);assert.equal(s.runner.getState().records.length,0);assert.equal(s.runner.getState().consensus,null);assert.equal(s.runner.getState().status,'stopped');
});
test('source is checked after a pause before every new request',async()=>{
 let blocked=false,calls=0,pauses=0;const technical={sourceState:()=>({status:blocked?'restricted':'idle',reason:'来源限制'}),history:async stock=>{calls++;return good(stock.code);}};
 const runner=createRunner({technical,engine:fakeEngine(),wait:async()=>{if(++pauses===2)blocked=true;}});const r=await runner.run(options());assert.equal(r.status,'stopped');assert.equal(calls,2);assert.equal(r.records.length,1);
});
test('dataset export keeps the full universe and exact selected batch without making a request',async()=>{
 const universe=Array.from({length:40},(_,i)=>({...marketRows[i%32],code:String(600000+i)+'.SH',privateNote:'never export',price:100}));
 const s=setup({}, {selectMarketSample:rows=>rows.slice(0,32)});assert.equal(s.runner.exportDataset(),null);
 await s.runner.run(options({mode:'consensus',marketRows:universe}));const calls=s.calls.length,data=s.runner.exportDataset();
 assert.equal(data.schema,'books.research.dataset.v1');assert.equal(data.source,'tencent-public-history');assert.equal(data.day,day);assert.equal(data.asOf,asOf);assert.equal(data.completed,true);assert.equal(data.collectionStatus,'complete');
 assert.equal(data.universe.length,40);assert.equal(data.totalUniverseCount,40);assert.equal(data.expectedCount,32);assert.equal(data.records.length,32);assert.equal(data.reference.code,'000300.SH');assert.equal(data.reference.adjustment,'index');assert.equal(data.reference.bars.length,61);assert.equal(data.records[0].source.bars.length,61);
 assert.equal(data.startedAt,new Date(fetchedAt).toISOString());assert.equal(data.finishedAt,new Date(fetchedAt).toISOString());assert.deepEqual(Object.keys(data.universe[0]),['code','name','sector','exchange']);assert.deepEqual(Object.keys(data.records[0].source),['status','day','bars','adjustment','fetchedAt','reason']);
 assert.doesNotMatch(JSON.stringify(data),/privateNote|sourceUrl|https:|"price"/);assert.equal(s.calls.length,calls);
});
test('dataset captures raw source values privately and each export is independent of caller mutation',async()=>{
 const sources=[],universe=marketRows.map(r=>({...r}));const s=setup({history:async(stock,target,signal,opts)=>{const source=good(stock.code,opts.index);source.cookie='secret';source.bars.at(-1).rawSecret='secret';sources.push(source);return source;}});
 await s.runner.run(options({mode:'consensus',marketRows:universe}));const data=s.runner.exportDataset(),price=data.records[0].source.bars.at(-1).close;
 data.reference.bars[0].close=-1;data.records[0].source.bars.at(-1).close=-1;data.universe[0].name='edited export';
 sources[1].bars.at(-1).close=-2;s.runner.getState().records[0].source.bars.at(-1).close=-3;universe[0].name='edited input';
 const next=s.runner.exportDataset();assert.equal(next.records[0].source.bars.at(-1).close,price);assert.equal(next.reference.bars[0].close,bars().slice(-61)[0].close);assert.equal(next.universe[0].name,marketRows[0].name);assert.doesNotMatch(JSON.stringify(next),/cookie|secret|rawSecret/);
 assert.deepEqual(next.records[0].source.bars.at(-1),{date:day,close:164,volume:1000});
});
test('fully collected missing histories export missing statuses rather than a smaller fabricated universe',async()=>{
 const s=setup({history:async(stock,target,signal,opts)=>opts.index||Number(stock.code.slice(0,6))<600029?good(stock.code,opts.index):{status:'unavailable',reason:'缺少同日数据'}});
 const state=await s.runner.run(options({mode:'consensus'}));assert.equal(state.status,'unavailable');const data=s.runner.exportDataset();
 assert.equal(data.completed,true);assert.equal(data.collectionStatus,'complete');assert.equal(data.records.length,32);assert.equal(data.expectedCount,32);assert.equal(data.totalUniverseCount,32);assert.equal(data.records.filter(r=>r.source.status==='ready').length,29);
 assert.deepEqual(data.records.at(-1).source,{status:'unavailable',day,bars:[],adjustment:null,fetchedAt:null,reason:'缺少同日数据'});
});
test('running, cancelled, source-stopped, reset and invalid batches cannot export a completed dataset',async()=>{
 let release;const s=setup({history:async stock=>new Promise(resolve=>release=()=>resolve(good(stock.code,true)))}),pending=s.runner.run(options({mode:'consensus'}));
 assert.equal(s.runner.exportDataset(),null);s.runner.cancel();release();await pending;assert.equal(s.runner.exportDataset(),null);
 const complete=setup();await complete.runner.run(options({mode:'consensus'}));assert.ok(complete.runner.exportDataset());complete.runner.clear();assert.equal(complete.runner.exportDataset(),null);
 await complete.runner.run(options({mode:'consensus',marketRows:[]}));assert.equal(complete.runner.exportDataset(),null);
 let calls=0;const denied=setup({history:async(stock,target,signal,opts)=>++calls<4?good(stock.code,opts.index):{status:'unavailable',sourceStopped:true,reason:'HTTP429'}});await denied.runner.run(options({mode:'consensus'}));assert.equal(denied.runner.exportDataset(),null);
});
test('a new source hold blocks export of previously collected data and incompatible target scopes are rejected',async()=>{
 let stopped=false;const s=setup({sourceState:()=>({status:stopped?'restricted':'idle',reason:'HTTP418'})});await s.runner.run(options({mode:'consensus'}));assert.ok(s.runner.exportDataset());stopped=true;assert.equal(s.runner.exportDataset(),null);
 const incompatible=setup();await incompatible.runner.run(options({mode:'market'}));assert.equal(incompatible.runner.getState().status,'complete');assert.equal(incompatible.runner.exportDataset(),null);
});
test('export status explains absent, running, cancelled and incompatible batches using the same export guard',async()=>{
 let release;const s=setup({history:async stock=>new Promise(resolve=>release=()=>resolve(good(stock.code,true)))});assert.deepEqual(s.runner.getExportStatus(),{available:false,reason:'尚无完整采集批次，请先完成一轮读取。'});
 const pending=s.runner.run(options({mode:'consensus'}));assert.match(s.runner.getExportStatus().reason,/仍在读取/);assert.equal(s.runner.getExportStatus().available,false);s.runner.cancel('用户暂停');release();await pending;assert.match(s.runner.getExportStatus().reason,/用户暂停/);assert.equal(s.runner.exportDataset(),null);
 const incompatible=setup();await incompatible.runner.run(options({mode:'market'}));assert.equal(incompatible.runner.getExportStatus().available,false);assert.match(incompatible.runner.getExportStatus().reason,/参考股票池之外/);assert.equal(incompatible.runner.exportDataset(),null);
});
test('export status rejects paused, restricted and unavailable sources and explains response-level stops',async()=>{
 let status='idle';const s=setup({sourceState:()=>({status,reason:status+' 来源停止'})});await s.runner.run(options({mode:'consensus'}));assert.deepEqual(s.runner.getExportStatus(),{available:true,reason:''});
 for(status of ['paused','restricted','unavailable']){assert.deepEqual(s.runner.getExportStatus(),{available:false,reason:status+' 来源停止'});assert.equal(s.runner.exportDataset(),null);}
 const denied=setup({history:async()=>({status:'unavailable',sourceStopped:true,reason:'HTTP429 来源限制'})});await denied.runner.run(options({mode:'consensus'}));assert.match(denied.runner.getExportStatus().reason,/HTTP429/);assert.equal(denied.runner.getExportStatus().available,false);
});
test('export eligibility is a lightweight check that never serializes or exposes mutable private data',async()=>{
 const s=setup();await s.runner.run(options({mode:'consensus'}));const stringify=JSON.stringify;let status;
 try{JSON.stringify=()=>{throw Error('status must not clone the dataset');};status=s.runner.getExportStatus();assert.deepEqual(status,{available:true,reason:''});}finally{JSON.stringify=stringify;}
 status.available=false;status.reason='edited';assert.deepEqual(s.runner.getExportStatus(),{available:true,reason:''});assert.ok(s.runner.exportDataset());
});
test('dataset failure diagnostics omit source URLs and authentication header values',async()=>{
 const s=setup({history:async(stock,target,signal,opts)=>opts.index?good(stock.code,true):{status:'unavailable',reason:'读取 https://example.test/?token=private-token 失败\nAuthorization: Bearer hidden-credential'}});
 await s.runner.run(options({mode:'consensus'}));const data=s.runner.exportDataset();assert.ok(data);assert.doesNotMatch(JSON.stringify(data),/example\.test|private-token|hidden-credential|Bearer/);assert.match(data.records[0].source.reason,/来源地址省略.*Authorization=\[已隐藏\]/);
});
test('exported raw dataset reproduces the actual consensus metrics without exported conclusions',async()=>{
 const actual=require('../screening/trend-screen.js'),s=setup({},actual),state=await s.runner.run(options({mode:'consensus'})),data=s.runner.exportDataset();
 assert.equal(state.status,'complete');const consensus=actual.buildConsensus({records:data.records.filter(r=>r.source.status==='ready').map(r=>({stock:r.stock,bars:r.source.bars})),calendar:data.reference.bars,lookback:20,day:data.day,expectedCount:data.expectedCount,totalUniverseCount:data.totalUniverseCount});
 assert.equal(consensus.identified,state.consensus.identified);assert.equal(consensus.commonCount,state.consensus.commonCount);
 const record=data.records[0],result=actual.evaluate({mode:'consensus',bars:record.source.bars,referenceBars:data.reference.bars,consensus,lookback:20,day:data.day,code:record.stock.code,limits:options().limits});
 assert.deepEqual(result.metrics,state.records[0].result.metrics);assert.doesNotMatch(JSON.stringify(data),/"metrics"|"matched"|"consensus"/);
 const model=require('../control/model.js'),replay=await model.evaluateDataset(data,model.DEFAULT_CONFIG,actual);assert.equal(replay.status,state.status);assert.equal(replay.summary.commonCount,state.consensus.commonCount);assert.deepEqual(replay.records[0].result.metrics,state.records[0].result.metrics);
});
const actualEngine=require('../screening/trend-screen.js'),controlModel=require('../control/model.js'),marketPool=require('../screening/market-pool.js'),actualPatterns=require('../screening/trend-patterns.js');
const settle=()=>new Promise(setImmediate);
function dataset(benchmark='000300.SH',count=marketRows.length,total=count){
 const universe=Array.from({length:total},(_,i)=>{
  const {code,name,sector,exchange}=marketRows[i]||{code:String(600000+i)+'.SH',name:'市场'+i,exchange:'SH',sector:i%2?'银行':'工业'};
  return {code,name,sector,exchange};
 });
 const selected=count===total?universe:actualEngine.selectMarketSample(universe,count);
 return {schema:'books.research.dataset.v1',day,asOf,completed:true,collectionStatus:'complete',expectedCount:count,totalUniverseCount:total,universe,reference:{code:benchmark,adjustment:'index',bars:bars().slice(-61),fetchedAt},records:selected.map(stock=>({stock,source:{status:'ready',day,adjustment:'qfq',bars:bars().slice(-61),fetchedAt}}))};
}
function cachedResult(query={}){
 const mode=query.mode||'consensus',lookback=Number(query.lookback||20),historical=query.scope==='historical-sample',data=dataset(query.benchmark,historical?120:32,historical?3052:32),consensus=mode==='consensus'?actualEngine.buildConsensus({records:data.records.map(r=>({stock:r.stock,bars:r.source.bars})),calendar:data.reference.bars,lookback,day,expectedCount:data.expectedCount,totalUniverseCount:data.totalUniverseCount}):null;
 return {mode,lookback,day,asOf,status:'complete',phase:'evaluated',limits:{enabled:false},reference:{code:data.reference.code,name:'沪深300'},records:data.records.map(r=>({stock:r.stock,result:actualEngine.evaluate({mode,bars:r.source.bars,referenceBars:data.reference.bars,code:r.stock.code,consensus,lookback,day,limits:{enabled:false}}),fetchedAt,referenceFetchedAt:fetchedAt})),consensus,total:data.expectedCount,marketUniverseCount:data.totalUniverseCount,fullMarket:!historical&&query.sampleSize==='all',...(historical?{scope:'historical-sample',sampleCount:120}:{}),requests:33,generation:'daily-generation-1',referenceFetchedAt:fetchedAt,poolFetchedStart:fetchedAt,poolFetchedEnd:fetchedAt,startedAt:fetchedAt,finishedAt:fetchedAt};
}
function cacheSetup(overrides={},runnerOptions={}){
 const calls=[],updates=[];let meta={available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-1',day,asOf,finishedAt:fetchedAt,total:32,ready:32},attempt:{status:'complete'}},resultOverride=null,rawOverride=null;
 const env={fetch:async(path,init)=>{calls.push({path,init});assert.ok(path.startsWith('/api/a-share-daily/'));const url=new URL(path,'https://books.test'),operation=url.pathname.split('/').at(-1);let value=operation==='state'?meta:operation==='dataset'?(rawOverride||dataset(url.searchParams.get('benchmark'))):(resultOverride||cachedResult(Object.fromEntries(url.searchParams)));return {ok:true,json:async()=>JSON.parse(JSON.stringify(value))};},...overrides};
 const runner=createCachedRunner({env,engine:actualEngine,model:controlModel,pool:marketPool,onUpdate:s=>updates.push(s),...runnerOptions});
 const input=extra=>({mode:'consensus',lookback:20,sampleSize:'120',minimumBreadth:.6,reference:{code:'000300.SH'},stocks:marketRows.slice(0,2),limits:options().limits,...extra});
 return {env,calls,updates,runner,input,setMetadata:v=>meta=v,setResult:v=>resultOverride=v,setDataset:v=>rawOverride=v};
}
test('all three cached modes use only same-origin artifacts, and120 does not silently shrink market or strength scope',async()=>{
 const s=cacheSetup();for(const mode of ['consensus','market','strength']){const result=await s.runner.run(s.input({mode}));assert.equal(result.status,'complete');assert.equal(result.records.length,mode==='consensus'?32:2);assert.equal(result.origin,'daily-cache');}
 const urls=s.calls.filter(c=>c.path.includes('/result?')).map(c=>new URL(c.path,'https://books.test'));assert.deepEqual(urls.map(u=>u.searchParams.get('sampleSize')),['120','all','all']);assert.ok(s.calls.every(c=>c.init.credentials==='same-origin'));
});
function dispersedResult(extra={}){
 const value=cachedResult(extra);value.consensus={...value.consensus,identified:false,commonCount:17,validCount:32,breadth:17/32,coverage:1};
 value.records.forEach((record,index)=>{record.result.matched=false;record.result.metrics.correlation=index<17?.8:.2;record.result.metrics.directionAgreement=.8;});return value;
}
test('stored consensus metrics expose observation candidates and reapply breadth without a request or mutating the cache',async()=>{
 const s=cacheSetup({}, {pool:{riskName:stock=>stock.code===marketRows[1].code}}),value=dispersedResult();value.records[0].result.metrics.periodReturn=40;const before=JSON.stringify(value);s.setResult(value);
 await s.runner.run(s.input());let state=s.runner.getState();assert.equal(state.records.filter(record=>record.result.candidateMatched).length,17);assert.equal(state.records.filter(record=>record.result.matched).length,0);assert.equal(state.records[0].result.excluded,true);assert.equal(state.records[1].result.eligible,false);
 const requests=s.calls.length;s.runner.reapply({minimumBreadth:.5});state=s.runner.getState();assert.equal(state.minimumBreadth,.5);assert.equal(state.records.filter(record=>record.result.matched).length,15);assert.equal(state.records[0].result.marketQualified,true);assert.equal(state.records[1].result.matched,false);assert.equal(s.calls.length,requests);assert.equal(JSON.stringify(value),before);
});
test('breadth reapply preserves the last successful failed or loading generation and the next generation reuses it',async()=>{
 const s=cacheSetup(),first=dispersedResult();s.setResult(first);await s.runner.run(s.input());const fetch=s.env.fetch;
 s.env.fetch=async()=>{throw Error('cache offline');};await s.runner.run(s.input());const requests=s.calls.length;s.runner.reapply({minimumBreadth:.5});assert.equal(s.calls.length,requests);assert.equal(s.runner.getState().cacheReadFailed,true);assert.equal(s.runner.getState().records.filter(record=>record.result.matched).length,17);
 s.env.fetch=fetch;s.setMetadata({available:true,scope:'full-market',lastSuccess:{generation:'daily-generation-2',day}});let release;s.env.fetch=async(path,init)=>path.includes('/result?')?{ok:true,json:()=>new Promise(resolve=>release=()=>resolve({...dispersedResult(),generation:'daily-generation-2'}))}:fetch(path,init);
 const pending=s.runner.refreshIfChanged();await settle();s.runner.reapply({minimumBreadth:.55});assert.equal(s.runner.getState().status,'running');assert.equal(s.runner.getState().generation,'daily-generation-1');assert.equal(s.runner.getState().minimumBreadth,.55);assert.equal(s.runner.getState().records.filter(record=>record.result.candidateMatched).length,17);release();await pending;
 assert.equal(s.runner.getState().generation,'daily-generation-2');assert.equal(s.runner.getState().minimumBreadth,.55);assert.equal(s.runner.getState().records.filter(record=>record.result.matched).length,0);
});
test('zero breadth cannot bypass missing consensus coverage',async()=>{
 const s=cacheSetup(),value=dispersedResult();value.consensus={...value.consensus,status:'unavailable',coverage:.79};s.setResult(value);await s.runner.run(s.input({minimumBreadth:0}));assert.ok(s.runner.getState().records.every(record=>record.result.candidateMatched===null&&record.result.matched===null));
});
test('a pinned historical summary with legacy period fields keeps its120-stock observation cohort',async()=>{
 const s=cacheSetup(),value=cachedResult({scope:'historical-sample'});value.consensus={requestedCount:120,validCount:120,coverage:1,commonCount:120,breadth:1,identified:true,period:{lookback:20,endAt:day}};s.setResult(value);
 await s.runner.run(s.input());assert.equal(s.runner.getState().consensus.day,day);assert.equal(s.runner.getState().consensus.lookback,20);assert.equal(s.runner.getState().records.filter(record=>record.result.candidateMatched).length,120);assert.equal(s.runner.getState().fullMarket,false);
});
test('existing mismatched consensus dates or periods are never normalized into valid cached candidates',async()=>{
 for(const mismatch of [{day:'2026-11-19'},{lookback:60}]){
  const s=cacheSetup(),value=cachedResult();value.consensus={...value.consensus,...mismatch};s.setResult(value);await s.runner.run(s.input({minimumBreadth:0}));const state=s.runner.getState();
  assert.ok(state.records.every(record=>record.result.candidateMatched===null&&record.result.matched===null));for(const [key,expected]of Object.entries(mismatch))assert.equal(state.consensus[key],expected);
 }
});
test('public full-market policy requests all while research configurations retain their sample size',async()=>{
 for(const sampleSize of ['120','240']){
  const publicPage=cacheSetup({}, {publicFullMarket:true});await publicPage.runner.run(publicPage.input({sampleSize}));
  let url=new URL(publicPage.calls.at(-1).path,'https://books.test');assert.equal(url.searchParams.get('sampleSize'),'all');assert.equal(publicPage.runner.getState().fullMarket,true);
  await publicPage.runner.loadDataset();url=new URL(publicPage.calls.at(-1).path,'https://books.test');assert.equal(url.searchParams.get('sampleSize'),'all');
  const research=cacheSetup();await research.runner.run(research.input({sampleSize}));url=new URL(research.calls.at(-1).path,'https://books.test');assert.equal(url.searchParams.get('sampleSize'),sampleSize);
 }
});
test('public effective sample keys isolate historical and full scopes and preserve desired settings across refresh and failures',async()=>{
 const s=cacheSetup({}, {publicFullMarket:true}),history=cachedResult({scope:'historical-sample'});
 const historical={available:true,scope:'historical-sample',fullMarket:false,lastSuccess:{generation:'daily-generation-1',day,scope:'historical-sample',sampleCount:120}};
 s.setMetadata(historical);s.setResult(history);await s.runner.run(s.input({sampleSize:'240'}));assert.equal(new URL(s.calls.at(-1).path,'https://books.test').searchParams.get('sampleSize'),'120');
 s.runner.reapply({sampleSize:'120',stocks:[]});assert.equal(s.runner.getState().records.length,120);
 const full={available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-1',day}};
 s.setMetadata(full);s.setResult(cachedResult({sampleSize:'all'}));await s.runner.refreshIfChanged();assert.equal(new URL(s.calls.at(-1).path,'https://books.test').searchParams.get('sampleSize'),'all');assert.equal(s.runner.getState().fullMarket,true);
 const fetch=s.env.fetch;s.env.fetch=async(path,init)=>path.includes('mode=strength')?{ok:false,json:async()=>({error:'新模式暂缺'})}:fetch(path,init);await s.runner.run(s.input({mode:'strength',sampleSize:'240'}));assert.equal(s.runner.getState().mode,'consensus');assert.equal(s.runner.getState().fullMarket,true);
 s.env.fetch=fetch;s.setMetadata({...full,lastSuccess:{generation:'daily-generation-2',day}});s.setResult({...cachedResult({mode:'strength',sampleSize:'all'}),generation:'daily-generation-2'});await s.runner.refreshIfChanged();const url=new URL(s.calls.at(-1).path,'https://books.test');assert.equal(url.searchParams.get('mode'),'strength');assert.equal(url.searchParams.get('sampleSize'),'all');
});
test('derived-only full results intersect explicit filters and never request a raw dataset',async()=>{
 const s=cacheSetup({}, {publicFullMarket:true}),result={...cachedResult({mode:'market',sampleSize:'all'}),sourceId:'tickflow-free',dataPolicy:{rawPublic:false,derivedPublic:true}},inside=result.records[0].stock,outside={code:'000001.SZ',name:'结果之外'};
 s.setResult(result);await s.runner.run(s.input({mode:'market',stocks:[inside,outside]}));assert.deepEqual(s.runner.getState().records.map(record=>record.stock.code),[inside.code]);assert.equal(s.runner.getState().scopeUncovered,0);
 const requests=s.calls.length;s.runner.reapply({stocks:null});assert.equal(s.runner.getState().records.length,32);s.runner.reapply({stocks:[]});assert.equal(s.runner.getState().records.length,0);assert.equal(s.runner.getExportStatus().available,false);await assert.rejects(()=>s.runner.loadDataset(),/不公开原始日线/);assert.equal(s.calls.length,requests);
});
test('heat caps reapply to cached baseline without a request or clipping raw metrics',async()=>{
 const s=cacheSetup(),base=cachedResult();base.records[0].result.metrics.periodReturn=43.76;s.setResult(base);await s.runner.run(s.input());const n=s.calls.length;
 assert.equal(s.runner.getState().records[0].result.excluded,true);s.runner.reapply({limits:{...options().limits,enabled:false}});assert.equal(s.runner.getState().records[0].result.matched,true);assert.equal(s.runner.getState().records[0].result.metrics.periodReturn,43.76);
 s.runner.reapply({limits:options().limits});assert.equal(s.runner.getState().records[0].result.excluded,true);assert.equal(s.calls.length,n);assert.equal(base.records[0].result.excluded,false);
});
test('cached consensus reference ignores local filters while market scopes retain unknown uncovered stocks',async()=>{
 const s=cacheSetup();await s.runner.run(s.input());const before=s.runner.getState().consensus.commonCount,n=s.calls.length;s.runner.reapply({stocks:[marketRows[0]]});assert.equal(s.runner.getState().records.length,32);assert.equal(s.runner.getState().consensus.commonCount,before);assert.equal(s.calls.length,n);
 await s.runner.run(s.input({mode:'market'}));const fetched=s.calls.length;s.runner.reapply({stocks:[marketRows[1],{code:'830001.BJ',name:'未覆盖'}]});const state=s.runner.getState();assert.equal(state.status,'unavailable');assert.equal(state.scopeUncovered,1);assert.equal(state.records.length,2);assert.equal(state.records[1].result.matched,null);assert.match(state.reason,/未被本批日终缓存覆盖/);assert.equal(s.calls.length,fetched);await assert.rejects(()=>s.runner.loadDataset(),/缓存之外/);
});
test('historical market and strength scopes intersect the120-stock archive without inventing uncovered rows',async()=>{
 for(const mode of ['market','strength']){
  const s=cacheSetup(),history=cachedResult({mode,scope:'historical-sample'}),inside=history.records[5].stock,outside={code:'000001.SZ',name:'样本之外'};
  s.setResult(history);
  const result=await s.runner.run(s.input({mode,stocks:[inside,outside]}));
  assert.deepEqual(result.records.map(r=>r.stock.code),[inside.code]);assert.equal(result.scopeUncovered,0);assert.equal(result.scope,'historical-sample');assert.equal(result.sampleCount,120);assert.equal(result.marketUniverseCount,3052);assert.equal(result.fullMarket,false);
  const requests=s.calls.length;
  s.runner.reapply({stocks:null});assert.equal(s.runner.getState().records.length,120);
  s.runner.reapply({stocks:[]});assert.equal(s.runner.getState().records.length,0);
  s.runner.reapply({stocks:[outside]});assert.equal(s.runner.getState().records.length,0);assert.equal(s.runner.getState().scopeUncovered,0);
  assert.equal(s.calls.length,requests);assert.equal(history.records.length,120);
 }
});
test('historical consensus retains its fixed120 samples despite a local empty or unrelated filter',async()=>{
 const s=cacheSetup();s.setResult(cachedResult({scope:'historical-sample'}));await s.runner.run(s.input({stocks:[]}));assert.equal(s.runner.getState().records.length,120);
 const requests=s.calls.length;s.runner.reapply({stocks:[{code:'000001.SZ',name:'样本之外'}]});assert.equal(s.runner.getState().records.length,120);assert.equal(s.runner.getState().marketUniverseCount,3052);assert.equal(s.runner.getState().fullMarket,false);assert.equal(s.calls.length,requests);
});
test('historical raw export keeps120 requested records and the original3052-stock universe',async()=>{
 const s=cacheSetup();s.setResult(cachedResult({mode:'market',scope:'historical-sample'}));s.setDataset(dataset('000300.SH',120,3052));await s.runner.run(s.input({mode:'market',stocks:null}));
 await s.runner.loadDataset();const raw=s.runner.exportDataset();assert.equal(raw.expectedCount,120);assert.equal(raw.records.length,120);assert.equal(raw.totalUniverseCount,3052);assert.equal(raw.universe.length,3052);assert.equal(s.runner.getState().fullMarket,false);
});
test('raw dataset is lazy, generation-pinned, reused and independently exportable',async()=>{
 const s=cacheSetup();await s.runner.run(s.input());assert.equal(s.calls.length,2);assert.equal(s.runner.getExportStatus().available,false);assert.equal(s.runner.exportDataset(),null);
 await s.runner.loadDataset();assert.equal(s.calls.length,3);const url=new URL(s.calls.at(-1).path,'https://books.test');assert.equal(url.searchParams.get('generation'),'daily-generation-1');assert.equal(url.searchParams.get('sampleSize'),'120');assert.equal(s.runner.getExportStatus().available,true);
 const data=s.runner.exportDataset();data.records[0].source.bars[0].close=-1;assert.ok(s.runner.exportDataset().records[0].source.bars[0].close>0);await s.runner.loadDataset();assert.equal(s.calls.length,3);
});
test('cached exports reject a raw artifact from a different source snapshot',async()=>{
 const s=cacheSetup();await s.runner.run(s.input());s.setDataset({...dataset(),asOf:'2026-11-20T09:00:00Z'});await assert.rejects(()=>s.runner.loadDataset(),/当前显示批次不一致/);assert.equal(s.runner.getExportStatus().available,false);assert.equal(s.runner.exportDataset(),null);
});
test('cancelling a cached read discards a late result and never resumes upstream collection',async()=>{
 let release;const s=cacheSetup(),fetch=s.env.fetch;s.env.fetch=async(path,init)=>path.includes('/result?')?{ok:true,json:()=>new Promise(resolve=>release=()=>resolve(cachedResult()))}:fetch(path,init);
 const pending=s.runner.run(s.input());await new Promise(setImmediate);assert.ok(release);s.runner.cancel('手动停止');release();await pending;assert.equal(s.runner.getState().status,'stopped');assert.equal(s.runner.getState().records.length,0);assert.equal(s.runner.getExportStatus().available,false);
});
test('missing completed caches stay empty and retain last successful completion time',async()=>{
 const s=cacheSetup();s.setMetadata({available:false,lastSuccess:{generation:'old',day,finishedAt:fetchedAt},attempt:{status:'failed',error:'来源429，后台已停止'}});const result=await s.runner.run(s.input());assert.equal(result.status,'unavailable');assert.equal(result.records.length,0);assert.equal(result.lastSuccess.finishedAt,fetchedAt);assert.match(result.reason,/429/);assert.equal(s.calls.length,1);
});
test('precomputed mode mismatch cannot be shown as a completed result',async()=>{
 const s=cacheSetup();s.setResult(cachedResult({mode:'market'}));const result=await s.runner.run(s.input());assert.equal(result.status,'unavailable');assert.equal(result.records.length,0);assert.match(result.reason,/模式、周期/);
});
test('result reads pin metadata generation and reject a response from a different completed generation',async()=>{
 const s=cacheSetup();s.setResult({...cachedResult(),generation:'new-pointer-during-fetch'});const result=await s.runner.run(s.input());assert.equal(result.status,'unavailable');assert.equal(result.records.length,0);const url=new URL(s.calls.at(-1).path,'https://books.test');assert.equal(url.searchParams.get('generation'),'daily-generation-1');
});
test('failed mode changes preserve the previous labeled results and raw archive without claiming the new mode completed',async()=>{
 const s=cacheSetup();await s.runner.run(s.input());await s.runner.loadDataset();const fetch=s.env.fetch;s.env.fetch=async(path,init)=>path.includes('mode=strength')?{ok:false,json:async()=>({error:'该模式缓存缺失'})}:fetch(path,init);
 const result=await s.runner.run(s.input({mode:'strength'}));assert.equal(result.status,'unavailable');assert.equal(result.mode,'consensus');assert.equal(result.attemptedMode,'strength');assert.equal(result.records.length,32);assert.match(result.reason,/初期转强.*失败.*保留市场共同走势/);assert.equal(s.runner.getExportStatus().available,true);assert.equal(s.runner.exportDataset().day,day);
});
test('same-generation cached modes are reused but a new generation loads new completed artifacts',async()=>{
 const s=cacheSetup();await s.runner.run(s.input());await s.runner.run(s.input());assert.equal(s.calls.filter(c=>c.path.includes('/result?')).length,1);s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-2',day,finishedAt:fetchedAt}});s.setResult({...cachedResult(),generation:'daily-generation-2'});await s.runner.run(s.input());assert.equal(s.calls.filter(c=>c.path.includes('/result?')).length,2);assert.equal(s.runner.getState().generation,'daily-generation-2');
});
test('an initially unavailable page automatically gains its first completed generation without another state download',async()=>{
 const s=cacheSetup();s.setMetadata({available:false,attempt:{status:'running',checked:10,total:32}});await s.runner.run(s.input());assert.equal(s.runner.getState().status,'unavailable');
 s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-1',day,asOf,finishedAt:fetchedAt},attempt:{status:'complete'}});await s.runner.refreshIfChanged();assert.equal(s.runner.getState().status,'complete');assert.equal(s.runner.getState().records.length,32);assert.equal(s.calls.length,3);assert.equal(s.calls.filter(c=>c.path.includes('/result?')).length,1);
});
test('same-generation polling only updates job progress while generation changes retain local settings and scope',async()=>{
 const s=cacheSetup();await s.runner.run(s.input({mode:'market'}));s.runner.reapply({stocks:[marketRows[2]],limits:{...options().limits,maxReturn20:1}});const resultReads=()=>s.calls.filter(c=>c.path.includes('/result?')).length;
 s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-1',day,finishedAt:fetchedAt},attempt:{status:'running',checked:100,total:3052}});await s.runner.refreshIfChanged();assert.equal(resultReads(),1);assert.equal(s.runner.getState().attempt.checked,100);
 s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-2',day,finishedAt:fetchedAt},attempt:{status:'complete'}});s.setResult({...cachedResult({mode:'market'}),generation:'daily-generation-2'});await s.runner.refreshIfChanged();const state=s.runner.getState();assert.equal(resultReads(),2);assert.equal(state.mode,'market');assert.equal(state.limits.maxReturn20,1);assert.deepEqual(state.records.map(r=>r.stock.code),[marketRows[2].code]);assert.equal(state.records[0].result.excluded,true);
});
test('a late polling response cannot replace a newer explicit mode selection',async()=>{
 const s=cacheSetup();await s.runner.run(s.input());const fetch=s.env.fetch;let release;s.env.fetch=async(path,init)=>path.endsWith('/state')?{ok:true,json:()=>new Promise(resolve=>release=()=>resolve({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'stale-generation'}}))}:fetch(path,init);
 const poll=s.runner.refreshIfChanged();await new Promise(setImmediate);s.env.fetch=fetch;await s.runner.run(s.input({mode:'market'}));release();await poll;assert.equal(s.runner.getState().mode,'market');assert.equal(s.runner.getState().generation,'daily-generation-1');
});
test('after a failed parameter read the next completed generation uses the requested period rather than the retained old result period',async()=>{
 const s=cacheSetup();await s.runner.run(s.input());const fetch=s.env.fetch;s.env.fetch=async(path,init)=>path.includes('lookback=60')?{ok:false,json:async()=>({error:'60日缓存暂不可用'})}:fetch(path,init);await s.runner.run(s.input({lookback:60}));assert.equal(s.runner.getState().lookback,20);
 s.env.fetch=fetch;s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-2',day,finishedAt:fetchedAt}});s.setResult({...cachedResult({lookback:60}),generation:'daily-generation-2'});await s.runner.refreshIfChanged();assert.equal(s.runner.getState().lookback,60);assert.equal(s.runner.getState().generation,'daily-generation-2');
});
class Target{
 constructor(){this.events={};}
 addEventListener(type,handler){(this.events[type]??=[]).push(handler);}
 removeEventListener(type,handler){this.events[type]=(this.events[type]||[]).filter(fn=>fn!==handler);}
 dispatchEvent(event){for(const handler of this.events[event.type]||[])handler(event);}
}
class Element extends Target{
 constructor(tag='div'){super();this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.own='';this.parentNode=null;this.hidden=false;}
 set textContent(value){this.own=String(value);for(const child of this.children)child.parentNode=null;this.children=[];}
 get textContent(){return this.own+this.children.map(child=>child.textContent).join('');}
 set innerHTML(_){throw Error('unsafe HTML');}
 append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
 insertBefore(node,before){if(node===before)return;node.remove();const index=before?this.children.indexOf(before):this.children.length;this.children.splice(index,0,node);node.parentNode=this;}
 remove(){if(this.parentNode){const items=this.parentNode.children;items.splice(items.indexOf(this),1);this.parentNode=null;}}
 replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this.own='';this.append(...nodes);}
 setAttribute(key,value){this.attrs[key]=String(value);}
 querySelectorAll(selector){const key=selector.slice(1,-1).replace(/^data-/,'').replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());return this.children.filter(node=>node.dataset[key]!==undefined);}
}
function dom(){
 const env=new Target(),ids={},doc={defaultView:env,getElementById:id=>ids[id],createElement:tag=>new Element(tag)};
 env.setInterval=setInterval;env.clearInterval=clearInterval;
 env.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options.detail;}};
 for(const id of ['trend-screen','trend-lookback','trend-pattern','trend-display','trend-breadth','trend-consensus-controls','trend-qualified-only','trend-consensus-status','trend-status','trend-count','trend-results','trend-pagination','trend-prev','trend-next','trend-page','trend-direction-controls','trend-direction-settings','trend-strength-controls','trend-heat-enabled','trend-settings-error','trend-reset-settings','trend-strategy-status','trend-peer-enabled','trend-peer-status'])ids[id]=new Element();
 for(const mode of ['consensus','market','strength']){const button=new Element('button');button.dataset.trendMode=mode;ids['trend-screen'].append(button);}
 for(const direction of ['up','down','sideways','all']){const button=new Element('button');button.dataset.trendDirection=direction;ids['trend-screen'].append(button);}
 for(const [data,keys]of Object.entries({trendDirectionRule:['minimumReturnPercent','maximumSidewaysRangePercent'],trendStrength:['crossWithinDays','minReturn5'],trendPeer:['groupTopPercent','minPeers','minExcessReturn','minRecentExcess','minImprovement','minDownsideExcess','maxSupportDistance','minResistanceSpace','sectorTopPercent'],trendLimit:['maxReturn20','maxReturn60','maxReturn5','maxDeviation','maxVolumeRatio'],trendPatternParam:['nearPct','rangePct','crossWindow','pullbackMinPct','pullbackMaxPct','volumeExpandRatio','volumeContractRatio']}))for(const key of keys){const field=new Element('input');field.dataset[data]=key;ids['trend-screen'].append(field);}
 ids['trend-lookback'].value='20';return {env,ids,doc};
}
function chartSpy(){
 const observed=[],disposed=[];let destroyed=0;
 const api={create:()=>({observe(host,stock){observed.push({host,stock});host.append(new Element('iframe'));},dispose(host){disposed.push(host);host.replaceChildren();},destroy(){destroyed++;}})};
 return {api,observed,disposed,get destroyed(){return destroyed;}};
}
const context=(rows=marketRows)=>({day,asOf,rows,pageRows:rows.slice(0,20),savedRows:rows.slice(0,2),allRows:marketRows,marketRows});
function mounted(extra={},storage){
 const d=dom(),s=cacheSetup(),charts=chartSpy();d.env.fetch=s.env.fetch;if(storage)d.env.localStorage=storage;
 const app=mount(d.doc,{selection:{getContext:()=>context()},engine:actualEngine,model:controlModel,pool:marketPool,patterns:actualPatterns,charts:charts.api,configuration:controlModel.DEFAULT_CONFIG,autoLoad:false,...extra});
 return {...s,...d,charts,app};
}
const articles=s=>s.ids['trend-results'].children.filter(node=>node.tagName==='article');
const patternDetails=article=>article.children.find(node=>node.className==='trend-stock-patterns');
test('the frozen compact DOM automatically loads all cached result cards without old parameter nodes',async()=>{
 const d=dom(),s=cacheSetup(),charts=chartSpy();d.env.fetch=s.env.fetch;d.env.BooksTechnicalScreen={sourceState:()=>({status:'restricted',reason:'旧来源停止'}),history:()=>{throw Error('must not request upstream');}};
 const app=mount(d.doc,{selection:{getContext:()=>context()},engine:actualEngine,model:controlModel,charts:charts.api,configuration:controlModel.DEFAULT_CONFIG});await settle();
 assert.equal(app.getState().status,'complete');assert.equal(articles(d).length,32);assert.equal(charts.observed.length,32);assert.equal(d.ids['trend-status'].textContent,'沪深主板 32只 · 数据日2026-11-20');assert.equal(d.ids['trend-count'].textContent,'32 只');
 const item=articles(d)[0];assert.equal(item.className,'trend-stock');assert.equal(item.attrs.role,'listitem');assert.match(item.children[0].children[0].children[0].href,/\.\.\/chart\.html\?tvwidgetsymbol=SSE%3A/);assert.doesNotMatch(item.textContent,/HTTP|回撤|复算|盈亏|请求/);assert.equal(new URL(s.calls.at(-1).path,'https://books.test').searchParams.get('sampleSize'),'all');app.destroy();
});
test('no completed generation shows one short empty sentence and never turns430 partial histories into cards',async()=>{
 const s=mounted();s.setMetadata({available:false,attempt:{status:'failed',checked:430,ready:430,total:3052,error:'HTTP501 上游已暂停'}});await s.app.start('consensus');
 assert.equal(s.ids['trend-results'].textContent,'暂无已完成的筛选结果');assert.equal(s.ids['trend-status'].textContent,'');assert.equal(s.ids['trend-count'].textContent,'');assert.equal(s.ids['trend-pagination'].hidden,true);assert.equal(s.charts.observed.length,0);assert.equal(s.calls.length,1);s.app.destroy();
});
test('cards only contain ready numeric candidates and zero candidates have their own short empty state',async()=>{
 const s=mounted(),result=cachedResult();for(const record of result.records)record.result.metrics.correlation=.1;s.setResult(result);await s.app.start('consensus');assert.equal(articles(s).length,0);assert.equal(s.ids['trend-results'].textContent,'没有符合条件的股票');assert.equal(s.ids['trend-count'].textContent,'0 只');s.app.destroy();
 const filtered=mounted(),base=cachedResult();base.records[0].result.metrics.correlation=.1;base.records[1].result={status:'unavailable',matched:null,reason:'HTTP测试不回显'};filtered.setResult(base);await filtered.app.start('consensus');assert.equal(articles(filtered)[0].dataset.code,marketRows[2].code);assert.equal(filtered.ids['trend-count'].textContent,'30 只');filtered.app.destroy();
});
test('four-card pagination disposes leaving hosts and observes only new current-page hosts',async()=>{
 const s=mounted();s.ids['trend-display'].value='4';s.ids['trend-display'].dispatchEvent({type:'change'});await s.app.start('consensus');const first=articles(s).map(node=>node.dataset.code);assert.equal(s.ids['trend-page'].textContent,'1 / 8');s.ids['trend-next'].dispatchEvent({type:'click'});
 assert.equal(articles(s).length,4);assert.equal(s.charts.disposed.length,4);assert.equal(s.charts.observed.length,8);assert.equal(s.ids['trend-page'].textContent,'2 / 8');assert.ok(articles(s).every(node=>!first.includes(node.dataset.code)));s.app.destroy();
});
test('ordinary renders and same-generation progress polling keep chart hosts and frames intact',async()=>{
 const s=mounted();await s.app.start('consensus');const nodes=articles(s).slice(),frames=s.charts.observed.map(item=>item.host.children[0]);s.app.render();s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-1',day,finishedAt:fetchedAt},attempt:{status:'running',checked:430,total:3052}});await s.app.runner.refreshIfChanged();
 assert.deepEqual(articles(s),nodes);assert.equal(s.charts.observed.length,32);assert.equal(s.charts.disposed.length,0);assert.deepEqual(s.charts.observed.map(item=>item.host.children[0]),frames);assert.doesNotMatch(s.ids['trend-status'].textContent,/430|3052|请求/);s.app.destroy();
});
test('a new generation with the same selected codes updates data without reloading current charts',async()=>{
 const s=mounted();await s.app.start('consensus');const nodes=articles(s).slice();s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-2',day,finishedAt:fetchedAt}});s.setResult({...cachedResult(),generation:'daily-generation-2'});await s.app.runner.refreshIfChanged();assert.deepEqual(articles(s),nodes);assert.equal(s.charts.observed.length,32);assert.equal(s.charts.disposed.length,0);s.app.destroy();
});
test('no prepared context uses cached full market while a prepared empty filter must stay empty',async()=>{
 const full=mounted({selection:{getContext:()=>({day:'',rows:[]})}});await full.app.start('market');assert.equal(full.app.getState().records.length,32);assert.equal(articles(full).length,32);full.app.destroy();
 const empty=mounted({selection:{getContext:()=>context([])}});await empty.app.start('market');assert.equal(empty.app.getState().records.length,0);assert.equal(articles(empty).length,0);assert.equal(empty.ids['trend-results'].textContent,'没有符合条件的股票');empty.app.destroy();
});
test('existing selection changes update local cards without source calls or hidden scope parameters',async()=>{
 let current=context();const s=mounted({selection:{getContext:()=>current}});await s.app.start('market');const calls=s.calls.length;current=context([marketRows[5]]);s.env.dispatchEvent({type:'books:selection-changed'});assert.deepEqual(articles(s).map(node=>node.dataset.code),[marketRows[5].code]);assert.equal(s.calls.length,calls);s.app.destroy();
});
test('inactive filters use the whole completed result and flag-only changes reapply the explicit intersection',async()=>{
 let current={...context([marketRows[0]]),filtersActive:false};const s=mounted({selection:{getContext:()=>current}});
 s.setResult({...cachedResult({mode:'market',sampleSize:'all'}),sourceId:'tickflow-free',dataPolicy:{rawPublic:false,derivedPublic:true}});await s.app.start('market');assert.equal(s.app.getState().records.length,32);assert.equal(s.ids['trend-count'].textContent,'32 只');const requests=s.calls.length;
 current={...current,filtersActive:true};s.env.dispatchEvent({type:'books:selection-changed'});assert.deepEqual(s.app.getState().records.map(record=>record.stock.code),[marketRows[0].code]);
 current={...current,rows:[]};s.env.dispatchEvent({type:'books:selection-changed'});assert.equal(s.app.getState().records.length,0);
 current={...current,filtersActive:false};s.env.dispatchEvent({type:'books:selection-changed'});assert.equal(s.app.getState().records.length,32);assert.equal(s.calls.length,requests);s.app.destroy();
});
test('a failed different-mode request keeps old state for diagnostics but never shows it under the new tab',async()=>{
 const s=mounted();await s.app.start('consensus');const fetch=s.env.fetch;s.env.fetch=async(path,init)=>path.includes('mode=strength')?{ok:false,json:async()=>({error:'HTTP501 诊断'})}:fetch(path,init);await s.app.start('strength');assert.equal(s.app.getState().mode,'consensus');assert.equal(articles(s).length,0);assert.equal(s.ids['trend-results'].textContent,'暂无已完成的筛选结果');assert.equal(s.ids['trend-status'].textContent,'');assert.equal(s.charts.disposed.length,32);s.app.destroy();
});
test('the selected period must match result state before any cards can be displayed',async()=>{
 const s=mounted();await s.app.start('consensus');const fetch=s.env.fetch;s.env.fetch=async(path,init)=>path.includes('lookback=60')?{ok:false,json:async()=>({error:'60日未就绪'})}:fetch(path,init);s.ids['trend-lookback'].value='60';s.ids['trend-lookback'].dispatchEvent({type:'change'});await settle();assert.equal(s.app.getState().lookback,20);assert.equal(articles(s).length,0);assert.equal(s.ids['trend-results'].textContent,'暂无已完成的筛选结果');s.app.destroy();
});
test('same-mode cache failures retain matching cards with only a short previous-success marker',async()=>{
 const s=mounted();await s.app.start('consensus');const nodes=articles(s).slice();s.env.fetch=async()=>{throw Error('HTTP501 private diagnostic');};await s.app.start('consensus');assert.deepEqual(articles(s),nodes);assert.equal(s.ids['trend-status'].textContent,'沪深主板 32只 · 数据日'+day);assert.doesNotMatch(s.ids['trend-results'].textContent,/HTTP501/);s.app.destroy();
});
test('historical cards retain their sample label and count during same-mode loading and failure',async()=>{
 const s=mounted({selection:{getContext:()=>({day:'',rows:[]})}});s.setResult(cachedResult({scope:'historical-sample'}));s.setMetadata({available:true,scope:'historical-sample',sampleCount:120,marketUniverseCount:3052,fullMarket:false,lastSuccess:{generation:'daily-generation-1',day,scope:'historical-sample',sampleCount:120},attempt:{status:'failed',error:'HTTP501 全量未完成'}});
 await s.app.start('consensus');const nodes=articles(s).slice(),label='历史120只样本 · 数据日2026-11-20';assert.equal(s.ids['trend-status'].textContent,label);assert.equal(s.ids['trend-count'].textContent,'120 只');assert.equal(s.app.getState().fullMarket,false);
 s.env.fetch=async()=>{throw Error('HTTP501 private diagnostic');};const pending=s.app.start('consensus');assert.equal(s.ids['trend-status'].textContent,label);assert.equal(s.ids['trend-count'].textContent,'120 只');assert.deepEqual(articles(s),nodes);
 await pending;assert.equal(s.ids['trend-status'].textContent,label);assert.deepEqual(articles(s),nodes);assert.equal(s.app.getState().scope,'historical-sample');assert.doesNotMatch(s.ids['trend-status'].textContent,/HTTP|3052|全量/);s.app.destroy();
});
test('historical selection changes filter only archived stocks without changing the sample scope',async()=>{
 const history=cachedResult({mode:'market',scope:'historical-sample'}),first=history.records[0].stock,second=history.records[1].stock;let current=context([first,{code:'000001.SZ',name:'样本之外'}]);
 const s=mounted({selection:{getContext:()=>current}});s.setMetadata({available:true,scope:'historical-sample',fullMarket:false,lastSuccess:{generation:'daily-generation-1',day}});s.setResult(history);await s.app.start('market');assert.deepEqual(articles(s).map(node=>node.dataset.code),[first.code]);assert.equal(s.ids['trend-status'].textContent,'历史120只样本 · 数据日2026-11-20');const requests=s.calls.length;
 current=context([]);s.env.dispatchEvent({type:'books:selection-changed'});assert.equal(articles(s).length,0);assert.equal(s.ids['trend-count'].textContent,'0 只');
 current=context([second]);s.env.dispatchEvent({type:'books:selection-changed'});assert.deepEqual(articles(s).map(node=>node.dataset.code),[second.code]);assert.equal(s.app.getState().sampleCount,120);assert.equal(s.calls.length,requests);s.app.destroy();
});
test('historical generations do not refresh the market roster and a future full generation resumes normal refresh',async()=>{
 const s=mounted({selection:{getContext:()=>({day:'',rows:[]})}}),events=[];s.env.addEventListener('books:refresh-selection',event=>events.push(event.detail.generation));s.setMetadata({available:true,scope:'historical-sample',fullMarket:false,lastSuccess:{generation:'daily-generation-1',day}});s.setResult(cachedResult({scope:'historical-sample'}));
 await s.app.start('consensus');assert.deepEqual(events,[]);await s.app.runner.refreshIfChanged();assert.deepEqual(events,[]);assert.equal(s.app.getState().scope,'historical-sample');assert.equal(s.ids['trend-status'].textContent,'历史120只样本 · 数据日2026-11-20');
 s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-2',day,finishedAt:fetchedAt},attempt:{status:'complete'}});s.setResult({...cachedResult({sampleSize:'all'}),generation:'daily-generation-2'});await s.app.runner.refreshIfChanged();
 assert.deepEqual(events,['daily-generation-2']);assert.equal(s.app.getState().scope,undefined);assert.equal(s.app.getState().fullMarket,true);assert.equal(s.ids['trend-status'].textContent,'沪深主板 32只 · 数据日2026-11-20');assert.equal(s.ids['trend-count'].textContent,'32 只');s.app.destroy();
});
test('derived-only generations show full roster counts and never dispatch a raw-market refresh',async()=>{
 const s=mounted({selection:{getContext:()=>({...context([]),filtersActive:false})}}),events=[];s.env.addEventListener('books:refresh-selection',event=>events.push(event.detail.generation));
 const result={...cachedResult({sampleSize:'all'}),marketUniverseCount:3194,sourceId:'tickflow-free',dataPolicy:{rawPublic:false,derivedPublic:true}};s.setResult(result);await s.app.start('consensus');assert.equal(new URL(s.calls.at(-1).path,'https://books.test').searchParams.get('sampleSize'),'all');assert.equal(s.ids['trend-status'].textContent,'沪深主板 3194只 · 数据日2026-11-20');assert.deepEqual(events,[]);
 s.setMetadata({available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:'daily-generation-2',day,sourceId:'tickflow-free',dataPolicy:{rawPublic:false,derivedPublic:true}}});s.setResult({...result,generation:'daily-generation-2'});await s.app.runner.refreshIfChanged();assert.deepEqual(events,[]);assert.equal(s.ids['trend-status'].textContent,'沪深主板 3194只 · 数据日2026-11-20');s.app.destroy();
});
test('unified configuration applies once before hand-selection and preserves raw export APIs',async()=>{
 const s=mounted(),config={module:'a-share-consensus',name:'服务器方案',settings:{...controlModel.DEFAULT_CONFIG.settings,mode:'market',sampleSize:'240',benchmark:'399001.SZ',limits:{...options().limits,maxReturn20:1}}};assert.equal(s.app.applyConfiguration(config),true);await settle();assert.equal(s.app.getState().mode,'market');assert.equal(s.app.getState().reference.code,'399001.SZ');assert.equal(s.app.getState().limits.maxReturn20,1);assert.equal(s.app.applyConfiguration(controlModel.DEFAULT_CONFIG),false);await s.app.loadDataset();assert.equal(s.app.getExportStatus().available,true);assert.equal(s.app.exportDataset().reference.code,'399001.SZ');s.app.destroy();
});
test('late admin defaults merge unedited fields without overriding a clicked mode or user-selected period',async()=>{
 for(const choose of ['mode','period']){const s=mounted();if(choose==='mode')s.ids['trend-screen'].children.find(button=>button.dataset.trendMode==='market').dispatchEvent({type:'click'});else{s.ids['trend-lookback'].value='60';s.ids['trend-lookback'].dispatchEvent({type:'change'});}assert.equal(s.app.applyConfiguration(controlModel.DEFAULT_CONFIG),true);await settle();assert.equal(s.app.getState()[choose==='mode'?'mode':'lookback'],choose==='mode'?'market':60);s.app.destroy();}
});
test('mounted polling remains visibility-aware, emits generation refreshes once and cleans every lifecycle owner',async()=>{
 const d=dom(),s=cacheSetup(),charts=chartSpy(),cleared=[],events=[];d.env.fetch=s.env.fetch;let tick;d.env.setInterval=(fn,ms)=>{assert.equal(ms,60000);tick=fn;return 9;};d.env.clearInterval=id=>cleared.push(id);d.env.addEventListener('books:refresh-selection',event=>events.push(event.detail.generation));
 const app=mount(d.doc,{selection:{getContext:()=>context()},engine:actualEngine,model:controlModel,charts:charts.api,autoLoad:false});await app.start('consensus');const before=s.calls.length;d.doc.hidden=true;tick();await settle();assert.equal(s.calls.length,before);d.doc.hidden=false;tick();await settle();assert.equal(s.calls.length,before+1);assert.deepEqual(events,['daily-generation-1']);d.env.dispatchEvent({type:'pagehide'});app.destroy();assert.deepEqual(cleared,[9]);assert.equal(charts.destroyed,1);
});
test('back-forward cache preserves charts and controls while explicit destroy still cleans resources',async()=>{
 const d=dom(),s=cacheSetup(),charts=chartSpy(),cleared=[];d.env.fetch=s.env.fetch;d.env.setInterval=()=>17;d.env.clearInterval=id=>cleared.push(id);
 const app=mount(d.doc,{selection:{getContext:()=>context()},engine:actualEngine,model:controlModel,charts:charts.api,configuration:controlModel.DEFAULT_CONFIG,autoLoad:false});await app.start('consensus');const nodes=articles(d).slice();
 d.env.dispatchEvent({type:'pagehide',persisted:true});assert.equal(charts.destroyed,0);assert.deepEqual(cleared,[]);assert.deepEqual(articles(d),nodes);
 d.env.dispatchEvent({type:'pageshow',persisted:true});d.ids['trend-screen'].children.find(button=>button.dataset.trendMode==='market').dispatchEvent({type:'click'});await settle();assert.equal(app.getState().mode,'market');assert.equal(app.getState().status,'complete');assert.equal(articles(d).length,32);assert.equal(charts.destroyed,0);
 app.destroy();assert.equal(charts.destroyed,1);assert.deepEqual(cleared,[17]);
});
test('browser mounting announces the app only after assigning its public instance',async()=>{
 const vm=require('node:vm'),fs=require('node:fs'),d=dom(),s=cacheSetup(),charts=chartSpy(),seen=[];Object.assign(d.env,{document:d.doc,fetch:s.env.fetch,BooksTrendScreen:actualEngine,BooksControlModel:{...controlModel,normalizeConfig:value=>controlModel.normalizeConfig(value===undefined?undefined:JSON.parse(JSON.stringify(value)))},BooksMarketPool:marketPool,BooksTrendPatterns:actualPatterns,BooksStockCharts:charts.api,BooksStockSelection:{getContext:()=>context()},AbortController,URLSearchParams,Event:class{constructor(type){this.type=type;}}});d.env.addEventListener('books:trend-mounted',()=>seen.push(d.env.BooksTrendControllerApp));vm.runInNewContext(fs.readFileSync(require.resolve('../screening/trend-controller.js'),'utf8'),d.env);assert.equal(seen.length,1);assert.equal(seen[0],d.env.BooksTrendControllerApp);await settle();assert.equal(d.env.BooksTrendControllerApp.getState().status,'complete');d.env.BooksTrendControllerApp.destroy();
});
test('early-turn sorting favors lower extension, not the largest period gain, and does not mutate input',()=>{
 const row=(code,matched,excluded,metrics)=>({stock:{code},result:{status:'ready',matched,excluded,metrics}}),records=[row('hot',false,true,{periodReturn:99,ma20Deviation:30}),row('raised',true,false,{periodReturn:14,ma20Deviation:7,correlation:.7}),row('early',true,false,{periodReturn:2,ma20Deviation:1,correlation:.9})];
 assert.deepEqual(sortRecords(records,'strength').map(r=>r.stock.code),['early','raised','hot']);assert.deepEqual(sortRecords(records,'consensus').map(r=>r.stock.code),['early','raised','hot']);assert.equal(records[0].stock.code,'hot');
});

const patternDefinition={id:'volume-contract',label:'缩量',group:'量价',rule:'近5日均量不超过此前20日均量的0.8倍'};
function patternFor(lookback,contract=true){
 const values=bars();values.forEach((bar,index)=>bar.volume=index>=values.length-5&&contract?700:1000);
 return actualPatterns.classify({bars:values,calendar:values,day,lookback});
}
function withPatterns(result){
 result.patternVersion=actualPatterns.version;result.patternDefinitions=actualPatterns.definitionsFor();
 result.records.forEach((record,index)=>record.patterns=patternFor(result.lookback,index<3));
 return result;
}
test('all display retains every stock, while20 and4 use local pages without another request',async()=>{
 const s=mounted();await s.app.start('consensus');const requests=s.calls.length;
 assert.equal(s.ids['trend-display'].value,'all');assert.equal(articles(s).length,32);assert.equal(s.ids['trend-pagination'].hidden,true);
 s.ids['trend-display'].value='20';s.ids['trend-display'].dispatchEvent({type:'change'});assert.equal(articles(s).length,20);assert.equal(s.ids['trend-page'].textContent,'1 / 2');
 s.ids['trend-next'].dispatchEvent({type:'click'});assert.equal(articles(s).length,12);
 s.ids['trend-display'].value='all';s.ids['trend-display'].dispatchEvent({type:'change'});assert.equal(articles(s).length,32);assert.equal(s.ids['trend-pagination'].hidden,true);assert.equal(s.calls.length,requests);s.app.destroy();
});
test('uniform multi-label filtering uses same-day same-window versioned artifacts and is local',async()=>{
 const s=mounted(),result=withPatterns(cachedResult());
 result.records[1].patterns.day='2026-11-19';result.records[2].patterns.lookback=60;
 s.setResult(result);await s.app.start('consensus');const requests=s.calls.length;
 const item=articles(s)[0];assert.equal(patternDetails(item).hidden,false);assert.match(patternDetails(item).textContent,/缩量.*0.70/);
 assert.equal(patternDetails(articles(s)[1]).hidden,true);assert.equal(patternDetails(articles(s)[2]).hidden,true);
 s.ids['trend-pattern'].value='volume-contract';s.ids['trend-pattern'].dispatchEvent({type:'change'});
 assert.deepEqual(articles(s).map(node=>node.dataset.code),[result.records[0].stock.code]);assert.equal(s.ids['trend-count'].textContent,'1 只');assert.equal(s.calls.length,requests);
 s.ids['trend-pattern'].value='';s.ids['trend-pattern'].dispatchEvent({type:'change'});assert.equal(articles(s).length,32);assert.equal(s.calls.length,requests);s.app.destroy();
});
test('pattern filter survives the loading state and switches to the new generation labels',async()=>{
 const s=mounted();s.setResult(withPatterns(cachedResult()));await s.app.start('consensus');
 s.ids['trend-pattern'].value='volume-contract';s.ids['trend-pattern'].dispatchEvent({type:'change'});assert.equal(articles(s).length,3);
 s.setMetadata({available:true,scope:'full-market',lastSuccess:{generation:'daily-generation-2',day}});
 const next=withPatterns({...cachedResult(),generation:'daily-generation-2'});next.records[0].patterns=patternFor(next.lookback,false);s.setResult(next);await s.app.runner.refreshIfChanged();
 assert.equal(s.ids['trend-pattern'].value,'volume-contract');assert.equal(articles(s).length,2);assert.equal(s.app.getState().generation,'daily-generation-2');s.app.destroy();
});

test('a chosen pattern or display size survives a late configuration merging unchanged settings',async()=>{
 for(const [id,value]of [['trend-pattern','volume-contract'],['trend-display','20']]){
  const s=mounted();s.setResult(withPatterns(cachedResult()));await s.app.start('consensus');
  s.ids[id].value=value;s.ids[id].dispatchEvent({type:'change'});
  assert.equal(s.app.applyConfiguration(controlModel.DEFAULT_CONFIG),true);await settle();
  assert.equal(s.app.getState().mode,'consensus');assert.equal(s.app.getState().lookback,20);assert.equal(s.ids[id].value,value);s.app.destroy();
 }
});

function fullObservationResult(){
 const value=cachedResult({lookback:60,sampleSize:'all'}),template=value.records[0];value.total=3194;value.marketUniverseCount=3194;
 value.consensus={...value.consensus,status:'ready',identified:false,requestedCount:3194,validCount:3140,commonCount:1707,breadth:1707/3140,coverage:3140/3194};
 value.records=Array.from({length:3194},(_,index)=>({...template,stock:{code:String(600000+index)+'.SH',name:index<44?'ST风险'+index:'观察'+index,exchange:'SH',sector:'工业'},result:index>=3140?{status:'unavailable',matched:null,reason:'归档样本不足'}:{...template.result,matched:false,metrics:{...template.result.metrics,correlation:index<1707?.8:.2,directionAgreement:.8,periodReturn:index===0||index>=44&&index<77?40:10,return5:1,ma20Deviation:1,volumeRatio:1}}}));
 return value;
}
test('the default60-day view shows1707 observation candidates while separating overall risk and heat failures',async t=>{
 const s=mounted(),value=fullObservationResult();t.after(()=>s.app.destroy());s.setResult(value);s.ids['trend-lookback'].value='60';await s.app.start('consensus');
 assert.equal(s.ids['trend-count'].textContent,'1707 只');assert.equal(articles(s).length,1707);assert.equal(s.ids['trend-qualified-only'].checked,false);assert.match(s.ids['trend-consensus-status'].textContent,/54.36%（1707\/3140）.*门槛 60%.*整体未达.*观察候选 1707只.*严格达标 0只/);
 const first=articles(s).find(article=>article.dataset.code==='600000.SH'),qualification=first.children.find(node=>node.className==='trend-stock-qualification');assert.match(qualification.textContent,/观察候选.*整体未达.*风险名称排除.*过热排除/);assert.equal(qualification.dataset.qualified,'false');
 const requests=s.calls.length,nodes=articles(s).slice();s.ids['trend-breadth'].value='50';s.ids['trend-breadth'].dispatchEvent({type:'change'});
 assert.deepEqual(articles(s),nodes);assert.match(s.ids['trend-consensus-status'].textContent,/门槛 50%.*整体达标.*观察候选 1707只.*严格达标 1630只/);assert.equal(s.app.getState().records.filter(record=>record.result.excluded&&record.result.candidateMatched).length,34);assert.equal(s.calls.length,requests);
 s.ids['trend-qualified-only'].checked=true;s.ids['trend-qualified-only'].dispatchEvent({type:'change'});assert.equal(articles(s).length,1630);assert.equal(s.ids['trend-count'].textContent,'1630 只');assert.ok(articles(s).every(article=>article.children.find(node=>node.className==='trend-stock-qualification').dataset.qualified==='true'));assert.equal(s.calls.length,requests);
 s.ids['trend-breadth'].value='60';s.ids['trend-breadth'].dispatchEvent({type:'change'});assert.equal(articles(s).length,0);assert.match(s.ids['trend-results'].textContent,/取消“仅看达标”/);s.ids['trend-qualified-only'].checked=false;s.ids['trend-qualified-only'].dispatchEvent({type:'change'});assert.equal(articles(s).length,1707);
 s.setResult(cachedResult({mode:'market',lookback:60}));await s.app.start('market');assert.equal(s.ids['trend-consensus-controls'].hidden,true);assert.equal(s.ids['trend-consensus-status'].textContent,'');assert.equal(s.ids['trend-results'].textContent,'没有符合条件的股票');
});
test('a selected pattern with no matches is distinguished from overall market dispersion',async()=>{
 const s=mounted(),value=withPatterns(cachedResult());value.records.forEach(record=>record.patterns=patternFor(value.lookback,false));s.setResult(value);await s.app.start('consensus');
 s.ids['trend-pattern'].value='volume-contract';s.ids['trend-pattern'].dispatchEvent({type:'change'});assert.equal(s.ids['trend-results'].textContent,'所选周期没有符合该技术形态的股票。');s.app.destroy();
});
function memoryStorage(initial){const values=new Map(initial===undefined?[]:[['books.screening.minimumBreadth.v1',initial]]);return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};}
test('only the local breadth overrides an initial admin configuration and manual changes block late defaults',async t=>{
 const storage=memoryStorage('0.55'),s=mounted({},storage);t.after(()=>s.app.destroy());assert.equal(s.ids['trend-breadth'].value,'55');
 const config={...controlModel.DEFAULT_CONFIG,settings:{...controlModel.DEFAULT_CONFIG.settings,mode:'market',lookback:60,minimumBreadth:.8}};assert.equal(s.app.applyConfiguration(config),true);await settle();assert.equal(s.app.getState().mode,'market');assert.equal(s.app.getState().lookback,60);assert.equal(s.app.getState().minimumBreadth,.55);assert.equal(s.ids['trend-breadth'].value,'55');
 const second=mounted({},storage);t.after(()=>second.app.destroy());second.setResult(dispersedResult());await second.app.start('consensus');const requests=second.calls.length;second.ids['trend-breadth'].value='50';second.ids['trend-breadth'].dispatchEvent({type:'change'});assert.equal(second.calls.length,requests);assert.equal(second.app.getState().minimumBreadth,.5);assert.equal(JSON.parse(storage.values.get('books.screening.settings.v1')).minimumBreadth,.5);assert.equal(second.app.applyConfiguration(config),true);await settle();
 const next=mounted({},storage);t.after(()=>next.app.destroy());assert.equal(next.ids['trend-breadth'].value,'50');await next.app.start('consensus');assert.equal(next.app.getState().minimumBreadth,.5);
});
test('breadth editing during a failed or loading generation preserves cards and the current pattern and page controls',async t=>{
 const s=mounted();t.after(()=>s.app.destroy());s.setResult(withPatterns(dispersedResult()));await s.app.start('consensus');s.ids['trend-pattern'].value='volume-contract';s.ids['trend-pattern'].dispatchEvent({type:'change'});s.ids['trend-display'].value='4';s.ids['trend-display'].dispatchEvent({type:'change'});const nodes=articles(s).slice(),fetch=s.env.fetch;
 s.env.fetch=async()=>{throw Error('cache offline');};await s.app.start('consensus');const failedRequests=s.calls.length;s.ids['trend-breadth'].value='50';s.ids['trend-breadth'].dispatchEvent({type:'change'});assert.deepEqual(articles(s),nodes);assert.equal(s.calls.length,failedRequests);assert.equal(s.app.getState().cacheReadFailed,true);assert.match(s.ids['trend-consensus-status'].textContent,/门槛 50%/);
 s.env.fetch=fetch;s.setMetadata({available:true,scope:'full-market',lastSuccess:{generation:'daily-generation-2',day}});let release;s.env.fetch=async(path,init)=>path.includes('/result?')?{ok:true,json:()=>new Promise(resolve=>release=()=>resolve({...withPatterns(dispersedResult()),generation:'daily-generation-2'}))}:fetch(path,init);
 const pending=s.app.runner.refreshIfChanged();await settle();s.ids['trend-breadth'].value='55';s.ids['trend-breadth'].dispatchEvent({type:'change'});assert.deepEqual(articles(s),nodes);assert.match(s.ids['trend-consensus-status'].textContent,/门槛 55%/);release();await pending;assert.equal(s.app.getState().minimumBreadth,.55);assert.equal(s.ids['trend-pattern'].value,'volume-contract');assert.equal(s.ids['trend-display'].value,'4');assert.equal(s.ids['trend-breadth'].value,'55');
});
test('invalid stored or entered breadth and unavailable local storage never prevent observing cached results',async t=>{
 for(const saved of ['broken','null','2']){const s=mounted({},memoryStorage(saved));t.after(()=>s.app.destroy());assert.equal(s.ids['trend-breadth'].value,'60');await s.app.start('consensus');const requests=s.calls.length;for(const input of ['', '-1','101','NaN']){s.ids['trend-breadth'].value=input;s.ids['trend-breadth'].dispatchEvent({type:'change'});assert.equal(s.ids['trend-breadth'].value,'60');}assert.equal(s.calls.length,requests);}
 const s=mounted({}, {getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}});t.after(()=>s.app.destroy());await s.app.start('consensus');const requests=s.calls.length;s.ids['trend-breadth'].value='0';s.ids['trend-breadth'].dispatchEvent({type:'change'});assert.equal(s.app.getState().minimumBreadth,0);assert.equal(articles(s).length,32);assert.match(s.ids['trend-strategy-status'].textContent,/本机设置未能保存/);assert.equal(s.calls.length,requests);
});

const field=(s,group,key)=>s.ids['trend-screen'].children.find(node=>node.dataset[group]===key);
function edit(s,group,key,value){const node=field(s,group,key);node.value=String(value);node.dispatchEvent({type:'change'});}
function chooseDirection(s,value){field(s,'trendDirection',value).dispatchEvent({type:'click'});}
function earlyStrengthResult(){
 const result=withPatterns(cachedResult({mode:'strength'}));
 result.records=result.records.slice(0,2);result.records.forEach((record,index)=>Object.assign(record.result.metrics,{periodReturn:-2.47,return5:1.43,ma20Deviation:1,ma5:102,ma20:101,crossAgeDays:index?7:1,crossSearchDays:20}));
 return result;
}
test('public landing is early strength with five-day main return and a separately labeled negative20-day return',async t=>{
 const s=mounted({configuration:undefined});t.after(()=>s.app.destroy());s.setResult(earlyStrengthResult());await s.app.start('strength');
 assert.equal(s.app.getState().mode,'strength');assert.equal(s.app.getState().direction,'up');assert.equal(s.app.getState().limits.maxReturn20,10);assert.equal(s.app.getState().limits.maxReturn60,20);
 const item=articles(s)[0],change=item.children[0].children[1],qualification=item.children.find(node=>node.className==='trend-stock-qualification');
 assert.equal(articles(s).length,1);assert.equal(change.children[0].textContent,'+1.43%');assert.equal(change.children[1].textContent,'近5日涨跌');assert.equal(change.children[2].textContent,'20日 -2.47%');
 assert.equal(qualification.children[0].textContent,'初期转强条件已满足');assert.match(qualification.textContent,/上穿MA20距今 1 个交易日/);assert.equal(qualification.open,undefined);
 assert.equal(s.ids['trend-direction-controls'].hidden,true);assert.equal(s.ids['trend-direction-settings'].hidden,true);assert.equal(s.ids['trend-strength-controls'].hidden,false);
});
test('direction cohorts retain the original market denominator and a volatileV shape never becomes sideways',async t=>{
 const s=mounted();t.after(()=>s.app.destroy());const value=dispersedResult();
 value.records.slice(0,17).forEach((record,index)=>Object.assign(record.result.metrics,{periodReturn:index<4?5:index<14?-5:0,periodRangePercent:index===16?25:6,ma20Deviation:1,return5:1}));
 s.setResult(value);await s.app.start('consensus');const requests=s.calls.length;
 s.ids['trend-breadth'].value='10';s.ids['trend-breadth'].dispatchEvent({type:'change'});chooseDirection(s,'up');assert.equal(articles(s).length,4);assert.equal(s.app.getState().directionSummary.validCount,32);assert.equal(s.app.getState().directionSummary.breadth,4/32);assert.match(s.ids['trend-consensus-status'].textContent,/共同上涨 12.5%（4\/32）/);
 chooseDirection(s,'down');assert.equal(articles(s).length,10);assert.equal(s.app.getState().directionSummary.breadth,10/32);
 chooseDirection(s,'sideways');assert.equal(articles(s).length,2);assert.ok(articles(s).every(article=>article.dataset.code!==value.records[16].stock.code));assert.equal(s.app.getState().directionSummary.marketQualified,false);
 chooseDirection(s,'all');assert.equal(articles(s).length,17);assert.equal(s.app.getState().directionSummary.breadth,17/32);assert.equal(s.calls.length,requests);
});
test('an emptydirection explains the activeperiod and nextaction without masking qualification or patternempty states',async t=>{
 const s=mounted();t.after(()=>s.app.destroy());s.setResult(dispersedResult({lookback:60}));s.ids['trend-lookback'].value='60';await s.app.start('consensus');chooseDirection(s,'sideways');
 assert.equal(s.ids['trend-results'].textContent,'所选60日没有符合横盘整理条件的共性候选，可调整涨跌分界和横盘区间幅度，或切换全部方向。');
 s.ids['trend-qualified-only'].checked=true;s.ids['trend-qualified-only'].dispatchEvent({type:'change'});assert.match(s.ids['trend-results'].textContent,/取消“仅看达标”/);
});
test('local parameter patches survive reload and late admin configuration only replaces unedited fields',async t=>{
 const storage=memoryStorage(),s=mounted({configuration:undefined},storage);t.after(()=>s.app.destroy());s.setResult(earlyStrengthResult());await s.app.start('strength');
 edit(s,'trendStrength','crossWithinDays',10);edit(s,'trendPatternParam','nearPct',5);edit(s,'trendLimit','maxReturn20',8);
 const admin={settings:{mode:'consensus',direction:'down',strength:{crossWithinDays:3,minReturn5:1},patterns:{nearPct:1,rangePct:6},limits:{maxReturn20:99,maxReturn60:40}}};
 assert.equal(s.app.applyConfiguration(admin),true);await settle();const state=s.app.getState();assert.equal(state.mode,'strength');assert.equal(state.direction,'up');assert.equal(state.strength.crossWithinDays,10);assert.equal(state.strength.minReturn5,1);assert.equal(state.patterns.nearPct,5);assert.equal(state.patterns.rangePct,6);assert.equal(state.limits.maxReturn20,8);assert.equal(state.limits.maxReturn60,40);
 const patch=JSON.parse(storage.values.get('books.screening.settings.v1'));assert.deepEqual(patch,{strength:{crossWithinDays:10},patterns:{nearPct:5},limits:{maxReturn20:8}});
 field(s,'trendMode','consensus').dispatchEvent({type:'click'});await settle();chooseDirection(s,'down');const next=mounted({configuration:undefined},storage);t.after(()=>next.app.destroy());assert.equal(field(next,'trendMode','consensus').attrs['aria-pressed'],'true');assert.equal(field(next,'trendDirection','down').attrs['aria-pressed'],'true');assert.equal(field(next,'trendStrength','crossWithinDays').value,'10');
});
test('facts thresholds and strength windows reapply locally without replacing chartDOM or mutating capturedfacts',async t=>{
 const s=mounted(),value=earlyStrengthResult();t.after(()=>s.app.destroy());s.setResult(value);const before=JSON.stringify(value);await s.app.start('strength');const item=articles(s)[0],requests=s.calls.length;
 edit(s,'trendStrength','crossWithinDays',10);assert.equal(articles(s).length,2);assert.equal(articles(s)[0],item);
 s.ids['trend-pattern'].value='volume-contract';s.ids['trend-pattern'].dispatchEvent({type:'change'});assert.equal(articles(s).length,2);
 edit(s,'trendPatternParam','volumeContractRatio',.6);assert.equal(articles(s).length,0);assert.match(s.ids['trend-pattern'].textContent,/0.6|缩量/);
 edit(s,'trendPatternParam','volumeContractRatio',.8);assert.equal(articles(s).length,2);assert.equal(s.calls.length,requests);assert.equal(JSON.stringify(value),before);
 chooseDirection(s,'down');assert.equal(articles(s).length,2,'a stored consensus direction never removes early-strength candidates');
});
test('invalid or inconsistent conditions revert the fields, keep the savedpatch, and never request data',async t=>{
 const storage=memoryStorage(),s=mounted({},storage);t.after(()=>s.app.destroy());await s.app.start('consensus');edit(s,'trendPatternParam','nearPct',5);const before=storage.values.get('books.screening.settings.v1'),requests=s.calls.length;
 for(const [group,key,value,expected]of [['trendStrength','crossWithinDays',0,'5'],['trendPatternParam','pullbackMinPct',9,'2'],['trendPatternParam','volumeContractRatio',1.3,'0.8'],['trendLimit','maxReturn20','', '15']]){edit(s,group,key,value);assert.equal(field(s,group,key).value,expected);assert.equal(s.ids['trend-settings-error'].hidden,false);assert.equal(storage.values.get('books.screening.settings.v1'),before);}
 edit(s,'trendStrength','crossWithinDays',8);assert.equal(s.ids['trend-settings-error'].hidden,true);assert.equal(s.calls.length,requests);
});
test('reset removes only condition preferences and retains mode direction period and unrelatedlocalstorage',async t=>{
 const storage=memoryStorage('0.4'),s=mounted({configuration:undefined},storage);t.after(()=>s.app.destroy());storage.values.set('books.unrelated','keep');s.setResult(earlyStrengthResult());await s.app.start('strength');edit(s,'trendStrength','crossWithinDays',10);chooseDirection(s,'down');const requests=s.calls.length;
 s.ids['trend-reset-settings'].dispatchEvent({type:'click'});assert.equal(s.app.getState().strength.crossWithinDays,5);assert.equal(s.app.getState().minimumBreadth,.6);assert.equal(s.app.getState().limits.maxReturn20,10);assert.equal(s.app.getState().direction,'down');assert.equal(s.app.getState().mode,'strength');assert.equal(storage.values.get('books.unrelated'),'keep');assert.equal(storage.values.has('books.screening.minimumBreadth.v1'),false);assert.deepEqual(JSON.parse(storage.values.get('books.screening.settings.v1')),{direction:'down'});assert.equal(s.calls.length,requests);
});
test('new parameters persist through failed and nextcompleted generations without upstream requests',async()=>{
 const s=cacheSetup(),first=earlyStrengthResult();s.setResult(first);await s.runner.run(s.input({mode:'strength',stocks:null}));const fetch=s.env.fetch;
 s.env.fetch=async()=>{throw Error('cache offline');};await s.runner.run(s.input({mode:'strength',stocks:null}));const requests=s.calls.length;s.runner.reapply({strength:{crossWithinDays:10},patterns:{nearPct:5},direction:'down'});assert.equal(s.runner.getState().cacheReadFailed,true);assert.equal(s.runner.getState().records.filter(record=>record.result.matched).length,2);assert.equal(s.calls.length,requests);
 s.env.fetch=fetch;s.setMetadata({available:true,scope:'full-market',lastSuccess:{generation:'daily-generation-2',day}});s.setResult({...earlyStrengthResult(),generation:'daily-generation-2'});await s.runner.refreshIfChanged();const state=s.runner.getState();assert.equal(state.generation,'daily-generation-2');assert.equal(state.strength.crossWithinDays,10);assert.equal(state.patterns.nearPct,5);assert.equal(state.direction,'down');assert.equal(state.directionSummary.direction,'all');assert.equal(state.records.filter(record=>record.result.matched).length,2);
});

function peerResult(){
 const calendar=bars(),records=marketRows.map((stock,index)=>{
  let close=100;const history=calendar.map((bar,i)=>{
   const open=close,tilt=index<16?-.0035+index*.0001:.0018+(index-16)*.00012;
   if(i)close*=1+(i%2?.006:-.006)+tilt+(i>=60?(index<16?-.0002:.0002+(index-16)*.00004):0);
   return {date:bar.date,open,high:Math.max(open,close)*1.03,low:Math.min(open,close)*.97,close,volume:i>=60&&index%2===0?700:1000};
  });return {stock,bars:history};
 });
 const consensus=actualEngine.buildConsensus({records,calendar,day,lookback:20,expectedCount:records.length,totalUniverseCount:records.length});
 assert.equal(consensus.status,'ready');
 const value=cachedResult({sampleSize:'all'});value.consensus=consensus;value.patternVersion=actualPatterns.version;value.patternDefinitions=actualPatterns.definitionsFor();
 value.records=records.map(record=>({stock:record.stock,result:{...actualEngine.evaluate({mode:'consensus',bars:record.bars,referenceBars:calendar,consensus,day,lookback:20,code:record.stock.code,limits:{enabled:false}}),structure:actualEngine.deriveSupportResistance({bars:record.bars,calendar,day})},patterns:actualPatterns.classify({bars:record.bars,calendar,day,lookback:20}),fetchedAt,referenceFetchedAt:fetchedAt}));
 return value;
}
function peerMounted(storage){
 const s=mounted({configuration:controlModel.normalizeConfig({settings:{limits:{enabled:false}}})},storage),value=peerResult();s.setResult(value);return {...s,value};
}
function enablePeers(s,value=true){s.ids['trend-peer-enabled'].checked=value;s.ids['trend-peer-enabled'].dispatchEvent({type:'change'});}
test('peer ranking follows the chosen direction and shape before pagination, using real fixed-market facts without another read',async t=>{
 const s=peerMounted();t.after(()=>s.app.destroy());await s.app.start('consensus');assert.equal(articles(s).length,32);
 const requests=s.calls.length,before=JSON.stringify(s.value);edit(s,'trendDirectionRule','minimumReturnPercent',0);chooseDirection(s,'up');assert.equal(articles(s).length,16);
 s.ids['trend-pattern'].value='volume-contract';s.ids['trend-pattern'].dispatchEvent({type:'change'});assert.equal(articles(s).length,8);
 for(const [key,value]of Object.entries({groupTopPercent:50,minExcessReturn:-1000,minRecentExcess:-1000,minImprovement:-1000}))edit(s,'trendPeer',key,value);
 enablePeers(s);assert.equal(articles(s).length,4);assert.match(s.ids['trend-peer-status'].textContent,/同组有效 8 只.*入选 4 只/);
 assert.ok(articles(s).every(article=>Number(article.dataset.code.slice(0,6))>=600016&&Number(article.dataset.code.slice(0,6))%2===0));
 s.ids['trend-pattern'].value='';s.ids['trend-pattern'].dispatchEvent({type:'change'});assert.equal(articles(s).length,8);assert.match(s.ids['trend-peer-status'].textContent,/同组有效 16 只/);
 const all=articles(s).map(article=>article.dataset.code);s.ids['trend-display'].value='4';s.ids['trend-display'].dispatchEvent({type:'change'});assert.equal(s.ids['trend-page'].textContent,'1 / 2');assert.deepEqual(articles(s).map(article=>article.dataset.code),all.slice(0,4));
 s.ids['trend-next'].dispatchEvent({type:'click'});assert.equal(s.ids['trend-page'].textContent,'2 / 2');assert.deepEqual(articles(s).map(article=>article.dataset.code),all.slice(4));assert.match(s.ids['trend-peer-status'].textContent,/同组有效 16 只/);
 s.ids['trend-display'].value='all';s.ids['trend-display'].dispatchEvent({type:'change'});enablePeers(s,false);assert.equal(articles(s).length,16);assert.equal(s.ids['trend-peer-status'].textContent,'');assert.equal(s.calls.length,requests);assert.equal(JSON.stringify(s.value),before);
 assert.ok(s.calls.every(call=>call.path.startsWith('/api/a-share-daily/')));
});
test('nullable peer inputs clear to null and invalid edits retain the saved configuration and existing cards',async t=>{
 const storage=memoryStorage(),s=peerMounted(storage);t.after(()=>s.app.destroy());await s.app.start('consensus');const requests=s.calls.length;
 for(const key of ['minDownsideExcess','maxSupportDistance','minResistanceSpace','sectorTopPercent']){
  assert.equal(field(s,'trendPeer',key).value,'');edit(s,'trendPeer',key,key==='sectorTopPercent'?50:2);assert.equal(s.app.getSchemeDraft().config.settings.peer[key],key==='sectorTopPercent'?50:2);
  edit(s,'trendPeer',key,'');assert.equal(s.app.getSchemeDraft().config.settings.peer[key],null);assert.equal(field(s,'trendPeer',key).value,'');assert.equal(JSON.parse(storage.values.get('books.screening.settings.v1')).peer[key],null);
 }
 edit(s,'trendPeer','groupTopPercent',45);const saved=storage.values.get('books.screening.settings.v1'),draft=JSON.stringify(s.app.getSchemeDraft()),nodes=articles(s).slice();
 for(const [key,value]of [['groupTopPercent',''],['groupTopPercent',101],['minPeers',1],['minPeers',6001],['minExcessReturn','not-a-number'],['maxSupportDistance',-1],['sectorTopPercent',0]]){
  edit(s,'trendPeer',key,value);assert.equal(storage.values.get('books.screening.settings.v1'),saved);assert.equal(JSON.stringify(s.app.getSchemeDraft()),draft);assert.deepEqual(articles(s),nodes);assert.equal(s.ids['trend-settings-error'].hidden,false);
 }
 const unknown=JSON.parse(draft);unknown.config.settings.peer.unrecognized=true;assert.throws(()=>s.app.applyScheme(unknown));assert.equal(JSON.stringify(s.app.getSchemeDraft()),draft);assert.equal(s.calls.length,requests);
});
test('peer card facts use the captured same-period baseline and matching OHLC structure, with old structure left unknown',async t=>{
 const s=peerMounted();t.after(()=>s.app.destroy());s.value.records[0].result.structure={...s.value.records[0].result.structure,endAt:'2026-11-19',supportDistancePct:777,resistanceSpacePct:888};await s.app.start('consensus');
 const first=articles(s).find(article=>article.dataset.code===s.value.records[0].stock.code);assert.match(first.textContent,/支撑压力资料不足/);assert.doesNotMatch(first.textContent,/777|888/);
 const capture=s.value.records[16],item=articles(s).find(article=>article.dataset.code===capture.stock.code),m=capture.result.metrics,structure=capture.result.structure;
 const point=value=>(value>0?'+':'')+value.toFixed(2)+'个百分点';
 assert.equal(m.relativeBaseline,'full_market_leave_one_out_equal_stock_daily_median');assert.equal(m.endAt,day);assert.equal(m.sampleCount,21);
 assert.ok(item.textContent.includes('同期领先 '+point(m.excessReturn)));assert.ok(item.textContent.includes('近5日领先 '+point(m.recentExcessReturn)));assert.ok(item.textContent.includes('抗跌 '+point(m.downsideExcess)));
 assert.equal(structure.endAt,day);assert.equal(structure.status,'ready');assert.ok(item.textContent.includes('距20日支撑 '+structure.supportDistancePct.toFixed(2)+'%'));assert.ok(item.textContent.includes('上方压力空间 '+structure.resistanceSpacePct.toFixed(2)+'%'));assert.match(item.textContent,/工业 · 盘后行业第 [12]/);
 assert.equal(s.ids['trend-status'].textContent,'沪深主板 32只 · 数据日'+day);
});
