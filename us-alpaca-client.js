/* Per-visitor IEX reads. Credentials and results stay in this page's memory. */
(function(root){
'use strict';
const nativeFetch=root.fetch.bind(root),STOP_KEY='books.us.alpaca.source-stop.v1',SOURCE='research:Alpaca',controllers=new Set(),cache=new Map();
let connection=null,epoch=0,nextAt=0,unauthorized=false,memoryStop=null,result=null,cacheBytes=0;
const verified=new Set(),object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),finite=v=>typeof v==='number'&&Number.isFinite(v),symbol=s=>typeof s==='string'&&/^[A-Z][A-Z0-9.-]{0,14}$/.test(s);
const fault=(code,extra={})=>Object.assign(Error(code),{code,...extra});
function day(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw fault('research_invalid_date');return s;}
function stamp(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s.slice(0,10)).toISOString().slice(0,10)===s.slice(0,10)&&Number(s.slice(11,13))<24;}
const cursor=s=>typeof s==='string'&&s.length>0&&s.length<=1024&&!/[\x00-\x20\x7f]/.test(s)&&!s.includes('://');
function stopRecord(){
 if(memoryStop)return memoryStop;let raw;try{raw=root.localStorage.getItem(STOP_KEY);}catch{throw fault('research_stop_storage_unavailable',{message:'无法读取本机来源停止记录，已阻止请求'});}
 if(raw!==null){try{const v=JSON.parse(raw);memoryStop={reason:['http_403','http_429'].includes(v?.reason)?v.reason:'stop_record_invalid'};}catch{memoryStop={reason:'stop_record_invalid'};}}return memoryStop;
}
function abortRequests(){epoch++;for(const c of controllers)c.abort();controllers.clear();}
function hold(reason){
 memoryStop={reason};try{root.localStorage.setItem(STOP_KEY,JSON.stringify({source:'Alpaca',reason,stoppedAt:new Date().toISOString()}));}catch{memoryStop.persistenceUnavailable=true;}abortRequests();
}
function freshResult(){if(typeof root.BooksResearchModel?.empty!=='function')throw fault('research_model_unavailable');return root.BooksResearchModel.empty();}
function localResult(){if(!result)result=freshResult();return result;}
function dispatchResult(){root.dispatchEvent(new CustomEvent('books-public-results',{detail:JSON.parse(JSON.stringify(localResult()))}));}
function disconnect(){abortRequests();connection=null;unauthorized=false;verified.clear();cache.clear();cacheBytes=0;result=null;if(root.BooksResearchModel?.empty)dispatchResult();return {connected:false,backgroundEnabled:false,ordersSent:0};}
function connect(value){
 if(!object(value)||Object.keys(value).some(k=>!['apiKey','apiSecret'].includes(k))||['apiKey','apiSecret'].some(k=>typeof value[k]!=='string'||!value[k].trim()||value[k].length>256||/[\x00-\x1f\x7f]/.test(value[k])))throw fault('research_invalid_credentials');
 disconnect();connection={apiKey:value.apiKey.trim(),apiSecret:value.apiSecret.trim(),savedAt:Date.now()};return {connected:true,saved:true,verified:false,provider:'Alpaca',feed:'iex',personalUse:true};
}
function assertSource(g){const stopped=stopRecord();if(stopped)throw fault('research_source_stopped',{reason:stopped.reason});if(unauthorized)throw fault('research_auth_failed',{reason:'http_401',message:'Alpaca Key / Secret无效，本轮已停止；请核对后重新连接'});if(!connection)throw fault('research_credentials_missing');if(g!==undefined&&g!==epoch)throw fault('research_read_cancelled');}
function symbols(p){if(!Array.isArray(p)||!p.length||p.length>30||new Set(p).size!==p.length||p.some(s=>!symbol(s)))throw fault('research_invalid_symbols');return p;}
function request(input,now){
 if(!object(input)||Object.keys(input).some(k=>!['provider','operation','params'].includes(k))||input.provider!=='Alpaca'||!['clock','calendar','snapshots','bars'].includes(input.operation)||!object(input.params))throw fault('research_invalid_request');
 const {operation,params:p}=input,q=new URLSearchParams();let url,ttl;
 if(operation==='clock'){if(Object.keys(p).length)throw fault('research_invalid_params');url='https://paper-api.alpaca.markets/v2/clock';ttl=10000;}
 else if(operation==='calendar'){
  if(Object.keys(p).some(k=>!['start','end'].includes(k)))throw fault('research_invalid_params');const start=day(p.start),end=day(p.end);if(start>end||Date.parse(end)-Date.parse(start)>370*86400000)throw fault('research_invalid_date');q.set('start',start);q.set('end',end);url='https://paper-api.alpaca.markets/v2/calendar?'+q;ttl=3600000;
 }else if(operation==='snapshots'){
  if(Object.keys(p).some(k=>k!=='symbols'))throw fault('research_invalid_params');q.set('symbols',symbols(p.symbols).join(','));q.set('feed','iex');url='https://data.alpaca.markets/v2/stocks/snapshots?'+q;ttl=5000;
 }else{
  if(Object.keys(p).some(k=>!['symbols','timeframe','start','end','pageToken'].includes(k))||p.timeframe!=='1Min')throw fault('research_invalid_params');symbols(p.symbols);
  if(!stamp(p.start)||!stamp(p.end)||Date.parse(p.start)>=Date.parse(p.end))throw fault('research_invalid_date');if(Date.parse(p.end)>now-60000)throw fault('research_end_too_recent');
  if('pageToken'in p&&!cursor(p.pageToken))throw fault('research_invalid_page');q.set('symbols',p.symbols.join(','));q.set('timeframe','1Min');q.set('start',new Date(p.start).toISOString());q.set('end',new Date(p.end).toISOString());q.set('feed','iex');q.set('adjustment','raw');q.set('limit','10000');q.set('sort','asc');if(p.pageToken)q.set('page_token',p.pageToken);url='https://data.alpaca.markets/v2/stocks/bars?'+q;ttl=60000;
 }
 return {url,ttl,operation,params:p};
}
function sample(v,kind){
 if(v==null)return null;if(!object(v)||!stamp(v.t))throw fault('research_schema');const keys=kind==='trade'?['p','s']:kind==='quote'?['bp','bs','ap','as']:['o','h','l','c','v'];
 if(keys.some(k=>!finite(v[k])||v[k]<0)||kind==='trade'&&v.p<=0||kind==='bar'&&(['o','h','l','c'].some(k=>v[k]<=0)||v.h<Math.max(v.o,v.c,v.l)||v.l>Math.min(v.o,v.c,v.h)))throw fault('research_schema');
 const out=Object.fromEntries(['t',...keys].map(k=>[k,v[k]]));if(kind==='bar')for(const k of ['vw','n'])if(k in v){if(v[k]!==null&&(!finite(v[k])||v[k]<0||k==='n'&&!Number.isInteger(v[k])))throw fault('research_schema');out[k]=v[k];}return out;
}
function normalize(req,v){
 const {operation,params:p}=req;if(operation==='clock'){if(!object(v)||typeof v.is_open!=='boolean'||!['timestamp','next_open','next_close'].every(k=>stamp(v[k])))throw fault('research_schema');return Object.fromEntries(['timestamp','is_open','next_open','next_close'].map(k=>[k,v[k]]));}
 if(operation==='calendar'){
  const seen=new Set();if(!Array.isArray(v)||v.length>400)throw fault('research_schema');return v.map(x=>{if(!object(x)||typeof x.date!=='string')throw fault('research_schema');const date=day(x.date);if(date<p.start||date>p.end||seen.has(date)||!['open','close'].every(k=>typeof x[k]==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(x[k]))||x.open>=x.close)throw fault('research_schema');seen.add(date);return {date,open:x.open,close:x.close};});
 }
 if(operation==='snapshots'){
  if(!object(v)||Object.keys(v).length>30||Object.keys(v).some(s=>!p.symbols.includes(s)))throw fault('research_schema');return Object.fromEntries(p.symbols.map(s=>{const x=v[s];if(x==null)return [s,null];if(!object(x))throw fault('research_schema');return [s,Object.fromEntries([['latestTrade','trade'],['latestQuote','quote'],['minuteBar','bar'],['dailyBar','bar'],['prevDailyBar','bar']].map(([k,kind])=>[k,sample(x[k],kind)]))];}));
 }
 if(!object(v)||!object(v.bars)||Object.keys(v.bars).some(s=>!p.symbols.includes(s))||!(v.next_page_token===null||cursor(v.next_page_token)))throw fault('research_schema');let count=0;const bars={};
 // Alpaca's end is inclusive. The consumer trims the end bar for half-open sessions.
 for(const [s,rows]of Object.entries(v.bars)){if(!Array.isArray(rows)||(count+=rows.length)>10000)throw fault('research_schema');bars[s]=rows.map(b=>{const out=sample(b,'bar');if(!out||Date.parse(out.t)<Date.parse(p.start)||Date.parse(out.t)>Date.parse(p.end))throw fault('research_schema');return out;});}return {bars,next_page_token:v.next_page_token};
}
async function bounded(response){
 const reader=response.body?.getReader();if(!reader)throw fault('research_schema');let size=0;const parts=[];for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>6000000){await reader.cancel();throw fault('research_response_too_large');}parts.push(chunk.value);}try{return JSON.parse(await new Blob(parts).text());}catch{throw fault('research_schema');}
}
function remember(key,value,ttl){
 const text=JSON.stringify(value);if(text.length>6000000)return;cache.set(key,{text,ttl,at:Date.parse(value.receivedAt)});cacheBytes+=text.length;
 while(cache.size>24||cacheBytes>8000000){const first=cache.keys().next().value;cacheBytes-=cache.get(first).text.length;cache.delete(first);}
}
async function read(input,signal){
 assertSource();const started=Date.now(),req=request(input,started),g=epoch,cached=cache.get(req.url);
 if(cached){if(started>=cached.at&&started-cached.at<cached.ttl)return {...JSON.parse(cached.text),cached:true};cacheBytes-=cached.text.length;cache.delete(req.url);}
 if(started<nextAt)throw fault('research_wait',{waitMs:nextAt-started});if(signal?.aborted)throw fault('research_read_cancelled');nextAt=started+500;
 const c=new AbortController(),abort=()=>c.abort();controllers.add(c);signal?.addEventListener('abort',abort,{once:true});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;c.abort();},20000);
 try{
  const response=await nativeFetch(req.url,{method:'GET',mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',headers:{'APCA-API-KEY-ID':connection.apiKey,'APCA-API-SECRET-KEY':connection.apiSecret},signal:c.signal});assertSource(g);
  if([403,429].includes(response.status)){const reason='http_'+response.status;hold(reason);throw fault('research_source_stopped',{reason});}
  if(response.status===401){unauthorized=true;verified.clear();abortRequests();throw fault('research_auth_failed',{reason:'http_401',message:'Alpaca Key / Secret无效，本轮已停止；请核对后重新连接'});}
  if(!response.ok)throw fault('research_http_'+response.status);
  const data=normalize(req,await bounded(response));assertSource(g);if(signal?.aborted)throw fault('research_read_cancelled');const completed=Date.now();
  if(!Number.isSafeInteger(completed)||completed<started)throw fault('research_clock_invalid');const value={provider:'Alpaca',operation:req.operation,receivedAt:new Date(completed).toISOString(),feed:'iex',coverage:'single_exchange',personalUse:true,redistributionAllowed:false,data};verified.add(req.operation);remember(req.url,value,req.ttl);return value;
 }catch(e){if(e.code)throw e;if(g!==epoch||signal?.aborted)throw fault('research_read_cancelled');throw fault('research_transport_error',{reason:timedOut?'timeout':'cors_or_network',message:timedOut?'Alpaca读取超时，本轮已停止':'浏览器无法直连Alpaca（CORS或网络错误）；未切换代理或重试'});
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controllers.delete(c);}
}
const localFields=['symbol','name','sourceTime','receivedAt','price','open','turnover','priceChange1m','minuteSourceTime','minuteStatus','kind','session','scope','date','minute','delaySeconds','historical','detectedAt','id','ratio','baselineDays','level'];
function localRecord(value,alert){
 if(!object(value)||value.market!=='us'||value.provider!=='Alpaca'||value.feed!=='iex'||value.coverage!=='single_exchange'||value.currency!=='USD'||!symbol(value.symbol)||!stamp(value.sourceTime)||!stamp(value.receivedAt))throw fault('research_invalid_result');
 const out={market:'us',provider:'Alpaca',source:'Alpaca',feed:'iex',coverage:'single_exchange',currency:'USD'};
 for(const k of localFields)if(k in value){const x=value[k];if(!['string','number','boolean'].includes(typeof x)||typeof x==='string'&&x.length>200||typeof x==='number'&&!finite(x))throw fault('research_invalid_result');out[k]=x;}
 if(!finite(out.price)||out.price<=0||'minuteSourceTime'in out&&!stamp(out.minuteSourceTime)||'detectedAt'in out&&!stamp(out.detectedAt)||'historical'in out&&typeof out.historical!=='boolean'||'delaySeconds'in out&&out.delaySeconds!==0)throw fault('research_invalid_result');
 if(alert&&(typeof out.id!=='string'||!out.id||!stamp(out.detectedAt)||!finite(out.ratio)||out.ratio<3||!finite(out.turnover)||out.turnover<0||!finite(out.priceChange1m)||!['watch','confirmed'].includes(out.level)||!Number.isInteger(out.baselineDays)||out.baselineDays<10||out.baselineDays>20))throw fault('research_invalid_result');return out;
}
function saveResult(input){
 if(!object(input)||input.schema!=='books.stock.workspace.v1'||input.audience!=='owner'||!Array.isArray(input.observations)||input.observations.length>2000||!Array.isArray(input.alerts)||input.alerts.length>500)throw fault('research_invalid_result');
 const observations=input.observations.map(x=>localRecord(x,false)),events=new Map(input.alerts.map(x=>{const next=localRecord(x,true);return [next.id,next];}));const next=localResult();next.observations=observations;next.alerts=[...events.values()];dispatchResult();return {saved:true,localOnly:true,uploaded:false,backgroundEnabled:false,ordersSent:0};
}
function status(){
 const stopped=stopRecord();return {providers:connection?[{provider:'Alpaca',saved:true,feed:'iex',savedAt:connection.savedAt,verified:verified.has('snapshots'),verifiedOperations:[...verified],personalUse:true,localOnly:true}]:[],stops:stopped?[{source:SOURCE,reason:stopped.reason}]:unauthorized?[{source:SOURCE,reason:'http_401'}]:[],backgroundEnabled:false,ordersSent:0,localOnly:true};
}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
async function bridgeFetch(path,init={}){
 try{
  if(typeof path!=='string'||!['/api/research/status','/api/research/read','/api/research/result'].includes(path)||!object(init)||Object.keys(init).some(k=>!['method','credentials','cache','redirect','headers','body','signal'].includes(k)))throw fault('research_invalid_request');
  const method=init.method||'GET';if(init.signal?.aborted)throw fault('research_read_cancelled');if(init.signal&&(typeof init.signal.addEventListener!=='function'||typeof init.signal.removeEventListener!=='function'))throw fault('research_invalid_request');
  if(path==='/api/research/status'){if(method!=='GET'||init.body!==undefined)throw fault('research_invalid_request');return json(status());}
  if(path==='/api/research/result'&&method==='GET'){if(init.body!==undefined)throw fault('research_invalid_request');return json(localResult());}
  if(method!=='POST'||typeof init.body!=='string'||init.body.length>8000000)throw fault('research_invalid_request');let input;try{input=JSON.parse(init.body);}catch{throw fault('research_invalid_request');}
  return json(path==='/api/research/read'?await read(input,init.signal):saveResult(input));
 }catch(e){return json({error:e.code||'research_request_failed',...(e.reason?{reason:e.reason}:{}),...(finite(e.waitMs)?{waitMs:e.waitMs}:{}),...(e.code&&e.message!==e.code?{message:e.message}:{})},400);}
}
root.BooksPublicMarket=Object.freeze({connect,disconnect,fetch:bridgeFetch});
})(window);
