'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const R=require('../trader/reference-data.js');
const C=require('../scripts/collect_aoying.cjs');

const now=new Date('2026-11-15T00:00:00.000Z');
const ok=data=>({code:'000000',success:true,data});
function fixture(url){
 const parsed=new URL(url);
 if(parsed.pathname.endsWith('/detail'))return ok({nickname:'熬鹰资本',marginBalance:375195.76813459,aumAmount:9109557.34820917,currentCopyCount:1000,maxCopyCount:1000,positionShow:false,lastTradeTime:Date.parse('2026-11-14T23:21:42.178Z'),status:'ACTIVE'});
 const period=parsed.searchParams.get('timeRange');
 if(parsed.pathname.endsWith('/performance'))return ok({timeRange:period,roi:period==='365D'?9525.28122545:10,pnl:period==='365D'?2857584.36763525:100,mdd:period==='365D'?68.310974:5,winRate:66.4,copierPnl:200,winOrders:3,totalOrder:4,sharpRatio:'2.68'});
 if(parsed.pathname.endsWith('/chart-data'))return ok([{value:1,dataType:'PNL',dateTime:Date.parse('2026-11-01T00:00:00Z')},{value:2,dataType:'PNL',dateTime:Date.parse('2026-11-02T00:00:00Z')}]);
 throw new Error(`unexpected URL ${url}`);
}

test('collector reads only public profile, five performance ranges and five PnL charts',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aoying-collector-'));
 const calls=[];
 const history=await C.collectAoying({now,previousFile:path.resolve(__dirname,'..','trader','aoying-history.js'),outputFile:path.join(dir,'history.js'),evidenceDir:path.join(dir,'evidence'),fetchImpl:async url=>{calls.push(url);return fixture(url);}});
 assert.equal(calls.length,11);
 assert.equal(calls.some(url=>/position|order|copy-trade\/lead-data/.test(url)),false);
 assert.deepEqual(Object.keys(history.performanceByPeriod),C.PERIODS);
 assert.deepEqual(Object.keys(history.curveByPeriod),C.PERIODS);
 assert.equal(history.positionStatus,'restricted');
 assert.equal(history.positionRows,null);
 assert.equal(history.profile.lastTradeAt,history.profile.lastTradeTime);
 assert.equal(history.fetchedAt,'2026-11-11T16:55:29Z');
 assert.equal(history.latestPublicFetchAt,now.toISOString());
 assert.equal(Object.prototype.hasOwnProperty.call(history,'positions'),false);
 const sandbox={};sandbox.globalThis=sandbox;vm.runInNewContext(fs.readFileSync(path.join(dir,'history.js'),'utf8'),sandbox);
 assert.equal(sandbox.BooksAoyingHistory.performanceByPeriod['365D'].roi,9525.28122545);
});

test('generated periods pass reference validation and preserve old 30D aliases',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aoying-reference-'));
 const history=await C.collectAoying({now,previousFile:path.resolve(__dirname,'..','trader','aoying-history.js'),outputFile:path.join(dir,'history.js'),evidenceDir:path.join(dir,'evidence'),fetchImpl:async url=>fixture(url)});
 for(const period of C.PERIODS){
  const performance=R.performance(history,C.PORTFOLIO_ID,period,{now:now.getTime()+1000});
  const chart=R.chart(history,C.PORTFOLIO_ID,period,{now:now.getTime()+1000});
  assert.equal(performance.status,'ready');
  assert.equal(performance.periodSupported,true);
  assert.equal(chart.status,'ready');
  assert.equal(chart.pointCount,2);
 }
 assert.equal(history.performance,history.performanceByPeriod['30D']);
 assert.equal(history.curve,history.curveByPeriod['30D']);
});

test('a failed public request leaves the previous evidence set untouched',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aoying-atomic-')),evidenceDir=path.join(dir,'evidence'),outputFile=path.join(dir,'history.js');
 fs.mkdirSync(evidenceDir,{recursive:true});
 const previousProfile=path.join(evidenceDir,'profile.json');fs.writeFileSync(previousProfile,'previous-evidence\n');
 await assert.rejects(()=>C.collectAoying({now,previousFile:path.resolve(__dirname,'..','trader','aoying-history.js'),outputFile,evidenceDir,fetchImpl:async url=>{
   const parsed=new URL(url);if(parsed.pathname.endsWith('/performance')&&parsed.searchParams.get('timeRange')==='90D')throw new Error('temporary source failure');return fixture(url);
 }}),/temporary source failure/);
 assert.equal(fs.readFileSync(previousProfile,'utf8'),'previous-evidence\n');
 assert.deepEqual(fs.readdirSync(evidenceDir),['profile.json']);
 assert.equal(fs.existsSync(outputFile),false);
});

test('legacy schema remains 30D-only and never reuses a 30D value for another period',()=>{
 const sandbox={};sandbox.globalThis=sandbox;vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'..','trader','aoying-history.js'),'utf8'),sandbox);
 const legacy=structuredClone(sandbox.BooksAoyingHistory);delete legacy.schemaVersion;legacy.schemaVersion=1;delete legacy.performanceByPeriod;delete legacy.curveByPeriod;
 assert.equal(R.performance(legacy,C.PORTFOLIO_ID,'30D',{now:Date.now()}).periodSupported,true);
 for(const period of ['7D','90D','180D','365D'])assert.equal(R.performance(legacy,C.PORTFOLIO_ID,period,{now:Date.now()}).roi,null);
});
