import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {precompute,INDICES} from '../server/a-share-daily.mjs';
import {createSchemeStore} from '../server/a-share-schemes.mjs';
import {runSavedSchemes} from '../server/a-share-scheme-runner.mjs';
const require=createRequire(import.meta.url),model=require('../control/model.js'),engine=require('../screening/trend-screen.js'),patterns=require('../screening/trend-patterns.js'),selector=require('../screening/strength-selection.js');
const siteDir=resolve('.'),day='2026-11-20',sourceId='strength-pipeline-fixture',policy={rawPublic:false,derivedPublic:true};
const relativeKeys=['relativeBaseline','excessReturn','recentExcessReturn','relativeStrengthChange','downsideExcess','downsideDays'];
const peer={enabled:true,minPeers:2,groupTopPercent:50,minExcessReturn:-100,minRecentExcess:-100,minImprovement:-100,maxSupportDistance:100,sectorTopPercent:50};
const json=file=>readFile(file,'utf8').then(JSON.parse);
function dates(target){const values=[];for(let d=new Date(target+'T00:00:00Z');values.length<61;d.setUTCDate(d.getUTCDate()-1))if(![0,6].includes(d.getUTCDay()))values.unshift(d.toISOString().slice(0,10));return values;}
function bars(target,index=-1,ohlc=true){
 let price=100;const drift=index<0?0:(index%4)*.0003+(Math.floor(index/4)%10)*.00001;
 return dates(target).map((date,i)=>{price*=1+[.003,-.002,.001,-.003,.002][i%5]+drift;const bar={date,close:price,volume:i>=56&&(index<0||index%2===0)?2000:1000};return ohlc?{...bar,open:price*.999,high:price*1.01,low:price*.99}:bar;});
}
function dataset(count=40,target=day,ohlc=true){
 const asOf=target+'T15:10:00+08:00',universe=Array.from({length:count},(_,i)=>({code:String(600000+i)+'.SH',name:'趋势测试'+i,sector:'行业'+i%4,exchange:'SH'}));
 return {schema:'books.research.dataset.v1',day:target,asOf,completed:true,collectionStatus:'complete',expectedCount:count,totalUniverseCount:count,universe,reference:{code:'000300.SH',adjustment:'index',bars:bars(target,-1,ohlc),fetchedAt:asOf},records:universe.map((stock,i)=>({stock,source:{status:'ready',sourceId,day:target,adjustment:'qfq',bars:bars(target,i,ohlc),fetchedAt:asOf}}))};
}
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'books-strength-pipeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function assertDerived(value){
 if(!value||typeof value!=='object')return;
 for(const [key,item]of Object.entries(value)){assert(!['bars','referenceBars','prices','open','high','low','close','startClose','endClose','supportPrice','resistancePrice'].includes(key),'raw field '+key);assertDerived(item);}
}
function facts(record){return Object.fromEntries(relativeKeys.map(key=>[key,record.result.metrics[key]]));}
test('three-mode, two-window server precomputation and model replay share fixed-market relative facts without public raw OHLC',async t=>{
 const dir=await directory(t),input=dataset(),references=new Map(INDICES.map((code,i)=>[code,{...input.reference,code,bars:input.reference.bars.map(bar=>({...bar,open:bar.open*(i+1),high:bar.high*(i+1),low:bar.low*(i+1),close:bar.close*(i+1)}))}]));
 t.mock.method(globalThis,'fetch',()=>{throw Error('fixture must not access a source');});
 const sources=new Map(input.records.map(record=>[record.stock.code,record.source]));
 const published=await precompute({dir,siteDir,snapshot:null,universe:input.universe,sources,references,day,asOf:input.asOf,startedAt:input.asOf,sourceId,dataPolicy:policy,now:()=>Date.parse(day+'T20:10:00+08:00')});
 assert.equal(published.barSchema,'ohlcv-v1');const location=join(dir,'generations',published.generation);
 assert(!(await readdir(location)).some(name=>name.startsWith('dataset')||name.startsWith('market')));
 const byWindow=new Map();
 for(const code of INDICES){
  const raw=await json(join(dir,'private','generations',published.generation,'dataset-all-'+code+'.json'));
  assert.deepEqual(raw.records[0].source.bars,input.records[0].source.bars);
  for(const lookback of [20,60])for(const mode of engine.MODES){
   const publicResult=await json(join(location,`result-${mode}-${lookback}-all-${code}.json`));assertDerived(publicResult);
   const replay=await model.evaluateDataset(raw,{settings:{sampleSize:'all',benchmark:code,mode,lookback,limits:{enabled:false}}},engine);
   assert.equal(replay.status,'complete');assert.equal(publicResult.records.length,40);
   assert.deepEqual(publicResult.records.map(facts),replay.records.map(facts));
   for(let i=0;i<publicResult.records.length;i++){
    const record=publicResult.records[i],m=record.result.metrics;
    assert.equal(m.relativeBaseline,'full_market_leave_one_out_equal_stock_daily_median');assert.equal(m.sampleCount,lookback+1);assert.equal(m.startAt,raw.reference.bars.at(-lookback-1).date);assert.equal(m.endAt,day);
    assert.deepEqual(record.result.structure,replay.records[i].result.structure);assert.equal(record.result.structure.status,'ready');assert.equal(record.result.structure.endAt,day);
   }
   const key=code+'/'+lookback,previous=byWindow.get(key);if(previous)assert.deepEqual(publicResult.records.map(facts),previous);else byWindow.set(key,publicResult.records.map(facts));
  }
 }
 assert.notEqual(byWindow.get('000300.SH/20')[0].excessReturn,byWindow.get('000300.SH/60')[0].excessReturn);
 const sixty=await json(join(location,'result-market-60-all-000300.SH.json'));
 const wrongWindow=selector.select(sixty.records,{day,lookback:20,mode:'market',peer:{...peer,sectorTopPercent:null}});assert.equal(wrongWindow.groupSummary.groupCount,0);assert(wrongWindow.records.every(record=>record.selection.selected===null));
});
test('legacy close-only inputs retain price-rule eligibility while structural conditions stay unknown',async()=>{
 const input=dataset(40,day,false),config={settings:{mode:'market',sampleSize:'all',limits:{enabled:false}}};
 const evaluated=await model.evaluateDataset(input,config,engine);assert.equal(evaluated.status,'complete');assert(evaluated.records.every(record=>record.result.matched===true));
 for(const record of evaluated.records){assert.equal(record.result.structure.status,'unavailable');assert.equal(record.result.structure.supportDistancePct,null);assert.equal(record.result.structure.resistanceSpacePct,null);}
 const selected=selector.select(evaluated.records,{day,lookback:20,mode:'market',peer:{...peer,sectorTopPercent:null}});
 assert.equal(selected.groupSummary.groupCount,40);assert(selected.records.every(record=>record.selection.selected===null));assert(selected.records.every(record=>record.result.matched===true));
});
async function directSelection(input,scheme){
 const evaluated=await model.evaluateDataset(input,scheme.config,engine),sources=new Map(input.records.map(record=>[record.stock.code,record.source]));
 const candidates=evaluated.records.map(record=>({...record,patterns:patterns.classify({bars:sources.get(record.stock.code).bars,calendar:input.reference.bars,day:input.day,lookback:scheme.config.settings.lookback,parameters:scheme.config.settings.patterns})}));
 const scope=scheme.selection.scopeCodes===null?null:new Set(scheme.selection.scopeCodes),scoped=candidates.filter(record=>scheme.config.settings.mode==='consensus'||scope===null||scope.has(record.stock.code));
 return selector.select(scoped,{day:input.day,lookback:scheme.config.settings.lookback,mode:scheme.config.settings.mode,qualification:scheme.selection.qualification,patternId:scheme.selection.patternId,peer:scheme.config.settings.peer,sectorRecords:candidates});
}
test('saved peer, shape and sector rules match the shared selector, legacy membership remains stable and missing OHLC never manufactures exits',async t=>{
 const dir=await directory(t),dbFile=join(dir,'schemes.sqlite'),db=new DatabaseSync(dbFile);t.after(()=>db.close());let clock=Date.parse(day+'T20:10:00+08:00');const now=()=>clock;
 const store=createSchemeStore({db,model,patterns,now}),scopeCodes=dataset().universe.map(stock=>stock.code);
 const base={ownerId:'strength_owner',config:{settings:{mode:'market',sampleSize:'all',limits:{enabled:false}}},selection:{patternId:'',qualification:'strict',scopeCodes}};
 const legacy=store.save({...base,name:'旧方案'}),strong=store.save({...base,name:'组内转强方案',config:{settings:{mode:'market',sampleSize:'all',limits:{enabled:false},peer}},selection:{...base.selection,patternId:'volume-expand'}});
 assert.equal(legacy.config.settings.peer.enabled,false);assert.equal(strong.config.settings.peer.sectorTopPercent,50);
 async function publish(target,ohlc){
  clock=Date.parse(target+'T20:10:00+08:00');const input=dataset(1000,target,ohlc),generation=target+'-'+clock,manifest={generation,day:target,asOf:input.asOf,sourceId,dataPolicy:policy,total:1000,ready:1000,fullMarket:true};
  await mkdir(join(dir,'private','generations',generation),{recursive:true});await mkdir(join(dir,'generations',generation),{recursive:true});
  await writeFile(join(dir,'private','generations',generation,'dataset-all-000300.SH.json'),JSON.stringify(input));await writeFile(join(dir,'generations',generation,'complete.json'),JSON.stringify({...manifest,completed:true}));await writeFile(join(dir,'current.json'),JSON.stringify(manifest));return input;
 }
 t.mock.method(globalThis,'fetch',()=>{throw Error('saved-scheme runner must stay offline');});
 let input=await publish(day,true),expected=await directSelection(input,strong),result=await runSavedSchemes({dbFile,dir,siteDir,now});
 assert.equal(result.status,'complete');assert.equal(expected.groupSummary.groupCount,10);assert(expected.selectedRecords.length>0);
 let run=store.latestRun(strong.id);assert.deepEqual(run.records.filter(record=>record.selected).map(record=>record.stock.code),expected.selectedRecords.map(record=>record.stock.code));assert.equal(run.summary.relativeStrength.groupCount,expected.groupSummary.groupCount);assertDerived(run.records);
 const legacyRun=store.latestRun(legacy.id),oldExpected=await directSelection(input,legacy);assert.equal(legacyRun.summary.selected,40);assert.deepEqual(legacyRun.records.filter(record=>record.selected).map(record=>record.stock.code),oldExpected.selectedRecords.map(record=>record.stock.code));
 input=await publish('2026-11-23',false);expected=await directSelection(input,strong);result=await runSavedSchemes({dbFile,dir,siteDir,now});assert.equal(result.status,'complete');run=store.latestRun(strong.id);
 assert.equal(run.summary.exited,0);assert(run.records.filter(record=>record.confirmedSelected).every(record=>record.selected===null&&record.change==='unknown'));assert(expected.records.filter(record=>record.result.relativeStrength?.groupCount).some(record=>record.selection.selected===null));
 assert.equal(store.latestRun(legacy.id).summary.selected,40);assert.equal(store.latestRun(legacy.id).summary.continued,40);
 assert.equal((await runSavedSchemes({dbFile,dir,siteDir,now})).schemes[0].status,'skipped');
});
