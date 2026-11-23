import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {collectHourly,publicHourly,sourceId,schedule} from '../server/a-share-hourly.mjs';
import {openStore,INDICES} from '../server/a-share-daily.mjs';
import {createSchemeApi} from '../server/a-share-schemes-api.mjs';
import {createSchemeStore} from '../server/a-share-schemes.mjs';

const require=createRequire(import.meta.url),siteDir=resolve('.');
const time=Date.parse('2026-11-23T10:05:00+08:00');
const quote=(stamp=time)=>({data:INDICES.map(symbol=>({symbol,region:'CN',session:'regular',timestamp:stamp,last_price:102,prev_close:100}))});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'books-hourly-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function options(dir,extra={}){return {dir,dbFile:join(dir,'app.sqlite'),siteDir,now:()=>time,apiKey:'mock-key',fetch:async()=>Response.json(quote()),runSchemes:async()=>({status:'complete',day:'2026-11-20',generation:'2026-11-20-1'}),...extra};}

test('no key performs zero external requests and still runs the saved daily schemes',async t=>{
  const dir=await fixture(t);let requests=0,runs=0;
  t.mock.method(globalThis,'fetch',()=>{throw Error('unexpected global network');});
  const result=await collectHourly(options(dir,{apiKey:'',fetch:()=>{requests++;throw Error('unexpected request');},runSchemes:async input=>{runs++;assert.deepEqual(Object.keys(input).sort(),['dbFile','dir','now','siteDir']);return {status:'complete'};}}));
  assert.equal(result.attempt.status,'unconfigured');assert.equal(result.attempt.requestCount,0);assert.equal(requests,0);assert.equal(runs,1);assert.equal(result.lastSuccess,null);assert.equal(result.schemes.status,'complete');assert.deepEqual(publicHourly(result),result);
  assert.equal(JSON.parse(await readFile(join(dir,'hourly.json'))).attempt.status,'unconfigured');assert.equal((await readdir(join(dir,'hourly','2026-11-23'))).length,1);
});
test('one authenticated guarded request publishes only validated derived changes and distinct source, fetch and expiry times',async t=>{
  const dir=await fixture(t);let requests=0;
  const source=time-1000;
  const result=await collectHourly(options(dir,{fetch:async(url,input)=>{requests++;assert.equal(url,'https://api.tickflow.org/v1/quotes?symbols=000300.SH,000001.SH,399001.SZ');assert.equal(input.headers['x-api-key'],'mock-key');assert.equal(input.redirect,'error');assert(input.signal);return Response.json(quote(source));}}));
  assert.equal(requests,1);assert.equal(result.attempt.requestCount,1);assert.equal(result.attempt.status,'complete');assert.equal(result.lastSuccess.asOf,new Date(source).toISOString());assert.equal(result.lastSuccess.fetchedAt,new Date(time).toISOString());assert.equal(result.lastSuccess.staleAfter,new Date(source+600000).toISOString());assert(Math.abs(result.lastSuccess.indices[0].changePercent-2)<1e-10);assert.deepEqual(publicHourly(result),result);
  const published=await readFile(join(dir,'hourly.json'),'utf8');assert.doesNotMatch(published,/mock-key|last_price|prev_close|"price"|"timestamp"|"data"/);
  const db=openStore(join(dir,'collector.sqlite'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history_v2').get().n,0);db.close();
});
test('optional or null quote sessions use the verified intraday calendar and source timestamp',async t=>{
  for(const session of [null,undefined]){
    const dir=await fixture(t),payload=quote();payload.data.forEach(q=>{if(session===undefined)delete q.session;else q.session=session;});
    const result=await collectHourly(options(dir,{fetch:async()=>Response.json(payload)}));assert.equal(result.attempt.status,'complete');assert.equal(result.attempt.requestCount,1);assert.deepEqual(publicHourly(result),result);
  }
  for(const session of ['closed','halted','lunch_break','pre_market','after_hours','foreign_session']){
    const dir=await fixture(t),payload=quote();payload.data[0].session=session;
    const result=await collectHourly(options(dir,{fetch:async()=>Response.json(payload)}));assert.equal(result.attempt.status,'stale');assert.equal(result.lastSuccess,null);
  }
  for(const stamp of ['2026-11-23T09:29:59+08:00','2026-11-23T12:59:59+08:00']){
    const dir=await fixture(t),payload=quote(Date.parse(stamp));payload.data.forEach(q=>{q.session=null;});
    const result=await collectHourly(options(dir,{now:()=>Date.parse(stamp)+1000,fetch:async()=>Response.json(payload)}));assert.equal(result.attempt.status,'stale');assert.equal(result.lastSuccess,null);
  }
});
test('closing ticks within 15:00 accept documented optional sessions while 15:01 and wrong sessions are rejected',async t=>{
  const closeTime=Date.parse('2026-11-23T15:05:00+08:00');
  for(const session of [null,undefined,'regular','closed','after_hours']){
    const dir=await fixture(t),payload=quote(Date.parse('2026-11-23T15:00:06+08:00'));
    payload.data.forEach((q,i)=>{if(session===undefined)delete q.session;else q.session=session;if(i===2)q.timestamp-=3000;});
    const result=await collectHourly(options(dir,{now:()=>closeTime,fetch:async()=>Response.json(payload)}));assert.equal(result.attempt.status,'complete');assert.equal(result.lastSuccess.asOf,'2026-11-23T07:00:03.000Z');assert.equal(result.lastSuccess.indices[0].sourceAt,'2026-11-23T07:00:06.000Z');
    const late=quote(Date.parse('2026-11-23T15:01:00+08:00'));late.data.forEach(q=>{if(session===undefined)delete q.session;else q.session=session;});
    const rejected=await collectHourly(options(dir,{now:()=>closeTime+1000,fetch:async()=>Response.json(late)}));assert.equal(rejected.attempt.status,'stale');assert.deepEqual(rejected.lastSuccess,result.lastSuccess);
  }
  for(const session of ['halted','lunch_break','pre_market','foreign_session']){
    const dir=await fixture(t),payload=quote(Date.parse('2026-11-23T15:00:06+08:00'));payload.data[0].session=session;
    const result=await collectHourly(options(dir,{now:()=>closeTime,fetch:async()=>Response.json(payload)}));assert.equal(result.attempt.status,'stale');assert.equal(result.lastSuccess,null);
  }
  const dir=await fixture(t);let requests=0;
  const closed=await collectHourly(options(dir,{now:()=>Date.parse('2026-11-23T15:10:01+08:00'),fetch:()=>{requests++;throw Error('capture window must remain closed');}}));assert.equal(closed.attempt.status,'closed');assert.equal(requests,0);
});
test('partial, stale, repeated, nonfinite, foreign-session and future quotes keep the exact last success and do not replay old data as new',async t=>{
  const dir=await fixture(t),first=await collectHourly(options(dir));
  const mutations=[p=>p.data.pop(),p=>p.data.forEach(q=>q.timestamp-=3600000),p=>{},p=>p.data[0].last_price=NaN,p=>p.data[0].session='lunch_break',p=>p.data[0].timestamp=time+10000,p=>p.data[0].region='US',p=>p.data[0].symbol=p.data[1].symbol];
  for(const mutate of mutations){const payload=quote();mutate(payload);const result=await collectHourly(options(dir,{now:()=>time+1000,fetch:async()=>Response.json(payload)}));assert(['stale','failed'].includes(result.attempt.status));assert.deepEqual(result.lastSuccess,first.lastSuccess);assert.equal(result.schemes.status,'complete');}
  const noKey=await collectHourly(options(dir,{apiKey:'',now:()=>time+2000}));assert.deepEqual(noKey.lastSuccess,first.lastSuccess);
  const failed=await collectHourly(options(dir,{now:()=>time+3000,fetch:async()=>{throw Error('secret provider body mock-key');},runSchemes:async()=>{throw Error('secret raw bar');}}));assert.equal(failed.schemes.status,'failed');assert.doesNotMatch(JSON.stringify(failed),/secret|mock-key|raw bar/);assert.deepEqual(failed.lastSuccess,first.lastSuccess);
});
test('each forbidden response persists a provider hold in the daily collector store and blocks all future automatic requests',async t=>{
  for(const status of [401,403,418,429,451]){
    const dir=await fixture(t),legacy='source-hold:tickflow-free-forward-v1';let requests=0;
    const db=openStore(join(dir,'collector.sqlite'));db.prepare('INSERT INTO settings VALUES(?,?)').run(legacy,JSON.stringify({reason:'daily hold'}));db.close();
    const input=options(dir,{fetch:async()=>{requests++;return new Response('secret provider response',{status,headers:{'Retry-After':'120'}});}});
    const first=await collectHourly(input),second=await collectHourly(input);assert.equal(first.attempt.status,'failed');assert.equal(first.attempt.requestCount,1);assert.equal(second.attempt.requestCount,0);assert.equal(requests,1);assert.doesNotMatch(JSON.stringify(first),/secret provider response/);
    const check=openStore(join(dir,'collector.sqlite')),hold=JSON.parse(check.prepare('SELECT value FROM settings WHERE key=?').get('source-hold:'+sourceId).value);assert.equal(hold.httpStatus,status);assert.equal(hold.retryAfter,new Date(time+120000).toISOString());assert.equal(JSON.parse(check.prepare('SELECT value FROM settings WHERE key=?').get(legacy).value).reason,'daily hold');check.close();
  }
});
test('lunch, weekends, holidays and unverified years make zero quote requests; the close snapshot requires the 15:00 source time',async t=>{
  const dir=await fixture(t);let requests=0;
  for(const value of ['2026-11-23T12:05:00+08:00','2026-11-22T10:05:00+08:00','2026-10-01T10:05:00+08:00','2027-01-04T10:05:00+08:00']){
    const result=await collectHourly(options(dir,{now:()=>Date.parse(value),fetch:()=>{requests++;throw Error('not open');}}));assert.equal(result.attempt.status,'closed');assert.equal(result.attempt.requestCount,0);
  }
  assert.equal(requests,0);
  const close=quote(Date.parse('2026-11-23T15:00:00+08:00'));close.data.forEach(q=>q.session='closed');
  const result=await collectHourly(options(dir,{now:()=>Date.parse('2026-11-23T15:05:00+08:00'),fetch:async()=>Response.json(close)}));assert.equal(result.attempt.status,'complete');
});
test('public scheme API keeps daily collection and monitor fields, reports a missing hourly file as null, and strips unapproved payload fields',async t=>{
  const dir=await fixture(t),collection={attempt:{status:'complete'}},store={get:()=>({id:'scheme'}),runs:()=>[],latestRun:()=>null,tracks:()=>[],monitor:()=>({status:'pending'})};
  await writeFile(join(dir,'status.json'),JSON.stringify(collection));const api=createSchemeApi({store,directory:dir});let body;
  const read=async()=>{await api.handle({method:'GET'},null,{path:'/api/a-share-daily/schemes',url:new URL('https://books.invalid/api/a-share-daily/schemes?id=scheme'),json:(res,status,value)=>{assert.equal(status,200);body=value;}});return body;};
  assert.equal((await read()).hourly,null);assert.deepEqual(body.collection,collection);assert.deepEqual(body.monitor,{status:'pending'});
  const value=await collectHourly(options(dir));value.raw='secret';value.lastSuccess.indices[0].price=1234;await writeFile(join(dir,'hourly.json'),JSON.stringify(value));assert.equal((await read()).hourly.schedule,schedule);assert.doesNotMatch(JSON.stringify(body.hourly),/secret|price|1234/);
  value.attempt.error='secret';await writeFile(join(dir,'hourly.json'),JSON.stringify(value));assert.equal((await read()).hourly,null);assert.deepEqual(body.collection,collection);
  await writeFile(join(dir,'hourly.json'),'broken');assert.equal((await read()).hourly,null);
});
test('hourly quotes cannot advance the real saved-scheme 15-day assessment before a complete private daily batch exists',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('saved daily schemes must remain offline');});
  const dir=await fixture(t),dbFile=join(dir,'app.sqlite'),db=new DatabaseSync(dbFile);t.after(()=>db.close());let clock=Date.parse('2026-11-02T20:10:00+08:00');
  const now=()=>clock,store=createSchemeStore({db,model:require('../control/model.js'),patterns:require('../screening/trend-patterns.js'),now});
  const scheme=store.save({ownerId:'owner',name:'十五日考核',config:{settings:{mode:'market',limits:{enabled:false}}},selection:{patternId:'',qualification:'strict',scopeCodes:['600000.SH']}});
  async function batch(day){
    const dates=[];for(let d=new Date(day+'T00:00:00Z');dates.length<61;d.setUTCDate(d.getUTCDate()-1))if(![0,6].includes(d.getUTCDay()))dates.unshift(d.toISOString().slice(0,10));
    const bars=dates.map(date=>({date,close:100+(Date.parse(date)-Date.parse('2026-01-01'))/86400000*.05,volume:100}));
    const universe=Array.from({length:1000},(_,i)=>({code:String(600000+i)+'.SH',name:'测试'+i,sector:'测试',exchange:'SH'})),asOf=day+'T15:10:00+08:00',generation=day+'-1';
    const manifest={generation,sourceId:'test-daily',day,asOf,total:1000,ready:1000,fullMarket:true};
    const dataset={schema:'books.research.dataset.v1',day,asOf,completed:true,collectionStatus:'complete',expectedCount:1000,totalUniverseCount:1000,universe,records:universe.map(stock=>({stock,source:{status:'ready',sourceId:manifest.sourceId,day,adjustment:'qfq',bars,fetchedAt:asOf}})),reference:{code:'000300.SH',adjustment:'index',bars,fetchedAt:asOf}};
    await mkdir(join(dir,'private','generations',generation),{recursive:true});await mkdir(join(dir,'generations',generation),{recursive:true});await writeFile(join(dir,'private','generations',generation,'dataset-all-000300.SH.json'),JSON.stringify(dataset));await writeFile(join(dir,'generations',generation,'complete.json'),JSON.stringify({...manifest,completed:true}));await writeFile(join(dir,'current.json'),JSON.stringify(manifest));return generation;
  }
  await batch('2026-11-02');await collectHourly(options(dir,{dbFile,now,apiKey:'',runSchemes:undefined}));assert.equal(store.tracks(scheme.id).length,1);
  const dailyGeneration=await batch('2026-11-20'),before=await readFile(join(dir,'current.json'),'utf8');clock=time;
  const payload=quote();payload.data.forEach(q=>q.last_price=200);
  const result=await collectHourly(options(dir,{dbFile,now,runSchemes:undefined,fetch:async()=>Response.json(payload)}));assert.equal(result.schemes.status,'complete');assert.equal(result.schemes.generation,dailyGeneration);assert.equal(store.tracks(scheme.id)[0].observations[15].status,'pending');assert.equal(store.tracks(scheme.id)[0].exitDay,null);assert.equal(store.latestRun(scheme.id).day,'2026-11-20');assert.equal(await readFile(join(dir,'current.json'),'utf8'),before);
  await batch('2026-11-23');clock=Date.parse('2026-11-23T20:10:00+08:00');await collectHourly(options(dir,{dbFile,now,apiKey:'',runSchemes:undefined}));const track=store.tracks(scheme.id)[0];assert.equal(track.observations[15].status,'ready');assert.equal(track.assessment.passed,false);assert.equal(track.exitDay,'2026-11-23');
});
test('timer and service retain existing users and paths, skip lunch and weekends, and read an optional external environment file',async()=>{
  const timer=await readFile(join(siteDir,'server/books-a-share-hourly.timer'),'utf8'),service=await readFile(join(siteDir,'server/books-a-share-hourly.service'),'utf8');
  assert.match(timer,/OnCalendar=Mon\.\.Fri \*-\*-\* 10,11,13,14,15:05:00 Asia\/Shanghai/);assert.match(timer,/Persistent=false/);assert.match(service,/User=books/);assert.match(service,/BOOKS_A_SHARE_DIR=\/var\/lib\/books\/a-share-daily/);assert.match(service,/EnvironmentFile=-\/etc\/books\/a-share-hourly.env/);assert.doesNotMatch(service,/Restart=|mock-key|BOOKS_TICKFLOW_API_KEY=/);
});
