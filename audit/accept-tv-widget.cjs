'use strict';
// One bounded acceptance page view of TradingView's official SSE widget.
// No quote exports, own scanner queries, server scanning or legacy collectors.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const csp="default-src 'none'; script-src 'self' https://s3.tradingview.com/external-embedding/embed-widget-hotlists.js; style-src 'self' 'unsafe-inline' https://www.tradingview-widget.com https://widgets.tradingview-widget.com; connect-src https://*.tradingview.com wss://*.tradingview.com https://www.tradingview-widget.com https://widgets.tradingview-widget.com; img-src data: https://*.tradingview.com https://*.tradingview-widget.com; font-src https://*.tradingview.com https://*.tradingview-widget.com; frame-src https://www.tradingview-widget.com; base-uri 'none'; object-src 'none'";
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><link rel="stylesheet" href="style.css"><title>TradingView 沪市组件验收</title></head><body><main><h1>沪市异动榜 · 日终行情</h1><div class="widget-wrap"><div id="tv-hotlists-host" class="tradingview-widget-container"></div><p><a href="https://www.tradingview.com/markets/stocks-china/" target="_blank" rel="noopener">Stock Market</a> by TradingView</p></div><p id="tv-movers-status" role="status">以组件标注为准。</p></main><script src="widget.js"></script></body></html>';
(async()=>{
 const server=http.createServer((req,res)=>{
  const files={'/style.css':'tv-market-movers-preview.css','/widget.js':'tv-market-movers-preview.js'};
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}
  else if(files[req.url]){res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(__dirname,files[req.url])));}
  else{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='https://sking-3.github.io/xuanliu-site';
 const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1100,height:640},serviceWorkers:'block'});
 let denied=false;const blocked=new Set(),errors=[],requests=new Set();
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(denied)return route.abort();
  // Fulfil only this owned site's candidate page/assets; no deployment is claimed.
  if(u.href===base+'/')return route.fulfill({contentType:'text/html',body:html});
  if(u.href===base+'/style.css')return route.fulfill({contentType:'text/css',body:fs.readFileSync(path.join(__dirname,'tv-market-movers-preview.css'),'utf8')});
  if(u.href===base+'/widget.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'tv-market-movers-preview.js'),'utf8')});
  if(u.protocol==='https:'&&(u.hostname==='tradingview.com'||u.hostname.endsWith('.tradingview.com')||['www.tradingview-widget.com','widgets.tradingview-widget.com','widget-sheriff.tradingview-widget.com'].includes(u.hostname))){
   requests.add(u.origin);return route.continue();
  }
  blocked.add(u.origin);return route.abort();
 });
 context.on('response',response=>{
  if([401,403,429].includes(response.status())){denied=true;console.error('SOURCE_STOP',response.status(),new URL(response.url()).origin);void context.close();}
 });
 try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text().slice(0,300));});
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>['embedded','unavailable'].includes(document.body.dataset.widgetState));
  await page.waitForTimeout(12000);
  const frame=page.frames().find(f=>f.url().includes('embed-widget/hotlists'));
  assert.ok(frame,'official iframe created');
  const before=await frame.evaluate(()=>({
   title:document.title,controls:[...document.querySelectorAll('button,[role=button],[role=tab]')].map(n=>({tag:n.tagName,role:n.getAttribute('role'),label:n.getAttribute('aria-label'),text:n.textContent?.trim(),class:n.className,selected:n.getAttribute('aria-selected')})),
   sseLinks:[...document.querySelectorAll('a')].filter(n=>/SSE[-:%]/.test(n.href)).length,
   errors:[...document.querySelectorAll('[role=alert],.tv-widget-error,.tv-widget-error__message')].map(n=>n.textContent?.trim().slice(0,300))
  }));
  console.log('BEFORE_TAB',JSON.stringify({...before,blocked:[...blocked],errors:errors.slice(0,5)}));
  const active=frame.locator('button,[role=button],[role=tab]').filter({hasText:'活跃'}).first();
  await active.click();
  const activeTab=true;
  await page.waitForTimeout(5000);
  const report=await frame.evaluate(()=>{
   const all=[...document.querySelectorAll('*')];
   return {controls:all.filter(n=>n.tagName==='BUTTON'||['button','tab'].includes(n.getAttribute('role'))).map(n=>n.textContent?.trim()).filter(Boolean),
    linkCount:all.filter(n=>n.tagName==='A'&&/SSE[-:%]/.test(n.href)).length,
    inSiteChartLinks:all.filter(n=>n.tagName==='A'&&n.href.startsWith('https://sking-3.github.io/xuanliu-site/chart.html?')&&/SSE[-:%]/.test(n.href)).length,
    symbolCount:all.filter(n=>/^SSE:/.test(n.getAttribute('symbol')||n.getAttribute('data-symbol')||'')).length,
    dateLabels:all.filter(n=>n.tagName==='TIME').map(n=>n.dateTime),
    unavailable:/No data|无数据|暂无数据/.test(document.body.innerText),width:innerWidth,scroll:document.documentElement.scrollWidth};
  });
  console.log('LEGACY_WIDGET_RESULT',JSON.stringify({...report,activeTab,blocked:[...blocked],origins:[...requests],errors:errors.slice(0,8)}));
  const out=path.join(__dirname,'browser-output/widget');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'legacy-sse-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:760});
  await page.screenshot({path:path.join(out,'legacy-sse-mobile.png'),fullPage:true});
  assert.ok(report.linkCount+report.symbolCount>0,'visible SSE symbols required');
  assert.equal(activeTab,true,'active ranking tab required');
  assert.ok(report.inSiteChartLinks>0,'native symbol links must target the owned site');
  assert.equal(report.unavailable,false);
  assert.ok(report.scroll<=report.width+1,'no page overflow');

 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
 if(denied)throw Error('Provider refusal; stop and do not rerun');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
