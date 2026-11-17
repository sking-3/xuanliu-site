'use strict';
(() => {
 const host=document.getElementById('tv-hotlists-host'),status=document.getElementById('tv-movers-status');
 if(!host||!status||host.dataset.mounted)return;
 host.dataset.mounted='true';host.dataset.widgetState='loading';
 let loaded=false;
 const timer=setTimeout(()=>{if(!loaded){host.dataset.widgetState='unavailable';status.textContent='TradingView 组件暂未响应，可查看下方来源页面。';}},15000);
 const widget=document.createElement('div');widget.className='tradingview-widget-container__widget';host.append(widget);
 const script=document.createElement('script');
 script.src='https://s3.tradingview.com/external-embedding/embed-widget-hotlists.js';script.async=true;
 script.textContent=JSON.stringify({colorTheme:'light',dateRange:'1D',exchange:'SSE',showChart:false,locale:'zh_CN',
  largeChartUrl:new URL('chart.html',location.href).href,isTransparent:false,showSymbolLogo:true,width:'100%',height:450});
 script.onerror=()=>{loaded=true;clearTimeout(timer);host.dataset.widgetState='unavailable';status.textContent='TradingView 组件暂不可用，可查看下方来源页面。';};
 script.onload=()=>{loaded=true;clearTimeout(timer);host.dataset.widgetState='embedded';status.textContent='日终行情，日期及可用性以组件和图表内标注为准。';};
 // A loaded renderer does not certify quote availability or freshness.
 host.append(script);
})();
