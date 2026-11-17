'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('both publication paths serialize without canceling a live deployment',()=>{
 for(const f of ['deploy-static-pages','refresh-traders'])assert.match(read('.github/workflows/'+f+'.yml'),/concurrency:\n  group: pages\n  queue: max\n  cancel-in-progress: false/);
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
 const workflow=read('.github/workflows/refresh-traders.yml'),collect=job(workflow,'collect-build'),normal=job(workflow,'deploy'),recovery=job(workflow,'recover-exchange');
 assert.equal((workflow.match(/actions\/deploy-pages@/g)||[]).length,2);
 assert.equal((normal.match(/actions\/deploy-pages@/g)||[]).length,1);
 assert.equal((recovery.match(/actions\/deploy-pages@/g)||[]).length,1);
 ordered(collect,['uses: ./.github/actions/setup-public-release','run: node scripts/verify_public_release.cjs\n','run: node scripts/stage_public_release.cjs','uses: actions/upload-pages-artifact@v4']);
 for(const name of ['Gate the final snapshot on offline unit, static and browser checks','Stage only the committed website','Upload Pages artifact'])enforced(step(collect,name));
 assert.match(step(collect,'Stage only the committed website'),/EXPECTED_SHA: \$\{\{ steps.snapshot.outputs.sha \}\}/);
 ordered(normal,['uses: actions/checkout@v6','actual_sha=$(gh api','uses: actions/deploy-pages@v4','run: node scripts/verify_public_release.cjs --live']);
 for(const name of ['Stop if main advanced after this artifact was built','Deploy the validated website and snapshot','Verify the published revision, assets and browser behavior'])enforced(step(normal,name));
 assert.match(step(normal,'Stop if main advanced after this artifact was built'),/"\$actual_sha" != "\$EXPECTED_SHA"[\s\S]*exit 1/);
 assert.match(normal,/ref: \$\{\{ needs.collect-build.outputs.published_sha \}\}/);
 assert.match(step(normal,'Verify the published revision, assets and browser behavior'),/EXPECTED_SHA: \$\{\{ needs.collect-build.outputs.published_sha \}\}/);
 ordered(recovery,['uses: actions/download-artifact@v4','name: Validate the recovery commit','uses: actions/checkout@v6','uses: ./.github/actions/setup-public-release','run: node scripts/verify_public_release.cjs\n','run: node scripts/stage_public_release.cjs','uses: actions/upload-pages-artifact@v4','actual_sha=$(gh api','uses: actions/deploy-pages@v4','run: node scripts/verify_public_release.cjs --live']);
 for(const name of ['Validate the recovery commit','Check out the exchange checkpoint','Gate the exchange checkpoint on offline unit, static and browser checks','Stage the committed exchange checkpoint','Upload exchange recovery Pages artifact','Stop recovery if main advanced','Deploy the validated exchange checkpoint','Verify the published exchange revision, assets and browser behavior'])enforced(step(recovery,name));
 assert.match(step(recovery,'Validate the recovery commit'),/sha.*\$RUNNER_TEMP\/exchange-checkpoint\/sha[\s\S]*exit 1/);
 assert.match(step(recovery,'Check out the exchange checkpoint'),/ref: \$\{\{ steps.recovery.outputs.sha \}\}/);
 for(const name of ['Gate the exchange checkpoint on offline unit, static and browser checks','Stage the committed exchange checkpoint','Upload exchange recovery Pages artifact','Stop recovery if main advanced','Deploy the validated exchange checkpoint','Verify the published exchange revision, assets and browser behavior'])assert.match(step(recovery,name),/if: steps.recovery.outputs.ready == 'true'/);
 assert.match(step(recovery,'Stage the committed exchange checkpoint'),/EXPECTED_SHA: \$\{\{ steps.recovery.outputs.sha \}\}/);
 assert.match(step(recovery,'Stop recovery if main advanced'),/"\$actual_sha" != "\$EXPECTED_SHA"[\s\S]*exit 1/);
 assert.match(step(recovery,'Deploy the validated exchange checkpoint'),/artifact_name: github-pages-exchange-recovery/);
 assert.match(step(recovery,'Upload exchange recovery Pages artifact'),/name: github-pages-exchange-recovery/);
 assert.match(step(recovery,'Verify the published exchange revision, assets and browser behavior'),/EXPECTED_SHA: \$\{\{ steps.recovery.outputs.sha \}\}/);
});
test('static release carries checkout SHA and refresh deploy waits for the tested snapshot',()=>{
 assert.match(read('.github/workflows/deploy-static-pages.yml'),/EXPECTED_SHA: \$\{\{ steps.checkout.outputs.commit \}\}/);
 const w=read('.github/workflows/refresh-traders.yml');
 assert.match(w,/deploy:\n    needs: collect-build/);
 assert.match(w,/ref: \$\{\{ needs.collect-build.outputs.published_sha \}\}/);
 assert.match(w,/EXPECTED_SHA: \$\{\{ needs.collect-build.outputs.published_sha \}\}/);
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
