'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BooksStockCharts=api;
})(globalThis,()=>{
  const source='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  function create({document,env=globalThis}){
    const states=new Map(),loading=new Set(),retained=new Map();
    const margin=600;
    let destroyed=false,pendingCheck=null,draining=false,drainScheduled=false;
    const alive=(state,epoch=state.epoch)=>!destroyed&&states.get(state.host)===state&&state.epoch===epoch;
    function phase(state,value,message){
      state.phase=value;
      state.host.dataset.chartState=value;
      state.status.textContent=message;
    }
    function cleanup(state){
      state.epoch++;
      loading.delete(state);retained.delete(state);
      env.clearTimeout(state.timer);
      state.observer?.disconnect();
      if(state.frame){
        state.frame.removeEventListener('load',state.onLoad);
        state.frame.removeEventListener('error',state.onError);
      }
      if(state.script)state.script.onerror=null;
      state.timer=null;state.observer=null;state.frame=null;state.script=null;
    }
    function unavailable(state,epoch){
      if(!alive(state,epoch)||state.phase!=='loading')return;
      cleanup(state);
      phase(state,'unavailable','日K暂不可用');
      const link=document.createElement('a');
      link.className='stock-chart-link';
      link.href='../chart.html?tvwidgetsymbol='+encodeURIComponent(state.symbol);
      link.textContent='查看完整日K';
      state.host.replaceChildren(state.status,link);
      drain();
    }
    function unmount(state){
      if(!alive(state)||!['loading','frame-loaded'].includes(state.phase))return;
      cleanup(state);
      state.host.replaceChildren(state.status);
      phase(state,'waiting','日K进入屏幕后加载');
    }
    function mount(state){
      if(!alive(state)||state.phase!=='waiting')return;
      const epoch=++state.epoch;
      loading.add(state);
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
        if(!alive(state,epoch)||state.phase!=='loading')return;
        env.clearTimeout(state.timer);
        state.timer=null;loading.delete(state);
        phase(state,'frame-loaded','');
        drain();
      };
      state.onError=()=>unavailable(state,epoch);
      state.observer=new env.MutationObserver(()=>{
        if(!alive(state,epoch)||state.phase!=='loading'||state.frame)return;
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
      state.timer=env.setTimeout(()=>unavailable(state,epoch),15000);
      container.append(script);
    }
    function visibility(state,near){
      const wasNear=state.near;state.near=near;
      if(near){retained.delete(state);return;}
      if(state.phase==='loading')unmount(state);
      else if(wasNear&&state.phase==='frame-loaded'){
        retained.delete(state);retained.set(state,true);
        while(retained.size>4)unmount(retained.keys().next().value);
      }
    }
    function drain(){
      if(destroyed||draining||loading.size>=2)return;
      draining=true;
      const waiting=[];
      for(const state of states.values()){
        if(!state.near||state.phase!=='waiting')continue;
        const rect=state.host.getBoundingClientRect(),visible=rect.bottom>0&&rect.top<env.innerHeight&&rect.right>0&&rect.left<env.innerWidth;
        const distance=rect.bottom<0?-rect.bottom:rect.top>env.innerHeight?rect.top-env.innerHeight:0;
        waiting.push({state,visible,distance});
      }
      waiting.sort((a,b)=>Number(b.visible)-Number(a.visible)||a.distance-b.distance);
      for(const item of waiting){if(loading.size>=2)break;mount(item.state);}
      draining=false;
    }
    function scheduleDrain(){
      if(destroyed||drainScheduled)return;
      drainScheduled=true;
      Promise.resolve().then(()=>{drainScheduled=false;drain();});
    }
    const viewport=env.IntersectionObserver?new env.IntersectionObserver(entries=>{
      for(const entry of entries){
        const state=states.get(entry.target);
        if(!state)continue;
        visibility(state,entry.isIntersecting);
      }
      drain();
    },{rootMargin:margin+'px 0px'}):null;
    function checkViewport(){
      pendingCheck=null;if(destroyed)return;
      const visible=[];
      for(const state of states.values()){
        if(!state.symbol)continue;
        const rect=state.host.getBoundingClientRect();
        visible.push([state,rect.bottom>rect.top&&rect.right>rect.left&&rect.bottom>=-margin&&rect.top<=env.innerHeight+margin&&rect.right>=0&&rect.left<=env.innerWidth]);
      }
      for(const [state,near]of visible)visibility(state,near);
      drain();
    }
    function scheduleCheck(){
      if(destroyed||pendingCheck!==null)return;
      pendingCheck=env.requestAnimationFrame?env.requestAnimationFrame(checkViewport):env.setTimeout(checkViewport,16);
    }
    if(!viewport){
      env.addEventListener('scroll',scheduleCheck,{passive:true,capture:true});
      env.addEventListener('resize',scheduleCheck);
    }
    function observe(host,stock){
      if(destroyed||states.has(host))return;
      const status=document.createElement('p');
      status.className='stock-chart-status';status.setAttribute('role','status');
      const code=stock?.code,match=typeof code==='string'&&/^(\d{6})\.(SH|SZ)$/.exec(code);
      const state={host,status,symbol:match?(match[2]==='SH'?'SSE:':'SZSE:')+match[1]:null,name:typeof stock?.name==='string'?stock.name:code,phase:'waiting',near:false,epoch:0,timer:null,observer:null,script:null,frame:null};
      states.set(host,state);host.replaceChildren(status);
      if(!match){phase(state,'unavailable','日K暂不可用');return;}
      phase(state,'waiting','日K进入屏幕后加载');
      if(viewport)viewport.observe(host);
      else scheduleCheck();
    }
    function dispose(host){
      const state=states.get(host);if(!state)return;
      states.delete(host);viewport?.unobserve(host);cleanup(state);
      host.replaceChildren();delete host.dataset.chartState;
      scheduleDrain();
    }
    function destroy(){
      if(destroyed)return;
      destroyed=true;
      for(const host of [...states.keys()])dispose(host);
      viewport?.disconnect();
      if(!viewport){
        env.removeEventListener('scroll',scheduleCheck,true);
        env.removeEventListener('resize',scheduleCheck);
        if(pendingCheck!==null){
          if(env.requestAnimationFrame)env.cancelAnimationFrame(pendingCheck);
          else env.clearTimeout(pendingCheck);
          pendingCheck=null;
        }
      }
    }
    return {observe,dispose,destroy};
  }
  return {create};
});
