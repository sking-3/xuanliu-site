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
test('half-hour workflow refreshes one complete period bundle without the retired scope resolver',()=>{
 assert.deepEqual([...workflow.matchAll(/- cron: '([^']+)'/g)].map(m=>m[1]),['27,57 * * * *']);
 assert.match(workflow,/group: hyperliquid-period-bundle\n  cancel-in-progress: false/);
 assert.doesNotMatch(workflow,/^  push:|resolve_trader_refresh_mode|refresh-mode|12 \*\/6/m);
 assert.match(workflow,/ref: main\n          fetch-depth: 1/);
 assert.match(step('Collect all current accounts with the same period rules'),/node scripts\/collect_period_samples\.cjs --feed trader\/feed\.json --out trader\/period-samples\.json/);
 assert.doesNotMatch(workflow,/if:.*refresh_scope|collect_trader_analytics|collect_trader_portfolios|refresh_trader_positions/);
});
test('durable source stops are loaded before either public request stage',()=>{
 const guard=step('Check durable source stops before any public request');
 assert.ok(workflow.indexOf(guard)<workflow.indexOf(step('Read the current official public directory and verify holdings')));
 for(const command of ['git ls-remote --heads origin hyperliquid-period-source-stop','git show FETCH_HEAD:trader/period-samples-stop.json','BOOKS_PERIOD_STOP_PERSISTED=true','node scripts/hyperliquid_run_guard.cjs','node scripts/collect_hyperliquid_fills.cjs --gate','if [[ -f trader/period-samples-stop.json ]]; then gate=allowed=false; fi','case "$gate" in allowed=true|allowed=false) ;; *) exit 1 ;; esac'])assert.ok(guard.includes(command),command);
 assert.doesNotMatch(guard,/continue-on-error/);
 for(const name of ['Read the current official public directory and verify holdings','Collect all current accounts with the same period rules']){
  assert.match(step(name),/if: steps.guard.outputs.allowed == 'true'/);
  assert.doesNotMatch(step(name),/continue-on-error|always\(\)/);
 }
 assert.match(step('Collect all current accounts with the same period rules'),/steps.directory.outcome == 'success'/);
 assert.match(step('Collect all current accounts with the same period rules'),/BOOKS_PERIOD_SOURCE_STOP_FILE: trader\/period-samples-stop\.json/);
 assert.match(step('Collect all current accounts with the same period rules'),/sleep 60/);
});
test('an incomplete or stopped batch persists only its source stop and never stages the public bundle',()=>{
 const save=step('Persist source stops or the complete verified bundle');
 assert.match(save,/if: always\(\) && steps.guard.outcome == 'success'/);
 assert.match(save,/PERIODS_OUTCOME: \$\{\{ steps.periods.outcome \}\}/);
 const persisted=save.slice(save.indexOf('if [[ ${BOOKS_PERIOD_STOP_PERSISTED-false} == true ]]'),save.indexOf('if [[ "$PERIODS_OUTCOME" != success ]]'));
 assert.match(persisted,/updated=false/);assert.match(persisted,/exit 0/);assert.doesNotMatch(persisted,/git (?:add|push)/);
 const stopped=save.slice(save.indexOf('if [[ "$PERIODS_OUTCOME" != success ]]'),save.indexOf('          bundle=('));
 assert.match(stopped,/source-policy\.js/);
 assert.match(stopped,/git add -- trader\/period-samples-stop\.json/);
 assert.match(stopped,/git push origin HEAD:refs\/heads\/hyperliquid-period-source-stop/);
 assert.match(stopped,/updated=false/);assert.match(stopped,/exit 0/);
 assert.doesNotMatch(stopped,/git push origin HEAD:main|git add -- trader\/feed\.json/);
});
test('successful publication retains the complete bundle and normal push protection',()=>{
 const save=step('Persist source stops or the complete verified bundle');
 assert.match(save,/bundle=\(trader\/feed\.json trader\/period-samples\.json trader\/hyperliquid-fills\.json trader\/position-history\)/);
 assert.match(save,/git diff --quiet[^\n]*-- "\$\{bundle\[@\]\}"/);
 assert.match(save,/for attempt in 1 2 3/);
 assert.match(save,/git push origin HEAD:main/);
 assert.doesNotMatch(save,/--force|git reset --hard origin\/main/);
 assert.match(save,/updated=%s/);
});
test('formal-site verification reads the exact published commit with read-only credentials',()=>{
 const verify=workflow.split('  verify-production:\n')[1];assert.ok(verify);
 assert.match(verify,/needs: collect/);
 assert.match(verify,/if: needs.collect.outputs.updated == 'true' && needs.collect.result == 'success'/);
 assert.match(verify,/ref: \$\{\{ needs.collect.outputs.published_sha \}\}/);
 assert.match(verify,/persist-credentials: false/);
 assert.match(verify,/run: bash scripts\/verify-trader-vps-publication.sh --period-bundle/);
 assert.doesNotMatch(verify,/contents: write|continue-on-error|collect_hyperliquid|git push/);
 assert.match(workflow,/permissions:\n  contents: read/);
 assert.doesNotMatch(workflow,/actions\/(?:configure-pages|deploy-pages|upload-pages-artifact)@|github\.io/);
});
test('Hyperliquid schedules cannot invoke Binance and retired observers have no schedule',()=>{
 assert.doesNotMatch(workflow,/collect_binance|collect_aoying|archive_aoying|binance_watch|public_orders\.py|binance-public-source/);
 for(const filename of ['binance-python-watch.yml','binance-public-orders.yml']){
  const watch=fs.readFileSync(path.join(root,'.github/workflows',filename),'utf8');
  assert.doesNotMatch(watch,/^  schedule:|^    - cron:/m);
  assert.match(watch,/group: binance-public-records-source\n      queue: max\n      cancel-in-progress: false/);
  if(filename==='binance-python-watch.yml')assert.match(watch,/if: \$\{\{ false && github.event_name != 'pull_request'/);
  else assert.match(watch,/if: github.event_name == 'workflow_dispatch'/);
 }
});
test('evidence storage is bounded and only manual runs retain raw evidence',()=>{
 const receipts=step('Record bounded source receipts without recurring artifact storage');
 assert.match(receipts,/if: always\(\)/);assert.match(receipts,/\[:400\]/);
 const evidence=step('Keep one manually verified raw evidence batch');
 assert.match(evidence,/if: always\(\) && github.event_name == 'workflow_dispatch'/);
 assert.match(evidence,/retention-days: 1/);
 const uploads=(workflow.match(/uses: actions\/upload-artifact@/g)||[]).length;assert.equal(uploads,1);
});
test('pull-request CI retains offline resolver and collector regression coverage',()=>{
 const ci=fs.readFileSync(path.join(root,'.github/workflows/verify-binance.yml'),'utf8');
 for(const name of ['scripts/resolve_trader_refresh_mode.cjs','scripts/collect_trader_analytics.cjs','scripts/collect_trader_portfolios.cjs','audit/trader-refresh-mode-unit.cjs','audit/trader-analytics-collector-unit.cjs','audit/trader-portfolio-collector-unit.cjs','scripts/hyperliquid_run_guard.cjs','audit/hyperliquid-run-guard-unit.cjs'])assert.ok(ci.includes("- '"+name+"'"),'missing PR path '+name);
 for(const file of ['audit/trader-refresh-mode-unit.cjs','audit/hyperliquid-run-guard-unit.cjs'])assert.ok(ci.includes('node '+file),'missing offline check '+file);
});
console.log('PASS '+count+' offline refresh-scope tests');
