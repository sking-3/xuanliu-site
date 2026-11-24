import {createReadStream} from 'node:fs';
import {writeFile,rename} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {analyzePatternRegimes} from './a-share-pattern-regimes.mjs';

/** Streams private source history. Only derived, batch-bound statistics leave this module. */
export async function precomputePatternStatistics({historyFile,target,generation,sourceId,day,asOf,patterns,now=Date.now,onProgress}={}){
  const input=createReadStream(historyFile),reader=createInterface({input,crlfDelay:Infinity});
  const iterator=reader[Symbol.asyncIterator]();
  try{
    const first=await iterator.next();
    if(first.done)throw Error('形态历史归档缺少元数据');
    const header=JSON.parse(first.value);
    if(header.schema!=='books.a-share.history.v1'||header.generation!==generation||header.sourceId!==sourceId||header.day!==day||header.asOf!==asOf||!Number.isInteger(header.total)||header.total<1)throw Error('形态历史归档与日终批次不一致');
    const records=(async function*(){
      let count=0;const seen=new Set();
      for(let next=await iterator.next();!next.done;next=await iterator.next()){
        const record=JSON.parse(next.value),code=record.stock?.code;
        if(typeof code!=='string'||seen.has(code)||record.source?.sourceId!==sourceId||record.source?.day!==day)throw Error('形态历史证券重复或来源、日期不符');
        seen.add(code);count++;yield record;
      }
      if(count!==header.total)throw Error('形态历史证券覆盖与完成批次不一致');
    })();
    const result=await analyzePatternRegimes({dataset:{day,asOf,reference:header.reference,expectedCount:header.total,universeMetadata:header.universePolicy},records,patterns,day,asOf,sourceId,generation,now,onProgress});
    const body=JSON.stringify(result),path=join(target,'pattern-regimes.json');
    await writeFile(path+'.tmp',body);await rename(path+'.tmp',path);
    await writeFile(path+'.gz.tmp',gzipSync(body));await rename(path+'.gz.tmp',path+'.gz');
    return result;
  }finally{reader.close();input.destroy();}
}
