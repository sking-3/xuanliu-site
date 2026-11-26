import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';

const prefix='/api/us-selection/';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const money=value=>finite(value)?value.toLocaleString('en-US',{maximumFractionDigits:2}):'—';
const empty=()=>({schema:'books.us.selection.v1',generatedAt:null,asOf:null,scope:{name:'等待美股收盘采集',expected:0,covered:0},source:{derivedPublic:false},market:{},short:{rows:[],status:'pending'},fundamentals:{rows:[],status:'pending'},dca:{rows:[],status:'pending'},tracking:{rows:[]}});
function acceptsGzip(header=''){
  return header.split(',').some(part=>{
    const [name,...options]=part.trim().split(';');
    const quality=options.find(option=>option.trim().startsWith('q='));
    return name.trim().toLowerCase()==='gzip'&&(!quality||Number(quality.trim().slice(2))>0);
  });
}

async function jsonFile(file){
  try{const bytes=await readFile(file);return JSON.parse((file.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

/** Public results contain derived research only, never a raw-bar data service. */
export function publicSnapshot(snapshot){
  const project=value=>{
    if(Array.isArray(value))return value.map(project);
    if(!value||typeof value!=='object')return value;
    return Object.fromEntries(Object.entries(value).filter(([key])=>!['bars','raw','rawResponse','companyFacts','payload','headers','privatePath'].includes(key)).map(([key,item])=>[key,project(item)]));
  };
  const result=project(snapshot);
  if(snapshot.source?.derivedPublic!==true){
    result.short={status:'source_pending',rows:[],reason:'行情来源尚未允许公开派生研究'};
    result.market={status:'source_pending'};
    result.tracking={status:'source_pending',rows:[]};
    return result;
  }
  result.short={...result.short,rows:(result.short?.rows||[]).map(row=>({...row,chartUrl:`${prefix}chart?symbol=${encodeURIComponent(row.symbol)}&window=60`}))};
  return result;
}

export function renderUSChart(row,window=60){
  const all=(row.bars||[]).filter(bar=>['open','high','low','close','volume'].every(key=>finite(bar[key]))),bars=all.slice(-window);
  if(!bars.length)return null;
  const width=760,height=460,left=62,right=152,top=66,bottom=338,volumeBottom=408,plot=width-left-right,step=plot/bars.length;
  const low=Math.min(...bars.map(bar=>bar.low)),high=Math.max(...bars.map(bar=>bar.high)),span=high-low||high*.02,min=low-span*.1,max=high+span*.1;
  const y=price=>bottom-(price-min)/(max-min)*(bottom-top),x=index=>left+(index+.5)*step;
  const references=[{kind:'B',label:'B 买入',price:row.trigger,color:'#286178'},{kind:'S',label:'S 卖出',price:row.invalidation,color:'#a24c43'}]
    .filter(level=>finite(level.price)&&level.price>=min&&level.price<=max)
    .map(level=>({...level,anchorY:y(level.price),labelY:Math.max(top+14,Math.min(bottom-14,y(level.price)))})).sort((a,b)=>a.anchorY-b.anchorY);
  for(let i=1;i<references.length;i++)references[i].labelY=Math.max(references[i].labelY,references[i-1].labelY+28);
  const overflow=references.length?Math.max(0,references.at(-1).labelY-(bottom-14)):0;
  for(const level of references)level.labelY-=overflow;
  const maxVolume=Math.max(...bars.map(bar=>bar.volume),1),parts=[];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(row.name||row.symbol)} · 最近${bars.length}个交易日日K · 研究观察</title><desc>B为买入参考，S为卖出参考；未持仓跌破S仅取消买入条件，不代表实际卖出。标签避让不改变参考价。</desc><rect width="100%" height="100%" fill="#fff"/><g font-family="system-ui,sans-serif" font-size="18" fill="#536477" style="font-variant-numeric:tabular-nums"><text x="${left}" y="26" font-size="22" fill="#26394b">${escape(row.name||row.symbol)} · 日K</text><text x="${left}" y="51">近${bars.length}个交易日 · 前复权 · USD</text><text x="${width-right-118}" y="26" fill="#9b702f">MA5</text><text x="${width-right-56}" y="26" fill="#58688a">MA20</text>`);
  for(let i=0;i<4;i++){const price=min+(max-min)*i/3,yy=y(price);parts.push(`<path d="M${left} ${yy}H${width-right}" stroke="#e3e8ed"/>`);if(references.every(level=>Math.abs(level.labelY-yy)>=24))parts.push(`<text data-axis-label="price" x="${width-right+8}" y="${yy+6}">${money(price)}</text>`);}
  const points=period=>bars.map((bar,index)=>{const original=all.length-bars.length+index;if(original+1<period)return null;return `${x(index)},${y(all.slice(original-period+1,original+1).reduce((sum,item)=>sum+item.close,0)/period)}`;}).filter(Boolean).join(' ');
  for(const [period,color]of [[5,'#9b702f'],[20,'#58688a']])parts.push(`<polyline points="${points(period)}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
  bars.forEach((bar,index)=>{const xx=x(index),color=bar.close>=bar.open?'#bb4c51':'#147d6c',body=Math.max(1.4,step*.58),yy=Math.min(y(bar.open),y(bar.close)),hh=Math.max(1.5,Math.abs(y(bar.open)-y(bar.close)));parts.push(`<path d="M${xx} ${y(bar.high)}V${y(bar.low)}" stroke="${color}"/><rect x="${xx-body/2}" y="${yy}" width="${body}" height="${hh}" fill="${color}"/><rect x="${xx-body/2}" y="${volumeBottom-bar.volume/maxVolume*48}" width="${body}" height="${bar.volume/maxVolume*48}" fill="${color}" opacity=".4"/>`);});
  for(const level of references){const {kind,label,price,color,anchorY,labelY}=level;parts.push(`<g data-reference="${kind}" data-price-y="${anchorY}" data-label-y="${labelY}"><path d="M${left} ${anchorY}H${width-right}" stroke="${color}" stroke-dasharray="5 4"/><path d="M${width-right} ${anchorY}L${width-right+5} ${labelY}" fill="none" stroke="${color}"/><rect x="${width-right+5}" y="${labelY-12}" width="${right-12}" height="24" rx="3" fill="#fff" stroke="${color}"/><text x="${width-right+11}" y="${labelY+6}" fill="${color}" font-size="16">${label} ${money(price)}</text></g>`);}
  for(const marker of row.markers||[]){const day=marker.day||marker.date,index=bars.findIndex(bar=>bar.date===day),kind=marker.kind||marker.type;if(index<0||!['B','S','X','+','−','-'].includes(kind))continue;const bar=bars[index],xx=x(index),above=['S','X','−','-'].includes(kind),yy=Math.max(top+12,Math.min(bottom-12,y(above?bar.high:bar.low)+(above?-17:17))),color=above?'#a24c43':'#147d6c';parts.push(`<g><title>${escape(kind+' '+day+' · 研究标记')}</title><circle cx="${xx}" cy="${yy}" r="12" fill="#fff" stroke="${color}"/><text x="${xx}" y="${yy+6}" text-anchor="middle" font-size="18" fill="${color}">${escape(kind)}</text></g>`);}
  parts.push(`<text x="${left}" y="${volumeBottom+25}">${escape(bars[0].date)}</text><text x="${width-right}" y="${volumeBottom+25}" text-anchor="end">${escape(bars.at(-1).date)}</text><text x="${left}" y="${volumeBottom-54}" font-size="16">成交量 · 股</text></g></svg>`);
  return parts.join('');
}

export function createUSSelectionCache({directory}){
  let cached=null,stamp='';const charts=new Map();
  async function published(){
    const pointer=await jsonFile(join(directory,'published.json'));if(!pointer)return null;
    if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(pointer.generation||''))throw Error('invalid_generation');
    const relative=`batches/${pointer.generation}/snapshot.json.gz`;
    if(pointer.snapshot!==relative)throw Error('invalid_snapshot_pointer');
    const file=join(directory,relative),info=await stat(file),key=pointer.generation+':'+info.mtimeMs;
    if(stamp!==key){const data=await jsonFile(file);if(data?.schema!=='books.us.selection.v1'||data.asOf!==pointer.asOf)throw Error('invalid_snapshot');cached=data;stamp=key;charts.clear();}
    return cached;
  }
  return {async handle(req,res,{path,url,json}){
    if(!path.startsWith(prefix))return false;
    const reply=(status,value)=>json(res,status,value,{'cache-control':'no-cache'});
    if(req.method!=='GET'){reply(405,{error:'method_not_allowed'});return true;}
    const route=path.slice(prefix.length);if(!['snapshot','state','chart'].includes(route)){reply(404,{error:'not_found'});return true;}
    try{
      const state=await jsonFile(join(directory,'state.json'))||{status:'pending',message:'等待首次美股收盘任务'};
      if(route==='state'){reply(200,state);return true;}
      const snapshot=await published();
      if(route==='snapshot'){
        const result={...publicSnapshot(snapshot||empty()),task:state};
        if(acceptsGzip(req.headers['accept-encoding'])){
          res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-cache','content-encoding':'gzip',vary:'Accept-Encoding'});
          res.end(gzipSync(JSON.stringify(result)));
        }else reply(200,result);
        return true;
      }
      const symbol=url.searchParams.get('symbol'),window=Number(url.searchParams.get('window')||60);
      if(!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol||'')||![60,120].includes(window)||[...url.searchParams.keys()].some(key=>!['symbol','window'].includes(key))){reply(400,{error:'invalid_query'});return true;}
      if(snapshot?.source?.derivedPublic!==true){reply(404,{error:'chart_not_published'});return true;}
      const row=snapshot.short?.rows?.find(item=>item.symbol===symbol);
      if(!row){reply(404,{error:'chart_not_published'});return true;}
      const key=symbol+':'+window;
      if(!charts.has(key)){const svg=renderUSChart(row,window);if(!svg){reply(404,{error:'chart_not_published'});return true;}if(charts.size>=128)charts.delete(charts.keys().next().value);charts.set(key,{plain:svg,gzip:gzipSync(svg)});}
      const body=charts.get(key),gzip=acceptsGzip(req.headers['accept-encoding']);
      res.writeHead(200,{'content-type':'image/svg+xml; charset=utf-8','cache-control':'no-cache',vary:'Accept-Encoding',...(gzip?{'content-encoding':'gzip'}:{})});res.end(gzip?body.gzip:body.plain);
    }catch{reply(503,{error:'us_selection_read_failed',message:'美股结果暂时读取失败，保留已发布批次；请稍后更新。'});}
    return true;
  }};
}
