'use strict';

async function readMaterial(path) {
  const response = await fetch(path, {cache: 'no-cache', credentials: 'omit', signal: AbortSignal.timeout(9000)});
  if (!response.ok) throw Error('资料读取失败');
  return response.json();
}

function publicationDay(value) {
  const date = Date.parse(value);
  if (!Number.isFinite(date)) throw Error('资料日期缺失');
  return new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(date);
}

const closeMaterial = document.getElementById('tools-close');
readMaterial('research-data/a-daily-movers.json').then(snapshot => {
  if (!Number.isInteger(snapshot.priced) || snapshot.priced < 1) throw Error('覆盖范围缺失');
  closeMaterial.textContent = publicationDay(snapshot.asOf) + ' 收盘 · ' + snapshot.priced.toLocaleString('zh-CN') + ' 只有效报价';
}).catch(() => { closeMaterial.textContent = '快照暂时无法读取，可打开涨跌榜查看。'; });

const macroMaterial = document.getElementById('tools-release');
readMaterial('macro-cn.json').then(snapshot => {
  const latest = snapshot.card.data.latest;
  const source = new URL(latest.url);
  if (typeof latest.title !== 'string' || !latest.title.trim() || source.protocol !== 'https:' || source.hostname !== 'www.stats.gov.cn') throw Error('发布信息不完整');
  macroMaterial.textContent = publicationDay(latest.publishedAt) + ' · ' + latest.title;
  document.getElementById('tools-release-source').href = source.href;
}).catch(() => { macroMaterial.textContent = '快照暂时无法读取，可前往国家统计局。'; });
