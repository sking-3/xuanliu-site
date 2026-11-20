'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
class Target{
 constructor(){this.events={};this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.textContent='';this.children=[];}
 addEventListener(type,handler){(this.events[type]??=[]).push(handler);}
 dispatchEvent(event){for(const handler of this.events[event.type]||[])handler(event);}
 async fire(type){await Promise.all((this.events[type]||[]).map(handler=>handler({type})));}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
}
const settle=()=>new Promise(setImmediate);
function bridge(changes={}){
 const group=new Target(),window=new Target(),ids=Object.fromEntries(['trend-control-tools','trend-control-state','trend-export-data','trend-save-data','trend-load-config','trend-lookback','trend-sample','trend-benchmark','trend-max-return','trend-max-five','trend-max-deviation','trend-max-volume','trend-exclude-hot'].map(id=>[id,new Target()]));ids['trend-control-tools'].closest=()=>group;
 let loaded=false,loads=0;const calls=[],files=[],starts=[],raw={schema:'books.research.dataset.v1',day:'2026-11-20',records:[{stock:{code:'600000.SH'},source:{bars:[{date:'2026-11-20',close:123.456,volume:1000}]}}]};
 const config={name:'默认方案',settings:{mode:'strength',lookback:60,sampleSize:'240',benchmark:'399001.SZ',limits:{enabled:true,maxReturn20:15,maxReturn60:30,maxReturn5:8,maxDeviation:8,maxVolumeRatio:2.5}}};
 const app={getState:()=>({origin:'daily-cache',phase:'evaluated',generation:'g1',status:'complete',scopeUncovered:0}),getExportStatus:()=>({available:loaded,reason:'需要读取原始归档'}),loadDataset:async()=>{loads++;loaded=true;return raw;},exportDataset:()=>loaded?raw:null,start:async mode=>starts.push(mode),...changes};window.BooksTrendControllerApp=app;window.BooksControlModel={normalizeDataset:value=>value};
 const fetch=async(path,init)=>{calls.push({path,init});assert.ok(path.startsWith('/api/research-control/'));return {ok:true,json:async()=>path.endsWith('/state')?{activeConfig:config,activeRevision:7}:{saved:true}};};
 const document={getElementById:id=>ids[id],hidden:false,createElement:()=>({click(){files.push(this.download);}})};
 vm.runInNewContext(fs.readFileSync(require.resolve('../screening/control-bridge.js'),'utf8'),{window,document,fetch,Blob,URL:{createObjectURL:()=> 'blob:local',revokeObjectURL(){}},Event:class{constructor(type){this.type=type;}},setInterval:()=>1,clearInterval(){},setTimeout:()=>1});
 return {ids,app,calls,files,starts,raw,get loads(){return loads;}};
}
test('bridge waits for an explicit archive action, then loads actual raw data before download',async()=>{
 const s=bridge();await settle();assert.equal(s.loads,0);assert.equal(s.ids['trend-export-data'].disabled,false);await s.ids['trend-export-data'].fire('click');assert.equal(s.loads,1);assert.deepEqual(s.files,['books-research-dataset-2026-11-20.json']);assert.match(s.ids['trend-control-state'].textContent,/同代完整原始归档/);
});
test('server archive save uses the lazy real dataset rather than precomputed result metrics',async()=>{
 const s=bridge();await settle();await s.ids['trend-save-data'].fire('click');assert.equal(s.loads,1);const request=s.calls.find(c=>c.path.endsWith('/datasets'));assert.deepEqual(JSON.parse(request.init.body),{dataset:s.raw});assert.match(s.ids['trend-control-state'].textContent,/保存到服务器/);
});
test('raw archive failures remain visible and cannot create a file or server save',async()=>{
 const s=bridge({loadDataset:async()=>{throw Error('同代归档不可用');}});await settle();await s.ids['trend-export-data'].fire('click');assert.equal(s.files.length,0);assert.match(s.ids['trend-control-state'].textContent,/未导出：同代归档不可用/);assert.equal(s.calls.filter(c=>c.path.endsWith('/datasets')).length,0);
});
test('applying the latest default starts its selected cached mode after updating every setting',async()=>{
 const s=bridge();await settle();await s.ids['trend-load-config'].fire('click');assert.equal(s.calls.filter(c=>c.path.endsWith('/state')).length,2);assert.deepEqual(s.starts,['strength']);assert.equal(s.ids['trend-lookback'].value,'60');assert.equal(s.ids['trend-max-return'].value,'30');assert.equal(s.ids['trend-sample'].value,'240');assert.match(s.ids['trend-control-state'].textContent,/服务器v7.*仅使用本站日终缓存/);
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
