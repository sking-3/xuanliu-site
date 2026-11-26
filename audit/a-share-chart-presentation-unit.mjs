import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {rebuildAShareChartPresentation} from '../server/a-share-chart-presentation-rebuild.mjs';
import {readPresentedChart,presentationDirectory} from '../server/a-share-chart-presentation.mjs';
import {readWorkbenchChart,readA14Chart,schema as deskSchema} from '../server/a-share-desk.mjs';
import {schema as watchSchema,version as watchVersion} from '../server/a-share-desk-watches.mjs';
import {schema as trackingSchema,version as trackingVersion} from '../server/a-share-opportunity-tracking.mjs';
import {closeCandidateVersion} from '../server/a-share-entry-current.mjs';
import {entryPolicyVersion} from '../server/a-share-entry-bars.mjs';
import {entryValidationVersion} from '../server/a-share-entry-validation.mjs';
import {createAShareCache} from '../server/a-share-cache.mjs';

async function save(file,value){await mkdir(dirname(file),{recursive:true});await writeFile(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'books-chart-presentation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const dates=[];for(let time=Date.parse('2026-11-26T00:00Z');dates.length<140;time-=86400000)if(![0,6].includes(new Date(time).getUTCDay()))dates.unshift(new Date(time).toISOString().slice(0,10));
 const bars=dates.map(date=>({date,open:100,high:101,low:99,close:100,volume:1000})),day=dates.at(-1),batch={generation:day+'-123',sourceId:'tickflow-free-forward-v1',day,asOf:day+'T07:00:00.000Z',total:1},stock={code:'600000.SH',name:'合成展示测试'},target=join(dir,'generations',batch.generation),source={sourceId:batch.sourceId,day,status:'ready',adjustment:'qfq',fetchedAt:day+'T08:00:00Z',bars};
 const header={schema:'books.a-share.history.v1',...batch,reference:{code:'000300.SH',bars}},history=join(dir,'private','generations',batch.generation,'history-all.ndjson');
 const item={...stock,...batch,formationDay:dates.at(-4),keyBarDay:dates.at(-3),stage:'waiting_breakout',closePrice:100,trigger:{above:101},invalidation:{below:99},actualFillVerified:false};
 const row={...stock,...batch,phase:'close',state:'watch',qualified:false,reference:{close:100,trigger:101,invalidation:99},research:{},actualFillVerified:false};
 const watch={schema:watchSchema,version:watchVersion,completed:true,datasetBound:true,...batch,current:[row],charts:[60,120].map(window=>({...batch,code:stock.code,window,path:'desk-watches-v1-charts/'+stock.code+'-'+window+'.svg',priceBasis:'first-close-percent',actualCandles:window}))};
 const entry={schema:'books.a-share.entry-current.v1',version:closeCandidateVersion,entryPolicyVersion,entryValidationVersion,completed:true,datasetBound:true,...batch,sourceDay:day,current:[item]};
 await save(join(dir,'current.json'),batch);await save(join(target,'complete.json'),{...batch,completed:true});await save(history,[header,{stock,source}].map(JSON.stringify).join('\n'));
 await save(join(target,'entry-current-v2/report.json'),entry);await save(join(target,'desk-watches-v1.json'),watch);await save(join(dir,'stock-desk-v1/current.json'),{schema:deskSchema,...batch});
 const paths=[];for(const window of [60,120])for(const path of ['desk-watches-v1-charts/'+stock.code+'-'+window+'.svg','entry-current-v2/'+stock.code+'-'+item.formationDay+'-'+window+'.svg']){paths.push('generations/'+batch.generation+'/'+path);await save(join(target,path),'<svg>original frozen image</svg>');await save(join(target,path+'.gz'),gzipSync('<svg>original frozen image</svg>'));}
 const request=async route=>{const url=new URL(route,'http://test'),res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};await createAShareCache({directory:dir}).handle({method:'GET',headers:{}},res,{path:url.pathname,url,json:(res,status,value)=>{res.status=status;res.value=value;}});return res;};
 return {dir,batch,target,stock,source,header,history,item,entry,row,watch,paths,dates,bars,request};
}
test('frozen selection is re-rendered atomically without network, source changes or gzip differences',async t=>{
 const f=await fixture(t),before=await Promise.all([readFile(join(f.dir,'current.json')),readFile(f.history),readFile(join(f.target,'entry-current-v2/report.json')),...f.paths.map(path=>readFile(join(f.dir,path)))]),fetch=globalThis.fetch;let requests=0;globalThis.fetch=()=>{requests++;throw Error('network prohibited');};t.after(()=>{globalThis.fetch=fetch;});
 const result=await rebuildAShareChartPresentation({dir:f.dir,includeA14:false});assert.equal(result.main.completed,true);assert.equal(result.main.files.length,4);assert.equal(requests,0);
 for(const path of result.main.files){const body=await readPresentedChart({dir:f.dir,binding:f.batch,path}),compressed=await readPresentedChart({dir:f.dir,binding:f.batch,path,compressed:true});assert.match(body.toString(),/B 买入参考/);assert.match(body.toString(),/S 卖出参考/);assert.deepEqual(gunzipSync(compressed),body);assert.doesNotMatch(body.toString(),/data-kind="S"/);}
 const after=await Promise.all([readFile(join(f.dir,'current.json')),readFile(f.history),readFile(join(f.target,'entry-current-v2/report.json')),...f.paths.map(path=>readFile(join(f.dir,path)))]);assert.deepEqual(after,before);
 const chart=await readWorkbenchChart({dir:f.dir,generation:f.batch.generation,code:f.stock.code,window:60});assert.match(chart.body.toString(),/B 买入参考/);
 const api=await f.request('/api/a-share-daily/entry-current-chart?'+new URLSearchParams({generation:f.batch.generation,code:f.stock.code,setup:f.item.formationDay}));assert.equal(api.status,200);assert.match(api.body.toString(),/B 买入参考/);
 const repeat=await rebuildAShareChartPresentation({dir:f.dir,includeA14:false});assert.deepEqual(repeat,result);
});
test('original source and eligibility guards run before presentation selection',async t=>{
 const f=await fixture(t);await rebuildAShareChartPresentation({dir:f.dir,includeA14:false});
 f.watch.current[0].qualified=true;await save(join(f.target,'desk-watches-v1.json'),f.watch);assert.equal(await readWorkbenchChart({dir:f.dir,generation:f.batch.generation,code:f.stock.code,window:60}),null);
 f.entry.current=[];await save(join(f.target,'entry-current-v2/report.json'),f.entry);const api=await f.request('/api/a-share-daily/entry-current-chart?'+new URLSearchParams({generation:f.batch.generation,code:f.stock.code,setup:f.item.formationDay}));assert.equal(api.status,404);
});
test('wrong generation, source, day, asOf, incomplete inventory and missing files cannot select a derived image',async t=>{
 const f=await fixture(t);await rebuildAShareChartPresentation({dir:f.dir,includeA14:false});const options={dir:f.dir,binding:f.batch,path:f.paths[0]};
 for(const key of ['generation','sourceId','day','asOf'])assert.equal(await readPresentedChart({...options,binding:{...f.batch,[key]:key==='generation'?'2026-11-25-456':'wrong'}}),null);
 assert.equal(await readPresentedChart({...options,path:'../private.svg'}),null);assert.equal(await readPresentedChart({...options,path:'generations/'+f.batch.generation+'/not-selected.svg'}),null);
 const manifest=join(f.dir,presentationDirectory,f.batch.generation,'manifest.json'),value=JSON.parse(await readFile(manifest));value.completed=false;await save(manifest,value);assert.equal(await readPresentedChart(options),null);
 const fallback=await readWorkbenchChart({dir:f.dir,generation:f.batch.generation,code:f.stock.code,window:60});assert.equal(fallback.body.toString(),'<svg>original frozen image</svg>');
 value.completed=true;await save(manifest,value);await unlink(join(f.dir,presentationDirectory,f.batch.generation,f.paths[0]));assert.equal(await readPresentedChart(options),null);
});
test('failure after staging charts publishes no manifest and preserves original source and fallback',async t=>{
 const f=await fixture(t);f.watch.charts[1].actualCandles=119;await save(join(f.target,'desk-watches-v1.json'),f.watch);const before=await readFile(join(f.dir,'current.json'));
 await assert.rejects(rebuildAShareChartPresentation({dir:f.dir,includeA14:false}),/coverage changed/);assert.deepEqual(await readFile(join(f.dir,'current.json')),before);
 assert.deepEqual(await readdir(join(f.dir,presentationDirectory)),[]);assert.equal((await readWorkbenchChart({dir:f.dir,generation:f.batch.generation,code:f.stock.code,window:60})).body.toString(),'<svg>original frozen image</svg>');
});
test('compressed private history is restored read-only and old generation input is rejected',async t=>{
 const f=await fixture(t),original=await readFile(f.history);await save(f.history+'.gz',gzipSync(original));await unlink(f.history);
 const result=await rebuildAShareChartPresentation({dir:f.dir,includeA14:false});assert.equal(result.main.files.length,4);assert.deepEqual(gunzipSync(await readFile(f.history+'.gz')),original);
 await assert.rejects(rebuildAShareChartPresentation({dir:f.dir,generation:'2026-11-25-123',includeA14:false}),/currently published/);
});
test('historical chart indexes use frozen public ids rather than reselecting setups',async t=>{
 const f=await fixture(t),setup={id:'frozen-one',formation:{date:f.dates.at(-10)},keyBar:{date:f.dates.at(-9)},trigger:{above:101},invalidation:{below:99},replayStatus:'confirmed'},path='entries/'+f.stock.code+'-0.svg';
 await save(join(f.target,path),'<svg>old history</svg>');await save(join(f.target,'entries',f.stock.code+'.json'),{...f.batch,stock:f.stock,items:[{id:setup.id,chartUrl:'/api/a-share-daily/entry-chart?'+new URLSearchParams({generation:f.batch.generation,code:f.stock.code,setup:'0'})}]});
 await save(join(f.dir,'private/generations',f.batch.generation,'entries',f.stock.code+'.json'),{...f.batch,stock:f.stock,setups:[{...setup,id:'not-selected'},setup]});
 const result=await rebuildAShareChartPresentation({dir:f.dir,includeA14:false});assert.equal(result.main.files.length,5);const body=await readPresentedChart({dir:f.dir,binding:f.batch,path:'generations/'+f.batch.generation+'/'+path});assert.match(body.toString(),/B 买入参考/);assert.match(body.toString(),/F 形态 · C 确认关键K · T 突破观察/);assert.doesNotMatch(body.toString(),/data-kind="S"/);
});
test('missing historical frozen setup fails instead of recalculating or publishing replacements',async t=>{
 const f=await fixture(t);await save(join(f.target,'entries',f.stock.code+'-0.svg'),'<svg>old</svg>');await save(join(f.target,'entries',f.stock.code+'.json'),{...f.batch,stock:f.stock,items:[{id:'missing',chartUrl:'old'}]});await save(join(f.dir,'private/generations',f.batch.generation,'entries',f.stock.code+'.json'),{...f.batch,stock:f.stock,setups:[]});
 await assert.rejects(rebuildAShareChartPresentation({dir:f.dir,includeA14:false}),/frozen selected setup id/);assert.deepEqual(await readdir(join(f.dir,presentationDirectory)),[]);
});
test('14:00 derived image uses its frozen captured quote and history generation, including cold quote archives',async t=>{
 const f=await fixture(t),day='2026-11-27',sourceId='tencent-public-stock-quotes-v1',receivedAt=day+'T06:00:10.000Z',quoteSourceAt=day+'T06:00:00.000Z',row={...f.row,day,sourceId,generation:day+'-1795759210000',historyGeneration:f.batch.generation,historySourceId:f.batch.sourceId,phase:'a14',state:'near_B',familyId:'entry-confirmation-16',ruleVersion:'test',setupId:'frozen',anchorDay:day,asOf:quoteSourceAt,quoteSourceAt,receivedAt,firstSeenAt:receivedAt,sourceFetchedAt:receivedAt,actualDiscoveryAt:receivedAt,basisDay:f.batch.day,basisClose:100,quotePrevClose:100,reference:{close:100.5,trigger:101,invalidation:99}};
 row.id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);const report={schema:trackingSchema,version:trackingVersion,completed:true,datasetBound:true,phase:'a14',generation:row.generation,historyGeneration:f.batch.generation,historySourceId:f.batch.sourceId,sourceId,day,asOf:quoteSourceAt,computedAt:day+'T06:02:00.000Z',current:[row],tracks:[],marketContext:{historyDay:f.batch.day}},root=join(f.dir,'intraday-preselection-v1');
 await save(join(root,'current.json'),report);await save(join(root,'days',day,'report.json'),report);await save(join(root,'days',day,'private-quotes-1795759210000-0.json.gz'),gzipSync(JSON.stringify({sourceId,receivedAt,quotes:[{code:f.stock.code,sourceAt:quoteSourceAt,prevClose:100,open:100,high:101,low:99.5,price:100.5}]})));
 for(const window of [60,120])await save(join(root,'days',day,'charts',f.stock.code+'-'+window+'.svg'),'<svg>old quote</svg>');
 const result=await rebuildAShareChartPresentation({dir:f.dir});assert.equal(result.a14.files.length,2);assert.equal(result.a14.historyGeneration,f.batch.generation);
 const chart=await readA14Chart({dir:f.dir,day,code:f.stock.code,window:60,now:Date.parse(day+'T07:00Z')});assert.match(chart.body.toString(),/B 买入参考/);assert.match(chart.body.toString(),/data-unclosed="true"/);assert.doesNotMatch(chart.body.toString(),/data-kind="B"/);
 const wrong=await readPresentedChart({dir:f.dir,binding:{...report,historyGeneration:'2026-11-25-123'},path:result.a14.files[0]});assert.equal(wrong,null);
});
test('14:00 per-stock quote times differ from the report minimum and remain independently bound to raw captures',async t=>{
 const f=await fixture(t),day='2026-11-27',sourceId='tencent-public-stock-quotes-v1',receivedAt=day+'T06:00:41.114Z',generation=day+'-1795759241114',quoteTimes=[day+'T06:00:38.000Z',day+'T06:00:36.000Z'];
 f.batch.total=2;f.header.total=2;const stocks=[f.stock,{...f.stock,code:'600001.SH'}];await save(join(f.dir,'current.json'),f.batch);await save(join(f.target,'complete.json'),{...f.batch,completed:true});await save(f.history,[f.header,...stocks.map(stock=>({stock,source:f.source}))].map(JSON.stringify).join('\n'));
 const current=stocks.map((stock,index)=>{const row={...f.row,...stock,day,sourceId,generation,historyGeneration:f.batch.generation,historySourceId:f.batch.sourceId,phase:'a14',state:'near_B',familyId:'entry-confirmation-16',ruleVersion:'test',setupId:'frozen-'+stock.code,anchorDay:day,asOf:quoteTimes[index],quoteSourceAt:quoteTimes[index],receivedAt,firstSeenAt:receivedAt,sourceFetchedAt:receivedAt,actualDiscoveryAt:receivedAt,basisDay:f.batch.day,basisClose:100,quotePrevClose:100,reference:{close:100.5,trigger:101,invalidation:99}};row.id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);return row;});
 const report={schema:trackingSchema,version:trackingVersion,completed:true,datasetBound:true,phase:'a14',generation,historyGeneration:f.batch.generation,historySourceId:f.batch.sourceId,sourceId,day,asOf:quoteTimes[1],computedAt:day+'T06:02:00.000Z',current,tracks:[],marketContext:{historyDay:f.batch.day}},root=join(f.dir,'intraday-preselection-v1'),publish=async()=>{await save(join(root,'current.json'),report);await save(join(root,'days',day,'report.json'),report);};await publish();
 await save(join(root,'days',day,'private-quotes-1795759241114-0.json'),{sourceId,receivedAt,quotes:stocks.map((stock,index)=>({code:stock.code,sourceAt:quoteTimes[index],prevClose:100,open:100,high:101,low:99.5,price:100.5}))});
 for(const stock of stocks)for(const window of [60,120])await save(join(root,'days',day,'charts',stock.code+'-'+window+'.svg'),'<svg>old quote</svg>');
 const result=await rebuildAShareChartPresentation({dir:f.dir});assert.equal(result.a14.files.length,4);assert.equal(result.a14.asOf,quoteTimes[1]);assert.notEqual(current[0].asOf,report.asOf);
 for(const row of current){const chart=await readA14Chart({dir:f.dir,day,code:row.code,window:60,now:Date.parse(day+'T07:00Z')});assert.match(chart.body.toString(),/B 买入参考/);assert.match(chart.body.toString(),/参考价 100.5/);}
 report.asOf=quoteTimes[0];await publish();await assert.rejects(rebuildAShareChartPresentation({dir:f.dir}),/earliest captured row quote time/);
 report.asOf=quoteTimes[1];current[0].asOf=day+'T06:00:39.000Z';await publish();await rm(join(f.dir,presentationDirectory,generation),{recursive:true});
 await assert.rejects(rebuildAShareChartPresentation({dir:f.dir}),/frozen quote or historical price binding differs/);assert.equal(await readFile(join(root,'days',day,'charts',stocks[0].code+'-60.svg'),'utf8'),'<svg>old quote</svg>');
});
