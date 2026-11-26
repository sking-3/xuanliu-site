import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {classify,buildSelection,latestSession,parameters} from '../server/us-selection-engine.mjs';
import {parseSeries,filterUniverse,usDate,dataPolicy} from '../server/us-tickflow.mjs';
import {runDaily,readPublished,readState,sourcePolicyAllowed} from '../server/us-daily.mjs';
const require=createRequire(import.meta.url),calendar=require('../market-calendar.js'),day='2026-11-25',clock=Date.parse('2026-11-26T09:00:00Z');
const dates=[];for(let value=Date.parse(day+'T00:00Z');dates.length<220;value-=86400000){const date=new Date(value).toISOString().slice(0,10);if(calendar.session('US',date).open)dates.unshift(date);}
const reference=dates.map(date=>({date,open:10,high:10.1,low:9.9,close:10,volume:5000000}));
function stockBars(){return dates.map((date,index)=>{const close=10+index*.06;return {date,open:close-.02,high:close+.04,low:close-.04,close,volume:1000000,amount:0};});}
function breakoutBars(){const bars=stockBars(),last=bars.at(-1);bars[bars.length-1]={...last,close:last.close+.03,high:last.high+.08,volume:2000000};return bars;}
function input(bars=breakoutBars()){return {asOf:day,scope:{name:'synthetic test universe'},universe:[{symbol:'TEST',name:'合成测试',securityQualified:false}],series:{TEST:bars},benchmarks:{SPY:reference,QQQ:reference},source:{...dataPolicy,sourceTime:'2026-11-25T21:00:00Z',fetchedAt:new Date(clock).toISOString()}};}
const provider={async universe(){return {universe:input().universe,scope:{name:'synthetic test universe'},payload:{},fetchedAt:new Date(clock).toISOString()};},async history(stocks){return new Map(stocks.map(stock=>[stock.symbol,{bars:['SPY','QQQ'].includes(stock.symbol)?reference:breakoutBars(),fetchedAt:new Date(clock).toISOString()}]));}};

test('US latest completed session obeys DST, Thanksgiving and early close, unknown years fail closed',()=>{
 assert.equal(latestSession(calendar,clock).date,day);
 assert.equal(latestSession(calendar,Date.parse('2026-11-27T17:59Z')).date,day);
 assert.equal(latestSession(calendar,Date.parse('2026-11-27T18:01Z')).date,'2026-11-27');
 assert.equal(latestSession(calendar,Date.parse('2026-07-06T20:01Z')).closeTime,'2026-07-06T20:00:00.000Z');
 assert.throws(()=>latestSession(calendar,Date.parse('2027-01-04T22:00Z')),/calendar/);
});
test('TickFlow US daily midnight is America/New_York rather than UTC or China time',()=>{
 assert.equal(usDate(1795582800000),day);
 const value=parseSeries({timestamp:[1795582800000],open:[10],high:[11],low:[9],close:[10.5],volume:[100],amount:[0]},day);
 assert.equal(value[0].date,day);assert.equal(value[0].amount,undefined);
 assert.throws(()=>parseSeries({timestamp:[1795582800000],open:[10],high:[9],low:[8],close:[10],volume:[100]},day),/invalid/);
});
test('source type=stock does not certify an ETF as ordinary equity and known products are excluded',()=>{
 const data=[{symbol:'TEST.US',exchange:'US',code:'TEST',name:'Normal Company',region:'US',type:'stock'},{symbol:'ETF1.US',exchange:'US',code:'ETF1',name:'iShares Test ETF',region:'US',type:'stock'}];
 const result=filterUniverse({exchange:'US',count:2,data});assert.equal(result.universe.length,1);assert.equal(result.excluded.length,1);assert.equal(result.universe[0].securityQualified,false);assert.equal(result.scope.fullUSMarket,false);
});
test('zero provider amount uses an explicit close-volume proxy and does not exclude every real US share',()=>{
 const result=classify(breakoutBars(),reference);assert(result.metrics.dollarVolume20Proxy>1e7);assert.equal(result.metrics.dollarVolume20,null);assert.equal(result.metrics.turnoverMethod,'close_times_provider_volume_proxy');assert(result.hits.some(hit=>hit.rule==='U2'));
 const exact=breakoutBars().map(bar=>({...bar,amount:2e7}));assert.equal(classify(exact,reference).metrics.dollarVolume20,2e7);
});
test('original U2 volume threshold remains strict and a fractional-high move is not a cent-price B',()=>{
 assert.equal(parameters.breakVolume,1.5);const bars=breakoutBars();bars.at(-1).volume=1499999;assert(!classify(bars,reference).hits.some(hit=>hit.rule==='U2'));
 bars.at(-1).volume=1500000;const high=Math.max(...bars.slice(-21,-1).map(bar=>bar.high));bars.at(-1).close=high+.001;bars.at(-1).high=high+.05;
 const result=classify(bars,reference).hits.find(hit=>hit.rule==='U2');assert(result);assert.equal(result.status,'waiting');assert(result.trigger>bars.at(-1).close);
});
test('source date gaps, stale rows and future suffixes cannot form current qualified B signals',()=>{
 const source=input();source.series.TEST=source.series.TEST.filter((_,i)=>i!==210);const gap=buildSelection(source,{now:clock});assert.equal(gap.snapshot.short.rows.length,0);assert.equal(gap.snapshot.short.diagnostics.length,1);
 const future=input();future.series.TEST.push({...future.series.TEST.at(-1),date:'2026-11-27',close:9000,high:9001});assert.equal(buildSelection(future,{now:clock}).snapshot.short.rows.length,0);
 const current=buildSelection(input(),{now:clock});assert(current.snapshot.short.rows.every(row=>row.qualified===false));assert.equal(current.snapshot.short.rows[0].markers[0].researchOnly,true);
});
test('prospective tracking freezes price plans and separates close returns, adverse lows and close drawdown',()=>{
 const initial=buildSelection(input(),{now:clock});const source=input();const last=source.series.TEST.at(-1),next='2026-11-27';
 source.asOf=next;source.series.TEST.push({...last,date:next,open:last.close+.1,high:last.close+.3,low:last.low+.01,close:last.close+.2,volume:2000000});
 for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol]=[...reference,{...reference.at(-1),date:next}];
 const second=buildSelection(source,{previousLedger:initial.ledger,previousSnapshot:initial.snapshot,now:clock+86400000});const record=second.ledger.records.find(r=>r.id===initial.ledger.records[0].id);
 assert.equal(record.trigger,initial.ledger.records[0].trigger);assert.equal(record.referenceDate,day);assert.equal(record.followup.horizons[1].status,'ready');assert.equal(record.followup.horizons[3].status,'pending');assert.equal(record.followup.basis,'first_observed_close_not_trade_fill');
 assert(record.followup.horizons[1].returnPercent>0);assert(record.followup.horizons[1].maxAdversePercent<=0);assert(record.followup.horizons[1].maxCloseDrawdownPercent<=0);
 const row=second.snapshot.short.rows[0];if(row){const tracked=second.ledger.records.find(r=>r.id===row.hits[0].trackingId);assert.equal(row.trigger,tracked.trigger);assert.equal(row.status,tracked.status);assert.equal(row.isNewB,false);}
});
test('a missing subsequent stock session stays missing rather than advancing on the next available bar',()=>{
 const initial=buildSelection(input(),{now:clock}),source=input();source.asOf='2026-11-30';source.series.TEST.push({...source.series.TEST.at(-1),date:source.asOf});
 for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol]=[...reference,{...reference.at(-1),date:'2026-11-27'},{...reference.at(-1),date:'2026-11-30'}];
 const next=buildSelection(source,{previousLedger:initial.ledger,now:clock+4*86400000});assert.equal(next.ledger.records[0].followup.horizons[1].status,'data_missing');assert.notEqual(next.ledger.records[0].membership,'exited');
});
test('worker publishes one complete immutable gzip batch, skips duplicate daily runs and retains success on failure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'books-us-unit-'));let time=clock;
 try{
  const first=await runDaily({directory,calendar,now:()=>time,wait:async()=>{},provider,enrich:async()=>({fundamentals:{rows:[]},dca:{rows:[]}})});assert.equal(first.status,'ready');const saved=await readPublished(directory);assert.equal(saved.asOf,day);assert.equal(saved.source.sourceTimeKind,'scheduled_regular_close');assert.equal(saved.source.providerPublishedAt,null);
  const pointer=JSON.parse(await readFile(join(directory,'published.json')));assert(gunzipSync(await readFile(join(directory,pointer.snapshot))).length>0);
  assert.equal((await runDaily({directory,calendar,now:()=>time,provider})).status,'idle');
  time+=1000;const broken={...provider,async history(){throw Error('fixture source failure');}};assert.equal((await runDaily({directory,calendar,now:()=>time,provider:broken,force:true})).status,'error');assert.deepEqual(await readPublished(directory),saved);assert.match((await readState(directory)).error,/fixture/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('refused sources remain held without timer retries; unverified collection policy makes no requests',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'books-us-hold-'));let requests=0;
 try{
  assert.equal(sourcePolicyAllowed({id:'nasdaq-public',collectionAllowed:true,analysisAllowed:true,permissionsVerified:true}),false);
  const pending=await runDaily({directory,calendar,now:()=>clock,sourcePolicy:{id:'pending'},fetch:async()=>{requests++;}});assert.equal(pending.status,'source_pending');assert.equal(requests,0);
  const denied=await runDaily({directory,calendar,now:()=>clock,wait:async()=>{},fetch:async()=>{requests++;return new Response('denied',{status:403});}});assert.equal(denied.status,'source_blocked');assert.equal(requests,1);
  const repeat=await runDaily({directory,calendar,now:()=>clock,fetch:async()=>{requests++;}});assert.equal(repeat.status,'source_blocked');assert.equal(requests,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('an exited waiting cohort keeps forward returns but cannot later reappear as a newly triggered B',()=>{
 const bars=stockBars();bars.at(-1).close=23.10;const initial=buildSelection(input(bars),{now:clock});assert(initial.ledger.records.length);assert.equal(initial.ledger.records[0].triggerDate,null);
 const source=input(bars);source.asOf='2026-11-27';source.series.TEST=[...bars,{...bars.at(-1),date:source.asOf,open:23.08,high:23.12,low:22.95,close:23.10}];
 for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol]=[...reference,{date:source.asOf,open:13,high:13.1,low:12.9,close:13,volume:5000000}];
 const exited=buildSelection(source,{previousLedger:initial.ledger,now:clock+86400000});assert.equal(exited.ledger.records[0].membership,'exited');
 source.asOf='2026-11-30';source.series.TEST.push({...source.series.TEST.at(-1),date:source.asOf,high:23.3,close:23.15});for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol].push({...source.benchmarks[symbol].at(-1),date:source.asOf});
 const later=buildSelection(source,{previousLedger:exited.ledger,now:clock+4*86400000});assert.equal(later.ledger.records[0].triggerDate,null);assert.equal(later.ledger.records[0].followup.horizons[1].status,'ready');
});
test('an untriggered 15-session observation expires and cannot generate a B on session 16',()=>{
 const bars=stockBars();bars.at(-1).close=23.10;const initial=buildSelection(input(bars),{now:clock});const source=input(bars);let count=0;
 for(let value=Date.parse(day+'T00:00Z')+86400000;count<16;value+=86400000){const date=new Date(value).toISOString().slice(0,10);if(!calendar.session('US',date).open)continue;count++;source.asOf=date;source.series.TEST.push({date,open:23.08,high:count===16?23.3:23.12,low:22.95,close:count===16?23.15:23.10,volume:1000000});for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol]=[...source.benchmarks[symbol],{...reference.at(-1),date}];}
 const result=buildSelection(source,{previousLedger:initial.ledger,now:clock+30*86400000}),record=result.ledger.records[0];assert.equal(record.triggerDate,null);assert.equal(record.membership,'completed');assert.equal(record.status,'invalid');assert.equal(record.followup.horizons[15].status,'ready');assert.equal(record.markers.length,0);
});

test('incremental gzip changes restore cumulative raw histories without deleting baseline dates',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'books-us-restore-'));let time=clock,data=input();
 const dynamic={async universe(){return {universe:data.universe,scope:data.scope,payload:{},fetchedAt:new Date(time).toISOString()};},async history(stocks){return new Map(stocks.map(stock=>[stock.symbol,{bars:data.benchmarks[stock.symbol]||data.series[stock.symbol],fetchedAt:new Date(time).toISOString()}]));}};
 try{
  await runDaily({directory,calendar,now:()=>time,provider:dynamic,enrich:async()=>({})});
  const before=JSON.parse(gunzipSync(await readFile(join(directory,'raw/history/TEST.json.gz'))));
  time=Date.parse('2026-11-28T09:00Z');data.asOf='2026-11-27';data.series.TEST.push({...data.series.TEST.at(-1),date:data.asOf});for(const symbol of ['SPY','QQQ'])data.benchmarks[symbol]=[...reference,{...reference.at(-1),date:data.asOf}];
  const completed=await runDaily({directory,calendar,now:()=>time,provider:dynamic,enrich:async()=>({})});assert.equal(completed.status,'ready');
  const pointer=JSON.parse(await readFile(join(directory,'published.json'))),lines=gunzipSync(await readFile(join(directory,'batches',pointer.generation,'changes.jsonl.gz'))).toString().trim().split('\n').map(line=>JSON.parse(line));
  const restored=new Map(before.bars.map(bar=>[bar.date,bar]));for(const line of lines.filter(line=>line.symbol==='TEST'))for(const bar of line.bars)restored.set(bar.date,bar);
  const actual=JSON.parse(gunzipSync(await readFile(join(directory,'raw/history/TEST.json.gz'))));assert.deepEqual([...restored.values()].sort((a,b)=>a.date.localeCompare(b.date)),actual.bars);assert.equal(actual.bars.length,before.bars.length+1);assert(lines.every(line=>line.bars.length===1));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a new B in another branch takes card priority over an older B being tracked',()=>{
 const bars=breakoutBars();bars.at(-1).low=22.8;const first=buildSelection(input(bars),{now:clock});assert.equal(first.snapshot.short.rows[0].hits.length,2);
 const source=input(bars);source.asOf='2026-11-27';source.series.TEST.push({date:source.asOf,open:23.15,high:23.35,low:22.9,close:23.30,volume:2000000});for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol]=[...reference,{...reference.at(-1),date:source.asOf}];
 const result=buildSelection(source,{previousLedger:first.ledger,now:clock+86400000}),row=result.snapshot.short.rows[0];assert.equal(row.rule,'PULLBACK');assert.equal(row.isNewB,true);assert.equal(row.signalDate,source.asOf);assert.equal(row.label,'趋势回踩后转强');assert.equal(row.trigger,first.ledger.records.find(record=>record.rule==='PULLBACK').trigger);
});
test('a completed short batch exposes partial fundamentals and keeps the warning on daily idle checks',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'books-us-warning-'));
 try{
  const enrichment={fundamentals:{status:'partial',rows:[],failures:[{source:'SEC',reason:'source refused'}]},dca:{status:'partial',rows:[],failures:[{source:'SEC',reason:'source refused'}]}};
  const result=await runDaily({directory,calendar,now:()=>clock,provider,enrich:async()=>enrichment});assert.equal(result.status,'ready');assert.equal(result.fundamentalsStatus,'partial');assert.equal(result.fundamentalsFailures.length,1);assert(result.warning);assert.equal(result.error,null);
  const idle=await runDaily({directory,calendar,now:()=>clock,provider});assert.equal(idle.status,'idle');assert.equal(idle.fundamentalsStatus,'partial');assert.equal(idle.warning,result.warning);assert.deepEqual(idle.fundamentalsFailures,result.fundamentalsFailures);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('B-trigger returns start at the actual trigger close after waiting days, independent of observation returns',()=>{
 const bars=stockBars();bars.at(-1).close=23.10;const initial=buildSelection(input(bars),{now:clock});assert.equal(initial.snapshot.short.rows[0].triggerFollowup.status,'not_triggered');assert.equal(initial.snapshot.short.rows[0].triggerFollowup.horizons[3].status,'pending');
 const source=input(bars),future=[['2026-11-27',23.10],['2026-11-30',23.15],['2026-12-01',23.20],['2026-12-02',23.25],['2026-12-03',23.30]];
 for(const [date,close] of future){source.asOf=date;source.series.TEST.push({date,open:close-.02,high:close+.03,low:22.95,close,volume:1000000});for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol]=[...source.benchmarks[symbol],{...reference.at(-1),date}];}
 const result=buildSelection(source,{previousLedger:initial.ledger,now:clock+8*86400000}),record=result.ledger.records[0];assert.equal(record.triggerDate,'2026-11-30');assert.equal(record.triggerClose,23.15);assert.equal(record.triggerFollowup.referenceDate,'2026-11-30');assert.equal(record.triggerFollowup.referenceClose,23.15);assert.equal(record.triggerFollowup.horizons[3].date,'2026-12-03');assert(Math.abs(record.triggerFollowup.horizons[3].returnPercent-(23.30/23.15-1)*100)<1e-8);assert.notEqual(record.followup.horizons[3].returnPercent,record.triggerFollowup.horizons[3].returnPercent);assert.equal(result.snapshot.tracking.maturedTriggered3,1);assert.equal(result.snapshot.tracking.meanTriggeredReturn3Percent,record.triggerFollowup.horizons[3].returnPercent);
});
test('legacy B records restore only the saved real trigger-day close and label the research price source',()=>{
 const original=buildSelection(input(),{now:clock}),legacy=structuredClone(original.ledger);delete legacy.records[0].triggerClose;delete legacy.records[0].triggerFollowup;delete legacy.records[0].triggerObservedAt;
 const result=buildSelection(input(),{previousLedger:legacy,now:clock+1000}),record=result.ledger.records[0];assert.equal(record.triggerClose,input().series.TEST.at(-1).close);assert.equal(record.triggerFollowup.priceSource,'restored_saved_daily_close');assert.equal(record.triggerFollowup.basis,'trigger_day_close_not_execution');assert.equal(record.triggerFollowup.researchOnly,true);assert.equal(result.snapshot.short.rows[0].triggerFollowup.referenceClose,record.triggerClose);
});

test('from-cache recomputes a source-bound current session without any quote requests or duplicate first observations',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'books-us-cache-'));let time=clock,requests=0;
 try{
  await runDaily({directory,calendar,now:()=>time,provider,enrich:async()=>({})});const old=JSON.parse(await readFile(join(directory,'published.json'))),oldSnapshot=await readPublished(directory);time+=1000;
  const result=await runDaily({directory,calendar,now:()=>time,fromCache:true,fetch:async()=>{requests++;throw Error('quotes must not be fetched');},enrich:async()=>({})});assert.equal(result.status,'ready');assert.equal(requests,0);assert.equal(result.requests,0);assert.equal(result.collectionMode,'from_cache');
  const saved=await readPublished(directory),pointer=JSON.parse(await readFile(join(directory,'published.json')));assert.notEqual(pointer.generation,old.generation);assert.equal(saved.recomputedFrom.generation,old.generation);assert.equal(saved.recomputedFrom.sourceId,dataPolicy.id);assert.equal(saved.short.rows[0].followup.firstSeenAt,oldSnapshot.short.rows[0].followup.firstSeenAt);assert.equal(saved.short.rows[0].triggerFollowup.referenceClose,oldSnapshot.short.rows[0].triggerFollowup.referenceClose);
  time=Date.parse('2026-11-28T09:00Z');const stale=await runDaily({directory,calendar,now:()=>time,fromCache:true,fetch:async()=>{requests++;},enrich:async()=>({})});assert.equal(stale.status,'error');assert.match(stale.error,/latest closed/);assert.deepEqual(JSON.parse(await readFile(join(directory,'published.json'))),pointer);assert.equal(requests,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('from-cache refuses corrupted current history instead of publishing a newly empty screen',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'books-us-cache-gap-'));
 try{
  await runDaily({directory,calendar,now:()=>clock,provider,enrich:async()=>({})});const old=await readPublished(directory),file=join(directory,'raw/history/TEST.json.gz'),stored=JSON.parse(gunzipSync(await readFile(file)));stored.bars.splice(210,1);
  const {gzipSync}=await import('node:zlib');await writeFile(file,gzipSync(JSON.stringify(stored)));
  const result=await runDaily({directory,calendar,now:()=>clock+1000,fromCache:true,fetch:async()=>{throw Error('no quote request allowed');},enrich:async()=>({})});assert.equal(result.status,'error');assert.match(result.error,/stale\/incomplete: TEST/);assert.deepEqual(await readPublished(directory),old);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('same-session invalid conditions are idempotent, while a new session can form a new observation id',()=>{
 const bars=breakoutBars();bars.at(-1).close+=.4;bars.at(-1).high+=.5;const source=input(bars),first=buildSelection(source,{now:clock});assert.equal(first.snapshot.short.rows[0].status,'invalid');assert.equal(first.ledger.records.length,1);
 const second=buildSelection(source,{previousLedger:first.ledger,now:clock+1000}),third=buildSelection(source,{previousLedger:second.ledger,now:clock+2000});assert.equal(second.ledger.records.length,1);assert.equal(third.ledger.records.length,1);assert.equal(second.ledger.records[0].firstSeenAt,first.ledger.records[0].firstSeenAt);assert.equal(second.ledger.records[0].trigger,first.ledger.records[0].trigger);assert.equal(second.ledger.records[0].referenceClose,first.ledger.records[0].referenceClose);assert.equal(second.snapshot.short.rows[0].hits[0].trackingId,first.ledger.records[0].id);
 source.asOf='2026-11-27';const prior=source.series.TEST.at(-1);source.series.TEST.push({...prior,date:source.asOf,open:prior.close,close:prior.close+.4,high:prior.close+.5,volume:2000000});for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol]=[...reference,{...reference.at(-1),date:source.asOf}];
 const next=buildSelection(source,{previousLedger:third.ledger,now:clock+86400000});assert.equal(next.ledger.records.filter(record=>record.rule==='U2').length,2);assert.equal(new Set(next.ledger.records.map(record=>record.id)).size,next.ledger.records.length);assert(next.ledger.records.some(record=>record.referenceDate===source.asOf));
});
test('legacy duplicate ids preserve the earliest frozen observation and never inflate future samples',()=>{
 const bars=breakoutBars();bars.at(-1).close+=.4;bars.at(-1).high+=.5;const source=input(bars),first=buildSelection(source,{now:clock}),original=first.ledger.records[0];
 const duplicate={...structuredClone(original),firstSeenAt:new Date(clock+60000).toISOString(),trigger:original.trigger+5,invalidation:original.invalidation+5,maxEntry:original.maxEntry+5,referenceClose:original.referenceClose+5};const legacy={...structuredClone(first.ledger),records:[duplicate,structuredClone(original)]},unchanged=structuredClone(legacy);
 const repaired=buildSelection(source,{previousLedger:legacy,now:clock+120000});assert.equal(repaired.ledger.records.length,1);assert.equal(repaired.ledger.summary.duplicateIdsCollapsed,1);assert.equal(repaired.snapshot.tracking.observations,1);assert.equal(repaired.ledger.records[0].firstSeenAt,original.firstSeenAt);assert.equal(repaired.ledger.records[0].trigger,original.trigger);assert.equal(repaired.ledger.records[0].referenceClose,original.referenceClose);assert.deepEqual(legacy,unchanged);
 const again=buildSelection(source,{previousLedger:repaired.ledger,now:clock+180000});assert.equal(again.ledger.records.length,1);assert.equal(again.ledger.summary.duplicateIdsCollapsed,0);assert.equal(again.snapshot.tracking.maturedTriggered3,0);
});

test('membership remains new on same-session recomputation and changes to continuing only across reference sessions',()=>{
 const source=input(),first=buildSelection(source,{now:clock}),second=buildSelection(source,{previousLedger:first.ledger,now:clock+1000});assert.equal(first.snapshot.short.rows[0].membership,'new');assert.equal(second.snapshot.short.rows[0].membership,'new');assert.equal(second.ledger.records.length,first.ledger.records.length);
 source.asOf='2026-11-27';source.series.TEST.push({date:source.asOf,open:23.25,high:23.35,low:23.11,close:23.30,volume:2000000});for(const symbol of ['SPY','QQQ'])source.benchmarks[symbol]=[...reference,{...reference.at(-1),date:source.asOf}];
 const later=buildSelection(source,{previousLedger:second.ledger,now:clock+86400000}),row=later.snapshot.short.rows[0];assert.equal(row.followup.referenceDate,day);assert.equal(row.membership,'continuing');assert.equal(later.ledger.records[0].firstSeenAt,first.ledger.records[0].firstSeenAt);
 const invalidBars=breakoutBars();invalidBars.at(-1).close+=.4;invalidBars.at(-1).high+=.5;const invalidSource=input(invalidBars),invalidFirst=buildSelection(invalidSource,{now:clock}),invalidAgain=buildSelection(invalidSource,{previousLedger:invalidFirst.ledger,now:clock+1000});assert.equal(invalidAgain.snapshot.short.rows[0].status,'invalid');assert.equal(invalidAgain.snapshot.short.rows[0].membership,'new');assert.equal(invalidAgain.ledger.records.length,1);
});
