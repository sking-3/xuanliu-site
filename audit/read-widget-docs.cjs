'use strict';
// Bounded browser inspection of the public widget constructor.
// No login, copy-code action, quote export, scanner calls of our own or SDK collector.
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch();
 const context=await browser.newContext({serviceWorkers:'block'});
 let denied=false;
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(denied)return route.abort();
  if(u.protocol==='https:'&&(u.hostname==='tradingview.com'||u.hostname.endsWith('.tradingview.com')||u.hostname==='widgets.tradingview-widget.com'))return route.continue();
  return route.abort();
 });
 context.on('response',response=>{
  if([401,403,429].includes(response.status())){
   denied=true;console.error('STOP',response.status(),new URL(response.url()).origin);
   void context.close();
  }
 });
 try{
  const page=await context.newPage();page.setDefaultTimeout(20000);
  await page.goto('https://www.tradingview.com/widget-docs/widgets/watchlists/market-summary/',{waitUntil:'domcontentloaded'});
  await page.locator('h1').waitFor();
  await page.waitForTimeout(8000);
  console.log('CONSTRUCTOR',JSON.stringify(await page.evaluate(()=>{
   const all=[];function visit(root){for(const e of root.querySelectorAll('*')){all.push(e);if(e.shadowRoot)visit(e.shadowRoot);}}visit(document);
   return {
    selects:all.filter(e=>e.tagName==='SELECT').map(e=>({name:e.name,options:[...e.options].map(o=>({value:o.value,text:o.text}))})),
    controls:all.filter(e=>['button','combobox','tab'].includes(e.getAttribute('role'))||e.tagName==='BUTTON').map(e=>({role:e.getAttribute('role'),text:e.textContent?.trim().slice(0,120),'aria-label':e.getAttribute('aria-label')})).slice(-150),
    labels:all.filter(e=>e.tagName==='LABEL').map(e=>e.textContent?.trim()).slice(-70),
    widgets:all.filter(e=>/^TV-(?!.*WIZARD)/.test(e.tagName)).map(e=>({tag:e.tagName,attributes:[...e.attributes].map(a=>[a.name,a.value])}))
   };
  })));

 }finally{await browser.close();}
 if(denied)throw Error('Provider refused; stop, no automatic retry');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
