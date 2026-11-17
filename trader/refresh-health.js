/* Public workflow status; reports execution independently from source data time. */
(() => {
  const anchor = document.getElementById('position-notice');
  if (!anchor) return;
  const box = document.createElement('p');
  box.className = 'position-notice';
  box.setAttribute('role', 'status');
  anchor.after(box);
  const date = value => {
    const d = new Date(value);
    return value && Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : '暂无记录';
  };
  fetch('refresh-health.json', { cache: 'no-cache' }).then(r => {
    if (!r.ok) throw new Error('status unavailable');
    return r.json();
  }).then(data => {
    if (data.schemaVersion !== 1 || !data.platforms) throw new Error('status invalid');
    const names = { Binance: '币安', OKX: 'OKX', Bitget: 'Bitget', Hyperliquid: 'Hyperliquid' };
    const reasons = { source_policy: '来源策略暂停', source_guard: '来源状态未通过检查', http_403: '来源拒绝访问 403', http_429: '来源限流 429', source_rate_limit: '来源限流' };
    const results = { success: '流程已完成', failure: '流程失败', cancelled: '流程取消', skipped: '本轮未采集', stopped: '采集暂停', unknown: '执行情况未知' };
    box.textContent = '自动更新记录 ' + date(data.recordedAt) + ' · ' + Object.entries(names).map(([key, name]) => {
      const item = data.platforms[key] || {};
      return name + '：' + (results[item.outcome] || results.unknown) + (item.outcome === 'stopped' && reasons[item.stopReason] ? '：' + reasons[item.stopReason] : '') + '（上次流程完成 ' + date(item.lastCompletedAt) + '，资料时间 ' + date(item.dataAt) + '）';
    }).join('；');
  }).catch(() => { box.textContent = '自动更新状态暂不可用；请查看各账户的资料时间。'; });
})();
