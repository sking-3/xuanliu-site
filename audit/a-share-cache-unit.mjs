import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {gzipSync,gunzipSync} from 'node:zlib';
import vm from 'node:vm';
import {createApp} from '../server/server.mjs';

const generation='2026-11-20T173000Z-1795195800000';
const lastSuccess={generation,day:'2026-11-20',asOf:'2026-11-20T08:15:00Z',finishedAt:'2026-11-20T09:35:00Z',total:120,ready:119};
const status={configured:true,schedule:'工作日16:30 北京时间',attempt:{status:'complete',stage:'published',day:'2026-11-20',total:120,checked:120,ready:119,missing:1,requests:121,startedAt:'2026-11-20T08:30:00Z',finishedAt:'2026-11-20T09:35:00Z',error:null,currentCode:null}};
function writeJson(file,value){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));}
async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'books-daily-cache-'));
  const app=createApp({siteDir:join(directory,'site'),aShareDir:join(directory,'cache')});
  const cache=join(directory,'cache');
  t.after(()=>{app.close();rmSync(directory,{recursive:true,force:true});});
  async function request(path,headers={},method='GET'){
    const response={headers:{},body:Buffer.alloc(0),setHeader(key,value){this.headers[key.toLowerCase()]=value;},
      writeHead(status,values){this.status=status;Object.assign(this.headers,values);return this;},
      end(body){this.body=Buffer.from(body||'');},json(){return JSON.parse(this.body);}};
    await app.handle({url:path,headers:{host:'localhost',...headers},method,socket:{}},response);
    return response;
  }
  function publish(name=generation,value={day:'2026-11-20',counts:{total:120,ready:119}}){
    const location=join(cache,'generations',name);mkdirSync(location,{recursive:true});
    for(const filename of ['result-consensus-20-120-000300.SH.json','result-market-60-all-399001.SZ.json','dataset-120-000300.SH.json','market.json']){
      writeJson(join(location,filename),value);writeFileSync(join(location,filename+'.gz'),gzipSync(JSON.stringify(value)));
    }
    writeJson(join(location,'complete.json'),{...lastSuccess,generation:name,completed:true});
    writeJson(join(cache,'current.json'),{...lastSuccess,generation:name});writeJson(join(cache,'status.json'),status);
  }
  return {app,cache,request,publish};
}
test('public cache state observes first collection while missing results return503 without any source request',async t=>{
  const f=await fixture(t),originalFetch=globalThis.fetch;let sourceCalls=0;
  globalThis.fetch=()=>{sourceCalls++;throw Error('external requests prohibited');};t.after(()=>{globalThis.fetch=originalFetch;});
  writeJson(join(f.cache,'status.json'),{...status,attempt:{...status.attempt,status:'running',checked:13}});
  const state=await f.request('/api/a-share-daily/state');assert.equal(state.status,200);assert.equal(state.headers['cache-control'],'no-cache');
  assert.equal(state.json().configured,true);assert.equal(state.json().available,false);assert.equal(state.json().attempt.checked,13);assert.equal(state.json().lastSuccess,null);
  for(const route of ['result','dataset','market'])assert.equal((await f.request('/api/a-share-daily/'+route)).status,503);
  assert.equal(sourceCalls,0);assert.equal((await f.request('/api/research-control/state')).status,401);
  assert.equal(f.app.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='research_control_runs'").get().count,0);
});
test('published cache preserves source dates and independent failed attempt without claiming fresh data',async t=>{
  const f=await fixture(t);f.publish();
  writeJson(join(f.cache,'status.json'),{...status,attempt:{...status.attempt,status:'failed',day:'2026-11-23',checked:8,error:'http_429'}});
  const state=(await f.request('/api/a-share-daily/state')).json();assert.equal(state.available,true);assert.equal(state.attempt.status,'failed');assert.deepEqual(state.lastSuccess,lastSuccess);
  const result=await f.request('/api/a-share-daily/result?mode=consensus&lookback=20&sampleSize=120&benchmark=000300.SH');
  assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-cache');assert.equal(result.json().day,'2026-11-20');assert.equal(result.json().counts.ready,119);
  assert.equal((await f.request('/api/a-share-daily/dataset?sampleSize=120&benchmark=000300.SH')).status,200);
  assert.equal((await f.request('/api/a-share-daily/market')).status,200);
});
test('gzip negotiation serves stored bytes and honors explicit q=0',async t=>{
  const f=await fixture(t);f.publish();
  const compressed=await f.request('/api/a-share-daily/market',{'accept-encoding':'br, gzip'});
  assert.equal(compressed.status,200);assert.equal(compressed.headers['content-encoding'],'gzip');assert.equal(compressed.headers.vary,'Accept-Encoding');
  assert.equal(JSON.parse(gunzipSync(compressed.body)).day,'2026-11-20');
  for(const encoding of ['identity','gzip;q=0','gzip;q=0, *;q=1']){
    const plain=await f.request('/api/a-share-daily/market',{'accept-encoding':encoding});assert.equal(plain.status,200);assert.equal(plain.headers['content-encoding'],undefined);assert.equal(plain.json().day,'2026-11-20');
  }
});
test('parameters are allowlisted and nonconsensus requests always use the full pool file',async t=>{
  const f=await fixture(t);f.publish();
  for(const query of ['mode=other','lookback=365','sampleSize=20','benchmark=600519.SH','command=run','mode=market&mode=strength','generation=..%2fsecret','generation=abc']){
    assert.equal((await f.request('/api/a-share-daily/result?'+query)).status,400,query);
  }
  assert.equal((await f.request('/api/a-share-daily/market?sampleSize=all')).status,400);
  assert.equal((await f.request('/api/a-share-daily/state?refresh=true')).status,400);
  assert.equal((await f.request('/api/a-share-daily/result?mode=market&lookback=60&sampleSize=120&benchmark=399001.SZ')).status,200);
  assert.equal((await f.request('/api/a-share-daily/state',{},'POST')).status,405);
  assert.equal((await f.request('/api/a-share-daily/unknown')).status,404);
});
test('only a pointer swap publishes a new generation and pinned old results remain consistent',async t=>{
  const f=await fixture(t);f.publish();const newer='2026-11-23T173000Z-1795455000000',location=join(f.cache,'generations',newer);
  mkdirSync(location,{recursive:true});writeJson(join(location,'market.json'),{day:'2026-11-23'});
  assert.equal((await f.request('/api/a-share-daily/market')).json().day,'2026-11-20');
  writeJson(join(location,'complete.json'),{...lastSuccess,generation:newer,day:'2026-11-23',completed:true});
  writeJson(join(f.cache,'current.tmp'),{...lastSuccess,generation:newer,day:'2026-11-23'});renameSync(join(f.cache,'current.tmp'),join(f.cache,'current.json'));
  assert.equal((await f.request('/api/a-share-daily/market')).json().day,'2026-11-23');
  assert.equal((await f.request('/api/a-share-daily/market?generation='+generation)).json().day,'2026-11-20');
  assert.equal((await f.request('/api/a-share-daily/market?generation=2026-11-24')).status,404);
});
test('partial generation files stay unreadable until a matching completed marker exists',async t=>{
  const f=await fixture(t);f.publish();const partial='2026-11-23T173000Z-1795455000000',location=join(f.cache,'generations',partial);
  mkdirSync(location,{recursive:true});
  for(const file of ['result-consensus-20-120-000300.SH.json','dataset-120-000300.SH.json','market.json'])writeJson(join(location,file),{day:'2026-11-23'});
  for(const route of ['result','dataset','market'])assert.equal((await f.request('/api/a-share-daily/'+route+'?generation='+partial)).status,404);
  assert.equal((await f.request('/api/a-share-daily/result?generation='+generation)).status,200);
  writeJson(join(f.cache,'current.json'),{...lastSuccess,generation:partial,day:'2026-11-23'});
  assert.equal((await f.request('/api/a-share-daily/state')).json().available,false);
  assert.equal((await f.request('/api/a-share-daily/result')).status,503);
  for(const completion of [{generation:partial,completed:false},{generation,completed:true}]){
    writeJson(join(location,'complete.json'),completion);assert.equal((await f.request('/api/a-share-daily/result?generation='+partial)).status,404);
  }
  writeJson(join(location,'complete.json'),{generation:partial,completed:true});
  assert.equal((await f.request('/api/a-share-daily/result?generation='+partial)).status,200);
  assert.equal((await f.request('/api/a-share-daily/result?generation='+generation)).status,200);
});
test('malformed worker files produce bounded cache errors without changing the lastGood pointer',async t=>{
  const f=await fixture(t);f.publish();const before=readFileSync(join(f.cache,'current.json'),'utf8');
  writeFileSync(join(f.cache,'status.json'),'not-json secret diagnostics');
  const response=await f.request('/api/a-share-daily/state');assert.equal(response.status,503);assert.deepEqual(response.json(),{error:'cache_read_failed'});
  assert.equal(readFileSync(join(f.cache,'current.json'),'utf8'),before);assert.equal((await f.request('/api/a-share-daily/market')).status,200);
});

class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.value='';this.textContent='';this.hidden=false;this.disabled=false;this.checked=false;}
  addEventListener(event,fn){this.listeners[event]=fn;}
  append(child){this.children.push(child);if(this.tagName==='SELECT'&&!this.value)this.value=child.value;}
  replaceChildren(){this.children=[];if(this.tagName==='SELECT')this.value='';}
  querySelectorAll(){return [];}
}
test('console polling updates only automation status and preserves the unsaved draft, active config and archive job UI',async()=>{
  const require=createRequire(import.meta.url),model=require('../control/model.js'),config=model.normalizeConfig({name:'服务器默认'});
  const directory=fileURLToPath(new URL('../control/',import.meta.url)),html=readFileSync(join(directory,'index.html'),'utf8');
  const elements=new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map(match=>[match[2],new Element(match[1])]));
  const documentEvents={},windowEvents={},timers=new Map(),requests=[];let timerId=0,automation=copy(status),failAutomation=false;
  const archiveState={currentRevision:1,activeRevision:1,activeConfig:config,config,versions:[{revision:1,config,createdAt:'2026-11-21T00:00:00Z'}],datasets:[],runs:[],job:null};
  const context={Intl,Date,JSON,Number,Set,Blob,AbortController,URL,console,
    document:{hidden:false,getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),addEventListener:(event,fn)=>{documentEvents[event]=fn;}},
    window:{BooksControlModel:model,addEventListener:(event,fn)=>{windowEvents[event]=fn;}},
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async path=>{requests.push(path);let body;if(path==='/api/auth/me')body={authenticated:true,user:{role:'admin',displayName:'测试管理员'}};
      else if(path==='/api/research-control/state')body=archiveState;
      else if(path==='/api/a-share-daily/state'){if(failAutomation)throw Error('unavailable');body={...automation,lastSuccess,available:true};}
      else throw Error('unexpected route '+path);return {ok:true,status:200,json:async()=>copy(body)};}
  };
  vm.runInNewContext(readFileSync(join(directory,'control.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(elements.get('automation-status').textContent,/2026-11-20/);assert.match(elements.get('capability-summary').textContent,/已配置/);
  elements.get('cfg-name').value='尚未保存的草稿';elements.get('config-form').listeners.input();const jobText=elements.get('job-status').textContent,configText=elements.get('config-compare').textContent;
  automation={...status,attempt:{...status.attempt,status:'running',checked:8}};
  const timer=[...timers.values()].find(value=>value.ms===30000);assert.ok(timer);await timer.fn();
  assert.match(elements.get('automation-status').textContent,/8\/120/);assert.equal(elements.get('cfg-name').value,'尚未保存的草稿');assert.equal(elements.get('job-status').textContent,jobText);assert.equal(elements.get('config-compare').textContent,configText);
  assert.equal(requests.filter(path=>path==='/api/research-control/state').length,1);
  failAutomation=true;await [...timers.values()].find(value=>value.ms===30000).fn();
  assert.match(elements.get('automation-status').textContent,/保留上次显示/);assert.match(elements.get('automation-status').textContent,/2026-11-20/);
  windowEvents.pagehide();assert.equal([...timers.values()].some(value=>value.ms===30000),false);
});
function copy(value){return JSON.parse(JSON.stringify(value));}
