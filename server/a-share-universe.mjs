export const universeSourceId='tickflow-free-instruments-v1';
export const universeSchema='books.a-share.universe.v1';
export const universeUrls=['SH','SZ'].map(exchange=>'https://free-api.tickflow.org/v1/exchanges/'+exchange+'/instruments?type=stock');
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const mainBoard=code=>/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(code);

// The provider's current reference list is not a historical point-in-time membership file.
export async function readTickflowUniverse({fetch,day,now=Date.now,sectors=new Map(),sectorAsOf=null}){
  if(typeof fetch!=='function'||!validDay(day))throw TypeError('名册读取需要统一限速请求及目标交易日');
  const universe=[],seen=new Set();
  for(const [i,url] of universeUrls.entries()){
    const exchange=i===0?'SH':'SZ',response=await fetch(url,{method:'GET',redirect:'error'});
    if(!response.ok)throw Error('TickFlow '+exchange+'名册 HTTP '+response.status);
    const payload=await response.json();
    if(!payload||payload.exchange!==exchange||!Array.isArray(payload.data)||payload.count!==payload.data.length||payload.count<500)throw Error('TickFlow '+exchange+'名册覆盖或格式异常');
    for(const item of payload.data){
      if(!item||item.exchange!==exchange||item.region!=='CN'||item.type!=='stock'||item.symbol!==item.code+'.'+exchange||!/^\d{6}$/.test(item.code)||seen.has(item.symbol)||typeof item.name!=='string'||!item.name.trim())throw Error('TickFlow 名册证券身份缺失、重复或不符');
      seen.add(item.symbol);
      const listingDate=item.ext?.listing_date??null;
      if(listingDate!==null&&!validDay(listingDate))throw Error('TickFlow 名册上市日期格式异常');
      if(!mainBoard(item.symbol)||listingDate!==null&&listingDate>day)continue;
      universe.push({code:item.symbol,name:item.name.trim(),exchange,sector:sectors.get(item.symbol)||'未分类',listingDate});
    }
  }
  if(universe.length<1000)throw Error('沪深主板名册覆盖不足');
  universe.sort((a,b)=>a.code.localeCompare(b.code));
  const retrievedAt=new Date(now()).toISOString();
  return {schema:universeSchema,day,retrievedAt,universe,universePolicy:{sourceId:universeSourceId,sourceUrls:universeUrls,retrievedAt,basis:'provider_current_reference',historicalMembership:false,listingDatesKnown:universe.filter(stock=>stock.listingDate!==null).length,sectorAsOf}};
}
