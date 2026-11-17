'use strict';
// Bounded official-widget capability check. No quote/API payloads are read or saved.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),base='https://sking-3.github.io/xuanliu-site/';
const out=path.join(__dirname,'browser-output/dual-widget');
const provider=u=>u.hostname==='tradingview.com'||u.hostname.endsWith('.tradingview.com')||
 ['www.tradingview-widget.com','widgets.tradingview-widget.com','widget-sheriff.tradingview-widget.com'].includes(u.hostname);
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const original=fs.readFileSync(path.join(root,'index.html'),'utf8');
const csp=original.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const loader=fs.readFileSync(path.join(root,'home-tv-movers.js'),'utf8');
const report={at:new Date().toISOString(),previewNotDeployment:true,quoteDataExported:false,
 baseHtmlSha256:hash(original),baseLoaderSha256:hash(loader),docs:[],checks:[],refusals:[],errors:[]};
let stopped=false;
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch();
 try{
  // Read only official documentation controls/generated embed code, never quote rows.
  const docs=await browser.newContext({serviceWorkers:'block'});
  await docs.route('**/*',route=>{
   const u=new URL(route.request().url());
   return !stopped&&u.protocol==='https:'&&provider(u)?route.continue():route.abort();
  });
  await docs.routeWebSocket('**/*',ws=>{if(!stopped&&provider(new URL(ws.url())))ws.connectToServer();else ws.close();});
  docs.on('response',r=>{if(provider(new URL(r.url()))&&[401,403,429].includes(r.status())){
   stopped=true;report.refusals.push({stage:'docs',status:r.status(),origin:new URL(r.url()).origin});void docs.close();
  }});
  const dp=await docs.newPage();
  for(const type of ['market-overview','market-summary']){
   if(stopped)break;
   try{
    await dp.goto('https://www.tradingview.com/widget-docs/widgets/watchlists/'+type+'/',{waitUntil:'domcontentloaded',timeout:30000});
    await dp.waitForTimeout(4000);
    const settings=await dp.evaluate(()=>({
     componentAttributes:[...document.querySelectorAll('tv-market-overview,tv-market-summary')].map(n=>({tag:n.tagName,attributes:[...n.attributes].map(a=>({name:a.name,value:a.value}))})),
     selects:[...document.querySelectorAll('select')].map(s=>({name:s.name,options:[...s.options].map(o=>({value:o.value,label:o.label}))})),
     code:[...document.querySelectorAll('pre,textarea')].map(n=>n.value||n.textContent).filter(s=>/tv-market|tradingview|market-mover|marketMover|hotlists|symbol-url/.test(s)).map(s=>s.slice(0,16000)).slice(0,8),
     controls:[...document.querySelectorAll('button,[role=combobox]')].filter(n=>n.getClientRects().length).map(n=>({role:n.getAttribute('role'),text:n.textContent.trim().slice(0,100)})).slice(0,80)
    }));
    report.docs.push({type,settings});
   }catch(error){report.errors.push({stage:'docs',type,message:String(error.message).split('\n')[0]});}
  }
  await docs.close();
  if(stopped)throw Error('Provider refusal: stopped without retry');
  for(const exchange of ['SSE','SZSE']){
   for(const width of [1440,390]){
    if(stopped)throw Error('Provider refusal: stopped without retry');
    const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
    await context.addInitScript(()=>{
     window.__policyViolations=[];
     document.addEventListener('securitypolicyviolation',e=>window.__policyViolations.push({blockedURI:e.blockedURI,violatedDirective:e.violatedDirective}));
    });
    await context.routeWebSocket('**/*',ws=>{
     if(!stopped&&provider(new URL(ws.url())))ws.connectToServer();else ws.close();
    });
    await context.route('**/*',route=>{
     if(stopped)return route.abort();
     const u=new URL(route.request().url());
     if(u.origin==='https://sking-3.github.io'&&u.pathname.startsWith('/xuanliu-site/')){
      const rel=decodeURIComponent(u.pathname.slice('/xuanliu-site/'.length))||'index.html';
      if(rel.split('/').some(x=>x.startsWith('.')||['private-follow','copy-config'].includes(x)))return route.abort();
      const file=path.resolve(root,rel);if(!file.startsWith(root+path.sep))return route.abort();
      try{
       let body=fs.readFileSync(file);
       if(rel==='home-tv-movers.js')body=Buffer.from(loader.replace("exchange:'SSE'","exchange:'"+exchange+"'"));
       if(rel==='index.html'){
        body=Buffer.from(original.replace('沪市异动榜',exchange==='SSE'?'沪市组件能力测试':'深市组件能力测试')
         .replace('上交所股票的活跃、涨幅与跌幅榜，由 TradingView 自动提供。不含深市，活跃榜不代表搜索或关注热度。','隔离能力测试；不表示已上线，不构成五日成交额榜。'));
       }
       return route.fulfill({contentType:types[path.extname(file)]||'application/octet-stream',body});
      }catch{return route.fulfill({status:404,body:'Not found'});}
     }
     if(u.hostname==='s3.tradingview.com'&&u.pathname.startsWith('/external-embedding/')&&
       !['/external-embedding/embed-widget-hotlists.js','/external-embedding/embed-widget-advanced-chart.js'].includes(u.pathname))return route.abort();
     return u.protocol==='https:'&&provider(u)?route.continue():route.abort();
    });
    context.on('response',r=>{if(provider(new URL(r.url()))&&[401,403,429].includes(r.status())){
     stopped=true;report.refusals.push({stage:'embed',exchange,width,status:r.status(),origin:new URL(r.url()).origin});void context.close();
    }});
    let page=await context.newPage();page.setDefaultTimeout(18000);
    for(const label of ['活跃','涨幅榜','跌幅榜']){
     const result={exchange,width,tab:label,previewNotDeployment:true,quoteDateVerified:false};
     try{
      await page.goto(base+'index.html',{waitUntil:'domcontentloaded'});
      assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),csp);
      result.homepageCspExact=true;
      await page.locator('#home-tv-movers').scrollIntoViewIfNeeded();
      await page.locator('#tv-hotlists-host iframe').waitFor();
      const frame=await (await page.locator('#tv-hotlists-host iframe').elementHandle()).contentFrame();
      await frame.getByRole('tab',{name:new RegExp('^'+label)}).first().click();
      await page.waitForTimeout(2500);
      const evidence=await frame.evaluate(({base,exchange})=>{
       const visible=n=>n.getClientRects().length>0;
       const links=[...document.querySelectorAll('a')].filter(n=>visible(n)&&n.href.startsWith(base+'chart.html?'));
       const text=document.body.innerText;
       return {visibleStockLinks:links.length,
        symbolsMatchExchange:links.length>0&&links.every(n=>new URL(n.href).searchParams.get('tvwidgetsymbol')?.startsWith(exchange+':')),
        unavailable:/No data|无数据|暂无数据|Invalid symbol|Invalid Symbol/.test(text),
        selected:[...document.querySelectorAll('[role=tab][aria-selected=true]')].filter(visible).map(n=>n.textContent.trim()),
        dates:[...new Set(text.match(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g)||[])],
        horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1};
      },{base,exchange});
      Object.assign(result,evidence);
      result.attributionVisible=await page.locator('[data-home-movers-source]').isVisible();
      result.pageOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
      result.policyViolations=await page.evaluate(()=>window.__policyViolations||[]);
      if(!evidence.visibleStockLinks||!evidence.symbolsMatchExchange||evidence.unavailable){
       result.supported=false;report.checks.push(result);break;
      }
      // Click one rendered stock on each exchange/viewport. Do not save its quote/code.
      if(label==='活跃'){
       const link=frame.locator('a[href^="'+base+'chart.html?"]:visible').first();
       const opened=[];const listener=p=>opened.push(p);context.on('page',listener);
       await link.click();
       const start=Date.now();
       while(Date.now()-start<20000&&!stopped){
        const dest=[page,...opened].find(p=>!p.isClosed()&&p.url().startsWith(base+'chart.html?'));
        if(dest){page=dest;break;}
        await new Promise(resolve=>setTimeout(resolve,200));
       }
       context.off('page',listener);
       result.actualClickToOwnedChart=new URL(page.url()).pathname==='/xuanliu-site/chart.html';
       assert.ok(result.actualClickToOwnedChart);
       const symbol=new URL(page.url()).searchParams.get('tvwidgetsymbol');
       assert.match(symbol,new RegExp('^'+exchange+':\\d{6}$'));
       await page.waitForFunction(s=>document.querySelector('#chart-symbol')?.textContent===s,symbol);
       result.chartSymbolMatches=true;
       const chartCsp=fs.readFileSync(path.join(root,'chart.html'),'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
       result.chartCspExact=await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')===chartCsp;
       await page.locator('#chart-widget iframe').waitFor();
       await page.waitForTimeout(6000);
       const chart=page.frames().find(f=>f.parentFrame()===page.mainFrame()&&f.url().includes('tradingview-widget.com'));
       result.chart=await chart.evaluate(()=>({canvasCount:document.querySelectorAll('canvas').length,
        unavailable:/Invalid symbol|Invalid Symbol|无效代码|该商品不可用|This symbol is only available/.test(document.body.innerText),
        dates:[...new Set(document.body.innerText.match(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g)||[])]}));
      }
      assert.equal(result.attributionVisible,true);
      assert.equal(result.pageOverflow,false);
      assert.equal(result.horizontalOverflow,false);
      assert.ok(result.selected.some(t=>t.startsWith(label)));
      if(result.chart){
       assert.equal(result.chartCspExact,true);
       assert.ok(result.chart.canvasCount>0);
       assert.equal(result.chart.unavailable,false);
      }
      result.supported=true;report.checks.push(result);
     }catch(error){
      result.supported=false;result.error=String(error.message).split('\n')[0];report.checks.push(result);break;
     }
    }
    await context.close();
   }
  }
 }finally{
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('DUAL_WIDGET_REPORT',JSON.stringify(report));
  await browser.close();
 }
 if(stopped)throw Error('Provider refusal: no further source calls permitted');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
