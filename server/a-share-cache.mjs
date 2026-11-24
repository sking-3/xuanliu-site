import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {readStoredFile,readStoredJson} from './a-share-retention.mjs';
import {closeCandidateVersion} from './a-share-entry-current.mjs';
import {currentEntryDirectory} from './a-share-entry-current-precompute.mjs';
import {entryPolicyVersion} from './a-share-entry-bars.mjs';
import {entryValidationVersion} from './a-share-entry-validation.mjs';

const prefix='/api/a-share-daily/';
const modes=new Set(['consensus','market','strength']);
const samples=new Set(['120','240','all']);
const benchmarks=new Set(['000300.SH','000001.SH','399001.SZ']);
const generationPattern=/^[0-9TZ-]{1,80}$/;

async function readJson(file){
  try{return await readStoredJson(file);}
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
    if(!['state','result','dataset','market','patterns','entries','entry-chart','coverage','entry-validation','signals','signal-chart','entry-current','entry-current-chart'].includes(route)){reply(404,{error:'not_found'});return true;}
    const allowed=route==='state'?[]:route==='result'?['mode','lookback','sampleSize','benchmark','generation']:route==='dataset'?['sampleSize','benchmark','generation']:['entries','signals'].includes(route)?['generation','code']:route==='entry-chart'?['generation','code','setup']:route==='signal-chart'?['generation','code','window']:route==='entry-current-chart'?['generation','code','setup','window']:['generation'];
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
    }else if(['entries','entry-chart'].includes(route)){
      const code=params.get('code'),setup=params.get('setup');
      if(!/^\d{6}\.(SH|SZ)$/.test(code||'')||route==='entry-chart'&&!/^[012]$/.test(setup||'')){reply(400,{error:'invalid_query'});return true;}
      filename=join('entries',code+(route==='entry-chart'?'-'+setup+'.svg':'.json'));
    }else if(['signals','signal-chart'].includes(route)){
      const code=params.get('code'),window=params.get('window')||'60';
      if(!/^\d{6}\.(SH|SZ)$/.test(code||'')||route==='signal-chart'&&!['60','120'].includes(window)){reply(400,{error:'invalid_query'});return true;}
      filename=join('signals',code+(route==='signal-chart'?'-'+window+'.svg':'.json'));
    }else if(route==='entry-current-chart'){
      const code=params.get('code'),setup=params.get('setup'),window=params.get('window')||'60';
      if(!/^\d{6}\.(SH|SZ)$/.test(code||'')||!/^\d{4}-\d{2}-\d{2}$/.test(setup||'')||!['60','120'].includes(window)){reply(400,{error:'invalid_query'});return true;}
      filename=join(currentEntryDirectory,code+'-'+setup+'-'+window+'.svg');
    }else filename=route==='entry-current'?join(currentEntryDirectory,'report.json'):route==='patterns'?'pattern-regimes.json':route==='entry-validation'?'entry-validation.json':route==='coverage'?'coverage.json':'market.json';
    try{
      const full=await pointer('current.json'),historical=await pointer('historical-current.json',true),published=full||historical;
      if(route==='state'){
        const status=await readJson(join(directory,'status.json')),retention=await readJson(join(directory,'retention-status.json'));
        const summary=value=>value?{generation:value.generation,day:value.day,asOf:value.asOf,finishedAt:value.finishedAt,total:value.total,ready:value.ready,
          ...(value.sourceId?{sourceId:value.sourceId,dataPolicy:value.dataPolicy,coverage:value.coverage,missing:value.missing}:{}),
          ...(value.scope==='historical-sample'?{scope:value.scope,archiveId:value.archiveId,publishedAt:value.publishedAt,sampleCount:value.sampleCount,marketUniverseCount:value.marketUniverseCount,fullMarket:false}:{})}:null;
        reply(200,{configured:status?.configured===true,schedule:status?.schedule??null,attempt:status?.attempt??null,retention,lastSuccess:summary(published),lastFullSuccess:summary(full),historical:summary(historical),available:Boolean(published),
          sourceId:published?.sourceId||null,dataPolicy:published?.dataPolicy||null,scope:published?(published.scope||'full-market'):null,sampleCount:published?(published.sampleCount??published.total):null,marketUniverseCount:published?(published.marketUniverseCount??published.total):null,fullMarket:Boolean(full)});return true;
      }
      if(!published&&!requestedGeneration){reply(503,{error:'cache_unavailable'});return true;}
      const generation=requestedGeneration||published.generation,completed=await generationDirectory(generation);
      if(!completed){reply(requestedGeneration?404:503,{error:'generation_unavailable'});return true;}
      if(completed.completion.dataPolicy?.rawPublic===false&&['dataset','market'].includes(route)){reply(403,{error:route==='dataset'?'source_policy_raw_export_disabled':'source_policy_raw_market_disabled'});return true;}
      if(route==='market'&&completed.completion.scope==='historical-sample'){reply(503,{error:'historical_market_unavailable'});return true;}
      if(route==='entry-current'||route==='entry-current-chart'){
        const value=await readJson(join(completed.location,currentEntryDirectory,'report.json')),marker=completed.completion;
        if(!value){reply(503,{error:'current_entry_unavailable'});return true;}
        if(value.schema!=='books.a-share.entry-current.v1'||value.version!==closeCandidateVersion||value.entryPolicyVersion!==entryPolicyVersion||value.entryValidationVersion!==entryValidationVersion||value.completed!==true||value.datasetBound!==true||value.generation!==generation||value.sourceId!==marker.sourceId||value.day!==marker.day||value.sourceDay!==marker.day||value.asOf!==marker.asOf||!Array.isArray(value.current)||value.current.some(item=>item.day!==marker.day||item.generation!==generation||item.sourceId!==marker.sourceId||item.asOf!==marker.asOf||!['triggered_at_close','waiting_breakout'].includes(item.stage)||item.actualFillVerified!==false)){
          reply(503,{error:'current_entry_mismatch'});return true;
        }
        if(route==='entry-current'){reply(200,value);return true;}
        if(!value.current.some(item=>item.code===params.get('code')&&item.formationDay===params.get('setup'))){reply(404,{error:'current_setup_unavailable'});return true;}
      }
      if(route==='signals'||route==='signal-chart'){
        const value=await readJson(join(completed.location,'signals',params.get('code')+'.json')),marker=completed.completion;
        if(!value){reply(503,{error:'signal_chart_unavailable'});return true;}
        if(value.schema!=='books.a-share.entry-signals.v1'||typeof marker.signalChartVersion!=='string'||value.version!==marker.signalChartVersion||value.generation!==generation||value.sourceId!==marker.sourceId||value.day!==marker.day||value.asOf!==marker.asOf||value.stock?.code!==params.get('code')||!Array.isArray(value.markers)||value.markers.some(item=>item.state!=='research'||item.actualFillVerified!==false)){
          reply(503,{error:'signal_chart_mismatch'});return true;
        }
        if(route==='signals'){reply(200,value);return true;}
      }
      if(route==='entries'||route==='coverage'){
        const value=await readJson(join(completed.location,filename)),marker=completed.completion;
        if(!value){reply(503,{error:route==='entries'?'entry_evidence_unavailable':'coverage_unavailable'});return true;}
        if(value.schema!==(route==='entries'?'books.a-share.entry-evidence.v1':'books.a-share.coverage.v1')||value.generation!==generation||value.sourceId!==marker.sourceId||value.day!==marker.day||value.asOf!==marker.asOf||route==='entries'&&(value.stock?.code!==params.get('code')||value.recommended!==false||value.entryOutcomeValidated!==false)){
          reply(503,{error:'derived_evidence_mismatch'});return true;
        }
        reply(200,value);return true;
      }
      if(route==='entry-validation'){
        const value=await readJson(join(completed.location,filename)),marker=completed.completion;
        if(!value){reply(503,{error:'entry_validation_unavailable'});return true;}
        if(value.schema!=='books.a-share.entry-validation.v1'||typeof marker.entryValidationVersion!=='string'||value.version!==marker.entryValidationVersion||value.entryPolicyVersion!==marker.entryPolicyVersion||value.generation!==generation||value.day!==marker.day||value.asOf!==marker.asOf||value.sourceId!==marker.sourceId||!Array.isArray(value.patterns)||value.patterns.length!==16||new Set(value.patterns.map(item=>item.id)).size!==16||!Array.isArray(value.current)){
          reply(503,{error:'entry_validation_mismatch'});return true;
        }
        reply(200,value);return true;
      }
      if(route==='patterns'){
        const value=await readJson(join(completed.location,filename)),marker=completed.completion;
        if(!value){reply(503,{error:'pattern_statistics_unavailable'});return true;}
        if(value.schema!=='books.a-share.pattern-regimes.v1'||value.generation!==generation||value.day!==marker.day||value.asOf!==marker.asOf||value.sourceId!==marker.sourceId||!Array.isArray(value.patterns)||!Array.isArray(value.candidates)){
          reply(503,{error:'pattern_statistics_mismatch'});return true;
        }
        reply(200,value);return true;
      }
      const compressed=gzipAccepted(req.headers['accept-encoding']);
      let body;
      try{body=compressed?await readFile(join(completed.location,filename+'.gz')):await readStoredFile(join(completed.location,filename));}
      catch(error){if(error.code==='ENOENT'){reply(503,{error:'cache_unavailable'});return true;}throw error;}
      res.writeHead(200,{'content-type':['entry-chart','signal-chart','entry-current-chart'].includes(route)?'image/svg+xml; charset=utf-8':'application/json; charset=utf-8','cache-control':'no-cache','vary':'Accept-Encoding',...(compressed?{'content-encoding':'gzip'}:{})});
      res.end(body);
    }catch{reply(503,{error:'cache_read_failed'});}
    return true;
  }
  return {handle};
}
