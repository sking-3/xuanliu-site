'use strict';
// Official Web Component capability check; no quote rows or response bodies exported.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const out=path.join(__dirname,'browser-output/dual-widget');
const owned='https://sking-3.github.io/xuanliu-site/chart.html';
const provider=u=>u.hostname==='tradingview.com'||u.hostname.endsWith('.tradingview.com')||
 ['www.tradingview-widget.com','widgets.tradingview-widget.com','widget-sheriff.tradingview-widget.com'].includes(u.hostname);
const report={at:new Date().toISOString(),officialDocsPreview:true,notHomepageAcceptance:true,
 quoteDataExported:false,rankingFormulaVerified:false,quoteDateVerified:false,checks:[],documentation:[],refusals:[],socketErrors:[]};
let stopped=false;
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch();
 try{
  for(const type of ['market-overview','market-summary']){
   if(stopped)break;
   const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'});
   context.on('page',page=>page.on('websocket',socket=>{
    if(provider(new URL(socket.url())))socket.on('socketerror',()=>{
     stopped=true;report.socketErrors.push({type,origin:new URL(socket.url()).origin});void context.close();
    });
   }));
   await context.routeWebSocket('**/*',ws=>{if(!stopped&&provider(new URL(ws.url())))ws.connectToServer();else ws.close();});
   await context.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(u.href.startsWith(owned)){
     // Verify the actual click target only; do not load or certify a chart here.
     return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Owned navigation target</title>'});
    }
    return !stopped&&u.protocol==='https:'&&provider(u)?route.continue():route.abort();
   });
   context.on('response',r=>{if(provider(new URL(r.url()))&&[401,403,429].includes(r.status())){
    stopped=true;report.refusals.push({type,status:r.status(),origin:new URL(r.url()).origin});void context.close();
   }});
   let page=await context.newPage();page.setDefaultTimeout(15000);
   try{
    await page.goto('https://www.tradingview.com/widget-docs/widgets/watchlists/'+type+'/',{waitUntil:'domcontentloaded',timeout:30000});
    await page.locator('tv-'+type).first().waitFor();
    // Collect only public configuration attributes and module URLs, never generic button text.
    report.documentation.push(await page.evaluate(type=>{
     const allowed=new Set(['exchange','mode','assets-type','symbol-url','time-frame','layout-mode','direction']);
     const sample=document.querySelector('tv-'+type);
     return {type,config:[...sample.attributes].filter(a=>allowed.has(a.name)).map(a=>({name:a.name,value:a.value})),
      moduleUrls:[...document.scripts].map(s=>s.src).filter(s=>/tradingview-widget\.com.*market|s3\.tradingview\.com.*market/.test(s)),
      labels:[...document.querySelectorAll('label')].map(n=>n.textContent.trim()).filter(s=>/^(Exchange|Stock exchange|Market|Mode|Assets type|Asset type)$/i.test(s)),
      publicConstructorRequiresSignIn:!![...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Join to copy code')};
    },type));
    for(const exchange of ['SSE','SZSE']){
     for(const width of [1440,390]){
      if(stopped)throw Error('Source stopped');
      await page.setViewportSize({width,height:960});
      // A new native element per scenario prevents reusing previous exchange rows.
      await page.evaluate(({type,exchange,owned,width})=>{
       document.querySelector('#capability-preview')?.remove();
       const holder=document.createElement('section');holder.id='capability-preview';
       holder.style.cssText='position:relative;box-sizing:border-box;width:'+Math.min(width-32,900)+'px;max-width:100%;margin:16px;background:white;z-index:100';
       const el=document.createElement('tv-'+type);el.id='capability-component';
       for(const [k,v] of Object.entries({'exchange':exchange,'mode':'market-movers','assets-type':'stocks',
        'time-frame':'1D','symbol-url':owned+'?tvwidgetsymbol={tvprosymbol}'}))el.setAttribute(k,v);
       holder.append(el);document.body.prepend(holder);
      },{type,exchange,owned,width});
      const component=page.locator('#capability-component');
      await component.scrollIntoViewIfNeeded();
      await page.waitForTimeout(7000);
      const result={type,exchange,width,quoteDateVerified:false,rankingFormulaVerified:false,
       chartDataReadyVerified:false,notHomepageAcceptance:true};
      try{
       const evidence=await component.evaluate((el,{exchange,owned})=>{
        const roots=[el];if(el.shadowRoot)roots.push(el.shadowRoot);
        for(let i=0;i<roots.length;i++)for(const n of roots[i].querySelectorAll('*'))if(n.shadowRoot&&!roots.includes(n.shadowRoot))roots.push(n.shadowRoot);
        const nodes=selector=>roots.flatMap(r=>[...r.querySelectorAll(selector)]);
        const visible=n=>n.getClientRects().length>0;
        const links=nodes('a[href]').filter(visible);
        const stockLinks=links.filter(n=>n.href.startsWith(owned+'?')||/\/symbols\//.test(n.href));
        const configuredLinks=links.filter(n=>n.href.startsWith(owned+'?'));
        const texts=roots.map(r=>r.textContent||'').join(' ');
        return {visibleStockLinks:stockLinks.length,ownedLinks:configuredLinks.length,
         mappedExchangeMatches:configuredLinks.length>0&&configuredLinks.every(n=>new URL(n.href).searchParams.get('tvwidgetsymbol')?.startsWith(exchange+':')),
         tabs: nodes('[role=tab]').filter(visible).map(n=>n.textContent.trim()).filter(s=>/^(Active|Gainers|Losers|Most active|Top gainers|Top losers|活跃|涨幅榜|跌幅榜)$/i.test(s)),
         unavailable:/No data|No results|Exchange is not supported|Unsupported exchange|无数据|暂无数据/i.test(texts),
         dates:[...new Set(texts.match(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g)||[])],
         brandLinkPresent:links.some(n=>/tradingview\.com/.test(n.href)&&!n.href.includes('/symbols/')),
         componentOverflow:el.scrollWidth>el.clientWidth+1};
       },{exchange,owned});
       Object.assign(result,evidence);
       result.nativeListObserved=evidence.visibleStockLinks>0&&!evidence.unavailable;
       if(evidence.ownedLinks&&evidence.mappedExchangeMatches){
        const opened=[];const listener=p=>opened.push(p);context.on('page',listener);
        await component.locator('a[href^="'+owned+'?"]:visible').first().click();
        const start=Date.now();
        while(Date.now()-start<10000&&!stopped){
         const dest=[page,...opened].find(p=>!p.isClosed()&&p.url().startsWith(owned+'?'));
         if(dest){
          result.actualClickToOwnedTarget=true;
          result.clickedExchangeMatches=new URL(dest.url()).searchParams.get('tvwidgetsymbol')?.startsWith(exchange+':')===true;
          if(dest!==page)await dest.close();
          else {await page.goBack({waitUntil:'domcontentloaded'});await page.locator('tv-'+type).first().waitFor();}
          break;
         }
         await new Promise(resolve=>setTimeout(resolve,200));
        }
        context.off('page',listener);
       }
      }catch(error){result.error=String(error.message).split('\n')[0];}
      report.checks.push(result);
      if(page.url().startsWith(owned))break;
     }
    }
   }catch(error){report.checks.push({type,error:String(error.message).split('\n')[0]});}
   await context.close();
  }
 }finally{
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('MODERN_WIDGET_REPORT',JSON.stringify(report));await browser.close();
 }
 if(stopped)throw Error('Observed provider refusal/socket error; stopped without retry');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
