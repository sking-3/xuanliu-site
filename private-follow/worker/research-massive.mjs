/* Massive Stocks Basic: owner-only, dated EOD reads; never an intraday fallback. */
const massiveError=code=>Error(code);
function massiveDay(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw massiveError('research_invalid_date');return s;}
export function massiveLatestDay(now=Date.now()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(x=>[x.type,x.value]));const date=p.year+'-'+p.month+'-'+p.day;
 // Official 2026-11-13 change: 20:15 ET release, with 15 minutes of safety margin.
 return p.hour+':'+p.minute>='20:30'?date:new Date(Date.parse(date+'T12:00:00Z')-86400000).toISOString().slice(0,10);
}
function massivePast(s,now){massiveDay(s);if(s>massiveLatestDay(now)||Date.parse(s)<now-729*86400000)throw massiveError('research_eod_not_released');return s;}
export function massiveRequest(operation,p,c,now){
 const allowed={benchmark:['start','end'],universe:['date','pageToken'],daily:['date']}[operation];if(!allowed||Object.keys(p).some(k=>!allowed.includes(k)))throw massiveError('research_invalid_params');let path;const q=new URLSearchParams();
 if(operation==='benchmark'){const start=massivePast(p.start,now),end=massivePast(p.end,now);if(start>end||Date.parse(end)-Date.parse(start)>200*86400000)throw massiveError('research_invalid_date');path='/v2/aggs/ticker/SPY/range/1/day/'+start+'/'+end;q.set('adjusted','true');q.set('sort','asc');q.set('limit','50000');}
 else if(operation==='daily'){path='/v2/aggs/grouped/locale/us/market/stocks/'+massivePast(p.date,now);q.set('adjusted','true');q.set('include_otc','false');}
 else{massivePast(p.date,now);path='/v3/reference/tickers';if(p.pageToken){if(typeof p.pageToken!=='string'||!/^[A-Za-z0-9_+\/=.-]{1,4096}$/.test(p.pageToken))throw massiveError('research_invalid_page');q.set('cursor',p.pageToken);}else{for(const [k,v]of Object.entries({market:'stocks',type:'CS',active:'true',date:p.date,limit:'1000',sort:'ticker',order:'asc'}))q.set(k,v);}}
 return {url:'https://api.massive.com'+path+'?'+q,init:{method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+c.apiKey}}};
}
export function massiveNormalize(operation,v){
 if(v.status!=='OK')throw Object.assign(massiveError(v.status==='NOT_AUTHORIZED'?'research_permission_denied':'research_provider_error'),{permission:v.status==='NOT_AUTHORIZED'});const rows=v.results||[];if(!Array.isArray(rows)||rows.length>(operation==='daily'?30000:operation==='universe'?1000:201))throw Object.assign(massiveError('research_schema'),{reason:'massive_shape_or_count'});
 if(operation==='universe'){
  if(v.count!==rows.length||rows.some(r=>typeof r.ticker!=='string'))throw massiveError('research_schema');let nextCursor=null;
  if(v.next_url){let u;try{u=new URL(v.next_url);}catch{throw massiveError('research_invalid_page');}if(u.origin!=='https://api.massive.com'||u.pathname!=='/v3/reference/tickers'||u.username||u.password||u.hash||[...u.searchParams.keys()].some(k=>!['cursor'].includes(k))||!u.searchParams.get('cursor'))throw massiveError('research_invalid_page');nextCursor=u.searchParams.get('cursor');if(!/^[A-Za-z0-9_+\/=.-]{1,4096}$/.test(nextCursor))throw massiveError('research_invalid_page');}
  return {results:rows.map(r=>Object.fromEntries(['ticker','name','market','locale','primary_exchange','type','active','currency_name'].filter(k=>k in r).map(k=>[k,r[k]]))),nextCursor};
 }
 if(v.adjusted!==true||v.resultsCount!==rows.length||new Set(rows.map(r=>operation==='daily'?r.T:r.t)).size!==rows.length)throw Object.assign(massiveError('research_schema'),{reason:'massive_adjustment_count_or_duplicates'});
 if(rows.some(r=>!Number.isFinite(r.t)||operation==='daily'&&(typeof r.T!=='string'||r.T.length>32)||r.otc===true))throw Object.assign(massiveError('research_schema'),{reason:'massive_timestamp_symbol_or_otc'});
 // Individual missing/invalid OHLC/volume stays visible as a pending security; it must not erase an otherwise valid whole-market response.
 return {results:rows.map(r=>Object.fromEntries(['T','t','o','h','l','c','v','vw','n'].filter(k=>k in r).map(k=>[k,r[k]]))),adjusted:true,paginationComplete:!v.next_url};
}
