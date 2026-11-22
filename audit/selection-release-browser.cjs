'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const path=require('node:path'),playwright=require('playwright');
const engine=process.env.RELEASE_BROWSER||'chromium';
const output=path.join(process.env.RELEASE_OUTPUT||path.join(__dirname,'browser-output/release'),engine);fs.mkdirSync(output,{recursive:true});
const snapshot=require('./release-fixtures.cjs');
const trendEngine=require('../screening/trend-screen.js');
const cacheGeneration='synthetic-release-cache-v1',cacheDay=snapshot.updatedAt.slice(0,10);
const cacheStocks=snapshot.stocks.filter(stock=>stock.exchange!=='BJ');
const cacheBars=Array.from({length:65},(_,i)=>({date:new Date(Date.parse(cacheDay+'T00:00:00Z')-(64-i)*86400000).toISOString().slice(0,10),close:i<60?100-i*.02:98.8+(i-59)*.35,volume:1000}));
function cachedTrend(url){
 if(url.pathname==='/api/a-share-daily/state')return {available:true,scope:'full-market',fullMarket:true,lastSuccess:{generation:cacheGeneration,day:cacheDay,asOf:snapshot.updatedAt},attempt:{status:'complete'}};
 if(url.pathname!=='/api/a-share-daily/result')return null;
 const mode=url.searchParams.get('mode'),lookback=Number(url.searchParams.get('lookback')),reference={code:url.searchParams.get('benchmark')};
 assert.equal(mode,'strength');assert.equal(lookback,20);assert.equal(url.searchParams.get('generation'),cacheGeneration);
 assert.equal(url.searchParams.get('sampleSize'),'all');assert.equal(reference.code,'000300.SH');
 const input={mode,lookback,day:cacheDay,referenceBars:cacheBars,limits:{enabled:false}};
 const match=trendEngine.evaluate({...input,bars:cacheBars}),miss=trendEngine.evaluate({...input,bars:cacheBars.map((bar,i)=>({...bar,close:100-i*.02}))});
 assert.equal(match.matched,true);assert.equal(miss.matched,false);
 return {status:'complete',mode,lookback,reference,generation:cacheGeneration,day:cacheDay,asOf:snapshot.updatedAt,scope:'full-market',fullMarket:true,marketUniverseCount:cacheStocks.length,sampleCount:cacheStocks.length,limits:{enabled:false},records:cacheStocks.map((stock,i)=>({stock:{...stock,sector:stock.boardName},result:i===0?match:miss,fetchedAt:snapshot.updatedAt,referenceFetchedAt:snapshot.updatedAt}))};
}
const batch=JSON.parse(fs.readFileSync(path.join(__dirname,'../research-data/snapshot.json'),'utf8'));
const record={at:new Date().toISOString(),network:'Synthetic fixtures; all external HTTP and WebSocket traffic blocked; no denied source contacted',checks:[],screens:[]};
const base=process.env.RELEASE_BASE_URL;assert.ok(base,'test server required');
function waitWorkspaceState(page,state){
 return page.locator(`[data-stock-workspace][data-published-state="${state}"]`).waitFor({state:'attached'});
}
async function openWorkspace(page){
 const disclosure=page.locator('details.stock-custom-results');
 if(!await disclosure.evaluate(node=>node.open))await disclosure.locator('summary').click();
 await disclosure.locator('[data-stock-workspace]').waitFor({state:'visible'});
}
(async()=>{
 const browser=await playwright[engine].launch(engine==='chromium'&&process.env.RELEASE_BROWSER_EXECUTABLE?{executablePath:process.env.RELEASE_BROWSER_EXECUTABLE}:{});
 async function context(handler,now='2026-11-16T08:00:00Z'){
  const c=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await c.routeWebSocket('**/*',ws=>ws.close());
  await c.addInitScript(stamp=>{window.testNow=Date.parse(stamp);Date.now=()=>window.testNow;},now);
  await c.route('**/*',async r=>{
   const url=new URL(r.request().url());if(await handler?.(r,url))return;
   if(url.origin===new URL(base).origin){
    const cached=cachedTrend(url);if(cached)return r.fulfill({json:cached});
    if(url.pathname==='/api/a-share-daily/schemes')return r.fulfill({json:{schemes:[]}});
    if(url.pathname==='/api/research-control/state')return r.fulfill({status:401,json:{error:'authentication_required'}});
   }

   if(url.href.includes('market-heatmap-fallback.json')||url.origin===new URL(base).origin&&url.pathname==='/api/a-share-daily/market')return r.fulfill({json:snapshot});
   if(url.origin===new URL(base).origin&&url.pathname.startsWith(new URL(base).pathname))return r.continue();return r.abort();
  });return c;
 }
 try{
  // The old duplicated request fixture would send 429 followed by a late 200.
  let requests=0;
  let c=await context(async(r,u)=>{if(u.pathname.endsWith('/research-data/snapshot.json')){requests++;await r.fulfill({status:requests===1?429:200,json:batch});return true;}});
  let page=await c.newPage();await page.goto(base+'us.html',{waitUntil:'domcontentloaded'});
  await waitWorkspaceState(page,'restricted');await openWorkspace(page);
  assert.equal(requests,1);assert.match(await page.locator('.sr-toolbar strong').innerText(),/来源拒绝或限流/);
  assert.ok(await page.locator('.sr-toolbar button').first().isDisabled());
  await page.reload({waitUntil:'domcontentloaded'});await waitWorkspaceState(page,'restricted');assert.equal(requests,1);
  record.checks.push({name:'429 followed by late-200 fixture',requests,workspace:'restricted',reloadRequests:0});
  await c.close();
  // A readable but unwritable store must block the first request and every reload.
  const storageBlocked=[];
  for(const route of ['us.html','screening/index.html']){
   let attempted=0;
   c=await context(async(r,u)=>{if(u.pathname.endsWith('/research-data/snapshot.json')){attempted++;await r.fulfill({status:429,json:batch});return true;}});
   await c.addInitScript(()=>{
    localStorage.setItem('fixture.storage-readable','readable');
    Storage.prototype.setItem=function(){throw new DOMException('Quota exceeded','QuotaExceededError');};
   });
   page=await c.newPage();await page.goto(base+route,{waitUntil:'domcontentloaded'});
   for(let load=0;load<3;load++){
    if(load)await page.reload({waitUntil:'domcontentloaded'});
    await waitWorkspaceState(page,'unavailable');await openWorkspace(page);
    assert.equal(await page.evaluate(()=>localStorage.getItem('fixture.storage-readable')),'readable');
    assert.match(await page.locator('.sr-toolbar strong').innerText(),/本机存储不可用.*已停止读取/);
    assert.match(await page.locator('.sr-notice').textContent(),/无法可靠保存来源停止记录/);
    assert.ok(await page.locator('.sr-toolbar button').first().isDisabled());
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(attempted,0);
   }
   storageBlocked.push({page:route,requests:attempted,reloads:2,workspace:'unavailable'});await c.close();
  }
  record.checks.push({name:'readable storage with QuotaExceededError blocks before fetch and across reloads',markets:storageBlocked});
  // An initial successful read cannot cache permission to write later stop records.
  requests=0;
  c=await context(async(r,u)=>{if(u.pathname.endsWith('/research-data/snapshot.json')){requests++;await r.fulfill({status:requests===1?200:429,json:batch});return true;}});
  await c.addInitScript(()=>{
   window.failStopStorage=window.name==='force-storage-failure';
   const original=Storage.prototype.setItem;
   Storage.prototype.setItem=function(key,value){if(window.failStopStorage)throw new DOMException('Quota exceeded','QuotaExceededError');return original.call(this,key,value);};
  });
  page=await c.newPage();await page.goto(base+'us.html',{waitUntil:'domcontentloaded'});
  await waitWorkspaceState(page,'not_configured');await openWorkspace(page);assert.equal(requests,1);
  await page.evaluate(()=>{window.failStopStorage=true;window.name='force-storage-failure';});
  await page.locator('.sr-toolbar button').first().click();
  await waitWorkspaceState(page,'unavailable');assert.equal(requests,1);
  assert.ok(await page.locator('.sr-toolbar button').first().isDisabled());
  await page.reload({waitUntil:'domcontentloaded'});await waitWorkspaceState(page,'unavailable');assert.equal(requests,1);
  record.checks.push({name:'storage rechecked before a manual refresh after a successful batch',initialRequests:1,additionalRequests:requests-1,reloadRequests:0,workspace:'unavailable'});await c.close();
  // A different tab's persistent stop appears while a successful response is in flight.
  let release,started;const ready=new Promise(resolve=>started=resolve);requests=0;
  c=await context(async(r,u)=>{if(u.pathname.endsWith('/research-data/snapshot.json')){requests++;started();await new Promise(resolve=>release=resolve);await r.fulfill({json:batch});return true;}});
  page=await c.newPage();await page.goto(base+'us.html',{waitUntil:'domcontentloaded'});await ready;
  await page.evaluate(()=>localStorage.setItem('books.stock.published-source-stop.v1','http_429'));release();
  await waitWorkspaceState(page,'restricted');assert.equal(requests,1);
  record.checks.push({name:'in-flight 200 cannot override a newly persisted denial',requests,workspace:'restricted'});await c.close();
  // Denial on the original daily-bar source blocks repeat calls, aliases and reloads.
  let daily=0;const requestedHosts=[];
  c=await context(async(r,u)=>{if(u.pathname.endsWith('/appstock/app/fqkline/get')&&r.request().frame()===r.request().frame().page().mainFrame()){daily++;requestedHosts.push(u.hostname);await r.fulfill({status:429,json:{}});return true;}});
  page=await c.newPage();await page.goto(base+'screening/index.html',{waitUntil:'domcontentloaded'});await page.locator('[data-selection][data-state=ready]').waitFor();
  await page.waitForFunction(()=>window.BooksTrendControllerApp?.getState().status==='complete');assert.equal(daily,0);
  assert.equal(await page.locator('[data-trend-limit="maxVolumeRatio"]').inputValue(),'2.5');
  await page.locator('details.pick-advanced > summary').click();
  await page.locator('#pick-query').fill('600519');await page.waitForFunction(()=>document.querySelectorAll('#pick-rows tr[data-code]').length===1);
  await page.locator('#pick-run').click();await page.locator('#pick-tech-access:not([hidden])').waitFor();
  assert.equal(daily,1);assert.ok(await page.locator('#pick-run').isDisabled());assert.ok(await page.locator('#pick-run-all').isDisabled());
  const again=await page.evaluate(()=>BooksTechnicalScreen.run({code:'600519.SH',asOf:'2026-11-13T08:15:00Z'},'2026-11-13'));
  assert.equal(again.sourceStopped,true);assert.equal(daily,1);
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('[data-selection][data-state=ready]').waitFor();assert.ok(await page.locator('#pick-run').isDisabled());assert.equal(daily,1);
  await page.locator('details.pick-advanced > summary').click();
  await page.locator('#pick-tech-access a').click();assert.ok(await page.locator('#research-file').isVisible());assert.equal(daily,1);
  record.checks.push({name:'Tencent stop survives repeat calls/reload and offers local-file recovery',dailyRequests:daily,requestedHosts,localFileVisible:true});await c.close();
  // Calendar boundary changes without reloading or receiving a new market batch.
  c=await context(undefined,'2026-11-16T06:59:00Z');page=await c.newPage();await page.goto(base+'screening/index.html',{waitUntil:'domcontentloaded'});await page.locator('[data-selection][data-state=ready]').waitFor();
  assert.equal(await page.locator('[data-selection]').getAttribute('data-freshness'),'dated');assert.match(await page.locator('#pick-freshness').innerText(),/2026-11-13.*逐股/);
  await page.evaluate(()=>{window.testNow=Date.parse('2026-11-16T07:00:00Z');document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.locator('[data-selection]').getAttribute('data-freshness'),'historical');assert.match(await page.locator('#pick-freshness').innerText(),/缺少.*2026-11-16/);
  assert.match(await page.locator('#pick-tech-status').innerText(),/历史条件观察 2026-11-13.*缺少 2026-11-16/);
  assert.match(await page.locator('#pick-run').innerText(),/历史/);
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#stock-selection').screenshot({path:path.join(output,'synthetic-calendar-'+width+'.png')});record.screens.push(width);}
  await page.evaluate(()=>{window.testNow=Date.parse('2027-01-04T08:00:00Z');document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.locator('[data-selection]').getAttribute('data-freshness'),'calendar-unverified');assert.match(await page.locator('#pick-tech-status').innerText(),/交易日历待核/);
  record.checks.push({name:'before-close -> after-close -> unknown-year preserves dated historical observation',before:'dated',after:'historical',unknown:'calendar-unverified'});await c.close();
  fs.writeFileSync(path.join(output,'selection.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);fs.writeFileSync(path.join(output,'selection-failure.txt'),e.stack);process.exitCode=1});
