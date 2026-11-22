import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server/server.mjs';

test('signed-in users save only their own schemes; existing admin controls stay protected',async()=>{
 const app=createApp({siteDir:fileURLToPath(new URL('../',import.meta.url)),aShareDir:'/private/tmp/no-scheme-data'});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port;
 const request=(path,{cookie,origin=base,method='GET',body,type='application/json'}={})=>fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(origin?{origin}:{}),...(body!==undefined?{'content-type':type}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const input={name:'初期转强',config:{settings:{mode:'strength'}},selection:{patternId:'',qualification:'strict',scopeCodes:null}};
 try{
  const register=async(email)=>{const response=await request('/api/auth/register',{method:'POST',body:{email,password:'local-test-password-12345',displayName:'Scheme test'}});assert.equal(response.status,201);return response.headers.get('set-cookie').split(';')[0];};
  await register('scheme-admin@example.invalid');
  const owner=await register('scheme-owner@example.invalid'),other=await register('scheme-other@example.invalid');
  assert.equal((await request('/api/research-control/schemes',{method:'POST',body:input})).status,401);
  for(const origin of [null,'http://other.invalid'])assert.equal((await request('/api/research-control/schemes',{cookie:owner,origin,method:'POST',body:input})).status,403);
  assert.equal((await request('/api/research-control/schemes',{cookie:owner,method:'POST',type:'text/plain',body:input})).status,403);
  const response=await request('/api/research-control/schemes',{cookie:owner,method:'POST',body:input});assert.equal(response.status,201);const {scheme}=await response.json();
  assert.equal(scheme.revision,1);assert.equal(scheme.config.settings.sampleSize,'all');assert.equal(scheme.ownerId,undefined);
  const saved={...input,id:scheme.id,expectedRevision:1};
  assert.equal((await request('/api/research-control/schemes',{cookie:other,method:'POST',body:saved})).status,404);
  assert.equal((await request('/api/research-control/schemes/enabled',{cookie:other,method:'POST',body:{id:scheme.id,enabled:false}})).status,404);
  assert.equal((await request('/api/research-control/schemes',{cookie:owner,method:'POST',body:saved})).status,201);
  assert.equal((await request('/api/research-control/schemes',{cookie:owner,method:'POST',body:saved})).status,409);
  assert.equal((await request('/api/research-control/schemes',{cookie:owner,method:'POST',body:{...input,config:{settings:{mode:'bogus'}}}})).status,400);
  const published=await(await request('/api/a-share-daily/schemes?id='+scheme.id,{origin:null})).json();assert.equal(published.scheme.revision,2);assert.deepEqual(published.runs,[]);assert.deepEqual(published.tracks,[]);
  assert.equal((await request('/api/research-control/state',{cookie:owner})).status,403);
  assert.equal((await request('/api/orders',{cookie:owner,method:'POST',body:{}})).status,403);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.close();}
});
