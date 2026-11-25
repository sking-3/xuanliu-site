import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare} from '../server/a-share-pattern-regimes.mjs';
import {analyzeDailyPrefix,definitions,version} from '../server/a-share-daily-setups.mjs';

const dates=[];for(let time=Date.parse('2026-11-25T00:00:00Z');dates.length<100;time-=86400000){const date=new Date(time);if(![0,6].includes(date.getUTCDay()))dates.unshift(date.toISOString().slice(0,10));}
const stock={code:'600001.SH',name:'普通主板合成样本',listingDate:'2000-01-01'};
function bars(closes=dates.map((_,i)=>10+i*.015)){return closes.map((close,i)=>({date:dates[i],open:close-.025,high:close+.1,low:close-.1,close,volume:100}));}
function series(input=bars(),reference=bars(dates.map(()=>10))){const value=prepare(input,dates);if(reference)value.referenceBars=reference;return value;}
function analyze(input=bars(),options={}){return analyzeDailyPrefix(series(input,options.reference),options.index??99,options.stock||stock);}
function rangeBars(){const result=bars(dates.map((_,i)=>10+.4*Math.sin(i*Math.PI/10)));for(const bar of result){bar.open=bar.close-.02;bar.high=bar.close+.03;bar.low=bar.close-.03;}result[99]={date:dates[99],open:9.8,high:10,low:9.63,close:9.95,volume:100};return result;}
function reclaimBars(){const result=bars(dates.map((_,i)=>12-i*.02));for(const bar of result){bar.open=bar.close+.02;bar.high=bar.close+.04;bar.low=bar.close-.04;}result[99]={date:dates[99],open:10.08,high:10.2,low:9.99,close:10.16,volume:100};return result;}
function limitBars(count=1){const result=bars(dates.map(()=>10));let price=10;for(let i=100-count;i<100;i++){price=Math.round(price*110)/100;result[i]={date:dates[i],open:price-.3,high:price,low:price-.5,close:price,volume:100};}return result;}

test('exports exactly four fixed descriptive models and source-bound prefix metrics',()=>{
 assert.equal(version,'books.a-share.daily-setups.2026-11-25.v1');assert.deepEqual(definitions.map(item=>item.id),['trend-pullback','trend-continuation','range-support','support-reclaim']);assert(definitions.every(item=>item.label&&item.description));
 const {metrics:m}=analyze();assert.equal(m.historySize,100);assert.equal(m.availableBarCount,100);assert.equal(m.historyEnd,dates[99]);assert.equal(m.historyStart,dates[0]);assert.equal(m.close,11.485);assert.equal(m.prevClose,11.47);assert.equal(m.volumeRatio20,1);assert(m.ma5>m.ma20&&m.ma20>m.ma60);assert(m.ma20Slope5Percent>0&&m.ma60Slope5Percent>0);assert.equal(m.benchmarkReturn20,0);assert.equal(m.excess20,m.return20);assert.equal(m.valid.history65,true);assert.equal(m.valid.benchmark21,true);assert(m.atr14>0);assert.equal(m.atrMethod,'simple_mean_true_range_14');
});
test('all classifications, levels, moving averages and sample boundaries are unchanged by any future suffix',()=>{
 const input=rangeBars(),reference=bars(dates.map(()=>10)),full=series(input,reference),index=80,original=analyzeDailyPrefix(full,index,stock),changed=structuredClone(input),changedReference=structuredClone(reference);
 for(let i=index+1;i<100;i++){changed[i]={...changed[i],open:1,high:1e6,low:.001,close:900000,volume:1e9};changedReference[i]={...changedReference[i],open:1,high:1e8,low:.001,close:90000000,volume:1e9};}
 assert.deepEqual(analyzeDailyPrefix(series(changed,changedReference),index,stock),original);
 const prefix=prepare(input.slice(0,index+1),dates.slice(0,index+1));prefix.referenceBars=reference.slice(0,index+1);assert.deepEqual(analyzeDailyPrefix(prefix,index,stock),original);assert.equal(original.metrics.historySize,81);
});
test('rising MA20/60 pullbacks and continuations remain unqualified next-session conditions with positive ordered price zones',()=>{
 const result=analyze();assert(result.setups.some(item=>item.id==='trend-pullback'));assert(result.setups.some(item=>item.id==='trend-continuation'));
 for(const item of result.setups){assert.equal(item.qualified,false);assert.equal(item.actualFillVerified,false);assert.equal(item.modelState,'next_session_watch');assert(item.invalidation>0&&item.invalidation<item.trigger);assert(item.buyZone.low>0&&item.buyZone.low<=item.buyZone.high);assert(item.reduceZone===null||item.reduceZone.low>=item.trigger&&item.reduceZone.low<=item.reduceZone.high);}
});
test('missing or nonaligned actual benchmark never turns missing excess into zero or qualifies continuation',()=>{
 const missing=series();delete missing.referenceBars;const first=analyzeDailyPrefix(missing,99,stock);assert.equal(first.metrics.benchmarkReturn20,null);assert.equal(first.metrics.excess20,null);assert.equal(first.metrics.valid.benchmark21,false);assert(first.setups.some(item=>item.id==='trend-pullback'));assert(!first.setups.some(item=>item.id==='trend-continuation'));
 const reference=bars(dates.map(()=>10));reference[90]={...reference[90],date:dates[89]};const mismatched=analyze(bars(),{reference});assert.equal(mismatched.metrics.excess20,null);assert(!mismatched.setups.some(item=>item.id==='trend-continuation'));
 const stronger=analyze(bars(),{reference:bars(dates.map((_,i)=>10+i*.04))});assert(stronger.metrics.excess20<0);assert(!stronger.setups.some(item=>item.id==='trend-continuation'));
});
test('range support uses a pre-existing box and can create a bottom-position T plan without a recent MA crossover or an early B',()=>{
 const result=analyze(rangeBars()),setup=result.setups.find(item=>item.id==='range-support');assert(setup);assert(result.metrics.ma5<result.metrics.ma20);assert.equal(setup.modelState,'existing_position_T_watch');assert.equal(setup.qualified,false);assert.match(setup.reason.join(' '),/已有可卖底仓.*不是早盘B/);assert(setup.reduceZone);assert(setup.reduceZone.high===result.metrics.prior20High);assert(setup.buyZone.low===result.metrics.prior20Low);assert(setup.trigger===10);assert(result.metrics.prior20High<10.5&&result.metrics.prior20Low>9.5);
});
test('a box that is too narrow or whose current candle does not reclaim its lower zone is not a T setup',()=>{
 const narrow=bars(dates.map((_,i)=>10+.04*Math.sin(i*Math.PI/10)));assert(!analyze(narrow).setups.some(item=>item.id==='range-support'));
 const high=rangeBars();high[99]={date:dates[99],open:10.2,high:10.3,low:10.15,close:10.25,volume:100};assert(!analyze(high).setups.some(item=>item.id==='range-support'));
});
test('a real low-area recovery is explicitly countertrend and does not assert a main-player action or reversal',()=>{
 const result=analyze(reclaimBars()),setup=result.setups.find(item=>item.id==='support-reclaim');assert(setup);assert.equal(setup.modelState,'countertrend_watch');assert(result.metrics.ma20<result.metrics.ma60);assert.match(setup.reason.join(' '),/不(?:断言|表示).*主力/);assert.equal(setup.qualified,false);assert(setup.invalidation<result.metrics.low);
 const noRecovery=reclaimBars();noRecovery[99]={...noRecovery[99],close:10.01,open:10.02,high:10.06};assert(!analyze(noRecovery).setups.some(item=>item.id==='support-reclaim'));
});
test('all four classes share the unchanged 8/15/8 price limits, including their exact floating-point boundaries',()=>{
 const five=bars(dates.map(()=>10));five[99]={date:dates[99],open:10.1,high:10.85,low:10,close:10.8,volume:100};assert(!analyze(five).metrics.reasons.some(reason=>reason.includes('防热上限')));five[99].close=10.800001;assert.equal(analyze(five).setups.length,0);assert(analyze(five).metrics.reasons.some(reason=>reason.includes('防热上限')));
 const twenty=bars(dates.map((_,i)=>i>=80?11.2:10));twenty[99]={date:dates[99],open:11.3,high:11.6,low:11.2,close:11.5,volume:100};assert(!analyze(twenty).metrics.reasons.some(reason=>reason.includes('防热上限')));twenty[99].close=11.500001;assert.equal(analyze(twenty).setups.length,0);assert(analyze(twenty).metrics.reasons.some(reason=>reason.includes('防热上限')));
 const deviation=bars(dates.map(()=>10.1));for(let i=80;i<99;i++)deviation[i]={date:dates[i],open:9.94,high:10.2,low:9.9,close:i===94?10.1:9.95,volume:100};deviation[99]={date:dates[99],open:10.7,high:10.9,low:9.95,close:10.8,volume:100};assert(!analyze(deviation).metrics.reasons.some(reason=>reason.includes('防热上限')));deviation[99].close=10.800001;assert.equal(analyze(deviation).setups.length,0);assert(analyze(deviation).metrics.reasons.some(reason=>reason.includes('防热上限')));
});
test('missing, suspended or zero-price sessions are never bridged into price plans or benchmark excess',()=>{
 const input=bars();input.splice(90,1);const missing=analyze(input);assert.equal(missing.metrics.valid.history61,false);assert.equal(missing.metrics.excess20,null);assert.deepEqual(missing.setups,[]);
 const zero=bars();zero[99].volume=0;const halted=analyze(zero);assert.equal(halted.metrics.close,null);assert.equal(halted.metrics.valid.current,false);assert.equal(halted.limitUp.atLimit,null);assert.deepEqual(halted.setups,[]);
 const previous=limitBars();previous.splice(98,1);assert.equal(analyze(previous).limitUp.status,'unknown');assert.equal(analyze(previous).limitUp.consecutiveCount,null);
 const absent=bars();absent.pop();const last=analyze(absent);assert.equal(last.metrics.valid.current,false);assert.equal(last.metrics.close,null);assert.equal(last.metrics.historyEnd,dates[99]);assert.deepEqual(last.setups,[]);
});
test('non-mainboard, ST, recently listed and unknown-listing stocks remain excluded or unknown without invented limits',()=>{
 for(const changed of [{code:'300001.SZ'},{name:'*ST 合成样本'},{listingDate:dates[96]},{listingDate:null}]){const result=analyze(bars(),{stock:{...stock,...changed}});assert.deepEqual(result.setups,[]);assert.equal(result.metrics.valid.stockEligible,false);assert.equal(result.limitUp.atLimit,null);assert(['unknown','excluded'].includes(result.limitUp.status));}
 const young=analyze(limitBars(),{stock:{...stock,listingDate:dates[95]}});assert.equal(young.limitUp.status,'excluded');const sixth=analyze(limitBars(),{stock:{...stock,listingDate:dates[94]}});assert.equal(sixth.limitUp.status,'ready');
});
test('first observed and consecutive daily close-limit proxies require a known earlier non-limit session',()=>{
 const first=analyze(limitBars()).limitUp;assert.equal(first.atLimit,true);assert.equal(first.stage,'first_observed');assert.equal(first.consecutiveCount,1);assert.equal(first.officialLimitPriceVerified,false);
 const second=analyze(limitBars(2)).limitUp;assert.equal(second.atLimit,true);assert.equal(second.stage,'consecutive');assert.equal(second.consecutiveCount,2);
 const gap=limitBars(2);gap.splice(97,1);const unknown=analyze(gap).limitUp;assert.equal(unknown.atLimit,true);assert.equal(unknown.stage,'unknown');assert.equal(unknown.consecutiveCount,null);
 const beginning=series(limitBars(100));const boundary=analyzeDailyPrefix(beginning,8,stock).limitUp;assert.equal(boundary.atLimit,true);assert.equal(boundary.stage,'unknown');assert.equal(boundary.consecutiveCount,null);
});
test('an at-limit setup and one-price candle can only mean next-session recheck, never a currently executable buy',()=>{
 const input=bars(dates.map((_,i)=>i>=80?10.4:9.8));input[98]={date:dates[98],open:10.1,high:10.2,low:9.95,close:10,volume:100};input[99]={date:dates[99],open:10.6,high:11,low:10.3,close:11,volume:100};const result=analyze(input);assert.equal(result.limitUp.atLimit,true);assert(result.setups.length);assert(result.setups.every(item=>item.modelState==='limit_up_next_session_recheck'&&!item.qualified&&!item.actualFillVerified));
 input[99]={date:dates[99],open:11,high:11,low:11,close:11,volume:100};const flat=analyze(input);assert.equal(flat.limitUp.onePrice,true);assert(flat.setups.every(item=>item.modelState==='limit_up_next_session_recheck'));assert(!JSON.stringify(flat.setups).includes('current_buy'));
});
test('future highs never become reduction targets, and an unknown higher pressure remains null',()=>{
 const input=bars();input[99]={date:dates[99],open:11.4,high:11.8,low:11.3,close:11.7,volume:100};const result=analyze(input);assert(result.setups.length);assert(result.setups.every(item=>item.reduceZone===null));assert(result.metrics.prior20High<11.8);
});
test('classifications do not contain per-stock thresholds and never mutate prepared arrays or the stock metadata',()=>{
 const input=series(rangeBars()),before={prices:[...input.prices],volumes:[...input.volumes],bars:structuredClone(input.bars)},meta=structuredClone(stock),one=analyzeDailyPrefix(input,99,stock),other=analyzeDailyPrefix(input,99,{...stock,code:'601398.SH',name:'另一只普通主板合成样本'});assert.deepEqual(one,other);assert.deepEqual(stock,meta);assert.deepEqual([...input.prices],before.prices);assert.deepEqual([...input.volumes],before.volumes);assert.deepEqual(input.bars,before.bars);
});
test('warmup and flat ranges report unavailable metrics instead of numerical infinity or manufactured setups',()=>{
 const early=analyze(bars(),{index:10});assert.equal(early.metrics.historySize,11);assert.equal(early.metrics.ma60,null);assert.equal(early.metrics.atr14,null);assert.equal(early.metrics.return60,null);assert.deepEqual(early.setups,[]);
 const input=bars(dates.map(()=>10));for(const bar of input)bar.open=bar.high=bar.low=bar.close=10;const flat=analyze(input);assert.equal(flat.metrics.rangePosition60Percent,null);assert.equal(flat.metrics.atr14,0);assert.equal(flat.metrics.valid.atr14,false);assert.deepEqual(flat.setups,[]);
});
