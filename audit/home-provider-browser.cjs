'use strict';
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const timeout = 45000;
const output = 'audit/browser-output/home-dashboard';
const home = process.env.HOME_PROVIDER_URL || 'http://127.0.0.1:8784/index.html';
const percentage = /[+−-]?\d[\d,]*(?:\.\d+)?\s*%/;
const price = /\d/;
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

async function heatmap(page) {
  const embed = page.locator('[data-mover-market="a"] .radar-main-body iframe');
  await embed.waitFor({timeout});
  const frame = await (await embed.elementHandle()).contentFrame();
  assert.ok(frame, 'A-share heatmap iframe is missing');
  try {
    await frame.waitForURL(url => url.hostname === 'dapan.app' && url.searchParams.get('market') === 'all'
      && url.searchParams.get('period') === 'day', {timeout,waitUntil:'domcontentloaded'});
    const data = await frame.waitForFunction(() => {
      const labels = Array.from(document.querySelectorAll('p'));
      const count = label => {
        const text = labels.find(node => node.textContent.trim() === label)?.nextElementSibling?.textContent?.trim();
        return text && /^[\d,]+$/.test(text) ? Number(text.replace(/,/g,'')) : NaN;
      };
      const rising = count('上涨'), flat = count('平盘'), falling = count('下跌');
      const coverage = rising + flat + falling;
      if (!(coverage > 1000 && rising + falling > 0)) return false;
      // The provider paints an archive before real quotes arrive.
      if (/当前为样本快照|样本数据|正在加载实时数据/.test(document.body.innerText)) return false;
      if (labels.some(node => node.textContent.trim() === '当前为样本快照')) return false;
      const canvas = document.querySelector('canvas[aria-label="A 股市场热力图画布"]');
      if (!canvas || canvas.clientWidth < 100 || canvas.clientHeight < 80) return false;
      const small = document.createElement('canvas');
      small.width = 64;
      small.height = 40;
      const context = small.getContext('2d');
      context.drawImage(canvas,0,0,64,40);
      const {data} = context.getImageData(0,0,64,40);
      let red = 0, green = 0;
      for (let i=0; i<data.length; i+=4) {
        const [r,g,b,alpha] = data.subarray(i,i+4);
        if (alpha < 128) continue;
        if (r > g + 20 && r > b + 12) red++;
        if (g > r + 15 && g > b + 5) green++;
      }
      if (red + green < 60 || (rising > 0 && falling > 0 && !(red && green))) return false;
      return {rising,flat,falling,coverage,red,green};
    },null,{timeout,polling:500});
    console.log('Live China market breadth and painted heatmap', await data.jsonValue());
  } catch (error) {
    const status = await frame.locator('body').innerText({timeout:3000}).catch(()=>'No response body');
    const chart = await frame.locator('canvas').count().catch(()=>0);
    throw Error('Heatmap failed: '+frame.url()+' | canvas='+chart+' | '+status.replace(/\s+/g,' ').slice(0,800)+' | '+error.message);
  }
}

async function chinaWatch(page) {
  const frame = page.locator('[data-mover-market="a"] [data-equity-watch]').frameLocator('iframe');
  const panel = frame.locator('body');
  const wuliangye = panel.locator('.js-quote-ticker[data-symbol="SZSE:000858"]:visible');
  await wuliangye.locator('.js-symbol-last').filter({hasText:price}).waitFor({timeout});
  await wuliangye.locator('.js-symbol-change-pt').filter({hasText:percentage}).waitFor({timeout});
  const [shanghai,shenzhen] = await Promise.all([watchRows(panel,'SSE'),watchRows(panel,'SZSE')]);
  assert.ok(shenzhen.some(row => row.symbol === 'SZSE:000858'), 'Expected a priced Wuliangye quote');
  console.log('Live Shanghai and Shenzhen watchlist',shanghai,shenzhen);
}

async function us(page) {
  const board = page.locator('[data-mover-market="us"]');
  for (const direction of ['gains','losses']) {
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
}

async function check() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (url.hostname === 'dapan.app' || url.hostname.endsWith('tradingview.com') || url.hostname.endsWith('tradingview-widget.com'))
        console.log('Source request failed', url.origin+url.pathname, request.failure()?.errorText);
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.hostname === 'dapan.app' && response.status() >= 400)
        console.log('Heatmap source HTTP',response.status(),url.pathname);
    });
    await page.goto(home, {waitUntil:'domcontentloaded'});
    const board = page.locator('.radar-stocks');
    await board.scrollIntoViewIfNeeded();
    const failures = [];
    for (const verify of [heatmap,chinaWatch,us]) {
      try { await verify(page); }
      catch (error) { failures.push(verify.name + ': ' + error.message); }
    }
    fs.mkdirSync(output,{recursive:true});
    await board.screenshot({path:output + '/provider-boards.png'});
    assert.ok(!failures.length, failures.join('\n'));
  } finally { await browser.close(); }
}

check().catch(error=>{console.error(error.message);process.exitCode=1;});
