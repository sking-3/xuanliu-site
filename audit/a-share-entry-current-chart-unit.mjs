import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {writeCurrentChart,writeViprasolCurrentChart} from '../server/a-share-entry-current-chart.mjs';

function calendar(count){const days=[];for(let time=Date.UTC(2024,0,1);days.length<count;time+=86400000){const date=new Date(time);if(date.getUTCDay()!==0&&date.getUTCDay()!==6)days.push(date.toISOString().slice(0,10));}return days;}
const candle=(date,changes={})=>({date,open:100,high:101,low:99,close:100,volume:1000,...changes});
function fixture(stage='waiting_next_session'){
  const dates=calendar(140),bars=dates.map(date=>candle(date)),day=dates.at(-1),formationDay=dates[136],keyBarDay=dates[137];
  bars[136]=candle(formationDay,{low:98});bars[137]=candle(keyBarDay,{open:100.5,high:103,low:100,close:102,volume:1100});bars[139]=candle(day,{open:102,high:105,low:101,close:104});
  const stock={code:'600000.SH',name:'当前机会样本'},item={...stock,setupId:stock.code+':'+formationDay,day,formationDay,keyBarDay,stage,closePrice:104,trigger:{above:103},invalidation:{below:98}};
  return {stock,bars,item};
}
async function output(input,run){const directory=await mkdtemp(join(tmpdir(),'books-current-chart-'));try{await writeCurrentChart({directory,...input});await run({directory,svg:window=>readFile(join(directory,input.stock.code+'-'+input.item.formationDay+'-'+window+'.svg'),'utf8')});}finally{await rm(directory,{recursive:true,force:true});}}

test('current waiting chart anchors only the item C and never imports old B/S or wave markers',async()=>{
  const input=fixture();input.item.markers=[{kind:'B',day:input.bars[85].date},{kind:'S',day:input.bars[100].date},{kind:'ADD',day:input.bars[110].date}];
  await output(input,async({svg})=>{for(const window of [60,120]){
    const image=await svg(window),index=input.bars.slice(-window).findIndex(bar=>bar.date===input.item.keyBarDay),x=Number((76+654/window*(index+.5)).toFixed(2));
    assert.equal([...image.matchAll(/data-candle-day=/g)].length,window);assert.match(image,/viewBox="0 0 960 540"/);assert.match(image,/font-size="28"/);
    assert(image.includes('data-candle-day="'+input.item.keyBarDay+'"><path d="M'+x+' '));assert(image.includes('data-day="'+input.item.keyBarDay+'" data-kind="C"'));
    assert.equal([...image.matchAll(/data-kind=/g)].length,1);assert.doesNotMatch(image,/data-kind="(?:B|S|ADD|REDUCE|INVALID)"/);
    assert.match(image,/data-level="trigger"/);assert.match(image,/data-level="invalidation"/);assert.match(image,/data-level="close"/);assert.match(image,/B 买入参考 [+-]?\d+\.\d+%/);assert.match(image,/S 卖出参考 [+-]?\d+\.\d+%/);assert.match(image,/收盘 [+-]?\d+\.\d+%/);
    assert.match(image,/data-average="5"/);assert.match(image,/data-average="20"/);assert.match(image,/成交量 · 手（相对柱高）/);
  }});
});

test('only triggered_at_close can add B on the exact current daily candle',async()=>{
  const input=fixture('triggered_at_close');await output(input,async({svg})=>{
    for(const window of [60,120]){const image=await svg(window);assert(image.includes('data-day="'+input.item.day+'" data-kind="B"'));assert.equal([...image.matchAll(/data-kind="B"/g)].length,1);assert.match(image,/当日收盘触发观察 · 未核实实际成交/);assert.doesNotMatch(image,/data-kind="(?:S|ADD|REDUCE|INVALID)"/);}
  });
  for(const stage of ['waiting_next_session','waiting_trigger','late_discovery','triggered_observation'])await output({...input,item:{...input.item,stage}},async({svg})=>assert.doesNotMatch(await svg(60),/data-kind="B"/));
});

test('current close must exceed trigger and preserve the fixed invalidation before B is drawn',async()=>{
  for(const changes of [{close:103},{low:97}]){
    const input=fixture('triggered_at_close');Object.assign(input.bars.at(-1),changes);input.item.closePrice=input.bars.at(-1).close;
    await output(input,async({svg})=>{const image=await svg(60);assert.match(image,/data-kind="C"/);assert.doesNotMatch(image,/data-kind="B"/);});
  }
});

test('invalid, stale, short, out-of-order or mismatched price-basis evidence stays explicitly empty',async()=>{
  const original=fixture(),cases=[{bars:[]},{bars:original.bars.slice(-10)},{bars:original.bars.map((bar,index)=>index===130?{...bar,close:NaN}:bar)},{bars:original.bars.slice().reverse()},{bars:original.bars.slice(0,-1)},{item:{...original.item,closePrice:105}},{item:{...original.item,keyBarDay:original.item.formationDay}},{item:{...original.item,trigger:{above:104}}},{item:{...original.item,invalidation:{below:97}}},{item:{...original.item,code:'000001.SZ'}}];
  for(const changes of cases)await output({...original,...changes},async({svg})=>{for(const window of [60,120]){const image=await svg(window);assert.match(image,/暂不绘制/);assert.doesNotMatch(image,/NaN|Infinity|data-candle-day|data-kind=/);}});
});

test('available short suffix discloses its real window and never fills missing candles',async()=>{
  const original=fixture(),bars=original.bars.slice(-25);await output({...original,bars},async({svg})=>{for(const window of [60,120]){const image=await svg(window);assert.equal([...image.matchAll(/data-candle-day=/g)].length,25);assert(image.includes('近'+window+'个交易日日K · 实际25根'));assert.doesNotMatch(image,/NaN|Infinity/);}});
});

test('SVG text is escaped, glyphs remain readable, and no raw OHLCV payload is embedded',async()=>{
  const input=fixture();input.stock.name='当前<&"\'> <script>bad()</script>';
  await output(input,async({svg})=>{const image=await svg(60);assert.match(image,/当前&lt;&amp;&quot;&apos;&gt; &lt;script&gt;/);assert.doesNotMatch(image,/<script|"(?:open|high|low|close|volume|bars)":|data-(?:open|high|low|close|volume)=/);assert.match(image,/font-variant-numeric:tabular-nums/);assert.match(image,/font-size="28"/);});
});

test('only the two requested SVGs and matching atomic gzip artifacts are written',async()=>{
  const input=fixture();await output(input,async({directory})=>{
    const files=await readdir(directory);assert.equal(files.length,4);assert(files.every(file=>file.endsWith('.svg')||file.endsWith('.svg.gz')));
    for(const window of [60,120]){const file=join(directory,input.stock.code+'-'+input.item.formationDay+'-'+window+'.svg');assert.deepEqual(gunzipSync(await readFile(file+'.gz')),await readFile(file));}
  });
});

function nativeFixture(){
  const {stock,bars}=fixture(),day=bars.at(-1).date,ruleId='tyson';
  return {stock,bars,item:{code:stock.code,name:stock.name,day,signalDay:day,ruleId,familyId:'viprasol-original-long-next-open-13',stage:'source_today_long_close',eligibleForSelection:true,actualFillVerified:false,closePrice:bars.at(-1).close,originalReference:{entry:104,stop:null,target:null}},paths:Object.fromEntries([60,120].map(window=>[window,ruleId+'-'+stock.code+'-'+day+'-'+window+'.svg']))};
}

test('native current chart marks only the source-day B without inventing C, historical signals or missing levels',async t=>{
  const input=nativeFixture(),directory=await mkdtemp(join(tmpdir(),'books-native-current-chart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeViprasolCurrentChart({directory,...input});
  for(const window of [60,120]){
    const file=join(directory,input.paths[window]),image=await readFile(file,'utf8');
    assert.equal([...image.matchAll(/data-kind="B"/g)].length,1);assert(image.includes('data-day="'+input.item.day+'" data-kind="B"'));
    assert.doesNotMatch(image,/data-kind="(?:C|S|ADD|REDUCE|INVALID)"|data-level="(?:invalidation|target)"|NaN|Infinity/);
    assert.match(image,/data-level="entry"/);assert.match(image,/data-normalization="first-close-percent"/);
    assert.equal([...image.matchAll(/data-candle-day=/g)].length,window);
    assert.doesNotMatch(image,/"(?:open|high|low|close|volume|bars)":|data-(?:open|high|low|close|volume)=/);
    assert.deepEqual(gunzipSync(await readFile(file+'.gz')),await readFile(file));
  }
});

test('native chart rejects unqualified, stale-source, mismatched price or unbound path inputs',async t=>{
  const input=nativeFixture(),directory=await mkdtemp(join(tmpdir(),'books-native-current-reject-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  for(const item of [{...input.item,eligibleForSelection:false},{...input.item,actualFillVerified:true},{...input.item,signalDay:input.bars.at(-2).date},{...input.item,closePrice:105},{...input.item,familyId:'fixed-16'}])await assert.rejects(writeViprasolCurrentChart({directory,...input,item}),/同日合格证据/);
  await assert.rejects(writeViprasolCurrentChart({directory,...input,paths:{60:'other.svg',120:input.paths[120]}}),/路径未绑定/);
  assert.deepEqual(await readdir(directory),[]);
});

test('display-window captions explain sixty or120 actual trading-session candles without changing the selected evidence or C into today B',async()=>{
 const input=fixture();await output(input,async({svg})=>{for(const window of [60,120]){const image=await svg(window);assert(image.includes('近'+window+'个交易日日K'));assert.match(image,/仅显示窗口，非持有期或预测期/);assert.match(image,/C为收盘确认，非当日B/);assert.match(image,/C · .*本次收盘确认，非当日B/);assert(image.includes('data-day="'+input.item.keyBarDay+'" data-kind="C"'));assert.doesNotMatch(image,/data-kind="(?:B|S)"/);assert.equal((image.match(/data-candle-day=/g)||[]).length,window);}});
});

test('native B/S reference labels stay in their right column and bounded lanes when three levels cluster below a distant target',async t=>{
 const input=nativeFixture(),directory=await mkdtemp(join(tmpdir(),'books-current-label-lanes-'));t.after(()=>rm(directory,{recursive:true,force:true}));input.item.originalReference={entry:104.01,stop:104,target:400};const before=structuredClone(input);await writeViprasolCurrentChart({directory,...input});
 for(const window of [60,120]){const image=await readFile(join(directory,input.paths[window]),'utf8'),labels=[...image.matchAll(/<g data-level="([^"]+)">[\s\S]*?<text x="754" y="([\d.]+)"[^>]*font-size="18">([^<]+)<\/text>/g)];assert.equal(labels.length,4);const ys=labels.map(match=>Number(match[2])).sort((a,b)=>a-b);assert(ys[0]>=106);assert(ys.at(-1)<=338);for(let i=1;i<ys.length;i++)assert(ys[i]-ys[i-1]>=33.99);assert(labels.some(match=>match[3].startsWith('B 买入参考 ')));assert(labels.some(match=>match[3].startsWith('S 卖出参考 ')));assert.doesNotMatch(image,/data-kind="S"/);assert.equal([...image.matchAll(/data-kind="B"/g)].length,1);}
 assert.deepEqual(input,before);
});
