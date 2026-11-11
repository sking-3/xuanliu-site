'use strict';
// Synthetic cases exist only in this test process. Production snapshots are real.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const M=require('../trader/trade-replay-model.js'),Data=require('../trader/trade-replay-data.js'),Public=require('../trader/public-executions.js');
const t=Date.now()-1000000;
const bn=(i,extra={})=>({symbol:'ETHUSDT',side:'BUY',positionSide:'LONG',executedQty:'0.1',avgPrice:'2000',totalPnl:'0',orderTime:t+i*1000,orderUpdateTime:t+i*1000,...extra});
const hl=(i,start,quantity,side='B',extra={})=>({coin:'ETH',side,sz:quantity,px:'2000',time:t+i*1000,startPosition:start,closedPnl:'0',fee:'0.1',feeToken:'USDC',tid:i,oid:i,...extra});
test('unknown Binance baseline never becomes a real position or a closed cycle',()=>{
 const es=M.binanceEvents([bn(1),bn(2),bn(3,{side:'SELL',executedQty:'0.2'})]),c=M.cycles(es)[0];
 assert.equal(c.observedChange,'0');assert.match(c.status,/期初未知/);assert.equal(c.closed,undefined);assert.equal(c.opened,undefined);assert.equal(c.quantity,null);
});
test('quantity arithmetic handles decimal cancellation and tiny signed balances exactly',()=>{
 assert.equal(M.add('0.1','0.2'),'0.3');assert.equal(M.add('0.3','-0.30000000000000000001'),'-0.00000000000000000001');
 const es=M.hyperliquidEvents([hl(1,'0','0.1'),hl(2,'0.1','0.2'),hl(3,'0.3','0.3','A')]);assert.equal(es[2].endPosition,'0');assert.equal(M.cycles(es)[0].status,'样本内闭合');
});
test('unresolved record versions remain visible without an invented net quantity',()=>{
 const es=M.binanceEvents([bn(1,{id:'a',identity:'same'}),bn(2,{id:'b',identity:'same',executedQty:'0.2'})]);
 assert.equal(es.length,2);assert.equal(M.cycles(es)[0].observedChange,null);assert.equal(M.cycles(es)[0].pnl,null);
});
test('official aggregates associate real observations but never manufacture entry or exit events',()=>{
 const es=M.binanceEvents([bn(2)]),raw={symbol:'ETHUSDT',side:'Long',opened:t,closed:t+3000,avgCost:'1900',avgClosePrice:'2100',closedVolume:'1',closingPnl:'200',status:'All Closed'};
 const [c]=M.cycles(es,[raw]);assert.equal(c.official,true);assert.equal(c.pnl,200);assert.equal(c.events.length,1);assert.equal(c.events[0].price,'2000');assert.equal(c.quantity,'1');
 assert.equal(M.cycles([], [raw])[0].events.length,0);
});
test('Hyperliquid duplicate fills and spot records cannot inflate reconstructed perpetual size',()=>{
 const a=hl(1,'0','1'),es=M.hyperliquidEvents([a,{...a},hl(2,'1','1','A'),hl(3,'0','10','B',{coin:'@1'})]);assert.equal(es.length,2);assert.equal(M.cycles(es).length,1);
});
test('nonzero initial position and missing middle fills do not acquire a complete cycle label',()=>{
 let cs=M.cycles(M.hyperliquidEvents([hl(1,'5','1'),hl(2,'6','6','A')]));assert.match(cs[0].status,/左侧缺失/);
 cs=M.cycles(M.hyperliquidEvents([hl(1,'0','1'),hl(2,'4','4','A')]));assert.equal(cs.length,2);assert.ok(cs.every(c=>c.status!=='样本内闭合'));
});
test('position reversals are explicit boundaries with no fabricated round-trip statistics',()=>{
 const es=M.hyperliquidEvents([hl(1,'0','1'),hl(2,'1','2','A'),hl(3,'-1','1','B')]),cs=M.cycles(es);assert.equal(es[1].effect,'reverse');assert.equal(cs.length,2);assert.ok(cs.every(c=>c.status!=='样本内闭合'));
});
test('malformed OHLC and duplicate candle timestamps fail closed',()=>{
 assert.throws(()=>M.candles([[t,'10','9','8','10']], 'binance'),/schema/);
 assert.throws(()=>M.candles([[t,'10','11','9','10'],[t,'10','11','9','10']], 'binance'),/schema/);
 assert.deepEqual(M.candles([[t,'10','11','9','10']], 'binance')[0],{time:Math.floor(t/1000),open:10,high:11,low:9,close:10});
});
function environment(fetch){const map=new Map();return {fetch,BooksTradeReplayModel:M,BooksSourcePolicy:{reason:()=>null,stop:code=>map.set('hlstop',code)},localStorage:{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)},map};}
test('market-data refusal persists across instances; no replacement host or retry is attempted',async()=>{
 for(const status of [403,429]){let calls=0;const e=environment(async url=>{calls++;assert.match(url,/^https:\/\/fapi.binance.com\/fapi\/v1\/klines\?/);return new Response('',{status});});
  const args=['Binance','ETHUSDT','1h',t-3600000,t];await assert.rejects(Data.create(e).candles(...args));await assert.rejects(Data.create(e).candles(...args));assert.equal(calls,1);
 }
});
test('snapshot source hold prevents even the first Hyperliquid history request',async()=>{
 let calls=0;const e=environment(async()=>{calls++;});e.BooksSourcePolicy.reason=()=> 'http_403';await assert.rejects(Data.create(e).fills('0x'+'a'.repeat(40)),/http_403/);assert.equal(calls,0);
});
test('deep-link history waits for same-origin safety verification before contacting the exchange',async()=>{
 let calls=0,verified=false;const e=environment(async()=>{calls++;return new Response('[]');});e.BooksSourcePolicy.reason=()=>verified?null:'snapshot_unverified';
 const pending=Data.create(e).fills('0x'+'a'.repeat(40));assert.equal(calls,0);verified=true;await pending;assert.equal(calls,1);
});
test('selected public account reads coalesce and cache without altering source fill times',async()=>{
 let calls=0;const e=environment(async()=>{calls++;return new Response(JSON.stringify([hl(1,'0','1')]));}),d=Data.create(e),address='0x'+'a'.repeat(40);
 const [a,b]=await Promise.all([d.fills(address),d.fills(address)]);assert.equal(a,b);assert.equal(calls,1);assert.equal(a.rows[0].time,t+1000);assert.equal(Data.create(e).cached(address).rows[0].time,t+1000);
});
test('real bundled observations render synchronously without waiting for remote GitHub',()=>{
 const context={};vm.runInNewContext(fs.readFileSync('trader/replay-seed.js','utf8'),context);
 let calls=0;const e=environment(()=>{calls++;});e.BooksPublicRecordSeed=context.BooksPublicRecordSeed;
 const r=Public.reader(e);assert.equal(calls,0);assert.ok(r.last().allRows.length>=38);assert.ok(Date.parse(r.last().checkedAt)<Date.now());
 const h={};vm.runInNewContext(fs.readFileSync('trader/aoying-history.js','utf8'),h);assert.equal(h.BooksAoyingHistory.rows.length,110);
 const cs=M.cycles(M.binanceEvents(r.last().allRows),h.BooksAoyingHistory.rows);assert.equal(cs.filter(c=>c.official).length,110);assert.equal(cs.flatMap(c=>c.events).length,r.last().allRows.length);
 for(const item of h.BooksAoyingHistory.evidence){const bytes=fs.readFileSync('trader/'+item.path);assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),item.sha256);}
});
