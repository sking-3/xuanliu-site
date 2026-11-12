/* Public default-perpetual positions only. No credentials, orders or account signing. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BooksFloatingPnl=api;})(globalThis,function(){
'use strict';
const SOCKET='wss://api.hyperliquid.xyz/ws',FRESH=15000,MAX_POINTS=600;
function snapshot(message,address,normalize,now){
 if(message?.channel!=='clearinghouseState'||message.data?.user?.toLowerCase()!==address||message.data.dex!=='')throw Error('invalid_position_stream');
 const value=normalize(message.data.clearinghouseState,now);
 if(now-value.sourceTime>FRESH||value.sourceTime>now+1000)throw Error('stale_position_stream');
 const rows=value.rows.map(r=>({...r,markPrice:r.quantity?r.positionValue/r.quantity:null}));
 const total=rows.reduce((sum,r)=>sum+r.unrealizedPnl,0);if(!Number.isFinite(total)||rows.some(r=>!Number.isFinite(r.markPrice)))throw Error('invalid_position_stream');
 return {...value,rows,total,fetchedAt:now,status:'ready',error:null};
}
function sample(previous,value){
 if(previous&&value.sourceTime<=previous.sourceTime)return previous;
 const signature=JSON.stringify(value.rows.map(r=>[r.coin,r.signedSize,r.entryPrice]).sort((a,b)=>a[0].localeCompare(b[0]))),same=previous?.signature===signature&&value.sourceTime-previous.sourceTime<=FRESH;
 const points=same?previous.points.slice():[];
 if(!points.length||Math.floor(value.sourceTime/5000)>Math.floor(points.at(-1).time/5000))points.push({time:value.sourceTime,value:value.total});
 else points[points.length-1]={time:value.sourceTime,value:value.total};
 return {...value,signature,points:points.slice(-MAX_POINTS),segmentStartedAt:same?previous.segmentStartedAt:value.sourceTime};
}
function create(options){
 const env=options.env||globalThis,policy=env.BooksSourcePolicy,now=options.now||Date.now,notify=options.onChange||(()=>{}),set=options.setTimer||env.setTimeout.bind(env),clear=options.clearTimer||env.clearTimeout.bind(env);
 let socket=null,timer=null,ping=null,wait=null,closed=false,visible=options.visible!==false,accepted=false,reconnects=0,generation=0,last=null,streamStop=null,status='connecting',reason=null;
 const address=options.address,normalize=env.BooksAccountLive?.normalize.positions;
 if(!/^0x[0-9a-f]{40}$/.test(address)||!normalize)throw Error('invalid_public_account');
 const emit=()=>notify({status,reason,snapshot:last,stale:!last||now()-last.sourceTime>FRESH});
 function disconnect(){generation++;for(const t of [timer,ping,wait])if(t!==null)clear(t);timer=ping=wait=null;const old=socket;socket=null;if(old){old.onopen=old.onmessage=old.onclose=old.onerror=null;try{old.close();}catch{}}}
 function stop(code,persist=false){if(closed)return;if(persist){streamStop=code;policy?.stop(code);}disconnect();status='stopped';reason=code;emit();}
 function heartbeat(){if(closed||!visible)return;emit();if(socket?.readyState===1)socket.send(JSON.stringify({method:'ping'}));ping=set(heartbeat,5000);}
 function start(){
  if(closed||!visible)return;disconnect();if(last)last={...last,signature:null};accepted=false;status='connecting';reason=null;emit();const token=generation,until=now()+8000;
  function connect(){
   if(closed||!visible||token!==generation)return;
   const block=streamStop||policy?.reason()||(!policy?'snapshot_unverified':null);
   if(block==='snapshot_unverified'&&now()<until){wait=set(connect,100);return;}
   if(block){stop(block);return;}
   try{socket=new env.WebSocket(SOCKET);}catch{stop('websocket_unavailable');return;}
   const ws=socket,alive=()=>!closed&&visible&&token===generation&&socket===ws;
   wait=set(()=>{if(alive())stop('stream_timeout');},8000);
   ws.onopen=()=>{if(alive())ws.send(JSON.stringify({method:'subscribe',subscription:{type:'clearinghouseState',user:address,dex:''}}));};
   ws.onmessage=e=>{
    if(!alive())return;
    try{
     if(typeof e.data!=='string'||e.data.length>1000000)throw Error('invalid_position_stream');const m=JSON.parse(e.data);
     if(m.channel==='error'){stop('stream_rejected',true);return;}
     if(m.channel==='pong')return;
     if(m.channel==='subscriptionResponse'){
      const s=m.data?.subscription;if(m.data?.method!=='subscribe'||s?.type!=='clearinghouseState'||s.user?.toLowerCase()!==address||s.dex!=='')throw Error('invalid_position_stream');return;
     }
     if(m.channel!=='clearinghouseState')return;
     const value=snapshot(m,address,normalize,now());last=sample(last,value);accepted=true;reconnects=0;if(wait!==null)clear(wait);wait=null;status='live';reason=null;options.onPositions?.(last);emit();
     if(ping===null)ping=set(heartbeat,5000);
    }catch(err){stop(err.message==='stale_position_stream'?'stale_position_stream':'invalid_position_stream');}
   };
   ws.onerror=()=>{if(alive())stop('websocket_unavailable');};
   ws.onclose=e=>{if(!alive())return;if([1003,1008,1009].includes(e.code)){stop('stream_rejected',true);return;}const retry=accepted&&reconnects<2;disconnect();status='disconnected';reason='stream_gap';emit();if(retry){reconnects++;timer=set(start,5000);} };
  }
  connect();
 }
 const unsubscribe=policy?.subscribe(code=>stop(code));
 function setVisible(value){if(closed||visible===value)return;visible=value;if(!value){disconnect();status='paused';reason='page_hidden';emit();}else start();}
 function destroy(){closed=true;disconnect();unsubscribe?.();}
 if(visible)start();else{status='paused';reason='page_hidden';emit();}return {destroy,setVisible};
}
function mount(host,r,options={}){
 const env=options.env||globalThis,doc=env.document,el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;},format=(v,d=4)=>Number(v).toLocaleString('zh-CN',{maximumFractionDigits:d}),signed=v=>(v>0?'+':'')+format(v),time=t=>new Date(t).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 host.classList.add('ta-floating');const heading=el('div',undefined,'ta-section-head');heading.append(el('h3','当前持仓与走势'),el('span','Hyperliquid · 默认永续市场'));host.append(heading);
 const status=el('p','正在连接公开持仓…','ta-note');status.setAttribute('role','status');status.setAttribute('aria-live','off');const total=el('strong','—','ta-floating-total'),layout=el('div',undefined,'ta-floating-layout'),figures=el('div'),chart=el('div',undefined,'ta-floating-chart'),rows=el('div',undefined,'ta-table-wrap'),caption=el('p','官方未实现盈亏，独立于周期收益与平仓统计。曲线从本次观察开始；仓位变化或断线后重新分段。','ta-note');rows.tabIndex=0;rows.setAttribute('role','region');rows.setAttribute('aria-label','当前持仓明细，可横向滚动');figures.append(el('p','当前未实现盈亏 · 平仓后为 0，已实现收益见上方','ta-note'),total,status);layout.append(figures,chart);host.append(layout,rows,caption);
 function render(state){
  const s=state.snapshot,labels={connecting:'连接中',live:'实时推送',stopped:'更新已停止',disconnected:'连接中断',paused:'页面隐藏，已暂停'};status.textContent=(labels[state.status]||state.status)+(state.stale&&s?' · 数据已过期':'')+(s?' · '+s.rows.length+' 个仓位 · 来源 '+new Date(s.sourceTime).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' · 接收 '+time(s.fetchedAt):'')+(state.reason?' · '+({http_403:'来源拒绝访问',http_429:'来源限流',stream_rejected:'来源拒绝订阅',snapshot_unverified:'来源安全状态未核验',websocket_unavailable:'实时流暂不可用',stream_timeout:'未收到有效快照',stream_gap:'重连后重新分段',page_hidden:'返回页面后重新核验',stale_position_stream:'未取得新鲜快照',invalid_position_stream:'来源数据校验失败'}[state.reason]||'暂不可用'):'');
  total.textContent=s?signed(s.total)+' USDC':'—';total.className='ta-floating-total'+(s?(s.total>=0?' ta-positive':' ta-negative'):'');host.dataset.state=state.stale?'stale':state.status;
  rows.replaceChildren();chart.replaceChildren();if(!s){chart.append(el('p','等待可信的当前仓位与盈亏数据。','ta-note'));return;}
  const table=el('table',undefined,'ta-table'),thead=el('thead'),tr=el('tr');for(const t of ['合约 / 方向','数量','持仓均价','仓位估值价','未实现盈亏 · USDC']){const th=el('th',t);th.scope='col';tr.append(th);}thead.append(tr);table.append(thead);const body=el('tbody');
  for(const p of s.rows.slice(0,30)){const row=el('tr');for(const t of [p.coin+' · '+(p.side==='long'?'多':'空'),format(p.quantity,8),p.entryPrice===null?'—':format(p.entryPrice),format(p.markPrice),signed(p.unrealizedPnl)])row.append(el('td',t));body.append(row);}table.append(body);rows.append(table);if(!s.rows.length)rows.append(el('p','本次官方快照确认当前无默认永续仓位。','ta-note'));if(s.rows.length>30)rows.append(el('p','表格显示前30个仓位；浮盈亏合计包含本次返回的全部默认永续仓位。','ta-note'));
  if(s.points.length<2){chart.append(el('p','已取得首个实时样本，等待后续行情。','ta-note'));return;}
  const points=s.points,first=points[0].time,last=points.at(-1).time,values=points.map(p=>p.value),lo=Math.min(...values),hi=Math.max(...values),span=hi-lo||Math.max(Math.abs(hi)*.001,.001),x=t=>12+556*(t-first)/Math.max(1,last-first),y=v=>15+105*(hi-v)/span;
  const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 580 150');svg.setAttribute('role','img');svg.setAttribute('aria-label','本次观察的未实现盈亏，'+points.length+' 个官方实时样本，单位 USDC');const path=doc.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M'+points.map(p=>x(p.time)+','+y(p.value)).join(' L'));path.setAttribute('fill','none');path.setAttribute('stroke',s.total>=0?'#169b83':'#d65672');path.setAttribute('stroke-width','2');svg.append(path);chart.append(svg,el('p',time(first)+' — '+time(last)+' · '+points.length+' 个实时样本 · 本段范围 '+format(lo)+' — '+format(hi)+' USDC','ta-note'));
 }
 const marketHost=el('section',undefined,'ta-position-market');host.append(marketHost);const market=env.BooksPositionMarket?.mount(marketHost,r,{data:options.data,env});
 const client=create({env,address:r.accountId,visible:doc.visibilityState!=='hidden',onChange:state=>{render(state);market?.update(state);},onPositions:options.onPositions});const visibility=()=>client.setVisible(doc.visibilityState!=='hidden');doc.addEventListener('visibilitychange',visibility);visibility();return {destroy(){client.destroy();market?.destroy();doc.removeEventListener('visibilitychange',visibility);}};
}
return {snapshot,sample,create,mount,FRESH,MAX_POINTS};
});
