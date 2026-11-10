'use strict';
const assert=require('node:assert/strict');
const UI=require('../home-ranking.js');
const T=Date.parse('2026-11-10T10:40:00Z'),iso=n=>new Date(n).toISOString(),copy=v=>JSON.parse(JSON.stringify(v));
const address='0x'+'1'.repeat(40);
function fixture(){return {
 feed:{status:'ready',source:{fetchedAt:iso(T-60000),snapshotAt:iso(T-120000),positionVerification:{completedAt:iso(T-30000)}},traders:[{id:'hl-'+address,accountId:address,name:'Trader A',pnl:12000000,positionCheck:{checkedAt:iso(T-40000)}}]},
 portfolios:{generatedAt:iso(T-10000),accounts:{[address]:{fetchedAt:iso(T-60000),pnl:9000000}}},
 analytics:{generatedAt:iso(T-10000),accounts:{[address]:{fetchedAt:iso(T-60000),value:75,count:40}}}
};}
const Data={
 validateFeed(p){if(p.status!=='ready'||!Array.isArray(p.traders))throw Error('feed');return p;},
 validatePortfolios(p){if(!p.generatedAt||!p.accounts)throw Error('portfolios');return p;},
 validateAnalytics(p){if(!p.generatedAt||!p.accounts)throw Error('analytics');return p;},
 accountHref(a,p){return UI.moreHref(p)+'&account='+encodeURIComponent(a);},
 rank({feed,portfolios,analytics,failures},period){
  const raw=feed.traders[0],long=period!=='30D',w=analytics?.accounts[address],history=portfolios?.accounts[address];
  const rows=(!raw||long&&!history)?[]:[{id:raw.id,name:raw.name,accountId:raw.accountId,currency:'USD',pnl:long?history.pnl:raw.pnl,roi:long?null:40.1,mdd:history?12.3:null,winRate:w?.count>=20?w.value:null,winCount:w?.count||0,winStart:iso(T-7200000),winEnd:iso(T-600000),winFetchedAt:w?.fetchedAt,winStale:failures.analytics,performanceAsOf:feed.source.snapshotAt,performanceFetchedAt:long?history.fetchedAt:feed.source.fetchedAt,performanceStale:failures.feed||long&&failures.portfolios,coverageDays:long?89.2:null,startAt:long?'2026-08-12T10:40:00Z':null,endAt:long?iso(T-120000):null,positionCheckedAt:raw.positionCheck.checkedAt,currentHolding:!failures.feed,stale:failures.feed||long&&failures.portfolios}];
  return {period,rows,eligibleCount:rows.length,stale:rows.some(r=>r.stale),asOf:feed.source.snapshotAt,scope:'本站收录的 Hyperliquid 账户',note:'按同期收益率排序；近期片段胜率不随周期'};
 }
};
class El{
 constructor(doc,tag='div'){this.doc=doc;this.tagName=tag;this.children=[];this.attrs={};this.events={};this.className='';this.own='';}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;this.own='';}
 set textContent(t){this.own=String(t);this.children=[];}
 get textContent(){return this.own+this.children.map(c=>c.textContent).join('');}
 set innerHTML(_){throw Error('HTML injection forbidden');}
 setAttribute(k,v){this.attrs[k]=String(v);}
 getAttribute(k){return this.attrs[k]??null;}
 contains(item){return this===item||this.children.some(c=>c.contains(item));}
 querySelectorAll(selector){const match=el=>selector==='a'?el.tagName==='a':selector.startsWith('.')?el.className.split(' ').includes(selector.slice(1)):selector==='[data-ranking-period]'?'data-ranking-period' in el.attrs:false;return this.children.flatMap(c=>[...(match(c)?[c]:[]),...c.querySelectorAll(selector)]);}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 addEventListener(k,f){(this.events[k]??=[]).push(f);}
 removeEventListener(k,f){this.events[k]=(this.events[k]||[]).filter(x=>x!==f);}
 click(){this.focus();for(const f of this.events.click||[])f({target:this});}
 focus(){this.doc.activeElement=this;}
}
function dom(){const ids={},doc={visibilityState:'visible',activeElement:null,events:{},createElement:t=>new El(doc,t),getElementById:id=>ids[id],addEventListener(k,f){(this.events[k]??=[]).push(f);},removeEventListener(k,f){this.events[k]=(this.events[k]||[]).filter(x=>x!==f);}};const root=ids['home-trader-ranking']=new El(doc,'section');for(const id of ['home-ranking-list','home-ranking-status','home-ranking-note','home-ranking-more']){ids[id]=new El(doc,id==='home-ranking-more'?'a':'div');root.append(ids[id]);}const buttons=UI.PERIODS.map(p=>{const b=new El(doc,'button');b.setAttribute('data-ranking-period',p);root.append(b);return b;});return {doc,ids,buttons};}
const kind=url=>Object.keys(UI.FILES).find(k=>UI.FILES[k].url===url),response=p=>new Response(JSON.stringify(p),{headers:{'content-type':'application/json; charset=utf-8'}});
function mounted(custom){const d=dom(),f=fixture(),calls=[];const app=UI.mount(d.doc,{data:Data,now:()=>T,fetch:async(url,options)=>{calls.push({url,options});return custom?custom(url,options,f):response(f[kind(url)]);}});return {...d,f,calls,app};}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await test('formats signed USD without inventing missing percentages',()=>{assert.equal(UI.amount(12000000),'+1,200.00万');assert.equal(UI.amount(100000000),'+1.00亿');assert.equal(UI.amount(-30),'−30.00');assert.equal(UI.percent(null),'—');assert.equal(UI.percent(0),'0.00%');assert.match(UI.time('2026-11-10T10:00:00Z'),/18:00/);});
await test('more links preserve allowed rolling period, USD and ROI ordering',()=>{for(const p of UI.PERIODS){const u=new URL(UI.moreHref(p),'https://test.invalid/');assert.equal(u.pathname,'/trader/index.html');assert.equal(u.searchParams.get('period'),p);assert.equal(u.searchParams.get('sort'),'roi');assert.equal(u.searchParams.get('currency'),'USD');}assert.match(UI.moreHref('javascript:bad'),/period=30D/);});
await test('compact ranking shows percentage, identity, date, detail link and no empty metrics',()=>{
 const d=dom(),f=fixture(),view=Data.rank({...f,failures:{}},'30D');
 UI.render(d.doc,view,'30D',Data);
 const s=d.ids['home-ranking-list'].textContent;
 assert.match(s,/Trader A.*\+40.10%.*收益截至/);assert.doesNotMatch(s,/USD|1,200.00万|采样盈亏回撤|近期片段胜率|—/);
 assert.match(d.ids['home-ranking-status'].textContent,/收益率前1名/);
 assert.match(d.ids['home-ranking-list'].querySelector('a').href,/sort=roi/);
});
await test('untrusted names stay text, zero return is retained and stale snapshots are dated',()=>{
 const d=dom(),f=fixture();f.feed.traders[0].name='<img src=x onerror=alert(1)>';
 const view=Data.rank({...f,failures:{feed:true}},'30D');view.rows[0].roi=0;
 UI.render(d.doc,view,'30D',Data);assert.match(d.ids['home-ranking-list'].textContent,/<img src=x onerror=alert\(1\)>.*0.00%/);
 assert.match(d.ids['home-ranking-status'].textContent,/历史快照/);
});
await test('empty period is not labelled as a zero-place ranking',()=>{const d=dom(),f=fixture(),view=Data.rank({feed:f.feed,failures:{}},'90D');UI.render(d.doc,view,'90D',Data);assert.match(d.ids['home-ranking-status'].textContent,/当前周期暂无符合条件排名/);assert.doesNotMatch(d.ids['home-ranking-status'].textContent,/前0名/);});
await test('mount makes only the three bounded same-origin snapshot requests',async()=>{const m=mounted();try{assert.equal(m.ids['home-ranking-list'].getAttribute('aria-busy'),'true');await m.app.refresh();assert.deepEqual(m.calls.map(c=>c.url).sort(),Object.values(UI.FILES).map(f=>f.url).sort());for(const c of m.calls){assert.equal(c.options.credentials,'omit');assert.equal(c.options.redirect,'error');assert.equal(c.options.cache,'no-cache');}assert.match(m.ids['home-ranking-list'].textContent,/Trader A/);assert.equal(m.ids['home-trader-ranking'].getAttribute('aria-busy'),'false');assert.equal(m.ids['home-ranking-list'].getAttribute('aria-busy'),'false');}finally{m.app.destroy();}});
await test('overlapping refreshes share work and period switching never refetches',async()=>{const releases=[],m=mounted(async(url,options,f)=>{await new Promise(resolve=>releases.push(resolve));return response(f[kind(url)]);});try{const a=m.app.refresh(),b=m.app.refresh();assert.equal(a,b);assert.equal(m.calls.length,3);releases.forEach(r=>r());await a;m.buttons[1].click();assert.equal(m.app.getPeriod(),'90D');assert.equal(m.calls.length,3);assert.equal(m.buttons[1].getAttribute('aria-pressed'),'true');assert.equal(m.buttons[0].getAttribute('aria-pressed'),'false');assert.equal(m.doc.activeElement,m.buttons[1]);}finally{m.app.destroy();}});
await test('optional history failures do not block the monthly feed or fabricate values',async()=>{const m=mounted(async(url,options,f)=>{if(kind(url)!=='feed')throw Error('offline');return response(f.feed);});try{await m.app.refresh();assert.match(m.ids['home-ranking-list'].textContent,/Trader A/);assert.equal(m.app.getView().rows[0].winRate,null);m.buttons[1].click();assert.equal(m.app.getView().rows.length,0);assert.match(m.ids['home-ranking-list'].textContent,/缺少可核验的收益率/);}finally{m.app.destroy();}});
await test('a failed refresh retains last good per-file values with failure metadata',async()=>{let failed=false;const m=mounted(async(url,options,f)=>{if(failed)throw Error('offline');return response(f[kind(url)]);});try{await m.app.refresh();failed=true;await m.app.refresh();assert.equal(m.app.getView().rows[0].pnl,12000000);assert.equal(m.app.getView().rows[0].winRate,75);assert.match(m.ids['home-ranking-list'].textContent,/收益截至.*历史快照/);assert.equal(m.app.getView().stale,true);}finally{m.app.destroy();}});
await test('first-read failure shows no rankings and no invented zero values',async()=>{const m=mounted(async()=>{throw Error('offline');});try{await m.app.refresh();assert.equal(m.app.getView(),null);assert.match(m.ids['home-ranking-list'].textContent,/暂未取得可用榜单/);assert.doesNotMatch(m.ids['home-ranking-list'].textContent,/Trader|0.00%/);}finally{m.app.destroy();}});
await test('rollback checks cover source snapshots and per-account collection dates',()=>{const f=fixture();for(const k of Object.keys(f)){const next=copy(f[k]);if(k==='feed')next.source.snapshotAt=iso(T-900000);else next.accounts[address].fetchedAt=iso(T-900000);assert.throws(()=>UI.rejectOlder(k,next,f[k]));}const next=copy(f.feed);next.traders=[];assert.doesNotThrow(()=>UI.rejectOlder('feed',next,f.feed));});
await test('invalid or older incoming data cannot replace accepted rows',async()=>{let old=false;const m=mounted(async(url,options,f)=>{const p=copy(f[kind(url)]);if(old&&kind(url)==='feed'){p.source.snapshotAt=iso(T-999999);p.traders[0].pnl=1;}return response(p);});try{await m.app.refresh();old=true;await m.app.refresh();assert.equal(m.app.getView().rows[0].pnl,12000000);assert.equal(m.app.getView().stale,true);}finally{m.app.destroy();}});
await test('HTML and oversized responses are rejected before schema validation',async()=>{await assert.rejects(UI.readJSON(async()=>new Response('<html>',{headers:{'content-type':'text/html'}}),UI.FILES.feed));let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(UI.FILES.feed.limit+1));},cancel(){cancelled=true;}});await assert.rejects(UI.readJSON(async()=>new Response(stream,{headers:{'content-type':'application/json'}}),UI.FILES.feed));assert.equal(cancelled,true);});
await test('focus survives a list refresh and destroy removes listeners',async()=>{const m=mounted();try{await m.app.refresh();const link=m.ids['home-ranking-list'].querySelector('a');link.focus();await m.app.refresh();assert.equal(m.doc.activeElement.href,link.href);assert.notEqual(m.doc.activeElement,link);m.app.destroy();m.buttons[2].click();assert.equal(m.app.getPeriod(),'30D');const calls=m.calls.length;await m.app.refresh();assert.equal(m.calls.length,calls);}finally{m.app.destroy();}});
console.log('PASS '+count+' homepage ranking UI/DOM checks. Offline fixtures only.');
})().catch(e=>{console.error(e);process.exitCode=1;});
