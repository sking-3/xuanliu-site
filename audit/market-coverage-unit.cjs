'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const config=html=>JSON.parse(html.match(/<script type="application\/json" data-feed-config>(.*?)<\/script>/s)[1]);
test('A-share quotes retain the explicit thirty-stock watch sample and separate indices; screening no longer duplicates it',()=>{const html=read('a-shares.html'),c=config(html);assert.equal(c.tabs[0].symbols.length,30);assert.equal(c.tabs[1].symbols.length,3);const all=c.tabs.flatMap(t=>t.symbols.map(s=>s.s));assert.equal(new Set(all).size,33);assert.ok(c.tabs[0].symbols.every(s=>/^(SSE:6\d{5}|SZSE:00\d{4})$/.test(s.s)));assert.ok(c.tabs[1].symbols.every(s=>s.d.includes('指数')));assert.match(html,/日终/);assert.match(html,/日终行情|不是盘中实时行情/);assert.match(html,/观察样本/);assert.equal(c.largeChartUrl,'chart.html');const desk=read('screening/index.html');assert.match(desk,/id="stock-desk"/);assert.match(desk,/id="index-ticker"/);assert.doesNotMatch(desk,/data-feed-config|a-market-widget|data-local-feed="a"/);});
test('A-share quote recovery shortcuts still belong to its actual watch sample, outside the stock desk',()=>{const html=read('a-shares.html'),c=config(html),allowed=new Set(c.tabs.flatMap(t=>t.symbols.map(s=>s.s))),block=html.match(/<details class="symbol-shortcuts".*?<\/details>/s)[0];const links=[...block.matchAll(/href="chart\.html\?tvwidgetsymbol=([^\"]+)"/g)].map(m=>decodeURIComponent(m[1]));assert.equal(links.length,9);assert.equal(new Set(links).size,9);assert.ok(links.every(s=>allowed.has(s)));assert.equal(links.filter(s=>c.tabs[0].symbols.some(x=>x.s===s)).length,6);assert.equal(links.filter(s=>c.tabs[1].symbols.some(x=>x.s===s)).length,3);assert.match(block,/主板股票图表快捷入口/);assert.match(block,/指数图表快捷入口/);assert.match(block,/非全量/);assert.doesNotMatch(block,/300750|宁德时代/);assert.doesNotMatch(read('screening/index.html'),/class="symbol-shortcuts"|id="a14-preselection"/);});
test('crypto full page uses the native Bitget read-only feed',()=>{const html=read('crypto.html');assert.match(html,/data-local-feed="crypto"/);assert.match(html,/data-crypto-feed/);assert.match(html,/crypto-market\.js\?v=[0-9a-f]+/);assert.match(html,/crypto-market\.css\?v=[0-9a-f]+/);assert.match(html,/Bitget/);assert.match(html,/20 个现货交易对/);assert.match(html,/价格单位 USDT · 24 小时涨跌/);assert.match(html,/<input id="crypto-query" type="search"/);assert.doesNotMatch(html,/apiKey|apiSecret|Bearer /);});
test('A-share page footer keeps its own source context',()=>{
 const html=read('a-shares.html');
 assert.match(html,/观察名单报价来自 TradingView/);
 assert.match(html,/data-close-direction="gainers"/);
 assert.match(html,/data-close-direction="losers"/);
 assert.match(html,/<input id="a-close-query" type="search"/);
 assert.match(html,/research-data|a-close-market\.js/);
 assert.ok(html.indexOf('id="a-market"') < html.indexOf('id="a14-preselection"'));
 assert.doesNotMatch(html,/<iframe[^>]*a-market-widget/);
 assert.doesNotMatch(html,/AiCoin|加密行情 ·/);
});

test('crypto native feed keeps a no-key chart fallback and source disclosure',()=>{const html=read('crypto.html'),block=html.match(/<details class="symbol-shortcuts".*?<\/details>/s)[0];assert.match(html,/data-crypto-feed/);assert.match(block,/chart\.html\?tvwidgetsymbol=/);assert.equal([...block.matchAll(/tvwidgetsymbol=BITGET%3A[A-Z]+USDT/g)].length,20);assert.match(html,/https:\/\/www\.bitget\.com\/markets\/spot/);assert.doesNotMatch(html,/\.tradingview\.com\/markets\/cryptocurrencies/);});

test('home crypto uses reachable two-tab coverage instead of the clipped single custom tab',()=>{const html=read('index.html'),all=[...html.matchAll(/<script type="application\/json" data-feed-config>(.*?)<\/script>/gs)].map(m=>JSON.parse(m[1])),c=all.find(x=>x.tabs?.[0]?.symbols?.[0]?.s==='BITGET:BTCUSDT');assert.deepEqual(c.tabs.map(t=>t.symbols.length),[10,10]);assert.equal(new Set(c.tabs.flatMap(t=>t.symbols.map(x=>x.s))).size,20);assert.equal(c.showChart,false);assert.equal(c.height,310);});

test('all compact home quote cards use visible group navigation',()=>{const all=[...read('index.html').matchAll(/<script type="application\/json" data-feed-config>(.*?)<\/script>/gs)].map(m=>JSON.parse(m[1]));assert.equal(all.length,3);assert.ok(all.every(c=>c.tabs.length===2));const us=all.find(c=>c.tabs[0].symbols[0].s==='NASDAQ:AAPL');assert.equal(us.tabs.flatMap(t=>t.symbols).length,15);assert.deepEqual(us.tabs.map(t=>t.symbols.length),[8,7]);});
