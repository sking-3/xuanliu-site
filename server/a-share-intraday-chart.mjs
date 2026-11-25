import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';

const escape=value=>String(value).replace(/[&<>"']/g,key=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[key]));
const n=value=>Number(value.toFixed(2));

export function renderIntradayChart({row,bars,window=60}){
 if(!['a14','close'].includes(row.phase)||![60,120].includes(window)||!Array.isArray(bars)||bars.length<20||bars.at(-1).date!==row.day||bars.at(-1).close!==row.reference.close||bars.some(bar=>!['open','high','low','close'].every(key=>Number.isFinite(bar[key])&&bar[key]>0)||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close)))throw Error('观察图与真实观察价格不符');
 const plan=row.research?.plan,hasPlan=plan!==null&&plan!==undefined;
 if(hasPlan&&(plan.priceBasis!=='same_batch_qfq'||!['code','sourceId','generation','day','asOf'].every(key=>typeof row[key]==='string'&&plan[key]===row[key])))throw Error('计划区域与图表证券、来源、批次或前复权基准不符');
 const zones=[];
 for(const [key,label,color]of [['buyZone','承接计划区','#317666'],['reduceZone','减仓计划区','#99743f']])if(plan?.[key]!==null&&plan?.[key]!==undefined){
  const zone=plan[key];if(![zone.low,zone.high].every(value=>Number.isFinite(value)&&value>0)||zone.low>zone.high)throw Error('计划区域须为有序的正数研究价格');
  zones.push({key,label,color,low:zone.low,high:zone.high});
 }
 const intraday=row.phase==='a14',label=intraday?'14:00盘中观察':'收盘观察',clock=intraday?row.quoteSourceAt:row.asOf,sourceTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(clock)),levels=[['B参考',row.reference.trigger,'#286178'],['失效',row.reference.invalidation,'#a45045']].filter(([,price])=>Number.isFinite(price));
 const view=bars.slice(-window),base=view[0].close,left=70,right=745,top=65,bottom=390,step=(right-left)/view.length;
 const pct=value=>(value/base-1)*100,values=view.flatMap(bar=>[pct(bar.low),pct(bar.high)]).concat(levels.map(([,price])=>pct(price)),zones.flatMap(zone=>[pct(zone.low),pct(zone.high)])),min=Math.min(...values),max=Math.max(...values),padding=Math.max(1,(max-min)*.15),low=min-padding,high=max+padding;
 const x=i=>left+(i+.5)*step,y=value=>bottom-(pct(value)-low)/(high-low)*(bottom-top),parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480" viewBox="0 0 960 480" data-normalization="first-close-percent" data-phase="${row.phase}" role="img" aria-labelledby="title desc"><title id="title">${escape(row.name)} · 近${window}个交易日日K · ${label}</title><desc id="desc">近${window}个交易日日K仅为显示窗口，非持有期或预测期；实际${view.length}根。${intraday?'最后一根为实际观察时的未收盘K，B为当时价格条件触发':'采用真实已完成日K，不为观察股制造B点'}，未核实成交；没有历史B/S回放。按窗口首日收盘归一化。${plan?'计划区域为同批前复权研究参考，非委托，未验证成交。':''}</desc><rect width="960" height="480" fill="#fff"/><g font-family="system-ui,sans-serif" font-size="19" fill="#53636e" style="font-variant-numeric:tabular-nums"><text x="70" y="28">${escape(row.name)} · 近${window}个交易日日K${view.length<window?'（实际'+view.length+'根）':''}</text><text x="70" y="52" font-size="16">${label} · 参考价 ${row.reference.close} · 来源 ${escape(sourceTime)}（北京）${intraday?' · 最后一根未收盘':''}</text>`];
 for(const zone of zones){const upper=y(zone.high),lower=y(zone.low);parts.push(`<g data-plan-zone="${zone.key}"><rect x="${left}" y="${n(upper)}" width="${right-left}" height="${n(Math.max(1,lower-upper))}" fill="${zone.color}" opacity=".08"/><path d="M${left} ${n(upper)}H${right}M${left} ${n(lower)}H${right}" stroke="${zone.color}" stroke-dasharray="3 5" opacity=".65"/><text x="${left+6}" y="${n(upper+16)}" font-size="15" fill="${zone.color}">${zone.label} ${zone.low.toFixed(2)}–${zone.high.toFixed(2)}</text></g>`);}
 for(let i=0;i<5;i++){const yy=bottom-i*(bottom-top)/4,value=low+i*(high-low)/4;parts.push(`<path d="M${left} ${n(yy)}H${right}" stroke="#e5e9eb"/><text x="755" y="${n(yy+6)}">${value.toFixed(2)}%</text>`);}
 for(const [i,bar]of view.entries()){const xx=x(i),width=Math.max(2,Math.min(9,step*.6)),color=bar.close>=bar.open?'#be4d52':'#16816e';parts.push(`<g data-candle-day="${bar.date}"${intraday&&i===view.length-1?' data-unclosed="true"':''}><path d="M${n(xx)} ${n(y(bar.high))}V${n(y(bar.low))}" stroke="${color}"/><rect x="${n(xx-width/2)}" y="${n(Math.min(y(bar.open),y(bar.close)))}" width="${n(width)}" height="${n(Math.max(1,Math.abs(y(bar.open)-y(bar.close))))}" fill="${color}"/></g>`);}
 for(const [label,price,color]of levels)parts.push(`<path d="M${left} ${n(y(price))}H${right}" stroke="${color}" stroke-dasharray="6 4"/><text x="755" y="${n(y(price)+6)}" fill="${color}">${label} ${price}</text>`);
 if(row.state==='triggered_B'){const xx=x(view.length-1),yy=Math.min(423,y(view.at(-1).low)+28);parts.push(`<g data-kind="B" data-day="${row.day}"><circle cx="${n(xx)}" cy="${n(yy)}" r="16" fill="#fff" stroke="#286178"/><text x="${n(xx)}" y="${n(yy+7)}" text-anchor="middle" fill="#286178">B</text></g>`);}
 parts.push(`<text x="70" y="455">${view[0].date}</text><text x="745" y="455" text-anchor="end">${row.day}${intraday?' · 未收盘':''}</text><text x="70" y="477" font-size="14">仅显示窗口，非持有期或预测期${plan?' · 同批前复权计划，非委托，未验证成交':''}</text></g></svg>`);return parts.join('');
}

export async function writeIntradayCharts({directory,row,bars}){
 await mkdir(directory,{recursive:true});
 for(const window of [60,120]){const file=join(directory,row.code+'-'+window+'.svg'),body=renderIntradayChart({row,bars,window});await writeFile(file+'.tmp',body);await rename(file+'.tmp',file);await writeFile(file+'.gz.tmp',gzipSync(body));await rename(file+'.gz.tmp',file+'.gz');}
}
