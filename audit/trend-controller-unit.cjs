'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRunner,sortRecords,mount}=require('../screening/trend-controller.js');
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
test('dataset failure diagnostics omit source URLs and authentication header values',async()=>{
 const s=setup({history:async(stock,target,signal,opts)=>opts.index?good(stock.code,true):{status:'unavailable',reason:'读取 https://example.test/?token=private-token 失败\nAuthorization: Bearer hidden-credential'}});
 await s.runner.run(options({mode:'consensus'}));const data=s.runner.exportDataset();assert.ok(data);assert.doesNotMatch(JSON.stringify(data),/example\.test|private-token|hidden-credential|Bearer/);assert.match(data.records[0].source.reason,/来源地址省略.*Authorization=\[已隐藏\]/);
});
test('exported raw dataset reproduces the actual consensus metrics without exported conclusions',async()=>{
 const actual=require('../screening/trend-screen.js'),s=setup({},actual),state=await s.runner.run(options({mode:'consensus'})),data=s.runner.exportDataset();
 assert.equal(state.status,'complete');const consensus=actual.buildConsensus({records:data.records.filter(r=>r.source.status==='ready').map(r=>({stock:r.stock,bars:r.source.bars})),calendar:data.reference.bars,lookback:20,day:data.day,expectedCount:data.expectedCount,totalUniverseCount:data.totalUniverseCount});
 assert.equal(consensus.identified,state.consensus.identified);assert.equal(consensus.commonCount,state.consensus.commonCount);
 const record=data.records[0],result=actual.evaluate({mode:'consensus',bars:record.source.bars,consensus,lookback:20,day:data.day,code:record.stock.code,limits:options().limits});
 assert.deepEqual(result.metrics,state.records[0].result.metrics);assert.doesNotMatch(JSON.stringify(data),/"metrics"|"matched"|"consensus"/);
 const model=require('../control/model.js'),replay=await model.evaluateDataset(data,model.DEFAULT_CONFIG,actual);assert.equal(replay.status,state.status);assert.equal(replay.summary.commonCount,state.consensus.commonCount);assert.deepEqual(replay.records[0].result.metrics,state.records[0].result.metrics);
});
class Target{constructor(){this.events={};}addEventListener(k,f){(this.events[k]??=[]).push(f);}removeEventListener(k,f){this.events[k]=(this.events[k]||[]).filter(x=>x!==f);}dispatchEvent(e){for(const f of this.events[e.type]||[])f(e);}}
class Element extends Target{constructor(tag='div'){super();this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.checked=false;this.own='';}set textContent(v){this.own=String(v);this.children=[];}get textContent(){return this.own+this.children.map(x=>x.textContent).join('');}set innerHTML(_){throw Error('unsafe HTML');}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;this.own='';}setAttribute(k,v){this.attrs[k]=String(v);}querySelectorAll(q){return q==='[data-trend-mode]'?this.children.filter(x=>x.dataset.trendMode):[];}}
function dom(){const env=new Target(),ids={},doc={defaultView:env,getElementById:id=>ids[id],createElement:tag=>new Element(tag)};
 for(const id of ['trend-screen','trend-lookback','trend-benchmark','trend-scope','trend-sample','trend-exclude-hot','trend-max-return','trend-max-five','trend-max-deviation','trend-max-volume','trend-stop','trend-status','trend-rules','trend-market-summary','trend-only-matches','trend-count','trend-rows','trend-prev','trend-next','trend-page'])ids[id]=new Element();
 for(const mode of ['consensus','market','strength']){const b=new Element('button');b.dataset.trendMode=mode;ids['trend-screen'].append(b);}for(const [id,value]of Object.entries({'trend-lookback':'20','trend-benchmark':'000300.SH','trend-scope':'filtered','trend-sample':'120','trend-max-return':'15','trend-max-five':'8','trend-max-deviation':'8','trend-max-volume':'2.5'}))ids[id].value=value;ids['trend-only-matches'].checked=true;ids['trend-exclude-hot'].checked=true;return {env,ids,doc};}
const context=(rows=stocks)=>({day,asOf,rows,pageRows:rows,savedRows:rows,allRows:marketRows,marketRows});
test('UI has no single reference input and no startup request; independent pool size is explicit',async()=>{
 const d=dom(),s=setup();const app=mount(d.doc,{selection:{getContext:()=>context()},technical:s.technical,engine:s.engine,wait:async()=>{}});
 assert.equal(d.ids['trend-reference'],undefined);assert.equal(s.calls.length,0);assert.match(d.ids['trend-status'].textContent,/市场参考池32|市场参考池 32/);assert.match(d.ids['trend-rules'].textContent,/不需要填写参考股票/);app.destroy();
});
test('mounted app exposes dataset and state plus a finished event with no source payload',async()=>{
 const d=dom(),s=setup(),events=[];d.env.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options.detail;}};
 d.env.addEventListener('books:trend-run-finished',event=>events.push(event.detail));const app=mount(d.doc,{selection:{getContext:()=>context()},technical:s.technical,engine:s.engine,wait:async()=>{}});
 assert.equal(app.exportDataset(),null);await app.start('consensus');assert.equal(app.getState().status,'complete');assert.equal(app.exportDataset().expectedCount,32);assert.equal(events.length,1);
 assert.deepEqual(events[0],{status:'complete',mode:'consensus',day,startedAt:app.getState().startedAt,finishedAt:app.getState().finishedAt});assert.doesNotMatch(JSON.stringify(events),/bars|sourceUrl/);app.destroy();
});
test('UI gives consensus coverage and breadth, not a stock benchmark or winner subset',async()=>{
 const d=dom(),s=setup(),app=mount(d.doc,{selection:{getContext:()=>context([stocks[0]])},technical:s.technical,engine:s.engine,wait:async()=>{}});
 await app.start('consensus');assert.equal(s.calls.length,33);assert.match(d.ids['trend-status'].textContent,/分层样本 32\/32/);assert.match(d.ids['trend-market-summary'].textContent,/有效覆盖 100%.*80%.*样本已形成/);assert.doesNotMatch(d.ids['trend-rows'].textContent,/参考股票|600519.SH/);app.destroy();
});
test('UI preserves raw high metrics, counts exclusions separately and exposes input-price/volume audit',async()=>{
 const d=dom(),s=setup({}, {evaluate:()=>({status:'ready',matched:false,excluded:true,reason:'过热',exclusionReasons:['涨幅超限'],metrics:{...metrics,startClose:100,endClose:143.76,periodReturn:43.76,volumeRatio:5.48,volumeAvg5:548,volumeAvgPrevious20:100}})});
 d.ids['trend-only-matches'].checked=false;const app=mount(d.doc,{selection:{getContext:()=>context([stocks[0]])},technical:s.technical,engine:s.engine,wait:async()=>{}});await app.start('strength');
 assert.match(d.ids['trend-rows'].textContent,/43.76%.*5.48倍.*过热排除/);assert.match(d.ids['trend-count'].textContent,/过热排除 1.*资料不足 0/);assert.match(d.ids['trend-rows'].textContent,/起点 100.*终点 143.76.*548.*100.*不是资金金额/);app.destroy();
});
test('a downward market common pattern is explicitly labeled downward instead of implying strength',async()=>{
 const d=dom(),s=setup({}, {buildConsensus:input=>({...fakeEngine().buildConsensus(input),dates:['2026-10-31',day],medianReturns:[-.01,-.02]})});
 const app=mount(d.doc,{selection:{getContext:()=>context()},technical:s.technical,engine:s.engine,wait:async()=>{}});await app.start('consensus');
 assert.match(d.ids['trend-market-summary'].textContent,/样本中位曲线 2026-10-31 至 2026-11-20 -2.98%（下行）/);app.destroy();
});
test('blank caps fail validation, period changes use defaults while preserving explicit custom caps',async()=>{
 const d=dom(),s=setup(),app=mount(d.doc,{selection:{getContext:()=>context()},technical:s.technical,engine:s.engine,wait:async()=>{}});
 d.ids['trend-max-return'].value='';await app.start('strength');assert.equal(s.calls.length,0);assert.match(d.ids['trend-status'].textContent,/有效的非负数/);
 d.ids['trend-max-return'].value='15';d.ids['trend-lookback'].value='60';d.ids['trend-lookback'].dispatchEvent({type:'change'});assert.equal(d.ids['trend-max-return'].value,'30');
 d.ids['trend-max-return'].value='22';d.ids['trend-lookback'].value='20';d.ids['trend-lookback'].dispatchEvent({type:'change'});assert.equal(d.ids['trend-max-return'].value,'22');app.destroy();
});
test('starting with invalid settings clears the previous dataset instead of exporting stale results',async()=>{
 const d=dom(),s=setup(),app=mount(d.doc,{selection:{getContext:()=>context()},technical:s.technical,engine:s.engine,wait:async()=>{}});await app.start('consensus');assert.ok(app.exportDataset());d.ids['trend-max-return'].value='';await app.start('consensus');assert.equal(app.exportDataset(),null);app.destroy();
});
test('scope and changed filters cannot silently keep stale results or broaden non-consensus scans',async()=>{
 const d=dom(),s=setup();let c={...context(),savedRows:[stocks[1]]};const app=mount(d.doc,{selection:{getContext:()=>c},technical:s.technical,engine:s.engine,wait:async()=>{}});
 d.ids['trend-scope'].value='saved';d.ids['trend-scope'].dispatchEvent({type:'change'});await app.start('market');assert.deepEqual(s.calls.map(x=>x.stock.code),['000300.SH','000858.SZ']);
 c={...c,rows:[stocks[0]]};d.env.dispatchEvent({type:'books:selection-changed'});assert.equal(app.runner.getState().records.length,0);app.destroy();
});
test('first filter change cancels a late outstanding response without a new read',async()=>{
 const d=dom();let c=context(),release,calls=0;const technical={sourceState:()=>({status:'idle'}),history:async stock=>{calls++;return new Promise(resolve=>release=()=>resolve(good(stock.code)));}};
 const app=mount(d.doc,{selection:{getContext:()=>c},technical,engine:fakeEngine(),wait:async()=>{}}),pending=app.start('strength');c={...c,rows:[stocks[1]]};d.env.dispatchEvent({type:'books:selection-changed'});release();await pending;assert.equal(calls,1);assert.equal(app.runner.getState().status,'idle');app.destroy();
});
test('early-turn sorting favors lower extension, not the largest period gain, and does not mutate input',()=>{
 const row=(code,matched,excluded,metrics)=>({stock:{code},result:{status:'ready',matched,excluded,metrics}}),records=[row('hot',false,true,{periodReturn:99,ma20Deviation:30}),row('raised',true,false,{periodReturn:14,ma20Deviation:7,correlation:.7}),row('early',true,false,{periodReturn:2,ma20Deviation:1,correlation:.9})];
 assert.deepEqual(sortRecords(records,'strength').map(r=>r.stock.code),['early','raised','hot']);assert.deepEqual(sortRecords(records,'consensus').map(r=>r.stock.code),['early','raised','hot']);assert.equal(records[0].stock.code,'hot');
});
