'use strict';
(function(root,factory){
 const api=factory(typeof module==='object'&&module.exports?require('./trend-screen.js'):root.BooksTrendScreen,typeof module==='object'&&module.exports?require('./trend-patterns.js'):root.BooksTrendPatterns);
 if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksStrengthSelection=api;
})(globalThis,(engine,patterns)=>{
 const compare=(a,b)=>a<b?-1:a>b?1:0;
 const exceeds=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
 const median=values=>{const sorted=values.slice().sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
 const validDay=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
 const sectorName=record=>typeof record.stock.sector==='string'&&record.stock.sector.trim()?record.stock.sector.trim():'未分类';
 function sectorStats(records,day,lookback){
  const groups=new Map();
  for(const record of records){
   const name=sectorName(record);if(!groups.has(name))groups.set(name,{total:0,members:[]});
   const group=groups.get(name),r=record.result,m=r.metrics;if(r.eligible!==false)group.total++;
   if(r.status==='ready'&&r.eligible!==false&&m?.endAt===day&&m.sampleCount===lookback+1&&validDay(m.startAt)&&m.startAt<day)group.members.push(record);
  }
  const sectors=[...groups].map(([sector,group])=>{
   const memberCount=group.members.length,known=!['未分类','未知','未知行业'].includes(sector),valid=group.members.filter(record=>Number.isFinite(record.result.metrics.periodReturn)&&Number.isFinite(record.result.metrics.volumeRatio)&&record.result.metrics.volumeRatio>0);
   const coverage=group.total?memberCount/group.total:0,ready=known&&memberCount>=3&&coverage>=.8&&valid.length===memberCount;
   return {sector,status:ready?'ready':'unavailable',reason:!known?'行业归属未知':memberCount<3?'同周期有效行业成员不足3只':coverage<.8?'行业日线覆盖不足80%':valid.length!==memberCount?'同行业所选周期收益或阶段均量比缺失':'盘后行业价格热度，非题材或资金流',day,lookback,
    stats:{memberCount,totalCount:group.total,validCount:valid.length,coverage,periodReturnMedian:ready?median(valid.map(record=>record.result.metrics.periodReturn)):null,upRatio:ready?valid.filter(record=>record.result.metrics.periodReturn>0).length/memberCount:null,volumeRatioMedian:ready?median(valid.map(record=>record.result.metrics.volumeRatio)):null,rank:null,percentile:null}};
  });
  const ranked=sectors.filter(sector=>sector.status==='ready').sort((a,b)=>b.stats.periodReturnMedian-a.stats.periodReturnMedian||compare(a.sector,b.sector));
  for(let start=0;start<ranked.length;){
   let end=start+1;while(end<ranked.length&&!exceeds(ranked[start].stats.periodReturnMedian,ranked[end].stats.periodReturnMedian))end++;
   const percentile=ranked.length===1?100:100*(ranked.length-1-start-(end-start-1)/2)/(ranked.length-1);
   for(let i=start;i<end;i++){ranked[i].stats.rank=start+1;ranked[i].stats.percentile=percentile;}
   start=end;
  }
  return sectors.sort((a,b)=>(a.stats.rank??Infinity)-(b.stats.rank??Infinity)||compare(a.sector,b.sector));
 }
 function baseSelection(record,{mode,qualification,patternId,day,lookback}){
  const r=record.result,p=record.patterns;
  if(r.status!=='ready'||r.candidateMatched==null||r.strengthKnown===false)return {selected:null,reason:r.reason||'本轮行情或筛选条件资料不足'};
  if(patternId){
   const facts=p?.facts,bound=p?.version===patterns.version&&p.day===day&&p.lookback===lookback&&facts?.version===patterns.version&&facts.day===day&&facts.lookback===lookback&&facts.status==='ready';
   if(!bound||p.status!=='ready'||!Array.isArray(p.labels)||!Array.isArray(p.unavailable)||p.unavailable.some(item=>item.id===patternId))return {selected:null,reason:'所选技术形态资料不足（事实版本、日期或周期不齐），未确认退出'};
  }
  const basis=qualification==='observation'&&mode==='consensus'?r.candidateMatched===true&&r.directionMatched!==false:r.matched===true;
  const shape=!patternId||p.labels.some(item=>item.id===patternId);
  return {selected:basis&&shape,reason:basis&&!shape?'未满足所选技术形态':r.reason||''};
 }
 function select(records,{day,lookback,mode,qualification='strict',patternId='',peer={enabled:false},sectorRecords=records}={}){
  if(!Array.isArray(records)||!validDay(day)||![20,60].includes(lookback)||!engine.MODES.includes(mode)||!['strict','observation'].includes(qualification))throw Error('统一筛选的记录、日期、周期或模式无效');
  if(typeof patternId!=='string'||patternId&&!patterns.definitions.some(pattern=>pattern.id===patternId))throw Error('所选技术形态无效');
  if(!peer||typeof peer!=='object'||Array.isArray(peer))throw Error('组内强弱参数无效');
  const {enabled=false,sectorTopPercent=null,...rules}=peer;
  if(typeof enabled!=='boolean'||sectorTopPercent!==null&&(!Number.isFinite(sectorTopPercent)||sectorTopPercent<=0||sectorTopPercent>100))throw Error('组内强弱开关或行业排名比例无效');
  if(Object.keys(rules).some(key=>!Object.hasOwn(engine.DEFAULT_RELATIVE_STRENGTH,key)))throw Error('组内强弱含未支持参数');
  const seen=new Set();
  for(const record of records){const code=record?.stock?.code;if(typeof code!=='string'||!code||seen.has(code)||!record.result||typeof record.result!=='object')throw Error('股票代码缺失、重复或筛选结果无效');seen.add(code);}
  if(!Array.isArray(sectorRecords))throw Error('行业参考池无效');
  const sectorCodes=new Set(sectorRecords.map(record=>record.stock.code));
  if(records.some(record=>!sectorCodes.has(record.stock.code)))throw Error('行业参考池未覆盖所选股票');
  const sectors=sectorStats(sectorRecords,day,lookback),bySector=new Map(sectors.map(sector=>[sector.sector,sector])),rankedSectors=sectors.filter(sector=>sector.status==='ready').length;
  const bases=records.map(record=>{
   const basis=baseSelection(record,{mode,qualification,patternId,day,lookback});
   if(!enabled||basis.selected!==true)return basis;
   if(record.result.eligible===false)return {selected:false,reason:'不符合当前股票筛选资格'};
   if(record.result.excluded===true)return {selected:false,reason:record.result.exclusionReasons?.[0]||record.result.reason||'超过所设过热限制'};
   if(sectorTopPercent!==null){
    const sector=bySector.get(sectorName(record));
    if(sector.status!=='ready')return {selected:null,reason:sector.reason+'，行业热度条件未知'};
    if(sector.stats.rank>Math.ceil(rankedSectors*sectorTopPercent/100))return {selected:false,reason:'盘后行业价格热度未进入前 '+sectorTopPercent+'%'};
   }
   return basis;
  });
  let ranked,groupSummary;
  if(enabled){
   const candidates=records.map((record,i)=>({...record,result:{...record.result,candidateMatched:bases[i].selected===true}}));
   const {records:output,...summary}=engine.rankStrength(candidates,{day,lookback,...rules});ranked=output;
   groupSummary={...summary,enabled,qualification,patternId,sectorTopPercent};
  }else groupSummary={enabled:false,status:'disabled',reason:'未启用组内强弱筛选',day,lookback,groupCount:0,qualification,patternId,sectorTopPercent,rules:null};
  const output=records.map((record,i)=>{
   let selection=bases[i];const relativeStrength=enabled?ranked[i].result.relativeStrength:null;
   if(enabled&&selection.selected===true)selection={selected:relativeStrength.matched,reason:relativeStrength.reason};
   return {...record,result:{...record.result,relativeStrength},selection};
  });
  return {records:output,selectedRecords:output.filter(record=>record.selection.selected===true),groupSummary,sectors};
 }
 return {select};
});
