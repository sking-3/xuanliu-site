'use strict';
// Official hosted screener only. No account key, data extraction or background collector.
(() => {
 const status=document.querySelector('[data-public-market-status]'),script=document.querySelector('[data-public-market-loader]'),widget=document.querySelector('[data-public-market-widget]'),recovery=document.querySelector('[data-public-market-recovery]'),reload=document.querySelector('[data-public-market-reload]');
 if(!status||!script||!widget||!recovery||!reload)return;
 let defined=false,timer;
 function unavailable(message){if(defined)return;clearTimeout(timer);status.textContent=message+' 可打开官方来源，或手动重新加载页面。本站不会自动重试或生成替代行情。';widget.hidden=true;recovery.hidden=false;}
 reload.addEventListener('click',()=>{if(reload.disabled)return;reload.disabled=true;location.reload();});
 script.addEventListener('error',()=>unavailable('公开行情组件未能加载。'));
 customElements.whenDefined('tv-screener').then(()=>{defined=true;clearTimeout(timer);widget.hidden=false;recovery.hidden=true;status.textContent='公开行情组件已注册；不代表报价已取得。数据日期、延迟和可用范围以组件显示为准。';});
 timer=setTimeout(()=>unavailable('公开行情组件尚未载入，数据暂不可用。'),15000);
})();
