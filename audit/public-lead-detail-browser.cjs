'use strict';
const assert=require('node:assert/strict');
module.exports=async function checkLeadDetails(page,base){
  const trader=new URL('trader/',base);
  async function json(path){
    const response=await page.request.get(new URL(path,trader).href);
    assert.equal(response.status(),200,path);
    return response.json();
  }
  const [bitget,okx,activity]=await Promise.all(['bitget/period-returns.json','okx/period-returns.json','okx/trades.json'].map(json));
  const activeOKX=activity.accounts.find(row=>row.activity.positions.rows.length&&row.activity.history.rows.length);
  const privateBitget=bitget.accounts.find(row=>row.activity.positions.status==='restricted');
  const activeBitget=bitget.accounts.find(row=>row.activity.positions.rows.length);
  assert.ok(activeOKX&&privateBitget&&activeBitget);
  const cases=[
    ['OKX',activeOKX.uniqueCode,okx.accounts.find(a=>a.uniqueCode===activeOKX.uniqueCode),activeOKX.activity],
    ['Bitget',activeBitget.portfolioId,activeBitget,activeBitget.activity],
    ['Bitget',privateBitget.portfolioId,privateBitget,privateBitget.activity]
  ];
  const report=[];
  for(const [exchange,id,row,sections]of cases){
    const url=new URL(trader.href);url.search=new URLSearchParams({exchange,account:id,period:'365D'});
    await page.goto(url.href,{waitUntil:'domcontentloaded'});
    const dialog=page.locator('#detail[open]'),body=dialog.locator('#detail-body');
    await dialog.waitFor({timeout:30000});
    assert.equal(await dialog.locator('#detail-title').innerText(),row.name);
    const period=row.performance['365D']?'365D':'90D',part=row.performance[period];
    const selected=body.locator('.period-switch [aria-pressed="true"]');
    assert.ok((await selected.innerText()).includes(String(parseInt(period,10))));
    const roi=Number((await body.locator('.roi').innerText()).replace(/[,，%％]/g,''));
    assert.ok(Math.abs(roi-part.roi)<=0.00501);
    if(!row.performance['365D']){
      assert.ok(await body.getByRole('button',{name:/近 365 天.*暂缺/}).isDisabled());
      assert.ok((await body.innerText()).includes('365D 暂无可核实收益'));
    }
    await body.locator('.lead-curve svg').waitFor();
    const curvePoints=exchange==='OKX'?part.pointCount:part.curve.length;
    assert.ok((await body.locator('.lead-curve').innerText()).includes(curvePoints+' 个来源日点'));
    if(exchange==='Bitget')assert.ok((await body.locator('.performance-body').innerText()).includes('USD'));
    const history=dialog.locator('[data-tab="positions"]');
    await history.click();
    assert.equal(await body.locator('tbody tr').count(),sections.history.rows.length);
    assert.ok((await body.locator('tbody tr').first().innerText()).includes(sections.history.rows[0].symbol));
    assert.ok(await body.locator('a[href*="evidence/"],a[href*="trade-evidence/"]').first().isVisible());
    const current=dialog.locator('[data-tab="live"]');
    if(sections.positions.rows.length){
      await current.click();
      assert.equal(await body.locator('tbody tr').count(),sections.positions.rows.length);
      if(exchange==='Bitget')assert.ok((await body.innerText()).includes('延迟约 1 小时'));
    }else{
      assert.ok(!await current.isVisible());
      await dialog.locator('[data-tab="analysis"]').click();
      assert.ok((await body.innerText()).includes('策略保护'));
    }
    assert.ok(!await dialog.locator('[data-tab="orders"]').isVisible(),'position summaries are not fills');
    report.push({exchange,name:row.name,period,positions:sections.positions.rows.length,history:sections.history.rows.length});
  }
  return report;
};
