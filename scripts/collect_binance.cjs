#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const ID='5156287639231681792';
const BASE='https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/';
const PROFILE_URL='https://www.binance.com/en/copy-trading/lead-details/'+ID;
const HALT=new Set(['http_202','http_401','http_403','http_418','http_429','http_451','restricted','inactive','identity_mismatch','schema_changed']);
const decimal=x=>{const s=String(x);if(!/^-?\d+(?:\.\d+)?$/.test(s)||s.length>100||!Number.isFinite(Number(s)))throw Error('schema_changed');return s;};
const abs=x=>decimal(x).replace(/^-/,'');
const stamp=x=>{if(!Number.isSafeInteger(x)||x<0||x>8640000000000000)throw Error('schema_changed');return x;};
const str=(x,max=150)=>{if(typeof x!=='string'||!x.length||x.length>max)throw Error('schema_changed');return x;};
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
function compare(a,b){const p=abs(a).split('.'),q=abs(b).split('.'),n=Math.max((p[1]||'').length,(q[1]||'').length);
 const x=BigInt(p[0]+(p[1]||'').padEnd(n,'0')),y=BigInt(q[0]+(q[1]||'').padEnd(n,'0'));return x<y?-1:x>y?1:0;}
function emptyHistory(){return {status:'unavailable',fetchedAt:null,errorCode:null,complete:false,rows:[]};}
function initial(){return {schemaVersion:1,sourceType:'copy_trade',portfolioId:ID,profile:{id:ID,name:'爱喝快乐肥宅水',status:'UNKNOWN',visibility:'unknown',sourceUrl:PROFILE_URL},generatedAt:null,
 source:{status:'unavailable',lastAttemptAt:null,lastSuccessAt:null,errorCode:null,refreshStopped:false},
 snapshot:null,observations:[],pendingAbsent:{},snapshots:[],evidence:{},history:{orders:emptyHistory(),closedPositions:emptyHistory()}};}
function checkPrevious(p){if(p===null||p===undefined)return initial();
 if(p.schemaVersion!==1||p.sourceType!=='copy_trade'||p.portfolioId!==ID||p.profile?.id!==ID||!p.source||!p.history||!Array.isArray(p.observations)||p.observations.length>200)throw Error('invalid_previous_state');
 if(p.snapshot&&(!p.snapshot.complete||!Array.isArray(p.snapshot.positions)||p.snapshot.positions.length>300||!Number.isFinite(Date.parse(p.snapshot.observedAt))))throw Error('invalid_previous_state');
 return JSON.parse(JSON.stringify(p));}
function profile(d){if(!d||typeof d!=='object')throw Error('schema_changed');
 if(String(d.leadPortfolioId)!==ID)throw Error('identity_mismatch');
 return {id:ID,name:str(d.nickname,200),status:str(d.status,30),visibility:d.positionShow===true?'public':d.positionShow===false?'restricted':'unknown',sourceUrl:PROFILE_URL};}
function positions(data,at){if(!Array.isArray(data)||data.length>10000)throw Error('schema_changed');
 const rows=[],keys=new Set();
 for(const p of data){if(!p||typeof p!=='object')throw Error('schema_changed');const quantity=abs(p.positionAmount);if(compare(quantity,'0')===0)continue;
 const symbol=str(p.symbol,50),side=str(p.positionSide,10),collateral=str(p.collateral,30);
 if(!/^[A-Z0-9_]+$/.test(symbol)||!['LONG','SHORT','BOTH'].includes(side))throw Error('schema_changed');
 const key=symbol+':'+side+':'+collateral;if(keys.has(key))throw Error('schema_changed');keys.add(key);
 const leverage=Number(p.leverage);if(!Number.isSafeInteger(leverage)||leverage<1||leverage>1000)throw Error('schema_changed');
 rows.push({key,symbol,side,quantity,entryPrice:decimal(p.entryPrice),markPrice:decimal(p.markPrice),leverage,unrealizedPnl:decimal(p.unrealizedProfit),collateral});
 }
 if(rows.length>300)throw Error('schema_changed');
 return {observedAt:at,complete:true,rawCount:data.length,positions:rows.sort((a,b)=>a.key.localeCompare(b.key))};}
function orders(d){if(!d||!Array.isArray(d.list)||d.list.length>20)throw Error('schema_changed');
 return d.list.map(x=>({symbol:str(x.symbol,50),side:str(x.side,10),positionSide:str(x.positionSide,10),type:str(x.type,30),
 executedQty:decimal(x.executedQty),avgPrice:decimal(x.avgPrice),totalPnl:decimal(x.totalPnl),orderTime:stamp(x.orderTime),orderUpdateTime:stamp(x.orderUpdateTime)}));}
function closed(d){if(!d||!Array.isArray(d.list)||d.list.length>20)throw Error('schema_changed');
 return d.list.map(x=>({symbol:str(x.symbol,50),side:str(x.side,15),opened:stamp(x.opened),closed:stamp(x.closed),avgCost:decimal(x.avgCost),avgClosePrice:decimal(x.avgClosePrice),closingPnl:decimal(x.closingPnl),closedVolume:decimal(x.closedVolume),status:str(x.status,40),leverage:decimal(x.leverage)}));}
function changes(previous,current,priorPending={},baseline=false){
 const old=new Map((previous?.positions||[]).map(p=>[p.key,p])),next=new Map(current.positions.map(p=>[p.key,p])),events=[],pending={};
 const emit=(p,kind,before,after,from)=>{const e={kind,symbol:p.symbol,side:p.side,from:from||null,to:current.observedAt,before,after};events.push({id:hash(e).slice(0,24),...e});};
 if(baseline||!previous){for(const p of current.positions)emit(p,'baseline',null,p.quantity,null);return {events,pending};}
 for(const p of current.positions){const before=old.get(p.key)||priorPending[p.key]?.position;
 if(!before)emit(p,'appeared',null,p.quantity,previous.observedAt);
 else {const c=compare(p.quantity,before.quantity);if(c)emit(p,c>0?'increased':'decreased',before.quantity,p.quantity,priorPending[p.key]?.from||previous.observedAt);}}
 for(const p of previous.positions){if(!next.has(p.key))pending[p.key]={position:p,from:previous.observedAt,firstMissingAt:current.observedAt};}
 for(const [key,value] of Object.entries(priorPending)){if(!next.has(key))emit(value.position,'absent',value.position.quantity,'0',value.from);}
 return {events,pending};
}
async function request(relative,{body,fetchImpl=fetch,timeoutMs=15000}={}){
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeoutMs);
 try{const r=await fetchImpl(BASE+relative,{method:body?'POST':'GET',redirect:'manual',credentials:'omit',signal:ctl.signal,headers:body?{'accept':'application/json','content-type':'application/json'}:{accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(r.status!==200)throw Error('http_'+r.status);
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('schema_changed');
 const reader=r.body?.getReader();if(!reader)throw Error('schema_changed');
 const chunks=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2*1024*1024)throw Error('response_too_large');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 const raw=Buffer.concat(chunks).toString('utf8');let j;try{j=JSON.parse(raw);}catch{throw Error('schema_changed');}
 if(j.code!=='000000'||j.success!==true)throw Error('source_error_'+String(j.code||'unknown').replace(/[^a-zA-Z0-9_]/g,'').slice(0,30));
 return {data:j.data,evidence:{sha256:hash(raw),bytes,httpStatus:200,code:j.code}};
 }catch(e){if(e.name==='AbortError')throw Error('timeout');throw e;}finally{clearTimeout(timer);}
}
function code(e){return /^[a-zA-Z0-9_]{1,80}$/.test(e.message)?e.message:'network_error';}
async function collect(previous=null,{fetchImpl=fetch,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const out=checkPrevious(previous),old=checkPrevious(previous),at=()=>new Date(now()).toISOString();
 out.generatedAt=at();
 if(out.source.refreshStopped)return out;
 out.source.lastAttemptAt=at();
 const get=async(relative,body)=>{const r=await request(relative,{body,fetchImpl});out.evidence[relative.split('?')[0]]={...r.evidence,receivedAt:at()};return r.data;};
 try{
 const d=await get('lead-portfolio/detail?portfolioId='+ID);out.profile=profile(d);
 if(out.profile.visibility!=='public')throw Error(out.profile.visibility==='restricted'?'restricted':'schema_changed');
 if(out.profile.status!=='ACTIVE')throw Error('inactive');
 await sleep(2000);
 const raw=await get('lead-data/positions?portfolioId='+ID),snap=positions(raw,at());
 const gap=old.snapshot?Date.parse(snap.observedAt)-Date.parse(old.snapshot.observedAt):Infinity;
 const reset=old.source.status!=='ready'||old.profile.visibility!=='public'||gap>60*60000||gap<=0;
 const diff=changes(old.snapshot,snap,old.pendingAbsent||{},reset);
 out.observations=[...(old.observations||[]),...diff.events].slice(-200);
 out.pendingAbsent=diff.pending;out.snapshot=snap;
 out.snapshots=[...(old.snapshots||[]),snap].slice(-24);
 out.source={status:'ready',lastAttemptAt:out.source.lastAttemptAt,lastSuccessAt:snap.observedAt,errorCode:null,refreshStopped:false};
 }catch(e){const c=code(e);out.source.status=c==='restricted'?'restricted':out.snapshot?'stale':'unavailable';out.source.errorCode=c;out.source.refreshStopped=HALT.has(c);out.pendingAbsent={};return out;}
 const to=now(),from=to-7*86400000;
 const tasks=[['orders','lead-portfolio/order-history',{portfolioId:ID,startTime:from,endTime:to,pageSize:20},orders],
 ['closedPositions','lead-portfolio/position-history',{portfolioId:ID,pageNumber:1,pageSize:20,sort:'OPENING'},closed]];
 for(const [kind,endpoint,body,normalize] of tasks){
 if(out.source.refreshStopped)break;
 await sleep(2000);
 try{const d=await get(endpoint,body);out.history[kind]={status:'ready',fetchedAt:at(),errorCode:null,complete:false,rows:normalize(d),
 coverage:{page:1,pageSize:20,requestedFrom:kind==='orders'?new Date(from).toISOString():null,requestedTo:kind==='orders'?new Date(to).toISOString():null,
 sourceTotal:Number.isSafeInteger(d.total)?d.total:null,indexValue:typeof d.indexValue==='string'?d.indexValue:null,truncated:true,identity:'source_page_sample_no_cross_run_deduplication'}};}
 catch(e){const c=code(e),h=out.history[kind]||emptyHistory();out.history[kind]={...h,status:h.fetchedAt?'stale':'unavailable',errorCode:c,complete:false};
 if(HALT.has(c)){out.source.refreshStopped=true;out.source.errorCode=c;}}
 }
 out.generatedAt=at();return out;
}
async function main(){
 const args=process.argv.slice(2);if(args.length>1)throw Error('usage: collect_binance.cjs [output.json]');
 const file=path.resolve(args[0]||'trader/binance/snapshot.json');
 let prev=null;try{const stat=await fs.stat(file);if(stat.size>2*1024*1024)throw Error('state_too_large');prev=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const out=await collect(prev);await fs.mkdir(path.dirname(file),{recursive:true});
 const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(out,null,2)+'\n');await fs.rename(temp,file);
 console.log(JSON.stringify({status:out.source.status,refreshStopped:out.source.refreshStopped,errorCode:out.source.errorCode,lastSuccessAt:out.source.lastSuccessAt,positions:out.snapshot?.positions.length??null,orders:out.history.orders.rows.length,closedPositions:out.history.closedPositions.rows.length}));
}
module.exports={ID,BASE,HALT,initial,profile,positions,orders,closed,changes,compare,request,collect};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
