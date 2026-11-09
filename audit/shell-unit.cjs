const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2], 'utf8');
function test(mobileInitially) {
  const eventTarget = () => ({events:{}, addEventListener(k, fn){this.events[k]=fn;}});
  const document = {activeElement:null};
  const element = () => Object.assign(eventTarget(), {attrs:{}, setAttribute(k,v){this.attrs[k]=v},getAttribute(k){return this.attrs[k]},hasAttribute(k){return k in this.attrs},focus(){document.activeElement=this}});
  const link = element();
  const skip = element(); skip.attrs.href='#content';
  const target = element();
  const nav = element(); nav.contains = x => x === link; nav.querySelector=()=>link;
  let button;
  const sidebar = element(); sidebar.querySelector = selector => selector === '.books-nav' ? nav : button;
  sidebar.insertBefore = b => button=b;
  const classes=new Set(['books-shell']);
  document.body={classList:{contains:x=>classes.has(x),add:x=>classes.add(x)}};
  document.querySelector=()=>sidebar;document.createElement=()=>element();document.querySelectorAll=()=>[skip];document.getElementById=()=>target;
  const media=Object.assign(eventTarget(),{matches:mobileInitially});
  const window=Object.assign(eventTarget(),{matchMedia:()=>media});
  vm.runInNewContext(source,{window,document});
  assert.equal(nav.hidden,mobileInitially);
  assert.equal(button.attrs['aria-controls'],'books-primary-navigation');
  button.events.click(); assert.equal(nav.hidden,false);assert.equal(button.attrs['aria-expanded'],'true');
  if(mobileInitially){let prevented=false;sidebar.events.keydown({key:'Escape',preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(nav.hidden,true);assert.equal(document.activeElement,button);}
  media.matches=false;media.events.change();assert.equal(nav.hidden,false);
  link.focus();media.matches=true;media.events.change();assert.equal(nav.hidden,true);assert.equal(document.activeElement,button);
  media.matches=false;media.events.change();assert.equal(document.activeElement,link);
  skip.events.click();assert.equal(document.activeElement,target);assert.equal(target.attrs.tabindex,'-1');
  button.events.click();window.events.pageshow();assert.equal(button.attrs['aria-expanded'],'false');
  vm.runInNewContext(source,{window,document});assert.equal(sidebar.querySelector('.books-menu-toggle'),button);
}
test(true);test(false);console.log('PASS: mobile/desktop initial states, disclosure, Escape focus, viewport focus recovery, skip focus, pageshow reset, duplicate initialization.');
