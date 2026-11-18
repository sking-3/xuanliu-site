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
  const [bitget,okx,records,official,historical]=await Promise.all([
    json('bitget/period-returns.json'),json('okx/period-returns.json'),json('okx/trades.json'),
    seed('replay-seed.js','BooksPublicRecordSeed'),seed('aoying-history.js','BooksAoyingHistory')]);
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
      assert.equal(await button.isVisible(),true);assert.equal(await button.isDisabled(),true);
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
      assert.equal(await dialog.locator('[data-tab="orders"]').isDisabled(),true,'aggregate positions must not appear as fills');
      totals[exchange].accounts++;totals[exchange].history+=history;totals[exchange].positions+=positions;
      details.push({exchange,id,name:a.name,history,positions,hidden:activity.positions.hiddenCount||0,status:activity.positions.status});
    }
  }
  const binanceDirectory=await json('binance/period-returns.json');
  const wanted=new Set([official.portfolioId,...binanceDirectory.accounts.map(a=>a.portfolioId)]);
  const directory=new URL(trader.href);directory.search=new URLSearchParams({exchange:'Binance',period:'30D',sort:'roi'});
  await page.goto(directory.href,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(n=>document.querySelectorAll('#leaders .card h3 button').length===n,wanted.size);
  const nameStyle=await page.locator('#leaders h3 button').first().evaluate(button=>{
    const css=getComputedStyle(button),edges=['Top','Right','Bottom','Left'];
    return {background:css.backgroundColor,borders:edges.map(edge=>parseFloat(css['border'+edge+'Width'])),padding:edges.map(edge=>parseFloat(css['padding'+edge]))};
  });
  assert.ok(['transparent','rgba(0, 0, 0, 0)'].includes(nameStyle.background),nameStyle.background);
  assert.deepEqual(nameStyle.borders,[0,0,0,0]);assert.deepEqual(nameStyle.padding,[0,0,0,0]);
  const cards=await page.locator('#leaders .card').evaluateAll(nodes=>nodes.map(card=>({
    name:card.querySelector('h3').textContent,roi:card.querySelector('.roi')?.textContent??null,
    id:card.querySelector('.platform-id').textContent.replace(/^组合 ID /,''),
    links:[...card.querySelectorAll('.card-links :is(a,button)')].map(a=>({label:a.textContent,href:a.getAttribute('href'),tag:a.tagName})),text:card.innerText
  })));
  const actual=new Set(),values=[],actionsReady=cards[0].links[0].tag==='A';let missingSeen=false;
  for(const card of cards){
    assert.deepEqual(card.links.map(link=>link.label),['模拟','跟单']);
    actual.add(card.id);
    for(const [i,link] of card.links.entries()){
      assert.equal(link.tag,actionsReady?'A':'BUTTON');
      if(!actionsReady){assert.equal(link.href,null);continue;}
      const u=new URL(link.href);assert.equal(u.origin,'https://books-private-follow.rr7jp4d56w.chatgpt.site');assert.equal(u.pathname,'/');
      assert.equal(u.searchParams.get('exchange'),'Binance');assert.equal(u.searchParams.get('name'),card.name);
      assert.equal(u.searchParams.get('mode'),i?'follow':'paper');assert.deepEqual([...u.searchParams.keys()].sort(),['exchange','mode','name','sourceAccountId']);
      assert.equal(u.searchParams.get('sourceAccountId'),card.id);
    }
    if(card.roi===null){missingSeen=true;assert.ok(card.text.includes('暂无已核实收益率'));}
    else{assert.equal(missingSeen,false,'measured ROI precedes unknown performance');values.push(Number(card.roi.replace(/[%％,，]/g,'').replace('−','-')));}
  }
  assert.deepEqual(actual,wanted);assert.deepEqual(values,[...values].sort((a,b)=>b-a));
  if(!actionsReady){
    const currentUrl=page.url();
    for(const [index,label] of [[0,'模拟'],[1,'跟单']]){
      const control=page.locator('#leaders .card').nth(index).getByRole('button',{name:label+' · '+cards[index].name,exact:true});
      await control.click();
      const notice=page.getByRole('dialog',{name:cards[index].name+' · '+label,exact:true});
      assert.equal(await notice.locator('p').innerText(),'账户设置暂不可用，请稍后重试。');
      if(index)await notice.getByRole('button',{name:'关闭'}).click();else await page.keyboard.press('Escape');
      await notice.waitFor({state:'detached'});assert.equal(page.url(),currentUrl);
      assert.equal(await control.evaluate(button=>button===document.activeElement),true);
    }
  }
  const hl=(await json('feed.json')).traders.find(t=>t.exchange==='Hyperliquid');assert.ok(hl);
  await open('Hyperliquid',hl.accountId,'30D');
  for(const selectedTab of ['positions','live','orders','points','analysis']){
    const controls=dialog.locator('#tabs button[data-tab]');
    assert.equal(await controls.count(),5);for(const control of await controls.all())assert.ok(await control.isVisible());
    const target=dialog.locator('[data-tab="'+selectedTab+'"]');assert.ok(await target.isEnabled());await target.click();assert.equal(await target.getAttribute('aria-pressed'),'true');
  }
  const minOfficial=Object.keys(official.records).length;
  const thirdPartyRequests=[];
  const watchThirdParty=request=>{if(/alphafox|aoying-public-archive/i.test(request.url()))thirdPartyRequests.push(request.url());};
  page.on('request',watchThirdParty);
  await open('Binance',official.portfolioId,'90D');
  await body.locator('.ta-account-facts').filter({hasText:'币安未公开'}).waitFor();
  const layout=await dialog.evaluate(root=>{
    const bounds=root.getBoundingClientRect();
    return {viewport:innerWidth,left:bounds.left,right:bounds.right,inside:root.scrollWidth-root.clientWidth,
      tabs:root.querySelectorAll('#tabs button[data-tab]:not([hidden])').length,title:parseFloat(getComputedStyle(root.querySelector('#detail-title')).fontSize),
      metric:parseFloat(getComputedStyle(root.querySelector('.ta-metric>strong')).fontSize)};
  });
  assert.equal(layout.tabs,5);
  if(layout.viewport<=640)assert.ok(layout.left>=-1&&layout.right<=layout.viewport+1&&layout.inside<=1,'mobile detail overflow '+JSON.stringify(layout));
  else assert.ok(layout.title<=20&&layout.metric<=24,'desktop detail type sizes '+JSON.stringify(layout));
  await dialog.locator('[data-tab="live"]').click();
  await body.getByText('当前持仓未知',{exact:true}).waitFor();
  await dialog.locator('#detail-overview').getByText('币安未公开当前仓位',{exact:true}).waitFor();
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
  const officialOrders=await officialCounts();
  assert.equal(await body.locator('.ta-archive-switch').count(),0);
  assert.doesNotMatch(await dialog.innerText(),/AlphaFox/i);
  assert.deepEqual(thirdPartyRequests,[]);
  page.off('request',watchThirdParty);
  return {totals,accounts:details,sample,eagle:{officialOrders,officialHistory:historical.rows.length}};
};
