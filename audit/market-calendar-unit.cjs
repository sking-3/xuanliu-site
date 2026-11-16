'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const cal=require('../market-calendar.js');
const tape=require('../market-strip.js');
const at=(m,t)=>cal.inSession(m,cal.clock(m,t));
test('known holidays and make-up work weekends are not exchange sessions',()=>{
  for(const [m,date] of [['CN','2026-10-01'],['CN','2026-02-23'],['CN','2026-02-28'],['US','2026-11-26'],['US','2026-07-03'],['HK','2026-04-07']]){
    assert.equal(cal.session(m,date).verified,true);assert.equal(cal.session(m,date).open,false);
  }
  assert.equal(cal.session('CN','2026-10-08').open,true);
});
test('US early close and daylight saving offsets',()=>{
  assert.equal(at('US','2026-11-27T17:59:59Z'),true);
  assert.equal(at('US','2026-11-27T18:00:00Z'),false);
  assert.equal(at('US','2026-11-27T20:00:00Z'),false);
  assert.equal(at('US','2026-06-02T13:30:00Z'),true);
  assert.equal(at('US','2026-11-16T14:29:59Z'),false);
  assert.equal(at('US','2026-11-16T14:30:00Z'),true);
  assert.equal(cal.latestClosed('US','2026-11-27T18:00:00Z').closeTime,'2026-11-27T18:00:00.000Z');
});
test('Hong Kong half-days include closing auction but no afternoon session',()=>{
  for(const day of ['2026-02-16','2026-12-24','2026-12-31']){
    assert.equal(cal.session('HK',day).close,'121000');
    assert.equal(at('HK',day+'T04:09:59Z'),true);
    assert.equal(at('HK',day+'T04:10:00Z'),false);
    assert.equal(at('HK',day+'T05:30:00Z'),false);
  }
});
test('mainland lunch, weekends, preclose and long holidays retain previous closed day',()=>{
  assert.equal(at('CN','2026-11-16T03:30:00Z'),false);
  assert.equal(at('CN','2026-11-16T05:00:00Z'),true);
  for(const time of ['2026-11-14T09:00:00Z','2026-11-16T01:00:00Z','2026-11-16T04:00:00Z','2026-11-16T06:59:59Z'])assert.equal(cal.latestClosed('CN',time).date,'2026-11-13');
  assert.equal(cal.latestClosed('CN','2026-11-16T07:00:00Z').date,'2026-11-16');
  assert.equal(cal.latestClosed('CN','2026-10-07T09:00:00Z').date,'2026-09-30');
});
test('unknown calendar, invalid date and year boundary never infer an open session',()=>{
  for(const day of ['2027-01-04','2026-02-31','garbage'])assert.equal(cal.session('CN',day).verified,false);
  assert.equal(cal.latestClosed('CN','2027-01-04T09:00:00Z'),null);
  assert.equal(cal.latestClosed('CN','2026-01-05T01:00:00Z'),null);
  assert.equal(cal.inSession('CN',{date:'2026-11-16',time:'106099'}),false);
});
test('batch assessment detects missing latest close and never asserts per-stock freshness',()=>{
  const batch='2026-11-13T08:15:00Z';
  assert.equal(cal.batchFreshness('CN',batch,'2026-11-15T09:00:00Z').state,'dated');
  assert.equal(cal.batchFreshness('CN',batch,'2026-11-16T06:59:59Z').state,'dated');
  const stale=cal.batchFreshness('CN',batch,'2026-11-16T07:00:00Z');
  assert.equal(stale.state,'historical');assert.equal(stale.latestClosedDate,'2026-11-16');
  assert.match(stale.message,/缺少最近已收盘交易日/);
  const current=cal.batchFreshness('CN','2026-11-16T08:15:00Z','2026-11-16T09:00:00Z');
  assert.equal(current.state,'dated');assert.match(current.message,/逐股行情日期仍待核验/);
  assert.equal(cal.batchFreshness('CN',batch,'2027-01-04T09:00:00Z').state,'calendar-unverified');
  for(const x of ['invalid','2026-02-31T08:15:00Z','2026-11-17T08:15:00Z','2026-11-13'])assert.equal(cal.batchFreshness('CN',x,'2026-11-16T09:00:00Z').state,'invalid');
});
function payload(symbol,day,stamp,dates){
  const ticker=tape.feeds[symbol][0],qt=[];qt[2]=ticker.slice(2);qt[3]='101';qt[4]='100';qt[30]=stamp;
  return {code:0,data:{[ticker]:{day:dates.map((d,i)=>[d,'99',i===dates.length-1?'101':i===dates.length-2?'100':'99']),qt:{[ticker]:qt}}}};
}
test('holiday intraday timestamps cannot become delayed quotes or same-day closes',()=>{
  const symbol='FRED:NDQCOM',p=payload(symbol,'2026-11-26','2026-11-26 10:00:00',['2026-11-24','2026-11-25','2026-11-26']);
  for(const t of ['2026-11-26T15:01:00Z','2026-11-26T22:00:00Z']){
    const q=tape.quote(symbol,p,new Date(t));assert.equal(q.delayed,null);assert.equal(q.closing.date,'2026-11-25');
  }
});
test('early close accepts a verified close, rejects afternoon delayed cache',()=>{
  const symbol='FRED:NDQCOM',p=payload(symbol,'2026-11-27','2026-11-27 13:00:00',['2026-11-24','2026-11-25','2026-11-27']);
  const q=tape.quote(symbol,p,new Date('2026-11-27T18:01:00Z'));
  assert.equal(q.closing.date,'2026-11-27');assert.equal(q.delayed,null);
  const closing={date:'2026-11-25',close:100};
  const row={price:101,previousClose:100,previousDate:closing.date,date:'2026-11-27',instant:'2026-11-27T18:01:00Z'};
  assert.equal(tape.fresh(symbol,row,closing,new Date('2026-11-27T18:02:00Z')),false);
});
test('cached live data must have the last closed session as its comparison base',()=>{
  const closing={date:'2026-11-12',close:100};
  const row={price:101,previousClose:100,previousDate:closing.date,date:'2026-11-16',instant:'2026-11-16T02:00:00Z'};
  assert.equal(tape.fresh('SSE:000001',row,closing,new Date('2026-11-16T02:01:00Z')),false);
  assert.equal(tape.fresh('unknown',row,closing,new Date('2026-11-16T02:01:00Z')),false);
});
