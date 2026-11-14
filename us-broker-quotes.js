/* Free-entitlement quote readers. Credentials remain in the loopback service. */
(function(){
'use strict';
const $=id=>document.getElementById(id),form=$('broker-pair-form');if(!form)return;
const BASE='http://127.0.0.1:19355',WATCH='books.stock.watchlist.v1',names={futu:'富途牛牛',longbridge:'长桥',tiger:'老虎证券'};
let pair='',generation=0,timer=null,active=false,controllers=new Map(),connected=[];
const message=text=>{$('broker-status').textContent=text;},validSymbol=s=>typeof s==='string'&&/^[A-Z][A-Z0-9.-]{0,14}$/.test(s);
const errors={broker_sdk_missing:'本机尚未安装所选平台的官方行情组件，请按接入说明安装。',broker_not_connected:'请先在本机接入页连接这个平台。',broker_invalid_pairing:'配对码无效，请使用本机组件本次启动生成的配对码。',broker_source_stopped:'该来源已停止，请先核查权限或限流记录。',broker_permission_denied:'本人账号尚无所需免费行情权限，本次读取已停止。',broker_rate_limited:'来源限流或额度不足，本次读取已停止。',broker_auth_failed:'行情凭证未通过验证，请在本机接入页核对。',broker_schema:'来源字段未通过核验，本次读取已停止。',broker_read_failed:'本次行情未取得，请核对本机组件状态。',broker_free_only_required:'请先在本机接入页确认仅使用本人免费行情权限。',broker_origin_denied:'本机组件未允许此页面来源。',broker_wait:'读取频率过快，请稍后手动重试。',pairing_required:'连接码无效，请使用本机组件本次启动生成的连接码。',provider_not_connected:'请先在本机接入页连接所选平台。',provider_source_stopped:'此来源已停止，请先核查本机接入页的权限或限流记录。',origin_not_allowed:'本机组件未允许当前页面来源。',free_only_required:'请先在本机接入页确认只用免费权限。',provider_schema_invalid:'来源字段未通过校验，本次已停止。',provider_wait:'多个页面共用本机读取节拍，请等待片刻后手动重试。',provider_busy:'该平台正在读取，请稍后手动重试。',free_access_confirmation_required:'请先在本机接入页确认只用本人免费权限。',broker_sdk_dotenv_present:'长桥组件检测到目录中有.env，请按说明在干净目录启动。',broker_sdk_environment_override:'长桥组件检测到外部环境覆盖，请在干净环境启动。',broker_sdk_unsupported:'官方SDK版本不兼容，请使用下载包中的已核验版本。'};
function stop(text){active=false;generation++;clearTimeout(timer);timer=null;for(const [c,deadline] of controllers){clearTimeout(deadline);c.abort();}controllers.clear();$('broker-stop').disabled=true;$('broker-start').disabled=false;$('broker-read').disabled=false;if(text)message(text);}
function selected(){const p=$('broker-provider').value;if(!names[p])throw Error('请选择支持的免费行情平台。');return p;}
function symbols(){let rows;try{rows=JSON.parse(localStorage.getItem(WATCH)||'[]');}catch{throw Error('本机自选格式异常，请先核对自选。');}if(!Array.isArray(rows))throw Error('本机自选格式异常。');const list=[...new Set(rows.filter(x=>x?.market==='us').map(x=>x.symbol))];if(!list.length)throw Error('请先在“我的美股自选”加入股票代码。');if(list.length>30||list.some(s=>!validSymbol(s)))throw Error('请保留最多30个有效美股代码。');return list;}
async function api(path,value,g){
 if(g!==generation||document.hidden)throw Object.assign(Error('已停止'),{cancelled:true});
 if(!/^[a-f0-9]{64}$/.test(pair))throw Error('请从本机接入页复制本次启动的配对码。');
 const c=new AbortController();const deadline=setTimeout(()=>c.abort(),25000);controllers.set(c,deadline);
 try{const response=await fetch(BASE+path,{method:value===undefined?'GET':'POST',mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+pair,...(value===undefined?{}:{'Content-Type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value),signal:c.signal});
 if(g!==generation||document.hidden)throw Object.assign(Error('已停止'),{cancelled:true});
 const length=Number(response.headers.get('Content-Length'));if(length>300000)throw Error('本机响应过大，未读取。');const text=await response.text();if(text.length>300000)throw Error('本机响应过大，未读取。');let data;try{data=JSON.parse(text);}catch{throw Error('本机响应格式异常。');}
 if(g!==generation||document.hidden)throw Object.assign(Error('已停止'),{cancelled:true});if(!response.ok)throw Error(errors[data.error]||'本机行情请求未完成，请核对接入页状态。');return data;
 }catch(e){if(g!==generation||document.hidden)throw Object.assign(Error('已停止'),{cancelled:true});if(e instanceof TypeError||e.name==='AbortError')throw Error('未能连接本机行情组件。请先手动启动，检查浏览器本地网络权限，再重试。');throw e;}finally{clearTimeout(deadline);controllers.delete(c);}
}
function providerState(value){
 if(!Array.isArray(value?.connectedProviders)||!Array.isArray(value?.sourceStops))throw Error('本机状态格式异常。');connected=value.connectedProviders;
 const stopped=new Set(value.sourceStops.map(x=>x.provider));for(const [p,label]of Object.entries(names)){const item=connected.find(x=>x.provider===p);$('broker-state-'+p).textContent=stopped.has(p)?'来源已停止':item?'适配器已连接 · 报价待核验':'未连接';}
}
function render(batch,provider,list){
 if(batch?.provider!==provider||!Array.isArray(batch.quotes)||batch.quotes.length>30||!Number.isFinite(Date.parse(batch.receivedAt)))throw Error('本机行情来源或批次时间异常。');
 const seen=new Set(),rows=[];for(const q of batch.quotes){if(q?.provider!==provider||q.currency!=='USD'||!list.includes(q.symbol)||seen.has(q.symbol))throw Error('行情代码或来源异常。');seen.add(q.symbol);if(q.price!==null&&!(typeof q.price==='number'&&Number.isFinite(q.price)&&q.price>0))throw Error('行情价格异常。');if(q.sourceTime!==null&&!Number.isFinite(Date.parse(q.sourceTime)))throw Error('行情来源时间异常。');if(provider==='tiger'&&q.delaySeconds!==900)throw Error('老虎免费行情的延迟标识异常。');rows.push(q);}
 const body=$('broker-quotes');body.replaceChildren();for(const symbol of list){const q=rows.find(x=>x.symbol===symbol),tr=document.createElement('tr');let state='来源未返回此代码',price='—',time='—',delay=provider==='tiger'?'约15分钟延迟':'免费权限 · 实际时效待核',scope='来源未提供';
 if(q){price=q.price===null?'—':q.price.toLocaleString('zh-CN',{maximumFractionDigits:6});time=q.sourceTime||'来源时间缺失';scope=names[provider]+' · '+(q.feed||'覆盖待核');const age=q.sourceTime?(Date.now()-Date.parse(q.sourceTime))/1000:null;state=q.price===null?'价格缺失':age===null?'时间待核':age< -5?'来源时间晚于本机':age>(q.delaySeconds||0)+120?'历史或旧报价':'已取得来源报价';if(q.sourceTime)delay=(provider==='tiger'?'约15分钟延迟 · ':'')+'来源时点距今 '+Math.max(0,Math.round(age))+' 秒';}
 for(const value of [q?.name?q.name+' · '+symbol:symbol,price,time,scope,delay,state]){const td=document.createElement('td');td.textContent=value;tr.append(td);}body.append(tr);}
 $('broker-updated').textContent='本次读取 '+batch.receivedAt+' · '+names[provider]+' · '+rows.filter(x=>x.price!==null).length+' / '+list.length+' 个有价格 · 来源时间与读取时间分开保留';
 $('broker-state-'+provider).textContent='已读取报价 · '+(provider==='tiger'?'约15分钟延迟':'实际时效见表格');
 $('broker-radar-note').textContent='本批为'+names[provider]+'免费报价快照。尚无已验收的同源完成分钟及10–20日基线，不生成放量信号；不会与原IEX或其他平台拼接。';
}
async function read(g,monitor){const started=Date.now();try{const p=selected(),list=symbols();const result=await api('/api/quotes',{provider:p,symbols:list},g);if(g!==generation)return false;render(result,p,list);message(monitor?'本页读取中 · '+names[p]+' · '+(p==='tiger'?'每30秒读取延迟快照':'每5秒读取快照'):'本次免费报价已读取，未启动持续读取。');return true;}catch(e){if(!e.cancelled&&g===generation)stop(e.message);return false;}finally{if(active&&g===generation)timer=setTimeout(()=>read(g,true),Math.max(0,(selected()==='tiger'?30000:5000)-(Date.now()-started)));}}
form.onsubmit=async e=>{e.preventDefault();stop('');const input=$('broker-pair');pair=input.value.trim();input.value='';const g=generation;try{providerState(await api('/api/status',undefined,g));if(g===generation)message('本机组件已配对。请选已连接的平台，添加自选后读取报价。');}catch(error){if(!error.cancelled&&g===generation){pair='';message(error.message);}}};
$('broker-read').onclick=()=>{window.BooksUsLive?.stop('已选择三平台免费报价');stop('');return read(generation,false);};
$('broker-start').onclick=()=>{window.BooksUsLive?.stop('已选择三平台免费报价');stop('');active=true;$('broker-stop').disabled=false;$('broker-start').disabled=true;void read(generation,true);};
$('broker-stop').onclick=()=>stop('本页读取已停止 · 没有后台排程');
$('broker-unpair').onclick=()=>{stop('本页已断开并清除配对码。平台凭证可在本机接入页断开清除。');pair='';connected=[];$('broker-pair').value='';for(const p of Object.keys(names))$('broker-state-'+p).textContent='未配对';$('broker-quotes').replaceChildren();$('broker-updated').textContent='尚未读取';};
$('broker-provider').onchange=()=>{stop('平台已切换，请读取所选来源；各平台的行情不混合。');$('broker-quotes').replaceChildren();$('broker-updated').textContent='尚未读取所选平台';};
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('页面已隐藏，免费行情读取已停止；返回后需手动启动。');});
window.addEventListener('pagehide',()=>{stop();pair='';connected=[];$('broker-pair').value='';});
window.addEventListener('storage',e=>{if(e.key===WATCH)stop('自选已变更，请重新读取。');});
window.BooksBrokerLive={stop};
})();
