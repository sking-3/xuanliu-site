import {createReadStream} from 'node:fs';
import {access,mkdir,mkdtemp,readFile,readdir,writeFile,rename,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGunzip,gzipSync,gunzipSync} from 'node:zlib';
import {readStoredFile,readStoredJson} from './a-share-retention.mjs';
import {renderIntradayChart} from './a-share-intraday-chart.mjs';
import {writeCurrentChart,writeViprasolCurrentChart} from './a-share-entry-current-chart.mjs';
import {entryChart} from './a-share-entry-precompute.mjs';
import {presentationDirectory,presentationVersion,presentationSchema,samePresentationSource,validChartPath} from './a-share-chart-presentation.mjs';

const identity=value=>Object.fromEntries(['generation','sourceId','day','asOf',...(value.historyGeneration?['historyGeneration']:[])].map(key=>[key,value[key]]));
const validBar=bar=>bar&&['open','high','low','close','volume'].every(key=>Number.isFinite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
async function optional(file){try{return await readStoredJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function names(directory){try{return await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
function frozen(report,batch){if(report?.completed!==true||!samePresentationSource(report,batch)||!Array.isArray(report.current))throw Error('Presentation report is not bound to its completed source generation');}
function tail(bars,dates,limit=120){const byDay=new Map(bars.map(bar=>[bar.date,bar]));let first=dates.length;while(first>Math.max(0,dates.length-limit)&&validBar(byDay.get(dates[first-1])))first--;return dates.slice(first).map(date=>byDay.get(date));}
async function* history(file){
  let compressed=false;try{await access(file);}catch(error){if(error.code!=='ENOENT')throw error;compressed=true;}
  const source=createReadStream(file+(compressed?'.gz':''),{highWaterMark:64*1024}),input=compressed?source.pipe(createGunzip()):source;input.setEncoding('utf8');let pending='';
  try{for await(const chunk of input){pending+=chunk;let end;while((end=pending.indexOf('\n'))!==-1){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line.trim())yield JSON.parse(line);}}if(pending.trim())yield JSON.parse(pending);}
  finally{input.destroy();source.destroy();}
}
async function svg(stage,path,body){if(!validChartPath(path)||typeof body!=='string'||!body.startsWith('<svg')||!body.endsWith('</svg>')||/NaN|Infinity/.test(body))throw Error('Presentation renderer did not produce a complete SVG');await mkdir(dirname(join(stage,path)),{recursive:true});await writeFile(join(stage,path),body);await writeFile(join(stage,path+'.gz'),gzipSync(body));}
async function publish({dir,binding,build,now,onProgress}){
  if(!/^[0-9TZ-]{1,80}$/.test(binding.generation||''))throw Error('Presentation source generation is invalid');
  const root=join(dir,presentationDirectory),target=join(root,binding.generation),existing=await optional(join(target,'manifest.json'));
  if(existing){if(existing.schema!==presentationSchema||existing.version!==presentationVersion||existing.completed!==true||!samePresentationSource(existing,binding))throw Error('Existing presentation belongs to a different source');return existing;}
  await mkdir(root,{recursive:true});const stage=await mkdtemp(join(root,'.'+binding.generation+'-'));
  try{
    const paths=await build(stage),files=[...new Set(paths)].sort();if(files.length!==paths.length)throw Error('Presentation chart paths are duplicated');
    for(const path of files){const body=await readFile(join(stage,path)),compressed=await readFile(join(stage,path+'.gz'));if(!gunzipSync(compressed).equals(body))throw Error('Presentation gzip differs from its SVG');}
    const manifest={schema:presentationSchema,version:presentationVersion,completed:true,...identity(binding),generatedAt:new Date(now()).toISOString(),files,sourceRecordsUnchanged:true};
    await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest));await rename(stage,target);await onProgress({stage:'published',generation:binding.generation,charts:files.length});return manifest;
  }finally{await rm(stage,{recursive:true,force:true});}
}

/** Re-renders only frozen selected items; never invokes collectors, selection or outcome calculations. */
export async function rebuildAShareChartPresentation({dir,generation,includeA14=true,now=Date.now,onProgress=()=>{}}={}){
  const batch=await readStoredJson(join(dir,'current.json'));generation??=batch.generation;
  if(generation!==batch.generation)throw Error('Presentation CLI requires the currently published source generation');
  const base='generations/'+generation,target=join(dir,base),complete=await readStoredJson(join(target,'complete.json'));
  if(complete.completed!==true||!samePresentationSource(complete,batch))throw Error('Presentation source is not complete');
  const main=await publish({dir,binding:batch,now,onProgress,build:async stage=>{
    const jobs=new Map(),add=(code,job)=>{if(!/^\d{6}\.(SH|SZ)$/.test(code))throw Error('Frozen presentation stock code is invalid');if(!jobs.has(code))jobs.set(code,[]);jobs.get(code).push(job);};
    const entry=await optional(join(target,'entry-current-v2/report.json'));
    if(entry){frozen(entry,batch);for(const item of entry.current){if(!samePresentationSource(item,batch))throw Error('Current entry source changed');add(item.code,{kind:'entry',item});}}
    const viprasol=await optional(join(target,'viprasol-study-v1/report.json'));
    if(viprasol){frozen(viprasol,batch);for(const item of viprasol.current.filter(item=>item.eligibleForSelection===true)){if(!samePresentationSource(item,batch))throw Error('Native entry source changed');add(item.code,{kind:'viprasol',item});}}
    for(const [file,chartDirectory,kind]of [['desk-watches-v1.json','desk-watches-v1-charts','watch'],['decision-context-v1.json','decision-context-v1-charts','context']]){
      const report=await optional(join(target,file));if(!report)continue;frozen(report,batch);
      if(!Array.isArray(report.charts))throw Error('Frozen presentation chart inventory is missing');
      const seen=new Set();for(const chart of report.charts){
        const row=report.current.find(row=>row.code===chart.code&&(kind!=='context'||row.research?.plan?.kind===chart.kind));
        const path=chartDirectory+'/'+(kind==='context'?chart.kind+'/':'')+chart.code+'-'+chart.window+'.svg';
        if(!row||!samePresentationSource(row,batch)||!samePresentationSource(chart,batch)||chart.path!==path||![60,120].includes(chart.window)||chart.priceBasis!=='first-close-percent')throw Error('Frozen presentation chart inventory differs from selected rows');
        const key=chart.code+':'+(chart.kind||'');if(seen.has(key))continue;seen.add(key);add(chart.code,{kind,row,directory:chartDirectory+(kind==='context'?'/'+chart.kind:''),charts:report.charts.filter(item=>item.code===chart.code&&(kind!=='context'||item.kind===chart.kind))});
      }
    }
    const historical=new Map();for(const name of await names(join(target,'entries'))){const match=/^(\d{6}\.(?:SH|SZ))-([012])\.svg(?:\.gz)?$/.exec(name);if(!match)continue;if(!historical.has(match[1]))historical.set(match[1],new Set());historical.get(match[1]).add(Number(match[2]));}
    for(const [code,indexes]of historical)add(code,{kind:'historical',indexes:[...indexes]});
    let header,dates,count=0;const seen=new Set(),files=[];
    for await(const record of history(join(dir,'private','generations',generation,'history-all.ndjson'))){
      if(!header){header=record;if(header.schema!=='books.a-share.history.v1'||!samePresentationSource(header,batch)||header.total!==batch.total||!Array.isArray(header.reference?.bars)||header.reference.bars.at(-1)?.date!==batch.day)throw Error('Presentation raw source header differs from the frozen generation');dates=header.reference.bars.map(bar=>bar.date);continue;}
      const {stock,source}=record;if(!stock?.code||seen.has(stock.code)||source?.sourceId!==batch.sourceId||source.day!==batch.day)throw Error('Presentation raw source identity is invalid');seen.add(stock.code);count++;
      for(const job of jobs.get(stock.code)||[]){
        if(source.adjustment!=='qfq'||!Array.isArray(source.bars))throw Error('Presentation chart source lacks original qfq bars');
        if(job.kind==='entry'||job.kind==='viprasol'){
          const directory=job.kind==='entry'?'entry-current-v2':'viprasol-study-v1',paths=Object.fromEntries([60,120].map(window=>[window,job.kind==='entry'?stock.code+'-'+job.item.formationDay+'-'+window+'.svg':job.item.ruleId+'-'+stock.code+'-'+job.item.day+'-'+window+'.svg']));
          for(const window of [60,120]){if(job.kind==='viprasol'&&job.item.charts?.[window]!==paths[window])throw Error('Native frozen chart path differs');await readStoredFile(join(target,directory,paths[window]));}
          if(job.kind==='entry')await writeCurrentChart({directory:join(stage,base,directory),stock,bars:tail(source.bars,dates,Infinity),item:job.item});
          else await writeViprasolCurrentChart({directory:join(stage,base,directory),stock,bars:source.bars,item:job.item,paths});
          for(const path of Object.values(paths)){const full=base+'/'+directory+'/'+path,body=await readFile(join(stage,full),'utf8');if(body.includes('暂不绘制'))throw Error('Frozen current entry bars no longer match its selected item');files.push(full);}
        }else if(job.kind==='watch'||job.kind==='context'){
          const bars=tail(source.bars,dates);for(const chart of job.charts){if(chart.actualCandles!==undefined&&chart.actualCandles!==Math.min(chart.window,bars.length))throw Error('Frozen chart candle coverage changed');const path=base+'/'+job.directory+'/'+stock.code+'-'+chart.window+'.svg';await readStoredFile(join(dir,path));await svg(stage,path,renderIntradayChart({row:job.row,bars,window:chart.window}));files.push(path);}
        }else{
          const report=await readStoredJson(join(target,'entries',stock.code+'.json')),privateReport=await readStoredJson(join(dir,'private','generations',generation,'entries',stock.code+'.json'));
          if(!samePresentationSource(report,batch)||!samePresentationSource(privateReport,batch)||report.stock?.code!==stock.code||privateReport.stock?.code!==stock.code||!Array.isArray(report.items)||!Array.isArray(privateReport.setups))throw Error('Historical presentation item archive differs from its source');
          for(const index of job.indexes){const item=report.items[index],setup=item&&privateReport.setups.find(setup=>setup.id===item.id);if(!setup||!item.chartUrl)throw Error('Historical presentation cannot bind the frozen selected setup id');const url=new URL(item.chartUrl,'http://archive');if(url.pathname!=='/api/a-share-daily/entry-chart'||url.searchParams.get('generation')!==generation||url.searchParams.get('code')!==stock.code||url.searchParams.get('setup')!==String(index))throw Error('Historical presentation chart URL differs from its original index');const path=base+'/entries/'+stock.code+'-'+index+'.svg';await svg(stage,path,entryChart({stock,bars:source.bars,setup}));files.push(path);}
        }
      }
      if(count%100===0)await onProgress({stage:'rendering',generation,checked:count,total:batch.total,charts:files.length});
    }
    if(!header||count!==batch.total||[...jobs.keys()].some(code=>!seen.has(code)))throw Error('Presentation private archive coverage is incomplete');
    const current=await readStoredJson(join(dir,'current.json'));if(!samePresentationSource(current,batch))throw Error('Source generation changed during presentation rebuild');return files;
  }});
  let a14=null;
  if(includeA14){
    const root=join(dir,'intraday-preselection-v1'),report=await optional(join(root,'current.json'));
    if(report){
      const frozenReport=await readStoredJson(join(root,'days',report.day,'report.json'));
      if(JSON.stringify(report)!==JSON.stringify(frozenReport)||report.completed!==true||report.phase!=='a14'||!Array.isArray(report.current)||!report.historyGeneration)throw Error('14:00 presentation source is not its frozen completed report');
      if(report.current.length&&(report.current.some(row=>!Number.isFinite(Date.parse(row.asOf)))||report.asOf!==report.current.reduce((earliest,row)=>row.asOf<earliest?row.asOf:earliest,report.current[0].asOf)))throw Error('14:00 report asOf is not the earliest captured row quote time');
      a14=await publish({dir,binding:report,now,onProgress,build:async stage=>{
        const quotes=new Map(),files=[],wanted=new Map(report.current.map(row=>[row.code,row]));let header,dates;const found=new Set();
        const captures=new Set((await names(join(root,'days',report.day))).filter(name=>/^private-quotes-\d+-\d+\.json(?:\.gz)?$/.test(name)).map(name=>name.replace(/\.gz$/,'')));
        for(const name of captures){
          const capture=await readStoredJson(join(root,'days',report.day,name));if(capture.sourceId!==report.sourceId||!Array.isArray(capture.quotes))throw Error('Frozen quote capture source differs');for(const quote of capture.quotes){const row=wanted.get(quote.code);if(row&&capture.receivedAt===row.receivedAt&&Date.parse(quote.sourceAt)===Date.parse(row.quoteSourceAt))quotes.set(quote.code,quote);}
        }
        for await(const record of history(join(dir,'private','generations',report.historyGeneration,'history-all.ndjson'))){
          if(!header){header=record;if(header.generation!==report.historyGeneration||header.sourceId!==report.historySourceId||header.reference?.bars?.at(-1)?.date!==report.marketContext?.historyDay)throw Error('14:00 historical archive source differs');dates=header.reference.bars.map(bar=>bar.date);continue;}
          const {stock,source}=record,row=wanted.get(stock?.code);if(!row)continue;const quote=quotes.get(stock.code);
          const rowBound=['generation','sourceId','day','historyGeneration','historySourceId'].every(key=>row[key]===report[key]);
          if(found.has(stock.code)||!quote||!rowBound||Date.parse(row.asOf)!==Date.parse(row.quoteSourceAt)||Date.parse(row.asOf)!==Date.parse(quote.sourceAt)||source.sourceId!==report.historySourceId||source.day!==row.basisDay||source.adjustment!=='qfq'||quote.price!==row.reference.close||quote.prevClose!==row.quotePrevClose||source.bars.at(-1)?.close!==row.basisClose)throw Error('14:00 frozen quote or historical price binding differs');found.add(stock.code);
          const bars=tail(source.bars,dates).concat({date:report.day,open:quote.open,high:quote.high,low:quote.low,close:quote.price,volume:null});
          for(const window of [60,120]){const path='intraday-preselection-v1/days/'+report.day+'/charts/'+stock.code+'-'+window+'.svg';await readStoredFile(join(dir,path));await svg(stage,path,renderIntradayChart({row,bars,window}));files.push(path);}
        }
        if(found.size!==wanted.size)throw Error('14:00 presentation lacks a saved source candle');
        const current=await readStoredJson(join(root,'current.json'));if(JSON.stringify(current)!==JSON.stringify(report))throw Error('14:00 source changed during presentation rebuild');return files;
      }});
    }
  }
  return {main,a14};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),allowed=new Set(['--dir','--site','--generation','--no-a14']);let dir=process.env.BOOKS_A_SHARE_DIR,generation,includeA14=true;
  // --site is accepted for deployment CLI parity; no website rules are executed.
  for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw Error('Unknown presentation argument: '+args[i]);if(args[i]==='--dir')dir=args[++i];else if(args[i]==='--site')i++;else if(args[i]==='--generation')generation=args[++i];else includeA14=false;}
  if(!dir)throw Error('Set BOOKS_A_SHARE_DIR or pass --dir');
  console.log(JSON.stringify(await rebuildAShareChartPresentation({dir,generation,includeA14,onProgress:value=>console.log(JSON.stringify(value))})));
}
