'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('both publication paths serialize without canceling a live deployment',()=>{
 for(const f of ['deploy-static-pages','refresh-traders'])assert.match(read('.github/workflows/'+f+'.yml'),/concurrency:\n  group: pages\n  queue: max\n  cancel-in-progress: false/);
});
test('each public artifact passes the shared offline gate before staging and deployment',()=>{
 for(const f of ['deploy-static-pages','refresh-traders']){
  const w=read('.github/workflows/'+f+'.yml');
  assert.ok(w.indexOf('run: node scripts/verify_public_release.cjs\n')<w.indexOf('run: node scripts/stage_public_release.cjs'));
  assert.ok(w.indexOf('run: node scripts/stage_public_release.cjs')<w.indexOf('uses: actions/deploy-pages@v4'));
  assert.equal((w.match(/actions\/deploy-pages@/g)||[]).length,1);
  assert.ok(w.indexOf('actual_sha=$(gh api')<w.indexOf('uses: actions/deploy-pages@v4'));
  assert.ok(w.indexOf('run: node scripts/verify_public_release.cjs --live')>w.indexOf('uses: actions/deploy-pages@v4'));
 }
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
