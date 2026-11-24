import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {writeCurrentChart} from '../server/a-share-entry-current-chart.mjs';

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
    assert.match(image,/data-level="trigger"/);assert.match(image,/data-level="invalidation"/);assert.match(image,/data-level="close"/);assert.match(image,/触发 [+-]?\d+\.\d+%/);assert.match(image,/失效 [+-]?\d+\.\d+%/);assert.match(image,/收盘 [+-]?\d+\.\d+%/);
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
  const original=fixture(),bars=original.bars.slice(-25);await output({...original,bars},async({svg})=>{for(const window of [60,120]){const image=await svg(window);assert.equal([...image.matchAll(/data-candle-day=/g)].length,25);assert(image.includes('25日 · 不足'+window+'日'));assert.doesNotMatch(image,/NaN|Infinity/);}});
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
