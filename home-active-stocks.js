'use strict';
(function(root){
  const METHOD='mean_daily_turnover_5_sessions',FILE='research-data/a-active-stocks.json';
  function requireValue(ok){if(!ok)throw Error('Invalid active-stock snapshot');}
  function text(value,max=80){return typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);}
  function day(value){
    requireValue(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value));
    const time=Date.parse(value+'T00:00:00Z');
    requireValue(Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value);
    return time;
  }
  function symbol(exchange,code){
    requireValue(typeof code==='string'&&((exchange==='SH'&&/^(600|601|603|605|688)\d{3}$/.test(code))||
      (exchange==='SZ'&&/^(000|001|002|003|300|301)\d{3}$/.test(code))));
    return (exchange==='SH'?'SSE:':'SZSE:')+code;
  }
  function chartHref(exchange,code){return 'chart.html?tvwidgetsymbol='+encodeURIComponent(symbol(exchange,code));}
  function summarize(data,now=Date.now()){
    requireValue(data&&data.schemaVersion===1&&data.method===METHOD&&typeof data.synthetic==='boolean');
    if(data.status==='not_configured'){
      requireValue(data.synthetic===false&&data.dataAsOf===null&&data.source===null&&data.coverage===null&&
        Array.isArray(data.tradingDates)&&data.tradingDates.length===0&&Array.isArray(data.rows)&&data.rows.length===0);
      return {status:'not_configured',rows:[]};
    }
    requireValue(data.status==='ready'&&Number.isFinite(now));
    const dates=data.tradingDates;
    requireValue(Array.isArray(dates)&&dates.length===5);
    dates.forEach((date,i)=>{const time=day(date),weekday=new Date(time).getUTCDay();
      requireValue(weekday!==0&&weekday!==6&&(!i||dates[i-1]<date));});
    requireValue(data.dataAsOf===dates[4]&&data.completedSessionsVerified===true);
    // The producer must verify the exchange calendar and final daily records.
    // A weekday check alone does not establish a trading day or completeness.
    const end=day(data.dataAsOf)+15*3600000-8*3600000;
    const generated=Date.parse(data.generatedAt);
    requireValue(typeof data.generatedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.generatedAt)&&
      Number.isFinite(generated)&&new Date(generated).toISOString()===data.generatedAt&&generated>=end&&generated<=now);
    requireValue(data.amountUnit==='CNY'&&data.source&&text(data.source.id)&&text(data.source.name)&&
      data.source.publicDisplayApproved===true&&text(data.source.permissionReference,500));
    if(!data.synthetic){
      const permission=new URL(data.source.permissionReference);
      requireValue(permission.protocol==='https:'&&!permission.username&&!permission.password);
    }
    const coverage=data.coverage;
    requireValue(coverage&&coverage.scope==='supplied_stock_sample'&&
      Number.isInteger(coverage.supplied)&&coverage.supplied>0&&coverage.supplied<=10000&&
      Number.isInteger(coverage.complete)&&coverage.complete>0&&Number.isInteger(coverage.excluded)&&coverage.excluded>=0&&
      coverage.complete+coverage.excluded===coverage.supplied);
    requireValue(Array.isArray(data.rows)&&data.rows.length===coverage.complete);
    const seen=new Set();
    const rows=data.rows.map(row=>{
      const ticker=symbol(row.exchange,row.code);
      requireValue(!seen.has(ticker)&&text(row.name,40));seen.add(ticker);
      requireValue(Array.isArray(row.dailyAmounts)&&row.dailyAmounts.length===5);
      let sum=0;
      row.dailyAmounts.forEach((entry,i)=>{
        requireValue(entry&&entry.date===dates[i]&&typeof entry.amount==='number'&&
          Number.isFinite(entry.amount)&&entry.amount>=0&&entry.amount<=1e15);
        sum+=entry.amount;
      });
      return {symbol:ticker,code:row.code,name:row.name,meanAmount:sum/5,href:chartHref(row.exchange,row.code)};
    }).filter(row=>row.meanAmount>0).sort((a,b)=>b.meanAmount-a.meanAmount||a.symbol.localeCompare(b.symbol)).slice(0,10);
    return {status:'ready',rows,synthetic:data.synthetic,source:data.source.name,dates:dates.slice(),
      dataAsOf:data.dataAsOf,coverage:{...coverage},historical:now-end>72*3600000};
  }
  function amount(value){return (value/1e8).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})+' 亿';}
  function render(doc,view){
    const section=doc.getElementById('home-active-stocks'),status=doc.getElementById('active-stocks-status');
    const list=doc.getElementById('active-stocks-list'),meta=doc.getElementById('active-stocks-meta');
    list.replaceChildren();meta.textContent='';section.dataset.state=view.status;section.setAttribute('aria-busy','false');
    if(view.status!=='ready'){
      status.textContent=view.status==='not_configured'?'待接入 · 暂无已核验的成交活跃名单':'名单暂不可用 · 本次未展示排名';
      return;
    }
    status.textContent=(view.synthetic?'合成测试数据 · 非真实行情 · ':'')+(view.historical?'历史快照':'日终快照')+' · 截至 '+view.dataAsOf+'（上海）';
    meta.textContent='来源：'+view.source+' · '+view.dates[0]+' 至 '+view.dataAsOf+' · 所提供样本 '+view.coverage.supplied+
      ' 只，完整数据 '+view.coverage.complete+' 只，缺失排除 '+view.coverage.excluded+' 只 · 展示前 '+view.rows.length+' 名';
    for(const [index,row]of view.rows.entries()){
      const li=doc.createElement('li'),link=doc.createElement('a'),rank=doc.createElement('span');
      const stock=doc.createElement('span'),name=doc.createElement('strong'),code=doc.createElement('small'),value=doc.createElement('span');
      rank.className='active-stock-rank';rank.textContent=String(index+1);
      name.textContent=row.name;code.textContent=row.symbol;stock.className='active-stock-name';stock.append(name,code);
      value.className='active-stock-amount';value.textContent=amount(row.meanAmount);
      link.href=row.href;link.setAttribute('aria-label',row.name+'，五日日均成交额 '+amount(row.meanAmount)+'，打开站内日终图表');
      link.append(rank,stock,value);li.append(link);list.append(li);
    }
    if(!view.rows.length){const li=doc.createElement('li');li.textContent='该样本内没有非零成交额记录';list.append(li);}
  }
  async function mount(doc,options={}){
    if(!doc.getElementById('home-active-stocks'))return;
    const fetcher=options.fetch||root.fetch.bind(root),now=options.now||Date.now;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetcher(FILE,{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});
      if(!response.ok)throw Error('Snapshot unavailable');
      const length=Number(response.headers.get('content-length')||0);if(length>4*1024*1024)throw Error('Oversized snapshot');
      const raw=await response.text();if(raw.length>4*1024*1024)throw Error('Oversized snapshot');
      render(doc,summarize(JSON.parse(raw),now()));
    }catch{render(doc,{status:'unavailable',rows:[]});}
    finally{clearTimeout(timer);}
  }
  const api={METHOD,FILE,symbol,chartHref,summarize,amount,render,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.BooksActiveStocks=api;if(root.document)mount(root.document);}
})(typeof globalThis==='object'?globalThis:this);
