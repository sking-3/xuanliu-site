import { runResearch, normalizeBars, METHOD_VERSION } from './engine.mjs';

const $ = id => document.getElementById(id);
const DAY = 86400000;
const STORE = 'books.quant-research.web.v1';
let current = null;
let dataset = null;
let records = [];
let busy = false;
let loading = false;
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
const decimal = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', {hour12:false,timeZoneName:'short'}) : '尚无';
const day = value => value ? new Date(value).toISOString().slice(0,10) : '—';
const strategyName = s => s?.family === 'trend' ? `均线趋势 · ${s.fast} / ${s.slow} 日` : s?.family === 'meanReversion' ? `均值回归 · ${s.lookback} 日 / ${s.entryZ}σ` : '买入持有';
function message(text) { $('message').textContent = text; $('message').hidden = !text; }
function node(tag, text, className) { const el = document.createElement(tag); if(text !== undefined) el.textContent = text; if(className) el.className = className; return el; }
function cells(parent, values) { const row = node('tr'); values.forEach(v => row.append(node('td',v))); parent.append(row); }
function rangeText(range) { return range ? `${day(range.startTimestamp)} — ${day(range.endTimestamp)}` : ''; }
async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(v=>v.toString(16).padStart(2,'0')).join(''); }
function download(name, value) { const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})); const a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
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
  $('provenance').textContent=`${record.source?.name ?? record.source ?? '公开行情'} · ${r.data?.rows ?? record.bars?.length ?? '—'} 根日线 · 方法 ${r.methodVersion ?? METHOD_VERSION} · SHA-256 ${(record.dataHash ?? r.data?.suppliedSha256 ?? '').slice(0,16)} · ${date(record.createdAt)}`;
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
function readBrowserRecords(){try{const data=JSON.parse(localStorage.getItem(STORE) ?? '[]');records=Array.isArray(data)?data.filter(x=>x?.report?.methodVersion===METHOD_VERSION).slice(0,5):[];}catch{records=[];message('浏览器记录暂时无法读取，仍可查看网站提供的结果。');}}
function saveBrowserRecord(record){records=[record,...records.filter(x=>x.id!==record.id)].slice(0,5);try{localStorage.setItem(STORE,JSON.stringify(records));}catch{message('本次研究已完成，但浏览器未能保存记录，可导出备份。');}}
function renderHistory(){const list=$('history-list');list.replaceChildren();if(!records.length){list.append(node('p','暂无研究记录。完成一次研究后会显示在这里。','muted'));return;}for(const r of records){const item=node('div',undefined,'history-item'),info=node('div',`${date(r.createdAt)} · 浏览器记录`);info.append(node('small',`${r.source?.name ?? '公开行情'} · ${String(r.dataHash ?? '').slice(0,12)}`));const button=node('button','查看');button.type='button';button.addEventListener('click',()=>{render(r);$('results').scrollIntoView({block:'start'});});item.append(info,button);list.append(item);}}
const sourceErrors={source_blocked:'行情来源拒绝访问或限制请求，自动采集已停止。',source_stopped:'行情来源拒绝访问或限制请求，自动采集已停止。',source_unavailable:'行情来源暂时无法连接。',source_error:'行情来源返回异常。',invalid_data:'本次行情未通过数据校验。',invalid_archive:'历史数据完整性校验未通过。'};
function statusFor(data){
  const last=Date.parse(data.latestClosedAt || ''),age=Date.now()-last;
  if(data.status==='blocked'||data.status==='stopped')return ['来源已停止更新',sourceErrors[data.error?.code]||'行情来源暂时无法读取，需核实来源状态。'];
  if(data.status==='error')return ['最新更新未完成',sourceErrors[data.error?.code]||'本次未能取得可核验的数据。'];
  if(data.status==='stale'||!Number.isFinite(last)||age>2*DAY)return data.bars?.length?['行情已过期',data.report?'当前显示上次成功采集的行情与研究结果。':'当前保留上次成功采集的行情，尚无网站研究结果。']:['尚无可用行情','尚未取得可核验的完整日线。'];
  if(!data.report)return ['行情已更新，研究结果待生成','网站已取得公开行情，可运行策略研究。'];
  return ['公开行情已更新','网站提供最近一次成功采集的公开行情和研究结果。'];
}
async function validateDataset(data){
  if(!data||data.schemaVersion!==1||!['ready','stale','blocked','stopped','error'].includes(data.status))throw Error('网站数据格式异常。');
  if(data.bars==null){if(data.dataHash!=null||data.report!=null||data.reportHash!=null||data.status==='ready')throw Error('网站研究记录不完整。');return null;}
  if(!Array.isArray(data.bars)||data.bars.length<300||data.bars.length>720||!(/^[a-f0-9]{64}$/.test(data.dataHash||'')))throw Error('网站行情记录不完整。');
  if(typeof data.source?.name!=='string'||!data.source.name)throw Error('网站行情来源信息不完整。');
  if(!Number.isFinite(Date.parse(data.retrievedAt||''))||!Number.isFinite(Date.parse(data.latestClosedAt||''))||Date.parse(data.retrievedAt)>Date.now()+60000)throw Error('网站行情时间异常。');
  if(await hash(data.bars)!==data.dataHash)throw Error('网站行情校验未通过。');
  const normalized=normalizeBars(data.bars,{intervalMs:DAY});
  const last=normalized.bars.at(-1).timestamp+DAY;
  if(last>Date.now()||last>Date.parse(data.retrievedAt)||last!==Date.parse(data.latestClosedAt))throw Error('网站行情包含未完成日线或时间不一致。');
  if(data.report&&(data.report.methodVersion!==METHOD_VERSION||data.report.data?.suppliedSha256!==data.dataHash||!(/^[a-f0-9]{64}$/.test(data.reportHash||''))||await hash(data.report)!==data.reportHash))throw Error('网站研究结果与行情记录不一致。');
  if(!data.report&&data.reportHash!=null)throw Error('网站研究记录不完整。');
  return data;
}
async function refresh(){
  if(loading)return;loading=true;$('refresh-status').disabled=true;
  try{
    const response=await fetch('data/latest.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(response.status===404?'网站尚未发布第一份行情与研究结果。':'网站数据暂时无法读取。');
    const data=await response.json();const verified=await validateDataset(data);
    dataset=verified;const [status,detail]=statusFor(data);$('runtime-status').textContent=status;
    $('runtime-detail').textContent=detail+(data.lastAttempt?` 最近尝试：${date(data.lastAttempt)}。`:'');
    $('runtime-data').textContent=data.retrievedAt?`上次成功采集：${date(data.retrievedAt)} · 最新完整日线结束：${date(data.latestClosedAt)}`:'尚无成功采集记录。';
    $('data-status').textContent=verified?`${verified.bars.length} 根完整日线 · ${day(verified.bars[0].time)} 至 ${day(verified.bars.at(-1).time)}（UTC 开盘日）`:'等待网站提供可核验的行情数据。';
    $('run-button').disabled=!verified||busy;
    if(verified?.report&&(!current||current.origin==='website')){const r={id:verified.dataHash,createdAt:verified.runAt,source:verified.source,dataHash:verified.dataHash,bars:verified.bars,report:verified.report,origin:'website'};render(r);}
  }catch(e){
    $('runtime-status').textContent='网站数据暂不可用';$('runtime-detail').textContent=e.message||'请稍后刷新。';
    if(dataset){$('runtime-detail').textContent+=' 保留本页上次读取的结果。';$('run-button').disabled=busy;}
    else{$('runtime-data').textContent='尚无可用行情。';$('run-button').disabled=true;}
  }finally{loading=false;$('refresh-status').disabled=false;}
}
for(const id of ['fee','slippage'])$(id).addEventListener('input',updateDraftStatus);
$('research-form').addEventListener('submit',async event=>{event.preventDefault();if(busy||!dataset)return;busy=true;$('run-button').disabled=true;$('run-button').textContent='正在研究…';message('');try{
  const config={feeBps:Number($('fee').value),slippageBps:Number($('slippage').value),intervalMs:DAY};
  const id=(await hash({dataHash:dataset.dataHash,config,method:METHOD_VERSION})).slice(0,24);let result=records.find(x=>x.id===id);
  if(result)message('已读取相同数据与配置的已有结果；重复计算不会产生新证据。');
  else{await new Promise(resolve=>setTimeout(resolve,30));const report=runResearch(dataset.bars,{...config,dataHash:dataset.dataHash,source:dataset.source.name});result={id,createdAt:new Date().toISOString(),source:dataset.source,dataHash:dataset.dataHash,bars:dataset.bars,report};saveBrowserRecord(result);}
  render(result);renderHistory();
}catch(e){message(`研究未完成：${e.message}`);}finally{busy=false;$('run-button').disabled=!dataset;$('run-button').textContent='运行策略研究';}});
$('export').addEventListener('click',()=>{if(current)download(`books-research-${current.id}.json`,current);});
$('refresh-status').addEventListener('click',refresh);
readBrowserRecords();renderHistory();refresh();
let resizeTimer;addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(current)drawEquity(current.report);},50);});
