'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const model=require('../trader/aoying-public-archive.js');
const collector=require('../scripts/collect_aoying_public_archive.cjs');
const archive=require('../trader/binance/aoying-public-archive.json');
async function main(){
  const snapshot=model.parse(archive),events=model.events(snapshot),cycles=model.cycles(snapshot,events);
  assert.equal(events.length,snapshot.latestOrders.length);
  assert.equal(new Set(events.map(x=>x.id)).size,events.length);
  assert.equal(cycles.length,snapshot.closedPositions.length);
  const matched=new Set();
  for(const event of events){
    assert.equal(event.pnl,null);assert.equal(event.fee,null);assert.equal(event.orderId,null);
    assert.equal(typeof event.quantity,'string');assert.equal(typeof event.price,'string');
    assert.equal(event.official,false);
  }
  for(const p of cycles){
    assert.equal(p.official,false);assert.equal(p.reference,true);
    for(const e of p.events){
      assert.equal(matched.has(e.id),false);matched.add(e.id);
      assert.ok(e.symbol===p.symbol && e.positionSide===p.positionSide && p.opened<=e.time && e.time<=p.closed);
    }
  }
  assert.throws(()=>model.parse({...snapshot,positions:[]}));
  const wrong=structuredClone(snapshot);wrong.latestOrders[0].canonicalAction='unknown';
  assert.throws(()=>model.parse(wrong));
  const sample=snapshot.latestOrders[0],savedPosition=snapshot.closedPositions[0];
  const source={ok:true,data:{id:model.sourceId,portfolioId:model.portfolioId,polledAt:snapshot.polledAt,historyLoaded:true,
    lifecycle:{sourceId:model.sourceId,meta:{visibility:'public'}},positions:[{privateValue:42}],marginBalance:'hidden',totalPnl:7,
    closedPositions:[{...savedPosition,hiddenField:'private',pnlEstimated:true}],latestOrders:[{...sample,realizedPnl:0,fee:1}]}};
  const projected=collector.project(Buffer.from(JSON.stringify(source)),snapshot.fetchedAt);
  assert.equal(projected.latestOrders[0].fingerprint,sample.fingerprint);
  assert.equal(model.events(projected)[0].pnl,null);
  assert.equal(model.cycles(projected)[0].pnlEstimated,true);
  for(const field of ['positions','marginBalance','totalPnl','hiddenField','privateValue','"fee"'])
    assert.ok(!JSON.stringify(projected).includes(field));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aoying-public-'));
  try{
    const filename=path.join(dir,'archive.json');await collector.publish(filename,projected);
    const original=await fs.readFile(filename,'utf8');
    await assert.rejects(collector.publish(filename,{...projected,polledAt:'2001-01-01T00:00:00.000Z'}),/older/);
    await assert.rejects(collector.publish(filename,{...projected,sourceBodySha256:'0'.repeat(64)}),/conflicting/);
    assert.equal(await fs.readFile(filename,'utf8'),original);
    const cumulative=path.join(dir,'cumulative.json');
    await collector.publish(cumulative,snapshot);
    const polled=Date.parse(snapshot.polledAt)+500;
    const tail=structuredClone(source);
    tail.data.polledAt=new Date(polled).toISOString();
    tail.data.latestOrders=[sample,{...sample,time:polled}];
    tail.data.closedPositions=[{...savedPosition,realizedPnl:1.23},{...savedPosition,lifecycleId:'test-tail-position'}];
    const batch=collector.project(Buffer.from(JSON.stringify(tail)),new Date(polled+50).toISOString());
    await collector.publish(cumulative,batch);
    const merged=model.parse(JSON.parse(await fs.readFile(cumulative,'utf8')));
    assert.equal(merged.latestOrders.length,snapshot.latestOrders.length+1);
    assert.equal(merged.closedPositions.length,snapshot.closedPositions.length+1);
    const mergedOrders=new Set(merged.latestOrders.map(x=>x.fingerprint));
    const mergedPositions=new Map(merged.closedPositions.map(x=>[x.lifecycleId,x]));
    assert.ok(snapshot.latestOrders.every(x=>mergedOrders.has(x.fingerprint)));
    assert.ok(snapshot.closedPositions.every(x=>mergedPositions.has(x.lifecycleId)));
    assert.equal(mergedPositions.get(savedPosition.lifecycleId).realizedPnl,1.23);
    assert.equal(merged.archiveReceipts.at(-2).sourceBodySha256,snapshot.sourceBodySha256);
    assert.equal(merged.archiveReceipts.at(-1).sourceBodySha256,batch.sourceBodySha256);
    assert.throws(()=>model.parse({...merged,archiveReceipts:[...merged.archiveReceipts].reverse()}));
    assert.deepEqual(await collector.publish(cumulative,batch),merged);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
  console.log('AlphaFox historical projection verified:',events.length,'operations,',cycles.length,'closed positions,',matched.size,'unambiguous interval matches');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
