'use strict';
// One-shot documentation verification. No quote/screener/TDX/Tencent endpoints.
const urls=[
 'https://www.tradingview.com/widget-docs/widgets/watchlists/market-summary.md',
 'https://www.tradingview.com/widget-docs/widgets/watchlists/legacy-stock-market.md',
 'https://www.tradingview.com/widget-docs/widgets/screeners/screener.md'
];
(async()=>{
 for(const url of urls){
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  console.log('DOC',url,'HTTP',response.status);
  if(!response.ok)throw Error('Documentation request stopped; do not retry automatically');
  const text=await response.text();if(text.length>120000)throw Error('Documentation too large');
  console.log(text);
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
