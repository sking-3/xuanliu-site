'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('../screening/entry-opportunities-controller.js'),patterns=require('../screening/trend-patterns.js');
const clone=value=>JSON.parse(JSON.stringify(value)),settle=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
const current=()=>({generation:'2026-11-23-123',sourceId:'tickflow-free-forward-v1',day:'2026-11-23',asOf:'2026-11-23T07:00:00Z'});
function stats(){return {sampleCount:80,meanReturnPercent:1.2,medianReturnPercent:.8,worstDrawdownPercent:9};}
function payload(){
 const c=current(),entry=(code,extra={})=>({code,name:'研究股票',setupId:code+':2026-11-20',formationDay:'2026-11-20',keyBarDay:'2026-11-23',trigger:{above:10.28},invalidation:{below:9.86},status:'waiting_trigger',replayStatus:'waiting_trigger',knownAt:'2026-11-23T08:01:00Z',patternIds:['regain-ma-20'],eligiblePatternIds:['regain-ma-20'],fresh:true,qualified:true,entryGatePassed:true,patternGatePassed:true,reasons:[],monitoring:{status:'future_condition_watch',nextSessionDay:'2026-11-24',watchUntil:'2026-11-24T15:00:00+08:00',remainingSessions:3},evidenceUrl:'/api/a-share-daily/entries?generation='+c.generation+'&code='+code,chartUrl:'/api/a-share-daily/entry-chart?generation='+c.generation+'&code='+code+'&setup=0',...extra});
 return {schema:'books.a-share.entry-validation.v1',version:'books.entry-validation.2026-11-24.v1',entryPolicyVersion:'books.entry-bars.2026-11-24.v1',...c,computedAt:'2026-11-23T08:20:00Z',benchmark:{code:'000300.SH'},policy:{horizon:15,targetReturnPercent:5},summary:{patternCount:16,qualifiedCount:1,candidateCount:2,reason:'没有同时通过两类门槛且仍有效的机会'},patterns:patterns.definitions.map(p=>({...p,status:p.id==='regain-ma-20'?'effective':'inactive',recommended:p.id==='regain-ma-20',reasons:p.id==='regain-ma-20'?[]:['未过门槛'],fit:stats(),recent:stats(),validation:stats(),diagnostics:[{label:'独立锚点',actual:3,operator:'>=',threshold:8,unit:'个',passed:false}]})),current:[entry('600000.SH'),entry('000001.SZ',{qualified:false,entryGatePassed:false,eligiblePatternIds:[],reasons:['独立入场验证未通过']})],method:{returnLabel:'触发后15交易日净变化',drawdownLabel:'触发起收盘路径回撤',costLabel:'统一费用0.30个百分点'}};
}
class Target{constructor(){this.events=new Map();}addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}removeEventListener(type,fn){this.events.get(type)?.delete(fn);}dispatchEvent(event){for(const fn of this.events.get(event.type)||[])fn(event);}}
class Element extends Target{
 constructor(tag='div'){super();this.tagName=tag;this.children=[];this.parentNode=null;this.dataset={};this.attrs={};this.own='';this.value='';this.hidden=false;this.disabled=false;}
 get textContent(){return this.own+this.children.map(c=>c.textContent).join('');}set textContent(value){this.replaceChildren();this.own=String(value);}
 append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}replaceChildren(...nodes){this.children=[];this.own='';this.append(...nodes);}setAttribute(name,value){this.attrs[name]=String(value);}
 closest(selector){return selector==='[data-entry-opportunity]'&&this.dataset.entryOpportunity!==undefined?this:this.parentNode?.closest(selector)||null;}
}
function fixture(){
 const env=new Target(),ids=new Map(),calls=[],timeouts=new Map(),intervals=new Map();let seq=0,view=current(),data=payload(),response=null,clock=Date.parse('2026-11-23T08:30:00Z');
 for(const id of ['','scope','retry','status','source','selection','list','method','records'])ids.set('entry-opportunities'+(id?'-'+id:''),new Element());
 env.setTimeout=fn=>{const id=++seq;timeouts.set(id,fn);return id;};env.clearTimeout=id=>timeouts.delete(id);env.setInterval=fn=>{const id=++seq;intervals.set(id,fn);return id;};env.clearInterval=id=>intervals.delete(id);
 env.fetch=async(path,init)=>{calls.push({path,init});return response?response(path,init):{ok:true,json:async()=>clone(data)};};
 const app={getState:()=>view},doc={defaultView:env,hidden:false,getElementById:id=>ids.get(id),createElement:tag=>new Element(tag)},component=ui.mount(doc,{app,autoLoad:false,now:()=>clock});
 return {env,doc,app,component,calls,timeouts,intervals,el:id=>ids.get('entry-opportunities'+(id?'-'+id:'')),setCurrent:v=>view=v,setPayload:v=>data=v,setResponse:fn=>response=fn,setNow:v=>clock=Date.parse(v),scope:value=>{ids.get('entry-opportunities-scope').value=value;ids.get('entry-opportunities-scope').dispatchEvent({type:'change'});},tick:async()=>{for(const fn of intervals.values())fn();await settle();}};
}
function find(root,fn){if(fn(root))return root;for(const child of root.children){const node=find(child,fn);if(node)return node;}return null;}

test('new current panel preserves the shared UI and original filters',()=>{
 const html=fs.readFileSync(require.resolve('../screening/index.html'),'utf8');assert.equal([...html.matchAll(/id="entry-opportunities"/g)].length,1);assert.equal([...html.matchAll(/src="entry-opportunities-controller.js\?/g)].length,1);assert.match(html,/href="\.\.\/academy\/index.html">交易员研习/);assert.match(html,/id="trend-pattern"/);assert.match(html,/id="trend-scheme-review"/);assert.match(html,/id="entry-opportunities-scope"/);
 const css=fs.readFileSync(require.resolve('../screening/entry-opportunities.css'),'utf8');assert.match(css,/font-variant-numeric:tabular-nums/);assert.match(css,/@media\(max-width:700px\)/);
});
test('current reads one exact published generation and keeps independent 15-day statistics separate',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());assert.equal(f.calls.length,0);await f.component.refresh();assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/api/a-share-daily/entry-validation?generation=2026-11-23-123');assert.equal(f.calls[0].init.redirect,'error');assert.equal(f.calls[0].init.credentials,'same-origin');assert.equal(f.calls[0].init.cache,'no-store');assert.equal(f.el('list').children.length,1);assert.match(f.el('list').textContent,/已通过原形态与独立入场验证.*盘中是否触发未核实/);assert.match(f.el('status').textContent,/合格条件观察 1 个.*研究候选 1 个/);assert.match(f.el('records').textContent,/成熟触发样本80.*平均净变化\+1.2%.*中位净变化\+0.8%.*最差路径回撤9%.*独立锚点 3个 \/ >= 8个/);assert.match(f.el('method').textContent,/与原固定形态次日开盘收益分开.*触发后15交易日/);assert.equal(f.timeouts.size,0);
});
test('research candidates never become qualified and expiration removes current opportunities without new quotes',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());await f.component.refresh();f.scope('research');assert.equal(f.el('list').children.length,1);assert.match(f.el('selection').textContent,/不等于合格入场机会/);assert.match(f.el('list').textContent,/独立入场验证未通过/);f.setNow('2026-11-24T07:01:00Z');f.scope('qualified');assert.match(f.el('list').textContent,/没有同时通过两类门槛/);assert.equal(f.component.getState().data.current[0].qualified,true);assert.match(f.el('status').textContent,/合格条件观察 0 个/);f.scope('research');assert.match(f.el('list').textContent,/需新收盘日线.*当前不可作为新入场机会/);assert.equal(f.calls.length,1);
});
test('mismatched generations, invalid qualifications and external chart links fail closed',()=>{
 for(const change of [{generation:'old'},{asOf:'2026-11-23T06:00:00Z'},{sourceId:'other'},{version:'other'},{entryPolicyVersion:'other'},{computedAt:'bad'},{patterns:[]},{policy:{horizon:14,targetReturnPercent:5}}])assert.throws(()=>ui.validate({...payload(),...change},current()));
 for(const change of [{qualified:true,entryGatePassed:false},{qualified:true,fresh:false},{formationDay:'2026-11-24'},{knownAt:'2026-11-23T09:00:00Z'},{eligiblePatternIds:['trend-down']},{chartUrl:'https://other.invalid/chart.svg'},{evidenceUrl:'/api/a-share-daily/entries?generation=old&code=600000.SH'},{monitoring:{status:'requires_fresh_data'}}]){const value=payload();Object.assign(value.current[0],change);assert.throws(()=>ui.validate(value,current()));}
 const duplicate=payload();duplicate.current[1]=clone(duplicate.current[0]);assert.throws(()=>ui.validate(duplicate,current()));
 const late=payload();late.computedAt='2026-11-24T02:00:00Z';assert.throws(()=>ui.validate(late,current()),/未来观察窗口/);
});
test('a failed refresh retains the prior independent statistics and a dated error',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());await f.component.refresh();const before=f.component.getState().data;f.setResponse(async()=>({ok:false,status:503}));await f.component.refresh();assert.equal(f.component.getState().data,before);assert.match(f.el('status').textContent,/503.*保留上次结果/);assert.equal(f.el('retry').hidden,false);assert.match(f.el('source').textContent,/来源时间.*计算.*页面读取/);assert.equal(f.timeouts.size,0);
});
test('a new generation aborts an old response and never shows its current opportunities',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());let release;f.setResponse(()=>new Promise(resolve=>release=resolve));const old=f.component.refresh();await settle();const next=payload();next.generation='2026-11-23-456';for(const item of next.current){item.evidenceUrl=item.evidenceUrl.replace('-123','-456');item.chartUrl=item.chartUrl.replace('-123','-456');}f.setCurrent({...current(),generation:next.generation});f.setResponse(async()=>({ok:true,json:async()=>next}));await f.component.refresh();release({ok:true,json:async()=>payload()});await old;assert.equal(f.component.getState().data.generation,next.generation);assert.equal(f.calls[0].init.signal.aborted,true);assert.equal(f.timeouts.size,0);
});
test('evidence is click-only, matches the setup and loads only same-generation derived charts',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());await f.component.refresh();const item=payload().current[0],details={schema:'books.a-share.entry-evidence.v1',...current(),stock:{code:item.code},items:[{id:item.setupId,formationDay:item.formationDay,keyBarDay:item.keyBarDay,reason:'严格确认条件已满足',chartUrl:item.chartUrl}]};f.setResponse(async()=>({ok:true,json:async()=>details}));const button=find(f.el('list'),e=>e.dataset.entryOpportunity===item.setupId);f.el('list').dispatchEvent({type:'click',target:button});await settle();assert.equal(f.calls.length,2);assert.equal(f.calls[1].path,item.evidenceUrl);assert.match(f.el('list').textContent,/F 形成 2026-11-20.*C 收盘确认 2026-11-23/);assert.equal(find(f.el('list'),e=>e.tagName==='img').src,item.chartUrl);const close=find(f.el('list'),e=>e.dataset.entryOpportunity===item.setupId);f.el('list').dispatchEvent({type:'click',target:close});assert.equal(find(f.el('list'),e=>e.tagName==='img'),null);assert.equal(f.timeouts.size,0);
});
test('detail failures remain visible and malformed chart evidence is never used',async t=>{
 const f=fixture();t.after(()=>f.component.destroy());await f.component.refresh();f.setResponse(async()=>({ok:true,json:async()=>({schema:'books.a-share.entry-evidence.v1',...current(),stock:{code:'600000.SH'},items:[{chartUrl:'https://untrusted.invalid/chart.svg'}]})}));f.el('list').dispatchEvent({type:'click',target:find(f.el('list'),e=>e.dataset.entryOpportunity)});await settle();assert.match(f.el('list').textContent,/批次或股票不一致/);assert.equal(find(f.el('list'),e=>e.tagName==='img'),null);
});
test('diagnostics preserve zero and unknown values rather than converting them to success',()=>{
 assert.equal(ui.diagnosticText([{label:'校正p',actual:null,operator:'<=',threshold:.05,unit:'',passed:false},{label:'计算状态',actual:'insufficient',operator:'=',threshold:'ready',unit:'',passed:false},{label:'样本',actual:0,operator:'>=',threshold:60,unit:'个',passed:false}]),'校正p 未取得 / <= 0.05；计算状态 insufficient / = ready；样本 0个 / >= 60个');
});

test('the actual private precompute projection satisfies the current UI contract for F, C and stale windows',async t=>{
 const {precomputeEntryEvidence}=await import('../server/a-share-entry-precompute.mjs'),{mkdtemp,mkdir,writeFile,readFile,rm}=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const dir=await mkdtemp(path.join(os.tmpdir(),'books-current-ui-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));const c=current(),target=path.join(dir,'public'),privateTarget=path.join(dir,'private'),historyFile=path.join(dir,'history.ndjson');await mkdir(target);await mkdir(privateTarget);
 const bars=Array.from({length:80},(_,i)=>({date:new Date(Date.parse(c.day+'T00:00:00Z')-(79-i)*86400000).toISOString().slice(0,10),open:10,high:10.2,low:9.8,close:10,volume:1000}));
 for(let i=75;i<80;i++){const close=10+(i-74)*.05;Object.assign(bars[i],{open:close-.04,high:close+.01,low:close-.06,close,volume:i===79?1100:1000});}
 const stock={code:'600000.SH',name:'契约研究样本'},header={schema:'books.a-share.history.v1',...c,total:1,reference:{bars}},source={sourceId:c.sourceId,day:c.day,status:'ready',bars,adjustment:'qfq',fetchedAt:'2026-11-23T09:00:00Z'};await writeFile(historyFile,[header,{stock,source}].map(v=>JSON.stringify(v)).join('\n')+'\n');
 for(const formation of [78,79]){
  const controlled={...patterns,classify:input=>({status:'ready',labels:input.day===bars[formation].date?[{id:'regain-ma-20'}]:[]})},opts={historyFile,target,privateTarget,...c,patterns:controlled,engine:require('../screening/trend-screen.js'),riskName:require('../screening/market-pool.js').riskName,policyKnownAt:'2026-11-23T08:00:00Z',nextSessionDay:'2026-11-24',effectivePatternIds:['regain-ma-20']};
  await precomputeEntryEvidence({...opts,now:()=>Date.parse('2026-11-23T12:00:00Z')});const early=JSON.parse(await readFile(path.join(target,'entry-validation.json')));assert.equal(ui.validate(early,c),early);assert.equal(early.current.length,1);assert.equal(ui.currentPool(early,'qualified',Date.parse('2026-11-23T12:10:00Z')).length,0);assert.equal(ui.currentPool(early,'research',Date.parse('2026-11-23T12:10:00Z')).length,1);
  await precomputeEntryEvidence({...opts,now:()=>Date.parse('2026-11-24T04:00:00Z')});const late=JSON.parse(await readFile(path.join(target,'entry-validation.json')));assert.equal(ui.validate(late,c),late);assert.equal(late.current[0].fresh,false);
 }
});
