import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {buildEntryMarkers} from './a-share-entry-markers.mjs';

export const signalChartVersion='entry-signals-v1';
const labels={B:'B触发观察',S:'S15日退出观察',ADD:'+加仓观察',REDUCE:'−减仓观察',INVALID:'X条件失效'};
const symbols={B:'B',S:'S',ADD:'+',REDUCE:'−',INVALID:'X'};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const number=value=>Number(value.toFixed(2));
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validBar=bar=>bar&&validDay(bar.date)&&['open','high','low','close'].every(key=>Number.isFinite(bar[key])&&bar[key]>0)&&Number.isFinite(bar.volume)&&bar.volume>=0&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close)&&bar.high>=bar.low;

async function save(file,value){
  const body=typeof value==='string'?value:JSON.stringify(value);
  await writeFile(file+'.tmp',body);await rename(file+'.tmp',file);
  await writeFile(file+'.gz.tmp',gzipSync(body));await rename(file+'.gz.tmp',file+'.gz');
}

function chart({stock,bars,markers,window,available,reason}){
  const width=960,left=76,right=width-30,start=available?Math.max(0,bars.length-window):0,view=available?bars.slice(start):[],step=(right-left)/(view.length||1),x=index=>left+step*(index+.5);
  const byDay=new Map(view.map((bar,index)=>[bar.date,{bar,index}])),lanes={above:[],below:[]},positions=[];
  for(const marker of markers){
    const found=byDay.get(marker.day);if(!found||!labels[marker.kind])continue;
    const side=['B','ADD'].includes(marker.kind)?'below':'above',slots=lanes[side],xx=x(found.index);
    let lane=slots.findIndex(last=>xx-last>=42);if(lane<0)lane=slots.length;slots[lane]=xx;
    positions.push({marker,...found,below:side==='below',lane});
  }
  const top=78+lanes.above.length*42,bottom=top+230,volumeTop=bottom+lanes.below.length*42+44,volumeBottom=volumeTop+54,height=volumeBottom+50;
  const title=(stock.name||stock.code)+' · 日K与研究信号',parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${escape(title)}</title><desc id="desc">窗口首日收盘归一化；B、S及加减仓均为日线研究观察，未经独立验证，未核实实际成交。</desc><rect width="${width}" height="${height}" fill="#fff"/><g font-family="system-ui,sans-serif" font-size="13" fill="#53636e" style="font-variant-numeric:tabular-nums"><text x="${left}" y="26">${escape(title)}</text>`];
  if(!available){
    parts.push(`<text x="${left}" y="90">${escape(reason)}</text></g></svg>`);return parts.join('');
  }
  const base=view[0].close,pct=value=>(value/base-1)*100;
  const averages=new Map([5,20].map(period=>[period,bars.map((bar,index)=>index+1<period?null:bars.slice(index+1-period,index+1).reduce((sum,item)=>sum+item.close,0)/period)]));
  const values=view.flatMap(bar=>[pct(bar.low),pct(bar.high)]);
  for(const average of averages.values())for(const value of average.slice(start))if(value!==null)values.push(pct(value));
  const low=Math.min(...values),high=Math.max(...values),range=Math.max(high-low,1),minimum=low-range*.12,maximum=high+range*.12,y=value=>bottom-(pct(value)-minimum)/(maximum-minimum)*(bottom-top);
  parts.push(`<text x="${left}" y="48">${view.length}日${view.length<window?' · 不足'+window+'日':''} · 归一化涨跌幅</text><text x="${right-132}" y="26" fill="#9c783f">MA5</text><text x="${right-65}" y="26" fill="#606a89">MA20</text>`);
  for(let i=0;i<5;i++){
    const value=minimum+(maximum-minimum)*i/4,yy=bottom-(bottom-top)*i/4;
    parts.push(`<path d="M${left} ${number(yy)}H${right}" stroke="#e5e9eb"/><text x="${left-8}" y="${number(yy+4)}" text-anchor="end">${number(value)}%</text>`);
  }
  if(minimum<=0&&maximum>=0)parts.push(`<path d="M${left} ${number(y(base))}H${right}" stroke="#aeb9bf" stroke-dasharray="3 4"/>`);
  const candleWidth=Math.max(2,Math.min(step*.6,10)),maxVolume=Math.max(...view.map(bar=>bar.volume),1);
  for(const [index,bar]of view.entries()){
    const xx=number(x(index)),color=bar.close>=bar.open?'#be4d52':'#16816e',open=y(bar.open),close=y(bar.close),volumeHeight=bar.volume/maxVolume*(volumeBottom-volumeTop);
    parts.push(`<g data-candle-day="${bar.date}"><path d="M${xx} ${number(y(bar.high))}V${number(y(bar.low))}" stroke="${color}"/><rect x="${number(xx-candleWidth/2)}" y="${number(Math.min(open,close))}" width="${number(candleWidth)}" height="${number(Math.max(Math.abs(close-open),1))}" fill="${color}"/><rect x="${number(xx-candleWidth/2)}" y="${number(volumeBottom-volumeHeight)}" width="${number(candleWidth)}" height="${number(volumeHeight)}" fill="${color}" opacity=".4"/></g>`);
  }
  for(const [period,average]of averages){
    const points=average.slice(start).map((value,index)=>value===null?null:[number(x(index)),number(y(value))]).filter(Boolean);
    if(points.length)parts.push(`<path data-average="${period}" d="${points.map((point,index)=>(index?'L':'M')+point.join(' ')).join('')}" fill="none" stroke="${period===5?'#9c783f':'#606a89'}" stroke-width="1.3"/>`);
  }
  for(const {marker,bar,index,below,lane}of positions){
    const xx=number(x(index)),edge=y(below?bar.low:bar.high),yy=number(edge+(below?1:-1)*(25+lane*42)),color=below?'#216d5f':'#995147',label=labels[marker.kind];
    parts.push(`<g id="${escape('marker-'+marker.id)}" data-day="${marker.day}" data-kind="${marker.kind}" data-state="research"><title>${escape(label+' · '+marker.day+' · research研究观察 · 未核实实际成交')}</title><path d="M${xx} ${number(edge)}V${number(yy+(below?-17:17))}" stroke="${color}" stroke-width="1"/><circle cx="${xx}" cy="${yy}" r="18" fill="#fff" stroke="${color}" stroke-width="1.2"/><text x="${xx}" y="${number(yy+10)}" fill="${color}" text-anchor="middle" font-size="28" font-weight="600">${symbols[marker.kind]}</text></g>`);
  }
  parts.push(`<path d="M${left} ${volumeTop-10}H${right}" stroke="#e5e9eb"/><text x="${left}" y="${volumeTop-15}">成交量 · 手（相对柱高）</text>`);
  for(const index of [...new Set([0,Math.floor((view.length-1)/2),view.length-1])])parts.push(`<text x="${number(x(index))}" y="${height-20}" text-anchor="${index===0?'start':index===view.length-1?'end':'middle'}" font-size="22">${view[index].date}</text>`);
  parts.push('</g></svg>');return parts.join('');
}

/** Precomputed derived charts only: original OHLCV stays in the private archive. */
export async function saveSignalCharts({target,stock,bars,setups,reference,dates,generation,sourceId,day,asOf,sourceFetchedAt,priceBasis}){
  const ordered=Array.isArray(bars)&&bars.length>0&&bars.every((bar,index)=>validDay(bar?.date)&&(!index||bar.date>bars[index-1].date));
  const byDay=new Map(ordered?bars.map(bar=>[bar.date,bar]):[]),end=ordered?dates.indexOf(bars.at(-1).date):-1;let start=end;
  while(start>=0&&validBar(byDay.get(dates[start])))start--;
  const chartBars=end<0?[]:dates.slice(start+1,end+1).map(date=>byDay.get(date));
  const chartAvailable=chartBars.length>=20&&chartBars.at(-1).date===day;
  const reason=!ordered||!chartBars.length?'本批日线缺失或无效，主图暂不可用':chartBars.at(-1).date!==day?'日线未覆盖本批数据日，主图暂不可用':'连续有效日线不足20根，主图暂不可用';
  let markers=[],groups=[];
  if(chartAvailable){
    const aligned=dates.map(date=>byDay.get(date)||null);
    const result=buildEntryMarkers({setups,bars:aligned,reference,dates});
    markers=result.markers.map(marker=>{
      const discovered=marker.evidence.map(item=>item.actualDiscoveryAt).filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b));
      return {...marker,label:labels[marker.kind],actualDiscoveryAt:discovered.at(-1)||null,lateDiscovery:marker.evidence.some(item=>item.lateDiscovery)};
    });groups=result.groups;
  }
  const chartRanges=Object.fromEntries([60,120].map(window=>[window,chartAvailable?{from:chartBars.slice(-window)[0].date,to:day}:null]));
  const metadata={schema:'books.a-share.entry-signals.v1',version:signalChartVersion,generation,sourceId,day,asOf,sourceFetchedAt,stock:{code:stock.code,name:stock.name||stock.code},priceBasis,windows:[60,120],markers,groups,chartAvailable,chartRanges};
  const directory=join(target,'signals');await mkdir(directory,{recursive:true});
  await save(join(directory,stock.code+'.json'),metadata);
  for(const window of metadata.windows)await save(join(directory,stock.code+'-'+window+'.svg'),chart({stock,bars:chartBars,markers,window,available:chartAvailable,reason}));
  return metadata;
}
