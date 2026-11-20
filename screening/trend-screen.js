'use strict';

(function(root){
  const RULES=Object.freeze({correlation:.65,curveCorrelation:.8,directionAgreement:.6,volumeRatio:1.2});
  const MODES=Object.freeze(['market','similar','strength']);
  const emptyMetrics=()=>({correlation:null,curveCorrelation:null,directionAgreement:null,periodReturn:null,referenceReturn:null,volumeRatio:null,ma5:null,ma20:null,startAt:null,endAt:null,sampleCount:0});
  function unavailable(reason){return {status:'unavailable',matched:null,reason,metrics:emptyMetrics(),reasons:[]};}
  function validDay(day){
    if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;
    const time=Date.parse(day+'T00:00:00Z');
    return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===day;
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
    if(previous!==day)throw Error(label+'缺少目标交易日日线');
    return bars;
  }
  const mean=values=>values.reduce((sum,n)=>sum+n,0)/values.length;
  const returns=prices=>prices.slice(1).map((p,i)=>p/prices[i]-1);
  function correlation(a,b){
    const am=mean(a),bm=mean(b);let covariance=0,av=0,bv=0;
    for(let i=0;i<a.length;i++){const x=a[i]-am,y=b[i]-bm;covariance+=x*y;av+=x*x;bv+=y*y;}
    if(av<=1e-24||bv<=1e-24)return null;
    const value=covariance/Math.sqrt(av*bv);
    return Number.isFinite(value)?Math.max(-1,Math.min(1,value)):null;
  }
  function evaluate(input={}){
    const {mode,bars,referenceBars,lookback,day,code,referenceCode}=input;
    if(!MODES.includes(mode)||![20,60].includes(lookback)||!validDay(day))return unavailable('筛选模式、周期或目标交易日无效');
    try{
      const stock=readBars(bars,day,'个股');
      if(mode==='similar'&&typeof code==='string'&&typeof referenceCode==='string'&&code.trim().toUpperCase()===referenceCode.trim().toUpperCase())return unavailable('参考股票自身不参与相似排名');
      const required=mode==='strength'?Math.max(lookback+1,26):lookback+1;
      if(stock.length<required)return unavailable('个股不足 '+required+' 根有效日线');
      // The benchmark calendar also anchors strength scans: a suspended stock
      // must not turn 20 effective bars spanning extra sessions into a 20-day return.
      const reference=readBars(referenceBars,day,mode==='strength'?'交易日历':'参考标的',mode==='strength');
      if(reference.length<required)return unavailable('参考标的不足 '+required+' 根有效日线');
      const anchor=reference.slice(-required),aligned=stock.filter(b=>b.date>=anchor[0].date);
      if(aligned.length!==anchor.length||aligned.some((b,i)=>b.date!==anchor[i].date))return unavailable('个股与参考标的在所选周期交易日不齐，不能跨缺口计算');
      const metrics=emptyMetrics();
      const window=aligned.slice(-lookback-1);let checks=[];
      if(mode==='market'||mode==='similar'){
        const prices=window.map(b=>b.close),referencePrices=anchor.map(b=>b.close),daily=returns(prices),referenceDaily=returns(referencePrices);
        metrics.correlation=correlation(daily,referenceDaily);
        metrics.curveCorrelation=correlation(prices.map(p=>p/prices[0]),referencePrices.map(p=>p/referencePrices[0]));
        if(metrics.correlation===null||metrics.curveCorrelation===null)return unavailable('所选周期波动不足，无法计算走势相关性');
        metrics.directionAgreement=daily.filter((r,i)=>Math.sign(r)===Math.sign(referenceDaily[i])).length/lookback;
        metrics.referenceReturn=(referencePrices.at(-1)/referencePrices[0]-1)*100;
        checks.push([metrics.correlation>=RULES.correlation,'日收益相关性 ≥ 0.65'],[metrics.directionAgreement>=RULES.directionAgreement,'同向交易日占比 ≥ 60%']);
        if(mode==='similar')checks.push([metrics.curveCorrelation>=RULES.curveCorrelation,'归一化价格曲线相关性 ≥ 0.80']);
      }else{
        const prices=aligned.map(b=>b.close),last=prices.at(-1);
        metrics.ma5=mean(prices.slice(-5));metrics.ma20=mean(prices.slice(-20));
        const previousMA20=mean(prices.slice(-25,-5)),previousVolume=mean(aligned.slice(-25,-5).map(b=>b.volume));
        metrics.volumeRatio=mean(aligned.slice(-5).map(b=>b.volume))/previousVolume;
        checks=[
          [last/prices.at(-lookback-1)-1>0,'所选周期涨幅 > 0%'],
          [last/prices.at(-6)-1>0,'最近 5 个交易日涨幅 > 0%'],
          [last>metrics.ma20,'收盘价 > MA20'],
          [metrics.ma5>metrics.ma20,'MA5 > MA20'],
          [metrics.ma20>previousMA20,'MA20 高于 5 个交易日前'],
          [metrics.volumeRatio>=RULES.volumeRatio,'近 5 日均量 / 此前 20 日均量 ≥ 1.20']
        ];
      }
      metrics.startAt=window[0].date;metrics.endAt=window.at(-1).date;metrics.sampleCount=window.length;
      metrics.periodReturn=(window.at(-1).close/window[0].close-1)*100;
      if(Object.values(metrics).some(value=>typeof value==='number'&&!Number.isFinite(value)))return unavailable('计算结果超出有效数值范围');
      const matched=checks.every(([pass])=>pass),reasons=checks.map(([pass,label])=>(pass?'满足：':'未满足：')+label);
      return {status:'ready',matched,reason:matched?'满足所选研究条件':reasons.find(r=>r.startsWith('未满足：')),metrics,reasons};
    }catch(error){return unavailable(error.message||'日线数据无法核验');}
  }
  const api={RULES,MODES,evaluate};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksTrendScreen=api;
})(typeof globalThis==='object'?globalThis:this);
