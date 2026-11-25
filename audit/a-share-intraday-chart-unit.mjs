import test from 'node:test';
import assert from 'node:assert/strict';
import {renderIntradayChart} from '../server/a-share-intraday-chart.mjs';

const bars=Array.from({length:21},(_,i)=>({date:'2026-11-'+String(i+1).padStart(2,'0'),open:10,high:10.3,low:9.8,close:i===20?10.25:10,volume:i===20?null:100}));
const row={phase:'a14',day:'2026-11-21',name:'<script>Fixture',state:'triggered_B',quoteSourceAt:'2026-11-21T06:00:30.000Z',reference:{close:10.25,trigger:10.2,invalidation:9.5}};
test('renders only current-day B and an explicitly unfinished last candle without historical B/S or invented volume',()=>{
 const svg=renderIntradayChart({row,bars});assert.match(svg,/最后一根.*未收盘/);assert.match(svg,/data-unclosed="true"/);assert.match(svg,/data-kind="B" data-day="2026-11-21"/);assert.equal((svg.match(/data-kind="B"/g)||[]).length,1);assert.doesNotMatch(svg,/data-kind="S"|<script>|成交量/);assert.match(svg,/&lt;script&gt;/);assert.match(svg,/font-variant-numeric:tabular-nums/);
});
test('near B has no invented trigger marker and mismatched last prices cannot render a chart',()=>{
 assert.doesNotMatch(renderIntradayChart({row:{...row,state:'near_B'},bars}),/data-kind="B"/);assert.throws(()=>renderIntradayChart({row:{...row,reference:{...row.reference,close:11}},bars}),/不符/);
});
test('the same renderer draws a real close watch without invented B levels, historical signals or unfinished candles',()=>{
 const svg=renderIntradayChart({row:{...row,phase:'close',asOf:'2026-11-21T07:00:00Z',state:'watch',reference:{close:10.25,trigger:null,invalidation:null}},bars});assert.match(svg,/data-phase="close"/);assert.match(svg,/收盘观察/);assert.doesNotMatch(svg,/data-unclosed|data-kind="B"|B参考|NaN/);assert.match(svg,/15:00:00/);
});
