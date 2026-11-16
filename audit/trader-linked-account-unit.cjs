'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const BinanceData=require('../trader/binance-data.js');
const trader=path.join(__dirname,'../trader');
const code=fs.readFileSync(path.join(trader,'plaza.js'),'utf8').split("for(const id of controls)$(id).addEventListener")[0].replace("(() => {","");
const snapshot=fs.readFileSync(path.join(trader,'binance/period-returns.json'),'utf8');
const id='4664928038467820544';
function fixture(id,replies){
  const elements=new Map(),opened=[],requested=[],notices=[];
  for(const [key,entries] of Object.entries({period:['365D'],exchange:['Binance'],source:['public'],sort:['roi'],currency:['USDT'],search:[],status:[]})){
    elements.set(key,{options:entries.map(value=>({value})),value:'',after(el){elements.set(el.id,el);}});
  }
  const context=vm.createContext({document:{getElementById:k=>elements.get(k)||null,createElement:()=>({setAttribute(){},set textContent(s){notices.push(s);}})},
    BinanceData,URL,AbortController,Blob,TextDecoder,location:{href:'https://example.org/trader/index.html?exchange=Binance&period=365D&account='+id},
    setTimeout:(fn,ms)=>{if(ms===450)queueMicrotask(fn);return 1;},clearTimeout(){},opened,
    async fetch(url){requested.push(url);const reply=replies.shift();assert.ok(reply,'unexpected extra request');return new Response(reply.body||'',{status:reply.status});}});
  vm.runInContext(code,context);
  // Record the identity that reaches the dialog. URL parsing, production validation, matching and retries are unchanged.
  vm.runInContext('openDetail=(row,period)=>opened.push([row.accountId,period]);readURL();openLinkedAccount();',context);
  return {opened,requested,notices,get pending(){return vm.runInContext('linkedAccount',context);},
    run:()=>vm.runInContext('refreshPeriodReturns().then(()=>openLinkedAccount(true))',context)};
}
test('a transient catalog failure opens the same verified account after one retry',async()=>{
  const f=fixture(id,[{status:503},{status:200,body:snapshot}]);
  await f.run();
  assert.deepEqual(f.requested,['binance/period-returns.json','binance/period-returns.json']);
  assert.equal(f.opened.length,1);assert.deepEqual([...f.opened[0]],[id,'365D']);assert.equal(f.pending,null);
  assert.ok(f.notices.some(message=>message.includes('正在重试')));
});
test('failed retry leaves a pending public ID recoverable on the next refresh',async()=>{
  const f=fixture(id,[{status:503},{status:503},{status:200,body:snapshot}]);
  await f.run();assert.equal(f.opened.length,0);assert.equal(f.pending,id);assert.ok(f.notices.at(-1).includes('可点击刷新'));
  await f.run();assert.deepEqual([...f.opened[0]],[id,'365D']);assert.equal(f.pending,null);
});
test('invalid JSON or a rejected schema is not treated as a transient network problem',async()=>{
  for(const body of ['<damaged>','{"accounts":[]}']){
    const f=fixture(id,[{status:200,body}]);await f.run();
    assert.equal(f.requested.length,1);assert.equal(f.opened.length,0);assert.equal(f.pending,id);
  }
});
test('an unknown valid-format ID stays outside the validated directory',async()=>{
  const missing='9999999999999999999',f=fixture(missing,[{status:503},{status:200,body:snapshot}]);
  await f.run();assert.equal(f.pending,null);assert.equal(f.opened.length,0);
  assert.ok(f.notices.at(-1).includes('没有找到'));
});
