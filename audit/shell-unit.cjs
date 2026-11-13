const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sourcePath = process.argv[2] || path.join(__dirname, '..', 'books-shell.js');
const source = fs.readFileSync(sourcePath, 'utf8');
function test(mobileInitially, currentType = 'page', headStartup = false) {
  const eventTarget = () => ({events:{}, addEventListener(k, fn){this.events[k]=fn;}});
  const document = Object.assign(eventTarget(), {activeElement:null,readyState:headStartup?'loading':'complete'});
  const rootClasses = new Set();
  document.documentElement={classList:{add:x=>rootClasses.add(x),remove:x=>rootClasses.delete(x)}};
  const element = (tagName='div') => Object.assign(eventTarget(), {
    tagName,attrs:{},children:[],ownText:'',className:'',
    setAttribute(k,v){this.attrs[k]=String(v)},getAttribute(k){return this.attrs[k]},
    hasAttribute(k){return k in this.attrs},focus(){document.activeElement=this},
    appendChild(child){this.children.push(child);return child},
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
  const names=['市场总览','A股选股','美股选股','带单员广场','公司研究','历史研究','研究工具'];
  const destinations=['index.html','screening/index.html','us.html','trader/index.html','research.html','screening/history.html','tools.html'];
  const links=names.map((name,i)=>{const node=makeElement('a');node.textContent=name;node.attrs.href=destinations[i];return node});
  const link=links[3];link.attrs['aria-current']=currentType;
  const unknown=makeElement('a');unknown.textContent='现有额外入口';unknown.attrs.href='existing.html';
  const skip = makeElement('a');skip.attrs.href='#content';
  const target = makeElement('main');
  const nav = makeElement('nav');nav.contains=x=>links.includes(x);
  nav.querySelectorAll=selector=>selector==='a'?[...links,unknown]:[];
  nav.querySelector=selector=>selector==='[aria-current]'?link:links[0];
  let button;
  const sidebar = makeElement('aside');sidebar.querySelector=selector=>selector==='.books-nav'?nav:button;
  sidebar.insertBefore=b=>button=b;
  const classes=new Set(['books-shell']);
  const body={classList:{contains:x=>classes.has(x),add:x=>classes.add(x)}};
  document.body=headStartup?null:body;
  document.querySelector=()=>sidebar;
  document.createElement=tag=>makeElement(tag);
  document.createElementNS=(namespace,tag)=>{const node=makeElement(tag);node.namespaceURI=namespace;return node};
  document.querySelectorAll=()=>[skip];document.getElementById=()=>target;
  const media=Object.assign(eventTarget(),{matches:mobileInitially});
  const window=Object.assign(eventTarget(),{matchMedia:()=>media});
  vm.runInNewContext(source,{window,document});
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
  assert.equal(nav.hidden,mobileInitially);
  assert.equal(button.attrs['aria-controls'],'books-primary-navigation');
  button.events.click();assert.equal(nav.hidden,false);assert.equal(button.attrs['aria-expanded'],'true');
  if(mobileInitially){let prevented=false;sidebar.events.keydown({key:'Escape',preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(nav.hidden,true);assert.equal(document.activeElement,button);}
  media.matches=false;media.events.change();assert.equal(nav.hidden,false);
  link.focus();media.matches=true;media.events.change();assert.equal(nav.hidden,true);assert.equal(document.activeElement,button);
  media.matches=false;media.events.change();assert.equal(document.activeElement,link);
  skip.events.click();assert.equal(document.activeElement,target);assert.equal(target.attrs.tabindex,'-1');
  button.events.click();window.events.pageshow({persisted:false});assert.equal(button.attrs['aria-expanded'],'true');
  window.events.pageshow({persisted:true});assert.equal(button.attrs['aria-expanded'],'false');
  const originalIcon=links[0].children[0];vm.runInNewContext(source,{window,document});
  assert.equal(sidebar.querySelector('.books-menu-toggle'),button);assert.equal(links[0].children[0],originalIcon);
}
test(true);test(false);test(true,'location');test(false,'location');
test(true,'page',true);test(false,'location',true);
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
assert.match(css,/--books-side:92px/);assert.match(css,/padding:0 0 0 var\(--books-side\)/);
assert.match(css,/\.books-nav a\{position:relative;flex-direction:column/);
assert.match(css,/\.books-nav-icon\{display:block;width:21px;height:21px/);
assert.match(css,/\.books-nav a\{width:100%;min-height:44px;[^}]*flex-direction:row/);
assert.match(css,/\.books-nav\[hidden\]\{display:none\}/);
assert.match(css,/@media\(max-width:760px\)\{\s*\.books-shell \.books-sidebar\{[^}]*min-height:82px/);
assert.match(css,/\.books-shell-preparing \.books-shell \.books-nav\{display:none\}/);
assert.match(css,/\.books-shell \.books-nav\{grid-column:1\/-1;display:grid/); // No-JavaScript fallback stays visible.
assert.match(ticker,/\.books-shell>\.index-ticker\{[^}]*inset:0 0 auto;[^}]*width:100%/);
assert.match(ticker,/\.books-sidebar\{top:var\(--books-ticker-height\);height:calc\(100dvh - var\(--books-ticker-height\)\)/);
console.log('PASS: head execution without body, DOMContentLoaded enhancement, preparing cleanup on success/early return/failure, stable mobile header and no-JavaScript navigation; 7 accessible local SVG icons, preserved destinations/current page, unknown-link fallback, mobile/desktop disclosure, Escape focus, viewport focus recovery, skip focus, ordinary pageshow preserves opened menu and BFCache pageshow resets, duplicate initialization.');
