/* Explicit isolated acceptance replay. Synthetic fixtures never enter saved ledgers or live feeds. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./paper-engine.js'),require('./paper-data.js'),require('./trade-replay-model.js'),require('./public-executions.js'));else root.BooksPaperAcceptance=factory(root.BooksPaperEngine,root.BooksPaperData,root.BooksTradeReplayModel,root.BooksBinancePublicRecords);})(globalThis,function(E,D,M,R){
 'use strict';
 function run(){const results=[],base=Date.now()-60000,iso=t=>new Date(t).toISOString();
  for(const venue of ['Binance','Bitget','Hyperliquid'])for(const side of ['long','short']){
   const records={},key=i=>i.toString(16).padStart(64,'0');
   function add(i,quantity,reduction=false){const at=base+i*1000,k=key(i);records[k]={fingerprint:k,identity:key(i+100),sourceOrderId:null,firstSeenAt:iso(at),versionFirstSeenAt:iso(at),orderTime:at,orderUpdateTime:at,direction:(reduction?'reducing_or_closing_':'opening_or_increasing_')+side,symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',executedQty:String(quantity),avgPrice:'95',totalPnl:'0'};}
   function feed(i){const at=base+i*1000,parsed=R.parse({schemaVersion:1,portfolioId:R.ID,scope:'public_execution_records_only',hiddenPositionsRequested:false,stopped:false,lastSuccessAt:iso(at),records},at);return {checkedAt:at,stopped:false,events:D.normalize(M.binanceEvents(parsed.allRows).map(e=>({...e,firstSeenAt:e.firstSeenAt})))};}
   add(1,9);let state=E.start(E.create('Binance:'+R.ID,'isolated_'+venue+'_'+side,{feeBps:5},base,{venue,limits:{maxExposure:300,symbols:['ETHUSDT']}}),feed(1),base+1500);
   if(state.orders.length)throw Error('baseline_failed');
   const steps=[['开仓',2,10,false,1],['加仓',3,10,false,2],['减仓',4,5,true,1.5],['平仓',5,15,true,0]];
   for(const [action,i,quantity,reduction,expected]of steps){add(i,quantity,reduction);const now=base+i*1000+500,price=reduction?(i===4?110:120):100,markets={ETH:{coin:'ETH',szDecimals:3,minNotional:10,maxLeverage:20,time:now,bids:[[price,100]],asks:[[price,100]]}};state=E.advance(state,feed(i),markets,now);const actual=state.positions['ETH|'+side]?.units/1000||0;if(actual!==expected||state.orders.at(-1)?.status!=='simulated'||!E.reconcile(state))throw Error('lifecycle_failed');const count=state.orders.length;state=E.advance(state,feed(i),markets,now);if(state.orders.length!==count)throw Error('duplicate_failed');results.push({venue,side,action,sourceQuantity:quantity,paperQuantity:actual,passed:true});}
   if(Math.abs(state.realized-(side==='long'?35:-35))>1e-8||state.orders.length!==4||state.orders.some(x=>x.sourceId===key(1)))throw Error('reconciliation_failed');
  }
  return {testOnly:true,synthetic:true,saved:false,ordersSent:0,passed:true,baselineAndDeduplication:true,results};
 }
 return {run};
});
