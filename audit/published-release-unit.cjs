'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const fixture=String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assets={};
function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
 if(item.name.startsWith('.'))continue;const p=path.join(dir,item.name);
 if(item.isDirectory())walk(p);else if((/\.(html|js|mjs|css)$/.test(p)||p.endsWith('/research-data/a-active-stocks.json')))assets[path.relative(process.cwd(),p).split(path.sep).join('/')]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}}walk(process.cwd());
const mode=process.env.TEST_MODE;let requests=0;
const activeStocks=require('./home-active-stocks.js').releaseMetadata(require('./research-data/a-active-stocks.json'));
if(mode==='wrong-publication-version')activeStocks.publicationVersion++;
if(mode==='wrong-ranking-version')activeStocks.schemaVersion=2;
if(mode==='wrong-ranking-date')activeStocks.dataAsOf='2026-11-13';
if(mode==='wrong-ranking-generation')activeStocks.generatedAt='2026-11-13T08:00:00.000Z';
if(mode==='missing-ranking-hash')delete assets['research-data/a-active-stocks.json'];
global.setTimeout=fn=>{queueMicrotask(fn);return 1;};
global.fetch=async url=>{
 requests++;const file=new URL(url).pathname.replace('/xuanliu-site/','');
 if(mode==='refusal')return new Response('',{status:429});
 if(file==='release-manifest.json')return Response.json({schema:1,revision:mode==='wrong-revision'?'b'.repeat(40):'a'.repeat(40),assets,activeStocks});
 return new Response(((mode==='corrupted-asset'&&file==='index.html')||(mode==='corrupted-ranking'&&file==='home-active-stocks.js')||(mode==='corrupted-ranking-json'&&file==='research-data/a-active-stocks.json'))?'different bytes':fs.readFileSync(file));
};
process.on('exit',()=>console.log('REQUESTS='+requests));
require('./scripts/check_published_release.cjs');
`;
function run(mode){return spawnSync(process.execPath,['-e',fixture],{cwd:root,encoding:'utf8',env:{...process.env,TEST_MODE:mode,EXPECTED_SHA:'a'.repeat(40),RELEASE_BASE_URL:'https://sking-3.github.io/xuanliu-site/'}});}
test('deployed verifier accepts only the exact revision and matching critical assets',()=>{const r=run('ok');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/24 critical asset hashes/);assert.match(r.stdout,/REQUESTS=25/);});
test('a refusal immediately stops the deployed verifier without retry',()=>{const r=run('refusal');assert.equal(r.status,1);assert.match(r.stdout,/REQUESTS=1/);assert.match(r.stderr,/429/);});
test('an obsolete deployed manifest is never accepted after bounded propagation checks',()=>{const r=run('wrong-revision');assert.equal(r.status,1);assert.match(r.stdout,/REQUESTS=3/);assert.match(r.stderr,/revision does not match/);});
test('a matching revision marker cannot hide corrupted deployed page bytes',()=>{const r=run('corrupted-asset');assert.equal(r.status,1);assert.match(r.stdout,/REQUESTS=2/);assert.match(r.stderr,/Published asset mismatch: index.html/);});
test('the ranking script is verified against the actual deployed bytes',()=>{const r=run('corrupted-ranking');assert.equal(r.status,1);assert.match(r.stdout,/REQUESTS=3/);assert.match(r.stderr,/Published asset mismatch: home-active-stocks.js/);});
test('old or modified ranking JSON is rejected even when code and release revision match',()=>{
 const r=run('corrupted-ranking-json');assert.equal(r.status,1);assert.match(r.stdout,/REQUESTS=5/);
 assert.match(r.stderr,/Published asset mismatch: research-data\/a-active-stocks.json/);
});
test('ranking schema, source date and generation time must match the manifest',()=>{
 for(const mode of ['wrong-publication-version','wrong-ranking-version','wrong-ranking-date','wrong-ranking-generation']){
  const r=run(mode);assert.equal(r.status,1);assert.match(r.stdout,/REQUESTS=1/);assert.match(r.stderr,/ranking version\/date metadata mismatch/);
 }
});
test('a manifest without the ranking JSON hash cannot pass code-only publication checks',()=>{
 const r=run('missing-ranking-hash');assert.equal(r.status,1);assert.match(r.stderr,/Published asset mismatch: research-data\/a-active-stocks.json/);
});
