'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {exposure,mount}=require('../trader/position-history-view.js');
const known={status:'complete',positions:[{side:'long',currency:'USDT',notional:'40'},{side:'short',currency:'USDT',notional:20}],equity:{currency:'USDT',value:'10'}};
test('gross sums both directions and actual leverage uses the same-currency equity from this observation',()=>{
  assert.deepEqual(exposure(known),{gross:60,long:40,short:20,currency:'USDT',leverage:6});
  assert.equal(exposure({...known,equity:{value:20,currency:'BTC'}}).leverage,null);
  assert.equal(exposure({...known,equity:{value:'0',currency:'USDT'}}).leverage,null);
  assert.equal(exposure({...known,positions:[]}).gross,0);
});
test('hidden, stale, mixed-currency, redacted and missing contract notionals cannot become total exposure',()=>{
  for(const status of ['partial','hidden','unavailable','stale'])assert.equal(exposure({...known,status}).gross,null);
  for(const p of [{currency:'BTC',side:'long',notional:1},{currency:'USDT',side:'short',notional:' '},{currency:'USDT',side:'short',notional:null,entryPrice:2000,quantity:2,quantityUnit:'张'}])
    assert.equal(exposure({...known,positions:[...known.positions,p]}).gross,null);
});
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.events={};this.attrs={};this.hidden=false;this.textContent='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.textContent='';this.children=children;}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,fn){this.events[k]=fn;}
}
const doc={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)};
const text=n=>[n.textContent,...n.children.map(text)].join(' ');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('historical positions remain dated after privacy changes and expanding reads only the selected archive month',async()=>{
  const orig=global.fetch,host=new Element('section'),accountId='5075281354358777856';host.ownerDocument=doc;
  const base={schemaVersion:1,exchange:'Binance',accountId},at='2026-11-10T02:00:00.000Z',later='2026-11-12T02:00:00.000Z';
  const open={key:'BTC:long',symbol:'BTCUSDT',side:'long',quantity:'1',quantityUnit:'BTC',firstSeenAt:at,lastSeenAt:at};
  const catalog={...base,latest:{status:'hidden',observedAt:later},open:[open],months:['2026-11'],counts:{snapshots:2,events:1}};
  const chunk={...base,month:'2026-11',snapshots:[{...known,scope:'public_lead_futures',observedAt:at},{status:'hidden',scope:'public_lead_futures',observedAt:later,positions:[]}],events:[]};
  const calls=[];global.fetch=async path=>{calls.push(path);return {ok:true,json:async()=>path.endsWith('index.json')?catalog:chunk};};
  try{
    const handle=mount(host,{exchange:'Binance',accountId});await flush();
    assert.equal(calls.length,1);assert.match(text(host),/仓位未公开.*仓位最后见于/);
    const details=host.children.find(x=>x.tag==='details');details.open=true;details.events.toggle();await flush();
    assert.equal(calls.length,2);assert.ok(calls[1].endsWith('2026-11.json'));assert.match(text(host),/最后一次公开观察到的仓位.*BTCUSDT/);assert.match(text(host),/未公开/);
    handle.destroy();assert.equal(host.children.length,0);
  }finally{global.fetch=orig;}
});
