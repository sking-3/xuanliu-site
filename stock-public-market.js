'use strict';
// Official hosted screener only. No account key, data extraction or background collector.
(() => {
 const status=document.querySelector('[data-public-market-status]'),script=document.querySelector('[data-public-market-loader]');
 if(!status||!script)return;
 let defined=false;
 script.addEventListener('error',()=>{status.textContent='公开行情组件未能加载。请查看来源状态；未用示例行情替代。';});
 customElements.whenDefined('tv-screener').then(()=>{defined=true;status.textContent='公开行情组件已载入；数据日期、延迟和可用范围以组件显示为准。';});
 setTimeout(()=>{if(!defined)status.textContent='公开行情组件尚未载入，数据暂不可用。没有生成报价或筛选结果。';},15000);
})();
