'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const path=require('node:path'),playwright=require('playwright');
const engine=process.env.RELEASE_BROWSER||'chromium';
const output=path.join(process.env.RELEASE_OUTPUT||path.join(__dirname,'browser-output/release'),engine);fs.mkdirSync(output,{recursive:true});
const snapshot=require('./release-fixtures.cjs');
const batch=JSON.parse(fs.readFileSync(path.join(__dirname,'../research-data/snapshot.json'),'utf8'));
const record={at:new Date().toISOString(),network:'Synthetic fixtures; all external HTTP, WebSocket and write traffic blocked; no denied source contacted',checks:[],screens:[],writeAttempts:[],blockedExternal:0};
const base=process.env.RELEASE_BASE_URL;assert.ok(base,'test server required');
function waitWorkspaceState(page,state){
 return page.locator(`[data-stock-workspace][data-published-state="${state}"]`).waitFor({state:'attached'});
}
async function openWorkspace(page){
 const disclosure=page.locator('details.stock-custom-results');
 if(!await disclosure.evaluate(node=>node.open))await disclosure.locator(':scope > summary').click();
 await disclosure.locator('[data-stock-workspace]').waitFor({state:'visible'});
}
const deskFixture=require('./stock-desk-fixtures.cjs');
(async()=>{
 const browser=await playwright[engine].launch(engine==='chromium'&&process.env.RELEASE_BROWSER_EXECUTABLE?{executablePath:process.env.RELEASE_BROWSER_EXECUTABLE}:{});
 async function context(handler,now='2026-11-16T08:00:00Z'){
  const c=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await c.routeWebSocket('**/*',ws=>ws.close());
  await c.addInitScript(stamp=>{window.testNow=Date.parse(stamp);Date.now=()=>window.testNow;},now);
  await c.route('**/*',async r=>{
   const url=new URL(r.request().url());if(!['GET','HEAD'].includes(r.request().method())){record.writeAttempts.push({path:url.pathname,method:r.request().method()});return r.abort();}if(await handler?.(r,url))return;
   if(url.origin===new URL(base).origin){
    if(url.pathname==='/api/a-share-daily/schemes')return r.fulfill({json:{schemes:[]}});
    if(url.pathname==='/api/research-control/state')return r.fulfill({status:401,json:{error:'authentication_required'}});
   }

   if(url.href.includes('market-heatmap-fallback.json')||url.origin===new URL(base).origin&&url.pathname==='/api/a-share-daily/market')return r.fulfill({json:snapshot});
   if(url.origin===new URL(base).origin&&url.pathname.startsWith(new URL(base).pathname))return r.continue();record.blockedExternal++;return r.abort();
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
  for(const route of ['us.html']){
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
  // The new A-share page reads exactly one precomputed workbench endpoint.
  let desk=deskFixture(),deskMode='ready',deskRequests=0,retiredRequests=0;const chartRequests=[],pageErrors=[];
  c=await context(async(r,u)=>{
   if(u.pathname==='/api/a-share-daily/workbench'){deskRequests++;await r.fulfill(deskMode==='failed'?{status:503,json:{error:'synthetic_network_failure'}}:{json:desk});return true;}
   if(['/api/a-share-daily/entry-current-chart','/api/a-share-daily/viprasol-current-chart','/api/a-share-daily/a14-chart','/api/a-share-daily/workbench-chart','/api/a-share-daily/context-chart'].includes(u.pathname)){chartRequests.push(u.search);await r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240" viewBox="0 0 600 240"><title>Synthetic read-only dayK fixture</title><rect width="600" height="240" fill="#f7f9fb"/><text x="20" y="40" font-size="18">Synthetic dayK '+u.searchParams.get('window')+'</text><path d="M20 190L170 150L280 165L400 100L570 120" fill="none" stroke="#365a70"/></svg>'});return true;}
   if(u.origin===new URL(base).origin&&(u.pathname==='/research-data/snapshot.json'||u.pathname.startsWith('/api/a-share-daily/')||u.pathname==='/api/research-control/state')){retiredRequests++;await r.fulfill({status:404,json:{error:'retired_route_in_synthetic_fixture'}});return true;}
  },'2026-11-25T08:35:00Z');
  page=await c.newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.addInitScript(()=>{window.stockDeskStartup=[];addEventListener('pageshow',event=>window.stockDeskStartup.push({type:'pageshow',persisted:event.persisted,hidden:document.hidden}));document.addEventListener('visibilitychange',()=>window.stockDeskStartup.push({type:'visibilitychange',hidden:document.hidden}));});await page.goto(base+'screening/index.html',{waitUntil:'domcontentloaded'});
  await page.locator('#stock-desk[data-state="ready"]').waitFor();await page.waitForFunction(()=>document.querySelectorAll('#stock-desk-results article').length===2);
  await page.waitForLoadState('load');await page.evaluate(()=>new Promise(requestAnimationFrame));const startup=await page.evaluate(()=>window.stockDeskStartup);
  assert.equal(deskRequests,1,'startup lifecycle '+JSON.stringify(startup));assert.equal(retiredRequests,0);assert.match(await page.locator('#stock-desk-count').innerText(),/2 只.*3 条条件/);assert.equal(await page.locator('#entry-opportunities,#viprasol-opportunities,#trend-research-view,#research-file,[data-stock-workspace]').count(),0);
  assert.equal(await page.locator('script[src*="entry-opportunities-controller"],script[src*="viprasol-opportunities-controller"],script[src*="trend-controller"]').count(),0);
  assert.match(await page.locator('#stock-desk-results').innerText(),/截至2026-11-25 收盘：尚未突破.*接近触发.*验证通过/);assert.match(await page.locator('#stock-desk-results').innerText(),/当日价格触发.*未通过验证/);
  record.checks.push({name:'unified current workbench replaces only requested retired page mounts',workbenchRequests:deskRequests,retiredRequests,startup});
  await page.locator('#stock-desk-strategy').selectOption('short-term');assert.equal(await page.locator('#stock-desk-results article').count(),2);assert.match(await page.locator('#stock-desk-results').innerText(),/Synthetic beta/);
  await page.locator('#stock-desk-shape').selectOption('close-limitup-watch:close-limitup');assert.equal(await page.locator('#stock-desk-results article').count(),1);assert.equal(await page.locator('[data-stock-desk-stage]').innerText(),'截至2026-11-25 收盘：收盘近涨停（非当前买点）');assert.doesNotMatch(await page.locator('[data-stock-desk-reason]').innerText(),/[<>] —/);assert.match(await page.locator('[data-stock-desk-chart] img').getAttribute('src'),/workbench-chart/);await page.locator('#stock-desk-shape').selectOption('all');
  await page.locator('#stock-desk-strategy').selectOption('trend');assert.equal(await page.locator('#stock-desk-results article').count(),1);assert.match(await page.locator('#stock-desk-results').innerText(),/Synthetic alpha/);
  await page.locator('#stock-desk-strategy').selectOption('institution');assert.equal(await page.locator('#stock-desk-results article').count(),1);
  await page.locator('#stock-desk-query').fill('not-in-fixture');assert.equal(await page.locator('#stock-desk-results article').count(),0);await page.locator('#stock-desk-query').fill('');
  await page.locator('[data-stock-desk-institution] > summary').click();assert.match(await page.locator('[data-stock-desk-institution-body]').innerText(),/2026-11-24（日期精度）/);assert.equal(await page.locator('[data-stock-desk-institution-body] a').count(),1);
  await page.locator('[data-stock-desk-research] > summary').click();assert.match(await page.locator('[data-stock-desk-research-body]').innerText(),/样本 61.*15日平均变化.*最差回撤/s);assert.equal(await page.locator('[data-stock-desk-research-body] a').count(),0);
  const range=page.locator('[data-stock-desk-chart] select');await range.selectOption('120');await page.waitForFunction(()=>document.querySelector('[data-stock-desk-chart] img')?.complete&&document.querySelector('[data-stock-desk-chart] img').naturalWidth>0);
  assert.match(await page.locator('[data-stock-desk-chart] img').getAttribute('src'),/window=120$/);
  await page.evaluate(()=>BooksStockDeskApp.refresh());assert.equal(await page.locator('[data-stock-desk-research]').evaluate(node=>node.open),true);assert.equal(await range.inputValue(),'120');assert.equal(await page.locator('#stock-desk-strategy').inputValue(),'institution');
  record.checks.push({name:'strategy/query filters, inline research and official disclosure, mapped chart range and expanded poll state',retiredRequests,chartRequests:chartRequests.length});
  const accepted=await page.locator('#stock-desk-source').innerText();deskMode='failed';await page.evaluate(()=>BooksStockDeskApp.refresh());assert.match(await page.locator('#stock-desk-error').innerText(),/503.*保留上次结果/);assert.equal(await page.locator('#stock-desk-results article').count(),1);assert.equal(await page.locator('#stock-desk-source').innerText(),accepted);
  deskMode='ready';desk=deskFixture();desk.close.data.computedAt='2026-11-25T07:30:00Z';await page.evaluate(()=>BooksStockDeskApp.refresh());assert.match(await page.locator('#stock-desk-error').innerText(),/时间回退/);assert.equal(await page.locator('#stock-desk-results article').count(),1);
  desk=deskFixture();await page.evaluate(()=>BooksStockDeskApp.refresh());await page.locator('#stock-desk-phase').selectOption('a14');assert.equal(await page.locator('#stock-desk-results article').count(),0);assert.match(await page.locator('#stock-desk-empty').innerText(),/14:00候选尚未采集/);
  await page.locator('#stock-desk-phase').selectOption('close');await page.locator('#stock-desk-strategy').selectOption('all');assert.equal(await page.locator('#stock-desk-results article').count(),2);
  record.checks.push({name:'503 and older results retain the last dated success; missing 14:00 never borrows close candidates'});
  await page.locator('#stock-desk-tracking-tab').click();assert.equal(await page.locator('#stock-desk-candidates').isVisible(),false);assert.equal(await page.locator('#stock-desk-tracking').isVisible(),true);assert.match(await page.locator('#stock-desk-tracking thead').innerText(),/\+1日.*\+2日.*\+3日/s);assert.match(await page.locator('#stock-desk-tracking-rows').innerText(),/待满/);assert.match(await page.locator('#stock-desk-tracking-rows').innerText(),/0%/);assert.match(await page.locator('#stock-desk-tracking-rows').innerText(),/缺资料/);
  record.checks.push({name:'frozen episodes display +1/+2/+3 observations, genuine zero and missing outcomes without fabricated returns'});
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#stock-desk').screenshot({path:path.join(output,'synthetic-desk-tracking-'+width+'.png')});await page.locator('#stock-desk-candidates-tab').click();assert.equal(await page.locator('#stock-desk-results article').count(),2);assert.ok(await page.locator('#stock-desk-phase').evaluate(node=>node.getBoundingClientRect().height)>=44);await page.locator('#stock-desk').screenshot({path:path.join(output,'synthetic-desk-candidates-'+width+'.png')});record.screens.push({surface:'stock-desk',width});await page.locator('#stock-desk-tracking-tab').click();}
  // Synthetic contract coverage only: a daily T observation is never promoted to an original validated B.
  const contextual=structuredClone(desk.close.data.current[0]),historical={sampleCount:40,stockCount:12,signalDayCount:14,meanReturnPercent:1.2,medianReturnPercent:.8,worstDrawdownPercent:6,adequate:true,reasons:[]},pathValues=Array.from({length:16},(_,index)=>index*.2);
  Object.assign(contextual,{id:'synthetic:daily-T',code:'600002.SH',name:'Synthetic daily plan',familyId:'daily-setup-watch',setupId:'range-support:2026-11-25',ruleIds:['range-support'],state:'watch',qualified:false,strategy:'trend',reference:{close:10,trigger:10.5,invalidation:9.4}});
  contextual.research={rules:[],position:{metrics:{return5:2,rangePosition60Percent:24,ma20Deviation:1.3},strength:{return20Percentile:85,return20Denominator:3000},limitUp:{status:'ready',consecutiveCount:0}},plan:{version:'synthetic-plan-v1',kind:'range-support',label:'Synthetic daily T observation',modelState:'existing_position_T_watch',signalDay:'2026-11-25',buyZone:{low:9.8,high:10.2},reduceZone:{low:11.5,high:12},trigger:10.5,invalidation:9.4,reason:['Synthetic known-prefix condition only'],holdingRequired:true,qualified:false,actualFillVerified:false},analogue:{key:'synthetic-only',label:'Synthetic historical conditions',regime:'sideways',positionBand:'low',horizons:{3:historical,15:historical},path:{sampleCount:40,stockCount:12,signalDayCount:14,median:pathValues,p25:pathValues.map(value=>value-1),p75:pathValues.map(value=>value+1),adequate:true,reasons:[]},method:'historical_close_path_not_forecast_or_trade_return',currentRosterBias:true}};
  contextual.chartUrls=Object.fromEntries([60,120].map(window=>[window,'/api/a-share-daily/context-chart?'+new URLSearchParams({generation:contextual.generation,code:contextual.code,kind:'range-support',window:String(window)})]));desk.close.data.current.push(contextual);
  desk.close.data.marketContext.position={benchmark:{regime:'bullish_trend'},breadth:{validPairs:3000,advancers:1700,decliners:1200,flat:100,ma20Denominator:2900,aboveMa20Count:1800,aboveMa20Percent:62.07},limitUpLike:{count:42},coverage:{ready:3100,total:3460}};
  await page.locator('#stock-desk-candidates-tab').click();await page.evaluate(()=>BooksStockDeskApp.refresh());await page.locator('#stock-desk-strategy').selectOption('t-plan');assert.equal(await page.locator('#stock-desk-results article').count(),1);assert.match(await page.locator('[data-stock-desk-stage]').innerText(),/截至2026-11-25 收盘：尚未突破/);assert.doesNotMatch(await page.locator('[data-stock-desk-stage]').innerText(),/验证通过|价格触发/);
  assert.match(await page.locator('#stock-desk-market-position').innerText(),/可比3,000只.*1,800\/2,900/);assert.match(await page.locator('[data-stock-desk-position]').innerText(),/强于 85%（3,000只）.*60日区间位置 24%/);assert.match(await page.locator('[data-stock-desk-plan-levels]').innerText(),/9.8–10.2.*11.5–12/s);assert.match(await page.locator('[data-stock-desk-plan-note]').innerText(),/可卖底仓.*当天新买不能当日卖出/);assert.match(await page.locator('.stock-desk-chart-note').innerText(),/窗口不是持仓或预测期/);
  const contextRange=page.locator('[data-stock-desk-chart] select');assert.match(await contextRange.innerText(),/近60个交易日.*近120个交易日/s);await page.locator('[data-stock-desk-research] > summary').click();assert.match(await page.locator('[data-stock-desk-analogue]').innerText(),/历史收盘路径，非预测.*3交易日.*40.*15交易日.*40/s);assert.equal(await page.locator('[data-stock-desk-analogue] svg').count(),1);assert.equal(await page.locator('[data-stock-desk-analogue] a').count(),0);await contextRange.selectOption('120');await page.evaluate(()=>BooksStockDeskApp.refresh());assert.equal(await page.locator('[data-stock-desk-research]').evaluate(node=>node.open),true);assert.equal(await contextRange.inputValue(),'120');assert.match(await page.locator('[data-stock-desk-chart] img').getAttribute('src'),/kind=range-support.*window=120$/);
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#stock-desk').screenshot({path:path.join(output,'synthetic-desk-plan-'+width+'.png')});}
  record.checks.push({name:'dated states, explicit trading-session window, phase-bound market denominators, existing-position T plan and inline historical distribution',contextChartRequests:chartRequests.filter(value=>value.includes('kind=range-support')).length});await page.locator('#stock-desk-strategy').selectOption('all');
  await page.locator('#stock-desk-candidates-tab').click();await page.evaluate(()=>{window.testNow=Date.parse('2026-11-26T01:30:00Z');document.dispatchEvent(new Event('visibilitychange'));});await page.waitForFunction(()=>document.querySelectorAll('#stock-desk-results article').length===0);assert.match(await page.locator('#stock-desk-empty').innerText(),/已过期/);await page.locator('#stock-desk-tracking-tab').click();assert.equal(await page.locator('#stock-desk-tracking-rows tr').count(),2);
  assert.deepEqual(pageErrors,[]);assert.equal(retiredRequests,0);assert.deepEqual(record.writeAttempts,[]);record.checks.push({name:'exact expiry removes current opportunity labels while retaining track episodes',retiredRequests,pageErrors,writeAttempts:0});await c.close();
  fs.writeFileSync(path.join(output,'selection.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);fs.writeFileSync(path.join(output,'selection-failure.txt'),e.stack);process.exitCode=1});
