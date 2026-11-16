'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {loopbackSite,localLink}=require('./offline-home-policy.cjs');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('homepage test destination accepts only an explicit loopback HTTP server',()=>{
 assert.equal(loopbackSite('http://127.0.0.1:8784/').origin,'http://127.0.0.1:8784');
 for(const value of ['https://sking-3.github.io/xuanliu-site/','https://api.bitget.com/','http://127.0.0.1/','http://localhost:8784/','http://127.0.0.1:8784/index.html','http://user:pass@127.0.0.1:8784/','http://127.0.0.1:8784/?url=external','file:///index.html'])assert.throws(()=>loopbackSite(value),/Offline homepage tests require/);
});
test('API link checks cannot cross the local origin or reuse credential URLs',()=>{
 const site=loopbackSite('http://127.0.0.1:8784/');
 assert.equal(localLink('http://127.0.0.1:8784/chart.html?x=1#chart',site),'http://127.0.0.1:8784/chart.html?x=1#chart');
 for(const url of ['https://web.ifzq.gtimg.cn/','https://proxy.finance.qq.com/ifzqgtimg','https://query1.finance.yahoo.com/','https://api.bitget.com/','https://raw.githubusercontent.com/wenyuanw/a-share-heatmap/main/a.json','http://127.0.0.1:4318/','http://user@127.0.0.1:8784/'])assert.throws(()=>localLink(url,site));
});
test('external destination is rejected before loading Playwright or opening a browser',()=>{
 const r=spawnSync(process.execPath,['audit/home-dashboard-browser.cjs'],{cwd:root,encoding:'utf8',env:{...process.env,HOME_BROWSER_URL:'https://api.bitget.com/',NODE_PATH:''}});
 assert.equal(r.status,1);assert.match(r.stderr,/Offline homepage tests require/);assert.doesNotMatch(r.stderr,/Cannot find module 'playwright'/);
});
test('retired provider CLI fails closed without a browser dependency or source request',()=>{
 const r=spawnSync(process.execPath,['audit/home-provider-browser.cjs'],{cwd:root,encoding:'utf8',env:{...process.env,HOME_PROVIDER_URL:'https://api.bitget.com/',NODE_PATH:''}});
 assert.equal(r.status,1);assert.match(r.stderr,/provider probing is disabled/);assert.deepEqual(require('./home-provider-browser.cjs'),{enabled:false});
});
test('homepage workflow has no live probe for either main pushes or manual runs',()=>{
 const w=read('.github/workflows/verify-home-dashboard.yml');
 assert.match(w,/workflow_dispatch:/);assert.match(w,/branches: \[main\]/);assert.match(w,/- 'index.html'/);
 assert.match(w,/node audit\/home-dashboard-browser.cjs/);
 assert.doesNotMatch(w,/node audit\/home-provider-browser\.cjs|HOME_PROVIDER_URL|public_home=|\[ui-only\]/);
 assert.match(w,/set -euo pipefail/);
 const script=read('audit/home-dashboard-browser.cjs');
 assert.match(script,/serviceWorkers:'block'/);assert.match(script,/routeWebSocket\('\*\*\/\*'/);
 assert.match(script,/page.request.get\(localLink\(href,site\),\{maxRedirects:0\}\)/);
 assert.doesNotMatch(script,/socket\.connectToServer\(/);
});
