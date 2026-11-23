import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createSchemeStore} from '../server/a-share-schemes.mjs';
import {createSchemeApi} from '../server/a-share-schemes-api.mjs';

const require=createRequire(import.meta.url),model=require('../control/model.js'),patterns=require('../screening/trend-patterns.js');
const day='2026-11-20',copy=value=>JSON.parse(JSON.stringify(value));
const selection={patternId:'',qualification:'strict',scopeCodes:null};
function fixture(t){
  const db=new DatabaseSync(':memory:');let tick=0;db.exec("CREATE TABLE existing_data(value TEXT); INSERT INTO existing_data VALUES('preserved')");
  const options={db,model,patterns,now:()=>Date.UTC(2026,10,20,13)+tick++},store=createSchemeStore(options);t.after(()=>db.close());return {db,store,reopen:()=>createSchemeStore(options)};
}
const save=(store,input={})=>store.save({ownerId:'owner_a',name:'初期转强方案',config:{settings:{mode:'strength',limits:{maxReturn5:5}}},selection:copy(selection),...input});
const begin=(store,scheme,input={})=>store.beginRun({schemeId:scheme.id,revision:scheme.revision,day,generation:day+'-real-1',sourceId:'tickflow-free-forward-v1',asOf:day+'T15:00:00+08:00',engineVersion:model.engineVersion,patternVersion:patterns.version,kind:'daily',...input});
const record=(code='600519.SH')=>({stock:{code,name:'测试股票'},selected:true,confirmedSelected:true,change:'new',result:{status:'ready',matched:true,metrics:{periodReturn:2,periodRangePercent:6,crossAgeDays:1}},patterns:{version:patterns.version,facts:{volume:{ratio:1.1,return5Pct:1},profile:{maPeriods:[5,10,20]}}}});
const track=(scheme,run,input={})=>({id:'episode_a',schemeId:scheme.id,revision:scheme.revision,code:'600519.SH',name:'测试股票',entryDay:run.day,knownAt:run.startedAt,enteredRunId:run.id,exitDay:null,observations:{'1':{status:'pending',returnPercent:null,day:null,reason:'尚未到期'}},sourceId:run.sourceId,engineVersion:run.engineVersion,patternVersion:run.patternVersion,anchorGeneration:run.generation,observationMethod:'same-batch-qfq-close-ratio',...input});
const complete=(store,run,input={})=>store.finishRun({runId:run.id,records:[record()],summary:{selected:1,new:1,continued:0,exited:0,unknown:0},...input});

test('named saves create independent immutable versions and force the effective full-market scope',t=>{
  const {store,db}=fixture(t),input={settings:{sampleSize:'120',direction:'up',patterns:{nearPct:3}}},before=JSON.stringify(input),first=save(store,{config:input,selection:{...selection,patternId:patterns.definitions[0].id}});
  assert.equal(first.revision,1);assert.equal(first.config.name,first.name);assert.equal(first.config.settings.sampleSize,'all');assert.equal(first.config.settings.patterns.nearPct,3);assert.equal(first.attempt,null);assert.equal(first.lastSuccess,null);assert.equal(JSON.stringify(input),before);assert.equal(first.ownerId,undefined);
  const second=save(store,{id:first.id,expectedRevision:1,name:'调整后的方案',config:{settings:{direction:'down'}},enabled:false});assert.equal(second.revision,2);assert.equal(second.enabled,false);
  const old=JSON.parse(db.prepare('SELECT config_json FROM screening_scheme_version WHERE scheme_id=? AND revision=1').get(first.id).config_json);assert.equal(old.name,'初期转强方案');assert.equal(old.settings.direction,'up');assert.equal(store.get(first.id).name,'调整后的方案');assert.equal(db.prepare('SELECT value FROM existing_data').get().value,'preserved');
  second.config.settings.direction='sideways';assert.equal(store.get(first.id).config.settings.direction,'down');
});
test('optimistic saves and owner-scoped mutations fail without writing another version',t=>{
  const {store,db}=fixture(t),a=save(store),b=save(store,{ownerId:'owner_b',name:'另一位的方案'});
  for(const input of [{id:a.id,expectedRevision:0},{id:a.id},{ownerId:'owner_b',id:a.id,expectedRevision:1}])assert.throws(()=>save(store,input),error=>error.status===(input.ownerId?404:409));
  assert.equal(db.prepare('SELECT count(*) AS n FROM screening_scheme_version').get().n,2);assert.deepEqual(store.list({ownerId:'owner_a'}).map(item=>item.id),[a.id]);assert.deepEqual(store.list({ownerId:'owner_b'}).map(item=>item.id),[b.id]);assert.equal(store.list().length,2);
  assert.throws(()=>store.setEnabled({ownerId:'owner_b',id:a.id,enabled:false}),error=>error.status===404);assert.equal(store.get(a.id).enabled,true);assert.equal(store.setEnabled({ownerId:'owner_a',id:a.id,enabled:false}).enabled,false);
  assert.throws(()=>save(store,{ownerId:''}),error=>error.status===400);assert.equal(store.get('unknown'),null);
});
test('selection strictly preserves pattern, qualification and deduplicated scope including an explicit empty scope',t=>{
  const {store}=fixture(t),scope=['600519.SH','000001.SZ','600519.SH'];
  const a=save(store,{selection:{patternId:patterns.definitions.at(-1).id,qualification:'observation',scopeCodes:scope}});assert.deepEqual(a.selection.scopeCodes,['600519.SH','000001.SZ']);assert.deepEqual(scope,['600519.SH','000001.SZ','600519.SH']);
  assert.deepEqual(save(store,{selection:{...selection,scopeCodes:[]}}).selection.scopeCodes,[]);
  const marketWide=save(store,{config:{settings:{mode:'consensus'}},selection:{...selection,scopeCodes:['600519.SH']}});assert.equal(marketWide.selection.scopeCodes,null);assert.equal(marketWide.config.settings.sampleSize,'all');
  for(const bad of [undefined,null,{}, {...selection,patternId:'invented'}, {...selection,qualification:'anything'}, {...selection,scopeCodes:undefined},{...selection,scopeCodes:['000300.SH']},{...selection,scopeCodes:['830001.BJ']},{...selection,scopeCodes:['600519']},{...selection,extra:'not allowed'}])assert.throws(()=>save(store,{selection:bad}));
  for(const name of ['', 'x'.repeat(81),'<script>'])assert.throws(()=>save(store,{name}));
  for(const config of [null,[],{settings:{mode:'other'}},{settings:{strength:{crossWithinDays:21}}}])assert.throws(()=>save(store,{config}),error=>error.status===400);
});
test('the same scheme revision, day and method complete once regardless of generation',t=>{
  const {store}=fixture(t),scheme=save(store),run=begin(store,scheme);
  assert.equal(run.status,'running');assert.equal(run.id,store.get(scheme.id).attempt.id);assert.throws(()=>begin(store,scheme),error=>error.status===409);
  const finished=complete(store,run),before=JSON.stringify(finished),again=begin(store,scheme,{generation:day+'-offline-2'});assert.equal(again.skipped,true);assert.equal(again.run.id,run.id);assert.equal(JSON.stringify(again.run),before);assert.equal(store.runs(scheme.id).length,1);assert.equal(store.latestRun(scheme.id).id,run.id);
  assert.deepEqual(complete(store,run,{records:[record('000001.SZ')]}),finished);assert.equal(store.failRun(run.id,'late error').status,'complete');
});
test('same-day source, engine and pattern changes create independent method results while running work still blocks other methods',t=>{
  const {store,db}=fixture(t),scheme=save(store),first=begin(store,scheme);
  assert.throws(()=>begin(store,scheme,{engineVersion:'next-engine'}),error=>error.code==='run_in_progress');
  complete(store,first);const original=store.getRun(first.id);
  for(const method of [{sourceId:'next-provider'},{engineVersion:'next-engine'},{patternVersion:'next-pattern'}]){
    const run=begin(store,scheme,{...method,kind:'baseline'});assert.equal(run.skipped,undefined);complete(store,run,{records:[],summary:{isBaseline:true,new:0}});
    const again=begin(store,scheme,{...method,generation:day+'-another-generation'});assert.equal(again.skipped,true);assert.equal(again.run.id,run.id);
  }
  assert.equal(store.runs(scheme.id).length,4);assert.deepEqual(store.getRun(first.id),original);
  const changed=store.runs(scheme.id).find(run=>run.engineVersion==='next-engine');
  assert.throws(()=>db.prepare('UPDATE screening_scheme_run SET engine_version=? WHERE id=?').run(model.engineVersion,changed.id),/UNIQUE/);
  assert.equal(store.getRun(changed.id).engineVersion,'next-engine');
});
test('legacy completed-day index migrates atomically without changing stored runs or episodes',t=>{
  const {store,db,reopen}=fixture(t),scheme=save(store),run=begin(store,scheme),episode=track(scheme,run);complete(store,run,{tracks:[episode]});
  db.exec("DROP INDEX screening_scheme_completed_method; CREATE UNIQUE INDEX screening_scheme_completed_day ON screening_scheme_run(scheme_id,revision,day) WHERE status='complete'");
  const runs=db.prepare('SELECT * FROM screening_scheme_run').all(),tracks=db.prepare('SELECT * FROM screening_scheme_track').all(),second=reopen();
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row=>row.name);
  assert(names.includes('screening_scheme_completed_method'));assert(!names.includes('screening_scheme_completed_day'));
  assert.deepEqual(db.prepare('SELECT * FROM screening_scheme_run').all(),runs);assert.deepEqual(db.prepare('SELECT * FROM screening_scheme_track').all(),tracks);
  const upgraded=begin(second,scheme,{engineVersion:'upgraded-engine',kind:'baseline'});complete(second,upgraded,{records:[],summary:{new:0}});
  assert.equal(second.runs(scheme.id).length,2);assert.deepEqual(second.getRun(run.id),store.getRun(run.id));assert.deepEqual(second.tracks(scheme.id),[episode]);
  assert.equal(begin(reopen(),scheme,{engineVersion:'upgraded-engine'}).skipped,true);
});
test('a failed index migration rolls back and can be retried without dropping old uniqueness or data',t=>{
  const {store,db,reopen}=fixture(t),scheme=save(store),run=begin(store,scheme);complete(store,run);
  db.exec("DROP INDEX screening_scheme_completed_method; CREATE UNIQUE INDEX screening_scheme_completed_day ON screening_scheme_run(scheme_id,revision,day) WHERE status='complete'; CREATE TABLE screening_scheme_completed_method(value TEXT)");
  const before=db.prepare('SELECT * FROM screening_scheme_run').all();assert.throws(()=>reopen());
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='screening_scheme_completed_day'").get());assert.deepEqual(db.prepare('SELECT * FROM screening_scheme_run').all(),before);
  db.exec('DROP TABLE screening_scheme_completed_method');assert.equal(begin(reopen(),scheme).skipped,true);assert.deepEqual(db.prepare('SELECT * FROM screening_scheme_run').all(),before);
});
test('failed attempts retain previous success and retry the same day without manufacturing exits',t=>{
  const {store}=fixture(t),scheme=save(store),first=begin(store,scheme);complete(store,first);
  const second=begin(store,scheme,{day:'2026-11-23',asOf:'2026-11-23T15:00:00+08:00'});store.failRun(second.id,new Error('source unavailable <html>'));
  const view=store.get(scheme.id);assert.equal(view.lastSuccess.id,first.id);assert.equal(view.attempt.status,'error');assert.deepEqual(store.getRun(second.id).records,[]);assert.equal(store.getRun(second.id).summary,null);assert.equal(store.latestRun(scheme.id).day,day);
  const retry=begin(store,scheme,{day:'2026-11-23',asOf:'2026-11-23T15:00:00+08:00'});complete(store,retry,{records:[],summary:{selected:0,new:0,continued:0,exited:0,unknown:1}});assert.equal(store.get(scheme.id).lastSuccess.id,retry.id);assert.equal(store.runs(scheme.id).length,3);
  assert.throws(()=>begin(store,scheme,{day:'2026-11-19'}),error=>error.status===409&&error.code==='data_day_regression');
});
test('a new version starts its own same-day run without overwriting the prior version snapshot',t=>{
  const {store,db}=fixture(t),one=save(store),runOne=begin(store,one);complete(store,runOne);
  const two=save(store,{id:one.id,expectedRevision:1,name:'新口径',selection:{...selection,qualification:'observation'}}),runTwo=begin(store,two,{kind:'baseline'});complete(store,runTwo,{summary:{baseline:true,selected:1}});
  assert.equal(store.runs(one.id).length,2);assert.equal(store.latestRun(one.id).revision,2);assert.equal(store.getRun(runOne.id).revision,1);assert.equal(store.getRun(runTwo.id).kind,'baseline');
  assert.equal(store.getRun(runOne.id).selection.qualification,'strict');assert.equal(store.getRun(runOne.id).config.name,'初期转强方案');assert.equal(store.getRun(runTwo.id).selection.qualification,'observation');assert.equal(store.getRun(runTwo.id).config.name,'新口径');assert.equal(store.runs(one.id)[0].config,undefined);
  assert.equal(JSON.parse(db.prepare('SELECT selection_json FROM screening_scheme_version WHERE scheme_id=? AND revision=1').get(one.id).selection_json).qualification,'strict');assert.equal(store.get(one.id).selection.qualification,'observation');
});
test('finish atomically saves derived records, episode identities and cross-revision follow-up observations',t=>{
  const {store}=fixture(t),one=save(store),runOne=begin(store,one),episode=track(one,runOne);complete(store,runOne,{tracks:[episode]});
  const two=save(store,{id:one.id,expectedRevision:1}),runTwo=begin(store,two,{day:'2026-11-23',asOf:'2026-11-23T15:00:00+08:00'}),next=track(two,runTwo,{id:'episode_b'}),updated={...episode,exitDay:'2026-11-23',observations:{'1':{status:'ready',returnPercent:1.25,day:'2026-11-23',reason:null}}};
  complete(store,runTwo,{tracks:[updated,next]});assert.equal(store.tracks(one.id).length,2);assert.equal(store.tracks(one.id,{revision:1}).length,1);assert.equal(store.tracks(one.id,{revision:2})[0].enteredRunId,runTwo.id);assert.equal(store.tracks(one.id,{revision:1})[0].observations['1'].returnPercent,1.25);
  const read=store.tracks(one.id);read[0].observations={};assert.notDeepEqual(store.tracks(one.id)[0].observations,{});assert.equal(store.getRun(runTwo.id).records[0].patterns.facts.volume.ratio,1.1);
});
test('invalid tracks or raw prices roll the whole finish back and preserve the last success',t=>{
  const {store}=fixture(t),scheme=save(store),run=begin(store,scheme),episode=track(scheme,run);
  assert.throws(()=>complete(store,run,{tracks:[episode,{...episode,id:'invalid_episode',enteredRunId:'not_a_run'}]}));assert.equal(store.tracks(scheme.id).length,0);assert.equal(store.getRun(run.id).status,'running');assert.equal(store.get(scheme.id).lastSuccess,null);
  for(const payload of [{records:[{...record(),source:{bars:[{date:day,close:123}]}}]},{records:[{...record(),result:{metrics:{startClose:100,endClose:110}}}]},{summary:{price:1}},{tracks:[{...episode,observations:{'1':{status:'ready',entryPrice:100,returnPercent:2}}}]}])assert.throws(()=>complete(store,run,payload),error=>error.code==='raw_data_not_allowed');
  assert.equal(store.tracks(scheme.id).length,0);assert.equal(store.getRun(run.id).status,'running');assert.deepEqual(store.getRun(run.id).records,[]);
});
test('follow-up writes preserve immutable entry and confirmed exit identities',t=>{
  const {store}=fixture(t),scheme=save(store),run=begin(store,scheme),episode=track(scheme,run);complete(store,run,{tracks:[episode]});
  const exited={...episode,exitDay:'2026-11-23'};store.updateTracks([exited]);
  for(const changed of [{...exited,entryDay:'2026-11-19'},{...exited,code:'000001.SZ'},{...exited,knownAt:'2026-11-21T00:00:00Z'},{...exited,exitDay:null}])assert.throws(()=>store.updateTracks([changed]));
  const ready={...exited,observations:{'20':{status:'unavailable',returnPercent:null,day:null,reason:'缺少目标交易日'}}};store.updateTracks([ready]);assert.deepEqual(store.tracks(scheme.id)[0],ready);
});
test('store recreation preserves successful state without interrupting another running worker',t=>{
  const {store,reopen}=fixture(t),scheme=save(store),run=begin(store,scheme),second=reopen();assert.equal(second.getRun(run.id).status,'running');complete(second,run);assert.equal(store.latestRun(scheme.id).id,run.id);assert.equal(second.get(scheme.id).lastSuccess.status,'complete');
});
test('unsafe JSON does not execute accessors or store sparse/nonfinite derived results',t=>{
  const {store}=fixture(t),scheme=save(store),run=begin(store,scheme);let getterCalls=0;
  const data=record();Object.defineProperty(data,'extra',{enumerable:true,get(){getterCalls++;return 1;}});assert.throws(()=>complete(store,run,{records:[data]}));assert.equal(getterCalls,0);
  const sparse=[record(),record()];delete sparse[0];assert.throws(()=>complete(store,run,{records:sparse}));assert.throws(()=>complete(store,run,{summary:{returnPercent:NaN}}));assert.equal(store.getRun(run.id).status,'running');
});
test('completed observations cannot be overwritten or dropped by a later generation',t=>{
  const {store}=fixture(t),scheme=save(store),run=begin(store,scheme),episode=track(scheme,run,{observations:{'1':{status:'ready',returnPercent:1.25,day:'2026-11-23',generation:'first-complete'},'3':{status:'not_observable',returnPercent:null,reason:'不回填已知时间前数据'}}});complete(store,run,{tracks:[episode]});
  for(const observations of [{...episode.observations,'1':{...episode.observations['1'],returnPercent:9}}, {'3':episode.observations['3']},{...episode.observations,'3':{status:'ready',returnPercent:1}}])assert.throws(()=>store.updateTracks([{...episode,observations}]),error=>error.status===409&&error.code==='observation_final');
  const extended={...episode,observations:{...episode.observations,'5':{status:'pending',returnPercent:null}}};store.updateTracks([extended]);assert.deepEqual(store.tracks(scheme.id)[0],extended);
});
test('running progress is readable and cannot overwrite a completed result',t=>{
  const {store}=fixture(t),scheme=save(store),run=begin(store,scheme);store.updateProgress(run.id,{stage:'reading_archive',checked:0,total:1000});store.updateProgress(run.id,{stage:'evaluating',checked:200,total:1000});
  assert.deepEqual(store.get(scheme.id).attempt.summary,{stage:'evaluating',checked:200,total:1000});assert.equal(store.get(scheme.id).lastSuccess,null);
  for(const progress of [{stage:'bad',checked:2,total:1},{stage:'bad',checked:-1,total:1000},{stage:'bad',checked:NaN,total:1000}])assert.throws(()=>store.updateProgress(run.id,progress),error=>error.status===400);
  const finished=complete(store,run);assert.deepEqual(store.updateProgress(run.id,{stage:'late',checked:0,total:1}),finished);assert.equal(store.get(scheme.id).lastSuccess.id,run.id);
});

test('fifteenth-session observations, policy and completed assessments are frozen with their entry method',t=>{
  const {store}=fixture(t),scheme=save(store),run=begin(store,scheme),policy={version:'close-15-return-5-v1',horizon:15,minimumReturnPercent:5,knownAt:run.startedAt};
  const episode=track(scheme,run,{policy,observations:{'15':{status:'ready',horizon:15,targetDay:'2026-12-11',returnPercent:5,generation:'verified-first'}},assessment:{status:'ready',passed:true,targetDay:'2026-12-11',returnPercent:5,observationGeneration:'verified-first'}});complete(store,run,{tracks:[episode]});
  for(const changed of [{...episode,policy:{...policy,knownAt:'2026-11-20T00:00:00Z'}},{...episode,policy:undefined},{...episode,sourceId:'changed-provider'},{...episode,engineVersion:'changed-engine'},{...episode,assessment:{...episode.assessment,passed:false}},{...episode,observations:{'15':{...episode.observations['15'],returnPercent:4.9}}}])assert.throws(()=>store.updateTracks([changed]),error=>error.status===409);
  assert.throws(()=>store.updateTracks([{...episode,policy:{...policy,horizon:14}}]),error=>error.code==='invalid_track');assert.throws(()=>store.updateTracks([{...episode,observations:{'16':{status:'pending'}}}]),error=>error.code==='invalid_track');
  assert.deepEqual(store.tracks(scheme.id),[episode]);
});

test('monitor projects current tracks after skipped-run updates without exposing internal fields or rewriting history',async t=>{
  const {store,reopen}=fixture(t),scheme=save(store),run=begin(store,scheme),episode=track(scheme,run),finished=complete(store,run,{tracks:[episode]}),before=JSON.stringify(finished);
  const context={revision:scheme.revision,sourceId:run.sourceId,engineVersion:run.engineVersion,patternVersion:run.patternVersion,day:'2026-12-11',generation:'repaired-batch',checkedAt:'2026-12-11T12:10:00Z'};
  const assessment={status:'ready',passed:false,targetDay:'2026-12-11',returnPercent:4,reason:'同批收盘变化',day:context.day,generation:'first-observation',observationGeneration:'first-observation',checkedAt:context.checkedAt};
  const elimination={targetDay:context.day,decisionDay:context.day,returnPercent:4,reason:'入选后第15个交易日收盘涨幅不足5%'};
  const closed={...episode,exitDay:context.day,assessment,elimination,monitorContext:context,ownerId:'must-not-be-published',internal:{privateValue:'must-not-be-published'}};store.updateTracks([closed]);
  const monitor=store.monitor(scheme.id);assert.equal(monitor.scope,'scheme');assert.equal(monitor.revision,scheme.revision);assert.equal(monitor.mode,scheme.config.settings.mode);assert.equal(monitor.lookback,scheme.config.settings.lookback);assert.equal(monitor.benchmark,scheme.config.settings.benchmark);assert.deepEqual(monitor.policy,{horizon:15,minimumReturnPercent:5});assert.equal(monitor.day,context.day);assert.equal(monitor.generation,context.generation);assert.deepEqual(monitor.active,[]);assert.equal(monitor.eliminated[0].code,episode.code);assert.equal(monitor.eliminated[0].assessment.generation,context.generation);assert.equal(monitor.eliminated[0].assessment.observationGeneration,'first-observation');assert.doesNotMatch(JSON.stringify(monitor),/owner|internal|privateValue|must-not-be-published|"(?:bars|prices|price|close)"/);
  const nextContext={...context,day:'2026-12-14',generation:'next-batch',checkedAt:'2026-12-14T12:10:00Z'};store.updateTracks([{...closed,monitorContext:nextContext}]);assert.equal(store.monitor(scheme.id).eliminated[0].assessment.day,nextContext.day);assert.equal(JSON.stringify(store.getRun(run.id)),before);assert.deepEqual(reopen().monitor(scheme.id),store.monitor(scheme.id));
  for(const changed of [{...closed,elimination:{...elimination,reason:'rewritten'}},{...closed,elimination:undefined}])assert.throws(()=>store.updateTracks([changed]),error=>error.status===409);
  const api=createSchemeApi({store});let response;await api.handle({method:'GET'},null,{path:'/api/a-share-daily/schemes',url:new URL('https://example.test/api/a-share-daily/schemes?id='+scheme.id),json:(_res,status,body)=>{response={status,body};}});assert.equal(response.status,200);assert.deepEqual(response.body.monitor,store.monitor(scheme.id));assert.deepEqual(response.body.latestRun,finished);
});

test('monitor separates method and revision scope while retaining a same-day elimination barrier',t=>{
  const {store}=fixture(t),one=save(store),runOne=begin(store,one),episode=track(one,runOne),context={revision:one.revision,sourceId:runOne.sourceId,engineVersion:runOne.engineVersion,patternVersion:runOne.patternVersion,day,generation:runOne.generation,checkedAt:runOne.startedAt};
  const closed={...episode,exitDay:day,assessment:{status:'ready',passed:false,targetDay:day,returnPercent:1},elimination:{targetDay:day,decisionDay:day,returnPercent:1,reason:'不足5%'},monitorContext:context};complete(store,runOne,{tracks:[closed]});
  const two=save(store,{id:one.id,expectedRevision:1}),runTwo=begin(store,two,{engineVersion:'next-engine'});complete(store,runTwo,{records:[],tracks:[{...closed,monitorContext:{...context,revision:two.revision,engineVersion:'next-engine'}}]});let monitor=store.monitor(one.id);assert.equal(monitor.engineVersion,'next-engine');assert.equal(monitor.revision,two.revision);assert.equal(monitor.active.length,0);assert.equal(monitor.eliminated.length,1);
  store.updateTracks([{...closed,monitorContext:{...context,revision:two.revision,engineVersion:'next-engine',day:'2026-11-23',generation:'next-day'}}]);monitor=store.monitor(one.id);assert.equal(monitor.eliminated.length,0);assert.equal(store.tracks(one.id).length,1);assert.equal(store.monitor('missing'),null);
});
