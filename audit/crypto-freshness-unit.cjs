// Isolated, synthetic time and messages. No browser, network, wallet, or production writes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = require('node:path').join(__dirname, '../crypto-market.js');
let now = Date.parse('2026-11-16T18:00:00Z');
const timers = new Map(), intervals = [];
let seq = 0, socket;
const status = {textContent:''};
const host = {innerHTML:'',querySelector(){return null;}};
const mount = {dataset:{scope:'full'},innerHTML:'',querySelector(s){return s==='.crypto-quote-list'?host:status;}};
const events = [];
class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
class Socket {constructor(){socket=this;this.readyState=1;} send(){}close(){}}
const context = {
 Date:Clock, Map, Set, JSON, Number, String, Boolean, Math, console,
 document:{hidden:false,querySelectorAll(){return [mount];},addEventListener(){},dispatchEvent(e){events.push(e);}},
 WebSocket:Socket, CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
 AbortController, fetch:()=>new Promise(()=>{}),
 setTimeout(fn,ms){timers.set(++seq,{fn,ms});return seq;},clearTimeout(id){timers.delete(id);},setInterval(fn){intervals.push(fn);return intervals.length;},clearInterval(){}
};
vm.runInNewContext(fs.readFileSync(source,'utf8'),context);
function send(symbol,price,ts){socket.onmessage({data:JSON.stringify({data:[{instId:symbol,lastPr:String(price),open24h:'100',change24h:'0.01',ts:String(ts)}]})});}
function paint(){for(const [id,t] of [...timers])if(t.ms===400){timers.delete(id);t.fn();}}
send('BTCUSDT',101,now);send('ETHUSDT',102,now);paint();
assert.equal(mount.dataset.cryptoState,'ready');
now+=120000;
send('BTCUSDT',103,now);paint();
const quotes=events.at(-1).detail.quotes;
const eth=quotes.find(q=>q.id==='ETH-USDT');
const summary={source,btcAgeSeconds:0,ethAgeSeconds:(now-eth.ts)/1000,mountState:mount.dataset.cryptoState,status:status.textContent,staleMarker:host.innerHTML.includes('报价已过期')};
console.log(JSON.stringify(summary,null,2));
{
 assert.equal(mount.dataset.cryptoState,'partial-stale');
 assert.match(host.innerHTML,/data-quote-state="stale"/);
 assert.match(host.innerHTML,/报价已过期/);
 assert.match(status.textContent,/1 个交易对报价已过期/);
 now+=10000;send('ETHUSDT',104,now);paint();
 assert.equal(mount.dataset.cryptoState,'ready');
 assert.ok(!host.innerHTML.includes('报价已过期'));
 now+=100000;send('BTCUSDT',105,now+100000);for(const tick of intervals)tick();paint();
 assert.equal(events.at(-1).detail.quotes.find(q=>q.id==='BTC-USDT').price,103);
 assert.equal(mount.dataset.cryptoState,'stale');
 assert.match(status.textContent,/行情暂未更新/);
 assert.equal((host.innerHTML.match(/data-quote-state="stale"/g)||[]).length,2);
 console.log('PASS: per-pair stale warning, recovery, and future timestamp rejection');
}
