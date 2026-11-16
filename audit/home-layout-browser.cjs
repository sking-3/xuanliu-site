'use strict';

const assert = require('node:assert/strict');

async function tape(page, scope, {motion}) {
  const body=scope.locator('body');
  const charts=scope.locator('[data-tape-group]:first-child a[data-symbol]');
  await charts.first().waitFor({state:'attached'});
  const symbols=await charts.evaluateAll(anchors=>[...new Set(anchors.map(anchor=>new URL(anchor.href).searchParams.get('tvwidgetsymbol')))]);
  assert.equal(await body.getAttribute('data-strip-mode'),'native');
  assert.equal(symbols.length,6);
  for (const symbol of ['SSE:000001','SZSE:399001','SZSE:399006','SSE:000688','HSI:HSI','FRED:NDQCOM']) {
    assert.ok(symbols.includes(symbol),'missing chart link for '+symbol);
  }
  const inputs=await charts.evaluateAll(anchors=>anchors.map(a=>({
    symbol:a.dataset.symbol,price:Number(a.querySelector('.tape-price').textContent.replace(/[,，]/g,'')),
    change:Number(a.querySelector('.tape-change').textContent.replace(/[,，%％]/g,'').replace('−','-')),
    kind:a.dataset.quoteKind ?? 'close',label:a.querySelector('.tape-kind').textContent,
    point:Number(a.dataset.price ?? a.dataset.close),close:Number(a.dataset.close),previousClose:Number(a.dataset.previousClose),
    previousDate:a.dataset.previousDate,
    date:a.querySelector('time').dateTime,source:a.querySelector('.tape-source').textContent,sourceURL:a.dataset.sourceUrl
  })));
  for(const item of inputs) {
    assert.ok(item.point>0 && item.close>0 && item.previousClose>0 && Math.abs(item.price-item.point)<=.0051,item.symbol+' displayed point value');
    assert.ok(Math.abs(item.change-(item.point/item.previousClose-1)*100)<=.0051,item.symbol+' index change');
    assert.ok(Number.isFinite(Date.parse(item.date)) && /^\d{4}-\d\d-\d\d$/.test(item.previousDate) && item.source,item.symbol+' dated source');
    if (item.kind==='delayed') {
      assert.equal(item.label,'延时报价');
      assert.match(item.date,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/);
      assert.ok(Math.abs(item.close-item.previousClose)<=.015,item.symbol+' delayed value must use the confirmed previous close');
    } else {
      assert.equal(item.kind,'close');
      assert.equal(item.label,'收盘');
      assert.match(item.date,/^\d{4}-\d\d-\d\d$/);
      assert.ok(item.previousDate<item.date && item.close===item.point,item.symbol+' dated closing point');
    }
    assert.ok(['web.ifzq.gtimg.cn','proxy.finance.qq.com'].includes(new URL(item.sourceURL).hostname));
  }
  if(scope!==page) {
    assert.ok(await page.locator('#index-ticker iframe').evaluate(frame=>{
      const rect=frame.getBoundingClientRect();
      return rect.height>=30 && rect.top<=1 && rect.width>=innerWidth*.95 &&
        document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===frame;
    }),'the top quote frame is offscreen or covered');
  }
  const sample=async()=>body.evaluate(node=>{
    const visibleNumbers=[],anchors=[...node.querySelectorAll('a[href*="tvwidgetsymbol"]')];
    const width=document.documentElement.clientWidth, height=document.documentElement.clientHeight;
    for (const anchor of anchors) {
      const walker=document.createTreeWalker(anchor.querySelector('.tape-price'),NodeFilter.SHOW_TEXT);
      for (let part=walker.nextNode();part;part=walker.nextNode()) {
        if (!/\d[\d,.]*/.test(part.textContent)||!part.textContent.trim()) continue;
        const range=document.createRange();range.selectNodeContents(part);
        for(const rect of range.getClientRects()) {
          const left=Math.max(0,rect.left), right=Math.min(width,rect.right), top=Math.max(0,rect.top), bottom=Math.min(height,rect.bottom);
          if(right-left<4 || bottom-top<3)continue;
          const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);
          if(hit && anchor.contains(hit)) visibleNumbers.push(part.textContent.trim());
        }
      }
    }
    return {visibleNumbers,width,height,firstX:anchors[0].getBoundingClientRect().left,displayed:node.innerText.slice(0,500)};
  });
  const initial=await sample();
  assert.ok(initial.visibleNumbers.length>0,'no uncovered, on-screen numeric index quote: '+JSON.stringify(initial));
  if (motion) {
    let next;
    for(let attempt=0;attempt<8;attempt++) {
      await page.waitForTimeout(180);
      next=await sample();
      if(Math.abs(next.firstX-initial.firstX)>2) break;
    }
    assert.ok(Math.abs(next.firstX-initial.firstX)>2,'the index tape did not move: '+JSON.stringify(initial));
    assert.ok(next.visibleNumbers.length>0,'the moving tape briefly blanked');
    return {inputs,visible:initial.visibleNumbers.slice(0,8),initialX:initial.firstX,subsequentX:next.firstX};
  }
  assert.equal(await scope.locator('.tape-track').evaluate(track=>getComputedStyle(track).animationName),'none','reduced motion preference');
  return {inputs,visible:initial.visibleNumbers.slice(0,8)};
}

async function ranking(page) {
  const panel = page.locator('#home-trader-ranking');
  const summary = page.locator('#market-radar .radar-rules summary');
  await panel.scrollIntoViewIfNeeded();
  await panel.locator('[data-ranking-period="30D"]').click();
  await panel.locator('#home-ranking-list[aria-busy="false"] .home-rank-row').first().waitFor();

  async function measure() {
    return panel.evaluate(async root => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const left = document.querySelector('#market-radar').getBoundingClientRect();
      const right = root.getBoundingClientRect();
      const list = root.querySelector('#home-ranking-list').getBoundingClientRect();
      const note = root.querySelector('#home-ranking-note').getBoundingClientRect();
      const shortGroup = root.querySelector('#home-ranking-short');
      const nextBlock = shortGroup && !shortGroup.hidden ? shortGroup.getBoundingClientRect() : note;
      const shown = [];
      for (const row of root.querySelectorAll('.home-rank-row')) {
        const box = row.getBoundingClientRect();
        if (box.height && box.top < list.bottom - 1 && box.bottom > list.top + 1) {
          shown.push({top: box.top, bottom: box.bottom,
            position: Number(row.querySelector('.home-rank-number').textContent),
            roi: Number(row.querySelector('.home-rank-profit strong').textContent.replace(/[,，%％]/g,'').replace('−','-'))});
        }
      }
      return {stacked: right.top >= left.bottom - 1, leftHeight: left.height, rightHeight: right.height,
        topOffset: right.top - left.top, bottomOffset: right.bottom - left.bottom, listHeight:list.height,
        rows: shown.length, totalRows:root.querySelectorAll('.home-rank-row').length,
        scrollable:root.querySelector('#home-ranking-list').scrollHeight>root.querySelector('#home-ranking-list').clientHeight+1,
        ordinals:shown.map(row => row.position), roi:shown.map(row => row.roi),
        gapBelowNote: right.bottom - note.bottom, gapAboveNote: nextBlock.top - Math.min(shown.at(-1)?.bottom ?? list.top,list.bottom)};
    });
  }

  const checkRows = state => {
    assert.ok(state.rows > 0 && state.roi.every(Number.isFinite),'visible ranked account returns are numeric');
    assert.deepEqual(state.ordinals,Array.from({length: state.rows},(_,i) => i+1));
    assert.deepEqual(state.roi,[...state.roi].sort((a,b) => b-a));
    assert.ok(state.gapBelowNote <= 32 && state.gapAboveNote <= 40,'empty area under the account rows: '+JSON.stringify(state));
  };
  const initial = await measure();
  checkRows(initial);
  const mobile = page.viewportSize().width <= 1140;
  assert.equal(initial.stacked, mobile,'market radar and ranking panel layout');
  if (!mobile) {
    assert.ok(Math.abs(initial.topOffset) <= 2 && Math.abs(initial.bottomOffset) <= 2,'desktop market and ranking edges must align: '+JSON.stringify(initial));
    assert.ok(initial.totalRows>3 && initial.scrollable,'desktop rankings must fill the column with comparable accounts');
    const list=panel.locator('#home-ranking-list');
    await list.evaluate(node=>{node.scrollTop=node.scrollHeight;});
    const scrolled=await measure();
    assert.equal(scrolled.ordinals.at(-1),initial.totalRows,'scrolling the rankings should reach the last comparable account');
    assert.ok(scrolled.ordinals[0]>1,'additional accounts must come into view');
    initial.lastAccountReached=scrolled.ordinals.at(-1);
    await list.evaluate(node=>{node.scrollTop=0;});
  } else {
    assert.ok(initial.totalRows<=3 && !initial.scrollable,'stacked views should show compact rankings without internal scrolling');
  }
  await summary.click();
  await page.waitForFunction(minimum => document.querySelector('#market-radar').getBoundingClientRect().height > minimum,
    initial.leftHeight+12);
  const expanded = await measure();
  checkRows(expanded);
  if (mobile) {
    assert.ok(expanded.stacked && Math.abs(expanded.rightHeight-initial.rightHeight)<=2,
      'the stacked rankings should use their own natural height');
  } else {
    assert.ok(!expanded.stacked && Math.abs(expanded.bottomOffset)<=2,'rankings did not follow the expanded market radar: '+JSON.stringify(expanded));
    assert.ok(expanded.rightHeight>initial.rightHeight+12,'rankings did not grow');
    assert.ok(expanded.listHeight>initial.listHeight+12,'extra space must go to the ranked account rows');
  }
  await summary.click();
  await panel.locator('[data-ranking-period="365D"]').click();
  await panel.locator('#home-ranking-list[aria-busy="false"] .home-rank-row').first().waitFor();
  const annual=await measure();
  checkRows(annual);
  if (!mobile && annual.totalRows<=2) {
    assert.ok(!annual.scrollable && annual.rightHeight<initial.rightHeight-12,'sparse annual records must use their natural height');
  }
  await panel.locator('[data-ranking-period="30D"]').click();
  return {initial,expanded,annual};
}

module.exports={ranking,tape};
