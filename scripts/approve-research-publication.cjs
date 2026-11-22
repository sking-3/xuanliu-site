'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const branch='research-publication-verified';
const schema='books.research-publication.v1';
const paths=['macro-cn.json','quant-research/data/latest.json'];
const sha40=/^[a-f0-9]{40}$/,sha64=/^[a-f0-9]{64}$/;
const hash=body=>createHash('sha256').update(body).digest('hex');

function validateManifest(value){
 if(!value||value.schema!==schema||!value.snapshots||Array.isArray(value.snapshots))throw Error('Invalid publication manifest');
 for(const [file,item] of Object.entries(value.snapshots)){
  if(!paths.includes(file)||!item||!sha40.test(item.revision)||!sha64.test(item.digest)||!Number.isFinite(Date.parse(item.approvedAt)))throw Error('Invalid approved snapshot');
 }
 return value;
}

// Called only after the exact snapshot checkout passes the complete release gate.
function approve({directory=process.cwd(),snapshotPath,revision,digest,now=Date.now,remote='origin'}={}){
 if(!paths.includes(snapshotPath)||!sha40.test(revision)||!sha64.test(digest))throw Error('Invalid publication input');
 function git(args,input){return execFileSync('git',args,{cwd:directory,input,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe']}).trim();}
 if(git(['rev-parse','HEAD'])!==revision)throw Error('Release gate checkout does not match the snapshot revision');
 const committed=execFileSync('git',['show',revision+':'+snapshotPath],{cwd:directory,maxBuffer:2*1024*1024});
 if(hash(committed)!==digest||hash(fs.readFileSync(path.join(directory,snapshotPath)))!==digest)throw Error('Snapshot digest changed after the release gate');
 for(let attempt=1;attempt<=3;attempt++){
  git(['fetch','--no-tags','--depth=1',remote,'main']);
  const main=git(['rev-parse','FETCH_HEAD']);
  const current=execFileSync('git',['show',main+':'+snapshotPath],{cwd:directory,maxBuffer:2*1024*1024});
  if(hash(current)!==digest)throw Error('Snapshot has been superseded on main; refusing to approve older data');
  const exists=git(['ls-remote','--heads',remote,'refs/heads/'+branch]);
  let previous=null,manifest={schema,snapshots:{}};
  if(exists){
   git(['fetch','--no-tags','--depth=1',remote,branch]);previous=git(['rev-parse','FETCH_HEAD']);
   manifest=validateManifest(JSON.parse(git(['show',previous+':manifest.json'])));
  }
  const existing=manifest.snapshots[snapshotPath];
  if(existing?.revision===revision&&existing.digest===digest)return {revision:previous,updated:false};
  manifest.snapshots[snapshotPath]={revision,digest,approvedAt:new Date(now()).toISOString()};
  const blob=git(['hash-object','-w','--stdin'],JSON.stringify(manifest)+'\n');
  const tree=git(['mktree'],'100644 blob '+blob+'\tmanifest.json\n');
  const commit=git(['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit-tree',tree,...(previous?['-p',previous]:[]),'-m','release: approve verified '+snapshotPath]);
  try{git(['push',remote,commit+':refs/heads/'+branch]);return {revision:commit,updated:true};}
  catch(error){if(attempt===3)throw error;}
 }
}
if(require.main===module){
 try{
  const args=process.argv.slice(2);
  if(args.length!==6||args[0]!=='--path'||args[2]!=='--revision'||args[4]!=='--digest')throw Error('Usage: approve-research-publication.cjs --path <snapshot> --revision <sha> --digest <sha256>');
  console.log(JSON.stringify(approve({snapshotPath:args[1],revision:args[3],digest:args[5]})));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={approve,validateManifest,branch,schema,paths};
