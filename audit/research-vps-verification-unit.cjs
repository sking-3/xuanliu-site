'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {verify}=require('../scripts/verify-vps-snapshot.cjs');
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const body='{"real":"snapshot"}\n',digest=createHash('sha256').update(body).digest('hex');
test('verifier reads only the fixed formal origin and waits for the exact bytes',async()=>{
 let time=0,calls=0;const result=await verify({snapshotPath:'macro-cn.json',digest,now:()=>time,wait:async ms=>{time+=ms;},fetchImpl:async(url,options)=>{
  calls++;assert(url.startsWith('https://45-77-39-98.sslip.io/macro-cn.json?verify='));assert.equal(options.redirect,'error');assert.equal(options.headers['Cache-Control'],'no-cache');return new Response(calls===1?'old':body);
 }});assert.equal(calls,2);assert.equal(result.digest,digest);
});
test('refused or limited publication checks stop immediately and never report success',async()=>{
 for(const status of [403,418,429]){let calls=0;await assert.rejects(verify({snapshotPath:'macro-cn.json',digest,fetchImpl:async()=>{calls++;return new Response('',{status});}}),/refused/);assert.equal(calls,1);}
 await assert.rejects(verify({snapshotPath:'../secret',digest,fetchImpl:()=>assert.fail('must not request')}),/Invalid/);
});
test('an unchanged wrong snapshot times out without being accepted as newly published',async()=>{
 let time=0;await assert.rejects(verify({snapshotPath:'quant-research/data/latest.json',digest,timeout:20,now:()=>time,wait:async ms=>{time+=ms;},fetchImpl:async()=>new Response('old')}),/timed out/);
});
test('the workflow logging pipeline preserves a failed verifier exit status',()=>{
 const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/verify-vps-publication.yml'),'utf8');
 const verification=workflow.split('- name: Verify the exact approved snapshot on the formal VPS')[1].split('- name:')[0];
 assert.match(verification,/shell: bash/);
 const result=spawnSync('bash',['--noprofile','--norc','-eo','pipefail','-c','"$NODE_BIN" scripts/verify-vps-snapshot.cjs --path invalid --digest invalid | cat'],{cwd:path.join(__dirname,'..'),env:{...process.env,NODE_BIN:process.execPath},encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/Invalid snapshot/);
});
