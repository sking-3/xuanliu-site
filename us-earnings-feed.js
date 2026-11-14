/* Public NVIDIA RSS titles only. No account, backend, source fallback or trading signal. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else{root.BooksUsIssuerFeed=api;if(root.document)api.mount(root);}})(globalThis,function(){
'use strict';
 const FEED='https://nvidianews.nvidia.com/cats/press_release.xml',STOP_KEY='books.public.issuer.stop.v1',META_KEY='books.public.issuer.meta.v1',PERIOD=300000,MAX_BYTES=1000000;
 const error=(code,extra={})=>Object.assign(Error(code),extra),schema=()=>{throw error('research_issuer_schema');};
 function chars(value){return value.replace(/&([^;\s<]+);/g,(full,name)=>{const known={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(known,name))return known[name];const number=/^#x[0-9a-f]+$/i.test(name)?parseInt(name.slice(2),16):/^#[0-9]+$/.test(name)?Number(name.slice(1)):NaN;if(!Number.isInteger(number)||!(number===9||number===10||number===13||number>=32&&number<=0xd7ff||number>=0xe000&&number<=0xfffd||number>=0x10000&&number<=0x10ffff))schema();return String.fromCodePoint(number);});}
 function text(value){if(/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-f]+;)/i.test(value))schema();return chars(value);}
 function published(value,now){
  const match=/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UT|[+-]\d{4})$/.exec(value.trim());if(!match)schema();
  const [,weekday,day,month,year,hour,minute,second='0',zone]=match,months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],local=Date.UTC(Number(year),months.indexOf(month),Number(day),Number(hour),Number(minute),Number(second)),date=new Date(local);
  if(Number(year)<1000||Number(hour)>23||Number(minute)>59||Number(second)>59||date.getUTCFullYear()!==Number(year)||date.getUTCMonth()!==months.indexOf(month)||date.getUTCDate()!==Number(day)||['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getUTCDay()]!==weekday)schema();
  const offset=/^[+-]/.test(zone)?(zone[0]==='+'?1:-1)*(Number(zone.slice(1,3))*60+Number(zone.slice(3))):0;if(/^[+-]/.test(zone)&&(Number(zone.slice(1,3))>23||Number(zone.slice(3))>59))schema();const stamp=local-offset*60000;if(stamp>now)schema();return new Date(stamp).toISOString();
 }
 function sourceLink(value){let url;try{url=new URL(value.trim());}catch{schema();}if(url.protocol!=='https:'||url.hostname!=='nvidianews.nvidia.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/news\/[a-z0-9][a-z0-9-]*$/i.test(url.pathname)||/[\u0000-\u0020\u007f\\]/.test(value.trim()))schema();return url.href;}
 function kind(title){
  if(!/\b(?:financial results|earnings|quarterly results)\b/i.test(title))return null;
  const headline=/\b(?:announces?|reports?)\b.*\b(?:financial results|earnings|quarterly results)\b/i.test(title),schedule=/\b(?:sets?|schedules?)\b.*\b(?:conference call|webcast|financial results|earnings)\b|\bannounces?\b.*\b(?:conference call|webcast|date)\b|\b(?:will|to)\s+(?:announce|report|release)\b|\bdate\s+for\b/i.test(title);
  return schedule||!headline&&/\b(?:conference call|webcast)\b/i.test(title)?'earnings_schedule':headline?'earnings_headline':null;
 }
 function parse(xml,now=Date.now()){
  if(typeof xml!=='string'||!Number.isFinite(now)||new TextEncoder().encode(xml).length>MAX_BYTES)throw error('research_issuer_response_too_large');
  if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml))schema();
  const stack=[],items=[];let cursor=0,current=null,capture=null,root=false,channel=false;
  const append=(value,cdata=false)=>{if(capture){capture.value+=cdata?value:text(value);if(capture.value.length>8192)schema();}else if(!stack.length&&value.trim())schema();};
  while(cursor<xml.length){
   const next=xml.indexOf('<',cursor);if(next<0){append(xml.slice(cursor));break;}append(xml.slice(cursor,next));cursor=next;
   if(xml.startsWith('<!--',cursor)){const end=xml.indexOf('-->',cursor+4);if(end<0||xml.slice(cursor+4,end).includes('--'))schema();cursor=end+3;continue;}
   if(xml.startsWith('<![CDATA[',cursor)){const end=xml.indexOf(']]>',cursor+9);if(end<0||!stack.length)schema();append(xml.slice(cursor+9,end),true);cursor=end+3;continue;}
   if(xml.startsWith('<?',cursor)){const end=xml.indexOf('?>',cursor+2);if(end<0)schema();cursor=end+2;continue;}
   let end=cursor+1,quote=null;for(;end<xml.length;end++){const c=xml[end];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}if(end===xml.length)schema();
   const token=xml.slice(cursor+1,end);cursor=end+1;
   if(token.startsWith('/')){const name=token.slice(1).trim();if(!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)||stack.pop()!==name)schema();if(capture&&name===capture.name){current[name]=capture.value;capture=null;}if(name==='item'){if(!current||!['title','link','pubDate'].every(k=>typeof current[k]==='string'))schema();items.push(current);current=null;}continue;}
   const open=/^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/)?$/.exec(token);if(!open||capture)schema();const name=open[1],selfClosing=!!open[2];
   if(!stack.length){if(root||name!=='rss'||selfClosing)schema();root=true;}else if(stack.length===1&&name==='channel'){if(channel||selfClosing)schema();channel=true;}
   if(name==='item'){if(current||stack.join('/')!=='rss/channel'||selfClosing||items.length>=100)schema();current={};}
   if(current&&stack.join('/')==='rss/channel/item'&&['title','link','pubDate'].includes(name)){if(Object.hasOwn(current,name)||selfClosing)schema();capture={name,value:''};}
   if(!selfClosing)stack.push(name);
  }
  if(stack.length||current||capture||!root||!channel)schema();const seen=new Set(),events=[];
  for(const item of items){const title=item.title.trim();if(!title||title.length>250||item.link.length>2048||item.pubDate.length>100)schema();const sourceUrl=sourceLink(item.link),publishedAt=published(item.pubDate,now);if(seen.has(sourceUrl))schema();seen.add(sourceUrl);const eventKind=kind(title);if(eventKind)events.push({symbol:'NVDA',provider:'issuer',scope:'NVDA_only',kind:eventKind,title,sourceUrl,pubDate:item.pubDate,publishedAt,evidenceScope:'rss_title_only',actualEarningsVerified:false,eligibleForU1:false});}
  return events;
 }
 async function hash(bytes,env){return Array.from(new Uint8Array(await env.crypto.subtle.digest('SHA-256',typeof bytes==='string'?new TextEncoder().encode(bytes):bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
 async function bounded(response,signal){const reader=response.body?.getReader();if(!reader)schema();const parts=[];let size=0;for(;;){if(signal.aborted){await reader.cancel();throw error('issuer_aborted');}const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>MAX_BYTES){await reader.cancel();throw error('research_issuer_response_too_large');}parts.push(next.value);}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}let xml;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{schema();}return {bytes,xml};}
 function mount(env=globalThis,{clock=Date.now}={}){
  const doc=env.document,refreshButton=doc?.getElementById('us-issuer-refresh'),status=doc?.getElementById('us-issuer-status'),body=doc?.getElementById('us-issuer-body');if(!refreshButton||!status||!body)return null;
  let request=null,timer=null,sourceStopped=false,paused=false,lastResult=null,lastMetadata=null;
  const node=(tag,value)=>{const element=doc.createElement(tag);if(value!==undefined)element.textContent=value;return element;};
  const official=(label,url=FEED)=>{const link=node('a',label);link.href=url;link.target='_blank';link.rel='noopener noreferrer';return link;};
  function message(value){status.replaceChildren(node('span',value+' · '),official('NVIDIA 官方 RSS'));}
  function clearTimer(){if(timer!==null)env.clearTimeout(timer);timer=null;}
  function pause(value){paused=true;clearTimer();if(request){env.clearTimeout(request.deadline);request.controller.abort();request=null;}refreshButton.disabled=sourceStopped;if(value)message(value);}
  function stopped(){try{const raw=env.localStorage.getItem(STOP_KEY);if(raw===null)return null;let value;try{value=JSON.parse(raw);}catch{}return ['http_403','http_429'].includes(value?.reason)?value.reason:'stored_stop';}catch{return 'storage_unavailable';}}
  function hold(reason,persist=false){sourceStopped=true;pause();let saved=true;if(persist)try{env.localStorage.setItem(STOP_KEY,JSON.stringify({reason,stoppedAt:new Date(clock()).toISOString()}));}catch{saved=false;}const label=reason==='storage_unavailable'?'浏览器无法读取停止记录':reason==='stored_stop'?'已有停止记录':reason;message('NVIDIA RSS 来源已停止（'+label+'）；本页不会重试、切换来源或自动恢复。'+(saved?'':'浏览器未能保存停止记录。'));refreshButton.disabled=true;}
  function metadata(){try{const value=JSON.parse(env.localStorage.getItem(META_KEY)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
  function render(events){body.replaceChildren();if(!events.length){const row=node('tr'),cell=node('td','NVIDIA 官方 RSS 本次没有符合分类的财报标题；仅 NVDA 范围，不代表全市场。');cell.colSpan=5;row.append(cell);body.append(row);return;}for(const event of events){const row=node('tr'),title=node('td');title.append(official(event.title,event.sourceUrl));row.append(node('td','NVDA · NVIDIA'),node('td',event.kind==='earnings_schedule'?'财报预告（非实际业绩）':'财报标题待核（仅标题）'),title,node('td',event.pubDate),node('td',event.firstSeenAt));body.append(row);}}
  async function refresh(){
   if(doc.hidden||request)return;const reason=stopped();if(sourceStopped||reason){hold(reason||'stored_stop');return;}paused=false;clearTimer();const current={controller:new AbortController(),timedOut:false};request=current;refreshButton.disabled=true;message('正在读取 NVIDIA 官方 RSS；首版仅 NVDA，不覆盖全市场。');current.deadline=env.setTimeout(()=>{if(request!==current)return;current.timedOut=true;pause('NVIDIA RSS 读取超过 20 秒，已取消；'+(lastResult?'保留上次真实标题与时间。':'尚未取得可展示标题。')+'请手动刷新；不会自动重试。');},20000);
   const live=()=>request===current&&!paused&&!doc.hidden;
   try{
    const response=await env.fetch(FEED,{method:'GET',credentials:'omit',redirect:'error',mode:'cors',cache:'no-store',signal:current.controller.signal,headers:{Accept:'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8'}});
    if([403,429].includes(response.status)){hold('http_'+response.status,true);return;}if(!live())return;if(response.redirected||response.status>=300&&response.status<400)throw error('issuer_redirect_rejected');if(!response.ok)throw error('issuer_http_'+response.status);
    const {bytes,xml}=await bounded(response,current.controller.signal);if(!live())return;const receivedAt=new Date(clock()).toISOString(),events=parse(xml,Date.parse(receivedAt)),rssHash=await hash(bytes,env),prior=lastMetadata||metadata(),seen={};let added=0;
    await Promise.all(events.map(async event=>{const id=await hash(event.sourceUrl,env),old=prior.seen?.[id],valid=typeof old?.firstSeenAt==='string'&&Number.isFinite(Date.parse(old.firstSeenAt))&&Date.parse(old.firstSeenAt)<=Date.parse(receivedAt);if(!valid)added++;event.firstSeenAt=valid?old.firstSeenAt:receivedAt;event.receivedAt=receivedAt;event.rssHash=rssHash;seen[id]={firstSeenAt:event.firstSeenAt,receivedAt,rssHash};}));
    if(!live())return;let metadataSaved=true;try{const retained=Object.entries(prior.seen||{}).filter(([id,value])=>/^[a-f0-9]{64}$/.test(id)&&typeof value?.firstSeenAt==='string'&&Number.isFinite(Date.parse(value.firstSeenAt))&&Date.parse(value.firstSeenAt)<=Date.parse(receivedAt)).slice(-100).map(([id,value])=>[id,{firstSeenAt:value.firstSeenAt,receivedAt:typeof value.receivedAt==='string'&&Number.isFinite(Date.parse(value.receivedAt))?value.receivedAt:value.firstSeenAt,rssHash:/^[a-f0-9]{64}$/.test(value.rssHash)?value.rssHash:null}]);lastMetadata={rssHash,receivedAt,seen:{...Object.fromEntries(retained),...seen}};env.localStorage.setItem(META_KEY,JSON.stringify(lastMetadata));}catch{metadataSaved=false;}
    lastResult={events,receivedAt,rssHash};render(events);message('已核对 NVIDIA 官方 RSS：仅 NVDA，非全市场；'+events.length+' 条财报相关标题，'+(prior.rssHash===rssHash?'RSS 内容未变':'新发现 '+added+' 条标题')+'。标题、预告均不作为已核实财报或 U1 信号。读取时间 '+receivedAt+(metadataSaved?'':'；首次发现时间未能保存到浏览器。'));
    timer=env.setTimeout(()=>{timer=null;if(doc.hidden){pause('页面已隐藏，RSS 读取已停止；恢复后请手动刷新。');return;}return refresh();},PERIOD);
   }catch(e){if(live()){pause();message((current.timedOut?'NVIDIA RSS 读取超过 20 秒，已取消':e.message==='research_issuer_response_too_large'?'NVIDIA RSS 超过 1 MB 安全上限':e.message==='research_issuer_schema'?'NVIDIA RSS 格式未通过安全校验':'NVIDIA RSS 本次未能读取')+'；'+(lastResult?'保留上次真实标题与时间。':'尚未取得可展示标题。')+'请手动刷新或打开官方来源；不会自动重试。');}}
   finally{env.clearTimeout(current.deadline);if(request===current){request=null;refreshButton.disabled=sourceStopped;}}
  }
  refreshButton.addEventListener('click',()=>refresh());doc.addEventListener('visibilitychange',()=>{if(doc.hidden)pause('页面已隐藏，RSS 读取已停止；恢复后请手动刷新。');});env.addEventListener('pagehide',()=>pause('页面已离开，RSS 读取已停止；返回后请手动刷新。'));
  let ready=Promise.resolve();const reason=stopped();if(reason)hold(reason);else if(doc.hidden)pause('页面当前隐藏，未读取 RSS；请在可见页面手动刷新。');else ready=refresh();
  return {refresh,ready,stop:()=>pause('RSS 读取已停止；请手动刷新。')};
 }
 return {parse,mount,FEED_URL:FEED,STOP_KEY,META_KEY};
});
