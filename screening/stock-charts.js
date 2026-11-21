'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BooksStockCharts=api;
})(globalThis,()=>{
  const source='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  function create({document,env=globalThis}){
    const states=new Map();
    let destroyed=false;
    const alive=state=>!destroyed&&states.get(state.host)===state;
    function phase(state,value,message){
      state.phase=value;
      state.host.dataset.chartState=value;
      state.status.textContent=message;
    }
    function cleanup(state){
      env.clearTimeout(state.timer);
      state.observer?.disconnect();
      if(state.frame){
        state.frame.removeEventListener('load',state.onLoad);
        state.frame.removeEventListener('error',state.onError);
      }
      if(state.script)state.script.onerror=null;
    }
    function unavailable(state){
      if(!alive(state)||state.phase!=='loading')return;
      cleanup(state);
      phase(state,'unavailable','日K暂不可用');
      const link=document.createElement('a');
      link.className='stock-chart-link';
      link.href='../chart.html?tvwidgetsymbol='+encodeURIComponent(state.symbol);
      link.textContent='查看完整日K';
      state.host.replaceChildren(state.status,link);
    }
    function mount(state){
      if(!alive(state)||state.phase!=='waiting')return;
      viewport?.unobserve(state.host);
      phase(state,'loading','日K加载中…');
      const container=document.createElement('div'),slot=document.createElement('div');
      container.className='stock-chart-widget tradingview-widget-container';
      slot.className='tradingview-widget-container__widget';
      const credit=document.createElement('div'),brand=document.createElement('a');
      credit.className='tradingview-widget-copyright';
      brand.href='https://www.tradingview.com/';
      brand.target='_blank';brand.rel='noopener nofollow';
      brand.textContent='Track all markets on TradingView';
      credit.append(brand);container.append(slot,credit);
      state.host.replaceChildren(container,state.status);
      state.onLoad=()=>{
        if(!alive(state)||state.phase!=='loading')return;
        env.clearTimeout(state.timer);
        phase(state,'frame-loaded','');
      };
      state.onError=()=>unavailable(state);
      state.observer=new env.MutationObserver(()=>{
        if(!alive(state)||state.phase!=='loading'||state.frame)return;
        const frame=container.querySelector('iframe');
        if(!frame)return;
        state.frame=frame;
        frame.title=state.name+' 日K（TradingView）';
        frame.addEventListener('load',state.onLoad,{once:true});
        frame.addEventListener('error',state.onError,{once:true});
        state.observer.disconnect();
      });
      state.observer.observe(container,{childList:true,subtree:true});
      const script=document.createElement('script');
      state.script=script;
      script.src=source;script.async=true;
      script.textContent=JSON.stringify({autosize:true,symbol:state.symbol,interval:'D',timezone:'Asia/Shanghai',theme:'light',style:'1',locale:'zh_CN',allow_symbol_change:false,calendar:false,hide_top_toolbar:true,hide_legend:false,support_host:'https://www.tradingview.com'});
      script.onerror=state.onError;
      state.timer=env.setTimeout(()=>unavailable(state),15000);
      container.append(script);
    }
    const viewport=env.IntersectionObserver?new env.IntersectionObserver(entries=>{
      for(const entry of entries){
        const state=states.get(entry.target);
        if(entry.isIntersecting&&state)mount(state);
      }
    },{rootMargin:'200px 0px'}):null;
    function observe(host,stock){
      if(destroyed||states.has(host))return;
      const status=document.createElement('p');
      status.className='stock-chart-status';status.setAttribute('role','status');
      const code=stock?.code,match=typeof code==='string'&&/^(\d{6})\.(SH|SZ)$/.exec(code);
      const state={host,status,symbol:match?(match[2]==='SH'?'SSE:':'SZSE:')+match[1]:null,name:typeof stock?.name==='string'?stock.name:code,phase:'waiting',timer:null,observer:null,script:null,frame:null};
      states.set(host,state);host.replaceChildren(status);
      if(!match){phase(state,'unavailable','日K暂不可用');return;}
      phase(state,'waiting','日K进入屏幕后加载');
      if(viewport)viewport.observe(host);
      else mount(state);
    }
    function dispose(host){
      const state=states.get(host);if(!state)return;
      states.delete(host);viewport?.unobserve(host);cleanup(state);
      host.replaceChildren();delete host.dataset.chartState;
    }
    function destroy(){
      if(destroyed)return;
      for(const host of [...states.keys()])dispose(host);
      viewport?.disconnect();destroyed=true;
    }
    return {observe,dispose,destroy};
  }
  return {create};
});
