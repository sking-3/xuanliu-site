#!/usr/bin/env node
'use strict';
const {execFileSync}=require('node:child_process');
const STEP='Collect the public Binance lead sample';
function decision(records,{attempt=1,truncated=false}={}){
 if(attempt>1)return {halt:true,reason:'workflow_retry_requires_review'};
 let skipped=false;
 for(const r of records){const steps=(r.jobs||[]).flatMap(j=>j.steps||[]).filter(s=>s.name===STEP);
  if(!steps.length)continue;
  if(steps.every(s=>s.conclusion==='skipped')){skipped=true;continue;}
  if(r.status!=='completed'||r.conclusion!=='success'||steps.some(s=>s.conclusion!=='success'))return {halt:true,reason:'previous_run_unverified',runId:r.id};
  return {halt:false,reason:'previous_run_committed',runId:r.id};
 }
 return {halt:skipped||truncated,reason:skipped||truncated?'previous_run_unknown':'first_collection'};
}
function historyTruncated(response,introduced){
 return !response.workflow_runs.some(r=>Date.parse(r.created_at)<introduced)&&
  (response.total_count>response.workflow_runs.length||response.workflow_runs.length>=20);
}
function main(){
 const repo=process.env.GITHUB_REPOSITORY,id=process.env.GITHUB_RUN_ID,attempt=Number(process.env.GITHUB_RUN_ATTEMPT||'1');
 if(repo!=='sking-3/xuanliu-site'||!/^\d+$/.test(id||''))throw Error('invalid_workflow_context');
 if(attempt>1){console.log('halt');return;}
 const api=route=>JSON.parse(execFileSync('gh',['api',route],{encoding:'utf8',timeout:20000,maxBuffer:5*1024*1024}));
 const response=api('repos/'+repo+'/actions/workflows/refresh-traders.yml/runs?branch=main&per_page=20');
 if(!Array.isArray(response.workflow_runs)||!response.workflow_runs.every(r=>Number.isFinite(Date.parse(r.created_at))))throw Error('invalid_run_metadata');
 // This collector did not exist before its first source commit.
 const introduced=Date.parse('2026-11-10T00:34:21Z');
 const prior=response.workflow_runs.filter(r=>String(r.id)!==id&&Date.parse(r.created_at)>=introduced).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 const records=[];
 for(const r of prior){
  const jobs=api('repos/'+repo+'/actions/runs/'+r.id+'/jobs?per_page=100');
  if(!Array.isArray(jobs.jobs)||jobs.total_count>100)throw Error('invalid_job_metadata');
  records.push({...r,jobs:jobs.jobs});
  const result=decision(records);
  if(result.reason==='previous_run_committed'||result.reason==='previous_run_unverified'){console.log(result.halt?'halt':'ok');return;}
 }
 const result=decision(records,{truncated:historyTruncated(response,introduced)});
 console.log(result.halt?'halt':'ok');
}
module.exports={decision,STEP,historyTruncated};
if(require.main===module){try{main();}catch(e){console.error('Cannot verify prior Binance run; no source request will be made.');process.exitCode=1;}}
