'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function dossier(page, {local=false, screenshot}={}) {
  const status = page.locator('#quote-status');
  await status.filter({hasText:/\d+ 个交易日/}).waitFor({timeout:35000});
  const source = new URL(await page.locator('#quote-source').getAttribute('href'));
  assert.equal(source.searchParams.get('param'),'sh600519,day,,,60,');
  const response = await page.request.get(source.href);
  assert.ok(response.ok());
  const raw = (await response.json()).data.sh600519.day;
  const rows = page.locator('#bars tr');
  const count = await rows.count();
  assert.equal(count,Math.min(60,raw.length));
  const latest = raw.at(-1);
  assert.equal(await rows.first().locator('td').first().textContent(),latest[0]);
  assert.equal(Number((await page.locator('#last-price').innerText()).replaceAll(',','')),Number(latest[2]));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.getByRole('button',{name:'生成研究报告'}).click();
  const report = page.locator('#report');
  assert.match(await report.innerText(),/未取得同花顺年报/);
  assert.ok((await report.innerText()).includes(source.href));
  if (screenshot) await page.screenshot({path:screenshot,fullPage:true});
  const refusal = await page.evaluate(async()=>{
    const res=await fetch('https://fuyao.aicubes.cn/api/a-share/valuations/snapshot?thscodes=600519.SH',{credentials:'omit',redirect:'error'});
    return (await res.json()).code;
  });
  assert.ok(Number.isInteger(refusal) && refusal!==0);
  if (!local) return {symbol:'600519.SH',bars:count,asOf:latest[0],lastClose:latest[2],anonymousFinancialApiCode:refusal};

  // Fixed contract inputs exercise private account responses. No key is sent to a provider.
  const val={thscode:'600519.SH',name:'贵州茅台',pe_ttm:21.35,pe_mrq:null,pb_mrq:0,ps_ttm:4,pcf_ttm:-2};
  const annual={thscode:val.thscode,period:'annual',currency:'CNY',period_end_ms:Date.UTC(2024,11,30,16),operating_income:101,parent_holder_net_profit:40,basic_eps:1.2};
  let failFinancials=false;
  await page.route('https://fuyao.aicubes.cn/api/a-share/**',async route=>{
    assert.equal(route.request().headers()['x-api-key'],'acceptance-only');
    const income = route.request().url().includes('income-statements');
    await route.fulfill({json:income && failFinancials?{code:5002}:{code:0,data:{timestamp:annual.period_end_ms,item:[income?annual:val]}}});
  });
  async function privateQuery() {
    await page.locator('#api-key').fill('acceptance-only');
    const button=page.getByRole('button',{name:'查询财务和估值'});
    await button.click();
    await page.waitForFunction(()=>!document.querySelector('#finance-form button').disabled && !document.querySelector('#api-key').value);
  }
  await privateQuery();
  assert.match(await page.locator('#financials').innerText(),/101 元/);
  const values=await page.locator('#valuations dd').allTextContents();
  assert.deepEqual(values,['21.35 倍','未提供','0 倍','4 倍','-2 倍']);
  const evidence = [];
  for (const [year,mean] of [[2026,2],[2028,4.5]]) {
    for (const [field,value] of [['eps_consensus_mean',mean],['eps_consensus_min',mean-1],['eps_consensus_max',mean+1],['eps_analyst_count',3]])
      evidence.push({id:'ev-'+String(evidence.length+1).padStart(12,'0'),symbol:'600519',market:'SH',period:'FY'+year,field,value,unit:field==='eps_analyst_count'?'家':'元/股',currency:field==='eps_analyst_count'?'n/a':'CNY',source:'ths',endpoint:'worth.html'});
  }
  const input={script:'fetch_estimates',symbol:'600519',market:'SH',status:'ok',primary_source:'ths',fetched_at:'2026-11-13T10:00:00+08:00',extra:{current_fy:'FY2026'},evidence};
  const file=page.locator('#vibe-file');
  await file.setInputFiles({name:'fetch_estimates.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(input))});
  await page.locator('#vibe-status').filter({hasText:'已导入'}).waitFor({state:'attached'});
  await page.getByRole('button',{name:'生成研究报告'}).click();
  const result=await report.innerText();
  assert.match(result,/50%/);assert.match(result,/ev-000000000001/);assert.match(result,/归母净利润 40 元/);
  assert.ok(!result.includes('acceptance-only'));
  const download=page.waitForEvent('download');
  await page.locator('#download').click();
  const downloaded=await download;
  assert.ok(downloaded.suggestedFilename().endsWith('.md'));
  assert.equal(fs.readFileSync(await downloaded.path(),'utf8'),result);
  input.symbol='000858';
  await file.setInputFiles({name:'fetch_estimates.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(input))});
  await page.locator('#vibe-status').filter({hasText:'未应用'}).waitFor({state:'attached'});
  failFinancials=true;
  await privateQuery();
  assert.match(await page.locator('#finance-status').innerText(),/5002/);
  assert.equal(await page.locator('#financials').innerText(),'');
  assert.match(await page.locator('#valuations').innerText(),/21.35/);
  return {realQuote:latest[0],bars:count,anonymousFinancialApiCode:refusal,privateFinancialCases:'success, missing, negative, partial failure (fixtures)',vibe:'import, mismatch and Markdown round trip'};
}
module.exports = dossier;
