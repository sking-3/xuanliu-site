'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {sync}=require('../scripts/publish-books-trader-snapshots.cjs');
const source=path.resolve(__dirname,'../trader'),revision='abcd'.repeat(10);
const json=value=>Buffer.from(JSON.stringify(value));
const parse=bytes=>JSON.parse(bytes.toString());
const periods=['7D','30D','90D','180D','365D','ALL'];
function resize(feed,rows,failed=0){
 feed.traders=rows;feed.source.selectedAccounts=rows.length;
 const v=feed.source.positionVerification;v.failedAccounts=failed;v.checkedAccounts=v.candidateAccounts-failed-v.unattemptedAccounts;
 v.holdingAccounts=rows.length;v.emptyAccounts=v.checkedAccounts-rows.length;return feed;
}
function samples(feed){
 const output={schemaVersion:1,generatedAt:feed.source.lastAttemptAt,accounts:{}};
 for(const row of feed.traders){
  const windows={};
  for(const period of periods){
   const anchorAt=row.windows[period]?.asOf||row.windows['30D'].asOf;
   const first=new Date(Date.parse(anchorAt)-60000).toISOString();
   const observedAt=feed.source.fetchedAt;
   const metric={value:0,startAt:first,endAt:anchorAt,count:2,observedAt,sha256:'a'.repeat(64)};
   windows[period]={anchorAt,observedAt,mdd:{...metric},win:{...metric},curve:[{time:first,value:0},{time:anchorAt,value:0}]};
   if(row.windows[period])windows[period].native={roi:row.windows[period].roi,pnl:row.windows[period].pnl,
    sourceAt:anchorAt,observedAt,sourcePeriod:row.windows[period].sourcePeriod,sha256:'b'.repeat(64)};
  }
  output.accounts[row.accountId]=windows;
 }
 return output;
}
async function fixture(t){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'books-period-publisher-'));
 t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
 const root=path.join(tmp,'trader'),staging=path.join(tmp,'stage'),stateFile=path.join(tmp,'state.json');
 await fs.mkdir(root,{recursive:true});await fs.mkdir(staging);
 for(const name of ['plaza.js','period-roi.js','source-policy.js','period-metrics.js'])await fs.copyFile(path.join(source,name),path.join(root,name));
 for(const name of ['okx-trades.js','okx-period-data.js','bitget-period-data.js'])
  await fs.writeFile(path.join(root,name),"module.exports={parse(value){if(value.invalid)throw Error('invalid fixture');return value;}};");
 const next=new Map(),previous=new Map();
 for(const file of ['okx/trades.json','okx/period-returns.json','bitget/period-returns.json']){
  const data={generatedAt:'2026-11-19T00:00:00Z',accounts:[{portfolioId:'retained',performance:{'30D':{lastSuccessAt:'2026-11-18T00:00:00Z',roi:20}}}]};
  next.set(file,json(data));
 }
 for(const kind of ['analytics','portfolios'])next.set(kind+'.json',await fs.readFile(path.join(source,kind+'.json')));
 const feed=resize(parse(await fs.readFile(path.join(source,'feed.json'))),parse(await fs.readFile(path.join(source,'feed.json'))).traders.slice(0,2));
 next.set('feed.json',json(feed));next.set('period-samples.json',json(samples(feed)));
 for(const [file,bytes]of next){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),bytes);previous.set(file,bytes);}
 const options={root,staging,stateFile,getRevision:async()=>revision,loadFile:async(pinned,file)=>{
  assert.equal(pinned,revision);const bytes=next.get(file);if(!bytes)throw Error('missing fixture '+file);return bytes;
 }};
 return {root,staging,stateFile,next,previous,options};
}
async function unchangedHL(f){for(const file of ['feed.json','period-samples.json'])assert.deepEqual(await fs.readFile(path.join(f.root,file)),f.previous.get(file));}

test('publishes zero and falling real native metrics together with the matching samples',async t=>{
 const f=await fixture(t),feed=parse(f.next.get('feed.json'));
 feed.traders[0].windows['30D'].roi=0;feed.traders[0].windows['30D'].pnl=0;
 feed.traders[1].windows['30D'].roi=-22;feed.traders[1].windows['30D'].pnl=-100;
 f.next.set('feed.json',json(feed));f.next.set('period-samples.json',json(samples(feed)));
 const result=await sync(f.options);
 assert.equal(result.hyperliquid.status,'verified');
 assert.deepEqual(result.updated,['period-samples.json','feed.json']);
 assert.equal(parse(await fs.readFile(path.join(f.root,'period-samples.json'))).accounts[feed.traders[0].accountId]['30D'].mdd.value,0);
 assert.equal(parse(await fs.readFile(path.join(f.root,'feed.json'))).traders[1].windows['30D'].roi,-22);
 assert.equal(parse(await fs.readFile(f.stateFile)).hyperliquid.status,'verified');
});

test('a missing sample file keeps both old Hyperliquid files and still publishes OKX',async t=>{
 const f=await fixture(t);f.next.delete('period-samples.json');
 const file='okx/period-returns.json',okx=parse(f.next.get(file));okx.generatedAt='2026-11-19T01:00:00Z';f.next.set(file,json(okx));
 const result=await sync(f.options);assert.equal(result.hyperliquid.status,'retained');assert.ok(result.updated.includes(file));
 await unchangedHL(f);
});

test('requires matching native cutoff, values, and exact directory identities',async t=>{
 const f=await fixture(t),original=f.next.get('period-samples.json');
 for(const mutate of [
  data=>{Object.values(data.accounts)[0]['30D'].native.roi+=1;},
  data=>{const row=Object.values(data.accounts)[0]['30D'];row.anchorAt=new Date(Date.parse(row.anchorAt)+1000).toISOString();row.native.sourceAt=row.anchorAt;},
  data=>{delete data.accounts[Object.keys(data.accounts)[0]];}
 ]){
  const data=parse(original);mutate(data);f.next.set('period-samples.json',json(data));
  const result=await sync({...f.options,check:true});assert.equal(result.hyperliquid.status,'retained');assert.ok(!result.updated.includes('feed.json'));
 }
 await unchangedHL(f);
});

test('rejects individual source/observation regressions even with a later top-level generation time',async t=>{
 const f=await fixture(t),original=f.next.get('period-samples.json');
 for(const key of ['mdd','win','native']){
  const data=parse(original),row=Object.values(data.accounts)[0]['30D'];
  row[key].observedAt=new Date(Date.parse(row[key].observedAt)-1000).toISOString();
  data.generatedAt=new Date(Date.parse(data.generatedAt)+1000).toISOString();f.next.set('period-samples.json',json(data));
  const result=await sync({...f.options,check:true});assert.equal(result.hyperliquid.status,'retained');assert.match(result.hyperliquid.reason,/would regress/);
 }
 await unchangedHL(f);
});

test('adds a newly qualified account dynamically with all its six periods',async t=>{
 const f=await fixture(t),feed=parse(f.next.get('feed.json')),row=structuredClone(feed.traders[0]);
 const address='0x'+'e'.repeat(40);row.id='hl-'+address;row.accountId=address;row.sourceUrl='https://app.hyperliquid.xyz/explorer/address/'+address;
 resize(feed,[...feed.traders,row]);f.next.set('feed.json',json(feed));f.next.set('period-samples.json',json(samples(feed)));
 const result=await sync(f.options);assert.equal(result.hyperliquid.status,'verified');assert.deepEqual(result.hyperliquid.added,[address]);
 assert.deepEqual(Object.keys(parse(await fs.readFile(path.join(f.root,'period-samples.json'))).accounts[address]),periods);
});

test('retains a malformed or older copy-platform catalog without blocking valid Hyperliquid',async t=>{
 const f=await fixture(t);f.next.set('bitget/period-returns.json',json({invalid:true}));
 const feed=parse(f.next.get('feed.json'));feed.traders[0].windows['30D'].pnl-=1;
 f.next.set('feed.json',json(feed));f.next.set('period-samples.json',json(samples(feed)));
 const okx=parse(f.next.get('okx/period-returns.json'));okx.generatedAt='2026-11-18T00:00:00Z';f.next.set('okx/period-returns.json',json(okx));
 const result=await sync(f.options);assert.equal(result.platforms.OKX.status,'retained');assert.equal(result.platforms.Bitget.status,'retained');
 assert.equal(result.hyperliquid.status,'verified');assert.deepEqual(result.updated,['period-samples.json','feed.json']);
 for(const file of ['okx/trades.json','okx/period-returns.json','bitget/period-returns.json'])assert.deepEqual(await fs.readFile(path.join(f.root,file)),f.previous.get(file));
});

test('keeps the local OKX period collector as the authoritative source',async t=>{
 const f=await fixture(t);f.next.delete('okx/period-returns.json');
 const result=await sync({...f.options,localOkxPeriods:true,check:true});
 assert.equal(result.platforms.OKX.status,'verified');assert.equal(result.catalogs['okx/period-returns.json'].source,'local');
 await assert.rejects(fs.access(f.stateFile),{code:'ENOENT'});assert.deepEqual(await fs.readdir(f.staging),[]);
});

test('keeps the source refusal guard and qualification failure protection',async t=>{
 const f=await fixture(t),analytics=parse(f.next.get('analytics.json'));
 analytics.source.stopCode='http_429';f.next.set('analytics.json',json(analytics));
 const stopped=await sync({...f.options,check:true});assert.equal(stopped.hyperliquid.status,'retained');assert.match(stopped.hyperliquid.reason,/source policy.*http_429/);
 f.next.set('analytics.json',f.previous.get('analytics.json'));
 const feed=parse(f.next.get('feed.json'));resize(feed,feed.traders.slice(0,1),1);
 f.next.set('feed.json',json(feed));f.next.set('period-samples.json',json(samples(feed)));
 const incomplete=await sync({...f.options,check:true});assert.equal(incomplete.hyperliquid.status,'retained');assert.match(incomplete.hyperliquid.reason,/incomplete verification/);
 await unchangedHL(f);
});

test('retains older legacy aggregates while the current feed and sample bundle can advance',async t=>{
 const f=await fixture(t),legacy=parse(f.next.get('analytics.json'));
 legacy.generatedAt=new Date(Date.parse(legacy.generatedAt)-1000).toISOString();legacy.source.completedAt=legacy.generatedAt;
 f.next.set('analytics.json',json(legacy));
 const feed=parse(f.next.get('feed.json'));feed.traders[0].windows['30D'].pnl-=1;
 f.next.set('feed.json',json(feed));f.next.set('period-samples.json',json(samples(feed)));
 const result=await sync(f.options);assert.equal(result.hyperliquid.status,'verified');
 assert.match(result.hyperliquid.legacyRetained.analytics,/would regress/);
 assert.deepEqual(result.updated,['period-samples.json','feed.json']);
 assert.deepEqual(await fs.readFile(path.join(f.root,'analytics.json')),f.previous.get('analytics.json'));
});
