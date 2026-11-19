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

  const curveLabels = {
    Binance: '币安原始盈亏采样',
    OKX: 'OKX 来源收益率日采样',
    Bitget: 'Bitget 来源收益率日采样',
    Hyperliquid: 'Hyperliquid 永续盈亏采样',
  };

  function score({ exchange, metrics, performanceAt, curve, capital, leverage, winSample } = {}) {
    const window = metrics || {};
    const sampled = exchange === 'Hyperliquid';
    const okx = exchange === 'OKX';
    const time = window.lastSuccessAt || window.fetchedAt || performanceAt ||
      (window.asOfType === 'observed' ? window.asOf : null);
    const metricTimes=window.metricTimes||{};
    const sourceAt = window.sourceAsOf || (window.asOfType === 'observed' ? null : window.asOf);
    const shortHistory = window.fullPeriod === false && Number.isFinite(window.accountAgeDays);
    const partialSample = window.derived && ['sampled_boundary', 'insufficient_history'].includes(window.coverageStatus);
    const roi = savedNumber(window.roi), drawdown = savedNumber(window.mdd);
    const win = savedNumber(winSample ? winSample.value : window.winRate);
    const aum = savedNumber(capital?.aumAmount), averageLeverage = savedNumber(leverage?.average);
    const currency = capital?.currency || window.currency;
    const usableDrawdown = drawdown !== null && drawdown >= 0;
    const usableWin = win !== null && win >= 0 && win <= 100;
    const usableAum = aum !== null && aum >= 0 && moneyUnits.has(currency);
    const usableLeverage = averageLeverage !== null && averageLeverage > 0 &&
      Number.isInteger(leverage?.count) && leverage.count > 0;
    const points = curve?.points;
    const cumulative = (curve?.basis||window.curveBasis)==='account_cumulative';
    const dailyDirection = cumulative&&(curve?.trendBasis||window.trendBasis)==='cumulative_daily_direction';
    const contiguous = !dailyDirection||!points?.some((point,index)=>index>0&&
      savedTime(point.time)-savedTime(points[index-1].time)!==86400000);
    const trend = contiguous?trendScore(points):null;
    const pct = value => numberFormat.format(value) + '%';
    const row = (label, points, raw, time, method, source, evidence = {}) => {
      const blocked = Boolean(evidence.periodBound && (shortHistory || partialSample));
      return {
        label, score: blocked ? null : points, raw, time: savedTime(time), method, source: source || '',
        blocked, limit: evidence.limit, sourceAt: savedTime(evidence.sourceAt), sampleRange: evidence.sampleRange || [],
      };
    };

    return [
      row('收益率', roi === null ? null : clampScore(50 + roi / 2), roi === null ? null : pct(roi), metricTimes.roi?.observedAt||time,
        '50 加收益率百分点的一半，四舍五入后限制为 0–100 分。',
        window.coverageLabel || (window.derived ? 'Hyperliquid 已对账区间收益率' : '来源所选周期收益率'),
        { periodBound: true, sourceAt:metricTimes.roi?.sourceAt||sourceAt, limit: roi > 100 ? '封顶' : roi < -100 ? '触底' : '' }),
      row(sampled ? '采样回撤' : '回撤控制', usableDrawdown ? clampScore(100 - drawdown) : null,
        usableDrawdown ? pct(drawdown) : null, metricTimes.mdd?.observedAt||(sampled ? curve?.lastSuccessAt : time),
        '100 减所列来源回撤百分点。', sampled ? '永续采样盈亏回撤' : '来源回撤',
        { periodBound: true, sourceAt:metricTimes.mdd?.sourceAt||(sampled ? points?.at(-1)?.time : sourceAt),
          sampleRange: metricTimes.mdd?.kind==='sample'&&metricTimes.mdd?.startAt&&metricTimes.mdd?.endAt ? [savedTime(metricTimes.mdd.startAt),savedTime(metricTimes.mdd.endAt)] : sampled && points?.length ? [savedTime(points[0].time),savedTime(points.at(-1).time)] : [] }),
      row(sampled ? '片段胜率' : okx ? '盈利日比例' : '胜率', usableWin ? clampScore(win) : null,
        usableWin ? pct(win) : null, metricTimes.winRate?.observedAt||(winSample ? winSample.fetchedAt : window.winRateEvidence?.lastSuccessAt || time),
        '按来源比例，每 1 个百分点计 1 分。',
        winSample?.label || (okx ? 'OKX 盈利日比例' : exchange === 'Binance' ? '币安已平仓仓位胜率' : '来源胜率'),
        { periodBound: !sampled, sourceAt: metricTimes.winRate?.sourceAt||(sampled || okx ? null : sourceAt),
          sampleRange:metricTimes.winRate?.kind==='sample'?[savedTime(metricTimes.winRate.startAt),savedTime(metricTimes.winRate.endAt)]:[] }),
      row('资金规模', usableAum ? clampScore(20 * (Math.log10(Math.max(1, aum)) - 3)) : null,
        usableAum ? numberFormat.format(aum) + ' ' + currency : null, capital?.fetchedAt,
        '管理规模达到 1 千为 0 分，此后每增 10 倍加 20 分，1 亿为 100 分。',
        usableAum ? '公开组合资料 · 管理规模 AUM' : undefined),
      row('上行一致性', trend, trend === null ? null : points.length + (dailyDirection?' 个日点 · 累计日点方向':' 个采样点'), curve?.lastSuccessAt,
        (dailyDirection?'仅衡量所选窗口内累计日点方向，终值不代表同期收益；不填补缺失日点。':'')+
        '正向净变化除以相邻采样绝对变化总和，再乘 100。至少 7 点，'+(dailyDirection?'日点须连续。':'最大间隔不得超过中位间隔的 3 倍。'),
        points?.length ? (dailyDirection?'来源累计收益率（日点） · 累计日点方向':curveLabels[exchange] || '来源盈亏采样') : undefined,
        { periodBound: true, sampleRange: trend === null ? [] : [savedTime(points[0].time), savedTime(points.at(-1).time)] }),
      row('杠杆控制', usableLeverage ? clampScore(100 - 5 * (averageLeverage - 1)) : null,
        usableLeverage ? numberFormat.format(averageLeverage) + '× · ' + leverage.count + ' 笔' : null, leverage?.fetchedAt,
        '历史有杠杆字段的平仓样本取等权均值。1× 为 100 分，每增加 1× 扣 5 分。',
        usableLeverage ? '已归档平仓样本' : undefined),
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
        const dates=axis.sampleRange.length?timeRange(axis.sampleRange,timeFormat):
          axis.sourceAt!==null?timeFormat.format(axis.sourceAt):
          axis.time!==null?'核对 '+timeFormat.format(axis.time):'';
        if(dates)reading.append(element('small',dates+'（北京）','bdr-raw'));

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


  function mountPerformance(target, data, renderCurve) {
    const document = target.ownerDocument;
    const radar = document.createElement('section');
    radar.className = 'ta-analysis-section detail-performance-panel';
    const updateRadar = curve => {
      radar.replaceChildren();
      mount(radar, { ...data, curve });
    };
    updateRadar(data.curve);
    const panels = document.createElement('div');
    panels.className = 'ta-analysis-visuals detail-performance-visuals';
    const profit = document.createElement('section');
    profit.className = radar.className;
    panels.append(radar, profit);
    target.append(panels);
    if (renderCurve) renderCurve(profit, updateRadar);
    else {
      const title = document.createElement('h3');
      title.textContent = '来源盈亏曲线';
      const message = document.createElement('p');
      message.className = 'detail-performance-note';
      message.textContent = '暂无此周期的已核验曲线。';
      profit.append(title, message);
    }
  }

  return { score, mount, mountPerformance };
});
