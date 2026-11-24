import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {saveSignalCharts,signalChartVersion} from '../server/a-share-signal-chart.mjs';

function calendar(count){const dates=[];for(let time=Date.UTC(2024,0,1);dates.length<count;time+=86400000){const day=new Date(time);if(day.getUTCDay()!==0&&day.getUTCDay()!==6)dates.push(day.toISOString().slice(0,10));}return dates;}
const candle=(date,changes={})=>({date,open:100,high:101,low:99,close:100,volume:1000,...changes});
function fixture(){
  const dates=calendar(140),bars=dates.map(day=>candle(day)),reference=dates.map(day=>candle(day)),day=dates.at(-1);
  bars[83]=candle(dates[83],{open:99.5,high:101,low:98,close:100.5});
  bars[84]=candle(dates[84],{open:100.5,high:103,low:100,close:102,volume:1100});
  bars[85]=candle(dates[85],{open:102,high:104,low:101,close:103.5});
  bars[87]=candle(dates[87],{open:101,high:105,low:100,close:104});
  const setup={id:'600000.SH:'+dates[83],patternIds:['regain-ma-20'],replayStatus:'triggered_observation',status:'late_discovery',formation:{...bars[83]},keyBar:{...bars[84]},observedEvent:{date:dates[85]},trigger:{above:103},invalidation:{below:98},knownAt:day+'T08:00:00Z',lateDiscovery:true};
  return {stock:{code:'600000.SH',name:'真实规则离线单测'},bars,setups:[setup],reference,dates,generation:day+'-1',sourceId:'tickflow-free-forward-v1',day,asOf:day+'T08:30:00Z',sourceFetchedAt:day+'T08:00:00Z',priceBasis:{adjustment:'qfq',label:'前复权研究参考价'}};
}
async function output(input,run){const target=await mkdtemp(join(tmpdir(),'books-signal-chart-'));try{const metadata=await saveSignalCharts({target,...input});await run({target,metadata,svg:window=>readFile(join(target,'signals',input.stock.code+'-'+window+'.svg'),'utf8')});}finally{await rm(target,{recursive:true,force:true});}}

test('metadata binds the batch and retains research evidence without exposing raw OHLCV',async()=>{
  const input=fixture();await output(input,async({target,metadata})=>{
    assert.equal(metadata.schema,'books.a-share.entry-signals.v1');assert.equal(metadata.version,signalChartVersion);assert.equal(metadata.chartAvailable,true);
    for(const key of ['generation','sourceId','day','asOf','sourceFetchedAt','priceBasis'])assert.deepEqual(metadata[key],input[key]);
    assert.deepEqual(metadata.windows,[60,120]);assert.deepEqual(metadata.chartRanges,{60:{from:input.dates[80],to:input.day},120:{from:input.dates[20],to:input.day}});
    const buy=metadata.markers.find(item=>item.kind==='B'),sell=metadata.markers.find(item=>item.kind==='S');
    assert.equal(buy.day,input.dates[85]);assert.equal(sell.day,input.dates[100]);assert.equal(buy.label,'B触发观察');assert.equal(sell.label,'S15日退出观察');
    assert.equal(buy.actualDiscoveryAt,input.setups[0].knownAt);assert.equal(buy.lateDiscovery,true);assert.equal(buy.evidence[0].lateDiscovery,true);
    for(const marker of metadata.markers){assert.equal(marker.state,'research');assert.equal(marker.actualFillVerified,false);assert.equal(marker.independentlyValidated,false);assert.equal(marker.recommended,false);assert(marker.evidence.length);}
    const serialized=await readFile(join(target,'signals',input.stock.code+'.json'),'utf8');
    assert.doesNotMatch(serialized,/"(?:bars|open|high|low|close|volume|ohlc|candles)"/i);assert.deepEqual(JSON.parse(serialized),metadata);
  });
});

test('60 and 120 charts use real session windows and anchor B/S to their actual candle coordinates',async()=>{
  const input=fixture();await output(input,async({metadata,svg})=>{
    for(const window of [60,120]){
      const image=await svg(window),view=input.bars.slice(-window);
      assert.equal([...image.matchAll(/data-candle-day=/g)].length,window);assert.match(image,/viewBox="0 0 960 /);assert.match(image,/font-size="28"/);
      assert.match(image,/data-average="5"/);assert.match(image,/data-average="20"/);assert.match(image,/成交量 · 手（相对柱高）/);assert.match(image,/归一化涨跌幅/);assert.match(image,/\d+(?:\.\d+)?%/);
      for(const kind of ['B','S']){
        const marker=metadata.markers.find(item=>item.kind===kind),index=view.findIndex(bar=>bar.date===marker.day),xx=Number((76+854/window*(index+.5)).toFixed(2));
        assert(image.includes('data-candle-day="'+marker.day+'"><path d="M'+xx+' '));
        assert.match(image,new RegExp('data-day="'+marker.day+'" data-kind="'+kind+'" data-state="research">[\\s\\S]*?<circle cx="'+xx+'"'));
        assert(image.includes(marker.label+' · '+marker.day+' · research研究观察 · 未核实实际成交'));
      }
      assert.doesNotMatch(image,/(?:NaN|Infinity|<script|data-(?:open|high|low|close|volume)=|"bars":)/);assert.match(image,/fill="#fff" stroke=/);
    }
  });
});

test('merged markers retain each discovery and surface the latest actual discovery without hiding late evidence',async()=>{
  const input=fixture(),first=input.setups[0],latest=input.day+'T10:00:00Z';
  input.setups.push({...first,id:first.id+':second',knownAt:latest,lateDiscovery:false});
  await output(input,async({metadata})=>{
    const marker=metadata.markers.find(item=>item.kind==='B');assert.equal(marker.evidence.length,2);assert.equal(marker.actualDiscoveryAt,latest);assert.equal(marker.lateDiscovery,true);assert(marker.evidence.some(item=>item.actualDiscoveryAt===first.knownAt&&item.lateDiscovery));
  });
});

test('raw and gzip artifacts match, and completed writes leave no temporary files',async()=>{
  const input=fixture();await output(input,async({target})=>{
    const directory=join(target,'signals'),files=await readdir(directory);assert.equal(files.length,6);assert(files.every(file=>!file.endsWith('.tmp')));
    for(const name of [input.stock.code+'.json',input.stock.code+'-60.svg',input.stock.code+'-120.svg'])assert.deepEqual(gunzipSync(await readFile(join(directory,name+'.gz'))),await readFile(join(directory,name)));
  });
});

test('missing, short, invalid, duplicate, unordered and stale bars produce explicit empty charts',async()=>{
  const original=fixture(),cases=[[],original.bars.slice(-10),original.bars.map((bar,index)=>index===135?{...bar,high:90}:bar),original.bars.map((bar,index)=>index===135?{...bar,close:NaN}:bar),original.bars.map((bar,index)=>index===135?{...bar,volume:-1}:bar),[...original.bars.slice(0,80),original.bars[79],...original.bars.slice(81)],original.bars.slice().reverse(),original.bars.slice(0,-1)];
  for(const bars of cases)await output({...original,bars},async({metadata,svg})=>{
    assert.equal(metadata.chartAvailable,false);assert.deepEqual(metadata.markers,[]);assert.deepEqual(metadata.groups,[]);assert.deepEqual(metadata.chartRanges,{60:null,120:null});
    for(const window of [60,120]){const image=await svg(window);assert.match(image,/主图暂不可用/);assert.doesNotMatch(image,/(?:NaN|Infinity|data-candle-day|data-day=)/);}
  });
});

test('old bad prices do not blank the current chart, and recent gaps shorten rather than bridge it',async()=>{
  const original=fixture(),dates=calendar(500),bars=dates.map(day=>candle(day)),day=dates.at(-1),input={...original,bars,dates,day,setups:[],reference:dates.map(day=>candle(day))};
  bars[0]=candle(dates[0],{open:0,high:0,low:0,close:0,volume:0});
  await output(input,async({metadata,svg})=>{assert.equal(metadata.chartAvailable,true);assert.equal([...((await svg(120)).matchAll(/data-candle-day=/g))].length,120);assert.equal(metadata.chartRanges[120].from,dates[380]);});
  bars[450]=candle(dates[450],{close:NaN});
  await output(input,async({metadata,svg})=>{assert.equal(metadata.chartAvailable,true);assert.equal(metadata.chartRanges[120].from,dates[451]);const image=await svg(120);assert.equal([...image.matchAll(/data-candle-day=/g)].length,49);assert.match(image,/49日 · 不足120日/);assert.doesNotMatch(image,/NaN|Infinity/);});
  bars[485]=candle(dates[485],{low:0});
  await output(input,async({metadata,svg})=>{assert.equal(metadata.chartAvailable,false);assert.match(await svg(60),/不足20根/);});
});

test('twenty valid current bars render only the available candles and disclose the short window',async()=>{
  const original=fixture(),bars=original.bars.slice(-20);await output({...original,bars,setups:[]},async({metadata,svg})=>{
    assert.equal(metadata.chartAvailable,true);assert.deepEqual(metadata.chartRanges,{60:{from:bars[0].date,to:original.day},120:{from:bars[0].date,to:original.day}});
    for(const window of [60,120]){const image=await svg(window);assert.equal([...image.matchAll(/data-candle-day=/g)].length,20);assert(image.includes('20日 · 不足'+window+'日'));}
  });
});

test('a calendar hole is aligned as missing, never shifted into a different B/S date',async()=>{
  const original=fixture(),bars=original.bars.filter(bar=>bar.date!==original.dates[84]);await output({...original,bars},async({metadata,svg})=>{
    assert.equal(metadata.chartAvailable,true);assert.equal(metadata.markers.length,0);assert.equal(metadata.chartRanges[120].from,original.dates[85]);const image=await svg(60);assert.doesNotMatch(image,/data-day=/);assert.equal([...image.matchAll(/data-candle-day=/g)].length,55);
  });
});

test('names and special characters are XML escaped without changing the stored stock identity',async()=>{
  const original=fixture(),name='测试<&"\' > <script>alert(1)</script>';await output({...original,stock:{...original.stock,name}},async({metadata,svg})=>{
    assert.equal(metadata.stock.name,name);const image=await svg(60);assert.match(image,/测试&lt;&amp;&quot;&apos; &gt; &lt;script&gt;/);assert.doesNotMatch(image,/<script/);assert.match(image,/font-variant-numeric:tabular-nums/);
  });
});
