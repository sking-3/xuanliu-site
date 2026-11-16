// Tests full-page enhancement without network or a browser.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const handlers={};
const status={textContent:'1 个交易对报价已过期 · 请按各行时间核对'};
const priceName={textContent:'Ethereum',replaceWith(link){row.link=link;}};
const sourceCell={replaceChildren(time){this.time=time;}};
const row={dataset:{quoteState:'stale'},hidden:false,querySelector(s){return s==='div:first-child strong'?priceName:s==='div:first-child small'?{textContent:'ETH-USDT'}:s==='a'?this.link:sourceCell;}};
const mount={dataset:{cryptoState:'partial-stale'},querySelector(s){return status;},querySelectorAll(){return [row];}};
const input={value:'',addEventListener(){}};
const counter={textContent:''};
const document={body:{},activeElement:{},querySelector(s){return s==='#crypto-query'?input:s==='#crypto-filter-count'?counter:mount;},addEventListener(t,f){handlers[t]=f;},createElement(){return {textContent:'',dataset:{},setAttribute(){},append(n){this.textContent+=n.textContent;}};}};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../crypto-full.js'),'utf8'),{document,Date,Intl,Map,Math});
handlers['books:bitget-quotes']({detail:{quotes:[{id:'ETH-USDT',ts:1794852000000}]}});
assert.match(status.textContent,/1 个交易对报价已过期/);
assert.match(sourceCell.time.textContent,/报价已过期/);
assert.equal(sourceCell.time.dateTime,'2026-11-16T18:00:00.000Z');
assert.equal(row.link.href,'chart.html?tvwidgetsymbol=BITGET%3AETHUSDT');
console.log('PASS: crypto full-page enhancement retains per-pair warning, aggregate warning, source datetime and chart URL.');
