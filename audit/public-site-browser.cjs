'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, webkit, devices} = require('playwright');

const root = path.resolve(__dirname,'..');
const base = new URL('http://127.0.0.1:8789/');
const engine = process.env.UI_BROWSER || 'chromium';
assert.ok(['chromium','webkit'].includes(engine));
const mobile = engine === 'webkit';
const profile = mobile ? devices['iPhone 13'] : {viewport:{width:1440,height:900}};
const out = path.join(__dirname,'browser-output/public-site',engine);
const report = {engine, viewport:profile.viewport, revision:process.env.GITHUB_SHA || null, checks:[]};
const embedded = new Set(['market-strip.html','home-watch-quotes.html','a-market-widget.html']);
const fileJSON = name => JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const day = stamp => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(stamp));
const digits = text => text.replace(/[\s,，]/g,'');
const numeric = text => Number(text.replace(/[,，\s%％]/g,'').replace(/−/g,'-'));
const normalizeDate = text => text.replace(/[年/.]/g,'-').replace(/月/g,'-').replace(/日/g,'');
const slug = label => label.replace(/[^a-zA-Z0-9-]+/g,'-');
const failures = [];

function publicPages(dir='') {
  const entries=fs.readdirSync(path.join(root,dir),{withFileTypes:true});
  const html=entries.filter(e=>e.isFile() && e.name.endsWith('.html')).map(e=>dir+e.name);
  for(const sub of entries.filter(e=>e.isDirectory() && ['trader','binance','screening'].includes(e.name))) {
    html.push(...publicPages(dir+sub.name+'/'));
  }
  return html.sort();
}

async function open(page,route) {
  const response=await page.goto(new URL(route,base).href,{waitUntil:'domcontentloaded',timeout:50000});
  assert.ok(response?.ok(),route+' HTTP '+response?.status());
}

async function check(context,label,action) {
  const page=await context.newPage();
  const errors=[];
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  try {
    const evidence=await action(page);
    assert.deepEqual(errors,[],'uncaught JavaScript errors');
    report.checks.push({name:label,status:'pass',evidence});
    console.log('PASS',label,JSON.stringify(evidence));
  } catch(error) {
    failures.push(label+': '+error.message);
    report.checks.push({name:label,status:'failed',reason:error.message});
    console.error('FAIL',label,error.message);
    await page.screenshot({path:path.join(out,'failed-'+slug(label)+'.png'),timeout:7000}).catch(()=>{});
  } finally { await page.close(); }
}

async function noOverflow(page) {
  const {width,scroll}=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(scroll<=profile.viewport.width+1 && width<=profile.viewport.width+1,
    'page width '+scroll+' / viewport '+width+' / device '+profile.viewport.width);
}

async function shell(page,route) {
  await open(page,route);
  assert.ok((await page.title()).trim().length>=3,route+' title');
  if(route==='trader/binance/index.html'){
    await page.waitForURL(url=>url.pathname==='/trader/' && url.searchParams.get('exchange')==='Binance');
  }
  if(embedded.has(route)) {
    await noOverflow(page);
    return {component:true,title:await page.title()};
  }
  const title=page.locator('h1');
  assert.equal(await title.count(),1,route+' single page title');
  await title.waitFor();
  const heading=(await title.innerText()).trim();
  assert.ok(heading);
  const nav=page.locator('.books-nav');
  if(await nav.count()){
    await page.locator('.books-menu-toggle').waitFor({state:'attached'});
    if(mobile) {
      const toggle=page.locator('.books-menu-toggle');
      await toggle.click();
      await nav.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    }
    assert.ok(await nav.locator('a[aria-current]').count()>=1,route+' active section');
    const targets=await nav.locator('a[href]').evaluateAll(links=>links.map(a=>a.href));
    assert.ok(targets.length>=7,route+' nav items');
    for(const href of targets){
      const url=new URL(href);
      assert.equal(url.origin,base.origin);
      assert.ok(fs.existsSync(path.join(root,decodeURIComponent(url.pathname))),url.pathname);
    }
    if(mobile) {
      await nav.locator('a').first().focus();
      await page.keyboard.press('Escape');
      await nav.waitFor({state:'hidden'});
      assert.equal(await page.locator('.books-menu-toggle').getAttribute('aria-expanded'),'false');
    }
  } else {
    assert.equal(route,'us-live.html',route+' needs a usable way back to the site');
    await page.getByRole('link',{name:/返回美股/}).waitFor();
  }
  await noOverflow(page);
  if(['index.html','a-shares.html','us.html','research.html','tools.html','trader/index.html','trader/exchange.html','agent-studio.html'].includes(route))
    await page.screenshot({path:path.join(out,'layout-'+slug(route)+'.png')});
  return {heading,title:await page.title()};
}

async function offlineContext(browser) {
  const context=await browser.newContext({...profile,locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base.origin?route.continue():route.abort('internetdisconnected'));
  await context.routeWebSocket(/wss?:\/\//,socket=>socket.close());
  return context;
}

async function economicFiles(page) {
  await open(page,'tools.html');
  const daily=fileJSON('research-data/a-daily-movers.json'), latest=fileJSON('macro-cn.json').card.data.latest;
  assert.ok(daily.priced>=5000 && latest.url.startsWith('https://www.stats.gov.cn/'));
  const close=page.locator('#tools-close'), release=page.locator('#tools-release');
  await close.getByText(new RegExp(daily.priced.toLocaleString('en-US').replace(',','[,，]?'), 'u')).first().waitFor();
  assert.ok(normalizeDate(await close.innerText()).includes(day(daily.asOf)),'dated coverage for A shares');
  await release.getByText(latest.title,{exact:false}).first().waitFor();
  assert.ok(normalizeDate(await release.innerText()).includes(day(latest.publishedAt)),'dated Chinese official release');
  await release.locator('a').filter({hasText:latest.title}).first().waitFor({timeout:2000}).catch(()=>{});
  assert.ok((await release.locator('a').evaluateAll(nodes=>nodes.map(a=>a.href))).includes(latest.url),'direct source article');
  return {asOf:daily.asOf,priced:daily.priced,macroTitle:latest.title,macroPublishedAt:latest.publishedAt,macroURL:latest.url};
}

async function dailyFallback(page) {
  const raw=fileJSON('research-data/a-daily-movers.json');
  await open(page,'index.html');
  const daily=page.locator('[data-mover-market="a"] .radar-main-body');
  await daily.locator('[data-daily-origin="bundled"]').waitFor();
  assert.equal(Date.parse(await daily.locator('[data-daily-asof]').getAttribute('datetime')),Date.parse(raw.asOf));
  for(const side of ['gainers','losers']){
    const rows=daily.locator('[data-daily-side="'+side+'"] li[data-code]');
    assert.deepEqual(await rows.evaluateAll(nodes=>nodes.map(n=>n.dataset.code)),raw[side].map(s=>s.code));
    for(const [index,stock] of raw[side].entries()) assert.ok((await rows.nth(index).innerText()).includes(stock.name));
  }
  return {scope:'public closing archive, upstream disconnected',asOf:raw.asOf,priced:raw.priced,gainers:raw.gainers,losers:raw.losers};
}

async function annualReturn(page) {
  const source=fileJSON('trader/binance/evidence/aoying-analysis-current/performance-365D.json');
  assert.equal(source.data.timeRange,'365D');
  assert.ok(source.success && Number.isFinite(source.data.roi));
  await open(page,'index.html');
  await page.locator('[data-ranking-period="365D"]').click();
  const row=page.locator('#home-ranking-list .home-rank-row').filter({hasText:'熬鹰资本'});
  await row.waitFor();
  const roi=numeric(await row.locator('.home-rank-profit strong').innerText());
  assert.ok(Math.abs(roi-source.data.roi)<=.006,'annual ROI '+roi+' vs Binance record '+source.data.roi);
  await row.locator('a').first().click();
  await page.locator('#detail[open]').waitFor();
  assert.equal(await page.locator('#period').inputValue(),'365D');
  assert.ok((await page.locator('#detail').innerText()).includes('熬鹰资本'));
  return {name:'熬鹰资本',roi,period:'365D',source:'trader/binance/evidence/aoying-analysis-current/performance-365D.json'};
}

async function publicExecutions(page) {
  const script=fs.readFileSync(path.join(root,'trader/replay-seed.js'),'utf8');
  const raw=JSON.parse(script.slice(script.indexOf('globalThis.BooksPublicRecordSeed=')+'globalThis.BooksPublicRecordSeed='.length).trim().replace(/;$/,''));
  assert.equal(raw.scope,'public_execution_records_only');
  await open(page,'trader/exchange.html');
  const rows=page.locator('#evidence-rows tr[data-id]');
  await rows.first().waitFor();
  const sample=await rows.evaluateAll(nodes=>nodes.slice(0,4).map(row=>({id:row.dataset.id,text:row.innerText})));
  for(const {id,text} of sample){
    const source=raw.records[id];
    assert.ok(source,'observed record '+id);
    assert.ok(text.includes(source.symbol) && digits(text).includes(String(Number(source.executedQty))) && digits(text).includes(String(Number(source.avgPrice))),text);
  }
  const symbol=raw.records[sample[0].id].symbol;
  await page.locator('#evidence-symbol').selectOption(symbol);
  assert.ok((await rows.allInnerTexts()).every(text=>text.includes(symbol)));
  assert.ok(normalizeDate(await page.locator('#evidence-status').innerText()).includes(day(raw.lastSuccessAt)),'public observation time');
  return {source:'trader/replay-seed.js',lastSuccessAt:raw.lastSuccessAt,sample};
}

async function fiveAgents(page) {
  const stock=fileJSON('research-data/a-daily-movers.json').gainers[0];
  await open(page,'agent-studio.html');
  await page.locator('#agent-symbol').fill(stock.code);
  await page.locator('#agent-evidence').fill(stock.name+' 出现在已归档的 A 股日涨幅名单。');
  await page.locator('#agent-run').click();
  assert.equal(await page.locator('#agent-cards article').count(),5);
  assert.match(await page.locator('#agent-ai-state').innerText(),/未调用 AI|规则模式/);
  assert.match(await page.locator('#agent-output-state').innerText(),/等待|不足|待核|未评估/);
  await page.reload({waitUntil:'domcontentloaded'});
  assert.equal(await page.locator('#agent-symbol').inputValue(),stock.code);
  return {symbol:stock.code,roles:5,mode:'rules',incompleteEvidence:await page.locator('#agent-output-state').innerText()};
}

async function cryptoFailure(page) {
  await open(page,'crypto.html');
  const feed=page.locator('[data-crypto-feed][data-scope=full]');
  await feed.locator('[data-crypto-retry]').waitFor();
  assert.equal(await feed.getAttribute('data-crypto-state'),'error');
  assert.equal(await feed.locator('.crypto-quote-value').count(),0);
  await feed.locator('[data-crypto-retry]').click();
  await feed.locator('[data-crypto-retry]').waitFor();
  return {source:'Bitget',status:await feed.locator('[data-crypto-status]').innerText()};
}

async function liveCrypto(page) {
  // Isolate the REST path so a subsequent WebSocket tick cannot race the independent comparison.
  // Every price below must originate in Bitget's real HTTPS response during this visit.
  await page.routeWebSocket(/wss?:\/\/[^/]*bitget\.com\//,socket=>socket.close());
  const response=page.waitForResponse(res=>{
    const url=new URL(res.url());
    return url.hostname==='api.bitget.com' && url.pathname==='/api/v2/spot/market/tickers';
  },{timeout:35000}).catch(()=>null);
  await open(page,'crypto.html');
  const source=await response;
  assert.ok(source?.ok(),'real Bitget REST source unreachable');
  const data=await source.json();
  assert.equal(data.code,'00000','vendor returned success');
  const verified=[];
  for(const symbol of ['BTC','ETH','SOL']){
    const item=data.data.find(tick=>tick.symbol===symbol+'USDT');
    const price=Number(item?.lastPr), pct=Number(item?.change24h)*100, ts=Number(item?.ts);
    assert.ok(price>0 && Number.isFinite(pct) && ts>0 && Math.abs(Date.now()-ts)<300000,'fresh timestamped '+symbol+' inputs');
    const row=page.locator('.crypto-quote-row').filter({has:page.getByText(symbol+'-USDT',{exact:true})});
    const expected=price.toLocaleString('en-US',{maximumFractionDigits:8});
    await row.locator('.crypto-quote-value strong').filter({hasText:expected}).waitFor();
    assert.equal(numeric(await row.locator('.crypto-quote-value strong').innerText()),Number(price.toFixed(8)));
    assert.ok(Math.abs(numeric(await row.locator('.crypto-quote-value span').innerText())-pct)<=.00501,'Bitget 24h change '+symbol);
    const stamp=new Date(ts).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});
    assert.ok((await row.locator('.crypto-quote-source').innerText()).includes(stamp));
    verified.push({symbol,sourceUTC:new Date(ts).toISOString(),price,pct});
  }
  await noOverflow(page);
  await page.locator('[data-crypto-feed]').screenshot({path:path.join(out,'real-bitget.png')});
  return {source:source.url(),type:'real REST, comparison with WebSocket updates disabled',verified};
}

async function liveUS(page) {
  const scans=[];
  page.on('response',async res=>{
    try {
      const url=new URL(res.url());
      if(url.hostname!=='scanner.tradingview.com' || !url.pathname.includes('/america/scan') || !res.ok())return;
      const query=res.request().postDataJSON(), payload=await res.json();
      const idx=query?.columns?.indexOf('change');
      if(idx>=0 && Array.isArray(payload?.data))scans.push(Object.fromEntries(payload.data.map(row=>[row.s,row.d[idx]])));
    } catch {}
  });
  await open(page,'index.html');
  const board=page.locator('.radar-stocks [data-mover-market=us]');
  await board.locator('.radar-mover-stage').evaluate(el=>el.scrollIntoView({block:'center'}));
  const frame=board.frameLocator('iframe');
  const table=frame.locator('tr[data-symbol]:has(td[data-field-key="change"])');
  const observed=[];
  for(const [direction,sign] of [['gainers',1],['losers',-1]]){
    if(sign<0)await board.locator('[data-kind=losers]').click();
    const cells=table.locator('td[data-field-key=change]').filter({hasText:/[%％]/});
    await cells.nth(1).waitFor({timeout:35000});
    const values=await table.evaluateAll(rows=>rows.slice(0,2).map(row=>({symbol:row.dataset.symbol,change:row.querySelector('td[data-field-key="change"]').innerText})));
    const src=new URL(await board.locator('iframe').getAttribute('src'),base);
    assert.ok(src.protocol==='https:' && /(^|\.)tradingview(-widget)?\.com$/.test(src.hostname),'genuine TradingView provider frame '+src.hostname);
    assert.equal(new Set(values.map(row=>row.symbol)).size,2);
    for(const item of values) {
      assert.match(item.symbol,/^[A-Z0-9]+:[A-Z0-9.-]+$/);
      item.pct=numeric(item.change);
      assert.ok(sign*item.pct>0 && Number.isFinite(item.pct),'US '+direction+' direction');
    }
    const match=()=>scans.find(batch=>values.every(item=>Number.isFinite(batch[item.symbol]) && Math.abs(batch[item.symbol]-item.pct)<=.0051));
    for(let retry=0;!match() && retry<5;retry++)await page.waitForTimeout(200);
    let independent=match();
    if(!independent){
      // Compare with a new, read-only symbol query from the same provider, recording cross-tick drift.
      const url='https://scanner.tradingview.com/america/scan';
      const evidence=await page.request.post(url,{data:{symbols:{tickers:values.map(item=>item.symbol)},columns:['change']},timeout:15000});
      assert.ok(evidence.ok(),'independent TradingView symbol check HTTP '+evidence.status());
      const payload=await evidence.json();
      independent=Object.fromEntries(payload.data.map(row=>[row.s,row.d[0]]));
      for(const item of values) assert.ok(Number.isFinite(independent[item.symbol]) && Math.abs(independent[item.symbol]-item.pct)<=0.10,'US quote drift exceeds 0.10 percentage point for '+item.symbol);
    }
    observed.push({direction,source:src.origin,values,verifiedChanges:values.map(item=>independent[item.symbol])});
    if(sign>0) await board.screenshot({path:path.join(out,'real-us-gainers.png')});
  }
  return observed;
}

async function researchFiles(page) {
  await open(page,'screening/index.html');
  const close=page.locator('[data-closing-ranks][data-state=ready]');
  await close.waitFor();
  const snapshot=fileJSON('research-data/a-daily-movers.json');
  const listed=await close.locator('[data-closing-lists]').innerText();
  for(const row of [...snapshot.gainers,...snapshot.losers]) assert.ok(listed.includes(row.code) && listed.includes(row.name),row.code);
  assert.ok(normalizeDate(await close.locator('[data-closing-status]').innerText()).includes(day(snapshot.asOf)));
  await open(page,'research.html');
  const sourceLinks=await page.locator('.issuer-list a[href]').evaluateAll(links=>links.map(link=>({label:link.innerText,url:link.href})));
  assert.equal(sourceLinks.length,3);
  for(const {url,label} of sourceLinks) assert.ok(new URL(url).protocol==='https:' && label.trim(),url);
  const filter=page.locator('#integration-filter');
  await filter.selectOption('private');
  await page.locator('[data-integrations-grid]').getByText('TigerOpen',{exact:true}).waitFor();
  return {scope:'published close, issuer reference links and private account configuration labels',asOf:snapshot.asOf,sourceLinks};
}

async function fullA(page) {
  const upstream=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/src/lib/data/market-heatmap-fallback.json'),{timeout:35000}).catch(()=>null);
  await open(page,'a-shares.html');
  const board=page.locator('#a-market[data-close-source]');
  await board.waitFor();
  const response=await upstream;
  assert.ok(response?.ok(),'actual A-share closing archive is unavailable');
  const sourceURL=new URL(response.url());
  assert.equal(sourceURL.hostname,'raw.githubusercontent.com');
  assert.ok(sourceURL.pathname.startsWith('/wenyuanw/a-share-heatmap/'));
  const data=await response.json();
  const stocks=data.stocks.filter(row=>Number.isFinite(row.price) && row.price>0 && Number.isFinite(row.changePct))
    .map(row=>({code:row.code.split('.')[0],name:row.name,change:row.changePct}));
  assert.ok(stocks.length>=5000 && Date.parse(data.updatedAt)<=Date.now()+300000);
  for(const [side,sign] of [['gainers',1],['losers',-1]]){
    const expected=stocks.filter(stock=>sign*stock.change>0).sort((a,b)=>sign*(b.change-a.change)||a.code.localeCompare(b.code)).slice(0,3);
    const rows=board.locator('[data-close-direction="'+side+'"] li[data-code]');
    await rows.first().filter({hasText:expected[0].code}).waitFor();
    const actual=await rows.evaluateAll(nodes=>nodes.slice(0,3).map(row=>({code:row.dataset.code,text:row.innerText})));
    assert.deepEqual(actual.map(row=>row.code),expected.map(row=>row.code));
    for(const [i,row] of actual.entries())assert.ok(row.text.includes(expected[i].name));
  }
  const search=page.locator('#a-close-query'), stock=stocks.find(row=>row.code==='000858');
  assert.ok(stock);
  await search.fill(stock.code);
  await page.waitForFunction(({code,name})=>{
    const visible=document.querySelector('#a-market').innerText.replace(/\s/g,'');
    return visible.includes(code) && visible.includes(name.replace(/\s/g,''));
  },stock);
  await board.screenshot({path:path.join(out,'real-a-search.png')});
  return {source:response.url(),asOf:data.updatedAt,validQuotes:stocks.length,search:stock.code};
}

async function main() {
  fs.mkdirSync(out,{recursive:true});
  const browser=await (mobile?webkit:chromium).launch();
  try {
    const offline=await offlineContext(browser);
    for(const route of publicPages()) await check(offline,'layout '+route,page=>shell(page,route));
    for(const [name,fn] of [
      ['published desk inputs',economicFiles],['published daily ranks with upstream offline',dailyFallback],
      ['annual trader performance and detail',annualReturn],['public execution archive and filter',publicExecutions],
      ['research pages and source filter',researchFiles],['five-agent rules without AI',fiveAgents],['Bitget unavailable and retry',cryptoFailure]
    ])await check(offline,name,fn);
    await offline.close();
    const online=await browser.newContext({...profile,locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block',reducedMotion:'reduce'});
    for(const [name,fn] of [['live A-share closing source',fullA],['live US ranking data',liveUS],['live Bitget quote values',liveCrypto]])await check(online,name,fn);
    await online.close();
  } finally {
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));
    await browser.close();
  }
  assert.ok(!failures.length,failures.join('\n'));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
