'use strict';
// Execute the actual workflow persistence shell against local disposable Git
// remotes. These checks never contact GitHub, an exchange, or the live VPS.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const repository=path.resolve(__dirname,'..');
const workflow=require('node:fs').readFileSync(path.join(repository,'.github/workflows/refresh-traders.yml'),'utf8');
function shellFor(name){
  const begin=workflow.indexOf('      - name: '+name+'\n');assert(begin>=0,name);
  const tail=workflow.slice(begin),next=tail.indexOf('\n      - name:',1);
  const step=next<0?tail:tail.slice(0,next),marker='        run: |\n',at=step.indexOf(marker);
  assert(at>=0,'missing shell: '+name);
  return step.slice(at+marker.length).split('\n').filter(line=>line.startsWith('          ')).map(line=>line.slice(10)).join('\n');
}
const saveShell=shellFor('Persist source stops or the complete verified bundle');
const guardShell=shellFor('Check durable source stops before any public request');
async function setup(t){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'period-workflow-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const remote=path.join(temp,'remote.git'),work=path.join(temp,'work');
  const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
  const git=(...args)=>execFileSync('git',['-C',work,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  execFileSync('git',['init','--bare','--initial-branch=main',remote],{env,stdio:'ignore'});
  await fs.mkdir(work);execFileSync('git',['init','--initial-branch=main',work],{env,stdio:'ignore'});
  git('config','user.name','offline test');git('config','user.email','test@example.invalid');git('remote','add','origin',remote);
  const write=async(file,data)=>{const target=path.join(work,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,typeof data==='string'?data:JSON.stringify(data));};
  const feed={schemaVersion:1,status:'ready',source:{id:'hyperliquid',url:'https://app.hyperliquid.xyz/leaderboard',
    status:'ok',selectedAccounts:0,positionVerification:{scope:'default_perp_dex',stopCode:null}},traders:[]};
  await write('trader/feed.json',feed);await write('trader/period-samples.json',{old:true});
  await write('trader/hyperliquid-fills.json',{old:true});
  await write('scripts/collect_hyperliquid_fills.cjs','if(process.argv[2]!=="--gate")process.exit(2);process.stdout.write("allowed=true\\n");');
  await write('trader/position-history/README.md','existing observations');
  await write('trader/source-policy.js',await fs.readFile(path.join(repository,'trader/source-policy.js'),'utf8'));
  for(const [file,method]of [['analytics','closing-fill-v1'],['portfolios','portfolio-periods-v2']])
    await write('trader/'+file+'.json',{schemaVersion:1,methodVersion:method,source:{id:'hyperliquid',
      endpoint:'https://api.hyperliquid.xyz/info',status:'ready',stopCode:null,accounts:0},accounts:{}});
  git('add','.');git('commit','-m','initial');git('push','-u','origin','main');
  const before=git('rev-parse','HEAD'),output=path.join(temp,'output'),runner=path.join(temp,'runner'),githubEnv=path.join(temp,'env');
  await fs.mkdir(runner);
  const run=outcome=>execFileSync('bash',['-c',saveShell],{cwd:work,env:{...env,PERIODS_OUTCOME:outcome,GITHUB_OUTPUT:output,RUNNER_TEMP:runner,GITHUB_ENV:githubEnv},
    encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const runGuard=()=>execFileSync('bash',['-c',guardShell],{cwd:work,env:{...env,GITHUB_OUTPUT:output,RUNNER_TEMP:runner,GITHUB_ENV:githubEnv},
    encoding:'utf8',stdio:['ignore','pipe','pipe']});
  return {write,run,runGuard,git,before,feed,work,output,remote,env,githubEnv};
}
test('only the new bounded HL batch runs, with durable stop handling after failure',()=>{
  assert.match(workflow,/if: always\(\) && steps\.guard\.outcome == 'success'/);
  assert.match(workflow,/git add -- trader\/period-samples-stop\.json/);
  assert.match(workflow,/if \[\[ -f trader\/period-samples-stop\.json \]\]; then gate=allowed=false; fi/);
  assert.doesNotMatch(workflow,/run: (?:node|python3?)(?: -B)? scripts\/(?:collect_trader_analytics|collect_trader_portfolios|collect_binance|collect_okx|collect_bitget)/);
  assert.doesNotMatch(workflow,/ssh |api\.hyperliquid\.xyz/);
  assert.match(guardShell,/git ls-remote --heads origin hyperliquid-period-source-stop/);
  assert.match(guardShell,/git show FETCH_HEAD:trader\/period-samples-stop\.json/);
  const timeout=Number(workflow.match(/    timeout-minutes: (\d+)/)?.[1]);assert(timeout>=40);
});
test('failed period collection never commits the modified feed or a partial bundle',async t=>{
  const f=await setup(t);await f.write('trader/feed.json',{...f.feed,changed:true});
  await f.write('trader/period-samples.json',{partial:true});f.run('failure');
  assert.equal(f.git('rev-parse','HEAD'),f.before);
  assert.match(await fs.readFile(f.output,'utf8'),/updated=false/);
});
test('a failed batch persists its source stop without the partial feed or samples',async t=>{
  const f=await setup(t);await f.write('trader/feed.json',{...f.feed,changed:true});
  await f.write('trader/period-samples.json',{partial:true});
  await f.write('trader/period-samples-stop.json',{status:'stopped',errorCode:'http_429'});f.run('failure');
  assert.equal(f.git('diff-tree','--no-commit-id','--name-only','-r','HEAD'),'trader/period-samples-stop.json');
  assert.equal(f.git('show','HEAD:trader/period-samples.json'),'{"old":true}');
  const remoteHead=execFileSync('git',['--git-dir',f.remote,'rev-parse','main'],{encoding:'utf8'}).trim();
  assert.equal(remoteHead,f.before);
  assert.match(execFileSync('git',['--git-dir',f.remote,'show','hyperliquid-period-source-stop:trader/period-samples-stop.json'],{encoding:'utf8'}),/http_429/);
});
test('a successful batch commits the feed, sample bundle and observation archive together',async t=>{
  const f=await setup(t);await f.write('trader/feed.json',{...f.feed,changed:true});
  await f.write('trader/period-samples.json',{complete:true});await f.write('trader/position-history/README.md','new observation');
  await f.write('trader/hyperliquid-fills.json',{fresh:true});
  f.run('success');assert.deepEqual(f.git('diff-tree','--no-commit-id','--name-only','-r','HEAD').split('\n'),[
    'trader/feed.json','trader/hyperliquid-fills.json','trader/period-samples.json','trader/position-history/README.md']);
  assert.match(await fs.readFile(f.output,'utf8'),/updated=true/);
});
async function concurrentMain(f){
  const other=path.join(path.dirname(f.work),'other');
  execFileSync('git',['clone','--quiet',f.remote,other],{env:f.env,stdio:'pipe'});
  const git=(...args)=>execFileSync('git',['-C',other,...args],{env:f.env,encoding:'utf8',stdio:'pipe'}).trim();
  git('config','user.name','concurrent test');git('config','user.email','test@example.invalid');
  await fs.writeFile(path.join(other,'unrelated.txt'),'a concurrent main change');git('add','unrelated.txt');git('commit','-m','concurrent main');git('push','origin','main');
  return git('rev-parse','HEAD');
}
test('main advancing during collection cannot discard the independent durable refusal',async t=>{
  const f=await setup(t),advanced=await concurrentMain(f);
  await f.write('trader/feed.json',{...f.feed,changed:true});await f.write('trader/period-samples.json',{partial:true});
  await f.write('trader/period-samples-stop.json',{status:'stopped',errorCode:'http_418'});f.run('failure');
  assert.equal(execFileSync('git',['--git-dir',f.remote,'rev-parse','main'],{encoding:'utf8'}).trim(),advanced);
  assert.match(execFileSync('git',['--git-dir',f.remote,'show','hyperliquid-period-source-stop:trader/period-samples-stop.json'],{encoding:'utf8'}),/http_418/);
  assert.equal(execFileSync('git',['--git-dir',f.remote,'show','main:trader/period-samples.json'],{encoding:'utf8'}),'{"old":true}');
});
test('a complete bundle still refuses to overwrite a concurrent main update',async t=>{
  const f=await setup(t),advanced=await concurrentMain(f);
  await f.write('trader/feed.json',{...f.feed,changed:true});await f.write('trader/period-samples.json',{complete:true});
  assert.throws(()=>f.run('success'));
  assert.equal(execFileSync('git',['--git-dir',f.remote,'rev-parse','main'],{encoding:'utf8'}).trim(),advanced);
  assert.equal(execFileSync('git',['--git-dir',f.remote,'show','main:trader/period-samples.json'],{encoding:'utf8'}),'{"old":true}');
});
test('the next checkout restores the refusal before permitting any collection',async t=>{
  const f=await setup(t);await f.write('trader/period-samples-stop.json',{status:'stopped',errorCode:'http_429'});f.run('failure');
  f.git('fetch','origin','main');f.git('reset','--hard','origin/main');
  await f.write('scripts/hyperliquid_run_guard.cjs',await fs.readFile(path.join(repository,'scripts/hyperliquid_run_guard.cjs'),'utf8'));
  f.runGuard();
  assert.equal(JSON.parse(await fs.readFile(path.join(f.work,'trader/period-samples-stop.json'),'utf8')).errorCode,'http_429');
  assert.match(await fs.readFile(f.output,'utf8'),/allowed=false/);
});
