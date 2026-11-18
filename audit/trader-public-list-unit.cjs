const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const read = (name) => fs.readFileSync(path.join(__dirname, '../trader', name), 'utf8');
const html = read('index.html');
const script = read('plaza.js');
assert.match(html, /data-public-list="true"/);
assert.match(html, /公开历史快照，不构成跟单建议，不代表未来收益/);
assert.match(read('plaza.css'), /\.public-disclaimer\{position:sticky/);
for (const asset of ['plaza.js', 'plaza.css']) {
  assert.ok(html.includes(asset + '?v=' + createHash('sha256').update(read(asset)).digest('hex').slice(0, 8)));
}

const element = (tag) => ({
  tag, children: [], textContent: '',
  append(...children) { this.children.push(...children); },
  replaceChildren(...children) { this.children = children; },
});
const elements = new Map();
const document = {
  body: { dataset: { publicList: 'true' } },
  createElement: element,
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  },
};
const context = {
  document,
  BooksOKXPeriodData: { performance: (row, period) => row.performance[period] },
  BooksBitgetPeriodData: { performance: (row, period) => row.performance[period] },
  BinanceData: {
    recordedPeriod: (row, period) => row?.performance[period] || null,
    performance: () => null,
  },
};
vm.runInNewContext(script.split('for(const id of controls)$(id).addEventListener')[0] +
  'globalThis.sample={publicListCard,render,state};})();', context);
const { publicListCard, render, state } = context.sample;
const cut = '2026-11-16T12:00:00Z';
const children = (node) => [node, ...node.children.flatMap(children)];
const content = (node) => children(node).map((item) => item.textContent).join(' ');
const hl = { name: '示例公开钱包', exchange: 'Hyperliquid', sourceKind: 'public_account',
  windows: { '30D': { roi: 0, mdd: null, asOf: cut, asOfType: 'source', sourcePeriod: 'month', coverageDays: 21 } } };
const okx = { name: '示例 OKX', exchange: 'OKX', sourceKind: 'okx_public_lead', okxRecord: { leadDays: 120,
  performance: { '30D': { roi: 2, mdd: null, beginTs: Date.parse('2026-10-17T12:00:00Z'), endTs: Date.parse(cut), lastSuccessAt: cut } } } };
const bitget = { name: '示例 Bitget', exchange: 'Bitget', sourceKind: 'bitget_public_lead', bitgetRecord: { leadDays: 180,
  performance: { '30D': { roi: 1, mdd: 0, lastSuccessAt: cut, curve: [{time: '2026-10-01T00:00:00Z'}, {time: cut}] } } } };
const binance = { name: '示例 Binance', exchange: 'Binance', sourceKind: 'copy_trade', periodRecord: {
  performance: { '90D': { roi: 5, mdd: 3, status: 'stale', lastSuccessAt: cut, accountAgeDays: 120 } } } };

assert.match(content(publicListCard(hl, false)), /收益率 0\.00%.*统计周期 月度.*带单天数 该来源未提供.*数据时间范围 该来源未提供.*来源时间/);
assert.match(content(publicListCard(okx, false)), /最大回撤 该来源未提供.*带单天数 120 天.*数据时间范围 2026.* 至 2026/);
assert.match(content(publicListCard(bitget, true)), /最大回撤 0\.00%（来源口径）.*带单天数 180 天.*数据时间范围 该来源未提供.*读取失败，保留上次有效值.*采集时间/);
assert.match(content(publicListCard(binance, false)), /统计周期 90D.*最大回撤 3\.00%.*历史快照，待更新/);
state.rows = [hl, okx, bitget, binance, { ...hl, _local: true }, { ...hl, paid: true }];
render();
const list = elements.get('leaders');
assert.deepEqual(Array.from(list.children, (card) => card.children[0].textContent), [hl.name, okx.name, bitget.name, binance.name]);
assert.equal(children(list).some((item) => ['button', 'dialog', 'select'].includes(item.tag)), false);
state.lastReadFailed = true;
render();
assert.match(elements.get('public-list-status').textContent, /Hyperliquid.*读取失败/);
assert.equal(list.children.length, 4);
state.rows = [];
render();
assert.match(elements.get('public-list-status').textContent, /暂无可用快照/);
console.log('trader public list unit: ok');
