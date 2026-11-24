import {createReadStream} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {analyzeEntryBars,entryPolicyVersion} from './a-share-entry-bars.mjs';
import {diagnoseHistory} from './a-share-tickflow.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function save(file,value){
  const body=typeof value==='string'?value:JSON.stringify(value);
  await writeFile(file+'.tmp',body);await rename(file+'.tmp',file);
  await writeFile(file+'.gz.tmp',gzipSync(body));await rename(file+'.gz.tmp',file+'.gz');
}

/** Backpressure is byte-bounded; readline's 1024-line queue can retain >100 MB here. */
export async function* readHistoryLines(file){
  const input=createReadStream(file,{encoding:'utf8',highWaterMark:64*1024});let pending='';
  try{
    for await(const chunk of input){
      pending+=chunk;let end;
      while((end=pending.indexOf('\n'))!==-1){
        const line=pending.slice(0,end);pending=pending.slice(end+1);
        if(line.trim())yield line;
      }
    }
    if(pending.trim())yield pending;
  }finally{input.destroy();}
}

/** A derived, normalized research chart; raw OHLC remains in the private archive. */
export function entryChart({stock,bars,setup}){
  const key=setup.keyBar||setup.formation,index=bars.findIndex(bar=>bar.date===key.date);
  const view=bars.slice(Math.max(0,index-25),Math.min(bars.length,index+16));
  if(!view.length||view.some(bar=>!['open','high','low','close'].every(k=>Number.isFinite(bar[k])&&bar[k]>0)))return null;
  const base=view[0].close,pct=price=>(price/base-1)*100,levels=[setup.invalidation.below,setup.trigger?.above].filter(Number.isFinite);
  const lower=Math.min(...view.map(bar=>pct(bar.low)),...levels.map(pct)),upper=Math.max(...view.map(bar=>pct(bar.high)),...levels.map(pct));
  const range=Math.max(upper-lower,1),bottom=lower-range*.12,top=upper+range*.17;
  const y=price=>218-(pct(price)-bottom)/(top-bottom)*173,step=536/view.length,x=i=>35+step*(i+.5),number=n=>Number(n.toFixed(2));
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="266" viewBox="0 0 640 266" role="img" aria-labelledby="title desc"><title id="title">${escape(stock.name||stock.code)} · 关键K研究回放</title><desc id="desc">以窗口首日收盘归一化；F为形态K，C为收盘确认关键K，T为日线观察到突破。不代表实际成交。</desc><rect width="640" height="266" fill="#fcfdfd"/><g font-family="system-ui,sans-serif" font-size="12" fill="#506171" style="font-variant-numeric:tabular-nums"><text x="18" y="23">关键K研究回放 · 归一化价格</text>`];
  for(let i=0;i<4;i++){
    const value=bottom+(top-bottom)*i/3,yy=218-i/3*173;
    parts.push(`<path d="M28 ${number(yy)}H576" stroke="#e0e6e9"/><text x="582" y="${number(yy+4)}">${number(value)}%</text>`);
  }
  for(const [price,label,color]of [[setup.trigger?.above,'触发参考','#286178'],[setup.invalidation.below,'固定失效','#a45045']])if(Number.isFinite(price)){
    const yy=number(y(price));parts.push(`<path d="M28 ${yy}H576" stroke="${color}" stroke-dasharray="4 4"/><text x="30" y="${number(yy-5)}" fill="${color}">${label}</text>`);
  }
  const width=Math.max(2,Math.min(step*.62,10));
  for(const [i,bar]of view.entries()){
    const xx=number(x(i)),color=bar.close>=bar.open?'#13816b':'#b34b54',height=Math.max(1,Math.abs(y(bar.open)-y(bar.close)));
    parts.push(`<path d="M${xx} ${number(y(bar.high))}V${number(y(bar.low))}" stroke="${color}"/><rect x="${number(xx-width/2)}" y="${number(Math.min(y(bar.open),y(bar.close)))}" width="${number(width)}" height="${number(height)}" fill="${color}"/>`);
    const labels=[];
    if(bar.date===setup.formation.date)labels.push('F');
    if(bar.date===setup.keyBar?.date)labels.push('C');
    if(bar.date===setup.observedEvent?.date&&setup.replayStatus==='triggered_observation')labels.push('T');
    if(labels.length)parts.push(`<circle cx="${xx}" cy="${number(y(bar.low)+12)}" r="9" fill="#244e61"/><text x="${xx}" y="${number(y(bar.low)+16)}" text-anchor="middle" fill="#fff">${labels.join('/')}</text>`);
  }
  parts.push(`<text x="28" y="244">${escape(view[0].date)}</text><text x="576" y="244" text-anchor="end">${escape(view.at(-1).date)}</text><text x="28" y="262">F 形态 · C 确认关键K · T 突破观察；非实际成交</text></g></svg>`);
  return parts.join('');
}

export async function precomputeEntryEvidence({historyFile,target,privateTarget,generation,sourceId,day,asOf,patterns,effectivePatternIds=[],policyKnownAt=null,nextSessionDay=null,now=Date.now,onProgress=()=>{}}){
  await mkdir(join(target,'entries'),{recursive:true});await mkdir(join(privateTarget,'entries'),{recursive:true});
  let header=null,count=0;const seen=new Set(),coverage=[];
  const totals={stocks:0,setups:0,confirmed:0,currentWatch:0,recommended:0};
  {
    for await(const line of readHistoryLines(historyFile)){
      if(!line)continue;const row=JSON.parse(line);
      if(!header){
        header=row;
        if(header.schema!=='books.a-share.history.v1'||header.generation!==generation||header.sourceId!==sourceId||header.day!==day||header.asOf!==asOf||!Array.isArray(header.reference?.bars))throw Error('关键K原始归档批次不符');
        continue;
      }
      const {stock,source}=row;
      if(!stock?.code||seen.has(stock.code)||source?.sourceId!==sourceId||source.day!==day)throw Error('关键K原始归档证券或日期不符');
      seen.add(stock.code);count++;
      const diagnostic=diagnoseHistory(source);
      if(source.status!=='ready')coverage.push({stock,reason:source.reason,diagnostic,fetchedAt:source.fetchedAt});
      const result=analyzeEntryBars({stock,bars:source.bars,calendar:header.reference.bars,patterns,day,asOf,sourceId,generation,sourceFetchedAt:source.fetchedAt||null,policyKnownAt,nextSessionDay,effectivePatternIds,now});
      await save(join(privateTarget,'entries',stock.code+'.json'),result);
      totals.stocks++;totals.setups+=result.summary.setupCount;totals.confirmed+=result.summary.confirmedCount;totals.currentWatch+=result.summary.currentWatchCount;
      const confirmed=result.setups.filter(setup=>setup.keyBar).reverse(),recent=result.current.slice().reverse(),used=new Set();
      const setups=[...recent,...confirmed,...result.setups.slice().reverse()].filter(setup=>{if(used.has(setup.id))return false;used.add(setup.id);return true;}).slice(0,3);
      const items=[];
      for(const [i,setup]of setups.entries()){
        const svg=entryChart({stock,bars:source.bars,setup});
        if(svg)await save(join(target,'entries',stock.code+'-'+i+'.svg'),svg);
        items.push({id:setup.id,patternIds:setup.patternIds,formationDay:setup.formation.date,keyBarDay:setup.keyBar?.date||null,triggerDay:setup.observedEvent?.date||null,
          replayStatus:setup.replayStatus,status:setup.status,knownAt:setup.knownAt,lateDiscovery:setup.lateDiscovery,reason:setup.reason,trigger:setup.trigger,invalidation:setup.invalidation,
          recommendationReasons:setup.recommendationReasons,monitoring:setup.monitoring,chartUrl:svg?'/api/a-share-daily/entry-chart?'+new URLSearchParams({generation,code:stock.code,setup:String(i)}):null});
      }
      await save(join(target,'entries',stock.code+'.json'),{schema:'books.a-share.entry-evidence.v1',generation,sourceId,day,asOf,stock,entryPolicyVersion,entryOutcomeValidated:false,recommended:false,summary:result.summary,
        priceBasis:result.priceBasis,sourceFetchedAt:result.sourceFetchedAt,policyKnownAt,items});
      if(count%50===0)onProgress({stage:'entry-evidence',checked:count,total:header.total,currentCode:stock.code});
    }
    if(!header||count!==header.total)throw Error('关键K原始归档覆盖不完整');
    await save(join(target,'coverage.json'),{schema:'books.a-share.coverage.v1',generation,sourceId,day,asOf,total:header.total,missing:coverage.length,records:coverage});
    const summary={entryPolicyVersion,policyKnownAt,...totals};await save(join(target,'entry-summary.json'),summary);return summary;
  }
}
