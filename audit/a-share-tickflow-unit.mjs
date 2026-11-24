import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTickflowSource,sourceId,dataPolicy,barSchema,hasOHLC,historyCount,diagnoseHistory} from '../server/a-share-tickflow.mjs';
import {readTickflowUniverse,universeSourceId,universeSchema,universeUrls} from '../server/a-share-universe.mjs';

const day='2026-11-20',now=()=>Date.parse('2026-11-21T01:00:00Z');
const stocks=[{code:'600519.SH'},{code:'000333.SZ'}];
const copy=value=>JSON.parse(JSON.stringify(value));
function series(size=80){
  const dates=[];
  for(let date=new Date(day+'T00:00:00Z');dates.length<size;date.setUTCDate(date.getUTCDate()-1))if(![0,6].includes(date.getUTCDay()))dates.unshift(date.toISOString().slice(0,10));
  return {timestamp:dates.map(date=>Date.parse(date+'T00:00:00+08:00')),open:dates.map((_,i)=>100+i),high:dates.map((_,i)=>102+i),low:dates.map((_,i)=>99+i),close:dates.map((_,i)=>101+i),volume:dates.map((_,i)=>1000+i)};
}
function fixture(data,changes={}){
  const calls=[];
  const api=createTickflowSource({now,fetch:async(url,options)=>{calls.push({url:new URL(url),options});return Response.json({data});},...changes});
  return {api,calls};
}
test('one injected request maps all requested symbols and preserves actual closes, volume units and source policy',async()=>{
  const raw=series(),h=fixture({'600519.SH':raw,'000333.SZ':copy(raw)}),result=await h.api.historyBatch(stocks,day);
  assert.equal(h.calls.length,1);assert.equal(result.size,2);const {url,options}=h.calls[0];
  assert.equal(url.origin,'https://free-api.tickflow.org');assert.equal(url.pathname,'/v1/klines/batch');assert.equal(url.searchParams.get('symbols'),'600519.SH,000333.SZ');
  assert.equal(url.searchParams.get('period'),'1d');assert.equal(url.searchParams.get('adjust'),'forward');assert.equal(url.searchParams.get('count'),'500');assert.equal(url.searchParams.get('end_time'),'1795190400000');assert.equal(options.redirect,'error');
  for(const source of result.values()){
    assert.equal(source.status,'ready');assert.equal(source.bars.length,raw.timestamp.length);assert.equal(source.bars.at(-1).date,day);assert.equal(source.bars[0].close,raw.close[0]);assert.equal(source.bars.at(-1).volume,raw.volume.at(-1));assert.equal(source.historyRequested,500);
    assert.deepEqual(source.bars[0],{date:source.bars[0].date,open:raw.open[0],high:raw.high[0],low:raw.low[0],close:raw.close[0],volume:raw.volume[0]});
    assert.deepEqual(source.bars.at(-1),{date:day,open:raw.open.at(-1),high:raw.high.at(-1),low:raw.low.at(-1),close:raw.close.at(-1),volume:raw.volume.at(-1)});assert.equal(hasOHLC(source.bars),true);
    assert.equal(source.sourceId,sourceId);assert.equal(source.adjustment,'qfq');assert.equal(source.adjustmentMethod,'比例前复权');assert.equal(source.volumeUnit,'手');assert.equal(source.fetchedAt,new Date(now()).toISOString());
  }
  assert.equal(sourceId,'tickflow-free-forward-v1');assert.equal(barSchema,'ohlcv-v1');assert.equal(dataPolicy.rawPublic,false);assert.equal(dataPolicy.derivedPublic,true);assert.equal(dataPolicy.maxRequestsPerMinute,60);
});
test('close-only histories cannot claim OHLC coverage and invalid positive-price ranges are rejected',async()=>{
  const raw=series(),h=fixture({'600519.SH':raw}),source=(await h.api.historyBatch([stocks[0]],day)).get('600519.SH');
  const closeOnly=source.bars.map(({date,close,volume})=>({date,close,volume}));assert.equal(hasOHLC(closeOnly),false);assert.equal(hasOHLC([]),false);
  for(const mutate of [bar=>{delete bar.open;},bar=>{bar.low=bar.high+1;},bar=>{bar.high=bar.close-1;},bar=>{bar.open=0;},bar=>{bar.volume=NaN;}]){
    const bars=copy(source.bars);mutate(bars.at(-1));assert.equal(hasOHLC(bars),false);
  }
  raw.open[raw.open.length-1]=0;const zero=fixture({'600519.SH':raw});await assert.rejects(zero.api.historyBatch([stocks[0]],day),error=>error.transportError===true);
});
test('the three index symbols share one unadjusted batch and retain index provenance',async()=>{
  const indices=['000300.SH','000001.SH','399001.SZ'],h=fixture(Object.fromEntries(indices.map(code=>[code,series()])));
  const result=await h.api.historyBatch(indices.map(code=>({code})),day,{index:true});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url.searchParams.get('adjust'),'none');
  for(const source of result.values()){assert.equal(source.adjustment,'index');assert.equal(source.adjustmentMethod,'指数不复权');assert.equal(source.status,'ready');}
});
test('missing symbols, empty histories and insufficient listing history stay individually unavailable',async()=>{
  const h=fixture({'600519.SH':series()}),result=await h.api.historyBatch(stocks,day);assert.equal(result.get('600519.SH').status,'ready');assert.equal(result.get('000333.SZ').status,'unavailable');assert.deepEqual(result.get('000333.SZ').bars,[]);
  for(const size of [0,1,60]){const h=fixture({'600519.SH':series(size)}),result=await h.api.historyBatch([stocks[0]],day);assert.equal(result.get('600519.SH').status,'unavailable');assert.equal(result.get('600519.SH').bars.length,size);}
});
test('absent target day or zero-trade days never receive invented or carried-forward bars',async()=>{
  for(const modify of [raw=>{for(const field of Object.keys(raw))raw[field].pop();},raw=>{raw.volume[raw.volume.length-1]=0;},raw=>{raw.volume[raw.volume.length-20]=0;},raw=>{for(const field of ['open','high','low','close'])raw[field][raw.close.length-1]=0;}]){
    const raw=series();modify(raw);const h=fixture({'600519.SH':raw}),source=(await h.api.historyBatch([stocks[0]],day)).get('600519.SH');
    assert.equal(source.status,'unavailable');assert.equal(source.bars.length,raw.timestamp.length);
  }
});
test('descending, duplicate and future dates are batch protocol failures',async()=>{
  for(const modify of [raw=>{for(const field of Object.keys(raw))raw[field].reverse();},raw=>{raw.timestamp[1]=raw.timestamp[0];},raw=>{raw.timestamp[raw.timestamp.length-1]=Date.parse('2026-11-21T00:00:00+08:00');},raw=>{raw.timestamp[0]='1795190400000';}]){
    const raw=series();modify(raw);const h=fixture({'600519.SH':raw});await assert.rejects(h.api.historyBatch([stocks[0]],day),error=>error.transportError===true);assert.equal(h.calls.length,1);
  }
});
test('malformed arrays or nonfinite and negative values stop the whole batch rather than create per-stock missing rows',async()=>{
  for(const modify of [raw=>{raw.close.pop();},raw=>{delete raw.high;},raw=>{raw.close[5]=NaN;},raw=>{raw.volume[5]=-1;},raw=>{raw.close[5]='106';},raw=>{raw.high[5]=1;},raw=>{raw.timestamp[5]=Infinity;}]){
    const raw=series();modify(raw);const h=fixture({'600519.SH':series(),'000333.SZ':raw});await assert.rejects(h.api.historyBatch(stocks,day),error=>error.transportError===true);assert.equal(h.calls.length,1);
  }
});
test('invalid JSON, absent batch data and per-series schema corruption are transport failures without retry',async()=>{
  for(const payload of [null,[],{}, {data:[]},{data:null},{data:{'600519.SH':'bad'}}]){
    let requests=0;const api=createTickflowSource({now,fetch:async()=>{requests++;return Response.json(payload);}});
    await assert.rejects(api.historyBatch([stocks[0]],day),error=>error.transportError===true);assert.equal(requests,1);
  }
  const api=createTickflowSource({now,fetch:async()=>new Response('<html>HTML page</html>')});
  await assert.rejects(api.historyBatch([stocks[0]],day),error=>error.transportError===true);
});
test('HTTP rejection and guarded network errors propagate once with transportError for the worker to stop',async()=>{
  for(const status of [401,403,418,429,451,500]){
    let requests=0;const api=createTickflowSource({fetch:async()=>{requests++;return new Response('',{status});}});
    await assert.rejects(api.historyBatch([stocks[0]],day),error=>error.transportError===true&&error.message.includes(String(status)));assert.equal(requests,1);
  }
  let requests=0;const denied=new Error('HTTP429；Retry-After 至 2026-11-21T02:00:00Z；已停止');
  const api=createTickflowSource({fetch:async()=>{requests++;throw denied;}});
  await assert.rejects(api.historyBatch([stocks[0]],day),error=>error===denied&&error.transportError===true);assert.equal(requests,1);
});
test('HTTP errors retain only allowlisted headers and a bounded redacted response summary',async()=>{
  let requests=0,reads=0;
  const headers=new Headers({'content-type':'text/html','server':'test-gateway','retry-after':'120','set-cookie':'SID=HEADER_COOKIE_SECRET','authorization':'Bearer HEADER_AUTH_SECRET','x-private':'HEADER_PRIVATE_SECRET'});
  const api=createTickflowSource({fetch:async()=>{requests++;return {ok:false,status:501,headers,text:async()=>{reads++;return 'Authorization: Bearer BODY_AUTH_SECRET token=BODY_TOKEN_SECRET api_key="BODY_KEY_SECRET" '+ 'x'.repeat(500);}};}});
  await assert.rejects(api.historyBatch([stocks[0]],day),error=>{
    assert.equal(error.transportError,true);const details=error.details;
    assert.deepEqual(Object.keys(details),['sourceId','url','httpStatus','contentType','server','retryAfter','responseSummary']);
    assert.equal(details.sourceId,sourceId);assert.equal(details.httpStatus,501);assert.equal(details.contentType,'text/html');assert.equal(details.server,'test-gateway');assert.equal(details.retryAfter,'120');
    assert.equal(new URL(details.url).origin,'https://free-api.tickflow.org');assert.equal(new URL(details.url).username,'');assert.equal(new URL(details.url).password,'');
    assert.ok(details.responseSummary.length<=256);assert.match(details.responseSummary,/redacted/);assert.doesNotMatch(JSON.stringify(details),/BODY_AUTH_SECRET|BODY_TOKEN_SECRET|BODY_KEY_SECRET|HEADER_COOKIE_SECRET|HEADER_AUTH_SECRET|HEADER_PRIVATE_SECRET/);
    return true;
  });
  assert.equal(requests,1);assert.equal(reads,1);
});
test('nonJSON and body read failures keep a bounded diagnostic and consume the response only once',async()=>{
  for(const readFailure of [false,true]){
    let requests=0,reads=0;
    const api=createTickflowSource({fetch:async()=>{requests++;return {ok:true,status:200,headers:new Headers({'content-type':'text/html','server':'edge'}),
      text:async()=>{reads++;if(readFailure)throw Error('private reader detail');return '<html>token=BODY_SECRET blocked</html>';},json:()=>{throw Error('must not read twice');}};}});
    await assert.rejects(api.historyBatch([stocks[0]],day),error=>{
      assert.equal(error.transportError,true);assert.equal(error.details.httpStatus,200);assert.equal(error.details.server,'edge');
      assert.doesNotMatch(error.details.responseSummary,/BODY_SECRET|private reader detail/);if(readFailure)assert.equal(error.details.responseSummary,'响应体读取失败');return true;
    });
    assert.equal(requests,1);assert.equal(reads,1);
  }
});
test('invalid input cannot invoke the injected fetch, and an empty batch makes zero requests',async()=>{
  let requests=0;const api=createTickflowSource({fetch:async()=>{requests++;throw Error('must not request');}});
  for(const [rows,target,options]of [[[...stocks,...stocks],day,{}],[[{code:'430047.BJ'}],day,{}],[[{code:'600519.SH\n'}],day,{}],[[{code:'600519.SH'}],day,{index:true}],[stocks,'2026-02-30',{}],[stocks,day,{index:'false'}],[Array.from({length:51},(_,i)=>({code:(600000+i)+'.SH'})),day,{}]])await assert.rejects(api.historyBatch(rows,target,options),TypeError);
  assert.equal((await api.historyBatch([],day)).size,0);assert.equal(requests,0);assert.throws(()=>createTickflowSource({}),TypeError);
  assert.doesNotMatch(readFileSync(new URL('../server/a-share-tickflow.mjs',import.meta.url),'utf8'),/globalThis\.fetch|setInterval|setTimeout|retry\s*\(/);
});

test('500 actual bars are retained once; old suspended rows remain raw while recent invalid bars stay unavailable',async()=>{
  const raw=series(historyCount);raw.volume[0]=0;raw.open[0]=raw.high[0]=raw.low[0]=raw.close[0]=0;
  const h=fixture({'600519.SH':raw}),source=(await h.api.historyBatch([stocks[0]],day)).get(stocks[0].code);
  assert.equal(source.status,'ready');assert.equal(source.bars.length,500);assert.equal(source.bars[0].volume,0);assert.equal(source.bars[0].close,0);assert.equal(hasOHLC(source.bars),true);assert.equal(hasOHLC(source.bars.slice(-61)),true);
  raw.volume[499]=0;const recent=(await fixture({'600519.SH':raw}).api.historyBatch([stocks[0]],day)).get(stocks[0].code);assert.equal(recent.status,'unavailable');assert.equal(recent.bars.length,500);assert.equal(recent.bars[499].volume,0);
  await assert.rejects(fixture({'600519.SH':series(501)}).api.historyBatch([stocks[0]],day),/长度/);
});

test('coverage diagnostics distinguish a real current-day bar with short history without weakening 61-bar eligibility',async()=>{
  const h=fixture({'600519.SH':series(30)}),source=(await h.api.historyBatch([stocks[0]],day)).get(stocks[0].code);
  assert.equal(source.status,'unavailable');assert.equal(source.reason,'不足61个交易日日线');assert.equal(hasOHLC(source.bars),false);assert.equal(h.calls.length,1);
  assert.deepEqual(source.diagnostic,{code:'insufficient_history',requestedDay:day,returnedBars:30,requiredBars:61,firstDay:source.bars[0].date,lastDay:day,targetDayPresent:true,targetDayValid:true,recentInvalidCount:0,recentInvalidDays:[],analysisHistoryReady:false});
});
test('coverage diagnostics retain stale and absent source facts without claiming a listing lifecycle',async()=>{
  const raw=series();for(const key of Object.keys(raw))raw[key].pop();
  const lag=(await fixture({'600519.SH':raw}).api.historyBatch([stocks[0]],day)).get(stocks[0].code);
  assert.equal(lag.status,'unavailable');assert.equal(lag.diagnostic.code,'target_day_missing');assert.equal(lag.diagnostic.lastDay,lag.bars.at(-1).date);assert.equal(lag.diagnostic.targetDayPresent,false);assert.equal(lag.diagnostic.targetDayValid,false);assert.equal(lag.diagnostic.analysisHistoryReady,false);assert.equal('delisted' in lag.diagnostic,false);
  const missing=(await fixture({}).api.historyBatch([stocks[0]],day)).get(stocks[0].code);
  assert.equal(missing.diagnostic.code,'series_absent');assert.equal(missing.diagnostic.returnedBars,0);assert.equal(missing.diagnostic.lastDay,null);assert.equal(missing.status,'unavailable');
  const empty=(await fixture({'600519.SH':series(0)}).api.historyBatch([stocks[0]],day)).get(stocks[0].code);
  assert.equal(empty.diagnostic.code,'empty_history');assert.equal(empty.reason,'不足61个交易日日线');
});
test('diagnostics work on immutable old archives and preserve invalid-day evidence and all 500 raw bars',async()=>{
  const raw=series(500);raw.volume[0]=0;raw.open[0]=raw.high[0]=raw.low[0]=raw.close[0]=0;
  const source=(await fixture({'600519.SH':raw}).api.historyBatch([stocks[0]],day)).get(stocks[0].code);
  const {diagnostic,...legacy}=copy(source),before=copy(legacy);assert.deepEqual(diagnoseHistory(legacy),diagnostic);assert.deepEqual(legacy,before);assert.equal(diagnostic.code,'ready');assert.equal(diagnostic.recentInvalidCount,0);assert.equal(source.bars.length,500);assert.equal(source.bars[0].close,0);
  raw.volume[499]=0;const invalid=(await fixture({'600519.SH':raw}).api.historyBatch([stocks[0]],day)).get(stocks[0].code);
  assert.equal(invalid.status,'unavailable');assert.equal(invalid.diagnostic.code,'recent_invalid_bars');assert.equal(invalid.diagnostic.targetDayPresent,true);assert.equal(invalid.diagnostic.targetDayValid,false);assert.deepEqual(invalid.diagnostic.recentInvalidDays,[day]);assert.equal(invalid.diagnostic.analysisHistoryReady,false);
  assert.throws(()=>diagnoseHistory({day,bars:null}),TypeError);assert.throws(()=>diagnoseHistory({day:'2026-02-30',bars:[]}),TypeError);
});

function instruments(exchange){return {exchange,count:600,data:Array.from({length:600},(_,i)=>{
  const code=String((exchange==='SH'?600000:1000)+i).padStart(6,'0');return {symbol:code+'.'+exchange,code,exchange,region:'CN',type:'stock',name:'真实名册格式'+i,ext:{listing_date:'2010-01-04'}};
})};}
test('official free exchange lists form the full current reference independently from dated quote snapshots',async()=>{
  const calls=[],rows={SH:instruments('SH'),SZ:instruments('SZ')};rows.SH.data[0].name='*ST保留';rows.SH.data[1].ext.listing_date='2026-11-23';rows.SZ.data[0].ext.listing_date=null;
  const result=await readTickflowUniverse({day,now,sectors:new Map([['600000.SH','已归档行业']]),sectorAsOf:'2026-11-11T08:00:00Z',fetch:async url=>{calls.push(url);return Response.json(rows[url.includes('/SH/')?'SH':'SZ']);}});
  assert.deepEqual(calls,universeUrls);assert.equal(result.schema,universeSchema);assert.equal(result.day,day);assert.equal(result.retrievedAt,new Date(now()).toISOString());assert.equal(result.universe.length,1199);
  assert.equal(result.universe.find(stock=>stock.code==='600000.SH').name,'*ST保留');assert.equal(result.universe.find(stock=>stock.code==='600000.SH').sector,'已归档行业');assert.equal(result.universe.some(stock=>stock.code==='600001.SH'),false);
  assert.equal(result.universe.find(stock=>stock.code==='001000.SZ').listingDate,null);assert.equal(result.universePolicy.historicalMembership,false);assert.equal(result.universePolicy.sourceId,universeSourceId);assert.equal(result.universePolicy.basis,'provider_current_reference');assert.equal(result.universePolicy.sectorAsOf,'2026-11-11T08:00:00Z');
});
test('incomplete, inconsistent, duplicate or rejected exchange metadata stops without an alternative list',async()=>{
  for(const change of [x=>{x.count++;},x=>{x.data.pop();},x=>{x.data[0].symbol='600000.SZ';},x=>{x.data[0].ext.listing_date='2026-02-30';},x=>{x.data[1]=copy(x.data[0]);},x=>{x.data[0].name='';},x=>{x.count=499;x.data=x.data.slice(0,499);}]){
    let calls=0;const row=instruments('SH');change(row);await assert.rejects(readTickflowUniverse({day,now,fetch:async()=>{calls++;return Response.json(row);}}));assert.equal(calls,1);
  }
  for(const status of [403,418,429,451,500]){let calls=0;await assert.rejects(readTickflowUniverse({day,now,fetch:async()=>{calls++;return new Response('',{status});}}),new RegExp(String(status)));assert.equal(calls,1);}
});
