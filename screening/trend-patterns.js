'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksTrendPatterns=api;
})(globalThis,()=>{
  const version='books.trend-patterns.2026-11-22.v2';
  const profile=Object.freeze({id:'daily-close-volume-v1',fastPeriod:5,midPeriod:10,slowPeriod:20,slopeDays:5,maPeriods:Object.freeze([5,10,20]),consolidationDays:5,nearPct:2,rangePct:4,crossWindow:3,pullbackMinPct:2,pullbackMaxPct:8,volumeRecentDays:5,volumePreviousDays:20,volumeExpandRatio:1.2,volumeContractRatio:.8});
  const fixedKeys=['fastPeriod','midPeriod','slowPeriod','slopeDays','consolidationDays','volumeRecentDays','volumePreviousDays'];
  const thresholdKeys=['nearPct','rangePct','crossWindow','pullbackMinPct','pullbackMaxPct','volumeExpandRatio','volumeContractRatio'];
  function parametersOf(parameters={}){
    const p={...profile,...parameters};
    for(const key of [...fixedKeys,'crossWindow'])if(!Number.isInteger(p[key])||p[key]<1)throw TypeError('形态窗口须为正整数');
    if(!Array.isArray(p.maPeriods)||!p.maPeriods.length||p.maPeriods.some(n=>!Number.isInteger(n)||n<1)||new Set(p.maPeriods).size!==p.maPeriods.length)throw TypeError('形态均线窗口无效');
    for(const key of thresholdKeys.filter(key=>key!=='crossWindow'))if(!Number.isFinite(p[key])||p[key]<0)throw TypeError('形态阈值须为非负有限数值');
    if(!(p.fastPeriod<p.midPeriod&&p.midPeriod<p.slowPeriod)||p.pullbackMinPct>p.pullbackMaxPct||p.volumeContractRatio>=p.volumeExpandRatio)throw TypeError('形态参数次序无效');
    const normalized={};
    for(const key of Object.keys(profile))normalized[key]=key==='maPeriods'?p[key].slice():key==='id'?profile.id:p[key];
    return normalized;
  }
  function catalogue(p){
    const result=[
      {id:'trend-up',label:'均线多头排列',group:'趋势',rule:`MA${p.fastPeriod}>MA${p.midPeriod}>MA${p.slowPeriod}，且MA${p.slowPeriod}较${p.slopeDays}个交易日前上行`},
      {id:'trend-down',label:'均线空头排列',group:'趋势',rule:`MA${p.fastPeriod}<MA${p.midPeriod}<MA${p.slowPeriod}，且MA${p.slowPeriod}较${p.slopeDays}个交易日前下行`},
      {id:'close-pullback',label:'收盘高点回撤',group:'回调',rule:`所选20/60日区间（含起点）最高收盘至当前收盘回撤${p.pullbackMinPct}%至${p.pullbackMaxPct}%；不表示盘中回踩或买入信号`}
    ];
    for(const period of p.maPeriods)result.push(
      {id:'near-ma-'+period,label:'MA'+period+'附近整理',group:'整理',rule:`最近${p.consolidationDays}个收盘均在各自当日MA${period}的±${p.nearPct}%内，且这${p.consolidationDays}个收盘最高/最低-1不超过${p.rangePct}%`},
      {id:'regain-ma-'+period,label:'收盘重回MA'+period,group:'均线事件',rule:`近${p.crossWindow}个交易日内，收盘由不高于当日MA${period}转为高于，且当前仍在其上方`},
      {id:'lose-ma-'+period,label:'收盘跌破MA'+period,group:'均线事件',rule:`近${p.crossWindow}个交易日内，收盘由不低于当日MA${period}转为低于，且当前仍在其下方`}
    );
    result.push(
      {id:'close-breakout',label:'收盘突破区间',group:'突破',rule:'当前收盘严格高于此前所选20/60个交易日最高收盘；不使用盘中最高价'},
      {id:'close-breakdown',label:'收盘跌破区间',group:'突破',rule:'当前收盘严格低于此前所选20/60个交易日最低收盘；不使用盘中最低价'},
      {id:'volume-expand',label:'阶段放量',group:'量价',rule:`最近${p.volumeRecentDays}日均量/此前${p.volumePreviousDays}日均量≥${p.volumeExpandRatio}；不是盘中量比`},
      {id:'volume-contract',label:'阶段缩量',group:'量价',rule:`最近${p.volumeRecentDays}日均量/此前${p.volumePreviousDays}日均量≤${p.volumeContractRatio}；不是盘中量比`}
    );
    return result;
  }
  const definitions=Object.freeze(catalogue(profile).map(Object.freeze));
  const definitionsFor=parameters=>catalogue(parametersOf(parameters));
  const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
  const mean=values=>values.reduce((average,value,index)=>average+(value-average)/(index+1),0);
  const pct=value=>(value>0?'+':'')+value.toFixed(2)+'%';
  const validDay=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
  function deriveFacts({bars,calendar,day,lookback,parameters={}}={}){
    const p=parametersOf(parameters),facts={version,day,lookback,profile:p,status:'unavailable',sampleCount:0};
    function reject(reason){facts.reason=reason;return facts;}
    if(!validDay(day)||![20,60].includes(lookback))return reject('目标日期或所选周期无效');
    if(!Array.isArray(bars)||!bars.length||!Array.isArray(calendar)||!calendar.length)return reject('收盘日线或交易日历缺失');
    for(const [rows,label]of [[bars,'收盘日线'],[calendar,'交易日历']]){
      let previous='';
      for(const bar of rows){if(!bar||!validDay(bar.date)||bar.date<=previous||bar.date>day)return reject(label+'日期重复、逆序或晚于目标日');previous=bar.date;}
      if(previous!==day)return reject(label+'缺少目标交易日');
    }
    if(bars.some(bar=>!Number.isFinite(bar.close)||bar.close<=0||!Number.isFinite(bar.volume)||bar.volume<=0))return reject('收盘价或成交量无效');
    const dates=calendar.filter(bar=>bar.date>=bars[0].date);
    if(dates.length!==bars.length||bars.some((bar,i)=>bar.date!==dates[i].date))return reject('日线与交易日历不齐，不能跨缺口判断形态');
    const prices=bars.map(bar=>bar.close),volumes=bars.map(bar=>bar.volume),n=prices.length,last=prices.at(-1);
    const ma=(period,end=n-1)=>mean(prices.slice(end-period+1,end+1));
    facts.sampleCount=n;facts.status='ready';facts.trend=null;facts.pullback=null;facts.near={};facts.crossings={};facts.boundary=null;facts.volume=null;
    if(n>=p.slowPeriod+p.slopeDays){
      const fast=ma(p.fastPeriod),middle=ma(p.midPeriod),slow=ma(p.slowPeriod),old=ma(p.slowPeriod,n-1-p.slopeDays);
      facts.trend={up:above(fast,middle)&&above(middle,slow)&&above(slow,old),down:above(middle,fast)&&above(slow,middle)&&above(old,slow),slopePct:(slow/old-1)*100};
      if(!Number.isFinite(facts.trend.slopePct))facts.trend={reason:'均线变化超出有限数值范围'};
    }
    if(n>=lookback+1){
      const previous=prices.slice(-lookback-1,-1),peak=Math.max(...prices.slice(-lookback-1)),high=Math.max(...previous),low=Math.min(...previous);
      facts.pullback={drawdownPct:(1-last/peak)*100};
      facts.boundary={breakout:above(last,high),breakdown:above(low,last),upDistancePct:Math.abs(last/high-1)*100,downDistancePct:Math.abs(last/low-1)*100};
      if(!Number.isFinite(facts.boundary.upDistancePct))facts.boundary.upReason='收盘区间偏离超出有限数值范围';
      if(!Number.isFinite(facts.boundary.downDistancePct))facts.boundary.downReason='收盘区间偏离超出有限数值范围';
      if(facts.boundary.upReason)facts.boundary.upDistancePct=null;
      if(facts.boundary.downReason)facts.boundary.downDistancePct=null;
    }
    for(const period of p.maPeriods){
      if(n>=period+p.consolidationDays-1){
        const recent=prices.slice(-p.consolidationDays),rangePct=(Math.max(...recent)/Math.min(...recent)-1)*100;
        const maxDeviationPct=Math.max(...recent.map((price,i)=>Math.abs(price/ma(period,n-p.consolidationDays+i)-1)*100));
        facts.near[period]=Number.isFinite(rangePct)&&Number.isFinite(maxDeviationPct)?{rangePct,maxDeviationPct}:{reason:'整理区间变化超出有限数值范围'};
      }
      if(n>=period){
        const current=ma(period),cross={maxWindow:n-period,side:above(last,current)?1:above(current,last)?-1:0,deviationPct:(last/current-1)*100,regain:null,lose:null};
        for(let i=period;i<n;i++){
          const current=ma(period,i),previous=ma(period,i-1),point={age:n-1-i,date:bars[i].date};
          if(above(prices[i],current)&&!above(prices[i-1],previous))cross.regain=point;
          if(above(current,prices[i])&&!above(previous,prices[i-1]))cross.lose=point;
        }
        facts.crossings[period]=cross;
      }
    }
    if(n>=Math.max(p.volumeRecentDays+p.volumePreviousDays,6)){
      const recent=mean(volumes.slice(-p.volumeRecentDays)),previous=mean(volumes.slice(-p.volumeRecentDays-p.volumePreviousDays,-p.volumeRecentDays)),ratio=recent/previous;
      facts.volume=Number.isFinite(ratio)?{ratio,return5Pct:(last/prices.at(-6)-1)*100}:{reason:'阶段均量比超出有限数值范围'};
      if(facts.volume.return5Pct!==undefined&&!Number.isFinite(facts.volume.return5Pct))facts.volume={reason:'阶段收盘变化超出有限数值范围'};
    }
    return facts;
  }
  function classifyFacts({facts,parameters={},day,lookback}={}){
    let base=profile,profileBound=false;
    if(facts?.profile&&fixedKeys.every(key=>Object.hasOwn(facts.profile,key))&&Array.isArray(facts.profile.maPeriods)){try{base=parametersOf(facts.profile);profileBound=true;}catch{}}
    const p=parametersOf({...base,...parameters}),defs=catalogue(p),output={version,day:day??facts?.day,lookback:lookback??facts?.lookback,status:'unavailable',labels:[],unavailable:[],facts};
    function reject(reason){output.reason=reason;output.unavailable=defs.map(def=>({id:def.id,reason}));return output;}
    for(const key of [...fixedKeys,'maPeriods'])if(JSON.stringify(p[key])!==JSON.stringify(base[key]))throw TypeError('改变固定窗口须从原始日线重新提取形态事实');
    if(parameters.crossWindow!==undefined&&parameters.crossWindow!==base.crossWindow&&parameters.crossWindow>20)throw TypeError('交叉窗口仅支持1至20个交易日');
    if(!profileBound||facts?.version!==version||facts.status!=='ready'||!validDay(output.day)||![20,60].includes(output.lookback)||facts.day!==output.day||facts.lookback!==output.lookback||!Number.isInteger(facts.sampleCount)||facts.sampleCount<1)return reject(facts?.reason||'形态事实版本、日期、周期或样本不符');
    const n=facts.sampleCount,byId=new Map(defs.map(def=>[def.id,def]));let evaluated=0;
    function check(id,minimum,evaluate){
      if(n<minimum){output.unavailable.push({id,reason:'需要至少'+minimum+'根同日有效日线'});return;}
      evaluated++;const evidence=evaluate();
      if(evidence&&typeof evidence==='object'){output.unavailable.push({id,reason:evidence.reason});return;}
      if(evidence){const {label,group}=byId.get(id);output.labels.push({id,label,group,evidence});}
    }
    const unavailable=(value,label)=>value?.reason?value:{reason:label+'事实缺失或非有限数值'};
    for(const direction of ['up','down'])check('trend-'+direction,p.slowPeriod+p.slopeDays,()=>{
      const f=facts.trend;if(!f||!Number.isFinite(f.slopePct)||typeof f[direction]!=='boolean')return unavailable(f,'均线趋势');
      return f[direction]?`MA${p.fastPeriod}${direction==='up'?'＞':'＜'}MA${p.midPeriod}${direction==='up'?'＞':'＜'}MA${p.slowPeriod}；慢线近${p.slopeDays}日${pct(f.slopePct)}`:null;
    });
    check('close-pullback',output.lookback+1,()=>{const f=facts.pullback;if(!Number.isFinite(f?.drawdownPct))return unavailable(f,'收盘回撤');return !above(p.pullbackMinPct,f.drawdownPct)&&!above(f.drawdownPct,p.pullbackMaxPct)?`所选${output.lookback}日区间最高收盘至当前回撤${f.drawdownPct.toFixed(2)}%`:null;});
    for(const period of p.maPeriods){
      check('near-ma-'+period,period+p.consolidationDays-1,()=>{
        const f=facts.near?.[period];if(!Number.isFinite(f?.rangePct)||!Number.isFinite(f?.maxDeviationPct))return unavailable(f,'均线整理');
        return !above(f.maxDeviationPct,p.nearPct)&&!above(f.rangePct,p.rangePct)?`近${p.consolidationDays}日收盘均在MA${period}±${p.nearPct}%内；收盘区间${f.rangePct.toFixed(2)}%`:null;
      });
      for(const direction of ['regain','lose'])check(direction+'-ma-'+period,period+p.crossWindow,()=>{
        const f=facts.crossings?.[period];if(!f||![-1,0,1].includes(f.side)||!Number.isFinite(f.deviationPct)||!Number.isInteger(f.maxWindow)||f.maxWindow!==n-period)return unavailable(f,'均线交叉');
        if(f.side!==(direction==='regain'?1:-1))return null;
        const point=f[direction];if(point===null)return null;
        if(!point||!Number.isInteger(point.age)||point.age<0||point.age>=f.maxWindow||!validDay(point.date)||point.date>output.day)return unavailable(f,'交叉时间');
        return point.age<p.crossWindow?`${point.date}收盘${direction==='regain'?'重回':'跌破'}MA${period}；当前偏离${pct(f.deviationPct)}`:null;
      });
    }
    for(const direction of ['breakout','breakdown'])check('close-'+direction,output.lookback+1,()=>{
      const f=facts.boundary,up=direction==='breakout',distance=up?f?.upDistancePct:f?.downDistancePct;
      if(!f||typeof f[direction]!=='boolean'||!Number.isFinite(distance))return {reason:(up?f?.upReason:f?.downReason)||'收盘区间事实缺失或非有限数值'};
      return f[direction]?`收盘${up?'高于':'低于'}此前${output.lookback}日${up?'最高':'最低'}收盘${distance.toFixed(2)}%`:null;
    });
    for(const direction of ['expand','contract'])check('volume-'+direction,Math.max(p.volumeRecentDays+p.volumePreviousDays,6),()=>{
      const f=facts.volume;if(!Number.isFinite(f?.ratio)||!Number.isFinite(f?.return5Pct))return unavailable(f,'阶段均量');
      const matched=direction==='expand'?!above(p.volumeExpandRatio,f.ratio):!above(f.ratio,p.volumeContractRatio);
      return matched?`近${p.volumeRecentDays}日均量/此前${p.volumePreviousDays}日均量${f.ratio.toFixed(2)}倍；近5日收盘${pct(f.return5Pct)}`:null;
    });
    output.status=evaluated?'ready':'unavailable';return output;
  }
  function classify(input={}){return classifyFacts({facts:deriveFacts(input),parameters:input.parameters});}
  return {version,profile,definitions,definitionsFor,classify,deriveFacts,classifyFacts};
});
