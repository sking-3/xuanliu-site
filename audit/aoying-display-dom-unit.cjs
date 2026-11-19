'use strict';
// Exercise the actual orders renderer with a connected root; no network/trading.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const publicApi=require('../trader/public-executions.js');
class Node {
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.parent=null;this.classList={add(){}};}
 append(...children){for(const child of children){if(child instanceof Node)child.parent=this;this.children.push(child);}}
 setAttribute(){}
 addEventListener(){}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
 get isConnected(){return this.tag==='document-root'||!!this.parent?.isConnected;}
}
function all(node){return [node,...node.children.filter(x=>x instanceof Node).flatMap(all)];}
test('connected orders table persists page insertion time for actual displayed public rows',()=>{
 const memory=new Map(),env={BooksTradeReplayModel:{},BooksTradeReplayData:{create:()=>({})},BooksBinancePublicRecords:publicApi,
  localStorage:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)},document:{visibilityState:'visible',createElement:tag=>new Node(tag),createTextNode:text=>new Node('#text',text)}};
 let source=fs.readFileSync(require.resolve('../trader/trade-analysis.js'),'utf8');
 source=source.replace('env.BooksTradeAnalysis={render,dispose,','env.BooksTradeAnalysis={orders,render,dispose,');
 vm.runInNewContext(source,env);
 const root=new Node('document-root'),host=new Node('div');root.append(host);
 const stamp='2026-11-16T05:52:41.924Z',id='a'.repeat(64),row={id,createdAt:1794808241161,updatedAt:1794808241161,firstSeenAt:stamp};
 const event={id,time:1794808241161,symbol:'BTCUSDT',action:'减多',side:'sell',price:64558,quantity:1,quote:'USDT',pnl:0,fee:null,firstSeenAt:stamp,orderId:null};
 env.BooksTradeAnalysis.orders({context:{r:{exchange:'Binance',sourceKind:'copy_trade',accountId:publicApi.ID}},archiveSource:'official',records:{checkedAt:stamp,allRows:[row]}},host,[event]);
 const result=JSON.parse(memory.get('books.aoying-public-display-audit.v1'));
 assert.equal(result.entries[id].collectorFirstSeenAt,stamp);
 assert.equal(result.entries[id].kind,'initial_page_load');
 assert.ok(all(host).some(n=>n.textContent==='本机页面首次写入'));
 assert.ok(all(host).some(n=>n.textContent&&n.textContent.includes('首次打开时已有的记录为基线')));
});

test('Aoying shows the profile trade time, archived trade time and collection time independently',()=>{
 const env={BooksTradeReplayModel:{summary:()=>({count:0,bySymbol:[]})},BooksTradeReplayData:{create:()=>({})},
  document:{createElement:tag=>new Node(tag)}};
 let source=fs.readFileSync(require.resolve('../trader/trade-analysis.js'),'utf8');
 source=source.replace('env.BooksTradeAnalysis={render,dispose,','env.BooksTradeAnalysis={analysis,status,render,dispose,');
 vm.runInNewContext(source,env);
 const root=new Node('document-root'),profileAt='2026-11-16T05:50:42Z',updatedAt=Date.parse('2026-11-19T07:03:11Z'),checkedAt='2026-11-19T07:14:01Z';
 const profile={lastTradeAt:profileAt,fetchedAt:'2026-11-16T07:36:39Z',status:'stale'};
 const c={root,context:{r:{exchange:'Binance',sourceKind:'copy_trade',accountId:publicApi.ID},profile,period:'30D',analysisPeriods:[]},cycles:[],events:[],
  records:{checkedAt,stopped:true,stopReason:'http_429',allRows:[{updatedAt}]}};
 env.BooksTradeAnalysis.analysis(c);
 const facts=all(root).find(n=>n.className==='ta-account-facts');
 const displayTime=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 assert.deepEqual(facts.children.slice(-2).map(n=>n.children.map(value=>value.textContent)),[
  ['组合资料最近交易',displayTime(profileAt)],['最新归档成交更新',displayTime(updatedAt)]
 ]);
 const status=env.BooksTradeAnalysis.status(c);
 assert.match(status,/成交采集已暂停（429）/);
 assert.ok(status.includes(displayTime(checkedAt)));
 assert.ok(!status.includes(displayTime(updatedAt)));
});
