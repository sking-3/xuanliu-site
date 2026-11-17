/* Public OKX futures lead trader returns. All monetary PnL is USDT. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.BooksOKXPeriodData=api;
})(globalThis,function(){
  'use strict';
  const days={ '7D':7,'30D':30,'90D':90,'365D':365 };
  const ranges={ '7D':'1','30D':'2','90D':'3','365D':'4' };
  const day=86400000,limit=6;
  const rankUrl='https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&sortType=pnl_ratio&minLeadDays=3&page=1&limit=20';
  const curveUrl=(id,p)=>'https://www.okx.com/api/v5/copytrading/public-pnl?instType=SWAP&uniqueCode='+id+'&lastDays='+ranges[p];
  const accountSourceUrl=id=>curveUrl(id,'90D');
  const validId=id=>typeof id==='string' && /^(?:[a-zA-Z0-9]{16}|[a-zA-Z0-9]{18})$/.test(id);
  const hashOk=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
  const evidencePath=(name,sha)=>'okx/evidence/'+name+'-'+sha+'.json';
  const num=Number.isFinite;
  const whole=n=>Number.isSafeInteger(n) && n>=0;
  const stamp=(s,now)=>typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && Date.parse(s)<=now+5000;
  function check(value) {if(!value)throw Error('Invalid OKX public performance snapshot');}
  function avatarUrl(value) {
    if (typeof value !== 'string' || value.length>2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
        url.hostname === 'static.okx.com' && url.pathname.startsWith('/cdn/okex/users/headimages/') ? url.href : null;
    } catch { return null; }
  }
  function parse(raw,now=Date.now()){
    check(raw?.schemaVersion===1 && raw.source==='okx_public_lead' && stamp(raw.generatedAt,now));
    check(raw.rankSourceUrl===rankUrl && hashOk(raw.rankEvidenceSha256) && raw.rankEvidencePath===evidencePath('leaders',raw.rankEvidenceSha256));
    check(stamp(raw.rankFetchedAt,now) && Date.parse(raw.rankFetchedAt)<=Date.parse(raw.generatedAt) && /^\d{14}$/.test(raw.rankVersion));
    check(Array.isArray(raw.accounts) && raw.accounts.length>0 && raw.accounts.length<=limit);
    const seen=new Set();
    for(const row of raw.accounts){
      const id=row.uniqueCode;
      check(validId(id) && !seen.has(id) && typeof row.name==='string' && row.name.trim() && row.name.length<=150);
      seen.add(id);
      check(row.sourceUrl===accountSourceUrl(id) && whole(row.leadDays) && row.leadDays>=90 && whole(row.copyTraderNum) && row.copyTraderNum>=1);
      check(row.performance && row.performance['90D']?.roi>0);
      for(const [p,part] of Object.entries(row.performance)){
        check(Object.hasOwn(days,p) && days[p]<=row.leadDays && part.sourcePeriod===p && part.sourceUrl===curveUrl(id,p));
        check(stamp(part.lastSuccessAt,now) && Date.parse(part.lastSuccessAt)<=Date.parse(raw.generatedAt) && part.sourceAsOf===null);
        check(num(part.roi) && num(part.pnl) && part.mdd===null && part.winRate===null);
        check(hashOk(part.evidenceSha256) && part.evidencePath===evidencePath(id+'-'+ranges[p],part.evidenceSha256));
        check(whole(part.beginTs) && whole(part.endTs) && part.endTs-part.beginTs===days[p]*day && part.pointCount===days[p]+1);
        check(part.endTs===row.performance['90D'].endTs && part.endTs<=Date.parse(part.lastSuccessAt));
      }
    }
    return raw;
  }
  function performance(row,period,now=Date.now()){
    const part=row?.performance?.[period];
    if(!part)return null;
    return {...part,status:now-Date.parse(part.lastSuccessAt)>day?'stale':'ready',sourceAsOf:null,
      accountAgeDays:row.leadDays,fullPeriod:row.leadDays>=days[period],periodSupported:true,currency:'USDT'};
  }
  function trader(row){
    return {id:'okx-'+row.uniqueCode,accountId:row.uniqueCode,name:row.name,sourceKind:'okx_public_lead',exchange:'OKX',
      currency:'USDT',sourceUrl:row.sourceUrl,avatarUrl:avatarUrl(row.avatarUrl),okxRecord:row};
  }
  return {parse,performance,trader,avatarUrl,rankUrl,curveUrl,accountSourceUrl,evidencePath,validId,days,ranges,limit};
});
