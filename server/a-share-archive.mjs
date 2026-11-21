import {mkdir, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';

const require=createRequire(import.meta.url);
const indexNames={'000300.SH':'沪深300','000001.SH':'上证指数','399001.SZ':'深证成指'};

/** Publishes a completed archive offline; collection status and full-market pointers are untouched. */
export async function publishArchivedDataset({dataset,archiveId,dir,siteDir,now=Date.now}){
  const model=require(join(siteDir,'control/model.js'));
  const engine=require(join(siteDir,'screening/trend-screen.js'));
  const archived=model.normalizeDataset(dataset);
  if(archived.expectedCount!==120)throw Error('历史样本发布只支持完整的120只归档。');
  if(typeof archiveId!=='string'||!archiveId.trim())throw Error('历史样本缺少原始归档标识。');
  const timestamp=now(),publishedAt=new Date(timestamp).toISOString();
  const generation=archived.day+'-'+timestamp+'-120';
  const location=join(dir,'generations',generation);
  await mkdir(join(dir,'generations'),{recursive:true});
  await mkdir(location);
  async function save(name,value){
    const body=JSON.stringify(value);
    await writeFile(join(location,name+'.json'),body);
    await writeFile(join(location,name+'.json.gz'),gzipSync(body));
  }
  const metadata={scope:'historical-sample',archiveId,sampleCount:archived.expectedCount,marketUniverseCount:archived.totalUniverseCount,fullMarket:false};
  const manifest={generation,day:archived.day,asOf:archived.asOf,finishedAt:publishedAt,publishedAt,total:archived.expectedCount,ready:archived.records.filter(record=>record.source.status==='ready').length,...metadata};
  const benchmark=archived.reference.code;
  await save('dataset-120-'+benchmark,archived);
  await save('dataset-all-'+benchmark,archived);
  for(const mode of ['consensus','market','strength'])for(const lookback of [20,60]){
    const evaluated=await model.evaluateDataset(archived,{settings:{mode,lookback,sampleSize:'120',benchmark,limits:{enabled:false}}},engine);
    const results=new Map(evaluated.records.map(record=>[record.stock.code,record.result]));
    const records=archived.records.map(record=>({stock:record.stock,fetchedAt:record.source.fetchedAt||null,referenceFetchedAt:archived.reference.fetchedAt,
      result:results.get(record.stock.code)||{status:'unavailable',matched:null,excluded:false,exclusionReasons:[],metrics:null,reasons:[],reason:evaluated.reason}}));
    await save('result-'+mode+'-'+lookback+'-'+(mode==='consensus'?'120':'all')+'-'+benchmark,{
      generation,mode,lookback,day:archived.day,asOf:archived.asOf,...metadata,
      reference:{code:benchmark,name:indexNames[benchmark]},limits:{enabled:false},status:evaluated.status,phase:'evaluated',
      records,total:archived.expectedCount,counts:evaluated.counts,consensus:mode==='consensus'?evaluated.summary:null,
      referenceFetchedAt:archived.reference.fetchedAt,poolFetchedStart:evaluated.sourceTimes.fetchedStart,poolFetchedEnd:evaluated.sourceTimes.fetchedEnd,
      requests:0,startedAt:publishedAt,finishedAt:publishedAt,publishedAt,reason:evaluated.reason
    });
  }
  await save('complete',{...manifest,completed:true});
  const pointer=join(dir,'historical-current.json');
  await writeFile(pointer+'.tmp',JSON.stringify(manifest));
  await rename(pointer+'.tmp',pointer);
  return manifest;
}
