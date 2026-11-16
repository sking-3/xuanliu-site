'use strict';
// Source observations do not record fills. Only a complete snapshot proves a
// previously observed position was absent at the time of this subsequent read.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {clean,advance}=require('../trader/position-observations.js');
function requireValue(valid,message){if(!valid)throw Error('position_history_'+message);}
async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function write(file,data){const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(data)+'\n',{flag:'wx'});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}}
function ordered(a,b){return a.observedAt.localeCompare(b.observedAt)||a.scope.localeCompare(b.scope);}
async function persistAccount(root,observations){
  const {exchange,accountId}=observations[0],dir=path.join(root,'position-history',exchange.toLowerCase(),accountId);
  await fs.mkdir(dir,{recursive:true});
  const byMonth=new Map();for(const s of observations){const m=s.observedAt.slice(0,7);if(!byMonth.has(m))byMonth.set(m,[]);byMonth.get(m).push(s);}
  const known=(await fs.readdir(dir)).filter(n=>/^\d{4}-\d{2}\.json$/.test(n)).map(n=>n.slice(0,7));
  const months=[...new Set([...known,...byMonth.keys()])].sort(),open=new Map();let snapshots=0,events=0,latest=null;
  for(const month of months){
    const file=path.join(dir,month+'.json'),old=await read(file);if(old)requireValue(old.schemaVersion===1&&old.accountId===accountId&&old.exchange===exchange&&old.month===month&&Array.isArray(old.snapshots),'damaged_archive');
    const items=new Map((old?.snapshots||[]).map(s=>[s.observedAt+'|'+s.scope,s]));
    for(const s of byMonth.get(month)||[]){const id=s.observedAt+'|'+s.scope,existing=items.get(id);if(existing)requireValue(JSON.stringify(existing)===JSON.stringify(s),'conflicting_snapshot');else items.set(id,s);}
    const orderedItems=[...items.values()].sort(ordered),derived=[];
    for(const s of orderedItems){derived.push(...advance(open,s));latest={observedAt:s.observedAt,status:s.status,scope:s.scope};}
    const chunk={schemaVersion:1,exchange,accountId,month,snapshots:orderedItems,events:derived};
    if(!old||JSON.stringify(chunk)!==JSON.stringify(old))await write(file,chunk);
    snapshots+=orderedItems.length;events+=derived.length;
  }
  const index={schemaVersion:1,exchange,accountId,latest,months,open:[...open.values()],counts:{snapshots,events}};
  const manifest=path.join(dir,'index.json');if(JSON.stringify(index)!==JSON.stringify(await read(manifest)))await write(manifest,index);
}
// An advisory OS lock on the archive directory is released even if a collector
// is killed. This avoids publishing a stale lock file or losing one writer's rows.
async function withArchiveLock(directory,operation){
  await fs.mkdir(directory,{recursive:true});
  const script='import os,sys,fcntl; fd=os.open(sys.argv[1],os.O_RDONLY); fcntl.flock(fd,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.buffer.read()';
  const holder=spawn('python3',['-c',script,directory],{stdio:['pipe','pipe','ignore']});
  const ended=new Promise((resolve,reject)=>{holder.once('error',reject);holder.once('close',code=>code===0?resolve():reject(Error('position_history_lock_failed')));});
  holder.stdin.on('error',()=>{});
  try{
    const ready=new Promise(resolve=>holder.stdout.once('data',resolve));
    const signal=await Promise.race([ready,ended]);requireValue(signal?.toString().trim()==='ready','lock');
    return await operation();
  }finally{holder.stdin.end();await ended;}
}
async function persistSnapshots(traderRoot,values){
  const groups=new Map();for(const raw of values){const s=clean(raw),id=s.exchange+':'+s.accountId;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(s);}
  if(groups.size)await withArchiveLock(path.join(traderRoot,'position-history'),async()=>{for(const rows of groups.values())await persistAccount(traderRoot,rows);});
  return {accounts:groups.size,observations:values.length};
}
module.exports={clean,advance,persistSnapshots};
