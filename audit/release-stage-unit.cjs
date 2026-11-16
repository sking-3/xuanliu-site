'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
test('staging keeps committed history, excludes private/test files and refuses dirty or obsolete input',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'books-release-stage-')),repo=path.join(temp,'repo');fs.mkdirSync(repo);
 const put=(f,text)=>{const p=path.join(repo,f);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
 const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
 try{
  git('init','-q');
  put('scripts/stage_public_release.cjs',fs.readFileSync(path.join(__dirname,'../scripts/stage_public_release.cjs')));
  for(const p of ['index.html','research.html','quant-research/index.html','screening/index.html','market-calendar.js'])put(p,'public');
  put('private-follow/fixture.txt','private-test-fixture');put('audit/fixture.json','synthetic');put('trader/paper-test.js','excluded');
  for(let i=0;i<400;i++)put('trader/position-history/test/'+i+'.json',JSON.stringify({testHistory:i}));
  git('add','.');git('-c','user.name=Release Test','-c','user.email=release-test@example.invalid','commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),stage=require(path.join(repo,'scripts/stage_public_release.cjs')).stage;
  put('untracked.json','must not enter artifact');
  const out=path.join(temp,'out');stage(out,sha);
  assert.equal(fs.readdirSync(path.join(out,'trader/position-history/test')).length,400);
  for(const f of ['private-follow','audit','trader/paper-test.js','untracked.json'])assert.equal(fs.existsSync(path.join(out,f)),false,f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'release-manifest.json'))).revision,sha);
  assert.throws(()=>stage(path.join(temp,'obsolete'),'0'.repeat(40)),/mismatch/);
  assert.throws(()=>stage(out,sha),/EEXIST/);
  put('index.html','uncommitted');assert.throws(()=>stage(path.join(temp,'dirty'),sha));
  assert.equal(fs.existsSync(path.join(temp,'dirty')),false);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
