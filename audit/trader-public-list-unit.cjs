const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'trader/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'trader/plaza.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'trader/plaza.css'), 'utf8');
const required = [
  '公开历史快照，不构成跟单建议，不代表未来收益',
  '该来源未提供',
  '收益率 · ${publicInfo.period}',
  '最大回撤',
  '带单天数',
  '数据范围',
  'function publicMetrics',
  '.public-metrics',
];
for (const marker of required) {
  if (![html, script, css].some((source) => source.includes(marker))) throw new Error(`missing marker: ${marker}`);
}
if (/推荐|优选/.test(html) || /推荐|优选/.test(script)) throw new Error('recommendation label remains');
console.log('trader public list unit: ok');
