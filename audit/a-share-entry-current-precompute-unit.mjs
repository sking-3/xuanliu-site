import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {precomputeEntryEvidence} from '../server/a-share-entry-precompute.mjs';
import {precomputeCurrentEntries,currentEntryDirectory} from '../server/a-share-entry-current-precompute.mjs';
import {createAShareCache} from '../server/a-share-cache.mjs';

const require=createRequire(import.meta.url),patterns=require('../screening/trend-patterns.js'),engine=require('../screening/trend-screen.js'),{riskName}=require('../screening/market-pool.js');
const generation='2026-11-24-1',sourceId='tickflow-free-forward-v1',day='2026-11-24',asOf='2026-11-24T07:00:00.000Z';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'books-close-view-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'generations',generation),privateTarget=join(dir,'private','generations',generation);await mkdir(target,{recursive:true});await mkdir(privateTarget,{recursive:true});
  const bars=Array.from({length:80},(_,i)=>({date:new Date(Date.parse(day+'T00:00Z')-(79-i)*86400000).toISOString().slice(0,10),open:100,high:100.1,low:99.9,close:100,volume:1000}));
  for(let i=75;i<80;i++){const close=100+(i-74)*.2;Object.assign(bars[i],{open:close-.1,high:close+.05,low:close-.15,close,volume:i===79?1100:1000});}
  const stock={code:'600000.SH',name:'收盘样本'},header={schema:'books.a-share.history.v1',generation,sourceId,day,asOf,total:1,reference:{bars}},source={status:'ready',sourceId,day,adjustment:'qfq',bars,fetchedAt:'2026-11-24T08:00:00.000Z'};
  const historyFile=join(privateTarget,'history-all.ndjson');await writeFile(historyFile,[header,{stock,source}].map(v=>JSON.stringify(v)).join('\n')+'\n');
  const now=()=>Date.parse('2026-11-24T09:00:00.000Z'),controlled={...patterns,classify:input=>({status:'ready',labels:input.day===bars[78].date?[{id:'regain-ma-20'}]:[]})};
  await precomputeEntryEvidence({historyFile,target,privateTarget,generation,sourceId,day,asOf,patterns:controlled,engine,riskName,policyKnownAt:'2026-11-24T06:00:00Z',nextSessionDay:'2026-11-25',now});
  const batch={generation,sourceId,day,asOf,total:1,dataPolicy:{rawPublic:false}};
  await writeFile(join(target,'pattern-regimes.json'),JSON.stringify({schema:'books.a-share.pattern-regimes.v1',version:'books.pattern-regimes.2026-11-24.v1',...batch,patterns:patterns.definitions.map(def=>({...def,status:'inactive',recommended:false}))}));
  await writeFile(join(dir,'current.json'),JSON.stringify(batch));await writeFile(join(target,'complete.json'),JSON.stringify({...batch,completed:true}));
  return {dir,target,privateTarget,historyFile,stock,bars,header,batch,options:{target,privateTarget,batch,siteDir:resolve('.'),nextSessionDay:'2026-11-25',now}};
}

test('current close view is appended atomically without rewriting source history, old studies or the source pointer',async t=>{
  const f=await fixture(t),old=await Promise.all([readFile(f.historyFile),readFile(join(f.target,'entry-validation.json')),readFile(join(f.dir,'current.json'))]);
  const report=await precomputeCurrentEntries(f.options);assert.equal(report.current.length,1);const item=report.current[0];
  assert.equal(report.completed,true);assert.equal(report.datasetBound,true);assert.equal(item.stage,'waiting_breakout');assert.equal(item.closePrice,101);assert.equal(item.day,day);assert.equal(item.qualified,false);assert.equal(item.actualFillVerified,false);
  assert.equal(report.summary.todayTriggeredCount,0);assert.equal(report.summary.waitingBreakoutCount,1);assert.equal(report.summary.stockCount,1);assert.equal(report.summary.entryEffectiveCount,0);
  assert.doesNotMatch(JSON.stringify(report),/"(?:bars|open|high|low|close|volume)"/);
  for(const window of [60,120]){const svg=await readFile(join(f.target,currentEntryDirectory,f.stock.code+'-'+item.formationDay+'-'+window+'.svg'),'utf8');assert.match(svg,/>C</);assert.doesNotMatch(svg,/>[BS]</);}
  for(const [index,file]of [f.historyFile,join(f.target,'entry-validation.json'),join(f.dir,'current.json')].entries())assert.deepEqual(await readFile(file),old[index]);
  const again=await precomputeCurrentEntries({...f.options,now:()=>Date.parse('2026-11-24T10:00:00Z')});assert.deepEqual(again,report);
});

test('partial source coverage and mismatched study bindings cannot publish a current view or change previous results',async t=>{
  const f=await fixture(t),old=await readFile(join(f.dir,'current.json'),'utf8'),lines=(await readFile(f.historyFile,'utf8')).trim().split('\n');
  lines[0]=JSON.stringify({...f.header,total:2});await writeFile(f.historyFile,lines.join('\n')+'\n');
  await assert.rejects(precomputeCurrentEntries(f.options),/覆盖不完整/);await assert.rejects(access(join(f.target,currentEntryDirectory,'report.json')),/ENOENT/);assert.equal(await readFile(join(f.dir,'current.json'),'utf8'),old);
  assert.equal((await readdir(f.target)).some(name=>name.startsWith('.entry-current-')),false);
  await writeFile(join(f.target,'entry-validation.json'),JSON.stringify({schema:'books.a-share.entry-validation.v1',generation:'other'}));
  await assert.rejects(precomputeCurrentEntries(f.options),/同批/);
});

test('wrong study schemas, versions and duplicated pattern identities stop before any view is created',async t=>{
  const f=await fixture(t),path=join(f.target,'entry-validation.json'),original=JSON.parse(await readFile(path));
  for(const change of [{schema:'wrong'},{version:'wrong'},{entryPolicyVersion:'wrong'},{patterns:original.patterns.map(()=>original.patterns[0])}]){
    await writeFile(path,JSON.stringify({...original,...change}));await assert.rejects(precomputeCurrentEntries(f.options),/同版本/);
    assert.equal((await readdir(f.target)).some(name=>name.startsWith('.entry-current-')||name===currentEntryDirectory),false);
  }
});

test('public current routes bind the exact candidate, generation and closed date and retain raw-export restrictions',async t=>{
  const f=await fixture(t),report=await precomputeCurrentEntries(f.options),item=report.current[0],api=createAShareCache({directory:f.dir});
  async function request(route){const url=new URL('http://localhost/api/a-share-daily/'+route),res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};await api.handle({method:'GET',headers:{}},res,{url,path:url.pathname,json(res,status,value){res.status=status;res.value=value;}});return res;}
  assert.equal((await request('entry-current')).value.current[0].closePrice,101);
  const chart='entry-current-chart?generation='+generation+'&code='+item.code+'&setup='+item.formationDay+'&window=60';
  assert.equal((await request(chart)).status,200);assert.match((await request(chart)).headers['content-type'],/^image\/svg/);
  for(const route of ['dataset','market'])assert.equal((await request(route)).status,403);
  for(const route of [chart.replace('window=60','window=30'),chart+'&file=raw','entry-current?generation='+generation+'&generation='+generation])assert.equal((await request(route)).status,400);
  assert.equal((await request(chart.replace(item.formationDay,'2026-01-01'))).status,404);
  const file=join(f.target,currentEntryDirectory,'report.json');await writeFile(file,JSON.stringify({...report,sourceDay:'2026-11-23'}));assert.equal((await request(chart)).status,503);assert.equal((await request('entry-current')).status,503);
  await rm(file);assert.equal((await request('entry-current')).status,200);assert.equal((await request(chart)).status,200);
});
