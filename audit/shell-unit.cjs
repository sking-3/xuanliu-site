const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sourcePath = process.argv[2] || path.join(__dirname, '..', 'books-shell.js');
const source = fs.readFileSync(sourcePath, 'utf8');
function test(mobileInitially, currentType = 'page') {
  const eventTarget = () => ({events:{}, addEventListener(k, fn){this.events[k]=fn;}});
  const document = {activeElement:null};
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
  document.body={classList:{contains:x=>classes.has(x),add:x=>classes.add(x)}};
  document.querySelector=()=>sidebar;
  document.createElement=tag=>makeElement(tag);
  document.createElementNS=(namespace,tag)=>{const node=makeElement(tag);node.namespaceURI=namespace;return node};
  document.querySelectorAll=()=>[skip];document.getElementById=()=>target;
  const media=Object.assign(eventTarget(),{matches:mobileInitially});
  const window=Object.assign(eventTarget(),{matchMedia:()=>media});
  vm.runInNewContext(source,{window,document});
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
  button.events.click();window.events.pageshow();assert.equal(button.attrs['aria-expanded'],'false');
  const originalIcon=links[0].children[0];vm.runInNewContext(source,{window,document});
  assert.equal(sidebar.querySelector('.books-menu-toggle'),button);assert.equal(links[0].children[0],originalIcon);
}
test(true);test(false);test(true,'location');test(false,'location');
const css=fs.readFileSync(path.join(path.dirname(sourcePath),'books-ui.css'),'utf8');
const ticker=fs.readFileSync(path.join(path.dirname(sourcePath),'index-ticker.css'),'utf8');
assert.match(css,/--books-side:92px/);assert.match(css,/padding:0 0 0 var\(--books-side\)/);
assert.match(css,/\.books-nav a\{position:relative;flex-direction:column/);
assert.match(css,/\.books-nav-icon\{display:block;width:21px;height:21px/);
assert.match(css,/\.books-nav a\{width:100%;min-height:44px;[^}]*flex-direction:row/);
assert.match(css,/\.books-nav\[hidden\]\{display:none\}/);
assert.match(ticker,/\.books-shell>\.index-ticker\{[^}]*inset:0 0 auto;[^}]*width:100%/);
assert.match(ticker,/\.books-sidebar\{top:var\(--books-ticker-height\);height:calc\(100dvh - var\(--books-ticker-height\)\)/);
console.log('PASS: 7 accessible local SVG navigation icons, preserved destinations/current page, short labels, unknown-link fallback, 92px shared rail/body offset, full-width ticker separation, mobile/desktop disclosure, Escape focus, viewport focus recovery, skip focus, pageshow reset, duplicate initialization.');
