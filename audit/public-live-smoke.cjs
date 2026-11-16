'use strict';
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {chromium, webkit, devices} = require('playwright');
const selection = require('./selection-browser.cjs');
const layout = require('./home-layout-browser.cjs');

const root = path.resolve(__dirname, '..');
const engine = process.env.UI_BROWSER;
const revision = process.env.EXPECTED_SHA;
assert.ok(['chromium','webkit'].includes(engine) && /^[a-f0-9]{40}$/.test(revision), 'browser and deployment revision required');
const site = 'https://sking-3.github.io/xuanliu-site/';
const output = path.join(__dirname,'browser-output/live-pages',engine);
fs.mkdirSync(output,{recursive:true});
const report = {site,revision,engine,checkedAt:new Date().toISOString(),pages:[]};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function openPublished(page,route,record) {
  record.expectedHash = sha256(fs.readFileSync(path.join(root,route)));
  for (const [attempt,pause] of [0,3000,8000,15000,25000].entries()) {
    if (pause) await delay(pause);
    const url = new URL(route === 'index.html' ? './' : route,site);
    url.searchParams.set('_v',revision);
    url.searchParams.set('_attempt',String(attempt+1));
    try {
      const response = await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:20000});
      assert.equal(response?.status(),200,'public HTML status');
      assert.equal(new URL(response.url()).origin,new URL(site).origin,'public origin');
      record.receivedHash = sha256(await response.body());
      assert.equal(record.receivedHash,record.expectedHash,'deployed HTML differs from the deployment commit');
      record.attempts=attempt+1;
      return;
    } catch (error) {
      if (attempt===4) throw error;
    }
  }
}

async function home(page) {
  const cards=page.locator('.market-card-grid > .feed-card');
  await cards.first().waitFor();
  const markets=await cards.evaluateAll(nodes => nodes.map(node => {
    const box=node.getBoundingClientRect();
    return {name:node.querySelector('h2,h3').textContent.trim(),width:box.width,height:box.height};
  }));
  assert.equal(markets.length,3);
  for (const key of ['width','height']) {
    const sizes=markets.map(card=>card[key]);
    assert.ok(Math.min(...sizes)>0 && Math.max(...sizes)-Math.min(...sizes)<=2,'unequal market card '+key);
  }
  const tape=await layout.tape(page,page.frameLocator('#index-ticker iframe'),{motion:true});
  const ranking=await layout.ranking(page);
  await page.locator('#index-ticker').screenshot({path:path.join(output,'visible-market-tape.png')});
  await page.locator('.home-grid').screenshot({path:path.join(output,'aligned-ranking.png')});
  return {markets,tape,ranking};
}

async function aShares(page) {
  const list=page.locator('[data-closing-ranks][data-state="ready"]');
  await list.waitFor();
  const asOf=await list.locator('time').getAttribute('datetime');
  assert.ok(Number.isFinite(Date.parse(asOf)));
  const rows=await list.locator('ol li').evaluateAll(items=>items.map(item=>({
    symbol:item.querySelector('span').textContent.trim(),name:item.querySelector('strong').textContent.trim()
  })));
  assert.ok(rows.length>=3 && rows.every(r=>/^\d{6}$/.test(r.symbol) && r.name.length>0));
  return {asOf,rows};
}

async function disclosures(page) {
  const docs=await page.locator('[data-disclosure-rows] li').evaluateAll(items=>items.map(item=>({
    day:item.querySelector('time').dateTime,company:item.querySelector('span').textContent,title:item.querySelector('a').textContent,url:item.querySelector('a').href
  })));
  assert.ok(docs.length>=3 && docs.every(d=>/^\d{4}-\d\d-\d\d$/.test(d.day) && !!d.title));
  for(const [issuer,host] of [['600519','static.cninfo.com.cn'],['AAPL','www.apple.com'],['NVDA','nvidianews.nvidia.com']]) {
    assert.ok(docs.some(d=>d.company.includes(issuer) && new URL(d.url).hostname===host),issuer+' original filing');
  }
  return docs;
}

async function tools(page) {
  const close=page.locator('#tools-close'),news=page.locator('#tools-release');
  await close.filter({hasText:/[0-9][,，]?\d{3}\s*只/}).waitFor();
  await news.filter({hasText:/20\d\d/}).waitFor();
  const url=await page.locator('#tools-release-source').getAttribute('href');
  assert.equal(new URL(url).hostname,'www.stats.gov.cn');
  return {close:await close.innerText(),officialRelease:await news.innerText(),url};
}

async function crypto(page) {
  const result=[];
  const status=page.locator('[data-crypto-status]').filter({hasText:/Bitget.*\d{1,2}:\d\d/});
  await status.waitFor({timeout:35000});
  for (const symbol of ['BTC','ETH']) {
    const row=page.locator('.crypto-quote-row').filter({has:page.getByText(symbol+'-USDT',{exact:true})});
    await row.locator('.crypto-quote-source time[datetime]').waitFor({timeout:35000});
    const price=Number((await row.locator('.crypto-quote-value strong').innerText()).replace(/,/g,''));
    const source=await status.innerText();
    const asOf=await row.locator('.crypto-quote-source time').getAttribute('datetime');
    assert.ok(Math.abs(Date.now()-Date.parse(asOf))<300000,'stale '+symbol+' source time');
    assert.ok(Number.isFinite(price) && price>0,'missing '+symbol+' price');
    result.push({symbol,price,source,asOf});
  }
  return result;
}

async function main() {
  const browser=await ({chromium,webkit})[engine].launch();
  try {
    const context=await browser.newContext(engine==='webkit' ? devices['iPhone 13'] : {viewport:{width:1440,height:900}});
    for (const [route,check] of [['index.html',home],['screening/index.html',aShares],['research.html',disclosures],['tools.html',tools],['crypto.html',crypto],['company-dossier.html',require('./company-dossier-browser.cjs')]]) {
      const page=await context.newPage();
      page.setDefaultTimeout(15000);
      const record={route};
      report.pages.push(record);
      const captures=route==='screening/index.html' ? selection.observe(page) : null;
      try {
        await openPublished(page,route,record);
        record.evidence=await check(page);
        if(captures) record.selection=await selection.check(page,captures,{screenshot:path.join(output,'real-stock-selection.png')});
        record.status='pass';
      } catch (error) {
        record.status='failed';record.reason=error.message;
        process.exitCode=1;
      } finally {
        const screenshot=route.replace(/[/\.]/g,'-')+'.png';
        await page.screenshot({path:path.join(output,screenshot),timeout:8000}).then(()=>{record.screenshot=screenshot;}).catch(error=>{record.screenshotError=error.message;process.exitCode=1;});
        fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
        console.log(record.status,route,record.reason || JSON.stringify(record.evidence));
        await page.close();
      }
    }
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
