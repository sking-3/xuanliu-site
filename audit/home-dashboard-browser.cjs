'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');

const engine = process.env.HOME_BROWSER_ENGINE || 'chromium';
const site = new URL(process.env.HOME_BROWSER_URL || 'http://127.0.0.1:8784/');
const output = path.join(__dirname, 'browser-output/home-dashboard');
const viewports = [{width:1440,height:900}, {width:390,height:844}];

async function checkLinks(page) {
  const urls = await page.locator('.index-labels a, .research-actions a, [data-home-radar] a').evaluateAll(links => links.map(a => a.href));
  assert.ok(urls.length >= 10, 'index, research and radar action links rendered');
  for (const href of urls) {
    const url = new URL(href);
    if(url.origin!==site.origin){
      assert.equal(url.protocol,'https:');
      assert.ok(['www.tradingview.com','cn.tradingview.com'].includes(url.hostname),href);
      assert.match(url.pathname,/^\/markets\/stocks-(?:china|usa)\/market-movers[-/]/);
      continue;
    }
    const response = await page.request.get(href);
    assert.equal(response.status(), 200, href);
    if (url.hash) {
      const found = await page.evaluate(({html, id}) => Boolean(new DOMParser().parseFromString(html, 'text/html').getElementById(id)), {html: await response.text(), id: decodeURIComponent(url.hash.slice(1))});
      assert.ok(found, 'target fragment exists: '+href);
    }
  }
}

async function inspect(browser, viewport) {
  const mobile = viewport.width < 600;
  const context = await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  const page = await context.newPage(), errors = [];
  const prefix = path.join(output,engine+'-'+viewport.width);
  page.on('pageerror', err => errors.push(err.message));
  let firstTime, tickerSocket;
  // Deterministic read-only Bitget input goes through the site's normal REST and socket adapters.
  await context.routeWebSocket('**/v2/ws/public', socket => {tickerSocket = socket;});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if(url.origin===site.origin && url.pathname==='/home-widget-test.html'){
      return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Test chart</title><p>Controlled chart frame</p>'});
    }
    if (url.origin === site.origin) return route.continue();
    if(url.href==='https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js'){
      return route.fulfill({contentType:'application/javascript',body:`
        const fixtureFrame=document.createElement('iframe');
        fixtureFrame.src='/home-widget-test.html';
        document.currentScript.parentNode.querySelector('.tradingview-widget-container__widget').append(fixtureFrame);
      `});
    }
    if (url.hostname === 'api.bitget.com' && url.pathname === '/api/v2/spot/market/tickers') {
      firstTime ??= Date.now() - 60000;
      return route.fulfill({json:{code:'00000',data:[{symbol:'BTCUSDT',lastPr:'100',change24h:'0.025',ts:String(firstTime)}]},headers:{'access-control-allow-origin':'*'}});
    }
    return route.abort();
  });
  try {
    await page.goto(new URL('index.html', site).href, {waitUntil:'domcontentloaded'});
    await page.locator('#insight-macro').getByText(/国家统计局/).first().waitFor();
    await page.locator('.radar-crypto .radar-rows').getByText('BTC-USDT').waitFor();
    assert.ok(tickerSocket, 'Bitget socket connected');
    assert.match(await page.locator('.radar-crypto').innerText(),/24 小时涨跌/);
    tickerSocket.send(JSON.stringify({data:[{instId:'BTCUSDT',lastPr:'102',change24h:'0.045',ts:String(firstTime+60000)}]}));
    await page.locator('.radar-crypto .radar-rows').getByText('近 1 分钟异动').waitFor();
    assert.match(await page.locator('.radar-crypto .radar-rows').innerText(),/\+2\.00%/);
    await page.waitForFunction(() => {
      const sections = [...document.querySelectorAll('.radar-stocks .radar-status')];
      return sections.length === 2 && sections.every(el => !/正在读取|无法读取/.test(el.textContent));
    });

    const geometry = await page.evaluate(() => {
      const box = el => {const {x,y,width,height} = el.getBoundingClientRect(); return {x,y,width,height};};
      return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cards:[...document.querySelectorAll('.market-card-grid > .feed-card')].map(box),
        footers:[...document.querySelectorAll('#market-insights > article')].map(card=>{
          const footer=card.querySelector('.insight-footer');
          return {rowTop:box(card).y,bottom:footer.getBoundingClientRect().bottom,sourceY:box(footer.querySelector('.insight-source')).y};
        }),
        overview:box(document.querySelector('#market-insights')),index:box(document.querySelector('.index-labels')),macro:document.querySelector('#insight-macro').innerText};
    });
    console.log(engine,JSON.stringify(geometry));
    fs.writeFileSync(prefix+'-layout.json',JSON.stringify(geometry,null,2));
    assert.equal(geometry.cards.length,3);
    assert.ok(geometry.scrollWidth <= viewport.width+1,'no horizontal overflow');
    for(const card of geometry.cards){
      assert.ok(Math.abs(card.width-geometry.cards[0].width)<=1 && Math.abs(card.height-geometry.cards[0].height)<=1,'equal quote cards');
      assert.ok(card.height>100 && card.height<=450,'compact positive card height');
    }
    if(mobile) assert.ok(geometry.cards[1].y>geometry.cards[0].y,'mobile stacked cards');
    else assert.ok(geometry.cards.every(card=>Math.abs(card.y-geometry.cards[0].y)<=1),'desktop same row');
    assert.ok(geometry.index.y < geometry.cards[0].y,'index navigation above quotes');
    assert.equal(geometry.footers.length,4);
    for(const a of geometry.footers)for(const b of geometry.footers){
      if(Math.abs(a.rowTop-b.rowTop)>1)continue;
      assert.ok(Math.abs(a.bottom-b.bottom)<=2,'source footers align across the row');
      if(!mobile)assert.ok(Math.abs(a.sourceY-b.sourceY)<=2,'desktop source labels align');
    }
    await page.screenshot({path:prefix+'-overview.png'});
    const drawer=page.locator('.home-quote-detail');
    await drawer.locator('summary').click();
    await drawer.locator('.pulse-host[data-pulse-state=embedded] iframe').waitFor();
    const detailGeometry=await drawer.evaluate(el=>{
      const frame=el.querySelector('iframe').getBoundingClientRect();
      const foot=el.querySelector('.pulse-source').getBoundingClientRect();
      return {frameHeight:frame.height,frameBottom:frame.bottom,footerTop:foot.top};
    });
    console.log(engine,viewport.width,'expandedChart',JSON.stringify(detailGeometry));
    assert.ok(Math.abs(detailGeometry.frameHeight-180)<=1,'complete chart frame renders at 180px');
    assert.ok(detailGeometry.footerTop>=detailGeometry.frameBottom-1,'source note lies below the frame');
    await drawer.screenshot({path:prefix+'-expanded-chart.png'});
    await drawer.locator('summary').click();
    await page.locator('.market-card-grid').screenshot({path:prefix+'-markets.png'});
    for (const [i, market] of ['china','usa'].entries()) {
      await page.locator('.radar-stocks button').nth(i).click();
      const panel = page.locator('#home-stock-movers');
      for (const kind of ['gainers','losers']) {
        await panel.locator('[data-kind="'+kind+'"]').click();
        assert.equal(await panel.locator('[aria-pressed="true"]').getAttribute('data-kind'), kind);
        const source = panel.locator('.radar-mover-sources a[href$="market-movers-'+kind+'/"]');
        assert.ok((await source.getAttribute('href')).includes('/stocks-'+market+'/'));
      }
    }
    await checkLinks(page);

    const ranking = page.locator('#home-trader-ranking');
    await ranking.scrollIntoViewIfNeeded();
    let detailURL;
    for(const period of ['30D','90D','365D']){
      await ranking.locator('[data-ranking-period="'+period+'"]').click();
      await page.waitForFunction(() => document.querySelector('#home-ranking-list[aria-busy="false"] .home-rank-row'));
      const list = ranking.locator('#home-ranking-list');
      if(period!=='30D'){
        const row = list.locator('.home-rank-row').filter({hasText:'熬鹰资本'});
        assert.match(await row.innerText(),/USDT/);
        detailURL = new URL(await row.locator('a').getAttribute('href'),site);
        assert.equal(detailURL.searchParams.get('period'),period);
        assert.equal(detailURL.searchParams.get('exchange'),'Binance');
      }
      const more = new URL(await ranking.locator('#home-ranking-more').getAttribute('href'),site);
      assert.equal(more.searchParams.get('period'),period);
      assert.equal(more.searchParams.get('exchange'),'all');
      console.log(engine,viewport.width,period,await ranking.locator('#home-ranking-status').innerText(),await list.locator('.home-rank-profit').allInnerTexts());
    }
    await ranking.screenshot({path:prefix+'-ranking.png'});
    await page.goto(detailURL.href,{waitUntil:'domcontentloaded'});
    await page.locator('#detail[open]').waitFor({timeout:30000});
    assert.match(await page.locator('#detail').innerText(),/熬鹰资本/);
    assert.equal(await page.locator('#period').inputValue(),'365D');
    assert.deepEqual(errors,[]);
  } catch (error) {
    await page.screenshot({path:prefix+'-failure.png'}).catch(()=>{});
    throw error;
  } finally {
    await context.close();
  }
}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser = await playwright[engine].launch({headless:true});
  try {for (const viewport of viewports) await inspect(browser,viewport);}
  finally {await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
