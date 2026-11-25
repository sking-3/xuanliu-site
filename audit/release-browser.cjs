'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const playwright=require('playwright');
const fixture=require('./release-fixtures.cjs');
const quantBars=Array.from({length:360},(_,i)=>({time:Date.UTC(2023,0,1+i),open:100+i/20,high:103+i/20,low:98+i/20,close:101+i/20,volume:1000}));
const quantFixture={schemaVersion:1,status:'stale',source:{name:'Synthetic offline regression'},bars:quantBars,dataHash:crypto.createHash('sha256').update(JSON.stringify(quantBars)).digest('hex'),retrievedAt:'2024-01-01T00:00:00.000Z',latestClosedAt:new Date(Date.UTC(2023,0,361)).toISOString(),report:null,reportHash:null};
const base=new URL(process.env.RELEASE_BASE_URL),engine=process.env.RELEASE_BROWSER||'chromium';
const deskFixture=require('./stock-desk-fixtures.cjs');
const output=path.join(process.env.RELEASE_OUTPUT||path.join(__dirname,'browser-output/release'),engine);
fs.mkdirSync(output,{recursive:true});
const report={engine,base:base.href,revision:process.env.EXPECTED_SHA||null,synthetic:true,externalRequestsBlocked:true,writesBlocked:true,writeAttempts:[],pages:[],interactions:[]};
const routes=['index.html','screening/index.html','us.html','trader/index.html','tools.html','research.html','screening/history.html','crypto.html','chart.html','company-dossier.html','agent-studio.html','a-shares.html','us-live.html','quant-research/index.html'];
async function main(){
 const browser=await playwright[engine].launch(engine==='chromium'&&process.env.RELEASE_BROWSER_EXECUTABLE?{executablePath:process.env.RELEASE_BROWSER_EXECUTABLE}:{});
 try{
  for(const width of [1440,768,390,375]){
   const cacheReads=[];let directDailyRequests=0;
   const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
   await context.routeWebSocket('**/*',ws=>ws.close());
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());if(!['GET','HEAD'].includes(route.request().method())){report.writeAttempts.push({path:url.pathname,method:route.request().method()});return route.abort();}
    if(url.origin===base.origin){
     if(url.pathname==='/api/a-share-daily/workbench'){cacheReads.push(url.pathname+url.search);return route.fulfill({json:deskFixture()});}
     if(['/api/a-share-daily/entry-current-chart','/api/a-share-daily/viprasol-current-chart','/api/a-share-daily/a14-chart','/api/a-share-daily/workbench-chart'].includes(url.pathname))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240" viewBox="0 0 600 240"><title>Synthetic dayK fixture only</title><path d="M20 190L170 150L280 165L400 100L570 120" fill="none" stroke="#365a70"/></svg>'});
     if(url.pathname==='/api/a-share-daily/schemes')return route.fulfill({json:{schemes:[]}});
     if(url.pathname==='/api/research-control/state')return route.fulfill({status:401,json:{error:'authentication_required'}});
    }
    if(url.pathname.endsWith('/appstock/app/fqkline/get')&&route.request().frame()===route.request().frame().page().mainFrame())directDailyRequests++;

    if(url.origin===base.origin&&url.pathname===new URL('quant-research/data/latest.json',base).pathname)return route.fulfill({json:quantFixture});
    if(url.href.includes('market-heatmap-fallback.json')||url.origin===base.origin&&url.pathname==='/api/a-share-daily/market')return route.fulfill({json:fixture});
    if(url.origin===base.origin&&url.pathname.startsWith(base.pathname))return route.continue();
    return route.abort();
   });
   for(const route of routes){
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
    if(route==='screening/index.html')await page.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-25T08:35:00Z');});
    const response=await page.goto(new URL(route,base).href,{waitUntil:'domcontentloaded'});
    assert.equal(response.status(),200,route+' HTTP');
    await page.locator('h1').waitFor();
    await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    assert.equal(await page.locator('h1').count(),1,route+' heading');
    const geometry=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));
    assert.ok(geometry.width<=width+1,route+' overflow '+JSON.stringify(geometry));
    const nav=page.locator('.books-nav');
    if(await nav.count()){
     const destinations=['index.html','screening/index.html','us.html','trader/index.html','research.html','screening/history.html','academy/index.html','tools.html'];
     if(route==='account.html')destinations.push('account.html');
     assert.equal(await nav.locator('a').count(),destinations.length,route+' navigation count');
     const links=await nav.locator('a').evaluateAll(nodes=>nodes.map(n=>n.href));
     assert.deepEqual(links,destinations.map(destination=>new URL(destination,base).href),route+' navigation destinations');
     assert.ok(links.every(url=>new URL(url).origin===base.origin&&new URL(url).pathname.startsWith(base.pathname)),route+' navigation base path');
     if(width<768){
      await page.locator('.books-menu-toggle').click();await nav.waitFor({state:'visible'});
      await page.locator('.books-menu-toggle').click();
     }
    }
    if(route==='screening/index.html'){
     await page.locator('#stock-desk[data-state="ready"]').waitFor();
     await page.waitForFunction(()=>document.querySelectorAll('#stock-desk-results article').length===2);
     const cached=await page.evaluate(()=>BooksStockDeskApp.getState());
     assert.equal(cached.phase,'close');assert.equal(cached.reports.close.generation,'2026-11-25-123');
     assert.match(await page.locator('#stock-desk-count').innerText(),/2 只.*3 条条件/);assert.equal(directDailyRequests,0);
     assert.ok(cacheReads.some(path=>path==='/api/a-share-daily/workbench'));
     assert.equal(await page.locator('#trend-screen,#research-file,#entry-opportunities,#viprasol-opportunities').count(),0);
     report.interactions.push({width,test:'unified stock desk reads completed same-source report without per-stock market requests or retired mounts'});
     await page.locator('#stock-desk-query').fill('600000');await page.waitForFunction(()=>document.querySelectorAll('#stock-desk-results article').length===1);
     await page.locator('#stock-desk-query').fill('NO-MATCH-TEST');await page.waitForFunction(()=>document.querySelectorAll('#stock-desk-results article').length===0);
     await page.locator('#stock-desk-query').fill('');await page.waitForFunction(()=>document.querySelectorAll('#stock-desk-results article').length===2);
     report.interactions.push({width,test:'synthetic workbench search, stock-level deduplication and honest empty state'});
    }
    if(route==='quant-research/index.html'){
     await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
     assert.match(await page.locator('#runtime-status').innerText(),/行情已过期/);
     await page.locator('#run-button').click();
     await page.waitForFunction(()=>!document.querySelector('#export').disabled);
     await page.reload({waitUntil:'domcontentloaded'});
     await page.locator('#history-list button').first().click();
     assert.equal(await page.locator('#export').isDisabled(),false);
     assert.match(await page.locator('#provenance').innerText(),/Synthetic offline regression/);
     report.interactions.push({width,test:'synthetic website snapshot, stale status, research and persisted result'});
    }
    assert.deepEqual(errors,[],route+' uncaught exceptions');
    report.pages.push({route,width,scrollWidth:geometry.width,uncaughtErrors:errors});
    if(['screening/index.html','us.html','quant-research/index.html'].includes(route)&&[1440,390].includes(width)){
     await page.screenshot({path:path.join(output,'synthetic-'+route.replace(/\W+/g,'-')+'-'+width+'.png')});
    }
    await page.close();
   }
   await context.close();
  }
  assert.deepEqual(report.writeAttempts,[]);
  console.log('PASS '+engine+': '+report.pages.length+' page/viewport checks; '+report.interactions.length+' interactions (synthetic, external sources blocked)');
 }finally{await browser.close();fs.writeFileSync(path.join(output,'pages.json'),JSON.stringify(report,null,2)+'\n');}
}
main().catch(error=>{console.error(error);fs.writeFileSync(path.join(output,'failure.txt'),error.stack);process.exitCode=1;});
