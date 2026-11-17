'use strict';
// Read-only release routing checks. Never dispatch a workflow, import a
// collector, open a socket, inspect Actions queues, or change stop records.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const reviewed={
  ".github/workflows/verify-shared-tdx-guard.yml": "eebcc9978e00e5edeec5602e383f2f8974d8dddc",
  ".github/actions/setup-public-release/action.yml": "189be9e13a8a5b7236b3a5837803184c3f58e46f",
  ".github/workflows/a-share-collector.yml": "ce4a80e0cc07db35ed3d8552c6384695a6d94743",
  ".github/workflows/binance-public-orders.yml": "2703d67cc9e50c1554663558b099a2b008596bee",
  ".github/workflows/binance-python-watch.yml": "c2ad748e283273cedbcb84fc880b855939c0ec63",
  ".github/workflows/copy-signal-dry-run.yml": "fdbb6418c96eda28f4466a8e55641fd8f9108bb9",
  ".github/workflows/deploy-static-pages.yml": "c75b222c5d0ad33a3fbf6c6670b260aa3b13f1be",
  ".github/workflows/quant-research.yml": "313e0e5015c01e00679295555ac5424c4256d573",
  ".github/workflows/refresh-aoying.yml": "ad00c65c7f5f7316a46ff29ed4cd5e73f69b8c2d",
  ".github/workflows/refresh-macro-cn.yml": "a54646d03a9078bc7f9641a0472089ee12065565",
  ".github/workflows/refresh-traders.yml": "d8b24770e7d81faa364e6a60de797cf9d9035ff1",
  ".github/workflows/schedule-health.yml": "75bed7b5aaeba0facec5508e7e790b3c6811df5d",
  ".github/workflows/verify-binance.yml": "e717b64c15684a4dba274c895009fb97989a504f",
  ".github/workflows/verify-home-dashboard.yml": "c525d390a8ea898b7e8c3d973c917711057f9d73",
  ".github/workflows/verify-public-site-ui.yml": "195612df319c06deb3b7f3ff1dc79335e81f83b7",
  ".github/workflows/verify-stock-workspace.yml": "d14438ac8f3e2798d680ec828cbb2278416357fb",
  "scripts/resolve_trader_refresh_mode.cjs": "5e3e0fb0ef95a97d14247a567f083210b6071d63",
  "scripts/stage_public_release.cjs": "6a928a46089d4125a2da012ee9b6ca6897b3310e",
  "scripts/verify_public_release.cjs": "ee056cda7dd605c9334f28d48f62a13f5991b202",
  "scripts/check_published_release.cjs": "f6a168e7febe407a8542a2aab74c563fe2d0fbe2",
  "audit/release-browser.cjs": "a7ab8595261147733bbe77deb36529b7139a82c1",
  "audit/selection-release-browser.cjs": "ccc47b1bbf83507ff53d5f6f8cd47253dda7499c",
  "audit/trader-refresh-mode-unit.cjs": "d8115505589c928835ff59cde574dbaa2c322a13",
  "audit/active-stocks-browser.cjs": "48fd47affcf7ef3c668c9d488211922cf7a48643"
};
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
function jobs(file){
  const value=read('.github/workflows/'+file).split(/^jobs:\s*$/m)[1];
  assert.ok(value,'missing jobs '+file);
  const starts=[...value.matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gm)];
  return Object.fromEntries(starts.map((m,i)=>[m[1],value.slice(m.index,starts[i+1]?.index)]));
}
function condition(file,job){
  const block=jobs(file)[job];assert.ok(block,'missing job '+file+'/'+job);
  const lines=block.split('\n'),i=lines.findIndex(l=>l.startsWith('    if: '));
  assert.ok(i>=0,'missing job gate '+file+'/'+job);
  let value=lines[i].slice(8).trim();
  if(value==='>-'||value==='>'){
    value='';
    for(let j=i+1;j<lines.length&&/^      \S/.test(lines[j]);j++)value+=' '+lines[j].trim();
  }
  return value.trim().replace(/^\$\{\{\s*|\s*\}\}$/g,'');
}
// A deliberately small parser for the five reviewed boolean gates. Unsupported
// syntax is a failing review, not a guessed GitHub Actions decision.
function evaluate(expression,context){
  const tokens=[];let remaining=expression;
  while(remaining.trim()){
    remaining=remaining.trimStart();
    const match=/^(&&|\|\||==|!=|\(|\)|'[^']*'|true\b|false\b|github(?:\.[A-Za-z_][A-Za-z0-9_]*)+)/.exec(remaining);
    assert.ok(match,'unsupported gate syntax');
    tokens.push(match[0]);remaining=remaining.slice(match[0].length);
  }
  let at=0;
  const allowed=new Set(['github.event_name','github.ref','github.repository',
    'github.event.workflow_run.event','github.event.workflow_run.conclusion',
    'github.event.workflow_run.head_branch']);
  function atom(){
    const token=tokens[at++];
    if(token==='('){const inner=or();assert.equal(tokens[at++],')');return inner;}
    if(token==='true'||token==='false')return ()=>token==='true';
    if(token?.startsWith("'"))return ()=>token.slice(1,-1);
    assert.ok(allowed.has(token),'unreviewed context reference');
    return context=>token.split('.').reduce((v,k)=>v?.[k],context);
  }
  function comparison(){
    const left=atom(),operator=tokens[at];
    if(operator!=='=='&&operator!=='!=')return left;
    at++;const right=atom();
    return c=>operator==='=='?left(c)===right(c):left(c)!==right(c);
  }
  function and(){
    let node=comparison();
    while(tokens[at]==='&&'){at++;const left=node,right=comparison();node=c=>Boolean(left(c)&&right(c));}
    return node;
  }
  function or(){
    let node=and();
    while(tokens[at]==='||'){at++;const left=node,right=and();node=c=>Boolean(left(c)||right(c));}
    return node;
  }
  const node=or();assert.equal(at,tokens.length,'unparsed gate');
  return node(context)===true;
}
const context=(event,upstream)=>({github:{event_name:event,ref:'refs/heads/main',
  repository:'sking-3/xuanliu-site',event:{workflow_run:upstream}}});
const sources=[
 ['refresh-traders.yml','collect-build'],
 ['binance-public-orders.yml','watch'],
 ['refresh-aoying.yml','collect'],
 ['refresh-macro-cn.yml','refresh'],
 ['quant-research.yml','research']
];
test('reviewed workflow and release files exactly match the documented snapshot',()=>{
  for(const [file,expected]of Object.entries(reviewed)){
    const bytes=fs.readFileSync(path.join(root,file));
    const actual=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
    assert.equal(actual,expected,'release plan must be reviewed again: '+file);
  }
});
test('no unreviewed workflow can enter the release route',()=>{
  const known=Object.keys(reviewed).filter(p=>p.startsWith('.github/workflows/')).map(p=>path.basename(p));
  known.push('verify-mootdx-feed.yml');
  assert.deepEqual(fs.readdirSync(path.join(root,'.github/workflows')).filter(p=>/\.ya?ml$/.test(p)).sort(),known.sort());
  const expected={
    'refresh-traders.yml':['collect-build','deploy','recover-exchange'],
    'binance-public-orders.yml':['test','watch'],
    'refresh-aoying.yml':['collect'],
    'refresh-macro-cn.yml':['refresh','deploy','verify'],
    'quant-research.yml':['validate','research','deploy','verify']
  };
  for(const [file,names]of Object.entries(expected))assert.deepEqual(Object.keys(jobs(file)),names,file);
});
test('every source job rejects push even when path filters match or fall back',()=>{
  for(const [file,job]of sources)assert.equal(evaluate(condition(file,job),context('push')),false,file+'/'+job);
});
test('pull requests and unknown events cannot enter source jobs',()=>{
  for(const event of ['pull_request','pull_request_target','repository_dispatch','merge_group','unknown'])
    for(const [file,job]of sources)assert.equal(evaluate(condition(file,job),context(event)),false,event+' '+file);
});
test('successful push or PR completion cannot chain into Aoying collection',()=>{
  for(const event of ['push','pull_request','schedule','unknown',undefined]){
    const upstream={event,conclusion:'success',head_branch:'main'};
    assert.equal(evaluate(condition('refresh-aoying.yml','collect'),context('workflow_run',upstream)),false);
  }
});
test('existing explicit dispatch and reviewed schedules retain only their old route',()=>{
  for(const [file,job]of sources)assert.equal(evaluate(condition(file,job),context('workflow_dispatch')),true,file);
  for(const [file,job]of sources)assert.equal(evaluate(condition(file,job),context('schedule')),
    ['refresh-traders.yml','refresh-macro-cn.yml','quant-research.yml'].includes(file),file);
  const gate=condition('refresh-aoying.yml','collect');
  assert.equal(evaluate(gate,context('workflow_run',{event:'workflow_dispatch',conclusion:'success',head_branch:'main'})),true);
  for(const record of [
    {event:'workflow_dispatch',conclusion:'failure',head_branch:'main'},
    {event:'workflow_dispatch',conclusion:'success',head_branch:'other'},
    {conclusion:'success',head_branch:'main'}
  ])assert.equal(evaluate(gate,context('workflow_run',record)),false);
  // Allowed scheduling is not authorization to contact a source.
});
test('parsing an unsupported gate fails rather than guessing allow',()=>{
  for(const expression of ["always()","github.actor == 'x'","true ||","!false","false; true"])
    assert.throws(()=>evaluate(expression,context('push')));
});
test('downstream deployment jobs cannot force collection jobs to run',()=>{
  for(const [file,upstream]of [['refresh-traders.yml','collect-build'],['refresh-macro-cn.yml','refresh'],['quant-research.yml','research']]){
    const deploy=jobs(file).deploy;
    assert.match(deploy,new RegExp('^    needs: '+upstream+'$','m'));
    assert.doesNotMatch(deploy,/always\(\)|continue-on-error/);
  }
});
test('old A-share manual collector and stopped Python monitor do not gain push access',()=>{
  const old=read('.github/workflows/a-share-collector.yml').split(/^permissions:/m)[0];
  assert.match(old,/\n  workflow_dispatch:/);
  assert.doesNotMatch(old,/\n  (push|schedule|workflow_run|workflow_call|repository_dispatch):/);
  const monitor=condition('binance-python-watch.yml','monitor');
  for(const event of ['push','workflow_dispatch','schedule'])assert.equal(evaluate(monitor,context(event)),false);
});
test('new mootdx workflow performs only offline checks and cannot chain a source',()=>{
  const value=read('.github/workflows/verify-mootdx-feed.yml');
  assert.doesNotMatch(value,/\n  (schedule|workflow_run|workflow_call|repository_dispatch):|--enable-network/);
  assert.match(value,/node --test tools\/mootdx_feed\/test_release_plan\.cjs/);
  assert.match(value,/unittest tools\.mootdx_feed\.test_collector/);
  const linked=read('.github/workflows/refresh-aoying.yml');
  assert.match(linked,/workflows: \["Binance public execution watch"\]/);
  assert.doesNotMatch(linked,/Verify mootdx feed|Verify public research site/);
});
test('static publication has no source calls or denied Actions inventory queries',()=>{
  for(const file of ['.github/workflows/deploy-static-pages.yml','.github/actions/setup-public-release/action.yml',
                      'scripts/stage_public_release.cjs','scripts/check_published_release.cjs']){
    assert.doesNotMatch(read(file),/scripts\/collect_|actions_state\.py|binance_run_guard|hyperliquid_run_guard|\/actions\/runs|status=queued|--enable-network/);
  }
  const deploy=read('.github/workflows/deploy-static-pages.yml');
  assert.ok(deploy.includes("ref: ${{ github.event_name == 'push' && github.event.after || 'main' }}"));
  assert.match(deploy,/git\/ref\/heads\/main/);
  assert.match(deploy,/actual_sha.*EXPECTED_SHA/);
  assert.match(deploy,/verify_public_release\.cjs --live/);
  const published=read('scripts/check_published_release.cjs');
  assert.match(published,/redirect:'error'/);
  assert.match(published,/base\.hostname!=='sking-3\.github\.io'/);
});
test('browser publication checks block external HTTP, service workers and WebSockets',()=>{
  for(const file of ['audit/release-browser.cjs','audit/selection-release-browser.cjs','audit/active-stocks-browser.cjs']){
    const value=read(file);
    assert.match(value,/serviceWorkers:'block'/);
    assert.match(value,/routeWebSocket\('\*\*\/\*',ws=>ws\.close\(\)\)/);
    assert.match(value,/\.route\('\*\*\/\*'/);
    assert.match(value,/\.abort\(\)/);
    assert.match(value,/url\.origin===/);
  }
});
test('publication stages committed data without running or bundling private outputs',()=>{
  const value=read('scripts/stage_public_release.cjs');
  assert.match(value,/\['archive','--format=tar',revision\]/);
  assert.match(value,/\['diff','--exit-code','HEAD','--'\]/);
  assert.doesNotMatch(value,/homedir|\.local\/state|\.local\/share|mootdx_feed\.collector/);
  // Python source is currently in the static archive. Pages does not execute it.
});

test('exchange recovery cannot deploy from a skipped push or PR collection job',()=>{
 const recovery=jobs('refresh-traders.yml')['recover-exchange'];
 assert.match(recovery,/^    needs: collect-build$/m);
 assert.equal(condition('refresh-traders.yml','recover-exchange'),"!cancelled() && (needs.collect-build.result == 'failure' || needs.collect-build.result == 'cancelled')");
 for(const event of ['push','pull_request']){
  assert.equal(evaluate(condition('refresh-traders.yml','collect-build'),context(event)),false);
  const upstreamResult='skipped';
  assert.equal(upstreamResult==='failure'||upstreamResult==='cancelled',false);
 }
 assert.doesNotMatch(recovery,/scripts\/collect_|--enable-network|\/actions\/runs/);
 assert.match(recovery,/node scripts\/verify_public_release\.cjs/);
 assert.match(recovery,/node scripts\/verify_public_release\.cjs --live/);
});

test('shared TDX guard workflow runs isolated offline checks only',()=>{
  const value=read('.github/workflows/verify-shared-tdx-guard.yml');
  assert.doesNotMatch(value,/\n  (schedule|workflow_dispatch|workflow_run|workflow_call|repository_dispatch):|--enable-network/);
  assert.match(value,/branches: \['codex\/shared-tdx-guard-20261117'\]/);
  assert.match(value,/unittest tools\.test_tdx_source_guard tools\.stock_research\.test_a_share_sources/);
  assert.match(value,/unittest tools\.mootdx_feed\.test_collector/);
  assert.doesNotMatch(value,/scripts\/collect_|git push|actions\/deploy|contents: write/);
});
