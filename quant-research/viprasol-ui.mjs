import {catalog, evaluateIndicator, verifySnapshot} from './viprasol-registry.mjs';

const $ = id => document.getElementById(id);
const state = {snapshot:null, market:null, marketError:null, results:new Map(), selected:'tyson', parameters:{}, window:120, chartWidth:960, error:null, loading:false};
const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN',{maximumFractionDigits:4}) : '—';
const day = time => new Date(time).toISOString().slice(0,10);
const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})+'（北京）' : '未提供';
const sideName = side => side==='long'?'多向':side==='short'?'空向':'结构事件';
function node(tag,text,className) {const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;}
function context() {return {symbol:'BTC/USD',tickerid:'KRAKEN:XBTUSD',timeframe:'D',intervalMs:86400000,timeZone:'UTC',exchangeTimeZone:'UTC',mintick:state.market?.tickSize,tickSize:state.market?.tickSize,series:{}};}
function compute(id, parameters) {
  try {return evaluateIndicator(id,state.snapshot.bars,parameters,context());}
  catch(error) {return {id,status:'error',missingDependencies:[error.message],signals:[],plots:[],zones:[],notes:[]};}
}
function stateText(result) {
  if(!result)return '等待核验';
  if(result.status==='ready')return '已移植 · 当前数据可计算';
  return (result.status==='error'?'计算未完成：':'已移植 · 当前停用：')+(result.missingDependencies.length?result.missingDependencies.join('；'):'当前数据未满足原规则依赖');
}
function renderProvenance() {
  const data=state.snapshot;
  $('indicator-refresh').disabled=state.loading;
  $('indicator-run').disabled=state.loading||!data;
  if(!data){$('indicator-status').textContent=state.error||'正在核验本站已归档日线。';return;}
  const stale=Date.now()-Date.parse(data.latestClosedAt)>2*86400000||data.status!=='ready';
  $('indicator-status').textContent=(state.error?'本次读取未完成，保留上次真实数据。 '+state.error:stale?'来源快照已过期或暂停，以下仅供历史研究。':'已读取本站真实日线。')+` ${data.bars.length}根 · BTC/USD · 日线`;
  $('indicator-provenance').textContent=`${data.source.name} · 来源完整日线截至 ${stamp(data.latestClosedAt)} · 来源采集 ${stamp(data.retrievedAt)} · 本页读取 ${stamp(state.readAt)}`;
  $('indicator-market').textContent=(state.marketError?'本次规格读取失败，'+(state.market?'保留上次有效规格。 ':'依赖报价单位的指标停用。 '):'')+(state.market?`最小报价单位 ${number(state.market.tickSize)} USD · Kraken AssetPairs · 规格读取 ${stamp(state.market.retrievedAt)}`:'交易对规格未取得，依赖最小报价单位的指标停用。');
}
function renderParameters() {
  const definition=catalog.find(item=>item.id===state.selected),container=$('indicator-parameters');container.replaceChildren();
  for(const spec of definition.parameters) {
    if(spec.type==='goals') {
      const goals=node('div',undefined,'indicator-goals');
      state.parameters[spec.key].forEach((goal,i)=>{
        const label=node('label'),check=node('input'),input=node('input');check.type='checkbox';check.checked=goal.done;
        check.setAttribute('aria-label',`目标${i+1}已完成`);input.type='text';input.value=goal.label;input.setAttribute('aria-label',`目标${i+1}内容`);
        check.dataset.goalIndex=String(i);input.dataset.goalIndex=String(i);check.dataset.paramKey=spec.key;input.dataset.paramKey=spec.key;
        label.append(check,input);goals.append(label);
      });container.append(goals);continue;
    }
    const label=node('label',spec.label||spec.key),input=node(spec.type==='select'?'select':'input');
    input.dataset.paramKey=spec.key;
    if(spec.type==='select') for(const option of spec.options){const item=node('option',typeof option==='object'?option.label:option);item.value=typeof option==='object'?option.value:option;input.append(item);}
    else input.type=spec.type==='boolean'?'checkbox':spec.type==='string'?'text':'number';
    if(spec.type==='boolean')input.checked=state.parameters[spec.key];else input.value=state.parameters[spec.key];
    if(spec.min!==undefined&&spec.min!==null)input.min=spec.min;
    if(spec.max!==undefined&&spec.max!==null)input.max=spec.max;
    if(input.type==='number')input.step=spec.type==='integer'||spec.integer?'1':'any';
    label.append(input);container.append(label);
  }
}
function renderLibrary() {
  const body=$('indicator-library');body.replaceChildren();
  for(const definition of catalog) {
    const row=node('tr'),name=node('td'),info=node('td'),source=node('td'),link=node('a','Pine 原稿 ↗');
    const choose=node('button',definition.title);choose.type='button';choose.dataset.chooseIndicator=definition.id;name.append(choose);
    info.append(node('span',stateText(state.results.get(definition.id)),'indicator-state'));
    if(definition.dependencies?.length)info.append(node('span',definition.dependencies.join('；')));
    link.href='viprasol-source/indicators/'+definition.sourceFile;link.target='_blank';link.rel='noopener noreferrer';source.append(link);row.append(name,info,source);body.append(row);
  }
}
function drawChart(bars,result,plot=null) {
  const chosen=state.window==='all'?bars.length:state.window,start=Math.max(0,bars.length-chosen),visible=bars.slice(start);
  const canvasWidth=state.chartWidth;
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',`0 0 ${canvasWidth} 400`);svg.setAttribute('role','img');svg.setAttribute('aria-label','BTC/USD真实已完成日线与当前所选指标的历史信号；横轴为UTC开盘日，不代表实际成交');
  const left=76,right=20,top=30,bottom=340,width=canvasWidth-left-right;
  const overlays=result.plots.filter(item=>item.pane!=='oscillator'&&Array.isArray(item.values));
  const samples=plot?plot.values.slice(start).filter(Number.isFinite):[...visible.flatMap(bar=>[bar.high,bar.low]),...overlays.flatMap(line=>line.values.slice(start).filter(Number.isFinite))];
  if(!samples.length)return node('p',(plot?.name||'图表')+'：当前窗口数据不足。','indicator-caption');
  const high=Math.max(...samples),low=Math.min(...samples),span=high-low||Math.max(Math.abs(high)*.01,1);
  const y=price=>top+(high+span*.05-price)/(span*1.1)*(bottom-top),x=index=>left+(index-start+.5)*width/visible.length;
  function shape(tag,attrs,text) {const element=document.createElementNS(svg.namespaceURI,tag);for(const [key,value] of Object.entries(attrs))element.setAttribute(key,String(value));if(text!==undefined)element.textContent=text;svg.append(element);return element;}
  for(let i=0;i<=4;i++){const value=low+span*i/4,cy=y(value);shape('line',{x1:left,x2:canvasWidth-right,y1:cy,y2:cy,stroke:'#e1e7ee'});shape('text',{x:66,y:cy+4,'text-anchor':'end'},number(value));}
  const clip=shape('clipPath',{id:plot?'indicator-pane-clip-'+result.plots.indexOf(plot):'indicator-price-clip'});
  const clipRect=document.createElementNS(svg.namespaceURI,'rect');for(const [key,value]of Object.entries({x:left,y:top,width,height:bottom-top}))clipRect.setAttribute(key,String(value));clip.append(clipRect);
  const clipped='url(#'+clip.id+')';
  if(!plot)for(const zone of result.zones||[]) {
    if(zone.endIndex<start||zone.startIndex>=bars.length)continue;
    const from=Math.max(start,zone.startIndex),to=Math.min(bars.length-1,zone.endIndex);
    if(Number.isFinite(zone.low)&&Number.isFinite(zone.high)){const rect=shape('rect',{x:x(from),y:y(zone.high),width:Math.max(1,x(to)-x(from)),height:Math.max(1,y(zone.low)-y(zone.high)),fill:'#496982','fill-opacity':.07,stroke:'#7890a2','stroke-opacity':.4,'clip-path':clipped});const title=document.createElementNS(svg.namespaceURI,'title');title.textContent=zone.label||zone.type||'参考区域';rect.append(title);}
    if(zone.type==='wave_base_channel')for(const offset of [0,zone.parallelOffset])shape('line',{x1:x(from),x2:x(to),y1:y(zone.start+zone.slope*(from-zone.startIndex)+offset),y2:y(zone.start+zone.slope*(to-zone.startIndex)+offset),stroke:'#7890a2','stroke-dasharray':'5 4','clip-path':clipped});
  }
  const candleWidth=Math.max(.7,Math.min(9,width/visible.length*.65));
  if(!plot)for(let i=start;i<bars.length;i++) {const bar=bars[i],color=bar.close>=bar.open?'#187968':'#b3474c',cx=x(i);shape('line',{x1:cx,x2:cx,y1:y(bar.high),y2:y(bar.low),stroke:color});shape('rect',{x:cx-candleWidth/2,y:Math.min(y(bar.open),y(bar.close)),width:candleWidth,height:Math.max(.8,Math.abs(y(bar.open)-y(bar.close))),fill:color});}
  const palette=['#345c80','#aa752b','#71815b','#9d6073','#557f83'];
  (plot?[plot]:overlays).forEach((line,j)=>{let path='';for(let i=start;i<bars.length;i++){const value=line.values[i];path+=Number.isFinite(value)?`${i===start||!Number.isFinite(line.values[i-1])?'M':'L'}${x(i)},${y(value)} `:'';}const curve=shape('path',{d:path,fill:'none',stroke:palette[j%palette.length],'stroke-width':1.4,'clip-path':clipped});const title=document.createElementNS(svg.namespaceURI,'title');title.textContent=line.name;curve.append(title);});
  if(!plot)for(const signal of result.signals.filter(item=>item.index>=start).slice(-60)) {
    const buy=signal.side==='long',sell=signal.side==='short';
    const events={count_found:'结构',count_invalidated:'失效',abc_complete:'ABC',regular_divergence:'背离',hidden_divergence:'背离',extreme:'极值',reentry:'回带'};
    const structural=['wave-structure-pro-v2','z-score-stats'].includes(result.id)||signal.side==='neutral'||signal.event&&signal.event!=='entry';
    const label=structural?(events[signal.type]||'告警'):buy?'B':sell?'S':'事件';
    const cy=Math.max(15,Math.min(360,y(buy?bars[signal.index].low:bars[signal.index].high)+(buy?15:-15)));
    shape('circle',{cx:x(signal.index),cy,r:label.length>1?14:9,fill:'#fff',stroke:structural?'#496982':buy?'#187968':'#b3474c'});shape('text',{x:x(signal.index),y:cy+4,'text-anchor':'middle'},label);
  }
  if(plot)shape('text',{x:left,y:18},plot.name+(plot.unit?' · '+plot.unit:''));
  const dates=canvasWidth<600?[start,bars.length-1]:[start,Math.floor((start+bars.length-1)/2),bars.length-1];
  for(const index of dates)shape('text',{x:x(index),y:377,'text-anchor':index===start?'start':index===bars.length-1?'end':'middle'},day(bars[index].time));
  return svg;
}
function drawProfiles(profiles) {
  const section=node('div',undefined,'indicator-profile');
  for(const profile of profiles){const rows=profile.rows||[],maximum=Math.max(...rows.map(row=>row.volume),0);if(!maximum)continue;const list=node('div',undefined,'indicator-profile-rows');section.append(node('h4',`成交量分布 · 时段 ${profile.session+1}`));
    for(const row of [...rows].reverse()){const line=node('div'),meter=node('meter');meter.min=0;meter.max=maximum;meter.value=row.volume;meter.setAttribute('aria-label',`${number(row.low)}–${number(row.high)} · ${number(row.volume)}`);line.append(node('span',`${number(row.low)}–${number(row.high)}`),meter,node('span',number(row.volume)));list.append(line);}section.append(list);
  }return section;
}
function renderResult(result) {
  state.result=result;
  const container=$('indicator-result'),definition=catalog.find(item=>item.id===state.selected);container.replaceChildren();
  const head=node('div',undefined,'indicator-result-head'),title=node('div');title.append(node('h3',definition.title),node('p',stateText(result)));head.append(title);container.append(head);
  if(result.status!=='ready'){container.append(node('p','缺少依赖时不生成信号、不使用同周期或零值代替其他数据。','indicator-caption'));return;}
  const recent=result.signals.filter(signal=>signal.index===state.snapshot.bars.length-1);
  title.append(node('p',`历史信号/结构事件 ${result.signals.length}个 · 最新完整K ${recent.length?recent.map(item=>sideName(item.side)).join('、'):'未触发'} · 不代表已验证买卖点`));
  if(state.selected!=='goal-setting-strategies'){const chart=node('div',undefined,'indicator-chart');chart.append(drawChart(state.snapshot.bars,result));container.append(chart);}
  if(result.profiles?.length)container.append(drawProfiles(result.profiles));
  for(const plot of result.plots.filter(item=>item.pane==='oscillator')){const panel=node('details',undefined,'indicator-pane'),summary=node('summary',plot.name);panel.append(summary,drawChart(state.snapshot.bars,result,plot));container.append(panel);}
  if(result.progress){const progress=node('div',undefined,'indicator-caption');progress.append(node('strong',`${result.progress.name} · ${result.progress.complete}/${result.progress.total} · ${number(result.progress.percent)}%`));for(const goal of result.progress.goals)progress.append(node('p',(goal.done?'✓ ':'○ ')+goal.label));container.append(progress);}
  if(result.summary){const summary=node('details',undefined,'indicator-summary');summary.append(node('summary','原指标计算摘要'));const list=node('dl');const entries=(value,prefix='')=>{for(const [key,item]of Object.entries(value)){if(item===null||['string','number','boolean'].includes(typeof item)){list.append(node('dt',prefix+key),node('dd',typeof item==='number'?number(item):item===null?'—':String(item)));}else if(!Array.isArray(item))entries(item,prefix+key+' / ');}};entries(result.summary);summary.append(list);container.append(summary);}
  const values=result.plots.filter(plot=>Array.isArray(plot.values)).map(plot=>`${plot.name}：${number(plot.values.at(-1))}`);
  if(values.length)container.append(node('p','最新完整K指标值 · '+values.join(' · '),'indicator-caption'));
  const notes=node('ul',undefined,'indicator-notes');
  for(const text of [...result.notes,'本移植尚未完成TradingView逐点数值对账，不等于收益验证。B/S表示多向/空向研究信号；枢轴在确认K之后可知，信号在该根完整收盘后才可用。结构事件与目标进度不代表交易。'])notes.append(node('li',text));container.append(notes);
  const signals=result.signals.slice(-30).reverse();
  if(signals.length) {
    const scroll=node('div',undefined,'table-scroll'),table=node('table',undefined,'indicator-table'),thead=node('thead'),header=node('tr'),body=node('tbody');
    for(const label of ['确认K · UTC开盘日','方向 / 事件','参考价格','失效参考','目标参考'])header.append(node('th',label));thead.append(header);
    for(const signal of signals){const row=node('tr');for(const value of [day(signal.time),signal.label||signal.type||sideName(signal.side),number(signal.entry),number(signal.stop),number(signal.target)])row.append(node('td',value));body.append(row);}
    scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','最近30项研究信号');table.append(thead,body);scroll.append(table);container.append(scroll);
  }
}
function choose(id) {
  state.selected=id;state.result=null;state.parameters=structuredClone(catalog.find(item=>item.id===id).defaults);$('indicator-select').value=id;renderParameters();
  if(state.snapshot){const result=state.results.get(id)||compute(id,state.parameters);renderResult(result);}
}
async function readJson(path) {const response=await fetch(path,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error(`${path}读取失败（${response.status}）`);return response.json();}
async function refresh() {
  if(state.loading)return;state.loading=true;state.error=null;renderProvenance();
  try {
    const [dataRead,marketRead]=await Promise.allSettled([readJson('data/latest.json'),readJson('viprasol-market.json')]);
    if(dataRead.status==='rejected')throw dataRead.reason;
    const snapshot=dataRead.value,market=marketRead.status==='fulfilled'?marketRead.value:state.market;
    await verifySnapshot(snapshot,state.snapshot);
    if(market&&(!['XBT/USD','BTC/USD'].includes(market.symbol)||!Number.isFinite(market.tickSize)||market.tickSize<=0))throw Error('交易对规格与BTC/USD不一致');
    state.snapshot=snapshot;state.market=market;state.marketError=marketRead.status==='rejected'?marketRead.reason.message:null;state.readAt=new Date().toISOString();state.results.clear();renderProvenance();
    for(const definition of catalog){state.results.set(definition.id,compute(definition.id,definition.defaults));await new Promise(resolve=>setTimeout(resolve,0));}
    renderLibrary();renderResult(compute(state.selected,state.parameters));
  }catch(error){state.error=error.message;}
  finally{state.loading=false;renderProvenance();}
}
$('indicator-select').replaceChildren(...catalog.map(definition=>{const option=node('option',definition.title);option.value=definition.id;return option;}));
$('indicator-select').addEventListener('change',event=>choose(event.target.value));
$('indicator-window').addEventListener('change',event=>{state.window=event.target.value==='all'?'all':Number(event.target.value);if(state.result)renderResult(state.result);else if(state.results.has(state.selected))renderResult(state.results.get(state.selected));});
$('indicator-library').addEventListener('click',event=>{const button=event.target.closest('[data-choose-indicator]');if(button){choose(button.dataset.chooseIndicator);$('indicator-heading').scrollIntoView({block:'start'});}});
$('indicator-form').addEventListener('input',event=>{
  const input=event.target,key=input.dataset.paramKey;if(!key)return;
  if(input.dataset.goalIndex!==undefined){const goal=state.parameters[key][Number(input.dataset.goalIndex)];if(input.type==='checkbox')goal.done=input.checked;else goal.label=input.value;}
  else state.parameters[key]=input.type==='checkbox'?input.checked:input.type==='number'?(input.value===''?NaN:Number(input.value)):input.value;
  $('indicator-run').textContent='按当前参数重新计算';
});
$('indicator-form').addEventListener('submit',event=>{event.preventDefault();if(!state.snapshot)return;state.result=compute(state.selected,state.parameters);renderResult(state.result);$('indicator-run').textContent='计算当前指标';});
$('indicator-refresh').addEventListener('click',refresh);
new ResizeObserver(entries=>{const width=Math.max(300,Math.min(960,Math.round(entries[0].contentRect.width)-32));if(width!==state.chartWidth){state.chartWidth=width;if(state.result)renderResult(state.result);}}).observe($('indicator-result'));
renderLibrary();choose(state.selected);refresh();
