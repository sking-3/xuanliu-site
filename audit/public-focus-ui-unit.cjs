// Behavioral DOM model. All fake financial fixtures are local to this test.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const Focus=require('../trader/public-focus.js');
class Element {
  constructor(){this.children=[];this.attrs={};this.value='';this.options=[];this.textContent='';this.open=false;this.hidden=false;this.events={};this.dataset={};}
  append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;this.textContent='';}
  setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,f){this.events[k]=f;}querySelectorAll(){return [];}
  showModal(){this.open=true;}close(){this.open=false;}focus(){document.activeElement=this;}
}
const ids={},document={body:new Element(),getElementById:id=>ids[id]??=new Element(),createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]};
document.activeElement=document.body;
for(const [id,values]of Object.entries({period:['7D','30D','90D','180D','365D','ALL'],exchange:['all','Hyperliquid'],source:['all','public','local'],sort:['mixed','roi'],currency:['all','USDC']})){const el=document.getElementById(id);el.options=values.map(value=>({value}));el.value=values[0];}
ids.period.value='30D';document.getElementById('search');
let calls=0,failed=false,gate=null,clients=[];
let snapshot={schemaVersion:1,address:Focus.identity().accountId,scope:'default_perp_dex',fetchedAt:new Date().toISOString(),sourceTime:new Date(Date.now()-1000).toISOString(),accountValue:0,positions:[]};
const location={href:'https://example.test/trader/index.html'};
const context={document,location,URL,Date,Blob,AbortController,setTimeout,clearTimeout,BooksPublicFocus:Focus,
  BooksAccountLive:{create(options){const c={options,starts:[],stops:0,start(address){this.starts.push(address);},stop(){this.stops++;}};clients.push(c);return c;}},
  fetch:async url=>{assert.equal(url,'public-focus.json');calls++;if(gate)await gate;if(failed)throw Error('offline');return new Response(JSON.stringify(snapshot));}};
const raw=fs.readFileSync(path.join(__dirname,'../trader/plaza.js'),'utf8').split("for(const id of controls)$(id).addEventListener")[0];
vm.createContext(context);vm.runInContext(raw+'globalThis.api={state,publicFocus,isPublicFocus,focusStatus,renderPublicFocus,refreshPublicFocus,canReadLive,openFocusLive,stopLive,readURL,openLinkedAccount,mergeRows,render};})();',context);
const a=context.api,text=n=>[n.textContent,...n.children.map(text)].join(' ');let passed=0;
async function test(name,fn){await fn();passed++;console.log('ok public-focus-ui '+name);}
(async()=>{
await test('identity is visible before any snapshot and never acquires leaderboard membership',()=>{a.renderPublicFocus();a.mergeRows();a.render();assert.equal(a.state.rows.length,0);assert.equal(ids['total-count'].textContent,0);assert.match(text(ids['public-focus-card']),/特别关注账户/);assert.match(text(ids['public-focus-card']),new RegExp(Focus.identity().accountId));assert.match(text(ids['public-focus-card']),/尚无有效持仓快照/);assert.equal(calls,0);assert.equal(clients.length,0);});
await test('loading same-origin snapshot deduplicates callers without opening account streams',async()=>{let release;gate=new Promise(r=>release=r);const first=a.refreshPublicFocus(),second=a.refreshPublicFocus();assert.equal(first,second);assert.equal(calls,1);release();await first;gate=null;assert.match(text(ids['public-focus-card']),/最近快照为空仓/);assert.equal(clients.length,0);assert.equal(ids['public-focus-section'].hidden,false);});
await test('identical refresh preserves card nodes and focused controls',async()=>{const card=ids['public-focus-card'].children[0];await a.refreshPublicFocus();assert.equal(ids['public-focus-card'].children[0],card);});
await test('expired and failed data stay visible without claiming current holdings',async()=>{a.publicFocus.snapshot={...snapshot,fetchedAt:new Date(Date.now()-7200000).toISOString(),sourceTime:new Date(Date.now()-7201000).toISOString()};a.renderPublicFocus();assert.match(text(ids['public-focus-card']),/快照已过期.*当前仓位未知/);failed=true;const previous=a.publicFocus.snapshot;await a.refreshPublicFocus();assert.equal(a.publicFocus.snapshot,previous);assert.match(text(ids['public-focus-card']),/快照读取失败/);assert.equal(ids['public-focus-section'].hidden,false);failed=false;});
await test('older snapshots cannot renew the observation timestamp',async()=>{a.publicFocus.snapshot=snapshot;const previous=snapshot;snapshot={...snapshot,fetchedAt:new Date(Date.now()-10000).toISOString(),sourceTime:new Date(Date.now()-11000).toISOString()};await a.refreshPublicFocus();assert.equal(a.publicFocus.snapshot,previous);assert.equal(a.publicFocus.readFailed,true);snapshot=previous;});
await test('only the registered object can use the public-focus live exception',()=>{assert.equal(a.canReadLive(a.publicFocus.record),true);assert.equal(a.canReadLive({...a.publicFocus.record}),false);assert.equal(a.canReadLive({...a.publicFocus.record,accountId:'0x'+'1'.repeat(40)}),false);});
await test('mixed-case whitelisted deep link opens detail but not streams',()=>{location.href='https://example.test/trader/index.html?account=0x02665A064143936ba3b5e400147b6C92560F7B24';a.readURL();assert.equal(a.openLinkedAccount(),true);assert.equal(ids.detail.open,true);assert.equal(a.state.detail,a.publicFocus.record);assert.equal(clients.length,0);assert.match(text(ids['detail-body']),/独立于排行榜/);});
await test('arbitrary URL addresses cannot open a new tracked account',()=>{location.href='https://example.test/trader/index.html?account=0x'+'1'.repeat(40);a.readURL();assert.equal(a.openLinkedAccount(true),false);assert.equal(clients.length,0);});
await test('explicit live action starts the one registered address and stops cleanly',()=>{a.openFocusLive();assert.equal(clients.length,1);assert.deepEqual(clients[0].starts,[Focus.identity().accountId]);assert.equal(a.state.tab,'live');a.stopLive();assert.equal(clients[0].stops,1);assert.equal(a.state.liveClient,null);assert.equal(a.state.rows.length,0);});
console.log(`${passed} public-focus UI tests passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
