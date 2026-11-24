import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const number=value=>Number(value.toFixed(2));
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validBar=bar=>bar&&validDay(bar.date)&&['open','high','low','close'].every(key=>Number.isFinite(bar[key])&&bar[key]>0)&&Number.isFinite(bar.volume)&&bar.volume>=0&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close)&&bar.high>=bar.low;

function currentChart({stock,bars,item,window}){
  const width=960,height=540,left=76,right=730,top=84,bottom=330,volumeTop=425,volumeBottom=485;
  const title=(stock.name||item.name||stock.code)+' · 当前机会日K',parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${escape(title)}</title><desc id="desc">以前复权窗口首日收盘归一化；仅显示本次确认C及当日收盘触发观察B，非实际成交，不含历史B/S或波段加减仓回放。</desc><rect width="${width}" height="${height}" fill="#fff"/><g font-family="system-ui,sans-serif" font-size="22" fill="#53636e" style="font-variant-numeric:tabular-nums"><text x="${left}" y="28">${escape(title)}</text>`];
  const valid=Array.isArray(bars)&&bars.length>=20&&bars.every((bar,index)=>validBar(bar)&&(!index||bar.date>bars[index-1].date))&&bars.at(-1).date===item.day&&bars.at(-1).close===item.closePrice;
  const formation=valid&&bars.find(bar=>bar.date===item.formationDay),key=valid&&bars.find(bar=>bar.date===item.keyBarDay);
  const bound=valid&&stock.code===item.code&&validDay(item.formationDay)&&validDay(item.keyBarDay)&&item.keyBarDay>item.formationDay&&item.keyBarDay<=item.day&&key&&formation&&item.trigger?.above===key.high&&item.invalidation?.below===formation.low&&item.trigger.above>item.invalidation.below;
  if(!bound){parts.push(`<text x="${left}" y="100">当前日线或关键K参考位未完整对齐，暂不绘制。</text></g></svg>`);return parts.join('');}
  const start=Math.max(0,bars.length-window),view=bars.slice(start),base=view[0].close,pct=value=>(value/base-1)*100,percent=value=>(pct(value)>0?'+':'')+pct(value).toFixed(2)+'%',step=(right-left)/view.length,x=index=>left+step*(index+.5);
  const averages=[5,20].map(period=>({period,values:bars.map((bar,index)=>index+1<period?null:bars.slice(index+1-period,index+1).reduce((sum,row)=>sum+row.close,0)/period)}));
  const levels=[{kind:'trigger',label:'触发',price:item.trigger.above,color:'#286178'},{kind:'invalidation',label:'失效',price:item.invalidation.below,color:'#a45045'},{kind:'close',label:'收盘',price:item.closePrice,color:'#68767d'}];
  const values=[...view.flatMap(bar=>[pct(bar.low),pct(bar.high)]),...levels.map(level=>pct(level.price))];
  for(const average of averages)for(const value of average.values.slice(start))if(value!==null)values.push(pct(value));
  const minimum=Math.min(...values),maximum=Math.max(...values),span=Math.max(maximum-minimum,1),low=minimum-span*.14,high=maximum+span*.14,y=price=>bottom-(pct(price)-low)/(high-low)*(bottom-top);
  parts.push(`<text x="${left}" y="57" font-size="20">${view.length}日${view.length<window?' · 不足'+window+'日':''} · 前复权归一化</text><text x="520" y="28" fill="#9c783f">MA5</text><text x="610" y="28" fill="#606a89">MA20</text>`);
  for(let i=0;i<5;i++){
    const yy=bottom-(bottom-top)*i/4,value=low+(high-low)*i/4;
    parts.push(`<path d="M${left} ${number(yy)}H${right}" stroke="#e5e9eb"/><text x="${left-8}" y="${number(yy+7)}" text-anchor="end" font-size="18">${number(value)}%</text>`);
  }
  const candleWidth=Math.max(2,Math.min(step*.6,10)),maxVolume=Math.max(...view.map(bar=>bar.volume),1);
  for(const [index,bar]of view.entries()){
    const xx=number(x(index)),color=bar.close>=bar.open?'#be4d52':'#16816e',volume=bar.volume/maxVolume*(volumeBottom-volumeTop);
    parts.push(`<g data-candle-day="${bar.date}"><path d="M${xx} ${number(y(bar.high))}V${number(y(bar.low))}" stroke="${color}"/><rect x="${number(xx-candleWidth/2)}" y="${number(Math.min(y(bar.open),y(bar.close)))}" width="${number(candleWidth)}" height="${number(Math.max(1,Math.abs(y(bar.open)-y(bar.close))))}" fill="${color}"/><rect x="${number(xx-candleWidth/2)}" y="${number(volumeBottom-volume)}" width="${number(candleWidth)}" height="${number(volume)}" fill="${color}" opacity=".4"/></g>`);
  }
  for(const {period,values}of averages){
    const points=values.slice(start).map((value,index)=>value===null?null:[number(x(index)),number(y(value))]).filter(Boolean);
    if(points.length)parts.push(`<path data-average="${period}" d="${points.map((point,index)=>(index?'L':'M')+point.join(' ')).join('')}" fill="none" stroke="${period===5?'#9c783f':'#606a89'}" stroke-width="1.4"/>`);
  }
  const lines=levels.map(level=>({...level,yy:y(level.price)})).sort((a,b)=>a.yy-b.yy);let last=top-34;
  for(const line of lines){line.labelY=Math.max(line.yy,last+34);last=line.labelY;}
  const overflow=Math.max(0,last-bottom);
  for(const line of lines){
    const yy=number(line.yy),labelY=number(line.labelY-overflow);
    parts.push(`<g data-level="${line.kind}"><path d="M${left} ${yy}H${right}" stroke="${line.color}" stroke-dasharray="${line.kind==='close'?'2 4':'6 4'}"/><path d="M${right} ${yy}L748 ${labelY}" stroke="${line.color}" fill="none"/><text x="754" y="${number(labelY+8)}" fill="${line.color}" font-size="24">${line.label} ${percent(line.price)}</text></g>`);
  }
  const markers=[{kind:'C',day:item.keyBarDay,label:'本次收盘确认观察'}];
  if(item.stage==='triggered_at_close'&&item.closePrice>item.trigger.above&&bars.at(-1).low>=item.invalidation.below)markers.push({kind:'B',day:item.day,label:'当日收盘触发观察'});
  const positions=[];
  for(const marker of markers){
    const index=view.findIndex(bar=>bar.date===marker.day);if(index<0)continue;
    const xx=number(x(index)),edge=y(view[index].low);let yy=edge+27;
    for(const previous of positions)if(Math.abs(xx-previous.x)<42&&Math.abs(yy-previous.y)<42)yy=previous.y+42;
    positions.push({x:xx,y:yy});
    parts.push(`<g id="current-${marker.kind}-${marker.day}" data-day="${marker.day}" data-kind="${marker.kind}" data-state="research"><title>${escape(marker.kind+' · '+marker.day+' · '+marker.label+' · 未核实实际成交')}</title><path d="M${xx} ${number(edge)}V${number(yy-18)}" stroke="#286178"/><circle cx="${xx}" cy="${number(yy)}" r="18" fill="#fff" stroke="#286178"/><text x="${xx}" y="${number(yy+10)}" text-anchor="middle" font-size="28" font-weight="600" fill="#286178">${marker.kind}</text></g>`);
  }
  parts.push(`<path d="M${left} ${volumeTop-12}H${right}" stroke="#e5e9eb"/><text x="${left}" y="${volumeTop-20}" font-size="20">成交量 · 手（相对柱高）</text>`);
  for(const index of [0,view.length-1])parts.push(`<text x="${number(x(index))}" y="522" text-anchor="${index?'end':'start'}">${view[index].date}</text>`);
  parts.push('</g></svg>');return parts.join('');
}

/** Inputs are the upstream calendar-checked continuous suffix; no raw bars are published. */
export async function writeCurrentChart({directory,stock,bars,item}){
  await mkdir(directory,{recursive:true});
  for(const window of [60,120]){
    const file=join(directory,stock.code+'-'+item.formationDay+'-'+window+'.svg'),body=currentChart({stock,bars,item,window});
    await writeFile(file+'.tmp',body);await rename(file+'.tmp',file);
    await writeFile(file+'.gz.tmp',gzipSync(body));await rename(file+'.gz.tmp',file+'.gz');
  }
}
