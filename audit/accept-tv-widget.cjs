'use strict';
// One bounded acceptance page view of TradingView's official SSE widget.
// No quote exports, own scanner queries, server scanning or legacy collectors.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const csp="default-src 'none'; script-src 'self' https://www.tradingview-widget.com https://widgets.tradingview-widget.com; style-src 'self' 'unsafe-inline' https://www.tradingview-widget.com https://widgets.tradingview-widget.com; connect-src https://*.tradingview.com wss://*.tradingview.com https://www.tradingview-widget.com https://widgets.tradingview-widget.com; img-src data: https://*.tradingview.com https://*.tradingview-widget.com; font-src https://*.tradingview.com https://*.tradingview-widget.com; frame-src https://www.tradingview-widget.com; base-uri 'none'; object-src 'none'";
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><link rel="stylesheet" href="style.css"><title>TradingView 沪市组件验收</title></head><body><main><h1>沪市异动榜 · 日终行情</h1><div class="widget-wrap"><tv-market-summary exchange="SSE" mode="market-movers" assets-type="stocks" direction="horizontal" layout-mode="flow" item-size="normal" time-frame="1D"><p>TradingView 组件读取中。</p></tv-market-summary></div><p id="tv-movers-status" role="status">以组件标注为准。</p></main><script src="widget.js"></script></body></html>';
(async()=>{
 const server=http.createServer((req,res)=>{
  const files={'/style.css':'tv-market-movers-preview.css','/widget.js':'tv-market-movers-preview.js'};
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}
  else if(files[req.url]){res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(__dirname,files[req.url])));}
  else{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1100,height:640},serviceWorkers:'block'});
 let denied=false;const blocked=new Set(),errors=[],requests=new Set();
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(denied)return route.abort();
  if(u.origin===base||u.protocol==='https:'&&(u.hostname==='tradingview.com'||u.hostname.endsWith('.tradingview.com')||['www.tradingview-widget.com','widgets.tradingview-widget.com'].includes(u.hostname))){
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
  const report=await page.evaluate(()=>{
   const all=[];function visit(root){if(!root)return;for(const n of root.querySelectorAll('*')){all.push(n);if(n.shadowRoot)visit(n.shadowRoot);}}visit(document);
   const widget=document.querySelector('tv-market-summary');
   return {state:document.body.dataset.widgetState,defined:!!customElements.get('tv-market-summary'),shadow:!!widget.shadowRoot,
    children:widget.children.length,textLength:widget.textContent.length,
    controls:all.filter(n=>n.tagName==='BUTTON'||['button','tab'].includes(n.getAttribute('role'))).map(n=>n.textContent?.trim()).filter(Boolean),
    linkCount:all.filter(n=>n.tagName==='A'&&/SSE[-:%]/.test(n.href)).length,
    symbolCount:all.filter(n=>/^SSE:/.test(n.getAttribute('symbol')||n.getAttribute('data-symbol')||'')).length,
    dateLabels:all.filter(n=>n.tagName==='TIME').map(n=>n.dateTime),width:innerWidth,scroll:document.documentElement.scrollWidth};
  });
  console.log('NATIVE_WIDGET_RESULT',JSON.stringify({...report,blocked:[...blocked],origins:[...requests],errors:errors.slice(0,8)}));
  const out=path.join(__dirname,'browser-output/widget');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'native-sse-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:760});
  await page.screenshot({path:path.join(out,'native-sse-mobile.png'),fullPage:true});
  assert.equal(report.defined,true,'public widget entry point registers');
  assert.equal(report.state,'embedded');
  assert.ok(report.linkCount+report.symbolCount>0,'visible SSE symbols required');
  assert.ok(report.scroll<=report.width+1,'no page overflow');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
 if(denied)throw Error('Provider refusal; stop and do not rerun');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
