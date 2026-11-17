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
  if(u.protocol==='https:'&&(u.hostname==='tradingview.com'||u.hostname.endsWith('.tradingview.com')||u.hostname==='widgets.tradingview-widget.com'||u.hostname==='www.tradingview-widget.com'))return route.continue();
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
  await page.getByRole('button',{name:'USA (US Exchanges)',exact:true}).click();
  const options=await page.getByRole('option').allTextContents();
  console.log('EXCHANGE_OPTIONS',JSON.stringify(options));
  const shanghai=page.getByText(/Shanghai/).last();
  if(!await shanghai.count())throw Error('Shanghai option absent; do not assume market support');
  await shanghai.click();await page.getByRole('button',{name:'Apply',exact:true}).click();
  const widget=page.locator('tv-market-summary').last();
  await widget.waitFor();await page.waitForTimeout(8000);
  console.log('SHANGHAI_CONFIGURATION',JSON.stringify(await widget.evaluate(e=>({
    attributes:[...e.attributes].map(a=>[a.name,a.value]),
    controls:[...e.shadowRoot.querySelectorAll('button,[role=button],[role=tab]')].map(e=>e.textContent?.trim()),
    symbolLinkCount:[...e.shadowRoot.querySelectorAll('a')].filter(a=>/SSE[-:%]/.test(a.href)).length,
    dates:[...e.shadowRoot.querySelectorAll('time')].map(e=>e.dateTime)
  }))));

 }finally{await browser.close();}
 if(denied)throw Error('Provider refused; stop, no automatic retry');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
