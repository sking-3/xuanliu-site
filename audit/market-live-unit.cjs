'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.attributes={};this.hidden=false;this.className='';this.dataset={};}
 append(...xs){this.children.push(...xs);}replaceChildren(...xs){this.children=xs;}get firstChild(){return this.children[0];}
 addEventListener(name,fn){this.events[name]=fn;}setAttribute(k,v){this.attributes[k]=v;}
 querySelector(q){const cls=q[0]==='.'?q.slice(1):null;for(const e of this.children){if(cls?e.className.split(' ').includes(cls):e.tag===q)return e;const nested=e.querySelector(q);if(nested)return nested;}return null;}
}
function setup(){
 const timers=new Map(),observers=[],events={};let sequence=0;
 const card=new Element();card.dataset.pulse='active';
 const parts=Object.fromEntries(['pulse-live','pulse-saved','pulse-host','pulse-state','pulse-market-name','pulse-pause'].map(k=>[k,Object.assign(new Element(),{className:k})]));
 const buttons=['live','saved'].map(view=>Object.assign(new Element('button'),{dataset:{view}}));
 card.append(...Object.values(parts),...buttons);card.querySelectorAll=()=>buttons;
 const document={hidden:false,querySelectorAll:()=>[card],createElement:t=>new Element(t),addEventListener:(k,v)=>events[k]=v};
 vm.runInNewContext(fs.readFileSync('market-live.js','utf8'),{document,URL,location:{href:'https://example.test/index.html'},setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(){this.active=true;}disconnect(){this.active=false;}}});
 const host=parts['pulse-host'];
 return {parts,card,document,timers,buttons,config:()=>JSON.parse(host.querySelector('script').textContent),ready(){const f=new Element('iframe');host.firstChild.append(f);for(const o of observers)if(o.active)o.fn();return f;},fire(ms){const items=[...timers].filter(([,t])=>t.ms===ms);for(const [id,t]of items){timers.delete(id);t.fn();}return items.length;},visibility(hidden){document.hidden=hidden;events.visibilitychange();}};
}
let passed=0;function test(name,fn){fn();passed++;console.log('ok '+name);}
test('rotates the provider symbol every three minutes after mounting, without a selector',()=>{const h=setup();assert.equal(h.config().symbol,'NASDAQ:AAPL');h.ready();for(const symbol of ['COINBASE:BTCUSD','SSE:000001','NASDAQ:AAPL']){assert.equal(h.fire(180000),1);assert.equal(h.config().symbol,symbol);h.ready();}assert.match(h.parts['pulse-market-name'].textContent,/美股/);});
test('pause preserves the live quote and resume starts a new rotation timer',()=>{const h=setup(),p=h.parts['pulse-pause'];h.ready();const first=h.parts['pulse-host'].firstChild;p.events.click();assert.equal(h.fire(180000),0);assert.equal(h.parts['pulse-host'].firstChild,first);assert.equal(p.attributes['aria-pressed'],'true');p.events.click();assert.equal(h.fire(180000),1);assert.equal(h.config().symbol,'COINBASE:BTCUSD');});
test('background tabs stop rotation and return without catching up missed symbols',()=>{const h=setup();h.ready();h.visibility(true);assert.equal(h.parts['pulse-host'].children.length,0);assert.equal(h.fire(180000),0);h.visibility(false);assert.equal(h.config().symbol,'NASDAQ:AAPL');h.ready();assert.equal(h.fire(180000),1);});
test('the saved snapshot view stops rotation and the live view resumes normally',()=>{const h=setup();h.ready();h.buttons[1].events.click();assert.equal(h.parts['pulse-live'].hidden,true);assert.equal(h.fire(180000),0);h.buttons[0].events.click();assert.equal(h.config().symbol,'NASDAQ:AAPL');h.ready();assert.equal(h.fire(180000),1);});
test('provider failure disables rotation and never retries automatically',()=>{const h=setup();h.parts['pulse-host'].querySelector('script').onerror();assert.equal(h.parts['pulse-live'].hidden,true);assert.equal(h.parts['pulse-pause'].disabled,true);assert.equal(h.fire(180000),0);h.visibility(true);h.visibility(false);assert.equal(h.parts['pulse-host'].children.length,0);assert.equal(h.buttons[0].disabled,true);});
test('a mount timeout cannot generate endless rotation requests',()=>{const h=setup();assert.equal(h.fire(15000),1);assert.equal(h.fire(180000),0);assert.equal(h.parts['pulse-host'].children.length,0);});
test('homepage has no manual market choice and public focus follows the research list',()=>{const home=fs.readFileSync('index.html','utf8'),plaza=fs.readFileSync('trader/index.html','utf8');assert.doesNotMatch(home,/class="pulse-market"|选择观察市场/);assert.match(home,/每 3 分钟自动切换/);assert.ok(plaza.indexOf('id="public-focus-section"')>plaza.indexOf('id="leaders"'));assert.ok(plaza.indexOf('id="public-focus-section"')<plaza.indexOf('<details class="method">'));});
console.log(`${passed} market rotation checks passed`);
