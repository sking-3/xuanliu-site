(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksPeriodMetrics=api;
})(globalThis,function(){
  'use strict';
  const DAY=86400000,periods=['7D','30D','90D','180D','365D','ALL'];
  const number=value=>typeof value==='number'&&Number.isFinite(value);
  const time=value=>typeof value==='string'?Date.parse(value):typeof value==='number'?value:NaN;
  const iso=value=>Number.isFinite(value)?new Date(value).toISOString():null;
  function interval(period,end){
    return {start:period==='ALL'?-Infinity:end-parseInt(period,10)*DAY,end};
  }
  function contains(range,first,last){
    return Number.isFinite(time(first))&&Number.isFinite(time(last))&&
      time(first)>=range.start&&time(last)<=range.end&&time(first)<=time(last);
  }
  function parseSamples(raw,now=Date.now()){
    if(raw?.schemaVersion!==1||!Number.isFinite(time(raw.generatedAt))||time(raw.generatedAt)>now+300000||
      !raw.accounts||Array.isArray(raw.accounts)||Object.keys(raw.accounts).length>200)throw Error('period_samples_schema');
    for(const [id,windows]of Object.entries(raw.accounts)){
      if(!/^0x[0-9a-f]{40}$/.test(id))throw Error('period_samples_identity');
      for(const [period,row]of Object.entries(windows)){
        if(!periods.includes(period)||!Number.isFinite(time(row.anchorAt))||time(row.anchorAt)>now+300000||
          !Array.isArray(row.curve)||row.curve.length>120)throw Error('period_samples_window');
        const range=interval(period,time(row.anchorAt));
        if(row.native&&(!['7D','30D','ALL'].includes(period)||!number(row.native.roi)||!number(row.native.pnl)||
          row.native.sourceAt!==row.anchorAt||!Number.isFinite(time(row.native.observedAt))||
          !/^[a-f0-9]{64}$/.test(row.native.sha256)))throw Error('period_samples_native');
        let previous=-Infinity;
        for(const point of row.curve){
          if(!number(point.value)||!contains(range,point.time,point.time)||time(point.time)<=previous)throw Error('period_samples_curve');
          previous=time(point.time);
        }
        for(const key of ['mdd','win']){
          const metric=row[key];
          if(metric===null)continue;
          if(!number(metric?.value)||metric.value<0||key==='win'&&metric.value>100||
            !Number.isInteger(metric.count)||metric.count<(key==='win'?1:2)||
            !contains(range,metric.startAt,metric.endAt)||!Number.isFinite(time(metric.observedAt))||
            time(metric.observedAt)>now+300000||!/^[a-f0-9]{64}$/.test(metric.sha256))throw Error('period_samples_metric');
        }
      }
    }
    return raw;
  }
  function resolve({exchange,period,performance,sample,sampleObservedAt,winEntry,supplement,sourceObservedAt}={}){
    if(!periods.includes(period))return null;
    if(!performance&&!supplement)return null;
    let base=performance?{...performance}:{currency:exchange==='Hyperliquid'?'USD':'USDT',periodSupported:false};
    const hl=exchange==='Hyperliquid';
    const existingAt=time(base.sourceAsOf??base.asOf??base.lastSuccessAt);
    if(hl&&supplement?.native&&(!Number.isFinite(existingAt)||time(supplement.native.sourceAt)>=existingAt)){
      const native=supplement.native;
      base={...base,roi:native.roi,pnl:native.pnl,asOf:native.sourceAt,sourceAsOf:native.sourceAt,
        asOfType:'source',lastSuccessAt:native.observedAt,sourcePeriod:native.sourcePeriod,
        derived:false,fullPeriod:undefined,coverageStatus:undefined};
    }
    const sourceAt=time(base.sourceAsOf??base.endTs??(base.asOfType!=='observed'?base.asOf:null));
    const observedAt=time(base.lastSuccessAt??base.fetchedAt??(base.asOfType==='observed'?base.asOf:sourceObservedAt));
    let end=Number.isFinite(sourceAt)?sourceAt:observedAt;
    if(hl&&['90D','180D','365D'].includes(period)&&!number(base.roi)&&supplement?.curve?.length>1&&
      time(supplement.historyStartAt)<=time(supplement.sourceStartAt)){
      base={...base,derived:true,sourcePeriod:'perpAllTime',pnl:supplement.curve.at(-1).value,
        roi:null,asOf:supplement.anchorAt,asOfType:'source',fullPeriod:true,coverageStatus:'sampled_boundary'};
      end=time(supplement.anchorAt);
    }
    const range=interval(period,end);
    const invalid=base.fullPeriod===false||base.derived&&base.coverageStatus==='insufficient_history';
    const at={sourceAt:iso(sourceAt),observedAt:iso(observedAt),startAt:iso(range.start),endAt:iso(range.end),kind:'source'};
    if(hl&&base.derived&&time(supplement?.anchorAt)===end){
      at.sourceAt=iso(end);at.observedAt=supplement.observedAt??supplement.mdd?.observedAt??null;
      at.kind='sample';
    }
    const field=(value,meta=at)=>({...meta,value:number(value)&&!invalid?value:null});
    const fields={roi:field(base.roi),pnl:field(base.pnl),mdd:field(base.mdd),winRate:field(base.winRate)};
    if(base.winRateEvidence)fields.winRate=field(base.winRate,{...at,sourceAt:null,startAt:null,endAt:null,
      observedAt:base.winRateEvidence.lastSuccessAt,method:'profit_days_ratio'});
    let curve=null;
    if(hl){
      fields.mdd=field(null);fields.winRate=field(null);
      const aligned=supplement&&time(supplement.anchorAt)===end?supplement:null;
      const risk=aligned?.mdd;
      if(risk&&contains(range,risk.startAt,risk.endAt))fields.mdd=field(risk.value,{...risk,sourceAt:risk.endAt,kind:'sample'});
      else if(sample?.mddUnavailableReason===null&&number(sample.mdd)&&sample.sampleCount>=2&&
        sample.mddPairedSampleCount===sample.sampleCount&&contains(range,sample.startAt,sample.endAt))
        fields.mdd=field(sample.mdd,{...at,startAt:sample.startAt,endAt:sample.endAt,sourceAt:sample.endAt,
          observedAt:sampleObservedAt??null,kind:'sample',count:sample.sampleCount});
      const win=aligned?.win;
      if(win&&contains(range,win.startAt,win.endAt))fields.winRate=field(win.value,{...win,sourceAt:win.endAt,kind:'sample'});
      else if(winEntry?.win?.eligibleCount&&contains(range,winEntry.win.startAt,winEntry.win.endAt))
        fields.winRate=field(winEntry.win.value,{...at,...winEntry.win,sourceAt:winEntry.win.endAt,
          observedAt:winEntry.fetchedAt,kind:'sample',count:winEntry.win.eligibleCount,complete:false});
      if(aligned?.curve?.length>1)curve={points:aligned.curve,
        startAt:aligned.curve[0].time,endAt:aligned.curve.at(-1).time,
        observedAt:aligned.observedAt??risk?.observedAt??win?.observedAt??null,count:aligned.curve.length};
      else if(sample?.points?.length>1&&contains(range,sample.startAt,sample.endAt))
        curve={points:sample.points,startAt:sample.startAt,endAt:sample.endAt,observedAt:sampleObservedAt??null,count:sample.sampleCount};
    }
    return {...base,roi:fields.roi.value,pnl:fields.pnl.value,mdd:fields.mdd.value,
      winRate:fields.winRate.value,metricTimes:fields,periodRange:{startAt:iso(range.start),endAt:iso(range.end)},
      periodInvalid:Boolean(invalid),alignedCurve:invalid?null:curve};
  }
  return {resolve,parseSamples,interval,contains};
});
