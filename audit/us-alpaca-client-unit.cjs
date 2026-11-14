'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','us-alpaca-client.js'),'utf8');
const credentials={apiKey:'SYNTHETIC_KEY',apiSecret:'SYNTHETIC_SECRET'},STOP_KEY='books.us.alpaca.source-stop.v1';
const tradeTime='2026-11-13T15:31:09.123456789Z';
const bar=()=>({t:'2026-11-12T15:30:00Z',o:100,h:103,l:99,c:102,v:450,vw:101.5,n:9,apiSecret:'SYNTHETIC_UPSTREAM_SECRET'});
const snapshot=()=>({AAPL:{latestTrade:{t:tradeTime,p:102.1,s:1,apiSecret:'SYNTHETIC_UPSTREAM_SECRET'},latestQuote:{t:tradeTime,bp:102,bs:1,ap:102.2,as:2},minuteBar:{...bar(),t:'2026-11-13T15:30:00Z'},unknown:'SYNTHETIC_UPSTREAM_SECRET'}});
const clock=()=>({timestamp:'2026-11-13T10:31:10-05:00',is_open:true,next_open:'2026-11-16T09:30:00-05:00',next_close:'2026-11-13T16:00:00-05:00',apiSecret:'SYNTHETIC_UPSTREAM_SECRET'});
const request=(operation,params={})=>({provider:'Alpaca',operation,params});
const snapshots=request('snapshots',{symbols:['AAPL','BRK.B']}),clockInput=request('clock'),bars=request('bars',{symbols:['AAPL'],timeframe:'1Min',start:'2026-11-12T14:30:00Z',end:'2026-11-12T16:00:00Z'}),calendar=request('calendar',{start:'2026-11-01',end:'2026-11-13'});
function setup(options={}){
 let time=Date.parse('2026-11-13T15:31:10Z'),timerId=0;const calls=[],storage=options.storage||new Map(),writes=[],events=[],timers=new Map();
 class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
 const payload=url=>url.includes('/snapshots')?snapshot():url.includes('/clock')?clock():url.includes('/calendar')?[{date:'2026-11-12',open:'09:30',close:'16:00',secret:'SYNTHETIC_UPSTREAM_SECRET'}]:{bars:{AAPL:[bar()]},next_page_token:null};
 const tools={advance(ms){time+=ms;},payload};
 const scope={Date:Clock,Response,Blob,URLSearchParams,AbortController,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},localStorage:{getItem(key){if(options.storageDenied)throw Error('blocked');return storage.get(key)??null;},setItem(key,value){writes.push({key,value});storage.set(key,value);}},dispatchEvent(event){events.push(event);},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},BooksResearchModel:{empty(){return {schema:'books.stock.workspace.v1',audience:'owner',publishedAt:new Date(time).toISOString(),markets:{a:{status:'not_configured',rows:[]},us:{status:'not_configured',rows:[]}},observations:[],alerts:[],execution:{backgroundEnabled:false,realOrdersSent:0}};}},fetch:async(url,init)=>{calls.push({url,init});if(options.fetch)return await options.fetch(url,init,tools);return Response.json(payload(url));}};
 scope.window=scope;vm.runInNewContext(source,scope);const bridge=scope.BooksPublicMarket;
 const read=async(input,init={})=>{const response=await bridge.fetch('/api/research/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),...init});return {response,value:await response.json()};};
 const local=async(method='GET',body)=>{const response=await bridge.fetch('/api/research/result',{method,...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,value:await response.json()};};
 return {bridge,calls,storage,writes,events,timers,read,local,scope,advance:tools.advance,get now(){return time;},connect(){return bridge.connect(credentials);},async status(){return await(await bridge.fetch('/api/research/status')).json();}};
}

test('bridge exports only explicit actions, performs no startup read, and never stores or returns credentials',async()=>{
 const h=setup();assert.deepEqual(Object.keys(h.bridge),['connect','disconnect','fetch']);assert.ok(Object.isFrozen(h.bridge));assert.equal(h.calls.length,0);assert.equal(h.connect().verified,false);
 assert.equal(h.writes.length,0);const status=await h.status();assert.equal(status.providers[0].saved,true);assert.equal(status.providers[0].verified,false);assert.doesNotMatch(JSON.stringify(status)+JSON.stringify(h.events.map(x=>x.detail)),/SYNTHETIC|apiKey|apiSecret/);assert.equal(h.bridge.apiSecret,undefined);
 await h.read(snapshots);assert.equal((await h.status()).providers[0].verified,true);h.bridge.disconnect();assert.equal((await h.status()).providers.length,0);assert.equal(h.writes.length,0);assert.equal(h.timers.size,0);
});

test('vendor reads use fixed official GET URLs and CORS omit, never proxy or caller headers',async()=>{
 const h=setup();h.connect();for(const input of [snapshots,clockInput,bars,calendar]){h.advance(500);const out=await h.read(input,{headers:{Authorization:'NEVER_FORWARD',Cookie:'NEVER_FORWARD'}});assert.equal(out.response.status,200);}
 assert.equal(h.calls.length,4);for(const {url,init}of h.calls){const u=new URL(url);assert.ok(['data.alpaca.markets','paper-api.alpaca.markets'].includes(u.hostname));assert.equal(u.protocol,'https:');assert.equal(init.method,'GET');assert.equal(init.mode,'cors');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.body,undefined);assert.deepEqual({...init.headers},{'APCA-API-KEY-ID':'SYNTHETIC_KEY','APCA-API-SECRET-KEY':'SYNTHETIC_SECRET'});assert.doesNotMatch(url,/SYNTHETIC|NEVER_FORWARD/);}
 assert.equal(h.calls[0].url,'https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL%2CBRK.B&feed=iex');assert.equal(h.calls[1].url,'https://paper-api.alpaca.markets/v2/clock');assert.equal(new URL(h.calls[2].url).searchParams.get('feed'),'iex');assert.equal(new URL(h.calls[2].url).searchParams.get('adjustment'),'raw');
});

test('all URLs, methods, operations, feeds and stock params are closed before any outbound request',async()=>{
 const h=setup();h.connect();
 for(const resource of ['https://evil.example/api/research/read','/api/research/read?url=https://evil.example','/api/research/credentials','/api/research/read/','/api/research/status#x',new URL('https://evil.example')])assert.equal((await h.bridge.fetch(resource)).status,400);
 for(const [url,init]of [['/api/research/read',{method:'GET'}],['/api/research/status',{method:'POST',body:'{}'}],['/api/research/result',{method:'DELETE'}],['/api/research/read',{method:'POST',body:'{bad'}],['/api/research/read',{method:'POST',body:'{}',url:'https://evil.example'}]])assert.equal((await h.bridge.fetch(url,init)).status,400);
 const invalid=[{...snapshots,provider:'Massive'},{...snapshots,url:'https://evil.example'},request('orders'),request('bars',{...bars.params,timeframe:'1Day'}),request('bars',{...bars.params,feed:'sip'}),request('bars',{...bars.params,pageToken:'https://evil.example'}),request('bars',{...bars.params,pageToken:'bad\n'}),request('bars',{...bars.params,end:new Date(h.now).toISOString()}),request('snapshots',{symbols:[]}),request('snapshots',{symbols:['AAPL','AAPL']}),request('snapshots',{symbols:Array.from({length:31},(_,i)=>'F'+i)}),request('snapshots',{symbols:['AAPL'],feed:'iex'}),request('snapshots',{symbols:['AAPL/USD']}),request('clock',{url:'https://evil.example'}),request('calendar',{start:'2026-02-30',end:'2026-11-13'})];
 for(const input of invalid)assert.equal((await h.read(input)).response.status,400);assert.equal(h.calls.length,0);
});

test('credential validation rejects extra routing fields and control characters without storing them',()=>{
 const h=setup();for(const input of [{...credentials,url:'https://evil.example'},{...credentials,apiKey:''},{...credentials,apiSecret:'bad\n'},{apiKey:'x'},null])assert.throws(()=>h.bridge.connect(input));assert.equal(h.writes.length,0);assert.equal(h.calls.length,0);
});

test('normalizers preserve nanosecond source time, real zero quotes and explicit missing samples while stripping extras',async()=>{
 const h=setup({fetch:async()=>Response.json({AAPL:{latestTrade:{t:tradeTime,p:102.1,s:1,secret:'SYNTHETIC'},latestQuote:{t:tradeTime,bp:0,bs:0,ap:0,as:0}}})});h.connect();const {value}=await h.read(snapshots);assert.equal(value.data.AAPL.latestTrade.t,tradeTime);assert.equal(value.data.AAPL.latestQuote.ap,0);assert.equal(value.data.AAPL.minuteBar,null);assert.equal(value.data['BRK.B'],null);assert.equal(value.feed,'iex');assert.equal(value.coverage,'single_exchange');assert.equal(value.personalUse,true);assert.equal(value.redistributionAllowed,false);assert.doesNotMatch(JSON.stringify(value),/SYNTHETIC|secret/);
});

test('malformed vendor timestamps/numbers/symbols cannot become invented quote or bar values',async()=>{
 const cases=[{...snapshot(),UNKNOWN:{latestTrade:{t:tradeTime,p:1,s:1}}},{AAPL:{latestTrade:{t:'2026-02-30T10:00:00Z',p:1,s:1}}},{AAPL:{latestTrade:{t:tradeTime,p:null,s:1}}},{AAPL:{latestTrade:{t:tradeTime,p:0,s:1}}},{AAPL:{latestQuote:{t:tradeTime,bp:1,bs:1,ap:2,as:null}}}];
 for(const payload of cases){const h=setup({fetch:async()=>Response.json(payload)});h.connect();const out=await h.read(snapshots);assert.equal(out.value.error,'research_schema');assert.equal((await h.status()).providers[0].verified,false);assert.equal(h.calls.length,1);}
 const h=setup({fetch:async()=>Response.json({bars:{AAPL:[{...bar(),v:null}]},next_page_token:null})});h.connect();assert.equal((await h.read(bars)).value.error,'research_schema');
});

test('inclusive API end bar reaches the consumer, while later and earlier rows fail closed',async()=>{
 const h=setup({fetch:async()=>Response.json({bars:{AAPL:[{...bar(),t:bars.params.end}]},next_page_token:null})});h.connect();assert.equal((await h.read(bars)).response.status,200);
 for(const time of ['2026-11-12T16:00:00.001Z','2026-11-12T14:29:59Z']){const bad=setup({fetch:async()=>Response.json({bars:{AAPL:[{...bar(),t:time}]},next_page_token:null})});bad.connect();assert.equal((await bad.read(bars)).value.error,'research_schema');}
});

test('snapshot/clock/bars cache uses 5s/10s/60s from response completion and preserves original receipt',async()=>{
 for(const [input,ttl]of [[snapshots,5000],[clockInput,10000],[bars,60000]]){
  const h=setup({fetch:async(url,init,tools)=>{tools.advance(1200);return Response.json(tools.payload(url));}});h.connect();const start=h.now,first=(await h.read(input)).value;assert.equal(first.receivedAt,new Date(start+1200).toISOString());
  h.advance(ttl-1);const cached=(await h.read(input)).value;assert.equal(cached.cached,true);assert.equal(cached.receivedAt,first.receivedAt);assert.equal(h.calls.length,1);
  h.advance(1);const next=(await h.read(input)).value;assert.equal(next.cached,undefined);assert.equal(h.calls.length,2);assert.notEqual(next.receivedAt,first.receivedAt);
 }
});

test('500ms source budget is shared by operations and survives reconnect; it never retries internally',async()=>{
 const h=setup();h.connect();await h.read(snapshots);let out=await h.read(clockInput);assert.equal(out.value.error,'research_wait');assert.equal(out.value.waitMs,500);assert.equal(h.calls.length,1);h.advance(499);out=await h.read(clockInput);assert.equal(out.value.waitMs,1);h.advance(1);assert.equal((await h.read(clockInput)).response.status,200);assert.equal(h.calls.length,2);
 h.bridge.connect({...credentials,apiKey:'SYNTHETIC_NEW'});assert.equal((await h.read(snapshots)).value.error,'research_wait');assert.equal(h.calls.length,2);h.advance(500);await h.read(snapshots);assert.equal(h.calls.length,3);
});

test('403/429 persist only a safe source stop, hold caches, and cannot be cleared by changing keys or reloading',async()=>{
 for(const status of [403,429]){
  let requests=0;const h=setup({fetch:async(url,init,tools)=>++requests===1?Response.json(tools.payload(url)):new Response('SYNTHETIC_SECRET',{status})});h.connect();await h.read(snapshots);h.advance(500);const rejected=await h.read(clockInput);assert.equal(rejected.value.error,'research_source_stopped');assert.equal(rejected.value.reason,'http_'+status);assert.equal(h.writes.length,1);assert.equal(h.writes[0].key,STOP_KEY);assert.doesNotMatch(h.writes[0].value,/SYNTHETIC|apiKey|apiSecret/);
  h.bridge.connect({...credentials,apiKey:'SYNTHETIC_NEW'});h.advance(100000);assert.equal((await h.read(snapshots)).value.error,'research_source_stopped');assert.equal(h.calls.length,2);const reload=setup({storage:h.storage});reload.connect();assert.equal((await reload.read(snapshots)).value.error,'research_source_stopped');assert.equal(reload.calls.length,0);
 }
});

test('401 holds only this credential session, explains authentication and never stores credentials or retries',async()=>{
 let count=0;const h=setup({fetch:async(url,init,tools)=>++count===1?new Response('SYNTHETIC_SECRET',{status:401}):Response.json(tools.payload(url))});h.connect();const out=await h.read(snapshots);assert.equal(out.value.error,'research_auth_failed');assert.match(out.value.message,/Key.*Secret无效/);assert.doesNotMatch(JSON.stringify(out.value),/SYNTHETIC/);h.advance(100000);assert.equal((await h.read(clockInput)).value.error,'research_auth_failed');assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);
 h.bridge.connect({...credentials,apiSecret:'SYNTHETIC_CORRECTED'});assert.equal((await h.read(snapshots)).response.status,200);assert.equal(h.calls.length,2);
});

test('CORS/network errors are sanitized and never fall back to a proxy or alternative host',async()=>{
 const h=setup({fetch:async()=>{throw new TypeError('SYNTHETIC_SECRET https://secret.invalid');}});h.connect();const out=await h.read(snapshots);assert.equal(out.value.error,'research_transport_error');assert.equal(out.value.reason,'cors_or_network');assert.match(out.value.message,/CORS或网络/);assert.doesNotMatch(JSON.stringify(out.value),/SYNTHETIC|secret.invalid/);assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);assert.equal(h.timers.size,0);
});

test('storage permission failures fail closed instead of bypassing unknown prior source stops',async()=>{
 const h=setup({storageDenied:true});h.connect();assert.equal((await h.read(snapshots)).value.error,'research_stop_storage_unavailable');assert.equal(h.calls.length,0);
 const corrupt=setup({storage:new Map([[STOP_KEY,'not JSON']])});corrupt.connect();assert.equal((await corrupt.read(snapshots)).value.reason,'stop_record_invalid');assert.equal(corrupt.calls.length,0);
});

test('local results never perform network uploads, discard daily payloads and secrets, and emit isolated copies',async()=>{
 const h=setup(),initial=(await h.local()).value;const q={market:'us',provider:'Alpaca',source:'Alpaca',feed:'iex',coverage:'single_exchange',currency:'USD',symbol:'AAPL',price:102,sourceTime:tradeTime,receivedAt:'2026-11-13T15:31:10Z',kind:'latest_trade',apiSecret:'SYNTHETIC_SECRET'};
 const a={...q,id:'us|Alpaca|iex|AAPL|2026-11-13T15:30:00.000Z',sourceTime:'2026-11-13T15:30:00Z',kind:'volume_acceleration',detectedAt:'2026-11-13T15:31:10Z',ratio:4,baselineDays:20,turnover:400,priceChange1m:.02,level:'confirmed',historical:true};
 const input={...initial,apiKey:'SYNTHETIC_KEY',observations:[q],alerts:[a,a],markets:{us:{rows:[{untrusted:'SYNTHETIC_SECRET'}]}}};const saved=await h.local('POST',input);assert.equal(saved.value.localOnly,true);assert.equal(saved.value.uploaded,false);assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
 const out=(await h.local()).value;assert.equal(out.alerts.length,1);assert.equal(out.observations[0].sourceTime,tradeTime);assert.equal(out.alerts[0].historical,true);assert.equal(out.markets.us.rows.length,0);assert.equal(out.publishedAt,initial.publishedAt);assert.doesNotMatch(JSON.stringify(out),/SYNTHETIC|apiSecret/);
 const event=h.events.at(-1);assert.equal(event.type,'books-public-results');event.detail.observations[0].price=999;assert.equal((await h.local()).value.observations[0].price,102);h.bridge.disconnect();assert.equal((await h.local()).value.observations.length,0);
});

test('disconnect aborts requests and destroys RAM keys and caches before late responses can return',async()=>{
 let release;const h=setup({fetch:async()=>await new Promise(resolve=>{release=()=>resolve(Response.json(snapshot()));})});h.connect();const pending=h.read(snapshots);for(let i=0;i<10&&!release;i++)await Promise.resolve();assert.ok(release);const call=h.calls[0];assert.equal([...h.timers.values()][0].ms,20000);h.bridge.disconnect();assert.equal(call.init.signal.aborted,true);release();const out=await pending;assert.notEqual(out.response.status,200);assert.equal((await h.status()).providers.length,0);assert.equal(h.timers.size,0);assert.equal(h.writes.length,0);
});

test('local result and unsupported reads cannot be used to inject nonfinite radar records',async()=>{
 const h=setup(),empty=(await h.local()).value;for(const input of [{...empty,observations:Array(2001).fill({})},{...empty,alerts:Array(501).fill({})},{...empty,observations:[{market:'a',symbol:'600519'}]}])assert.equal((await h.local('POST',input)).value.error,'research_invalid_result');assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
});
