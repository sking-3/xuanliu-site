import { runResearch, normalizeBars, METHOD_VERSION } from './engine.mjs';

const $ = id => document.getElementById(id);
const DAY = 86400000;
const STORE = 'books.quant-research.v1';
const isLocal = ['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === '4318';
let current = null;
let imported = null;
let runtime = null;
let records = [];
let serverRecords = [];
let busy = false;
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
const decimal = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const date = value => value ? new Date(value).toLocaleString('zh-CN', {hour12:false,timeZoneName:'short'}) : '尚无';
const day = value => value ? new Date(value).toISOString().slice(0,10) : '—';
const strategyName = s => s?.family === 'trend' ? `均线趋势 · ${s.fast} / ${s.slow} 日` : s?.family === 'meanReversion' ? `均值回归 · ${s.lookback} 日 / ${s.entryZ}σ` : '买入持有';
if(isLocal){document.querySelector('.brand').href='#content';document.querySelector('nav a[href="../tools.html"]').remove();}
function message(text) { $('message').textContent = text; $('message').hidden = !text; }
function node(tag, text, className) { const el = document.createElement(tag); if(text !== undefined) el.textContent = text; if(className) el.className = className; return el; }
function cells(parent, values) { const row = node('tr'); values.forEach(v => row.append(node('td',v))); parent.append(row); }
function rangeText(range) { return range ? `${day(range.startTimestamp)} — ${day(range.endTimestamp)}` : ''; }
async function api(path, body) {
  const response = await fetch(path,{cache:'no-store', ...(body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}), signal:AbortSignal.timeout(60000)});
  let data; try { data=await response.json(); } catch { throw new Error('研究服务返回异常，检查本机服务是否运行。'); }
  if(!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `研究服务错误 ${response.status}`);
  return data;
}
async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(v=>v.toString(16).padStart(2,'0')).join(''); }
function download(name, value, type='application/json') { const url=URL.createObjectURL(new Blob([typeof value === 'string' ? value : JSON.stringify(value,null,2)],{type})); const a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function parseFile(text, name) {
  if(name.toLowerCase().endsWith('.json')) { const data=JSON.parse(text); return Array.isArray(data)?data:data.bars ?? data.dataset?.bars; }
  const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  const headers=lines.shift().split(',').map(x=>x.trim().toLowerCase());
  if(headers.join(',') !== 'time,open,high,low,close,volume') throw new Error('CSV 表头必须是 time,open,high,low,close,volume。请使用格式说明核对。');
  return lines.filter(x=>x.trim()).map((line,i)=>{const parts=line.split(',').map(x=>x.trim());if(parts.length!==6)throw new Error(`CSV 第 ${i+2} 行不是 6 列。`);return Object.fromEntries(headers.map((h,j)=>[h,parts[j]]));});
}
function warningText(w) {
  const text = typeof w === 'string' ? w : w.message ?? w.code ?? JSON.stringify(w);
  const translations = [
    ['Research only:', '仅用于研究；历史结果不能确认未来最优策略，也不触发任何真实交易。'],
    ['Final holdout', '最终留存集已经展示；看到结果后继续修改参数会污染检验，需保留新的未使用数据。'],
    ['24 predefined', '共尝试 24 组预定参数，存在多重试验偏差；训练、验证和滚动窗口有重叠，不能当作独立证据累加。'],
    ['Long/flat', '模型只包含无杠杆现货多仓和空仓，按全额资金及可分割数量计算；不含融资、资金费、税费和流动性冲击。'],
    ['Signals use', '使用前一根已完成收盘信号，在下一根开盘成交；每段从现金开始，期末按最后收盘价扣成本平仓。'],
    ['Drawdown and', '回撤与 Sharpe 按日线收盘净值计算，日内损失可能更大；Sharpe 使用零无风险利率。'],
    ['No strategy meets', '没有策略满足训练段的最低交易数与有效 Sharpe 要求；当前选择仅用于诊断。'],
    ['Validation or', '验证段或留存段完成交易太少，结论尚不稳定。'],
    ['The frozen candidate loses', '固定候选在验证段或最终留存段扣除成本后亏损。'],
    ['The frozen candidate underperforms', '固定候选在最终留存段落后于同成本的买入持有基准。'],
  ];
  if(text.includes('rows have zero volume'))return '数据中存在零成交量日线，模型假设可成交，真实执行可能不可行。';
  return translations.find(([prefix])=>text.startsWith(prefix))?.[1] ?? text;
}
function drawEquity(report) {
  const svg=$('equity'); svg.replaceChildren();
  const width=Math.max(280,svg.clientWidth || 960);svg.setAttribute('viewBox',`0 0 ${width} 230`);
  const a=report.holdout.equity, b=report.baseline.holdout.equity;
  const values=[...a,...b].map(p=>p.value); const low=Math.min(...values)*.99, high=Math.max(...values)*1.01;
  const ns='http://www.w3.org/2000/svg';
  function add(tag,attrs,text){const el=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,v);if(text)el.textContent=text;svg.append(el);return el;}
  const minTime=Math.min(a[0]?.timestamp ?? 0,b[0]?.timestamp ?? 0);const maxTime=Math.max(a.at(-1)?.timestamp ?? 1,b.at(-1)?.timestamp ?? 1);
  const x=t=>60+(t-minTime)/Math.max(1,maxTime-minTime)*(width-75);const y=v=>185-(v-low)/Math.max(1,high-low)*155;
  for(let i=0;i<4;i++){const v=low+(high-low)*i/3;add('line',{x1:60,y1:y(v),x2:width-15,y2:y(v),stroke:'#e2e8e7'});add('text',{x:52,y:y(v)+4,'text-anchor':'end'},Math.round(v).toLocaleString());}
  for(const [data,cls] of [[b,'baseline'],[a,'strategy']]) add('path',{d:data.map((p,i)=>`${i?'L':'M'}${x(p.timestamp).toFixed(2)} ${y(p.value).toFixed(2)}`).join(' '),class:cls});
  add('text',{x:60,y:215},day(minTime));add('text',{x:width-15,y:215,'text-anchor':'end'},day(maxTime));
}
function updateDraftStatus(){if(!current)return;const c=current.report.config;const changed=Number($('fee').value)!==c.feeBps||Number($('slippage').value)!==c.slippageBps;$('draft-status').textContent=changed?'上方成本输入已修改；下方仍是之前保存的结果，重新运行后才会更新。':'下方是已保存的研究结果；修改输入不会改变这份记录。';}
function render(record) {
  current=record;const r=record.report;
  $('empty').hidden=true;$('report').hidden=false;$('export').disabled=false;
  const hold=r.holdout.metrics, val=r.validation.metrics;
  const enough=r.selected.eligible && hold.tradeCount>=10 && val.tradeCount>=10;
  const ahead=hold.netReturn>r.baseline.holdout.metrics.netReturn && val.netReturn>0 && hold.netReturn>0 && r.walkForward.filter(x=>x.test.metrics.netReturn>0).length>=2;
  $('verdict').textContent=!enough?'证据不足：样本外交易次数偏少':ahead?'可进入后续观察，尚未证明未来优势':'样本外尚未形成稳定优势';
  $('selection').textContent=`训练段选中：${strategyName(r.selected.strategy)}。这只是固定网格中的训练优选；最终留存段收益 ${percent(hold.netReturn)}，最大回撤 ${percent(hold.maxDrawdown)}。`;
  $('result-cost').textContent=`本记录固定成本：单边手续费 ${r.config.feeBps} 基点，单边滑点 ${r.config.slippageBps} 基点 · 初始资金 ${r.config.initialCapital.toLocaleString()} · 数据 ${day(r.data.start)} 至 ${day(r.data.end)}（UTC 开盘日）`;
  updateDraftStatus();
  $('provenance').textContent=`${record.source?.name ?? record.source ?? '个人导入'} · ${r.data?.rows ?? record.bars?.length ?? '—'} 根日线 · 方法 ${r.methodVersion ?? METHOD_VERSION} · SHA-256 ${(record.dataHash ?? r.data?.suppliedSha256 ?? '').slice(0,16)} · ${date(record.createdAt)}`;
  $('metrics').replaceChildren();
  for(const [key,label] of [['training','训练 60%'],['validation','验证 20%'],['holdout','最终留存 20%']]){const m=r[key].metrics;cells($('metrics'),[label,percent(m.netReturn),percent(r.baseline[key].metrics.netReturn),percent(m.maxDrawdown),decimal(m.sharpe),m.tradeCount,percent(m.winRate)]);}
  $('cost-rows').replaceChildren();for(const[key,label]of[['training','训练'],['validation','验证'],['holdout','最终留存']]){const m=r[key].metrics;cells($('cost-rows'),[label,percent(m.annualizedReturn),percent(m.exposure),decimal(m.fees),decimal(m.slippageCost)]);}
  $('trial-rows').replaceChildren();
  for(const trial of r.experiments){const m=trial.metrics;cells($('trial-rows'),[`${strategyName(trial.strategy)}${trial.strategyId===r.selected.strategyId?' · 训练选中':''}`,percent(m.netReturn),percent(m.maxDrawdown),decimal(m.sharpe),m.tradeCount]);}
  $('fold-rows').replaceChildren();
  for(const fold of r.walkForward){const m=fold.test.metrics;cells($('fold-rows'),[rangeText(fold.test.range)||`第 ${fold.fold} 段`,strategyName(fold.selected.strategy),percent(m.netReturn),percent(m.maxDrawdown),m.tradeCount]);}
  $('warnings').replaceChildren();
  for(const warning of r.warnings ?? []) $('warnings').append(node('li',warningText(warning)));
  $('warnings').append(node('li','该留存集已经展示。若依据此结果修改规则、成本或参数，请使用新的未来数据做确认；重复回测不增加独立证据。'));
  drawEquity(r);
}
function readBrowserRecords(){try{const data=JSON.parse(localStorage.getItem(STORE) ?? '[]');records=Array.isArray(data)?data.filter(x=>x?.report?.methodVersion===METHOD_VERSION).slice(0,5):[];}catch{records=[];message('无法读取浏览器记录；研究仍可运行，请导出结果备份。');}}
function saveBrowserRecord(record){records=[record,...records.filter(x=>x.id!==record.id)].slice(0,5);try{localStorage.setItem(STORE,JSON.stringify(records));}catch{message('本次研究已完成，但浏览器存储空间不足。请立即导出记录备份。');}}
function renderHistory(){const list=$('history-list');list.replaceChildren();const all=[...serverRecords.map(x=>({...x,server:true})),...records].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20);if(!all.length){list.append(node('p','暂无研究记录。完成一次研究后会显示在这里。','muted'));return;}for(const r of all){const item=node('div',undefined,'history-item');const info=node('div',`${date(r.createdAt)} · ${r.server?'本机':'浏览器'}`);info.append(node('small',`${r.source?.name ?? r.source ?? '文件导入'} · ${String(r.dataHash ?? '').slice(0,12)}`));const button=node('button','查看');button.type='button';button.addEventListener('click',async()=>{try{render(r.server?await api(`/api/runs/${encodeURIComponent(r.id)}`):r);$('results').scrollIntoView({block:'start'});}catch(e){message(e.message);}});item.append(info,button);list.append(item);}}
async function refresh(){
  if(!isLocal){$('runtime-status').textContent='浏览器模式：可导入数据进行研究';$('runtime-detail').textContent='自动采集与定时研究由 Mac 上的本机服务执行。点击“打开本机研究服务”查看，公开页面不会尝试连接你的电脑。';$('data-source').value='file';$('file-panel').hidden=false;renderHistory();return;}
  $('local-link').hidden=true;
  try{runtime=await api('/api/status');$('runtime-status').textContent=runtime.sourceBlocked?'来源已停止，请查看错误记录':runtime.running?'研究正在执行':runtime.scheduleEnabled?'日更研究已启用':'自动研究已暂停';$('runtime-detail').textContent=`最近成功：${date(runtime.lastSuccess)} · 下次：${date(runtime.nextRun)}。Mac 关机或休眠时不执行。${runtime.error ? ' 错误：'+(runtime.error.message??runtime.error):''}`;$('runtime-data').textContent=`行情抓取：${date(runtime.sourceRetrievedAt)} · 最新完整日线结束：${date(runtime.latestClosedAt)}${runtime.dataStale?' · 数据已过期，请核对来源状态':''}`;$('schedule-toggle').disabled=!!runtime.sourceBlocked;$('schedule-toggle').textContent=runtime.scheduleEnabled?'暂停自动研究':'启用每日研究';const data=await api('/api/runs');serverRecords=data.runs??[];renderHistory();if(!current && serverRecords.length)render(await api(`/api/runs/${encodeURIComponent(serverRecords[0].id)}`));}
  catch(e){$('runtime-status').textContent='本机研究服务暂时不可用';$('runtime-detail').textContent=e.message;$('schedule-toggle').disabled=true;}
}
$('data-source').addEventListener('change',()=>{$('file-panel').hidden=$('data-source').value!=='file';});
for(const id of ['fee','slippage'])$(id).addEventListener('input',updateDraftStatus);
$('data-file').addEventListener('change',async event=>{imported=null;const file=event.target.files[0];if(!file)return;try{if(file.size>5*1024*1024)throw new Error('文件上限 5 MB，请按单标的连续日线拆分。');const parsed=parseFile(await file.text(),file.name);if(!Array.isArray(parsed)||parsed.length>10000)throw new Error('文件应包含最多 10,000 根 OHLCV 日线。');const normalized=normalizeBars(parsed,{intervalMs:DAY});if(normalized.bars.at(-1).timestamp+DAY>Date.now())throw new Error('文件包含未收盘或未来日线，请先剔除。');if(normalized.bars.length<300)throw new Error('至少需要 300 根连续日线进行分段研究。');imported={bars:normalized.bars,source:{name:file.name,type:'local-import'},dataHash:await hash(normalized.bars)};$('data-status').textContent=`数据检查通过 · ${normalized.bars.length} 根 · ${day(normalized.bars[0].timestamp)} 至 ${day(normalized.bars.at(-1).timestamp)} · 零成交量 ${normalized.quality.zeroVolumeRows} 根`;message('');}catch(e){$('data-status').textContent='数据检查未通过';message(e.message);}});
$('research-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;$('run-button').disabled=true;$('run-button').textContent='正在研究…';message('');try{const config={feeBps:Number($('fee').value),slippageBps:Number($('slippage').value),intervalMs:DAY};let result;if($('data-source').value==='local'){if(!isLocal)throw new Error('请打开本机研究服务，或选择导入文件。');result=await api('/api/run',{feeBps:config.feeBps,slippageBps:config.slippageBps});if(result.reused)message('同一数据与参数已有研究记录，已读取原结果；重复计算不会产生新证据。');}else{if(!imported)throw new Error('请先选择并检查 CSV 或 JSON 文件。');const id=(await hash({dataHash:imported.dataHash,config,method:METHOD_VERSION})).slice(0,24);result=records.find(x=>x.id===id);if(result)message('已读取相同数据与配置的已有结果。');else{await new Promise(resolve=>setTimeout(resolve,30));const report=runResearch(imported.bars,{...config,dataHash:imported.dataHash,source:imported.source.name});result={id,createdAt:new Date().toISOString(),...imported,report};saveBrowserRecord(result);}}render(result);renderHistory();if(isLocal)await refresh();}catch(e){message(`研究未完成：${e.message}`);}finally{busy=false;$('run-button').disabled=false;$('run-button').textContent='运行策略研究';}});
$('export').addEventListener('click',async()=>{if(!current)return;try{let record=current;if(!record.bars && isLocal){const dataset=await api(`/api/runs/${encodeURIComponent(record.id)}?includeData=1`);record=dataset;}download(`books-research-${record.id}.json`,record);}catch(e){message(e.message);}});
$('download-template').addEventListener('click',()=>download('OHLCV-format.txt','CSV 表头：time,open,high,low,close,volume\n每行：UTC 日期或时间戳，开盘，最高，最低，收盘，成交量。\n请导入真实、连续、已收盘的加密现货日线（至少300根、最多10000根）。\n本文件只是格式说明，不含示例行情，不可直接回测。\nJSON 可为相同字段的对象数组，或 {"bars":[...]}。','text/plain'));
$('refresh-status').addEventListener('click',refresh);
$('schedule-toggle').addEventListener('click',async()=>{try{await api('/api/schedule',{enabled:!runtime?.scheduleEnabled});await refresh();}catch(e){message(e.message);}});
readBrowserRecords();renderHistory();refresh();
if(isLocal)setInterval(()=>{if(!document.hidden && !busy)refresh();},30000);
let resizeTimer;addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(current)drawEquity(current.report);},50);});
