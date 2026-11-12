/* Follow setup stores non-secret drafts only. No account credentials or exchange orders. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksFollowSettings=api;})(globalThis,function(){
'use strict';
const KEY='books.follow-settings.v1',TARGETS={Bitget:{name:'Bitget 合约',unit:'USDT',prefix:'BITGET_MAIN',secrets:['API_KEY','API_SECRET','PASSPHRASE']},Binance:{name:'币安 USDT 合约',unit:'USDT',prefix:'BINANCE_MAIN',secrets:['API_KEY','API_SECRET']},Hyperliquid:{name:'Hyperliquid 永续',unit:'USDC',prefix:'HYPERLIQUID_MAIN',secrets:['AGENT_PRIVATE_KEY']}};
const defaults=exchange=>({schemaVersion:1,mode:'dry_run',liveTradingEnabled:false,target:{exchange,accountRef:TARGETS[exchange]?.prefix},copyRatio:1,notionalPerIncrease:100,maxOrderNotional:100,maxTotalNotional:300,leverage:5,slippageBps:10,direction:'both',symbols:[],signalMaxAgeSeconds:60});
function source(r){return {exchange:r.exchange,accountId:r.accountId||r.id};}
function sourceSupported(r){return r.exchange==='Binance'&&r.accountId==='5075281354358777856';}
function normalize(raw,r){
 const allowed=['schemaVersion','mode','liveTradingEnabled','source','target','copyRatio','notionalPerIncrease','maxOrderNotional','maxTotalNotional','leverage','slippageBps','direction','symbols','signalMaxAgeSeconds'];
 if(!raw||raw.schemaVersion!==1||Object.keys(raw).some(k=>!allowed.includes(k))||raw.mode!=='dry_run'||raw.liveTradingEnabled!==false||!TARGETS[raw.target?.exchange]||Object.keys(raw.target).some(k=>!['exchange','accountRef'].includes(k))||!/^[A-Z][A-Z0-9_]{2,31}$/.test(raw.target.accountRef||''))throw Error('配置无效；只接受不含密钥的模拟指令设置。');
 const v={...defaults(raw.target.exchange),...raw,source:source(r),target:{exchange:raw.target.exchange,accountRef:raw.target.accountRef}};
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(v.source.accountId)||!['Binance','Hyperliquid','Bitget','OKX','Bybit','Gate','Polymarket'].includes(v.source.exchange)||raw.source&&(Object.keys(raw.source).some(k=>!['exchange','accountId'].includes(k))||raw.source.exchange!==v.source.exchange||raw.source.accountId!==v.source.accountId))throw Error('信号来源与当前账户不一致。');
 for(const [k,min,max]of [['copyRatio',.001,10],['notionalPerIncrease',1,1000000],['maxOrderNotional',1,1000000],['maxTotalNotional',1,10000000],['leverage',1,40],['slippageBps',0,500],['signalMaxAgeSeconds',5,120]])if(typeof v[k]!=='number'||!Number.isFinite(v[k])||v[k]<min||v[k]>max)throw Error('请检查比例、金额与风控参数范围。');
 if(v.notionalPerIncrease*v.copyRatio>v.maxOrderNotional||v.maxOrderNotional>v.maxTotalNotional||!Number.isInteger(v.leverage)||!['both','long','short'].includes(v.direction)||!Array.isArray(v.symbols)||v.symbols.length>20||v.symbols.some(x=>typeof x!=='string'||!/^[A-Z0-9_]{2,30}$/.test(x)))throw Error('单笔金额不能超过上限，上限不能超过总敞口；请核对币种列表。');
 v.symbols=[...new Set(v.symbols)];return v;
}
function configPath(c){return 'copy-config/'+c.source.accountId+'-'+c.target.exchange.toLowerCase()+'-'+c.target.accountRef.toLowerCase()+'.json';}
function commitURL(c){const u=new URL('https://github.com/sking-3/xuanliu-site/new/main');u.searchParams.set('filename',configPath(c));u.searchParams.set('value',JSON.stringify(c,null,2)+'\n');return u.href;}
let current=null;
function dispose(){if(current){current.env.BooksPaperCopy?.dispose();current.host.classList.remove('follow-settings');if(current.ownsDialogClass)current.dialog?.classList.remove('ta-detail');current=null;}}
function render(host,r,options={}){
 if(current?.host===host&&current.r.exchange===r.exchange&&(current.r.accountId||current.r.id)===(r.accountId||r.id)&&host.firstChild)return;dispose();
 const env=options.env||globalThis,doc=env.document,dialog=host.closest('dialog'),c={host,r,env,dialog,ownsDialogClass:dialog&&!dialog.classList.contains('ta-detail'),mode:options.mode||'api',values:{}};current=c;dialog?.classList.add('ta-detail');
 const el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const link=(text,url)=>{const a=el('a',text,'follow-link');a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;};
 const note=text=>el('p',text,'follow-note'),button=(text,fn)=>{const b=el('button',text,'ta-button');b.type='button';b.onclick=fn;return b;};
 const storageKey=target=>r.exchange+':'+(r.accountId||r.id)+':'+target;
 function load(target){const all=JSON.parse(env.localStorage.getItem(KEY)||'{}');if(!all||Array.isArray(all)||typeof all!=='object'||Object.keys(all).length>100)throw Error('本机跟单草稿无法读取，原内容已保留。');const x=all[storageKey(target)];return x?normalize(x,r):{...defaults(target),source:source(r)};}
 function show(mode,restoreFocus=false){
  c.remember?.();c.remember=null;c.mode=mode;env.BooksPaperCopy?.dispose();host.replaceChildren();host.classList.add('trade-analysis','follow-settings');
  const heading=el('div',undefined,'follow-heading');heading.append(el('h3','跟单设置'),link('查看来源 ↗',r.sourceUrl));host.append(heading);
  const tabs=el('div',undefined,'follow-mode');tabs.setAttribute('aria-label','跟单方式');let selectedMode;for(const [value,label]of [['paper','本机模拟'],['api','API 跟单']]){const b=button(label,()=>show(value,true));b.setAttribute('aria-pressed',String(mode===value));if(mode===value)selectedMode=b;tabs.append(b);}host.append(tabs);if(restoreFocus)selectedMode.focus();
  if(mode==='paper'){const mount=el('section');host.append(mount);if(env.BooksPaperCopy?.supported(r))env.BooksPaperCopy.render(mount,r);else mount.append(note('此账户尚未接入本机模拟信号。可查看来源或切换 API 跟单设置；历史样本不会生成自动订单。'));return;}
  host.append(note('信号来源：'+r.name+' · '+r.exchange+' · '+(r.accountId||r.id)));
  const supported=sourceSupported(r),status=el('p',supported?'尚未接入交易所 API · 配置仅用于模拟指令，实盘关闭':'仅可保存草稿 · 此来源尚未接入 GitHub 模拟意图 · 实盘关闭','follow-status');status.setAttribute('role','status');host.append(status);const setStatus=message=>status.textContent=message+(supported?'':' · 此来源尚未接入 GitHub 模拟意图');
  const form=el('form',undefined,'follow-form');form.onsubmit=e=>e.preventDefault();const fields={};
  function field(label,name,type,opts){const wrap=el('label',label),input=el(opts?'select':'input');input.name=name;if(opts)for(const [value,title]of opts){const o=el('option',title);o.value=value;input.append(o);}else{input.type=type;input.step='any';}wrap.append(input);form.append(wrap);fields[name]=input;return input;}
  field('执行交易所','exchange',null,Object.entries(TARGETS).map(([k,v])=>[k,v.name]));field('执行账户别名（对应 GitHub Secrets）','accountRef','text');field('跟单比例 · %','copyRatio','number');field('每次增仓名义金额','notionalPerIncrease','number');field('单笔名义金额上限','maxOrderNotional','number');field('总敞口上限','maxTotalNotional','number');field('杠杆上限','leverage','number');field('最大滑点 · 基点','slippageBps','number');field('跟随方向','direction',null,[['both','多空双向'],['long','仅多方向'],['short','仅空方向']]);field('币种白名单（留空为全部）','symbols','text');field('信号有效期 · 秒','signalMaxAgeSeconds','number');
  fields.symbols.placeholder='ETHUSDT, BTCUSDT';fields.accountRef.autocomplete='off';
  const rawValues=()=>Object.fromEntries(Object.entries(fields).map(([k,n])=>[k,n.value]));let target=c.target||'Bitget';c.remember=()=>{c.values[target]=rawValues();c.target=target;};
  const requirements=el('div',undefined,'follow-requirements'),secretNames=note(''),actions=el('div',undefined,'follow-actions'),github=link('在 GitHub 保存配置','#'),edit=link('编辑 GitHub 配置','#'),path=el('input');path.readOnly=true;path.setAttribute('aria-label','GitHub 配置路径');
  function cfg(){const raw=rawValues();return normalize({...defaults(raw.exchange),source:source(r),target:{exchange:raw.exchange,accountRef:raw.accountRef.trim().toUpperCase()},copyRatio:Number(raw.copyRatio)/100,...Object.fromEntries(['notionalPerIncrease','maxOrderNotional','maxTotalNotional','leverage','slippageBps','signalMaxAgeSeconds'].map(k=>[k,Number(raw[k])])),direction:raw.direction,symbols:raw.symbols.split(/[,，\s]+/).filter(Boolean).map(x=>x.toUpperCase())},r);}
  function updateLinks(){const v=TARGETS[fields.exchange.value],alias=fields.accountRef.value.trim().toUpperCase();secretNames.textContent='金额单位 '+v.unit+'。正式接入时使用 GitHub Secrets：'+v.secrets.map(n=>(alias||v.prefix)+'_'+n).join('、')+'。';try{const x=cfg();github.href=commitURL(x);edit.href='https://github.com/sking-3/xuanliu-site/edit/main/'+configPath(x);path.value=configPath(x);github.removeAttribute('aria-disabled');edit.removeAttribute('aria-disabled');}catch{github.removeAttribute('href');edit.removeAttribute('href');github.setAttribute('aria-disabled','true');edit.setAttribute('aria-disabled','true');path.value='请先修正参数';}}
  function apply(exchange){let x;try{x=c.values[exchange]||load(exchange);}catch(e){x={...defaults(exchange),source:source(r)};setStatus(e.message);}for(const [k,n]of Object.entries(fields))n.value=k==='exchange'?exchange:k==='accountRef'?x.target?.accountRef||x.accountRef:k==='symbols'?Array.isArray(x.symbols)?x.symbols.join(', '):x.symbols:k==='copyRatio'&&typeof x.copyRatio==='number'?x.copyRatio*100:x[k];const v=TARGETS[exchange];requirements.replaceChildren(el('h4',v.name+' 接入'),secretNames,note(exchange==='Hyperliquid'?'正式执行使用专用 Agent Wallet；主钱包私钥不填入本站。代理授权与实盘启动需另外完成。':'正式执行由 GitHub Actions 服务端签名请求；需核对读取/交易权限、提现关闭及 IP 白名单。普通托管 runner 没有固定出口 IP。'),note('当前工作流只生成模拟意图，不读取上述 Secrets、不调用下单 API。目标市场精度、余额、持仓模式及权限尚未校验。'));updateLinks();}
  fields.exchange.onchange=()=>{c.values[target]=rawValues();target=fields.exchange.value;apply(target);};form.oninput=updateLinks;
  const save=button('保存跟单设置',()=>{try{const x=cfg(),all=JSON.parse(env.localStorage.getItem(KEY)||'{}');if(!all||Array.isArray(all)||typeof all!=='object'||Object.keys(all).length>100)throw Error('本机草稿无法读取，原内容已保留。');all[storageKey(target)]=x;env.localStorage.setItem(KEY,JSON.stringify(all));setStatus('已保存本机草稿 · 尚未同步 GitHub · 实盘关闭');updateLinks();}catch(e){setStatus(e.message);}});
  const workflow=supported?link('打开 GitHub 模拟指令工作流','https://github.com/sking-3/xuanliu-site/actions/workflows/copy-signal-dry-run.yml'):el('span','GitHub 模拟指令 · 此来源未接入','follow-link');if(!supported)workflow.setAttribute('aria-disabled','true');
  actions.append(save,github,edit);host.append(form,note('试运行金额 = 每次增仓名义金额 × 跟单比例；不是按未知的源账户总仓位推算。总敞口、杠杆及滑点是执行前约束，本工作流尚不模拟目标账户成交或余额。'),requirements,actions,path,note(supported?'首次配置：在 GitHub 保存 JSON，再打开“Copy signal dry-run”工作流，填写上方配置路径并手动运行 65 秒。已有配置用“编辑 GitHub 配置”更新。新工作流没有定时启动；每个执行账户单独保存。':'可将草稿保存到 GitHub；此来源尚不能运行后台模拟指令。保存或提交设置不会连接交易账户。'),workflow,link('打开 GitHub Secrets 设置','https://github.com/sking-3/xuanliu-site/settings/secrets/actions'));
  if(!sourceSupported(r))host.append(note('GitHub 模拟意图目前只接熬鹰的已批准公开检查点。此来源的设置可保存为草稿，尚不能在该工作流执行。Hyperliquid 来源可使用本机模拟。'));
  apply(target);
 }
 show(c.mode);
}
return {KEY,TARGETS,defaults,source,normalize,configPath,commitURL,sourceSupported,render,dispose};
});
