import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

const prefix='/api/a-share-daily/';
const modes=new Set(['consensus','market','strength']);
const samples=new Set(['120','240','all']);
const benchmarks=new Set(['000300.SH','000001.SH','399001.SZ']);
const generationPattern=/^[0-9TZ-]{1,80}$/;

async function readJson(file){
  try{return JSON.parse(await readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function gzipAccepted(header=''){
  const encodings=header.split(',').map(value=>{
    const [name,...options]=value.trim().split(';');
    const quality=options.find(option=>option.trim().startsWith('q='));
    return {name:name.trim().toLowerCase(),quality:quality?Number(quality.trim().slice(2)):1};
  });
  const encoding=encodings.find(value=>value.name==='gzip')||encodings.find(value=>value.name==='*');
  return encoding&&encoding.quality>0;
}
function validQuery(params,allowed){
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)return false;
  return true;
}

/** Reads only atomically published worker files; requests never start collection. */
export function createAShareCache({directory}){
  async function pointer(name,historical=false){
    let value;
    try{value=await readJson(join(directory,name));}
    catch(error){if(error instanceof SyntaxError)return null;throw error;}
    if(!value||!generationPattern.test(value.generation))return null;
    const completed=await generationDirectory(value.generation);
    if(!completed)return null;
    if(historical&&(value.scope!=='historical-sample'||completed.completion.scope!=='historical-sample'))return null;
    if(!historical&&(value.scope==='historical-sample'||completed.completion.scope==='historical-sample'))return null;
    return value;
  }
  async function generationDirectory(generation){
    const location=join(directory,'generations',generation);
    try{
      if(!(await stat(location)).isDirectory())return null;
      const completion=await readJson(join(location,'complete.json'));
      return completion?.completed===true&&completion.generation===generation?{location,completion}:null;
    }
    catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
  }
  async function handle(req,res,{path,url,json}){
    if(!path.startsWith(prefix))return false;
    const reply=(status,value)=>json(res,status,value,{'cache-control':'no-cache'});
    if(req.method!=='GET'){reply(405,{error:'method_not_allowed'});return true;}
    const route=path.slice(prefix.length),params=url.searchParams;
    if(!['state','result','dataset','market'].includes(route)){reply(404,{error:'not_found'});return true;}
    const allowed=route==='state'?[]:route==='result'?['mode','lookback','sampleSize','benchmark','generation']:route==='dataset'?['sampleSize','benchmark','generation']:['generation'];
    if(!validQuery(params,allowed)){reply(400,{error:'invalid_query'});return true;}
    const requestedGeneration=params.get('generation');
    if(requestedGeneration!==null&&!generationPattern.test(requestedGeneration)){reply(400,{error:'invalid_generation'});return true;}
    let filename;
    if(route==='result'){
      const mode=params.get('mode')||'consensus',lookback=params.get('lookback')||'20',requestedSample=params.get('sampleSize')||'120',benchmark=params.get('benchmark')||'000300.SH';
      if(!modes.has(mode)||!['20','60'].includes(lookback)||!samples.has(requestedSample)||!benchmarks.has(benchmark)){reply(400,{error:'invalid_query'});return true;}
      filename=`result-${mode}-${lookback}-${mode==='consensus'?requestedSample:'all'}-${benchmark}.json`;
    }else if(route==='dataset'){
      const sample=params.get('sampleSize')||'120',benchmark=params.get('benchmark')||'000300.SH';
      if(!samples.has(sample)||!benchmarks.has(benchmark)){reply(400,{error:'invalid_query'});return true;}
      filename=`dataset-${sample}-${benchmark}.json`;
    }else filename='market.json';
    try{
      const full=await pointer('current.json'),historical=await pointer('historical-current.json',true),published=full||historical;
      if(route==='state'){
        const status=await readJson(join(directory,'status.json'));
        const summary=value=>value?{generation:value.generation,day:value.day,asOf:value.asOf,finishedAt:value.finishedAt,total:value.total,ready:value.ready,
          ...(value.scope==='historical-sample'?{scope:value.scope,archiveId:value.archiveId,publishedAt:value.publishedAt,sampleCount:value.sampleCount,marketUniverseCount:value.marketUniverseCount,fullMarket:false}:{})}:null;
        reply(200,{configured:status?.configured===true,schedule:status?.schedule??null,attempt:status?.attempt??null,lastSuccess:summary(published),lastFullSuccess:summary(full),historical:summary(historical),available:Boolean(published),
          scope:published?(published.scope||'full-market'):null,sampleCount:published?(published.sampleCount??published.total):null,marketUniverseCount:published?(published.marketUniverseCount??published.total):null,fullMarket:Boolean(full)});return true;
      }
      if(!published&&!requestedGeneration){reply(503,{error:'cache_unavailable'});return true;}
      const generation=requestedGeneration||published.generation,completed=await generationDirectory(generation);
      if(!completed){reply(requestedGeneration?404:503,{error:'generation_unavailable'});return true;}
      if(route==='market'&&completed.completion.scope==='historical-sample'){reply(503,{error:'historical_market_unavailable'});return true;}
      const compressed=gzipAccepted(req.headers['accept-encoding']);
      let body;
      try{body=await readFile(join(completed.location,filename+(compressed?'.gz':'')));}
      catch(error){if(error.code==='ENOENT'){reply(503,{error:'cache_unavailable'});return true;}throw error;}
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-cache','vary':'Accept-Encoding',...(compressed?{'content-encoding':'gzip'}:{})});
      res.end(body);
    }catch{reply(503,{error:'cache_read_failed'});}
    return true;
  }
  return {handle};
}
