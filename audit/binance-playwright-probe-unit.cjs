'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {webcrypto}=require('node:crypto');
const {TARGET,PLAYWRIGHT_VERSION,DRIVER,archivedBaseline,loadPlaywright,browserProbe,assess,main}=require('../scripts/probe_binance_playwright.cjs');
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const previous='2024-02-18T10:00:00.000Z',fresh='2024-02-19T10:00:00.000Z',now=Date.parse('2024-02-20T10:00:00.000Z');
const baseline={roi:803.81948672,compareAt:previous,sourceAt:null,receiptAt:previous};
const prefix='https://www.binance.com/bapi/futures/v1/';
const publicUrl=kind=>prefix+(kind==='detail'?'friendly':'public')+'/future/copy-trade/lead-portfolio/'+(kind==='chart'?'chart-data':kind)+'?portfolioId='+TARGET.id+(kind==='detail'?'':'&timeRange=365D')+(kind==='chart'?'&dataType=ROI':'');
const profile={leadPortfolioId:TARGET.id,nickname:TARGET.name,portfolioType:'PUBLIC',status:'ACTIVE'};
const metric={timeRange:'365D',roi:'812.50',updateTime:Date.parse(fresh)};
const points=[{time:Date.parse(previous),value:'801.00'},{time:Date.parse(fresh),value:'812.50'}];
const wrapped=data=>JSON.stringify({code:'000000',success:true,data});
function mockResponse(kind,{status=200,body,headers={},url,method='GET',navigation=false}={}) {
  return {status:()=>status,url:()=>url||publicUrl(kind),headerValue:async key=>headers[key.toLowerCase()]??null,
    body:async()=>Buffer.from(body??wrapped(kind==='detail'?profile:kind==='performance'?metric:points)),
    request:()=>({isNavigationRequest:()=>navigation,method:()=>method})};
}
function fakePage({initial=[],afterClick=[],text=TARGET.name+' ROI 812.50% 365D',count=1}={}) {
  const page=new EventEmitter(),state={closed:0,navigations:0,clicks:0,screenshots:0,continued:0,aborted:0,routes:[]};
  let routeHandler;
  const context={route:async(pattern,handler)=>{assert.equal(pattern,'**/*');routeHandler=handler;},close:async()=>{state.closed++;}};
  page.context=()=>context;page.url=()=>TARGET.url;
  page.tryRequest=async url=>routeHandler({request:()=>({url:()=>url,isNavigationRequest:()=>true,frame:()=>({parentFrame:()=>null})}),
    abort:async()=>{state.aborted++;},continue:async()=>{state.continued++;}});
  page.goto=async(url,opts)=>{assert.equal(url,TARGET.url);assert.ok(opts.timeout<=30000);state.navigations++;await page.tryRequest(url);for(const response of initial)page.emit('response',response);};
  page.locator=selector=>{assert.equal(selector,'body');return {innerText:async()=>text};};
  const control={isVisible:async()=>true,click:async()=>{state.clicks++;for(const response of afterClick)page.emit('response',response);},waitFor:async()=>{}};
  page.getByText=(name)=>typeof name==='string'?{first:()=>control}:{count:async()=>count,nth:()=>control};
  page.screenshot=async()=>{state.screenshots++;};
  return {page,state};
}
async function observe(options={}) {
  const {page,state}=fakePage({initial:[mockResponse('detail')],afterClick:[mockResponse('performance'),mockResponse('chart')],...options});
  const result=await browserProbe(page,{target:TARGET,budgetMs:800,screenshotPath:'/private/tmp/mock-binance-visible.png'});
  return {result,page,state};
}
function completeObservation() {
  return {probeSchema:1,target:TARGET,navigations:1,clicked365D:true,stop:null,
    dom:{url:TARGET.url,nameVisible:true,portfolioId:TARGET.id,visibleText:TARGET.name+' 365D'},screenshot:'visible.png',
    profiles:[{portfolioId:TARGET.id,name:TARGET.name}],receipts:[],
    roiObservations:[{portfolioId:TARGET.id,period:'365D',value:'812.5',sourceAt:fresh}],
    curveObservations:[{portfolioId:TARGET.id,period:'365D',metric:'ROI',points:points.map(p=>({timestamp:p.time,value:p.value})),curveSourceAt:fresh}]};
}

test('browser observes one rendered account and one UI period action, preserving original point values',async()=>{
  const {result,state}=await observe();
  assert.equal(result.stop,null);assert.equal(state.navigations,1);assert.equal(state.clicks,1);assert.equal(state.closed,1);
  assert.equal(result.profiles[0].name,TARGET.name);assert.equal(result.roiObservations[0].value,'812.50');
  assert.equal(result.roiObservations[0].sourceAt,fresh);assert.equal(result.curveObservations[0].timestampField,'time');
  assert.deepEqual(result.curveObservations[0].points,points.map(p=>({timestamp:p.time,value:p.value})));
  assert.equal(assess(result,baseline,now).status,'success');
  assert.ok(result.receipts.every(r=>/^[a-f0-9]{64}$/.test(r.bodySha256)));
});

test('every explicit denial closes the context and blocks subsequent requests without a second navigation',async()=>{
  for(const status of [401,403,418,429,451]) {
    const {result,page,state}=await observe({initial:[mockResponse('detail',{status})],afterClick:[]});
    assert.equal(result.stop.code,'http_'+status);assert.equal(result.stop.kind,'blocked');assert.equal(state.clicks,0);
    await page.tryRequest(TARGET.url);assert.equal(state.aborted,1);assert.equal(state.navigations,1);assert.equal(state.closed,1);
    const checked=assess(result,baseline,now);assert.equal(checked.status,'blocked');assert.equal(checked.canPublish,false);
  }
});

test('WAF challenge 202 and unproven empty 202 have distinct outcomes, neither is retried',async()=>{
  for(const [headers,expected,status] of [[{'x-amzn-waf-action':'challenge'},'waf_challenge_202','blocked'],[{},'empty_response','not_proven']]) {
    const {result,state}=await observe({initial:[mockResponse('detail',{status:202,body:'',headers})],afterClick:[]});
    assert.equal(result.stop.code,expected);assert.equal(result.stop.kind,status);assert.equal(state.navigations,1);assert.equal(state.closed,1);
    assert.equal(assess(result,baseline,now).status,status);
  }
});

test('redirects and repeated top-frame navigations are aborted rather than followed',async()=>{
  const {result,page,state}=await observe();assert.equal(result.stop,null);
  await page.tryRequest('https://www.binance.com/en/copy-trading/lead-details/'+TARGET.id);
  assert.equal(state.aborted,1);assert.equal(state.continued,1);
});

test('unknown or interpolated curve shapes remain unavailable; source points require ordered real timestamps',async()=>{
  for(const data of [[{value:1},{value:2}],[{timestamp:'Monday',value:1},{timestamp:'Tuesday',value:2}],
    [{time:Date.parse(fresh),value:1},{time:Date.parse(previous),value:2}],{svgPath:'M0 0 L20 50'},
    [{time:Date.parse(previous),value:null},{time:Date.parse(fresh),value:1}]]) {
    const {result}=await observe({afterClick:[mockResponse('performance'),mockResponse('chart',{body:wrapped(data)})]});
    assert.equal(result.curveObservations.length,0);
    const checked=assess(result,baseline,now);assert.equal(checked.status,'partial_observed');assert.equal(checked.curve,null);assert.equal(checked.canExpand,false);
  }
});

test('a changed page ROI and a new original curve can expand observations while ROI source time stays unknown',async()=>{
  const {result}=await observe({afterClick:[mockResponse('performance',{body:wrapped({timeRange:'365D',roi:'813'})}),mockResponse('chart')]});
  const checked=assess(result,baseline,now);
  assert.equal(checked.status,'success_observed_changed');assert.equal(checked.reason,'changed_observed_roi_and_new_original_curve');
  assert.equal(checked.roi.sourceAt,null);assert.equal(checked.roi.freshnessUnknown,true);assert.equal(checked.curve.curveSourceAt,fresh);
  assert.equal(checked.canExpand,true);assert.equal(checked.canPublish,false);
  result.curveObservations=[];
  const missingCurve=assess(result,baseline,now);
  assert.equal(missingCurve.status,'partial_observed');assert.equal(missingCurve.roi.sourceAt,null);assert.equal(missingCurve.canExpand,false);
});

test('the archived official chart-data PNL dateTime/value schema retains USDT values without rebasing',async()=>{
  const pnl=[{dateTime:Date.parse(previous),value:'-10.2500'},{dateTime:Date.parse(fresh),value:'1114857.75897284'}];
  const {result}=await observe({afterClick:[mockResponse('performance'),mockResponse('chart',{
    url:publicUrl('chart').replace('dataType=ROI','dataType=PNL'),body:wrapped(pnl)})]});
  const curve=result.curveObservations[0];
  assert.equal(curve.metric,'PNL');assert.equal(curve.unit,'USDT');assert.equal(curve.timestampField,'dateTime');
  assert.deepEqual(curve.points,pnl.map(p=>({timestamp:p.dateTime,value:p.value})));
  assert.equal(assess(result,baseline,now).status,'success');
});

test('wrong response identity, period and chart metric never become matching observations',async()=>{
  for(const patch of [
    {performance:mockResponse('performance',{body:wrapped({...metric,portfolioId:'999'})})},
    {performance:mockResponse('performance',{body:wrapped({...metric,timeRange:'90D'})})},
    {performance:mockResponse('performance',{url:publicUrl('performance').replace(TARGET.id,'999')})},
    {chart:mockResponse('chart',{url:publicUrl('chart').replace('dataType=ROI','dataType=UNKNOWN')})}
  ]) {
    const {result}=await observe({afterClick:[patch.performance||mockResponse('performance'),patch.chart||mockResponse('chart')]});
    assert.notEqual(assess(result,baseline,now).status,'success');
  }
  const {result}=await observe({initial:[mockResponse('detail',{body:wrapped({...profile,nickname:'another trader'})})]});
  assert.equal(assess(result,baseline,now).reason,'public_identity_unproven');
});

test('source time must be newer than archive independently of local receipt time and changed ROI',()=>{
  const good=completeObservation();assert.equal(assess(good,baseline,now).status,'success');
  for(const [change,reason] of [
    [o=>o.roiObservations[0].sourceAt=previous,'source_not_newer_than_archive'],
    [o=>o.curveObservations[0].curveSourceAt=previous,'source_not_newer_than_archive'],
    [o=>o.roiObservations[0].value=baseline.roi,'roi_unchanged_from_archive'],
    [o=>o.clicked365D=false,'identity_or_period_unproven'],
    [o=>o.dom.nameVisible=false,'identity_or_period_unproven']
  ]) {const o=structuredClone(good);change(o);const result=assess(o,baseline,now);assert.equal(result.reason,reason);assert.equal(result.canPublish,false);}
});

test('the specialized observer initiates one navigation without direct API calls or bypass actions',()=>{
  const code=browserProbe.toString();
  assert.equal((code.match(/page\.goto\(/g)||[]).length,1);
  assert.ok(!/\b(?:fetch|request\.get|request\.post|storageState|addCookies|setExtraHTTPHeaders|route\.fulfill)\s*\(/.test(code));
});

test('response summaries redact unknown query parameters and never persist full headers or response bodies',async()=>{
  const {result}=await observe({afterClick:[mockResponse('performance',{url:publicUrl('performance')+'&token=SECRET&cookie=SESSION',headers:{authorization:'Bearer SECRET','set-cookie':'secret'}}),mockResponse('chart')]});
  const serialized=JSON.stringify(result);assert.ok(!serialized.includes('SECRET'));assert.ok(!serialized.includes('SESSION'));
  assert.ok(!serialized.includes('authorization'));assert.ok(!serialized.includes('set-cookie'));assert.ok(!serialized.includes('bodyBase64'));
});

test('the standard Playwright package version is verified before loading',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'probe-package-test-'));
  try {
    const runtime={chromium:{launch:async()=>{}}};let loaded=null;
    fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify({name:'playwright',version:PLAYWRIGHT_VERSION}));
    assert.equal(loadPlaywright({PLAYWRIGHT_PACKAGE_DIR:temp},directory=>{loaded=directory;return runtime;}),runtime);
    assert.equal(loaded,fs.realpathSync(temp));
    fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify({name:'playwright',version:'99.0.0'}));
    assert.throws(()=>loadPlaywright({PLAYWRIGHT_PACKAGE_DIR:temp},()=>{throw Error('must_not_load');}),/version_mismatch/);
    assert.throws(()=>loadPlaywright({PLAYWRIGHT_PACKAGE_DIR:'relative'}),/directory_required/);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('standard browser lifecycle preserves denial results after immediate context closure',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'probe-main-test-')),output=path.join(temp,'artifacts'),calls=[];
  const root=path.join(__dirname,'..'),files=['trader/binance/period-returns.json','scripts/source-holds.json'];
  const before=files.map(file=>fs.readFileSync(path.join(root,file)));
  const {page,state}=fakePage({initial:[mockResponse('detail',{status:403})]});
  const context=page.context();context.newPage=async()=>{calls.push('newPage');return page;};
  const browser={newContext:async options=>{
    assert.deepEqual(options,{viewport:{width:1440,height:1000},serviceWorkers:'block'});
    calls.push('newContext');return context;
  },close:async()=>{calls.push('browser.close');}};
  const playwright={chromium:{launch:async options=>{
    assert.deepEqual(options,{headless:false});calls.push('launch');return browser;
  }}};
  try {
    const result=await main(['--output-dir',output],{playwright,root});
    assert.equal(result.status,'blocked');assert.equal(result.reason,'http_403');assert.equal(result.stage,'navigate');
    assert.equal(result.driver,DRIVER);assert.equal(result.kind,'manual_standard_playwright_probe');assert.equal(result.canPublish,false);
    assert.equal(state.closed,1);assert.equal(state.navigations,1);assert.equal(state.clicks,0);
    assert.deepEqual(calls,['launch','newContext','newPage','browser.close']);
    const persisted=JSON.parse(fs.readFileSync(path.join(output,'result.json'),'utf8'));
    assert.equal(persisted.status,'blocked');assert.equal(persisted.receipts[0].status,403);
    assert.equal(persisted.receipts[0].url,publicUrl('detail'));
    assert.deepEqual(fs.readdirSync(output),['result.json']);
    for(let i=0;i<files.length;i++)assert.deepEqual(fs.readFileSync(path.join(root,files[i])),before[i]);
    await assert.rejects(main(['--output-dir',output],{playwright}),/must_be_empty/);
    assert.equal(archivedBaseline(root).sourceAt,null);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('driver setup failures report the actual failing stage and do not retry launch',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'probe-driver-failure-'));let launches=0;
  try {
    const playwright={chromium:{launch:async()=>{launches++;throw Error('missing_display');}}};
    const result=await main(['--output-dir',path.join(temp,'artifacts')],{playwright});
    assert.equal(result.reason,'missing_display');assert.equal(result.stage,'setup_browser');assert.equal(launches,1);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
