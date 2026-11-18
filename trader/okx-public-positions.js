/* Bounded, read-only snapshots from OKX's public SWAP lead position endpoint. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BooksOKXPublicPositions=api;
})(globalThis,function(){
  'use strict';

  const endpoint='/api/public/okx/lead-positions';
  const official='https://www.okx.com/api/v5/copytrading/public-current-subpositions';
  const limit=100, maxBytes=512*1024, timeoutMs=10000;
  const validId=id=>typeof id==='string'&&/^(?:[A-Za-z0-9]{16}|[A-Za-z0-9]{18})$/.test(id);
  const validSubId=id=>typeof id==='string'&&/^\d{1,28}$/.test(id);
  const validNumber=value=>typeof value==='string'&&/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)&&Number.isFinite(Number(value));
  const optionalNumber=value=>validNumber(value)?Number(value):null;
  const positive=value=>value===null||value<=0?null:value;
  const sourceUrl=id=>official+'?instType=SWAP&uniqueCode='+encodeURIComponent(id)+'&limit='+limit;

  function parse(raw,id,observedAt){
    if(!validId(id)||raw?.code!=='0'||!Array.isArray(raw.data)||raw.data.length>limit||
        !Number.isFinite(Date.parse(observedAt)))throw Error('invalid_okx_snapshot');
    const stamp=Date.parse(observedAt), url=sourceUrl(id), ids=new Set(), rows=[];
    let hiddenCount=0;
    for(const row of raw.data){
      if(!row||row.uniqueCode!==id||row.instType!=='SWAP'||!validSubId(row.subPosId)||ids.has(row.subPosId))
        throw Error('invalid_okx_identity');
      ids.add(row.subPosId);
      // The source can deliberately mask public position details.
      if(!row.instId||!row.subPos||!row.openTime||!row.openAvgPx||!row.posSide){
        hiddenCount++;
        continue;
      }
      const quantity=optionalNumber(row.subPos), opened=positive(optionalNumber(row.openTime)),
        entryPrice=positive(optionalNumber(row.openAvgPx));
      if(!/^[A-Z0-9][A-Z0-9.-]{0,75}-SWAP$/.test(row.instId)||!/^[A-Z0-9]{1,20}$/.test(row.ccy)||
          !['long','short','net'].includes(row.posSide)||quantity===null||!Number.isSafeInteger(opened)||
          opened>stamp+300000||entryPrice===null)throw Error('invalid_okx_position');
      if(!quantity){
        hiddenCount++;
        continue;
      }
      const margin=optionalNumber(row.margin), ratio=optionalNumber(row.uplRatio);
      rows.push({id:row.subPosId,symbol:row.instId,side:row.posSide==='net'?(quantity<0?'short':'long'):row.posSide,
        sourceSide:row.posSide,quantity:Math.abs(quantity),unit:'张',currency:row.ccy,
        openedAt:new Date(opened).toISOString(),entryPrice,markPrice:positive(optionalNumber(row.markPx)),
        leverage:positive(optionalNumber(row.lever)),unrealizedPnl:optionalNumber(row.upl),
        margin:margin!==null&&margin>=0?margin:null,marginMode:['cross','isolated'].includes(row.mgnMode)?row.mgnMode:null,
        pnlRatioPct:ratio!==null&&Number.isFinite(ratio*100)?ratio*100:null,sourceUrl:url});
    }
    const truncated=raw.data.length===limit;
    const status=hiddenCount&&!rows.length?'restricted':truncated||hiddenCount?'partial':rows.length?'ready':'empty';
    const reason=status==='restricted'?'OKX 隐藏了本次返回的仓位明细。':
      status==='empty'?'本次查询未返回公开仓位。':truncated?'已读取最近 100 条来源记录。':
      hiddenCount?'部分仓位明细已被来源隐藏。':null;
    return {status,rows,fetchedAt:observedAt,checkedAt:observedAt,sourceUrl:url,hiddenCount,truncated,reason};
  }

  const failureReason=Object.freeze({
    source_stopped:'OKX 来源采集已暂停，请查看上次有效快照。',
    forbidden:'OKX 来源拒绝公开请求（HTTP 403）。',
    rate_limited:'OKX 来源限流（HTTP 429）。',
    timeout:'OKX 公开仓位读取超时。',
    unavailable:'OKX 公开仓位暂时无法读取。',
    invalid:'OKX 返回的数据未通过校验。'
  });

  async function read(id,{signal}={}){
    if(!validId(id))throw Error('invalid_okx_id');
    signal?.throwIfAborted();
    const controller=new AbortController(), abort=()=>controller.abort(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    const failure=(code)=>({status:'unavailable',rows:[],fetchedAt:null,checkedAt:new Date().toISOString(),
      sourceUrl:sourceUrl(id),hiddenCount:0,truncated:false,reason:failureReason[code]});
    try {
      const response=await fetch(endpoint+'?account='+encodeURIComponent(id),
        {credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
      if(!response.ok){
        const error=response.headers.get('x-books-source-error');
        if(error==='source_stopped')return failure(error);
        return failure(({403:'forbidden',429:'rate_limited',504:'timeout'})[response.status]||'unavailable');
      }
      const length=Number(response.headers.get('content-length'));
      if(length>maxBytes)return failure('invalid');
      const bytes=await response.arrayBuffer();
      if(bytes.byteLength>maxBytes)return failure('invalid');
      const stamp=response.headers.get('x-books-source-read-at'),timestamp=Date.parse(stamp);
      if(stamp&&(!Number.isFinite(timestamp)||timestamp>Date.now()+300000))return failure('invalid');
      try{
        const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        return parse(raw,id,stamp?new Date(timestamp).toISOString():new Date().toISOString());
      }catch{return failure('invalid');}
    }catch(error){
      if(signal?.aborted)throw signal.reason;
      return failure(controller.signal.aborted?'timeout':'unavailable');
    }finally{
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
    }
  }
  return {read,parse};
});
