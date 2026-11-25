import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {runStockDesk,readStockDesk,readA14Chart,readWorkbenchChart,readContextChart,schema,directoryName} from '../server/a-share-desk.mjs';
import {filename as watchFilename,chartDirectoryName as watchChartDirectory} from '../server/a-share-desk-watches.mjs';
import {version as trackingVersion,schema as trackingSchema,directoryName as trackingDirectory} from '../server/a-share-opportunity-tracking.mjs';
import {version as preferenceVersion,filename as preferenceFilename} from '../server/a-share-market-preference.mjs';
import {createAShareCache} from '../server/a-share-cache.mjs';
import {filename as contextFilename} from '../server/a-share-decision-context.mjs';

const siteDir=fileURLToPath(new URL('..',import.meta.url)),day='2026-11-20',now=()=>Date.parse(day+'T10:00:00Z');
const batch={generation:day+'-1795165200000',sourceId:'tickflow-free-forward-v1',day,asOf:day+'T07:00:00.000Z',total:1000,ready:900,dataPolicy:{rawPublic:false}};
async function save(file,value){await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));}
function closeReport(){
  const original={code:'600000.SH',name:'合成接口测试',familyId:'key-k-entry-16',ruleVersion:'test-v1',setupId:'600000.SH:2026-11-19',ruleIds:['ma20_pullback'],anchorDay:day,phase:'close',state:'near_B',qualified:false,qualification:'unqualified_observation',...batch,sourceFetchedAt:day+'T08:00:00Z',actualDiscoveryAt:day+'T08:30:00Z',firstSeenAt:day+'T09:00:00Z',conditionKnownAfter:day+'T07:00:00Z',activeUntil:'2026-11-23T09:30:00+08:00',reference:{close:10,trigger:10.1,invalidation:9.5},chartUrls:{},research:{rules:[],institutionalEvidence:null},actualFillVerified:false};
  original.id=JSON.stringify([original.sourceId,original.ruleVersion,original.familyId,original.setupId,original.code,original.anchorDay]);
  const observations={1:{status:'pending',returnPercent:null},2:{status:'pending',returnPercent:null},3:{status:'pending',returnPercent:null}};
  return {schema:trackingSchema,version:trackingVersion,completed:true,datasetBound:true,...batch,computedAt:day+'T09:00:00Z',marketContext:{regime:'mixed_or_range'},current:[{...structuredClone(original),observations}],tracks:[{id:original.id,firstSeenAt:original.firstSeenAt,original,observations}],summary:{qualifiedCount:0},method:{savedScheme15DayPolicyChanged:false}};
}
function preference(){
  return {schema:'books.a-share.market-preference.v1',version:preferenceVersion,completed:true,datasetBound:true,...batch,computedAt:day+'T09:00:00Z',policy:{horizon:3,minSamples:30,minStocks:10,minSignalDays:10},currentRegime:{state:'sideways'},byRegime:[{regime:'sideways',patterns:[{regime:'sideways',patternId:'ma20_pullback',sampleCount:29,stockCount:10,signalDayCount:10,meanReturnPercent:1,meanExcessPercent:.5,positiveRate:.6,adequate:false,adequacy:{reasons:['fewer_than_30_events']},eligibleForSelection:false}]}],adequateRanking:[],eligibleForSelection:false};
}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'books-desk-unit-')),target=join(dir,'generations',batch.generation);t.after(()=>rm(dir,{recursive:true,force:true}));
  await save(join(dir,'current.json'),batch);await save(join(target,'complete.json'),{...batch,completed:true,fullMarket:true});
  const db=new DatabaseSync(join(dir,'collector.sqlite'));db.exec('CREATE TABLE batches_v2(source_id TEXT,day TEXT,as_of TEXT,snapshot_json TEXT)');
  const universe=Array.from({length:1000},(_,index)=>({code:String(600000+index)+'.SH',name:'合成名册'+index}));
  db.prepare('INSERT INTO batches_v2 VALUES(?,?,?,?)').run(batch.sourceId,day,batch.asOf,JSON.stringify({schema:'books.a-share.universe.v1',day,retrievedAt:day+'T08:00:00Z',universe}));db.close();
  const report=closeReport(),pref=preference();
  await save(join(target,'entry-current-v2','report.json'),{...batch,completed:true,current:report.current});await save(join(target,'viprasol-study-v1','report.json'),{...batch,completed:true,current:[]});
  const dates=[];for(let time=Date.parse(day+'T00:00:00Z');dates.length<70;time-=86400000)if(![0,6].includes(new Date(time).getUTCDay()))dates.unshift(new Date(time).toISOString().slice(0,10));
  const bars=dates.map(date=>({date,open:10,high:10.1,low:9.9,close:10,volume:100})),source={sourceId:batch.sourceId,day,status:'ready',adjustment:'qfq',historyRequested:500,fetchedAt:day+'T08:00:00Z',bars};
  const raw={schema:'books.a-share.history.v1',...batch,historyRequested:500,reference:{code:'000300.SH',adjustment:'index',fetchedAt:source.fetchedAt,bars}},records=universe.map(stock=>({stock:{...stock,listingDate:'2000-01-01'},source})),historyFile=join(dir,'private','generations',batch.generation,'history-all.ndjson');
  await mkdir(dirname(historyFile),{recursive:true});const saveHistory=()=>writeFile(historyFile,[raw,...records].map(JSON.stringify).join('\n'));await saveHistory();
  const track=async({additionalCurrent=[]}={})=>{const value={...structuredClone(report),computedAt:new Date(now()).toISOString()};for(const row of additionalCurrent){value.current.push({...structuredClone(row),observations:{}});value.tracks.push({id:row.id,firstSeenAt:row.firstSeenAt,original:structuredClone(row),observations:{}});}await save(join(target,trackingDirectory,'report.json'),value);return value;};
  const precompute=async()=>{await save(join(target,preferenceFilename+'.json'),pref);return structuredClone(pref);};
  const publish=()=>runStockDesk({dir,siteDir,now,track,precompute,collectInstitutions:async()=>({status:'complete',checkedAt:day+'T09:59:00Z',byCode:{}})});
  return {dir,target,report,pref,track,precompute,publish,records,saveHistory};
}
async function publishA14(dir,{quoteDay='2026-11-23',second=true}={}){
  const make=(code,minute)=>{
    const receivedAt=quoteDay+'T06:0'+minute+':10.000Z',row={code,name:'合成盘中测试',familyId:'entry-confirmation-16',ruleVersion:'test-a14',setupId:code+':'+day,ruleIds:[],anchorDay:quoteDay,phase:'a14',state:'near_B',qualified:false,qualification:'unqualified_observation',generation:quoteDay+'-1795414200000',sourceId:'tencent-public-stock-quotes-v1',historySourceId:batch.sourceId,historyGeneration:batch.generation,day:quoteDay,asOf:quoteDay+'T06:0'+minute+':00.000Z',sourceFetchedAt:receivedAt,actualDiscoveryAt:receivedAt,conditionKnownAfter:receivedAt,firstSeenAt:receivedAt,activeUntil:quoteDay+'T15:00:00+08:00',basisDay:day,basisClose:10,quotePrevClose:10,quoteSourceAt:quoteDay+'T06:0'+minute+':00.000Z',receivedAt,reference:{close:10.05,trigger:10.1,invalidation:9.5},observations:{},research:{},actualFillVerified:false};
    row.id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);return row;
  };
  const current=[make('600000.SH',0),...(second?[make('600001.SH',1)]:[])],report={schema:trackingSchema,version:trackingVersion,phase:'a14',completed:true,datasetBound:true,generation:current[0].generation,sourceId:current[0].sourceId,historyGeneration:batch.generation,historySourceId:batch.sourceId,day:quoteDay,asOf:current[0].asOf,computedAt:quoteDay+'T06:02:00Z',current,tracks:current.map(row=>({id:row.id,firstSeenAt:row.firstSeenAt,original:structuredClone(row),observations:{}}))};
  const root=join(dir,'intraday-preselection-v1');await save(join(root,'current.json'),report);await save(join(root,'days',quoteDay,'report.json'),report);await save(join(root,'status.json'),{status:'complete',day:quoteDay,finishedAt:report.computedAt,error:null});
  const file=join(root,'days',quoteDay,'charts','600000.SH-60.svg');await mkdir(dirname(file),{recursive:true});await writeFile(file,'<svg data-test="derived"/>');await writeFile(file+'.gz',gzipSync('<svg data-test="derived"/>'));
  return report;
}

test('publishes one close source with inline same-regime research without changing frozen originals or eligibility',async t=>{
  const f=await fixture(t),original=structuredClone(f.report.tracks[0].original),result=await f.publish();assert.equal(result.attempt.status,'complete');
  const view=await readStockDesk({dir:f.dir,now:now()});assert.equal(view.schema,schema);assert.equal(view.close.status,'ready');assert.equal(view.close.data.generation,batch.generation);assert.equal(view.close.data.current[0].qualified,false);
  assert.equal(view.close.data.current[0].research.regimePreference[0].sampleCount,29);assert.equal(view.close.data.current[0].research.regimePreference[0].adequate,false);assert.deepEqual(view.close.data.tracks[0].original,original);assert.deepEqual(f.report.tracks[0].original,original);assert.equal(view.close.data.marketContext.preferences.historicalMembership,false);assert.deepEqual(view.close.data.marketContext.topRanking,[]);assert.equal(view.close.data.method.savedScheme15DayPolicyChanged,false);
});
test('full-market coded plans are merged read-only with coherent model charts and separate immutable episodes',async t=>{
 const f=await fixture(t),record=f.records[2];record.source=structuredClone(record.source);Object.assign(record.source.bars[50],{high:10.5,low:9.5});Object.assign(record.source.bars.at(-1),{open:9.8,high:10,low:9.6,close:9.9});await f.saveHistory();
 const published=await f.publish();assert.equal(published.attempt.status,'complete');const view=await readStockDesk({dir:f.dir,now:now()}),row=view.close.data.current.find(row=>row.familyId==='daily-setup-watch');assert.ok(row);assert.equal(row.code,record.stock.code);assert.equal(row.research.plan.kind,'range-support');assert.equal(row.research.plan.holdingRequired,true);assert.equal(row.qualified,false);assert.equal(view.close.data.marketContext.position.coverage.total,1000);assert.deepEqual(view.close.data.tracks[0].original,f.report.tracks[0].original);
 const options={dir:f.dir,generation:batch.generation,code:row.code,kind:row.research.plan.kind,window:60,now:now()},chart=await readContextChart(options);assert.match(chart.body.toString(),/data-normalization="first-close-percent"/);assert.equal(await readContextChart({...options,kind:'trend-pullback'}),null);assert.equal(await readContextChart({...options,generation:'2026-01-01-1'}),null);
 const cache=createAShareCache({directory:f.dir}),url=new URL(row.chartUrls[60],'http://local'),response={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};await cache.handle({method:'GET',headers:{}},response,{path:url.pathname,url,json:(res,status,value)=>{res.status=status;res.value=value;}});assert.equal(response.status,200);assert.match(response.headers['content-type'],/image\/svg/);
 const context=join(f.target,contextFilename+'.json'),saved=await readFile(context,'utf8');await f.publish();assert.equal(await readFile(context,'utf8'),saved);await unlink(context);assert.equal((await readStockDesk({dir:f.dir,now:now()})).close.status,'ready');
});
test('failed preference keeps previous workbench marker and source pointer intact',async t=>{
  const f=await fixture(t);await f.publish();const pointer=await readFile(join(f.dir,directoryName,'current.json'),'utf8'),source=await readFile(join(f.dir,'current.json'),'utf8');
  const result=await runStockDesk({dir:f.dir,siteDir,now,track:f.track,precompute:async()=>{throw Error('archive truncated');}});assert.equal(result.attempt.status,'failed');assert.equal(result.attempt.error,'archive truncated');assert.equal(await readFile(join(f.dir,directoryName,'current.json'),'utf8'),pointer);assert.equal(await readFile(join(f.dir,'current.json'),'utf8'),source);assert.equal((await readStockDesk({dir:f.dir,now:now()})).close.status,'ready');
});
test('uses the exact frozen roster and caps selected enrichment; does not request again on a checked CN day',async t=>{
  const f=await fixture(t);let calls=0;
  const collectInstitutions=async options=>{calls++;assert.equal(options.allowedUniverse.length,1000);assert.deepEqual(options.selectedCodes,['600000.SH']);await save(join(f.dir,'institution-disclosures-v1','status.json'),{status:'held',checkedAt:day+'T09:30:00Z',sourceId:'cninfo-public-announcements-v1',reason:'HTTP 403'});return {status:'held',checkedAt:day+'T09:30:00Z',reason:'HTTP 403'};};
  assert.equal((await runStockDesk({dir:f.dir,siteDir,now,track:f.track,precompute:f.precompute,collectInstitutions})).attempt.status,'complete');
  const again=await runStockDesk({dir:f.dir,siteDir,now,track:f.track,precompute:f.precompute,collectInstitutions});assert.equal(calls,1);assert.equal(again.attempt.institutions.skipped,'already_checked_today');assert.equal((await readStockDesk({dir:f.dir,now:now()})).institutions.status,'held');
});
test('institution network failure is isolated, with previous verified records retained',async t=>{
  const f=await fixture(t),record={id:'1',code:'600000.SH',title:'合成披露记录',sourceDate:'2026-11-19',firstSeenAt:'2026-11-19T09:00:00Z'},root=join(f.dir,'institution-disclosures-v1'),file='2026-11-19/2026-11-19T09-00-00-000Z.json';
  await save(join(root,file),{status:'complete',sourceId:'cninfo-public-announcements-v1',checkedAt:'2026-11-19T09:00:00Z',byCode:{'600000.SH':[record]}});await save(join(root,'current.json'),{sourceId:'cninfo-public-announcements-v1',file});
  let calls=0;const collectInstitutions=async()=>{calls++;throw Error('source failed');};
  const result=await runStockDesk({dir:f.dir,siteDir,now,track:f.track,precompute:f.precompute,collectInstitutions});assert.equal(result.attempt.status,'complete');
  const view=await readStockDesk({dir:f.dir,now:now()});assert.equal(view.close.status,'ready');assert.equal(view.institutions.status,'failed');assert.equal(view.institutions.reason,'source failed');assert.deepEqual(view.institutions.byCode['600000.SH'],[record]);assert.deepEqual(view.close.data.current[0].research.institutionalEvidence,[record]);
  await runStockDesk({dir:f.dir,siteDir,now,track:f.track,precompute:f.precompute,collectInstitutions});assert.equal(calls,1);
});
test('wrong source roster or source changed during production cannot silently publish',async t=>{
  const f=await fixture(t);let calls=0;const db=new DatabaseSync(join(f.dir,'collector.sqlite'));db.prepare('UPDATE batches_v2 SET as_of=?').run('wrong');db.close();
  const result=await runStockDesk({dir:f.dir,siteDir,now,track:f.track,precompute:f.precompute,collectInstitutions:async()=>{calls++;}});assert.equal(calls,0);assert.equal(result.attempt.institutions.status,'failed');assert.match(result.attempt.institutions.reason,/matching frozen/);
  const before=await readFile(join(f.dir,directoryName,'current.json'),'utf8');const changed=await runStockDesk({dir:f.dir,siteDir,now,track:f.track,precompute:async()=>{await save(join(f.dir,'current.json'),{...batch,generation:day+'-999'});return f.pref;}});assert.equal(changed.attempt.status,'failed');assert.match(changed.attempt.error,/changed/);assert.equal(await readFile(join(f.dir,directoryName,'current.json'),'utf8'),before);
});
test('14:00 snapshot date and per-cohort times remain independent of the completed close batch',async t=>{
  const f=await fixture(t);await f.publish();const intraday=await publishA14(f.dir),later=Date.parse('2026-11-23T08:00:00Z'),view=await readStockDesk({dir:f.dir,now:later});assert.equal(view.a14.status,'ready');assert.equal(view.a14.data.day,'2026-11-23');assert.equal(view.close.data.day,day);assert.notEqual(view.a14.data.current[0].asOf,view.a14.data.current[1].asOf);assert.deepEqual(view.a14.data.tracks,intraday.tracks);assert.equal(view.a14.data.current[0].active,false);assert.equal(view.a14.data.current[0].displayState,'expired');assert.equal(view.a14.data.liveCandidateCount,0);
});
test('projects matured close-ledger outcomes into frozen14 view without rewriting the original file',async t=>{
  const f=await fixture(t);await f.publish();const intraday=await publishA14(f.dir,{quoteDay:'2026-11-26',second:false}),track=structuredClone(intraday.tracks[0]);
  // After Thursday 11/26, the next three actual sessions are Friday, Monday and Tuesday.
  const future={...batch,generation:'2026-12-01-1796108400000',day:'2026-12-01',asOf:'2026-12-01T07:00:00.000Z'},target=join(f.dir,'generations',future.generation);
  track.observations={3:{status:'ready',targetDay:future.day,returnPercent:2,generation:future.generation,sourceId:future.sourceId,asOf:future.asOf,method:'intraday_reference_rebased_to_same_batch_qfq_not_trade_return'}};
  Object.assign(f.report,future,{computedAt:'2026-12-01T09:00:00Z',current:[]});f.report.tracks.push(track);Object.assign(f.pref,future);
  await save(join(target,'complete.json'),{...future,completed:true});await save(join(target,trackingDirectory,'report.json'),f.report);await save(join(target,preferenceFilename+'.json'),f.pref);await save(join(f.dir,directoryName,'current.json'),{schema,...future});
  const file=join(f.dir,'intraday-preselection-v1','days',intraday.day,'report.json'),original=await readFile(file,'utf8'),view=await readStockDesk({dir:f.dir,now:Date.parse('2026-12-01T10:00:00Z')});
  assert.equal(view.a14.data.current[0].observations[3].returnPercent,2);assert.equal(view.a14.data.tracks[0].observations[3].returnPercent,2);assert.equal(view.a14.data.observationDay,future.day);assert.equal(view.a14.data.observationGeneration,future.generation);assert.equal(view.a14.data.observationAsOf,future.asOf);assert.equal(view.a14.data.day,intraday.day);assert.equal(view.a14.data.asOf,intraday.asOf);assert.equal(await readFile(file,'utf8'),original);assert.equal(view.a14.data.tracks[0].original.firstSeenAt,intraday.current[0].firstSeenAt);
});
test('rejects 14 window forgery and unpublished archive mutation while retaining close data',async t=>{
  const f=await fixture(t);await f.publish();const report=await publishA14(f.dir),root=join(f.dir,'intraday-preselection-v1');report.current[0].quoteSourceAt=report.day+'T06:11:00Z';await save(join(root,'current.json'),report);await save(join(root,'days',report.day,'report.json'),report);
  let view=await readStockDesk({dir:f.dir,now:Date.parse('2026-11-23T08:00:00Z')});assert.equal(view.close.status,'ready');assert.equal(view.a14.status,'unavailable');assert.equal(view.a14.data,null);
  const good=await publishA14(f.dir);good.current[0].name='unpublished';await save(join(root,'current.json'),good);view=await readStockDesk({dir:f.dir,now:Date.parse('2026-11-23T08:00:00Z')});assert.equal(view.a14.data,null);assert.match(view.a14.reason,/frozen archive/);
});
test('derived14 chart serves only currently published day/code/windows, with gzip restoration',async t=>{
  const f=await fixture(t);await publishA14(f.dir);const options={dir:f.dir,day:'2026-11-23',code:'600000.SH',window:60,now:Date.parse('2026-11-23T08:00:00Z')};
  const compressed=await readA14Chart({...options,compressed:true});assert.match(gunzipSync(compressed.body).toString(),/derived/);await unlink(join(f.dir,'intraday-preselection-v1','days',options.day,'charts','600000.SH-60.svg'));assert.match((await readA14Chart(options)).body.toString(),/derived/);
  for(const change of [{day:'2026-11-24'},{code:'600999.SH'},{code:'300001.SZ'},{day:'../../private'},{window:5}])assert.equal(await readA14Chart({...options,...change}),null);
});
test('workbench and a14-chart GETs are read-only, no private quote routes or source requests',async t=>{
  const f=await fixture(t);await f.publish();await publishA14(f.dir);const cache=createAShareCache({directory:f.dir}),old=globalThis.fetch;let requests=0;globalThis.fetch=()=>{requests++;throw Error('network prohibited');};t.after(()=>{globalThis.fetch=old;});
  async function request(path,headers={},method='GET'){
    const url=new URL(path,'http://local'),res={writeHead(status,values){this.status=status;this.headers=values;},end(body){this.body=body;}},json=(res,status,value)=>{res.status=status;res.value=value;};await cache.handle({method,headers},res,{path:url.pathname,url,json});return res;
  }
  assert.equal((await request('/api/a-share-daily/workbench')).value.schema,schema);assert.equal((await request('/api/a-share-daily/workbench?generation=x')).status,400);assert.equal((await request('/api/a-share-daily/workbench',{},'POST')).status,405);
  const chart=await request('/api/a-share-daily/a14-chart?day=2026-11-23&code=600000.SH&window=60',{'accept-encoding':'gzip'});assert.equal(chart.status,200);assert.match(chart.headers['content-type'],/image\/svg/);assert.equal(chart.headers['content-encoding'],'gzip');assert.match(gunzipSync(chart.body).toString(),/derived/);
  assert.equal((await request('/api/a-share-daily/a14-chart?day=2026-11-23&code=600999.SH&window=60')).status,404);assert.equal((await request('/api/a-share-daily/private-quotes')).status,404);assert.equal(requests,0);
});
test('gzip-only close artifacts remain readable and current eligibility expires at serving time',async t=>{
  const f=await fixture(t);await f.publish();for(const file of [join(f.target,trackingDirectory,'report.json'),join(f.target,preferenceFilename+'.json')]){await writeFile(file+'.gz',gzipSync(await readFile(file)));await unlink(file);}
  const view=await readStockDesk({dir:f.dir,now:Date.parse('2026-11-23T02:00:00Z')});assert.equal(view.close.status,'ready');assert.equal(view.close.data.current[0].active,false);assert.equal(view.close.data.current[0].displayState,'expired');assert.equal(view.close.data.current[0].qualified,false);assert.equal(view.close.data.liveCandidateCount,0);
});

test('collects real disclosure evidence before independent watches, then freezes those rows in the first tracker publication',async t=>{
  const f=await fixture(t),stock=f.records[1];stock.source=structuredClone(stock.source);stock.source.bars.at(-1).close=11;stock.source.bars.at(-1).high=11;stock.source.bars.at(-1).open=10.1;await f.saveHistory();
  const steps=[],collectInstitutions=async()=>{steps.push('institutions');return {status:'complete',checkedAt:day+'T09:59:00Z',sourceId:'cninfo-public-announcements-v1',byCode:{}};};
  const track=async options=>{steps.push('tracker');assert.equal(options.additionalCurrent.length,1);assert.equal(options.additionalCurrent[0].code,'600001.SH');assert.equal(options.additionalCurrent[0].qualified,false);assert.equal(options.additionalCurrent[0].state,'watch');assert.match(await readFile(join(f.target,watchChartDirectory,'600001.SH-60.svg'),'utf8'),/data-normalization="first-close-percent"/);return f.track(options);};
  const precompute=async options=>{steps.push('preference');return f.precompute(options);};
  const result=await runStockDesk({dir:f.dir,siteDir,now,track,precompute,collectInstitutions});assert.equal(result.attempt.status,'complete');assert.deepEqual(steps,['institutions','tracker','preference']);
  const view=await readStockDesk({dir:f.dir,now:now()}),row=view.close.data.current.find(item=>item.code==='600001.SH');assert.equal(row.state,'watch');assert.equal(row.qualified,false);assert.equal(row.reference.trigger,null);assert.equal(row.firstSeenAt,new Date(now()).toISOString());assert.equal(view.close.data.tracks.find(item=>item.id===row.id).original.familyId,'close-limitup-watch');assert.deepEqual(view.close.data.tracks[0].original,f.report.tracks[0].original);
  const chart=await readWorkbenchChart({dir:f.dir,generation:batch.generation,code:row.code,window:60,compressed:true});assert.match(gunzipSync(chart.body).toString(),/收盘观察/);assert.doesNotMatch(gunzipSync(chart.body).toString(),/data-kind="B"|data-unclosed/);
});
test('watch chart API only serves an own-published same-generation listed normalized artifact, never private files',async t=>{
  const f=await fixture(t),stock=f.records[1];stock.source=structuredClone(stock.source);Object.assign(stock.source.bars.at(-1),{open:10.1,high:11,close:11});await f.saveHistory();await f.publish();
  const cache=createAShareCache({directory:f.dir}),request=async path=>{const url=new URL(path,'http://local'),res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};await cache.handle({method:'GET',headers:{}},res,{path:url.pathname,url,json:(r,status,value)=>{r.status=status;r.value=value;}});return res;};
  const path='/api/a-share-daily/workbench-chart?'+new URLSearchParams({generation:batch.generation,code:'600001.SH',window:'60'}),served=await request(path);assert.equal(served.status,200);assert.match(served.headers['content-type'],/image\/svg/);
  assert.equal((await request(path.replace('600001.SH','600999.SH'))).status,404);assert.equal((await request(path+'&file=private-quotes.json')).status,400);assert.equal((await request(path.replace(batch.generation,day+'-999'))).status,404);
  const file=join(f.target,watchFilename+'.json'),report=JSON.parse(await readFile(file));report.charts[0].path='../private/history-all.ndjson';await save(file,report);assert.equal((await request(path)).status,404);
});
test('partial institution coverage maps to ready with an explicit warning while verified older rows remain visible',async t=>{
  const f=await fixture(t),root=join(f.dir,'institution-disclosures-v1'),file=day+'/'+day+'T09-30-00-000Z.json',record={id:'10',code:'600000.SH',title:'合成已核实披露',firstSeenAt:day+'T09:00:00Z'},value={status:'partial',sourceId:'cninfo-public-announcements-v1',checkedAt:day+'T09:30:00Z',byCode:{'600000.SH':[record]},reason:'本次分页不完整；保留逐条已核对记录。'};
  await save(join(root,file),value);await save(join(root,'current.json'),{sourceId:value.sourceId,file});await save(join(root,'status.json'),{status:'partial',sourceId:value.sourceId,checkedAt:value.checkedAt,reason:value.reason});await f.publish();
  const view=await readStockDesk({dir:f.dir,now:now()});assert.equal(view.institutions.status,'ready');assert.equal(view.institutions.partial,true);assert.match(view.institutions.reason,/分页不完整/);assert.deepEqual(view.institutions.byCode['600000.SH'],[record]);assert.equal(view.close.status,'ready');
});
test('corrupt optional institution state does not discard close tracking or manufacture evidence',async t=>{
  const f=await fixture(t),root=join(f.dir,'institution-disclosures-v1');await mkdir(root);await writeFile(join(root,'status.json'),'broken');assert.equal((await f.publish()).attempt.status,'complete');
  const view=await readStockDesk({dir:f.dir,now:now()});assert.equal(view.close.status,'ready');assert.equal(view.institutions.status,'failed');assert.deepEqual(view.institutions.byCode,{});assert.deepEqual(view.close.data.current[0].research.institutionalEvidence,[]);
});

function presentationRow(base,index,pattern,extra={}){
  const row={...structuredClone(base),code:String(600000+index)+'.SH',ruleIds:[pattern],setupId:'setup-'+index,...extra};row.id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);return row;
}
const adequateRank=(patternId,rank,extra={})=>({patternId,rank,regime:'sideways',adequate:true,sampleCount:30,stockCount:10,signalDayCount:10,eligibleForSelection:false,...extra});
async function presentRows(f,rows,ranking){
  await f.publish();f.report.current=rows;f.report.tracks=rows.map(row=>({id:row.id,firstSeenAt:row.firstSeenAt,original:structuredClone(row),observations:{}}));f.pref.adequateRanking=ranking;f.pref.byRegime=[{regime:'sideways',patterns:ranking}];
  const file=join(f.target,trackingDirectory,'report.json');await save(file,f.report);await save(join(f.target,preferenceFilename+'.json'),f.pref);return {file,before:await readFile(file)};
}
test('existing adequate regime ranks reorder trend slots only within the same state and qualification layer',async t=>{
  const f=await fixture(t),base=f.report.current[0],rows=[presentationRow(base,0,'third'),presentationRow(base,1,'first',{strategy:'short-term',state:'watch'}),presentationRow(base,2,'third',{ruleIds:['third','first']}),presentationRow(base,3,'third',{state:'triggered_B'}),presentationRow(base,4,'first',{strategy:'institution',state:'watch'}),presentationRow(base,5,'second'),presentationRow(base,6,'third',{qualified:true}),presentationRow(base,7,'first',{state:'watch'})];
  const frozen=await presentRows(f,rows,[adequateRank('first',1),adequateRank('second',2),adequateRank('third',3)]),view=await readStockDesk({dir:f.dir,now:now()});
  assert.deepEqual(view.close.data.current.map(row=>row.id),[rows[2],rows[1],rows[5],rows[3],rows[4],rows[0],rows[6],rows[7]].map(row=>row.id));assert.deepEqual(await readFile(frozen.file),frozen.before);assert.deepEqual(view.close.data.tracks.map(track=>track.original),rows);
});
test('insufficient samples and other regimes cannot borrow a rank or promote an unqualified row',async t=>{
  const f=await fixture(t),base=f.report.current[0],rows=[presentationRow(base,0,'other-regime'),presentationRow(base,1,'too-small'),presentationRow(base,2,'adequate'),presentationRow(base,3,'unknown')];
  const frozen=await presentRows(f,rows,[adequateRank('other-regime',1,{regime:'bull'}),adequateRank('too-small',1,{sampleCount:29}),adequateRank('adequate',3)]),view=await readStockDesk({dir:f.dir,now:now()});
  assert.deepEqual(view.close.data.current.map(row=>row.id),[rows[2],rows[0],rows[1],rows[3]].map(row=>row.id));assert(view.close.data.current.every(row=>row.qualified===false));assert.deepEqual(await readFile(frozen.file),frozen.before);
});
test('equal or unavailable ranks preserve original setup order, including multiple setups for one code',async t=>{
  const f=await fixture(t),base=f.report.current[0],rows=[presentationRow(base,0,'tie'),presentationRow(base,1,'tie',{code:'600000.SH'}),presentationRow(base,2,'tie'),presentationRow(base,3,'unknown-a'),presentationRow(base,4,'unknown-b')];
  const original=structuredClone(rows),frozen=await presentRows(f,rows,[adequateRank('tie',2)]),view=await readStockDesk({dir:f.dir,now:now()});
  assert.deepEqual(view.close.data.current.map(row=>row.id),rows.map(row=>row.id));assert.deepEqual(rows,original);assert.deepEqual(view.close.data.tracks.map(track=>track.original),original);assert.deepEqual(await readFile(frozen.file),frozen.before);
});
