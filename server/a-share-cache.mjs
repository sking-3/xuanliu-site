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
  async function current(){
    const value=await readJson(join(directory,'current.json'));
    if(!value||!generationPattern.test(value.generation))return null;
    return value;
  }
  async function generationDirectory(generation){
    const location=join(directory,'generations',generation);
    try{
      if(!(await stat(location)).isDirectory())return null;
      const completion=await readJson(join(location,'complete.json'));
      return completion?.completed===true&&completion.generation===generation?location:null;
    }
    catch(error){if(error.code==='ENOENT')return null;throw error;}
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
      const published=await current();
      if(route==='state'){
        const status=await readJson(join(directory,'status.json'));
        const lastSuccess=published?{generation:published.generation,day:published.day,asOf:published.asOf,finishedAt:published.finishedAt,total:published.total,ready:published.ready}:null;
        const available=Boolean(published&&await generationDirectory(published.generation));
        reply(200,{configured:status?.configured===true,schedule:status?.schedule??null,attempt:status?.attempt??null,lastSuccess,available});return true;
      }
      if(!published&&!requestedGeneration){reply(503,{error:'cache_unavailable'});return true;}
      const generation=requestedGeneration||published.generation,location=await generationDirectory(generation);
      if(!location){reply(requestedGeneration?404:503,{error:'generation_unavailable'});return true;}
      const compressed=gzipAccepted(req.headers['accept-encoding']);
      let body;
      try{body=await readFile(join(location,filename+(compressed?'.gz':'')));}
      catch(error){if(error.code==='ENOENT'){reply(503,{error:'cache_unavailable'});return true;}throw error;}
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-cache','vary':'Accept-Encoding',...(compressed?{'content-encoding':'gzip'}:{})});
      res.end(body);
    }catch{reply(503,{error:'cache_read_failed'});}
    return true;
  }
  return {handle};
}
