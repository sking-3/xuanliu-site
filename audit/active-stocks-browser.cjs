'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),playwright=require('playwright');
const fixture=require('./active-stocks-fixture.cjs'),marketFixture=require('./release-fixtures.cjs');
const base=new URL(process.env.RELEASE_BASE_URL),engine=process.env.RELEASE_BROWSER||'chromium';
const output=path.join(process.env.RELEASE_OUTPUT||path.join(__dirname,'browser-output/release'),engine);
const report={engine,synthetic:true,externalRequestsBlocked:true,checks:[]};
async function main(){
 fs.mkdirSync(output,{recursive:true});
 const browser=await playwright[engine].launch();
 try{
  for(const width of [1440,768,390,375]){
   const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
   await context.routeWebSocket('**/*',ws=>ws.close());
   let mode='production',snapshotRequests=0,providerAttempts=0;
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin===base.origin&&url.pathname===new URL('research-data/a-active-stocks.json',base).pathname){
     snapshotRequests++;
     if(mode==='production')return route.continue();
     if(mode==='refused')return route.fulfill({status:403,body:'Forbidden'});
     if(mode==='malformed')return route.fulfill({contentType:'application/json',body:'{'});
     const data=fixture();
     if(mode==='invalid')data.rows[0].dailyAmounts.pop();
     if(mode==='hostile')data.rows[1].name='<img src=x onerror=alert(1)>';
     return route.fulfill({json:data});
    }
    if(url.href.includes('market-heatmap-fallback.json'))return route.fulfill({json:marketFixture});
    if(url.origin===base.origin&&url.pathname.startsWith(base.pathname))return route.continue();
    if(url.hostname==='s3.tradingview.com')providerAttempts++;
    return route.abort();
   });
   const page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
   async function visit(state){
    await page.goto(new URL('index.html',base).href,{waitUntil:'domcontentloaded'});
    await page.locator('#home-active-stocks[data-state="'+state+'"][aria-busy=false]').waitFor();
    const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(geometry.scroll<=geometry.width+1,'no overflow '+width);
   }
   await visit('not_configured');
   assert.match(await page.locator('#active-stocks-status').innerText(),/待接入/);
   assert.equal(await page.locator('#active-stocks-list li').count(),0);
   mode='fixture';await visit('ready');
   assert.match(await page.locator('#active-stocks-status').innerText(),/合成测试数据 · 非真实行情/);
   assert.match(await page.locator('#active-stocks-status').innerText(),/2026-11-13/);
   assert.match(await page.locator('#active-stocks-meta').innerText(),/样本 4 只，完整数据 3 只，缺失排除 1 只/);
   assert.equal(await page.locator('#active-stocks-list li').count(),3);
   const symbols=await page.locator('#active-stocks-list a').evaluateAll(nodes=>nodes.map(n=>new URL(n.href).searchParams.get('tvwidgetsymbol')));
   assert.deepEqual(symbols,['SZSE:000001','SSE:600519','SZSE:300750']);
   await page.locator('#home-active-stocks').screenshot({path:path.join(output,'synthetic-active-stocks-'+width+'.png')});
   for(const symbol of ['SZSE:000001','SSE:600519']){
    await page.locator('#active-stocks-list a').filter({has:page.locator('small',{hasText:symbol})}).click();
    assert.equal(new URL(page.url()).pathname,new URL('chart.html',base).pathname);
    assert.equal(new URL(page.url()).origin,base.origin);
    await page.waitForFunction(s=>document.querySelector('#chart-symbol')?.textContent===s,symbol);
    assert.match(await page.locator('#chart-data-note').innerText(),/日终数据，非盘中实时/);
    await page.waitForFunction(()=>document.querySelector('#chart-widget')?.dataset.chartState==='unavailable');
    assert.match(await page.locator('#chart-status').innerText(),/图表来源未响应/);
    await visit('ready');
   }
   mode='hostile';await visit('ready');
   assert.match(await page.locator('#active-stocks-list').innerText(),/<img src=x onerror=alert\(1\)>/);
   assert.equal(await page.locator('#active-stocks-list img').count(),0);
   for(const failure of ['invalid','refused','malformed']){
    mode=failure;const before=snapshotRequests;await visit('unavailable');
    assert.equal(await page.locator('#active-stocks-list li').count(),0);
    assert.equal(await page.locator('#active-stocks-meta').innerText(),'');
    assert.match(await page.locator('#active-stocks-status').innerText(),/未展示排名/);
    assert.equal(snapshotRequests-before,1,'one static snapshot attempt, no retry');
   }
   assert.ok(providerAttempts>0,'provider attempts intercepted and aborted');
   assert.deepEqual(errors,[],'uncaught errors');
   report.checks.push({width,syntheticRows:3,chartSymbols:['SZSE:000001','SSE:600519'],failureStates:3,externalProviderAttemptsBlocked:providerAttempts});
   await context.close();
  }
  console.log('PASS '+engine+': active stocks, 4 viewports, 8 in-site chart navigations, synthetic fixtures and failures');
 }finally{await browser.close();fs.writeFileSync(path.join(output,'active-stocks.json'),JSON.stringify(report,null,2)+'\n');}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
