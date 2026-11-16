'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {persistSnapshots,clean}=require('../scripts/position_lifecycle.cjs');
const {snapshotsFromBinance,snapshotFromFocus}=require('../scripts/archive_positions.cjs');
const accountId='0x'+('ab'.repeat(20));
const stamp=t=>`2026-11-01T00:${String(t).padStart(2,'0')}:00.000Z`;
const pos=(quantity,symbol='ETH')=>({key:symbol+':long',symbol,side:'long',quantity,quantityUnit:symbol,currency:'USDC',entryPrice:'2000',markPrice:null,notional:String(Number(quantity)*2000)});
const snap=(minute,rows,status='complete',scope='default_perp_dex')=>({exchange:'Hyperliquid',accountId,scope,status,observedAt:stamp(minute),sourceUrl:'https://api.hyperliquid.xyz/info',equity:{value:'5783.371',currency:'USDC'},positions:rows});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'books-obs-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));const base=path.join(dir,'position-history','hyperliquid',accountId);
  return {dir,base,put:(...values)=>persistSnapshots(dir,values),read:async(name='index')=>JSON.parse(await fs.readFile(path.join(base,name+'.json'),'utf8'))};}
test('real complete reads preserve appearance, size changes and later absence without fabricating a fill',async t=>{
  const f=await fixture(t);await f.put(snap(1,[pos('1.000000000000000001')]),snap(2,[pos('1.000000000000000002')]),snap(3,[pos('0.9')]),snap(4,[]));
  const index=await f.read(),month=await f.read('2026-11');assert.deepEqual(index.counts,{snapshots:4,events:4});assert.equal(index.open.length,0);
  assert.deepEqual(month.events.map(e=>e.type),['first_seen','increased','decreased','no_longer_seen']);
  assert.equal(month.events.at(-1).from,stamp(3));assert.equal(month.events.at(-1).to,stamp(4));assert.equal(month.events.at(-1).afterQuantity,null);
  assert.equal(month.snapshots[0].positions[0].entryPrice,'2000');assert.equal(month.snapshots[0].equity.value,'5783.371');assert.ok(!('exitPrice' in month.events.at(-1)));
});
test('hidden, stale, failed and partial reads never flatten a prior holding or renew unseen rows',async t=>{
  const f=await fixture(t);await f.put(snap(1,[pos('1')]),snap(2,[],'hidden'),snap(3,[],'unavailable'),snap(4,[],'stale'),snap(5,[pos('1','BTC')],'partial'));
  const d=await f.read();assert.equal(d.open.length,2);assert.equal(d.open.find(x=>x.symbol==='ETH').lastSeenAt,stamp(1));
  assert.deepEqual((await f.read('2026-11')).events.map(e=>e.type),['first_seen','first_seen']);
  await f.put(snap(6,[pos('2')],'partial'),snap(7,[pos('2')]),snap(8,[],'complete','other_dex'));
  const m=await f.read('2026-11');assert.equal(m.events.find(e=>e.type==='increased').from,stamp(1));assert.equal(m.events.filter(e=>e.type==='no_longer_seen').length,1);assert.equal((await f.read()).open.length,1);
});
test('concurrent writers, retry, delayed cross-month capture, and interrupted summary publication retain data',async t=>{
  const f=await fixture(t),first=snap(1,[pos('1')]),second=snap(2,[pos('2')]),past={...snap(0,[]),observedAt:'2026-10-31T23:59:00.000Z'};
  await Promise.all([f.put(second),f.put(first)]);await f.put(first,second,past);
  assert.deepEqual((await f.read()).months,['2026-10','2026-11']);assert.deepEqual((await f.read()).counts,{snapshots:3,events:2});
  await fs.unlink(path.join(f.base,'index.json'));await f.put(second);assert.deepEqual((await f.read()).counts,{snapshots:3,events:2});
  await assert.rejects(f.put({...first,positions:[]}),/conflicting_snapshot/);assert.equal((await f.read('2026-11')).snapshots.length,2);
});
test('public records and path checks enforce exchange identity, source, side and observation status',()=>{
  const observation=snap(1,[pos('1')]);for(const invalid of [{...observation,accountId:'../../file'},{...observation,sourceUrl:'https://wrong.example/a'},{...observation,status:'hidden'},{...observation,positions:[pos('1e-10000')]},{...observation,positions:[pos('1'),pos('1')]}])assert.throws(()=>clean(invalid));
  for(const row of snapshotsFromBinance(require('../trader/binance/portfolios.json')))assert.ok(clean(row));
  const focus=clean(snapshotFromFocus(require('../trader/public-focus.json')));assert.ok(focus.positions.length&&focus.equity.value);
});
