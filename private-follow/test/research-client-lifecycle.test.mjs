import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {researchClient} from '../worker/research-ui.mjs';

test('browser Massive date boundary stays on the previous Eastern calendar day until midnight',async()=>{
 const code=researchClient.slice(researchClient.indexOf('async function runMassive()'),researchClient.indexOf("$('run-a').onclick"));
 for(const [stamp,end] of [['2026-11-14T01:30:00Z','2026-11-12'],['2026-11-14T04:59:00Z','2026-11-12'],['2026-11-14T05:00:00Z','2026-11-13']]){
  const now=Date.parse(stamp),seen=[];
  class Clock extends Date{constructor(v){super(v===undefined?now:v);}static now(){return now;}}
  const scope={Date:Clock,R:{localDay:()=>stamp<'2026-11-14T05:00:00Z'?'2026-11-13':'2026-11-14'},text(){},read:async(provider,operation,params)=>{seen.push({provider,operation,params});throw Error('fixture-stop');}};
  vm.runInNewContext(code,scope);await assert.rejects(scope.runMassive(),/fixture-stop/);
  assert.equal(seen.length,1);assert.equal(seen[0].operation,'benchmark');assert.equal(seen[0].params.end,end);
 }
});

test('cancelled collection displays why it stopped and restores buttons without source retries',async()=>{
 const code=researchClient.slice(researchClient.indexOf('async function run(market)'),researchClient.indexOf('async function runMassive()'));
 for(const reason of ['已手动停止本次读取','页面已隐藏，本次读取已停止','页面已离开，本次读取已停止']){
  const nodes=Object.fromEntries(['run-a','run-us','stop-read','us-source'].map(k=>[k,{disabled:false,value:'Massive'}]));let message='',runs=0;
  const scope=vm.createContext({$:id=>nodes[id],text:(id,v)=>{if(id==='run-status')message=v;},stopWatch(){},status:async()=>{}});
  vm.runInContext('let busy=false,watchBusy=false,cancelled=false,cancelReason="";'+code,scope);
  scope.runMassive=async()=>{runs++;vm.runInContext('cancelled=true;cancelReason='+JSON.stringify(reason),scope);throw Error('signal is aborted without reason');};
  await scope.run('us');assert.equal(runs,1);assert.ok(message.startsWith(reason));assert.doesNotMatch(message,/signal|aborted/);assert.equal(nodes['run-us'].disabled,false);assert.equal(nodes['stop-read'].disabled,true);
 }
});
