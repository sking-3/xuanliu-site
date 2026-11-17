'use strict';
(() => {
 const host=document.getElementById('tv-hotlists-host'),status=document.getElementById('tv-movers-status');
 if(!host||!status||host.dataset.mounted)return;
 host.dataset.mounted='true';host.dataset.widgetState='loading';
 const timer=setTimeout(()=>{
  if(!['loading','script-loaded'].includes(host.dataset.widgetState))return;
  host.dataset.widgetState='unverified';
  status.textContent='无法确认来源行情是否可用。请以榜单内容为准；空白时可查看下方来源页面。';
 },15000);
 const widget=document.createElement('div');widget.className='tradingview-widget-container__widget';host.append(widget);
 const script=document.createElement('script');
 script.src='https://s3.tradingview.com/external-embedding/embed-widget-hotlists.js';script.async=true;
 script.textContent=JSON.stringify({colorTheme:'light',dateRange:'1D',exchange:'SSE',showChart:false,locale:'zh_CN',
  largeChartUrl:new URL('chart.html',location.href).href,isTransparent:false,showSymbolLogo:true,width:'100%',height:450});
 script.onerror=()=>{clearTimeout(timer);host.dataset.widgetState='unavailable';status.textContent='TradingView 组件暂不可用，可查看下方来源页面。';};
 script.onload=()=>{
  // Script and iframe load events cannot certify cross-origin quote content.
  // Keep the deadline active even if the external renderer itself has loaded.
  if(host.dataset.widgetState!=='loading')return;
  host.dataset.widgetState='script-loaded';
  status.textContent='正在等待来源行情。日终行情的日期及可用性以榜单和图表内标注为准。';
 };
 host.append(script);
})();
