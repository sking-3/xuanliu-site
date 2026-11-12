/* Exact previously authorized public checkpoint; never GitHub workflow queues. */
export async function checkpoint(env,fetcher){
 const source='github_checkpoint',now=Date.now(),held=await env.DB.prepare('SELECT reason FROM source_stops WHERE source = ?').bind(source).first();if(held)throw Error('source_stopped');
 await env.DB.prepare('INSERT INTO checkpoint_cache (source, attempted_at) VALUES (?, 0) ON CONFLICT(source) DO NOTHING').bind(source).run();
 const previous=await env.DB.prepare('SELECT payload, attempted_at FROM checkpoint_cache WHERE source = ?').bind(source).first();
 const claim=await env.DB.prepare('UPDATE checkpoint_cache SET attempted_at = ? WHERE source = ? AND attempted_at <= ?').bind(now,source,now-75000).run();
 if(!(claim.meta?.changes??claim.changes)){if(previous.payload)return JSON.parse(previous.payload);throw Error('checkpoint_waiting');}
 try{
  const response=await fetcher('https://api.github.com/repos/sking-3/xuanliu-site/contents/monitor-state/5075281354358777856.json?ref=binance-public-orders-state',{headers:{'Accept':'application/vnd.github+json','User-Agent':'Books-Private-ReadOnly'},redirect:'manual',signal:AbortSignal.timeout(10000)});
  if([403,429].includes(response.status)){await env.DB.prepare('INSERT INTO source_stops (source, reason, stopped_at) VALUES (?, ?, ?) ON CONFLICT(source) DO NOTHING').bind(source,'http_'+response.status,now).run();throw Error('source_stopped');}
  if(!response.ok)throw Error('checkpoint_unavailable');const raw=await response.text();if(raw.length>1600000)throw Error('response_too_large');const wrapped=JSON.parse(raw);if(wrapped.encoding!=='base64'||typeof wrapped.content!=='string'||wrapped.content.length>1500000)throw Error('checkpoint_schema');const payload=new TextDecoder().decode(Uint8Array.from(atob(wrapped.content.replace(/\s/g,'')),c=>c.charCodeAt(0))),value=JSON.parse(payload);
  if(value.schemaVersion!==1||value.portfolioId!=='5075281354358777856'||value.scope!=='public_execution_records_only'||value.hiddenPositionsRequested!==false||typeof value.stopped!=='boolean'||!value.records)throw Error('checkpoint_schema');
  // Keep original source times and stop evidence. Existing reader validates every record.
  await env.DB.prepare('UPDATE checkpoint_cache SET payload = ?, fetched_at = ? WHERE source = ?').bind(payload,now,source).run();return value;
 }catch(e){if(e.message==='source_stopped')throw e;if(previous.payload)return JSON.parse(previous.payload);throw e;}
}
