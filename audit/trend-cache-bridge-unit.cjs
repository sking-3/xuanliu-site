"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
class Target{
 constructor(){this.events={};this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.textContent='';this.children=[];}
 addEventListener(type,handler,options){
  const callback=options?.once?event=>{this.events[type]=this.events[type].filter(x=>x!==callback);handler(event);}:handler;
  (this.events[type]??=[]).push(callback);
 }
 dispatchEvent(event){for(const handler of [...this.events[event.type]||[]])handler(event);}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
}
const settle=()=>new Promise(setImmediate);
function bridge(options={}){
 const window=new Target(),calls=[],applied=[],config={name:'默认方案',settings:{mode:'strength',lookback:60,sampleSize:'240',benchmark:'399001.SZ',limits:{enabled:true,maxReturn20:15,maxReturn60:30,maxReturn5:8,maxDeviation:8,maxVolumeRatio:2.5}}};
 let jsonReads=0;
 const app=options.app||{applyConfiguration:value=>{applied.push(value);return true;}};
 if(!options.delayedMount)window.BooksTrendControllerApp=app;
 const fetch=async(path,init)=>{
  calls.push({path,init});
  if(options.networkError)throw Error('offline');
  return {ok:options.denied!==true,json:async()=>{jsonReads++;if(options.badJSON)throw Error('invalid JSON');return {activeConfig:options.empty?null:config};}};
 };
 const document={getElementById(){throw Error('headless bridge must not query DOM');}};
 const interval=()=>{throw Error('headless bridge must not create polling timers');};
 vm.runInNewContext(fs.readFileSync(require.resolve('../screening/control-bridge.js'),'utf8'),{window,document,fetch,setInterval:interval,setTimeout:interval});
 return {window,app,calls,applied,config,get jsonReads(){return jsonReads;}};
}
test('headless bridge makes one same-origin GET and delegates the active configuration once',async()=>{
 const s=bridge();await settle();assert.equal(s.calls.length,1);assert.equal(s.calls[0].path,'/api/research-control/state');assert.deepEqual(JSON.parse(JSON.stringify(s.calls[0].init)),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error'});assert.equal(s.jsonReads,1);assert.deepEqual(s.applied,[s.config]);
 s.window.dispatchEvent({type:'books:trend-mounted'});await settle();assert.equal(s.calls.length,1);assert.equal(s.applied.length,1);
});
test('headless bridge waits for the mounted app without querying removed tool IDs or reading sources',async()=>{
 const s=bridge({delayedMount:true});await settle();assert.equal(s.applied.length,0);assert.equal(s.calls.length,1);s.window.BooksTrendControllerApp=s.app;s.window.dispatchEvent({type:'books:trend-mounted'});s.window.dispatchEvent({type:'books:trend-mounted'});await settle();assert.deepEqual(s.applied,[s.config]);assert.equal(s.calls.length,1);
});
test('denied, failed, malformed and empty configuration responses leave defaults untouched',async()=>{
 for(const options of [{denied:true},{networkError:true},{badJSON:true},{empty:true}]){const s=bridge(options);await settle();assert.equal(s.calls.length,1);assert.equal(s.applied.length,0);assert.equal((s.window.events['books:trend-mounted']||[]).length,0);if(options.denied)assert.equal(s.jsonReads,0);}
});
test('late active configuration cannot override a user selection rejected by the app',async()=>{
 let mode='market',attempts=0;const app={applyConfiguration(){attempts++;return false;}},s=bridge({app,delayedMount:true});await settle();s.window.BooksTrendControllerApp=app;s.window.dispatchEvent({type:'books:trend-mounted'});s.window.dispatchEvent({type:'books:trend-mounted'});assert.equal(attempts,1);assert.equal(mode,'market');assert.equal(s.calls.length,1);
});
test('A-share refresh reads the same-origin market generation, not the old third-party browser URL',async()=>{
 const root=new Target(),status=new Target(),lists=new Target(),window=new Target(),requests=[],accepted=[];root.dataset={};root.querySelector=id=>id==='[data-closing-status]'?status:lists;
 const snapshot={updatedAt:new Date(Date.now()-1000).toISOString(),stocks:[{name:'真实接口测试形状',code:'600000.SH'}]},summary={asOf:snapshot.updatedAt,priced:1,gainers:[{name:'真实接口测试形状',code:'600000'}],losers:[]};
 window.BooksDailyMovers={summarize:()=>summary};window.BooksStockSelection={accept:(value,origin)=>accepted.push({value,origin}),unavailable:()=>{throw Error('market snapshot should load');}};
 const document={querySelector:q=>q==='[data-closing-ranks]'?root:null,getElementById:()=>null,createElement:()=>new Target()};
 const fetch=async(path)=>{requests.push(path);return {ok:true,json:async()=>path.startsWith('/api/a-share-daily/market')?snapshot:summary};};
 vm.runInNewContext(fs.readFileSync(require.resolve('../research-desk.js'),'utf8'),{document,window,fetch,Date,Intl,AbortController,setTimeout,clearTimeout});await settle();assert.ok(requests.includes('/api/a-share-daily/market'));assert.ok(requests.every(path=>!path.includes('https://')));assert.equal(accepted.length,1);assert.equal(accepted[0].origin,'upstream');assert.equal(accepted[0].value.updatedAt,snapshot.updatedAt);
 window.dispatchEvent({type:'books:refresh-selection',detail:{generation:'completed-generation-2'}});await settle();assert.equal(requests.at(-1),'/api/a-share-daily/market?generation=completed-generation-2');assert.equal(accepted.length,2);
});
test('a newly published generation is queued behind an in-flight market read instead of being lost',async()=>{
 const root=new Target(),status=new Target(),lists=new Target(),window=new Target(),requests=[],accepted=[];root.dataset={};root.querySelector=id=>id==='[data-closing-status]'?status:lists;
 const old={updatedAt:new Date(Date.now()-60000).toISOString(),stocks:[]},next={updatedAt:new Date(Date.now()-1000).toISOString(),stocks:[]};let release;
 const summary=value=>({asOf:value.updatedAt,priced:1,gainers:[],losers:[]});window.BooksDailyMovers={summarize:summary};window.BooksStockSelection={accept:value=>accepted.push(value.updatedAt),unavailable:()=>{throw Error('queued market read should complete');}};
 const document={querySelector:q=>q==='[data-closing-ranks]'?root:null,getElementById:()=>null,createElement:()=>new Target()};
 const fetch=async(path)=>{requests.push(path);if(path==='/api/a-share-daily/market')return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>old}));return {ok:true,json:async()=>path.includes('generation=')?next:summary(old)};};
 vm.runInNewContext(fs.readFileSync(require.resolve('../research-desk.js'),'utf8'),{document,window,fetch,Date,Intl,AbortController,setTimeout,clearTimeout});window.dispatchEvent({type:'books:refresh-selection',detail:{generation:'g2'}});window.dispatchEvent({type:'books:refresh-selection',detail:{generation:'g3'}});release();await settle();assert.equal(requests.at(-1),'/api/a-share-daily/market?generation=g3');assert.equal(requests.filter(path=>path.includes('generation=')).length,1);assert.equal(accepted.at(-1),next.updatedAt);
});
