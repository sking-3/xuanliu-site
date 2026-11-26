(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.BooksUsTaskStatus = api;
    if (root.document) api.mount(root);
  }
})(globalThis, function () {
  'use strict';
  const statuses = { not_started: '尚未运行', already_running: '已有任务运行', collecting: '采集中', computing: '计算中', ready: '已完成', complete: '已完成', idle: '已有最新批次', waiting_source: '等待来源更新', source_pending: '等待可用来源', source_blocked: '来源已停止', error: '本轮失败' };
  const phases = { universe: '读取名册', daily_bars: '日线采集', tracking: '后续跟踪', fundamentals: '财报核对', fundamentals_universe: '财报名册', fundamentals_complete: '财报核对完成', complete: '完成' };
  const active = value => ['collecting', 'computing'].includes(value);
  const finite = Number.isFinite;

  function stamp(value) {
    if (!value) return '未提供';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    return finite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) + ' 北京' : '未提供';
  }

  function progressText(value) {
    const progress = value.progress && typeof value.progress === 'object' ? value.progress : value;
    const processed = finite(progress.processed) ? progress.processed : progress.completed;
    const total = finite(progress.total) ? progress.total : finite(progress.expected) ? progress.expected : value.expected;
    const parts = [];
    if (progress.phase) parts.push(phases[progress.phase] || progress.phase);
    if (finite(processed) && finite(total) && total > 0) parts.push(processed.toLocaleString('zh-CN') + '/' + total.toLocaleString('zh-CN'));
    return parts.join(' · ');
  }

  function lines(value) {
    const result = [];
    result.push('本轮：' + (statuses[value.status] || value.status || '状态待核') + (value.targetDate ? ' · 目标交易日 ' + value.targetDate : '') + (progressText(value) ? ' · ' + progressText(value) : ''));
    if (value.message) result.push(String(value.message));
    const counts = [];
    if (finite(value.covered)) counts.push('有效 ' + value.covered.toLocaleString('zh-CN') + '只');
    if (finite(value.missing)) counts.push('缺失 ' + value.missing.toLocaleString('zh-CN') + '只');
    if (finite(value.candidates)) counts.push('观察候选 ' + value.candidates.toLocaleString('zh-CN') + '只');
    if (counts.length) result.push(counts.join(' · '));
    if (value.fundamentalsProgress) result.push('公开财报：' + (progressText(value.fundamentalsProgress) || '核对中'));
    const failures = Array.isArray(value.fundamentalsFailures) ? value.fundamentalsFailures : [];
    if (value.fundamentalsStatus === 'partial' || failures.length) result.push('公开财报部分失败：' + failures.length + '项；有效短线批次仍独立保留');
    else if (value.fundamentalsStatus === 'unavailable') result.push('公开财报暂不可用；短线批次状态单独核验');
    for (const failure of failures) result.push('财报原因：' + (typeof failure === 'string' ? failure : [failure.symbol || failure.source, failure.reason || failure.message].filter(Boolean).join('：')));
    const success = value.lastSuccess;
    result.push(success ? '最近成功：数据日 ' + stamp(success.asOf) + ' · 发布 ' + stamp(success.generatedAt) : '最近成功：尚无已发布的完整美股批次');
    if (value.error || value.failureReason) result.push('失败原因：' + String(value.error || value.failureReason) + (value.failedAt ? ' · ' + stamp(value.failedAt) : '') + '；保留上次成功结果');
    if (value.sourceHold) result.push('来源停止：' + (value.sourceHold.reason || '来源拒绝访问') + ' · ' + stamp(value.sourceHold.stoppedAt));
    if (value.schedule) result.push('自动计划：' + String(value.schedule));
    if (value.updatedAt) result.push('状态时间：' + stamp(value.updatedAt));
    return result;
  }

  function mount(env = globalThis) {
    const doc = env.document, panel = doc.getElementById('us-task-status'), refreshButton = doc.getElementById('us-task-refresh');
    if (!panel || !refreshButton) return null;
    const state = { data: null, error: '', reading: false, readAt: null, closed: false, sequence: 0, timer: null, request: null };

    function render() {
      const messages = [];
      if (state.error) messages.push('状态读取失败：' + state.error + (state.data ? '；保留上次显示，其他控制台功能不受影响。' : '；其他控制台功能不受影响。'));
      if (state.data) messages.push(...lines(state.data));
      if (!messages.length) messages.push('正在读取美股任务状态…');
      if (state.readAt) messages.push('页面读取：' + stamp(state.readAt));
      panel.replaceChildren(...messages.map(message => { const p = doc.createElement('p'); p.className = 'hint'; p.textContent = message; return p; }));
      refreshButton.disabled = state.reading;
      refreshButton.textContent = state.reading ? '读取中…' : '刷新状态';
    }

    function cancelTimer() { if (state.timer !== null) env.clearTimeout(state.timer); state.timer = null; }

    async function refresh() {
      if (state.closed || doc.hidden || state.reading) return;
      cancelTimer(); state.reading = true; state.error = ''; const sequence = ++state.sequence;
      const controller = new AbortController(); state.request = controller;
      const deadline = env.setTimeout(() => controller.abort(), 12000);
      render();
      try {
        const response = await env.fetch('/api/us-selection/state', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) throw Error('HTTP ' + response.status);
        const value = await response.json();
        if (!value || typeof value !== 'object' || typeof value.status !== 'string') throw Error('任务状态格式异常');
        if (sequence !== state.sequence || state.closed) return;
        state.data = value; state.readAt = new Date().toISOString();
      } catch (error) {
        if (sequence !== state.sequence || state.closed) return;
        state.error = error.name === 'AbortError' ? '请求已取消或超时，请刷新状态重试' : error.message;
      } finally {
        env.clearTimeout(deadline);
        if (sequence === state.sequence) {
          state.reading = false; state.request = null; render();
          if (!state.closed && !doc.hidden) state.timer = env.setTimeout(refresh, active(state.data?.status) ? 15000 : 60000);
        }
      }
    }

    refreshButton.addEventListener('click', refresh);
    doc.addEventListener('visibilitychange', () => {
      cancelTimer();
      if (doc.hidden) {
        state.sequence++; state.request?.abort(); state.request = null; state.reading = false;
      } else refresh();
    });
    env.addEventListener('pagehide', () => { state.closed = true; state.sequence++; cancelTimer(); state.request?.abort(); });
    const ready = refresh();
    return { state, ready, refresh };
  }

  return { lines, progressText, stamp, mount };
});
