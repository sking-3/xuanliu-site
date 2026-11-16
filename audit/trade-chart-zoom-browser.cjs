'use strict';
const assert=require('node:assert/strict');

module.exports=async function checkTradeChartZoom(page,base){
  // Mount the real chart through the saved account, keeping deterministic candles in this test only.
  const endpoint='https://fapi.binance.com/fapi/v1/klines*';
  await page.route(endpoint,async route=>{
    const q=new URL(route.request().url()).searchParams;
    const step=({'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000})[q.get('interval')];
    const end=Number(q.get('endTime')),bars=[];
    for(let t=Number(q.get('startTime'));t<=end&&bars.length<1500;t+=step){
      const value=100+bars.length%11;
      bars.push([t,String(value),String(value+2),String(value-1),String(value+1),'25']);
    }
    await route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(bars)});
  });
  await page.addInitScript(()=>{
    let api;
    Object.defineProperty(window,'BooksTradeChart',{configurable:true,get:()=>api,set(original){
      api={...original,mount(...args){
        const view=original.mount(...args);
        window.__replayZoomAudit={view,container:args[0]};
        return view;
      }};
    }});
  });
  const url=new URL('trader/',base);
  url.search=new URLSearchParams({exchange:'Binance',account:'5075281354358777856',view:'points'});
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  const legend=page.locator('#detail[open] .ta-chart-legend');
  const zoom=page.getByRole('group',{name:'图表缩放'});
  await zoom.waitFor({timeout:30000});
  await legend.waitFor();
  const snapshot=()=>page.evaluate(()=>{
    const {view,container}=window.__replayZoomAudit;
    const range=view.chart.timeScale().getVisibleLogicalRange(),canvas=container.querySelector('canvas');
    const selectors=['body','#detail','#detail-title','#detail .ta-chart-legend','#detail .ta-chart-tooltip','#detail .ta-replay-title h3','#detail .ta-attribution'];
    const fonts=selectors.map(s=>getComputedStyle(document.querySelector(s)).fontSize);
    const box=container.getBoundingClientRect();
    return {span:range.to-range.from,font:view.chart.options().layout.fontSize,fonts,width:box.width,height:box.height,
      canvasWidth:canvas.clientWidth,canvasHeight:canvas.clientHeight,visualScale:visualViewport?.scale||1,
      action:getComputedStyle(container).touchAction,documentTransform:getComputedStyle(document.body).transform,dialogTransform:getComputedStyle(document.querySelector('#detail')).transform,
      replay:document.querySelector('[aria-label="回放进度"]').value};
  });
  const spin=async()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await spin();
  const before=await snapshot();
  assert.ok(before.span>2);
  const plus=zoom.getByRole('button',{name:'放大图表',exact:true}),minus=zoom.getByRole('button',{name:'缩小图表',exact:true});
  const reset=zoom.getByRole('button',{name:'重置图表',exact:true});
  await plus.click();await spin();const enlarged=await snapshot();
  assert.ok(enlarged.span<before.span,'a shorter time range must be visible');
  await minus.click();await spin();const smaller=await snapshot();
  assert.ok(smaller.span>enlarged.span,'a longer time range must be visible');
  await reset.click();await spin();const restored=await snapshot();
  assert.ok(Math.abs(restored.span-before.span)<1,'restore the fitted extent to within one bar');
  for(const after of [enlarged,smaller,restored]){
    for(const key of ['font','fonts','width','height','visualScale','documentTransform','dialogTransform','replay']){
      assert.deepEqual(after[key],before[key],key+' must remain unchanged');
    }
    // Width of the time-axis pane may change slightly when different price ticks are printed.
    assert.ok(Math.abs(after.canvasWidth-before.canvasWidth)<16);
    assert.equal(after.canvasHeight,before.canvasHeight);
  }
  const outside=await page.evaluate(()=>{
    const target=document.querySelector('#detail-title');
    const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-50,ctrlKey:true});
    const events=[wheel];
    for(const type of ['touchstart','touchmove','touchend','gesturestart','gesturechange','gestureend']){
      const event=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperty(event,'touches',{value:type==='touchend'?[]:[{clientX:20,clientY:30},{clientX:65,clientY:30}]});
      events.push(event);
    }
    return {actions:[target,target.closest('dialog'),document.body,document.documentElement].map(e=>getComputedStyle(e).touchAction),
      viewport:document.querySelector('meta[name="viewport"]').content,
      canceled:events.filter(event=>!target.dispatchEvent(event)).map(event=>event.type)};
  });
  assert.deepEqual(outside.canceled,[],'gestures outside the chart must not be intercepted');
  assert.ok(outside.actions.every(value=>value==='auto'||value==='manipulation'||value.includes('pinch-zoom')));
  assert.doesNotMatch(outside.viewport,/user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\.0*)?(?=\s*(?:,|$))/i);
  await page.unroute(endpoint);
  return {candles:'deterministic test fixture',width:before.width,chartFont:before.font,logicalSpans:[before.span,enlarged.span,smaller.span,restored.span],
    visualScale:restored.visualScale,chartTouchAction:before.action,outsideTouchAction:outside.actions};
};
