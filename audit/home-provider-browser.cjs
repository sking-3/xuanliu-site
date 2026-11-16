'use strict';
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function compareChinaSources(browser) {
  const candidates = [
    ['SSE','hotlists',{exchange:'SSE',showChart:false}],
    ['SZSE','hotlists',{exchange:'SZSE',showChart:false}],
    ['china','hotlists',{exchange:'CHINA',showChart:false}],
    ['china-all','screener',{market:'china',defaultScreen:'most_capitalized',defaultColumn:'overview',showToolbar:false}],
    ['china-list','market-overview',{showChart:false,showSymbolLogo:false,tabs:[{title:'沪深',symbols:[{s:'SSE:600519',d:'贵州茅台'},{s:'SZSE:000858',d:'五粮液'}]}]}],
    ['dapan','frame',{}]
  ];
  await Promise.all(candidates.map(async ([id,widget,settings]) => {
    const page=await browser.newPage();
    try {
      await page.route('http://127.0.0.1:8784/provider-test', route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset=utf-8><div id="host" style="height:400px;width:640px"></div>'}));
      await page.goto('http://127.0.0.1:8784/provider-test');
      await page.evaluate(({widget,settings})=>{
        const host=document.querySelector('#host');
        if(widget==='frame'){
          const frame=document.createElement('iframe');frame.src='https://dapan.app/?market=all&period=day&borders=off';host.append(frame);return;
        }
        host.className='tradingview-widget-container';
        const inner=document.createElement('div');inner.className='tradingview-widget-container__widget';host.append(inner);
        const script=document.createElement('script');script.src='https://s3.tradingview.com/external-embedding/embed-widget-'+widget+'.js';
        script.textContent=JSON.stringify({width:'100%',height:350,locale:'zh_CN',colorTheme:'light',...settings});host.append(script);
      },{widget,settings});
      await page.waitForTimeout(11500);
      for(const frame of page.frames().slice(1,3)) {
        const body=await frame.locator('body').innerText({timeout:4000});
        console.log('China candidate',id,new URL(frame.url()).pathname,body.replace(/\s+/g,' ').slice(0,510));
      }
    } catch(error){console.log('China candidate',id,error.message.slice(0,160));}
    finally{await page.close();}
  }));
}

async function check() {
  const browser = await chromium.launch();
  try {
    await compareChinaSources(browser);
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
