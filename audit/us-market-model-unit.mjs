import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Public-module regression tests. All bars are SYNTHETIC offline fixtures.
// No private-directory imports, real quotes, API credentials or network requests.
const scope={URL};vm.runInNewContext(readFileSync(new URL('../us-market-model.js',import.meta.url),'utf8'),scope,{filename:'us-market-model.js'});
const model=scope.BooksResearchModel,days=['2026-10-28','2026-10-29','2026-10-30','2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-09','2026-11-10'];
const at=(day,minute)=>model.atMarket(day,minute,'us');
const bar=(day,minute,volume=100,close=100)=>({t:at(day,minute),o:100,h:103,l:99,c:close,v:volume,vw:1});
const page=(bars,receivedAt,extra={})=>({provider:'Alpaca',feed:'iex',receivedAt,data:{bars:{FIXTURE:bars}},...extra});
const baseline=(minutes=['10:00'])=>days.flatMap(day=>minutes.map(minute=>bar(day,minute)));
const observe=(pages,now)=>model.observations(pages,'us',Date.parse(now));

test('a quiet latest minute cannot erase an earlier fresh completed spike',()=>{
 const now=at('2026-11-11','10:02'),out=observe([page([...baseline(['10:00','10:01']),bar('2026-11-11','10:00',400,102),bar('2026-11-11','10:01')],now)],now);
 assert.equal(out.observations.length,1);assert.equal(out.observations[0].minute,'10:01');assert.equal(out.alerts.length,1);assert.equal(out.alerts[0].minute,'10:00');assert.equal(out.alerts[0].ratio,4);
});
test('all fresh completed minutes are scanned and overlapping pages dedupe stable alert IDs',()=>{
 const now=at('2026-11-11','10:02'),first=page([...baseline(['10:00','10:01']),bar('2026-11-11','10:00',400,102),bar('2026-11-11','10:01',500,102)],now),later={...first,receivedAt:new Date(Date.parse(now)+1000).toISOString()},out=observe([first,later,first],later.receivedAt);
 // The first minute has just aged out at +121 seconds; exact boundaries are checked below.
 assert.equal(out.alerts.length,1);assert.equal(out.alerts[0].minute,'10:01');assert.equal(out.alerts[0].receivedAt,later.receivedAt);
 const both=observe([first,first],now);assert.equal(both.alerts.length,2);assert.equal(new Set(Array.from(both.alerts,a=>a.id)).size,2);
 const single=observe([first],now);assert.equal(JSON.stringify(Array.from(both.alerts,a=>a.id)),JSON.stringify(Array.from(single.alerts,a=>a.id)));
});
test('US early close does not reuse regular-session same-minute baselines',()=>{
 const prior=['2026-11-12','2026-11-13','2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-23','2026-11-24','2026-11-25'],now=at('2026-11-27','13:31'),out=observe([page([...prior.map(day=>bar(day,'13:30')),bar('2026-11-27','13:30',400,102)],now)],now);
 assert.equal(out.observations[0].session,'extended');assert.equal(out.observations[0].scope,'after_core');assert.equal(out.alerts.length,0);
});
test('holidays and weekends are closed and unknown calendar years stay unverified',()=>{
 for(const [day,session]of [['2026-11-26','closed'],['2026-11-14','closed'],['2027-11-11','unverified']]){
  const now=at(day,'10:01'),out=observe([page([...baseline(),bar(day,'10:00',400,102)],now)],now);
  assert.equal(out.observations[0].session,session);assert.equal(out.alerts.length,0);
 }
});
test('before-core and after-core quotes carry separate scopes and compare only their own scope',()=>{
 for(const [minute,clock,scope]of [['08:00','08:01','before_core'],['16:30','16:31','after_core']]){
  const now=at('2026-11-11',clock),out=observe([page([...baseline([minute]),bar('2026-11-11',minute,400,102)],now)],now);
  assert.equal(out.observations[0].session,'extended');assert.equal(out.observations[0].scope,scope);assert.equal(out.alerts.length,1);assert.equal(out.alerts[0].scope,scope);
 }
});
test('IEX and SIP turnover cannot share a baseline and preserve their coverage',()=>{
 const now=at('2026-11-11','10:17'),out=observe([page(baseline(),now),page([bar('2026-11-11','10:00',1000,102)],now,{feed:'sip_delayed'})],now);
 assert.equal(out.alerts.length,0);assert.equal(out.observations[0].feed,'sip_delayed');assert.equal(out.observations[0].coverage,'consolidated');assert.equal(out.observations[0].delaySeconds,960);
 const valid=observe([page([...baseline(),bar('2026-11-11','10:00',400,102)],now,{feed:'sip_delayed'})],now);assert.equal(valid.alerts.length,1);assert.equal(valid.alerts[0].ratio,4);
 const iex=observe([page([...baseline(),bar('2026-11-11','10:00',400,102)],at('2026-11-11','10:01'))],at('2026-11-11','10:01'));assert.equal(iex.alerts[0].coverage,'single_exchange');assert.equal(iex.alerts[0].feed,'iex');
});
test('providers cannot share a baseline even when feed names and symbols match',()=>{
 const now=at('2026-11-11','10:01'),out=observe([page(baseline(),now),page([bar('2026-11-11','10:00',1000,102)],now,{provider:'OtherFixtureProvider'})],now);
 assert.equal(out.alerts.length,0);assert.equal(out.observations[0].provider,'OtherFixtureProvider');assert.equal(out.observations[0].source,'OtherFixtureProvider');
});
test('old pages without feed retain their actual quote but cannot confirm an anomaly',()=>{
 const now=at('2026-11-11','10:01'),out=observe([page([...baseline(),bar('2026-11-11','10:00',400,102)],now,{feed:undefined})],now);
 assert.equal(out.observations[0].price,102);assert.equal(out.observations[0].feed,null);assert.equal(out.observations[0].coverage,'unverified');assert.equal(out.alerts.length,0);
});
test('DST matches Eastern clock minutes rather than equal UTC hours',()=>{
 const now=at('2026-11-11','10:01'),out=observe([page([...baseline(),bar('2026-11-11','10:00',400,102)],now)],now);
 assert.equal(at('2026-10-30','10:00'),'2026-10-30T14:00:00.000Z');assert.equal(at('2026-11-02','10:00'),'2026-11-02T15:00:00.000Z');assert.equal(out.alerts[0].baselineDays,10);assert.equal(out.alerts[0].ratio,4);
});
test('future or forming bars never alert and completion requires a full minute',()=>{
 const stamp=at('2026-11-11','10:00'),bars=[...baseline(),bar('2026-11-11','10:00',400,102)];
 for(const [offset,status,count]of [[-1000,'future',0],[59000,'forming',0],[60000,'complete',1]]){
  const now=new Date(Date.parse(stamp)+offset).toISOString(),out=observe([page(bars,now)],now);
  assert.equal(out.observations[0].minuteStatus,status);assert.equal(out.observations[0].price,102);assert.equal(out.alerts.length,count);
 }
 const observedEarly=new Date(Date.parse(stamp)+59000).toISOString(),later=new Date(Date.parse(stamp)+61000).toISOString(),cached=observe([page(bars,observedEarly)],later);assert.equal(cached.observations[0].minuteStatus,'forming');assert.equal(cached.alerts.length,0);
});
test('missing or nine-day history leaves the real latest quote visible without an alert',()=>{
 const now=at('2026-11-11','10:01');for(const history of [[],baseline().slice(1)]){const out=observe([page([...history,bar('2026-11-11','10:00',400,102)],now)],now);assert.equal(out.observations[0].price,102);assert.equal(out.alerts.length,0);}
});
test('baseline uses no more than the last twenty distinct prior days',()=>{
 const prior=[];for(let time=Date.parse('2026-10-01T00:00:00Z');prior.length<25;time+=86400000){const day=new Date(time);if(day.getUTCDay()>0&&day.getUTCDay()<6)prior.push(day.toISOString().slice(0,10));}
 const date='2026-11-11',now=at(date,'10:01'),bars=prior.map((day,i)=>bar(day,'10:00',i<5?10000:100)),out=observe([page([...bars,bar(date,'10:00',400,102)],now)],now);
 assert.equal(out.alerts.length,1);assert.equal(out.alerts[0].baselineDays,20);assert.equal(out.alerts[0].ratio,4);
});
test('source and receipt timestamps survive alerts and the public output contract',()=>{
 const sourceTime='2026-11-11T10:00:00-05:00',receivedAt='2026-11-11T15:01:04.567Z',current={...bar('2026-11-11','10:00',400,102),t:sourceTime},out=observe([page([...baseline(),current],receivedAt)],receivedAt);
 assert.equal(out.observations[0].sourceTime,sourceTime);assert.equal(out.alerts[0].sourceTime,sourceTime);assert.equal(out.alerts[0].receivedAt,receivedAt);assert.equal(out.observations[0].receivedAt,receivedAt);
 const value=model.empty();Object.assign(value,out);assert.equal(value.schema,'books.stock.workspace.v1');assert.equal(value.execution.backgroundEnabled,false);assert.equal(value.execution.realOrdersSent,0);
 assert.ok(value.observations.every(q=>q.market==='us'&&q.provider==='Alpaca'&&q.feed==='iex'&&q.coverage==='single_exchange'&&q.currency==='USD'));
 assert.ok(value.alerts.every(a=>a.market==='us'&&a.feed==='iex'&&a.baselineDays>=10&&a.ratio>=3&&a.currency==='USD'));assert.doesNotMatch(JSON.stringify(value),/apiKey|apiSecret|vault/);
});

test('explicit historical review evaluates only the requested past session without changing source times',()=>{
 const replayDate='2026-11-11',now=at('2026-11-13','11:00'),bars=[...baseline(['10:00','10:01']),bar(replayDate,'10:00',400,102),bar(replayDate,'10:01',500,102),bar('2026-11-12','10:00',1000,102),bar('2026-11-13','10:59',1000,102)],input=page(bars,now),before=JSON.stringify(input),out=model.observations([input],'us',Date.parse(now),{replayDate});
 assert.equal(out.observations.length,1);assert.equal(out.observations[0].date,replayDate);assert.equal(out.observations[0].minute,'10:01');assert.equal(out.alerts.length,2);
 for(const alert of out.alerts){assert.equal(alert.date,replayDate);assert.equal(alert.historical,true);assert.equal(alert.detectedAt,now);assert.equal(alert.receivedAt,now);assert.equal(alert.sourceTime,at(replayDate,alert.minute));assert.equal(alert.baselineDays,10);}
 assert.equal(JSON.stringify(input),before);assert.equal(observe([input],now).alerts.length,0);
 const realNow=at(replayDate,'10:02'),live=observe([page(bars.filter(b=>Date.parse(b.t)<=Date.parse(realNow)),realNow)],realNow);assert.equal(JSON.stringify(Array.from(live.alerts,a=>a.id)),JSON.stringify(Array.from(out.alerts,a=>a.id)));
});
test('historical review accepts only verified nonfuture US trading dates',()=>{
 const now=Date.parse(at('2026-11-13','11:00'));
 for(const replayDate of ['2026-11-16','2026-11-14','2026-11-08','2026-09-07','2026-11-26','2027-01-04','2025-11-11','2026-02-31','2026-11-11?token=SYNTHETIC',null,undefined])assert.throws(()=>model.observations([],'us',now,{replayDate}),/历史复核日期/);
 assert.throws(()=>model.observations([],'a',now,{replayDate:'2026-11-11'}),/历史复核日期/);
 assert.throws(()=>model.observations([],'us',now,{replayDate:'2026-11-11',allowFuture:true}),/历史复核参数/);
 assert.doesNotThrow(()=>model.observations([],'us',now,{replayDate:'2026-11-13'}));
});
test('historical review still excludes forming and future minutes on the current trading day',()=>{
 const replayDate='2026-11-11',now=new Date(Date.parse(at(replayDate,'10:00'))+30000).toISOString(),bars=[...baseline(['09:59','10:00','10:01']),bar(replayDate,'09:59',400,102),bar(replayDate,'10:00',500,102),bar(replayDate,'10:01',500,102)],out=model.observations([page(bars,now)],'us',Date.parse(now),{replayDate});
 assert.equal(out.alerts.length,1);assert.equal(out.alerts[0].minute,'09:59');assert.equal(out.alerts[0].historical,true);assert.equal(out.observations[0].minuteStatus,'future');
 const earlyReceipt=at(replayDate,'10:00'),later=at('2026-11-13','11:00'),cached=model.observations([page([...baseline(),bar(replayDate,'10:00',400,102)],earlyReceipt)],'us',Date.parse(later),{replayDate});assert.equal(cached.alerts.length,0);assert.equal(cached.observations[0].minuteStatus,'forming');
});
test('historical review preserves feed and provider isolation and minimum same-source history',()=>{
 const replayDate='2026-11-11',now=at('2026-11-13','11:00'),current=bar(replayDate,'10:00',1000,102),cases=[
  [page([...baseline(),current],now,{feed:undefined})],
  [page(baseline(),now),page([current],now,{feed:'sip_delayed'})],
  [page(baseline(),now),page([current],now,{provider:'OtherFixtureProvider'})],
  [page([...baseline().slice(1),current],now)]
 ];
 for(const pages of cases){const out=model.observations(pages,'us',Date.parse(now),{replayDate});assert.equal(out.observations.length,1);assert.equal(out.observations[0].price,102);assert.equal(out.alerts.length,0);}
});
test('historical review returns no other-date observations when the requested session is absent',()=>{
 const now=at('2026-11-13','11:00'),out=model.observations([page([...baseline(),bar('2026-11-13','10:59',500,102)],now)],'us',Date.parse(now),{replayDate:'2026-11-12'});
 assert.equal(out.observations.length,0);assert.equal(out.alerts.length,0);
});
