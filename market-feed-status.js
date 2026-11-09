'use strict';
// A provider readiness signal is not proof of fresh or available quotes.
(()=>{
 const states=new Map();
 function stateFor(section){let s=states.get(section);if(!s){s={timer:null,generation:0,ready:false,area:null,status:null,toggle:null};states.set(section,s);}return s;}
 function controls(s,hidden){s.area.hidden=hidden;s.toggle.textContent=hidden?'展开行情区域':'收起行情区域';s.toggle.setAttribute('aria-expanded',String(!hidden));}
 function fail(s,text){clearTimeout(s.timer);s.ready=false;s.status.textContent=text;controls(s,true);}
 function start(s){clearTimeout(s.timer);s.ready=false;controls(s,false);s.status.textContent='正在加载第三方行情组件…';s.timer=setTimeout(()=>{if(!s.ready)fail(s,'未能在 15 秒内确认组件就绪，已收起空白区域。可能是网络、浏览器拦截或数据源响应慢。可重新加载、展开查看，或打开上方来源链接。');},15000);}
 window.addEventListener('message',event=>{
  if(event.origin!=='https://www.tradingview-widget.com')return;
  for(const [section,s] of states){const frame=section.querySelector('iframe');if(!frame||event.source!==frame.contentWindow||!s.status)continue;
   const name=event.data&&event.data.name;
   if(name==='tv-widget-ready'||name==='tv-widget-load'){clearTimeout(s.timer);s.ready=true;s.status.textContent='第三方组件已响应。价格、延迟与数据可用性请以组件内显示为准。';}
   else if(name==='tv-widget-no-data')fail(s,'数据源报告暂无可用数据。没有以零值或示例行情替代。可重试或打开上方来源链接。');
  }
 });
 window.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.public-feed').forEach(section=>{
   const s=stateFor(section);s.area=section.querySelector('.feed-widget-area');s.status=section.querySelector('.feed-status');s.toggle=section.querySelector('.feed-toggle');if(!s.area||!s.status||!s.toggle)return;
   const old=section.querySelector('script[src*="embed-widget-market-overview.js"]');if(!old)return;const config=old.textContent,src=old.src;
   old.addEventListener('error',()=>{if(s.generation===0)fail(s,'行情脚本加载失败，已收起空白区域。请检查网络或浏览器拦截设置后重试。');});
   s.toggle.addEventListener('click',()=>controls(s,!s.area.hidden));
   section.querySelector('.feed-retry').addEventListener('click',()=>{
    const generation=++s.generation;const container=document.createElement('div');container.className='tradingview-widget-container';
    const widget=document.createElement('div');widget.className='tradingview-widget-container__widget';container.append(widget);
    const copyright=document.createElement('div');copyright.className='tradingview-widget-copyright';const link=document.createElement('a');link.href='https://www.tradingview.com/markets/stocks-usa/';link.target='_blank';link.rel='noopener nofollow';link.textContent='US stocks';copyright.append(link,document.createTextNode(' by TradingView'));container.append(copyright);
    const script=document.createElement('script');script.type='text/javascript';script.src=src;script.async=true;script.textContent=config;script.addEventListener('error',()=>{if(s.generation===generation)fail(s,'行情脚本加载失败，已收起空白区域。请稍后重试或打开上方来源链接。');});container.append(script);s.area.replaceChildren(container);start(s);
   });start(s);
  });
 });
})();
