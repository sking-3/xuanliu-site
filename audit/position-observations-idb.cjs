'use strict';
// Runs against a dedicated temporary DB; it never writes to the user's archive.
async function exercise(dependencies={}){
  const api=dependencies.api||globalThis.BooksPositionObservations;
  const idb=dependencies.indexedDB||globalThis.indexedDB,KeyRange=dependencies.IDBKeyRange||globalThis.IDBKeyRange;
  const name='books.qa.position-archive.'+Math.random(),id='0x'+('ab'.repeat(20));
  const env={indexedDB:{open:(_,v)=>idb.open(name,v)},IDBKeyRange:KeyRange};
  let store=api.createLocal(env);const at=Date.parse('2026-11-16T04:00:00Z');
  const ok=(condition,why)=>{if(!condition)throw Error(why);};
  const part=(time,size)=>({sourceTime:at+time,fetchedAt:at+time+40,accountValue:100,rows:size?[{coin:'BTC',side:'long',quantity:size,entryPrice:10,positionValue:11*size,unrealizedPnl:size,marginUsed:size,leverage:{value:2}}]:[]});
  try{
    ok(await store.record(id,part(1000,2),'websocket'),'first complete official WS sample');
    await store.record(id,part(1000,2),'rest');await store.close();store=api.createLocal(env);
    ok((await store.index(id)).open[0].quantity==='2','reload restores seen position');
    // The late sample arrived after the empty source sample and must be inserted chronologically.
    await store.record(id,part(4000,0),'websocket');await store.record(id,part(2000,3),'rest');await store.record(id,part(3000,1),'websocket');
    await store.record(id,{...part(5000,0),fetchedAt:at+125001},'rest');
    const head=await store.index(id),month=await store.month(id,'2026-11');
    ok(head.counts.snapshots===4&&head.open.length===0,'duplicate/stale excluded; valid empty closes observation');
    ok(month.events.map(e=>e.type).join(',')==='first_seen,increased,decreased,no_longer_seen','durable observed opening and later absence');
    ok(month.snapshots[0].equity.value==='100'&&month.snapshots[2].positions[0].markPrice==='11','observed equity and exposure retained');
    const failed=api.createLocal({});ok(!await failed.record(id,part(1000,2),'rest')&&failed.error(id)==='storage_unavailable','unavailable storage is explicit');
    return {snapshots:head.counts.snapshots,events:head.counts.events,methods:[...new Set(month.snapshots.map(s=>s.transport))]};
  }finally{await store.close();await new Promise((resolve,reject)=>{const r=idb.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});}
}
module.exports={exercise,check:async(page)=>page.evaluate(exercise)};
