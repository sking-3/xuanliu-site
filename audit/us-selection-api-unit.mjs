import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createUSSelectionCache,publicSnapshot,renderUSChart} from '../server/us-selection-api.mjs';
import {trendExitVersion} from '../server/us-selection-engine.mjs';

const bars=Array.from({length:130},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),open:100+i/10,high:102+i/10,low:99+i/10,close:101+i/10,volume:1000+i}));
const snapshot={schema:'books.us.selection.v1',asOf:bars.at(-1).date,generatedAt:'2026-11-26T10:00:00.000Z',source:{derivedPublic:true,rawPublic:false},short:{rows:[{symbol:'TEST',name:'Test company',trigger:114,invalidation:111,bars,markers:[{date:bars.at(-1).date,type:'B'}]}]},fundamentals:{rows:[{symbol:'TEST',metrics:{pe:12},companyFacts:{raw:'private'}}]},dca:{rows:[]}};
test('public projection retains computed research and removes nested raw data',()=>{
  const result=publicSnapshot(snapshot);
  assert.equal(result.short.rows[0].bars,undefined);assert.equal(result.fundamentals.rows[0].companyFacts,undefined);
  assert.equal(result.short.rows[0].trigger,114);assert.match(result.short.rows[0].chartUrl,/symbol=TEST/);
  assert.equal(publicSnapshot({...snapshot,source:{derivedPublic:false}}).short.rows.length,0);
  const privateData=publicSnapshot({...snapshot,source:{derivedPublic:false},market:{benchmarks:{SPY:{close:100}}},tracking:{rows:[{referenceClose:100}]}});
  assert.equal(privateData.market.benchmarks,undefined);assert.deepEqual(privateData.tracking.rows,[]);
});
test('chart window is trading-bar count and markers use their original dates',()=>{
  const svg=renderUSChart(snapshot.short.rows[0],60);
  assert.match(svg,/近60个交易日/);assert.ok(svg.includes(bars.at(-60).date));assert.ok(!svg.includes(bars[0].date));
  assert.ok(svg.includes(`data-signal="B"><title>B 买入信号 ${bars.at(-1).date}</title>`));assert.match(svg,/前复权 · USD/);assert.equal(renderUSChart({bars:[]}),null);
});
test('buy threshold and defense labels avoid each other and price ticks without moving the reference lines',()=>{
  const row={...snapshot.short.rows[0],trigger:110,invalidation:109.99};
  const svg=renderUSChart(row,120);
  const labels=[...svg.matchAll(/data-reference="(entry|defense)" data-price-y="([\d.]+)" data-label-y="([\d.]+)"/g)].map(([,kind,priceY,labelY])=>({kind,priceY:Number(priceY),labelY:Number(labelY)}));
  assert.equal(labels.length,2);assert(Math.abs(labels[0].labelY-labels[1].labelY)>=28);
  assert(Math.abs(labels[0].priceY-labels[1].priceY)<1,'close reference prices must retain their true chart positions');
  for(const [,tickY]of svg.matchAll(/data-axis-label="price" x="[\d.]+" y="([\d.]+)"/g))for(const label of labels)assert(Math.abs(Number(tickY)-6-label.labelY)>=24);
  assert.match(svg,/买入门槛 110/);assert.match(svg,/防守位 109\.99/);
  assert.doesNotMatch(svg,/data-reference="[BS]"|data-signal="S"/);
  assert.equal(row.trigger,110);assert.equal(row.invalidation,109.99);assert.equal(row.markers[0].date,bars.at(-1).date);
});
test('a recorded exit has its own candle and price while a legacy S remains a historical risk',()=>{
  const oldDate=bars.at(-5).date,exitDate=bars.at(-3).date;
  const row={...snapshot.short.rows[0],trendPosition:{state:'sold',reference:{trigger:112,defense:108}},markers:[
    {type:'S',date:oldDate,price:110.1,label:'日线触及失效位'},
    {type:'S',date:exitDate,price:112.15,exitVersion:trendExitVersion,exitRule:'ma20_two_closes',reason:'连续两个交易日收盘低于MA20'}
  ]};
  const before=structuredClone(row),result=publicSnapshot({...snapshot,short:{rows:[row]}}).short.rows[0];
  assert.equal(result.markers[0].type,'X');
  assert.equal(result.markers[0].date,oldDate);
  assert.equal(result.markers[1].type,'S');
  const svg=renderUSChart(row,120);
  assert.ok(svg.includes(`data-signal="X"><title>X 风险记录 ${oldDate} · 110.1 USD · 历史防守位触及</title>`));
  assert.ok(svg.includes(`data-signal="S"><title>S 卖出信号 ${exitDate} · 112.15 USD · 连续两个交易日收盘低于MA20</title>`));
  assert.equal([...svg.matchAll(/data-signal="S"/g)].length,1);
  assert.match(svg,/买入门槛 112/);assert.match(svg,/防守位 108/);
  assert.deepEqual(row,before);
});
test('a failed current task retains the completed snapshot and never starts collection',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'books-us-api-'));
  try{
    const generation='test-v1';await mkdir(join(directory,'batches',generation),{recursive:true});
    await writeFile(join(directory,'batches',generation,'snapshot.json.gz'),gzipSync(JSON.stringify(snapshot)));
    await writeFile(join(directory,'published.json'),JSON.stringify({generation,asOf:snapshot.asOf,snapshot:`batches/${generation}/snapshot.json.gz`}));
    await writeFile(join(directory,'state.json'),JSON.stringify({status:'failed',message:'Provider HTTP 501',processed:50,total:100}));
    const cache=createUSSelectionCache({directory});
    async function get(path,encoding=''){
      let status,value,headers;
      const res={writeHead(s,h){status=s;headers=h;},end(body){value=body;}};
      const url=new URL(path,'http://localhost');
      const handled=await cache.handle({method:'GET',headers:{'accept-encoding':encoding}},res,{path:url.pathname,url,json(_res,s,v){status=s;value=v;}});
      return {handled,status,value,headers};
    }
    const result=await get('/api/us-selection/snapshot');assert.equal(result.status,200);assert.equal(result.value.asOf,snapshot.asOf);assert.equal(result.value.task.status,'failed');assert.equal(result.value.short.rows[0].bars,undefined);
    const zipped=await get('/api/us-selection/snapshot','gzip');assert.deepEqual(JSON.parse(gunzipSync(zipped.value)),result.value);
    const chart=await get('/api/us-selection/chart?symbol=TEST&window=120','gzip');assert.equal(chart.status,200);assert.match(gunzipSync(chart.value).toString(),/近120个交易日/);
    const plain=await get('/api/us-selection/chart?symbol=TEST&window=60','gzip;q=0');assert.equal(plain.headers['content-encoding'],undefined);
    assert.equal((await get('/api/us-selection/chart?symbol=UNKNOWN')).status,404);
    assert.equal((await get('/api/us-selection/chart?symbol=TEST&window=1000')).status,400);
  }finally{await rm(directory,{recursive:true,force:true});}
});
