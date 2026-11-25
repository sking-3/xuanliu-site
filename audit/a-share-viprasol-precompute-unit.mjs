import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {precomputeViprasolStudy,writeViprasolCurrentCharts,viprasolStudyDirectory} from '../server/a-share-viprasol-precompute.mjs';
import {familyId,sourceCommit} from '../server/a-share-viprasol-study.mjs';

const day='2026-11-25',generation=day+'-1',sourceId='tickflow-free-forward-v1',asOf=day+'T07:00:00.000Z';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'books-viprasol-view-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const target=join(dir,'generations',generation),privateTarget=join(dir,'private',generation),siteDir=join(dir,'site');
 await mkdir(target,{recursive:true});await mkdir(privateTarget,{recursive:true});await mkdir(join(siteDir,'quant-research/native-audit'),{recursive:true});
 const dates=[];for(let time=Date.parse(day+'T00:00:00Z');dates.length<80;time-=86400000){const date=new Date(time);if(![0,6].includes(date.getUTCDay()))dates.unshift(date.toISOString().slice(0,10));}
 const bars=dates.map((date,i)=>({date,open:100,high:i>=59&&i<=68?101:100.1,low:i>=59&&i<=68?99:99.9,close:100,volume:1000}));
 Object.assign(bars[79],{open:100,high:102,low:99.9,close:101});
 const stock={code:'600000.SH',name:'合成写入契约测试',exchange:'SH'},source={sourceId,day,status:'ready',adjustment:'qfq',historyRequested:500,bars,fetchedAt:day+'T08:00:00.000Z',volumeUnit:'手'};
 const reference={code:'000300.SH',adjustment:'index',bars:dates.map(date=>({date,open:100,high:100.1,low:99.9,close:100,volume:1000})),fetchedAt:source.fetchedAt};
 const header={schema:'books.a-share.history.v1',generation,sourceId,day,asOf,total:1,historyRequested:500,reference};
 const batch={generation,sourceId,day,asOf,total:1},historyFile=join(privateTarget,'history-all.ndjson');
 await writeFile(historyFile,[header,{stock,source}].map(JSON.stringify).join('\n')+'\n');
 await writeFile(join(dir,'current.json'),JSON.stringify(batch));await writeFile(join(target,'pattern-regimes.json'),'original 16-family sentinel');
 return {dir,target,siteDir,historyFile,header,stock,source,bars,batch,options:{historyFile,target,batch,siteDir,policyKnownAt:day+'T06:50:00Z',nextSessionDay:'2026-11-26',now:()=>Date.parse(day+'T09:00:00Z')}};
}
async function noCompletedView(f){await assert.rejects(access(join(f.target,viprasolStudyDirectory,'report.json')),/ENOENT/);assert.equal((await readdir(f.target)).some(name=>name.startsWith('.viprasol-study-')),false);}
async function validStorageWriter({directory,item,paths}){
 assert.equal(item.familyId,familyId);assert.equal(item.day,item.signalDay);
 for(const window of [60,120]){const body='<svg data-normalization="first-close-percent"><text>'+window+'日 · 0%</text></svg>';await writeFile(join(directory,paths[window]),body);await writeFile(join(directory,paths[window]+'.gz'),gzipSync(body));}
}

test('missing approval/build leaves native0, preserves source/current/16-family, and binds all current items',async t=>{
 const f=await fixture(t),paths=[f.historyFile,join(f.dir,'current.json'),join(f.target,'pattern-regimes.json')],before=await Promise.all(paths.map(path=>readFile(path)));let writerCalls=0;
 const report=await precomputeViprasolStudy({...f.options,writeCurrentChart:async()=>{writerCalls++;}});
 assert.equal(report.completed,true);assert.equal(report.datasetBound,true);assert.equal(report.sourceDay,day);assert.equal(report.implementationCommit,null);assert.equal(report.summary.nativeApprovedCount,0);assert.equal(report.eligibleForSelection,false);assert.equal(writerCalls,0);assert.deepEqual(report.charts,[]);
 assert.ok(report.current.some(item=>item.ruleId==='tyson'));
 for(const item of report.current){assert.equal(item.familyId,familyId);assert.equal(item.closePrice,f.bars.at(-1).close);assert.equal(item.signalDay,day);assert.equal(item.eligibleForSelection,false);assert.deepEqual(item.charts,{});}
 for(let i=0;i<paths.length;i++)assert.deepEqual(await readFile(paths[i]),before[i]);
 assert.equal(report.summary.statisticalPassedCount,report.rules.filter(rule=>rule.statisticalGatePassed).length);
 const plain=await readFile(join(f.target,viprasolStudyDirectory,'report.json')),compressed=await readFile(join(f.target,viprasolStudyDirectory,'report.json.gz'));assert.deepEqual(gunzipSync(compressed),plain);
 assert.doesNotMatch(plain.toString(),/"(?:bars|open|high|low|volume)":/);
});

test('gzip-only archived report can be read without rewriting source or recomputing the view',async t=>{
 const f=await fixture(t),first=await precomputeViprasolStudy(f.options),path=join(f.target,viprasolStudyDirectory,'report.json');await rm(path);
 const again=await precomputeViprasolStudy({...f.options,now:()=>Date.parse(day+'T10:00:00Z')});assert.deepEqual(again,first);await assert.rejects(access(path),/ENOENT/);
});

test('an archived view cannot reuse an altered source-today stage',async t=>{
 const f=await fixture(t),report=await precomputeViprasolStudy(f.options),path=join(f.target,viprasolStudyDirectory,'report.json');
 report.current[0].stage='historical_replay';const changed=JSON.stringify(report);await writeFile(path,changed);await writeFile(path+'.gz',gzipSync(changed));
 await assert.rejects(precomputeViprasolStudy(f.options),/not source-today/);assert.equal(await readFile(path,'utf8'),changed);
});

test('build implementation binding is loaded, but unreviewed numerical agreement is never an approval',async t=>{
 const f=await fixture(t),implementationCommit='a'.repeat(40);await writeFile(join(f.siteDir,'quant-research/viprasol-build.json'),JSON.stringify({implementationCommit}));
 await writeFile(join(f.siteDir,'quant-research/native-audit/a-share-approvals.json'),JSON.stringify([{ruleId:'tyson',sourceCommit,implementationCommit,numericalMatch:true,divergenceCount:0}]));
 const report=await precomputeViprasolStudy(f.options);assert.equal(report.implementationCommit,implementationCommit);assert.equal(report.summary.nativeApprovedCount,0);assert.equal(report.summary.effectiveCount,0);assert.ok(report.rules[0].nativeGate.reasons.includes('native_scope_not_fully_reviewed'));
});

test('corrupt or non-array approval cannot replace an already completed report',async t=>{
 const f=await fixture(t);await precomputeViprasolStudy(f.options);const path=join(f.target,viprasolStudyDirectory,'report.json'),old=await readFile(path);
 const approvals=join(f.siteDir,'quant-research/native-audit/a-share-approvals.json');
 await writeFile(approvals,'{broken');await assert.rejects(precomputeViprasolStudy(f.options),SyntaxError);assert.deepEqual(await readFile(path),old);
 await writeFile(approvals,JSON.stringify({nativeVerified:true}));await assert.rejects(precomputeViprasolStudy(f.options),/explicit reviewed-entry array/);assert.deepEqual(await readFile(path),old);
});

test('source generation/day/asOf/sourceId/total and requested500 mismatches reject atomically',async t=>{
 for(const change of [{generation:'2026-11-24-1'},{day:'2026-11-24'},{asOf:'2026-11-25T06:00:00Z'},{sourceId:'other'},{total:2},{historyRequested:61}]){
  const f=await fixture(t);await writeFile(f.historyFile,[{...f.header,...change},{stock:f.stock,source:f.source}].map(JSON.stringify).join('\n'));
  await assert.rejects(precomputeViprasolStudy(f.options),/header/);await noCompletedView(f);
 }
});

test('truncated raw JSON, missing stock code, duplicate code and missing record cannot create a view',async t=>{
 for(const variant of ['json','code','duplicate','missing']){
  const f=await fixture(t);let lines=[f.header,{stock:f.stock,source:f.source}];
  if(variant==='json'){await writeFile(f.historyFile,JSON.stringify(f.header)+'\n{"stock":');}
  else{
   if(variant==='code')lines[1]={stock:{name:'missing code'},source:f.source};
   if(variant==='duplicate')lines.push(lines[1]);
   if(variant==='missing'){f.batch.total=2;lines[0]={...f.header,total:2};}
   await writeFile(f.historyFile,lines.map(JSON.stringify).join('\n'));
  }
  await assert.rejects(precomputeViprasolStudy(f.options));await noCompletedView(f);
 }
});

test('derived market metadata must bind its generation and cover only source codes',async t=>{
 const f=await fixture(t),metadata={sourceKind:'exchange-rule-derived',generation,sourceId,sourceDay:day,sourceAsOf:asOf,mintickVerified:true,mintick:.01};
 await assert.rejects(precomputeViprasolStudy({...f.options,marketMetadata:{[f.stock.code]:{...metadata,generation:'other'}}}),/metadata is not bound/);
 await assert.rejects(precomputeViprasolStudy({...f.options,marketMetadata:{'600999.SH':metadata}}),/code absent/);await noCompletedView(f);
 const report=await precomputeViprasolStudy({...f.options,marketMetadata:{[f.stock.code]:metadata}});assert.equal(report.summary.nativeApprovedCount,0);assert.equal(report.eligibleForSelection,false);
});

test('isolated chart storage contract writes exactly two normalized gzip-restorable charts per qualified item',async t=>{
 const f=await fixture(t),base=await precomputeViprasolStudy(f.options),item=base.current.find(item=>item.ruleId==='tyson');assert.ok(item);
 // This is a storage fixture, not a native approval or injected study evaluator.
 const report={current:[{...item,eligibleForSelection:true}]},directory=join(f.dir,'chart-contract');await mkdir(directory);
 await writeViprasolCurrentCharts({historyFile:f.historyFile,directory,report,batch:f.batch,writeCurrentChart:validStorageWriter});
 assert.equal(report.charts.length,2);assert.equal(report.current[0].closePrice,f.bars.at(-1).close);assert.deepEqual(report.current[0].originalReference,item.originalReference);
 for(const chart of report.charts){assert.equal(chart.path,'tyson-'+f.stock.code+'-'+day+'-'+chart.window+'.svg');for(const key of ['generation','sourceId','day','asOf'])assert.equal(chart[key],f.batch[key]);const plain=await readFile(join(directory,chart.path));assert.deepEqual(gunzipSync(await readFile(join(directory,chart.path+'.gz'))),plain);}
 assert.equal((await readdir(directory)).length,4);
});

test('a qualified storage fixture cannot silently omit writer, stock, source binding, gzip or normalization',async t=>{
 const f=await fixture(t),base=await precomputeViprasolStudy(f.options),item=base.current.find(item=>item.ruleId==='tyson'),directory=join(f.dir,'chart-rejection');await mkdir(directory);
 const call=(writer,changes={})=>writeViprasolCurrentCharts({historyFile:f.historyFile,directory,report:{current:[{...item,eligibleForSelection:true,...changes}]},batch:f.batch,writeCurrentChart:writer});
 await assert.rejects(call(undefined),/require an injected/);
 await assert.rejects(call(async()=>{}),/ENOENT/);
 await assert.rejects(call(validStorageWriter,{code:'600999.SH'}),/source stock/);
 await assert.rejects(call(validStorageWriter,{originalReference:{...item.originalReference,entry:999}}),/closing price/);
 await assert.rejects(call(async({directory,paths})=>{for(const path of Object.values(paths))await writeFile(join(directory,path),'<svg data-normalization="first-close-percent"></svg>');}),/ENOENT/);
 await assert.rejects(call(async({directory,paths})=>{for(const path of Object.values(paths)){await writeFile(join(directory,path),'<svg></svg>');await writeFile(join(directory,path+'.gz'),gzipSync('<svg></svg>'));}}),/normalized SVG/);
 await assert.rejects(call(async({directory,paths})=>{for(const path of Object.values(paths)){await writeFile(join(directory,path),'<svg data-normalization="first-close-percent"></svg>');await writeFile(join(directory,path+'.gz'),gzipSync('different'));}}),/does not restore/);
});
