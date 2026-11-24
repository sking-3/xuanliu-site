export const sourceId='tickflow-free-forward-v1';
export const barSchema='ohlcv-v1';
export const dataPolicy=Object.freeze({rawPublic:false,derivedPublic:true,provider:'TickFlow',attribution:'TickFlow',documentation:'https://docs.tickflow.org/zh-Hans/faq',maxRequestsPerMinute:60});

const endpoint='https://free-api.tickflow.org/v1/klines/batch';
const fields=['timestamp','open','high','low','close','volume'];
const indices=new Set(['000300.SH','000001.SH','399001.SZ']);
const offset=8*60*60*1000;
export const historyCount=500;
const count=historyCount,minimum=61;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function hasOHLC(bars){
  return Array.isArray(bars)&&bars.length>=minimum&&bars.length<=count&&bars.every(bar=>bar&&
    ['open','high','low','close','volume'].every(field=>typeof bar[field]==='number'&&Number.isFinite(bar[field])&&bar[field]>=0)&&
    bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close))&&
    bars.slice(-minimum).every(bar=>['open','high','low','close','volume'].every(field=>bar[field]>0));
}
function transport(message){return Object.assign(new Error('TickFlow '+message),{transportError:true});}
function responseError(response,url,body,message){
  const responseSummary=body.replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi,'$1 [redacted]')
    .replace(/(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|set-cookie|cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;<>]+)/gi,'$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted]').replace(/\s+/g,' ').trim().slice(0,256);
  return Object.assign(transport(message),{details:{sourceId,url,httpStatus:response.status,contentType:response.headers.get('content-type'),server:response.headers.get('server'),retryAfter:response.headers.get('retry-after'),responseSummary}});
}
function targetEnd(day){
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new TypeError('目标交易日无效');
  const midnight=Date.parse(day+'T00:00:00Z');
  if(!Number.isFinite(midnight)||new Date(midnight).toISOString().slice(0,10)!==day)throw new TypeError('目标交易日无效');
  return midnight-offset+24*60*60*1000;
}
function readSeries(series,day){
  if(!object(series)||fields.some(field=>!Array.isArray(series[field])))throw transport('日线数组格式异常');
  const size=series.timestamp.length;
  if(size>count||fields.some(field=>series[field].length!==size))throw transport('日线数组长度异常');
  const bars=[];let previous='';
  for(let i=0;i<size;i++){
    const timestamp=series.timestamp[i];
    if(!Number.isSafeInteger(timestamp))throw transport('日线时间戳异常');
    const dateValue=new Date(timestamp+offset);
    if(!Number.isFinite(dateValue.getTime()))throw transport('日线时间戳异常');
    const date=dateValue.toISOString().slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<=previous||date>day)throw transport('日线日期倒序、重复或越界');
    previous=date;
    const [open,high,low,close,volume]=fields.slice(1).map(field=>series[field][i]);
    if(![open,high,low,close,volume].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0))throw transport('日线数值格式异常');
    if(high<Math.max(open,close)||low>Math.min(open,close))throw transport('日线价格范围异常');
    bars.push({date,open,high,low,close,volume});
  }
  if(size<minimum)return {bars,reason:'不足61个交易日日线'};
  if(bars.at(-1).date!==day)return {bars,reason:'缺少目标交易日日线'};
  if(!hasOHLC(bars))return {bars,reason:'最近61根日线存在无成交或无有效开高低收的交易日'};
  return {bars};
}

/** The caller supplies the shared rate-limited fetch; this adapter never retries. */
export function createTickflowSource({fetch,now=Date.now}){
  if(typeof fetch!=='function')throw new TypeError('需要注入限速请求函数');
  async function historyBatch(stocks,day,{index=false}={}){
    const endTime=targetEnd(day);
    if(!Array.isArray(stocks)||stocks.length>50||typeof index!=='boolean')throw new TypeError('每批最多50个标的，指数选项须明确');
    const codes=stocks.map(stock=>stock?.code);
    if(codes.some(code=>typeof code!=='string'||!/^\d{6}\.(SH|SZ)$/.test(code)||(index&&!indices.has(code)))||new Set(codes).size!==codes.length)throw new TypeError('证券代码或批次重复');
    if(!codes.length)return new Map();
    const url=new URL(endpoint);
    url.searchParams.set('symbols',codes.join(','));url.searchParams.set('period','1d');url.searchParams.set('count',String(count));
    url.searchParams.set('end_time',String(endTime));url.searchParams.set('adjust',index?'none':'forward');
    let response;
    try{response=await fetch(url.href,{method:'GET',redirect:'error'});}
    catch(error){if(error instanceof Error){error.transportError=true;throw error;}throw transport('连接未完成');}
    let body;
    try{body=await response.text();}catch{throw responseError(response,url.href,'响应体读取失败',response.ok?'响应体读取失败':'HTTP '+response.status);}
    if(!response.ok)throw responseError(response,url.href,body,'HTTP '+response.status);
    let payload;
    try{payload=JSON.parse(body);}catch{throw responseError(response,url.href,body,'响应不是有效JSON');}
    if(!object(payload)||!object(payload.data))throw transport('批次数据格式异常');
    const fetchedAt=new Date(now()).toISOString(),result=new Map();
    for(const code of codes){
      const series=payload.data[code];
      const parsed=series==null?{reason:'来源未返回该证券日线'}:readSeries(series,day);
      result.set(code,{status:parsed.reason?'unavailable':'ready',day,adjustment:index?'index':'qfq',bars:parsed.bars||[],historyRequested:count,fetchedAt,reason:parsed.reason||null,sourceId,adjustmentMethod:index?'指数不复权':'比例前复权',volumeUnit:'手'});
    }
    return result;
  }
  return {historyBatch};
}
