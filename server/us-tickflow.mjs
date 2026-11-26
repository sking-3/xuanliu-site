export const sourceId='tickflow-free-us-forward-v1';
export const dataPolicy=Object.freeze({id:sourceId,name:'TickFlow · 美股盘后日线',provider:'TickFlow',documentation:'https://docs.tickflow.org/zh-Hans/faq',policyCheckedAt:'2026-11-26',collectionAllowed:true,analysisAllowed:true,permissionsVerified:true,rawPublic:false,derivedPublic:true,redistributionAllowed:false,accessScope:'derived_public',adjustment:'forward',adjustmentMethod:'比例前复权',corporateActionsVerified:false,volumeUnit:'股',maxRequestsPerMinute:60});
const endpoint='https://free-api.tickflow.org/v1';
const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function usDate(timestamp){
 const parts=Object.fromEntries(dateFormatter.formatToParts(new Date(timestamp)).map(p=>[p.type,p.value]));
 return parts.year+'-'+parts.month+'-'+parts.day;
}
export function parseSeries(series,day){
 const fields=['timestamp','open','high','low','close','volume'];
 if(!object(series)||fields.some(field=>!Array.isArray(series[field]))||fields.some(field=>series[field].length!==series.timestamp.length))throw Error('TickFlow US daily arrays are malformed');
 let previous='';return series.timestamp.map((timestamp,i)=>{
  if(!Number.isSafeInteger(timestamp))throw Error('TickFlow US daily timestamp is invalid');
  const date=usDate(timestamp),bar=Object.fromEntries(fields.slice(1).map(field=>[field,series[field][i]]));
  if(date<=previous||date>day||Object.values(bar).some(value=>!Number.isFinite(value)||value<0)||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close))throw Error('TickFlow US daily date/values are invalid');
  previous=date;
  if(Number.isFinite(series.amount?.[i])&&series.amount[i]>0)bar.amount=series.amount[i];
  return {date,...bar};
 });
}
export function filterUniverse(payload){
 if(payload?.exchange!=='US'||!Array.isArray(payload.data)||payload.count!==payload.data.length||!payload.count)throw Error('TickFlow US directory is incomplete');
 const excluded=[],universe=[],seen=new Set();
 const product=/\b(?:ETF|ETN|fund|trust|warrants?|preferred|units?|rights?|depositary|acquisition)\b|优先股|认股权|认购权|基金|存托凭证/i;
 for(const item of payload.data){
  if(item.exchange!=='US'||item.region!=='US'||item.type!=='stock'||typeof item.symbol!=='string'||seen.has(item.symbol))throw Error('TickFlow US directory identity/type is malformed');
  seen.add(item.symbol);
  if(!/^[-A-Z0-9.]+\.US$/.test(item.symbol)){excluded.push({symbol:item.symbol,name:item.name,reason:'来源证券代码含不支持标记，保留原值待核'});continue;}
  if(product.test(item.name||'')){excluded.push({symbol:item.symbol.slice(0,-3),name:item.name,reason:'名称明确表示基金、ETF或非普通股产品'});continue;}
  universe.push({symbol:item.symbol.slice(0,-3),providerSymbol:item.symbol,name:item.name||item.code,exchange:'US',securityQualified:false,securityType:'provider_stock_type_unverified',totalShares:item.ext?.total_shares??null});
 }
 universe.sort((a,b)=>a.symbol.localeCompare(b.symbol));
 return {universe,excluded,scope:{name:'TickFlow收录美股权益池 · 已排除名称明确的基金等产品',providerCount:payload.count,expected:universe.length,securityQualification:'普通股与主交易所资格尚未独立核验',fullUSMarket:false,directorySource:endpoint+'/exchanges/US/instruments?type=stock'}};
}
export function createTickflowUSSource({request,now=Date.now}){
 async function json(url){
  const response=await request(url,{method:'GET',redirect:'error'});
  if(!response.ok)throw Object.assign(Error('TickFlow US HTTP '+response.status),{httpStatus:response.status});
  const payload=await response.json();return {payload,fetchedAt:new Date(now()).toISOString()};
 }
 async function universe(){const {payload,fetchedAt}=await json(endpoint+'/exchanges/US/instruments?type=stock');return {...filterUniverse(payload),payload,fetchedAt};}
 async function history(stocks,{date,closeTime,close='160000'}){
  if(!Array.isArray(stocks)||stocks.length<1||stocks.length>50)throw Error('TickFlow US batch requires 1–50 instruments');
  const symbols=stocks.map(stock=>stock.providerSymbol||stock.symbol+'.US');
  if(symbols.some(symbol=>!/^[-A-Z0-9.]+\.US$/.test(symbol))||new Set(symbols).size!==symbols.length)throw Error('TickFlow US symbols are malformed or duplicated');
  const closeHour=Number(close.slice(0,2)),closeMinute=Number(close.slice(2,4));
  const endTime=Date.parse(closeTime)+(24-closeHour)*3600000-closeMinute*60000;
  const url=new URL(endpoint+'/klines/batch');
  for(const [key,value] of Object.entries({symbols:symbols.join(','),period:'1d',count:'500',end_time:String(endTime),adjust:'forward'}))url.searchParams.set(key,value);
  const {payload,fetchedAt}=await json(url.href);
  if(!object(payload?.data))throw Error('TickFlow US batch has no data map');
  const result=new Map();
  for(const stock of stocks){const key=stock.providerSymbol||stock.symbol+'.US',series=payload.data[key];result.set(stock.symbol,{bars:series?parseSeries(series,date):[],fetchedAt,sourceBarTime:series?.timestamp?.length?new Date(series.timestamp.at(-1)).toISOString():null,reason:series?null:'来源未返回该证券日线'});}
  return result;
 }
 return {universe,history};
}
