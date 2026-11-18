'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const BinanceData=require('../trader/binance-data.js');
const BooksBitgetPeriodData=require('../trader/bitget-period-data.js');
const trader=path.join(__dirname,'../trader');
const code=fs.readFileSync(path.join(trader,'plaza.js'),'utf8').split("for(const id of controls)$(id).addEventListener")[0].replace("(() => {","");
const snapshot=fs.readFileSync(path.join(trader,'binance/period-returns.json'),'utf8');
const id='4664928038467820544';
function fixture(id,replies,params='exchange=Binance&period=365D',adapters={BinanceData}){
  const elements=new Map(),opened=[],requested=[],notices=[];
  for(const [key,entries] of Object.entries({period:['30D','365D'],exchange:['Binance','OKX'],source:['public'],sort:['roi'],currency:['USDT'],search:[],'public-list-status':[]})){
    elements.set(key,{options:entries.map(value=>({value})),value:'',after(el){elements.set(el.id,el);}});
  }
  const context=vm.createContext({document:{body:{dataset:{publicList:'true'}},getElementById:k=>elements.get(k)||null,
    createElement:()=>({setAttribute(){},set textContent(s){notices.push(s);}})},
    ...adapters,URL,AbortController,Blob,TextDecoder,location:{href:'https://example.org/trader/index.html?'+params+'&account='+id},
    setTimeout:(fn,ms)=>{if(ms===450)queueMicrotask(fn);return 1;},clearTimeout(){},opened,
    async fetch(url){requested.push(url);const reply=replies.shift();assert.ok(reply,'unexpected extra request');return new Response(reply.body||'',{status:reply.status});}});
  vm.runInContext(code,context);
  // Record the identity that reaches the dialog. URL parsing, production validation, matching and retries are unchanged.
  vm.runInContext('openDetail=(row,period,view)=>opened.push(view?[row.accountId,period,view]:[row.accountId,period]);readURL();openLinkedAccount();',context);
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
test('a newly published account opens directly without a hard-coded identity and preserves the detail period and view',async()=>{
  const added='9999999999999999998';
  const catalog=JSON.parse(snapshot);
  const sample=catalog.accounts.find(account=>account.portfolioId===id);
  catalog.accounts.push(JSON.parse(JSON.stringify(sample).replaceAll(id,added)));
  assert.equal(Object.hasOwn(BinanceData.PORTFOLIOS,added),false);
  const f=fixture(added,[{status:200,body:JSON.stringify(catalog)}],
    'exchange=OKX&period=30D&detailExchange=Binance&detailPeriod=365D&view=points');
  await f.run();
  assert.deepEqual([...f.opened[0]],[added,'365D','points']);
  assert.equal(f.pending,null);
});
test('a seventh valid Bitget account can open from a catalog larger than one MiB',async()=>{
  const catalog=JSON.parse(fs.readFileSync(path.join(trader,'bitget/period-returns.json'),'utf8'));
  const sample=catalog.accounts.find(account=>account.portfolioId==='1426773431891742720');
  const added='9999999999999999998';
  catalog.accounts.push(JSON.parse(JSON.stringify(sample).replaceAll(sample.portfolioId,added)));
  const body=JSON.stringify(catalog);
  assert.ok(Buffer.byteLength(body)>1024*1024);
  assert.equal(BooksBitgetPeriodData.parse(catalog).accounts.at(-1).portfolioId,added);
  const f=fixture(added,[{status:200,body}],'detailExchange=Bitget&detailPeriod=365D&view=positions',{BooksBitgetPeriodData});
  await f.run();
  assert.deepEqual(f.requested,['bitget/period-returns.json']);
  assert.deepEqual([...f.opened[0]],[added,'365D','positions']);
  assert.equal(f.pending,null);
});
