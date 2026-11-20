import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server/server.mjs';

test('control API uses existing admin session, strict same-origin writes, version conflicts and closed trade routes',async()=>{
 const app=createApp({siteDir:fileURLToPath(new URL('../',import.meta.url))});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port;
 const request=(path,{cookie,origin=base,method='GET',body,type='application/json'}={})=>fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(origin?{origin}:{}),...(body!==undefined?{'content-type':type}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  const reg=async(email)=>{const response=await request('/api/auth/register',{method:'POST',body:{email,password:'local-test-password-12345',displayName:'Local control test'}});assert.equal(response.status,201);return response.headers.get('set-cookie').split(';')[0];};
  const admin=await reg('control-admin@example.invalid'),user=await reg('control-user@example.invalid');
  assert.equal((await request('/api/research-control/state',{origin:null})).status,401);
  assert.equal((await request('/api/research-control/state',{cookie:user})).status,403);
  const state=await (await request('/api/research-control/state',{cookie:admin})).json();assert.equal(state.currentRevision,0);assert.equal(state.capabilities.archiveReplay,true);
  for(const origin of [null,'http://other.invalid',base.replace('http:','https:')])assert.equal((await request('/api/research-control/config',{cookie:admin,origin,method:'POST',body:{expectedRevision:0,config:state.config}})).status,403);
  assert.equal((await request('/api/research-control/config',{cookie:admin,method:'POST',type:'text/plain',body:{expectedRevision:0,config:state.config}})).status,403);
  assert.equal((await request('/api/research-control/config',{cookie:admin,method:'POST',body:{expectedRevision:0,config:state.config}})).status,201);
  assert.equal((await request('/api/research-control/config',{cookie:admin,method:'POST',body:{expectedRevision:0,config:state.config}})).status,409);
  const page=await request('/control/index.html');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await request('/api/orders',{cookie:admin,method:'POST',body:{}})).status,403);
  assert.equal((await (await request('/api/health')).json()).liveTradingEnabled,false);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.close();}
});
