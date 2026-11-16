'use strict';

const assert = require('node:assert/strict');

// Capture exactly the batch read by this browser; a second request can cross a daily refresh.
const marketURL = 'https://raw.githubusercontent.com/wenyuanw/a-share-heatmap/main/src/lib/data/market-heatmap-fallback.json';
const ticker = '600519.SH';
function observe(page) {
  const captures = {market:[], bars:[]};
  page.on('response', response => {
    if (!response.ok()) return;
    const url = new URL(response.url());
    if (url.href.split('?')[0] === marketURL) captures.market.push(response);
    if (['web.ifzq.gtimg.cn','proxy.finance.qq.com'].includes(url.hostname)
        && url.pathname.endsWith('/appstock/app/fqkline/get')
        && /^sh600519,day,.*?,qfq$/.test(url.searchParams.get('param') || '')) captures.bars.push(response);
  });
  return captures;
}

function expectedSignals(raw, date) {
  const entry = raw?.data?.sh600519;
  assert.ok(entry && Number(raw.code) === 0, 'Tencent returned no reference bars for 600519.SH');
  const quoted = Object.hasOwn(entry,'qfqday') ? entry.qfqday : entry.day;
  const history = quoted.filter(row => row[0] <= date && Number(row[5]) > 0).sort((a,b) => a[0].localeCompare(b[0])).slice(-60);
  assert.equal(history.length,60);
  assert.equal(history.at(-1)[0],date,'Tencent last eligible date differs from the snapshot date');
  const prices = history.map(row => Number(row[2]));
  assert.ok(prices.every(price => price > 0 && Number.isFinite(price)));
  const means = [];
  for (let end=29; end<60; end++) {
    means.push(prices.slice(end-29,end+1).reduce((sum,price) => sum+price,0)/30);
  }
  const sample = [means.at(-30),means.at(-20),means.at(-10),means.at(-1)];
  return {turtle:prices.at(-1) >= Math.max(...prices),
    increasing:sample[1] > sample[0] && sample[2] > sample[1] && sample[3] > sample[2] && sample[3] > sample[0]*1.20,
    latestClose:prices.at(-1),highestClose:Math.max(...prices),movingAverages:sample};
}

async function check(page,captures,{screenshot}={}) {
  const desk = page.locator('[data-selection][data-state="ready"][data-origin="upstream"]');
  await desk.waitFor({timeout:40000});
  assert.ok(captures.market.length,'selection page did not read the real full-market snapshot');
  const snapshot = await captures.market.at(-1).json();
  const date = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(snapshot.updatedAt));
  assert.equal(await desk.getAttribute('data-day'),date);
  const valid = snapshot.stocks.filter(s => Number.isFinite(s.changePct) && Number.isFinite(s.price) && s.price>0);
  assert.equal(snapshot.stockCount,snapshot.stocks.length);
  assert.ok(valid.length >= 5000);
  const target = valid.find(s => s.code === ticker);
  assert.ok(target, '600519.SH must be present in the source batch');
  const displayed = page.locator('#pick-rows tr[data-code]');
  const counts = async (selected,total=valid.length) => {
    await page.waitForFunction(({selected,total}) => {
      const s = document.querySelector('#pick-count').textContent.replace(/[,，\s]/g,'');
      return s.includes('符合'+selected+'/'+total+'只');
    },{selected,total});
  };
  await counts(valid.length);
  const sectors = new Map();
  for (const s of valid) {
    const name = s.boardName?.trim();
    if (!name || name==='未分类') continue;
    const group = sectors.get(name)||[];
    group.push(s.changePct);sectors.set(name,group);
  }
  const groups = [...sectors].map(([name,pcts])=>({name,count:pcts.length,mean:pcts.reduce((n,v)=>n+v,0)/pcts.length}))
    .sort((a,b) => b.mean-a.mean || a.name.localeCompare(b.name,'zh-CN'));
  const buttons = page.locator('[data-sector-summary] button');
  assert.equal(await buttons.count(),5);
  for(const [index, group] of groups.slice(0,5).entries()) {
    const label=await buttons.nth(index).innerText();
    assert.ok(label.includes(group.name));
    const pct=Number(label.match(/([+-]?\d+(?:\.\d+)?)%/)?.[1]);
    assert.ok(Math.abs(pct-group.mean)<=.00501, 'industry mean mismatch for '+group.name);
  }
  await buttons.first().click();
  await counts(groups[0].count);
  const sector = page.locator('#pick-sector');
  assert.equal(await sector.inputValue(),groups[0].name);
  await sector.selectOption({value:target.boardName});
  await page.locator('#pick-venue').selectOption('SH');
  const bounds = {minChange:Math.floor(target.changePct)-1,maxChange:Math.ceil(target.changePct)+1,
    minCap:Math.max(0,Math.floor(target.totalMarketCap/1e8)-5),maxCap:Math.ceil(target.totalMarketCap/1e8)+5};
  for (const [id,value] of [['pick-min-change',bounds.minChange],['pick-max-change',bounds.maxChange],['pick-cap-min',bounds.minCap],['pick-cap-max',bounds.maxCap]]) {
    await page.locator('#'+id).fill(String(value));
  }
  const matches=valid.filter(s=>s.boardName===target.boardName && s.exchange==='SH' && s.changePct>=bounds.minChange && s.changePct<=bounds.maxChange
    && Number.isFinite(s.totalMarketCap) && s.totalMarketCap/1e8>=bounds.minCap && s.totalMarketCap/1e8<=bounds.maxCap)
    .sort((a,b)=>b.changePct-a.changePct || a.code.localeCompare(b.code));
  await counts(matches.length);
  assert.deepEqual(await displayed.evaluateAll(rows=>rows.map(row=>row.dataset.code)),matches.slice(0,20).map(s=>s.code));
  await page.locator('#pick-reset').click();
  const chain=page.locator('#pick-chain');
  await chain.selectOption('大模型');
  const largeModel=new Set(['688041.SH','688256.SH','300308.SZ','601138.SH','000977.SZ','002230.SZ','601360.SH','300418.SZ','688111.SH','300229.SZ','300624.SZ','300496.SZ','688088.SH','688327.SH','002362.SZ']);
  const members=valid.filter(s=>largeModel.has(s.code));
  await counts(members.length);
  assert.deepEqual((await displayed.evaluateAll(rows=>rows.map(row=>row.dataset.code))).sort(),members.map(s=>s.code).sort());
  await page.locator('#pick-segments').getByRole('button',{name:'上游 · 算力基座'}).click();
  const upstreamCodes=['688041.SH','688256.SH','300308.SZ','601138.SH','000977.SZ'];
  const upstream=members.filter(s=>upstreamCodes.includes(s.code));
  await counts(upstream.length);
  assert.deepEqual((await displayed.evaluateAll(rows=>rows.map(row=>row.dataset.code))).sort(),upstream.map(s=>s.code).sort());
  await page.locator('#pick-segments').getByRole('button',{name:'全部环节'}).click();
  await counts(members.length);
  await page.locator('#pick-reset').click();
  const query=page.locator('#pick-query');
  await query.fill('不存在的证券 600519xxx');
  await counts(0);
  assert.equal(await displayed.count(),0);
  assert.ok(await page.locator('#pick-run').isDisabled());

  await query.fill(target.name);
  await counts(1);
  const row=displayed.first();
  assert.equal(await row.getAttribute('data-code'),ticker);
  assert.equal(new URL(await row.locator('a').first().getAttribute('href'), page.url()).searchParams.get('symbol'),ticker);
  assert.ok((await row.innerText()).includes(target.name));
  const save=row.locator('[data-save]');
  assert.equal(await save.getAttribute('aria-pressed'),'false');
  await save.click();
  assert.equal(await save.getAttribute('aria-pressed'),'true');
  await page.reload({waitUntil:'domcontentloaded'});
  await desk.waitFor({timeout:40000});
  await page.locator('#pick-saved').check();
  await counts(1);
  assert.equal(await displayed.first().getAttribute('data-code'),ticker);
  await page.locator('#pick-run').click();
  const checked=page.locator('#pick-tech-rows tr[data-code="'+ticker+'"]');
  await checked.waitFor({timeout:35000});
  assert.equal(await checked.getAttribute('data-status'),'ready','600519.SH verification: '+await checked.innerText());
  const barResponse=captures.bars.at(-1);
  assert.ok(barResponse, 'no real adjusted Tencent kline response for the verified security');
  const ref=expectedSignals(await barResponse.json(),date);
  assert.equal(await checked.getAttribute('data-turtle'),String(ref.turtle));
  assert.equal(await checked.getAttribute('data-increasing'),String(ref.increasing));
  const responsesBefore=captures.bars.length;
  await counts(1);
  await page.locator('#pick-run-all').click();
  const finished=page.locator('#pick-tech-status').filter({hasText:/全部筛选结果.*核验完成.*1 \/ 1/});
  await finished.waitFor();
  assert.equal(captures.bars.length,responsesBefore,'repeating the same date and security must reuse the checked daily bars');
  assert.equal(await checked.getAttribute('data-turtle'),String(ref.turtle));
  assert.equal(await checked.getAttribute('data-increasing'),String(ref.increasing));
  const status=await finished.innerText();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'selection page overflows its viewport');
  if (screenshot) await desk.screenshot({path:screenshot});
  await displayed.first().locator('[data-save]').click();
  await counts(0);
  return {asOf:snapshot.updatedAt,coverage:valid.length,industries:sectors.size,topSector:groups[0],rangeMatches:matches.length,
    largeModelSample:members.length,persistedWatch:ticker,referenceFeed:barResponse.url(),...ref,status};
}

async function offline(page) {
  await page.locator('[data-selection][data-state=unavailable]').waitFor({timeout:20000});
  assert.equal(await page.locator('#pick-rows tr[data-code]').count(),0);
  assert.ok(await page.locator('#pick-run').isDisabled());
  assert.ok(await page.locator('#pick-refresh').isEnabled());
  return {status:await page.locator('#pick-source').innerText()};
}

module.exports={observe,check,offline};
