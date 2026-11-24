const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'academy', 'reader-ui.js'), 'utf8');

function fixture({mobileInitially = false, book = false, withSidebar = true} = {}) {
  const queue = new Map();
  const observers = [];
  const targetReads = {count: 0};
  const windowScrolls = [];
  const directoryScrolls = [];
  let frameId = 0;
  const eventTarget = () => ({events: {}, addEventListener(type, listener) {
    (this.events[type] ||= []).push(listener);
  }, emit(type, event = {}) {
    event.target ||= this;
    event.preventDefault ||= () => {};
    event.stopImmediatePropagation ||= () => {};
    for (const listener of this.events[type] || []) listener(event);
  }});
  const media = Object.assign(eventTarget(), {matches: mobileInitially});
  const originalAI = [];
  const window = Object.assign(eventTarget(), {
    scrollY: 0, innerHeight: 900,
    matchMedia(query) { return query.includes('reduced-motion') ? {matches: false} : media; },
    scrollTo(options) { windowScrolls.push(options); },
    toggleAiDrawer(value) { originalAI.push(value); }
  });
  class Element {
    constructor(tag = 'div', className = '') {
      Object.assign(this, eventTarget());
      this.tagName = tag; this.className = className; this.attrs = {};
      this.children = []; this.style = {}; this.hidden = false; this.open = false;
      this.textContent = ''; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
        remove: name => { this.className = this.className.split(/\s+/).filter(x => x !== name).join(' '); }
      };
    }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; }
    hasAttribute(name) { return name in this.attrs; }
    appendChild(child) {
      if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
      child.parentElement = this; this.children.push(child); return child;
    }
    before(child) {
      const parent = this.parentElement;
      if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
      child.parentElement = parent; parent.children.splice(parent.children.indexOf(this), 0, child);
    }
    after(child) {
      const parent = this.parentElement;
      if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
      child.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
    }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1]; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    matches(selector) {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      if (selector === 'a[href^="#"]') return this.tagName === 'a' && this.getAttribute('href')?.startsWith('#');
      if (selector === '[data-tid]') return this.hasAttribute('data-tid');
      return false;
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector.split(',').some(part => node.matches(part.trim()))) return node;
      }
      return null;
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() {
      for (let node = this; node; node = node.parentElement) {
        if (node.hidden || node.style.display === 'none' || node.tagName === 'dialog' && !node.open) return [];
        if (node.classList.contains('toc-links-wrap') && node.parentElement.classList.contains('collapsed')) return [];
      }
      return [{}];
    }
    getBoundingClientRect() {
      if (this.isTarget) {
        targetReads.count++;
        return {top: this.docTop - window.scrollY, bottom: this.docTop - window.scrollY + 300};
      }
      if (this === sidebar || this.tagName === 'dialog') return {top: 120, bottom: 120 + this.clientHeight};
      let scroll = 0;
      for (let parent = this.parentElement; parent; parent = parent.parentElement) scroll += parent.scrollTop;
      return {top: 120 + (this.rowTop || 0) - scroll, bottom: 164 + (this.rowTop || 0) - scroll};
    }
    scrollBy(options) { this.scrollTop += options.top; directoryScrolls.push({node: this, ...options}); }
    scrollIntoView(options) { windowScrolls.push({node: this, ...options}); }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
  }
  const body = new Element('body');
  const root = new Element('html'); root.scrollHeight = 4000;
  const layout = body.appendChild(new Element('div', 'layout'));
  const sidebar = new Element('aside', 'sidebar' + (book ? ' academy-book-toc' : ''));
  sidebar.clientHeight = 400; sidebar.scrollHeight = 1800;
  if (withSidebar) layout.appendChild(sidebar);
  const main = layout.appendChild(new Element('main'));
  const web = main.appendChild(new Element('section')); web.id = 'webReader';
  const pdf = main.appendChild(new Element('section')); pdf.id = 'pdfReader';
  const toggle = body.appendChild(new Element('button')); toggle.id = 'academy-toc-toggle';
  const targets = {};
  const links = {};
  const groups = {};
  const buttons = {};
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    const target = web.appendChild(new Element('section')); target.id = id;
    target.isTarget = true; target.docTop = [500, 1200, 2400][index]; targets[id] = target;
  }
  // TOC order intentionally differs from article order.
  for (const id of ['c', 'a', 'b']) {
    const group = sidebar.appendChild(new Element('div', 'toc-group')); groups[id] = group;
    const button = group.appendChild(new Element('button', 'toc-vol-btn')); button.rowTop = 900; buttons[id] = button;
    const wrap = group.appendChild(new Element('div', 'toc-links-wrap'));
    const link = wrap.appendChild(new Element('a', 'toc-link')); links[id] = link;
    link.setAttribute('href', '#' + id); link.rowTop = 700;
    const title = link.appendChild(new Element('span', 'toc-title-txt')); title.textContent = '章节 ' + id.toUpperCase();
  }
  if (book) {
    for (const id of ['btnWebMode', 'btnPdfMode', 'backTop']) {
      const button = sidebar.appendChild(new Element('button', id === 'backTop' ? '' : 'mode-btn')); button.id = id;
    }
  }
  const byId = id => {
    const visit = node => node.id === id ? node : node.children.map(visit).find(Boolean);
    return visit(body) || null;
  };
  const document = {
    body, documentElement: root,
    querySelector: selector => selector === 'main' ? main : withSidebar ? sidebar : null,
    getElementById: byId,
    createElement(tag) {
      const node = new Element(tag);
      if (tag === 'dialog') { node.clientHeight = 450; node.scrollHeight = 1800; }
      return node;
    },
    createComment: () => new Element('#comment')
  };
  const getComputedStyle = node => ({
    scrollPaddingTop: '100px',
    overflowY: node === sidebar ? media.matches ? 'visible' : 'auto' : node.tagName === 'dialog' ? 'auto' : 'visible'
  });
  const observerClass = type => class {
    constructor(callback) { this.callback = callback; this.type = type; observers.push(this); }
    observe(node, options) { this.target = node; this.options = options; }
  };
  vm.runInNewContext(source, {window, document, getComputedStyle,
    ResizeObserver: observerClass('resize'), MutationObserver: observerClass('mutation'),
    requestAnimationFrame(callback) { queue.set(++frameId, callback); return frameId; }
  });
  function flush() { const pending = [...queue.values()]; queue.clear(); pending.forEach(callback => callback()); }
  const scroll = y => { window.scrollY = y; window.emit('scroll'); flush(); };
  const invalidate = type => { observers.find(observer => observer.type === type).callback([]); flush(); };
  const current = () => Object.keys(links).filter(id => links[id].getAttribute('aria-current') === 'location');
  return {window, document, media, body, layout, sidebar, main, web, pdf, toggle, targets, links, groups, buttons,
    observers, targetReads, windowScrolls, directoryScrolls, originalAI, flush, scroll, invalidate, current, byId};
}

{
  const f = fixture(); // Executes the full file, including initial renderTOC/revealCurrent.
  f.flush(); assert.deepEqual(f.current(), []);
  assert.deepEqual(f.originalAI, [false]);
  f.window.toggleAiDrawer(); assert.equal(f.byId('academy-ai-notice').open, true);
  f.window.toggleAiDrawer(false); assert.equal(f.byId('academy-ai-notice').open, false);
  f.scroll(500); assert.deepEqual(f.current(), ['a']);
  assert.equal(f.toggle.textContent, '目录 · 章节 A');
  assert.equal(f.toggle.getAttribute('aria-label'), '章节目录，当前章节：章节 A');
  assert.ok(f.directoryScrolls.length); assert.equal(f.directoryScrolls[0].node, f.sidebar);
  assert.equal(f.windowScrolls.length, 0);
  const reads = f.targetReads.count;
  for (let i = 0; i < 100; i++) f.scroll(510 + i);
  assert.equal(f.targetReads.count, reads, 'Cached scroll must not reread target rectangles');
  f.groups.b.classList.add('collapsed'); f.scroll(1300);
  assert.deepEqual(f.current(), ['b']); assert.equal(f.groups.b.classList.contains('collapsed'), true);
  assert.equal(f.groups.b.getAttribute('data-academy-current'), '');
  f.groups.c.style.display = 'none'; const count = f.directoryScrolls.length; f.scroll(2500);
  assert.deepEqual(f.current(), ['c']); assert.equal(f.directoryScrolls.length, count);
  assert.equal(f.groups.c.style.display, 'none', 'Search-filtered group must stay filtered');
  f.scroll(1300); assert.deepEqual(f.current(), ['b']);
  f.scroll(0); assert.deepEqual(f.current(), []); assert.equal(f.toggle.textContent, '章节目录');
  f.scroll(3200); assert.deepEqual(f.current(), ['c'], 'Page bottom selects final visible section');
  f.targets.c.hidden = true; f.invalidate('mutation'); assert.deepEqual(f.current(), ['b']);
  f.targets.b.docTop = 3500; f.scroll(2000); assert.deepEqual(f.current(), ['b'], 'Offsets stay cached before layout invalidation');
  f.invalidate('resize'); assert.deepEqual(f.current(), ['a']);
  assert.ok(f.targetReads.count > reads);
  const mutation = f.observers.find(observer => observer.type === 'mutation');
  assert.equal(mutation.target, f.main);
  assert.deepEqual(Array.from(mutation.options.attributeFilter), ['class', 'style', 'hidden', 'open']);
  assert.equal(f.windowScrolls.length, 0);
}

{
  const f = fixture({mobileInitially: true, book: true});
  f.flush(); f.scroll(1300); assert.deepEqual(f.current(), ['b']);
  assert.equal(f.directoryScrolls.length, 0, 'Closed mobile TOC must not scroll its viewport');
  assert.equal(f.sidebar.parentElement, f.byId('academy-toc-dialog'));
  f.toggle.emit('click'); assert.equal(f.byId('academy-toc-dialog').open, true);
  assert.equal(f.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.directoryScrolls.at(-1).node, f.byId('academy-toc-dialog'));
  f.byId('academy-toc-dialog').querySelector('.academy-toc-close').emit('click');
  assert.equal(f.byId('academy-toc-dialog').open, false);
  f.web.style.display = 'none'; f.invalidate('mutation');
  assert.deepEqual(f.current(), [], 'PDF mode excludes hidden web chapters');
  f.web.style.display = ''; f.invalidate('mutation'); assert.deepEqual(f.current(), ['b']);
  f.media.matches = false; f.media.emit('change');
  assert.equal(f.sidebar.parentElement, f.layout); assert.equal(f.byId('academy-toc-dialog').open, false);
  assert.equal(f.current().length, 1); assert.equal(f.windowScrolls.length, 0);
}

{
  const f = fixture({withSidebar: false});
  assert.equal(f.toggle.hidden, true); assert.equal(f.observers.length, 0);
  f.window.toggleAiDrawer(); assert.equal(f.byId('academy-ai-notice').open, true);
}

console.log('PASS reader follow: article order, up/down/top/end, hidden/PDF sections, layout invalidation and cached geometry, collapsed/search preservation, isolated directory scrolling, mobile title/ARIA and breakpoint restoration, initial TOC/AI execution.');
