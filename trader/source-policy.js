/* Shared refusal evidence for same-origin snapshots and public Hyperliquid reads. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksSourcePolicy = api.browser(root);
})(globalThis, function () {
'use strict';
const BLOCKS = new Set(['http_403', 'http_429']);
const ADDRESS=/^0x[0-9a-f]{40}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const code=x=>x===null||(typeof x==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(x));
const fail=reason=>{throw Error(reason);};
function decision(states){
 if(!plain(states))fail('invalid_feed_status');
 const findings=[];
 const inspect=(value,stage,optional,invalid)=>{
  if(value===undefined&&optional)return;
  if(!code(value))fail(invalid);
  if(BLOCKS.has(value))findings.push({allowed:false,reason:value,stage});
 };
 const feed=states.feed,source=feed?.source;
 if(!plain(feed)||feed.schemaVersion!==1||!plain(source)||source.id!=='hyperliquid'||
  source.url!=='https://app.hyperliquid.xyz/leaderboard'||!Array.isArray(feed.traders)||feed.traders.length>200||
  source.selectedAccounts!==feed.traders.length||
  !((feed.status==='ready'&&['ok','stale'].includes(source.status))||(feed.status==='unavailable'&&source.status==='error')))
  fail('invalid_feed_status');
 inspect(source.errorCode,'feed',source.status!=='error','invalid_feed_status');
 const verification=source.positionVerification;
 if(verification!==undefined){
  if(!plain(verification)||verification.scope!=='default_perp_dex')fail('invalid_feed_status');
  inspect(verification.stopCode,'positions',true,'invalid_feed_status');
 }else if(feed.status==='ready')fail('invalid_feed_status');
 for(const [kind,method] of [['analytics','closing-fill-v1'],['portfolios','portfolio-periods-v2']]){
  const value=states[kind],invalid='invalid_'+kind+'_status',s=value?.source;
  if(!plain(value)||value.schemaVersion!==1||value.methodVersion!==method||!plain(s)||
   s.id!=='hyperliquid'||s.endpoint!=='https://api.hyperliquid.xyz/info'||
   !['ready','partial','unavailable'].includes(s.status)||!Object.hasOwn(s,'stopCode')||!plain(value.accounts))
   fail(invalid);
  const entries=Object.entries(value.accounts);
  if(entries.length>200||s.accounts!==entries.length)fail(invalid);
  inspect(s.stopCode,kind,false,invalid);
  for(const [address,record] of entries){
   if(!ADDRESS.test(address)||!plain(record)||!['ready','stale','unavailable'].includes(record.status)||!Object.hasOwn(record,'errorCode'))fail(invalid);
   inspect(record.errorCode,kind+'_record',false,invalid);
  }
 }
 return findings[0]||{allowed:true,reason:null,stage:null};
}

function browser(root) {
  const records = {};
  const key = 'books.source-stop.hyperliquid.v1';
  const listeners = new Set();
  let stopped = null, verified = false;
  function reason() {
    try { stopped ||= root.localStorage.getItem(key); }
    catch { return 'storage_unavailable'; }
    return stopped || (verified ? null : 'snapshot_unverified');
  }
  function stop(code) {
    if ((!BLOCKS.has(code) && code!=='stream_rejected') || stopped) return;
    stopped = code;
    try { root.localStorage.setItem(key, code); } catch {}
    for (const fn of listeners) fn(code);
  }
  function inspect(kind, record) {
    records[kind] = record;
    verified = false;
    // Inspect each batch immediately, even if another public file is unavailable.
    const codes = [record?.source?.errorCode, record?.source?.positionVerification?.stopCode,
      record?.source?.stopCode, ...Object.values(record?.accounts || {}).map(r => r?.errorCode)];
    for (const code of codes) stop(code);
    if (!records.feed || !records.analytics || !records.portfolios) return;
    try {
      const result = decision(records);
      verified = result.allowed;
      if (!verified) stop(result.reason);
    } catch { verified = false; }
  }
  root.addEventListener('storage', event => { if (event.key === key) stop(event.newValue); });
  return { reason, stop, inspect, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}
return { decision, browser };
});
