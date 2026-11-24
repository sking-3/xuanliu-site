'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const site = path.resolve(__dirname, '..');
const before = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'fixtures', 'home-widget-before');
const currentOverview = require('../market-overview.js');
const previousOverview = require(path.join(before, 'market-overview.js'));
const currentSentiment = require('../market-sentiment.js');
const previousSentiment = require(path.join(before, 'market-sentiment.js'));
const now = Date.parse('2026-11-24T12:00:00+08:00');
const clone = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(doc, tag) {
    this.doc = doc;
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.className = '';
    this.own = '';
    this.dataset = {};
    this.style = {setProperty(name, value) {this[name] = value;}};
  }
  append(...nodes) {this.children.push(...nodes);}
  replaceChildren(...nodes) {this.children = nodes; this.own = '';}
  set textContent(value) {this.own = String(value); this.children = [];}
  get textContent() {return this.own + this.children.map(item => item.textContent).join('');}
  setAttribute(name, value) {this.attrs[name] = String(value);}
  getAttribute(name) {return this.attrs[name];}
  contains(node) {return this === node || this.children.some(item => item.contains(node));}
  querySelectorAll(selector) {
    const matches = item => selector.startsWith('.')
      ? item.className.split(' ').includes(selector.slice(1))
      : selector.startsWith('[')
        ? (() => {const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/); return name in item.attrs && (value === undefined || item.attrs[name] === value);})()
        : item.tagName === selector;
    return this.children.flatMap(item => [...(matches(item) ? [item] : []), ...item.querySelectorAll(selector)]);
  }
  querySelector(selector) {
    const split = selector.indexOf(' ');
    if (split >= 0) return this.querySelector(selector.slice(0, split)).querySelector(selector.slice(split + 1));
    return this.querySelectorAll(selector)[0] || null;
  }
  focus() {this.doc.activeElement = this;}
}
function document() {
  const doc = {activeElement: null, createElement: tag => new Element(doc, tag), createTextNode: text => {const item = new Element(doc, '#text'); item.textContent = text; return item;}};
  return doc;
}
function tree(node) {
  const children = node.children.flatMap(tree);
  if (['insight-content', 'sentiment-content'].includes(node.className)) return children;
  const properties = {};
  for (const key of ['href', 'target', 'rel', 'hidden', 'open', 'tabIndex', 'min', 'max', 'value', 'dateTime']) {
    if (node[key] !== undefined) properties[key] = node[key];
  }
  return [{tag: node.tagName, text: node.own, class: node.className, attrs: node.attrs, dataset: node.dataset, style: Object.fromEntries(Object.entries(node.style).filter(([, value]) => typeof value !== 'function')), properties, children}];
}
function sentimentDOM() {
  const doc = document(), root = doc.createElement('article');
  root.append(doc.createElement('span'));
  root.children[0].setAttribute('data-sentiment-state', '');
  for (const market of ['cn', 'us', 'crypto']) {
    const section = doc.createElement('section'), body = doc.createElement('div'), tab = doc.createElement('button');
    section.setAttribute('data-sentiment-market', market);
    body.className = 'sentiment-body';
    section.append(body);
    tab.setAttribute('data-sentiment-select', market);
    root.append(tab, section);
  }
  return {doc, root};
}
function assertRegion(element, name) {
  assert.ok(element);
  assert.equal(element.getAttribute('role'), 'region');
  assert.equal(element.getAttribute('tabindex'), '0');
  assert.ok(element.getAttribute('aria-label').includes(name));
}

const overview = JSON.parse(fs.readFileSync(path.join(site, 'market-overview.json')));
const chinese = JSON.parse(fs.readFileSync(path.join(site, 'macro-cn.json'))).card;
let checks = 0;
for (const [id, source] of [...Object.entries(overview.cards), ['macro', chinese]]) {
  for (const state of ['ready', 'stale', 'unavailable']) {
    const card = clone(source);
    if (state === 'unavailable') Object.assign(card, {status: 'unavailable', data: null, asOf: null, fetchedAt: null});
    const oldDoc = document(), newDoc = document(), oldHost = oldDoc.createElement('article'), newHost = newDoc.createElement('article');
    previousOverview.renderCard(oldDoc, oldHost, id, card, now, state === 'stale');
    currentOverview.renderCard(newDoc, newHost, id, card, now, state === 'stale');
    assert.deepEqual(tree(newHost), tree(oldHost), id + ':' + state);
    const content = newHost.querySelector('.insight-content');
    assertRegion(content, '内容');
    assert.equal(content.querySelector('.insight-footer'), null);
    assert.equal(newHost.children.at(-1).className, 'insight-footer');
    checks++;
  }
}
const sentiment = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'home-widget-before', 'sentiment-latest.json')));
for (const market of ['cn', 'us', 'crypto']) {
  for (const state of ['ready', 'stale', 'unavailable']) {
    for (const expanded of [false, true]) {
      const snapshot = clone(sentiment);
      if (state === 'unavailable') Object.assign(snapshot.markets[market], {status: 'unavailable', data: null, asOf: null, fetchedAt: null});
      const oldDOM = sentimentDOM(), newDOM = sentimentDOM();
      previousSentiment.render(oldDOM.doc, oldDOM.root, snapshot, state === 'stale', now, market, false, expanded);
      currentSentiment.render(newDOM.doc, newDOM.root, snapshot, state === 'stale', now, market, false, expanded);
      assert.deepEqual(tree(newDOM.root), tree(oldDOM.root), market + ':' + state + ':' + expanded);
      const selected = newDOM.root.querySelector('[data-sentiment-market="' + market + '"]');
      const body = selected.querySelector('.sentiment-body'), content = body.querySelector('.sentiment-content');
      assertRegion(content, '情绪');
      assert.equal(content.querySelector('.sentiment-meta'), null);
      assert.equal(body.children.at(-1).className, 'sentiment-meta');
      checks++;
    }
  }
  const oldDOM = sentimentDOM(), newDOM = sentimentDOM();
  previousSentiment.render(oldDOM.doc, oldDOM.root, null, false, now, market, true);
  currentSentiment.render(newDOM.doc, newDOM.root, null, false, now, market, true);
  assert.deepEqual(tree(newDOM.root), tree(oldDOM.root));
  checks++;
}
{
  const doc = document(), host = doc.createElement('article');
  currentOverview.renderCard(doc, host, 'flows', overview.cards.flows, now, false);
  const oldContent = host.querySelector('.insight-content');
  oldContent.scrollTop = 48; oldContent.focus();
  currentOverview.renderCard(doc, host, 'flows', overview.cards.flows, now, false);
  const content = host.querySelector('.insight-content');
  assert.equal(content.scrollTop, 48);
  assert.equal(doc.activeElement, content);
  checks++;
}
{
  const {doc, root} = sentimentDOM();
  currentSentiment.render(doc, root, sentiment, false, now, 'cn');
  const oldContent = root.querySelector('[data-sentiment-market="cn"]').querySelector('.sentiment-content');
  oldContent.scrollTop = 56; oldContent.focus();
  currentSentiment.render(doc, root, sentiment, false, now, 'cn');
  const content = root.querySelector('[data-sentiment-market="cn"]').querySelector('.sentiment-content');
  assert.equal(content.scrollTop, 56);
  assert.equal(doc.activeElement, content);
  currentSentiment.render(doc, root, sentiment, false, now, 'us');
  currentSentiment.render(doc, root, sentiment, false, now, 'cn');
  assert.equal(root.querySelector('[data-sentiment-market="cn"]').querySelector('.sentiment-content').scrollTop, 56);
  checks++;
}
console.log('PASS ' + checks + ' before/after render cases: original nodes, text, data, source links, timestamps and selection/method states preserved after removing only the new scroll-region wrappers.');
