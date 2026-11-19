/* Scores describe the available source snapshots only. Missing axes have no point. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksDetailRadar = api;
})(globalThis, function () {
  'use strict';

  const svgNamespace = 'http://www.w3.org/2000/svg';
  const moneyUnits = new Set(['USD', 'USDT', 'USDC']);
  const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const timeOptions = {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  };
  const timeFormat = new Intl.DateTimeFormat('zh-CN', timeOptions);
  const exactTime = new Intl.DateTimeFormat('zh-CN', { ...timeOptions, second: '2-digit' });

  function savedNumber(value) {
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    return Number.isFinite(value) ? value : null;
  }

  function savedTime(value) {
    if (typeof value === 'string') value = Date.parse(value);
    return Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : null;
  }

  function timeRange(times, format) {
    if (times.length === 0) return '';
    const first = format.format(Math.min(...times));
    const last = format.format(Math.max(...times));
    return first === last ? first : first + ' 至 ' + last;
  }

  function clampScore(value) {
    return Math.min(100, Math.max(0, Math.round(value)));
  }

  function trendScore(points) {
    if (!Array.isArray(points) || points.length < 7) return null;
    const gaps = [];
    let previousTime = null;
    let previousValue = null;
    let distance = 0;
    for (const point of points) {
      const time = savedTime(point?.time);
      const value = savedNumber(point?.value);
      if (time === null || value === null || (previousTime !== null && time <= previousTime)) return null;
      if (previousTime !== null) {
        gaps.push(time - previousTime);
        distance += Math.abs(value - previousValue);
      }
      previousTime = time;
      previousValue = value;
    }
    const orderedGaps = [...gaps].sort((a, b) => a - b);
    const typicalGap = orderedGaps[Math.floor(orderedGaps.length / 2)];
    if (!Number.isFinite(distance) || distance === 0 || orderedGaps.at(-1) > 3 * typicalGap) return null;
    return clampScore(100 * Math.max(0, previousValue - savedNumber(points[0].value)) / distance);
  }

  function score(input = {}) {
    const roi = savedNumber(input.roi);
    const drawdown = savedNumber(input.mdd);
    const win = savedNumber(input.winRate);
    const aum = savedNumber(input.aum);
    const leverage = savedNumber(input.leverage);
    const usableDrawdown = drawdown !== null && drawdown >= 0;
    const usableWin = win !== null && win >= 0 && win <= 100;
    const usableAum = aum !== null && aum >= 0 && moneyUnits.has(input.currency);
    const usableLeverage = leverage !== null && leverage > 0 &&
      Number.isInteger(input.leverageCount) && input.leverageCount > 0;
    const trend = trendScore(input.points);
    const metricTime = savedTime(input.metricsAt);
    const pct = value => numberFormat.format(value) + '%';
    const row = (label, points, raw, time, method, source, evidence = {}) => {
      const excluded = evidence.periodBound && input.periodQualified === false;
      return {
        label, score: excluded ? null : points, raw, time: savedTime(time), method, source: source || '',
        blocked: Boolean(excluded), limit: evidence.limit, sourceAt: savedTime(evidence.sourceAt),
        sampleRange: evidence.sampleRange || [],
      };
    };

    return [
      row('收益率', roi === null ? null : clampScore(50 + roi / 2), roi === null ? null : pct(roi), metricTime,
        '所选区间收益率每增加 2 个百分点加 1 分。0% 为 50 分，100% 起计 100 分。', input.roiLabel,
        { periodBound: true, sourceAt: input.metricsAsOf, limit: roi > 100 ? '封顶' : roi < -100 ? '触底' : '' }),
      row(input.drawdownAxisLabel || '回撤控制', usableDrawdown ? clampScore(100 - drawdown) : null, usableDrawdown ? pct(drawdown) : null,
        Object.hasOwn(input, 'drawdownAt') ? input.drawdownAt : metricTime,
        '100 减所列来源回撤百分点。', input.mddLabel,
        { periodBound: true, sourceAt: input.drawdownAsOf }),
      row(input.winAxisLabel || '胜率', usableWin ? clampScore(win) : null, usableWin ? pct(win) : null,
        Object.hasOwn(input, 'winAt') ? input.winAt : metricTime,
        '按来源比例，每 1 个百分点计 1 分。', input.winLabel,
        { periodBound: !input.winIndependent, sourceAt: input.winAsOf }),
      row('资金规模', usableAum ? clampScore(20 * (Math.log10(Math.max(1, aum)) - 3)) : null,
        usableAum ? numberFormat.format(aum) + ' ' + input.currency : null, input.aumAt,
        '管理规模达到 1 千为 0 分，此后每增 10 倍加 20 分，1 亿为 100 分。', input.aumLabel),
      row('上行一致性', trend, trend === null ? null : input.points.length + ' 个采样点', input.curveAt,
        '正向净变化除以相邻采样绝对变化总和，再乘 100。至少 7 点，最大间隔不得超过中位间隔的 3 倍。', input.curveLabel,
        { periodBound: true, sampleRange: trend === null ? [] : [savedTime(input.points[0].time), savedTime(input.points.at(-1).time)] }),
      row('杠杆控制', usableLeverage ? clampScore(100 - 5 * (leverage - 1)) : null,
        usableLeverage ? numberFormat.format(leverage) + '× · ' + input.leverageCount + ' 笔' : null, input.leverageAt,
        '历史有杠杆字段的平仓样本取等权均值。1× 为 100 分，每增加 1× 扣 5 分。', input.leverageLabel),
    ];
  }

  function draw(document, axes) {
    const centerX = 152;
    const centerY = 86;
    const radius = 56;
    const location = (index, scale) => {
      const angle = (-90 + 60 * index) * Math.PI / 180;
      return [centerX + radius * scale * Math.cos(angle), centerY + radius * scale * Math.sin(angle)];
    };
    function shape(name, className, attributes) {
      const node = document.createElementNS(svgNamespace, name);
      node.setAttribute('class', className);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      return node;
    }
    const chart = shape('svg', 'bdr-chart', { viewBox: '0 0 304 172', 'aria-hidden': 'true' });
    const polygon = (ratios, className) => shape('polygon', className, {
      points: ratios.map((ratio, i) => location(i, ratio).join(',')).join(' '),
    });
    for (const ring of [1, .75, .5, .25]) chart.append(polygon(axes.map(() => ring), 'bdr-grid'));
    axes.forEach((axis, i) => {
      const [x, y] = location(i, 1);
      const [labelX, labelY] = location(i, 1.30);
      const available = axis.score !== null;
      chart.append(shape('line', available ? 'bdr-axis' : 'bdr-axis bdr-axis-missing',
        { x1: centerX, y1: centerY, x2: x, y2: y }));
      const label = shape('text', available ? 'bdr-label' : 'bdr-label bdr-label-missing', {
        x: labelX, y: labelY, 'dominant-baseline': 'central',
        'text-anchor': i === 0 || i === 3 ? 'middle' : i < 3 ? 'start' : 'end',
      });
      label.textContent = axis.label;
      chart.append(label);
    });
    const spots = axes.map((axis, i) => axis.score === null ? null : location(i, axis.score / 100));
    if (spots.every(Boolean)) {
      chart.append(polygon(axes.map(axis => axis.score / 100), 'bdr-area'));
    } else {
      spots.forEach((spot, i) => {
        if (spot && axes[i].score > 0) chart.append(shape('line', 'bdr-stem', { x1: centerX, y1: centerY, x2: spot[0], y2: spot[1] }));
      });
    }
    for (const spot of spots) {
      if (spot) chart.append(shape('circle', 'bdr-point', { cx: spot[0], cy: spot[1], r: 3.3 }));
    }
    return chart;
  }

  function mount(target, input = {}) {
    const document = target.ownerDocument;
    const axes = score(input);
    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    const panel = element('div', undefined, 'bdr-radar');
    const header = element('div', undefined, 'bdr-header');
    header.append(element('h3', '能力雷达图'));
    if (input.periodLabel) header.append(element('span', input.periodLabel));
    panel.append(header);
    const available = axes.filter(axis => axis.score !== null);
    const snapshots = timeRange(available.map(axis => axis.time).filter(time => time !== null), timeFormat);
    const meta = [available.length + '/' + axes.length + ' 项已评分'];
    if (available.length) meta.push(snapshots ? '快照 ' + snapshots + '（北京）' : '快照时间未提供');
    panel.append(element('p', meta.join(' · '), 'bdr-meta'));
    if (available.length) panel.append(draw(document, axes));
    else panel.append(element('p', '暂无可用于评分的资料。', 'bdr-empty'));

    const legend = element('dl', undefined, 'bdr-legend');
    for (const axis of axes) {
      const row = element('div', undefined, 'bdr-score');
      row.setAttribute('data-available', String(axis.score !== null));
      const reading = element('dd');
      if (axis.score === null) reading.textContent = axis.blocked ? '覆盖不足' : '暂无评分';
      else {
        const points = element('strong', String(axis.score) + ' 分');
        const raw = element('small', [axis.raw, axis.limit].filter(Boolean).join(' · '), 'bdr-raw');
        reading.append(points, raw);
      }
      row.append(element('dt', axis.label), reading);
      legend.append(row);
    }
    panel.append(legend);

    const details = element('details', undefined, 'bdr-method');
    details.append(element('summary', '评分口径与各项快照'));
    details.append(element('p', '各项按 0–100 分计，取整数并限制在量尺范围内。请按同来源、同口径和同覆盖区间对照同一维度。'));
    const definitions = element('dl');
    for (const axis of axes) {
      definitions.append(element('dt', axis.label));
      const parts = [axis.raw, axis.source,
        axis.raw !== null ? (axis.time !== null ? '采集 ' + exactTime.format(axis.time) + '（北京）' : '采集时间未提供') : '',
        axis.raw !== null && axis.sourceAt !== null && axis.sourceAt !== axis.time ? '数据截至 ' + exactTime.format(axis.sourceAt) + '（北京）' : '',
        axis.sampleRange.length ? '曲线采样 ' + timeRange(axis.sampleRange, exactTime) + '（北京）' : '',
        axis.blocked ? '资料未覆盖所选周期' : axis.score === null ? '暂无评分' : '', axis.method];
      definitions.append(element('dd', parts.filter(Boolean).join(' · ')));
    }
    details.append(definitions);
    panel.append(details);
    target.append(panel);
    return axes;
  }

  return { score, mount };
});
