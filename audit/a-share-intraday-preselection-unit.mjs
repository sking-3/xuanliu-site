import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectIntradayPreselection,recheckIntradayCandidate,parseTencentQuotes,sourceId} from '../server/a-share-intraday-preselection.mjs';
import {closeCandidateVersion} from '../server/a-share-entry-current.mjs';
import calendar from '../market-calendar.js';

test('14:00 timer has bounded same-day checks and never replays a missed market snapshot',async()=>{
 const timer=await readFile(new URL('../server/books-a-share-a14.timer',import.meta.url),'utf8');
 const service=await readFile(new URL('../server/books-a-share-a14.service',import.meta.url),'utf8');
 assert.deepEqual(timer.match(/^OnCalendar=.+$/gm),['OnCalendar=Mon..Fri *-*-* 14:00:30 Asia/Shanghai','OnCalendar=Mon..Fri *-*-* 14:03:00 Asia/Shanghai','OnCalendar=Mon..Fri *-*-* 14:07:00 Asia/Shanghai']);
 assert.match(timer,/^Persistent=false$/m);assert.match(service,/--max-old-space-size=128 .*a-share-intraday-preselection\.mjs$/m);
 assert.match(service,/^User=books$/m);assert.doesNotMatch(service,/EnvironmentFile=|API_KEY|TOKEN/);
});

const historySource='tickflow-free-forward-v1',historyDay='2026-11-25',day='2026-11-26',generation='2026-11-25-1',receivedAt=day+'T14:00:31+08:00';
const prices=[];for(let date=Date.parse(historyDay+'T00:00:00Z');prices.length<61;date-=86400000){const day=new Date(date).toISOString().slice(0,10);if(calendar.session('CN',day).open)prices.unshift({date:day,open:10,high:10.1,low:9.9,close:10,volume:100});}
const parent=(code='600001.SH')=>({code,name:'Fixture',day:historyDay,stage:'waiting_breakout',remainingSessions:2,setupId:code+':2026-11-23',patternIds:['regain-ma-20'],trigger:{above:10.2},invalidation:{below:9.5},distanceToTriggerPct:-1.96});
const source=()=>({sourceId:historySource,day:historyDay,status:'ready',adjustment:'qfq',fetchedAt:historyDay+'T16:00:00+08:00',bars:structuredClone(prices)});
const quote=(code='600001.SH')=>({code,name:'Fixture',price:10.25,prevClose:10,open:10.01,high:10.3,low:10,sourceAt:day+'T14:00:30+08:00'});
const input=()=>({parent:parent(),source:source(),reference:{code:'000300.SH',bars:structuredClone(prices)},quote:quote(),day,receivedAt,historyGeneration:generation});
function line(symbol,at='20261126140030'){
 const fields=Array(88).fill('');Object.assign(fields,{1:'Fixture',2:symbol.slice(2),3:'10.25',4:'10',5:'10.01',6:'9999',30:at,33:'10.3',34:'10'});return 'v_'+symbol+'="'+fields.join('~')+'";';
}
test('parses normal public quote payload without evaluating JavaScript and rejects wrong or duplicate identities',()=>{
 const rows=parseTencentQuotes(line('sh600001'),['sh600001']);assert.equal(rows.get('sh600001').price,10.25);assert.equal(rows.get('sh600001').sourceAt,day+'T14:00:30+08:00');
 assert.throws(()=>parseTencentQuotes(line('sh600002'),['sh600001']),/身份/);assert.throws(()=>parseTencentQuotes(line('sh600001')+line('sh600001'),['sh600001']),/重复/);assert.throws(()=>parseTencentQuotes('globalThis.compromised=true',['sh600001']),/缺少/);assert.equal(globalThis.compromised,undefined);
});
test('fresh current-day trigger is a distinct unvalidated observation with real quote and receipt timestamps',()=>{
 const result=recheckIntradayCandidate(input());assert.equal(result.accepted,true);assert.equal(result.row.state,'triggered_B');assert.equal(result.row.qualified,false);assert.equal(result.row.phase,'a14');assert.equal(result.row.sourceId,sourceId);assert.equal(result.row.historySourceId,historySource);assert.equal(result.row.anchorDay,day);assert.equal(result.row.basisDay,historyDay);assert.equal(result.row.firstSeenAt,receivedAt);assert.equal(result.bars.at(-1).volume,null);assert.equal(result.bars.at(-1).close,10.25);
});
test('never bridges mismatched price bases, reuses yesterday triggered B, or accepts expired or stale quotes',()=>{
 for(const change of [v=>v.quote.prevClose=9.8,v=>v.parent.stage='triggered_at_close',v=>v.parent.remainingSessions=0,v=>v.quote.sourceAt=historyDay+'T14:00:30+08:00',v=>v.quote.sourceAt=day+'T13:59:59+08:00',v=>v.receivedAt=day+'T14:11:00+08:00',v=>v.quote.name='*ST Fixture']){const value=input();change(value);assert.equal(recheckIntradayCandidate(value).accepted,false);}
});
test('invalidation, opening gap and overheating remove candidates while an untriggered near price stays near B',()=>{
 for(const change of [v=>v.quote.low=9.4,v=>v.quote.open=10.5,v=>{v.quote.price=10.5;v.quote.high=10.6;},v=>{v.source.bars.at(-5).close=9;},v=>{v.source.bars.at(-20).close=8;}]){const value=input();change(value);assert.equal(recheckIntradayCandidate(value).accepted,false);}
 const near=input();near.quote.price=10.15;assert.equal(recheckIntradayCandidate(near).row.state,'near_B');
});
async function fixture(t,count=6){
 const dir=await mkdtemp(join(tmpdir(),'books-a14-'));t.after(()=>rm(dir,{recursive:true,force:true}));const target=join(dir,'generations',generation),raw=join(dir,'private','generations',generation);await mkdir(join(target,'entry-current-v2'),{recursive:true});await mkdir(raw,{recursive:true});
 const batch={generation,sourceId:historySource,day:historyDay,asOf:historyDay+'T15:00:00+08:00',total:1000,ready:1000,fullMarket:true},parents=Array.from({length:count},(_,i)=>parent(String(600001+i)+'.SH'));
 await writeFile(join(dir,'current.json'),JSON.stringify(batch));await writeFile(join(target,'complete.json'),JSON.stringify({...batch,completed:true,closeCandidateVersion}));await writeFile(join(target,'entry-current-v2/report.json'),JSON.stringify({...batch,schema:'books.a-share.entry-current.v1',version:closeCandidateVersion,datasetBound:true,completed:true,current:parents}));
 await writeFile(join(raw,'history-all.ndjson'),[{schema:'books.a-share.history.v1',...batch,historyRequested:500,reference:{code:'000300.SH',bars:prices}},...parents.map(stock=>({stock,source:source()}))].map(JSON.stringify).join('\n'));
 let clock=Date.parse(receivedAt);const requests=[],waits=[],calendar={clock:()=>({date:day,time:'140031'}),session:()=>({verified:true,open:true}),latestClosed:()=>({date:historyDay})};
 const fetch=async url=>{requests.push(String(url));const symbols=String(url).split('/q=')[1].split(',');const at=new Date(clock-1000+8*3600000).toISOString().slice(0,19).replace(/[-:T]/g,'');return new Response(symbols.map(symbol=>line(symbol,at)).join('\n'));};
 return {dir,parents,requests,waits,options:{dir,siteDir:process.cwd(),calendar,fetch,now:()=>clock,wait:async ms=>{waits.push(ms);clock+=ms;}}};
}
test('collects at most five symbols per request, freezes one cohort, and a second scheduled check makes no requests',async t=>{
 const f=await fixture(t);const first=await collectIntradayPreselection(f.options);assert.equal(first.attempt.status,'complete');assert.equal(f.requests.length,2);assert.equal(f.waits.length,1);assert.equal(f.waits[0],6500);assert.equal(first.lastSuccess.current.length,6);assert(first.lastSuccess.current.every(row=>row.generation===first.lastSuccess.generation));assert(first.lastSuccess.current.every(row=>row.qualified===false&&row.phase==='a14'));assert.equal(new Set(first.lastSuccess.current.map(row=>row.receivedAt)).size,2);
 const frozen=await readFile(join(f.dir,'intraday-preselection-v1/days',day,'report.json'));const second=await collectIntradayPreselection(f.options);assert.equal(second.attempt.status,'no_new_snapshot');assert.equal(f.requests.length,2);assert.deepEqual(await readFile(join(f.dir,'intraday-preselection-v1/days',day,'report.json')),frozen);
 const svg=await readFile(join(f.dir,'intraday-preselection-v1/days',day,'charts/600001.SH-60.svg'),'utf8');assert.match(svg,/data-phase="a14"/);assert.match(svg,/data-kind="B" data-day="2026-11-26"/);
});
test('closed hours make zero requests and an explicit 403 keeps the stock source stopped on the next run',async t=>{
 const f=await fixture(t,1);const closed=await collectIntradayPreselection({...f.options,calendar:{...f.options.calendar,clock:()=>({date:day,time:'180000'})}});assert.equal(closed.attempt.status,'closed');assert.equal(closed.attempt.requests,0);
 let calls=0;const denied={...f.options,fetch:async()=>{calls++;return new Response('Denied',{status:403});}};const first=await collectIntradayPreselection(denied);assert.equal(first.attempt.status,'held');assert.equal(first.lastSuccess,null);assert.equal(calls,1);const second=await collectIntradayPreselection(denied);assert.equal(second.attempt.status,'held');assert.equal(second.attempt.requests,0);assert.equal(calls,1);
});
test('recent missing trading sessions are not replaced with older bars and old invalid prices only shorten the real chart prefix',()=>{
 const missing=input();missing.source.bars.splice(-10,1);assert.equal(recheckIntradayCandidate(missing).accepted,false);const halted=input();halted.source.bars.at(-4).volume=0;assert.equal(recheckIntradayCandidate(halted).accepted,false);
 const old=input();old.source.bars[0].close=0;const result=recheckIntradayCandidate(old);assert.equal(result.accepted,true);assert.equal(result.bars.length,61);assert.equal(result.bars[0].date,prices[1].date);
});
test('a stale whole first cohort does not freeze an empty day and the next scheduled fresh snapshot can proceed',async t=>{
 const f=await fixture(t,1);const first=await collectIntradayPreselection({...f.options,fetch:async()=>new Response(line('sh600001','20261126135959'))});assert.equal(first.attempt.status,'waiting_source');assert.equal(first.lastSuccess,null);await assert.rejects(readFile(join(f.dir,'intraday-preselection-v1/days',day,'report.json')),/ENOENT/);
 const next=await collectIntradayPreselection(f.options);assert.equal(next.attempt.status,'complete');assert.equal(next.lastSuccess.current.length,1);
});
test('wrong source bindings and future history reads fail before contacting the public quote source',async t=>{
 const f=await fixture(t,1),file=join(f.dir,'generations',generation,'entry-current-v2/report.json'),entry=JSON.parse(await readFile(file));entry.sourceId='other';await writeFile(file,JSON.stringify(entry));const failed=await collectIntradayPreselection(f.options);assert.equal(failed.attempt.status,'failed');assert.equal(f.requests.length,0);
});
