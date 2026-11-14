'use strict';
/* All credentials and provider data are synthetic. fetch is a local mock only. */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.join(__dirname,'..'),FILE=path.join(ROOT,'us-broker-quotes.js'),WATCH='books.stock.watchlist.v1';
const PAIR='a1'.repeat(32),BASE='http://127.0.0.1:19355',NOW=Date.parse('2026-11-15T12:00:00Z');
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.listeners={};this._text='';this.value='';this.disabled=false;}
 get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}set textContent(v){this._text=String(v);this.children=[];}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this._text='';this.children=[...nodes];}
 setAttribute(key,value){this.attrs[key]=String(value);}addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
}
function setup(options={}){
 let now=NOW,id=0;const nodes={},timers=new Map(),windowEvents={},documentEvents={},calls=[],writes=[],iexStops=[],modelCalls=[];
 for(const key of ['broker-pair-form','broker-pair','broker-status','broker-stop','broker-start','broker-read','broker-provider','broker-unpair','broker-quotes','broker-updated','broker-radar-note','broker-state-futu','broker-state-longbridge','broker-state-tiger'])nodes[key]=new Element();
 nodes['broker-provider'].value=options.provider||'futu';nodes['broker-stop'].disabled=true;nodes['broker-status'].textContent='尚未配对';nodes['broker-quotes'].textContent='等待真实行情，不预填价格';
 for(const provider of ['futu','longbridge','tiger'])nodes['broker-state-'+provider].textContent='未连接';
 const storage=new Map([[WATCH,JSON.stringify(options.watch??[{market:'us',symbol:'AAPL'}])]]);
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const document={hidden:false,getElementById:key=>nodes[key]||null,createElement:tag=>new Element(tag),addEventListener(type,fn){(documentEvents[type]??=[]).push(fn);}};
 const state=()=>({connectedProviders:['futu','longbridge','tiger'].map(provider=>({provider})),sourceStops:[]});
 const batch=(provider='futu',symbols=['AAPL'])=>({provider,receivedAt:new Date(now).toISOString(),quotes:symbols.map(symbol=>({provider,symbol,currency:'USD',price:123.45,sourceTime:new Date(now-(provider==='tiger'?900000:1000)).toISOString(),feed:'SYNTHETIC_FREE_FEED',delaySeconds:provider==='tiger'?900:0}))});
 const payload=(url,init)=>url.endsWith('/api/status')?state():(()=>{const input=JSON.parse(init.body);return batch(input.provider,input.symbols);})();
 const scope={Date:Clock,URL,Response,Headers,AbortController,TypeError,document,localStorage:{getItem:key=>storage.get(key)??null,setItem(key,value){writes.push({key,value});storage.set(key,value);}},setTimeout(fn,ms){const key=++id;timers.set(key,{fn,at:now+ms,ms});return key;},clearTimeout:key=>timers.delete(key),addEventListener(type,fn){(windowEvents[type]??=[]).push(fn);},BooksUsLive:{stop:reason=>iexStops.push(reason)},BooksResearchModel:{observations(...args){modelCalls.push(args);throw Error('Other-platform baselines must not be used');}},fetch:async(url,init)=>{calls.push({url,init});return options.fetch?options.fetch(url,init,{state,batch,payload}):Response.json(payload(url,init));}};
 scope.window=scope;vm.runInNewContext(fs.readFileSync(FILE,'utf8'),scope,{filename:'us-broker-quotes.js'});
 async function emit(events,type,event={}){for(const fn of events[type]||[])fn(event);await flush();}
 async function advance(ms){now+=ms;for(let i=0;i<20;i++){const due=[...timers].filter(([,timer])=>timer.at<=now).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);due[1].fn();await flush();}await flush();}
 return {scope,nodes,document,storage,timers,calls,writes,iexStops,modelCalls,batch,state,advance,get now(){return now;},async pair(value=PAIR){nodes['broker-pair'].value=value;return nodes['broker-pair-form'].onsubmit({preventDefault(){}});},read:()=>nodes['broker-read'].onclick(),async start(){nodes['broker-start'].onclick();await flush();},async unpair(){nodes['broker-unpair'].onclick();await flush();},async choose(provider){nodes['broker-provider'].value=provider;nodes['broker-provider'].onchange();await flush();},async hide(){document.hidden=true;await emit(documentEvents,'visibilitychange');},async show(){document.hidden=false;await emit(documentEvents,'visibilitychange');},event:(type,event)=>emit(windowEvents,type,event)};
}

test('public pairing form hides its code, links the fixed loopback service, and makes no startup request',()=>{
 const html=fs.readFileSync(path.join(ROOT,'us-live.html'),'utf8');assert.match(html,/<input\b[^>]*id="broker-pair"[^>]*type="password"/);assert.match(html,/http:\/\/127\.0\.0\.1:19355\//);assert.doesNotMatch(html,/<script\b[^>]*src=["']https?:/i);
 const h=setup();assert.equal(h.calls.length,0);assert.match(h.nodes['broker-quotes'].textContent,/等待真实行情/);assert.equal(h.writes.length,0);assert.deepEqual(Object.keys(h.scope.BooksBrokerLive),['stop']);
});

test('pairing clears the input immediately and retains the code only in RAM for fixed credential-omit requests',async()=>{
 const gate=deferred();const h=setup({fetch:async(_url,_init,tools)=>{await gate.promise;return Response.json(tools.state());}}),pending=h.pair();await flush();assert.equal(h.nodes['broker-pair'].value,'');assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,BASE+'/api/status');assert.equal(h.calls[0].init.method,'GET');assert.equal(h.calls[0].init.headers.Authorization,'Bearer '+PAIR);assert.doesNotMatch(h.calls[0].url,new RegExp(PAIR));gate.resolve();await pending;
 assert.match(h.nodes['broker-status'].textContent,/已配对/);assert.match(h.nodes['broker-state-futu'].textContent,/报价待核验/);assert.equal(h.writes.length,0);assert.equal(h.scope.BooksBrokerLive.pair,undefined);
});

test('all three readers use only the fixed loopback quote endpoint, safe fetch options and US symbols',async()=>{
 const h=setup({watch:[{market:'a',symbol:'600519'},{market:'us',symbol:'AAPL'},{market:'us',symbol:'AAPL'},{market:'us',symbol:'NVDA'}]});await h.pair();for(const provider of ['futu','longbridge','tiger']){await h.choose(provider);assert.equal(await h.read(),true);}
 assert.equal(h.calls.length,4);for(const call of h.calls){const u=new URL(call.url);assert.equal(u.origin,BASE);assert.ok(['/api/status','/api/quotes'].includes(u.pathname));assert.equal(call.init.mode,'cors');assert.equal(call.init.credentials,'omit');assert.equal(call.init.cache,'no-store');assert.equal(call.init.redirect,'error');assert.equal(call.init.headers.Authorization,'Bearer '+PAIR);assert.equal(u.search,'');if(u.pathname==='/api/quotes'){assert.equal(call.init.method,'POST');assert.equal(call.init.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(call.init.body).symbols,['AAPL','NVDA']);}}
 assert.equal(h.writes.length,0);assert.equal(h.modelCalls.length,0);assert.equal(h.iexStops.length,3);
});

test('missing or invalid pairing and empty or invalid watchlists cannot cause quote requests or seeded prices',async()=>{
 const h=setup();assert.equal(await h.read(),false);assert.equal(h.calls.length,0);await h.pair('not-a-pairing-code');assert.equal(h.calls.length,0);assert.equal(h.nodes['broker-pair'].value,'');assert.match(h.nodes['broker-status'].textContent,/配对码/);
 for(const watch of [[],[{market:'us',symbol:'AAPL/secret'}],Array.from({length:31},(_,i)=>({market:'us',symbol:'S'+i}))]){const x=setup({watch});await x.pair();assert.equal(await x.read(),false);assert.equal(x.calls.length,1);assert.equal(x.nodes['broker-quotes'].children.length,0);assert.doesNotMatch(x.nodes['broker-quotes'].textContent,/123\.45/);}
});

test('Futu polls at five seconds and hiding aborts a pending request and prevents every polling continuation',async()=>{
 let gate;const h=setup({fetch:async(url,init,tools)=>{if(url.endsWith('/api/status'))return Response.json(tools.state());if(!gate)return Response.json(tools.payload(url,init));return gate.promise;}});await h.pair();await h.start();assert.ok([...h.timers.values()].some(timer=>timer.ms===5000));assert.match(h.nodes['broker-status'].textContent,/每5秒/);
 gate=deferred();await h.advance(5000);const request=h.calls.at(-1);assert.equal(request.url,BASE+'/api/quotes');await h.hide();assert.equal(request.init.signal.aborted,true);assert.ok(![...h.timers.values()].some(timer=>[5000,30000].includes(timer.ms)));const old=h.nodes['broker-quotes'].textContent;gate.resolve(Response.json(h.batch()));await flush();assert.equal(h.timers.size,0);assert.equal(h.nodes['broker-quotes'].textContent,old);assert.match(h.nodes['broker-status'].textContent,/页面已隐藏/);const count=h.calls.length;await h.advance(60000);await h.show();await h.advance(60000);assert.equal(h.calls.length,count);assert.equal(h.nodes['broker-stop'].disabled,true);
});

test('Tiger remains explicitly fifteen-minute delayed even though the page polls every thirty seconds',async()=>{
 const h=setup({provider:'tiger'});await h.pair();await h.start();assert.match(h.nodes['broker-status'].textContent,/每30秒.*延迟快照/);assert.match(h.nodes['broker-quotes'].textContent,/约15分钟延迟/);assert.match(h.nodes['broker-quotes'].textContent,/900 秒/);assert.ok([...h.timers.values()].some(timer=>timer.ms===30000));assert.ok(![...h.timers.values()].some(timer=>timer.ms===5000));assert.doesNotMatch(h.nodes['broker-updated'].textContent,/实时/);await h.event('pagehide');
});

test('wrong Tiger delay values stop instead of silently relabelling or using a paid realtime source',async()=>{
 for(const delaySeconds of [0,undefined,15]){const h=setup({provider:'tiger',fetch:async(url,init,tools)=>{if(url.endsWith('/api/status'))return Response.json(tools.state());const data=tools.payload(url,init);data.quotes[0].delaySeconds=delaySeconds;return Response.json(data);}});await h.pair();assert.equal(await h.read(),false);assert.match(h.nodes['broker-status'].textContent,/延迟标识异常/);assert.equal(h.calls.length,2);assert.equal(h.nodes['broker-quotes'].children.length,0);assert.equal(h.timers.size,0);}
});

test('switching platforms aborts and isolates late quotes, never creating a combined provider or IEX baseline',async()=>{
 const gate=deferred();let pending=true;const h=setup({fetch:async(url,init,tools)=>url.endsWith('/api/status')?Response.json(tools.state()):pending?gate.promise:Response.json(tools.payload(url,init))});await h.pair();const first=h.read();await flush();const oldRequest=h.calls.at(-1);await h.choose('longbridge');assert.equal(oldRequest.init.signal.aborted,true);assert.equal(h.nodes['broker-quotes'].children.length,0);gate.resolve(Response.json(h.batch('futu')));assert.equal(await first,false);assert.match(h.nodes['broker-status'].textContent,/平台已切换/);pending=false;assert.equal(await h.read(),true);assert.match(h.nodes['broker-quotes'].textContent,/长桥/);assert.doesNotMatch(h.nodes['broker-quotes'].textContent,/富途牛牛|IEX/);assert.match(h.nodes['broker-radar-note'].textContent,/不生成放量信号/);assert.match(h.nodes['broker-radar-note'].textContent,/不会与原IEX或其他平台拼接/);assert.equal(h.modelCalls.length,0);assert.ok(h.calls.every(call=>call.url.startsWith(BASE+'/api/')));
});

test('a batch or row from another provider cannot be displayed under the selected platform',async()=>{
 for(const mutate of [data=>{data.provider='tiger';},data=>{data.quotes[0].provider='longbridge';},data=>{data.quotes[0].symbol='UNREQUESTED';},data=>{data.quotes.push({...data.quotes[0]});}]){const h=setup({fetch:async(url,init,tools)=>{if(url.endsWith('/api/status'))return Response.json(tools.state());const data=tools.payload(url,init);mutate(data);return Response.json(data);}});await h.pair();assert.equal(await h.read(),false);assert.equal(h.nodes['broker-quotes'].children.length,0);assert.match(h.nodes['broker-status'].textContent,/异常/);}
});

test('missing times and prices remain explicit and never become the receipt time, zero price or radar signal',async()=>{
 for(const change of [{sourceTime:null},{price:null},{missingRow:true}]){const h=setup({fetch:async(url,init,tools)=>{if(url.endsWith('/api/status'))return Response.json(tools.state());const data=tools.payload(url,init);if(change.missingRow)data.quotes=[];else Object.assign(data.quotes[0],change);return Response.json(data);}});await h.pair();assert.equal(await h.read(),true);const text=h.nodes['broker-quotes'].textContent;if(change.sourceTime===null){assert.match(text,/来源时间缺失/);assert.match(text,/时间待核/);assert.doesNotMatch(text,/已取得来源报价/);assert.doesNotMatch(text,new RegExp(new Date(h.now).toISOString()));}else if(change.price===null){assert.match(text,/价格缺失/);assert.match(text,/—/);assert.doesNotMatch(text,/123\.45/);}else{assert.match(text,/来源未返回此代码/);assert.doesNotMatch(text,/123\.45/);}assert.equal(h.modelCalls.length,0);assert.match(h.nodes['broker-radar-note'].textContent,/不生成放量信号/);}
});

test('malformed or missing source timestamps and invalid prices fail before rendering any invented values',async()=>{
 for(const change of [{sourceTime:undefined},{sourceTime:'not-a-date'},{price:0},{price:-1},{price:'123.45'},{price:undefined}]){const h=setup({fetch:async(url,init,tools)=>{if(url.endsWith('/api/status'))return Response.json(tools.state());const data=tools.payload(url,init);Object.assign(data.quotes[0],change);return Response.json(data);}});await h.pair();assert.equal(await h.read(),false);assert.equal(h.nodes['broker-quotes'].children.length,0);assert.match(h.nodes['broker-status'].textContent,/异常/);}
});

test('storage watchlist changes stop pending reads; unrelated storage changes do not stop an active poll',async()=>{
 const h=setup();await h.pair();await h.start();await h.event('storage',{key:'unrelated'});assert.ok([...h.timers.values()].some(timer=>timer.ms===5000));const count=h.calls.length;h.storage.set(WATCH,JSON.stringify([{market:'us',symbol:'NVDA'}]));await h.event('storage',{key:WATCH});assert.match(h.nodes['broker-status'].textContent,/自选已变更/);assert.equal(h.timers.size,0);await h.advance(60000);assert.equal(h.calls.length,count);assert.equal(h.writes.length,0);
});

test('pagehide aborts polling and destroys the RAM pairing code without restarting on return',async()=>{
 const h=setup();await h.pair();await h.start();const count=h.calls.length;await h.event('pagehide');assert.equal(h.timers.size,0);assert.equal(h.nodes['broker-pair'].value,'');await h.advance(60000);await h.show();assert.equal(h.calls.length,count);assert.equal(await h.read(),false);assert.equal(h.calls.length,count);assert.match(h.nodes['broker-status'].textContent,/配对码/);assert.equal(h.writes.length,0);
});

test('permission or rate-limit failures stop immediately with no alternate platform, paid call or scheduled retry',async()=>{
 for(const error of ['broker_permission_denied','broker_rate_limited','broker_source_stopped','broker_free_only_required']){const h=setup({fetch:async(url,_init,tools)=>url.endsWith('/api/status')?Response.json(tools.state()):Response.json({error},{status:400})});await h.pair();await h.start();assert.equal(h.timers.size,0);assert.equal(h.calls.length,2);assert.equal(h.nodes['broker-stop'].disabled,true);assert.doesNotMatch(h.nodes['broker-status'].textContent,/成功|已读取/);await h.advance(60000);assert.equal(h.calls.length,2);assert.equal(h.writes.length,0);}
});

test('a late pairing body cannot replace disconnected provider states after the user unpairs',async()=>{
 const body=deferred();const h=setup({fetch:async()=>({ok:true,status:200,headers:new Headers(),text:()=>body.promise})});const pairing=h.pair();await flush();await h.unpair();assert.match(h.nodes['broker-status'].textContent,/已断开/);body.resolve(JSON.stringify(h.state()));await pairing;assert.match(h.nodes['broker-status'].textContent,/已断开/);for(const provider of ['futu','longbridge','tiger'])assert.equal(h.nodes['broker-state-'+provider].textContent,'未配对');assert.equal(h.nodes['broker-pair'].value,'');assert.equal(h.timers.size,0);assert.equal(h.writes.length,0);
});
