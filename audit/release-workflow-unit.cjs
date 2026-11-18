'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('publication paths serialize independently without canceling an active run',()=>{
 for(const [filename,group] of [['deploy-static-pages','pages'],['refresh-traders','trader-production']]){
  assert.ok(read('.github/workflows/'+filename+'.yml').includes('concurrency:\n  group: '+group+'\n  queue: max\n  cancel-in-progress: false'));
 }
});
test('all browser release jobs use the same supported runner as the PR gate',()=>{
 for(const f of ['deploy-static-pages','refresh-traders','verify-public-site-ui','verify-home-dashboard']){
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
 ordered(staticJob,['uses: ./.github/actions/setup-public-release','run: node scripts/verify_public_release.cjs\n','run: node scripts/stage_public_release.cjs','uses: actions/upload-pages-artifact@v4','actual_sha=$(gh api','uses: actions/deploy-pages@v4','run: node scripts/verify_public_release.cjs --live']);
 for(const name of ['Gate this exact checkout on offline unit, static and browser checks','Stage the committed public website','Reject an obsolete release before deployment','Deploy validated static website','Verify the published revision, assets and browser behavior'])enforced(step(staticJob,name));
 assert.match(step(staticJob,'Reject an obsolete release before deployment'),/test "\$actual_sha" = "\$EXPECTED_SHA".*exit 1/);
});
test('trader data runs keep the offline release gate and verify pinned snapshots on production',()=>{
 const workflow=read('.github/workflows/refresh-traders.yml'), release=job(workflow,'release-checks'), verify=job(workflow,'verify-production'), recovery=job(workflow,'recover-exchange');
 assert.doesNotMatch(workflow,/actions\/(?:configure-pages|deploy-pages|upload-pages-artifact)@|github\.io|^  push:/m);
 const gate='Gate the final snapshot on offline unit and static checks';
 ordered(release,['uses: actions/checkout@v6','uses: actions/setup-node@v6','uses: actions/setup-python@v5','run: node scripts/verify_public_release.cjs --offline-only']);
 assert.match(release,/ref: \$\{\{ needs.collect-build.outputs.published_sha \}\}/);
 enforced(step(release,gate));
 assert.match(verify,/needs: collect-build/);
 assert.match(verify,/ref: \$\{\{ needs.collect-build.outputs.published_sha \}\}/);
 const normal='Verify the exact snapshots on the formal site';
 assert.match(step(verify,normal),/run: bash scripts\/verify-trader-vps-publication.sh\n/);
 enforced(step(verify,normal));
 ordered(recovery,['uses: actions/download-artifact@v4','name: Validate the recovery commit','uses: actions/checkout@v6','run: bash scripts/verify-trader-vps-publication.sh --exchange-only']);
 assert.match(step(recovery,'Validate the recovery commit'),/sha.*\$RUNNER_TEMP\/exchange-checkpoint\/sha[\s\S]*exit 1/);
 assert.match(step(recovery,'Check out the exchange checkpoint'),/ref: \$\{\{ steps.recovery.outputs.sha \}\}/);
 const fromCheckpoint=step(recovery,'Verify the formal site received the exchange checkpoint');
 assert.match(fromCheckpoint,/if: steps.recovery.outputs.ready == 'true'/);
 enforced(fromCheckpoint);
 assert.match(read('.github/workflows/deploy-static-pages.yml'),/EXPECTED_SHA: \$\{\{ steps.checkout.outputs.commit \}\}/);
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
