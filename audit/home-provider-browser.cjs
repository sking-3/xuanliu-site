'use strict';
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function check() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (url.hostname.endsWith('tradingview.com') || url.hostname.endsWith('tradingview-widget.com'))
        console.log('Source request failed', url.origin+url.pathname, request.failure()?.errorText);
    });
    await page.goto('http://127.0.0.1:8784/index.html', {waitUntil:'domcontentloaded'});
    await page.locator('.radar-stocks').scrollIntoViewIfNeeded();
    const read = async (market,direction) => {
      const board = page.locator('[data-mover-market="'+market+'"]');
      if (direction === 'losses') await board.locator('[data-kind="losers"]').click();
      const rows = board.frameLocator('iframe').locator('tr[data-symbol]:has(td[data-field-key="change"])');
      await rows.nth(1).waitFor({timeout:45000});
      const row = rows.first();
      const symbol = await row.getAttribute('data-symbol');
      const change = await row.locator('td[data-field-key="change"]').innerText();
      const pct = Number(change.replace(/[^\d.\-−]/g,'').replace('−','-'));
      assert.ok(symbol && /\d/.test(change) && (direction === 'gains' ? pct>0 : pct<0),market+' '+symbol+' '+change);
      console.log('Live source row', market,direction,symbol,change);
    };
    const results = await Promise.allSettled(['a','us'].map(async market => {
      await read(market,'gains');
      await read(market,'losses');
    }));
    fs.mkdirSync('audit/browser-output/home-dashboard',{recursive:true});
    await page.locator('.radar-stocks').screenshot({path:'audit/browser-output/home-dashboard/provider-boards.png'});
    for (const r of results) if (r.status==='rejected') console.error(r.reason.message);
    assert.ok(results.every(r=>r.status==='fulfilled'),'Both real sources must present priced rows');
  } finally {await browser.close();}
}
check().catch(error=>{console.error(error.message);process.exitCode=1;});
