import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/server.mjs';

test('static HTTP serves .mjs/.js as JavaScript and preserves PDF and unknown-extension mappings',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'books-static-mime-'));
 const fixtures=[
  ['module.mjs','export const value = 1;','application/javascript; charset=utf-8'],
  ['script.js','globalThis.value = 1;','application/javascript; charset=utf-8'],
  ['document.pdf','%PDF-1.7 fixture','application/pdf; charset=utf-8'],
  ['opaque.bin','opaque fixture','application/octet-stream; charset=utf-8'],
 ];
 let app;
 try{
  for(const [name,body]of fixtures)await writeFile(join(directory,name),body);
  app=createApp({siteDir:directory,aShareDir:join(directory,'a-share')});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  const base='http://127.0.0.1:'+app.server.address().port;
  for(const [name,body,type]of fixtures){
   const response=await fetch(base+'/'+name);
   assert.equal(response.status,200,name);
   assert.equal(response.headers.get('content-type'),type,name);
   assert.equal(await response.text(),body,name);
  }
 }finally{
  if(app){await new Promise(resolve=>app.server.close(resolve));app.close();}
  await rm(directory,{recursive:true,force:true});
 }
});
