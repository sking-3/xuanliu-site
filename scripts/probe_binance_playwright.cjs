#!/usr/bin/env node
'use strict';
// One explicitly authorized, anonymous browser observation. Never imports legacy collectors,
// sends an HTTP/API request, merges published data, or changes source-holds.json.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const TARGET=Object.freeze({id:'4751838302089254401',name:'Btc星辰',period:'365D',url:'https://www.binance.com/zh-TC/copy-trading/lead-details/4751838302089254401'});
const CLI_VERSION='0.1.25';
const sha256=x=>crypto.createHash('sha256').update(x).digest('hex');

function archivedBaseline(root=path.join(__dirname,'..')) {
  const filename=path.join(root,'trader/binance/period-returns.json');
  const bytes=fs.readFileSync(filename), raw=JSON.parse(bytes);
  const row=raw.accounts?.find(a=>a.portfolioId===TARGET.id);
  const part=row?.performance?.byPeriod?.[TARGET.period];
  if (row?.name!==TARGET.name || !part || !Number.isFinite(Number(part.roi))) throw Error('invalid_archived_baseline');
  // sourceAsOf is frequently absent. Comparing against the archived receipt time is a
  // conservative lower bound, not a claim that the receipt is a platform source time.
  const sourceAt=part.sourceAsOf??null;
  const receiptAt=part.lastSuccessAt??part.evidence?.receivedAt;
  const compareAt=sourceAt||receiptAt;
  if (!Number.isFinite(Date.parse(compareAt))) throw Error('invalid_archived_baseline_time');
  return {file:'trader/binance/period-returns.json',sha256:sha256(bytes),portfolioId:TARGET.id,period:TARGET.period,
    roi:Number(part.roi),sourceAt,receiptAt,compareAt,comparisonBasis:sourceAt?'archived_source_time':'archived_receipt_lower_bound'};
}

function resolveCli(env=process.env) {
  const candidate=env.PLAYWRIGHT_CLI_BIN || (env.PATH||'').split(path.delimiter).map(p=>path.join(p,'playwright-cli')).find(p=>fs.existsSync(p));
  if (!candidate) throw Error('playwright_cli_not_installed');
  const executable=fs.realpathSync(candidate);
  let dir=path.dirname(executable);
  while (dir!==path.dirname(dir)) {
    const pkg=path.join(dir,'package.json');
    if (fs.existsSync(pkg)) {
      const meta=JSON.parse(fs.readFileSync(pkg,'utf8'));
      if (meta.name==='@playwright/cli') {
        if (meta.version!==CLI_VERSION) throw Error('playwright_cli_version_mismatch');
        return executable;
      }
    }
    dir=path.dirname(dir);
  }
  throw Error('playwright_cli_package_unverified');
}

function runCommand(executable,args,{cwd,timeoutMs,env=process.env}) {
  return new Promise((resolve,reject)=>{
    // Ignore inherited MCP profile/header/storage configuration. No CLI update query
    // or saved user browser state belongs in this fresh anonymous probe.
    const cleanEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('PLAYWRIGHT_MCP_')));
    cleanEnv.NO_UPDATE_NOTIFIER='1';
    const child=spawn(executable,args,{cwd,env:cleanEnv,stdio:['ignore','pipe','pipe'],shell:false});
    let stdout='',bytes=0,settled=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('cli_stage_timeout'));},timeoutMs);
    function finish(error,result) {if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);}
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){child.kill('SIGKILL');finish(Error('cli_output_too_large'));}else stdout+=chunk;});
    // CLI stderr and snapshots can contain untrusted page text. Never forward them to logs.
    child.stderr.on('data',()=>{});
    child.on('error',()=>finish(Error('cli_spawn_failed')));
    child.on('close',code=>code===0?finish(null,stdout):finish(Error('cli_command_failed')));
  });
}

function parseCliResult(stdout) {
  // --raw prints the JSON result (the CLI may append a snapshot section).
  const text=String(stdout).trim();
  try {const value=JSON.parse(text);if(value&&value.probeSchema===1)return value;} catch {}
  const marker='### Result\n', start=text.indexOf(marker);
  const payload=start<0?text:text.slice(start+marker.length);
  // Parse only a complete JSON object beginning on a result line. Never eval CLI output.
  for (const offset of [0,...[...payload.matchAll(/\n(?=\{)/g)].map(m=>m.index+1)]) {
    if(payload[offset]!=='{')continue;
    let depth=0,quoted=false,escaped=false;
    for(let i=offset;i<payload.length;i++) {
      const c=payload[i];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}' && --depth===0){
        try {const value=JSON.parse(payload.slice(offset,i+1));if(value?.probeSchema===1)return value;}catch{}
        break;
      }
    }
  }
  throw Error('cli_result_not_json');
}

// This entire function is serialized into the CLI's isolated run-code context.
// The only outbound operation initiated by this code is the single page.goto below.
async function browserProbe(page,config) {
  const T=config.target, start=Date.now(), deadline=start+config.budgetMs;
  const ctx=page.context(), pending=new Set(), receipts=[], roiObservations=[], curveObservations=[], profiles=[];
  let phase='initial', navigations=0, stopped=null, closePromise=null, screenshot=null, dom=null, clicked365D=false;
  const budget=()=>Math.max(1,Math.min(30000,deadline-Date.now()));
  const bounded=async(operation,ms=budget())=>{
    let timer;
    try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('stage_timeout')),ms);})]);}
    finally{clearTimeout(timer);}
  };
  const stop=reason=>{
    if(stopped)return closePromise;
    stopped=reason;
    // Set stopped synchronously before closing: the route guard aborts subsequent requests.
    closePromise=ctx.close().catch(()=>{});
    return closePromise;
  };
  const safeUrl=raw=>{
    try {
      const u=new URL(raw);
      if(!['https:','http:'].includes(u.protocol))return u.protocol;
      if(/(?:challenge|captcha|verify|token|waf)/i.test(u.pathname))return u.origin+'/[redacted-challenge-resource]';
      const pathname=u.pathname.split('/').map(s=>s.length>80?'[redacted]':s).join('/');
      const out=new URL(u.origin+pathname);
      for(const key of ['portfolioId','leadPortfolioId','timeRange','dataType']) {
        const value=u.searchParams.get(key);
        if(value && /^(\d{19}|30D|90D|365D|ROI|PNL)$/.test(value))out.searchParams.set(key,value);
      }
      return out.href;
    } catch{return 'invalid_url';}
  };
  const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const numeric=value=>(typeof value==='number' && Number.isFinite(value)) || (typeof value==='string' && /^[+-]?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)));
  const sourceTime=value=>{
    let n=null;
    if(typeof value==='number' && Number.isSafeInteger(value))n=value<1e11?value*1000:value;
    else if(typeof value==='string' && /^\d{10}(?:\d{3})?$/.test(value))n=Number(value)*(value.length===10?1000:1);
    else if(typeof value==='string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))n=Date.parse(value);
    return Number.isFinite(n) && n>=Date.UTC(2009,0,1) && n<=Date.now()+5000?n:null;
  };
  const explicitTime=data=>{
    for(const field of ['sourceAt','sourceAsOf','asOf','updatedAt','updateTime','lastUpdateTime','dataUpdateTime']) {
      if(data && Object.hasOwn(data,field)) {
        const n=sourceTime(data[field]);
        if(n!==null)return {sourceAt:new Date(n).toISOString(),sourceTimeField:field,rawSourceTime:data[field]};
      }
    }
    return {sourceAt:null,sourceTimeField:null,rawSourceTime:null};
  };
  const bodyText=async()=>{
    const text=await bounded(page.locator('body').innerText({timeout:budget()}));
    const challenge=/verify (?:that )?you are human|checking your browser|access denied|request blocked|captcha|人機驗證|人机验证|安全驗證|安全验证|訪問被拒|访问被拒/i.test(text);
    if(challenge){await stop({kind:'blocked',code:'rendered_access_challenge'});throw Error('browser_stopped');}
    return text;
  };
  const scrub=text=>text.replace(/(?:bearer\s+|(?:token|cookie|authorization|secret|password)\s*[:=]\s*)[^\s,;]+/gi,'[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted-email]').slice(0,6000);
  const inspect=async response=>{
    const status=response.status(), rawUrl=response.url();
    const item={status,url:safeUrl(rawUrl),phase,bodySha256:null,bytes:null};
    if(receipts.length<200)receipts.push(item);
    if([401,403,418,429,451].includes(status)) {await stop({kind:'blocked',code:'http_'+status,status,url:item.url});return;}
    const waf=await bounded(response.headerValue('x-amzn-waf-action'));
    if(status===202 && String(waf).toLowerCase()==='challenge') {await stop({kind:'blocked',code:'waf_challenge_202',status,url:item.url});return;}
    if(stopped)return;
    let u;try{u=new URL(rawUrl);}catch{return;}
    // The three paths and dateTime/value chart schema are documented by this
    // repository's archived public collector. This observes them; it never calls them.
    const isPublic=u.origin==='https://www.binance.com' && /^\/bapi\/futures\/v\d+\/(?:public|friendly)\/future\/copy-trade\/lead-portfolio\/(?:detail|performance|chart-data)$/.test(u.pathname);
    const isDocument=response.request().isNavigationRequest();
    if(!isPublic && !isDocument && status!==202)return;
    const contentLength=await bounded(response.headerValue('content-length'));
    if(contentLength && Number(contentLength)>1024*1024){item.note='body_too_large';return;}
    const bytes=await bounded(response.body());
    if(bytes.length>1024*1024){item.note='body_too_large';return;}
    item.bytes=bytes.length;item.bodySha256=await digest(bytes);
    if(status===202) {
      item.note=bytes.length===0?'empty_response':'unclassified_202';
      if(isPublic || isDocument)await stop({kind:'not_proven',code:item.note,status,url:item.url});
      return;
    }
    if(!isPublic || status!==200 || response.request().method()!=='GET')return;
    let raw;try{raw=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{item.note='not_json';return;}
    if(raw?.success!==true || raw?.code!=='000000' || raw.data==null){item.note='unknown_public_response_schema';return;}
    const data=raw.data;
    const requestId=u.searchParams.get('portfolioId')||u.searchParams.get('leadPortfolioId');
    if(requestId!==T.id){item.note='unrelated_account';return;}
    if(data && !Array.isArray(data) && ['portfolioId','leadPortfolioId','publicLeadPortfolioId'].some(key=>data[key]!=null && String(data[key])!==T.id)) {
      item.note='identity_mismatch';return;
    }
    const evidence={url:item.url,bodySha256:item.bodySha256,httpStatus:status,phase:item.phase};
    if(u.pathname.endsWith('/detail')) {
      if(data.nickname===T.name && String(data.leadPortfolioId)===T.id && ['PUBLIC','SIGNAL'].includes(data.portfolioType) && data.status==='ACTIVE')profiles.push({portfolioId:T.id,name:T.name,...evidence});
      else item.note='identity_or_public_status_unproven';
      return;
    }
    if(item.phase!=='period365' || u.searchParams.get('timeRange')!==T.period || data.timeRange!=null && data.timeRange!==T.period){item.note='wrong_or_unobserved_period';return;}
    if(u.pathname.endsWith('/performance') && !Array.isArray(data) && numeric(data.roi)) {
      roiObservations.push({value:data.roi,unit:'percent',portfolioId:T.id,period:T.period,observedAt:new Date().toISOString(),...explicitTime(data),...evidence});
    }
    if(!u.pathname.endsWith('/chart-data'))return;
    const metric=u.searchParams.get('dataType')??data.dataType;
    if(!['ROI','PNL'].includes(metric)){item.note='curve_metric_unproven';return;}
    let points=null, arrayField=null;
    if(Array.isArray(data)){points=data;arrayField='data';}
    else for(const key of ['points','chart','chartList','dataPoints','list'])if(Array.isArray(data[key])){points=data[key];arrayField='data.'+key;break;}
    if(!points || points.length<2 || points.length>5000){item.note='raw_curve_points_unavailable';return;}
    let previous=-Infinity, timestampField=null;
    const mapped=[];
    for(const point of points) {
      if(!point || typeof point!=='object' || Array.isArray(point)){item.note='unknown_curve_schema';return;}
      const key=Object.hasOwn(point,'dateTime')?'dateTime':Object.hasOwn(point,'timestamp')?'timestamp':Object.hasOwn(point,'time')?'time':null;
      const time=key?sourceTime(point[key]):null;
      if(!key || time===null || time<=previous || !numeric(point.value) || timestampField && timestampField!==key ||
        point.timeRange!=null && point.timeRange!==T.period || point.dataType!=null && point.dataType!==metric){item.note='unknown_curve_schema';return;}
      previous=time;timestampField=key;mapped.push({timestamp:point[key],value:point.value});
    }
    curveObservations.push({portfolioId:T.id,period:T.period,metric,unit:metric==='PNL'?'USDT':'percent',points:mapped,arrayField,timestampField,
      // These are original source values with an explicit field mapping, not reconstructed chart pixels.
      curveSourceAt:new Date(previous).toISOString(),observedAt:new Date().toISOString(),...evidence});
  };
  const listener=response=>{
    const task=inspect(response).catch(()=>{if(!stopped && receipts.length<200)receipts.push({status:response.status(),url:safeUrl(response.url()),phase,note:'response_observation_failed'});});
    pending.add(task);task.finally(()=>pending.delete(task));
  };
  let overallTimer;
  try {
    overallTimer=setTimeout(()=>{void stop({kind:'not_proven',code:'browser_budget_timeout'});},config.budgetMs);
    // No route.fulfill, alternate origin, header spoofing, login, cookie injection, or retry.
    await ctx.route('**/*',async route=>{
      const request=route.request();
      if(stopped || Date.now()>=deadline){await route.abort();return;}
      if(request.isNavigationRequest() && request.frame().parentFrame()===null) {
        if(request.url()!==T.url || navigations!==0){await route.abort();void stop({kind:'not_proven',code:'unexpected_navigation'});return;}
        navigations++;
      }
      await route.continue();
    });
    page.on('response',listener);
    await page.goto(T.url,{waitUntil:'domcontentloaded',timeout:budget()});
    if(stopped)throw Error('browser_stopped');
    let text=await bodyText();
    if(!text.includes(T.name)) {
      await page.getByText(T.name,{exact:true}).first().waitFor({state:'visible',timeout:budget()});
      text=await bodyText();
    }
    if(page.url()!==T.url || !text.includes(T.name))throw Error('dom_identity_unproven');
    dom={url:page.url(),nameVisible:true,portfolioId:T.id,clickedPeriod:null,visibleText:scrub(text)};
    await page.screenshot({path:config.screenshotPath,fullPage:false,timeout:budget()});screenshot='visible.png';
    const choices=page.getByText(/^(365D|365\s*天|365\s*Days)$/i,{exact:true});
    let control=null;
    for(let i=0;i<await choices.count();i++)if(await choices.nth(i).isVisible()) {
      if(control)throw Error('ambiguous_365d_control');control=choices.nth(i);
    }
    if(!control)throw Error('365d_control_not_visible');
    phase='period365';await control.click({timeout:budget()});clicked365D=true;
    const observeUntil=Math.min(deadline-1000,Date.now()+30000);
    while(!stopped && Date.now()<observeUntil && !(roiObservations.length && curveObservations.length)) {
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(stopped)throw Error('browser_stopped');
    await bounded(Promise.allSettled([...pending]));
    text=await bodyText();
    dom={url:page.url(),nameVisible:text.includes(T.name),portfolioId:T.id,clickedPeriod:T.period,visibleText:scrub(text)};
    if(dom.url!==T.url || !dom.nameVisible)throw Error('dom_identity_changed');
    await page.screenshot({path:config.screenshotPath,fullPage:false,timeout:budget()});screenshot='visible.png';
  } catch(error) {
    if(!stopped)stopped={kind:'not_proven',code:/^(?:dom_identity_unproven|dom_identity_changed|365d_control_not_visible|ambiguous_365d_control|stage_timeout)$/.test(error.message)?error.message:'browser_stage_failed'};
  } finally {
    clearTimeout(overallTimer);
    page.off('response',listener);
    await bounded(closePromise||ctx.close().catch(()=>{}),3000).catch(()=>{});
  }
  return {probeSchema:1,target:T,clicked365D,navigations,stop:stopped,dom,screenshot,profiles,roiObservations,curveObservations,receipts};
}

function makeBrowserCode(config) {return `async page => (${browserProbe.toString()})(page, ${JSON.stringify(config)})\n`;}

function assess(observation,baseline,now=Date.now()) {
  if(!observation || observation.probeSchema!==1 || observation.target?.id!==TARGET.id || observation.target?.url!==TARGET.url)throw Error('invalid_browser_result');
  const result={schemaVersion:1,kind:'manual_browser_probe',target:TARGET,cliVersion:CLI_VERSION,baseline,
    observedAt:new Date(now).toISOString(),status:'not_proven',reason:null,canExpand:false,canPublish:false,
    dom:observation.dom??null,screenshot:observation.screenshot??null,receipts:observation.receipts??[],roi:null,curve:null};
  if(observation.stop){result.status=observation.stop.kind==='blocked'?'blocked':'not_proven';result.reason=observation.stop.code;return result;}
  if(observation.navigations!==1 || !observation.clicked365D || observation.dom?.url!==TARGET.url || !observation.dom?.nameVisible || observation.dom?.portfolioId!==TARGET.id){result.reason='identity_or_period_unproven';return result;}
  const profile=observation.profiles?.find(p=>p.portfolioId===TARGET.id && p.name===TARGET.name);
  if(!profile){result.reason='public_identity_unproven';return result;}
  const candidates=observation.roiObservations?.filter(r=>r.portfolioId===TARGET.id && r.period===TARGET.period && Number.isFinite(Number(r.value)))??[];
  const curves=observation.curveObservations?.filter(r=>r.portfolioId===TARGET.id && r.period===TARGET.period && ['ROI','PNL'].includes(r.metric) && Array.isArray(r.points) && r.points.length>=2)??[];
  const roi=candidates.at(-1),curve=curves.at(-1);
  if(roi)result.roi={...roi,freshnessUnknown:!roi.sourceAt};
  if(curve)result.curve=curve;
  if(!roi || !curve){result.status=roi||curve?'partial_observed':'not_proven';result.reason=!roi?'reported_roi_unavailable':'raw_timestamped_curve_unavailable';return result;}
  if(roi.sourceAt && !Number.isFinite(Date.parse(roi.sourceAt))){result.reason='invalid_roi_source_time';return result;}
  if(roi.sourceAt && Date.parse(roi.sourceAt)>now+5000 || Date.parse(curve.curveSourceAt)>now+5000){result.reason='source_time_in_future';return result;}
  if(roi.sourceAt && Date.parse(roi.sourceAt)<=Date.parse(baseline.compareAt) || !(Date.parse(curve.curveSourceAt)>Date.parse(baseline.compareAt))){result.status='partial_observed';result.reason='source_not_newer_than_archive';return result;}
  if(Number(roi.value)===baseline.roi){result.status='partial_observed';result.reason='roi_unchanged_from_archive';return result;}
  if(!roi.sourceAt) {
    // A changed value observed in the rendered account plus a genuinely newer raw
    // curve can justify expanding the observation. The curve time is NOT assigned
    // to ROI, and this partial source-time evidence is not an automatic publish gate.
    result.status='success_observed_changed';result.reason='changed_observed_roi_and_new_original_curve';result.canExpand=true;
    return result;
  }
  result.status='success';result.reason='new_source_timed_roi_and_original_curve';result.canExpand=true;result.canPublish=true;
  return result;
}

async function main(args,deps={}) {
  if(args.length!==2 || args[0]!=='--output-dir')throw Error('Usage: probe_binance_playwright.cjs --output-dir EMPTY_DIRECTORY');
  const outputDir=path.resolve(args[1]);
  if(fs.existsSync(outputDir) && fs.readdirSync(outputDir).length)throw Error('output_directory_must_be_empty');
  fs.mkdirSync(outputDir,{recursive:true});
  const run=deps.runCommand||runCommand, started=Date.now(), deadline=started+90000;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'binance-browser-session-'));
  const session='binance-manual-'+process.pid;
  let baseline=null,cli=null,result=null;
  try {
    baseline=archivedBaseline(deps.root);
    cli=deps.cli||resolveCli();
    const launchConfig=path.join(temp,'launch.json');
    fs.writeFileSync(launchConfig,JSON.stringify({browser:{browserName:'chromium',isolated:true,launchOptions:{headless:false}}}),{mode:0o600});
    await run(cli,['-s='+session,'open','about:blank','--headed','--config='+launchConfig],{cwd:temp,timeoutMs:Math.min(30000,deadline-Date.now()-8000)});
    const code=makeBrowserCode({target:TARGET,budgetMs:Math.min(70000,deadline-Date.now()-8000),screenshotPath:path.join(outputDir,'visible.png')});
    const script=path.join(temp,'browser-probe.js');fs.writeFileSync(script,code,{mode:0o600});
    const stdout=await run(cli,['-s='+session,'--raw','run-code','--filename='+script],{cwd:temp,timeoutMs:Math.max(1,deadline-Date.now()-5000)});
    result=assess(parseCliResult(stdout),baseline);
  } catch(error) {
    result={schemaVersion:1,kind:'manual_browser_probe',target:TARGET,cliVersion:CLI_VERSION,baseline,observedAt:new Date().toISOString(),status:'not_proven',
      reason:/^[a-z_]{1,80}$/.test(error.message)?error.message:'probe_failed',canExpand:false,canPublish:false,roi:null,curve:null,receipts:[]};
  } finally {
    // A CLI command failure never causes a second navigation. Cleanup is the only follow-up.
    if(cli)await run(cli,['-s='+session,'close'],{cwd:temp,timeoutMs:Math.max(1,Math.min(5000,deadline-Date.now()))}).catch(()=>{});
    fs.rmSync(temp,{recursive:true,force:true});
  }
  fs.writeFileSync(path.join(outputDir,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  return result;
}
if(require.main===module)main(process.argv.slice(2)).then(result=>{
  console.log(JSON.stringify({status:result.status,reason:result.reason,canExpand:result.canExpand,canPublish:result.canPublish}));
  if(!['success','success_observed_changed'].includes(result.status))process.exitCode=1;
}).catch(error=>{console.error(/^[a-z_]{1,80}$/.test(error.message)?error.message:'probe_invocation_failed');process.exitCode=1;});
module.exports={TARGET,CLI_VERSION,archivedBaseline,resolveCli,runCommand,parseCliResult,browserProbe,makeBrowserCode,assess,main};
