#!/usr/bin/env node
'use strict';
// One bounded public batch. Raw evidence stays in the private runner directory.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const analytics=require('../trader/account-analytics.js');
const policy=require('../trader/source-policy.js');
const DAY=86400000,PERIODS=['7D','30D','90D','180D','365D','ALL'];
const NATIVE={'7D':'week','30D':'month',ALL:'allTime'};
const BLOCKS=new Set([401,403,418,429,451]);
const LIMITS=Object.freeze({weightPerMinute:900,fillWeight:120,portfolioWeight:20,intervalMs:750,
  maxBytes:8*1024*1024,maxAccounts:200,timeoutMs:15000,feedMaxAgeMs:60*60000});
const iso=value=>new Date(value).toISOString();
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
const finite=value=>(typeof value==='string'&&value.trim()!==''||typeof value==='number')&&Number.isFinite(Number(value));
function retryTime(value,now){
  if(!value)return null;
  const at=/^\d+(?:\.\d+)?$/.test(value)?now+Number(value)*1000:Date.parse(value);
  return Number.isFinite(at)?iso(Math.max(now,at)):null;
}
async function atomicWrite(file,data,io=fs,mode=0o600){
  await io.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{await io.writeFile(temp,JSON.stringify(data)+'\n',{mode,flag:'wx'});await io.rename(temp,file);}
  finally{await io.rm(temp,{force:true});}
}
async function boundedBody(response){
  if(Number(response.headers.get('content-length'))>LIMITS.maxBytes)fail('response_too_large');
  if(!response.body)return Buffer.alloc(0);
  const chunks=[];let count=0;
  for await(const chunk of response.body){count+=chunk.byteLength;if(count>LIMITS.maxBytes)fail('response_too_large');chunks.push(chunk);}
  return Buffer.concat(chunks,count);
}
class PublicSource{
  constructor({fetch,now,sleep,saveEvidence,saveStop,runId}){
    Object.assign(this,{fetch,now,sleep,saveEvidence,saveStop,runId});
    this.ledger=[];this.last=-Infinity;this.stopped=false;this.requests=0;this.http429=0;this.http418=0;
  }
  async request(body){
    if(this.stopped)fail('source_stopped');
    if(!['portfolio','userFills'].includes(body?.type)||!/^0x[0-9a-f]{40}$/.test(body?.user||''))fail('invalid_request');
    const cost=body.type==='userFills'?LIMITS.fillWeight:LIMITS.portfolioWeight;
    for(;;){
      const now=this.now();this.ledger=this.ledger.filter(row=>now-row.at<60000);
      const used=this.ledger.reduce((sum,row)=>sum+row.cost,0);
      const wait=Math.max(0,LIMITS.intervalMs-(now-this.last),used+cost>LIMITS.weightPerMinute?60001-(now-this.ledger[0].at):0);
      if(!wait)break;await this.sleep(wait);
    }
    this.last=this.now();this.ledger.push({at:this.last,cost});this.requests++;
    const receipt={runId:this.runId,request:body,startedAt:iso(this.last),httpStatus:null};
    let response,bytes;
    try{
      response=await this.fetch('https://api.hyperliquid.xyz/info',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
        signal:AbortSignal.timeout(LIMITS.timeoutMs),redirect:'error',credentials:'omit',
      });
      receipt.httpStatus=response.status;receipt.receivedAt=iso(this.now());
      receipt.retryAfter=response.headers.get('retry-after');
      if(BLOCKS.has(response.status)){
        this.stopped=true;if(response.status===429)this.http429++;if(response.status===418)this.http418++;
        await this.saveStop({schemaVersion:1,source:'hyperliquid',status:'stopped',runId:this.runId,
          errorCode:'http_'+response.status,detectedAt:receipt.receivedAt,
          retryAfterAt:retryTime(receipt.retryAfter,this.now()),requestCount:this.requests,
          http429Count:this.http429,http418Count:this.http418});
      }
      bytes=await boundedBody(response);receipt.sha256=hash(bytes);receipt.bytes=bytes.length;
      await this.saveEvidence(body,bytes,receipt);
      if(!response.ok)fail('http_'+response.status);
      if(!/application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))fail('invalid_content_type');
      let data;try{data=JSON.parse(bytes.toString('utf8'));}catch{fail('invalid_json');}
      return {data,receipt};
    }catch(error){
      const code=/^(?:http_\d{3}|response_too_large|invalid_content_type|invalid_json)$/.test(error?.message||'')?error.message:
        error?.name==='TimeoutError'||error?.name==='AbortError'?'request_timeout':'network_error';
      if(!bytes)await this.saveEvidence(body,Buffer.alloc(0),{...receipt,receivedAt:receipt.receivedAt||iso(this.now()),errorCode:code});
      fail(code);
    }
  }
}
function buildWindows(account,portfolio,fills){
  const all=portfolio.data.find(row=>row[0]==='perpAllTime')?.[1];
  const hasHistory=Boolean(all?.pnlHistory?.length);
  const fallbackAnchor=hasHistory?iso(all.pnlHistory.at(-1)[0]):account.windows.ALL.asOf;
  const result={};
  for(const period of PERIODS){
    const anchorAt=account.windows?.[period]?.asOf||fallbackAnchor;
    const end=Date.parse(anchorAt),start=period==='ALL'?-Infinity:end-parseInt(period,10)*DAY;
    const native=portfolio.data.find(row=>row[0]===(period==='7D'?'perpWeek':period==='30D'?'perpMonth':'perpAllTime'))?.[1];
    const source=hasHistory?(period!=='ALL'&&native?.pnlHistory?.[0]?.[0]<=start?native:all):null;
    const history=source?.pnlHistory||[];
    const pnl=history.filter(row=>row[0]>=start&&row[0]<=end);
    const equityByTime=new Map(source?.accountValueHistory||[]);
    const equity=pnl.map(row=>[row[0],equityByTime.get(row[0])]);
    let mdd=null,win=null;
    if(pnl.length>1&&equity.every(row=>finite(row[1]))){
      const metric=analytics.normalize.sampledDrawdown(pnl,equity);
      if(metric.value!==null)mdd={value:metric.value,method:'pnl_peak_equity',startAt:iso(pnl[0][0]),endAt:iso(pnl.at(-1)[0]),
        count:pnl.length,observedAt:portfolio.receipt.receivedAt,sha256:portfolio.receipt.sha256};
    }
    const selected=fills.data.filter(row=>row.time>=start&&row.time<=end);
    const statistic=analytics.normalize.winRate(selected,Date.parse(fills.receipt.receivedAt));
    if(statistic.eligibleCount)win={value:statistic.value,method:statistic.method,startAt:statistic.startAt,endAt:statistic.endAt,
      count:statistic.eligibleCount,winning:statistic.winning,losing:statistic.losing,breakeven:statistic.breakeven,
      observedAt:fills.receipt.receivedAt,sha256:fills.receipt.sha256,complete:false,capped:fills.data.length===2000};
    result[period]={anchorAt,observedAt:portfolio.receipt.receivedAt,sourceStartAt:Number.isFinite(start)?iso(start):null,
      historyStartAt:history.length?iso(history[0][0]):null,historyEndAt:history.length?iso(history.at(-1)[0]):null,mdd,win,
      missingReasons:{...(!hasHistory?{history:'missing_perp_all_time_history'}:{}),
        ...(!mdd?{mdd:!hasHistory?'missing_perp_all_time_history':pnl.length<2?'insufficient_samples_inside_period':'unverified_paired_equity'}:{}),
        ...(pnl.length<2?{curve:!hasHistory?'missing_perp_all_time_history':'insufficient_samples_inside_period'}:{}),
        ...(!win?{win:'no_eligible_closing_fill_inside_period'}:{})},
      curve:pnl.length>1?analytics.downsample(pnl.map(row=>({time:iso(row[0]),value:Number(row[1])-Number(pnl[0][1])})),120):[]};
    const published=account.windows?.[period];
    if(NATIVE[period]&&published?.asOfType==='source')result[period].native={roi:published.roi,pnl:published.pnl,
      sourceAt:anchorAt,observedAt:account.observedAt,sourcePeriod:NATIVE[period],sha256:account.nativeSha256};
  }
  return result;
}
async function collect({feed,analyticsState,portfolioState,previous=null,previousStop=null,feedSha256,
  fetch=globalThis.fetch,now=Date.now,sleep=pause,saveEvidence=async()=>{},saveStop=async()=>{},runId=crypto.randomUUID()}={}){
  const {parseSamples}=require('../trader/period-metrics.js');
  if(previousStop!==null)fail('source_stop_persisted');
  const decision=policy.decision({feed,analytics:analyticsState,portfolios:portfolioState});
  if(!decision.allowed)fail('source_policy_'+decision.reason);
  const fetchedAt=Date.parse(feed.source.fetchedAt);
  if(feed.status!=='ready'||feed.source.status!=='ok'||!Number.isFinite(fetchedAt)||
    fetchedAt>now()+5000||now()-fetchedAt>LIMITS.feedMaxAgeMs)fail('feed_not_current');
  if(previous)parseSamples(previous,now());
  const accounts=[],seen=new Set();
  for(const row of feed.traders){
    if(row.exchange!=='Hyperliquid'||row.sourceKind!=='public_account'||!/^0x[0-9a-f]{40}$/.test(row.accountId)||seen.has(row.accountId))fail('invalid_feed_identity');
    seen.add(row.accountId);
    for(const period of Object.keys(NATIVE)){
      const part=row.windows?.[period],at=Date.parse(part?.asOf);
      if(!Number.isFinite(at)||at>fetchedAt+5000||!Number.isFinite(part?.roi)||!Number.isFinite(part?.pnl))fail('invalid_native_window');
      if(Date.parse(previous?.accounts[row.accountId]?.[period]?.native?.sourceAt)>at)fail('source_time_regression');
    }
    const nativeSha256=feed.source.rawSha256||feedSha256;
    if(!/^[a-f0-9]{64}$/.test(nativeSha256||''))fail('invalid_feed');
    accounts.push({...row,observedAt:feed.source.fetchedAt,nativeSha256});
  }
  if(accounts.length>LIMITS.maxAccounts||!/^[a-f0-9]{64}$/.test(feedSha256||''))fail('invalid_feed');
  const source=new PublicSource({fetch,now,sleep,saveEvidence,saveStop,runId});
  const output={schemaVersion:1,runId,feedSha256,generatedAt:iso(now()),accounts:{}};
  for(const account of accounts){
    const portfolio=await source.request({type:'portfolio',user:account.accountId});
    analytics.normalize.portfolio(portfolio.data,Date.parse(portfolio.receipt.receivedAt));
    const fills=await source.request({type:'userFills',user:account.accountId,aggregateByTime:false});
    analytics.normalize.winRate(fills.data,Date.parse(fills.receipt.receivedAt));
    output.accounts[account.accountId]=buildWindows(account,portfolio,fills);
  }
  output.generatedAt=iso(now());
  output.sourcePolicy={status:'ready',stopCode:null,requestCount:source.requests,http429Count:0,http418Count:0,
    weightPerMinute:LIMITS.weightPerMinute,sourceLimitPerMinute:1200};
  parseSamples(output,now());return output;
}
async function readJson(file,optional=false){
  try{const stat=await fs.stat(file);if(!stat.isFile()||stat.size>12*1024*1024)fail('invalid_file');return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
}
async function main(args=process.argv.slice(2),dependencies={}){
  const repository=path.resolve(__dirname,'..');
  let feedFile=path.join(repository,'trader/feed.json'),out=path.join(repository,'trader/period-samples.json');
  let evidence=process.env.RUNNER_TEMP||os.tmpdir();
  for(let i=0;i<args.length;i++){
    if(args[i]==='--feed'&&args[i+1])feedFile=path.resolve(args[++i]);
    else if(args[i]==='--out'&&args[i+1])out=path.resolve(args[++i]);
    else if(args[i]==='--evidence'&&args[i+1])evidence=path.resolve(args[++i]);else fail('invalid_arguments');
  }
  const stopFile=dependencies.stopFile||process.env.BOOKS_PERIOD_SOURCE_STOP_FILE||path.join(path.dirname(out),'period-samples-stop.json');
  const previousStop=await readJson(stopFile,true);
  if(previousStop!==null)fail('source_stop_persisted');
  const stat=await fs.stat(feedFile);if(!stat.isFile()||stat.size>2*1024*1024)fail('invalid_feed');
  const feedBytes=await fs.readFile(feedFile);if(feedBytes.length>2*1024*1024)fail('invalid_feed');
  const feed=JSON.parse(feedBytes),dir=path.dirname(feedFile);
  const analyticsState=await readJson(path.join(dir,'analytics.json')),portfolioState=await readJson(path.join(dir,'portfolios.json'));
  const previous=await readJson(out,true),feedSha256=hash(feedBytes);
  await fs.mkdir(evidence,{recursive:true,mode:0o700});
  const runDir=await fs.mkdtemp(path.join(evidence,'period-samples-'));await fs.chmod(runDir,0o700);
  const result=await collect({feed,analyticsState,portfolioState,previous,previousStop,feedSha256,...dependencies,
    saveStop:record=>atomicWrite(stopFile,record),
    saveEvidence:async(body,bytes,receipt)=>{
      const file=path.join(runDir,body.user+'-'+body.type);
      await fs.writeFile(file+'.json',bytes,{mode:0o600,flag:'wx'});
      await fs.writeFile(file+'-receipt.json',JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
    }});
  await atomicWrite(out,result,fs,0o644);
  (dependencies.log||console.log)(JSON.stringify({runId:result.runId,accounts:Object.keys(result.accounts).length,
    generatedAt:result.generatedAt,requests:result.sourcePolicy.requestCount,evidence:runDir}));
  return result;
}
module.exports={collect,main,buildWindows,PublicSource,retryTime,LIMITS};
if(require.main===module)main().catch(error=>{console.error('period_samples:'+error.message);process.exitCode=1;});
