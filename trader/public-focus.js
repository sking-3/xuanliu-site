/* Explicit public research identity; independent of ranked holding accounts. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksPublicFocus = api;
})(globalThis, function () {
  'use strict';
  const address = '0x02665a064143936ba3b5e400147b6c92560f7b24';
  const sourceUrl = 'https://app.hyperliquid.xyz/explorer/address/' + address;
  function identity() {
    return {id:'public-focus-'+address,name:'特别关注账户',accountId:address,
      exchange:'Hyperliquid',currency:'USDC',sourceKind:'public_focus',sourceUrl,
      featured:true,paid:false,windows:{},positions:[],points:[],orders:[],note:''};
  }
  function fail() { throw Error('invalid_public_focus_snapshot'); }
  function object(v) { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v; }
  function number(v, nullable=false) {
    if(nullable && v===null)return null;
    if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>=1e20)fail();
    return v;
  }
  function positive(v, nullable=false) { const n=number(v,nullable);if(n!==null&&n<0)fail();return n; }
  function time(v,now) {
    if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))fail();
    const t=Date.parse(v);if(!Number.isFinite(t)||new Date(t).toISOString()!==v||t<0||t>now+5000)fail();return t;
  }
  function validate(payload, now=Date.now()) {
    const p=object(payload);
    if(p.schemaVersion!==1||p.address!==address||p.scope!=='default_perp_dex')fail();
    const fetched=time(p.fetchedAt,now),source=time(p.sourceTime,now);
    if(fetched-source>120000||source-fetched>5000)fail();
    if(!Array.isArray(p.positions)||p.positions.length>1000)fail();
    const seen=new Set(),positions=p.positions.map(raw=>{
      const r=object(raw),signedSize=number(r.signedSize),quantity=positive(r.quantity);
      if(!signedSize||quantity!==Math.abs(signedSize)||r.side!==(signedSize>0?'long':'short'))fail();
      if(typeof r.coin!=='string'||!r.coin.trim()||r.coin.length>40||seen.has(r.coin))fail();seen.add(r.coin);
      const leverage=object(r.leverage);if(!['cross','isolated'].includes(leverage.type))fail();
      return {coin:r.coin,signedSize,quantity,side:r.side,entryPrice:positive(r.entryPrice,true),
        positionValue:positive(r.positionValue),unrealizedPnl:number(r.unrealizedPnl),
        marginUsed:positive(r.marginUsed),liquidationPrice:positive(r.liquidationPrice,true),
        leverage:{type:leverage.type,value:positive(leverage.value)}};
    });
    return {schemaVersion:1,address,scope:p.scope,fetchedAt:p.fetchedAt,sourceTime:p.sourceTime,
      accountValue:number(p.accountValue,true),positions};
  }
  return {identity,validate,maxBytes:65536};
});
