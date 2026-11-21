'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const model=require('../control/model.js');
const html=fs.readFileSync(require.resolve('../control/index.html'),'utf8');
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.events={};this.dataset={};this.files=[];this._value='';this._text='';this.disabled=false;this.hidden=false;this.checked=false;}
 get value(){return this._value;}set value(value){this._value=String(value);}
 get valueAsNumber(){return this.value.trim()?Number(this.value):NaN;}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}set textContent(value){this._text=String(value??'');this.children=[];}
 addEventListener(type,fn){(this.events[type]??=[]).push(fn);}
 append(...nodes){this.children.push(...nodes);if(this.tagName==='SELECT'&&!this.value&&nodes[0])this.value=nodes[0].value;}
 replaceChildren(...nodes){this.children=[];this._text='';if(this.tagName==='SELECT')this.value='';this.append(...nodes);}
 querySelectorAll(){return [];}
 click(){if(!this.disabled)for(const fn of this.events.click||[])fn({type:'click'});}
}
async function fixture(configs=[{name:'已存50%',settings:{minimumBreadth:.5}}]){
 const elements=new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map(match=>[match[2],new Element(match[1])]));
 const formIds=[...html.slice(html.indexOf('<form id="config-form"'),html.indexOf('</form>')).matchAll(/id="([^"]+)"/g)].map(match=>match[1]);
 elements.get('config-form').querySelectorAll=()=>formIds.map(id=>elements.get(id)).filter(node=>['INPUT','SELECT','BUTTON'].includes(node.tagName));
 const versions=configs.map((config,i)=>({revision:i+1,config:model.normalizeConfig(config),createdAt:'2026-11-22T00:00:00Z'})).reverse();
 let state={currentRevision:versions.length,activeRevision:1,activeConfig:versions.at(-1).config,config:versions[0].config,versions,datasets:[],runs:[],job:null},nextTimer=0;
 const requests=[],downloads=[],blobs=new Map(),timers=new Map(),windowEvents={},documentEvents={};let parse;
 const context={TextEncoder,AbortController,Blob,
  document:{hidden:false,getElementById:id=>elements.get(id),createElement:tag=>{const node=new Element(tag);if(tag==='a')node.click=()=>downloads.push({name:node.download,blob:blobs.get(node.href)});return node;},addEventListener:(type,fn)=>{documentEvents[type]=fn;}},
  addEventListener:(type,fn)=>{windowEvents[type]=fn;},
  URL:{createObjectURL:blob=>{const id='blob:unit-'+blobs.size;blobs.set(id,blob);return id;},revokeObjectURL:id=>blobs.delete(id)},
  setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  fetch:async(path,init)=>{
   const body=init.body?JSON.parse(init.body):undefined;requests.push({path,method:init.method,body});let value;
   if(path==='/api/auth/me')value={authenticated:true,user:{role:'admin',displayName:'配置测试'}};
   else if(path==='/api/a-share-daily/state')value={configured:false,attempt:null,lastSuccess:null,available:false};
   else if(path==='/api/research-control/state')value=state;
   else if(path==='/api/research-control/config'){
    assert.equal(body.expectedRevision,state.currentRevision);const config=model.normalizeConfig(body.config),revision=state.currentRevision+1;
    state={...state,currentRevision:revision,config,versions:[{revision,config,createdAt:'2026-11-22T00:00:00Z'},...state.versions]};value={revision};
   }else throw Error('unexpected request '+path);
   return {ok:true,status:200,json:async()=>parse(JSON.stringify(value))};
  }
 };
 context.window=context;vm.createContext(context);parse=vm.runInContext('(text)=>JSON.parse(text)',context);
 vm.runInContext(fs.readFileSync(require.resolve('../control/model.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(require.resolve('../control/control.js'),'utf8'),context);await settle();
 assert.equal(elements.get('control-app').hidden,false);assert.match(elements.get('control-status').textContent,/已连接/);
 async function emit(id,type){for(const fn of elements.get(id).events[type]||[])fn({type,preventDefault(){}});await settle();}
 return {elements,requests,downloads,emit,get state(){return state;},async exported(){await emit('export-config','click');return JSON.parse(await downloads.at(-1).blob.text());}};
}
test('the actual console script loads50 percent, saves0.5 after a name edit and exports the persisted threshold',async()=>{
 const f=await fixture(),field=f.elements.get('cfg-minimum-breadth');assert.equal(field.value,'50');assert.match(f.elements.get('config-compare').textContent,/50%/);assert.match(f.elements.get('versions').textContent,/门槛 50%/);
 f.elements.get('cfg-name').value='只改名称';await f.emit('config-form','input');await f.emit('config-form','submit');
 const save=f.requests.find(request=>request.path.endsWith('/config'));assert.equal(save.body.config.settings.minimumBreadth,.5);assert.equal(f.state.config.settings.minimumBreadth,.5);assert.equal(field.value,'50');assert.equal((await f.exported()).settings.minimumBreadth,.5);
 assert(f.requests.every(request=>request.path.startsWith('/api/')));
});
test('loading an older version and importing/exporting configuration preserve its explicit minimum breadth',async()=>{
 const f=await fixture([{name:'历史25%',settings:{minimumBreadth:.25}},{name:'当前80%',settings:{minimumBreadth:.8}}]);assert.equal(f.elements.get('cfg-minimum-breadth').value,'80');
 const row=f.elements.get('versions').children.find(row=>row.children[0].textContent.startsWith('v1'));
 row.children[3].children.find(button=>button.textContent==='载入草稿').click();await settle();assert.equal(f.elements.get('cfg-minimum-breadth').value,'25');assert.equal((await f.exported()).settings.minimumBreadth,.25);
 const imported={name:'导入75%',settings:{minimumBreadth:.75}},text=JSON.stringify(imported),input=f.elements.get('import-config');input.files=[{size:text.length,text:async()=>text}];
 await f.emit('import-config','change');assert.equal(f.elements.get('cfg-minimum-breadth').value,'75');assert.equal((await f.exported()).settings.minimumBreadth,.75);assert.equal(f.requests.filter(request=>request.method==='POST').length,0);
 await f.emit('config-form','submit');const save=f.requests.find(request=>request.path.endsWith('/config'));assert.equal(save.body.expectedRevision,2);assert.equal(save.body.config.settings.minimumBreadth,.75);assert.equal(f.state.config.settings.minimumBreadth,.75);
});
test('legacy imports receive60 percent and invalid empty or out-of-range values never issue a save',async()=>{
 const f=await fixture(),text=JSON.stringify({name:'旧配置',settings:{lookback:60}});f.elements.get('import-config').files=[{size:text.length,text:async()=>text}];await f.emit('import-config','change');
 assert.equal(f.elements.get('cfg-minimum-breadth').value,'60');assert.equal((await f.exported()).settings.minimumBreadth,.6);
 for(const value of ['','-1','101']){f.elements.get('cfg-minimum-breadth').value=value;await f.emit('config-form','submit');assert.equal(f.requests.filter(request=>request.method==='POST').length,0);assert.equal(f.state.currentRevision,1);assert.equal(f.elements.get('control-status').dataset.error,'true');}
 for(const [value,ratio]of [['0',0],['100',1]]){f.elements.get('cfg-minimum-breadth').value=value;await f.emit('config-form','submit');assert.equal(f.state.config.settings.minimumBreadth,ratio);assert.equal((await f.exported()).settings.minimumBreadth,ratio);}
});
test('direction, early strength and pattern thresholds survive the actual console save and import paths',async()=>{
 const f=await fixture(),values={'cfg-direction':'sideways','cfg-direction-min':'2','cfg-direction-range':'6','cfg-cross-days':'3','cfg-min-return5':'0.5','cfg-pattern-near':'1.5','cfg-pattern-range':'3','cfg-pattern-cross':'10','cfg-pattern-pullback-min':'1','cfg-pattern-pullback-max':'6','cfg-pattern-expand':'1.5','cfg-pattern-contract':'0.6'};
 for(const [id,value]of Object.entries(values))f.elements.get(id).value=value;
 await f.emit('config-form','submit');const settings=f.state.config.settings;
 assert.equal(settings.direction,'sideways');assert.deepEqual(settings.directionRules,{minimumReturnPercent:2,maximumSidewaysRangePercent:6});assert.deepEqual(settings.strength,{crossWithinDays:3,minReturn5:.5});
 assert.deepEqual(settings.patterns,{nearPct:1.5,rangePct:3,crossWindow:10,pullbackMinPct:1,pullbackMaxPct:6,volumeExpandRatio:1.5,volumeContractRatio:.6});
 assert.deepEqual((await f.exported()).settings,settings);
 const imported={name:'重新导入条件',settings},text=JSON.stringify(imported);f.elements.get('import-config').files=[{size:text.length,text:async()=>text}];await f.emit('import-config','change');
 for(const [id,value]of Object.entries(values))assert.equal(f.elements.get(id).value,value,id);
 const posts=f.requests.filter(request=>request.method==='POST').length;
 f.elements.get('cfg-pattern-pullback-min').value='7';await f.emit('config-form','submit');assert.equal(f.requests.filter(request=>request.method==='POST').length,posts);
 f.elements.get('cfg-pattern-pullback-min').value='1';f.elements.get('cfg-cross-days').value='';await f.emit('config-form','submit');assert.equal(f.requests.filter(request=>request.method==='POST').length,posts);
});
