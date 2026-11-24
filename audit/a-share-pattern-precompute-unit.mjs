import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {precomputePatternStatistics} from '../server/a-share-pattern-precompute.mjs';

const require=createRequire(import.meta.url),patterns=require('../screening/trend-patterns.js');
const day='2026-11-23',asOf='2026-11-23T08:00:00.000Z',generation='2026-11-23-1',sourceId='tickflow-free-forward-v1';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'books-pattern-stream-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const historyFile=join(dir,'history-all.ndjson'),target=join(dir,'public');await mkdir(target);
  const bars=Array.from({length:80},(_,i)=>({date:new Date(Date.parse(day+'T00:00:00Z')-(79-i)*86400000).toISOString().slice(0,10),open:10,high:10.2,low:9.8,close:10,volume:1000}));
  const header={schema:'books.a-share.history.v1',generation,sourceId,day,asOf,total:1,universePolicy:{basis:'current-roster-retrospective'},reference:{code:'000300.SH',bars}};
  const record={stock:{code:'600000.SH',name:'样本',listingDate:'2000-01-01'},source:{sourceId,day,status:'ready',adjustment:'qfq',bars}};
  const write=async(h=header,records=[record])=>writeFile(historyFile,[h,...records].map(x=>JSON.stringify(x)).join('\n')+'\n');
  await write();return {dir,historyFile,target,header,record,write,options:{historyFile,target,generation,sourceId,day,asOf,patterns,now:()=>Date.parse('2026-11-24T00:00:00Z')}};
}
test('private history streams into derived statistics with matching source dates and explicit insufficient history',async t=>{
  const f=await fixture(t),result=await precomputePatternStatistics(f.options);
  assert.equal(result.generation,generation);assert.equal(result.day,day);assert.equal(result.sourceId,sourceId);assert.equal(result.candidates.length,0);
  assert.equal(result.coverage.historyDays,80);assert.equal(result.patterns.length,16);assert(result.patterns.every(x=>x.status!=='effective'));
  const body=await readFile(join(f.target,'pattern-regimes.json'),'utf8');assert.deepEqual(JSON.parse(body),result);
  assert.equal(gunzipSync(await readFile(join(f.target,'pattern-regimes.json.gz'))).toString(),body);
  assert.equal(body.includes('"bars"'),false);assert.equal(body.includes('"open"'),false);
});
test('mismatched metadata, incomplete and duplicate history cannot publish or replace statistics',async t=>{
  const f=await fixture(t),path=join(f.target,'pattern-regimes.json');await writeFile(path,'previous');
  for(const [header,records] of [[{...f.header,generation:'old'},[f.record]],[{...f.header,total:2},[f.record]],[{...f.header,total:2},[f.record,f.record]],[f.header,[{...f.record,source:{...f.record.source,sourceId:'other'}}]]]){
    await f.write(header,records);await assert.rejects(precomputePatternStatistics(f.options),/归档|覆盖|重复|来源/);assert.equal(await readFile(path,'utf8'),'previous');
  }
});
