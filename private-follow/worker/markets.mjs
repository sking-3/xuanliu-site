/* Public contract metadata and depth only. No vault access, signing or trading. */
const marketCache=new Map();
const numeric=v=>typeof v==='string'&&/^\d+(\.\d+)?$/.test(v)&&Number.isFinite(Number(v))?Number(v):NaN;
function decimalPlaces(step){const n=numeric(step),d=-Math.log10(n);if(!(n>0)||!Number.isInteger(d)||d<0||d>8)throw Error('unsupported_quantity_step');return d;}
export function contractRules(venue,raw,symbol){
 if(venue==='Binance'){
  const x=raw.symbols?.find(x=>x.symbol===symbol);if(!x||x.status!=='TRADING'||x.contractType!=='PERPETUAL'||x.quoteAsset!=='USDT'||x.marginAsset!=='USDT')throw Error('unsupported_market');
  const lot=x.filters?.find(f=>f.filterType==='MARKET_LOT_SIZE'),standard=x.filters?.find(f=>f.filterType==='LOT_SIZE'),notional=x.filters?.find(f=>f.filterType==='MIN_NOTIONAL');if(!lot||!standard||!notional)throw Error('market_schema');
  const szDecimals=decimalPlaces(String(Math.max(numeric(lot.stepSize),numeric(standard.stepSize))));return {szDecimals,minQuantity:Math.max(numeric(lot.minQty),numeric(standard.minQty)),maxQuantity:Math.min(numeric(lot.maxQty),numeric(standard.maxQty)),minNotional:numeric(notional.notional),maxLeverage:20,leverageBasis:'模拟风控上限，未核验账户杠杆档位'};
 }
 if(raw.code!=='00000'||!Array.isArray(raw.data))throw Error('market_schema');const x=raw.data.find(x=>x.symbol===symbol);if(!x||x.symbolStatus!=='normal'||x.symbolType!=='perpetual'||x.quoteCoin!=='USDT')throw Error('unsupported_market');
 return {szDecimals:decimalPlaces(x.sizeMultiplier),minQuantity:numeric(x.minTradeNum),maxQuantity:numeric(x.maxMarketOrderQty),minNotional:numeric(x.minTradeUSDT),maxLeverage:numeric(x.maxLever),leverageBasis:'来源合约公开上限；未核验账户档位'};
}
export async function paperMarket(env,venue,coin,fetcher){
 if(!['Binance','Bitget'].includes(venue)||!/^[A-Z0-9_]{1,30}$/.test(coin))throw Error('unsupported_market');const symbol=coin+'USDT',source='paper_market:'+venue;
 const held=await env.DB.prepare('SELECT reason FROM source_stops WHERE source = ?').bind(source).first();if(held)throw Error('source_stopped');
 async function read(url){const r=await fetcher(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(10000)});if([403,429].includes(r.status)){await env.DB.prepare('INSERT INTO source_stops (source, reason, stopped_at) VALUES (?, ?, ?) ON CONFLICT(source) DO NOTHING').bind(source,'http_'+r.status,Date.now()).run();throw Error('source_stopped');}if(!r.ok)throw Error('market_http_'+r.status);const text=await r.text();if(text.length>2000000)throw Error('response_too_large');return JSON.parse(text);}
 const metadataKey=source+':'+symbol;let entry=marketCache.get(metadataKey);if(!entry||Date.now()-entry.at>600000){const raw=await read(venue==='Binance'?'https://fapi.binance.com/fapi/v1/exchangeInfo':'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol='+symbol),rules=contractRules(venue,raw,symbol);if(![rules.minQuantity,rules.maxQuantity,rules.minNotional,rules.maxLeverage].every(x=>Number.isFinite(x)&&x>0))throw Error('market_schema');entry={at:Date.now(),rules};marketCache.set(metadataKey,entry);}
 const raw=await read(venue==='Binance'?'https://fapi.binance.com/fapi/v1/depth?symbol='+symbol+'&limit=50':'https://api.bitget.com/api/v2/mix/market/merge-depth?symbol='+symbol+'&productType=USDT-FUTURES&precision=scale0&limit=50');
 if(venue==='Bitget'&&raw.code!=='00000')throw Error('market_schema');const depth=venue==='Binance'?raw:raw.data,time=Number(venue==='Binance'?depth.T:depth.ts);
 function levels(xs,buy){if(!Array.isArray(xs)||!xs.length||xs.length>100)throw Error('book_schema');let previous=buy?Infinity:0;return xs.map(x=>{const px=Number(x[0]),sz=Number(x[1]);if(!(px>0&&sz>0&&Number.isFinite(px)&&Number.isFinite(sz))||(buy?px>previous:px<previous))throw Error('book_schema');previous=px;return [px,sz];});}
 if(!Number.isSafeInteger(time)||time<=0||time>Date.now()+1000||Date.now()-time>15000)throw Error('market_unavailable');const bids=levels(depth.bids,true),asks=levels(depth.asks,false);if(bids[0][0]>asks[0][0])throw Error('book_schema');
 return {...entry.rules,coin,symbol,venue,currency:'USDT',bids,asks,time,receivedAt:Date.now(),source:venue+' 官方合约盘口 · USDT'};
}
