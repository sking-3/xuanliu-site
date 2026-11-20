'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRunner,resolveReference,sortRecords,mount}=require('../screening/trend-controller.js');
const day='2026-11-20',asOf='2026-11-20T08:00:00Z',fetchedAt='2026-11-20T10:00:00Z';
const stocks=[{code:'600519.SH',name:'贵州茅台'},{code:'000858.SZ',name:'五粮液'}];
function bars(n=65){return Array.from({length:n},(_,i)=>({date:new Date(Date.parse(day+'T00:00:00Z')-(n-i-1)*86400000).toISOString().slice(0,10),close:100+i,volume:1000}));}
const good=(code,index=false)=>({status:'ready',code,day,adjustment:index?'index':'qfq',bars:bars(),fetchedAt,sourceUrl:'https://web.ifzq.gtimg.cn/'});
const engine={evaluate:()=>({status:'ready',matched:true,metrics:{correlation:.8,directionAgreement:.8,periodReturn:12.3,startAt:'2026-10-20',endAt:day},reasons:['共同条件']})};
function setup(overrides={}){const calls=[],pauses=[],updates=[];const technical={sourceState:()=>({status:'idle'}),history:async(stock,target,signal,options)=>{calls.push({stock,target,signal,options});return good(stock.code,options.index);},...overrides};const runner=createRunner({technical,engine,wait:async(ms,signal)=>{pauses.push(ms);assert.equal(signal.aborted,false);},now:()=>Date.parse(fetchedAt),onUpdate:s=>updates.push(s)});return {calls,pauses,updates,runner,technical};}
const options=(extra={})=>({mode:'strength',lookback:20,day,asOf,stocks,reference:{code:'000300.SH'},index:true,...extra});
test('new controller never fetches on construction, missing DOM or invalid scope',async()=>{
 const s=setup();assert.equal(s.calls.length,0);assert.equal(mount({getElementById:()=>null}),null);
 assert.equal((await s.runner.run(options({stocks:[]}))).status,'unavailable');assert.equal(s.calls.length,0);
});
test('same shared history client performs serial, dated requests with guarded pauses',async()=>{
 const s=setup(),result=await s.runner.run(options());
 assert.equal(result.status,'complete');assert.equal(result.records.length,2);assert.equal(result.requests,3);assert.deepEqual(s.pauses,[1500,1500]);
 for(const [i,c] of s.calls.entries()){assert.equal(c.stock.asOf,asOf);assert.equal(c.target,day);assert.deepEqual(c.options,{minBars:26,index:i===0});}
 assert.equal(result.records[0].fetchedAt,fetchedAt);assert.equal(result.records[0].sourceUrl,'https://web.ifzq.gtimg.cn/');
});
test('market reads exactly one fixed index before stocks, preserving separate adjustment',async()=>{
 const s=setup(),result=await s.runner.run(options({mode:'market',reference:{code:'000300.SH'},index:true,lookback:60}));
 assert.deepEqual(s.calls.map(c=>c.stock.code),['000300.SH','600519.SH','000858.SZ']);assert.equal(s.calls[0].options.index,true);assert.equal(s.calls[1].options.index,false);assert.equal(s.calls[0].options.minBars,61);assert.equal(result.records[0].referenceFetchedAt,fetchedAt);
 const invalid=await s.runner.run(options({mode:'market',reference:{code:'600519.SH'},index:true}));assert.equal(invalid.status,'unavailable');assert.equal(s.calls.length,3);
});
test('same-batch successful daily bars are reused across modes and windows',async()=>{
 const s=setup();await s.runner.run(options());assert.equal(s.runner.cacheSize(),3);
 const result=await s.runner.run(options({mode:'similar',lookback:60,reference:stocks[0],index:false}));assert.equal(result.status,'complete');assert.equal(result.requests,0);assert.equal(s.calls.length,3);assert.equal(result.records.length,1);
 await s.runner.run(options({asOf:'2026-11-20T09:00:00Z'}));assert.equal(s.calls.length,6,'a changed source batch cannot reuse old bars');
});
test('persisted source stops prohibit even a reference request',async()=>{
 const s=setup({sourceState:()=>({status:'restricted',reason:'HTTP 429 已停止'})});const r=await s.runner.run(options({mode:'market',reference:{code:'000300.SH'},index:true}));assert.equal(r.status,'stopped');assert.match(r.reason,/429/);assert.equal(s.calls.length,0);
});
test('source refusal in an anchor terminates without a stock request or retry',async()=>{
 let calls=0;const s=setup({history:async()=>{calls++;return {status:'unavailable',sourceStopped:true,reason:'HTTP 403'};}});
 const r=await s.runner.run(options({mode:'similar',reference:stocks[0],index:false}));assert.equal(r.status,'stopped');assert.match(r.reason,/403/);assert.equal(calls,1);assert.equal(r.records.length,0);
});
test('a source refusal mid-scan retains completed rows without advancing or retrying',async()=>{
 let calls=0;const s=setup({history:async(stock)=>++calls<=2?good(stock.code):{status:'unavailable',sourceStopped:true,reason:'HTTP 429'}});
 const r=await s.runner.run(options());assert.equal(r.status,'stopped');assert.equal(r.records.length,1);assert.equal(calls,3);assert.equal(r.total,2);
});
test('missing input is recorded separately from a valid non-match',async()=>{
 const s=setup({history:async stock=>stock.code===stocks[0].code?{status:'unavailable',reason:'缺少目标交易日'}:good(stock.code)});
 const result=await s.runner.run(options());assert.equal(result.status,'complete');assert.equal(result.records[0].result.status,'unavailable');assert.match(result.records[0].result.reason,/目标/);assert.equal(result.records[1].result.matched,true);
});
test('cancellation discards a late result and does not start the next stock',async()=>{
 let resolve,calls=0;const s=setup({history:async stock=>{calls++;return new Promise(r=>resolve=()=>r(good(stock.code)));}});
 const pending=s.runner.run(options());assert.equal(calls,1);s.runner.cancel('用户停止');resolve();await pending;assert.equal(s.runner.getState().records.length,0);assert.equal(calls,1);assert.equal(s.runner.getState().status,'stopped');assert.match(s.runner.getState().reason,/用户停止/);
});
test('source restriction is checked again after a delay before the next request',async()=>{
 let blocked=false,calls=0,pauses=0;const technical={sourceState:()=>({status:blocked?'restricted':'idle',reason:'限制'}),history:async stock=>{calls++;return good(stock.code);}};
 const runner=createRunner({technical,engine,wait:async()=>{if(++pauses===2)blocked=true;}});const r=await runner.run(options());assert.equal(r.status,'stopped');assert.equal(calls,2);assert.equal(r.records.length,1);
});
test('reference resolution uses actual unique listed codes or names, not guessed symbols',()=>{
 assert.equal(resolveReference('600519',stocks).stock.code,'600519.SH');assert.equal(resolveReference('000858.sz',stocks).stock.code,'000858.SZ');assert.equal(resolveReference(' 贵州茅台 ',stocks).stock.code,'600519.SH');assert.match(resolveReference('fake',stocks).reason,/名单/);assert.match(resolveReference('双名',[{code:'600000.SH',name:'双名'},{code:'000001.SZ',name:'双名'}]).reason,/不唯一/);
});
class Target{
 constructor(){this.events={};}
 addEventListener(k,f){(this.events[k]??=[]).push(f);}
 removeEventListener(k,f){this.events[k]=(this.events[k]||[]).filter(v=>v!==f);}
 dispatchEvent(e){for(const fn of this.events[e.type]||[])fn(e);}
}
class Element extends Target{
 constructor(tag='div'){super();this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.checked=false;this.own='';}
 set textContent(v){this.own=String(v);this.children=[];}
 get textContent(){return this.own+this.children.map(v=>v.textContent).join('');}
 set innerHTML(_){throw Error('unsafe HTML');}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;this.own='';}
 setAttribute(k,v){this.attrs[k]=String(v);}
 querySelectorAll(selector){return selector==='[data-trend-mode]'?this.children.filter(e=>e.dataset.trendMode):[];}
}
function dom(){
 const env=new Target(),ids={},doc={defaultView:env,getElementById:id=>ids[id],createElement:tag=>new Element(tag)};
 for(const id of ['trend-screen','trend-lookback','trend-benchmark','trend-reference','trend-scope','trend-stop','trend-status','trend-rules','trend-only-matches','trend-count','trend-rows','trend-prev','trend-next','trend-page'])ids[id]=new Element();
 for(const mode of ['market','similar','strength']){const b=new Element('button');b.dataset.trendMode=mode;ids['trend-screen'].append(b);}
 ids['trend-lookback'].value='20';ids['trend-benchmark'].value='000300.SH';ids['trend-scope'].value='filtered';ids['trend-only-matches'].checked=true;
 return {env,ids,doc};
}
test('mounted UI defaults to no requests and shows safe text, dates and full counts after one click',async()=>{
 const d=dom(),s=setup(),weird=[{code:'600519.SH',name:'<script>name</script>'}];let stopped=0;
 const selection={getContext:()=>({day,asOf,rows:weird,pageRows:weird,savedRows:weird,allRows:weird}),stopTechnicalScan:()=>stopped++};
 const app=mount(d.doc,{selection,technical:s.technical,engine,wait:async()=>{}});
 assert.equal(s.calls.length,0);assert.match(d.ids['trend-status'].textContent,/当前范围 1/);assert.equal(d.ids['trend-stop'].hidden,true);
 await app.start('strength');assert.equal(stopped,1);assert.equal(s.calls.length,2);assert.match(d.ids['trend-rows'].textContent,/<script>name<\/script>/);assert.match(d.ids['trend-status'].textContent,/已核验 1\/1.*命中 1.*核验完成/);assert.match(d.ids['trend-rows'].textContent,/读取.*北京/);assert.equal(d.ids['trend-rows'].children[0].children[0].children[0].href,'../company-dossier.html?symbol=600519.SH');app.destroy();
});
test('the first filter change cancels an already-running scan and clears its obsolete view',async()=>{
 const d=dom();let release,calls=0;let c={day,asOf,rows:stocks,pageRows:stocks,savedRows:[],allRows:stocks};
 const technical={sourceState:()=>({status:'idle'}),history:async stock=>{calls++;return new Promise(r=>release=()=>r(good(stock.code)));}};
 const app=mount(d.doc,{selection:{getContext:()=>c},technical,engine,wait:async()=>{}}),pending=app.start('strength');assert.equal(calls,1);
 c={...c,rows:[stocks[1]]};d.env.dispatchEvent({type:'books:selection-changed'});release();await pending;
 assert.equal(app.runner.getState().records.length,0);assert.equal(app.runner.getState().status,'idle');assert.equal(calls,1);assert.match(d.ids['trend-status'].textContent,/当前范围 1/);app.destroy();
});
test('saved scope and invalid reference do not silently broaden the request universe',async()=>{
 const d=dom(),s=setup();const c={day,asOf,rows:stocks,pageRows:stocks,savedRows:[stocks[1]],allRows:stocks};
 const app=mount(d.doc,{selection:{getContext:()=>c},technical:s.technical,engine,wait:async()=>{}});
 d.ids['trend-reference'].value='not listed';await app.start('similar');assert.equal(s.calls.length,0);assert.match(d.ids['trend-status'].textContent,/名单/);
 d.ids['trend-scope'].value='saved';d.ids['trend-scope'].dispatchEvent({type:'change'});await app.start('strength');assert.deepEqual(s.calls.map(c=>c.stock.code),['000300.SH','000858.SZ']);app.destroy();
});
test('result sorting puts matched and valid rows first then ranks the selected mode metric',()=>{
 const row=(code,status,matched,metrics)=>({stock:{code},result:{status,matched,metrics}});
 const records=[row('missing','unavailable',false,{}),row('not-hit','ready',false,{correlation:.99,curveCorrelation:.99,periodReturn:99}),row('a','ready',true,{correlation:.7,curveCorrelation:.95,periodReturn:10}),row('b','ready',true,{correlation:.9,curveCorrelation:.85,periodReturn:20})];
 assert.deepEqual(sortRecords(records,'market').map(r=>r.stock.code),['b','a','not-hit','missing']);
 assert.deepEqual(sortRecords(records,'similar').map(r=>r.stock.code),['a','b','not-hit','missing']);
 assert.deepEqual(sortRecords(records,'strength').map(r=>r.stock.code),['b','a','not-hit','missing']);
 assert.equal(records[0].stock.code,'missing','presentation sorting must not mutate scan records');
});
test('similar screening excludes its own reference from queue, totals and missing counts',async()=>{
 const s=setup(),r=await s.runner.run(options({mode:'similar',reference:stocks[0],index:false}));
 assert.equal(r.total,1);assert.equal(r.records.length,1);assert.equal(r.records[0].stock.code,stocks[1].code);assert.equal(r.reference.code,stocks[0].code);assert.equal(r.reference.name,stocks[0].name);assert.equal(r.referenceFetchedAt,fetchedAt);
 const only=setup(),noOther=await only.runner.run(options({mode:'similar',stocks:[stocks[0]],reference:stocks[0],index:false}));
 assert.equal(noOther.status,'unavailable');assert.equal(noOther.total,0);assert.match(noOther.reason,/自身/);assert.equal(only.calls.length,0);
});
test('market UI identifies its benchmark and displays independent anchor and stock read times',async()=>{
 const d=dom(),s=setup(),c={day,asOf,rows:stocks,pageRows:stocks,savedRows:stocks,allRows:stocks};
 const app=mount(d.doc,{selection:{getContext:()=>c},technical:s.technical,engine,wait:async()=>{}});
 await app.start('market');assert.match(d.ids['trend-status'].textContent,/对照 沪深300 000300\.SH/);assert.match(d.ids['trend-rows'].textContent,/对照读取/);assert.match(d.ids['trend-rules'].textContent,/保持页面打开/);app.destroy();
});
test('strength reads the selected index calendar first and passes it to date-aligned evaluation',async()=>{
 const calls=[],inputs=[];const technical={sourceState:()=>({status:'idle'}),history:async(stock,target,signal,opts)=>{calls.push({code:stock.code,index:opts.index});return good(stock.code,opts.index);}};
 const runner=createRunner({technical,engine:{evaluate:input=>{inputs.push(input);return {status:'ready',matched:false,metrics:{},reasons:[]};}},wait:async()=>{}});
 const r=await runner.run(options({reference:{code:'399001.SZ'},stocks:[stocks[0]]}));
 assert.equal(r.status,'complete');assert.deepEqual(calls,[{code:'399001.SZ',index:true},{code:'600519.SH',index:false}]);assert.equal(inputs[0].mode,'strength');assert.equal(inputs[0].referenceCode,'399001.SZ');assert.equal(inputs[0].referenceBars.at(-1).date,day);
 const d=dom(),s=setup(),c={day,asOf,rows:stocks,pageRows:stocks,savedRows:stocks,allRows:stocks};
 const app=mount(d.doc,{selection:{getContext:()=>c},technical:s.technical,engine,wait:async()=>{}});await app.start('strength');assert.match(d.ids['trend-status'].textContent,/交易日对照 沪深300/);assert.match(d.ids['trend-rules'].textContent,/仅用于对齐交易日/);app.destroy();
});
