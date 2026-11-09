// Synthetic fixtures exist only in this test process, never in deployed feeds.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const now = '2026-01-15T12:00:00Z';
const row = (i=0) => ({id:`synthetic-${String(i).padStart(2,'0')}`,name:`SYNTHETIC TEST ${i}`,exchange:'Binance',currency:'USDT',featured:i===0,paid:i%2===0,observedAt:now,sourceUrl:'https://example.com/synthetic-test',windows:{'30D':{asOf:now,roi:i,pnl:i,mdd:20-i,wins:i,closedTrades:20,curve:[{time:'2026-01-14T12:00:00Z',value:0},{time:now,value:i}]},ALL:{asOf:now,roi:i,pnl:i,mdd:20,wins:i,closedTrades:20,curve:[]}},positions:[],points:[],orders:[]});
const ready=()=>({schemaVersion:1,status:'ready',traders:Array.from({length:15},(_,i)=>row(i))});
let feed=ready(), calls=0, delay=0, mode='json';
const server=http.createServer((req,res)=>{let f=path.join(root,new URL(req.url,'http://localhost').pathname);try{if(fs.statSync(f).isDirectory())f=path.join(f,'index.html');res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f))}catch{res.writeHead(404).end()}});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/trader/feed.json',async route=>{calls++;await new Promise(r=>setTimeout(r,delay));if(mode==='network')return route.abort();await route.fulfill({contentType:'application/json',body:mode==='bad-json'?'{':JSON.stringify(feed)});});
let passed=0;async function test(name,f){await f();passed++;console.log(`PASS ${name}`)}
const base=`http://127.0.0.1:${server.address().port}/trader/index.html`;
const settled=()=>page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
const refresh=async()=>{await page.locator('#refresh').click();await settled()};
try{
await page.goto(base+'?page=2&q=SYNTHETIC');await settled();
await test('URL initial query/page survives asynchronous load',async()=>{assert.equal(await page.locator('#page').textContent(),'2 / 2');assert.equal(await page.locator('#search').inputValue(),'SYNTHETIC')});
await test('pagination and Back/Forward restore state',async()=>{await page.locator('#prev').click();assert.equal(new URL(page.url()).searchParams.get('page'),null);await page.goBack();assert.equal(await page.locator('#page').textContent(),'2 / 2');await page.goForward();assert.equal(await page.locator('#page').textContent(),'1 / 2')});
await test('search persists and reset restores via Back',async()=>{await page.locator('#search').fill('TEST 14');assert.equal(new URL(page.url()).searchParams.get('q'),'TEST 14');assert.equal(await page.locator('#leaders .card').count(),1);await page.locator('#reset').click();await page.goBack();assert.equal(await page.locator('#search').inputValue(),'TEST 14');await page.locator('#reset').click()});
await test('ranking, missing values and correct per-trade win rate',async()=>{assert.match(await page.locator('#leaders .card').first().textContent(),/TEST 14/);assert.match(await page.locator('#leaders .card').first().textContent(),/70.00%/);await page.locator('#sort').selectOption('mdd');assert.match(await page.locator('#leaders .card').first().textContent(),/TEST 14/);feed.traders[14].windows['30D'].mdd=null;await refresh();assert.match(await page.locator('#leaders .card').first().textContent(),/TEST 13/)});
await test('native dialog Escape restores focus; keyboard view navigation',async()=>{const b=page.locator('#leaders .detail-button').first();await b.click();assert.equal(await page.locator('#close').evaluate(e=>e===document.activeElement),true);await page.locator('[data-tab="analysis"]').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('[data-tab="positions"]').getAttribute('aria-pressed'),'true');assert.match(await page.locator('#detail-body').textContent(),/没有可用记录/);await page.keyboard.press('End');assert.equal(await page.locator('[data-tab="orders"]').getAttribute('aria-pressed'),'true');await page.keyboard.press('Escape');assert.equal(await page.locator('#detail').evaluate(e=>e.open),false);assert.equal(await b.evaluate(e=>e===document.activeElement),true)});
await test('repeated refresh deduplicates requests and exposes busy state',async()=>{delay=150;const n=calls;await page.locator('#refresh').click();await page.evaluate(()=>{for(let i=0;i<5;i++)document.querySelector('#refresh').onclick()});assert.equal(await page.locator('#leaders').getAttribute('aria-busy'),'true');await settled();assert.equal(calls,n+1);delay=0});
for(const [name,mutate] of [
['impossible calendar date',r=>r.observedAt='2026-02-30T12:00:00Z'],
['window newer than collection',r=>r.windows['30D'].asOf='2026-01-16T12:00:00Z'],
['trade newer than collection',r=>r.orders=[{time:'2026-01-16T12:00:00Z',symbol:'TEST',side:'buy',price:1,quantity:1,pnl:0}]],
['wins exceed closed trades',r=>r.windows['30D'].wins=100],
['negative drawdown',r=>r.windows['30D'].mdd=-1],
['null point',r=>r.windows['30D'].curve=[null]],
['nonchronological curve',r=>r.windows['30D'].curve.reverse()],
['insecure source URL',r=>r.sourceUrl='javascript:alert(1)'],
['blank identity',r=>r.name='   ']
])await test(`reject ${name} and clear old data`,async()=>{feed=ready();mutate(feed.traders[0]);await refresh();assert.equal(await page.locator('#leaders .card').count(),0);assert.match(await page.locator('#status').textContent(),/校验/)});
await test('duplicate IDs rejected',async()=>{feed=ready();feed.traders[1].id=feed.traders[0].id;await refresh();assert.match(await page.locator('#status').textContent(),/校验/)});
await test('network and malformed JSON failures recover without stale rows',async()=>{for(const m of ['network','bad-json']){mode=m;await refresh();assert.match(await page.locator('#status').textContent(),/读取失败/)}mode='json';feed=ready();await refresh();assert.equal(await page.locator('#leaders .card').count(),12)});
await test('no trades is unknown, not fabricated zero win rate',async()=>{feed={schemaVersion:1,status:'ready',traders:[row()]};feed.traders[0].windows['30D'].closedTrades=0;await refresh();assert.match(await page.locator('#leaders .metrics').textContent(),/逐笔胜率—/)});
await test('empty ready and unavailable remain distinct/truthful',async()=>{feed={schemaVersion:1,status:'ready',traders:[]};await refresh();assert.match(await page.locator('#notice-title').textContent(),/当前无记录/);feed=JSON.parse(fs.readFileSync(path.join(root,'trader/feed.json')));await refresh();assert.match(await page.locator('#notice-title').textContent(),/尚未接入/);assert.equal(await page.locator('.card').count(),0)});
assert.deepEqual(errors,[]);console.log(`${passed} tests passed; no browser page errors. Production feed unchanged and unavailable.`);
}finally{await browser.close();server.close()}})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
