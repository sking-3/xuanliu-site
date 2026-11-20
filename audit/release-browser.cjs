'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const playwright=require('playwright');
const fixture=require('./release-fixtures.cjs');
const quantBars=Array.from({length:360},(_,i)=>({time:Date.UTC(2023,0,1+i),open:100+i/20,high:103+i/20,low:98+i/20,close:101+i/20,volume:1000}));
const quantFixture={schemaVersion:1,status:'stale',source:{name:'Synthetic offline regression'},bars:quantBars,dataHash:crypto.createHash('sha256').update(JSON.stringify(quantBars)).digest('hex'),retrievedAt:'2024-01-01T00:00:00.000Z',latestClosedAt:new Date(Date.UTC(2023,0,361)).toISOString(),report:null,reportHash:null};
const base=new URL(process.env.RELEASE_BASE_URL),engine=process.env.RELEASE_BROWSER||'chromium';
const output=path.join(process.env.RELEASE_OUTPUT||path.join(__dirname,'browser-output/release'),engine);
fs.mkdirSync(output,{recursive:true});
const report={engine,base:base.href,revision:process.env.EXPECTED_SHA||null,synthetic:true,externalRequestsBlocked:true,pages:[],interactions:[]};
const routes=['index.html','screening/index.html','us.html','trader/index.html','tools.html','research.html','screening/history.html','crypto.html','chart.html','company-dossier.html','agent-studio.html','a-shares.html','us-live.html','quant-research/index.html'];
async function main(){
 const browser=await playwright[engine].launch(engine==='chromium'&&process.env.RELEASE_BROWSER_EXECUTABLE?{executablePath:process.env.RELEASE_BROWSER_EXECUTABLE}:{});
 try{
  for(const width of [1440,768,390,375]){
   const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
   await context.routeWebSocket('**/*',ws=>ws.close());
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());
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
     assert.equal(await nav.locator('a').count(),7,route+' navigation count');
     const links=await nav.locator('a').evaluateAll(nodes=>nodes.map(n=>n.href));
     assert.ok(links.every(url=>new URL(url).origin===base.origin&&new URL(url).pathname.startsWith(base.pathname)),route+' navigation base path');
     if(width<768){
      await page.locator('.books-menu-toggle').click();await nav.waitFor({state:'visible'});
      await page.locator('.books-menu-toggle').click();
     }
    }
    if(route==='screening/index.html'){
     await page.locator('[data-selection][data-state=ready]').waitFor();
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
