'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');

const engine = process.env.HOME_BROWSER_ENGINE || 'chromium';
const site = new URL(process.env.HOME_BROWSER_URL || 'http://127.0.0.1:8784/');
const output = path.join(__dirname, 'browser-output/home-dashboard');
const viewports = [{width:1440,height:900}, {width:390,height:844}];
const heatmapRepo = 'https://github.com/wenyuanw/a-share-heatmap';
const watchTagsModule = 'https://widgets.tradingview-widget.com/w/zh_CN/tv-ticker-tag.js';
const observed = ['SSE:600519','SZSE:000858','SSE:601398','SZSE:000333','SSE:600036','SZSE:002594','SSE:601318','SZSE:300750'];
const compactChanges = Object.fromEntries(observed.map((symbol,index)=>[symbol,['+1.25%','−0.50%','0.00%','+2.91%','+0.70%','−0.41%','+0.88%','−0.96%'][index]]));
const intradaySources = {
  a: 'https://quote.eastmoney.com/changes/',
  us: 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts',
};

async function checkLinks(page) {
  const urls = await page.locator('.index-labels a, .research-actions a, [data-home-radar] a').evaluateAll(links => links.map(a => a.href));
  assert.ok(urls.length >= 10, 'index, research and radar action links rendered');
  for (const href of urls) {
    const url = new URL(href);
    if(url.origin!==site.origin){
      assert.equal(url.protocol,'https:');
      if (Object.values(intradaySources).includes(url.href) || url.href === 'https://dapan.app/' ||
          url.href === heatmapRepo || url.href === heatmapRepo+'/' ||
          /^https:\/\/(?:raw\.githubusercontent\.com\/wenyuanw\/a-share-heatmap\/|github\.com\/wenyuanw\/a-share-heatmap\/blob\/)(?:main|[a-f0-9]{40})\/src\/lib\/data\/market-heatmap-fallback\.json$/.test(url.href)) continue;
      assert.ok(['www.tradingview.com','cn.tradingview.com'].includes(url.hostname),href);
      assert.ok(url.pathname === '/markets/stocks-china/' ||
        /^\/markets\/stocks-(?:china|usa)\/market-movers-(?:gainers|losers|active)\/$/.test(url.pathname),href);
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
  let failUs = false, failWatch = false, failTags = false;
  await context.addInitScript(() => {
    if (window !== top) return;
    window.watchWidgetEvents = [];
    addEventListener('message', event => {
      const frame = document.querySelector('[data-equity-watch] iframe[src*="home-watch-quotes.html"]');
      if (event.origin === location.origin && frame?.contentWindow === event.source && event.data?.type === 'books:watch-widget') {
        window.watchWidgetEvents.push({status:event.data.status,count:event.data.count});
      }
    }, true);
  });
  // Deterministic read-only Bitget input goes through the site's normal REST and socket adapters.
  await context.routeWebSocket('**/v2/ws/public', socket => {tickerSocket = socket;});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if(url.origin===site.origin && url.pathname==='/home-widget-test.html'){
      return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Test chart</title><p>Controlled chart frame</p>'});
    }
    if (url.hostname === 'raw.githubusercontent.com' && url.pathname.includes('/wenyuanw/a-share-heatmap/')) {
      return route.abort();
    }
    if (url.origin === site.origin) return route.continue();
    if (url.href === watchTagsModule) {
      if (failTags === 'offline') return route.abort();
      return route.fulfill({contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},body:`
        const dailyChanges=${JSON.stringify(compactChanges)};
        customElements.define('tv-ticker-pill',class extends HTMLElement {
          connectedCallback() {
            const root=this.attachShadow({mode:'closed'});
            root.innerHTML='<span class="name"></span><span class="change"></span>';
            const symbol=this.getAttribute('symbol');
            const missing=(${JSON.stringify(failTags)} === 'partial' && symbol === 'SZSE:300750');
            root.querySelector('.name').textContent=symbol.split(':')[1];
            root.querySelector('.change').textContent=missing ? '—' : dailyChanges[symbol];
            for (const dataType of ['quote/chp','symbolInfo/name']) {
              const id=Symbol(dataType);
              this.dispatchEvent(new CustomEvent('data-request',{bubbles:true,composed:true,detail:{dataType,consumerId:id}}));
              this.dispatchEvent(new CustomEvent('loading-status-changed',{bubbles:true,composed:true,detail:{
                requestId:id,status:missing && dataType === 'quote/chp' ? 'error' : 'completed'
              }}));
            }
          }
        });
        customElements.define('tv-ticker-tag',class extends HTMLElement {
          connectedCallback() {
            const root=this.attachShadow({mode:'closed'}), pill=document.createElement('tv-ticker-pill');
            pill.setAttribute('symbol',this.getAttribute('symbol'));
            root.append(pill);
          }
        });
      `});
    }
    if(url.href==='https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js'){
      return route.fulfill({contentType:'application/javascript',body:`
        const fixtureFrame=document.createElement('iframe');
        fixtureFrame.src='/home-widget-test.html';
        document.currentScript.parentNode.querySelector('.tradingview-widget-container__widget').append(fixtureFrame);
      `});
    }
    const widget = url.pathname.match(/\/external-embedding\/embed-widget-(screener|market-overview)\.js$/)?.[1];
    if (url.hostname === 's3.tradingview.com' && widget) {
      if (widget === 'screener' && failUs) {
        failUs = false;
        return route.abort();
      }
      return route.fulfill({contentType:'application/javascript',body:`
        (() => {
          const script = document.currentScript;
          if (!script.closest('[data-home-radar]') || (${JSON.stringify(failWatch)} && script.closest('[data-equity-watch]'))) {
            script.dispatchEvent(new Event('error'));
            return;
          }
          const config = JSON.parse(script.textContent);
          const frame = document.createElement('iframe');
          const sequence = window.screenerTestSequence = (window.screenerTestSequence || 0) + 1;
          frame.src = '/home-widget-test.html?' + new URLSearchParams({widget:${JSON.stringify(widget)}, config:JSON.stringify(config), sequence});
          script.parentNode.querySelector('.tradingview-widget-container__widget').append(frame);
        })();
      `});
    }
    if (url.hostname === 'api.bitget.com' && url.pathname === '/api/v2/spot/market/tickers') {
      firstTime ??= Date.now() - 60000;
      return route.fulfill({json:{code:'00000',data:[{symbol:'BTCUSDT',lastPr:'100',change24h:'0.025',ts:String(firstTime)}]},headers:{'access-control-allow-origin':'*'}});
    }
    return route.abort();
  });
  const panels = {
    a:page.locator('.radar-stocks [data-mover-market="a"]'),
    us:page.locator('.radar-stocks [data-mover-market="us"]'),
  };
  const boards = {
    daily: panels.a.locator('.radar-main-body'),
    watch: page.locator('.radar-stocks > [data-equity-watch]'),
    us: panels.us,
  };
  async function inspectDaily() {
    const panel = boards.daily;
    assert.equal(await panel.locator('iframe').count(),0,'native A-share daily lists');
    const asOf = panel.locator('[data-daily-asof]');
    await asOf.waitFor();
    const date = await asOf.innerText();
    assert.match(date,/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/,'daily snapshot date is visible');
    const evidence = {date};
    for (const side of ['gainers','losers']) {
      const rows = panel.locator('[data-daily-side="'+side+'"] li');
      await rows.first().waitFor();
      const texts = await rows.allInnerTexts();
      assert.ok(texts.length >= 1 && texts.length <= 3,side+' shows up to three securities');
      const codes = texts.map((row, index) => {
        const code = row.match(/\d{6}/)?.[0];
        assert.ok(code,'stock code at rank '+(index+1)+' in '+side);
        assert.match(row,/\p{Script=Han}/u,'stock name at rank '+(index+1)+' in '+side);
        assert.doesNotMatch(row,/\d\s*[%％]/,'bundled rank has no copied quote percentage');
        return code;
      });
      assert.equal(new Set(codes).size,texts.length,'no duplicate ranks in '+side);
      evidence[side] = codes;
    }
    return evidence;
  }
  async function inspectBoard(key, direction='gainers') {
    const board = boards[key];
    const frames = board.locator('.radar-mover-stage iframe[src*="home-widget-test.html?"]');
    await frames.waitFor({state:'visible'});
    assert.equal(await board.locator('.radar-mover-stage iframe').count(),1);
    const src = await frames.getAttribute('src');
    const params = new URL(src,site).searchParams;
    const config = JSON.parse(params.get('config'));
    if (key === 'watch') {
      assert.equal(params.get('widget'),'market-overview');
      assert.equal(config.tabs.length,1,'one tab for both exchanges');
      const codes = config.tabs[0].symbols.map(symbol => symbol.s);
      assert.equal(codes.length,8);
      assert.equal(new Set(codes).size,8);
      assert.equal(codes.filter(code => /^SSE:\d{6}$/.test(code)).length,4);
      assert.equal(codes.filter(code => /^SZSE:\d{6}$/.test(code)).length,4);
    } else {
      assert.equal(params.get('widget'),'screener');
      assert.equal(config.market,'america');
      assert.equal(config.defaultScreen,'top_'+direction);
      assert.equal(await board.locator('button[data-kind="'+direction+'"]').getAttribute('aria-pressed'),'true');
    }
    return src;
  }
  async function compactWatch() {
    const frame = boards.watch.locator('.radar-mover-stage iframe[src*="home-watch-quotes.html"]');
    await page.waitForFunction(() => window.watchWidgetEvents.some(event => event.status === 'ready' && event.count === 8));
    await frame.waitFor();
    const rows = frame.contentFrame().locator('[data-watch-symbol]');
    await rows.nth(7).waitFor();
    assert.equal(await rows.count(),8);
    const symbols = await rows.evaluateAll(elements => elements.map(row=>row.dataset.watchSymbol));
    assert.deepEqual([...symbols].sort(),[...observed].sort());
    for (const symbol of observed) {
      const row = frame.contentFrame().locator('[data-watch-symbol="'+symbol+'"]');
      assert.match(await row.innerText(),/\p{Script=Han}/u);
      const stockURL = new URL(await row.locator('a.stock').getAttribute('href'),site);
      assert.equal(stockURL.searchParams.get('tvwidgetsymbol'),symbol);
      const tag = row.locator('tv-ticker-tag');
      assert.equal(await tag.getAttribute('symbol'),symbol);
      assert.ok(await tag.evaluate(element=>element.shadowRoot===null),'closed vendor component');
    }
    assert.equal(await boards.watch.getAttribute('data-watch-mode'),'compact');
    return frame;
  }
  try {
    await page.goto(new URL('index.html', site).href, {waitUntil:'domcontentloaded'});
    const initial = {};
    initial.daily = await inspectDaily();
    const initialCompact = await compactWatch();
    await initialCompact.evaluate(frame => {frame.dataset.testIdentity='initial';});
    initial.us = await inspectBoard('us');
    for (const market of ['a','us']) {
      const minute = page.locator('.radar-minutes [data-minute-market="'+market+'"]');
      assert.equal(await minute.locator('.radar-status').count(),1);
      const actualSources = await minute.locator('a').evaluateAll(links => links.map(link => link.href));
      assert.ok(actualSources.includes(intradaySources[market]),'market-specific intraday source for '+market);
    }
    console.log(engine,viewport.width,'native daily lists, eight Shanghai/Shenzhen stocks and US gainers loaded before interaction',initial.daily);
    await page.locator('#insight-macro').getByText(/国家统计局/).first().waitFor();
    await page.locator('.radar-crypto .radar-rows').getByText('BTC-USDT').waitFor();
    assert.ok(tickerSocket, 'Bitget socket connected');
    assert.match(await page.locator('.radar-crypto').innerText(),/24 小时涨跌/);
    tickerSocket.send(JSON.stringify({data:[{instId:'BTCUSDT',lastPr:'102',change24h:'0.045',ts:String(firstTime+60000)}]}));
    await page.locator('.radar-crypto .radar-rows').getByText('近 1 分钟异动').waitFor();
    assert.match(await page.locator('.radar-crypto .radar-rows').innerText(),/\+2\.00%/);
    await page.waitForFunction(() => {
      const sections = [...document.querySelectorAll('.radar-minutes .radar-status')];
      return sections.length === 2 && sections.every(el => !/正在读取|无法读取/.test(el.textContent));
    });

    const geometry = await page.evaluate(() => {
      const box = el => {const {x,y,width,height} = el.getBoundingClientRect(); return {x,y,width,height};};
      return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cards:[...document.querySelectorAll('.market-card-grid > .feed-card')].map(box),
        footers:[...document.querySelectorAll('#market-insights > article')].map(card=>{
          const footer=card.querySelector('.insight-footer');
          return {rowTop:box(card).y,bottom:footer.getBoundingClientRect().bottom,sourceY:box(footer.querySelector('.insight-source')).y};
        }),
        radar:['[data-mover-market=a]','.radar-crypto','[data-mover-market=us]','[data-equity-watch]'].map(selector=>box(document.querySelector('.radar-stocks > '+selector))),
        quoteStages:['[data-mover-market=us]','[data-equity-watch]'].map(selector=>box(document.querySelector('.radar-stocks > '+selector+' .radar-mover-stage'))),
        overview:box(document.querySelector('#market-insights')),index:box(document.querySelector('.index-labels')),macro:document.querySelector('#insight-macro').innerText};
    });
    console.log(engine,JSON.stringify(geometry));
    fs.writeFileSync(prefix+'-layout.json',JSON.stringify(geometry,null,2));
    assert.equal(geometry.cards.length,3);
    assert.ok(geometry.scrollWidth <= viewport.width+1,'no horizontal overflow');
    if (!mobile) {
      const [a,crypto,us,watch] = geometry.radar;
      assert.ok(Math.abs(a.y-crypto.y)<=1 && Math.abs(us.y-watch.y)<=1 && us.y>a.y,'two radar rows');
      assert.ok(Math.abs(a.x-us.x)<=1 && Math.abs(crypto.x-watch.x)<=1 && crypto.x>a.x,'two radar columns');
      const [left,right] = geometry.quoteStages;
      assert.ok(left.height>0 && Math.abs(left.height-right.height)<=1 && Math.abs(left.y-right.y)<=1,'quote viewports align');
    }
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
    failUs = true;
    await panels.us.locator('[data-kind="losers"]').click();
    await panels.us.locator('.radar-retry').waitFor();
    assert.equal(await panels.us.locator('.radar-mover-stage iframe').count(),0);
    for (const kind of ['gainers','losers']) {
      await panels.us.locator('.radar-mover-sources a[href$="/stocks-usa/market-movers-'+kind+'/"]').waitFor();
    }
    assert.deepEqual(await inspectDaily(),initial.daily);
    assert.equal(await initialCompact.getAttribute('data-test-identity'),'initial');
    await panels.us.locator('.radar-retry').click();
    const usLosers = await inspectBoard('us','losers');
    assert.deepEqual(await inspectDaily(),initial.daily);
    assert.equal(await initialCompact.getAttribute('data-test-identity'),'initial');
    await page.locator('.radar-stocks').screenshot({path:prefix+'-stock-radar.png'});
    await checkLinks(page);

    await boards.watch.locator('[data-watch-view="quotes"]').click();
    await inspectBoard('watch');
    assert.equal(await boards.watch.getAttribute('data-watch-mode'),'quotes');
    assert.equal(await inspectBoard('us','losers'),usLosers);
    await boards.watch.locator('[data-watch-view="compact"]').click();
    await compactWatch();
    assert.equal(await inspectBoard('us','losers'),usLosers);

    failTags = 'partial';
    await page.reload({waitUntil:'domcontentloaded'});
    await inspectBoard('watch');
    assert.equal(await boards.watch.getAttribute('data-watch-mode'),'fallback');
    assert.ok(await page.evaluate(()=>window.watchWidgetEvents.some(event => event.status === 'unavailable' && event.count === 7)),
      'seven quoted stocks cannot pass as a complete eight-stock watch');
    assert.deepEqual(await inspectDaily(),initial.daily);
    await inspectBoard('us');

    failTags = 'offline';
    failWatch = true;
    await page.reload({waitUntil:'domcontentloaded'});
    await boards.watch.locator('.radar-retry').waitFor();
    assert.deepEqual(await inspectDaily(),initial.daily);
    const usOnReload = await inspectBoard('us');
    failWatch = false;
    await boards.watch.locator('.radar-retry').click();
    await inspectBoard('watch');
    failTags = false;
    await boards.watch.locator('[data-watch-view="compact"]').click();
    await compactWatch();
    assert.deepEqual(await inspectDaily(),initial.daily);
    assert.equal(await inspectBoard('us'),usOnReload);
    console.log(engine,viewport.width,'native lists survive remote outage and both quote widgets recover independently');

    const ranking = page.locator('#home-trader-ranking');
    await ranking.scrollIntoViewIfNeeded();
    let detailURL, detailName;
    for(const period of ['30D','90D','365D']){
      await ranking.locator('[data-ranking-period="'+period+'"]').click();
      await page.waitForFunction(() => document.querySelector('#home-ranking-list[aria-busy="false"] .home-rank-row'));
      const list = ranking.locator('#home-ranking-list');
      if(period!=='30D'){
        const row = list.locator('.home-rank-row').first();
        detailName = await row.locator('.home-rank-name').innerText();
        assert.match(await row.innerText(),/USDT/);
        detailURL = new URL(await row.locator('.home-rank-identity').getAttribute('href'),site);
        assert.equal(detailURL.searchParams.get('period'),period);
        assert.ok(['Binance','OKX','Bitget','Hyperliquid'].includes(detailURL.searchParams.get('exchange')));
      }
      const more = new URL(await ranking.locator('#home-ranking-more').getAttribute('href'),site);
      assert.equal(more.searchParams.get('period'),period);
      assert.equal(more.searchParams.get('exchange'),'all');
      console.log(engine,viewport.width,period,await ranking.locator('#home-ranking-status').innerText(),await list.locator('.home-rank-profit').allInnerTexts());
    }
    await ranking.screenshot({path:prefix+'-ranking.png'});
    await page.goto(detailURL.href,{waitUntil:'domcontentloaded'});
    await page.locator('#detail[open]').waitFor({timeout:30000});
    assert.ok((await page.locator('#detail').innerText()).includes(detailName));
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
