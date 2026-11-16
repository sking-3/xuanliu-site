'use strict';
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const timeout = 45000;
const output = 'audit/browser-output/home-dashboard';
const home = process.env.HOME_PROVIDER_URL || 'http://127.0.0.1:8784/index.html';
const percentage = /[+−-]?\d[\d,]*(?:\.\d+)?\s*%/;
const price = /\d/;
const shenzhenSymbols = new Set(['SZSE:000858','SZSE:000333','SZSE:002594','SZSE:300750']);

function numeric(raw) {
  return Number(raw.trim().replace(/[,\s%]/g, '').replace(/−/g, '-'));
}

async function watchRows(panel, exchange, direction) {
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
  for (const row of values.slice(0,2)) {
    assert.match(row.symbol, new RegExp('^' + exchange + ':\\d{6}$'));
    assert.ok(numeric(row.price) > 0 && percentage.test(row.change), JSON.stringify(row));
    const pct = numeric(row.change);
    assert.ok(Number.isFinite(pct), JSON.stringify(row));
    if (direction === 'gains') assert.ok(pct > 0, JSON.stringify(row));
    if (direction === 'losses') assert.ok(pct < 0, JSON.stringify(row));
  }
  return values;
}

async function shanghai(page) {
  const frame = page.locator('[data-mover-market="a"] .radar-main-body').frameLocator('iframe');
  const groups = [
    ['volume_gainers','active'],
    ['percent_change_gainers','gains',/涨幅|领涨|上涨|gainers/i],
    ['percent_change_loosers','losses',/跌幅|领跌|下跌|losers/i]
  ];
  for (const [group,direction,label] of groups) {
    if (label) await frame.locator('.js-tabs').getByText(label).first().click({timeout});
    const values = await watchRows(frame.locator('[data-tab-group="' + group + '"]'), 'SSE', direction);
    console.log('Live Shanghai ' + direction, values.slice(0,2));
  }
}

async function shenzhen(page) {
  const frame = page.locator('[data-mover-market="a"] [data-shenzhen-watch]').frameLocator('iframe');
  const panel = frame.locator('body');
  const wuliangye = panel.locator('.js-quote-ticker[data-symbol="SZSE:000858"]:visible');
  await wuliangye.locator('.js-symbol-last').filter({hasText:price}).waitFor({timeout});
  await wuliangye.locator('.js-symbol-change-pt').filter({hasText:percentage}).waitFor({timeout});
  const values = await watchRows(panel, 'SZSE');
  assert.ok(values.every(row => shenzhenSymbols.has(row.symbol)), 'Unexpected stock in the Shenzhen watchlist');
  assert.ok(values.some(row => row.symbol === 'SZSE:000858' && numeric(row.price) > 0
    && Number.isFinite(numeric(row.change))), 'Expected a priced Wuliangye quote');
  console.log('Live Shenzhen watchlist', values);
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
      if (url.hostname.endsWith('tradingview.com') || url.hostname.endsWith('tradingview-widget.com'))
        console.log('Source request failed', url.origin+url.pathname, request.failure()?.errorText);
    });
    await page.goto(home, {waitUntil:'domcontentloaded'});
    const board = page.locator('.radar-stocks');
    await board.scrollIntoViewIfNeeded();
    const failures = [];
    for (const verify of [shenzhen,shanghai,us]) {
      try { await verify(page); }
      catch (error) { failures.push(verify.name + ': ' + error.message); }
    }
    fs.mkdirSync(output,{recursive:true});
    await board.screenshot({path:output + '/provider-boards.png'});
    assert.ok(!failures.length, failures.join('\n'));
  } finally { await browser.close(); }
}

check().catch(error=>{console.error(error.message);process.exitCode=1;});
