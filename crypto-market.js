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
  ].map(([id, instrument, name]) => ({id, instrument, name}));
  const byInstrument = new Map(pairs.map(p => [p.instrument, p]));
  const providerLabel = {bitget:'Bitget'};
  let sourceUnavailable = false, lastQuoteAt = 0;
  const mounts = document.querySelectorAll('[data-crypto-feed]');
  if (!mounts.length) return;
  const visiblePairs = mount => mount.dataset.scope === 'full' ? pairs : pairs.slice(0, 8);
  const clean = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
  const pct = (last, open, change) => {
    const direct = clean(change);
    if (direct !== null) return direct * 100;
    const l=clean(last), o=clean(open);
    return l !== null && o ? ((l-o)/o)*100 : null;
  };
  function render(mount, state) {
    const status = [...state.values()].sort((a,b) => b.ts - a.ts)[0];
    const host = mount.querySelector('.crypto-quote-list');
    const unavailable = sourceUnavailable && !status;
    const stale = Boolean(lastQuoteAt && Date.now() - lastQuoteAt > 90000);
    mount.dataset.cryptoState = unavailable ? 'error' : stale ? 'stale' : status ? 'ready' : 'loading';
    const rows = unavailable ? '<div class="crypto-quote-empty"><strong>交易所行情暂未连接</strong><p>Bitget 当前没有返回公开报价。请检查网络后重试。</p><button type="button" data-crypto-retry>重试</button></div>' : visiblePairs(mount).map(pair => {
      const q=state.get(pair.id), price=q?.price, change=q?.change;
      const changeText=change === null || change === undefined ? '--' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      const cls=change === null || change === undefined ? '' : change >= 0 ? 'up' : 'down';
      return `<div class="crypto-quote-row"><div><strong>${pair.name}</strong><small>${pair.id}</small></div><div class="crypto-quote-value"><strong>${price === null || price === undefined ? '--' : Number(price).toLocaleString('en-US',{maximumFractionDigits:8})}</strong><span class="${cls}">${changeText}</span></div><small class="crypto-quote-source">${q ? `${providerLabel[q.provider]||q.provider} · ${new Date(q.ts).toLocaleTimeString('zh-CN',{hour12:false})}` : '等待来源'}</small></div>`;
    }).join('');
    if (host) { host.innerHTML = rows; host.querySelector('[data-crypto-retry]')?.addEventListener('click', refresh); }
    const statusNode=mount.querySelector('[data-crypto-status]');
    if(statusNode) statusNode.textContent = unavailable ? '交易所公开行情暂未连接，请重试或检查网络。' : stale ? `行情暂未更新 · 上次成功 ${new Date(lastQuoteAt).toLocaleTimeString('zh-CN',{hour12:false})}` : status ? `来源：${providerLabel[status.provider]||status.provider} · 公开行情 · ${new Date(status.ts).toLocaleTimeString('zh-CN',{hour12:false})}` : '正在连接 Bitget 公开行情…';
  }
  function apply(state, pair, provider, last, open, change, ts) {
    const price = clean(last), timestamp = clean(ts);
    if (price === null || price <= 0 || timestamp === null || timestamp <= 0 || timestamp > Date.now() + 5000) return;
    if (state.has(pair.id) && timestamp <= state.get(pair.id).ts) return;
    lastQuoteAt = Math.max(lastQuoteAt, timestamp);
    sourceUnavailable = false;
    state.set(pair.id, {id:pair.id, provider, price, change:pct(last, open, change), ts:timestamp});
    schedulePaint();
  }
  function paint() {
    for (const mount of mounts) render(mount,state);
    document.dispatchEvent(new CustomEvent('books:bitget-quotes', {detail:{
      quotes:[...state.values()], total:pairs.length, unavailable:sourceUnavailable
    }}));
  }
  let paintTimer;
  function schedulePaint() {
    if (paintTimer || document.hidden) return;
    paintTimer = setTimeout(() => { paintTimer = null; paint(); }, 400);
  }
  async function fetchJson(url) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),6000);
    try { const response=await fetch(url,{signal:controller.signal,cache:'no-store'}); if(!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json(); }
    finally { clearTimeout(timer); }
  }
  async function fetchBitget(state) {
    const data=await fetchJson('https://api.bitget.com/api/v2/spot/market/tickers');
    if (data?.code !== '00000' || !Array.isArray(data.data) || !data.data.some(item => byInstrument.has(item.symbol) && clean(item.lastPr)>0 && clean(item.ts)>0)) throw Error('Bitget ticker unavailable');
    for(const item of data.data) { const p=byInstrument.get(item.symbol); if(p) apply(state,p,'bitget',item.lastPr,item.open,item.change24h,item.ts); }
  }
  function openWs(url, onMessage, onOpen, onClose) {
    if(typeof WebSocket!=='function') return null;
    const socket=new WebSocket(url); socket.onopen=onOpen; socket.onmessage=event=>{try{onMessage(JSON.parse(event.data));}catch{}}; socket.onerror=()=>{}; socket.onclose=onClose; return socket;
  }
  function connectBitget(state) {
    const socket=openWs('wss://ws.bitget.com/v2/ws/public', message=>{for(const d of message.data||[]){const p=byInstrument.get(d.instId||d.symbol);if(p)apply(state,p,'bitget',d.lastPr,d.open24h||d.open,d.change24h,d.ts);}},()=>socket?.send(JSON.stringify({op:'subscribe',args:pairs.map(p=>({instType:'SPOT',channel:'ticker',instId:p.instrument}))})),()=>{});
    return socket;
  }
  for(const mount of mounts) {
    mount.innerHTML='<div class="crypto-native-head"><span data-crypto-status>正在连接 Bitget 公开行情…</span><a href="crypto.html">完整行情 ↗</a></div><div class="crypto-quote-list"></div><p class="crypto-native-note">公开只读行情 · 来源时间以交易所推送为准 · 不含交易权限</p>';
  }
  const state = new Map();
  let socket, interval, pending;
  async function refresh() {
    if (pending || document.hidden) return;
    pending = true;
    try { await fetchBitget(state); }
    catch { sourceUnavailable = !lastQuoteAt || Date.now() - lastQuoteAt > 90000; }
    finally { pending = false; schedulePaint(); }
  }
  function start() {
    if (document.hidden || interval) return;
    try { socket = connectBitget(state); } catch {}
    refresh();
    interval = setInterval(() => {
      if (!socket || socket.readyState === 3) {
        try { socket = connectBitget(state); } catch {}
      }
      refresh();
    },15000);
  }
  paint();
  start();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { start(); schedulePaint(); return; }
    clearInterval(interval); interval = null;
    if (socket) { socket.close(); socket = null; }
  });
})();
