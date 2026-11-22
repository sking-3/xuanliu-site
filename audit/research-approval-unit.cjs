'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {approve,branch}=require('../scripts/approve-research-publication.cjs');
const hash=body=>createHash('sha256').update(body).digest('hex');
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'research-approve-')),remote=path.join(directory,'remote.git'),repo=path.join(directory,'repo');
 const git=(args,cwd=repo)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 fs.mkdirSync(repo);git(['init','--bare',remote]);git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);git(['remote','add','origin',remote]);
 fs.mkdirSync(path.join(repo,'quant-research/data'),{recursive:true});fs.writeFileSync(path.join(repo,'macro-cn.json'),'{}\n');fs.writeFileSync(path.join(repo,'quant-research/data/latest.json'),'{}\n');git(['add','.']);git(['commit','-m','fixture']);git(['push','origin','main']);
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 return {directory,repo,remote,git,revision:git(['rev-parse','HEAD']),digest:hash('{}\n'),manifest(){return JSON.parse(git(['show','refs/heads/'+branch+':manifest.json'],remote));}};
}
function receiptRaces(f,count){
 const other=path.join(f.directory,'other'),counter=path.join(f.directory,'push-attempts'),receipt=path.join(f.directory,'competing-receipt.json');
 f.git(['clone','--branch','main',f.remote,other],f.directory);
 f.git(['config','user.name','Concurrent fixture'],other);f.git(['config','user.email','concurrent@example.invalid'],other);
 const hook=`#!${process.execPath}
'use strict';
const fs=require('node:fs'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const {approve}=require(${JSON.stringify(require.resolve('../scripts/approve-research-publication.cjs'))});
const other=${JSON.stringify(other)},counter=${JSON.stringify(counter)},receipt=${JSON.stringify(receipt)};
const attempt=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;
fs.writeFileSync(counter,String(attempt));
if(attempt>${count})process.exit(0);
const git=(args)=>execFileSync('git',args,{cwd:other,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
git(['fetch','origin','main']);git(['reset','--hard','FETCH_HEAD']);
const snapshotPath='quant-research/data/latest.json',body=JSON.stringify({race:attempt})+'\\n';
fs.writeFileSync(other+'/'+snapshotPath,body);git(['add','--',snapshotPath]);
git(['commit','-m','concurrent research snapshot '+attempt]);git(['push','origin','HEAD:main']);
const revision=git(['rev-parse','HEAD']),digest=createHash('sha256').update(body).digest('hex');
const approved=approve({directory:other,snapshotPath,revision,digest});
fs.writeFileSync(receipt,JSON.stringify({receiptRevision:approved.revision,revision,digest}));
`;
 fs.writeFileSync(path.join(f.repo,'.git/hooks/pre-push'),hook,{mode:0o755});
 return {counter,receipt};
}
test('approval publishes only a manifest on a separate branch and preserves the other approved snapshot',t=>{
 const f=fixture(t),input={directory:f.repo,revision:f.revision,digest:f.digest};
 assert.equal(approve({...input,snapshotPath:'macro-cn.json'}).updated,true);
 assert.equal(f.git(['rev-parse','refs/heads/main'],f.remote),f.revision);
 assert.equal(approve({...input,snapshotPath:'macro-cn.json'}).updated,false);
 approve({...input,snapshotPath:'quant-research/data/latest.json'});
 assert.deepEqual(Object.keys(f.manifest().snapshots).sort(),['macro-cn.json','quant-research/data/latest.json']);
 assert.equal(f.git(['ls-tree','--name-only','refs/heads/'+branch],f.remote),'manifest.json');
});
test('wrong paths, wrong gate checkout and uncommitted snapshot changes cannot be approved',t=>{
 const f=fixture(t),input={directory:f.repo,revision:f.revision,digest:f.digest,snapshotPath:'macro-cn.json'};
 assert.throws(()=>approve({...input,snapshotPath:'../secret'}),/Invalid/);
 assert.throws(()=>approve({...input,revision:'a'.repeat(40)}),/checkout/);
 fs.writeFileSync(path.join(f.repo,'macro-cn.json'),'changed');assert.throws(()=>approve(input),/digest/);
 assert.equal(f.git(['ls-remote','--heads','origin','refs/heads/'+branch]),'');
});
test('unrelated main commits do not invalidate the checked snapshot, superseded snapshot bytes do',t=>{
 const f=fixture(t),input={directory:f.repo,revision:f.revision,digest:f.digest,snapshotPath:'macro-cn.json'};
 fs.writeFileSync(path.join(f.repo,'unrelated.txt'),'other');f.git(['add','.']);f.git(['commit','-m','other']);f.git(['push','origin','main']);f.git(['checkout','--detach',f.revision]);
 assert.equal(approve(input).updated,true);
 f.git(['checkout','main']);fs.writeFileSync(path.join(f.repo,'macro-cn.json'),'new data');f.git(['add','.']);f.git(['commit','-m','new data']);f.git(['push','origin','main']);f.git(['checkout','--detach',f.revision]);
 assert.throws(()=>approve(input),/superseded/);
 assert.equal(f.manifest().snapshots['macro-cn.json'].revision,f.revision);
});
test('a competing first receipt is retained after retry and identical approval stays idempotent',t=>{
 const f=fixture(t),race=receiptRaces(f,1),input={directory:f.repo,revision:f.revision,digest:f.digest,snapshotPath:'macro-cn.json'};
 const result=approve(input),competing=JSON.parse(fs.readFileSync(race.receipt,'utf8'));
 assert.equal(result.updated,true);assert.equal(fs.readFileSync(race.counter,'utf8'),'2');
 assert.equal(f.git(['rev-parse','refs/heads/'+branch+'^'],f.remote),competing.receiptRevision);
 assert.equal(f.git(['rev-parse','main'],f.remote),competing.revision);
 assert.equal(f.manifest().snapshots['macro-cn.json'].revision,f.revision);
 assert.equal(f.manifest().snapshots['macro-cn.json'].digest,f.digest);
 assert.equal(f.manifest().snapshots['quant-research/data/latest.json'].revision,competing.revision);
 assert.equal(f.manifest().snapshots['quant-research/data/latest.json'].digest,competing.digest);
 assert.equal(f.git(['rev-list','--count','refs/heads/'+branch],f.remote),'2');
 assert.deepEqual(approve(input),{revision:result.revision,updated:false});
 assert.equal(f.git(['rev-parse','refs/heads/'+branch],f.remote),result.revision);
});
test('three competing receipt pushes exhaust normal retries without overwriting the latest manifest',t=>{
 const f=fixture(t),input={directory:f.repo,revision:f.revision,digest:f.digest};
 const initial=approve({...input,snapshotPath:'quant-research/data/latest.json'}),race=receiptRaces(f,3);
 assert.throws(()=>approve({...input,snapshotPath:'macro-cn.json'}),/git push/);
 const competing=JSON.parse(fs.readFileSync(race.receipt,'utf8'));
 assert.equal(fs.readFileSync(race.counter,'utf8'),'3');
 assert.equal(f.git(['rev-parse','refs/heads/'+branch],f.remote),competing.receiptRevision);
 assert.equal(f.git(['rev-list','--count','refs/heads/'+branch],f.remote),'4');
 assert.equal(f.git(['rev-parse','refs/heads/'+branch+'~3'],f.remote),initial.revision);
 assert.deepEqual(Object.keys(f.manifest().snapshots),['quant-research/data/latest.json']);
 assert.equal(f.manifest().snapshots['quant-research/data/latest.json'].revision,competing.revision);
 assert.equal(f.manifest().snapshots['quant-research/data/latest.json'].digest,competing.digest);
});
