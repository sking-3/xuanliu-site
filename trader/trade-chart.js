/* Chart interactions use only already validated candles and saved observations. */
(function(env){
'use strict';
const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;};
const fmt=(v,d=8)=>v===null||v===undefined||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:d});
const stamp=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const short=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function mount(container,playback,options){
 const {bars,events,seconds,cycle,name,onOutside}=options,lib=env.LightweightCharts,M=env.BooksTradeReplayModel;
 const legend=el('div',undefined,'ta-chart-legend');container.before(legend);
 const chart=lib.createChart(container,{autoSize:true,layout:{background:{type:'solid',color:'#ffffff'},textColor:'#738195',attributionLogo:true,fontFamily:'system-ui, sans-serif',fontSize:11},grid:{vertLines:{color:'#eef1f5'},horzLines:{color:'#eef1f5'}},rightPriceScale:{borderColor:'#dfe5eb',scaleMargins:{top:.16,bottom:.23}},timeScale:{borderColor:'#dfe5eb',timeVisible:true,tickMarkFormatter:(t,type)=>new Date(Number(t)*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',...(type===0?{year:'numeric'}:type===1?{month:'short'}:type===2?{month:'2-digit',day:'2-digit'}:{hour:'2-digit',minute:'2-digit',hour12:false})})},localization:{locale:'zh-CN',timeFormatter:t=>stamp(Number(t)*1000)},handleScroll:{vertTouchDrag:false,horzTouchDrag:true}});
 const series=chart.addSeries(lib.CandlestickSeries,{upColor:'#16a085',downColor:'#e25371',borderVisible:false,wickUpColor:'#16a085',wickDownColor:'#e25371'}),markers=lib.createSeriesMarkers(series,[]);
 let volume=null;
 if(bars.some(b=>b.volume!==undefined)){volume=chart.addSeries(lib.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},lastValueVisible:false,priceLineVisible:false});chart.priceScale('volume').applyOptions({scaleMargins:{top:.83,bottom:0},visible:false});}
 const groups=M.markerGroups(events,bars,seconds),byId=new Map(groups.map(m=>[m.id,m])),byTime=new Map();for(const e of events){const t=Math.floor(e.time/1000/seconds)*seconds;if(!byTime.has(t))byTime.set(t,[]);byTime.get(t).push(e);}
 const tooltip=el('div',undefined,'ta-chart-tooltip');tooltip.hidden=true;tooltip.setAttribute('role','status');tooltip.setAttribute('aria-live','polite');container.append(tooltip);
 let cursor=bars.length,playing=false,timer=null,pinned=false,lastKey='',lines=[];
 const button=(label,fn)=>{const b=el('button',label,'ta-button');b.type='button';b.onclick=fn;return b;};
 const play=button('回放',()=>{if(playing){stop();return;}if(cursor>=bars.length)cursor=1;playing=true;play.textContent='暂停';timer=setInterval(()=>{cursor=Math.min(bars.length,cursor+1);paint();if(cursor===bars.length)stop();},450);paint();}),step=button('下一根',()=>{stop();cursor=Math.min(bars.length,cursor+1);paint();}),reset=button('完整区间',()=>{stop();cursor=bars.length;paint();chart.timeScale().fitContent();}),range=el('input'),caption=el('span',undefined,'ta-playback-time');
 range.type='range';range.min='1';range.max=String(bars.length);range.setAttribute('aria-label','回放进度');range.oninput=()=>{stop();cursor=Number(range.value);paint();};playback.append(play,step,reset,range,caption);
 function stop(){playing=false;clearInterval(timer);timer=null;play.textContent='回放';}
 function hide(){tooltip.hidden=true;lastKey='';pinned=false;tooltip.classList.remove('is-pinned');}
 function readout(bar){legend.replaceChildren();const title=el('strong',cycle.symbol),time=el('span',short(bar.time*1000));legend.append(title,time);for(const [label,key]of [['开','open'],['高','high'],['低','low'],['收','close']])legend.append(el('span',label+' '+fmt(bar[key]),key==='close'?(bar.close>=bar.open?'ta-positive':'ta-negative'):''));if(bar.volume!==undefined)legend.append(el('span','量 '+fmt(bar.volume,2)));}
 function averages(){for(const line of lines)series.removePriceLine(line);lines=[];if(cursor!==bars.length)return;for(const [title,value,color]of [[cycle.official?'官方开仓均价':'样本开仓均价',cycle.avgEntry,'#c66a6a'],[cycle.official?'官方平仓均价':'样本平仓均价',cycle.avgExit,'#1e9e87']])if(value!==null&&Number(value)>0)lines.push(series.createPriceLine({price:Number(value),color,lineWidth:1,lineStyle:2,axisLabelVisible:true,title}));}
 function paint(){hide();series.setData(bars.slice(0,cursor));if(volume)volume.setData(bars.slice(0,cursor).filter(b=>b.volume!==undefined).map(b=>({time:b.time,value:b.volume,color:b.close>=b.open?'#8fd8c699':'#f5a5b699'})));markers.setMarkers(groups.filter(m=>m.time<=bars[cursor-1].time).map(({events,...m})=>m));range.value=String(cursor);caption.textContent=short(bars[cursor-1].time*1000)+' · '+cursor+'/'+bars.length;readout(bars[cursor-1]);averages();}
 function locate(param){
  const id=param.hoveredInfo?.objectId??param.hoveredObjectId,marker=byId.get(id),time=marker?.time??(typeof param.time==='number'?param.time:null);
  if(time===null||time>bars[cursor-1].time)return null;const list=marker?.events||byTime.get(time)||[];return {time,list,key:marker?.id||'bar:'+time};
 }
 function show(found,point,pin=false){
  if(!found?.list.length){if(!pinned)hide();return;}if(!pin&&pinned)return;
  const key=found.key+'|'+pin;
  if(lastKey!==key){
   tooltip.replaceChildren();const header=el('div',undefined,'ta-tooltip-head');header.append(el('strong',name+' · '+cycle.symbol),el('span',found.list.length+' 条操作'));if(pin){const close=button('×',hide);close.className='ta-tooltip-close';close.setAttribute('aria-label','关闭点位明细');header.append(close);}tooltip.append(header);
   const list=pin?found.list:found.list.slice(0,6);
   for(const e of list){const row=el('div',undefined,'ta-tooltip-record'),head=el('strong',e.action+' · '+(({long:'多仓',short:'空仓'})[e.positionSide]||'开平未知')+' · '+(e.side==='buy'?'买入':'卖出'),e.side==='buy'?'ta-tooltip-buy':'ta-tooltip-sell');
    row.append(head,el('p',fmt(e.quantity)+' @ '+fmt(e.price)+' '+e.quote),el('p','名义金额 '+fmt(Number(e.quantity)*Number(e.price),2)+' '+e.quote),el('small','来源时间 '+stamp(e.time)+' 北京时间'),el('small','首次发现 '+(e.firstSeenAt?stamp(e.firstSeenAt):'未记录')));
    if(e.startPosition!==undefined)row.append(el('small','成交前 / 后仓位 '+e.startPosition+' / '+e.endPosition));
    if(e.ambiguous)row.append(el('small','记录版本存在歧义，不叠加推算仓位。'));tooltip.append(row);
   }
   if(!pin&&found.list.length>6)tooltip.append(el('small','另有 '+(found.list.length-6)+' 条；点击固定后查看。'));
   if(!pin)tooltip.append(el('small','点击固定 · 手机可轻触查看','ta-tooltip-hint'));lastKey=key;
  }
  pinned=pin;tooltip.classList.toggle('is-pinned',pin);tooltip.hidden=false;
  const width=Math.min(350,container.clientWidth-16),left=Math.max(8,Math.min(container.clientWidth-width-8,(point?.x??20)+14));tooltip.style.width=width+'px';tooltip.style.left=left+'px';tooltip.style.top=Math.max(8,Math.min(container.clientHeight-100,(point?.y??20)+18))+'px';
  if(tooltip.offsetHeight+Number.parseFloat(tooltip.style.top)>container.clientHeight-8)tooltip.style.top=Math.max(8,container.clientHeight-tooltip.offsetHeight-8)+'px';
 }
 function move(param){const bar=param.seriesData?.get(series);if(bar?.open!==undefined)readout(bar);if(!param.point){if(!pinned)hide();return;}show(locate(param),param.point);}
 function click(param){const found=locate(param);if(found?.list.length){stop();show(found,param.point,true);}else hide();}
 chart.subscribeCrosshairMove(move);chart.subscribeClick(click);container.addEventListener('pointerleave',()=>{if(!pinned)hide();});
 paint();chart.timeScale().fitContent();
 return {chart,focusEvent(e){stop();const time=Math.floor(e.time/1000/seconds)*seconds,i=bars.findIndex(b=>b.time===time);if(i<0){onOutside?.();return;}cursor=i+1;paint();chart.timeScale().setVisibleLogicalRange({from:Math.max(0,i-16),to:i+6});show({list:[e],key:e.id,time},{x:20,y:20},true);container.scrollIntoView({block:'center',behavior:'auto'});},destroy(){stop();chart.unsubscribeCrosshairMove(move);chart.unsubscribeClick(click);chart.remove();legend.remove();tooltip.remove();}};
}
env.BooksTradeChart={mount};
})(globalThis);
