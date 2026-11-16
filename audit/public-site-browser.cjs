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
    assert.equal(targets.length,7,route+' seven primary entrances');
    const shortcuts=page.locator('.books-shortcuts');
    await shortcuts.waitFor();
    const quick=await shortcuts.locator('a').evaluateAll(links=>links.map(a=>new URL(a.href).pathname).sort());
    assert.deepEqual(quick,['/a-shares.html','/crypto.html','/us-live.html']);
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
  await close.filter({hasText:new RegExp(daily.priced.toLocaleString('en-US').replace(',','[,，]?'))}).waitFor();
  assert.ok(normalizeDate(await close.innerText()).includes(day(daily.asOf)),'dated coverage for A shares');
  await release.filter({hasText:latest.title}).waitFor();
  assert.ok(normalizeDate(await release.innerText()).includes(day(latest.publishedAt)),'dated Chinese official release');
  assert.equal(await page.locator('#tools-release-source').getAttribute('href'),latest.url,'direct source article');
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
  const sample=await rows.evaluateAll(nodes=>nodes.slice(0,4).map(row=>({
    id:row.dataset.id,updatedAt:row.querySelector('time').dateTime,symbol:row.cells[1].querySelector('strong').innerText,
    direction:row.cells[1].querySelector('small').innerText,quantity:row.cells[2].innerText,price:row.cells[3].innerText
  })));
  const directions={opening_or_increasing_long:'开多/加多方向',opening_or_increasing_short:'开空/加空方向',reducing_or_closing_long:'减多/平多方向',reducing_or_closing_short:'减空/平空方向',one_way_direction_unresolved:'单向仓位，开平未知'};
  for(const row of sample){
    const {id}=row;
    const source=raw.records[id];
    assert.ok(source,'observed record '+id);
    assert.equal(row.updatedAt,new Date(source.orderUpdateTime).toISOString());
    assert.equal(row.symbol,source.symbol);
    assert.equal(row.direction,directions[source.direction]);
    assert.equal(row.quantity,source.executedQty+' '+source.baseAsset);
    assert.equal(row.price,source.avgPrice+' '+source.quoteAsset);
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
  assert.ok(await page.locator('#agent-cards').isHidden(),'old conclusions hidden after evidence changes');
  await page.locator('#agent-run').click();
  assert.equal(await page.locator('#agent-cards article').count(),5);
  assert.match(await page.locator('#agent-ai-state').innerText(),/未调用 AI|规则模式/);
  assert.match(await page.locator('#agent-output-state').innerText(),/等待|不足|待核|未评估/);
  await page.reload({waitUntil:'domcontentloaded'});
  assert.equal(await page.locator('#agent-symbol').inputValue(),stock.code);
  await page.locator('#agent-reset').click();
  assert.equal(await page.locator('#agent-mode').inputValue(),'rules');
  assert.equal(await page.locator('#agent-horizon').inputValue(),'mid');
  return {symbol:stock.code,roles:5,mode:'rules',incompleteEvidence:await page.locator('#agent-output-state').innerText()};
}

async function publicWatchlist(page) {
  await open(page,'us-live.html');
  const input=page.locator('#public-watch-symbol');
  const row=page.locator('#public-watchlist li').filter({has:page.getByText('NVDA',{exact:true})});
  await input.fill('NVDA');
  await input.press('Enter');
  await row.waitFor();
  await page.reload({waitUntil:'domcontentloaded'});
  await row.waitFor();
  await row.getByRole('button',{name:/移除/}).click();
  await row.waitFor({state:'detached'});
  await page.reload({waitUntil:'domcontentloaded'});
  assert.equal(await row.count(),0);
  return {symbol:'NVDA',persistedAcrossReload:true,removed:true,brokerAccountUsed:false};
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

async function usQuotesPage(page) {
  await open(page,'us.html');
  await page.locator('.research-jumps a[href="#public-market-title"]').click();
  await page.locator('#public-market-title').waitFor();
  const feed=page.locator('.public-feed[aria-label="美股行情"] .feed-widget-area');
  await feed.evaluate(el=>el.scrollIntoView({block:'center'}));
  const frame=feed.frameLocator('iframe');
  const symbols=['NASDAQ:AAPL','NASDAQ:MSFT'];
  const quotes=[];
  for(const symbol of symbols) {
    const row=frame.locator('.js-quote-ticker[data-symbol="'+symbol+'"]');
    await row.locator('.js-symbol-last').filter({hasText:/\d/}).waitFor({timeout:35000});
    await row.locator('.js-symbol-change-pt').filter({hasText:/[%％]/}).waitFor({timeout:20000});
    const price=numeric(await row.locator('.js-symbol-last').innerText());
    const pct=numeric(await row.locator('.js-symbol-change-pt').innerText());
    assert.ok(price>0 && Number.isFinite(pct),'actual '+symbol+' price and daily change');
    quotes.push({symbol,price,pct});
  }
  const source=new URL(await feed.locator('iframe').getAttribute('src'),base);
  assert.ok(/(^|\.)tradingview(-widget)?\.com$/.test(source.hostname));
  const reference=await page.request.post('https://scanner.tradingview.com/america/scan',{data:{symbols:{tickers:symbols},columns:['close','change']},timeout:15000});
  assert.ok(reference.ok(),'independent overview reference HTTP '+reference.status());
  const input=(await reference.json()).data;
  for(const quote of quotes) {
    const ticks=input.find(entry=>entry.s===quote.symbol)?.d;
    assert.ok(ticks?.every(Number.isFinite) && ticks[0]>0 && Math.abs(ticks[0]-quote.price)<=Math.max(0.10,ticks[0]*0.0015) && Math.abs(ticks[1]-quote.pct)<=0.15,
      'delayed quote and current reference differ outside the observation tolerance: '+JSON.stringify({quote,reference:ticks}));
    quote.reference=ticks;
  }
  await feed.screenshot({path:path.join(out,'real-us-quote-page.png')});
  return {scope:'US research page public observed stocks',source:source.origin,comparison:reference.url(),quotes};
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
  const docs=page.locator('[data-issuer-research][data-state=archive] [data-disclosure-rows] li');
  await docs.nth(2).waitFor();
  const archived=await docs.evaluateAll(nodes=>nodes.map(node=>({symbol:node.querySelector('span').innerText,
    date:node.querySelector('time').dateTime,href:node.querySelector('a').href,kind:node.querySelector('small').innerText})));
  for(const [symbol,date,domain,title] of [['600519','2026-10-31','static.cninfo.com.cn','季度报告'],['AAPL','2026-11-02','www.apple.com','季度业绩'],['NVDA','2026-10-28','nvidianews.nvidia.com','预告']]){
    const actual=archived.find(row=>row.symbol.includes(symbol));
    assert.ok(actual && actual.date===date && actual.kind.includes(title),symbol+' dated issuer disclosure');
    assert.equal(new URL(actual.href).hostname,domain);
  }
  const sourceLinks=await page.locator('.issuer-list a[href]').evaluateAll(links=>links.map(link=>({label:link.innerText,url:link.href})));
  assert.equal(sourceLinks.length,3);
  assert.deepEqual(sourceLinks.map(s=>new URL(s.url).hostname).sort(),['investor.apple.com','investor.nvidia.com','www.sse.com.cn']);
  assert.equal(new URL(sourceLinks.find(s=>new URL(s.url).hostname==='www.sse.com.cn').url).searchParams.get('productId'),'600519');
  const filter=page.locator('#integration-filter');
  if(!await filter.isVisible()) await page.locator('details').filter({has:filter}).locator('summary').first().click();
  await filter.selectOption('private');
  await page.locator('[data-integrations-grid]').getByText('TigerOpen',{exact:true}).waitFor();
  return {scope:'published close and issuer disclosures available offline',asOf:snapshot.asOf,sourceLinks,archived};
}

async function fullA(page) {
  const upstream=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/src/lib/data/market-heatmap-fallback.json'),{timeout:35000}).catch(()=>null);
  await open(page,'a-shares.html');
  const board=page.locator('#a-market[data-close-source=upstream]');
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
  assert.equal(Date.parse(await page.locator('#a-close-stamp time').getAttribute('datetime')),Date.parse(data.updatedAt));
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
    const visible=document.querySelector('#a-close-matches').innerText.replace(/\s/g,'');
    return visible.includes(code) && visible.includes(name.replace(/\s/g,''));
  },stock);
  await board.screenshot({path:path.join(out,'real-a-search.png')});
  return {source:response.url(),asOf:data.updatedAt,validQuotes:stocks.length,search:stock.code};
}

async function actualChart(page) {
  const sessions=new Map();
  page.on('websocket',socket=>{
    const hostname=new URL(socket.url()).hostname;
    if(!/(^|\.)tradingview\.com$/.test(hostname))return;
    socket.on('framereceived',({payload})=>{
      for(const piece of String(payload).split(/~m~\d+~m~/)){
        if(!piece.startsWith('{'))continue;
        let msg;
        try {msg=JSON.parse(piece);} catch {continue;}
        if(!Array.isArray(msg.p)||typeof msg.p[0]!=='string'||!msg.p[0].startsWith('cs_'))continue;
        const state=sessions.get(msg.p[0])||{source:hostname};
        sessions.set(msg.p[0],state);
        if(msg.m==='symbol_resolved'){
          const stock=msg.p[2];
          if(stock?.name)state.symbol=stock.name;
        }
        if(!['timescale_update','du'].includes(msg.m) || !msg.p[1])continue;
        for(const series of Object.values(msg.p[1])){
          const bars=(series?.s||[]).map(row=>row.v).filter(v=>Array.isArray(v) && v.length>=5 &&
            v.slice(0,5).every(Number.isFinite) && v[0]>1000000000 && v[0]<Date.now()/1000+86400 &&
            v[3]>0 && v[2]>=Math.max(v[1],v[4]) && v[3]<=Math.min(v[1],v[4]));
          if(bars.length>=(state.bars?.length || 3))state.bars=bars;
        }
      }
    });
  });
  await open(page,'chart.html');
  await page.locator('#chart-picker [data-chart-symbol="NASDAQ:AAPL"]').click();
  assert.equal(new URL(page.url()).searchParams.get('tvwidgetsymbol'),'NASDAQ:AAPL');
  const host=page.locator('#chart-widget');
  await host.scrollIntoViewIfNeeded();
  const frame=host.frameLocator('iframe');
  const pane=frame.locator('canvas:visible').first();
  await pane.waitFor({timeout:35000});
  const until=Date.now()+22000;
  let actual;
  while(Date.now()<until) {
    actual=[...sessions.values()].find(s=>s.symbol==='AAPL' && s.bars?.length>=3);
    if(actual)break;
    await page.waitForTimeout(250);
  }
  const src=new URL(await host.locator('iframe').getAttribute('src'),base);
  assert.ok(/(^|\.)tradingview(-widget)?\.com$/.test(src.hostname));
  const usable=await frame.locator('canvas:visible').evaluateAll(nodes=>nodes.some(canvas=>{
    const box=canvas.getBoundingClientRect();return box.width>=130 && box.height>=90;
  }));
  assert.ok(usable,'chart canvas has a usable plotted area');
  let proof;
  if(actual) {
    const bars=actual.bars.slice(-3);
    assert.ok(bars[0][0]<bars[1][0] && bars[1][0]<bars[2][0],'sequence of distinct source dates');
    proof={type:'actual TradingView websocket OHLC and rendered canvas',exchange:'NASDAQ',symbol:actual.symbol,source:actual.source,
      candles:bars.map(v=>({time:new Date(v[0]*1000).toISOString(),open:v[1],high:v[2],low:v[3],close:v[4]}))};
  } else {
    // WebKit may omit iframe WebSocket events. Independently verify a visible legend price.
    const reference=await page.request.post('https://scanner.tradingview.com/america/scan',{data:{symbols:{tickers:['NASDAQ:AAPL']},columns:['close']},timeout:15000});
    assert.ok(reference.ok(),'chart reference price HTTP '+reference.status());
    const row=(await reference.json()).data.find(entry=>entry.s==='NASDAQ:AAPL');
    assert.ok(Number.isFinite(row?.d[0]) && row.d[0]>0,'independent AAPL price');
    const legend=frame.locator('[data-name*="legend"]:visible');
    const texts=await legend.allInnerTexts();
    const values=texts.flatMap(text=>[...text.matchAll(/\b\d[\d,]*\.\d{1,4}\b/g)].map(match=>numeric(match[0])));
    assert.ok(texts.some(text=>/Apple|苹果|AAPL/i.test(text)) && values.some(value=>Math.abs(value-row.d[0])<=0.10),'chart symbol and price correspond to independent quote');
    proof={type:'rendered legend, chart canvas and independent TradingView quote',symbol:row.s,price:row.d[0],source:reference.url()};
  }
  await host.screenshot({path:path.join(out,'real-chart-aapl.png')});
  return proof;
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
      ['research pages and source filter',researchFiles],['five-agent rules without AI',fiveAgents],['public watchlist add restore remove',publicWatchlist],['Bitget unavailable and retry',cryptoFailure]
    ])await check(offline,name,fn);
    await offline.close();
    const online=await browser.newContext({...profile,locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block',reducedMotion:'reduce'});
    for(const [name,fn] of [['live A-share closing source',fullA],['live US ranking data',liveUS],['US page real watch quotes',usQuotesPage],['live Bitget quote values',liveCrypto],['real chart from symbol picker',actualChart]])await check(online,name,fn);
    await online.close();
  } finally {
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));
    await browser.close();
  }
  assert.ok(!failures.length,failures.join('\n'));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
