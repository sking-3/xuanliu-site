'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {collect,row}=require('../scripts/collect_okx_trades.cjs');
const model=require('../trader/okx-trades.js');
const dir=path.resolve(__dirname,'../trader/okx');
const bundle=JSON.parse(fs.readFileSync(path.join(dir,'trades.json'),'utf8'));
const id='811846999954962957',time=new Date(Date.now()-2000).toISOString();
const source={uniqueCode:id,name:'Example'};
const first={instId:'BTC-USDT-SWAP',instType:'SWAP',subPosId:'1001',uniqueCode:id,ccy:'USDT',lever:'3E+1',
  openTime:String(Date.parse(time)-3600000),closeTime:String(Date.parse(time)-60000),openAvgPx:'100.00',closeAvgPx:'101.00',pnl:'1.13',posSide:'net',subPos:'-1.123',markPx:'110',upl:'-0.11'};
function offline(map){
  return async(name,url)=>{
    const part=name.includes('-positions-')?map.positions:map.history;
    if(part===undefined)throw Error('connection failed');
    const bytes=Buffer.from(JSON.stringify(part));
    return {bytes,meta:{sourceUrl:url,httpStatus:200,receivedAt:time}};
  };
}
const ok=data=>({code:'0',data,msg:''});
test('every publicly shown row can be regenerated from its exact OKX account-bound API receipt',()=>{
  model.parse(bundle,Date.parse(bundle.generatedAt));
  let total=0;
  for(const a of bundle.accounts){
    for(const kind of ['positions','history']){
      const s=a.activity[kind],expected=new Map();
      for(const p of s.pages){
        const bytes=fs.readFileSync(path.join(dir,'trade-evidence',path.basename(p.evidencePath)));
        assert.equal(bytes.length,p.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'),p.sha256);
        const envelope=JSON.parse(bytes);
        if(envelope.code!=='0')continue;
        for(const item of envelope.data){const r=row(item,a.uniqueCode,kind,p);if(r)expected.set(r.evidencePath+':'+r.id,r);}
      }
      for(const r of s.rows)assert.deepEqual(r,expected.get(r.evidencePath+':'+r.id));
      total+=s.rows.length;
    }
    assert.equal(a.activity.orders.status,'unsupported');
  }
  assert.ok(total>0);
});
test('masked current rows, successful empty lists and provider errors stay distinct',async()=>{
  const masked={...first,instId:'',subPos:'',openTime:'',openAvgPx:''},failed={code:'59269',msg:'This futures lead trader does not exist',data:[]};
  const read=async current=>(await collect([source],offline({positions:current,history:failed}),async()=>{})).bundle;
  const data=await read(ok([masked]));
  assert.equal(data.accounts[0].activity.positions.status,'partial');assert.equal(data.accounts[0].activity.positions.hiddenCount,1);
  assert.equal(data.accounts[0].activity.history.status,'unavailable');assert.ok(data.accounts[0].activity.history.evidencePath);
  assert.equal(data.accounts[0].activity.positions.rows.length,0);
  assert.equal((await read(ok([]))).accounts[0].activity.positions.status,'empty');
});
test('repeated refresh keeps previously observed history separate from unavailable current positions; stale markers respect age',async()=>{
  const old=(await collect([source],offline({positions:ok([first]),history:ok([first])}),async()=>{})).bundle;
  const original=old.accounts[0].activity.history.rows[0];
  assert.equal(original.side,'short');assert.equal(original.unit,'张');assert.equal(original.leverage,30);
  const second=(await collect([source],offline({positions:{code:'59269',data:[],msg:'unavailable'},history:ok([])}),async()=>{},old)).bundle;
  assert.deepEqual(second.accounts[0].activity.history.rows,[original]);
  assert.equal(second.accounts[0].activity.positions.status,'unavailable');
  const view=model.parse(old,Date.parse(time)+31*60000);
  assert.equal(view.accounts[0].activity.positions.status,'stale');
  assert.equal(view.accounts[0].activity.history.status,'ready');
  const outage=(await collect([source],offline({}),async()=>{},old)).bundle;
  assert.equal(outage.accounts[0].activity.history.status,'stale');assert.equal(outage.accounts[0].activity.history.rows.length,1);
});
test('rejects another account or a substituted receipt path',async()=>{
  const input=(await collect([source],offline({positions:ok([]),history:ok([first])}),async()=>{})).bundle;
  input.accounts[0].activity.history.rows[0].sourceUrl=model.url('7E27C9B14BB5D378','history');
  assert.throws(()=>model.parse(input));
  const wrong=(await collect([source],offline({positions:ok([{...first,uniqueCode:'7E27C9B14BB5D378'}]),history:ok([])}),async()=>{})).bundle;
  assert.equal(wrong.accounts[0].activity.positions.status,'unavailable');
});
test('403 and 429 stop the whole run before another request',async()=>{
  for(const status of [403,429]){
    let requests=0;
    await assert.rejects(()=>collect([source,source],async(name,url)=>{
      requests++;return {bytes:Buffer.from('{}'),meta:{sourceUrl:url,httpStatus:status,receivedAt:time}};
    },async()=>{}),{code:'OKX_SOURCE_STOPPED'});
    assert.equal(requests,1);
  }
});
