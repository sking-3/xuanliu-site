(function (root) {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';
  const WIDTH = 960;
  const HEIGHT = 192;
  const INSET = 6;
  const DAY = 86400000;
  const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
  const fullTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const dayLabel = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  });
  const yearLabel = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const clockLabel = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const exactNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 20 });
  const axisNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
  let instances = 0;

  function datedPoints(points) {
    const unique = new Map();
    for (const point of Array.isArray(points) ? points : []) {
      if (!point || !Number.isFinite(point.value)) continue;
      const sourceTime = point.time;
      const time = typeof sourceTime === 'string' && isoTime.test(sourceTime)
        ? Date.parse(sourceTime) : sourceTime;
      if (!Number.isInteger(time) || !Number.isFinite(new Date(time).getTime())) continue;
      if (!unique.has(time)) unique.set(time, point.value);
      else if (unique.get(time) !== point.value) unique.set(time, null);
    }
    return Array.from(unique, ([time, value]) => ({ time, value }))
      .filter(point => point.value !== null)
      .sort((a, b) => a.time - b.time);
  }

  function nearestIndex(points, time) {
    let left = 0;
    let right = points.length - 1;
    while (left < right) {
      const middle = (left + right) >> 1;
      if (points[middle].time < time) left = middle + 1;
      else right = middle;
    }
    return left && time - points[left - 1].time <= points[left].time - time ? left - 1 : left;
  }

  function html(doc, tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function svg(doc, tag, attributes) {
    const element = doc.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  }

  function pointNumber(value, unit) {
    const formatted = exactNumber.format(value);
    const digits = Number(formatted.replaceAll(',', '')) === value ? formatted : String(value);
    return (value > 0 ? '+' : '') + digits + (unit === '%' ? '%' : ' ' + unit);
  }

  function pointTime(time) {
    const milliseconds = new Date(time).getUTCMilliseconds();
    const fraction = milliseconds ? '.' + String(milliseconds).padStart(3, '0') : '';
    return fullTime.format(time) + fraction + '（北京）';
  }

  function ticks(doc, chart, y, low, high) {
    const axis = html(doc, 'div', 'dpc-axis');
    axis.setAttribute('aria-hidden', 'true');
    const values = low === high ? [0] : low < 0 && high > 0 ? [low, 0, high] : [low, high];
    for (const value of values) {
      const position = y(value);
      chart.append(svg(doc, 'line', {
        x1: 0, y1: position, x2: WIDTH, y2: position,
        class: value === 0 ? 'dpc-zero' : 'dpc-grid-line',
        'vector-effect': 'non-scaling-stroke',
      }));
      const text = axisNumber.format(value);
      const label = html(doc, 'span', 'dpc-axis-label', Number(text) === 0 && value ? value.toExponential(1) : text);
      label.style.top = `${position / HEIGHT * 100}%`;
      axis.append(label);
    }
    return axis;
  }

  function drawSeries(doc, chart, points, x, y) {
    const baseline = y(0);
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.time).toFixed(3)} ${y(point.value).toFixed(3)}`).join(' ');
    const area = `${line} L${x(points.at(-1).time)} ${baseline} L${x(points[0].time)} ${baseline} Z`;
    const defs = svg(doc, 'defs', {});
    const id = `dpc-${++instances}`;
    const sides = [
      { name: 'up', start: 0, height: baseline },
      { name: 'down', start: baseline, height: HEIGHT - baseline },
    ];
    for (const side of sides) {
      const clip = svg(doc, 'clipPath', { id: `${id}-${side.name}` });
      clip.append(svg(doc, 'rect', { x: 0, y: side.start, width: WIDTH, height: side.height }));
      defs.append(clip);
      const group = svg(doc, 'g', { class: `dpc-${side.name}`, 'clip-path': `url(#${id}-${side.name})` });
      group.append(
        svg(doc, 'path', { d: area, class: 'dpc-area' }),
        svg(doc, 'path', { d: line, class: 'dpc-line', 'vector-effect': 'non-scaling-stroke' }),
      );
      chart.append(group);
    }
    chart.prepend(defs);
  }

  function mount(container, samples, options = {}) {
    const points = datedPoints(samples);
    if (points.length < 2) return false;

    const doc = container.ownerDocument;
    const first = points[0].time;
    const last = points.at(-1).time;
    let low = 0;
    let high = 0;
    for (const point of points) {
      low = Math.min(low, point.value);
      high = Math.max(high, point.value);
    }
    const scale = Math.max(Math.abs(low), Math.abs(high)) || 1;
    const span = (high / scale - low / scale) || 1;
    const x = time => INSET + (time - first) / (last - first) * (WIDTH - 2 * INSET);
    const y = value => low === high ? HEIGHT / 2 : INSET + (high / scale - value / scale) / span * (HEIGHT - 2 * INSET);
    const unit = options.unit || 'USD';
    const chartRoot = html(doc, 'div', 'dpc');
    if (low === high) chartRoot.dataset.flat = 'true';
    const readout = html(doc, 'div', 'dpc-readout');
    const value = html(doc, 'strong', 'dpc-value');
    const time = html(doc, 'time', 'dpc-time');
    readout.append(value, time);
    const board = html(doc, 'div', 'dpc-board');
    const plot = html(doc, 'div', 'dpc-plot');
    const chart = svg(doc, 'svg', {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'none', 'aria-hidden': 'true',
    });
    const axis = ticks(doc, chart, y, low, high);
    drawSeries(doc, chart, points, x, y);
    const focusLine = svg(doc, 'line', {
      y1: 0, y2: HEIGHT, class: 'dpc-rule', 'vector-effect': 'non-scaling-stroke',
    });
    chart.append(focusLine);
    const marker = html(doc, 'span', 'dpc-marker');
    marker.setAttribute('aria-hidden', 'true');
    const scrubber = html(doc, 'input', 'dpc-scrubber');
    scrubber.type = 'range';
    scrubber.min = '0';
    scrubber.max = String(points.length - 1);
    scrubber.step = '1';
    scrubber.setAttribute('aria-label', `${options.label || '表现曲线'}，用左右方向键查看采样`);
    plot.append(chart, marker, scrubber);
    board.append(plot, axis);
    const dates = html(doc, 'div', 'dpc-dates');
    dates.setAttribute('aria-hidden', 'true');
    const wholeYear = yearLabel.format(first).slice(0, 4) !== yearLabel.format(last).slice(0, 4);
    const sameDay = last - first < DAY && dayLabel.format(first) === dayLabel.format(last);
    const shortTime = wholeYear ? yearLabel : sameDay ? clockLabel : dayLabel;
    dates.append(html(doc, 'span', '', shortTime.format(first)), html(doc, 'span', '', shortTime.format(last)));
    chartRoot.append(readout, board, dates);

    let active = -1;
    function select(index) {
      if (active === index) return;
      active = index;
      const point = points[index];
      const cx = x(point.time);
      const cy = y(point.value);
      const direction = point.value > 0 ? 'up' : point.value < 0 ? 'down' : 'flat';
      chartRoot.dataset.direction = direction;
      value.textContent = pointNumber(point.value, unit);
      time.textContent = pointTime(point.time);
      time.dateTime = new Date(point.time).toISOString();
      marker.style.left = `${cx / WIDTH * 100}%`;
      marker.style.top = `${cy / HEIGHT * 100}%`;
      focusLine.setAttribute('x1', cx);
      focusLine.setAttribute('x2', cx);
      scrubber.value = String(index);
      scrubber.setAttribute('aria-valuetext', `${time.textContent}，${value.textContent}`);
    }
    function inspect(event) {
      const rect = plot.getBoundingClientRect();
      if (!rect.width) return;
      const fraction = ((event.clientX - rect.left) / rect.width * WIDTH - INSET) / (WIDTH - 2 * INSET);
      select(nearestIndex(points, first + fraction * (last - first)));
    }
    plot.addEventListener('pointermove', event => {
      if (event.pointerType === 'mouse' || event.buttons === 1) inspect(event);
    });
    plot.addEventListener('pointerdown', inspect);
    scrubber.addEventListener('input', () => select(scrubber.valueAsNumber));
    select(points.length - 1);
    container.append(chartRoot);
    return true;
  }

  root.BooksDetailPerformanceCurve = Object.freeze({ mount });
})(globalThis);
