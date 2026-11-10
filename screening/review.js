/* Local historical files are read in memory. No requests or storage. */
(() => {
  const root=document.querySelector('[data-screen-market]');
  if (!root) return;
  const market=root.dataset.screenMarket;
  const rules=market==='a' ? {
    M1:['炸板与缩量回收','需分时封开顺序及真实限价。持续破位反驳已回收。'],
    M2:['波段回访','需预先固定支撑锚点、容差与失效条件。事后画线无法验证。'],
    M3:['高标回调','需先核对同日地位和调整窗口。持续走弱不能确认回调结束。'],
    M4:['低吸与异常波动风险','需当时监管口径和事件日期。缺少异动记录不能判定规避成功。'],
    M5:['日周期 MACD 120／60','指标线、参数和触发未冻结，不能用价格均线替代。'],
    F1:['四K交集回收（研究）','收回参考区仅支持几何观察。复权不一致或跌破下沿会削弱解释。'],
    P1:['突破后缩量回访（研究）','未核对真实涨停价和分时顺序时，不能推断炸板。'],
    P2:['支撑回访（研究）','重新选择锚点会改变结论。需核对先验支撑和复权。']
  } : {
    U1:['事件形态','跳空、放量及正日收益须同时成立。缺公告时，催化仍待核。'],
    U2:['放量突破','须突破前20日高点且量比达标。失守突破位时复核。'],
    U3:['临近突破','仅在前20日高点下方观察。相对 SPY 转弱或跌破均线时复核。']
  };
  const get=id=>root.querySelector('#'+id);
  const rule=get('strategy'),group=get('category'),query=get('security-search');
  const source=get('file-state'),body=get('review-rows'),count=get('review-count'),file=get('research-file');
  const option=(select,key,label)=>select.add(new Option(label,key));
  for(const [key,[name]] of Object.entries(rules))option(rule,key,name);
  for(const status of market==='a'?['待核','排除']:['历史观察','待核','未命中','排除'])option(group,status,status);
  let book=null, page=0, generation=0;
  const size=25;
  function render() {
    const chosen=rule.value;
    get('falsifier').textContent=chosen?rules[chosen][1]:market==='a'?'五种原模式定义待补。四K与两种回访分支单列为研究观察。':'三条规则独立匹配，同一证券合并显示。收盘日期取自所选文件。';
    if(book?.parameters && chosen){
      const p=book.parameters;
      const thresholds={U1:'跳空 ≥ '+(100*p.event_gap).toFixed(1)+'%，量比 ≥ '+p.event_volume,
        U2:'突破前20日高点，量比 ≥ '+p.break_volume,
        U3:'距前20日高点不超过 '+(100*p.near_high).toFixed(1)+'%'};
      get('falsifier').textContent+= ' 本批参数 · '+thresholds[chosen]+'。最低 '+p.min_price+' USD，20日均成交额 ≥ '+(p.min_turnover/1e6)+' 百万美元。';
    }
    const q=query.value.trim().toUpperCase(),rows=(book?.rows||[]).filter(r=>
      (!chosen || r.hits.includes(chosen) || r.pending?.includes(chosen)) &&
      (!group.value || r.status===group.value) && (!q || (r.symbol+' '+r.name).toUpperCase().includes(q)));
    const pages=Math.ceil(rows.length/size);
    page=Math.max(0,Math.min(page,pages-1));
    count.textContent=book?rows.length+' 项 · '+(pages?page+1:0)+' / '+pages:'尚未载入历史文件';
    body.replaceChildren();
    for(const r of rows.slice(page*size,(page+1)*size)){
      const tr=document.createElement('tr');
      const description=r.hits.map(k=>rules[k][0]).join('、')||'—';
      for(const value of [r.symbol+' '+r.name,r.status,description,r.close==null?'—':r.close.toFixed(2),r.note]){
        const td=document.createElement('td');td.textContent=value;tr.append(td);
      }
      body.append(tr);
    }
    if(!rows.length){const td=document.createElement('td'),tr=document.createElement('tr');td.colSpan=5;td.textContent=book?'此筛选下没有记录。':'可查看策略条件和反证，载入文件后显示历史列表。';tr.append(td);body.append(tr);}
    get('back-page').disabled=page===0;get('next-page').disabled=page+1>=pages;
  }
  async function load() {
    const token=++generation,f=file.files[0];if(!f)return;
    try {
      if(f.size>16*1024*1024)throw Error();
      const parsed=JSON.parse(await f.text()),v=parsed[market];
      if(parsed.schema!=='books.research.review.v1'||!v||!/^\d{4}-\d{2}-\d{2}$/.test(v.asof)||
        !Array.isArray(v.rows)||v.rows.length>10000||typeof v.source!=='string'||v.source.length>250)throw Error();
      if(market==='us' && !['event_gap','event_volume','break_volume','near_high','min_price','min_turnover','max_extension'].every(k=>Number.isFinite(v.parameters?.[k])&&v.parameters[k]>=0))throw Error();
      const ids=new Set(),allowed=Array.from(group.options).map(o=>o.value).filter(Boolean);
      for(const r of v.rows){
        if(typeof r.symbol!=='string'||r.symbol.length>24||ids.has(r.symbol)||!r.symbol||typeof r.name!=='string'||
          !allowed.includes(r.status)||!Array.isArray(r.hits)||!r.hits.every(k=>Object.hasOwn(rules,k))||
          (r.pending!==undefined&&(!Array.isArray(r.pending)||!r.pending.every(k=>Object.hasOwn(rules,k))))||
          (r.close!==null&&!(Number.isFinite(r.close)&&r.close>0))||typeof r.note!=='string')throw Error();
        ids.add(r.symbol);
      }
      if(token!==generation)return;
      book=v;page=0;
      source.textContent='历史文件 · '+v.asof+' · '+v.source+' · 输入 '+v.rows.length+' 只';
    }catch{if(token!==generation)return;source.textContent='文件格式或指标未通过校验。'+(book?'保留上次载入的 '+book.asof+' 历史结果。':'请选择本工具生成的研究快照。');}
    render();
  }
  file.addEventListener('change',load);
  for(const control of [rule,group,query])control.addEventListener('input',()=>{page=0;render();});
  get('back-page').addEventListener('click',()=>{page--;render();});
  get('next-page').addEventListener('click',()=>{page++;render();});
  render();
})();
