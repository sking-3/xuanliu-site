'use strict';

(function(root){
  const RULES=Object.freeze({correlation:.65,directionAgreement:.6,consensusCorrelation:.5,consensusBreadth:.6,minimumMembers:30,coverage:.8});
  const DEFAULT_LIMITS=Object.freeze({enabled:true,maxReturn20:15,maxReturn60:30,maxReturn5:8,maxDeviation:8,maxVolumeRatio:2.5});
  const MODES=Object.freeze(['market','consensus','strength']);
  const compare=(a,b)=>a<b?-1:a>b?1:0;
  const exceeds=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
  const emptyMetrics=()=>({correlation:null,curveCorrelation:null,directionAgreement:null,periodReturn:null,referenceReturn:null,return5:null,volumeRatio:null,volumeAvg5:null,volumeAvgPrevious20:null,ma5:null,ma20:null,ma20Deviation:null,startClose:null,endClose:null,startAt:null,endAt:null,sampleCount:0,crossedUpRecently:null});
  function unavailable(reason){return {status:'unavailable',matched:null,excluded:false,exclusionReasons:[],reason,metrics:emptyMetrics(),reasons:[]};}
  function validDay(day){
    if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;
    const time=Date.parse(day+'T00:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===day;
  }
  function readBars(bars,day,label,calendarOnly=false){
    if(!Array.isArray(bars)||!bars.length||bars.length>640)throw Error(label+'日线缺失或超出范围');
    let previous='';
    for(const b of bars){
      if(!b||!validDay(b.date)||b.date<=previous||b.date>day)throw Error(label+'日期重复、逆序或晚于目标日');
      if(!calendarOnly&&(!Number.isFinite(b.close)||b.close<=0))throw Error(label+'收盘价缺失或无效');
      if(!calendarOnly&&(!Number.isFinite(b.volume)||b.volume<=0))throw Error(label+'成交量缺失、无效或无成交');
      previous=b.date;
    }
    if(previous!==day)throw Error(label+'缺少目标交易日日线');return bars;
  }
  const mean=values=>values.reduce((sum,n)=>sum+n,0)/values.length;
  const returns=prices=>prices.slice(1).map((p,i)=>p/prices[i]-1);
  function correlation(a,b){
    const am=mean(a),bm=mean(b);let covariance=0,av=0,bv=0;
    for(let i=0;i<a.length;i++){const x=a[i]-am,y=b[i]-bm;covariance+=x*y;av+=x*x;bv+=y*y;}
    if(av<=1e-24||bv<=1e-24)return null;
    const value=covariance/Math.sqrt(av*bv);return Number.isFinite(value)?Math.max(-1,Math.min(1,value)):null;
  }
  function align(bars,dates){
    const result=bars.filter(b=>b.date>=dates[0]);
    if(result.length!==dates.length||result.some((b,i)=>b.date!==dates[i]))throw Error('个股与交易日历在所选周期不齐，不能跨停牌缺口计算');return result;
  }
  function curve(daily){let value=1;return [1,...daily.map(r=>(value*=1+r))];}
  function relativeMetrics(daily,peer){
    const path=curve(daily),reference=curve(peer);
    return {correlation:correlation(daily,peer),curveCorrelation:correlation(path,reference),directionAgreement:daily.filter((r,i)=>Math.sign(r)===Math.sign(peer[i])).length/daily.length,referenceReturn:(reference.at(-1)-1)*100};
  }
  function selectMarketSample(rows,limit=120){
    if(!Array.isArray(rows)||limit!==Infinity&&(!Number.isInteger(limit)||limit<1))return [];
    const seen=new Set(),groups=new Map();
    for(const row of rows){
      if(!row||typeof row.code!=='string'||!/^\d{6}\.(?:SH|SZ|BJ)$/.test(row.code)||seen.has(row.code))continue;
      seen.add(row.code);const key=(row.exchange||row.code.slice(-2))+'/'+(row.sector||'未分类');
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
    }
    const total=seen.size,target=Math.min(total,limit),strata=[...groups].sort((a,b)=>compare(a[0],b[0])).map(([key,members])=>{
      members.sort((a,b)=>compare(a.code,b.code));const exact=target*members.length/total;
      return {key,members,quota:Math.floor(exact),remainder:exact-Math.floor(exact)};
    });
    let remaining=target-strata.reduce((sum,g)=>sum+g.quota,0);
    for(const g of [...strata].sort((a,b)=>b.remainder-a.remainder||compare(a.key,b.key)))if(remaining>0&&g.quota<g.members.length){g.quota++;remaining--;}
    const selected=[];
    for(const {members,quota}of strata)for(let i=0;i<quota;i++)selected.push(members[Math.floor((i+.5)*members.length/quota)]);
    return selected.sort((a,b)=>compare(a.code,b.code));
  }
  function buildConsensus(input={}){
    const {records,calendar,lookback,day}=input,expected=input.expectedCount??records?.length,totalUniverseCount=input.totalUniverseCount??expected;
    const base={status:'unavailable',identified:false,reason:'',day,lookback,requestedCount:expected,validCount:0,coverage:0,breadth:0,commonCount:0,totalUniverseCount,dates:[],supportDates:[],memberCodes:[],medianReturns:[],perCode:{}};
    try{
      if(![20,60].includes(lookback)||!validDay(day)||!Array.isArray(records)||!Number.isInteger(expected)||expected<30||!Number.isInteger(totalUniverseCount)||totalUniverseCount<expected)throw Error('至少需要30只独立市场样本，不能以单只股票或少量个股代表市场');
      const required=Math.max(lookback+1,26),anchor=readBars(calendar,day,'市场交易日历',true);
      if(anchor.length<required)throw Error('市场交易日历样本不足');
      base.supportDates=anchor.slice(-required).map(b=>b.date);base.dates=base.supportDates.slice(-lookback-1);
      const members=[],seen=new Set();
      for(const record of records){
        const code=record?.stock?.code;
        if(typeof code!=='string'||!/^\d{6}\.(?:SH|SZ|BJ)$/.test(code)||seen.has(code))throw Error('市场样本代码缺失或重复');
        seen.add(code);
        try{
          const aligned=align(readBars(record.bars,day,'市场样本'),base.supportDates),daily=returns(aligned.slice(-lookback-1).map(b=>b.close));
          if(daily.some(r=>!Number.isFinite(r)))continue;members.push({code,daily});
        }catch{}
      }
      base.validCount=members.length;base.coverage=members.length/expected;
      if(records.length>expected||members.length>expected)throw Error('有效样本不能超过预先确定的市场样本数量');
      if(members.length<Math.max(RULES.minimumMembers,Math.ceil(expected*RULES.coverage)))throw Error('市场样本覆盖不足：有效 '+members.length+'/'+expected+'，需至少30只且覆盖80%');
      base.memberCodes=members.map(m=>m.code);const count=members.length;
      // Sort each day's equal-stock returns once. Rank lookup then gives an
      // exact leave-one-out median in O(1), without quadratic repeated sorts.
      const sorted=Array.from({length:lookback},(_,d)=>members.map(m=>({code:m.code,value:m.daily[d]})).sort((a,b)=>a.value-b.value||compare(a.code,b.code)));
      const ranks=sorted.map(values=>new Map(values.map((v,i)=>[v.code,i])));
      const median=(values,removed=-1)=>{
        const n=values.length-(removed>=0?1:0),at=i=>values[removed>=0&&i>=removed?i+1:i].value;
        return n%2?at((n-1)/2):(at(n/2-1)+at(n/2))/2;
      };
      base.medianReturns=sorted.map(values=>median(values));
      if(curve(base.medianReturns).some(value=>!Number.isFinite(value)||value<=0))throw Error('市场合成曲线超出有效数值范围');
      for(const member of members){
        const peer=sorted.map((values,d)=>median(values,ranks[d].get(member.code))),m=relativeMetrics(member.daily,peer);
        base.perCode[member.code]=m;
        if(m.correlation!==null&&m.correlation>=RULES.consensusCorrelation&&m.directionAgreement>=RULES.directionAgreement)base.commonCount++;
      }
      base.breadth=base.commonCount/count;base.identified=base.breadth>=RULES.consensusBreadth;base.status='ready';
      base.reason=base.identified?'市场样本至少60%形成共同走势':'市场走势分化，尚未形成至少60%的主流共性';return base;
    }catch(error){base.reason=error.message||'市场共性无法核验';return base;}
  }
  function limitsOf(input){
    if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)))throw Error('排除条件无效');
    const result={...DEFAULT_LIMITS,...input};
    if(typeof result.enabled!=='boolean')throw Error('排除条件开关无效');
    for(const key of Object.keys(DEFAULT_LIMITS).filter(k=>k!=='enabled'))if(!Number.isFinite(result[key])||result[key]<=0)throw Error('排除条件须为有限正数');return result;
  }
  function applyLimits(result,input,lookback=20){
    const metrics=result.metrics?{...result.metrics}:result.metrics;
    if(result.status!=='ready')return {...result,metrics,reasons:[...(result.reasons||[])],exclusionReasons:[...(result.exclusionReasons||[])]};
    if(![20,60].includes(lookback))throw Error('排除条件周期无效');
    const limits=limitsOf(input),reasons=(result.reasons||[]).filter(reason=>!reason.startsWith('排除：'));
    const baseMatched=result.excluded?!reasons.some(reason=>reason.startsWith('未满足：')):result.matched;
    const exclusionReasons=[];
    if(limits.enabled){
      for(const [value,cap,label]of [[metrics.periodReturn,lookback===20?limits.maxReturn20:limits.maxReturn60,'所选周期涨幅'],[metrics.return5,limits.maxReturn5,'近5日涨幅'],[metrics.ma20Deviation,limits.maxDeviation,'相对MA20正乖离'],[metrics.volumeRatio,limits.maxVolumeRatio,'近5日/此前20日成交量比']])if(exceeds(value,cap))exclusionReasons.push(label+' '+value.toFixed(2)+(label.includes('成交量比')?'倍':'%')+' 超过上限 '+cap+(label.includes('成交量比')?'倍':'%'));
    }
    const excluded=exclusionReasons.length>0,matched=baseMatched&&!excluded;
    return {...result,matched,excluded,exclusionReasons,reason:excluded?exclusionReasons[0]:matched?'满足所选研究条件':reasons.find(reason=>reason.startsWith('未满足：')),metrics,reasons:reasons.concat(exclusionReasons.map(reason=>'排除：'+reason))};
  }
  function evaluate(input={}){
    const {mode,bars,referenceBars,lookback,day,code,consensus}=input;
    if(!MODES.includes(mode)||![20,60].includes(lookback)||!validDay(day))return unavailable('筛选模式、周期或目标交易日无效');
    try{
      const limits=limitsOf(input.limits),stock=readBars(bars,day,'个股'),required=Math.max(lookback+1,26);
      let supportDates;
      if(mode==='consensus'){
        if(typeof code!=='string'||!/^\d{6}\.(?:SH|SZ|BJ)$/.test(code))throw Error('证券代码无效，无法核对是否需排除自身');
        if(!consensus||consensus.status!=='ready'||consensus.day!==day||consensus.lookback!==lookback||consensus.validCount<RULES.minimumMembers||consensus.coverage<RULES.coverage||consensus.dates?.at(-1)!==day||consensus.dates.length!==lookback+1)throw Error(consensus?.reason||'市场共同走势尚未建立');
        supportDates=consensus.supportDates;
      }else{
        const anchor=readBars(referenceBars,day,mode==='strength'?'交易日历':'参考指数',mode==='strength');
        if(anchor.length<required)throw Error('参考交易日历不足 '+required+' 根');supportDates=anchor.slice(-required).map(b=>b.date);
      }
      if(stock.length<required||!Array.isArray(supportDates)||supportDates.length<required)throw Error('个股不足 '+required+' 根同日有效日线');
      const aligned=align(stock,supportDates),window=aligned.slice(-lookback-1),prices=aligned.map(b=>b.close),last=prices.at(-1),metrics=emptyMetrics();
      metrics.startAt=window[0].date;metrics.endAt=window.at(-1).date;metrics.sampleCount=window.length;metrics.startClose=window[0].close;metrics.endClose=last;
      metrics.periodReturn=(last/metrics.startClose-1)*100;metrics.return5=(last/prices.at(-6)-1)*100;
      metrics.ma5=mean(prices.slice(-5));metrics.ma20=mean(prices.slice(-20));metrics.ma20Deviation=(last/metrics.ma20-1)*100;
      metrics.volumeAvg5=mean(aligned.slice(-5).map(b=>b.volume));metrics.volumeAvgPrevious20=mean(aligned.slice(-25,-5).map(b=>b.volume));metrics.volumeRatio=metrics.volumeAvg5/metrics.volumeAvgPrevious20;
      let checks=[];
      if(mode==='market'||mode==='consensus'){
        const daily=returns(window.map(b=>b.close));let relative;
        if(mode==='market'){
          const reference=referenceBars.slice(-lookback-1).map(b=>b.close);relative=relativeMetrics(daily,returns(reference));
        }else relative=consensus.perCode?.[code]||relativeMetrics(daily,consensus.medianReturns);
        Object.assign(metrics,relative);
        if(metrics.correlation===null||metrics.curveCorrelation===null)throw Error('所选周期波动不足，无法计算走势相关性');
        checks=mode==='consensus'?[[consensus.identified,'市场样本至少60%有共同走势'],[metrics.correlation>=RULES.consensusCorrelation,'与其余市场样本日收益相关性 ≥ 0.50'],[metrics.directionAgreement>=RULES.directionAgreement,'同向交易日占比 ≥ 60%']]:[[metrics.correlation>=RULES.correlation,'日收益相关性 ≥ 0.65'],[metrics.directionAgreement>=RULES.directionAgreement,'同向交易日占比 ≥ 60%']];
      }else{
        metrics.crossedUpRecently=false;
        for(let t=prices.length-5;t<prices.length;t++){
          const ma5=mean(prices.slice(t-4,t+1)),ma20=mean(prices.slice(t-19,t+1)),old5=mean(prices.slice(t-5,t)),old20=mean(prices.slice(t-20,t));
          if(exceeds(ma5,ma20)&&!exceeds(old5,old20))metrics.crossedUpRecently=true;
        }
        checks=[[metrics.return5>0,'最近5个交易日上涨'],[exceeds(last,metrics.ma20),'收盘价 > MA20'],[exceeds(metrics.ma5,metrics.ma20),'MA5 > MA20'],[metrics.crossedUpRecently,'MA5在近5个交易日内上穿MA20']];
      }
      if(Object.values(metrics).some(v=>typeof v==='number'&&!Number.isFinite(v)))throw Error('计算结果超出有效数值范围');
      const reasons=checks.map(([pass,label])=>(pass?'满足：':'未满足：')+label);
      return applyLimits({status:'ready',matched:checks.every(([pass])=>pass),excluded:false,exclusionReasons:[],metrics,reasons},limits,lookback);
    }catch(error){return unavailable(error.message||'日线数据无法核验');}
  }
  const api={RULES,DEFAULT_LIMITS,MODES,evaluate,applyLimits,selectMarketSample,buildConsensus};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksTrendScreen=api;
})(typeof globalThis==='object'?globalThis:this);
