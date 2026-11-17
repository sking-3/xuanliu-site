'use strict';
(() => {
 const host=document.getElementById('tv-hotlists-host'),status=document.getElementById('tv-movers-status');
 const widget=document.createElement('div');widget.className='tradingview-widget-container__widget';host.append(widget);
 const script=document.createElement('script');
 script.src='https://s3.tradingview.com/external-embedding/embed-widget-hotlists.js';script.async=true;
 script.textContent=JSON.stringify({colorTheme:'light',dateRange:'1D',exchange:'SSE',showChart:false,locale:'zh_CN',
  largeChartUrl:new URL('chart.html',location.href).href,isTransparent:false,showSymbolLogo:true,width:'100%',height:450});
 script.onerror=()=>{document.body.dataset.widgetState='unavailable';status.textContent='TradingView 组件暂不可用，本页没有替换为旧榜单。';};
 script.onload=()=>{document.body.dataset.widgetState='embedded';status.textContent='沪市日终行情；日期及更新状态以 TradingView 组件和图表标注为准。';};
 host.append(script);
})();
