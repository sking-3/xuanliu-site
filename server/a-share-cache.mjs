import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {readStoredFile,readStoredJson} from './a-share-retention.mjs';
import {readPresentedChart} from './a-share-chart-presentation.mjs';
import {closeCandidateVersion} from './a-share-entry-current.mjs';
import {currentEntryDirectory} from './a-share-entry-current-precompute.mjs';
import {entryPolicyVersion} from './a-share-entry-bars.mjs';
import {entryValidationVersion} from './a-share-entry-validation.mjs';
import {version as viprasolStudyVersion,familyId as viprasolFamilyId,definitions as viprasolRules,sourceCommit as viprasolSourceCommit} from './a-share-viprasol-study.mjs';
import {readStockDesk,readA14Chart,readWorkbenchChart,readContextChart} from './a-share-desk.mjs';

const prefix='/api/a-share-daily/';
const modes=new Set(['consensus','market','strength']);
const samples=new Set(['120','240','all']);
const benchmarks=new Set(['000300.SH','000001.SH','399001.SZ']);
const generationPattern=/^[0-9TZ-]{1,80}$/;
const viprasolDirectory='viprasol-study-v1',viprasolIds=new Set(viprasolRules.map(rule=>rule.id));

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
    if(!['state','result','dataset','market','patterns','entries','entry-chart','coverage','entry-validation','signals','signal-chart','entry-current','entry-current-chart','viprasol-study','viprasol-current-chart','workbench','a14-chart','workbench-chart','context-chart'].includes(route)){reply(404,{error:'not_found'});return true;}
    const allowed=['state','workbench'].includes(route)?[]:route==='a14-chart'?['day','code','window']:route==='context-chart'?['generation','code','kind','window']:route==='result'?['mode','lookback','sampleSize','benchmark','generation']:route==='dataset'?['sampleSize','benchmark','generation']:['entries','signals'].includes(route)?['generation','code']:route==='entry-chart'?['generation','code','setup']:['signal-chart','workbench-chart'].includes(route)?['generation','code','window']:route==='entry-current-chart'?['generation','code','setup','window']:route==='viprasol-current-chart'?['generation','code','rule','window']:['generation'];
    if(!validQuery(params,allowed)){reply(400,{error:'invalid_query'});return true;}
    if(route==='workbench'){
      try{reply(200,await readStockDesk({dir:directory}));}catch{reply(503,{error:'workbench_read_failed'});}return true;
    }
    if(route==='a14-chart'){
      const day=params.get('day'),code=params.get('code'),window=params.get('window')||'60';
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(code||'')||!['60','120'].includes(window)){reply(400,{error:'invalid_query'});return true;}
      try{
        const chart=await readA14Chart({dir:directory,day,code,window,compressed:Boolean(gzipAccepted(req.headers['accept-encoding']))});
        if(!chart){reply(404,{error:'a14_chart_not_published'});return true;}
        res.writeHead(200,{'content-type':'image/svg+xml; charset=utf-8','cache-control':'no-cache','vary':'Accept-Encoding',...(chart.compressed?{'content-encoding':'gzip'}:{})});res.end(chart.body);
      }catch{reply(404,{error:'a14_chart_not_published'});}return true;
    }
    if(['workbench-chart','context-chart'].includes(route)){
      const generation=params.get('generation'),code=params.get('code'),window=params.get('window')||'60',kind=params.get('kind');
      if(!generationPattern.test(generation||'')||!/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(code||'')||!['60','120'].includes(window)||route==='context-chart'&&!['trend-pullback','trend-continuation','range-support','support-reclaim'].includes(kind)){reply(400,{error:'invalid_query'});return true;}
      try{
        const reader=route==='context-chart'?readContextChart:readWorkbenchChart;
        const chart=await reader({dir:directory,generation,code,kind,window,compressed:Boolean(gzipAccepted(req.headers['accept-encoding']))});
        if(!chart){reply(404,{error:'workbench_chart_not_published'});return true;}
        res.writeHead(200,{'content-type':'image/svg+xml; charset=utf-8','cache-control':'no-cache','vary':'Accept-Encoding',...(chart.compressed?{'content-encoding':'gzip'}:{})});res.end(chart.body);
      }catch{reply(404,{error:'workbench_chart_not_published'});}return true;
    }
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
    }else if(route==='viprasol-current-chart'){
      if(!/^\d{6}\.(SH|SZ)$/.test(params.get('code')||'')||!viprasolIds.has(params.get('rule'))||!['60','120'].includes(params.get('window')||'60')){reply(400,{error:'invalid_query'});return true;}
    }else if(route==='viprasol-study'){
      filename=join(viprasolDirectory,'report.json');
    }else filename=route==='entry-current'?join(currentEntryDirectory,'report.json'):route==='patterns'?'pattern-regimes.json':route==='entry-validation'?'entry-validation.json':route==='coverage'?'coverage.json':'market.json';
    try{
      const full=await pointer('current.json'),historical=await pointer('historical-current.json',true),published=full||historical;
      if(route==='state'){
        const [status,retention,stockDesk,intraday]=await Promise.all(['status.json','retention-status.json','stock-desk-v1/status.json','intraday-preselection-v1/status.json'].map(file=>readJson(join(directory,file))));
        const summary=value=>value?{generation:value.generation,day:value.day,asOf:value.asOf,finishedAt:value.finishedAt,total:value.total,ready:value.ready,
          ...(value.sourceId?{sourceId:value.sourceId,dataPolicy:value.dataPolicy,coverage:value.coverage,missing:value.missing}:{}),
          ...(value.scope==='historical-sample'?{scope:value.scope,archiveId:value.archiveId,publishedAt:value.publishedAt,sampleCount:value.sampleCount,marketUniverseCount:value.marketUniverseCount,fullMarket:false}:{})}:null;
        reply(200,{configured:status?.configured===true,schedule:status?.schedule??null,attempt:status?.attempt??null,retention,stockDesk,intraday,lastSuccess:summary(published),lastFullSuccess:summary(full),historical:summary(historical),available:Boolean(published),
          sourceId:published?.sourceId||null,dataPolicy:published?.dataPolicy||null,scope:published?(published.scope||'full-market'):null,sampleCount:published?(published.sampleCount??published.total):null,marketUniverseCount:published?(published.marketUniverseCount??published.total):null,fullMarket:Boolean(full)});return true;
      }
      if(!published&&!requestedGeneration){reply(503,{error:'cache_unavailable'});return true;}
      const generation=requestedGeneration||published.generation,completed=await generationDirectory(generation);
      if(!completed){reply(requestedGeneration?404:503,{error:'generation_unavailable'});return true;}
      if(completed.completion.dataPolicy?.rawPublic===false&&['dataset','market'].includes(route)){reply(403,{error:route==='dataset'?'source_policy_raw_export_disabled':'source_policy_raw_market_disabled'});return true;}
      if(route==='market'&&completed.completion.scope==='historical-sample'){reply(503,{error:'historical_market_unavailable'});return true;}
      if(route==='viprasol-study'||route==='viprasol-current-chart'){
        const value=await readJson(join(completed.location,viprasolDirectory,'report.json')),marker=completed.completion;
        if(!value){reply(503,{error:'viprasol_study_unavailable'});return true;}
        if(value.schema!=='books.a-share.viprasol-study.v1'||value.version!==viprasolStudyVersion||value.familyId!==viprasolFamilyId||value.sourceCommit!==viprasolSourceCommit||marker.viprasolStudyVersion!==value.version||marker.viprasolImplementationCommit!==value.implementationCommit||value.completed!==true||value.datasetBound!==true||value.generation!==generation||value.sourceId!==marker.sourceId||value.day!==marker.day||value.asOf!==marker.asOf||!Array.isArray(value.rules)||value.rules.length!==viprasolIds.size||new Set(value.rules.map(rule=>rule.id)).size!==viprasolIds.size||value.rules.some(rule=>!viprasolIds.has(rule.id))||!Array.isArray(value.current)||!Array.isArray(value.charts)||value.current.some(item=>item.familyId!==viprasolFamilyId||!viprasolIds.has(item.ruleId)||item.generation!==generation||item.sourceId!==marker.sourceId||item.day!==marker.day||item.signalDay!==marker.day||item.asOf!==marker.asOf||item.stage!=='source_today_long_close'||item.actualFillVerified!==false||item.eligibleForSelection===true&&(!/^[a-f0-9]{40}$/.test(value.implementationCommit||'')||!value.rules.some(rule=>rule.id===item.ruleId&&rule.eligibleForSelection===true&&rule.statisticalGatePassed===true&&rule.nativeGate?.passed===true)))){
          reply(503,{error:'viprasol_study_mismatch'});return true;
        }
        const now=Date.now(),live=value.current.filter(item=>item.eligibleForSelection===true&&Number.isFinite(Date.parse(item.activeUntil))&&Date.parse(item.activeUntil)>now);
        if(route==='viprasol-study'){reply(200,{...value,servedAt:new Date(now).toISOString(),liveQualifiedCurrentCount:live.length,current:value.current.map(item=>({...item,liveEligibleForSelection:live.includes(item)}))});return true;}
        const item=live.find(item=>item.code===params.get('code')&&item.ruleId===params.get('rule')),window=Number(params.get('window')||'60');
        const chart=item&&value.charts.find(chart=>chart.ruleId===item.ruleId&&chart.code===item.code&&chart.day===marker.day&&chart.generation===generation&&chart.sourceId===marker.sourceId&&chart.asOf===marker.asOf&&chart.window===window);
        const expected=item&&item.ruleId+'-'+item.code+'-'+item.day+'-'+window+'.svg';
        if(!chart||chart.path!==expected||item.charts?.[window]!==expected){reply(404,{error:'viprasol_current_chart_unavailable'});return true;}
        filename=join(viprasolDirectory,expected);
      }
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
      try{
        if(['entry-chart','entry-current-chart','viprasol-current-chart'].includes(route))body=await readPresentedChart({dir:directory,binding:completed.completion,path:'generations/'+generation+'/'+filename,compressed});
        body??=compressed?await readFile(join(completed.location,filename+'.gz')):await readStoredFile(join(completed.location,filename));
      }
      catch(error){if(error.code==='ENOENT'){reply(503,{error:'cache_unavailable'});return true;}throw error;}
      res.writeHead(200,{'content-type':['entry-chart','signal-chart','entry-current-chart','viprasol-current-chart'].includes(route)?'image/svg+xml; charset=utf-8':'application/json; charset=utf-8','cache-control':'no-cache','vary':'Accept-Encoding',...(compressed?{'content-encoding':'gzip'}:{})});
      res.end(body);
    }catch{reply(503,{error:'cache_read_failed'});}
    return true;
  }
  return {handle};
}
