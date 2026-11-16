'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const day=86400000;
const displayed=s=>Number(s.replace(/[\s,%％，]/g,'').replace('−','-'));
const closeTo=(a,b,label)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=.0051,label+' '+a+' ≠ '+b);

async function check(page,baseURL) {
  const base=new URL('./',baseURL || page.url());
  const request=page.request;
  const source=new URL('trader/okx/period-returns.json',base);
  const response=await request.get(source.href);
  assert.equal(response.status(),200);
  const snapshot=await response.json();
  const report={};
  for (const [period,selector] of [['90D','3'],['365D','4']]) {
    const numbers=new Map();
    const days=parseInt(period,10);
    for (const a of snapshot.accounts) {
      const part=a.performance[period];
      if (!part) continue;
      const official=new URL(part.sourceUrl);
      assert.equal(official.origin,'https://www.okx.com');
      assert.equal(official.pathname,'/api/v5/copytrading/public-pnl');
      assert.equal(official.searchParams.get('uniqueCode'),a.uniqueCode);
      assert.equal(official.searchParams.get('instType'),'SWAP');
      assert.equal(official.searchParams.get('lastDays'),selector);
      const archive=new URL('trader/'+part.evidencePath,base);
      assert.equal(archive.origin,base.origin);
      const bytes=await request.get(archive.href);
      assert.equal(bytes.status(),200);
      const raw=await bytes.body();
      assert.equal(createHash('sha256').update(raw).digest('hex'),part.evidenceSha256);
      const envelope=JSON.parse(raw);
      assert.equal(envelope.code,'0');
      const points=envelope.data.map(x=>({at:Number(x.beginTs),ratio:Number(x.pnlRatio)})).sort((a,b)=>a.at-b.at);
      assert.ok(a.leadDays>=days && points.length===days+1);
      assert.equal(points[0].ratio,0);
      for(let i=1;i<points.length;i++) {
        assert.equal(points[i].at-points[i-1].at,day);
        assert.ok(Number.isFinite(points[i].ratio));
      }
      const roi=points.at(-1).ratio*100;
      closeTo(part.roi,roi,a.uniqueCode+' raw percentage');
      numbers.set(a.uniqueCode,{name:a.name,roi,archive:archive.href,official:part.sourceUrl});
    }
    assert.ok(numbers.size>0,period+' has verified OKX lead traders');
    await page.goto(new URL('index.html',base).href,{waitUntil:'domcontentloaded'});
    const rankings=page.locator('#home-trader-ranking');
    await rankings.scrollIntoViewIfNeeded();
    await rankings.locator('[data-ranking-period="'+period+'"]').click();
    await page.locator('#home-ranking-list[aria-busy="false"] .home-rank-row').first().waitFor({timeout:30000});
    const home=await page.locator('#home-ranking-list .home-rank-row').evaluateAll(nodes=>nodes.map(el=>{
      const link=el.querySelector('.home-rank-identity'),url=new URL(link.href);
      return {id:url.searchParams.get('account'),exchange:url.searchParams.get('exchange'),period:url.searchParams.get('period'),
        price:el.querySelector('.home-rank-profit strong').textContent,proof:el.querySelector('.home-rank-evidence')?.href};
    }));
    const onHome=home.filter(r=>r.exchange==='OKX');
    if(page.viewportSize().width>1140)assert.equal(onHome.length,numbers.size,period+' shows all eligible OKX rows in desktop list');
    for(const row of onHome){
      const actual=numbers.get(row.id);
      assert.ok(actual && row.period===period);
      closeTo(displayed(row.price),actual.roi,'home '+row.id);
      assert.equal(row.proof,actual.archive);
    }
    await page.locator('#home-ranking-more').click();
    await page.locator('#platform-okx').click();
    await page.waitForFunction(({period,count})=>document.querySelector('#period')?.value===period &&
      document.querySelectorAll('#leaders .card .roi').length===count, {period,count:numbers.size},{timeout:30000});
    const cards=page.locator('#leaders .card');
    const shown=await cards.evaluateAll(nodes=>nodes.map(el=>({name:el.querySelector('h3').textContent,
      id:el.querySelector('.platform-id').title.split(' ').at(-1),roi:el.querySelector('.roi').textContent})));
    assert.deepEqual(shown.map(v=>v.id).sort(),[...numbers.keys()].sort());
    for(const row of shown){assert.equal(row.name,numbers.get(row.id).name);closeTo(displayed(row.roi),numbers.get(row.id).roi,'plaza '+row.id);}
    const first=shown[0], expected=numbers.get(first.id);
    await cards.first().locator('button.detail-button').click();
    const detail=page.locator('#detail[open] #detail-body');await detail.waitFor();
    closeTo(displayed(await detail.locator('.roi').first().innerText()),expected.roi,'detail '+first.id);
    assert.ok((await detail.innerText()).includes('OKX '+period));
    const proof=detail.getByRole('link',{name:'收益凭证',exact:true});
    assert.equal(await proof.evaluate(a=>a.href),expected.archive);
    const official=await detail.locator('a').evaluateAll(nodes=>nodes.map(n=>n.href).filter(h=>new URL(h).hostname==='www.okx.com'));
    assert.ok(official.some(h=>h===expected.official || new URL(h).pathname.toUpperCase()==='/COPY-TRADING/ACCOUNT/'+first.id.toUpperCase()),'account-bound official link in detail');
    report[period]={count:numbers.size,top:first,homeCount:onHome.length,official:official[0]};
  }
  return report;
}
module.exports={check};
