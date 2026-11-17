'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const api=require('../home-active-stocks.js'),fixture=require('./active-stocks-fixture.cjs');
const now=Date.parse('2026-11-16T10:00:00.000Z');
test('five complete sessions produce an independent turnover rank with deterministic ties',()=>{
 const data=fixture(),copy=JSON.stringify(data),view=api.summarize(data,now);
 assert.deepEqual(view.rows.map(row=>row.symbol),['SZSE:000001','SSE:600519','SZSE:300750']);
 assert.deepEqual(view.rows.map(row=>row.meanAmount),[9e8,3e8,3e8]);
 assert.equal(view.dataAsOf,'2026-11-13');assert.equal(view.historical,true);
 assert.equal(view.synthetic,true);assert.equal(view.coverage.excluded,1);
 assert.equal(JSON.stringify(data),copy);assert.equal(api.amount(3e8),'3.00 亿');
});
test('exchange mappings never guess Beijing, indices, malformed codes or URLs',()=>{
 for(const [exchange,code,symbol]of [['SH','600519','SSE:600519'],['SH','688981','SSE:688981'],['SZ','000001','SZSE:000001'],['SZ','300750','SZSE:300750']]){
  assert.equal(api.symbol(exchange,code),symbol);
  assert.equal(new URL(api.chartHref(exchange,code),'https://test.invalid/').searchParams.get('tvwidgetsymbol'),symbol);
 }
 for(const [exchange,code]of [['BJ','920001'],['SH','000001'],['SZ','600519'],['SH','60051'],['SZ',1],['SZ','javascript:alert(1)']])assert.throws(()=>api.symbol(exchange,code));
});
test('incomplete amounts, strings, nonfinite or negative values never yield partial rankings',()=>{
 for(const amount of [null,undefined,'100',NaN,Infinity,-1,1e16]){
  const data=fixture();data.rows[0].dailyAmounts[0].amount=amount;
  assert.throws(()=>api.summarize(data,now));
 }
 for(const change of [d=>d.rows[0].dailyAmounts.pop(),d=>d.rows[0].dailyAmounts.reverse(),d=>d.rows[0].dailyAmounts[0].date='2026-11-08']){
  const data=fixture();change(data);assert.throws(()=>api.summarize(data,now));
 }
});
test('date validation rejects duplicates, impossible dates, unclosed sessions and future generation',()=>{
 for(const change of [
  d=>d.tradingDates[1]=d.tradingDates[0],d=>d.tradingDates[0]='2026-02-30',
  d=>d.tradingDates[0]='2026-11-08',d=>d.tradingDates.pop(),d=>d.completedSessionsVerified=false,
  d=>d.dataAsOf='2026-11-12',d=>d.generatedAt='2026-11-13T06:59:00.000Z',
  d=>d.generatedAt='2026-11-16T11:00:00.000Z',d=>d.generatedAt='2026-11-13T08:00:00',
  d=>d.generatedAt='2026-02-30T08:00:00.000Z'
 ]){const data=fixture();change(data);assert.throws(()=>api.summarize(data,now));}
 assert.throws(()=>api.summarize(fixture(),Date.parse('2026-11-13T06:00:00Z')));
});
test('snapshot time remains the source session date when a historical file is reopened',()=>{
 const data=fixture();assert.equal(api.summarize(data,Date.parse('2026-11-13T08:00:00Z')).historical,false);
 assert.equal(api.summarize(data,Date.parse('2027-01-01T00:00:00Z')).dataAsOf,'2026-11-13');
 assert.equal(api.summarize(data,Date.parse('2027-01-01T00:00:00Z')).historical,true);
});
test('coverage, units, permission metadata and duplicate stocks fail closed',()=>{
 for(const change of [
  d=>d.coverage.scope='all_a_shares',d=>d.coverage.supplied++,d=>d.coverage.complete--,
  d=>d.coverage.excluded=-1,d=>d.amountUnit='unknown',d=>d.source.publicDisplayApproved=false,
  d=>d.source.permissionReference='',d=>d.rows[1]={...d.rows[0]},d=>d.method='price_change',
  d=>d.status='live',d=>delete d.synthetic,d=>d.schemaVersion=2,
  d=>{d.synthetic=false;d.source.permissionReference='javascript:alert(1)';},
  d=>{d.synthetic=false;d.source.permissionReference='https://user:secret@test.invalid/license';}
 ]){const data=fixture();change(data);assert.throws(()=>api.summarize(data,now));}
});
test('zero turnover does not become an active rank; the list is limited to ten',()=>{
 const data=fixture();data.rows.forEach(row=>row.dailyAmounts.forEach(day=>day.amount=0));
 assert.equal(api.summarize(data,now).rows.length,0);
 const many=fixture();many.rows=Array.from({length:15},(_,i)=>({...many.rows[0],code:String(600100+i)}));
 many.coverage={scope:'supplied_stock_sample',supplied:15,complete:15,excluded:0};
 assert.equal(api.summarize(many,now).rows.length,10);
});
test('the browser and Node use the same pure ranking function',()=>{
 const context={URL};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../home-active-stocks.js'),'utf8'),context);
 assert.deepEqual(JSON.parse(JSON.stringify(context.BooksActiveStocks.summarize(fixture(),now))),api.summarize(fixture(),now));
});
test('the shipped snapshot stays empty until source integration is separately reviewed',()=>{
 const data=require('../research-data/a-active-stocks.json');
 assert.deepEqual(api.summarize(data,now),{status:'not_configured',rows:[]});
 assert.equal(data.synthetic,false);assert.equal(data.source,null);assert.equal(data.dataAsOf,null);
 for(const change of [d=>d.rows.push(fixture().rows[0]),d=>d.dataAsOf='2026-11-13',d=>d.synthetic=true]){
  const changed=JSON.parse(JSON.stringify(data));change(changed);assert.throws(()=>api.summarize(changed,now));
 }
});
test('production code cannot load the synthetic audit fixture or call a provider',()=>{
 const root=path.join(__dirname,'..');
 const source=fs.readFileSync(path.join(root,'home-active-stocks.js'),'utf8'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 assert.doesNotMatch(source,/active-stocks-fixture|raw\.githubusercontent|gtimg|7709|localStorage|sessionStorage/);
 assert.match(source,/credentials:'omit',redirect:'error'/);assert.match(source,/cache:'no-store'/);
 assert.match(html,/id="home-active-stocks"/);assert.match(html,/home-active-stocks\.js/);
 assert.doesNotMatch(html,/合成样本|合成测试源/);
 assert.match(fs.readFileSync(path.join(root,'scripts/stage_public_release.cjs'),'utf8'),/'audit'/);
});
