'use strict';
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const day = 86400000;

// Compare against the published provider receipts, independently of the ranking adapter.
module.exports = async function checkPeriods(page) {
  const site = new URL('./', page.url());
  const trader = new URL('trader/',site);
  async function json(relative) {
    const response=await page.request.get(new URL(relative,trader).href);
    assert.equal(response.status(),200,relative);
    return response.json();
  }
  const bundle=await json('binance/period-returns.json');
  const referenceId='5075281354358777856';
  const referenceProfile=(await json('binance/evidence/aoying-analysis-current/profile.json')).data;
  const historyResponse=await page.request.get(new URL('aoying-history.js',trader).href);
  assert.equal(historyResponse.status(),200);
  const historyScript=await historyResponse.text();
  const prefix='globalThis.BooksAoyingHistory=';
  assert.ok(historyScript.includes(prefix));
  const history=JSON.parse(historyScript.split(prefix)[1].trim().replace(/;$/,''));
  const summary={};
  const panel=page.locator('#home-trader-ranking');
  for(const period of ['90D','365D']) {
    const full=new Map(), short=new Map(), days=parseInt(period,10);
    const add=(id,roi,start,readAt)=>{
      assert.ok(Number.isFinite(roi) && Number.isFinite(start) && Number.isFinite(Date.parse(readAt)));
      const target=Date.parse(readAt)-start >= days*day?full:short;
      assert.ok(!target.has(id),'duplicate evidence for '+id);
      target.set(id,roi);
    };
    for(const account of bundle.accounts) {
      const part=account.performance.byPeriod[period];
      if(!part || !Number.isFinite(part.roi)) continue;
      const target=new URL(part.evidencePath,trader);
      assert.equal(target.origin,site.origin);
      const receipt=await page.request.get(target.href);
      assert.equal(receipt.status(),200,target.pathname);
      const bytes=await receipt.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'),part.evidence.sha256);
      const data=JSON.parse(bytes);
      assert.equal(data.code,'000000');assert.equal(data.success,true);
      assert.equal(data.data.timeRange,period);assert.equal(data.data.roi,part.roi);
      add(account.portfolioId,data.data.roi,account.startTime,part.lastSuccessAt);
    }
    const reference=await json('binance/evidence/aoying-analysis-current/performance-'+period+'.json');
    assert.equal(reference.data.timeRange,period);
    add(referenceId,reference.data.roi,referenceProfile.startTime,history.performanceByPeriod[period].fetchedAt);
    assert.ok(full.size>=3,period+' requires multiple accounts with full-period evidence');
    await panel.locator('[data-ranking-period="'+period+'"]').click();
    const list=panel.locator('#home-ranking-list[aria-busy="false"]');
    const rows=list.locator('.home-rank-row');
    await rows.first().waitFor();
    const values=await rows.evaluateAll(items=>items.map(row=>{
      const url=new URL(row.querySelector('.home-rank-identity').href);
      return {id:url.searchParams.get('account'),exchange:url.searchParams.get('exchange'),period:url.searchParams.get('period'),
        roi:Number(row.querySelector('.home-rank-profit strong').textContent.replace(/[,%％，]/g,'').replace('−','-'))};
    }));
    assert.equal(values.length,new Set(values.map(r=>r.id)).size);
    assert.deepEqual(values.map(r=>r.roi),values.map(r=>r.roi).sort((a,b)=>b-a));
    for(const row of values) {
      assert.equal(row.period,period);
      if(row.exchange!=='Binance')continue;
      assert.ok(full.has(row.id) && !short.has(row.id),'ranked Binance account must cover '+period+' '+row.id);
      assert.ok(Math.abs(row.roi-full.get(row.id))<=.00501,'wrong displayed ROI for '+row.id);
    }
    if(page.viewportSize().width>1140) {
      for(const id of full.keys())assert.ok(values.some(row=>row.id===id),'full-period account missing '+id);
    } else assert.equal(values.length,3,'mobile ranked preview');
    const shortGroup=panel.locator('#home-ranking-short');
    if(short.size){
      await shortGroup.waitFor();
      if(!await shortGroup.evaluate(el=>el.open))await shortGroup.locator('summary').click();
      const shortRows=shortGroup.locator('.home-rank-short-row');
      assert.equal(await shortRows.count(),short.size);
      for(const id of short.keys()){
        const link=shortRows.locator('a[href*="account='+id+'"]').first();
        assert.equal(await link.count(),1,id+' must appear in the short-history disclosure');
      }
      await shortGroup.locator('summary').click();
    }
    summary[period]={verifiedFull:full.size,shortHistory:short.size,visibleRows:values.length,first:values[0]};
  }
  const identity=panel.locator('#home-ranking-list .home-rank-identity').first();
  const selected=await identity.innerText();
  const href=new URL(await identity.getAttribute('href'),site);
  await identity.click();
  await page.locator('#detail[open]').waitFor({timeout:30000});
  assert.equal(await page.locator('#period').inputValue(),'365D');
  assert.equal(new URL(page.url()).searchParams.get('account'),href.searchParams.get('account'));
  assert.ok((await page.locator('#detail').innerText()).includes(selected.trim().split(/\s*\n\s*/).at(-1)));
  await page.goBack({waitUntil:'domcontentloaded'});
  return summary;
};
