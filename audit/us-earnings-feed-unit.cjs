'use strict';
// Synthetic RSS and an isolated browser model. No network or real-market requests.
const {test}=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto'),{readFileSync}=require('node:fs'),vm=require('node:vm'),api=require('../us-earnings-feed.js');
const FEED='https://nvidianews.nvidia.com/cats/press_release.xml',LINK='https://nvidianews.nvidia.com/news/synthetic-financial-results',NOW=Date.parse('2026-11-14T12:00:00Z'),PUB='Wed, 28 Oct 2026 21:00:00 GMT';
const item=({title='NVIDIA Sets Conference Call for Third-Quarter Financial Results',link=LINK,pubDate=PUB,extra=''}={})=>'<item><title>'+title+'</title><link>'+link+'</link><pubDate>'+pubDate+'</pubDate>'+extra+'</item>';
const rss=value=>'<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Synthetic source</title>'+value+'</channel></rss>';
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.events={};this.disabled=false;this.value='';}
 set textContent(value){this.value=String(value);this.children=[];}get textContent(){return this.value+this.children.map(child=>child.textContent).join('');}
 append(...values){this.children.push(...values);}replaceChildren(...values){this.value='';this.children=values;}addEventListener(type,fn){this.events[type]=fn;}
}
function setup({hidden=false,fetcher,storage=new Map(),autoMount=true}={}){
 const nodes=Object.fromEntries(['us-issuer-refresh','us-issuer-status','us-issuer-body'].map(id=>[id,new Element(id)])),timers=new Map(),events={},calls=[];let sequence=0,now=NOW;
 const doc={hidden,events:{},getElementById:id=>nodes[id]||null,createElement:tag=>new Element(tag),addEventListener(type,fn){this.events[type]=fn;}};
 const env={document:doc,crypto:webcrypto,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))},setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),addEventListener(type,fn){events[type]=fn;},fetch:async(url,init)=>{calls.push({url,init});return fetcher?fetcher(url,init,calls.length):new Response(rss(item()));}};
 const result=autoMount?api.mount(env,{clock:()=>now}):null;
 return {env,doc,nodes,timers,events,calls,storage,result,setNow:value=>{now=value;},async fireTimer(ms){const found=[...timers].find(([,value])=>value.ms===ms);assert.ok(found,'expected timer '+ms);timers.delete(found[0]);return found[1].fn();},async click(){return nodes['us-issuer-refresh'].events.click();},hide(){doc.hidden=true;doc.events.visibilitychange();},show(){doc.hidden=false;doc.events.visibilitychange();}};
}
test('public parser distinguishes schedules and title-only result reports without U1 claims',()=>{
 const records=api.parse(rss(item()+item({title:'NVIDIA Announces Conference Call for Financial Results',link:LINK+'-call'})+item({title:'NVIDIA Reports Financial Results',link:LINK+'-reports'})+item({title:'NVIDIA Announces Synthetic Product',link:LINK+'-product',extra:'<content:encoded><![CDATA[PRIVATE_BODY reports financial results]]></content:encoded>'})),NOW);
 assert.deepEqual(records.map(record=>record.kind),['earnings_schedule','earnings_schedule','earnings_headline']);for(const record of records){assert.equal(record.provider,'issuer');assert.equal(record.scope,'NVDA_only');assert.equal(record.actualEarningsVerified,false);assert.equal(record.eligibleForU1,false);assert.equal(record.evidenceScope,'rss_title_only');}assert.doesNotMatch(JSON.stringify(records),/PRIVATE_BODY|content:encoded/);
});
test('browser UMD bootstrap mounts only a present panel and respects initial hidden state',()=>{
 assert.equal(api.mount({document:{getElementById:()=>null}}),null);const h=setup({hidden:true,autoMount:false});vm.runInNewContext(readFileSync(require.resolve('../us-earnings-feed.js'),'utf8'),h.env);assert.equal(typeof h.env.BooksUsIssuerFeed.parse,'function');assert.match(h.nodes['us-issuer-status'].textContent,/页面当前隐藏/);assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
});
test('official RSS-format dates, CDATA titles and source publication text are preserved',()=>{
 const records=api.parse(rss(item({title:'<![CDATA[NVIDIA Reports Financial Results & Outlook]]>'})),NOW);assert.equal(records[0].title,'NVIDIA Reports Financial Results & Outlook');assert.equal(records[0].pubDate,PUB);assert.equal(records[0].publishedAt,'2026-10-28T21:00:00.000Z');assert.equal(records[0].sourceUrl,LINK);
 for(const pubDate of ['not a date','Wed, 31 Feb 2026 21:00:00 GMT','Thu, 28 Oct 2026 21:00:00 GMT','Sun, 15 Nov 2026 12:00:00 GMT'])assert.throws(()=>api.parse(rss(item({pubDate})),NOW),/schema/);
 assert.equal(api.parse(rss(item({title:'NVIDIA  Reports Financial Results'})),NOW)[0].title,'NVIDIA  Reports Financial Results');
});
test('DTD, entity resolution, invalid links and oversized or malformed XML are rejected',()=>{
 for(const xml of ['<!DOCTYPE rss SYSTEM "https://other.invalid">'+rss(item()),'<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private">]>'+rss(item({title:'&x; Financial Results'})),rss(item({title:'&unknown; Financial Results'})),rss(item({title:'x'.repeat(251)})),rss(item({extra:'<title>duplicate</title>'})),rss(Array.from({length:101},(_,i)=>item({link:LINK+'-'+i})).join('')),rss(item()).replace('</rss>','')])assert.throws(()=>api.parse(xml,NOW),/schema/);
 for(const link of ['http://nvidianews.nvidia.com/news/results','https://other.invalid/news/results','https://nvidianews.nvidia.com.evil.invalid/news/results','https://user:secret@nvidianews.nvidia.com/news/results','https://nvidianews.nvidia.com:8443/news/results','https://nvidianews.nvidia.com/blog/results','https://nvidianews.nvidia.com/news/results?key=secret','https://nvidianews.nvidia.com/news/%2e%2e/results'])assert.throws(()=>api.parse(rss(item({link})),NOW),/schema/);
 assert.throws(()=>api.parse(' '.repeat(1000001),NOW),/too_large/);
});
test('visible startup makes one fixed credential-free GET and renders attributed source facts',async()=>{
 const h=setup();await h.result.ready;assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,FEED);assert.equal(h.calls[0].init.method,'GET');assert.equal(h.calls[0].init.credentials,'omit');assert.equal(h.calls[0].init.redirect,'error');assert.equal(h.calls[0].init.cache,'no-store');assert.equal(h.calls[0].init.headers.Authorization,undefined);
 const row=h.nodes['us-issuer-body'].children[0];assert.equal(row.children.length,5);assert.match(row.children[0].textContent,/NVDA.*NVIDIA/);assert.match(row.children[1].textContent,/预告.*非实际/);assert.equal(row.children[2].children[0].textContent,'NVIDIA Sets Conference Call for Third-Quarter Financial Results');assert.equal(row.children[2].children[0].href,LINK);assert.equal(row.children[3].textContent,PUB);assert.equal(row.children[4].textContent,new Date(NOW).toISOString());assert.match(h.nodes['us-issuer-status'].textContent,/仅 NVDA，非全市场/);assert.equal(h.nodes['us-issuer-status'].children[1].href,FEED);assert.deepEqual([...h.timers.values()].map(value=>value.ms),[300000]);
});
test('only hashes and actual observation times are stored, never RSS text or titles',async()=>{
 const h=setup();await h.result.ready;const raw=h.storage.get(api.META_KEY),meta=JSON.parse(raw);assert.match(meta.rssHash,/^[a-f0-9]{64}$/);assert.equal(meta.receivedAt,new Date(NOW).toISOString());assert.equal(Object.keys(meta.seen).length,1);assert.doesNotMatch(raw,/NVIDIA|Financial|content|<item>|https:/);assert.deepEqual(Object.keys(Object.values(meta.seen)[0]).sort(),['firstSeenAt','receivedAt','rssHash']);
});
test('failed metadata persistence does not invent a later firstSeen time within the same page',async()=>{
 const h=setup();h.env.localStorage.setItem=(key,value)=>{if(key===api.META_KEY)throw Error('synthetic quota');h.storage.set(key,value);};await h.result.ready;const first=h.nodes['us-issuer-body'].children[0].children[4].textContent;h.setNow(NOW+300000);await h.fireTimer(300000);assert.equal(h.nodes['us-issuer-body'].children[0].children[4].textContent,first);assert.match(h.nodes['us-issuer-status'].textContent,/未能保存/);assert.equal(h.storage.has(api.META_KEY),false);
});
test('visible success schedules one five-minute read and unchanged RSS does not create new discovery times',async()=>{
 const h=setup();await h.result.ready;const before=h.nodes['us-issuer-body'].children[0].children[4].textContent;h.setNow(NOW+300000);await h.fireTimer(300000);assert.equal(h.calls.length,2);assert.match(h.nodes['us-issuer-status'].textContent,/RSS 内容未变/);assert.equal(h.nodes['us-issuer-body'].children[0].children[4].textContent,before);assert.equal(h.nodes['us-issuer-body'].children[0].children[3].textContent,PUB);assert.equal(h.timers.size,1);
});
test('initial hidden pages make no request or timer, and showing the page does not auto-resume',async()=>{
 const h=setup({hidden:true});await h.result.ready;assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);h.show();assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);await h.click();assert.equal(h.calls.length,1);assert.equal(h.timers.size,1);
});
test('hiding or leaving cancels the foreground loop and requires an explicit refresh to resume',async()=>{
 const h=setup();await h.result.ready;h.hide();assert.equal(h.timers.size,0);h.show();assert.equal(h.calls.length,1);await h.click();assert.equal(h.calls.length,2);h.events.pagehide();assert.equal(h.timers.size,0);assert.match(h.nodes['us-issuer-status'].textContent,/手动刷新/);
});
test('late responses after hidden cancellation cannot mutate rows, metadata or the stopped status',async()=>{
 let resolve,signal;const h=setup({fetcher:async(url,init)=>{signal=init.signal;return new Promise(done=>{resolve=done;});}});h.hide();assert.equal(signal.aborted,true);assert.equal(h.timers.size,0);resolve(new Response(rss(item())));await h.result.ready;assert.equal(h.nodes['us-issuer-body'].children.length,0);assert.equal(h.storage.has(api.META_KEY),false);assert.match(h.nodes['us-issuer-status'].textContent,/页面已隐藏/);h.show();assert.equal(h.calls.length,1);
});
test('the twenty-second deadline aborts the request and never leaves an automatic retry',async()=>{
 let signal;const h=setup({fetcher:async(url,init)=>{signal=init.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('synthetic aborted'),{name:'AbortError'}))));}});await h.fireTimer(20000);await h.result.ready;assert.equal(signal.aborted,true);assert.equal(h.timers.size,0);assert.equal(h.calls.length,1);assert.match(h.nodes['us-issuer-status'].textContent,/超过 20 秒/);assert.equal(h.storage.has(api.META_KEY),false);
});
test('403 and 429 persistently hold the source across mounts without switching hosts or auto-restoring',async()=>{
 for(const code of [403,429]){const storage=new Map(),h=setup({storage,fetcher:async()=>new Response('',{status:code})});await h.result.ready;assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);assert.equal(JSON.parse(storage.get(api.STOP_KEY)).reason,'http_'+code);assert.equal(h.nodes['us-issuer-refresh'].disabled,true);await h.result.refresh();assert.equal(h.calls.length,1);const next=setup({storage});await next.result.ready;assert.equal(next.calls.length,0);assert.equal(next.timers.size,0);assert.match(next.nodes['us-issuer-status'].textContent,/不会重试、切换来源或自动恢复/);}
});
test('a new persistent stop from another page is checked before the next foreground attempt',async()=>{
 const h=setup();await h.result.ready;h.storage.set(api.STOP_KEY,JSON.stringify({reason:'http_429'}));await h.fireTimer(300000);assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);assert.equal(h.nodes['us-issuer-refresh'].disabled,true);
});
test('stream size, redirect and schema failures never invent a successful update',async()=>{
 for(const mode of ['size','redirect','schema']){let cancelled=false;const h=setup({fetcher:async(url,init,call)=>{if(call===1)return new Response(rss(item()));if(mode==='redirect')return new Response('',{status:302,headers:{Location:'https://other.invalid'}});if(mode==='schema')return new Response('<rss>broken');return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1000001));},cancel(){cancelled=true;}}));}});await h.result.ready;const before=h.storage.get(api.META_KEY),oldTitle=h.nodes['us-issuer-body'].textContent;h.setNow(NOW+300000);await h.result.refresh();assert.equal(h.storage.get(api.META_KEY),before);assert.equal(h.nodes['us-issuer-body'].textContent,oldTitle);assert.match(h.nodes['us-issuer-status'].textContent,/保留上次真实标题与时间/);assert.equal(h.timers.size,0);assert.equal(h.calls.length,2);if(mode==='size')assert.equal(cancelled,true);}
});
test('a valid empty financial subset is scoped honestly and does not seed example titles',async()=>{
 const h=setup({fetcher:async()=>new Response(rss(item({title:'NVIDIA Announces Synthetic Product'})))});await h.result.ready;assert.match(h.nodes['us-issuer-body'].textContent,/本次没有符合分类.*仅 NVDA/);assert.doesNotMatch(h.nodes['us-issuer-body'].textContent,/Sets Conference Call/);assert.match(h.nodes['us-issuer-status'].textContent,/0 条财报相关标题/);
});
