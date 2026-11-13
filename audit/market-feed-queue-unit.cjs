// Deterministic DOM model: no upstream requests and no claim about quote completeness.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../market-feed-status.js'), 'utf8');

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || new Set();
    callbacks.add(callback); this.listeners.set(name, callbacks);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, event = {}) { for (const callback of [...(this.listeners.get(name) || [])]) callback(event); }
}
class Element extends Target {
  constructor(tagName = 'div') {
    super(); this.tagName = tagName.toUpperCase(); this.children = []; this.attrs = {};
    this.className = ''; this.textContent = ''; this.hidden = false; this.parent = null;
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attrs[name] = value; }
  closest(selector) {
    for (let element = this; element; element = element.parent) {
      if (selector === 'details:not([open])' && element.tagName === 'DETAILS' && !element.open) return element;
    }
    return null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.split(',').some(part => part.startsWith('.')
        ? child.className.split(' ').includes(part.slice(1)) : child.tagName === part.toUpperCase())) return child;
      const result = child.querySelector(selector); if (result) return result;
    }
    return null;
  }
}
function feed(index) {
  const section = new Element('section'), area = new Element(), status = new Element('p');
  const controls = new Element(), retry = new Element('button'), shortcuts = new Element('details');
  const heading = new Element('h3'), config = new Element('script'); heading.textContent = '市场 ' + index;
  config.textContent = JSON.stringify({tabs:[{symbols:[{s:'NASDAQ:AAPL'}]}],showChart:false});
  section.querySelector = selector => ({'.feed-widget-area':area, '.feed-status':status,
    '.feed-controls':controls, '.feed-retry':retry, '.symbol-shortcuts':shortcuts,
    'h2,h3':heading, 'script[data-feed-config]':config})[selector];
  return {section,area,status,controls,retry,shortcuts,
    phase:() => section.attrs['data-feed-state'], script:() => area.querySelector('script')};
}
function harness(count = 4, options = {}) {
  const feeds = Array.from({length:count}, (_, i) => feed(i));
  const document = new Target(), window = new Target(), timers = new Map(), mutations = [], intersections = [];
  let timerId = 0;
  document.hidden = !!options.hidden;
  document.createElement = tagName => new Element(tagName);
  document.querySelectorAll = () => feeds.map(item => item.section);
  class MutationObserver {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe(target) { this.target = target; this.connected = true; }
    disconnect() { this.connected = false; }
  }
  if (!options.noIntersection) window.IntersectionObserver = class {
    constructor(callback, init) { this.callback = callback; this.options = init; this.targets = new Set(); intersections.push(this); }
    observe(target) { this.targets.add(target); this.connected = true; }
    disconnect() { this.targets.clear(); this.connected = false; }
  };
  const context = vm.createContext({document,window,MutationObserver,Map,JSON,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }});
  const run = () => vm.runInContext(source, context);
  run();
  const near = (items, isIntersecting = true) => intersections.at(-1).callback(items.map(item => ({target:item.section,isIntersecting})));
  const frame = item => {
    const element = new Element('iframe'); element.contentWindow = {};
    item.area.children[0].append(element);
    mutations.find(observer => observer.target === item.area.children[0] && observer.connected)?.callback();
    return element;
  };
  const message = (element, name, extra = {}) => window.emit('message', {
    origin:'https://www.tradingview-widget.com', source:element.contentWindow, data:{name}, ...extra});
  return {feeds,document,window,timers,mutations,intersections,near,frame,message,run};
}
let count = 0;
function test(name, check) { check(); count++; console.log('PASS ' + name); }

test('offscreen feeds stay queued until the 240px viewport margin is entered', () => {
  const h = harness();
  assert.equal(h.intersections[0].options.rootMargin, '240px 0px');
  assert.ok(h.feeds.every(item => item.phase() === 'queued' && !item.script()));
  h.near([h.feeds[2]]); assert.equal(h.feeds[2].phase(), 'loading');
  assert.equal(h.feeds[0].script(), null); assert.equal(h.feeds[2].retry.disabled, true);
});
test('at most two initializations run and iframe insertion alone does not free a slot', () => {
  const h = harness(); h.near(h.feeds);
  assert.deepEqual(h.feeds.map(item => item.phase()), ['loading','loading','queued','queued']);
  const frame = h.frame(h.feeds[0]);
  assert.equal(h.feeds[0].phase(), 'loading'); assert.equal(h.feeds[2].script(), null);
  frame.emit('load');
  assert.deepEqual(h.feeds.map(item => item.phase()), ['embedded','loading','loading','queued']);
  assert.match(h.feeds[0].status.textContent, /组件已载入.*逐项更新/);
  assert.doesNotMatch(h.feeds[0].status.textContent, /报价完整|实时行情已就绪|行情已全部/);
  assert.equal(h.feeds[0].controls.hidden, true);
});
test('hidden documents do not start queued feeds and successful frames survive visibility changes', () => {
  const h = harness(4, {hidden:true}); h.near(h.feeds);
  assert.ok(h.feeds.every(item => !item.script()));
  h.document.hidden = false; h.document.emit('visibilitychange');
  const frame = h.frame(h.feeds[0]), container = h.feeds[0].area.children[0];
  h.document.hidden = true; frame.emit('load');
  assert.equal(h.feeds[2].phase(), 'queued');
  h.document.hidden = false; h.document.emit('visibilitychange');
  assert.equal(h.feeds[2].phase(), 'loading');
  assert.equal(h.feeds[0].area.children[0], container);
  assert.equal(h.feeds[0].area.querySelector('iframe'), frame);
});
test('a failure releases a slot but never automatically retries the failed source', () => {
  const h = harness(3); h.near(h.feeds);
  const failedScript = h.feeds[0].script(); failedScript.onerror();
  assert.equal(h.feeds[0].phase(), 'error'); assert.equal(h.feeds[0].area.hidden, true);
  assert.equal(h.feeds[0].controls.hidden, false); assert.equal(h.feeds[2].phase(), 'loading');
  h.document.emit('visibilitychange'); h.near([h.feeds[0]]);
  assert.equal(h.feeds[0].script(), failedScript); assert.equal(h.feeds[0].phase(), 'error');
  h.feeds[0].retry.emit('click'); assert.equal(h.feeds[0].phase(), 'queued');
  h.frame(h.feeds[1]).emit('load');
  assert.equal(h.feeds[0].phase(), 'loading'); assert.notEqual(h.feeds[0].script(), failedScript);
  failedScript.onerror(); assert.equal(h.feeds[0].phase(), 'loading');
});
test('bounded frame timeout describes only an embed and absent frames become recoverable errors', () => {
  const h = harness(2); h.near(h.feeds); h.frame(h.feeds[0]);
  for (const callback of [...h.timers.values()]) callback();
  assert.equal(h.feeds[0].phase(), 'embedded'); assert.match(h.feeds[0].status.textContent, /仍可能加载中/);
  assert.equal(h.feeds[1].phase(), 'error'); assert.equal(h.timers.size, 0);
  assert.equal(h.feeds[1].retry.disabled, false);
});
test('existing provider message names retain origin/source checks and unknown names cannot declare readiness', () => {
  const h = harness(1); h.near(h.feeds); const frame = h.frame(h.feeds[0]);
  h.message(frame, 'tv-widget-ready', {origin:'https://evil.invalid'});
  h.message(frame, 'tv-widget-ready', {source:{}}); h.message(frame, 'quotes-complete');
  assert.equal(h.feeds[0].phase(), 'loading');
  h.message(frame, 'tv-widget-no-data'); assert.equal(h.feeds[0].phase(), 'error');
  h.message(frame, 'tv-widget-ready'); assert.equal(h.feeds[0].phase(), 'embedded');
  assert.equal(h.feeds[0].area.querySelector('iframe'), frame);
});
test('legacy re-execution scans new feeds without rebuilding existing feeds or duplicating listeners', () => {
  const h = harness(1); h.near(h.feeds); const container = h.feeds[0].area.children[0];
  const originalViewport = h.intersections[0]; h.run(); h.window.BooksMarketFeeds.scan();
  assert.equal(h.feeds[0].area.children[0], container); assert.equal(h.intersections.length, 1);
  assert.equal(h.window.listeners.get('message').size, 1);
  h.feeds.push(feed(1)); h.run(); assert.equal(h.feeds[1].phase(), 'queued');
  assert.equal(originalViewport.targets.has(h.feeds[1].section), true);
  h.near([h.feeds[1]]); assert.equal(h.feeds[1].phase(), 'loading');
});
test('closed legacy details defer loading and reopening does not recreate a successful frame', () => {
  const h = harness(1), details = new Element('details'); details.append(h.feeds[0].section);
  h.near(h.feeds); assert.equal(h.feeds[0].phase(), 'queued');
  details.open = true; h.document.emit('toggle', {target:details});
  const frame = h.frame(h.feeds[0]); frame.emit('load'); const container = h.feeds[0].area.children[0];
  details.open = false; h.document.emit('toggle', {target:details});
  details.open = true; h.document.emit('toggle', {target:details}); h.run();
  assert.equal(h.feeds[0].area.children[0], container); assert.equal(h.feeds[0].phase(), 'embedded');
});
test('pagehide keeps pending embeds attached; BFCache identifies frames and resumes observation without new scripts', () => {
  const h = harness(3); h.near(h.feeds);
  const frame = h.frame(h.feeds[0]); frame.emit('load');
  const containers = h.feeds.map(item => item.area.children[0]), scripts = h.feeds.map(item => item.script());
  h.window.emit('pagehide');
  assert.equal(h.timers.size, 0); assert.ok(h.mutations.every(observer => !observer.connected));
  assert.equal(h.intersections[0].connected, false);
  assert.deepEqual(h.feeds.map(item => item.phase()), ['embedded','loading','loading']);
  const lateFrame = h.frame(h.feeds[2]); h.message(frame, 'tv-widget-no-data'); h.run();
  assert.equal(h.feeds[0].phase(), 'embedded');
  h.window.emit('pageshow', {persisted:false}); assert.equal(h.timers.size, 0);
  h.window.emit('pageshow', {persisted:true});
  assert.deepEqual(h.feeds.map(item => item.phase()), ['embedded','loading','embedded']);
  h.feeds.forEach((item,index) => { assert.equal(item.area.children[0], containers[index]); assert.equal(item.script(), scripts[index]); });
  assert.match(lateFrame.title, /市场 2/); assert.match(h.feeds[2].status.textContent, /保留原组件.*逐项更新/);
  assert.equal(h.timers.size, 1); h.frame(h.feeds[1]).emit('load');
  assert.equal(h.feeds[1].phase(), 'embedded'); assert.equal(h.timers.size, 0);
});
test('BFCache preserves prior errors and records a script failure during suspension without retrying it', () => {
  const h = harness(4); h.near(h.feeds);
  const failed = h.feeds[0].script(); failed.onerror();
  const pending = h.feeds[1].script(); h.window.emit('pagehide'); pending.onerror();
  h.window.emit('pageshow', {persisted:true}); h.window.emit('pageshow', {persisted:true});
  assert.deepEqual(h.feeds.map(item => item.phase()), ['error','error','loading','queued']);
  assert.equal(h.feeds[0].script(), failed); assert.equal(h.feeds[1].script(), pending);
  assert.equal(h.feeds[1].area.hidden, true); assert.equal(h.feeds[1].retry.disabled, false);
  h.near([h.feeds[3]]); assert.equal(h.feeds[3].phase(), 'loading');
  assert.equal(h.feeds[1].script(), pending);
});
test('BFCache restoration without IntersectionObserver still counts retained initialization slots', () => {
  const h = harness(3, {noIntersection:true}), scripts = h.feeds.slice(0,2).map(item => item.script());
  h.window.emit('pagehide'); h.frame(h.feeds[0]);
  h.window.emit('pageshow', {persisted:true});
  assert.deepEqual(h.feeds.map(item => item.phase()), ['embedded','loading','loading']);
  assert.equal(h.feeds[0].script(), scripts[0]); assert.equal(h.feeds[1].script(), scripts[1]);
});
test('a callback queued before pagehide cannot overwrite a restored source failure', () => {
  const h = harness(1); h.near(h.feeds);
  const frame = h.frame(h.feeds[0]), oldObserver = h.mutations[0];
  const oldLoad = [...frame.listeners.get('load')][0], script = h.feeds[0].script();
  h.window.emit('pagehide'); script.onerror(); h.window.emit('pageshow', {persisted:true});
  assert.equal(h.feeds[0].phase(), 'error');
  oldLoad(); oldObserver.callback(); assert.equal(h.feeds[0].phase(), 'error');
  assert.equal(h.feeds[0].script(), script);
});
test('browsers without IntersectionObserver still enforce two initialization slots', () => {
  const h = harness(3, {noIntersection:true});
  assert.deepEqual(h.feeds.map(item => item.phase()), ['loading','loading','queued']);
  h.frame(h.feeds[0]).emit('load'); assert.equal(h.feeds[2].phase(), 'loading');
});
console.log(`${count} market feed queue/lifecycle DOM-model tests passed. Browser rendering is separate.`);
