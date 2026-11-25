import {policy as originalPolicy} from './a-share-pattern-regimes.mjs';

export const version='books.a-share.daily-setups.2026-11-25.v1';
export const definitions=Object.freeze([
 {id:'trend-pullback',label:'上升结构回踩收复',description:'MA20高于MA60且二者五日斜率为正；日低在MA20上下2%内，阳线收回MA20；共用原8%/15%/8%价格防热。'},
 {id:'trend-continuation',label:'趋势延续观察',description:'MA20/60上行、MA5高于MA20、五日涨幅及相对沪深300二十日超额为正；共用原价格防热，不要求近期金叉。'},
 {id:'range-support',label:'箱体支撑T观察',description:'此前20日箱体宽4%至15%且至少两个ATR14；日低触及下四分之一、收盘回到箱体25%至65%；仅已有底仓的日线T计划。'},
 {id:'support-reclaim',label:'低位收复观察',description:'非上升20/60结构中，日低在此前20日低点上下2%内，下影不短于实体及四分之一ATR或低点抬高；收复前日高点或MA5。'}
]);
const mainboard=code=>/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(code||'');
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validBar=bar=>Boolean(bar&&day(bar.date)&&['open','high','low','close','volume'].every(key=>Number.isFinite(bar[key])&&bar[key]>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close));
const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));

function stockEligibility(series,index,stock){
 if(!mainboard(stock?.code)||typeof stock.name!=='string'||!stock.name.trim()||/^(?:S?\*?ST)|退/i.test(stock.name.replace(/\s/g,'')))return {status:'excluded',reason:'非已确认的沪深主板普通非ST股票'};
 if(!day(stock.listingDate))return {status:'unknown',reason:'上市日期未知，未推定普通主板涨跌幅适用性'};
 const calendar=series.referenceBars||series.bars,date=calendar[index]?.date,sixth=calendar[index-5]?.date;
 if(!day(date)||!day(sixth))return {status:'unknown',reason:'缺少至少六个真实交易日的上市适用性日期'};
 if(stock.listingDate>sixth)return {status:'excluded',reason:'上市尚未超过五个已知交易日，不按普通10%规则推定'};
 return {status:'ready',reason:'当前名册普通主板及已知上市日期；历史风险警示变更尚未核验'};
}

function limitAt(series,index,stock){
 const eligibility=stockEligibility(series,index,stock),bar=series.bars[index],previous=series.bars[index-1];
 if(eligibility.status!=='ready')return {...eligibility,atLimit:null,onePrice:validBar(bar)?bar.high===bar.low&&bar.open===bar.close:null};
 if(!validBar(bar)||!validBar(previous))return {status:'unknown',atLimit:null,onePrice:null,reason:'本日或前一真实交易日缺少有效日线，未跨缺口推定'};
 const roundedTenPercent=Math.round(previous.close*110)/100;
 return {status:'ready',atLimit:Math.abs(bar.close-roundedTenPercent)<=.011&&!above(bar.high,bar.close),onePrice:bar.high===bar.low&&bar.open===bar.close,roundedTenPercent,reason:'同源前复权日线近似；不是官方涨停价或封单核验'};
}

function limitUp(series,index,stock){
 const result={method:'daily_close_ten_percent_proxy',...limitAt(series,index,stock),consecutiveCount:null,observedConsecutiveCount:0,stage:'unknown',officialLimitPriceVerified:false};
 if(result.status==='excluded'){result.stage='excluded';return result;}
 if(result.atLimit===false){result.consecutiveCount=0;result.stage='not_limit';return result;}
 if(result.atLimit!==true)return result;
 let count=1;
 for(let prior=index-1;prior>=0;prior--){
  const before=limitAt(series,prior,stock);
  if(before.atLimit===false){result.consecutiveCount=count;result.observedConsecutiveCount=count;result.stage=count===1?'first_observed':'consecutive';return result;}
  if(before.atLimit!==true){result.observedConsecutiveCount=count;result.reason+='；连续段起点或此前交易日未核验，不断言首板或完整连板数';return result;}
  count++;
 }
 result.observedConsecutiveCount=count;result.reason+='；连续段触及数据起点，完整连板数未知';return result;
}

function metricsAt(series,index){
 const {bars,prices,volumes}=series,current=bars[index],previous=bars[index-1],range=(count,at=index)=>at>=count-1&&series.validRange(at-count+1,at);
 const ma=(period,at=index)=>range(period,at)?(prices[at+1]-prices[at-period+1])/period:null;
 const change=period=>range(period+1)?(current.close/bars[index-period].close-1)*100:null;
 const ma5=ma(5),ma20=ma(20),ma60=ma(60),old20=ma(20,index-5),old60=ma(60,index-5),history21=range(21),history61=range(61),history65=range(65),atrReady=range(15);
 let atr14=null;if(atrReady){let sum=0;for(let i=index-13;i<=index;i++)sum+=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));atr14=sum/14;}
 const prior=history21?bars.slice(index-20,index):[],past60=history61?bars.slice(index-59,index+1):[],prior20High=prior.length?Math.max(...prior.map(bar=>bar.high)):null,prior20Low=prior.length?Math.min(...prior.map(bar=>bar.low)):null;
 const highest=past60.length?Math.max(...past60.map(bar=>bar.high)):null,lowest=past60.length?Math.min(...past60.map(bar=>bar.low)):null;
 const reference=series.referenceBars,benchmark=reference?.slice(index-20,index+1),benchmark21=history21&&benchmark?.length===21&&benchmark.every((bar,i)=>validBar(bar)&&bar.date===bars[index-20+i].date)||false;
 const benchmarkReturn20=benchmark21?(benchmark[20].close/benchmark[0].close-1)*100:null,return20=change(20);
 return {day:current?.date||reference?.[index]?.date||null,index,historySize:index+1,availableBarCount:index+1-series.invalid[index+1],historyStart:bars[0]?.date||reference?.[0]?.date||null,historyEnd:current?.date||reference?.[index]?.date||null,
  close:validBar(current)?current.close:null,prevClose:validBar(previous)?previous.close:null,open:validBar(current)?current.open:null,high:validBar(current)?current.high:null,low:validBar(current)?current.low:null,
  ma5,ma20,ma60,ma20Slope5Percent:ma20!==null&&old20!==null?(ma20/old20-1)*100:null,ma60Slope5Percent:ma60!==null&&old60!==null?(ma60/old60-1)*100:null,atr14,atrMethod:'simple_mean_true_range_14',
  return5:change(5),return20,return60:change(60),ma20Deviation:ma20!==null?(current.close/ma20-1)*100:null,volumeRatio20:history21?current.volume/((volumes[index]-volumes[index-20])/20):null,
  prior20High,prior20Low,rangePosition60Percent:highest!==null&&above(highest,lowest)?(current.close-lowest)/(highest-lowest)*100:null,benchmarkReturn20,excess20:benchmark21?return20-benchmarkReturn20:null,
  valid:{current:validBar(current),previous:validBar(previous),history21,history61,history65,atr14:atrReady&&atr14>0,benchmark21},reasons:[]};
}

function plan(id,metrics,limit,anchorSupport,pressure,reason){
 const {high,low,atr14}=metrics,trigger=high,invalidation=Math.min(anchorSupport,low)-atr14*.5,buyLow=anchorSupport,buyHigh=Math.min(trigger,anchorSupport+atr14*.5);
 if(![trigger,invalidation,buyLow,buyHigh].every(value=>Number.isFinite(value)&&value>0)||!above(trigger,invalidation)||above(buyLow,buyHigh))return null;
 const reduceZone=Number.isFinite(pressure)&&above(pressure,trigger)?{low:Math.max(trigger,pressure-atr14*.5),high:pressure}:null;
 const definition=definitions.find(item=>item.id===id),modelState=limit.atLimit===true?'limit_up_next_session_recheck':id==='range-support'?'existing_position_T_watch':id==='support-reclaim'?'countertrend_watch':'next_session_watch';
 return {id,label:definition.label,trigger,invalidation,buyZone:{low:buyLow,high:buyHigh},reduceZone,reason:[...reason,'价格区域来自当时已知日线及ATR14，不表示盘中触发先后或实际成交',...(limit.atLimit===true?['本日收盘已在推定涨停价附近；只能次一交易日重新核验，不能写成当前可买']:[]),...(id==='range-support'?['仅适用于已有可卖底仓的日线波段T观察；不是早盘B点']:[])],modelState,qualified:false,actualFillVerified:false};
}

/** Every decision reads only positions <= index; the optional benchmark must be same-calendar real bars. */
export function analyzeDailyPrefix(series,index,stock){
 if(!series?.bars||!Number.isInteger(index)||index<0||index>=series.bars.length)throw TypeError('日线条件需要已对齐的序列与有效前缀位置');
 const metrics=metricsAt(series,index),limit=limitUp(series,index,stock),eligibility=stockEligibility(series,index,stock),setups=[];
 metrics.valid.stockEligible=eligibility.status==='ready';
 if(!metrics.valid.history61||!metrics.valid.atr14)metrics.reasons.push('不足61个连续有效真实交易日日线，或ATR14不可用');
 if(!metrics.valid.benchmark21)metrics.reasons.push('缺少同日对齐的沪深300二十日价格；趋势延续超额条件停用');
 if(eligibility.status!=='ready')metrics.reasons.push(eligibility.reason);
 const hot=metrics.return5!==null&&above(metrics.return5,originalPolicy.maxReturn5)||metrics.return20!==null&&above(metrics.return20,originalPolicy.maxReturn20)||metrics.ma20Deviation!==null&&above(metrics.ma20Deviation,originalPolicy.maxMa20Deviation);
 if(hot)metrics.reasons.push('超过统一5日8%、20日15%或MA20偏离8%的原价格防热上限');
 if(!metrics.valid.history61||!metrics.valid.atr14||eligibility.status!=='ready'||hot)return {metrics,limitUp:limit,setups};
 const bar=series.bars[index],previous=series.bars[index-1],rising=metrics.valid.history65&&above(metrics.ma20,metrics.ma60)&&above(metrics.ma20Slope5Percent,0)&&above(metrics.ma60Slope5Percent,0),width=metrics.prior20High-metrics.prior20Low,boxPercent=width/metrics.prior20Low*100;
 const add=(id,support,pressure,reasons)=>{const item=plan(id,metrics,limit,support,pressure,reasons);if(item)setups.push(item);};
 if(rising&&!above(Math.abs(bar.low/metrics.ma20-1)*100,2)&&!above(metrics.ma20,bar.close)&&above(bar.close,bar.open))add('trend-pullback',metrics.ma20,metrics.prior20High,['MA20/60上升结构，日低接近MA20上下2%且阳线收复']);
 if(rising&&above(metrics.ma5,metrics.ma20)&&above(metrics.return5,0)&&metrics.valid.benchmark21&&above(metrics.excess20,0))add('trend-continuation',metrics.ma20,metrics.prior20High,['MA20/60上行、MA5在MA20之上、五日正涨幅及二十日正超额']);
 if(!above(4,boxPercent)&&!above(boxPercent,15)&&!above(metrics.atr14*2,width)&&!above(bar.low,metrics.prior20Low+width*.25)&&!above(metrics.prior20Low+width*.25,bar.close)&&!above(bar.close,metrics.prior20Low+width*.65))add('range-support',metrics.prior20Low,metrics.prior20High,['此前20日箱体4%至15%且宽度至少两个ATR14；收盘回到25%至65%区间']);
 const previousMa5=series.validRange(index-5,index-1)?(series.prices[index]-series.prices[index-5])/5:null,shadow=Math.min(bar.open,bar.close)-bar.low,body=Math.abs(bar.close-bar.open),lowReversal=!above(Math.abs(bar.low/metrics.prior20Low-1)*100,2)&&(!above(Math.max(body,metrics.atr14*.25),shadow)||above(bar.low,previous.low)),reclaimed=above(bar.close,previous.high)||previousMa5!==null&&!above(previous.close,previousMa5)&&above(bar.close,metrics.ma5);
 const countertrend=!above(metrics.ma20,metrics.ma60)||!above(metrics.ma20Slope5Percent,0)||metrics.ma60Slope5Percent!==null&&!above(metrics.ma60Slope5Percent,0);
 if(countertrend&&lowReversal&&reclaimed)add('support-reclaim',Math.min(metrics.prior20Low,bar.low),metrics.prior20High,['非上升20/60结构的近20日低位，下影或低点抬高并收复前高/MA5','仅逆势反弹观察，不断言主力维护或趋势已经反转']);
 return {metrics,limitUp:limit,setups};
}
