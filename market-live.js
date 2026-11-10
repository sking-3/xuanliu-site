/* The provider renders quotes and news inside its own frames. No backend schedule. */
(() => {
  'use strict';
  const chart = new URL('chart.html', location.href).href;
  const settings = {
    active: {
      script:'embed-widget-market-overview.js', title:'Coinbase 美元现货报价',
      config:{colorTheme:'light',dateRange:'1D',showChart:false,locale:'zh_CN',width:'100%',height:215,
        largeChartUrl:chart,showSymbolLogo:false,tabs:[{title:'现货 / USD',symbols:[
          {s:'COINBASE:BTCUSD',d:'Bitcoin'},{s:'COINBASE:ETHUSD',d:'Ethereum'},{s:'COINBASE:SOLUSD',d:'Solana'}]}]},
      note:'Coinbase · USD · 来源未提供逐笔报价时间'
    },
    macro: {
      script:'embed-widget-timeline.js', title:'市场快讯',
      config:{feedMode:'all_symbols',displayMode:'regular',colorTheme:'light',locale:'zh_CN',width:'100%',height:215},
      note:'新闻按来源发布时间展示'
    }
  };
  for (const card of document.querySelectorAll('[data-pulse]')) {
    const spec=settings[card.dataset.pulse],live=card.querySelector('.pulse-live'),saved=card.querySelector('.pulse-saved');
    const host=card.querySelector('.pulse-host'),state=card.querySelector('.pulse-state'),buttons=card.querySelectorAll('[data-view]');
    let selected='live',observer=null,timer=null,generation=0,failed=false;
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
        state.textContent=spec.note;
      });
      observer.observe(container,{childList:true,subtree:true});
      const script=document.createElement('script');script.async=true;
      script.src='https://s3.tradingview.com/external-embedding/'+spec.script;
      script.textContent=JSON.stringify(spec.config);script.onerror=unavailable;
      timer=setTimeout(unavailable,15000);container.append(script);
    }
    const notice=document.createElement('p');notice.className='pulse-state pulse-failure';
    notice.hidden=true;notice.textContent='动态来源未加载，显示保存的快照。';card.append(notice);
    for(const b of buttons)b.addEventListener('click',()=>{selected=b.dataset.view;show();});
    document.addEventListener('visibilitychange',show);
    show();
  }
})();
