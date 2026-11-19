'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.BOOKS_PERIOD_REFRESH_UI_SOURCE||path.join(__dirname,'../trader/plaza.js'),'utf8');
const metrics=require('../trader/period-metrics.js');
const section=(first,last)=>{
  const start=source.indexOf(first),end=source.indexOf(last,start);
  assert(start>=0&&end>start,'actual refresh source must contain '+first);return source.slice(start,end);
};
const refreshCode=section('function refresh(background=false)','// Initialize the list in the browser');
const performanceCode=section('function publicPerformance(row,period)','function metricStamp(field)');
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function fixture({open=true,missing=false}={}){
  const stamp='2026-11-19T16:00:00.000Z',observed='2026-11-19T16:10:00.000Z';
  const address='0x'+'1'.repeat(40),arrived=deferred(),firstDraw=deferred(),draws=[],cards=[];
  const row={id:'hl-'+address,accountId:address,sourceKind:'public_account',exchange:'Hyperliquid',currency:'USD',
    windows:{'30D':{roi:305,pnl:690650,asOf:stamp,asOfType:'source'}}};
  const oldWin={fetchedAt:observed,win:{value:0,eligibleCount:74,startAt:'2026-08-01T00:00:00Z',endAt:'2026-08-02T00:00:00Z'}};
  const oldHistory={status:'ready',fetchedAt:observed,windows:{'30D':{mdd:106.59,mddUnavailableReason:null,
    sampleCount:2,mddPairedSampleCount:2,startAt:'2026-08-01T00:00:00Z',endAt:'2026-08-02T00:00:00Z',points:[]}}};
  const elements=new Map(),element=id=>{
    if(!elements.has(id))elements.set(id,{open:id==='detail'&&open,disabled:false,textContent:'',setAttribute(){},focus(){}});
    return elements.get(id);
  };
  const context={BooksPeriodMetrics:metrics,publicListPage:true,linkedAccount:open?address:null,
    state:{detail:open?{...row,windows:{'30D':{...row.windows['30D'],roi:299}}}:null,window:'30D',
      publicRows:[],rows:[],binanceRows:[],source:null,portfolioCacheReadFailed:false,winCacheReadFailed:false},
    periodSamples:null,periodReturns:null,okxReturns:null,bitgetReturns:null,
    publicRefreshMessage:'',publicReadAt:null,maxBytes:2*1024*1024,
    document:{body:{},activeElement:null},$:element,AbortController,setTimeout,clearTimeout,Date,
    sharedRequest:(_key,run)=>run(),readPublicWorkflow:async()=>{},refreshWinCache:async()=>{},refreshPortfolioCache:async()=>{},
    refreshBinance:async()=>{},refreshPublicFocus:async()=>{},
    refreshPeriodReturns:()=>arrived.promise.then(payload=>{context.periodSamples=metrics.parseSamples(payload);}),
    publicSnapshotVersion:()=>JSON.stringify({feed:context.state.feedText,samples:context.periodSamples?.generatedAt}),
    fetch:async url=>{assert.equal(url,'feed.json');return new Response(JSON.stringify({schemaVersion:1,status:'ready',
      source:{fetchedAt:observed},traders:[row]}));},
    decodeChunks:chunks=>Buffer.concat(chunks).toString('utf8'),validate:data=>data.traders,
    validateSource:data=>data.source,rejectOlderFeed(){},savePublicSnapshot(){},saveURL(){},
    openLinkedAccount(){},reevaluatePositions(){},updateView(){},choosePeriod(){},renderSource(){},
    mergeRows:()=>{context.state.rows=context.state.publicRows;},
    renderPreservingCardFocus:()=>{cards.push(context.publicPerformance(context.state.rows[0],'30D'));},
    publicReadFailures:()=>({}),
    isPublicAccount:row=>row.sourceKind==='public_account'&&!row._local,
    isPublicLead:row=>Boolean(row&&['OKX','Bitget'].includes(row.exchange)),
    isBinanceTrader:row=>Boolean(row?.sourceKind==='copy_trade'),
    performanceWindow:(row,period)=>row.windows[period]||null,portfolioSection:()=>oldHistory,cachedWin:()=>oldWin,
  };
  context.renderDetail=()=>{
    draws.push({period:context.state.window,metrics:context.publicPerformance(context.state.detail,context.state.window)});
    firstDraw.resolve();
  };
  const sandbox=vm.createContext(context);vm.runInContext(performanceCode+'\n'+refreshCode,sandbox);
  const raw={value:31,method:'pnl_peak_equity',startAt:'2026-10-21T16:00:00.000Z',endAt:stamp,count:30,observedAt:observed,sha256:'a'.repeat(64)};
  const payload={schemaVersion:1,generatedAt:observed,accounts:{[address]:{'30D':{anchorAt:stamp,observedAt:observed,
    mdd:missing?null:raw,win:missing?null:{...raw,value:74,count:100,method:'closing_fill_net_of_closing_fee'},
    curve:missing?[]:[{time:raw.startAt,value:0},{time:stamp,value:100}]}}}};
  return {context,arrived,firstDraw,draws,cards,payload,row};
}
test('the real refresh repaints a deep-linked HL detail in the same batch after deferred period data arrives',async()=>{
  const f=fixture(),pending=f.context.refresh(false);await f.firstDraw.promise;
  assert.equal(f.draws.length,1);assert.equal(f.draws[0].period,'30D');
  assert.equal(f.draws[0].metrics.roi,305);assert.equal(f.draws[0].metrics.mdd,null);assert.equal(f.draws[0].metrics.winRate,null);
  f.arrived.resolve(f.payload);await pending;
  assert.equal(f.draws.length,2,'waiting for the next timer or tab event is insufficient');
  const detail=f.draws.at(-1),card=f.cards.at(-1);
  assert.equal(detail.period,'30D');assert.equal(f.context.state.window,'30D');
  assert.equal(detail.metrics.mdd,31);assert.equal(detail.metrics.winRate,74);
  assert.equal(card.mdd,detail.metrics.mdd);assert.equal(card.winRate,detail.metrics.winRate);
  assert.equal(detail.metrics.metricTimes.mdd.endAt,f.payload.accounts[f.row.accountId]['30D'].anchorAt);
});
test('missing deferred metrics remain empty rather than restoring older cross-period samples',async()=>{
  const f=fixture({missing:true}),pending=f.context.refresh(false);await f.firstDraw.promise;
  f.arrived.resolve(f.payload);await pending;
  assert.equal(f.draws.length,2);assert.equal(f.draws.at(-1).period,'30D');
  assert.equal(f.draws.at(-1).metrics.mdd,null);assert.equal(f.draws.at(-1).metrics.winRate,null);
  assert.equal(f.cards.at(-1).mdd,null);assert.equal(f.cards.at(-1).winRate,null);
});
test('a normal list refresh without an open account never calls the non-null HL predicate on null',async()=>{
  const f=fixture({open:false}),pending=f.context.refresh(false);f.arrived.resolve(f.payload);await pending;
  assert.equal(f.draws.length,0);assert.equal(f.cards.at(-1).mdd,31);
});
