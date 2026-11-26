import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createUSSelectionCache,publicSnapshot,renderUSChart} from '../server/us-selection-api.mjs';

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
  assert.match(svg,/B .*研究标记/);assert.match(svg,/前复权 · USD/);assert.equal(renderUSChart({bars:[]}),null);
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
