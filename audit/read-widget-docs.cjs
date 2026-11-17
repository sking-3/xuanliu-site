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
  if(u.protocol==='https:'&&(u.hostname==='tradingview.com'||u.hostname.endsWith('.tradingview.com')))return route.continue();
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
  await page.waitForTimeout(5000);
  console.log('CONSTRUCTOR',JSON.stringify(await page.evaluate(()=>({
   selects:[...document.querySelectorAll('select')].map(e=>({name:e.name,options:[...e.options].map(o=>({value:o.value,text:o.text}))})),
   buttons:[...document.querySelectorAll('button')].map(e=>e.textContent?.trim()).filter(Boolean).slice(-100),
   inputs:[...document.querySelectorAll('input')].map(e=>({type:e.type,placeholder:e.placeholder,value:e.type==='password'?'':e.value})).slice(-30),
   widgets:[...document.querySelectorAll('*')].filter(e=>e.tagName.startsWith('TV-')).map(e=>({tag:e.tagName,attributes:[...e.attributes].map(a=>[a.name,a.value])}))
  }))));
 }finally{await browser.close();}
 if(denied)throw Error('Provider refused; stop, no automatic retry');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
