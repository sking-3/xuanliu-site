'use strict';
/* Offline only: event files and CLI I/O are injected; no source requests are made. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {resolveMode,main}=require('../scripts/resolve_trader_refresh_mode.cjs');
const SHA='a'.repeat(40),OTHER='b'.repeat(40);
const resolve=(eventName,event,checkoutSha=SHA)=>resolveMode({eventName,event,checkoutSha});
const push=(message='',after=SHA)=>({ref:'refs/heads/main',after,head_commit:{message}});
let count=0;function test(name,fn){fn();count++;console.log('ok '+name);}
test('half-hour schedule selects positions and six-hour schedule selects full',()=>{assert.equal(resolve('schedule',{schedule:'27,57 * * * *'}),'positions');assert.equal(resolve('schedule',{schedule:'12 */6 * * *'}),'full');});
test('unknown and malformed schedule expressions fail closed',()=>{for(const schedule of ['26,56 * * * *','17,47 * * * *','',null,undefined,['27,57 * * * *'],'toString'])assert.throws(()=>resolve('schedule',{schedule}),/invalid_refresh_event/);});
test('manual dispatch accepts exactly the two declared scopes',()=>{for(const scope of ['positions','full'])assert.equal(resolve('workflow_dispatch',{inputs:{refresh_scope:scope}}),scope);});
test('invalid dispatch values and extra inputs cannot select a default collection',()=>{for(const inputs of [undefined,null,{},[],{refresh_scope:'skip'},{refresh_scope:'FULL'},{refresh_scope:true},{refresh_scope:'full',extra:'positions'}])assert.throws(()=>resolve('workflow_dispatch',{inputs}),/invalid_refresh_event/);});
test('matching push labels retain skip, positions, and full meanings',()=>{assert.equal(resolve('push',push('fix [ui-only]')),'skip');assert.equal(resolve('push',push('refresh [positions-only]')),'positions');assert.equal(resolve('push',push('ordinary update')),'full');assert.equal(resolve('push',push('[positions-only] [ui-only]')),'skip');});
test('delayed UI-only pushes stop before every source instead of escalating collection',()=>{for(const message of ['[ui-only]','[positions-only] [ui-only]'])assert.throws(()=>resolve('push',push(message,OTHER)),/invalid_refresh_event/);for(const message of ['[positions-only]','ordinary update'])assert.equal(resolve('push',push(message,OTHER)),'full');});
test('malformed push metadata and non-main branches fail closed',()=>{for(const event of [{...push(),ref:'refs/heads/other'},{...push(),after:null},{...push(),after:[SHA]},{...push(),after:'a'.repeat(39)},{...push(),head_commit:null},{...push(),head_commit:{message:{}}}])assert.throws(()=>resolve('push',event),/invalid_refresh_event/);});
test('unsupported event types and malformed checkout hashes fail closed',()=>{for(const eventName of ['pull_request','repository_dispatch','',undefined])assert.throws(()=>resolve(eventName,{}),/invalid_refresh_event/);for(const sha of [null,undefined,[SHA],'not-a-sha','A'.repeat(40)])assert.throws(()=>resolveMode({eventName:'push',event:push(),checkoutSha:sha}),/invalid_refresh_event/);for(const event of [null,[],undefined])assert.throws(()=>resolve('push',event),/invalid_refresh_event/);});
test('CLI reads the event file from environment and emits only the allowed scope',()=>{const output=[],raw=JSON.stringify(push('untrusted $(echo sentinel)\n[positions-only]'));const io={statSync:p=>{assert.equal(p,'/injected/event.json');return {size:Buffer.byteLength(raw)};},readFileSync:(p,encoding)=>{assert.equal(p,'/injected/event.json');assert.equal(encoding,'utf8');return raw;}};assert.equal(main({GITHUB_EVENT_NAME:'push',GITHUB_EVENT_PATH:'/injected/event.json',BOOKS_CHECKOUT_SHA:SHA},{io,log:x=>output.push(x)}),'positions');assert.deepEqual(output,['positions']);});
test('missing, oversized, and malformed event files never emit a mode',()=>{const output=[],log=x=>output.push(x),env={GITHUB_EVENT_NAME:'push',GITHUB_EVENT_PATH:'/event',BOOKS_CHECKOUT_SHA:SHA};assert.throws(()=>main({...env,GITHUB_EVENT_PATH:''},{io:{},log}),/invalid_refresh_event/);assert.throws(()=>main(env,{io:{statSync:()=>({size:2*1024*1024+1})},log}),/invalid_refresh_event/);assert.throws(()=>main(env,{io:{statSync:()=>({size:2}),readFileSync:()=>'{!'},log}),SyntaxError);assert.throws(()=>main(env,{io:{statSync:()=>({size:2}),readFileSync:()=> ' '.repeat(2*1024*1024+1)},log}),/invalid_refresh_event/);assert.deepEqual(output,[]);});
const root=path.join(__dirname,'..'),workflow=fs.readFileSync(path.join(root,'.github/workflows/refresh-traders.yml'),'utf8');
const step=name=>{const start=workflow.indexOf('      - name: '+name+'\n');assert.ok(start>=0,'missing step '+name);const end=workflow.indexOf('\n      - name:',start+1);return workflow.slice(start,end<0?workflow.length:end);};
test('workflow schedules and collection stages use the one resolved scope',()=>{
 assert.deepEqual([...workflow.matchAll(/- cron: '([^']+)'/g)].map(m=>m[1]),['27,57 * * * *','12 */6 * * *']);
 assert.match(step('Resolve Hyperliquid refresh scope'),/BOOKS_CHECKOUT_SHA:.*steps.checkout.outputs.commit/);
 assert.match(step('Resolve Hyperliquid refresh scope'),/node scripts\/resolve_trader_refresh_mode\.cjs/);
 // Only job scheduling may inspect the UI-only label directly; source stages
 // still use the resolver with its event/checkout SHA equality validation.
 const directLabels=workflow.split('\n').filter(line=>line.includes('github.event.head_commit.message'));
 assert.equal(directLabels.length,1);
 assert.match(directLabels[0],/^      group:.*github.event_name == 'push'.*\[ui-only\].*github.run_id.*github.run_attempt.*'binance-public-source'/);
 for(const name of ['Record this collection start','Collect one public Hyperliquid snapshot'])assert.match(step(name),/if: steps.refresh-mode.outputs.mode != 'skip'/);
 for(const name of ['Precompute native and 90/180/365-day portfolio windows','Separate shared API rate windows','Precompute closing-fill win rates with persistent last-good cache','Reverify holdings after the long analytics batch'])assert.match(step(name),/if: steps.refresh-mode.outputs.mode == 'full'/);
});
test('UI-only skips Binance while Pages serialization and peer source guards remain required',()=>{
 assert.match(workflow,/concurrency:\n  group: pages\n  queue: max\n  cancel-in-progress: false/);
 assert.match(workflow,/    concurrency:\n      group:.*'binance-public-source'.*\n      queue: max\n      cancel-in-progress: false/);
 const watch=fs.readFileSync(path.join(root,'.github/workflows/binance-python-watch.yml'),'utf8');
 assert.match(watch,/    concurrency:\n      group: binance-public-source\n      queue: max\n      cancel-in-progress: false/);
 assert.match(step('Reverify holdings after the long analytics batch'),/sleep 60\n.*refresh_trader_positions\.cjs --not-before "\$BOOKS_COLLECTION_STARTED_AT"/);
 for(const name of ['Verify the preceding Binance run was safely committed','Collect the public Binance lead sample'])assert.match(step(name),/^        if: steps.refresh-mode.outputs.mode != 'skip' && steps.binance-peer-validate.outputs.allowed == 'true'$/m);
 assert.match(step('Save the snapshot without overwriting concurrent edits'),/git push origin HEAD:main/);
 assert.match(workflow,/actual_sha.*EXPECTED_SHA/);
});
test('peer checkpoint failures skip Binance without rewriting existing source state',()=>{
 const names=['Select the latest Python Binance source checkpoint','Restore the exact Python Binance source checkpoint','Validate the Python Binance global source-stop state'];
 for(const name of names){assert.match(step(name),/if: steps.refresh-mode.outputs.mode != 'skip'/);assert.match(step(name),/continue-on-error: true/);}
 assert.match(step(names[0]),/actions_state\.py select-peer/);
 assert.match(step(names[1]),/artifact-ids:.*restore_artifact_id/);
 assert.match(step(names[1]),/run-id:.*restore_run_id/);
 assert.match(step(names[2]),/actions_state\.py validate-peer/);
 assert.ok(workflow.indexOf('      - name: '+names[2])<workflow.indexOf('      - name: Verify the preceding Binance run was safely committed'));
 const report=step('Report blocked Binance collection without changing its snapshots');
 assert.match(report,/BINANCE_PEER_ALLOWED:.*steps.binance-peer-validate.outputs.allowed/);
 assert.doesNotMatch(report,/GITHUB_ENV|collect_binance|BINANCE_PREVIOUS_RUN_UNVERIFIED/);
 assert.equal((workflow.match(/continue-on-error: true/g)||[]).length,3);
});
test('mode resolution failure cannot emit a mode or allow downstream always-run collectors',()=>{
 const output=[],raw=JSON.stringify(push('[ui-only]',OTHER));
 assert.throws(()=>main({GITHUB_EVENT_NAME:'push',GITHUB_EVENT_PATH:'/event',BOOKS_CHECKOUT_SHA:SHA},{io:{statSync:()=>({size:Buffer.byteLength(raw)}),readFileSync:()=>raw},log:x=>output.push(x)}),/invalid_refresh_event/);
 assert.deepEqual(output,[]);
 assert.ok(workflow.indexOf('      - name: Resolve Hyperliquid refresh scope')<workflow.indexOf('      - name: Collect one public Hyperliquid snapshot'));
 assert.doesNotMatch(workflow,/always\(\)/);
 for(const name of ['Resolve Hyperliquid refresh scope','Collect one public Hyperliquid snapshot','Precompute native and 90/180/365-day portfolio windows','Precompute closing-fill win rates with persistent last-good cache','Collect the public Binance lead sample'])assert.doesNotMatch(step(name),/continue-on-error/);
});
test('pull-request CI covers the resolver, collectors, and their offline tests',()=>{const ci=fs.readFileSync(path.join(root,'.github/workflows/verify-binance.yml'),'utf8');for(const name of ['scripts/resolve_trader_refresh_mode.cjs','scripts/collect_trader_analytics.cjs','scripts/collect_trader_portfolios.cjs','audit/trader-refresh-mode-unit.cjs','audit/trader-analytics-collector-unit.cjs','audit/trader-portfolio-collector-unit.cjs']){assert.ok(ci.includes("- '"+name+"'"),'missing PR path '+name);assert.ok(ci.includes((name.startsWith('scripts/')?'node --check ':'node ')+name),'missing PR check '+name);}});
test('persisted source guard precedes and gates every Hyperliquid stage',()=>{const name='Check persisted Hyperliquid source refusals';assert.ok(workflow.indexOf('      - name: '+name)<workflow.indexOf('      - name: Collect one public Hyperliquid snapshot'));assert.match(step(name),/node scripts\/hyperliquid_run_guard\.cjs/);assert.match(step(name),/set -euo pipefail/);for(const name of ['Record this collection start','Collect one public Hyperliquid snapshot','Precompute native and 90/180/365-day portfolio windows','Separate shared API rate windows','Precompute closing-fill win rates with persistent last-good cache','Reverify holdings after the long analytics batch'])assert.ok(step(name).includes("steps.hyperliquid-guard.outputs.allowed == 'true'"),name);const ci=fs.readFileSync(path.join(root,'.github/workflows/verify-binance.yml'),'utf8');for(const file of ['scripts/hyperliquid_run_guard.cjs','audit/hyperliquid-run-guard-unit.cjs'])assert.ok(ci.includes("- '"+file+"'"));assert.ok(ci.includes('node audit/hyperliquid-run-guard-unit.cjs'));});
console.log('PASS '+count+' offline refresh-scope tests');
