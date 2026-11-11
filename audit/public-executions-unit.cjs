'use strict';
// Synthetic checkpoint fixtures; no exchange requests in this suite.
const {test}=require('node:test'),assert=require('node:assert/strict');
const api=require('../trader/public-executions.js');
const NOW=Date.now(),stamp=new Date(NOW-1000).toISOString();
function record(key='a',identity='b') {return {fingerprint:key.repeat(64),identity:identity.repeat(64),sourceOrderId:null,symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',executedQty:'0.125',avgPrice:'2000.12345',totalPnl:'-2.5',orderTime:NOW-10000,orderUpdateTime:NOW-2000,firstSeenAt:stamp,direction:'opening_or_increasing_short'};}
function fixture(){const row=record();return {schemaVersion:1,portfolioId:api.ID,scope:'public_execution_records_only',hiddenPositionsRequested:false,stopped:false,lastSuccessAt:stamp,records:{[row.fingerprint]:row}};}
function environment(fetch){const store=new Map();return {fetch,localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}};}
test('saved records preserve exact units and direction ambiguity without inferred orders',()=>{
 const v=api.parse(fixture(),NOW);assert.equal(v.rows.length,1);assert.equal(v.rows[0].quantity,'0.125');assert.equal(v.rows[0].price,'2000.12345');assert.equal(v.rows[0].quoteAsset,'USDT');assert.equal(v.rows[0].direction,'开空/加空方向');assert.equal(v.checkedAt,stamp);assert.equal(v.rows[0].versionFirstSeenAt,stamp);assert.equal(v.rows[0].sourceOrderId,undefined);
});
test('different fingerprints with equal source identity and times remain separate public records',()=>{
 const v=fixture(),r=record('c');r.executedQty='0.25';r.versionFirstSeenAt=new Date(NOW).toISOString();v.records[r.fingerprint]=r;
 const third=record('d');third.executedQty='1';v.records[third.fingerprint]=third;
 const parsed=api.parse(v,NOW);assert.equal(parsed.rows[0].quantity,'0.25');assert.equal(parsed.retainedRecords,3);assert.deepEqual(new Set(parsed.rows.map(x=>x.quantity)),new Set(['0.125','0.25','1']));
});
test('invalid identities, scope, timestamps and numeric data fail closed',()=>{
 for(const change of [v=>v.portfolioId='another',v=>v.scope='positions',v=>v.hiddenPositionsRequested=true,v=>v.lastSuccessAt=null,v=>v.lastSuccessAt=new Date(NOW+600000).toISOString(),v=>v.records['a'.repeat(64)].direction='new_short',v=>v.records['a'.repeat(64)].firstSeenAt='unknown',v=>v.records['a'.repeat(64)].versionFirstSeenAt='unknown',v=>v.records['a'.repeat(64)].executedQty='Infinity',v=>v.records['a'.repeat(64)].avgPrice='-1',v=>v.records['a'.repeat(64)].orderUpdateTime=NOW+600000,v=>v.records['a'.repeat(64)].sourceOrderId='invented']){const v=fixture();change(v);assert.throws(()=>api.parse(v,NOW),/SCHEMA/);}
});
test('empty baseline and stopped history remain distinguishable',()=>{
 const v=fixture();v.records={};v.lastSuccessAt=null;assert.deepEqual(api.parse(v,NOW).rows,[]);v.stopped=true;assert.equal(api.parse(v,NOW).stopped,true);
});
test('reader uses only saved public checkpoint, single flight and a one-minute cache',async()=>{
 let calls=0,release;const wait=new Promise(r=>release=r),env=environment(async(url,options)=>{calls++;assert.equal(url,api.URL);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');await wait;return new Response(JSON.stringify(fixture()));});
 const reader=api.reader(env),p=reader.read(),q=reader.read();release();assert.deepEqual(await p,await q);await reader.read();assert.equal(calls,1);assert.equal(reader.last().rows.length,1);
});
test('403 and 429 stop subsequent reads, including across reader instances',async()=>{
 for(const status of [403,429]){let calls=0;const env=environment(async()=>{calls++;return new Response('',{status});}),r=api.reader(env);await assert.rejects(r.read());await assert.rejects(r.read());await assert.rejects(api.reader(env).read());assert.equal(calls,1);assert.equal(r.reason(),'http_'+status);}
});
test('oversized checkpoint is rejected without retaining partial data',async()=>{
 const r=api.reader(environment(async()=>new Response(' '.repeat(900001))));await assert.rejects(r.read(),/too_large/);assert.equal(r.last(),null);
});
