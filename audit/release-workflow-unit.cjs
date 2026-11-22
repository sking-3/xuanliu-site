'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('static publication and Hyperliquid collection serialize independently without canceling active runs',()=>{
 for(const [filename,group,queue] of [['deploy-static-pages','pages','  queue: max\n'],['refresh-traders','hyperliquid-period-bundle','']]){
  const workflow=read('.github/workflows/'+filename+'.yml');
  assert.ok(workflow.includes('concurrency:\n  group: '+group+'\n'+queue+'  cancel-in-progress: false'));
 }
});
test('all browser release jobs use the same supported runner as the PR gate',()=>{
 for(const f of ['deploy-static-pages','refresh-traders','verify-vps-publication','verify-public-site-ui','verify-home-dashboard']){
  const w=read('.github/workflows/'+f+'.yml'),runners=[...w.matchAll(/runs-on: (.+)/g)].map(m=>m[1]);
  assert.ok(runners.length>0);assert.ok(runners.every(r=>r==='ubuntu-24.04'),f+' must not drift with ubuntu-latest');
 }
});
function job(workflow,name){
 const match=workflow.match(new RegExp('^  '+name+':\\n([\\s\\S]*?)(?=^  [a-zA-Z][a-zA-Z0-9_-]*:\\n|$(?![\\s\\S]))','m'));
 assert.ok(match,'missing job '+name);return match[1];
}
function ordered(text,parts){let at=-1;for(const part of parts){const next=text.indexOf(part,at+1);assert.ok(next>at,'missing or out of order: '+part);at=next;}}
function step(jobText,name){const section=jobText.split('      - name: '+name+'\n')[1]?.split(/\n      - (?:name:|uses:)/)[0];assert.ok(section,'missing step '+name);return section;}
function enforced(section){assert.doesNotMatch(section,/continue-on-error:\s*true/);}
test('each public artifact independently passes its own release gates',()=>{
 const staticJob=job(read('.github/workflows/deploy-static-pages.yml'),'deploy');
 assert.equal((staticJob.match(/actions\/deploy-pages@/g)||[]).length,1);
 assert.match(staticJob,/EXPECTED_SHA: \$\{\{ steps.checkout.outputs.commit \}\}/);
 ordered(staticJob,['uses: ./.github/actions/setup-public-release','run: node scripts/verify_public_release.cjs\n','run: node scripts/stage_public_release.cjs','uses: actions/upload-pages-artifact@v4','actual_sha=$(gh api','uses: actions/deploy-pages@v4','run: node scripts/verify_public_release.cjs --live']);
 for(const name of ['Gate this exact checkout on offline unit, static and browser checks','Stage the committed public website','Reject an obsolete release before deployment','Deploy validated static website','Verify the published revision, assets and browser behavior'])enforced(step(staticJob,name));
 assert.match(step(staticJob,'Reject an obsolete release before deployment'),/test "\$actual_sha" = "\$EXPECTED_SHA".*exit 1/);
});
test('Hyperliquid gates the actual complete bundle and verifies its pinned production snapshot',()=>{
 const workflow=read('.github/workflows/refresh-traders.yml'),collect=job(workflow,'collect'),verify=job(workflow,'verify-production');
 assert.doesNotMatch(workflow,/actions\/(?:configure-pages|deploy-pages|upload-pages-artifact)@|github\.io|^  push:|^  (?:release-checks|recover-exchange):/m);
 ordered(collect,['uses: actions/checkout@v6','uses: actions/setup-node@v6','uses: actions/setup-python@v5','name: Test shared period rules and source guards','name: Check durable source stops before any public request','name: Read the current official public directory and verify holdings','name: Collect all current accounts with the same period rules','name: Persist source stops or the complete verified bundle']);
 const checks=step(collect,'Test shared period rules and source guards');enforced(checks);
 for(const command of ['node --test audit/period-metrics-unit.cjs audit/period-samples-collector-unit.cjs','node --test audit/period-refresh-ui-unit.cjs','node --test audit/hyperliquid-fills-unit.cjs','node audit/hyperliquid-run-guard-unit.cjs','python3 audit/hyperliquid-collector-test.py'])assert.ok(checks.includes(command),command);
 assert.match(collect,/published_sha: \$\{\{ steps.save.outputs.sha \}\}/);
 assert.match(collect,/updated: \$\{\{ steps.save.outputs.updated \}\}/);
 assert.match(verify,/needs: collect/);
 assert.match(verify,/if: needs.collect.outputs.updated == 'true' && needs.collect.result == 'success'/);
 assert.match(verify,/ref: \$\{\{ needs.collect.outputs.published_sha \}\}/);
 assert.match(verify,/persist-credentials: false/);
 const published=step(verify,'Verify the exact period bundle reached the formal site');enforced(published);
 assert.match(published,/run: bash scripts\/verify-trader-vps-publication.sh --period-bundle/);
 assert.doesNotMatch(verify,/contents: write|collect_hyperliquid|git push/);
 const verifier=read('scripts/verify-trader-vps-publication.sh');
 assert.match(verifier,/origin=https:\/\/45-77-39-98\.sslip\.io/);
 assert.match(verifier,/--period-bundle\) files=\(trader\/feed.json trader\/period-samples.json\)/);
 assert.match(verifier,/git -C "\$root" show "\$revision:\$file"/);
});
test('macro and quantitative publications pass the complete gate before approval and formal-site verification',()=>{
 const workflow=read('.github/workflows/verify-vps-publication.yml'),publish=job(workflow,'publish');
 for(const input of ['snapshot_path','digest','revision'])assert.match(workflow,new RegExp('      '+input+':\\n        type: string\\n        required: true'));
 assert.match(publish,/ref: \$\{\{ inputs.revision \}\}/);
 ordered(publish,['uses: actions/checkout@v6','uses: ./.github/actions/setup-public-release','run: node scripts/verify_public_release.cjs\n','run: node scripts/approve-research-publication.cjs --path "$SNAPSHOT_PATH" --revision "$SNAPSHOT_REVISION" --digest "$SNAPSHOT_DIGEST"','run: node scripts/verify-vps-snapshot.cjs --path "$SNAPSHOT_PATH" --digest "$SNAPSHOT_DIGEST"']);
 for(const name of ['Gate this exact checkout on offline unit, static and browser checks','Approve only the gated snapshot for the VPS pull publisher','Verify the exact approved snapshot on the formal VPS'])enforced(step(publish,name));
 assert.doesNotMatch(workflow,/--offline-only|--browser-only|deploy-static-pages|actions\/(?:configure-pages|deploy-pages|upload-pages-artifact)@|github\.io|pages: write|id-token: write|secrets:/);
 assert.match(publish,/permissions:\n      contents: write/);
 for(const [filename,dependency,snapshot] of [['refresh-macro-cn','refresh','macro-cn.json'],['quant-research','research','quant-research/data/latest.json']]){
  const caller=read('.github/workflows/'+filename+'.yml'),publication=job(caller,'publication');
  assert.match(publication,new RegExp('needs: '+dependency+'\\n'));
  assert.match(publication,/uses: \.\/\.github\/workflows\/verify-vps-publication.yml/);
  assert.ok(publication.includes('snapshot_path: '+snapshot));
  for(const output of ['digest','revision'])assert.ok(publication.includes(output+': ${{ needs.'+dependency+'.outputs.'+output+' }}'));
  assert.doesNotMatch(publication,/if:|changed|pages:|id-token:|secrets:/);
  assert.doesNotMatch(caller,/deploy-static-pages|github\.io|actions\/(?:configure-pages|deploy-pages|upload-pages-artifact)@/);
 }
 const approval=read('scripts/approve-research-publication.cjs');assert.match(approval,/const branch='research-publication-verified'/);
 assert.doesNotMatch(approval,/--force|:refs\/heads\/main/);
 const verifier=read('scripts/verify-vps-snapshot.cjs');assert.match(verifier,/const origin='https:\/\/45-77-39-98\.sslip\.io'/);
 assert.doesNotMatch(verifier,/execFile|spawn|git push|writeFile/);
});
test('pull requests and integration branch run offline checks without a special commit label',()=>{
 const w=read('.github/workflows/verify-public-site-ui.yml');
 assert.match(w,/pull_request:\n    branches: \[main\]/);
 assert.match(w,/integration\/site-release-20261117/);
 assert.match(w,/run: node scripts\/verify_public_release.cjs/);
 assert.doesNotMatch(w,/public-ui-smoke|workflow_run/);
});
test('synthetic browser fixture validates across all exchanges and stays dated',()=>{
 const fixture=require('./release-fixtures.cjs'),pool=require('../screening/market-pool.js').build(fixture);
 assert.equal(pool.rows.length,5000);assert.equal(fixture.updatedAt,'2026-11-13T08:15:00.000Z');
});
