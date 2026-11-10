#!/usr/bin/env node
'use strict';
/* Resolve refresh scope. UI-only publications skip every source; other modes retain independent Binance guards. */
const fs=require('node:fs');
const MAX_EVENT_BYTES=2*1024*1024;
const SCHEDULES=Object.freeze({'27,57 * * * *':'positions','12 */6 * * *':'full'});
const SHA=/^[0-9a-f]{40}$/;
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const fail=()=>{throw Error('invalid_refresh_event');};
function resolveMode({eventName,event,checkoutSha}={}) {
  if(!plain(event)||typeof checkoutSha!=='string'||!SHA.test(checkoutSha))fail();
  if(eventName==='schedule') {
    if(typeof event.schedule!=='string'||!Object.hasOwn(SCHEDULES,event.schedule))fail();
    return SCHEDULES[event.schedule];
  }
  if(eventName==='workflow_dispatch') {
    if(!plain(event.inputs)||Object.keys(event.inputs).length!==1||!['positions','full'].includes(event.inputs.refresh_scope))fail();
    return event.inputs.refresh_scope;
  }
  if(eventName==='push') {
    if(event.ref!=='refs/heads/main'||typeof event.after!=='string'||!SHA.test(event.after)||typeof event.head_commit?.message!=='string')fail();
    // UI-only publication never escalates into collection when main has moved.
    if(event.head_commit.message.includes('[ui-only]')) {
      if(event.after!==checkoutSha)fail();
      return 'skip';
    }
    // Other delayed events retain their existing full-refresh behavior.
    if(event.after!==checkoutSha)return 'full';
    if(event.head_commit.message.includes('[positions-only]'))return 'positions';
    return 'full';
  }
  fail();
}
function main(env=process.env,{io=fs,log=console.log}={}) {
  if(typeof env.GITHUB_EVENT_PATH!=='string'||!env.GITHUB_EVENT_PATH)fail();
  if(io.statSync(env.GITHUB_EVENT_PATH).size>MAX_EVENT_BYTES)fail();
  const raw=io.readFileSync(env.GITHUB_EVENT_PATH,'utf8');
  if(Buffer.byteLength(raw)>MAX_EVENT_BYTES)fail();
  const mode=resolveMode({eventName:env.GITHUB_EVENT_NAME,event:JSON.parse(raw),checkoutSha:env.BOOKS_CHECKOUT_SHA});
  log(mode);return mode;
}
module.exports={resolveMode,main};
if(require.main===module){try{main();}catch(_){console.error('Cannot resolve refresh scope; no collection will start.');process.exitCode=1;}}
