'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.BooksControlModel=api;
})(globalThis,()=>{
 const engineVersion='books.trend-screen.2026-11-21.v1';
 const schema='books.research.dataset.v1',MAX_BYTES=24*1024*1024;
 const indexCodes=new Set(['000300.SH','000001.SH','399001.SZ']);
 const stockPattern=/^(?:6\d{5}\.SH|(?:00|30)\d{4}\.SZ)$/;
 const DEFAULT_CONFIG=Object.freeze({module:'a-share-consensus',name:'默认共性方案',settings:Object.freeze({lookback:20,sampleSize:'120',benchmark:'000300.SH',mode:'consensus',limits:Object.freeze({enabled:true,maxReturn20:15,maxReturn60:30,maxReturn5:8,maxDeviation:8,maxVolumeRatio:2.5})})});
 const fail=message=>{throw new TypeError(message);};
 const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
 function plain(value){return !!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
 function jsonInput(value,maxBytes){
  let nodes=0;
  function visit(item,depth){
   if(++nodes>2000000||depth>12)fail('资料结构过大或层级过深');
   if(item===null||typeof item==='string'||typeof item==='boolean')return;
   if(typeof item==='number'){if(!Number.isFinite(item))fail('资料含非有限数值');return;}
   if(!Array.isArray(item)&&!plain(item))fail('只接受普通 JSON 资料');
   if(Array.isArray(item))for(let i=0;i<item.length;i++)if(!own(item,String(i)))fail('资料数组不能有空缺');
   for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(item))){
    if(key==='length'&&Array.isArray(item))continue;
    if(['__proto__','constructor','prototype'].includes(key))fail('资料含不安全字段');
    if(!own(descriptor,'value'))fail('资料不能含动态访问器');
    if(descriptor.value===undefined&&!Array.isArray(item))continue;
    visit(descriptor.value,depth+1);
   }
  }
  visit(value,0);const serialized=JSON.stringify(value);
  if(typeof serialized!=='string'||new TextEncoder().encode(serialized).length>maxBytes)fail('资料超过大小限制');
 }
 function object(value,label){if(!plain(value))fail(label+'须为普通对象');return value;}
 function known(value,keys,label){object(value,label);for(const key of Object.keys(value))if(!keys.includes(key))fail(label+'含未支持字段：'+key);}
 function text(value,label,max=100){if(typeof value!=='string'||!value.trim()||value.length>max||/[<>\u0000-\u001f\u007f]/.test(value))fail(label+'须为有长度限制的纯文字');return value.trim();}
 function dayValue(value,label='交易日'){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail(label+'格式无效');
  const time=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)fail(label+'无效');return value;
 }
 function stamp(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value))fail(label+'须为含时区的 ISO 时间');
  dayValue(value.slice(0,10),label);if(/[+-]14:(?!00)/.test(value))fail(label+'时区无效');
  if(!Number.isFinite(Date.parse(value)))fail(label+'无效');return value;
 }
 function integer(value,label,min,max){if(!Number.isInteger(value)||value<min||value>max)fail(label+'超出范围');return value;}
 function normalizeConfig(value){
  if(value===undefined)value={};jsonInput(value,16384);known(value,['module','name','settings'],'配置');
  const moduleName=value.module===undefined?DEFAULT_CONFIG.module:value.module;if(moduleName!==DEFAULT_CONFIG.module)fail('不支持的研究模块');
  const name=text(value.name===undefined?DEFAULT_CONFIG.name:value.name,'方案名称',80);if(/(?:https?:\/\/|javascript:|data:)/i.test(name))fail('方案名称不能包含网址或代码');
  const input=value.settings===undefined?{}:value.settings;known(input,['lookback','sampleSize','benchmark','mode','limits'],'研究设置');
  const settings={...DEFAULT_CONFIG.settings,...input};
  if(![20,60].includes(settings.lookback))fail('周期仅支持20或60个交易日');
  if(!['120','240','all'].includes(settings.sampleSize))fail('样本规模仅支持120、240或all');
  if(!indexCodes.has(settings.benchmark))fail('基准只能是已支持的指数');
  if(!['consensus','market','strength'].includes(settings.mode))fail('研究模式无效');
  const inputLimits=input.limits===undefined?{}:input.limits;known(inputLimits,Object.keys(DEFAULT_CONFIG.settings.limits),'排除上限');
  const limits={...DEFAULT_CONFIG.settings.limits,...inputLimits};if(typeof limits.enabled!=='boolean')fail('排除开关须为布尔值');
  for(const key of Object.keys(limits).filter(k=>k!=='enabled'))if(!Number.isFinite(limits[key])||limits[key]<=0||limits[key]>(key==='maxVolumeRatio'?100:1000))fail('排除上限须为范围内的有限正数');
  return {module:moduleName,name,settings:{lookback:settings.lookback,sampleSize:settings.sampleSize,benchmark:settings.benchmark,mode:settings.mode,limits}};
 }
 function stock(value){
  object(value,'股票');if(typeof value.code!=='string'||!stockPattern.test(value.code))fail('股票代码须为沪深A股代码，不能使用指数');
  const exchange=value.code.slice(-2);if(value.exchange!==undefined&&value.exchange!==exchange)fail('股票交易所与代码不符');
  return {code:value.code,name:text(value.name??value.code,'股票名称'),sector:text(value.sector??'未分类','行业'),exchange};
 }
 function bars(value,day,label){
  if(!Array.isArray(value)||value.length<2||value.length>61)fail(label+'须为2至61根日线');let previous='';
  const result=value.map(bar=>{
   object(bar,label);const date=dayValue(bar.date,label+'日期');if(date<=previous||date>day)fail(label+'日期须唯一、递增且不晚于交易日');previous=date;
   if(!Number.isFinite(bar.close)||bar.close<=0||!Number.isFinite(bar.volume)||bar.volume<=0)fail(label+'价格和成交量须为正的有限数值');
   return {date,close:bar.close,volume:bar.volume};
  });
  if(previous!==day)fail(label+'缺少目标交易日');return result;
 }
 function normalizeDataset(value){
  jsonInput(value,MAX_BYTES);object(value,'数据集');if(value.schema!==schema)fail('数据集版本不支持');
  if(value.completed!==true||value.collectionStatus!=='complete')fail('只接受完整结束的原始采集批次');
  const day=dayValue(value.day),asOf=stamp(value.asOf,'快照时间');if(new Date(Date.parse(asOf)+8*3600000).toISOString().slice(0,10)!==day)fail('快照时间的北京时间日期须与交易日一致');
  if(!Array.isArray(value.records)||!value.records.length||value.records.length>6000)fail('逐股记录须为1至6000条');
  const expectedCount=integer(value.expectedCount,'计划数量',1,6000),totalUniverseCount=integer(value.totalUniverseCount,'市场池数量',expectedCount,6000);
  if(value.records.length!==expectedCount)fail('实际请求记录数须等于计划数量');
  if(!Array.isArray(value.universe)||value.universe.length!==totalUniverseCount)fail('完整市场池数量与声明不符');
  const universe=value.universe.map(stock),codes=new Set();for(const item of universe){if(codes.has(item.code))fail('市场池股票代码重复');codes.add(item.code);}
  const ref=object(value.reference,'指数日历');if(!indexCodes.has(ref.code)||ref.adjustment!=='index')fail('参考日历须为支持的指数原始日线');
  const reference={code:ref.code,adjustment:'index',bars:bars(ref.bars,day,'指数日线'),fetchedAt:stamp(ref.fetchedAt,'指数读取时间')};
  const seen=new Set(),records=value.records.map(record=>{
   object(record,'逐股记录');const item=stock(record.stock);if(seen.has(item.code))fail('请求股票代码重复');if(!codes.has(item.code))fail('请求股票不在完整市场池内');seen.add(item.code);
   const source=object(record.source,'来源');if(source.day!==undefined&&source.day!==day)fail('来源交易日与批次不符');
   let normalized;
   if(source.status==='ready'){
    if(source.adjustment!=='qfq')fail('个股来源须明确提供前复权日线');
    normalized={status:'ready',day,adjustment:'qfq',bars:bars(source.bars,day,'个股日线'),fetchedAt:stamp(source.fetchedAt,'个股读取时间')};
   }else if(source.status==='unavailable'){
    normalized={status:'unavailable',day,reason:text(source.reason??'来源资料不足','缺失原因',500)};
    if(source.fetchedAt!==undefined&&source.fetchedAt!==null)normalized.fetchedAt=stamp(source.fetchedAt,'个股读取时间');
   }else fail('来源状态只能为ready或unavailable');
   return {stock:item,source:normalized};
  });
  return {schema,day,asOf,completed:true,collectionStatus:'complete',expectedCount,totalUniverseCount,universe,reference,records};
 }
 const yieldTurn=()=>new Promise(resolve=>setTimeout(resolve,0));
 async function evaluateDataset(input,configuration,engine,{onProgress,shouldStop}={}){
  const dataset=normalizeDataset(input),config=normalizeConfig(configuration),settings=config.settings;
  if(!engine||typeof engine.evaluate!=='function'||typeof engine.buildConsensus!=='function'||typeof engine.selectMarketSample!=='function')fail('研究计算引擎不可用');
  const requested=settings.sampleSize==='all'?dataset.totalUniverseCount:Math.min(Number(settings.sampleSize),dataset.totalUniverseCount);
  const counts={total:dataset.expectedCount,checked:0,ready:0,matched:0,excluded:0,missing:0},records=[];
  const times=dataset.records.map(r=>r.source.fetchedAt).filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const sourceTimes={asOf:dataset.asOf,referenceFetchedAt:dataset.reference.fetchedAt,fetchedStart:times[0]??null,fetchedEnd:times.at(-1)??null};
  const summary={mode:settings.mode,sampleSize:settings.sampleSize,fullMarket:dataset.expectedCount===dataset.totalUniverseCount,requestedCount:dataset.expectedCount,totalUniverseCount:dataset.totalUniverseCount,validCount:0,coverage:0,breadth:null,commonCount:null,identified:false,period:{lookback:settings.lookback,startAt:null,endAt:dataset.day},curveReturn:null};
  const result=(status,reason)=>({status,reason,summary,records,counts,day:dataset.day,sourceTimes,engineVersion});
  const stopped=()=>typeof shouldStop==='function'&&shouldStop();
  const progress=()=>{if(typeof onProgress==='function')onProgress({checked:counts.checked,total:counts.total,counts:{...counts},day:dataset.day});};
  if(settings.mode==='consensus'&&requested!==dataset.expectedCount)return result('unavailable','原始批次与所选样本规模不一致，须使用对应的完整共性归档；不能扩大或缩小已采集参考池');
  if(settings.benchmark!==dataset.reference.code)return result('unavailable','原始批次指数日历与所选基准不一致，须使用对应原始日线');
  if(stopped())return result('stopped','研究已停止，尚未生成完整结论');
  let consensus=null;
  if(settings.mode==='consensus'){
   const chosen=engine.selectMarketSample(dataset.universe,requested),actual=new Set(dataset.records.map(r=>r.stock.code));
   if(chosen.length!==requested||chosen.some(s=>!actual.has(s.code)))return result('unavailable','原始请求名单不符合完整市场池的固定分层取样规则');
   consensus=engine.buildConsensus({records:dataset.records.filter(r=>r.source.status==='ready').map(r=>({stock:r.stock,bars:r.source.bars})),calendar:dataset.reference.bars,lookback:settings.lookback,day:dataset.day,expectedCount:dataset.expectedCount,totalUniverseCount:dataset.totalUniverseCount});
   summary.validCount=consensus.validCount;summary.coverage=consensus.coverage;summary.breadth=consensus.breadth;summary.commonCount=consensus.commonCount;
   summary.period.startAt=consensus.dates?.[0]??null;
   if(consensus.status==='ready')summary.curveReturn=(consensus.medianReturns.reduce((value,r)=>value*(1+r),1)-1)*100;
  }
  progress();await yieldTurn();
  for(const record of dataset.records){
   if(stopped())return result('stopped','研究已停止，部分计算结果保留，未生成完整结论');
   let evaluation;
   if(record.source.status==='ready')evaluation=engine.evaluate({mode:settings.mode,bars:record.source.bars,referenceBars:dataset.reference.bars,lookback:settings.lookback,day:dataset.day,code:record.stock.code,consensus,limits:settings.limits});
   else evaluation={status:'unavailable',matched:null,excluded:false,exclusionReasons:[],reason:record.source.reason,metrics:null,reasons:[]};
   records.push({stock:{...record.stock},result:evaluation});counts.checked++;
   if(evaluation.status==='ready'){counts.ready++;if(evaluation.matched)counts.matched++;if(evaluation.excluded)counts.excluded++;if(!summary.period.startAt)summary.period.startAt=evaluation.metrics?.startAt??null;}else counts.missing++;
   if(counts.checked%20===0){progress();await yieldTurn();}
  }
  if(stopped())return result('stopped','研究已停止，未生成完整结论');
  if(!consensus){summary.validCount=counts.ready;summary.coverage=counts.ready/dataset.expectedCount;}
  summary.identified=consensus?.status==='ready'&&consensus.identified===true;
  progress();return result(consensus&&consensus.status!=='ready'||!counts.ready?'unavailable':'complete',consensus?.reason||(counts.ready?'原始日线已按固定规则核验':'资料不足，无法生成有效结论'));
 }
 return {DEFAULT_CONFIG,engineVersion,normalizeConfig,normalizeDataset,evaluateDataset};
});
