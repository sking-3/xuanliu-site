'use strict';
(() => {
 const widget=document.querySelector('tv-market-summary');
 const status=document.getElementById('tv-movers-status');
 const chart=new URL('chart.html',location.href);
 widget.setAttribute('symbol-url',chart.href+'?tvwidgetsymbol={tvprosymbol}');
 widget.addEventListener('tv-link-open',event=>{
  const symbol=event.detail?.context?.symbol;
  if(typeof symbol!=='string'||!/^SSE:\d{6}$/.test(symbol))return;
  event.preventDefault();
  const target=new URL(chart);target.searchParams.set('tvwidgetsymbol',symbol);
  try{
   if(window.parent!==window&&window.parent.location.origin===location.origin){window.parent.location.assign(target.href);return;}
  }catch{}
  location.assign(target.href);
 });
 // This imports TradingView's renderer; no quote requests, data export or storage
 // are implemented by this site. A loaded renderer is not evidence of fresh data.
 let completed=false;
 const timer=setTimeout(()=>{
  if(!completed){status.textContent='组件暂未加载，可稍后重新打开本页或查看来源页面。';document.body.dataset.widgetState='unavailable';}
 },15000);
 import('https://www.tradingview-widget.com/w/zh_CN/tv-market-summary.js').then(()=>{
  completed=true;clearTimeout(timer);
  document.body.dataset.widgetState='embedded';
  status.textContent='行情及更新状态以 TradingView 组件和图表内标注为准。';
 }).catch(()=>{
  completed=true;clearTimeout(timer);
  document.body.dataset.widgetState='unavailable';
  status.textContent='TradingView 组件暂不可用；本页没有替换为旧榜单。';
 });
})();
