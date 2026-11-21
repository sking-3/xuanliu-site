'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksTrendPatterns=api;
})(globalThis,()=>{
  const version='books.trend-patterns.2026-11-22.v1';
  const profile=Object.freeze({id:'daily-close-volume-v1',fastPeriod:5,midPeriod:10,slowPeriod:20,slopeDays:5,maPeriods:Object.freeze([5,10,20]),consolidationDays:5,nearPct:2,rangePct:4,crossWindow:3,pullbackMinPct:2,pullbackMaxPct:8,volumeRecentDays:5,volumePreviousDays:20,volumeExpandRatio:1.2,volumeContractRatio:.8});
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
  const above=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
  const mean=values=>values.reduce((average,value,index)=>average+(value-average)/(index+1),0);
  const pct=value=>(value>0?'+':'')+value.toFixed(2)+'%';
  const validDay=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
  function classify({bars,calendar,day,lookback,parameters={}}={}){
    const p={...profile,...parameters},defs=catalogue(p),output={version,day,lookback,status:'unavailable',labels:[],unavailable:[]};
    function reject(reason){output.reason=reason;output.unavailable=defs.map(def=>({id:def.id,reason}));return output;}
    for(const key of ['fastPeriod','midPeriod','slowPeriod','slopeDays','consolidationDays','crossWindow','volumeRecentDays','volumePreviousDays'])if(!Number.isInteger(p[key])||p[key]<1)throw TypeError('形态窗口须为正整数');
    if(!Array.isArray(p.maPeriods)||!p.maPeriods.length||p.maPeriods.some(n=>!Number.isInteger(n)||n<1)||new Set(p.maPeriods).size!==p.maPeriods.length)throw TypeError('形态均线窗口无效');
    for(const key of ['nearPct','rangePct','pullbackMinPct','pullbackMaxPct','volumeExpandRatio','volumeContractRatio'])if(!Number.isFinite(p[key])||p[key]<0)throw TypeError('形态阈值须为非负有限数值');
    if(!(p.fastPeriod<p.midPeriod&&p.midPeriod<p.slowPeriod)||p.pullbackMinPct>p.pullbackMaxPct||p.volumeContractRatio>=p.volumeExpandRatio)throw TypeError('形态参数次序无效');
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
    const prices=bars.map(bar=>bar.close),volumes=bars.map(bar=>bar.volume),n=prices.length,last=prices.at(-1),byId=new Map(defs.map(def=>[def.id,def]));
    const ma=(period,end=n-1)=>mean(prices.slice(end-period+1,end+1));
    let evaluated=0;
    function check(id,minimum,evaluate){
      if(n<minimum){output.unavailable.push({id,reason:'需要至少'+minimum+'根同日有效日线'});return;}
      evaluated++;const evidence=evaluate();
      if(evidence&&typeof evidence==='object'){output.unavailable.push({id,reason:evidence.reason});return;}
      if(evidence){const {label,group}=byId.get(id);output.labels.push({id,label,group,evidence});}
    }
    for(const direction of ['up','down'])check('trend-'+direction,p.slowPeriod+p.slopeDays,()=>{
      const fast=ma(p.fastPeriod),middle=ma(p.midPeriod),slow=ma(p.slowPeriod),old=ma(p.slowPeriod,n-1-p.slopeDays),slope=(slow/old-1)*100;
      if(!Number.isFinite(slope))return {reason:'均线变化超出有限数值范围'};
      const matched=direction==='up'?above(fast,middle)&&above(middle,slow)&&above(slow,old):above(middle,fast)&&above(slow,middle)&&above(old,slow);
      return matched?`MA${p.fastPeriod}${direction==='up'?'＞':'＜'}MA${p.midPeriod}${direction==='up'?'＞':'＜'}MA${p.slowPeriod}；慢线近${p.slopeDays}日${pct(slope)}`:null;
    });
    check('close-pullback',lookback+1,()=>{const peak=Math.max(...prices.slice(-lookback-1)),drawdown=(1-last/peak)*100;return !above(p.pullbackMinPct,drawdown)&&!above(drawdown,p.pullbackMaxPct)?`所选${lookback}日区间最高收盘至当前回撤${drawdown.toFixed(2)}%`:null;});
    for(const period of p.maPeriods){
      check('near-ma-'+period,period+p.consolidationDays-1,()=>{
        const recent=prices.slice(-p.consolidationDays),range=(Math.max(...recent)/Math.min(...recent)-1)*100;
        const near=recent.every((price,i)=>!above(Math.abs(price/ma(period,n-p.consolidationDays+i)-1)*100,p.nearPct));
        return near&&!above(range,p.rangePct)?`近${p.consolidationDays}日收盘均在MA${period}±${p.nearPct}%内；收盘区间${range.toFixed(2)}%`:null;
      });
      for(const direction of ['regain','lose'])check(direction+'-ma-'+period,period+p.crossWindow,()=>{
        if(direction==='regain'?!above(last,ma(period)):!above(ma(period),last))return null;
        let occurred=null;
        for(let i=n-p.crossWindow;i<n;i++){
          const current=ma(period,i),previous=ma(period,i-1);
          if(direction==='regain'?above(prices[i],current)&&!above(prices[i-1],previous):above(current,prices[i])&&!above(previous,prices[i-1]))occurred=bars[i].date;
        }
        return occurred?`${occurred}收盘${direction==='regain'?'重回':'跌破'}MA${period}；当前偏离${pct((last/ma(period)-1)*100)}`:null;
      });
    }
    for(const direction of ['breakout','breakdown'])check('close-'+direction,lookback+1,()=>{
      const previous=prices.slice(-lookback-1,-1),threshold=direction==='breakout'?Math.max(...previous):Math.min(...previous);
      const matched=direction==='breakout'?above(last,threshold):above(threshold,last);
      const distance=Math.abs(last/threshold-1)*100;if(!Number.isFinite(distance))return {reason:'收盘区间偏离超出有限数值范围'};
      return matched?`收盘${direction==='breakout'?'高于':'低于'}此前${lookback}日${direction==='breakout'?'最高':'最低'}收盘${distance.toFixed(2)}%`:null;
    });
    for(const direction of ['expand','contract'])check('volume-'+direction,Math.max(p.volumeRecentDays+p.volumePreviousDays,6),()=>{
      const recent=mean(volumes.slice(-p.volumeRecentDays)),previous=mean(volumes.slice(-p.volumeRecentDays-p.volumePreviousDays,-p.volumeRecentDays)),ratio=recent/previous;
      if(!Number.isFinite(ratio))return {reason:'阶段均量比超出有限数值范围'};
      const matched=direction==='expand'?!above(p.volumeExpandRatio,ratio):!above(ratio,p.volumeContractRatio);
      return matched?`近${p.volumeRecentDays}日均量/此前${p.volumePreviousDays}日均量${ratio.toFixed(2)}倍；近5日收盘${pct((last/prices.at(-6)-1)*100)}`:null;
    });
    output.status=evaluated?'ready':'unavailable';return output;
  }
  return {version,profile,definitions,classify};
});
