'use strict';
// Bounded real-widget UI verification. Owned pages/assets are exact checkout bytes.
// No provider replies are mocked, no raw quote API is called by this test.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),base='https://sking-3.github.io/xuanliu-site/';
const output=path.join(__dirname,'browser-output/exact-widget');
const allowedScriptPaths=new Set(['/external-embedding/embed-widget-hotlists.js','/external-embedding/embed-widget-advanced-chart.js']);
const provider=u=>u.hostname==='tradingview.com'||u.hostname.endsWith('.tradingview.com')||
 ['www.tradingview-widget.com','widgets.tradingview-widget.com','widget-sheriff.tradingview-widget.com'].includes(u.hostname);
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const report={synthetic:false,previewNotDeployment:true,ownedFiles:['index.html','chart.html','home-tv-movers.js','chart.js'].map(file=>({file,sha256:digest(file)})),
 quoteDateVerified:false,quoteDate:null,checks:[],policyViolations:[],denials:[],blockedUnrelated:[],providerOrigins:[]};
let denied=false;
async function main(){
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch();
 const origins=new Set(),blocked=new Set();
 try{
  for(const width of [1440,390]){
   const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
   await context.addInitScript(()=>{
    window.__policyViolations=[];
    document.addEventListener('securitypolicyviolation',e=>window.__policyViolations.push({
     documentURI:e.documentURI,blockedURI:e.blockedURI,violatedDirective:e.violatedDirective,disposition:e.disposition}));
   });
   await context.routeWebSocket('**/*',ws=>{
    const u=new URL(ws.url());if(!denied&&provider(u)){origins.add(u.origin);ws.connectToServer();}
    else{blocked.add(u.origin);ws.close();}
   });
   await context.route('**/*',route=>{
    const req=route.request(),u=new URL(req.url());
    if(denied)return route.abort();
    if(u.origin==='https://sking-3.github.io'&&u.pathname.startsWith('/xuanliu-site/')){
     const rel=decodeURIComponent(u.pathname.slice('/xuanliu-site/'.length))||'index.html';
     if(rel.split('/').some(s=>s.startsWith('.')||['private-follow','copy-config'].includes(s)))return route.abort();
     let file=path.resolve(root,rel);
     if(!file.startsWith(root+path.sep))return route.abort();
     try{
      if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');
      return route.fulfill({contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
     }catch{return route.fulfill({status:404,body:'Not found'});}
    }
    // Other existing dashboard widgets and independent sources are outside this check.
    // Keep final HTML/CSP intact; suppress only their network at the test boundary.
    if(u.hostname==='s3.tradingview.com'&&u.pathname.startsWith('/external-embedding/')&&!allowedScriptPaths.has(u.pathname)){
     blocked.add(u.origin+u.pathname);return route.abort();
    }
    if(u.protocol==='https:'&&provider(u)){origins.add(u.origin);return route.continue();}
    blocked.add(u.origin);return route.abort();
   });
   context.on('response',response=>{
    const u=new URL(response.url());
    if(provider(u)&&[401,403,429].includes(response.status())){
     denied=true;report.denials.push({status:response.status(),origin:u.origin});
     void context.close();
    }
   });
   let page=await context.newPage();page.setDefaultTimeout(25000);
   for(const [index,label] of ['活跃','涨幅榜','跌幅榜'].entries()){
    if(index===0||new URL(page.url()).pathname.endsWith('chart.html')){
     await page.goto(base+'index.html',{waitUntil:'domcontentloaded'});
    }
    const expectedCsp=fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),expectedCsp);
    await page.locator('#home-tv-movers').scrollIntoViewIfNeeded();
    await page.locator('#tv-hotlists-host iframe').waitFor();
    const frame=await (await page.locator('#tv-hotlists-host iframe').elementHandle()).contentFrame();
    assert.ok(frame,'real native hot-list iframe');
    await frame.waitForURL(u=>u.href.includes('embed-widget/hotlists'),{timeout:25000});
    const tab=frame.getByRole('tab',{name:new RegExp('^'+label)}).first();
    await tab.click();await tab.evaluate(n=>n.getAttribute('aria-selected')==='true');
    await page.waitForTimeout(2500);
    const details=await frame.evaluate(()=>{
     const links=[...document.querySelectorAll('a')].filter(n=>n.href.startsWith('https://sking-3.github.io/xuanliu-site/chart.html?')&&n.getClientRects().length>0);
     const dates=[...document.querySelectorAll('time')].map(n=>({datetime:n.getAttribute('datetime'),text:n.textContent.trim()}));
     const dateText=[...new Set(document.body.innerText.match(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s20\d{2}\b/g)||[])];
     return {links:links.map(n=>n.href),dates,dateText,width:innerWidth,scroll:document.documentElement.scrollWidth,
      selected:[...document.querySelectorAll('[role=tab][aria-selected=true]')].map(n=>n.textContent.trim()),
      unavailable:/No data|无数据|暂无数据|Invalid symbol|Invalid Symbol/.test(document.body.innerText)};
    });
    console.log('EXACT_LIST',JSON.stringify({width,label,...details}));
    assert.ok(details.links.length>0,'actual chart links on '+label);
    assert.ok(details.selected.some(t=>t.startsWith(label)),'correct selected tab');
    assert.equal(details.unavailable,false,'source list has visible rows');
    assert.ok(details.scroll<=details.width+1,'widget horizontal overflow');
    const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(geometry.scroll<=geometry.width+1,'page horizontal overflow');
    assert.equal(await page.locator('[data-home-movers-source]').isVisible(),true);
    const violations=await page.evaluate(()=>window.__policyViolations||[]);
    report.policyViolations.push(...violations);
    assert.equal(violations.filter(v=>/embed-widget-hotlists|www\.tradingview-widget\.com/.test(v.blockedURI)).length,0,'native widget blocked by actual homepage CSP');
    await page.locator('#home-tv-movers').screenshot({path:path.join(output,'real-'+width+'-'+index+'-list.png')});
    const href=details.links[0],symbol=new URL(href).searchParams.get('tvwidgetsymbol');
    assert.match(symbol,/^SSE:\d{6}$/);
    const opened=[];
    const listener=p=>opened.push(p);context.on('page',listener);
    const linkIndex=await frame.locator('a[href]').evaluateAll((nodes,target)=>nodes.findIndex(n=>n.href===target),href);
    assert.ok(linkIndex>=0,'actual link still present');
    await frame.locator('a[href]').nth(linkIndex).click();
    // The provider may use a new tab. Follow its actual click outcome, never page.goto(href).
    const start=Date.now();
    while(Date.now()-start<25000&&!denied){
     const dest=[page,...opened].find(p=>!p.isClosed()&&p.url().startsWith(base+'chart.html?'));
     if(dest){page=dest;break;}
     await new Promise(resolve=>setTimeout(resolve,200));
    }
    context.off('page',listener);
    assert.equal(new URL(page.url()).pathname,'/xuanliu-site/chart.html','real link reaches owned chart');
    await page.waitForFunction(s=>document.querySelector('#chart-symbol')?.textContent===s,symbol);
    assert.match(await page.locator('#chart-data-note').innerText(),/日终数据，非盘中实时/);
    const chartCsp=fs.readFileSync(path.join(root,'chart.html'),'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),chartCsp);
    await page.locator('#chart-widget iframe').waitFor();
    await page.waitForTimeout(8000);
    const chart=page.frames().find(f=>f.parentFrame()===page.mainFrame()&&f.url().includes('tradingview-widget.com')&& !f.url().includes('hotlists'));
    assert.ok(chart,'actual provider chart iframe');
    const chartEvidence=await chart.evaluate(()=>{
     const text=document.body.innerText;
     return {canvasCount:document.querySelectorAll('canvas').length,
      unavailable:/Invalid symbol|Invalid Symbol|无效商品|无效代码|该商品不可用|This symbol is only available/.test(text),
      dateElements:[...document.querySelectorAll('time')].map(n=>({datetime:n.getAttribute('datetime'),text:n.textContent.trim()})),
      dateTokens:[...new Set(text.match(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s20\d{2}\b/g)||[])],
      statusLabels:[...document.querySelectorAll('[aria-label],[title]')].map(n=>n.getAttribute('aria-label')||n.getAttribute('title')).filter(t=>/日终|延迟|闭市|Market closed|delayed|end.of.day/i.test(t)).slice(0,10)};
    });
    console.log('EXACT_CHART',JSON.stringify({width,label,symbol,...chartEvidence}));
    assert.ok(chartEvidence.canvasCount>0,'provider chart renderer visible');
    assert.equal(chartEvidence.unavailable,false,'provider has no unsupported-symbol message');
    await page.screenshot({path:path.join(output,'real-'+width+'-'+index+'-chart.png'),fullPage:true});
    const chartGeometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(chartGeometry.scroll<=chartGeometry.width+1,'chart page horizontal overflow');
    const chartViolations=await page.evaluate(()=>window.__policyViolations||[]);
    report.policyViolations.push(...chartViolations);
    assert.equal(chartViolations.filter(v=>/embed-widget-advanced-chart|www\.tradingview-widget\.com/.test(v.blockedURI)).length,0,'chart blocked by actual chart CSP');
    const result={width,tab:label,symbol,linkCount:details.links.length,actualClick:true,homepageCspExact:true,chartCspExact:true,
     listDates:details.dates,listDateTokens:details.dateText,chart:chartEvidence,quoteDateVerified:false};
    report.checks.push(result);console.log('EXACT_WIDGET_CHECK',JSON.stringify(result));
   }
   await context.close();
  }
 }finally{
  report.providerOrigins=[...origins];report.blockedUnrelated=[...blocked];
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('EXACT_WIDGET_SUMMARY',JSON.stringify(report));
  await browser.close();
 }
 if(denied)throw Error('Provider refusal; stop this source and do not retry');
 assert.equal(report.checks.length,6);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
