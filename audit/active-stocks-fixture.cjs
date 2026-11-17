'use strict';
// Synthetic fixtures only. audit/ is excluded from the public release archive.
module.exports=function fixture(){
 const tradingDates=['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13'];
 return {publicationVersion:10,schemaVersion:1,status:'ready',synthetic:true,method:'mean_daily_turnover_5_sessions',
  amountUnit:'CNY',completedSessionsVerified:true,dataAsOf:tradingDates[4],generatedAt:'2026-11-13T08:00:00.000Z',tradingDates,
  source:{id:'offline-fixture',name:'合成测试源',publicDisplayApproved:true,permissionReference:'offline-fixture-only'},
  coverage:{scope:'supplied_stock_sample',supplied:4,complete:3,excluded:1},
  rows:[
   {exchange:'SH',code:'600519',name:'合成样本甲',dailyAmounts:tradingDates.map((date,i)=>({date,amount:(i+1)*1e8}))},
   {exchange:'SZ',code:'000001',name:'合成样本乙',dailyAmounts:tradingDates.map(date=>({date,amount:9e8}))},
   {exchange:'SZ',code:'300750',name:'合成样本丙',dailyAmounts:tradingDates.map(date=>({date,amount:3e8}))}
  ]};
};
