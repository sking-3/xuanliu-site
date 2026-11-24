import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {precomputeEntryEvidence,entryChart,readHistoryLines,qualifyEntryWatch} from '../server/a-share-entry-precompute.mjs';
import {createAShareCache} from '../server/a-share-cache.mjs';
import {signalChartVersion} from '../server/a-share-signal-chart.mjs';

const require=createRequire(import.meta.url),patterns=require('../screening/trend-patterns.js'),engine=require('../screening/trend-screen.js'),{riskName}=require('../screening/market-pool.js');
const generation='2026-11-23-1',day='2026-11-23',asOf='2026-11-23T07:00:00.000Z',sourceId='tickflow-free-forward-v1';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'books-entry-evidence-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'generations',generation),privateTarget=join(dir,'private',generation),historyFile=join(dir,'history.ndjson');
  await mkdir(target,{recursive:true});await mkdir(privateTarget,{recursive:true});
  const bars=Array.from({length:80},(_,i)=>({date:new Date(Date.parse(day+'T00:00:00Z')-(79-i)*86400000).toISOString().slice(0,10),open:10,high:10.2,low:9.8,close:10,volume:1000}));
  const header={schema:'books.a-share.history.v1',generation,sourceId,day,asOf,total:1,reference:{bars}},stock={code:'600000.SH',name:'研究样本'},source={sourceId,day,status:'ready',bars,adjustment:'qfq',fetchedAt:'2026-11-23T13:00:00Z'};
  const write=async(h=header,record={stock,source})=>writeFile(historyFile,[h,record].map(x=>JSON.stringify(x)).join('\n')+'\n');await write();
  return {dir,target,privateTarget,historyFile,bars,header,stock,source,write,options:{historyFile,target,privateTarget,generation,sourceId,day,asOf,patterns,engine,riskName,now:()=>Date.parse('2026-11-24T04:00:00Z')}};
}
test('precompute stores full replay privately and publishes only batch-bound derived evidence',async t=>{
  const f=await fixture(t),summary=await precomputeEntryEvidence(f.options);
  assert.equal(summary.stocks,1);assert.equal(summary.recommended,0);
  const body=await readFile(join(f.target,'entries','600000.SH.json'),'utf8'),value=JSON.parse(body);
  assert.equal(value.schema,'books.a-share.entry-evidence.v1');assert.equal(value.generation,generation);assert.equal(value.recommended,false);
  assert(!body.includes('"bars"'));assert(!body.includes('"open"'));assert(!body.includes('"volume"'));
  const replay=JSON.parse(await readFile(join(f.privateTarget,'entries','600000.SH.json')));assert.equal(replay.schema,'books.a-share.entry-bars.v1');
  const coverage=JSON.parse(await readFile(join(f.target,'coverage.json')));assert.equal(coverage.missing,0);assert.equal(coverage.total,1);
  await f.write({...f.header,total:2});await assert.rejects(precomputeEntryEvidence(f.options),/覆盖不完整/);
  await f.write({...f.header,generation:'wrong'});await assert.rejects(precomputeEntryEvidence(f.options),/批次不符/);
});
test('source gaps stay explicit; insufficient history is not converted into eligible data',async t=>{
  const f=await fixture(t);await f.write(f.header,{stock:f.stock,source:{...f.source,status:'unavailable',reason:'不足61个交易日日线',bars:f.bars.slice(-5)}});
  await precomputeEntryEvidence(f.options);
  const coverage=JSON.parse(await readFile(join(f.target,'coverage.json')));assert.equal(coverage.missing,1);assert.equal(coverage.records[0].diagnostic.code,'insufficient_history');
  assert.equal(coverage.records[0].diagnostic.returnedBars,5);assert.equal(coverage.records[0].diagnostic.targetDayPresent,true);
  const signals=JSON.parse(await readFile(join(f.target,'signals','600000.SH.json')));assert.equal(signals.chartAvailable,false);assert.deepEqual(signals.markers,[]);
});
test('derived SVG marks actual dated key candles and escapes source labels',()=>{
  const bars=[{date:'2026-11-20',open:10,high:11,low:9,close:10,volume:1},{date:'2026-11-23',open:10,high:12,low:10,close:11,volume:2}],setup={formation:bars[0],keyBar:bars[1],trigger:{above:12},invalidation:{below:9},replayStatus:'waiting_trigger'};
  const svg=entryChart({stock:{name:'<script>&'},bars,setup});assert(svg.includes('&lt;script&gt;&amp;'));assert(!svg.includes('<script>'));assert(svg.includes('>F<'));assert(svg.includes('>C<'));assert(svg.includes('2026-11-23'));assert(svg.includes('归一化价格'));
});
test('public routes are readonly, pinned and cannot expose raw bars or traverse entry paths',async t=>{
  const f=await fixture(t);await precomputeEntryEvidence(f.options);
  const pointer={generation,sourceId,day,asOf,dataPolicy:{rawPublic:false}};await writeFile(join(f.dir,'current.json'),JSON.stringify(pointer));await writeFile(join(f.target,'complete.json'),JSON.stringify({...pointer,completed:true}));
  const api=createAShareCache({directory:f.dir});
  async function request(route){
    const url=new URL('http://localhost/api/a-share-daily/'+route),res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
    await api.handle({method:'GET',headers:{}},res,{url,path:url.pathname,json(res,status,value){res.status=status;res.value=value;}});return res;
  }
  assert.equal((await request('entries?code=600000.SH&generation='+generation)).value.generation,generation);
  assert.equal((await request('coverage')).value.missing,0);
  for(const route of ['entries?code=../collector','entry-chart?code=600000.SH&setup=3','entry-chart?code=600000.SH&setup=0&file=secret','entries?code=600000.SH&generation=2026-11-24'])assert([400,404].includes((await request(route)).status),route);
  assert.equal((await request('dataset')).status,403);
  const file=join(f.target,'entries','600000.SH.json'),value=JSON.parse(await readFile(file));await writeFile(file,JSON.stringify({...value,day:'2026-11-20'}));
  assert.equal((await request('entries?code=600000.SH')).status,503);
});
test('one completed batch publishes same-source signal metadata and both charts; mismatches and raw exports remain closed',async t=>{
  const f=await fixture(t),summary=await precomputeEntryEvidence(f.options);
  assert.equal(summary.signalChartVersion,signalChartVersion);
  const marker={generation,sourceId,day,asOf,signalChartVersion,dataPolicy:{rawPublic:false}};
  await writeFile(join(f.dir,'current.json'),JSON.stringify(marker));await writeFile(join(f.target,'complete.json'),JSON.stringify({...marker,completed:true}));
  const api=createAShareCache({directory:f.dir});
  async function request(route,headers={}){
    const url=new URL('http://localhost/api/a-share-daily/'+route),res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
    await api.handle({method:'GET',headers},res,{url,path:url.pathname,json(res,status,value){res.status=status;res.value=value;}});return res;
  }
  const query='?generation='+generation+'&code=600000.SH',meta=await request('signals'+query);
  assert.equal(meta.status,200);assert.equal(meta.value.chartAvailable,true);assert.equal(meta.value.asOf,asOf);assert.equal(meta.value.sourceFetchedAt,f.source.fetchedAt);
  assert.doesNotMatch(JSON.stringify(meta.value),/"(?:bars|open|high|low|close|volume)"/);
  for(const window of [60,120]){
    const file=join(f.target,'signals','600000.SH-'+window+'.svg');await rm(file);
    const image=await request('signal-chart'+query+'&window='+window);assert.equal(image.status,200);assert.match(image.headers['content-type'],/^image\/svg/);assert.match(image.body.toString(),/<svg/);
    assert.equal((await request('signal-chart'+query+'&window='+window,{'accept-encoding':'gzip'})).headers['content-encoding'],'gzip');
  }
  for(const route of ['signals?code=../collector','signals?code=600000.SH&bars=1','signal-chart'+query+'&window=30','signal-chart'+query+'&window=60&window=120'])assert.equal((await request(route)).status,400,route);
  for(const route of ['dataset','market'])assert.equal((await request(route)).status,403);
  const metaFile=join(f.target,'signals','600000.SH.json'),original=JSON.parse(await readFile(metaFile));
  for(const change of [{day:'2026-11-20'},{asOf:'2026-11-23T06:00:00.000Z'},{sourceId:'other'},{version:'wrong'},{stock:{code:'600001.SH'}},{markers:[{state:'live',actualFillVerified:true}]}]){
    await writeFile(metaFile,JSON.stringify({...original,...change}));
    assert.equal((await request('signals'+query)).status,503);assert.equal((await request('signal-chart'+query)).status,503);
  }
});
test('slow consumers process 120 MB of long history lines under a 64 MB heap without read-ahead accumulation',async t=>{
  const f=await fixture(t),file=join(f.dir,'large-history.ndjson'),output=await open(file,'w'),padding='x'.repeat(80*1024);
  try{for(let i=0;i<1500;i++)await output.write(JSON.stringify({i,padding})+'\n');}finally{await output.close();}
  const script=`import {readHistoryLines} from ${JSON.stringify(new URL('../server/a-share-entry-precompute.mjs',import.meta.url).href)};let count=0;for await(const line of readHistoryLines(process.argv[1])){if(JSON.parse(line).i!==count++)throw Error('line order');await new Promise(resolve=>setTimeout(resolve,1));}if(count!==1500)throw Error('coverage');console.log(count);`;
  const result=await promisify(execFile)(process.execPath,['--max-old-space-size=64','--input-type=module','-e',script,file],{maxBuffer:4096,timeout:30000});assert.equal(result.stdout.trim(),'1500');
  await writeFile(file,'{"中文":"跨字节"}\r\n\n{"最后":"无换行"}');const rows=[];for await(const line of readHistoryLines(file))rows.push(JSON.parse(line));assert.deepEqual(rows,[{中文:'跨字节'},{最后:'无换行'}]);
});


test('independent report is produced for all 16 shapes, bound to the actual private batch and readable after cold compression',async t=>{
  const f=await fixture(t),summary=await precomputeEntryEvidence(f.options),file=join(f.target,'entry-validation.json'),raw=await readFile(file,'utf8'),report=JSON.parse(raw);
  assert.equal(report.patterns.length,16);assert.deepEqual(report.patterns.map(item=>item.id),patterns.definitions.map(item=>item.id));
  for(const field of ['generation','sourceId','day','asOf'])assert.equal(report[field],f.options[field]);
  assert.equal(report.version,summary.entryValidationVersion);assert.equal(report.entryPolicyVersion,summary.entryPolicyVersion);assert.equal(report.validationFamily.hypotheses,16);assert.notEqual(report.validationFamily.id,report.validationFamily.separateFrom);
  assert(report.patterns.every(item=>item.recommended===false&&item.validation.sampleCount===0));assert.equal(report.summary.qualifiedCount,0);assert.equal(report.summary.watchCount,0);
  assert.doesNotMatch(raw,/"(?:bars|open|high|low|close|volume|prices|cookie|apiKey)"/);assert.match(report.method.returnLabel,/T后第3\/5\/10\/15/);assert.match(report.method.excessLabel,/收盘区间|收盘至/);
  const publication={generation,sourceId,day,asOf,entryPolicyVersion:summary.entryPolicyVersion,entryValidationVersion:summary.entryValidationVersion,dataPolicy:{rawPublic:false}};
  await writeFile(join(f.dir,'current.json'),JSON.stringify(publication));await writeFile(join(f.target,'complete.json'),JSON.stringify({...publication,completed:true}));
  await rm(file);const before=await readFile(join(f.dir,'current.json'),'utf8'),api=createAShareCache({directory:f.dir});
  async function request(route){const url=new URL('http://localhost/api/a-share-daily/'+route),res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};await api.handle({method:'GET',headers:{'accept-encoding':'gzip'}},res,{url,path:url.pathname,json(res,status,value){res.status=status;res.value=value;}});return res;}
  const response=await request('entry-validation?generation='+generation);assert.equal(response.status,200);assert.deepEqual(response.value,report);
  for(const route of ['dataset','market'])assert.equal((await request(route+'?generation='+generation)).status,403);
  assert.equal(await readFile(join(f.dir,'current.json'),'utf8'),before);
});

async function currentFixture(t,formationIndex){
  const f=await fixture(t);
  for(let i=75;i<80;i++){const close=10+(i-74)*.05;Object.assign(f.bars[i],{open:close-.04,high:close+.01,low:close-.06,close,volume:i===79?1100:1000});}
  f.source.fetchedAt='2026-11-23T09:00:00Z';await f.write();
  const controlled={...patterns,classify:input=>({status:'ready',labels:input.day===f.bars[formationIndex].date?[{id:'regain-ma-20'}]:[]})};
  const options={...f.options,patterns:controlled,now:()=>Date.parse('2026-11-23T12:00:00Z'),policyKnownAt:'2026-11-23T08:00:00Z',nextSessionDay:'2026-11-24',effectivePatternIds:['regain-ma-20']};
  return {...f,options};
}

test('current F and C are future condition watches with real dates, not historical trade claims or a bypass of independent gates',async t=>{
  for(const index of [78,79]){
    const f=await currentFixture(t,index);await precomputeEntryEvidence(f.options);const report=JSON.parse(await readFile(join(f.target,'entry-validation.json'))),candidate=report.current[0];
    assert.equal(report.current.length,1);assert.equal(candidate.formationDay,f.bars[index].date);assert.equal(candidate.replayStatus,index===78?'waiting_trigger':'waiting_confirmation');
    assert.equal(candidate.fresh,true);assert.equal(candidate.monitoring.nextSessionDay,'2026-11-24');assert.equal(candidate.sourceFetchedAt,f.source.fetchedAt);assert.equal(candidate.knownAt,'2026-11-23T12:00:00.000Z');assert.equal(candidate.patternGatePassed,true);assert.equal(candidate.entryGatePassed,false);assert.deepEqual(candidate.eligiblePatternIds,[]);assert.equal(candidate.qualified,false);
    assert(candidate.reasons.some(reason=>reason.includes('独立滚动验证')));assert.equal(report.summary.qualifiedCount,0);assert.equal(report.summary.watchCount,1);
    if(index===78){assert.equal(candidate.keyBarDay,day);assert.equal(candidate.trigger.above,f.bars[79].high);}else{assert.equal(candidate.keyBarDay,null);assert.equal(candidate.trigger,null);}
    const image=await readFile(join(f.target,'entries','600000.SH-0.svg'),'utf8');assert(image.includes('>F<'));assert.equal(image.includes('>C<'),index===78);
  }
});

test('the same pending candle stops claiming a fresh observation when its next opening has passed',async t=>{
  const f=await currentFixture(t,78);await precomputeEntryEvidence(f.options);const early=JSON.parse(await readFile(join(f.target,'entry-validation.json'))).current[0];assert.equal(early.fresh,true);
  await precomputeEntryEvidence({...f.options,now:()=>Date.parse('2026-11-24T04:00:00Z')});const later=JSON.parse(await readFile(join(f.target,'entry-validation.json'))).current[0];
  assert.equal(later.setupId,early.setupId);assert.equal(later.fresh,false);assert.equal(later.qualified,false);assert.equal(later.monitoring.status,'requires_fresh_data');assert(later.reasons.some(reason=>reason.includes('需要新收盘日线')));assert.equal(later.sourceFetchedAt,early.sourceFetchedAt);
});

test('the production qualifier intersects identical pattern IDs and never substitutes independently passing other IDs',()=>{
  const input={patternIds:['regain-ma-20','volume-expand'],knownAt:'2026-11-23T12:00:00Z',sourceFetchedAt:'2026-11-23T09:00:00Z',monitoring:{status:'future_condition_watch',nextSessionDay:'2026-11-24',remainingSessions:3}},before=structuredClone(input),base={computedAt:'2026-11-23T12:00:00Z'};
  const mismatched=qualifyEntryWatch(input,{...base,entryEffective:new Set(['regain-ma-20']),shapeEffective:new Set(['volume-expand'])});
  assert.equal(mismatched.entryGatePassed,true);assert.equal(mismatched.patternGatePassed,true);assert.deepEqual(mismatched.eligiblePatternIds,[]);assert.equal(mismatched.qualified,false);assert(mismatched.reasons.some(reason=>reason.includes('没有同一形态')));
  const same=qualifyEntryWatch(input,{...base,entryEffective:new Set(['regain-ma-20']),shapeEffective:new Set(['regain-ma-20'])});assert.equal(same.qualified,true);assert.deepEqual(same.eligiblePatternIds,['regain-ma-20']);
  const stale=qualifyEntryWatch(input,{...base,computedAt:'2026-11-24T04:00:00Z',entryEffective:new Set(['regain-ma-20']),shapeEffective:new Set(['regain-ma-20'])});assert.equal(stale.fresh,false);assert.equal(stale.qualified,false);
  const unknown=qualifyEntryWatch({...input,monitoring:{...input.monitoring,status:'knowledge_time_unknown'}},{...base,entryEffective:new Set(['regain-ma-20']),shapeEffective:new Set(['regain-ma-20'])});assert.equal(unknown.qualified,false);assert.equal(unknown.fresh,false);
  assert.deepEqual(input,before);assert.equal(same.knownAt,input.knownAt);assert.equal(same.sourceFetchedAt,input.sourceFetchedAt);
});
