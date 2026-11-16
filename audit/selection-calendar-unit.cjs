'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const calendar=require('../market-calendar.js');
const friday='2026-11-13T08:15:00Z';
test('Monday preopen and lunch require Friday, not the unfinished Monday session',()=>{
 for(const time of ['2026-11-16T01:00:00Z','2026-11-16T04:00:00Z','2026-11-16T06:59:59Z']){
  const r=calendar.batchFreshness('CN',friday,time);assert.equal(r.state,'dated');assert.equal(r.latestClosedDate,'2026-11-13');assert.match(r.message,/逐股行情日期仍待核验/);
 }
});
test('the exact Shanghai close makes the Friday batch historical',()=>{
 const r=calendar.batchFreshness('CN',friday,'2026-11-16T07:00:00Z');assert.equal(r.state,'historical');assert.equal(r.latestClosedDate,'2026-11-16');assert.match(r.message,/缺少/);
});
test('a same-date intraday capture is still missing the required closing batch',()=>{
 const r=calendar.batchFreshness('CN','2026-11-16T06:59:59Z','2026-11-16T07:00:01Z');assert.equal(r.state,'historical');assert.equal(r.batchDate,'2026-11-16');
});
test('weekends and the official National Day closure do not use elapsed-hour thresholds',()=>{
 assert.equal(calendar.batchFreshness('CN',friday,'2026-11-15T14:00:00Z').state,'dated');
 const r=calendar.batchFreshness('CN','2026-09-30T08:00:00Z','2026-10-07T08:00:00Z');assert.equal(r.state,'dated');assert.equal(r.latestClosedDate,'2026-09-30');
});
test('next-year calendar uncertainty cannot declare a latest completed session',()=>{
 const r=calendar.batchFreshness('CN',friday,'2027-01-04T08:00:00Z');assert.equal(r.state,'calendar-unverified');assert.equal(r.latestClosedDate,null);
});
test('future or unzoned batches cannot establish freshness',()=>{
 for(const stamp of ['2026-11-17T08:00:00Z','2026-11-16T08:00:00'])assert.equal(calendar.batchFreshness('CN',stamp,'2026-11-16T08:00:00Z').state,'invalid');
});
test('a post-close batch never attests per-security completeness or live data',()=>{
 const r=calendar.batchFreshness('CN','2026-11-16T08:00:00Z','2026-11-16T09:00:00Z');assert.equal(r.state,'dated');assert.match(r.message,/逐股行情日期仍待核验/);assert.notEqual(r.state,'ready');
});
