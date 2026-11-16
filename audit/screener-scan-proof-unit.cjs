'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseScan,matches}=require('./screener-scan-proof.cjs');

test('matches the same raw widget batch at displayed precision with its data restriction',()=>{
  const raw=JSON.stringify({columns:['change','update_mode','close'],options:{data_restrictions:'PREV_BAR'}});
  const batch=parseScan(raw,{data:[{s:'NASDAQ:AAPL',d:[.3926,'delayed_streaming_900',356.267]}]});
  assert.equal(batch.dataRestrictions,'PREV_BAR');
  assert.equal(batch.rows.get('NASDAQ:AAPL').update_mode,'delayed_streaming_900');
  assert.ok(matches(batch,[{symbol:'NASDAQ:AAPL',price:356.27,pct:.39}]));
  assert.equal(matches(batch,[{symbol:'NASDAQ:AAPL',price:354.63,pct:-.46}]),false);
  assert.equal(matches(batch,[{symbol:'NASDAQ:AAPL',price:356.27,pct:.40}]),false);
  assert.equal(matches(batch,[{symbol:'NASDAQ:OTHER',pct:.39}]),false);
});

test('malformed request, missing columns or incorrect response shape cannot count as verification',()=>{
  assert.throws(()=>parseScan('broken',{data:[]}));
  assert.throws(()=>parseScan('{"columns":["close"]}',{data:[]}));
  assert.throws(()=>parseScan('{"columns":["change"]}',{}));
  const batch=parseScan('{"columns":["change"]}',{data:[{s:'NASDAQ:AAPL',d:[null]}]});
  assert.equal(matches(batch,[{symbol:'NASDAQ:AAPL',pct:0}]),false);
  assert.equal(matches(batch,[]),false);
});
