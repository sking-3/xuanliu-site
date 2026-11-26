'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../control/us-task-status.js');

const running = { status: 'collecting', targetDate: '2026-11-25', phase: 'daily_bars', processed: 100, expected: 3500, covered: 96, missing: 4, candidates: 3, message: '采集并计算日线', lastSuccess: { asOf: '2026-11-24', generatedAt: '2026-11-25T01:30:00Z' }, schedule: '收盘后自动运行' };
assert.equal(api.progressText(running), '日线采集 · 100/3,500');
assert.equal(api.progressText({ progress: { phase: 'tracking', completed: 4, total: 6 } }), '后续跟踪 · 4/6');
const description = api.lines(running).join('\n');
assert.ok(description.includes('采集中'));
assert.ok(description.includes('目标交易日 2026-11-25'));
assert.ok(description.includes('数据日 2026-11-24'));
assert.ok(description.includes('有效 96只 · 缺失 4只 · 观察候选 3只'));
assert.ok(api.lines({ ...running, status: 'error', error: 'HTTP 503' }).join('\n').includes('失败原因：HTTP 503'));
assert.ok(api.lines({ status: 'source_blocked', sourceHold: { reason: 'HTTP 403', stoppedAt: '2026-11-26T01:00:00Z' } }).join('\n').includes('来源停止：HTTP 403'));
const partial = api.lines({ ...running, status: 'ready', fundamentalsStatus: 'partial', fundamentalsFailures: [{ source: 'SEC', reason: 'HTTP 403' }] }).join('\n');
assert.ok(partial.includes('本轮：已完成'));
assert.ok(partial.includes('公开财报部分失败：1项'));
assert.ok(partial.includes('财报原因：SEC：HTTP 403'));

async function stateFlow() {
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.textContent = ''; }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
  }
  const panel = new Element(), button = new Element(), listeners = {}, requests = [], timers = new Map();
  let timerId = 0, fail = false;
  const document = { hidden: false, getElementById: id => id === 'us-task-status' ? panel : button, createElement: () => new Element(), addEventListener: (type, listener) => { listeners[type] = listener; } };
  const env = {
    document,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (type, listener) => { listeners[type] = listener; },
    fetch: async (url, options) => {
      requests.push({ url, method: options.method });
      if (fail) throw Error('network unavailable');
      return { ok: true, json: async () => running };
    }
  };
  const app = api.mount(env);
  await app.ready;
  assert.equal(app.state.data, running);
  assert.equal(button.disabled, false);
  fail = true; await app.refresh();
  assert.equal(app.state.data, running, 'failed reads retain last known status');
  assert.ok(panel.children.some(child => child.textContent.includes('其他控制台功能不受影响')));
  document.hidden = true; listeners.visibilitychange();
  const count = requests.length; await app.refresh(); assert.equal(requests.length, count, 'hidden page does not poll');
  assert.equal(timers.size, 0);
  listeners.pagehide();
  assert.ok(requests.every(request => request.url === '/api/us-selection/state' && request.method === 'GET'), 'status view never triggers a collection mutation');
  const html = fs.readFileSync(path.join(__dirname, '../control/index.html'), 'utf8');
  assert.ok(html.includes('id="automation-status"'));
  assert.ok(html.includes('id="job-status"'));
  assert.ok(html.includes('us-task-status.js?v=20261126-1'));
  console.log('US task status: progress, latest success, source failure, retained status, visibility and GET-only isolation passed.');
}
stateFlow().catch(error => { console.error(error); process.exitCode = 1; });
