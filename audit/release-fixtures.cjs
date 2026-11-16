'use strict';
// Synthetic, offline test data only. Never used as a published market snapshot.
const stocks = Array.from({length:5000}, (_,i)=>({
  code:String(600000+i)+'.SH',exchange:'SH',name:'测试证券'+i,boardName:'测试行业',
  price:10,changePct:0,totalMarketCap:100e8
}));
Object.assign(stocks[4998],{code:'000001.SZ',exchange:'SZ'});
Object.assign(stocks[4999],{code:'800001.BJ',exchange:'BJ'});
module.exports={updatedAt:'2026-11-13T08:15:00.000Z',stockCount:stocks.length,boardCount:1,stocks};
