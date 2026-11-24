'use strict';
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{
  root.BooksEntryBars=api;
  const start=()=>{root.BooksEntryBarsApp=api.mount(root.document);};
  if(root.document&&root.BooksTrendControllerApp)start();
  else if(root.document)root.addEventListener('books:trend-mounted',start,{once:true});
 }
})(globalThis,()=>{
 const schema='books.a-share.entry-evidence.v1',policyVersion='books.entry-bars.2026-11-24.v1';
 const labels={waiting_confirmation:'等待收盘确认',waiting_trigger:'等待后日突破',triggered_observation:'日线已观察到突破',invalidated:'固定失效位已破',expired:'观察窗口已过期',unavailable:'日线缺失或停牌',unexecutable:'一字价日，未假设成交',ambiguous:'日线顺序不明，未假设成交',chased:'开盘追高排除'};
 const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
 const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 const price=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:4}):'—';
 const beijing=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const stamp=value=>validTime(value)?beijing.format(new Date(value))+'（北京）':'未提供';
 const binding=value=>typeof value?.generation==='string'&&value.generation&&validDay(value.day)&&typeof value.sourceId==='string'&&value.sourceId&&validTime(value.asOf)?JSON.stringify([value.generation,value.day,value.sourceId,value.asOf]):null;
 function validate(value,current,code){
  if(value?.schema!==schema||binding(value)!==binding(current)||!binding(current)||value.stock?.code!==code||value.entryPolicyVersion!==policyVersion||value.entryOutcomeValidated!==false||value.recommended!==false||!Array.isArray(value.items)||value.items.length>3)throw Error('关键K与当前股票、日线批次或规则不一致，未采用返回结果。');
  const ids=new Set();
  for(const [index,item]of value.items.entries()){
   if(!validDay(item.formationDay)||item.formationDay>value.day||item.id!==code+':'+item.formationDay||ids.has(item.id)||!Object.hasOwn(labels,item.replayStatus)||!Array.isArray(item.patternIds)||!item.patternIds.length||!Array.isArray(item.recommendationReasons)||item.recommendationReasons.some(reason=>typeof reason!=='string')||typeof item.reason!=='string'||typeof item.lateDiscovery!=='boolean'||item.status!==(item.lateDiscovery?'late_discovery':item.replayStatus))throw Error('关键K日期、阶段或证据不完整，未采用返回结果。');
   ids.add(item.id);
   if(item.keyBarDay!==null&&(!validDay(item.keyBarDay)||item.keyBarDay<=item.formationDay||item.keyBarDay>value.day)||item.triggerDay!==null&&(!validDay(item.triggerDay)||item.triggerDay<item.formationDay||item.keyBarDay&&item.triggerDay<=item.keyBarDay||item.triggerDay>value.day)||item.knownAt!==null&&!validTime(item.knownAt)||!Number.isFinite(item.invalidation?.below)||item.invalidation.below<=0||item.trigger!==null&&(!Number.isFinite(item.trigger?.above)||item.trigger.above<=item.invalidation.below))throw Error('关键K参考位或时间顺序无效，未采用返回结果。');
   if(item.chartUrl!==null){
    const url=new URL(item.chartUrl,'https://books.invalid');
    if(!item.chartUrl.startsWith('/api/a-share-daily/entry-chart?')||url.origin!=='https://books.invalid'||url.pathname!=='/api/a-share-daily/entry-chart'||url.hash||url.searchParams.get('generation')!==value.generation||url.searchParams.get('code')!==code||url.searchParams.get('setup')!==String(index)||[...url.searchParams.keys()].length!==3)throw Error('关键K图表与当前批次不一致，未加载图表。');
   }
  }
  return value;
 }
 function mount(doc,options={}){
  const body=doc?.getElementById('trend-results'),env=doc?.defaultView||globalThis,app=options.app||env.BooksTrendControllerApp;
  if(!body||!app?.getState)return null;
  const cards=new Map();let destroyed=false,scheduled=false,nextId=0;
  function text(tag,content,className){const node=doc.createElement(tag);node.textContent=content;if(className)node.className=className;return node;}
  function stop(record){record.sequence++;record.controller?.abort();record.controller=null;record.loading=false;}
  function render(record){
   const {button,panel}=record;button.setAttribute('aria-expanded',String(record.open));button.disabled=!record.binding;panel.hidden=!record.open;
   if(!record.open)return;
   const children=[],data=record.data;
   children.push(text('p',record.loading?'正在读取本批关键K证据…':record.error||'关键K研究回放 · 未推荐','entry-bars-status'));
   if(data){
    children.push(text('p','数据日 '+data.day+' · 来源 '+data.sourceId+' · 读取 '+stamp(data.sourceFetchedAt),'entry-bars-source'));
    if(!data.items.length)children.push(text('p','本批没有已形成的关键K证据；不补造入场点。','entry-bars-note'));
    for(const item of data.items){
     const row=doc.createElement('article');row.className='entry-bars-record';
     const heading=text('h5',item.keyBarDay?'收盘确认K':'形成K · 尚未确认','entry-bars-heading');
     heading.append(text('span',(item.lateDiscovery?'晚于当时开盘发现 · ':'')+labels[item.replayStatus]));row.append(heading);
     const facts=doc.createElement('dl');facts.className='entry-bars-facts';
     for(const [label,value]of [[item.keyBarDay?'关键K日期':'形成K日期',item.keyBarDay||item.formationDay],['突破参考位',item.trigger?'> '+price(item.trigger.above):'待收盘确认'],['失效参考位','< '+price(item.invalidation.below)]]){
      const cell=doc.createElement('div');cell.append(text('dt',label),text('dd',value));facts.append(cell);
     }
     row.append(facts,text('p','F 形成 '+item.formationDay+' · C 收盘确认 '+(item.keyBarDay||'未形成')+' · '+(item.replayStatus==='triggered_observation'?'T 越位观察 ':'终止或待观察 ')+(item.triggerDay||'—'),'entry-bars-note'));
     if(item.chartUrl&&!record.failedCharts.has(item.id)){
      const image=doc.createElement('img');image.className='entry-bars-chart';image.alt=(data.stock.name||data.stock.code)+'：F形成、C收盘确认和后日触发的研究回放';image.loading='lazy';image.decoding='async';image.src=item.chartUrl;
      image.addEventListener('error',()=>{if(cards.get(record.card)===record&&record.data===data){record.failedCharts.add(item.id);render(record); }},{once:true});row.append(image);
     }else if(item.chartUrl)row.append(text('p','关键K图表未能载入，日期和参考位证据仍保留。','entry-bars-note'));
     row.append(text('p',item.reason,'entry-bars-note'));
     if(item.monitoring?.remainingSessions>0)row.append(text('p',item.monitoring.status==='future_condition_watch'?'下一已核验交易日 '+item.monitoring.nextSessionDay+' · 剩余 '+item.monitoring.remainingSessions+' 个交易日条件观察':'仅保留剩余窗口观察，下一交易日和新日线须重新核验。','entry-bars-note'));
     row.append(text('p','实际发现 '+stamp(item.knownAt)+' · '+item.recommendationReasons.join('；'),'entry-bars-note'));children.push(row);
    }
    children.push(text('p','前复权研究参考位，非实际委托报价。F为形成、C为收盘确认、T为后日越位观察；本触发规则尚未独立完成收益验证，不推荐。','entry-bars-note'));
   }
   if(record.error){const retry=text('button','重新读取本批关键K','entry-bars-retry');retry.type='button';retry.dataset.entryRetry='';retry.disabled=record.loading;children.push(retry);}
   panel.replaceChildren(...children);
  }
  function sync(){
   if(destroyed)return;
   const current=app.getState(),key=binding(current);
   for(const [card,record]of cards)if(!body.contains(card)){stop(record);record.section.remove();cards.delete(card);}
   for(const card of body.querySelectorAll('.trend-stock[data-code]')){
    const code=card.dataset.code;if(!/^\d{6}\.(SH|SZ)$/.test(code||''))continue;
    let record=cards.get(card);
    if(!record){
     const section=doc.createElement('section'),button=text('button','关键K · 查看确认与触发','entry-bars-toggle'),panel=doc.createElement('div');
     section.className='entry-bars';button.type='button';button.dataset.entryToggle='';panel.className='entry-bars-panel';panel.id='entry-bars-panel-'+(++nextId);panel.setAttribute('role','region');panel.setAttribute('aria-label',code+'关键K证据');button.setAttribute('aria-controls',panel.id);section.append(button,panel);
     record={card,section,button,panel,code,binding:key,open:false,loading:false,data:null,error:null,controller:null,sequence:0,failedCharts:new Set()};cards.set(card,record);
     const chart=card.querySelector('.trend-stock-chart');card.insertBefore(section,chart||null);render(record);
    }else if(record.binding!==key||record.code!==code){
     stop(record);record.code=code;record.binding=key;record.open=false;record.data=null;record.error=null;record.failedCharts.clear();record.panel.replaceChildren();record.panel.setAttribute('aria-label',code+'关键K证据');render(record);
    }
   }
  }
  function schedule(){if(destroyed||scheduled)return;scheduled=true;Promise.resolve().then(()=>{scheduled=false;sync();});}
  async function load(record){
   if(destroyed||record.loading||!record.binding)return;
   const current=app.getState();if(binding(current)!==record.binding||!body.contains(record.card)){sync();return;}
   const sequence=++record.sequence,controller=new AbortController();record.controller=controller;record.loading=true;record.error=null;render(record);
   const timer=env.setTimeout(()=>controller.abort(),30000);
   try{
    const response=await env.fetch('/api/a-share-daily/entries?'+new URLSearchParams({generation:current.generation,code:record.code}),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
    if(!response.ok)throw Error('本批关键K证据暂不可用（HTTP '+response.status+'）。');
    const data=validate(await response.json(),current,record.code);
    if(destroyed||sequence!==record.sequence||!body.contains(record.card)||binding(app.getState())!==record.binding)return;
    record.data=data;record.failedCharts.clear();
   }catch(error){if(!destroyed&&sequence===record.sequence&&body.contains(record.card)&&binding(app.getState())===record.binding)record.error=error.name==='AbortError'?'关键K读取超时，可重新读取本批证据。':error.name==='TypeError'?'关键K读取失败，可重新读取本批证据。':error.message;}
   finally{env.clearTimeout(timer);if(!destroyed&&sequence===record.sequence){record.loading=false;record.controller=null;render(record);}}
  }
  function click(event){
   const button=event.target.closest?.('[data-entry-toggle], [data-entry-retry]');if(!button)return;
   const record=cards.get(button.closest('.trend-stock'));if(!record)return;
   if(button.dataset.entryRetry!==undefined){load(record);return;}
   record.open=!record.open;if(!record.open)stop(record);render(record);if(record.open&&!record.data)load(record);
  }
  const observer=new env.MutationObserver(schedule);observer.observe(body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-code']});
  body.addEventListener('click',click);env.addEventListener('books:trend-run-finished',schedule);
  function destroy(){if(destroyed)return;destroyed=true;observer.disconnect();for(const record of cards.values()){stop(record);record.section.remove();}cards.clear();body.removeEventListener('click',click);env.removeEventListener('books:trend-run-finished',schedule);env.removeEventListener('pagehide',pagehide);}
  function pagehide(event){if(!event.persisted)destroy();}
  env.addEventListener('pagehide',pagehide);sync();
  return {sync,destroy,getState:()=>[...cards.values()].map(record=>({code:record.code,binding:record.binding,open:record.open,loading:record.loading,data:record.data,error:record.error}))};
 }
 return {mount,validate};
});
