'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const sampleDetails=require('./public-lead-detail-browser.cjs');

module.exports=async function checkPublicTraderDetails(page,base){
  const trader=new URL('trader/',base),cache=new Map();
  async function bytes(rel){
    assert.equal(new URL(rel,trader).origin,trader.origin);
    if(!cache.has(rel)){
      const response=await page.request.get(new URL(rel,trader).href);
      assert.equal(response.status(),200,rel);
      cache.set(rel,await response.body());
    }
    return cache.get(rel);
  }
  async function json(rel){return JSON.parse((await bytes(rel)).toString('utf8'));}
  async function proof(rel,hash){
    const raw=await bytes(rel);
    assert.equal(createHash('sha256').update(raw).digest('hex'),hash,rel);
    return JSON.parse(raw.toString('utf8'));
  }
  async function seed(rel,globalName){
    const s=(await bytes(rel)).toString('utf8'),marker='globalThis.'+globalName+'=';
    assert.ok(s.includes(marker),rel);
    return JSON.parse(s.split(marker)[1].trim().replace(/;$/,''));
  }
  const [bitget,okx,records,reference,official,historical]=await Promise.all([
    json('bitget/period-returns.json'),json('okx/period-returns.json'),json('okx/trades.json'),
    json('binance/aoying-public-archive.json'),seed('replay-seed.js','BooksPublicRecordSeed'),seed('aoying-history.js','BooksAoyingHistory')]);
  const sample=await sampleDetails(page,base);
  const dialog=page.locator('#detail[open]'),body=dialog.locator('#detail-body');
  async function open(exchange,id,period){
    const url=new URL(trader.href);url.search=new URLSearchParams({exchange,account:id,period});
    await page.goto(url.href,{waitUntil:'domcontentloaded'});
    await dialog.waitFor({timeout:30000});
  }
  async function checkRows(tab,section,kind){
    const button=dialog.locator('[data-tab="'+tab+'"]');
    if(!section.rows.length){
      assert.equal(await button.isVisible(),false);
      const text=await body.innerText();
      if(section.hiddenCount)assert.ok(text.includes('来源隐藏了 '+section.hiddenCount+' 条明细'));
      else if(section.status==='restricted')assert.ok(text.includes('策略保护'));
      else if(section.status==='unavailable')assert.ok(text.includes('官方数据暂不可读'));
      else if(section.status==='empty')assert.ok(text.includes('本次查询未显示公开记录'));
      return 0;
    }
    await button.click();
    const rows=await body.locator('tbody tr').evaluateAll(ts=>ts.map(t=>Array.from(t.cells,c=>c.textContent.trim())));
    assert.equal(rows.length,section.rows.length);
    for(const [i,cells] of rows.entries()){
      const r=section.rows[i];
      assert.equal(cells[0],r.symbol);
      assert.equal(cells[1],({long:'多',short:'空',net:'净持仓'})[r.side]);
      assert.equal(Number(cells[4]),r.entryPrice,kind+' opening price');
      if(kind==='history')assert.equal(Number(cells[5]),r.exitPrice,kind+' closing price');
      const quantityIndex=kind==='history'?6:5;
      assert.equal(Number(cells[quantityIndex].split(' ')[0]),r.quantity);
    }
    const links=await body.locator('.lead-source-links a').evaluateAll(nodes=>nodes.map(a=>a.href));
    for(const p of new Set([section.evidencePath,...section.rows.map(r=>r.evidencePath)].filter(Boolean)))assert.ok(links.includes(new URL(p,trader).href),p);
    await dialog.locator('[data-tab="analysis"]').click();
    return rows.length;
  }
  const totals={Bitget:{accounts:0,history:0,positions:0},OKX:{accounts:0,history:0,positions:0}},details=[];
  for(const exchange of ['Bitget','OKX']){
    const bundle=exchange==='OKX'?okx:bitget;
    for(const a of bundle.accounts){
      const id=a.uniqueCode||a.portfolioId;
      const activity=a.activity||records.accounts.find(x=>x.uniqueCode===id)?.activity;
      assert.ok(activity,'missing trade source state '+id);
      await open(exchange,id,'365D');
      assert.equal(await dialog.locator('#detail-title').innerText(),a.name);
      const fallback=a.performance['365D']?'365':'90';
      const selected=body.locator('.period-switch [aria-pressed="true"]');
      await selected.filter({hasText:new RegExp(fallback+' 天')}).waitFor();
      if(!a.performance['365D'])assert.ok(await body.getByRole('button',{name:/365 天.*暂缺/}).isDisabled());
      for(const period of ['30D','90D','365D']){
        const p=a.performance[period];
        if(!p)continue;
        const raw=await proof(p.evidencePath,p.evidenceSha256);
        const expected=exchange==='Bitget'?Number(raw.data.roi):Number([...raw.data].sort((a,b)=>Number(b.beginTs)-Number(a.beginTs))[0].pnlRatio)*100;
        const control=body.getByRole('button',{name:'近 '+parseInt(period,10)+' 天',exact:true});
        await control.click();
        assert.equal(await control.getAttribute('aria-pressed'),'true');
        const text=(await body.locator('.roi').innerText()).replace(/[%％,，]/g,'').replace('−','-');
        assert.ok(Math.abs(Number(text)-expected)<=.00501,exchange+' '+id+' '+period+' source ROI');
        assert.equal(await body.getByRole('link',{name:'收益凭证',exact:true}).evaluate(a=>a.href),new URL(p.evidencePath,trader).href);
      }
      const history=await checkRows('positions',activity.history,'history');
      const positions=await checkRows('live',activity.positions,'positions');
      assert.equal(await dialog.locator('[data-tab="orders"]').isVisible(),false,'aggregate positions must not appear as fills');
      totals[exchange].accounts++;totals[exchange].history+=history;totals[exchange].positions+=positions;
      details.push({exchange,id,name:a.name,history,positions,hidden:activity.positions.hiddenCount||0,status:activity.positions.status});
    }
  }
  const minOfficial=Object.keys(official.records).length;
  await open('Binance',official.portfolioId,'90D');
  await body.locator('.ta-archive-switch button[aria-pressed="true"]').filter({hasText:'本站官方归档'}).waitFor();
  assert.ok((await body.innerText()).includes('来源未公开 · 仓位未知'));
  await dialog.locator('[data-tab="orders"]').click();
  const status=body.locator('.ta-status'),all=body.locator('.ta-table tbody tr');
  const officialCounts=async()=>{
    await status.filter({hasText:new RegExp('条操作 · '+historical.rows.length+' 条官方历史仓位')}).waitFor();
    const officialCount=Number((await status.innerText()).match(/(\d+) 条操作/)[1]);
    assert.ok(officialCount>=minOfficial,'missing previously archived Binance record');
    assert.equal(await all.count(),officialCount);
    assert.equal(await body.getByRole('columnheader',{name:'归档记录标识'}).count(),0);
    return officialCount;
  };
  const before=await officialCounts();
  await body.locator('.ta-archive-switch button').filter({hasText:'AlphaFox 公开归档'}).click();
  await status.filter({hasText:reference.latestOrders.length+' 条流水 · '+reference.closedPositions.length+' 条已平仓记录'}).waitFor({timeout:30000});
  const ids=await all.evaluateAll(nodes=>nodes.map(tr=>tr.cells[tr.cells.length-1].textContent));
  assert.deepEqual(ids.sort(),reference.latestOrders.map(r=>'af:'+r.fingerprint).sort(),'third-party view contains exactly its own records');
  await body.locator('.ta-archive-switch button').filter({hasText:'本站官方归档'}).click();
  const back=await officialCounts();
  assert.ok(back>=before&&back<before+reference.latestOrders.length,'third-party records must not be added on switching back');
  return {totals,accounts:details,sample,eagle:{officialOrders:back,officialHistory:historical.rows.length,alphaFoxOrders:ids.length,alphaFoxHistory:reference.closedPositions.length}};
};
