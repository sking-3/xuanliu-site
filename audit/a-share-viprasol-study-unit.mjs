import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {definitions,version,sourceCommit,familyId,policy,collectRuleEvents,validateViprasolEvents,analyzeViprasolStudy} from '../server/a-share-viprasol-study.mjs';
import {policy as originalPolicy,evaluateEvent} from '../server/a-share-pattern-regimes.mjs';

test('flat server deployment resolves registry and screening from BOOKS_SITE_DIR',async t=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),directory=await mkdtemp(join(tmpdir(),'books-viprasol-flat-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await Promise.all(['a-share-viprasol-study.mjs','a-share-pattern-regimes.mjs'].map(file=>copyFile(join(root,'server',file),join(directory,file))));
 const script='const study=await import(process.argv[1]); const original=await import(process.argv[2]); process.stdout.write(JSON.stringify({count:study.definitions.length,familyId:study.familyId,samePolicy:study.policy===original.policy,horizon:study.policy.horizon}));';
 const {stdout,stderr}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,pathToFileURL(join(directory,'a-share-viprasol-study.mjs')).href,pathToFileURL(join(directory,'a-share-pattern-regimes.mjs')).href],{cwd:directory,env:{...process.env,BOOKS_SITE_DIR:root},timeout:30000});
 assert.equal(stderr,'');
 assert.deepEqual(JSON.parse(stdout),{count:13,familyId:'viprasol-original-long-next-open-13',samePolicy:true,horizon:15});
});

function calendar(count){const days=[];for(let time=Date.UTC(2024,0,1);days.length<count;time+=86400000){const date=new Date(time);if(![0,6].includes(date.getUTCDay()))days.push(date.toISOString().slice(0,10));}return days;}
const bar=(date,price=100)=>({date,open:price,high:price*1.01,low:price*.99,close:price,volume:1000});
const signal=(bars,index)=>({index,time:Date.parse(bars[index].date+'T00:00:00.000Z'),side:'long',entry:bars[index].close,stop:1,target:1000000});
function fixture(count=500){
 const all=calendar(count+1),dates=all.slice(0,count),day=dates.at(-1),asOf=day+'T15:00:00+08:00';
 const bars=dates.map((date,i)=>bar(date,i<count-5?100:[99.5,99.6,100.2,100.6,101][i-(count-5)])),reference=dates.map(date=>bar(date));
 const stock={code:'600000.SH',name:'合成单测样本'},source={sourceId:'synthetic-fixture',day,status:'ready',adjustment:'qfq',fetchedAt:day+'T16:00:00+08:00',volumeUnit:'手',bars};
 return {dates,bars,reference,stock,source,options:{dataset:{day,asOf,expectedCount:1,reference:{code:'000300.SH',bars:reference},records:[{stock,source}]},sourceId:source.sourceId,generation:day+'-test',nextSessionDay:all[count],policyKnownAt:day+'T15:01:00+08:00',now:()=>Date.parse(day+'T17:00:00+08:00')}};
}
function matureEvents(dates,net=10){
 const events=[];for(let i=61;i<dates.length-15;i++)for(let stock=0;stock<60;stock++)if(stock%15===i%15)events.push({code:String(600000+stock)+'.SH',signalIndex:i,entryIndex:i+1,exitIndex:i+15,returns:{3:net,5:net,10:net,15:net},returnPercent:net,excessPercent:net,drawdownPercent:1});return events;
}
const fakeRegistry=(id,bars)=>({status:'ready',signals:id==='tyson'?[{index:bars.length-1,time:bars.at(-1).time,side:'long',entry:bars.at(-1).close,stop:99,target:105}]:[]});
const implementationCommit='a'.repeat(40);
const approvalFor=(rule,f,changes={})=>({ruleId:rule.id,studyVersion:version,sourceCommit,implementationCommit,parameters:{...rule.parameters},nativeVerified:true,coverageComplete:true,evidenceKind:'tradingview-pine-logs',nativeLongSignalCount:1,prefixStable:true,volumeSemanticsVerified:true,volumeUnit:'手',approvedAt:f.source.fetchedAt,...changes});

test('13 frozen long hypotheses are independent of the 16 shapes and preserve every threshold',()=>{
 assert.equal(definitions.length,13);assert.equal(new Set(definitions.map(rule=>rule.id)).size,13);
 assert.equal(definitions.some(rule=>rule.id==='khabib'||rule.id==='wave-structure-pro-v2'||rule.id==='z-score-stats'),false);
 assert.equal(familyId,'viprasol-original-long-next-open-13');assert.equal(policy,originalPolicy);
 assert.equal(Object.isFrozen(policy),true);assert.equal(Object.isFrozen(definitions),true);
 assert.throws(()=>{definitions[0].parameters.compLen=1;},TypeError);
 assert.equal(definitions.find(rule=>rule.id==='elite-flow-pro').prefixStable,false);
 assert.deepEqual(definitions.filter(rule=>!rule.volumeDependent).map(rule=>rule.id),['tyson','ronaldo','double-tap-double-top-bottom']);
 assert.equal(definitions.filter(rule=>rule.volumeDependent).length,10);
});

test('study uses next open and source+15 close, keeps cost, and ignores source reference SL/TP fills',()=>{
 const f=fixture(100),bars=f.dates.map(date=>bar(date));bars[61]={...bar(f.dates[61],105),low:100};bars[65]=bar(f.dates[65],130);bars[75]=bar(f.dates[75],115);
 const collected=collectRuleEvents({signals:[signal(bars,60)],bars,reference:f.reference,dates:f.dates,code:f.stock.code});
 assert.equal(collected.events.length,1);const event=collected.events[0];assert.equal(event.entryIndex,61);assert.equal(event.exitIndex,75);
 assert.ok(Math.abs(event.returnPercent-((115/105-1)*100-.3))<1e-12);
 assert.ok(Math.abs(event.drawdownPercent-(1-100/130)*100)<1e-12);
 assert.deepEqual(event,evaluateEvent({bars,reference:f.reference,signalIndex:60,code:f.stock.code}));
});

test('reserve before outcomes: a later executable signal cannot replace an earlier unexecutable one',()=>{
 const f=fixture(110),bars=f.dates.map(date=>bar(date));bars[61]={date:f.dates[61],open:110,high:110,low:110,close:110,volume:1000};
 const collected=collectRuleEvents({signals:[signal(bars,60),signal(bars,62)],bars,reference:f.reference,dates:f.dates,code:f.stock.code});
 assert.equal(collected.counts.unexecutable,1);assert.equal(collected.counts.overlapReserved,1);assert.equal(collected.events.length,0);
 const changed=bars.map((bar,i)=>i>62?{...bar,close:1000,high:1001,open:1000,low:999}:bar);
 const later=collectRuleEvents({signals:[signal(changed,60),signal(changed,62)],bars:changed,reference:f.reference,dates:f.dates,code:f.stock.code});
 assert.deepEqual(later.reservations,collected.reservations);assert.equal(later.counts.overlapReserved,1);
});

test('pending events reserve the same interval before future bars exist; no premature 15-day sample',()=>{
 const f=fixture(110),signals=[signal(f.bars,80),signal(f.bars,82)];
 const first=collectRuleEvents({signals,bars:f.bars.slice(0,90),reference:f.reference.slice(0,90),dates:f.dates.slice(0,90),code:f.stock.code});
 const mature=collectRuleEvents({signals,bars:f.bars,reference:f.reference,dates:f.dates,code:f.stock.code});
 assert.equal(first.events.length,0);assert.equal(first.counts.pending,1);assert.equal(first.counts.overlapReserved,1);
 assert.deepEqual(mature.reservations,first.reservations);assert.equal(mature.events.length,1);assert.equal(mature.events[0].signalIndex,80);
});

test('missing stock trading day is not bridged in the holding interval',()=>{
 const f=fixture(110),bars=f.bars.filter(bar=>bar.date!==f.dates[70]);
 const out=collectRuleEvents({signals:[signal(bars,60)],bars,reference:f.reference,dates:f.dates,code:f.stock.code});
 assert.equal(out.counts.unavailable,1);assert.equal(out.events.length,0);
});

test('older stock-only history seeds the original port but cannot invent an older benchmark outcome',()=>{
 const f=fixture(110),dates=f.dates.slice(20),reference=f.reference.slice(20);
 const out=collectRuleEvents({signals:[signal(f.bars,10),signal(f.bars,60)],bars:f.bars,reference,dates,code:f.stock.code});
 assert.equal(out.counts.outsideReferenceHistory,1);assert.equal(out.events.length,1);assert.equal(out.events[0].signalIndex,40);
});

test('rolling gate keeps 120/60/180, purge15, fold20 and fixed 13-comparison correction',()=>{
 const dates=calendar(500),report=validateViprasolEvents(matureEvents(dates),dates);
 assert.equal(report.statisticalGatePassed,true);assert.equal(report.validation.folds.length,9);
 assert.equal(report.validation.adjustedPValue,Math.min(1,report.validation.pValue*13));
 assert.ok(report.validation.blockCount>=policy.minIndependentBlocks);
 for(const fold of report.validation.folds){assert.ok(fold.trainedThrough<fold.startDay);assert.ok(fold.trainingOutcomeThrough<fold.startDay);const a=dates.indexOf(fold.trainedThrough),b=dates.indexOf(fold.startDay);assert.equal(b-a,16);}
 const bad=validateViprasolEvents(matureEvents(dates,-10),dates);assert.equal(bad.statisticalGatePassed,false);assert.ok(bad.reasons.includes('validation_meanReturnPercent'));
 const short=calendar(389),incomplete=validateViprasolEvents(matureEvents(short),short);assert.equal(incomplete.statisticalGatePassed,false);assert.ok(incomplete.reasons.includes('history'));
});

test('cannot pass malformed, future-mature, same-day-entry or overlapping event cohorts',()=>{
 const dates=calendar(100),base={code:'600000.SH',signalIndex:61,entryIndex:62,exitIndex:76,returns:{3:1,5:1,10:1,15:1},returnPercent:1,excessPercent:1,drawdownPercent:0};
 assert.throws(()=>validateViprasolEvents([{...base,entryIndex:61}],dates),/invalid/);
 assert.throws(()=>validateViprasolEvents([{...base,signalIndex:90,entryIndex:91,exitIndex:105}],dates),/invalid/);
 assert.throws(()=>validateViprasolEvents([base,{...base,signalIndex:62,entryIndex:63,exitIndex:77}],dates),/overlap/);
});

test('no native allowlist means no qualification, even when an injected test evaluator finds today long',async()=>{
 const f=fixture(),out=await analyzeViprasolStudy({...f.options,evaluate:fakeRegistry});
 assert.equal(out.completed,true);assert.equal(out.summary.ruleCount,13);assert.equal(out.summary.nativeApprovedCount,0);assert.equal(out.eligibleForSelection,false);
 assert.equal(out.current.length,1);assert.equal(out.current[0].signalDay,f.dates.at(-1));assert.equal(out.current[0].actualFillVerified,false);assert.equal(out.current[0].entryMode,'next_open_recheck_required');
 assert.equal(out.rules.every(rule=>!rule.eligibleForSelection),true);assert.ok(out.rules[0].reasons.includes('native_review_allowlist_missing'));
 assert.ok(out.rules[0].reasons.includes('synthetic_evaluator_not_native_evidence'));
 assert.equal(out.rules.find(rule=>rule.id==='elite-flow-pro').counts.prefixUnstable,1);
});

test('partial or zero-long native evidence cannot pass the independent native gate',async()=>{
 const f=fixture(),rule=definitions[0];
 for(const [change,reason]of [[{coverageComplete:false},'native_scope_not_fully_reviewed'],[{nativeLongSignalCount:0},'native_long_branch_unobserved'],[{parameters:{...rule.parameters,compLen:11}},'native_source_parameters_or_version_mismatch']]){
  const out=await analyzeViprasolStudy({...f.options,implementationCommit,evaluate:fakeRegistry,nativeApprovals:[approvalFor(rule,f,change)]});assert.equal(out.eligibleForSelection,false);assert.ok(out.rules[0].nativeGate.reasons.includes(reason));
 }
});

test('only the three explicit price rules can omit volume semantics; all flow rules remain gated',async()=>{
 const f=fixture();f.source.volumeUnit='unknown';
 for(const rule of definitions){
  const approved=approvalFor(rule,f,{volumeSemanticsVerified:false,volumeUnit:'unknown'});
  const out=await analyzeViprasolStudy({...f.options,implementationCommit,evaluate:fakeRegistry,nativeApprovals:[approved]}),gate=out.rules.find(item=>item.id===rule.id).nativeGate;
  if(rule.volumeDependent){assert.equal(gate.passed,false,rule.id);assert.ok(gate.reasons.includes('volume_semantics_unknown_or_mismatched'),rule.id);}
  else{assert.equal(gate.passed,true,rule.id);assert.equal(gate.reasons.includes('volume_semantics_unknown_or_mismatched'),false,rule.id);}
  assert.equal(out.eligibleForSelection,false,'synthetic evaluation never becomes selection evidence');
 }
});

test('native approval binds the exact implementation commit; missing binding only blocks native',async()=>{
 const f=fixture(),rule=definitions[0],approved=approvalFor(rule,f);
 const bound=await analyzeViprasolStudy({...f.options,implementationCommit,evaluate:fakeRegistry,nativeApprovals:[approved]});
 assert.equal(bound.implementationCommit,implementationCommit);assert.equal(bound.rules[0].nativeGate.implementationCommit,implementationCommit);assert.equal(bound.rules[0].nativeGate.passed,true);
 for(const change of [{implementationCommit:null},{implementationCommit:'b'.repeat(40)},{implementationCommit:'not-a-commit'}]){
  const out=await analyzeViprasolStudy({...f.options,...change,evaluate:fakeRegistry,nativeApprovals:[approved]});
  assert.equal(out.completed,true);assert.equal(out.rules[0].nativeGate.passed,false);assert.equal(out.eligibleForSelection,false);
  assert.deepEqual(out.rules[0].fit,bound.rules[0].fit);assert.deepEqual(out.rules[0].validation,bound.rules[0].validation);
  assert.ok(out.rules[0].nativeGate.reasons.includes('native_implementation_commit_mismatch'));
 }
 const absent={...approved};delete absent.implementationCommit;
 const missingApproval=await analyzeViprasolStudy({...f.options,implementationCommit,evaluate:fakeRegistry,nativeApprovals:[absent]});
 assert.equal(missingApproval.rules[0].nativeGate.passed,false);assert.ok(missingApproval.rules[0].nativeGate.reasons.includes('native_implementation_commit_mismatch'));
 const research=await analyzeViprasolStudy({...f.options,evaluate:fakeRegistry});assert.equal(research.completed,true);assert.equal(research.implementationCommit,null);assert.ok(research.rules[0].nativeGate.reasons.includes('implementation_commit_unbound'));
});

test('summary separates statistical success from an empty native allowlist and effective rules',async()=>{
 const f=fixture(),records=Array.from({length:60},(_,index)=>({stock:{code:String(600000+index)+'.SH',name:'合成统计测试'},source:{...f.source,bars:f.dates.map((date,i)=>bar(date,100*1.01**i))}}));
 const evaluator=(id,bars,parameters,context)=>({status:'ready',signals:id==='tyson'?bars.map((bar,index)=>({index,time:bar.time,side:'long',entry:bar.close})).filter(signal=>signal.index>=61&&signal.index%15===Number(context.symbol.slice(0,6))%15):[]});
 const out=await analyzeViprasolStudy({...f.options,dataset:{...f.options.dataset,expectedCount:records.length,records},evaluate:evaluator});
 assert.equal(out.summary.statisticalPassedCount,1);assert.equal(out.rules[0].statisticalGatePassed,true);
 assert.equal(out.summary.nativeApprovedCount,0);assert.equal(out.summary.effectiveCount,0);assert.equal(out.eligibleForSelection,false);
});

test('current list cannot recycle an old B, chase a large lift, or survive a passed next open',async()=>{
 const old=(id,bars)=>({status:'ready',signals:id==='tyson'?[{index:bars.length-21,time:bars.at(-21).time,side:'long',entry:100}]:[]});
 const f=fixture();assert.equal((await analyzeViprasolStudy({...f.options,evaluate:old})).current.length,0);
 const lifted=fixture();lifted.source.bars.at(-1).close=125;lifted.source.bars.at(-1).high=126;lifted.source.bars.at(-1).open=124;assert.equal((await analyzeViprasolStudy({...lifted.options,evaluate:fakeRegistry})).current.length,0);
 const expired=await analyzeViprasolStudy({...f.options,evaluate:fakeRegistry,now:()=>Date.parse(f.options.nextSessionDay+'T10:00:00+08:00')});assert.equal(expired.current.length,0);
});

test('unknown official tick blocks dependent ports; source/calendar future or incomplete coverage rejects',async()=>{
 const f=fixture(),out=await analyzeViprasolStudy(f.options);assert.ok(out.rules.find(rule=>rule.id==='pressure-flow-pro').counts.missingDependencies>0);assert.equal(out.eligibleForSelection,false);
 const future=fixture();future.source.bars.push(bar(future.options.nextSessionDay));await assert.rejects(analyzeViprasolStudy(future.options),/mismatch/);
 const incomplete=fixture();incomplete.options.dataset.expectedCount=2;await assert.rejects(analyzeViprasolStudy({...incomplete.options,evaluate:fakeRegistry}),/coverage incomplete/);
 const duplicate=fixture();duplicate.options.dataset.records.push({...duplicate.options.dataset.records[0]});await assert.rejects(analyzeViprasolStudy({...duplicate.options,evaluate:fakeRegistry}),/mismatch/);
});
