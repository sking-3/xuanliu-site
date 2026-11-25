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
test('60 and120 are explicit daily display windows, with actual short coverage and no implied holding or forecast period',()=>{
 for(const window of [60,120]){const svg=renderIntradayChart({row,bars,window});assert(svg.includes('近'+window+'个交易日日K'));assert.match(svg,/实际21根/);assert.match(svg,/仅显示窗口，非持有期或预测期/);assert.equal((svg.match(/data-candle-day=/g)||[]).length,21);assert.match(svg,/参考价 10\.25/);assert.match(svg,/data-normalization="first-close-percent"/);}
});
function planned(){
 const bound={...row,code:'600001.SH',phase:'close',asOf:'2026-11-21T07:00:00Z',sourceId:'tickflow-free-forward-v1',generation:'2026-11-21-1',state:'watch'};
 bound.research={plan:{...Object.fromEntries(['code','sourceId','generation','day','asOf'].map(key=>[key,bound[key]])),priceBasis:'same_batch_qfq',buyZone:{low:9.9,high:10.05},reduceZone:{low:10.6,high:10.8}}};return bound;
}
test('same-stock same-generation plan zones retain real reference prices and add no fictional buy, sell or historical points',()=>{
 const input=planned(),before=structuredClone(input),svg=renderIntradayChart({row:input,bars});assert.match(svg,/data-plan-zone="buyZone"/);assert.match(svg,/data-plan-zone="reduceZone"/);assert.match(svg,/承接计划区 9\.90–10\.05/);assert.match(svg,/减仓计划区 10\.60–10\.80/);assert.match(svg,/B参考 10\.2/);assert.match(svg,/失效 9\.5/);assert.match(svg,/参考价 10\.25/);assert.match(svg,/同批前复权计划，非委托，未验证成交/);assert.doesNotMatch(svg,/data-kind="(?:B|S|ADD|REDUCE)"|data-unclosed|NaN|Infinity/);assert.deepEqual(input,before);assert.match(svg,/data-normalization="first-close-percent"/);
});
test('foreign-stock, foreign-generation, wrong-date, changed-source and non-qfq plans are rejected before drawing any zones',()=>{
 for(const key of ['code','sourceId','generation','day','asOf','priceBasis']){const input=planned();input.research.plan[key]='wrong';assert.throws(()=>renderIntradayChart({row:input,bars}),/计划区域.*不符/);}
 for(const zone of [{low:0,high:10},{low:10,high:9},{low:NaN,high:10},{low:9,high:Infinity}]){const input=planned();input.research.plan.buyZone=zone;assert.throws(()=>renderIntradayChart({row:input,bars}),/有序的正数/);}
 const malformed=planned();malformed.research.plan=false;assert.throws(()=>renderIntradayChart({row:malformed,bars}),/不符/);
});
test('the earlier unplanned14 chart remains the same whether an absent plan is omitted or explicitly null',()=>{
 const plain=renderIntradayChart({row,bars}),empty=renderIntradayChart({row:{...row,research:{plan:null}},bars});assert.equal(empty,plain);assert.doesNotMatch(plain,/data-plan-zone=/);assert.equal((plain.match(/data-kind="B"/g)||[]).length,1);assert.match(plain,/data-unclosed="true"/);
 const input=planned();input.research.plan.reduceZone=null;assert.doesNotMatch(renderIntradayChart({row:input,bars}),/data-plan-zone="reduceZone"/);
});
test('plan reference labels use a separate bottom legend and at most four decimals without long raw prices in visible text',()=>{
 const input=planned();input.reference={close:10.250123456789,trigger:10.312345678901,invalidation:9.512345678901};const candles=bars.map((bar,i)=>i===bars.length-1?{...bar,close:input.reference.close}:bar),svg=renderIntradayChart({row:input,bars:candles});
 assert.match(svg,/<text x="70" y="420"[^>]*>B参考 10\.3123<\/text>/);assert.match(svg,/<text x="400" y="420"[^>]*>失效 9\.5123<\/text>/);assert.match(svg,/参考价 10\.2501/);
 const text=[...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].map(match=>match[1]).join(' ');for(const price of Object.values(input.reference))assert(!text.includes(String(price)));
 assert.doesNotMatch(svg,/<text x="755"[^>]*>(?:B参考|失效) /);assert.equal([...svg.matchAll(/<text x="755"[^>]*>[^<]*%<\/text>/g)].length,5);assert.match(svg,/data-normalization="first-close-percent"/);
});
test('display rounding never changes the original plan prices or level-line positions, and unplanned labels keep their old placement',()=>{
 const input=planned();input.reference={close:20.516785714285715,trigger:20.5169999999999,invalidation:20.516749999999};input.research.plan.buyZone={low:20.5166,high:20.5167};input.research.plan.reduceZone={low:20.517,high:20.5171};
 const candles=bars.map((bar,i)=>({...bar,open:20.5168,high:20.517,low:20.5166,close:i===bars.length-1?input.reference.close:20.5168})),before=structuredClone(input),base=candles[0].close,pct=value=>(value/base-1)*100,values=candles.flatMap(bar=>[pct(bar.low),pct(bar.high)]).concat([pct(input.reference.trigger),pct(input.reference.invalidation),pct(20.5166),pct(20.5167),pct(20.517),pct(20.5171)]),minimum=Math.min(...values),maximum=Math.max(...values),padding=Math.max(1,(maximum-minimum)*.15),low=minimum-padding,high=maximum+padding,y=value=>Number((390-(pct(value)-low)/(high-low)*325).toFixed(2));
 const svg=renderIntradayChart({row:input,bars:candles});assert.notEqual(y(input.reference.invalidation),y(Number(input.reference.invalidation.toFixed(4))));assert(svg.includes('d="M70 '+y(input.reference.invalidation)+'H745" stroke="#a45045"'));assert(svg.includes('d="M70 '+y(input.reference.trigger)+'H745" stroke="#286178"'));assert.match(svg,/>失效 20\.5167<\/text>/);assert.match(svg,/>B参考 20\.517<\/text>/);assert.match(svg,/参考价 20\.5168/);assert.deepEqual(input,before);
 const legacy=renderIntradayChart({row:{...input,research:{plan:null}},bars:candles});assert.match(legacy,/<text x="755"[^>]*>失效 20\.516749999999<\/text>/);assert.doesNotMatch(legacy,/<text x="(?:70|400)" y="420"/);
});
