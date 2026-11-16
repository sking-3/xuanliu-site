'use strict';
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const timeout = 45000;
const output = 'audit/browser-output/home-dashboard';
const home = process.env.HOME_PROVIDER_URL || 'http://127.0.0.1:8784/index.html';
const percentage = /[+−-]?\d[\d,]*(?:\.\d+)?\s*%/;
const price = /\d/;
const dailySource = 'https://raw.githubusercontent.com/wenyuanw/a-share-heatmap/main/src/lib/data/market-heatmap-fallback.json';
const watchSymbols = {
  SSE: new Set(['SSE:600519','SSE:601398','SSE:600036','SSE:601318']),
  SZSE: new Set(['SZSE:000858','SZSE:000333','SZSE:002594','SZSE:300750'])
};

function numeric(raw) {
  return Number(raw.trim().replace(/[,\s%]/g, '').replace(/−/g, '-'));
}

async function watchRows(panel, exchange) {
  const rows = panel.locator('.js-quote-ticker[data-symbol^="' + exchange + ':"]:visible')
    .filter({has: panel.page().locator('.js-symbol-last').filter({hasText:price})})
    .filter({has: panel.page().locator('.js-symbol-change-pt').filter({hasText:percentage})});
  await rows.nth(1).waitFor({timeout});
  const values = await rows.evaluateAll(elements => elements.map(row => ({
    symbol: row.getAttribute('data-symbol'),
    name: row.getAttribute('data-description') || row.querySelector('.tv-widget-watch-list__description')?.textContent?.trim(),
    price: row.querySelector('.js-symbol-last').textContent.trim(),
    change: row.querySelector('.js-symbol-change-pt').textContent.trim()
  })));
  assert.ok(new Set(values.map(row => row.symbol)).size >= 2, 'Expected two distinct ' + exchange + ' quotes');
  for (const row of values) {
    assert.ok(watchSymbols[exchange].has(row.symbol), 'Unexpected observation stock: ' + row.symbol);
    assert.match(row.symbol, new RegExp('^' + exchange + ':\\d{6}$'));
    assert.ok(numeric(row.price) > 0 && percentage.test(row.change), JSON.stringify(row));
    const pct = numeric(row.change);
    assert.ok(Number.isFinite(pct), JSON.stringify(row));
  }
  return values;
}

function shanghaiDay(value) {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error('Invalid snapshot date: ' + value);
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
}

async function chinaDaily(page, upstream) {
  const response = await upstream;
  assert.ok(response, 'The browser must request the closing archive');
  assert.ok(response.ok(), 'Upstream closing archive HTTP ' + response.status());
  const source = await response.json();
  assert.ok(Array.isArray(source.stocks) && source.stocks.length === source.stockCount && source.stockCount > 1000,
    'Unexpected upstream stock universe');
  const candidates = source.stocks.filter(stock => Number.isFinite(stock.price) && stock.price > 0 && Number.isFinite(stock.changePct))
    .map(stock => ({code:stock.code.split('.')[0],name:stock.name,change:stock.changePct}));
  const board = page.locator('[data-mover-market="a"] .radar-main-body');
  const asof = board.locator('[data-daily-asof]');
  const expectedDay = shanghaiDay(source.updatedAt);
  await asof.waitFor({timeout});
  await page.waitForFunction(expected => {
    const value = document.querySelector('[data-mover-market="a"] .radar-main-body [data-daily-asof]')?.getAttribute('datetime');
    if (!value || !Number.isFinite(Date.parse(value))) return false;
    return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value)) === expected;
  }, expectedDay, {timeout});
  await board.locator('[data-daily-origin="upstream"]').waitFor({timeout});
  const origin = 'upstream';
  assert.equal(shanghaiDay(await asof.getAttribute('datetime')),expectedDay);
  for (const [side,sign] of [['gainers',1],['losers',-1]]) {
    const expected = candidates.filter(stock => sign * stock.change > 0)
      .sort((a,b) => sign * (b.change - a.change) || a.code.localeCompare(b.code)).slice(0,3);
    assert.equal(expected.length,3);
    const rows = board.locator('[data-daily-side="' + side + '"] li[data-code]:visible');
    await rows.nth(2).waitFor({timeout});
    const actual = await rows.evaluateAll(nodes => nodes.map(node => ({code:node.dataset.code,text:node.innerText})));
    assert.deepEqual(actual.map(row=>row.code),expected.map(stock=>stock.code),side + ' rank order differs from the dated archive');
    for (const [index,row] of actual.entries()) {
      assert.match(row.code,/^\d{6}$/);
      assert.ok(expected[index].name && row.text.includes(expected[index].name) && row.text.includes(row.code),
        'Missing display name/code: ' + JSON.stringify(row));
    }
    console.log('Verified China closing rank',expectedDay,origin,side,actual.map(row => row.text.replace(/\s+/g,' ')));
  }
}

// Chromium's post-layout snapshot includes the provider's closed shadow trees.
// Count only rendered change text belonging to the named stock row in the watch frame.
function renderedChanges(snapshot, frameURL) {
  const {strings,documents} = snapshot;
  const document = documents.find(entry=>strings[entry.documentURL] === frameURL);
  if (!document) return new Map();
  const {nodes,layout} = document;
  const symbols = [], tags = [], changes = [];
  for (let index=0; index<nodes.nodeName.length; index++) {
    const parent = nodes.parentIndex[index];
    const attributes = nodes.attributes[index] || [];
    symbols[index] = symbols[parent];
    tags[index] = tags[parent] || strings[nodes.nodeName[index]].toLowerCase() === 'tv-ticker-tag';
    changes[index] = changes[parent];
    for (let field=0; field<attributes.length; field+=2) {
      const name=strings[attributes[field]], value=strings[attributes[field+1]];
      if (name === 'data-watch-symbol') symbols[index]=value;
      if (name === 'class' && value.split(/\s+/).includes('change')) changes[index]=true;
    }
  }
  const result = new Map();
  for (let index=0; index<layout.nodeIndex.length; index++) {
    const node=layout.nodeIndex[index], symbol=symbols[node];
    const text=strings[layout.text[index]]?.trim();
    if (!text || !symbol || !tags[node] || !changes[node]) continue;
    const [, ,width,height] = layout.bounds[index];
    if (width<=0 || height<=0 || strings[layout.styles[index][0]] === 'hidden') continue;
    result.set(symbol,(result.get(symbol)||'')+text);
  }
  return result;
}

async function compactWatch(page) {
  const board = page.locator('.radar-stocks > [data-equity-watch]');
  await page.waitForFunction(() => window.watchWidgetEvents.length > 0 || document.querySelector('[data-equity-watch]')?.dataset.watchMode === 'fallback',null,{timeout});
  const health = await page.evaluate(() => window.watchWidgetEvents);
  assert.ok(health.some(message => message.status === 'ready' && message.count === 8),
    'Expected eight live compact quotes, received '+JSON.stringify(health)+'; selected view: '+await board.getAttribute('data-watch-mode'));
  assert.equal(await board.getAttribute('data-watch-mode'),'compact');
  const watch = board.frameLocator('iframe[src*="home-watch-quotes.html"]');
  const symbols = [...watchSymbols.SSE,...watchSymbols.SZSE];
  assert.deepEqual((await watch.locator('[data-watch-symbol]').evaluateAll(rows=>rows.map(row=>row.dataset.watchSymbol))).sort(),symbols.sort());
  assert.ok(await watch.locator('html').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'no horizontal overflow inside the compact frame');
  const iframeURL = await watch.locator('html').evaluate(()=>location.href);
  const session = await page.context().newCDPSession(page);
  let values;
  try {
    const deadline=Date.now()+8000;
    do {
      const tree=await session.send('DOMSnapshot.captureSnapshot',{computedStyles:['visibility']});
      values=renderedChanges(tree,iframeURL);
      if (symbols.every(symbol=>percentage.test(values.get(symbol)||'')) || Date.now()>=deadline) break;
      await page.waitForTimeout(300);
    } while (true);
  } finally { await session.detach(); }
  for (const symbol of symbols) {
    const row = watch.locator('[data-watch-symbol="'+symbol+'"]');
    assert.match(await row.innerText(),/\p{Script=Han}/u,'named stock '+symbol);
    const text = values.get(symbol);
    assert.ok(text && percentage.test(text) && Number.isFinite(numeric(text)),'missing rendered percentage for '+symbol+' '+text);
    assert.ok(await row.locator('tv-ticker-tag').evaluate(el=>{
      const box=el.getBoundingClientRect();
      return box.width>0 && box.height>0 && box.left>=-1 && box.right<=document.documentElement.clientWidth+1;
    }),symbol+' change fits in the quote viewport');
  }
  console.log('Eight live TradingView compact changes',page.viewportSize().width,Object.fromEntries(values));
}

async function fullWatch(page) {
  const board = page.locator('.radar-stocks > [data-equity-watch]');
  const fallback = (await board.getAttribute('data-watch-mode')) === 'fallback';
  if (!fallback) await board.locator('button[data-watch-view="quotes"]').click();
  const frame = board.frameLocator('.radar-mover-stage iframe:not([src*="home-watch-quotes.html"])');
  const panel = frame.locator('body');
  const wuliangye = panel.locator('.js-quote-ticker[data-symbol="SZSE:000858"]:visible');
  await wuliangye.locator('.js-symbol-last').filter({hasText:price}).waitFor({timeout});
  await wuliangye.locator('.js-symbol-change-pt').filter({hasText:percentage}).waitFor({timeout});
  const [shanghai,shenzhen] = await Promise.all([watchRows(panel,'SSE'),watchRows(panel,'SZSE')]);
  assert.ok(shenzhen.some(row => row.symbol === 'SZSE:000858'), 'Expected a priced Wuliangye quote');
  console.log('Live Shanghai and Shenzhen full-quote observation',await board.getAttribute('data-watch-mode'),shanghai,shenzhen);
  assert.equal(await board.getAttribute('data-watch-mode'),fallback ? 'fallback' : 'quotes');
}

async function us(page, direction) {
  const board = page.locator('[data-mover-market="us"]');
  if (direction === 'losses') await board.locator('[data-kind="losers"]').click();
  const frame = board.frameLocator('iframe');
  const rows = frame.locator('tr[data-symbol]:visible:has(td[data-field-key="change"])');
  const changes = rows.locator('td[data-field-key="change"]').filter({hasText:percentage});
  await changes.nth(1).waitFor({timeout});
  const values = await rows.evaluateAll(elements => elements.slice(0,2).map(row => ({
    symbol: row.getAttribute('data-symbol'),
    change: row.querySelector('td[data-field-key="change"]').textContent.trim()
  })));
  assert.equal(new Set(values.map(row=>row.symbol)).size,2);
  for (const row of values) {
    assert.match(row.symbol,/^[A-Z0-9]+:[A-Z0-9.-]+$/);
    assert.ok(percentage.test(row.change) && (direction === 'gains' ? numeric(row.change) > 0 : numeric(row.change) < 0), JSON.stringify(row));
  }
  console.log('Live US ' + direction, values);
}

async function inspect(browser,width) {
  const mobile = width === 390;
  const page = await browser.newPage({viewport:{width,height:mobile?844:900},isMobile:mobile,hasTouch:mobile,locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  const failures = [];
  async function verify(name, action) {
    try { await action(); }
    catch (error) { failures.push(width+' '+name+': '+error.message); }
  }
  try {
    await page.addInitScript(() => {
      if (window !== top) return;
      window.watchWidgetEvents = [];
      addEventListener('message', event => {
        const frame = document.querySelector('[data-equity-watch] iframe[src*="home-watch-quotes.html"]');
        if (event.origin === location.origin && frame?.contentWindow === event.source && event.data?.type === 'books:watch-widget') {
          window.watchWidgetEvents.push({status:event.data.status,count:event.data.count});
        }
      },true);
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (url.origin + url.pathname === dailySource || url.hostname.endsWith('tradingview.com') || url.hostname.endsWith('tradingview-widget.com'))
        console.log('Source request failed', url.origin+url.pathname, request.failure()?.errorText);
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin + url.pathname === dailySource && response.status() >= 400)
        console.log('Closing archive HTTP',response.status());
    });
    const upstream = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin + url.pathname === dailySource;
    },{timeout}).catch(()=>null);
    await page.goto(home, {waitUntil:'domcontentloaded'});
    const board = page.locator('.radar-stocks');
    await board.scrollIntoViewIfNeeded();
    const usStage=board.locator('[data-mover-market="us"] .radar-mover-stage');
    await usStage.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
    await verify('US gainers',()=>us(page,'gains'));
    await verify('unobstructed US quote viewport',async()=>{
      const bounds = await usStage.boundingBox();
      const strip = await page.locator('#index-ticker').boundingBox();
      assert.ok(bounds && (!strip || bounds.y>=strip.y+strip.height-1),'fixed ticker overlaps the US quotes');
    });
    await usStage.screenshot({path:output+'/provider-'+width+'-default-us.png'});
    await board.locator('[data-equity-watch] .radar-mover-stage').evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
    await verify('compact watch',()=>compactWatch(page));
    if (!mobile) {
      await verify('closing ranks',()=>chinaDaily(page,upstream));
    }
    await verify('default layout',async()=>{
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow on homepage');
      assert.equal(await page.locator('[data-mover-market="us"] [data-kind="gainers"]').getAttribute('aria-pressed'),'true');
    });
    // This multi-viewport component capture would otherwise repeat the fixed ticker inside the card.
    await board.screenshot({path:output+'/provider-'+width+'-default-radar.png',style:'.books-shell > .index-ticker {visibility:hidden !important}'});
    await board.locator('[data-equity-watch]').screenshot({path:output+'/provider-'+width+'-default-watch.png'});
    if (!mobile) {
      await verify('full or backup quotes',()=>fullWatch(page));
      await verify('US losers',()=>us(page,'losses'));
      await board.screenshot({path:output+'/provider-boards.png'});
    }
  } finally { await page.close(); }
  return failures;
}

async function check() {
  const browser = await chromium.launch();
  try {
    fs.mkdirSync(output,{recursive:true});
    const failures = [];
    for (const width of [1440,390]) failures.push(...await inspect(browser,width));
    assert.ok(!failures.length,failures.join('\n'));
  } finally { await browser.close(); }
}

check().catch(error=>{console.error(error.message);process.exitCode=1;});
