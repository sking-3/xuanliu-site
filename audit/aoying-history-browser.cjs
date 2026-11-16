'use strict';
const assert=require('node:assert/strict');
const {decode}=require('../scripts/archive_aoying_records.cjs');

module.exports=async function checkAoying(page,base){
  const trader=new URL('trader/',base),id='5075281354358777856';
  async function script(file){
    const res=await page.request.get(new URL(file,trader).href);
    assert.equal(res.status(),200,file);
    return res.text();
  }
  const saved=decode(await script('replay-seed.js'));
  const history=JSON.parse((await script('aoying-history.js')).split('globalThis.BooksAoyingHistory=')[1].trim().replace(/;$/,''));
  const ids=Object.keys(saved.records);
  assert.ok(ids.length>=64);
  let refreshes=0;
  // A successful rolling response omits older records, just as the seven-day checkpoint does.
  const rolling={...saved,records:Object.fromEntries(ids.slice(-2).map(k=>[k,saved.records[k]]))};
  await page.route('https://raw.githubusercontent.com/sking-3/xuanliu-site/binance-public-orders-state/monitor-state/'+id+'.json*',async route=>{
    refreshes++;
    await route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(rolling)});
  });
  const directory=new URL(trader.href);directory.search=new URLSearchParams({exchange:'Binance',period:'30D'});
  await page.goto(directory.href,{waitUntil:'domcontentloaded'});
  await page.locator('#leaders h3').getByRole('button',{name:/查看 熬鹰资本 的研究详情/}).click();
  const dialog=page.locator('#detail[open]');
  await dialog.waitFor({timeout:30000});
  await dialog.locator('[data-tab="orders"]').click();
  await dialog.locator('.ta-table tbody tr').first().waitFor();
  assert.equal(await dialog.locator('#detail-title').innerText(),'熬鹰资本');
  assert.equal(await dialog.locator('.ta-table > tbody > tr').count(),ids.length);
  await dialog.locator('[data-tab="positions"]').click();
  await dialog.locator('.ta-expand').first().waitFor();
  assert.equal(await dialog.locator('tr').filter({hasText:/币安官方 · \d+ 条已见操作/}).count(),history.rows.length);
  await dialog.locator('[data-tab="analysis"]').click();
  for(const [period,part] of Object.entries(history.performanceByPeriod)){
    await dialog.getByRole('button',{name:period,exact:true}).click();
    const roi=await dialog.locator('.ta-metric strong').first().innerText();
    assert.ok(Math.abs(Number(roi.replace(/[%％,，]/g,''))-part.roi)<=0.00501,period+' ROI');
    const curve=await dialog.locator('.ta-profit-wrap svg[role="img"]').getAttribute('aria-label');
    assert.ok(curve.includes(history.curveByPeriod[period].points.length+' 个实际采样点'),period+' curve');
  }
  await page.goto(new URL('exchange.html',trader).href,{waitUntil:'domcontentloaded'});
  await page.locator('#evidence-rows tr[data-id]').first().waitFor();
  const more=page.locator('#evidence-more');
  assert.ok(await more.isVisible());
  while(await more.isVisible())await more.click();
  const evidence=await page.locator('#evidence-rows tr[data-id]').evaluateAll(rows=>rows.map(r=>r.dataset.id));
  assert.deepEqual(new Set(evidence),new Set(ids));
  assert.ok(refreshes>=1,'rolling checkpoint requested');
  return {account:id,archived:ids.length,officialPositions:history.rows.length,performancePeriods:Object.keys(history.performanceByPeriod)};
};
