// Synthetic fixtures, never published as observed account positions.
const assert=require('node:assert/strict'),Focus=require('../trader/public-focus.js');
const address=Focus.identity().accountId,now=Date.parse('2026-11-10T15:00:00.000Z');
const base={schemaVersion:1,address,scope:'default_perp_dex',fetchedAt:new Date(now).toISOString(),sourceTime:new Date(now-1000).toISOString(),accountValue:50,
  positions:[{coin:'ETH',signedSize:-0.1,quantity:0.1,side:'short',entryPrice:2000,positionValue:200,unrealizedPnl:0,marginUsed:40,liquidationPrice:null,leverage:{type:'cross',value:5}}]};
const copy=()=>JSON.parse(JSON.stringify(base));let count=0;
function test(name,fn){fn();count++;console.log('ok public-focus '+name);}
test('whitelisted neutral identity is separate from ranked public accounts',()=>{const r=Focus.identity();assert.equal(r.sourceKind,'public_focus');assert.equal(r.name,'特别关注账户');assert.equal(r.accountId,address);assert.deepEqual(r.windows,{});assert.equal(r.sourceUrl,'https://app.hyperliquid.xyz/explorer/address/'+address);assert.equal(r.featured,true);});
test('identity does not share mutable arrays or inferred performance',()=>{let r=Focus.identity();r.positions.push({});r.windows['30D']={roi:1};assert.deepEqual(Focus.identity().positions,[]);assert.deepEqual(Focus.identity().windows,{});});
test('valid real-shaped holding snapshot is normalized',()=>assert.deepEqual(Focus.validate(copy(),now),base));
test('empty account remains a valid snapshot and public identity',()=>{let p=copy();p.positions=[];assert.deepEqual(Focus.validate(p,now).positions,[]);assert.equal(Focus.identity().accountId,address);});
test('old data retains its original timestamps for UI freshness handling',()=>assert.equal(Focus.validate(copy(),now+86400000).fetchedAt,base.fetchedAt));
test('different address or scope cannot acquire public focus privileges',()=>{for(const p of [{...copy(),address:'0x'+'1'.repeat(40)},{...copy(),scope:'spot'}])assert.throws(()=>Focus.validate(p,now));});
test('future or malformed observation dates are rejected',()=>{for(const value of [new Date(now+6000).toISOString(),'2026-02-30T15:00:00.000Z','not a date']){let p=copy();p.fetchedAt=value;assert.throws(()=>Focus.validate(p,now));}});
test('source and retrieval times must represent the same recent response',()=>{let p=copy();p.sourceTime=new Date(now-120001).toISOString();assert.throws(()=>Focus.validate(p,now));p=copy();p.sourceTime=new Date(now+5001).toISOString();assert.throws(()=>Focus.validate(p,now+10000));});
test('position sign side and quantity must agree',()=>{for(const mutation of [{signedSize:0},{quantity:0.2},{side:'long'}]){let p=copy();Object.assign(p.positions[0],mutation);assert.throws(()=>Focus.validate(p,now));}});
test('malformed money fields and duplicate positions cannot be published',()=>{for(const value of ['200',Infinity,NaN,-1]){let p=copy();p.positions[0].positionValue=value;assert.throws(()=>Focus.validate(p,now));}let p=copy();p.positions.push({...p.positions[0]});assert.throws(()=>Focus.validate(p,now));});
test('arbitrary incoming profile claims and URLs are discarded',()=>{let p={...copy(),name:'Certified trader',sourceUrl:'https://example.com',roi:100,owner:'private'};assert.deepEqual(Focus.validate(p,now),base);});
console.log(`${count} public-focus tests passed`);
