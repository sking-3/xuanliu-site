/* The provider renders quotes and news inside its own frames. No backend schedule. */
(() => {
  'use strict';
  const chart = new URL('chart.html', location.href).href;
  const settings = {
    active: {
      script:'embed-widget-mini-symbol-overview.js', title:'跨市场观察报价',
      config:{colorTheme:'light',dateRange:'1D',locale:'zh_CN',width:'100%',height:180,
        largeChartUrl:chart,isTransparent:true},
      symbols:{a:'SSE:000001',us:'NASDAQ:AAPL',crypto:'COINBASE:BTCUSD'},
      notes:{a:'上证指数 · CNY · 日终行情',us:'Apple · USD · 行情可能延迟',crypto:'Bitcoin · Coinbase现货 · USD'},
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
    const market=card.querySelector('.pulse-market');
    const host=card.querySelector('.pulse-host'),state=card.querySelector('.pulse-state'),buttons=card.querySelectorAll('[data-view]');
    let selected=card.dataset.defaultView||'live',observer=null,timer=null,generation=0,failed=false;
    function clear() {
      generation++;clearTimeout(timer);observer?.disconnect();host.replaceChildren();
    }
    function show() {
      live.hidden=selected!=='live';saved.hidden=selected==='live';
      for(const b of buttons)b.setAttribute('aria-pressed',String(b.dataset.view===selected));
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
        buttons[0].disabled=true;
      }
      observer=new MutationObserver(()=>{
        const frame=container.querySelector('iframe');
        if(stamp!==generation||!frame)return;
        frame.title=spec.title+' · TradingView';clearTimeout(timer);observer.disconnect();
        state.textContent=spec.notes?.[market?.value]||spec.note;
      });
      observer.observe(container,{childList:true,subtree:true});
      const script=document.createElement('script');script.async=true;
      script.src='https://s3.tradingview.com/external-embedding/'+spec.script;
      script.textContent=JSON.stringify({...spec.config,...(spec.symbols?{symbol:spec.symbols[market.value]}:{})});script.onerror=unavailable;
      timer=setTimeout(unavailable,15000);container.append(script);
    }
    const notice=document.createElement('p');notice.className='pulse-state pulse-failure';
    notice.hidden=true;notice.textContent='动态来源未加载，显示保存的快照。';card.append(notice);
    for(const b of buttons)b.addEventListener('click',()=>{selected=b.dataset.view;show();});
    market?.addEventListener('change',()=>{clear();show();});
    document.addEventListener('visibilitychange',show);
    show();
  }
})();
