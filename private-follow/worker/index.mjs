import {owner,origin,body,seal,unseal,headers,json,settings,SOURCE} from './security.mjs';
import {probe,credentials,exchanges} from './connectors.mjs';
import {page,client,css} from './ui.mjs';
import {paperPage,paperBoot} from './paper.mjs';
import {checkpoint} from './checkpoint.mjs';
const protectedAssets={};
export async function handle(request,env,{fetcher=fetch}={}){
 try{
  const path=new URL(request.url).pathname;if(path==='/api/identity'&&request.method==='GET'){const id=request.headers.get('oai-authenticated-user-id');if(!id)return json({error:'sign_in_required'},401);return json({siteUserId:id,setupOnly:true});}const user=owner(request,env);
  if(request.method==='GET'){
   if(path==='/')return new Response(page,{headers:{...headers,'Content-Type':'text/html;charset=utf-8'}});
   if(path==='/paper')return new Response(paperPage,{headers:{...headers,'Content-Type':'text/html;charset=utf-8'}});
   if(path==='/paper-boot.js')return new Response(paperBoot,{headers:{...headers,'Content-Type':'application/javascript;charset=utf-8'}});
   if(Object.hasOwn(protectedAssets,path))return new Response(protectedAssets[path],{headers:{...headers,'Content-Type':path.endsWith('.css')?'text/css;charset=utf-8':'application/javascript;charset=utf-8'}});
   if(path==='/api/checkpoint')return json(await checkpoint(env,fetcher));
   if(path==='/api/source-policy'){const held=await env.DB.prepare('SELECT reason FROM source_stops WHERE source = ?').bind('public_policy').first();if(held)return json({error:'source_stopped'},409);const result={};for(const name of ['feed','analytics','portfolios']){let response;try{response=await fetcher('https://sking-3.github.io/xuanliu-site/trader/'+name+'.json',{redirect:'manual',signal:AbortSignal.timeout(10000)});}catch{throw Error('policy_transport_error');}if([403,429].includes(response.status)){await env.DB.prepare('INSERT INTO source_stops (source, reason, stopped_at) VALUES (?, ?, ?) ON CONFLICT(source) DO NOTHING').bind('public_policy','http_'+response.status,Date.now()).run();return json({error:'source_stopped'},409);}if(!response.ok)throw Error('policy_http_'+response.status);const raw=await response.text();if(raw.length>2500000)throw Error('response_too_large');result[name]=JSON.parse(raw);}return json(result);}
   if(path==='/app.js')return new Response(client,{headers:{...headers,'Content-Type':'application/javascript;charset=utf-8'}});
   if(path==='/app.css')return new Response(css,{headers:{...headers,'Content-Type':'text/css;charset=utf-8'}});
   if(path==='/api/session')return json({owner:true,sourceId:SOURCE,mode:'simulation',liveTradingEnabled:false,vaultReady:!!env.CREDENTIAL_ENCRYPTION_KEY});
   if(path==='/api/settings'){const row=await env.DB.prepare('SELECT settings_json, revision, updated_at FROM follow_settings WHERE owner_id = ?').bind(user).first(),rows=await env.DB.prepare('SELECT exchange, summary_json, checked_at, stopped_reason FROM connections WHERE owner_id = ?').bind(user).all();const stops=await env.DB.prepare('SELECT source, reason FROM source_stops').all(),stopMap=Object.fromEntries(stops.results.map(x=>[x.source,x.reason]));return json({settings:row?JSON.parse(row.settings_json):null,revision:row?.revision||0,connections:rows.results.map(x=>({exchange:x.exchange,...JSON.parse(x.summary_json),checkedAt:x.checked_at,stoppedReason:stopMap[x.exchange]||x.stopped_reason}))});}
   return json({error:'not_found'},404);
  }
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);origin(request);const input=await body(request);
  if(path==='/api/settings'){const next=settings(input);await env.DB.prepare('INSERT INTO follow_settings (owner_id, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET settings_json=excluded.settings_json, revision=follow_settings.revision+1, updated_at=excluded.updated_at').bind(user,JSON.stringify(next),Date.now()).run();return json({saved:true,settings:next});}
  const connection=path.match(/^\/api\/connections\/(Binance|Bitget|Hyperliquid)$/);
  if(connection){const exchange=connection[1],blocked=await env.DB.prepare('SELECT reason FROM source_stops WHERE source = ?').bind(exchange).first();if(blocked)return json({error:'source_stopped',reason:blocked.reason},409);
   let c;if(input.useSaved===true&&Object.keys(input).length===1){const row=await env.DB.prepare('SELECT vault FROM connections WHERE owner_id = ? AND exchange = ?').bind(user,exchange).first();if(!row)throw Error('connection_missing');c=await unseal(row.vault,env,user+':'+exchange);}else c=credentials(exchange,input);
   // Require an operational vault before making any private exchange request.
   const encrypted=await seal(c,env,user+':'+exchange);
   try{const result=await probe(exchange,c,{fetcher});await env.DB.prepare('INSERT INTO connections (owner_id, exchange, vault, summary_json, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id,exchange) DO UPDATE SET vault=excluded.vault, summary_json=excluded.summary_json, checked_at=excluded.checked_at, stopped_reason=NULL').bind(user,exchange,encrypted,JSON.stringify(result),Date.now()).run();return json({connected:true,...result});}
   catch(e){if(e.stop)await env.DB.prepare('INSERT INTO source_stops (source, reason, stopped_at) VALUES (?, ?, ?) ON CONFLICT(source) DO NOTHING').bind(exchange,e.message,Date.now()).run();throw e;}
  }
  return json({error:'not_found'},404);
 }catch(e){const allowed=/^(sign_in_required|owner_only|invalid_origin|invalid_settings|invalid_credentials|invalid_address|public_policy_unavailable|policy_http_[0-9]{3}|policy_transport_error|source_stopped|checkpoint_waiting|checkpoint_unavailable|checkpoint_schema|request_too_large|invalid_request|vault_not_configured|connection_missing|account_schema|account_read_rejected|source_rejected|response_too_large|source_http_(403|429)|connection_http_[0-9]{3})$/;return json({error:allowed.test(e.message)?e.message:'request_failed'},e.status||400);}
}
export default {fetch:handle};
