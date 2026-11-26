'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BooksStockCharts=api;
})(globalThis,()=>{
  const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
  const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const binding=value=>typeof value?.generation==='string'&&value.generation&&validDay(value.day)&&typeof value.sourceId==='string'&&value.sourceId&&validTime(value.asOf)?JSON.stringify([value.generation,value.day,value.sourceId,value.asOf]):null;
  const markerNames={B:'B',S:'S',ADD:'+',REDUCE:'−',INVALID:'X'};
  const stamp=value=>validTime(value)?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value))+' 北京':'未提供';
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
      state.controller?.abort();
      if(state.image){state.image.removeEventListener('load',state.onLoad);state.image.removeEventListener('error',state.onError);}
      if(state.frame){
        state.frame.removeEventListener('load',state.onLoad);
        state.frame.removeEventListener('error',state.onError);
      }
      if(state.script)state.script.onerror=null;
      state.timer=null;state.observer=null;state.frame=null;state.script=null;state.controller=null;state.image=null;
    }
    function chartLink(state){
      const link=document.createElement('a');link.className='stock-chart-link';
      link.href='../chart.html?tvwidgetsymbol='+encodeURIComponent(state.symbol);link.target='_blank';link.rel='noopener';
      link.textContent=state.batch?'TradingView 完整图 ↗':'查看完整日K';return link;
    }
    function unavailable(state,epoch,message){
      if(!alive(state,epoch)||state.phase!=='loading')return;
      cleanup(state);
      phase(state,'unavailable',message||'日K暂不可用');
      state.host.replaceChildren(state.status,chartLink(state));
      if(state.batch){
        const retry=document.createElement('button');retry.type='button';retry.className='stock-signal-retry';retry.textContent='重试本批图表';
        retry.addEventListener('click',()=>{if(!alive(state)||state.phase!=='unavailable')return;phase(state,'waiting','日K进入屏幕后加载');scheduleDrain();});state.host.append(retry);
      }
      drain();
    }
    function unmount(state){
      if(!alive(state)||!['loading','frame-loaded','signal-loaded'].includes(state.phase))return;
      cleanup(state);
      state.host.replaceChildren(state.status);
      phase(state,'waiting','日K进入屏幕后加载');
    }
    function mountWidget(state){
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
    function validateSignals(value,state){
      if(value?.schema!=='books.a-share.entry-signals.v1'||value.version!=='entry-signals-v1'||binding(value)!==binding(state.batch)||value.stock?.code!==state.code||!Array.isArray(value.windows)||value.windows.length!==2||!value.windows.includes(60)||!value.windows.includes(120)||typeof value.chartAvailable!=='boolean'||!Array.isArray(value.markers)||value.markers.length>1000||value.sourceFetchedAt!==null&&!validTime(value.sourceFetchedAt))throw Error('信号图与当前股票或数据批次不一致。');
      const ids=new Set();
      for(const marker of value.markers){
        if(typeof marker.id!=='string'||!marker.id||ids.has(marker.id)||!Object.hasOwn(markerNames,marker.kind)||!validDay(marker.day)||marker.day>value.day||typeof marker.label!=='string'||typeof marker.reason!=='string'||!validTime(marker.knownAfter)||marker.actualDiscoveryAt!==null&&!validTime(marker.actualDiscoveryAt)||typeof marker.lateDiscovery!=='boolean'||marker.state!=='research'||marker.actualFillVerified!==false||!Array.isArray(marker.evidence)||marker.evidence.some(item=>typeof item?.setupId!=='string'||!Array.isArray(item.patternIds)||item.patternIds.some(id=>typeof id!=='string')||!validTime(item.knownAfter)||item.actualDiscoveryAt!==null&&!validTime(item.actualDiscoveryAt)||typeof item.lateDiscovery!=='boolean'||item.independentlyValidated!==false||item.actualFillVerified!==false))throw Error('信号标记日期或研究口径无效，未加载图表。');
        ids.add(marker.id);
      }
      if(value.chartRanges)for(const window of [60,120]){const range=value.chartRanges[window];if(range!==null&&(!validDay(range?.from)||range.to!==value.day||range.from>range.to))throw Error('信号图显示范围与数据日不一致。');}
      return value;
    }
    function renderMarkerDetails(state){
      const range=state.data.chartRanges?.[state.window];
      const markers=state.data.markers.filter(marker=>!range||marker.day>=range.from&&marker.day<=range.to).slice().sort((a,b)=>b.day.localeCompare(a.day)||a.id.localeCompare(b.id)).slice(0,8);
      if(!markers.some(marker=>marker.id===state.selected))state.selected=markers[0]?.id||null;
      state.markerList.replaceChildren();
      for(const marker of markers){
        const button=document.createElement('button');button.type='button';button.textContent=markerNames[marker.kind]+' · '+marker.day.slice(5);button.setAttribute('aria-pressed',String(marker.id===state.selected));
        button.addEventListener('click',()=>{if(!alive(state))return;state.selected=marker.id;renderMarkerDetails(state);});state.markerList.append(button);
      }
      const selected=markers.find(marker=>marker.id===state.selected);
      state.markerList.hidden=!markers.length;
      state.reason.textContent=selected?markerNames[selected.kind]+' '+selected.day+' · '+selected.reason+' · 收盘后可知 '+stamp(selected.knownAfter)+(selected.lateDiscovery?' · 晚于当日发现 '+stamp(selected.actualDiscoveryAt):'')+' · 未独立验证，非成交。':(range?'此显示范围没有研究标记。':'本批没有研究标记。');
    }
    function signalSurface(state){
      const toolbar=document.createElement('div'),title=document.createElement('span'),select=document.createElement('select');
      toolbar.className='stock-signal-toolbar';title.textContent='日K · 研究观察';select.setAttribute('aria-label',state.name+'日K显示范围');
      for(const days of [60,120]){const option=document.createElement('option');option.value=String(days);option.textContent='近'+days+'个交易日';select.append(option);}select.value=String(state.window);
      select.addEventListener('change',()=>{const value=Number(select.value);if(!alive(state)||![60,120].includes(value)||value===state.window)return;state.window=value;cleanup(state);phase(state,'waiting','日K进入屏幕后加载');state.host.replaceChildren(state.status);scheduleDrain();});toolbar.append(title,select);
      const legend=document.createElement('div');legend.className='stock-signal-legend';
      for(const label of ['B 买入观察（突破）','S 卖出观察（15日研究退出）','+ 波段加仓','− 波段减仓','X 条件失效']){const item=document.createElement('span');item.textContent=label;legend.append(item);}
      const markerList=document.createElement('div'),reason=document.createElement('p'),footer=document.createElement('div'),source=document.createElement('span');
      markerList.className='stock-signal-markers';markerList.setAttribute('aria-label',state.name+'最近研究标记');reason.className='stock-signal-reason';reason.setAttribute('aria-live','polite');footer.className='stock-signal-footer';
      source.textContent=(state.batch.attribution||state.batch.sourceId)+' · 数据日 '+state.batch.day+' · 来源 '+stamp(state.batch.asOf)+' · 读取 '+stamp(state.data?.sourceFetchedAt)+' · 前复权归一化研究图；未独立验证，非成交。';
      footer.append(source,chartLink(state));state.markerList=markerList;state.reason=reason;
      state.host.replaceChildren(toolbar,state.status,legend,markerList,reason,footer);
      return legend;
    }
    async function mountSignals(state){
      if(!alive(state)||state.phase!=='waiting')return;
      const epoch=++state.epoch;loading.add(state);phase(state,'loading','日K与研究标记加载中…');
      const controller=new (env.AbortController||globalThis.AbortController)();state.controller=controller;
      state.timer=env.setTimeout(()=>unavailable(state,epoch,'本批信号图读取超时，可重试。'),15000);
      try{
        if(!state.data){
          const response=await env.fetch('/api/a-share-daily/signals?'+new URLSearchParams({generation:state.batch.generation,code:state.code}),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
          if(!response.ok)throw Error('本批信号图暂不可用（HTTP '+response.status+'）。');
          const value=validateSignals(await response.json(),state);if(!alive(state,epoch))return;state.data=value;
        }
        if(!alive(state,epoch))return;
        const legend=signalSurface(state);
        if(!state.data.chartAvailable){env.clearTimeout(state.timer);state.timer=null;state.controller=null;loading.delete(state);phase(state,'signal-loaded','本批日线不足，暂无可核对的主图与标记。');legend.hidden=true;state.markerList.hidden=true;state.reason.textContent='';drain();return;}
        const image=document.createElement('img');state.image=image;image.className='stock-signal-image';image.alt=state.name+'日K：B买入观察、S卖出观察（固定15日研究退出）及波段加减仓研究标记，非实际成交';image.decoding='async';
        state.onLoad=()=>{if(!alive(state,epoch)||state.phase!=='loading')return;env.clearTimeout(state.timer);state.timer=null;state.controller=null;loading.delete(state);phase(state,'signal-loaded','');renderMarkerDetails(state);drain();};
        state.onError=()=>unavailable(state,epoch,'本批日K图未能载入，可重试或查看完整图。');image.addEventListener('load',state.onLoad,{once:true});image.addEventListener('error',state.onError,{once:true});
        image.src='/api/a-share-daily/signal-chart?'+new URLSearchParams({generation:state.batch.generation,code:state.code,window:String(state.window)});state.host.insertBefore(image,state.status);
      }catch(error){if(alive(state,epoch))unavailable(state,epoch,error.name==='TypeError'?'本批信号图读取失败，可重试。':error.message);}
    }
    function mount(state){if(state.batch)mountSignals(state);else mountWidget(state);}
    function visibility(state,near){
      const wasNear=state.near;state.near=near;
      if(near){retained.delete(state);return;}
      if(state.phase==='loading')unmount(state);
      else if(wasNear&&['frame-loaded','signal-loaded'].includes(state.phase)){
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
    function observe(host,stock,batch){
      if(destroyed)return;
      const previous=states.get(host),key=binding(batch),code=stock?.code;
      if(previous&&previous.code===code&&previous.binding===key&&previous.hasBatch===Boolean(batch))return;
      if(previous)dispose(host);
      const status=document.createElement('p');
      status.className='stock-chart-status';status.setAttribute('role','status');
      const match=typeof code==='string'&&/^(\d{6})\.(SH|SZ)$/.exec(code);
      const state={host,status,code,binding:key,hasBatch:Boolean(batch),batch:key?{generation:batch.generation,day:batch.day,sourceId:batch.sourceId,asOf:batch.asOf,attribution:batch.attribution}:null,window:60,data:null,selected:null,image:null,controller:null,symbol:match?(match[2]==='SH'?'SSE:':'SZSE:')+match[1]:null,name:typeof stock?.name==='string'?stock.name:code,phase:'waiting',near:false,epoch:0,timer:null,observer:null,script:null,frame:null};
      states.set(host,state);host.replaceChildren(status);
      if(!match||batch&&!key){phase(state,'unavailable','日K暂不可用');return;}
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
