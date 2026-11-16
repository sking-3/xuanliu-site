/* Scheduled cash-equity sessions only. Quote timestamps still determine freshness.
 * Calendars verified 2026-11-16. Unlisted years fail closed; no inferred holidays.
 * This is not a feed of emergency closures, individual halts or extended-hours trading. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BooksMarketCalendar=api;
})(globalThis,function(){
  'use strict';
  const version='cash-sessions-2026-v1';
  const sources={
    CN:'https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml',
    US:'https://www.nasdaq.com/market-activity/stock-market-holiday-schedule',
    HK:'https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf'
  };
  const zones={CN:'Asia/Shanghai',HK:'Asia/Hong_Kong',US:'America/New_York'};
  const aliases={a:'CN',us:'US','Asia/Shanghai':'CN','Asia/Hong_Kong':'HK','America/New_York':'US'};
  const holidays={
    CN:['01-01','01-02','01-03','02-15','02-16','02-17','02-18','02-19','02-20','02-21','02-22','02-23','04-04','04-05','04-06','05-01','05-02','05-03','05-04','05-05','06-19','06-20','06-21','09-25','09-26','09-27','10-01','10-02','10-03','10-04','10-05','10-06','10-07'],
    US:['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'],
    HK:['01-01','02-17','02-18','02-19','04-03','04-06','04-07','05-01','05-25','06-19','07-01','10-01','10-19','12-25']
  };
  const early={US:['11-27','12-24'],HK:['02-16','12-24','12-31']};
  const formatters=new Map();
  const key=market=>aliases[market]||market;
  function validDay(day){
    return typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
  }
  function clock(market,value=Date.now()){
    const k=key(market),time=new Date(value);
    if(!zones[k]||!Number.isFinite(time.getTime()))return null;
    if(!formatters.has(k))formatters.set(k,new Intl.DateTimeFormat('en-US',{timeZone:zones[k],year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));
    const p=Object.fromEntries(formatters.get(k).formatToParts(time).map(x=>[x.type,x.value]));
    return {date:p.year+'-'+p.month+'-'+p.day,time:p.hour+p.minute+p.second};
  }
  function session(market,day){
    const k=key(market),base={date:day,market:k,calendarVersion:version,source:sources[k]||null};
    if(!zones[k]||!validDay(day)||!day.startsWith('2026-'))return {...base,verified:false,open:false,intervals:[],close:null};
    const weekday=new Date(day+'T00:00:00Z').getUTCDay(),md=day.slice(5);
    if(weekday===0||weekday===6||holidays[k].includes(md))return {...base,verified:true,open:false,intervals:[],close:null};
    const half=early[k]?.includes(md)||false;
    const close=k==='US'?(half?'130000':'160000'):k==='HK'?(half?'121000':'161000'):'150000';
    const intervals=k==='US'?[['093000',close]]:k==='HK'&&half?[['093000',close]]:[['093000',k==='HK'?'120000':'113000'],['130000',close]];
    return {...base,verified:true,open:true,earlyClose:half,intervals,close};
  }
  function inSession(market,local){
    if(!local||!/^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(local.time))return false;
    const s=session(market,local.date);
    return s.verified&&s.open&&s.intervals.some(([start,end])=>local.time>=start&&local.time<end);
  }
  function instant(market,day,time){
    const target=Date.parse(day+'T'+time.slice(0,2)+':'+time.slice(2,4)+':'+time.slice(4,6)+'Z');
    let value=target;
    for(let i=0;i<3;i++){
      const p=clock(market,value);if(!p)return NaN;
      const observed=Date.parse(p.date+'T'+p.time.slice(0,2)+':'+p.time.slice(2,4)+':'+p.time.slice(4,6)+'Z');
      value+=target-observed;
    }
    return value;
  }
  function latestClosed(market,now=Date.now()){
    const current=clock(market,now);if(!current||!session(market,current.date).verified)return null;
    let day=current.date;
    for(let i=0;i<370;i++){
      const s=session(market,day);if(!s.verified)return null;
      if(s.open&&(day<current.date||current.time>=s.close))return {date:day,closeTime:new Date(instant(market,day,s.close)).toISOString(),calendarVersion:version,source:s.source};
      day=new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10);
    }
    return null;
  }
  // A collection timestamp cannot establish per-security coverage. Never return "live"/"ready".
  function batchFreshness(market,updatedAt,now=Date.now()){
    const received=typeof updatedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(updatedAt)&&validDay(updatedAt.slice(0,10))?Date.parse(updatedAt):NaN;
    const nowMs=new Date(now).getTime();
    if(!Number.isFinite(received)||!Number.isFinite(nowMs)||received>nowMs)return {state:'invalid',latestClosedDate:null,message:'批次时间异常 · 无法核验数据时效'};
    const latest=latestClosed(market,nowMs);
    if(!latest)return {state:'calendar-unverified',latestClosedDate:null,message:'交易日历待核验 · 仅展示有日期的快照'};
    const stale=received<Date.parse(latest.closeTime);
    return {state:stale?'historical':'dated',latestClosedDate:latest.date,latestCloseTime:latest.closeTime,batchDate:clock(market,received).date,
      message:stale?'历史快照 · 缺少最近已收盘交易日 '+latest.date+' 的收盘后批次':'批次时间已覆盖 '+latest.date+' 收盘 · 逐股行情日期仍待核验'};
  }
  return {version,sources,clock,session,inSession,latestClosed,batchFreshness};
});
