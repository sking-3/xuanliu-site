'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../screening/selection-shell.js'),'utf8');
function setup(dataset={}){
 const label={textContent:'',dataset:{selectionBatch:'us'}},workspace={dataset};let changed,requests=0;
 vm.runInNewContext(source,{window:{addEventListener(){}},document:{querySelector:s=>s==='[data-selection-batch]'?label:workspace},location:{hash:''},MutationObserver:class{constructor(fn){changed=fn}observe(){}disconnect(){}},fetch:()=>{requests++;throw Error('Header must not fetch')},AbortController,URL});
 return {label,workspace,changed,requests:()=>requests};
}
test('header never requests a batch and reads the workspace authoritative state',()=>{const r=setup({publishedState:'not_configured',publishedLabel:'公开策略结果尚未发布'});assert.equal(r.requests(),0);assert.equal(r.label.textContent,'公开策略结果尚未发布');});
test('workspace rejection is mirrored after a previously displayed success',()=>{const r=setup({publishedState:'ready',publishedLabel:'批次已完成',publishedAsOf:'2026-11-13'});Object.assign(r.workspace.dataset,{publishedState:'restricted',publishedLabel:'来源拒绝或限流 · 已停止读取'});r.changed();assert.equal(r.label.dataset.state,'restricted');assert.match(r.label.textContent,/已停止读取/);assert.equal(r.requests(),0);});
test('missing workspace status is loading, never a zero result',()=>{const r=setup();assert.equal(r.label.dataset.state,'loading');assert.match(r.label.textContent,/正在核对/);});
test('failed workspace reads cannot leave a normal header status',()=>{const r=setup({publishedState:'unavailable',publishedLabel:'批次状态暂不可用'});assert.equal(r.label.dataset.state,'unavailable');assert.match(r.label.textContent,/不可用/);});
