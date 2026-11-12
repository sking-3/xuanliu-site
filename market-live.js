/* Provider-owned quotes/news. Rotation runs only while the live panel is visible. */
(() => {
  'use strict';
  const chart = new URL('chart.html', location.href).href;
  const rotationMs=3*60*1000;
  const settings = {
    active: {
      script:'embed-widget-mini-symbol-overview.js', title:'跨市场观察报价',
      config:{colorTheme:'light',dateRange:'1D',locale:'zh_CN',width:'100%',height:180,
        largeChartUrl:chart,isTransparent:true},
      symbols:{a:'SSE:000001',us:'NASDAQ:AAPL',crypto:'COINBASE:BTCUSD'},
      names:{a:'A股 · 上证指数',us:'美股 · Apple',crypto:'加密 · Bitcoin'},
      notes:{a:'上证指数 · CNY · 日终；来源未提供报价时间',us:'Apple · USD · 可能延迟；来源未提供逐笔时间',crypto:'Bitcoin · Coinbase · USD；来源未提供逐笔时间'},
      note:'观察标的报价 · 时效以来源标记为准'
    },
    macro: {
      script:'embed-widget-timeline.js', title:'市场快讯',
      config:{feedMode:'all_symbols',displayMode:'regular',colorTheme:'light',locale:'zh_CN',width:'100%',height:215},
      note:'新闻按来源发布时间展示'
    }
  };
  for (const card of document.querySelectorAll('[data-pulse]')) {
    const spec=settings[card.dataset.pulse],live=card.querySelector('.pulse-live'),saved=card.querySelector('.pulse-saved');
    const marketName=card.querySelector('.pulse-market-name'),pause=card.querySelector('.pulse-pause');
    const host=card.querySelector('.pulse-host'),state=card.querySelector('.pulse-state'),buttons=card.querySelectorAll('[data-view]');
    const markets=Object.keys(spec.symbols||{});
    let marketIndex=1,paused=false,rotationTimer=null,nextRotationAt=null,remaining=rotationMs;
    let selected=card.dataset.defaultView||'live',observer=null,timer=null,generation=0,failed=false;
    const currentMarket=()=>markets[marketIndex];
    const rotationNote=card.querySelector('.pulse-rotation-note');
    function progress(){if(!rotationNote)return;const seconds=Math.max(0,Math.ceil(((nextRotationAt||Date.now()+remaining)-Date.now())/1000));rotationNote.textContent=paused?'轮播已暂停':`自动轮播 · ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} 后切换 · A股 / 美股 / 加密`;}
    function stopRotation(){clearTimeout(rotationTimer);rotationTimer=null;}
    function rotateLater(){
      stopRotation();
      if(markets.length<2||paused||failed||selected!=='live'||document.hidden)return;
      if(nextRotationAt===null)nextRotationAt=Date.now()+remaining;
      progress();rotationTimer=setTimeout(()=>{marketIndex=(marketIndex+1)%markets.length;nextRotationAt=Date.now()+rotationMs;remaining=rotationMs;clear();show();},Math.max(0,nextRotationAt-Date.now()));
    }
    function clear() {
      generation++;clearTimeout(timer);stopRotation();observer?.disconnect();host.replaceChildren();
    }
    function show() {
      if(markets.length>1&&!paused&&nextRotationAt!==null&&Date.now()>=nextRotationAt){const steps=1+Math.floor((Date.now()-nextRotationAt)/rotationMs);marketIndex=(marketIndex+steps)%markets.length;nextRotationAt+=steps*rotationMs;clear();}
      live.hidden=selected!=='live';saved.hidden=selected==='live';
      for(const b of buttons)b.setAttribute('aria-pressed',String(b.dataset.view===selected));
      if(marketName)marketName.textContent=spec.names[currentMarket()];
      if(live.hidden || document.hidden){clear();return;}
      if(host.firstChild || failed)return;
      const stamp=++generation;
      const container=document.createElement('div'),slot=document.createElement('div');
      container.className='tradingview-widget-container';slot.className='tradingview-widget-container__widget';
      container.append(slot);host.append(container);state.textContent='正在连接来源…';
      function unavailable() {
        if(stamp!==generation)return;
        clear();failed=true;selected='saved';show();
        const notice=card.querySelector('.pulse-failure');notice.hidden=false;
        buttons[0].disabled=true;if(pause)pause.disabled=true;
      }
      observer=new MutationObserver(()=>{
        const frame=container.querySelector('iframe');
        if(stamp!==generation||!frame)return;
        frame.title=spec.title+' · '+(spec.names?.[currentMarket()]||'市场快讯')+' · TradingView';clearTimeout(timer);observer.disconnect();
        state.textContent=spec.notes?.[currentMarket()]||spec.note;rotateLater();
      });
      observer.observe(container,{childList:true,subtree:true});
      const script=document.createElement('script');script.async=true;
      script.src='https://s3.tradingview.com/external-embedding/'+spec.script;
      script.textContent=JSON.stringify({...spec.config,...(spec.symbols?{symbol:spec.symbols[currentMarket()]}:{})});script.onerror=unavailable;
      timer=setTimeout(unavailable,15000);container.append(script);
    }
    const notice=document.createElement('p');notice.className='pulse-state pulse-failure';
    notice.hidden=true;notice.textContent='动态来源未加载，显示保存的快照。';card.append(notice);
    for(const b of buttons)b.addEventListener('click',()=>{selected=b.dataset.view;show();});
    pause?.addEventListener('click',()=>{
      if(!paused)remaining=nextRotationAt===null?rotationMs:Math.max(0,nextRotationAt-Date.now());else nextRotationAt=Date.now()+remaining;
      paused=!paused;pause.setAttribute('aria-pressed',String(paused));pause.textContent=paused?'继续轮播':'暂停轮播';progress();
      if(paused)stopRotation();else rotateLater();
    });
    document.addEventListener('visibilitychange',show);
    if(markets.length>1)setInterval(()=>{if(!document.hidden&&selected==='live')progress();},1000);
    show();
  }
})();
