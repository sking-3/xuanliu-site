/* Display archived observations in the account and market scope in which the source returned them. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksPositionHistoryView=api;
})(globalThis,function(){
  'use strict';
  const statuses={complete:'完整公开快照',partial:'部分可见',hidden:'仓位未公开',unavailable:'来源不可用',stale:'上次样本已过期'};
  const changes={first_seen:'首次见到',increased:'两次观察间增加',decreased:'两次观察间减少',no_longer_seen:'后一次完整观察未再见'};
  const scopes={default_perp_dex:'默认永续市场',public_lead_futures:'公开带单合约',public_swap_subpositions:'公开永续带单'};
  const idPatterns={Binance:/^\d{19}$/,Bitget:/^\d{15,23}$/,OKX:/^(?:[0-9A-Za-z]{16}|[0-9A-Za-z]{18})$/,Hyperliquid:/^0x[a-f0-9]{40}$/};
  function finite(n){
    if(typeof n!=='number'&&(typeof n!=='string'||!n.trim()))return null;
    const v=Number(n);return Number.isFinite(v)?v:null;
  }
  function exposure(snapshot){
    const missing={gross:null,long:null,short:null,leverage:null,currency:null};
    if(snapshot.status!=='complete'||!Array.isArray(snapshot.positions))return missing;
    const rows=snapshot.positions;
    const currency=rows[0]?.currency||snapshot.equity?.currency;
    if(!currency||rows.some(p=>p.currency!==currency||finite(p.notional)===null||finite(p.notional)<0||!['long','short'].includes(p.side)))return missing;
    let long=0,short=0;
    for(const p of rows){if(p.side==='long')long+=finite(p.notional);else short+=finite(p.notional);}
    const gross=long+short,eq=finite(snapshot.equity?.value);
    if(!Number.isFinite(gross))return missing;
    return {gross,long,short,currency,leverage:eq>0&&snapshot.equity.currency===currency?gross/eq:null};
  }
  const amount=v=>finite(v)===null?'—':finite(v).toLocaleString('zh-CN',{maximumFractionDigits:8});
  const time=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
  const side=v=>({long:'多',short:'空',net:'净持仓'})[v]||'—';
  function mount(host,r){
    const doc=host.ownerDocument||document;
    function el(tag,content,cls){const element=doc.createElement(tag);if(content!=null)element.textContent=content;if(cls)element.className=cls;return element;}
    if(!idPatterns[r.exchange]?.test(r.accountId))return {destroy(){}};
    const controller=new AbortController(),base='position-history/'+r.exchange.toLowerCase()+'/'+encodeURIComponent(r.accountId)+'/';
    const details=el('details'),heading=el('summary','仓位观察与历史敞口'),hint=el('p','读取归档索引…','meta'),content=el('div');
    const originBar=el('div',null,'period-switch');
    originBar.setAttribute('aria-label','仓位归档来源');
    details.append(heading,content);host.replaceChildren(hint,originBar,details);
    let index=null,loaded=null,version=0,origin='server',error404=false,localFailed=null,timer=null;
    const browser=r.exchange==='Hyperliquid'?globalThis.BooksPositionObservations?.local:null;
    const indexes={server:null,browser:null},labels={server:'本站定时采样',browser:'此浏览器所见'};
    originBar.hidden=true;
    const cache=new Map();
    async function load(name){
      const response=await fetch(base+name+'.json',{signal:controller.signal,credentials:'omit',redirect:'error'});
      if(!response.ok){const e=Error('archive_read');e.status=response.status;throw e;}
      const data=await response.json();
      if(data.schemaVersion!==1||data.accountId!==r.accountId||data.exchange!==r.exchange)throw Error('archive_identity');
      return data;
    }
    function table(headers,rows,format=row=>row,latestFirst=false){
      const wrap=el('div',null,'table-wrap'),grid=el('table'),head=el('thead'),headRow=el('tr'),body=el('tbody');
      headers.forEach(label=>headRow.append(el('th',label)));head.append(headRow);grid.append(head,body);wrap.append(grid);
      let cursor=0;const more=el('button','显示更多记录','detail-button');more.type='button';
      function appendPage(){for(let i=cursor;i<Math.min(rows.length,cursor+30);i++){const at=latestFirst?rows.length-1-i:i,row=format(rows[at],at);const tr=el('tr');row.forEach(v=>tr.append(el('td',v??'—')));body.append(tr);}cursor+=30;more.hidden=cursor>=rows.length;}
      appendPage();more.addEventListener('click',appendPage);wrap.append(more);return wrap;
    }
    function plot(points,field,unit){
      const result=el('div',null,'history-plot');
      const values=points.filter(p=>Number.isFinite(p[field]));
      if(values.length<2){result.textContent=values.length?'只有一个有值的快照，详见下表。':'本月缺少这一指标的完整快照。';return result;}
      const ns='http://www.w3.org/2000/svg',svg=doc.createElementNS(ns,'svg');
      svg.setAttribute('viewBox','0 0 550 104');svg.setAttribute('role','img');
      svg.setAttribute('aria-label',values.length+' 个独立快照，单位 '+unit+'，最近 '+amount(values.at(-1)[field]));
      let low=Infinity,hi=-Infinity;
      for(const p of values){low=Math.min(low,p[field]);hi=Math.max(hi,p[field]);}
      const first=Date.parse(values[0].observedAt),last=Date.parse(values.at(-1).observedAt),span=last-first||1;
      const bins=new Map();
      for(const p of values){
        const key=Math.floor(260*(Date.parse(p.observedAt)-first)/span),bin=bins.get(key);
        if(!bin)bins.set(key,{min:p,max:p});
        else{if(p[field]<bin.min[field])bin.min=p;if(p[field]>bin.max[field])bin.max=p;}
      }
      for(const p of new Set([values[0],...Array.from(bins.values()).flatMap(bin=>[bin.min,bin.max]),values.at(-1)])){
        const dot=doc.createElementNS(ns,'circle'),title=doc.createElementNS(ns,'title');
        dot.setAttribute('cx',8+534*(Date.parse(p.observedAt)-first)/span);
        dot.setAttribute('cy',hi===low?52:94-84*(p[field]-low)/(hi-low));dot.setAttribute('r','2.5');
        title.textContent=time(p.observedAt)+' · '+amount(p[field])+' '+unit;dot.append(title);svg.append(dot);
      }
      result.append(svg,el('small',time(values[0].observedAt)+' 至 '+time(values.at(-1).observedAt)+' · '+values.length+' 个有值快照 · '+unit));
      return result;
    }
    const sourceHosts={Binance:['www.binance.com'],Bitget:['www.bitget.com','api.bitget.com'],OKX:['www.okx.com'],Hyperliquid:['api.hyperliquid.xyz','app.hyperliquid.xyz']};
    function link(name,href){
      const a=el('a',name,'source-link');a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;
    }
    function drawObservation(parent,samples,month){
      const section=el('section',null,'history-observation'),picker=el('select'),target=el('div');
      section.append(el('h4','单次仓位明细'),picker,target);parent.append(section);
      picker.setAttribute('aria-label','查看仓位快照时间');
      let page=0;const newer=el('button','较新快照'),older=el('button','较早快照');
      newer.type='button';older.type='button';
      function choices(){
        picker.replaceChildren();const end=samples.length-page*50,start=Math.max(0,end-50);
        for(let i=end-1;i>=start;i--){const s=samples[i],option=el('option',time(s.observedAt)+' · '+statuses[s.status]);option.value=String(i);picker.append(option);}
        picker.value=String(end-1);newer.disabled=page===0;older.disabled=start===0;
      }
      if(samples.length>50){section.append(newer,older);newer.addEventListener('click',()=>{page--;choices();select();});older.addEventListener('click',()=>{page++;choices();select();});}
      choices();
      function select(){
        const s=samples[Number(picker.value)];if(!s)return;
        const scope=scopes[s.scope]||s.scope,ref=s.sourceTime&&s.sourceTime!==s.observedAt?' · 来源时间 '+time(s.sourceTime):'';
        target.replaceChildren(el('p',r.exchange+' · '+scope+' · '+statuses[s.status]+' · 读取 '+time(s.observedAt)+ref,'detail-method'));
        if(s.positions.length){
          const unitValue=(v,u)=>finite(v)===null?'—':amount(v)+(u?' '+u:'');
          target.append(table(['合约','方向','数量','单位','来源开仓时间','开仓均价','标记价','名义金额','保证金','来源杠杆','浮动盈亏'],
            s.positions.map(p=>[p.symbol,side(p.side),amount(p.quantity),p.quantityUnit,time(p.sourceOpenedAt),amount(p.entryPrice),amount(p.markPrice),unitValue(p.notional,p.currency),unitValue(p.marginUsed,p.currency),p.leverage==null?'—':amount(p.leverage)+'×',unitValue(p.unrealizedPnl,p.currency)])));
        }else target.append(el('p',s.status==='complete'?'这次完整读取中未见仓位。':'本次读取没有可显示的仓位明细。','meta'));
        const links=el('div',null,'lead-source-links');
        if(origin==='server')links.append(link('查看本月归档数据',base+month+'.json'));
        const part=r.activity?.positions;
        if(part?.evidencePath&&s.evidenceSha256&&part.evidenceSha256===s.evidenceSha256)links.append(link('当次交易所回执',part.evidencePath));
        let url;try{url=new URL(s.sourceUrl);}catch(_){}
        if(url?.protocol==='https:'&&sourceHosts[r.exchange]?.includes(url.hostname)&&!url.username&&!url.password)links.append(link('交易所来源 ↗',url.href));
        target.append(links);
        if(s.evidenceSha256)target.append(el('small','回执 SHA-256 '+s.evidenceSha256,'history-digest'));
      }
      select();picker.addEventListener('change',select);
    }
    function drawMonth(target,data){
      const snapshots=data.snapshots,scopeSelect=el('select'),scopeNames=[...new Set(snapshots.map(s=>s.scope))];
      scopeSelect.setAttribute('aria-label','观察市场');for(const name of scopeNames){const option=el('option',scopes[name]||name);option.value=name;scopeSelect.append(option);}
      const body=el('div');target.replaceChildren();if(scopeNames.length>1)target.append(scopeSelect);target.append(body);
      function drawScope(){
        const scope=scopeSelect.value||scopeNames[0],rows=snapshots.filter(s=>s.scope===scope);
        const samples=rows.map(s=>({observedAt:s.observedAt,...exposure(s)})),units=[...new Set(samples.map(p=>p.currency).filter(Boolean))];
        body.replaceChildren(el('p','市场 '+(scopes[scope]||scope)+' · 时间均为北京时间','meta'));
        const display=el('div'),choices=el('div',null,'period-switch'),buttons=[];
        function change(field){
          for(const item of buttons)item.button.setAttribute('aria-pressed',String(item.key===field));
          display.replaceChildren();
          const series=field==='leverage'?[{unit:'×',points:samples}]:units.map(unit=>({unit,points:samples.filter(p=>p.currency===unit)}));
          for(const {unit,points} of series)display.append(plot(points,field,unit));
          if(!series.length)display.append(el('small','缺少完整仓位名义金额，无法核实账户敞口。'));
        }
        for(const [key,label] of [['gross','名义敞口'],['leverage','实际杠杆']]){
          const button=el('button',label);button.type='button';button.addEventListener('click',()=>change(key));buttons.push({key,button});choices.append(button);
        }
        change('gross');body.append(choices,display,el('p','总名义敞口按同一完整快照的多空名义金额绝对值相加。实际杠杆还需同次、同币种的账户权益。','detail-method'));
        body.append(table(['快照时间','可见范围','可见仓位数','多仓名义金额','空仓名义金额','总名义敞口','实际杠杆'],rows,(s,i)=>{
          const p=samples[i],withUnit=n=>n===null?'—':amount(n)+' '+p.currency;
          return [time(s.observedAt),statuses[s.status]||'待核实',s.status==='complete'||s.status==='partial'?s.positions.length:'—',withUnit(p.long),withUnit(p.short),withUnit(p.gross),p.leverage==null?'—':amount(p.leverage)+'×'];
        },true));
        drawObservation(body,rows,data.month);
        const events=data.events.filter(e=>e.scope===scope).reverse();
        if(events.length){body.append(el('h4','两次公开观察间的变化'),table(['后次观察','前次观察','合约','方向','观测变化','前次数量','后次数量','单位'],events.map(e=>[time(e.to),time(e.from),e.symbol,side(e.side),changes[e.type],amount(e.beforeQuantity),amount(e.afterQuantity),e.quantityUnit])));}
      }
      drawScope();scopeSelect.addEventListener('change',drawScope);
    }
    async function selectMonth(name,target){
      const token=++version;target.textContent='读取月份快照…';
      try{
        const key=origin+'/'+name;
        const data=cache.get(key)||(origin==='browser'?await browser.month(r.accountId,name):await load(name));
        if(controller.signal.aborted||token!==version)return;
        if(data.month!==name||!Array.isArray(data.snapshots)||!Array.isArray(data.events))throw Error('archive_month');
        cache.set(key,data);drawMonth(target,data);
      }catch(_){if(!controller.signal.aborted&&token===version)target.textContent='本月档案读取失败，请重新选择月份。';}
    }
    function expand(){
      if(!details.open||!index||loaded===index)return;
      loaded=index;content.replaceChildren();const select=el('select'),section=el('div');
      if(index.open.length){
        content.append(el('h4','最后一次公开观察到的仓位'),table(['合约','方向','最后可见数量','单位','开仓均价','最后标记价','最后浮动盈亏','来源杠杆','首次见到','最后见到'],index.open.map(p=>[p.symbol,side(p.side),amount(p.quantity),p.quantityUnit,amount(p.entryPrice),amount(p.markPrice),finite(p.unrealizedPnl)===null?'—':amount(p.unrealizedPnl)+(p.currency?' '+p.currency:''),p.leverage==null?'—':amount(p.leverage)+'×',time(p.firstSeenAt),time(p.lastSeenAt)])));
      }
      if(!index.months.length)return;
      for(const name of [...index.months].reverse()){const option=el('option',name);option.value=name;select.append(option);}
      select.setAttribute('aria-label','仓位归档月份');content.append(select,section);select.addEventListener('change',()=>selectMonth(select.value,section));selectMonth(index.months.at(-1),section);
    }
    details.addEventListener('toggle',expand);
    function validIndex(d){
      if(!d)return null;
      if(d.schemaVersion!==1||d.accountId!==r.accountId||d.exchange!==r.exchange||!Array.isArray(d.months)||!d.months.every(m=>/^\d{4}-(?:0[1-9]|1[0-2])$/.test(m))||!Array.isArray(d.open)||!d.latest||!Object.hasOwn(statuses,d.latest.status))throw Error('archive_index');
      return d;
    }
    function show(){
      if(controller.signal.aborted)return;
      if(!indexes[origin])origin=indexes.server?'server':indexes.browser?'browser':'server';
      index=indexes[origin];
      originBar.replaceChildren();originBar.hidden=!indexes.server||!indexes.browser;
      if(!originBar.hidden)for(const name of ['server','browser']){
        const control=el('button',labels[name]);control.type='button';control.setAttribute('aria-pressed',String(name===origin));
        control.addEventListener('click',()=>{if(origin!==name){origin=name;loaded=null;++version;show();}});originBar.append(control);
      }
      details.hidden=!index;
      const localWarning=localFailed==='quota_exceeded'?'本机空间已满，新的观察未保存，仍可查看先前记录。':localFailed?'本机记录存储暂不可用。':'';
      if(!index){hint.textContent=(error404?'该账户尚无可核实的仓位快照档案。':'仓位观察档案暂不可读。')+localWarning;return;}
      const latestSeen=index.open.map(p=>p.lastSeenAt).filter(Boolean).sort().at(-1);
      hint.textContent=labels[origin]+' · '+index.counts.snapshots+' 次观察 · '+r.exchange+' · 最近 '+time(index.latest.observedAt)+'（北京） · '+statuses[index.latest.status]+(latestSeen?' · 仓位最后见于 '+time(latestSeen):'');
      expand();
    }
    async function readBrowser(){
      if(!browser)return;
      try{indexes.browser=validIndex(await browser.index(r.accountId));localFailed=browser.error?.(r.accountId)||null;}
      catch(_){localFailed=browser.error?.(r.accountId)||'unavailable';}
    }
    async function readServer(){
      try{indexes.server=validIndex(await load('index'));}
      catch(e){error404=e.status===404;}
    }
    Promise.all([readServer(),readBrowser()]).then(show);
    function changed(event){
      if(event.detail?.accountId!==r.accountId||timer!==null)return;
      timer=setTimeout(async()=>{timer=null;await readBrowser();if(origin==='browser'){cache.clear();loaded=null;++version;}show();},2500);
    }
    if(browser)globalThis.addEventListener('books-position-observation',changed);
    return {destroy(){
      controller.abort();if(timer!==null)clearTimeout(timer);
      if(browser)globalThis.removeEventListener('books-position-observation',changed);
      host.replaceChildren();
    }};
  }
  return {mount,exposure};
});
