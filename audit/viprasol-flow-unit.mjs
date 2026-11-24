import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,evaluateIndicator,nativeMA,edgeEstimate} from '../quant-research/viprasol-flow.mjs';
const mintick=.01;
function wave(n=420){return Array.from({length:n},(_,i)=>{const center=100+Math.sin(i*.19)*8+Math.sin(i*.037)*5,open=center+Math.sin(i*.91)*.8,close=center+Math.cos(i*.71)*.8;return {time:Date.UTC(2024,0,1)+i*86400000,open,close,high:Math.max(open,close)+.7+(i%5)*.13,low:Math.min(open,close)-.6-(i%4)*.09,volume:100+i%11*30+(i%29===0?900:0)};});}
const baseline=n=>Array.from({length:n},(_,i)=>({time:Date.UTC(2025,0,1)+i*86400000,open:10,high:10.5,low:9.5,close:10,volume:100}));
const plot=(out,name)=>out.plots.find(p=>p.name===name)?.values;

test('ADX and discrete trend state stay off the price axis with explicit units',()=>{
 const bars=wave(180),apex=evaluateIndicator('apex-trend-signal-engine',bars,{}, {mintick}),elite=evaluateIndicator('elite-flow-pro',bars,{}, {mintick});
 const adx=apex.plots.find(p=>p.name==='ADX'),state=elite.plots.find(p=>p.name==='Trend State');
 assert.equal(adx.pane,'oscillator');assert.equal(adx.unit,'0–100');
 assert.equal(state.pane,'oscillator');assert.equal(state.unit,'−1/0/1');
 assert.equal(apex.plots.find(p=>p.name==='Trend Midline').pane,'price');
 assert.equal(elite.plots.find(p=>p.name==='Trend Core').pane,'price');
});

test('eleven separate source-bound ports retain parameters and never alter input data',()=>{
 assert.equal(catalog.length,11);assert.equal(new Set(catalog.map(x=>x.id)).size,11);
 const bars=wave(),original=JSON.stringify(bars);for(const item of catalog){const out=evaluateIndicator(item.id,bars,{}, {mintick});assert.equal(out.status,'ready',item.id);assert.ok(item.sourceFile.endsWith(item.id+'.pine'));assert.ok(item.parameters.every(p=>p.key in item.defaults));assert.ok(out.plots.every(p=>p.values.length===bars.length));assert.ok(out.plots.every(p=>p.values.every(v=>v===null||Number.isFinite(v))),item.id);assert.ok(out.signals.every(s=>s.time===bars[s.index].time));}
 assert.equal(JSON.stringify(bars),original);
});
test('missing OHLCV and official tick size fail closed without synthetic zero dependencies',()=>{
 for(const item of catalog){const invalid=wave(40);delete invalid[4].volume;const out=evaluateIndicator(item.id,invalid,{}, {mintick});assert.equal(out.status,'blocked');assert.equal(out.signals.length,0);}
 const noTick=evaluateIndicator('absorption-radar-pro',wave());assert.equal(noTick.status,'blocked');assert.deepEqual(noTick.missingDependencies,['official_mintick']);
 const early=evaluateIndicator('edge-liquidity-engine',wave(20));assert.equal(early.status,'blocked');assert.ok(early.plots[0].values.every(x=>x===null));
 assert.throws(()=>evaluateIndicator('ma-confluence-engine',wave(),{maType:'JMA'}));
 assert.throws(()=>evaluateIndicator('pressure-flow-pro',wave(),{cooldown:-1},{mintick}));
});
test('twenty-one MA formulas are present, with independent SMA/WMA/DEMA/ALMA expectations',()=>{
 const bars=wave(180),x=bars.map(b=>b.close),types=catalog.find(x=>x.id==='ma-confluence-engine').parameters.find(p=>p.key==='maType').options;
 assert.equal(types.length,21);
 const outputs=new Map(types.map(type=>[type,nativeMA(type,x,10,bars)]));for(const [type,values]of outputs){assert.equal(values.length,x.length);assert.ok(values.some(Number.isFinite),type);}
 const tail=x.slice(-10);assert.equal(outputs.get('SMA').at(-1),tail.reduce((a,b)=>a+b,0)/10);assert.equal(outputs.get('WMA').at(-1),tail.reduce((s,v,i)=>s+v*(i+1),0)/55);
 const e=outputs.get('EMA'),e2=nativeMA('EMA',e,10,bars);assert.equal(outputs.get('DEMA').at(-1),2*e.at(-1)-e2.at(-1));
 const weights=tail.map((_,i)=>Math.exp(-((i-.85*9)**2)/(2*(10/6)**2))),expected=tail.reduce((s,v,i)=>s+v*weights[i],0)/weights.reduce((a,b)=>a+b,0);assert.equal(outputs.get('ALMA').at(-1),expected);
 for(const type of ['FRAMA','VIDYA','SuperSmoother','Gaussian','Laguerre','Kalman','LSMA','Median','T3','HMA','KAMA','ZLEMA','McGinley'])assert.notEqual(outputs.get(type).at(-1),e.at(-1),type+' must not be an EMA fallback');
});
test('absorption preserves weighted score, grade, strict cooldown and stop-first level tracking',()=>{
 const bars=baseline(20);bars.push({...bars[19],time:bars[19].time+86400000,open:10,close:10.8,high:11,low:8,volume:1000});
 bars.push({...bars[20],time:bars[20].time+86400000,open:10.8,close:10.9,high:25,low:1,volume:100});
 const out=evaluateIndicator('absorption-radar-pro',bars,{}, {mintick});const s=out.signals.find(s=>s.side==='long');assert.equal(s.index,20);assert.equal(s.score,88);assert.equal(s.label,'BUY A');assert.ok(s.stop<s.entry&&s.target>s.entry);assert.equal(out.levelEvents[0].event,'stop');assert.equal(out.levelEvents[0].index,21);assert.equal(out.levelEvents.length,1);
 assert.equal(out.zones[0].state,'live'); // Absorption invalidates on a CLOSE below its far edge, not the stop wick.
 const below={...bars[21],time:bars[21].time+86400000,open:7.5,close:7,high:8,low:6,volume:100};assert.equal(evaluateIndicator('absorption-radar-pro',[...bars,below],{}, {mintick}).zones[0].state,'failed');
});
test('pressure flow uses original breakout strength and asymmetric candle-extreme stop',()=>{
 const bars=baseline(20);bars.push({...bars[19],time:bars[19].time+86400000,open:10,close:12,high:12.1,low:9.9,volume:1000});
 const out=evaluateIndicator('pressure-flow-pro',bars,{}, {mintick});const s=out.signals.find(s=>s.index===20);assert.equal(s.side,'long');assert.match(s.label,/BUY A.*BREAK/);assert.equal(s.stop,9.9);assert.equal(s.target,14.1);assert.equal(s.score,95);
});
test('Liquidity Hunt arms a confirmed sweep and emits on the later fresh MSS candle',()=>{
 const values=[[8,8.5,7.5,8],[8,9,7.8,8.5],[8.5,10,8.2,9],[9,9.5,8,8.5],[8.5,9,7.5,8],[8,8.5,7,7.5],[7.5,8.2,7.2,8],[8,8.8,7.6,8.4],[8.4,9,8,8.5],[8.5,9,7.8,8],[8,8.3,6.8,7.8],[7.8,9,7.5,8.6],[8.6,10.6,8.5,10.5]];
 const bars=values.map(([open,high,low,close],i)=>({time:Date.UTC(2025,0,1)+i*86400000,open,high,low,close,volume:100}));
 const params={swingLen:2,atrLen:1,minBodyATR:0,signalGap:0};assert.equal(evaluateIndicator('liquidity-hunt-pro',bars.slice(0,12),params,{mintick}).signals.length,0);
 const out=evaluateIndicator('liquidity-hunt-pro',bars,params,{mintick}),s=out.signals.at(-1);assert.equal(s.index,12);assert.equal(s.sweepIndex,10);assert.equal(s.stop,6.8);assert.equal(s.entry,10.5);assert.ok(Math.abs(s.target-14.2)<1e-12);
});
test('EDGE uses its original delayed two-pass estimator; unavailable windows are null',()=>{
 const bars=wave(100),out=edgeEstimate(bars,30);assert.ok(out.slice(0,32).every(v=>v===null));assert.ok(out.slice(32).every(v=>Number.isFinite(v)&&v>=0));
 const fixed=baseline(100);assert.ok(edgeEstimate(fixed,30).slice(32).every(v=>v===0));
 const engine=evaluateIndicator('edge-liquidity-engine',bars,{winInput:30,smoothInput:1,showRawInput:true},{});assert.equal(plot(engine,'EDGE Spread bps').at(-1),out.at(-1)*10000);
});
test('Bayes training counts stay cumulative, probabilities use three classes and history remains causal',()=>{
 const params={classifierLookbackInput:30,zScoreWindowInput:10,cvdMomentumPeriodInput:3,cvdSlopePeriodInput:3},bars=wave(180),out=evaluateIndicator('naive-bayes-order-flow',bars,params,{mintick});
 const b=plot(out,'P Bull'),s=plot(out,'P Bear'),d=plot(out,'P Diverged');assert.ok(b.every((v,i)=>v>=0&&s[i]>=0&&d[i]>=0&&v+s[i]+d[i]<=1.00000001));assert.ok(b.some(v=>v>.7));assert.match(out.notes.join(' '),/训练累积历史/);
 const prefix=evaluateIndicator('naive-bayes-order-flow',bars.slice(0,130),params,{mintick});for(const p of prefix.plots)assert.deepEqual(plot(out,p.name).slice(0,130),p.values);
 assert.deepEqual(out.signals.filter(s=>s.index<130),prefix.signals);
});
test('source Market OS initialization and Elite Flow last-bar caveats remain explicit',()=>{
 const bars=wave(300),os=evaluateIndicator('market-os',bars,{}, {mintick});assert.equal(os.signals.length,0);assert.match(os.notes.join(' '),/无法初始化/);
 assert.match(evaluateIndicator('elite-flow-pro',bars,{}, {mintick}).notes.join(' '),/barstate.islast/);
 assert.match(evaluateIndicator('elite-advanced-pattern-scanner',bars,{}, {mintick}).notes.join(' '),/不可达/);
});
test('all causal entry signals and non-render plot prefixes ignore later candles',()=>{
 const bars=wave(350);for(const item of catalog.filter(x=>x.id!=='elite-flow-pro')){
  const prefix=evaluateIndicator(item.id,bars.slice(0,280),{}, {mintick}),full=evaluateIndicator(item.id,bars,{}, {mintick});
  assert.deepEqual(full.signals.filter(s=>s.index<280),prefix.signals,item.id+' signals');
  for(const p of prefix.plots)assert.deepEqual(plot(full,p.name).slice(0,280),p.values,item.id+' '+p.name);
 }
});
test('four-point discount and premium scanners preserve symmetry weights, confirmation delay and targets',()=>{
 const anchors=[[0,20],[20,10],[30,15],[40,10],[53,17],[70,16]];
 const fixture=mirror=>Array.from({length:71},(_,i)=>{let k=0;while(k<anchors.length-2&&i>anchors[k+1][0])k++;const [[a,x],[b,y]]=[anchors[k],anchors[k+1]],center=x+(y-x)*(i-a)/(b-a),c=mirror?40-center:center;return {time:Date.UTC(2025,0,1)+i*86400000,open:c-.05,close:c,high:c+.2,low:c-.2,volume:100};});
 const common={vip_left_candles:2,vip_right_candles:2,vip_min_structure_length:6,vip_min_trend_depth:6,vip_min_quality_threshold:0,vip_use_volatility_filter:false,vip_use_momentum_filter:false,vip_use_liquidity_filter:false};
 const bars=fixture(false),params={...common,vip_enable_premium:false},out=evaluateIndicator('elite-advanced-pattern-scanner',bars,params,{mintick});
 assert.equal(out.zones[0].knownIndex,42);assert.deepEqual(out.zones[0].points.map(p=>p.index),[0,20,30,40]);assert.equal(out.zones[0].score,86);assert.equal(out.signals[0].index,50);assert.equal(out.signals[0].side,'long');assert.equal(out.signals[0].stop,null);assert.ok(Math.abs(out.signals[0].target-19.844)<1e-12);
 assert.equal(evaluateIndicator('elite-advanced-pattern-scanner',bars.slice(0,42),params,{mintick}).zones.length,0);
 const premium=evaluateIndicator('elite-advanced-pattern-scanner',fixture(true),{...common,vip_enable_discount:false},{mintick});assert.equal(premium.zones[0].knownIndex,42);assert.equal(premium.signals[0].side,'short');assert.equal(premium.signals[0].index,50);assert.equal(premium.signals[0].score,86);
});
test('declared-but-unused APEX stop parameter never becomes an invented source stop',()=>{
 const bars=wave(450),a=evaluateIndicator('apex-trend-signal-engine',bars,{useLoc:false,adxThr:5}, {mintick}),b=evaluateIndicator('apex-trend-signal-engine',bars,{useLoc:false,adxThr:5,slMult:15}, {mintick});
 assert.deepEqual(a.signals,b.signals);assert.ok(a.signals.every(s=>s.stop===null));assert.match(a.notes.join(' '),/slMult.*未使用/);
 const trend=Array.from({length:300},(_,i)=>{const c=100+Math.sin(i*.19)*8+i*.1;return{time:i*864e5,open:c-.2,close:c,high:c+.2,low:c-.2,volume:100};});
 const os=evaluateIndicator('market-os',trend,{bosReqInput:0,showCGrade:true,pivotInput:5},{mintick});assert.ok(os.signals.length>0);assert.equal(os.signals[0].side,'long');
});
