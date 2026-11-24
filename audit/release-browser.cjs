'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const playwright=require('playwright');
const fixture=require('./release-fixtures.cjs');
const quantBars=Array.from({length:360},(_,i)=>({time:Date.UTC(2023,0,1+i),open:100+i/20,high:103+i/20,low:98+i/20,close:101+i/20,volume:1000}));
const quantFixture={schemaVersion:1,status:'stale',source:{name:'Synthetic offline regression'},bars:quantBars,dataHash:crypto.createHash('sha256').update(JSON.stringify(quantBars)).digest('hex'),retrievedAt:'2024-01-01T00:00:00.000Z',latestClosedAt:new Date(Date.UTC(2023,0,361)).toISOString(),report:null,reportHash:null};
const base=new URL(process.env.RELEASE_BASE_URL),engine=process.env.RELEASE_BROWSER||'chromium';
const trendEngine=require('../screening/trend-screen.js');
const cacheGeneration='synthetic-release-cache-v1',cacheDay=fixture.updatedAt.slice(0,10);
const cacheStocks=fixture.stocks.filter(stock=>stock.exchange!=='BJ');
const cacheBars=Array.from({length:65},(_,i)=>({date:new Date(Date.parse(cacheDay+'T00:00:00Z')-(64-i)*86400000).toISOString().slice(0,10),close:i<60?100-i*.02:98.8+(i-59)*.35,volume:1000}));
function cachedTrend(url){
 if(url.pathname==='/api/a-share-daily/state')return {available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:cacheGeneration,day:cacheDay,asOf:fixture.updatedAt},attempt:{status:'complete'}};
 if(url.pathname!=='/api/a-share-daily/result')return null;
 const mode=url.searchParams.get('mode'),lookback=Number(url.searchParams.get('lookback')),reference={code:url.searchParams.get('benchmark')};
 assert.equal(mode,'strength');assert.equal(lookback,20);assert.equal(url.searchParams.get('generation'),cacheGeneration);
 assert.equal(url.searchParams.get('sampleSize'),'all');assert.equal(reference.code,'000300.SH');
 const input={mode,lookback,day:cacheDay,referenceBars:cacheBars,limits:{enabled:false}};
 const match=trendEngine.evaluate({...input,bars:cacheBars}),miss=trendEngine.evaluate({...input,bars:cacheBars.map((bar,i)=>({...bar,close:100-i*.02}))});
 assert.equal(match.matched,true);assert.equal(miss.matched,false);
 return {status:'complete',mode,lookback,reference,generation:cacheGeneration,day:cacheDay,asOf:fixture.updatedAt,scope:'full-market',fullMarket:true,marketUniverseCount:cacheStocks.length,sampleCount:cacheStocks.length,limits:{enabled:false},records:cacheStocks.map((stock,i)=>({stock:{...stock,sector:stock.boardName},result:i===0?match:miss,fetchedAt:fixture.updatedAt,referenceFetchedAt:fixture.updatedAt}))};
}
const output=path.join(process.env.RELEASE_OUTPUT||path.join(__dirname,'browser-output/release'),engine);
fs.mkdirSync(output,{recursive:true});
const report={engine,base:base.href,revision:process.env.EXPECTED_SHA||null,synthetic:true,externalRequestsBlocked:true,pages:[],interactions:[]};
const routes=['index.html','screening/index.html','us.html','trader/index.html','tools.html','research.html','screening/history.html','crypto.html','chart.html','company-dossier.html','agent-studio.html','a-shares.html','us-live.html','quant-research/index.html'];
async function main(){
 const browser=await playwright[engine].launch(engine==='chromium'&&process.env.RELEASE_BROWSER_EXECUTABLE?{executablePath:process.env.RELEASE_BROWSER_EXECUTABLE}:{});
 try{
  for(const width of [1440,768,390,375]){
   const cacheReads=[];let directDailyRequests=0;
   const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
   await context.routeWebSocket('**/*',ws=>ws.close());
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin===base.origin){
     const cached=cachedTrend(url);if(cached){cacheReads.push(url.pathname+url.search);return route.fulfill({json:cached});}
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
     await page.locator('[data-selection][data-state=ready]').waitFor();
     await page.waitForFunction(()=>window.BooksTrendControllerApp?.getState().status==='complete');
     const cached=await page.evaluate(()=>BooksTrendControllerApp.getState());
     assert.equal(cached.origin,'daily-cache');assert.equal(cached.mode,'strength');assert.equal(cached.lookback,20);
     assert.equal(cached.generation,cacheGeneration);assert.equal(cached.limits.maxVolumeRatio,2.5);
     assert.equal(await page.locator('#trend-results .trend-stock').count(),1);assert.equal(directDailyRequests,0);
     assert.ok(cacheReads.some(path=>path.startsWith('/api/a-share-daily/result?')));
     report.interactions.push({width,test:'default strength uses the matching completed generation without source requests'});
     await page.locator('details.pick-advanced > summary').click();
     await page.locator('#pick-query').fill('600519');
     await page.waitForFunction(()=>document.querySelectorAll('#pick-rows tr[data-code]').length===1);
     await page.locator('#pick-query').fill('NO-MATCH-TEST');
     await page.waitForFunction(()=>document.querySelectorAll('#pick-rows tr[data-code]').length===0);
     report.interactions.push({width,test:'synthetic search and empty state'});
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
  console.log('PASS '+engine+': '+report.pages.length+' page/viewport checks; '+report.interactions.length+' interactions (synthetic, external sources blocked)');
 }finally{await browser.close();fs.writeFileSync(path.join(output,'pages.json'),JSON.stringify(report,null,2)+'\n');}
}
main().catch(error=>{console.error(error);fs.writeFileSync(path.join(output,'failure.txt'),error.stack);process.exitCode=1;});
