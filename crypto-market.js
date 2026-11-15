'use strict';
// Read-only crypto quotes. Public endpoints only; no API keys and no order capability.
(() => {
  const pairs = [
    ['BTC-USDT','BTCUSDT','Bitcoin'],['ETH-USDT','ETHUSDT','Ethereum'],['SOL-USDT','SOLUSDT','Solana'],
    ['XRP-USDT','XRPUSDT','XRP'],['DOGE-USDT','DOGEUSDT','Dogecoin'],['ADA-USDT','ADAUSDT','Cardano'],
    ['AVAX-USDT','AVAXUSDT','Avalanche'],['LINK-USDT','LINKUSDT','Chainlink'],['DOT-USDT','DOTUSDT','Polkadot'],
    ['LTC-USDT','LTCUSDT','Litecoin'],['BCH-USDT','BCHUSDT','Bitcoin Cash'],['UNI-USDT','UNIUSDT','Uniswap'],
    ['AAVE-USDT','AAVEUSDT','Aave'],['NEAR-USDT','NEARUSDT','NEAR'],['ATOM-USDT','ATOMUSDT','Cosmos'],
    ['FIL-USDT','FILUSDT','Filecoin'],['XLM-USDT','XLMUSDT','Stellar'],['SHIB-USDT','SHIBUSDT','Shiba Inu'],
    ['SUI-USDT','SUIUSDT','Sui'],['PEPE-USDT','PEPEUSDT','Pepe']
  ].map(([id, binance, name]) => ({id, binance, name}));
  const byBinance = new Map(pairs.map(p => [p.binance, p]));
  const byId = new Map(pairs.map(p => [p.id, p]));
  const providerLabel = {binance:'Binance', okx:'OKX', bitget:'Bitget'};
  let sourceUnavailable = false, lastQuoteAt = 0;
  const mounts = document.querySelectorAll('[data-crypto-feed]');
  if (!mounts.length) return;
  const visiblePairs = mount => mount.dataset.scope === 'full' ? pairs : pairs.slice(0, 8);
  const clean = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const pct = (last, open, change) => {
    const direct = clean(change);
    if (direct !== null) return direct > 1 ? direct : direct * 100;
    const l=clean(last), o=clean(open);
    return l !== null && o ? ((l-o)/o)*100 : null;
  };
  function render(mount, state) {
    const status = [...state.values()].find(Boolean);
    const host = mount.querySelector('.crypto-quote-list');
    const unavailable = sourceUnavailable && !status;
    const stale = Boolean(lastQuoteAt && Date.now() - lastQuoteAt > 30000);
    mount.dataset.cryptoState = unavailable ? 'error' : stale ? 'stale' : status ? 'ready' : 'loading';
    const rows = unavailable ? '<div class="crypto-quote-empty"><strong>交易所行情暂未连接</strong><p>Binance、OKX、Bitget 当前都没有返回公开报价。请检查网络后重试。</p><button type="button" data-crypto-retry>重试</button></div>' : visiblePairs(mount).map(pair => {
      const q=state.get(pair.id), price=q?.price, change=q?.change;
      const changeText=change === null || change === undefined ? '--' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      const cls=change === null || change === undefined ? '' : change >= 0 ? 'up' : 'down';
      return `<div class="crypto-quote-row"><div><strong>${pair.name}</strong><small>${pair.id}</small></div><div class="crypto-quote-value"><strong>${price === null || price === undefined ? '--' : Number(price).toLocaleString('en-US',{maximumFractionDigits:8})}</strong><span class="${cls}">${changeText}</span></div><small class="crypto-quote-source">${q ? `${providerLabel[q.provider]||q.provider} · ${new Date(q.ts||Date.now()).toLocaleTimeString('zh-CN',{hour12:false})}` : '等待来源'}</small></div>`;
    }).join('');
    if (host) { host.innerHTML = rows; host.querySelector('[data-crypto-retry]')?.addEventListener('click', () => location.reload()); }
    const statusNode=mount.querySelector('[data-crypto-status]');
    if(statusNode) statusNode.textContent = unavailable ? '交易所公开行情暂未连接，请重试或检查网络。' : stale ? `行情暂未更新 · 上次成功 ${new Date(lastQuoteAt).toLocaleTimeString('zh-CN',{hour12:false})}` : status ? `来源：${providerLabel[status.provider]||status.provider} · 公开行情 · ${new Date(status.ts||Date.now()).toLocaleTimeString('zh-CN',{hour12:false})}` : '正在连接 Binance / OKX / Bitget 公开行情…';
  }
  function apply(state, pair, provider, last, open, change, ts) {
    const price=clean(last); if(price===null) return;
    const q={provider,price,change:pct(last,open,change),ts:Number(ts)||Date.now()};
    sourceUnavailable = false; lastQuoteAt = Date.now();
    state.set(pair.id,q);
    for(const mount of mounts) render(mount,state);
  }
  async function fetchJson(url) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),6000);
    try { const response=await fetch(url,{signal:controller.signal,cache:'no-store'}); if(!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json(); }
    finally { clearTimeout(timer); }
  }
  async function fetchBinance(state) {
    const symbols=encodeURIComponent(JSON.stringify(pairs.map(p=>p.binance)));
    const data=await fetchJson(`https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${symbols}`);
    for(const item of Array.isArray(data)?data:[]) { const p=byBinance.get(item.symbol); if(p) apply(state,p,'binance',item.lastPrice,item.openPrice,item.priceChangePercent,item.closeTime); }
  }
  async function fetchOkx(state) {
    const data=await fetchJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
    for(const item of data?.data||[]) { const p=byId.get(item.instId); if(p) apply(state,p,'okx',item.last,item.open24h,null,item.ts); }
  }
  async function fetchBitget(state) {
    const data=await fetchJson('https://api.bitget.com/api/v2/spot/market/tickers?category=SPOT');
    for(const item of data?.data||[]) { const p=byBinance.get(item.symbol); if(p) apply(state,p,'bitget',item.lastPr,item.openUtc,item.changeUtc24h,item.ts); }
  }
  function openWs(url, onMessage, onOpen, onClose) {
    if(typeof WebSocket!=='function') return null;
    const socket=new WebSocket(url); socket.onopen=onOpen; socket.onmessage=event=>{try{onMessage(JSON.parse(event.data));}catch{}}; socket.onerror=()=>{}; socket.onclose=onClose; return socket;
  }
  function connectBinance(state) {
    const streams=pairs.map(p=>`${p.binance.toLowerCase()}@ticker`).join('/');
    return openWs(`wss://stream.binance.com:9443/stream?streams=${streams}`, message=>{const d=message.data||message,p=byBinance.get(d.s);if(p)apply(state,p,'binance',d.c,d.o,d.P,d.E);},()=>{},()=>{});
  }
  function connectOkx(state) {
    const socket=openWs('wss://ws.okx.com/ws/v5/public', message=>{for(const d of message.data||[]){const p=byId.get(d.instId);if(p)apply(state,p,'okx',d.last,d.open24h,null,d.ts);}},()=>socket?.send(JSON.stringify({op:'subscribe',args:pairs.map(p=>({channel:'tickers',instId:p.id}))})),()=>{});
    return socket;
  }
  function connectBitget(state) {
    const socket=openWs('wss://ws.bitget.com/v2/ws/public', message=>{for(const d of message.data||[]){const p=byBinance.get(d.instId||d.symbol);if(p)apply(state,p,'bitget',d.lastPr,d.openUtc,d.changeUtc24h,d.ts);}},()=>socket?.send(JSON.stringify({op:'subscribe',args:pairs.map(p=>({instType:'SPOT',channel:'ticker',instId:p.binance}))})),()=>{});
    return socket;
  }
  for(const mount of mounts) {
    mount.innerHTML='<div class="crypto-native-head"><span data-crypto-status>正在连接 Binance / OKX / Bitget 公开行情…</span><a href="crypto.html">完整行情 ↗</a></div><div class="crypto-quote-list"></div><p class="crypto-native-note">公开只读行情 · 来源时间以交易所推送为准 · 不含交易权限</p>';
  }
  const state=new Map(); for(const mount of mounts) render(mount,state);
  setTimeout(()=>{ if(!state.size){ sourceUnavailable=true; for(const mount of mounts) render(mount,state); } },8000);
  const sockets=[];
  try { sockets.push(connectBinance(state),connectOkx(state),connectBitget(state)); } catch {}
  const refresh=()=>Promise.allSettled([fetchBinance(state),fetchOkx(state),fetchBitget(state)]).then(()=>{for(const mount of mounts)render(mount,state);});
  refresh(); const interval=setInterval(refresh,15000);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearInterval(interval);for(const socket of sockets)socket?.close?.();}else location.reload();});
})();
