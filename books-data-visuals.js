/* Independently drawn, data-bound visuals inspired by Quix Studio's chart motion. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.BooksDataVisuals = api;
    api.mount(root.document);
  }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function gaugeModel(track, tickTexts) {
    if (!track) return null;
    const values = ['aria-valuemin', 'aria-valuemax', 'aria-valuenow'].map(name => track.getAttribute(name));
    if (values.some(value => value === null || value.trim() === '')) return null;
    const [min, max, value] = values.map(Number);
    if (![min, max, value].every(Number.isFinite) || max <= min || value < min || value > max) return null;
    const ticks = tickTexts.map(label => ({label, value: Number.parseFloat(label)}));
    if (!ticks.length || ticks.some(tick => !Number.isFinite(tick.value) || tick.value < min || tick.value > max)) return null;
    return {min, max, value, percent: 100 * (value - min) / (max - min),
      ticks: ticks.map(tick => ({label: tick.label, ratio: (tick.value - min) / (max - min)}))};
  }

  function drawGauge(doc, scale, model) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 240 128');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('data-books-visual', 'gauge');
    svg.setAttribute('class', 'books-sentiment-gauge');
    function element(tag, attributes, text) {
      const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
      if (text !== undefined) node.textContent = text;
      svg.appendChild(node);
      return node;
    }
    const arc = {d: 'M24 108 A96 96 0 0 1 216 108', pathLength: 100};
    element('path', {...arc, class: 'books-gauge-track'});
    const active = element('path', {...arc, class: 'books-gauge-value', 'stroke-dasharray': model.percent + ' 100'});
    if (model.percent === 0) active.setAttribute('visibility', 'hidden');
    for (const tick of model.ticks) {
      const angle = Math.PI * (1 - tick.ratio), x = Math.cos(angle), y = Math.sin(angle);
      element('line', {class: 'books-gauge-tick', x1: 120 + 87 * x, y1: 108 - 87 * y, x2: 120 + 81 * x, y2: 108 - 81 * y});
      element('text', {class: 'books-gauge-label', x: 120 + 68 * x, y: 108 - 68 * y}, tick.label);
    }
    scale.appendChild(svg);
    scale.classList.add('books-scale-ready');
    return active;
  }

  function mount(doc) {
    const env = doc.defaultView, records = new Map();
    const motion = env.matchMedia('(prefers-reduced-motion: reduce)');
    const hosts = ['market-sentiment', 'insight-flows', 'entry-opportunities-list'].map(id => doc.getElementById(id)).filter(Boolean);
    let frame = null, destroyed = false;

    function cancel(record) {
      if (record.animation) record.animation.cancel();
      record.animation = null;
    }
    function play(record) {
      if (!record.pending || doc.hidden || motion.matches || !record.target.isConnected) return;
      record.pending = false;
      if (typeof record.target.animate !== 'function') return;
      const keyframes = record.kind === 'gauge'
        ? [{strokeDasharray: '0 100'}, {strokeDasharray: record.percent + ' 100'}]
        : [{clipPath: 'inset(0 100% 0 0)', opacity: .65}, {clipPath: 'inset(0)', opacity: 1}];
      const animation = record.target.animate(keyframes, {duration: record.kind === 'chart' ? 240 : 300, easing: 'ease-out', iterations: 1});
      record.animation = animation;
      animation.onfinish = () => { if (record.animation === animation) record.animation = null; };
    }
    const intersection = typeof env.IntersectionObserver === 'function' ? new env.IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const record = Array.from(records.values()).find(value => value.target === entry.target);
        if (record) play(record);
      }
    }) : null;

    function register(key, signature, target, kind, percent) {
      const previous = records.get(key), changed = !previous || previous.signature !== signature;
      if (previous && previous.target === target && !changed) return;
      if (previous) {
        cancel(previous);
        if (intersection) intersection.unobserve(previous.target);
      }
      const record = {signature, target, kind, percent, animation: null,
        pending: changed && !doc.hidden && !motion.matches};
      records.set(key, record);
      if (intersection) intersection.observe(target);
    }
    function refresh() {
      if (destroyed || doc.hidden) return;
      const present = new Set();
      const sentiment = doc.getElementById('market-sentiment');
      if (sentiment) for (const scale of sentiment.querySelectorAll('.sentiment-scale')) {
        const track = scale.querySelector('.sentiment-track');
        const labels = Array.from(scale.querySelectorAll('.sentiment-ticks li'), node => node.textContent.trim());
        const model = gaugeModel(track, labels), panel = scale.closest('[data-sentiment-market]');
        const key = 'sentiment:' + (panel ? panel.getAttribute('data-sentiment-market') : 'default');
        const oldSvg = scale.querySelector('[data-books-visual="gauge"]');
        if (!model) {
          if (oldSvg) oldSvg.remove();
          scale.classList.remove('books-scale-ready');
          continue;
        }
        const signature = JSON.stringify([model, track.getAttribute('aria-valuetext')]);
        const previous = records.get(key);
        let target = oldSvg && oldSvg.querySelector('.books-gauge-value');
        if (!target || !previous || previous.signature !== signature) {
          if (oldSvg) oldSvg.remove();
          target = drawGauge(doc, scale, model);
        }
        present.add(key);
        register(key, signature, target, 'gauge', model.percent);
      }
      const flows = doc.getElementById('insight-flows');
      const bar = flows && flows.querySelector('.insight-flow-bar');
      if (bar) {
        const signature = Array.from(bar.children, node => [node.getAttribute('style'), node.getAttribute('title')]);
        present.add('flows');
        register('flows', JSON.stringify(signature), bar, 'flow');
      }
      const list = doc.getElementById('entry-opportunities-list');
      if (list) for (const image of list.querySelectorAll('.entry-current-chart')) {
        const card = image.closest('[data-setup-id]');
        if (!card) continue;
        const key = 'chart:' + card.getAttribute('data-setup-id');
        present.add(key);
        if (image.complete && image.naturalWidth > 0) register(key, image.getAttribute('src'), image, 'chart');
      }
      for (const [key, record] of records) if (!present.has(key)) {
        cancel(record);
        if (intersection) intersection.unobserve(record.target);
        records.delete(key);
      }
    }
    function schedule() {
      if (destroyed || doc.hidden || frame !== null) return;
      frame = env.requestAnimationFrame(() => {frame = null; refresh();});
    }
    const observer = new env.MutationObserver(changes => {
      if (changes.some(change => {
        if (change.type === 'attributes') return true;
        return [...change.addedNodes, ...change.removedNodes].some(node =>
          node.nodeType !== 1 || !node.hasAttribute('data-books-visual'));
      })) schedule();
    });
    for (const host of hosts) observer.observe(host, {childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'src']});
    function pause() {
      if (frame !== null) env.cancelAnimationFrame(frame);
      frame = null;
      for (const record of records.values()) {cancel(record); record.pending = false;}
    }
    function visibility() {if (doc.hidden) pause(); else schedule();}
    function preference() {if (motion.matches) pause(); else schedule();}
    function pagehide(event) {if (event.persisted) pause(); else destroy();}
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pause();
      observer.disconnect();
      if (intersection) intersection.disconnect();
      doc.removeEventListener('visibilitychange', visibility);
      doc.removeEventListener('load', schedule, true);
      motion.removeEventListener('change', preference);
      env.removeEventListener('pagehide', pagehide);
      env.removeEventListener('pageshow', schedule);
      records.clear();
    }
    doc.addEventListener('visibilitychange', visibility);
    doc.addEventListener('load', schedule, true);
    motion.addEventListener('change', preference);
    env.addEventListener('pagehide', pagehide);
    env.addEventListener('pageshow', schedule);
    refresh();
    return {refresh, destroy};
  }
  return {gaugeModel, mount};
});
