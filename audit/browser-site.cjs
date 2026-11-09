// Prepared candidate browser regression. Run only in an authorized browser-capable environment.
// Provider requests are intentionally blocked to test truthful failure states; no prices are invented.
const {chromium}=require('playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
 const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/,''), file=path.resolve(root,rel||'index.html');
 if(!file.startsWith(root+path.sep)||rel.split('/').includes('.git'))return res.writeHead(403).end();
 try{const target=fs.statSync(file).isDirectory()?path.join(file,'index.html'):file;res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html'})[path.extname(target)]||'text/plain');res.end(fs.readFileSync(target))}catch{res.writeHead(404).end()}
});
const pages=['index.html','a-shares.html','us.html','crypto.html','research.html','tools.html','screening/index.html','screening/history.html','trader/index.html','trader/exchange.html','chart.html'];
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});
 const base=`http://127.0.0.1:${server.address().port}/`,output=path.join(__dirname,'browser-output');fs.mkdirSync(output,{recursive:true});
 let passed=0;
 try{
  for(const width of [1440,768,390,320]){
   const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
   await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   for(const route of pages){
    await page.goto(base+route);await page.locator('.books-menu-toggle').waitFor({state:'attached'});
    assert.equal(await page.locator('h1').count(),1,`${route}: page heading`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${route} overflows at ${width}`);
    if(width<=760){
     const nav=page.locator('.books-nav'),toggle=page.locator('.books-menu-toggle');
     assert.equal(await nav.isVisible(),false);await toggle.click();assert.equal(await nav.isVisible(),true);
     await nav.locator('a').first().focus();await page.keyboard.press('Escape');assert.equal(await nav.isVisible(),false);
     assert.equal(await toggle.evaluate(e=>e===document.activeElement),true);
    }
    if(['index.html','a-shares.html','us.html','crypto.html'].includes(route)){
     await page.locator('.feed-status').first().filter({hasText:'加载失败'}).waitFor();
     assert.equal(await page.locator('.feed-widget-area').first().isVisible(),false);
     await page.locator('.feed-retry').first().click();await page.locator('.feed-status').first().filter({hasText:'加载失败'}).waitFor();
     await page.locator('.symbol-shortcuts summary').first().click();assert.ok(await page.locator('.symbol-shortcuts a').first().isVisible());
    }
    if(route==='chart.html'){assert.equal(await page.locator('#chart-picker').getAttribute('open'),'');assert.equal(await page.locator('#chart-widget').isVisible(),false)}
    if(route==='trader/index.html'){await page.locator('#status').filter({hasText:'未接通'}).waitFor();assert.equal(await page.locator('.card').count(),0)}
    await page.screenshot({path:path.join(output,`${width}-${route.replaceAll('/','_')}.png`),fullPage:true});passed++;
   }
   assert.deepEqual(errors,[],`unexpected page errors at ${width}`);await context.close();
  }
  const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}),page=await context.newPage();
  await page.goto(base);assert.equal(await page.locator('.books-nav').isVisible(),true);assert.ok(await page.locator('.books-nav a').count()>=7);await context.close();passed++;
  console.log(`PASS ${passed} candidate viewport/page scenarios. Third-party data availability was not tested.`);
 }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
