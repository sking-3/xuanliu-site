'use strict';
// Verify the real homepage's unverified leader observation. All provider traffic is blocked.
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
   let nativeMode='blocked',rankingRequests=0;
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin===base.origin&&url.pathname===new URL('research-data/a-active-stocks.json',base).pathname){
     rankingRequests++;return route.fulfill({json:fixture()});
    }
    if(url.hostname==='s3.tradingview.com'&&url.pathname==='/external-embedding/embed-widget-hotlists.js'){
     if(nativeMode==='fixture')return route.fulfill({contentType:'text/javascript',body:"const s=document.currentScript,c=JSON.parse(s.textContent);if(c.exchange!=='SSE'||c.locale!=='zh_CN'||c.showChart!==false)throw Error('wrong hot-list configuration');const f=document.createElement('iframe');f.title='合成组件测试';f.style.cssText='width:100%;height:450px;border:0';f.srcdoc='<p>合成组件测试 · 非真实行情</p><a target=\"_top\" href=\"'+c.largeChartUrl+'?tvwidgetsymbol=SSE%3A600519\">合成组件测试</a>';s.parentElement.querySelector('.tradingview-widget-container__widget').replaceChildren(f);"});
     return route.abort();
    }
    if(url.href.includes('market-heatmap-fallback.json'))return route.fulfill({json:marketFixture});
    if(url.origin===base.origin&&url.pathname.startsWith(base.pathname))return route.continue();
    return route.abort();
   });
   const page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
   await page.goto(new URL('index.html',base).href,{waitUntil:'domcontentloaded'});
   const section=page.locator('#home-short-leaders');
   await section.scrollIntoViewIfNeeded();
   assert.equal(await section.locator('h2').innerText(),'A 股短线龙头观察');
   assert.match(await section.locator('[role=status]').innerText(),/关键证据尚未齐备，暂不展示候选/);
   assert.equal(await section.getAttribute('data-state'),'unverified');
   assert.deepEqual(await section.locator('dt').allTextContents(),['连板高度','热点板块','成交与换手','风险提示']);
   assert.match(await section.innerText(),/涨停是观察线索，不能单独认定龙头/);
   assert.equal(await section.locator('ol, table, a[href*="tvwidgetsymbol"], [data-symbol]').count(),0);
   assert.equal(await page.locator('#active-stocks-list,#home-active-stocks').count(),0);
   assert.equal(await page.locator('script[src*="home-active-stocks.js"]').count(),0);
   assert.equal(await page.evaluate(()=>typeof window.BooksActiveStocks),'undefined');
   assert.equal(await page.evaluate(()=>document.querySelector('#home-tv-movers').nextElementSibling.id),'home-short-leaders');
   assert.equal(await page.locator('#market-radar[aria-label="市场异动"]').count(),1);
   const sizes=await section.evaluate(el=>({viewport:innerWidth,page:document.documentElement.scrollWidth,section:el.scrollWidth,client:el.clientWidth}));
   assert.ok(sizes.page<=sizes.viewport+1&&sizes.section<=sizes.client+1,'no overflow at '+width);
   await section.screenshot({path:path.join(output,'leader-observation-'+width+'.png')});
   // A supplied old turnover list must never become a leader list, including after restore/reload.
   await page.evaluate(()=>{
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
    document.dispatchEvent(new Event('visibilitychange'));
   });
   await page.reload({waitUntil:'domcontentloaded'});
   await page.locator('#home-short-leaders[data-state=unverified]').waitFor();
   assert.equal(rankingRequests,0,'legacy turnover producer is not consumed by leader observation');
   await page.locator('#tv-hotlists-host[data-widget-state="unavailable"]').waitFor();
   assert.equal(await page.locator('[data-home-movers-source]').isVisible(),true);
   nativeMode='fixture';
   await page.reload({waitUntil:'domcontentloaded'});
   await page.frameLocator('#tv-hotlists-host iframe').getByRole('link',{name:'合成组件测试',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#chart-symbol')?.textContent==='SSE:600519');
   assert.equal(new URL(page.url()).origin,base.origin);
   assert.equal(rankingRequests,0);
   assert.deepEqual(errors,[]);
   report.checks.push({width,state:'unverified',evidenceFields:4,leaderCandidates:0,legacyRankingRequests:rankingRequests,
    marketMoversPreserved:true,nativeNavigation:'synthetic fixture only',noOverflow:true});
   await context.close();
  }
  console.log('PASS '+engine+': leader observation at 4 widths, no fabricated candidates or legacy ranking requests; existing mover navigation preserved with synthetic fixture');
 }finally{await browser.close();fs.writeFileSync(path.join(output,'leader-observation.json'),JSON.stringify(report,null,2)+'\n');}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
