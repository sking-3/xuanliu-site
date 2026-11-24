const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sourcePath = process.argv[2] || path.join(__dirname, '..', 'books-shell.js');
const source = fs.readFileSync(sourcePath, 'utf8');
function test(mobileInitially, currentType = 'page', headStartup = false, withShortcuts = true) {
  const eventTarget = () => ({events:{}, addEventListener(k, fn){this.events[k]=fn;}});
  const document = Object.assign(eventTarget(), {activeElement:null,readyState:headStartup?'loading':'complete'});
  const rootClasses = new Set();
  document.documentElement={classList:{add:x=>rootClasses.add(x),remove:x=>rootClasses.delete(x)}};
  const element = (tagName='div') => Object.assign(eventTarget(), {
    tagName,attrs:{},children:[],ownText:'',className:'',
    setAttribute(k,v){this.attrs[k]=String(v)},getAttribute(k){return this.attrs[k]},
    hasAttribute(k){return k in this.attrs},focus(){document.activeElement=this},
    matches(){return document.keyboardFocus===this},getBoundingClientRect(){return {height:60}},contains(node){return node===this||this.children.some(child=>child.contains(node))},
    appendChild(child){
      if(child.parentElement){const siblings=child.parentElement.children;siblings.splice(siblings.indexOf(child),1);}
      child.parentElement=this;this.children.push(child);return child;
    },
    insertBefore(child,before){
      if(child.parentElement){const siblings=child.parentElement.children;siblings.splice(siblings.indexOf(child),1);}
      const index=this.children.indexOf(before);assert.notEqual(index,-1);
      child.parentElement=this;this.children.splice(index,0,child);return child;
    },
    closest(selector){let node=this;while(node){if(selector==='a'&&node.tagName==='a')return node;node=node.parentElement;}return null},
    replaceChildren(...children){this.children=children;this.ownText=''},
    get textContent(){return this.children.length?this.children.map(x=>x.textContent).join(''):this.ownText},
    set textContent(value){this.ownText=String(value);this.children=[]},
    querySelector(selector){return this.children.find(child=>selector==='.'+(child.attrs.class||child.className))||null},
  });
  // Object.assign evaluates getters: restore a real DOM-like text property.
  const makeElement = tag => {
    const node=element(tag);
    Object.defineProperty(node,'textContent',{get(){return this.children.length?this.children.map(x=>x.textContent).join(''):this.ownText},set(value){this.ownText=String(value);this.children=[]}});
    return node;
  };
  const names=['市场总览','A股选股','美股选股','带单员广场','公司研究','历史研究','交易员研习','研究工具'];
  const destinations=['index.html','screening/index.html','us.html','trader/index.html','research.html','screening/history.html','academy/index.html','tools.html'];
  const links=names.map((name,i)=>{const node=makeElement('a');node.textContent=name;node.attrs.href=destinations[i];return node});
  const link=links[3];link.attrs['aria-current']=currentType;
  const unknown=makeElement('a');unknown.textContent='现有额外入口';unknown.attrs.href='existing.html';
  const skip = makeElement('a');skip.attrs.href='#content';
  const target = makeElement('main');
  const nav = makeElement('nav');nav.contains=x=>links.includes(x);
  nav.querySelectorAll=selector=>selector==='a'?[...links,unknown]:[];
  nav.querySelector=selector=>selector==='[aria-current]'?link:links[0];
  let button,panel;
  const shortcuts=withShortcuts?makeElement('nav'):null;
  const shortcutLink=withShortcuts?makeElement('a'):null;
  if(shortcuts){shortcutLink.attrs.href='crypto.html';shortcutLink.textContent='加密行情';shortcuts.appendChild(shortcutLink);}
  const sidebar = makeElement('aside');
  sidebar.appendChild(nav);if(shortcuts)sidebar.appendChild(shortcuts);
  sidebar.querySelector=selector=>({'.books-nav':nav,'.books-menu-toggle':button,'.books-shortcuts':shortcuts,'.books-menu-panel':panel})[selector]||null;
  const sidebarInsertBefore=sidebar.insertBefore.bind(sidebar);
  sidebar.insertBefore=(node,before)=>{if(node.className==='books-menu-toggle')button=node;if(node.className==='books-menu-panel')panel=node;return sidebarInsertBefore(node,before);};
  sidebar.contains=x=>!!x&&(x===button||x===panel||x===shortcuts||x===shortcutLink||nav.contains(x));
  const classes=new Set(['books-shell']);
  const body={children:[],appendChild(node){this.children.push(node);return node},classList:{contains:x=>classes.has(x),add:x=>classes.add(x)}};
  document.body=headStartup?null:body;
  document.querySelector=()=>sidebar;
  document.createElement=tag=>makeElement(tag);
  document.createElementNS=(namespace,tag)=>{const node=makeElement(tag);node.namespaceURI=namespace;return node};
  const tickerElement=makeElement('section');
  document.querySelectorAll=()=>[skip];document.getElementById=id=>id==='index-ticker'?tickerElement:target;
  let sidebarTop=53, sidebarHeight=60;
  const geometryReads={style:0,height:0,rect:0};
  const readCount=()=>geometryReads.style+geometryReads.height+geometryReads.rect;
  Object.defineProperty(sidebar,'offsetHeight',{get(){geometryReads.height++;return sidebarHeight;}});
  sidebar.getBoundingClientRect=()=>{geometryReads.rect++;return {height:sidebarHeight};};
  const observers=[];
  class ResizeObserverMock {
    constructor(callback){this.callback=callback;this.targets=[];observers.push(this);}
    observe(node){this.targets.push(node);}
  }
  const media=Object.assign(eventTarget(),{matches:mobileInitially});
  const timers=new Map();let timerId=0;
  const window=Object.assign(eventTarget(),{matchMedia:()=>media,scrollY:0,innerWidth:mobileInitially?390:1440,
    setTimeout(fn,delay){timers.set(++timerId,{fn,delay});return timerId},clearTimeout(id){timers.delete(id)}});
  const fire=(delay)=>{const entry=[...timers].find(([,t])=>t.delay===delay);assert.ok(entry,'Expected timer '+delay);timers.delete(entry[0]);entry[1].fn();};

  const context={window,document,ResizeObserver:ResizeObserverMock,getComputedStyle(node){
    assert.equal(node,sidebar);geometryReads.style++;return {top:sidebarTop+'px'};
  }};
  vm.runInNewContext(source,context);
  if(headStartup){
    assert.equal(rootClasses.has('books-shell-preparing'),true);
    assert.equal(button,undefined);assert.equal(links[0].children.length,0);
    assert.equal(nav.hidden,undefined); // Source DOM still contains every link; preparing CSS alone conceals the mobile flash.
    document.body=body;document.readyState='interactive';document.events.DOMContentLoaded();
  }
  assert.equal(rootClasses.has('books-shell-preparing'),false);
  links.forEach((node,i)=>{
    assert.equal(node.attrs.href,destinations[i]);assert.equal(node.attrs['aria-label'],names[i]);
    assert.equal(node.attrs.title,names[i]);assert.equal(node.children.length,2);
    const [icon,label]=node.children;
    assert.equal(icon.tagName,'svg');assert.equal(icon.namespaceURI,'http://www.w3.org/2000/svg');
    assert.equal(icon.attrs.class,'books-nav-icon');assert.equal(icon.attrs['aria-hidden'],'true');assert.equal(icon.attrs.focusable,'false');
    assert.equal(icon.attrs.viewBox,'0 0 24 24');assert.equal(icon.children[0].tagName,'path');assert.ok(icon.children[0].attrs.d);
    assert.equal(label.className,'books-nav-label');assert.equal(label.textContent,i===3?'带单广场':names[i]);
    assert.ok(node.attrs['data-books-nav']);
  });
  assert.equal(link.attrs['aria-current'],currentType);assert.equal(unknown.textContent,'现有额外入口');assert.equal(unknown.attrs.href,'existing.html');
  assert.equal(nav.hidden,false);
  assert.equal(panel.hidden,mobileInitially);assert.equal(panel.inert,mobileInitially);
  assert.equal(panel.parentElement,sidebar);assert.equal(nav.parentElement,panel);
  assert.equal(panel.children[0],nav,'original navigation node is moved, not cloned');
  if(shortcuts){assert.equal(shortcuts.parentElement,panel);assert.equal(panel.children[1],shortcuts);assert.equal(shortcuts.children[0],shortcutLink);assert.equal(shortcutLink.attrs.href,'crypto.html');}
  else assert.equal(panel.children.length,1);
  assert.equal(button.attrs['aria-controls'],'books-menu-panel');
  button.events.click();assert.equal(panel.hidden,false);assert.equal(panel.inert,false);assert.equal(nav.hidden,false);assert.equal(button.attrs['aria-expanded'],'true');
  if(mobileInitially){let prevented=false;sidebar.events.keydown({key:'Escape',preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(panel.hidden,true);assert.equal(panel.inert,true);assert.equal(document.activeElement,button);}
  media.matches=false;media.events.change();assert.equal(panel.hidden,false);assert.equal(panel.inert,false);assert.equal(nav.hidden,false);
  link.focus();media.matches=true;media.events.change();assert.equal(panel.hidden,true);assert.equal(panel.inert,true);assert.equal(document.activeElement,button);
  media.matches=false;media.events.change();assert.equal(document.activeElement,link);
  if(shortcuts){
    shortcutLink.focus();media.matches=true;media.events.change();
    assert.equal(panel.hidden,true);assert.equal(panel.inert,true);assert.equal(document.activeElement,button,'shortcut focus returns to the toggle when the mobile panel closes');
    media.matches=false;media.events.change();assert.equal(document.activeElement,link);
  }
  skip.events.click();assert.equal(document.activeElement,target);assert.equal(target.attrs.tabindex,'-1');
  button.events.click();window.events.pageshow({persisted:false});assert.equal(button.attrs['aria-expanded'],'true');
  window.events.pageshow({persisted:true});assert.equal(button.attrs['aria-expanded'],'false');
  document.activeElement=target;window.innerWidth=1440;window.scrollY=480;media.matches=false;
  window.events.scroll();fire(2400);assert.equal(sidebar.attrs['data-nav-hidden'],'true');
  window.events.pointermove({clientY:70,pointerType:'mouse'});assert.equal(sidebar.attrs['data-nav-hidden'],'false');
  window.events.pointermove({clientY:400,pointerType:'mouse'});
  document.keyboardFocus=link;link.focus();sidebar.events.focusin();
  assert.equal([...timers.values()].some(t=>t.delay===2400),false);
  document.keyboardFocus=null;document.activeElement=target;sidebar.events.focusout();fire(0);fire(2400);
  assert.equal(sidebar.attrs['data-nav-hidden'],'true');
  window.scrollY=0;window.events.scroll();assert.equal(sidebar.attrs['data-nav-hidden'],'false');
  media.matches=true;window.innerWidth=390;window.scrollY=480;window.events.scroll();
  button.events.click();assert.equal([...timers.values()].some(t=>t.delay===2400),false);
  button.events.click();fire(2400);assert.equal(sidebar.attrs['data-nav-hidden'],'true');
  const recall=body.children.find(n=>n.className==='books-nav-recall');
  window.events.pointermove({clientY:70,pointerType:'mouse'});
  assert.equal(sidebar.attrs['data-nav-hidden'],'true');
  assert.equal(recall.hidden,false);recall.events.click();
  document.events.click({target:recall});
  assert.equal(button.attrs['aria-expanded'],'true');assert.equal(sidebar.attrs['data-nav-hidden'],'false');
  assert.equal(document.activeElement,button);
  if(shortcuts){document.events.click({target:shortcutLink});assert.equal(button.attrs['aria-expanded'],'true');}
  panel.events.click({target:link});assert.equal(button.attrs['aria-expanded'],'false');
  assert.equal(panel.hidden,true);assert.equal(panel.inert,true);assert.equal(nav.hidden,false);
  assert.equal(document.activeElement,button);
  if(shortcuts){
    for(const modifier of [{},{ctrlKey:true},{metaKey:true}]){
      button.events.click();shortcutLink.focus();
      panel.events.click({target:shortcutLink,...modifier});
      assert.equal(button.attrs['aria-expanded'],'false','shortcut selection dismisses for ordinary, Ctrl and Meta clicks');
      assert.equal(panel.hidden,true);assert.equal(panel.inert,true);assert.equal(document.activeElement,button);
      assert.equal(shortcutLink.attrs.href,'crypto.html');
    }
  }
  button.events.click();document.events.click({target});assert.equal(button.attrs['aria-expanded'],'false');
  assert.equal(panel.hidden,true);assert.equal(panel.inert,true);
  window.scrollY=0;window.events.scroll();
  // Scroll and pointer handlers must use the cached boundary, even while revealing.
  media.matches=false;window.innerWidth=1440;document.activeElement=target;
  window.scrollY=700;window.events.resize();
  const hotPathReads=readCount();
  for(let i=0;i<100;i++){window.scrollY=700+i;window.events.scroll();}
  for(let i=0;i<100;i++){window.scrollY=800-i;window.events.scroll();}
  for(let i=0;i<20;i++){window.events.pointermove({clientY:70,pointerType:'mouse'});window.events.pointermove({clientY:400,pointerType:'mouse'});}
  assert.equal(readCount(),hotPathReads,'scroll/pointer hot paths do not read geometry');
  assert.equal(geometryReads.rect,0,'transformed rectangles are never used as recall bounds');
  assert.equal(observers.length,1);assert.deepEqual(observers[0].targets,[sidebar,tickerElement]);

  // A viewport resize shrinks the recall zone from 125px to 72px.
  sidebarTop=20;sidebarHeight=40;window.events.resize();fire(2400);
  window.events.pointermove({clientY:100,pointerType:'mouse'});
  assert.equal(sidebar.attrs['data-nav-hidden'],'true');
  window.events.pointermove({clientY:70,pointerType:'mouse'});
  assert.equal(sidebar.attrs['data-nav-hidden'],'false');

  // Navigation content resizing expands the zone without another window resize.
  window.events.pointermove({clientY:400,pointerType:'mouse'});fire(2400);
  sidebarTop=75;sidebarHeight=96;observers[0].callback([{target:sidebar}]);
  window.events.pointermove({clientY:150,pointerType:'mouse'});
  assert.equal(sidebar.attrs['data-nav-hidden'],'false');

  // The ticker can move a fixed-height header: observe its size as well.
  window.events.pointermove({clientY:400,pointerType:'mouse'});fire(2400);
  sidebarTop=110;observers[0].callback([{target:tickerElement}]);
  window.events.pointermove({clientY:200,pointerType:'mouse'});
  assert.equal(sidebar.attrs['data-nav-hidden'],'false');
  const finalReads=readCount();
  window.events.pointermove({clientY:400,pointerType:'mouse'});window.scrollY=0;window.events.scroll();
  assert.equal(readCount(),finalReads);
  const originalIcon=links[0].children[0],originalPanel=panel;vm.runInNewContext(source,context);
  assert.equal(panel,originalPanel);assert.equal(nav.parentElement,panel);
  assert.equal(observers.length,1,'duplicate initialization does not attach observers');
  assert.equal(sidebar.querySelector('.books-menu-toggle'),button);assert.equal(links[0].children[0],originalIcon);
}
test(true);test(false);test(true,'location');test(false,'location');
test(true,'page',true);test(false,'location',true);
test(true,'page',false,false);test(false,'page',false,false);
// Fallback paths must release the temporary CSS guard even if a page has no shell or initialization fails.
for(const fails of [false,true]){
  const classes=new Set(),events={};
  const document={readyState:'loading',body:null,documentElement:{classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}},
    addEventListener(name,fn){events[name]=fn},querySelector(){return null}};
  vm.runInNewContext(source,{window:{},document});assert.equal(classes.has('books-shell-preparing'),true);
  if(fails)document.body={classList:{contains(){throw new Error('synthetic shell initialization failure')}}};
  if(fails)assert.throws(()=>events.DOMContentLoaded(),/synthetic shell initialization failure/);else events.DOMContentLoaded();
  assert.equal(classes.has('books-shell-preparing'),false);
}
const css=fs.readFileSync(path.join(path.dirname(sourcePath),'books-ui.css'),'utf8');
const ticker=fs.readFileSync(path.join(path.dirname(sourcePath),'index-ticker.css'),'utf8');
assert.match(css,/\.books-menu-panel\{display:contents\}/);
assert.match(css,/--books-side:92px/);assert.match(css,/padding:0 0 0 var\(--books-side\)/);
assert.match(css,/\.books-nav a\{position:relative;flex-direction:column/);
assert.match(css,/\.books-nav-icon\{display:block;width:21px;height:21px/);
assert.match(css,/\.books-nav a\{width:100%;min-height:44px;[^}]*flex-direction:row/);
assert.match(css,/\.books-nav\[hidden\]\{display:none\}/);
assert.match(css,/@media\(max-width:760px\)\{\s*\.books-shell \.books-sidebar\{[^}]*min-height:82px/);
assert.match(css,/\.books-shell-preparing \.books-shell-enhanced \.books-nav\{display:none\}/);
assert.match(css,/\.books-shell \.books-nav\{grid-column:1\/-1;display:grid/); // No-JavaScript fallback stays visible.
assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{[^}]*transition:none!important/);
assert.match(ticker,/\.books-shell>\.index-ticker\{[^}]*inset:0 0 auto;[^}]*width:100%/);
assert.match(ticker,/\.books-sidebar\{top:var\(--books-ticker-height\);height:calc\(100dvh - var\(--books-ticker-height\)\)/);
console.log('PASS: head execution without body, DOMContentLoaded enhancement, preparing cleanup on success/early return/failure, stable mobile header and no-JavaScript navigation; 8 accessible local SVG icons, preserved destinations/current page, unknown-link fallback, mobile/desktop disclosure, Escape focus, viewport focus recovery, skip focus, ordinary pageshow preserves opened menu and BFCache pageshow resets, duplicate initialization.');

console.log('PASS: delayed navigation hide, pointer recall, keyboard pin, mobile menu pin and touch recall.');

console.log('PASS: scroll/pointer handlers perform zero geometry reads; viewport resize, navigation ResizeObserver and ticker ResizeObserver refresh recall bounds; duplicate initialization retains one observer; reduced motion overrides later component transitions.');

console.log('PASS: original navigation and optional shortcut nodes move into one panel without cloning; closed mobile panel is hidden/inert, desktop panel stays available; shortcut focus recovers on desktop-to-mobile changes; ordinary/Ctrl/Meta shortcut selection and outside click dismiss with focus recovery.');
