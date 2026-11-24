'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {gaugeModel, mount} = require('../books-data-visuals.js');

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn(event); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, list) => sum + list.size, 0); }
}
class Element {
  constructor(tag = 'div', attrs = {}, text = '') {
    this.tagName = tag; this.attrs = {...attrs}; this.children = []; this.parentNode = null; this.nodeType = 1; this.textContent = text; this.animations = [];
    this.classList = {add: value => this.setAttribute('class', [...new Set((this.getAttribute('class') || '').split(' ').filter(Boolean).concat(value))].join(' ')), remove: value => this.setAttribute('class', (this.getAttribute('class') || '').split(' ').filter(v => v !== value).join(' '))};
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  get isConnected() { return this.root === true || Boolean(this.parentNode?.isConnected); }
  matches(selector) {
    if (selector.startsWith('.')) return (this.getAttribute('class') || '').split(' ').includes(selector.slice(1));
    if (selector.startsWith('[')) { const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/); return value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value; }
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    const split = selector.lastIndexOf(' '), ancestor = split < 0 ? null : selector.slice(0, split), target = split < 0 ? selector : selector.slice(split + 1);
    const result = [];
    for (const child of this.children) {
      if (child.matches(target) && (!ancestor || child.parentNode.closest(ancestor))) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  animate(keyframes, options) { const animation = {keyframes, options, cancelled: false, cancel() { this.cancelled = true; }}; this.animations.push(animation); return animation; }
}
function scale(value = '16.6', max = '100', labels = ['0', '25', '50', '75', '100']) {
  const panel = new Element('section', {'data-sentiment-market': 'cn'}), node = panel.appendChild(new Element('div', {class: 'sentiment-scale'}));
  const track = node.appendChild(new Element('div', {class: 'sentiment-track', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': max, 'aria-valuenow': value, 'aria-valuetext': value + ' / ' + max}));
  const ticks = node.appendChild(new Element('ol', {class: 'sentiment-ticks'}));
  for (const label of labels) ticks.appendChild(new Element('li', {}, label));
  return {panel, node, track};
}
function fixture({reduced = false, hidden = false, imageReady = false} = {}) {
  const env = new Events(), doc = new Events(), frames = new Map(), ids = new Map(); let nextFrame = 0;
  const media = new Events(); media.matches = reduced; env.matchMedia = () => media;
  env.requestAnimationFrame = fn => { frames.set(++nextFrame, fn); return nextFrame; }; env.cancelAnimationFrame = id => frames.delete(id);
  env.MutationObserver = class { constructor(fn) { this.callback = fn; this.targets = []; fixtureObserver = this; } observe(node) { this.targets.push(node); } disconnect() { this.targets = []; } };
  env.IntersectionObserver = class { constructor(fn) { this.callback = fn; this.targets = new Set(); fixtureIntersection = this; } observe(node) { this.targets.add(node); } unobserve(node) { this.targets.delete(node); } disconnect() { this.targets.clear(); } };
  let fixtureObserver, fixtureIntersection;
  doc.defaultView = env; doc.hidden = hidden; doc.getElementById = id => ids.get(id); doc.createElementNS = (_, tag) => new Element(tag);
  for (const id of ['market-sentiment', 'insight-flows', 'entry-opportunities-list']) { const node = new Element(); node.root = true; ids.set(id, node); }
  const sentiment = scale(); ids.get('market-sentiment').appendChild(sentiment.panel);
  const bar = ids.get('insight-flows').appendChild(new Element('div', {class: 'insight-flow-bar'}));
  bar.appendChild(new Element('span', {style: 'flex:43.3;--flow-color:#3e647e', title: '美债43.3%'}));
  bar.appendChild(new Element('span', {style: 'flex:56.7;--flow-color:#7891a4', title: '其他56.7%'}));
  const card = ids.get('entry-opportunities-list').appendChild(new Element('article', {'data-setup-id': '600000.SH:2026-11-24'}));
  const image = card.appendChild(new Element('img', {class: 'entry-current-chart', src: '/api/a-share-daily/entry-current-chart?generation=test&window=60'})); image.complete = imageReady; image.naturalWidth = imageReady ? 1200 : 0;
  const component = mount(doc);
  return {doc, env, media, frames, ids, sentiment, bar, image, component,
    observer: fixtureObserver, intersection: fixtureIntersection,
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    visible() { fixtureIntersection.callback([...fixtureIntersection.targets].map(target => ({target, isIntersecting: true}))); },
    active() { return ids.get('market-sentiment').querySelector('.books-gauge-value'); }};
}

test('gauge preserves genuine zero and derives VIX positions from its own 60-point scale', () => {
  const zero = scale('0'); assert.equal(gaugeModel(zero.track, ['0', '25', '50', '75', '100']).percent, 0);
  const vix = scale('27.25', '60'); const result = gaugeModel(vix.track, ['0', '15', '30', '45', '60+']);
  assert.equal(result.percent, 27.25 / 60 * 100); assert.deepEqual(result.ticks.at(-1), {label: '60+', ratio: 1}); assert.equal(result.ticks[2].ratio, .5);
});
test('unknown, empty, nonnumeric, inverted and out-of-scale values have no fabricated gauge', () => {
  assert.equal(gaugeModel(null, ['0', '100']), null);
  for (const value of [null, '', ' ', 'unavailable', 'Infinity', '-1', '101']) { const f = scale(); if (value === null) delete f.track.attrs['aria-valuenow']; else f.track.setAttribute('aria-valuenow', value); assert.equal(gaugeModel(f.track, ['0', '100']), null); }
  for (const [min, max] of [['100', '0'], ['0', '0'], ['', '100'], ['0', 'NaN']]) { const f = scale(); f.track.setAttribute('aria-valuemin', min); f.track.setAttribute('aria-valuemax', max); assert.equal(gaugeModel(f.track, ['0', '100']), null); }
  const f = scale(); for (const ticks of [[], ['?'], ['0', '101']]) assert.equal(gaugeModel(f.track, ticks), null);
});
test('drawing retains native accessibility facts and zero does not acquire a false filled dot', t => {
  const f = fixture(); t.after(() => f.component.destroy()); const original = {...f.sentiment.track.attrs};
  assert.equal(f.active().getAttribute('stroke-dasharray'), '16.6 100'); assert.deepEqual(f.sentiment.track.attrs, original);
  assert.equal(f.sentiment.node.querySelector('[data-books-visual="gauge"]').getAttribute('aria-hidden'), 'true');
  f.sentiment.track.setAttribute('aria-valuenow', '0'); f.component.refresh(); assert.equal(f.active().getAttribute('visibility'), 'hidden');
  delete f.sentiment.track.attrs['aria-valuenow']; f.component.refresh(); assert.equal(f.active(), null); assert.ok(!f.sentiment.node.getAttribute('class').includes('books-scale-ready'));
});
test('owner rebuild of equal facts and repeat reads do not replay, but changed values do', t => {
  const f = fixture(); t.after(() => f.component.destroy()); f.visible(); const first = f.active(); assert.equal(first.animations.length, 1);
  f.component.refresh(); f.visible(); assert.equal(first.animations.length, 1);
  f.sentiment.panel.remove(); const replacement = scale(); f.ids.get('market-sentiment').appendChild(replacement.panel); f.component.refresh(); f.visible();
  const second = f.active(); assert.notEqual(first, second); assert.equal(second.animations.length, 0); assert.equal(first.animations[0].cancelled, true);
  replacement.track.setAttribute('aria-valuenow', '25'); f.component.refresh(); f.visible(); assert.equal(f.active().animations.length, 1); assert.equal(f.active().getAttribute('stroke-dasharray'), '25 100');
});
test('reduced motion renders final facts and switching it on cancels current motion without late replay', t => {
  const f = fixture({reduced: true}); t.after(() => f.component.destroy()); f.visible(); assert.equal(f.active().animations.length, 0); assert.equal(f.active().getAttribute('stroke-dasharray'), '16.6 100');
  f.media.matches = false; f.media.emit('change'); f.flush(); f.visible(); assert.equal(f.active().animations.length, 0);
  f.sentiment.track.setAttribute('aria-valuenow', '20'); f.component.refresh(); f.visible(); const animation = f.active().animations[0]; assert.ok(animation);
  f.media.matches = true; f.media.emit('change'); assert.equal(animation.cancelled, true); f.media.matches = false; f.media.emit('change'); f.flush(); f.visible(); assert.equal(f.active().animations.length, 1);
});
test('hidden documents suspend work, cancel pending frames and do not replay old facts on return', t => {
  const f = fixture(); t.after(() => f.component.destroy()); f.visible(); const animation = f.active().animations[0];
  f.doc.emit('load'); assert.equal(f.frames.size, 1); f.doc.hidden = true; f.doc.emit('visibilitychange'); assert.equal(f.frames.size, 0); assert.equal(animation.cancelled, true);
  f.doc.emit('load'); assert.equal(f.frames.size, 0); f.doc.hidden = false; f.doc.emit('visibilitychange'); f.flush(); f.visible(); assert.equal(f.active().animations.length, 1);
});
test('daily K reveal waits for the real image load and leaves its data URL untouched', t => {
  const f = fixture(); t.after(() => f.component.destroy()); const src = f.image.getAttribute('src'); f.visible(); assert.equal(f.image.animations.length, 0);
  f.image.complete = true; f.image.naturalWidth = 1200; f.doc.emit('load'); f.flush(); f.visible(); assert.equal(f.image.animations.length, 1);
  f.component.refresh(); f.visible(); assert.equal(f.image.animations.length, 1); assert.equal(f.image.getAttribute('src'), src);
  assert.equal(f.image.animations[0].options.iterations, 1); assert.equal(f.image.animations[0].options.duration, 240);
});
test('own SVG mutations cannot loop RAF and destruction disconnects all lifecycle work', () => {
  const f = fixture({imageReady: true}); f.visible(); const animation = f.active().animations[0];
  const svg = f.sentiment.node.querySelector('[data-books-visual="gauge"]'); f.observer.callback([{type: 'childList', addedNodes: [svg], removedNodes: []}]); assert.equal(f.frames.size, 0);
  f.observer.callback([{type: 'attributes'}]); f.observer.callback([{type: 'attributes'}]); assert.equal(f.frames.size, 1);
  f.component.destroy(); assert.equal(f.frames.size, 0); assert.equal(f.observer.targets.length, 0); assert.equal(f.intersection.targets.size, 0); assert.equal(animation.cancelled, true);
  assert.equal(f.doc.listenerCount(), 0); assert.equal(f.env.listenerCount(), 0); assert.equal(f.media.listenerCount(), 0); f.component.refresh(); assert.equal(f.frames.size, 0);
});
