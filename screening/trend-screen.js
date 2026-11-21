'use strict';

(function(root){
  const RULES=Object.freeze({correlation:.65,directionAgreement:.6,consensusCorrelation:.5,consensusBreadth:.6,minimumMembers:30,coverage:.8});
  const DEFAULT_LIMITS=Object.freeze({enabled:true,maxReturn20:15,maxReturn60:30,maxReturn5:8,maxDeviation:8,maxVolumeRatio:2.5});
  const DEFAULT_DIRECTION_RULES=Object.freeze({minimumReturnPercent:3,maximumSidewaysRangePercent:8});
  const DEFAULT_STRENGTH=Object.freeze({crossWithinDays:5,minReturn5:0});
  const MODES=Object.freeze(['market','consensus','strength']);
  const compare=(a,b)=>a<b?-1:a>b?1:0;
  const exceeds=(a,b)=>a-b>Number.EPSILON*64*Math.max(1,Math.abs(a),Math.abs(b));
  const emptyMetrics=()=>({correlation:null,curveCorrelation:null,directionAgreement:null,periodReturn:null,periodRangePercent:null,referenceReturn:null,return5:null,volumeRatio:null,volumeAvg5:null,volumeAvgPrevious20:null,ma5:null,ma20:null,ma20Deviation:null,startClose:null,endClose:null,startAt:null,endAt:null,sampleCount:0,crossedUpRecently:null,crossAgeDays:null,crossSearchDays:0});
  function unavailable(reason){return {status:'unavailable',matched:null,candidateMatched:null,marketQualified:null,eligible:true,eligibilityCodes:[],excluded:false,exclusionReasons:[],reason,metrics:emptyMetrics(),reasons:[]};}
  function breadthThreshold(value=RULES.consensusBreadth){
    if(!Number.isFinite(value)||value<0||value>1)throw Error('整体共性门槛须为0至1的有限数值');return value;
  }
  const percent=value=>(value*100).toFixed(2).replace(/\.00$/,'')+'%';
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
    const base={status:'unavailable',identified:false,reason:'',minimumBreadth:input.minimumBreadth===undefined?RULES.consensusBreadth:input.minimumBreadth,day,lookback,requestedCount:expected,validCount:0,coverage:0,breadth:0,commonCount:0,totalUniverseCount,dates:[],supportDates:[],memberCodes:[],medianReturns:[],perCode:{}};
    try{
      base.minimumBreadth=breadthThreshold(base.minimumBreadth);
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
      base.breadth=base.commonCount/count;base.identified=!exceeds(base.minimumBreadth,base.breadth);base.status='ready';
      base.reason=base.identified?'市场样本至少'+percent(base.minimumBreadth)+'形成共同走势':'市场走势分化，尚未形成至少'+percent(base.minimumBreadth)+'的主流共性';return base;
    }catch(error){base.reason=error.message||'市场共性无法核验';return base;}
  }
  function limitsOf(input){
    if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)))throw Error('排除条件无效');
    const result={...DEFAULT_LIMITS,...input};
    if(typeof result.enabled!=='boolean')throw Error('排除条件开关无效');
    for(const key of Object.keys(DEFAULT_LIMITS).filter(k=>k!=='enabled'))if(!Number.isFinite(result[key])||result[key]<=0)throw Error('排除条件须为有限正数');return result;
  }
  function directionRulesOf(input){
    const rules={...DEFAULT_DIRECTION_RULES,...input};
    if(!Number.isFinite(rules.minimumReturnPercent)||rules.minimumReturnPercent<0||rules.minimumReturnPercent>100||!Number.isFinite(rules.maximumSidewaysRangePercent)||rules.maximumSidewaysRangePercent<0||rules.maximumSidewaysRangePercent>1000)throw Error('方向条件超出范围');return rules;
  }
  function strengthOf(input){
    const rules={...DEFAULT_STRENGTH,...input};
    if(!Number.isInteger(rules.crossWithinDays)||rules.crossWithinDays<1||rules.crossWithinDays>20||!Number.isFinite(rules.minReturn5)||rules.minReturn5< -100||rules.minReturn5>100)throw Error('初期转强条件超出范围');return rules;
  }
  function classifyDirection(metrics,directionRules){
    const rules=directionRulesOf(directionRules),value=metrics?.periodReturn;
    if(!Number.isFinite(value))return null;
    if(exceeds(value,rules.minimumReturnPercent))return 'up';
    if(exceeds(-value,rules.minimumReturnPercent))return 'down';
    if(!Number.isFinite(metrics.periodRangePercent)||metrics.periodRangePercent<0)return null;
    return exceeds(metrics.periodRangePercent,rules.maximumSidewaysRangePercent)?'unclassified':'sideways';
  }
  function crossMetrics(stock,calendar){
    let i=stock.length-1,j=calendar.length-1;const prices=[];
    while(i>=0&&j>=0&&stock[i].date===calendar[j].date){prices.unshift(stock[i].close);i--;j--;}
    const crossSearchDays=Math.max(0,Math.min(20,prices.length-20));let crossAgeDays=null;
    for(let age=0;age<crossSearchDays;age++){
      const t=prices.length-1-age,ma5=mean(prices.slice(t-4,t+1)),ma20=mean(prices.slice(t-19,t+1)),old5=mean(prices.slice(t-5,t)),old20=mean(prices.slice(t-20,t));
      if(exceeds(ma5,ma20)&&!exceeds(old5,old20)){crossAgeDays=age;break;}
    }
    return {crossAgeDays,crossSearchDays,crossedUpRecently:crossSearchDays>=5?crossAgeDays!==null&&crossAgeDays<5:null};
  }
  function applyStrengthRules(result,{strength}={}){
    const rules=strengthOf(strength),metrics=result.metrics?{...result.metrics}:result.metrics;
    if(result.status!=='ready')return {...result,metrics};
    const known=metrics&&Number.isFinite(metrics.return5)&&Number.isFinite(metrics.ma20Deviation)&&Number.isFinite(metrics.ma5)&&Number.isFinite(metrics.ma20)&&Number.isInteger(metrics.crossSearchDays)&&metrics.crossSearchDays>=rules.crossWithinDays&&(metrics.crossAgeDays===null||Number.isInteger(metrics.crossAgeDays)&&metrics.crossAgeDays>=0&&metrics.crossAgeDays<metrics.crossSearchDays);
    const checks=known?[[exceeds(metrics.return5,rules.minReturn5),'近5日涨幅 > '+rules.minReturn5+'%'],[exceeds(metrics.ma20Deviation,0),'收盘价 > MA20'],[exceeds(metrics.ma5,metrics.ma20),'MA5 > MA20'],[metrics.crossAgeDays!==null&&metrics.crossAgeDays<rules.crossWithinDays,'MA5在近'+rules.crossWithinDays+'个交易日内上穿MA20']]:[[false,'交叉历史不足，无法核验近'+rules.crossWithinDays+'个交易日条件']];
    const candidateMatched=known?checks.every(([pass])=>pass):null,baseMatched=candidateMatched===true&&result.eligible!==false&&result.marketQualified!==false&&result.directionMatched!==false,excluded=result.excluded===true;
    const ruleReasons=checks.map(([pass,label])=>(pass?'满足：':'未满足：')+label),failed=checks.find(([pass])=>!pass),ruleFailure=failed?'未满足：'+failed[1]:result.eligible===false?'未满足：筛选资格不合格':result.marketQualified===false?'未满足：整体共性门槛':result.directionMatched===false?'未满足：所选走势方向':null,exclusionReasons=(result.exclusionReasons||[]).slice();
    return {...result,metrics,strengthKnown:!!known,candidateMatched,baseMatched,matched:baseMatched&&!excluded,ruleReasons,ruleFailure,reason:excluded?exclusionReasons[0]:baseMatched?'满足所选研究条件':ruleFailure,reasons:ruleReasons.concat(exclusionReasons.map(reason=>'排除：'+reason))};
  }
  function applyLimits(result,input,lookback=20){
    const metrics=result.metrics?{...result.metrics}:result.metrics;
    if(result.status!=='ready')return {...result,metrics,reasons:[...(result.reasons||[])],exclusionReasons:[...(result.exclusionReasons||[])]};
    if(![20,60].includes(lookback))throw Error('排除条件周期无效');
    const limits=limitsOf(input);
    let ruleReasons=[];
    if(Array.isArray(result.ruleReasons))ruleReasons=result.ruleReasons.slice();
    else if(!result.excluded)ruleReasons=(result.reasons||[]).slice();
    const candidateBase=typeof result.candidateMatched==='boolean'?result.candidateMatched:typeof result.baseMatched==='boolean'?result.baseMatched:result.matched;
    const baseMatched=candidateBase&&result.eligible!==false&&result.marketQualified!==false&&result.directionMatched!==false;
    const exclusionReasons=[];
    if(limits.enabled){
      for(const [value,cap,label]of [[metrics.periodReturn,lookback===20?limits.maxReturn20:limits.maxReturn60,'所选周期涨幅'],[metrics.return5,limits.maxReturn5,'近5日涨幅'],[metrics.ma20Deviation,limits.maxDeviation,'相对MA20正乖离'],[metrics.volumeRatio,limits.maxVolumeRatio,'近5日/此前20日成交量比']])if(exceeds(value,cap))exclusionReasons.push(label+' '+value.toFixed(2)+(label.includes('成交量比')?'倍':'%')+' 超过上限 '+cap+(label.includes('成交量比')?'倍':'%'));
    }
    const excluded=exclusionReasons.length>0,matched=baseMatched&&!excluded;
    const ruleFailure=result.ruleFailure===undefined?(baseMatched?null:result.reason||null):result.ruleFailure;
    return {...result,baseMatched,matched,excluded,exclusionReasons,ruleReasons,ruleFailure,reason:excluded?exclusionReasons[0]:matched?'满足所选研究条件':ruleFailure,metrics,reasons:ruleReasons.concat(exclusionReasons.map(reason=>'排除：'+reason))};
  }
  function applyConsensusThreshold(result,{consensus,minimumBreadth=RULES.consensusBreadth,eligible=result.eligible??true,eligibilityCodes=eligible?[]:(result.eligibilityCodes||['ineligible'])}={}){
    const threshold=breadthThreshold(minimumBreadth),metrics=result.metrics?{...result.metrics}:result.metrics;
    if(typeof eligible!=='boolean'||!Array.isArray(eligibilityCodes))throw Error('筛选资格须为布尔值及原因代码列表');
    const codes=eligible?[]:(eligibilityCodes.length?eligibilityCodes.slice():['ineligible']);
    const c=consensus,m=metrics;
    const valid=c?.status==='ready'&&Number.isInteger(c.validCount)&&c.validCount>=RULES.minimumMembers&&Number.isInteger(c.requestedCount)&&c.requestedCount>=c.validCount&&Number.isFinite(c.coverage)&&c.coverage>=RULES.coverage&&c.coverage<=1&&Math.abs(c.coverage-c.validCount/c.requestedCount)<1e-12&&Number.isInteger(c.commonCount)&&c.commonCount>=0&&c.commonCount<=c.validCount&&Number.isFinite(c.breadth)&&Math.abs(c.breadth-c.commonCount/c.validCount)<1e-12;
    if(result.status!=='ready'||!valid||!m||c.day!==m.endAt||c.lookback+1!==m.sampleCount||!Number.isFinite(m.correlation)||!Number.isFinite(m.directionAgreement)){
      return {...result,status:'unavailable',candidateMatched:null,marketQualified:null,eligible,eligibilityCodes:codes,minimumBreadth:threshold,baseMatched:null,matched:null,metrics,ruleReasons:[],ruleFailure:c?.reason||result.reason||'市场覆盖或缓存指标不完整',reason:c?.reason||result.reason||'市场覆盖或缓存指标不完整',reasons:[]};
    }
    const candidateChecks=[[m.correlation>=RULES.consensusCorrelation,'与其余市场样本日收益相关性 ≥ 0.50'],[m.directionAgreement>=RULES.directionAgreement,'同向交易日占比 ≥ 60%']];
    const candidateMatched=candidateChecks.every(([pass])=>pass),marketQualified=!exceeds(threshold,c.breadth);
    const checks=[[marketQualified,'市场共性占比 '+percent(c.breadth)+' 达到所设门槛 '+percent(threshold)],...candidateChecks,[eligible,codes.includes('risk_name')?'风险名称不在筛选资格内':'筛选资格合格']];
    const ruleReasons=checks.map(([pass,label])=>(pass?'满足：':'未满足：')+label),failed=checks.find(([pass])=>!pass),ruleFailure=failed?'未满足：'+failed[1]:null;
    const baseMatched=candidateMatched&&marketQualified&&eligible&&result.directionMatched!==false,excluded=result.excluded===true,exclusionReasons=(result.exclusionReasons||[]).slice();
    return {...result,candidateMatched,marketQualified,eligible,eligibilityCodes:codes,minimumBreadth:threshold,baseMatched,matched:baseMatched&&!excluded,metrics,ruleReasons,ruleFailure,exclusionReasons,reason:excluded?exclusionReasons[0]:baseMatched?'满足所选研究条件':ruleFailure,reasons:ruleReasons.concat(exclusionReasons.map(reason=>'排除：'+reason))};
  }
  function applyDirection(records,{direction='all',directionRules,consensus=null,minimumBreadth=RULES.consensusBreadth}={}){
    if(!Array.isArray(records)||!['all','up','down','sideways'].includes(direction))throw Error('走势方向无效');
    const rules=directionRulesOf(directionRules),threshold=breadthThreshold(minimumBreadth);
    const prepared=records.map(record=>{
      let result=record.result;
      if(consensus)result=applyConsensusThreshold({...result,directionMatched:true},{consensus,minimumBreadth:threshold});
      const classification=classifyDirection(result.metrics,rules);
      return {...record,result:{...result,direction:classification,directionMatched:direction==='all'||classification===direction}};
    });
    const candidateCount=prepared.filter(r=>r.result.status==='ready'&&r.result.candidateMatched===true).length;
    const selectedCandidateCount=prepared.filter(r=>r.result.status==='ready'&&r.result.candidateMatched===true&&r.result.directionMatched).length;
    const validCount=consensus?consensus.validCount:prepared.filter(r=>r.result.status==='ready').length;
    const valid=consensus?prepared.some(r=>r.result.status==='ready'&&r.result.marketQualified!==null):true;
    const allBreadth=consensus&&valid?consensus.breadth:null,breadth=consensus&&valid?(direction==='all'?allBreadth:selectedCandidateCount/validCount):null;
    const marketQualified=consensus?(valid?!exceeds(threshold,breadth):null):null;
    const updated=prepared.map(record=>{
      const r=record.result;if(r.status!=='ready')return record;
      const previous=r.directionReasons||[],ruleReasons=(r.ruleReasons||[]).filter(reason=>!previous.includes(reason));
      const directionLabel={all:'全部方向',up:'共同上涨',down:'共同下跌',sideways:'横盘整理'}[direction];
      const directionReasons=direction==='all'?[]:[(r.directionMatched?'满足：':'未满足：')+'所选走势方向 '+directionLabel,(marketQualified===null||marketQualified?'满足：':'未满足：')+'方向组占有效市场样本 '+(breadth===null?'不适用':percent(breadth))];
      const qualified=consensus?marketQualified:r.marketQualified,baseMatched=r.candidateMatched===true&&r.eligible!==false&&qualified!==false&&r.directionMatched,excluded=r.excluded===true;
      const ruleFailure=!r.directionMatched?'未满足：所选走势方向':qualified===false?'未满足：方向组整体共性门槛':r.candidateMatched!==true||r.eligible===false?r.ruleFailure:null;
      const reasons=ruleReasons.concat(directionReasons),exclusionReasons=(r.exclusionReasons||[]).slice();
      return {...record,result:{...r,marketQualified:qualified,baseMatched,matched:baseMatched&&!excluded,directionReasons,ruleReasons:reasons,ruleFailure,reason:excluded?exclusionReasons[0]:baseMatched?'满足所选研究条件':ruleFailure,reasons:reasons.concat(exclusionReasons.map(reason=>'排除：'+reason))}};
    });
    return {records:updated,summary:{direction,validCount,candidateCount,selectedCandidateCount,breadth,allBreadth,marketQualified,minimumBreadth:threshold}};
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
      metrics.periodRangePercent=(Math.max(...window.map(b=>b.close))/Math.min(...window.map(b=>b.close))-1)*100;
      metrics.ma5=mean(prices.slice(-5));metrics.ma20=mean(prices.slice(-20));metrics.ma20Deviation=(last/metrics.ma20-1)*100;
      metrics.volumeAvg5=mean(aligned.slice(-5).map(b=>b.volume));metrics.volumeAvgPrevious20=mean(aligned.slice(-25,-5).map(b=>b.volume));metrics.volumeRatio=metrics.volumeAvg5/metrics.volumeAvgPrevious20;
      const calendar=referenceBars?readBars(referenceBars,day,'交易日历',true):supportDates.map(date=>({date}));
      Object.assign(metrics,crossMetrics(stock,calendar));
      let checks=[];
      if(mode==='market'||mode==='consensus'){
        const daily=returns(window.map(b=>b.close));let relative;
        if(mode==='market'){
          const reference=referenceBars.slice(-lookback-1).map(b=>b.close);relative=relativeMetrics(daily,returns(reference));
        }else relative=consensus.perCode?.[code]||relativeMetrics(daily,consensus.medianReturns);
        Object.assign(metrics,relative);
        if(metrics.correlation===null||metrics.curveCorrelation===null)throw Error('所选周期波动不足，无法计算走势相关性');
        checks=mode==='consensus'?[[metrics.correlation>=RULES.consensusCorrelation,'与其余市场样本日收益相关性 ≥ 0.50'],[metrics.directionAgreement>=RULES.directionAgreement,'同向交易日占比 ≥ 60%']]:[[metrics.correlation>=RULES.correlation,'日收益相关性 ≥ 0.65'],[metrics.directionAgreement>=RULES.directionAgreement,'同向交易日占比 ≥ 60%']];
      }
      if(Object.values(metrics).some(v=>typeof v==='number'&&!Number.isFinite(v)))throw Error('计算结果超出有效数值范围');
      const reasons=checks.map(([pass,label])=>(pass?'满足：':'未满足：')+label);
      const candidateMatched=checks.every(([pass])=>pass),failed=checks.find(([pass])=>!pass);
      let base={status:'ready',candidateMatched,marketQualified:null,eligible:true,eligibilityCodes:[],matched:candidateMatched,excluded:false,exclusionReasons:[],metrics,reasons,ruleReasons:reasons,ruleFailure:failed?'未满足：'+failed[1]:null};
      if(mode==='strength')base=applyStrengthRules(base,{strength:input.strength});
      const filtered=applyLimits(base,limits,lookback);
      if(mode!=='consensus')return filtered;
      const minimumBreadth=input.minimumBreadth===undefined?(consensus.minimumBreadth??RULES.consensusBreadth):input.minimumBreadth;
      return applyConsensusThreshold(filtered,{consensus,minimumBreadth});
    }catch(error){return unavailable(error.message||'日线数据无法核验');}
  }
  const api={RULES,DEFAULT_LIMITS,DEFAULT_DIRECTION_RULES,DEFAULT_STRENGTH,MODES,evaluate,applyLimits,applyConsensusThreshold,applyStrengthRules,classifyDirection,applyDirection,selectMarketSample,buildConsensus};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksTrendScreen=api;
})(typeof globalThis==='object'?globalThis:this);
