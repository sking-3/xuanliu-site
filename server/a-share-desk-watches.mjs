import {mkdir,mkdtemp,readFile,writeFile,rename,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readHistoryLines} from './a-share-entry-precompute.mjs';
import {readStoredJson} from './a-share-retention.mjs';
import {policy as trendPolicy} from './a-share-pattern-regimes.mjs';

export const version='books.a-share.desk-watches.2026-11-25.v1';
export const schema='books.a-share.desk-watches.v1';
export const filename='desk-watches-v1',chartDirectoryName='desk-watches-v1-charts';
const binding=['sourceId','generation','day','asOf'],windows=[60,120];
const kinds=new Set(['research_visit','fund_holding','shareholder_increase','shareholder_decrease','investment_fund_partnership','shareholder_holding','repurchase','employee_share_plan']);
const mainboard=code=>/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(code||'');
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const same=(a,b)=>binding.every(key=>a[key]===b[key]);
const risk=stock=>!stock.name?.trim()||/^(?:S?\*?ST)|退/i.test(stock.name.replace(/\s/g,''));
const validBar=bar=>bar&&day(bar.date)&&['open','high','low','close'].every(key=>Number.isFinite(bar[key])&&bar[key]>0)&&Number.isFinite(bar.volume)&&bar.volume>0&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close);
const greater=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));

function recentMetrics(bars,dates){
 const byDay=new Map(bars.map(bar=>[bar.date,bar])),view=dates.slice(-21).map(date=>byDay.get(date));
 if(view.length!==21||view.some(bar=>!validBar(bar)))return null;
 const mean=values=>values.reduce((sum,bar)=>sum+bar.close,0)/values.length,close=view.at(-1).close,ma5=mean(view.slice(-5)),ma20=mean(view.slice(-20));
 return {return5:(close/view.at(-6).close-1)*100,return20:(close/view[0].close-1)*100,ma5,ma20,ma20Deviation:(close/ma20-1)*100,closeAboveMa20:greater(close,ma20),ma5AboveMa20:greater(ma5,ma20)};
}
function recentEvents(institutions,code,dates,checked){
 const rows=institutions?.byCode?.[code]||[];
 if(!Array.isArray(rows))throw Error('Desk watch institutional records are not a list');
 if(!rows.length)return [];
 if(institutions.sourceId!=='cninfo-public-announcements-v1'||!time(institutions.checkedAt)||Date.parse(institutions.checkedAt)>checked)throw Error('Desk watch institutional source or read time is invalid');
 const seen=new Set(),result=[];
 for(const event of rows){
  if(event.code!==code||!kinds.has(event.kind)||!day(event.sourceDate)||event.sourceDate<dates.at(-5)||event.sourceDate>dates.at(-1))continue;
  if(typeof event.id!=='string'||!/^\d{1,30}$/.test(event.id)||!time(event.firstSeenAt)||Date.parse(event.firstSeenAt)>checked||typeof event.title!=='string'||!event.title||typeof event.summary!=='string'||!event.summary)throw Error('Desk watch institutional identity or first-seen time is invalid');
  const url=new URL(event.url);
  if(!['https://static.cninfo.com.cn','https://dataclouds.cninfo.com.cn'].includes(url.origin)||url.username||url.password||url.search||url.hash||!/\.pdf$/i.test(url.pathname))throw Error('Desk watch institutional link is not an official PDF');
  if(event.precision==='day'?event.publishedAt!==null:event.precision!=='minute'||!time(event.publishedAt)||Date.parse(event.publishedAt)>checked||new Date(Date.parse(event.publishedAt)+8*3600000).toISOString().slice(0,10)!==event.sourceDate)throw Error('Desk watch institutional publication precision is invalid');
  if(seen.has(event.id))continue;seen.add(event.id);
  result.push(Object.fromEntries(['id','code','title','url','sourceDate','publishedAt','precision','firstSeenAt','kind','summary'].map(key=>[key,event[key]])));
 }
 return result;
}
function watchRow({stock,source,batch,computedAt,activeUntil,strategy,metrics,events=[],limitPrice=null}){
 const short=strategy==='short-term',familyId=short?'close-limitup-watch':'institution-disclosure-watch',ruleIds=short?['close-limitup']:[...new Set(events.map(event=>event.kind.replaceAll('_','-')))];
 const conditionKnownAfter=short?batch.day+'T15:00:00+08:00':new Date(Math.max(Date.parse(batch.day+'T15:00:00+08:00'),...events.map(event=>Math.max(Date.parse(event.firstSeenAt),event.publishedAt?Date.parse(event.publishedAt):0)))).toISOString();
 const row={code:stock.code,name:stock.name,familyId,ruleVersion:version,setupId:familyId+':'+batch.day,ruleIds,anchorDay:batch.day,phase:'close',state:'watch',qualified:false,qualification:'unqualified_observation',
  ...Object.fromEntries(binding.map(key=>[key,batch[key]])),sourceFetchedAt:source.fetchedAt,actualDiscoveryAt:computedAt,firstSeenAt:computedAt,conditionKnownAfter,activeUntil,
  strategy,label:short?'收盘涨停观察·次日须复核':'机构披露观察·不代表机构买入',reference:{close:source.bars.at(-1).close,trigger:null,invalidation:null},
  chartUrls:Object.fromEntries(windows.map(window=>[window,'/api/a-share-daily/workbench-chart?'+new URLSearchParams({generation:batch.generation,code:stock.code,window:String(window)})])),
  reasons:short?['仅观察同源前复权收盘接近前收×1.10且收于最高价；未验证官方当日涨停价、封单或盘中打板成交','次日开盘前须重新核对；未通过或替代原16类形态及13项指标门槛']:['最近五个基准交易日日期区间内的真实公开披露；不推断机构实时买入','仅为未明显拉升的披露观察，不是已验证入场信号'],
  research:{rules:[],structure:metrics,institutionalEvidence:events.length?events:null,...(short?{closeLimitReference:{previousClose:source.bars.at(-2).close,roundedTenPercent:limitPrice,tolerance:.011,officialLimitPriceVerified:false,listingDate:stock.listingDate}}:{})},actualFillVerified:false};
 row.id=JSON.stringify([row.sourceId,row.ruleVersion,row.familyId,row.setupId,row.code,row.anchorDay]);return row;
}

async function checkCharts(directory,code){
 for(const window of windows){
  const body=await readFile(join(directory,code+'-'+window+'.svg')),compressed=await readFile(join(directory,code+'-'+window+'.svg.gz'));
  if(!gunzipSync(compressed).equals(body)||!/^\s*<svg\b[^>]*\bdata-normalization=["']first-close-percent["'][^>]*>/i.test(body.toString())||!/<\/svg>\s*$/.test(body.toString()))throw Error('Desk watch charts must restore to normalized SVGs');
 }
}

async function publishCharts(directory,target){
 try{await rename(directory,target);return;}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
 const staged=(await readdir(directory)).sort(),existing=(await readdir(target)).sort();
 if(JSON.stringify(staged)!==JSON.stringify(existing))throw Error('Desk watch orphan charts differ from this completed source batch');
 for(const file of staged)if(!(await readFile(join(directory,file))).equals(await readFile(join(target,file))))throw Error('Desk watch orphan chart bytes differ; existing charts were retained');
}

/** Independent unqualified observations; consumes one private stock record at a time. */
export async function precomputeDeskWatches({historyFile,target,batch,institutions={byCode:{}},existingCodes=new Set(),nextSessionDay,now=Date.now,writeChart,signal,onProgress=()=>{}}){
 const checked=now(),computedAt=new Date(checked).toISOString(),activeUntil=nextSessionDay+'T09:30:00+08:00';
 if(!batch||!day(batch.day)||!time(batch.asOf)||Date.parse(batch.asOf)<Date.parse(batch.day+'T15:00:00+08:00')||Date.parse(batch.asOf)>checked||!batch.sourceId||!/^[0-9TZ-]{1,80}$/.test(batch.generation||'')||!Number.isInteger(batch.total)||batch.total<1||!(existingCodes instanceof Set)||!day(nextSessionDay)||nextSessionDay<=batch.day)throw Error('Desk watches need a closed source batch and verified next session');
 const path=join(target,filename+'.json');let previous;
 try{previous=await readStoredJson(path);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(previous){if(previous.schema!==schema||previous.version!==version||previous.completed!==true||previous.datasetBound!==true||!same(previous,batch)||previous.summary?.universeCount!==batch.total)throw Error('Desk watch existing report differs from this source batch');return previous;}
 await mkdir(target,{recursive:true});const stage=await mkdtemp(join(target,'.desk-watches-')),directory=join(stage,chartDirectoryName),current=[],charts=[],seen=new Set();let header,dates;
 const counts={processed:0,readyToday:0,riskExcluded:0,missingBasis:0,existingCoreExcluded:0,limitupListingUnknown:0,limitupNewListingExcluded:0,limitupFlatExcluded:0,institutionHeatExcluded:0,institutionNotEarlyExcluded:0};
 try{
  await mkdir(directory);
  for await(const line of readHistoryLines(historyFile)){
   signal?.throwIfAborted();const record=JSON.parse(line);
   if(!header){
    header=record;const reference=header.reference;
    if(header.schema!=='books.a-share.history.v1'||!same(header,batch)||header.total!==batch.total||header.historyRequested!==500||reference?.code!=='000300.SH'||reference.adjustment!=='index'||!Array.isArray(reference.bars)||reference.bars.length<21||reference.bars.length>500||reference.bars.some((bar,index)=>!validBar(bar)||bar.date>batch.day||index&&bar.date<=reference.bars[index-1].date)||reference.bars.at(-1).date!==batch.day||!time(reference.fetchedAt)||Date.parse(reference.fetchedAt)<Date.parse(batch.asOf)||Date.parse(reference.fetchedAt)>checked)throw Error('Desk watch private header or reference calendar differs from the batch');
    dates=reference.bars.map(bar=>bar.date);continue;
   }
   const {stock,source}=record;
   if(!/^\d{6}\.(?:SH|SZ)$/.test(stock?.code||'')||seen.has(stock.code)||source?.sourceId!==batch.sourceId||source.day!==batch.day||!['ready','unavailable'].includes(source.status)||source.adjustment!=='qfq'||source.historyRequested!==500||!Array.isArray(source.bars)||source.bars.length>500||source.bars.some((bar,index)=>!day(bar.date)||bar.date>batch.day||index&&bar.date<=source.bars[index-1].date)||!time(source.fetchedAt)||Date.parse(source.fetchedAt)<Date.parse(batch.asOf)||Date.parse(source.fetchedAt)>checked)throw Error('Desk watch private stock identity, source, dates or read time are invalid');
   seen.add(stock.code);counts.processed++;
   if(!mainboard(stock.code)||risk(stock)){counts.riskExcluded++;continue;}
   if(existingCodes.has(stock.code)){counts.existingCoreExcluded++;continue;}
   const bars=source.bars,last=bars.at(-1),prior=bars.at(-2);
   if(source.status!=='ready'||!validBar(last)||last.date!==batch.day||!validBar(prior)||prior.date!==dates.at(-2)){counts.missingBasis++;continue;}
   counts.readyToday++;const metrics=recentMetrics(bars,dates),rows=[];
   if(checked<Date.parse(activeUntil)){
    const limitPrice=Math.round(prior.close*110)/100,atLimit=Math.abs(last.close-limitPrice)<=.011&&!greater(last.high,last.close);
    if(atLimit){
     if(!day(stock.listingDate)){counts.limitupListingUnknown++;}
     else if(stock.listingDate>dates.at(-6)){counts.limitupNewListingExcluded++;}
     else if(last.open===last.high&&last.high===last.low&&last.low===last.close){counts.limitupFlatExcluded++;}
     else rows.push(watchRow({stock,source,batch,computedAt,activeUntil,strategy:'short-term',metrics,limitPrice}));
    }
    const events=recentEvents(institutions,stock.code,dates,checked);
    if(events.length&&metrics){
     const hot=greater(metrics.return5,trendPolicy.maxReturn5)||greater(metrics.return20,trendPolicy.maxReturn20)||greater(metrics.ma20Deviation,trendPolicy.maxMa20Deviation);
     if(hot)counts.institutionHeatExcluded++;
     else if(metrics.return5<=0||!metrics.closeAboveMa20||!metrics.ma5AboveMa20)counts.institutionNotEarlyExcluded++;
     else rows.push(watchRow({stock,source,batch,computedAt,activeUntil,strategy:'institution',metrics,events}));
    }
   }
   if(rows.length){
    if(typeof writeChart!=='function')throw Error('Desk watch candidates require an injected normalized chart writer');
    const byDay=new Map(bars.map(bar=>[bar.date,bar]));let first=dates.length;
    while(first>Math.max(0,dates.length-120)&&validBar(byDay.get(dates[first-1])))first--;
    const chartBars=dates.slice(first).map(date=>byDay.get(date));
    if(chartBars.length<20)throw Error('Desk watch chart has fewer than twenty continuous valid sessions');
    for(const row of rows)row.research.chartBasis={firstDate:chartBars[0].date,lastDate:batch.day,continuousSessions:chartBars.length,missingOrInvalidPastBarsNotFilled:true};
    await writeChart({directory,row:rows[0],bars:chartBars});await checkCharts(directory,stock.code);current.push(...rows);
    for(const window of windows){const actualCandles=Math.min(window,chartBars.length);charts.push({...Object.fromEntries(binding.map(key=>[key,batch[key]])),code:stock.code,window,requestedWindow:window,actualCandles,firstDate:chartBars.at(-actualCandles).date,lastDate:batch.day,path:chartDirectoryName+'/'+stock.code+'-'+window+'.svg',priceBasis:'first-close-percent'});}
   }
   if(counts.processed%100===0)await onProgress({stage:'desk-watches',checked:counts.processed,total:batch.total});
  }
  if(!header||seen.size!==batch.total||[...existingCodes].some(code=>!seen.has(code)))throw Error('Desk watch private source coverage is incomplete');
  const report={schema,version,completed:true,datasetBound:true,...Object.fromEntries(binding.map(key=>[key,batch[key]])),computedAt,activeUntil,current,charts,
   summary:{...counts,universeCount:batch.total,candidateCount:current.length,stockCount:new Set(current.map(row=>row.code)).size,shortTermCount:current.filter(row=>row.strategy==='short-term').length,institutionCount:current.filter(row=>row.strategy==='institution').length,qualifiedCount:0},
   method:{selection:'independent_unqualified_watch_only',originalSixteenAndThirteenGatesChanged:false,officialLimitPriceVerified:false,institutionalBuyingInferred:false,institutionWindow:{firstDate:dates.at(-5),lastDate:batch.day,referenceSessions:5,publicationOnNonSessionDayAllowed:true},antiHeat:{maxReturn5:trendPolicy.maxReturn5,maxReturn20:trendPolicy.maxReturn20,maxMa20Deviation:trendPolicy.maxMa20Deviation},returnBasis:'same_batch_qfq_close_change_not_trade_return',firstSeen:'first_actual_watch_run_never_backdated',...(checked>=Date.parse(activeUntil)?{inactiveReason:'next_verified_session_open_has_passed'}:{})}};
  const body=JSON.stringify(report);await writeFile(join(stage,filename+'.json'),body);await writeFile(join(stage,filename+'.json.gz'),gzipSync(body));signal?.throwIfAborted();
  await publishCharts(directory,join(target,chartDirectoryName));await rename(join(stage,filename+'.json.gz'),path+'.gz');await rename(join(stage,filename+'.json'),path);return report;
 }finally{await rm(stage,{recursive:true,force:true});}
}
