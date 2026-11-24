import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {precomputeEntryEvidence,entryChart,readHistoryLines} from '../server/a-share-entry-precompute.mjs';
import {createAShareCache} from '../server/a-share-cache.mjs';

const require=createRequire(import.meta.url),patterns=require('../screening/trend-patterns.js');
const generation='2026-11-23-1',day='2026-11-23',asOf='2026-11-23T07:00:00.000Z',sourceId='tickflow-free-forward-v1';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'books-entry-evidence-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'generations',generation),privateTarget=join(dir,'private',generation),historyFile=join(dir,'history.ndjson');
  await mkdir(target,{recursive:true});await mkdir(privateTarget,{recursive:true});
  const bars=Array.from({length:80},(_,i)=>({date:new Date(Date.parse(day+'T00:00:00Z')-(79-i)*86400000).toISOString().slice(0,10),open:10,high:10.2,low:9.8,close:10,volume:1000}));
  const header={schema:'books.a-share.history.v1',generation,sourceId,day,asOf,total:1,reference:{bars}},stock={code:'600000.SH',name:'研究样本'},source={sourceId,day,status:'ready',bars,adjustment:'qfq',fetchedAt:'2026-11-23T13:00:00Z'};
  const write=async(h=header,record={stock,source})=>writeFile(historyFile,[h,record].map(x=>JSON.stringify(x)).join('\n')+'\n');await write();
  return {dir,target,privateTarget,historyFile,bars,header,stock,source,write,options:{historyFile,target,privateTarget,generation,sourceId,day,asOf,patterns,now:()=>Date.parse('2026-11-24T04:00:00Z')}};
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
test('slow consumers process 120 MB of long history lines under a 64 MB heap without read-ahead accumulation',async t=>{
  const f=await fixture(t),file=join(f.dir,'large-history.ndjson'),output=await open(file,'w'),padding='x'.repeat(80*1024);
  try{for(let i=0;i<1500;i++)await output.write(JSON.stringify({i,padding})+'\n');}finally{await output.close();}
  const script=`import {readHistoryLines} from ${JSON.stringify(new URL('../server/a-share-entry-precompute.mjs',import.meta.url).href)};let count=0;for await(const line of readHistoryLines(process.argv[1])){if(JSON.parse(line).i!==count++)throw Error('line order');await new Promise(resolve=>setTimeout(resolve,1));}if(count!==1500)throw Error('coverage');console.log(count);`;
  const result=await promisify(execFile)(process.execPath,['--max-old-space-size=64','--input-type=module','-e',script,file],{maxBuffer:4096,timeout:30000});assert.equal(result.stdout.trim(),'1500');
  await writeFile(file,'{"中文":"跨字节"}\r\n\n{"最后":"无换行"}');const rows=[];for await(const line of readHistoryLines(file))rows.push(JSON.parse(line));assert.deepEqual(rows,[{中文:'跨字节'},{最后:'无换行'}]);
});
