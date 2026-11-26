(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.BooksUsSelection = api;
    if (root.document) api.mount(root);
  }
})(globalThis, function () {
  'use strict';

  const SCHEMA = 'books.us.selection.v1';
  const MODES = ['short', 'value', 'dca'];
  const finite = Number.isFinite;
  const reasonText = reason => typeof reason === 'string' ? reason : reason.message;
  const modeRows = (snapshot, mode) => snapshot ? (mode === 'short' ? snapshot.short : mode === 'value' ? snapshot.fundamentals : snapshot.dca).rows : [];
  const sectorNames = {
    'Information Technology': '信息技术', Technology: '信息技术', Semiconductors: '半导体',
    Financials: '金融', 'Health Care': '医疗保健', Industrials: '工业',
    'Consumer Discretionary': '可选消费', 'Consumer Staples': '必需消费',
    Communication: '通信服务', 'Communication Services': '通信服务', Energy: '能源',
    Utilities: '公用事业', Materials: '原材料', 'Real Estate': '房地产'
  };
  const sectorName = name => sectorNames[name] || name;
  const sectorLabels = { trough: '低谷条件成立', weak_price: '行情偏弱', weak_business: '经营承压', not_trough: '低谷条件未达', pending: '证据不足' };
  const sectorQualified = row => row.sectorValue?.state === 'confirmed_relative';

  function initialState() {
    return {
      mode: 'short', search: '', strategy: '', pageSize: 'all', page: 1,
      minPrice: 5, minTurnover: 10, minStrength: 0, shortStatus: '',
      valuePe: 20, valueFcf: 4, valueDebt: 3, valueStatus: 'low_multiple',
      dcaFee: .2, dcaYears: 3, dcaStatus: 'candidate',
      snapshot: null, progress: null, phase: 'loading', error: '', readAt: null,
      chartWindows: {}, chartErrors: {}, requestId: 0
    };
  }

  function validateSnapshot(value) {
    if (!value || value.schema !== SCHEMA || !value.short || !value.fundamentals || !value.dca) throw Error('结果格式未通过核验');
    for (const group of [value.short, value.fundamentals, value.dca]) {
      if (!Array.isArray(group.rows) || group.rows.some(row => !row || typeof row.symbol !== 'string' || !row.symbol)) throw Error('股票结果格式未通过核验');
    }
    return value;
  }

  function shortStatus(row) {
    if (row.phase === 'tracking' || row.isNewB === false && row.status === 'B') return 'tracking';
    if (row.status === 'B' || row.status === 'triggered') return 'triggered';
    if (row.status === 'invalid' || row.status === 'invalidated') return 'invalidated';
    if (row.status === 'overextended' || finite(row.close) && finite(row.maxEntry) && row.close > row.maxEntry) return 'overextended';
    return 'watch';
  }

  function strategyKey(row, mode) {
    return mode === 'short' ? row.rule : mode === 'value' ? row.sectorValue?.sector || row.industry : row.kind;
  }

  function filterRows(snapshot, state) {
    const search = state.search.trim().toLocaleLowerCase();
    return modeRows(snapshot, state.mode).filter(row => {
      if (search && !(row.symbol + ' ' + (row.name || '')).toLocaleLowerCase().includes(search)) return false;
      if (state.strategy && strategyKey(row, state.mode) !== state.strategy && !(state.mode === 'short' && row.hits?.some(hit => hit.rule === state.strategy))) return false;
      const metrics = row.metrics || {};
      if (state.mode === 'short') {
        if (!finite(row.close) || row.close < state.minPrice) return false;
        const turnover = finite(metrics.dollarVolume20) ? metrics.dollarVolume20 : metrics.dollarVolume20Proxy;
        if (finite(turnover) && turnover < state.minTurnover * 1e6) return false;
        if (finite(metrics.excess20Percent) && metrics.excess20Percent < state.minStrength) return false;
        return !state.shortStatus || shortStatus(row) === state.shortStatus;
      }
      if (state.mode === 'value') {
        if (state.valueStatus === 'candidate' && row.financialPassed !== true) return false;
        if (state.valueStatus === 'pending') return row.status === 'pending';
        if (state.valueStatus === 'excluded') return row.status === 'excluded';
        if (state.valueStatus === '') return true;
        if (state.valueStatus === 'relative_discount' && !sectorQualified(row)) return false;
        if (state.valueStatus === 'trough_value' && !(sectorQualified(row) && row.sectorValue.opportunity === true)) return false;
        if (state.valueStatus === 'low_multiple' && !(row.valuationStatus === 'low_multiple' && row.status === 'candidate' && row.financialPassed === true)) return false;
        if (finite(metrics.normalizedPe) && (metrics.normalizedPe <= 0 || metrics.normalizedPe > state.valuePe)) return false;
        if (finite(metrics.normalizedFcfYield) && metrics.normalizedFcfYield < state.valueFcf) return false;
        if (finite(metrics.netDebtToFcf) && metrics.netDebtToFcf > state.valueDebt) return false;
        return true;
      }
      if (state.dcaStatus && row.status !== state.dcaStatus) return false;
      if (state.dcaStatus !== 'candidate') return true;
      if (row.kind === 'etf') return !finite(metrics.expenseRatio) || metrics.expenseRatio <= state.dcaFee;
      return !finite(metrics.annualProfitYears) || metrics.annualProfitYears >= state.dcaYears;
    });
  }

  function reviewCounts(snapshot, mode) {
    const rows = modeRows(snapshot, mode);
    const candidate = row => mode === 'value' ? row.status === 'candidate' && row.financialPassed === true && row.valuationStatus === 'low_multiple' : row.status === 'candidate';
    return { candidate: rows.filter(candidate).length, pending: rows.filter(row => row.status === 'pending').length, excluded: rows.filter(row => row.status === 'excluded').length, all: rows.length };
  }

  function paginate(rows, pageSize, page) {
    const size = pageSize === 'all' ? Math.max(rows.length, 1) : Number(pageSize);
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const selected = Math.min(Math.max(page, 1), pages);
    return { rows: rows.slice((selected - 1) * size, selected * size), page: selected, pages, total: rows.length };
  }

  function number(value, digits = 2) {
    return finite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value) : '—';
  }

  function percent(value, signed = false) {
    return finite(value) ? (signed && value > 0 ? '+' : '') + number(value) + '%' : '待形成';
  }

  function money(value) {
    if (!finite(value)) return '—';
    if (Math.abs(value) >= 1e9) return number(value / 1e9) + '十亿美元';
    if (Math.abs(value) >= 1e6) return number(value / 1e6) + '百万美元';
    return number(value) + '美元';
  }

  function time(value) {
    if (!value) return '待核';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    if (!finite(date.getTime())) return '待核';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) + ' 北京';
  }

  function sourceUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function chartUrl(value, symbol, window) {
    try {
      const url = new URL(value, 'https://45-77-39-98.sslip.io');
      if (url.origin !== 'https://45-77-39-98.sslip.io' || url.pathname !== '/api/us-selection/chart' || url.searchParams.get('symbol') !== symbol || ![60, 120].includes(window)) return null;
      url.searchParams.set('window', String(window));
      return url.pathname + url.search;
    } catch { return null; }
  }

  function taskParts(task) {
    if (!task) return [];
    const names = { not_started: '尚未运行', collecting: '采集中', computing: '计算中', ready: '已完成', complete: '已完成', idle: '已有最新批次', waiting_source: '等待来源更新', source_pending: '等待可用来源', source_blocked: '来源已停止', error: '本轮失败' };
    const phases = { universe: '读取名册', daily_bars: '日线采集', tracking: '后续跟踪', fundamentals: '财报核对', complete: '完成' };
    const progress = task.progress && typeof task.progress === 'object' ? task.progress : task;
    const processed = finite(progress.processed) ? progress.processed : progress.completed;
    const total = finite(progress.total) ? progress.total : finite(progress.expected) ? progress.expected : task.expected;
    const parts = [];
    if (task.status) parts.push('任务 ' + (names[task.status] || task.status));
    if (progress.phase) parts.push('阶段 ' + (phases[progress.phase] || progress.phase));
    if (finite(processed) && finite(total) && total > 0) parts.push(number(processed, 0) + '/' + number(total, 0));
    if (typeof task.message === 'string' && task.message) parts.push(task.message);
    if (task.error || task.failureReason) parts.push('失败原因 ' + String(task.error || task.failureReason));
    const failures = Array.isArray(task.fundamentalsFailures) ? task.fundamentalsFailures : [];
    if (task.fundamentalsStatus === 'partial' || failures.length) parts.push('公开财报部分失败 · ' + failures.length + '项');
    else if (task.fundamentalsStatus === 'unavailable') parts.push('公开财报暂不可用');
    for (const failure of failures.slice(0, 3)) parts.push(typeof failure === 'string' ? failure : [failure.symbol || failure.source, failure.reason || failure.message].filter(Boolean).join('：'));
    if (failures.length > 3) parts.push('其余' + (failures.length - 3) + '项原因见研究控制台');
    return parts;
  }

  function etfLabel(style) {
    if (['dividend', 'dividend_quality'].includes(style)) return '红利风格ETF';
    if (['broad', 'broad_equity'].includes(style)) return '宽基ETF';
    return 'ETF研究';
  }

  function valueLabel(row) {
    if (row.status === 'pending') return '资料待核';
    if (sectorQualified(row)) return row.sectorValue.opportunity ? '低谷中的相对低估' : '相对低估';
    if (row.valuationStatus === 'low_multiple') {
      if (row.status === 'candidate' && row.financialPassed === true) return '低倍数候选';
      return row.status === 'excluded' ? '低倍数 · 财务未通过' : '低倍数 · 财务待核';
    }
    if (row.valuationStatus === 'not_low') return '估值未达低倍数条件';
    if (row.financialPassed === true) return '财务通过 · 估值待核';
    return row.status === 'excluded' ? '条件未通过' : '财报／估值待核';
  }

  function valueGaps(row) {
    const fields = (row.financialEvidence?.missingFields || []).map(field => field.label).filter(Boolean);
    const labels = {
      annual_period_missing: '多年年度口径未对齐', share_class_pending: '多类股票合计估值',
      sector_method_pending: '行业专用估值口径', share_count_pending: '可核验期末股数',
      financial_period_stale: '新鲜财报', price_permission_or_freshness_pending: '可用估值价格',
      price_before_latest_filing: '财报公开后的股价', collection_failed_retained: '本轮来源更新'
    };
    for (const issue of row.reasons || []) {
      if (labels[issue.code]) fields.push(labels[issue.code]);
      if (!row.financialEvidence && issue.code === 'financial_fields_missing') fields.push('同期间财务字段');
    }
    return [...new Set(fields)];
  }

  function sourceTimeLabel(source) {
    return source.sourceTimeKind === 'scheduled_regular_close' || source.id === 'tickflow-free-us-forward-v1' ? '收盘时点' : '源时间';
  }

  function mount(env = globalThis) {
    const doc = env.document, host = doc.getElementById('us-selection');
    if (!host) return null;
    const state = initialState();
    const get = id => doc.getElementById(id);
    const node = (tag, text, className) => {
      const element = doc.createElement(tag);
      if (text !== undefined && text !== null) element.textContent = String(text);
      if (className) element.className = className;
      return element;
    };

    function levels(items) {
      const list = node('dl', null, 'us-selection-levels');
      for (const [label, value] of items) {
        const cell = node('div');
        cell.append(node('dt', label), node('dd', value));
        list.append(cell);
      }
      return list;
    }

    function sources(items, metadata = {}) {
      const block = node('div', null, 'us-selection-sources');
      for (const item of items || []) {
        const url = sourceUrl(item.url);
        if (!url) continue;
        const link = node('a', item.name || '原始来源');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        block.append(link);
        if (item.asOf) block.append(node('span', '来源日期 ' + time(item.asOf)));
      }
      if (metadata.sourceTime) block.append(node('span', sourceTimeLabel(metadata) + ' ' + time(metadata.sourceTime)));
      if (metadata.readAt) block.append(node('span', '本站读取 ' + time(metadata.readAt)));
      return block;
    }

    function empty(target, title, message) {
      const block = node('div', null, 'us-selection-empty');
      block.append(node('strong', title), node('span', message));
      target.replaceChildren(block);
    }

    function followup(row) {
      const group = node('div', null, 'us-selection-tracking');
      const tracking = row.triggerFollowup;
      if (!tracking) {
        group.append(node('p', 'B触发后跟踪尚未生成，等待任务更新。'));
        return group;
      }
      if (tracking.status === 'not_triggered') {
        group.append(node('p', 'B尚未触发，收益待形成。触发样本0条。'));
        return group;
      }
      if (tracking.status === 'price_missing') {
        group.append(node('p', 'B触发收盘价记录不足，收益与回撤待核。'));
        return group;
      }
      const items = [];
      for (const horizon of ['1', '2', '3', '5', '15']) {
        const result = tracking.horizons?.[horizon];
        items.push(['B后' + horizon + '个交易日', result?.status === 'ready' ? percent(result.returnPercent, true) : result?.status === 'data_missing' ? '数据缺口' : '待形成']);
      }
      const three = tracking.horizons?.['3'];
      items.push(['B后3日最大不利变动', three?.status === 'ready' ? percent(three.maxAdversePercent, true) : '待形成']);
      items.push(['B后3日收盘回撤', three?.status === 'ready' ? percent(three.maxCloseDrawdownPercent, true) : '待形成']);
      items.push(['B后3日成熟样本', three?.status === 'ready' ? '1条' : '0条']);
      group.append(levels(items));
      group.append(node('p', 'B触发收盘 ' + time(tracking.referenceDate) + ' · 参考价 ' + number(tracking.referenceClose) + ' USD · 确认时间 ' + time(tracking.firstSeenAt) + ' · 本条触发观察1条；非实际成交收益。'));
      return group;
    }

    function observationReview(row) {
      const tracking = row.followup, details = node('details', null, 'us-selection-inline');
      details.append(node('summary', '首次观察后复盘 · 非B触发口径'));
      const items = [];
      for (const horizon of ['1', '2', '3', '5', '15']) {
        const result = tracking.horizons?.[horizon];
        items.push(['观察后' + horizon + '个交易日', result?.status === 'ready' ? percent(result.returnPercent, true) : result?.status === 'data_missing' ? '数据缺口' : '待形成']);
      }
      details.append(levels(items), node('p', '首次观察日 ' + time(tracking.referenceDate) + ' · 观察收盘 ' + number(tracking.referenceClose) + ' USD · 本条观察1条；与B触发后的统计分开。'));
      return details;
    }

    function chart(row) {
      const container = node('div');
      const heading = node('div', null, 'us-selection-chart-heading');
      heading.append(node('span', '日K · MA5 / MA20 · 收盘条件观察'));
      const select = node('select'); select.dataset.usChartWindow = row.symbol;
      select.setAttribute('aria-label', row.symbol + '日K显示范围');
      for (const window of [60, 120]) {
        const option = node('option', '近' + window + '个交易日'); option.value = String(window); select.append(option);
      }
      const window = state.chartWindows[row.symbol] || 60; select.value = String(window); heading.append(select);
      const figure = node('figure', null, 'us-selection-chart');
      const url = chartUrl(row.chartUrl, row.symbol, window), key = row.symbol + ':' + window;
      if (url && !state.chartErrors[key]) {
        const image = doc.createElement('img');
        image.src = url; image.alt = (row.name || row.symbol) + '近' + window + '个交易日日K、均线与B/S观察标记';
        image.loading = 'lazy'; image.decoding = 'async'; image.width = 960; image.height = 540;
        image.addEventListener('error', () => {
          state.chartErrors[key] = true;
          renderChartError(figure);
        }, { once: true });
        figure.append(image, node('figcaption', 'B：买入参考；S：卖出参考。日K显示窗口不是持有期，标记不代表实际成交。'));
      } else renderChartError(figure, url ? '日K暂未读取成功，更新结果后可重新核对。' : '本批日K尚未生成；等待真实日线采集完成。');
      container.append(heading, figure);
      return container;
    }

    function renderChartError(figure, message = '日K暂未读取成功，更新结果后可重新核对。') {
      figure.replaceChildren(node('div', message, 'us-selection-chart-empty'));
    }

    function companyDetails(row) {
      const details = node('details', null, 'us-selection-inline');
      details.append(node('summary', '公司、财报与核验详情'));
      const fundamental = state.snapshot.fundamentals.rows.find(item => item.symbol === row.symbol);
      const financial = fundamental || row;
      if (state.mode !== 'short' && row.name) details.append(node('p', row.name));
      if (row.description) details.append(node('p', row.description));
      if (financial.industry) details.append(node('p', '产业：' + financial.industry));
      if (fundamental || state.mode === 'value' || row.kind === 'stock') {
        const m = financial.metrics || {};
        details.append(levels([
          ['营业收入 · TTM', money(m.revenueTtm)], ['净利润 · TTM', money(m.netIncomeTtm)],
          ['自由现金流 · TTM', money(m.fcfTtm)], ['净负债／自由现金流', finite(m.netDebtToFcf) ? number(m.netDebtToFcf) + '倍' : '待核']
        ]));
        details.append(node('p', '财报期／TTM截至 ' + time(financial.asOf) + ' · 财报公开 ' + time(financial.filedAt)));
        details.append(node('p', '连续盈利 ' + (finite(m.annualProfitYears) ? m.annualProfitYears + '年' : '待核') + ' · 连续正自由现金流 ' + (finite(m.annualFcfYears) ? m.annualFcfYears + '年' : '待核')));
        if (state.mode === 'value') {
          if (financial.valuationStatus === 'not_low') details.append(node('p', '估值核验：未达低倍数条件。'));
          if (financial.valuationStatus === 'low_multiple') details.append(node('p', '估值核验：达到低倍数条件；财务与资料完整性另行核验。'));
          details.append(node('p', 'TTM市盈率 ' + (finite(m.pe) ? number(m.pe) + '倍' : '待核') + ' · TTM自由现金流收益率 ' + (finite(m.fcfYield) ? percent(m.fcfYield) : '待核')));
          if (financial.normalization) details.append(node('p', '中周期参考：取TTM与最近3个完整财年中位数中较低的利润、自由现金流计算；不是公允价值或已验证收益预测。'));
        }
      } else details.append(node('p', '本批尚无完整的公司财报记录，未据此认定低估。'));
      const reasons = financial === row ? row.reasons || [] : [...financial.reasons || [], ...row.reasons || []];
      if (state.mode !== 'value' && reasons.length) {
        const list = node('ul');
        for (const reason of new Set(reasons.map(reasonText))) list.append(node('li', reason));
        details.append(list);
      }
      if (row.followup) details.append(observationReview(row));
      details.append(sources(financial.sources, financial));
      return details;
    }

    function resultHeading(row, status, tone) {
      const header = node('header', null, 'us-selection-result-heading');
      const title = node('h3', row.name || row.symbol);
      title.append(node('span', row.symbol, 'us-selection-symbol'));
      const badge = node('span', status, 'us-selection-badge');
      if (tone) badge.dataset.tone = tone;
      header.append(title, badge);
      return header;
    }

    function shortCard(row) {
      const card = node('article', null, 'us-selection-result'); card.dataset.usSymbol = row.symbol;
      const status = shortStatus(row), labels = { triggered: '本批新B观察', tracking: 'B后跟踪', watch: '等待B触发', overextended: '超过追价上限', invalidated: '条件失效' };
      card.append(resultHeading(row, labels[status] + (row.qualified === true ? '' : ' · 未验证'), status === 'invalidated' ? 'negative' : status === 'overextended' ? 'warning' : null));
      card.append(levels([['参考收盘 · USD', number(row.close)], ['B 买入参考 >', number(row.trigger)], ['S 卖出参考 <', number(row.invalidation)], ['最高观察价', number(row.maxEntry)]]));
      const m = row.metrics || {};
      card.append(node('p', (row.label || row.rule || '规则待核') + ' · ' + (row.membership === 'new' ? '新入选' : row.membership === 'continuing' ? '持续观察' : '本批观察') + ' · 20日 ' + percent(m.return20Percent, true) + ' · 相对SPY ' + percent(m.excess20Percent, true) + ' · 量比 ' + number(m.rvol) + '倍', 'us-selection-reasons'));
      card.append(chart(row), followup(row), companyDetails(row));
      const date = node('p', '数据日 ' + time(row.asOf || state.snapshot.asOf), 'us-selection-sources');
      card.append(date, sources([], { ...state.snapshot.source, sourceTime: row.sourceTime || state.snapshot.source?.sourceTime, readAt: row.readAt || state.snapshot.source?.fetchedAt }));
      return card;
    }

    function valueCard(row) {
      const m = row.metrics || {};
      const evidence = node('div', null, 'us-value-evidence');
      const value = row.sectorValue;
      const facts = [];
      if (value?.sector) facts.push(sectorName(value.sector) + ' · ' + (sectorLabels[value.sectorState] || '景气待核'));
      if (value?.peerGroup && row.status === 'candidate') {
        const companyCount = value.peerGroup.memberCompanies;
        facts.push('SEC SIC ' + value.peerGroup.code + (finite(companyCount) ? ' · 同码样本 ' + companyCount + ' 家' : '') + ' · ' + number(value.peerCount, 0) + ' 家可比');
      }
      if (finite(value?.peDiscountPct)) facts.push('中周期 PE 折价 ' + percent(value.peDiscountPct) + '（同业中位 ' + number(value.peerMedianPe) + ' 倍）');
      if (finite(value?.fcfMultipleDiscountPct)) facts.push('市值／FCF 折价 ' + percent(value.fcfMultipleDiscountPct) + '（同业中位 ' + number(value.peerMedianPriceToFcf) + ' 倍）');
      if (facts.length) evidence.append(node('p', facts.join(' · '), 'us-sector-note'));
      const gaps = valueGaps(row);
      if (gaps.length) evidence.append(node('p', '待补 ' + gaps.join('、'), 'us-sector-note'));
      const reasons = [...new Set([
        ...(row.reasons || []).filter(reason => !gaps.length || reason.code !== 'financial_fields_missing').map(reasonText),
        ...(value?.reasons || [])
      ])];
      if (reasons.length) evidence.append(node('p', reasons.join('。'), 'us-sector-note'));
      if (row.status === 'candidate' && !sectorQualified(row) && !value?.reasons?.length) evidence.append(node('p', '财务与低倍数门槛已通过，同业折价待核。', 'us-sector-note'));
      if (value?.peerSymbols?.length) evidence.append(node('p', '可比样本 ' + value.peerSymbols.join('、'), 'us-sector-note'));
      return researchRow(row, '估值研究', valueLabel(row), [
        ['中周期PE', finite(m.normalizedPe) ? number(m.normalizedPe) + '倍' : '待核'],
        ['中周期FCF收益率', finite(m.normalizedFcfYield) ? percent(m.normalizedFcfYield) : '待核'],
        ['净负债／FCF', finite(m.netDebtToFcf) ? number(m.netDebtToFcf) + '倍' : '待核'],
        ['年度营收同比', finite(m.annualRevenueGrowthPct) ? percent(m.annualRevenueGrowthPct, true) : '待核']
      ], evidence);
    }

    function dcaCard(row) {
      const etf = row.kind === 'etf', label = etf ? etfLabel(row.style) : '长期个股研究';
      const m = row.metrics || {};
      return researchRow(row, label, row.status === 'candidate' ? '条件通过' : row.status === 'excluded' ? '条件未通过' : '资料待核', etf ? [
        ['年费率', finite(m.expenseRatio) ? percent(m.expenseRatio) : '待核'], ['持仓数量', finite(m.holdingsCount) ? number(m.holdingsCount, 0) : '待核'],
        ['前十大占比', finite(m.top10Weight) ? percent(m.top10Weight) : '待核'], ['组合市盈率', finite(m.portfolioPe) ? number(m.portfolioPe) + '倍' : '待核']
      ] : [
        ['连续盈利', finite(m.annualProfitYears) ? m.annualProfitYears + '年' : '待核'], ['连续正自由现金流', finite(m.annualFcfYears) ? m.annualFcfYears + '年' : '待核'],
        ['中周期PE', finite(m.normalizedPe) ? number(m.normalizedPe) + '倍' : '待核'], ['中周期FCF收益率', finite(m.normalizedFcfYield) ? percent(m.normalizedFcfYield) : '待核']
      ]);
    }

    function researchRow(row, label, status, items, evidence) {
      const card = node('article', null, 'us-research-row'); card.dataset.usSymbol = row.symbol;
      const identity = node('header', null, 'us-research-identity');
      const title = row.nameZh || row.shortName || row.symbol;
      const heading = node('h3', title);
      heading.append(node('small', title === row.symbol ? label : row.symbol));
      const name = node('p', row.name || row.symbol, 'us-research-name'); name.title = row.name || row.symbol;
      identity.append(heading, name);
      const badge = node('span', status, 'us-research-status');
      if (row.status !== 'candidate') badge.dataset.tone = 'warning';
      const etf = row.kind === 'etf', dates = etf ? '持仓资料 ' + time(row.asOf) + (finite(row.metrics?.portfolioPe) ? ' · 组合PE截至 ' + time(row.metrics.portfolioPeAsOf) : '') : '财报期／TTM截至 ' + time(row.asOf) + ' · 财报公开 ' + time(row.filedAt) + (row.valuationBasis?.priceAsOf ? ' · 估值日期 ' + time(row.valuationBasis.priceAsOf) : '');
      const details = etf ? etfDetails(row) : companyDetails(row);
      card.append(identity, levels(items), badge, node('p', dates, 'us-research-dates'));
      if (evidence?.children.length) card.append(evidence);
      card.append(details);
      return card;
    }

    function etfDetails(row) {
      const details = node('details', null, 'us-selection-inline');
      details.append(node('summary', '策略、风险与来源'), node('p', row.name));
      if (row.benchmark) details.append(node('p', '跟踪指数：' + row.benchmark));
      const list = node('ul');
      for (const reason of row.reasons || []) list.append(node('li', reasonText(reason)));
      details.append(list, sources(row.sources, row));
      return details;
    }

    function reviewStatusBar(mode) {
      const counts = reviewCounts(state.snapshot, mode), bar = node('div', null, 'us-review-statuses');
      bar.setAttribute('aria-label', '本批研究状态');
      const selected = mode === 'value' ? state.valueStatus : state.dcaStatus;
      const candidateCounts = state.snapshot.fundamentals.sectors?.candidateCounts;
      const choices = mode === 'value' && candidateCounts ? [
        ['trough_value', '低谷折价', candidateCounts.troughOpportunities],
        ['relative_discount', '相对低估', candidateCounts.confirmedRelative]
      ] : [];
      choices.push([mode === 'value' ? 'low_multiple' : 'candidate', mode === 'value' ? '低倍数' : '条件通过', counts.candidate], ['pending', '待核', counts.pending], ['excluded', '未通过', counts.excluded], ['', '全部', counts.all]);
      for (const [value, label, count] of choices) {
        const button = node('button', label); button.type = 'button';
        button.dataset.usReviewStatus = value; button.dataset.usReviewMode = mode;
        button.setAttribute('aria-pressed', String(selected === value));
        button.append(node('strong', number(count, 0))); bar.append(button);
      }
      return bar;
    }

    function renderReview(target, page) {
      const mode = state.mode, status = mode === 'value' ? state.valueStatus : state.dcaStatus;
      target.append(reviewStatusBar(mode), node('p', ['low_multiple', 'candidate', 'relative_discount', 'trough_value'].includes(status) ? '当前名单应用所选数值条件。上方数量为本批总数。' : '浏览本批核验结果，可按产业或股票搜索。', 'us-review-scope'));
      if (mode === 'value' && status === 'pending') {
        const counts = new Map();
        for (const row of filterRows(state.snapshot, state)) for (const gap of valueGaps(row)) counts.set(gap, (counts.get(gap) || 0) + 1);
        const frequent = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => label + ' ' + count + ' 只');
        if (frequent.length) target.append(node('p', '主要待补项（可重叠） ' + frequent.join(' · '), 'us-review-scope'));
      }
      if (!page.rows.length) {
        const block = node('div', null, 'us-selection-empty');
        block.append(node('strong', '当前筛选下没有记录'), node('span', '可直接选择上方待核、未通过或全部，查看本批资料与原因。'));
        target.append(block); return;
      }
      if (mode === 'value') { target.append(...page.rows.map(valueCard)); return; }
      for (const [kind, title] of [['etf', '基金定投'], ['stock', '个股长期观察']]) {
        const rows = page.rows.filter(row => row.kind === kind);
        if (!rows.length) continue;
        const group = node('section', null, 'us-review-group'), heading = node('header', null, 'us-review-group-heading');
        heading.append(node('h2', title), node('span', '显示' + rows.length + '只'));
        group.append(heading, ...rows.map(dcaCard)); target.append(group);
      }
    }

    function sectorRow(group, benchmark) {
      const card = node('article', null, 'us-research-row');
      const heading = node('h3');
      const open = node('button', sectorName(group.name), 'us-sector-open');
      open.type = 'button'; open.dataset.usSector = group.name;
      open.setAttribute('aria-label', '查看' + sectorName(group.name) + '个股');
      heading.append(open);
      const identity = node('header', null, 'us-research-identity');
      identity.append(heading);
      const label = node('span', sectorLabels[group.state] || '证据不足', 'us-research-status');
      if (group.state === 'pending') label.dataset.tone = 'warning';
      const metric = (value, suffix = '%') => finite(value) ? number(value) + suffix : '待核';
      const period = group.financialPeriodRange;
      const coverage = [
        '日线 ' + group.priceSamples + '/' + group.members + ' 家',
        '同期财报 ' + group.financialSamples + '/' + group.members + ' 家',
        period ? '财报期 ' + (period.first === period.last ? period.last : period.first + ' 至 ' + period.last) : '',
        group.classificationCode ? 'SEC SIC ' + group.classificationCode : group.classification === 'SEC SIC 3674' ? group.classification : '',
        group.state === 'trough' ? '低谷折价 ' + group.candidates + ' 只' : ''
      ].filter(Boolean);
      card.append(identity, levels([
        ['近60交易日等权涨跌', metric(group.return60Pct)],
        ['相对 ' + benchmark, metric(group.excess60Pp, ' 个百分点')],
        ['低于50日均线', metric(group.belowMa50Pct)],
        ['营收／净利同比下降', metric(group.decliningRevenuePct) + ' ／ ' + metric(group.decliningProfitPct)]
      ]), label, node('p', coverage.join(' · '), 'us-sector-note'));
      if (group.reasons?.length) card.append(node('p', group.reasons.join('。'), 'us-sector-note'));
      return card;
    }

    function renderSectors() {
      const sectors = state.snapshot?.fundamentals.sectors;
      const context = get('us-value-sectors-context');
      const leading = get('us-value-sectors-leading');
      const remaining = get('us-value-sectors-remaining');
      const more = get('us-value-sectors-more');
      if (sectors?.status !== 'ready') {
        context.textContent = sectors?.reason || (state.phase === 'loading' ? '正在读取本批产业证据…' : '当前批次没有可用的产业核验证据。');
        leading.replaceChildren(); remaining.replaceChildren(); more.hidden = true;
        return;
      }
      const groups = sectors.groups;
      const benchmark = sectors.benchmark || 'SPY';
      const troughs = groups.filter(group => group.state === 'trough');
      const selected = groups.find(group => group.name === state.strategy);
      const featured = selected ? [selected] : troughs.length ? troughs : groups.filter(group => ['weak_price', 'weak_business'].includes(group.state)).sort((a, b) => (a.excess60Pp ?? 0) - (b.excess60Pp ?? 0)).slice(0, 3);
      const rest = groups.filter(group => !featured.includes(group));
      context.textContent = [
        '行情日 ' + time(sectors.asOf),
        troughs.length ? '低谷 ' + troughs.length + ' / ' + groups.length : '本批暂无行情与财报同时支持的低谷',
        '证据不足 ' + groups.filter(group => group.state === 'pending').length + ' 个产业',
        sectors.unclassifiedCompanyCount ? '未分类 ' + sectors.unclassifiedCompanyCount + ' 家' : ''
      ].filter(Boolean).join(' · ');
      const rule = sectors.thresholds;
      const evidence = node('p', null, 'us-sector-note');
      if (rule) evidence.textContent = '行情与财报各至少 ' + rule.minMembers + ' 家、覆盖 ' + rule.minCoveragePct + '%。低谷要求近60交易日等权涨幅不高于 ' + rule.maxReturn60Pct + '%、相对 ' + benchmark + ' 不高于 ' + rule.maxExcess60Pp + ' 个百分点，低于50日均线的公司至少 ' + rule.minBelowMa50Pct + '%，营收与净利同比下降的公司各至少 ' + rule.minDecliningPct + '%。相对低估要求至少 ' + rule.minPeers + ' 家可比公司，PE 与市值／FCF 各折价至少 ' + rule.minDiscountPct + '%。';
      const price = sectors.source?.price, financial = sectors.source?.financial, universe = sectors.source?.universe;
      const scope = state.snapshot.fundamentals.scope;
      const index = scope?.industrySource ? { name: 'SEC 细分产业索引', url: scope.industrySource, asOf: scope.industryIndexAsOf } : null;
      const provenance = sources([price, financial, universe, index].filter(Boolean), { sourceTime: sectors.sourceTime, readAt: price?.readAt });
      if (scope?.readAt) provenance.append(node('span', '名册读取 ' + time(scope.readAt)));
      if (scope?.industryIndexReadAt) provenance.append(node('span', '产业索引读取 ' + time(scope.industryIndexReadAt)));
      if (financial?.readAt) provenance.append(node('span', '财报核验 ' + time(financial.readAt)));
      leading.replaceChildren(evidence, provenance, ...featured.map(group => sectorRow(group, benchmark)));
      get('us-value-sectors-summary').textContent = '查看其余 ' + rest.length + ' 个产业的依据';
      remaining.replaceChildren(...rest.map(group => sectorRow(group, benchmark)));
      more.hidden = rest.length === 0;
    }

    function renderStrategies() {
      const select = get('us-selection-strategy'), current = state.strategy, choices = new Map();
      for (const row of modeRows(state.snapshot, state.mode)) {
        const key = strategyKey(row, state.mode);
        if (key) choices.set(key, state.mode === 'short' ? row.label || key : state.mode === 'dca' ? key === 'etf' ? 'ETF' : '个股' : sectorName(key));
        if (state.mode === 'short') for (const hit of row.hits || []) if (hit.rule) choices.set(hit.rule, hit.label || hit.rule);
      }
      const label = state.mode === 'short' ? '策略' : state.mode === 'value' ? '产业' : '类型';
      get('us-selection-strategy-label').textContent = label;
      select.replaceChildren();
      const all = node('option', '全部' + label); all.value = ''; select.append(all);
      for (const [value, text] of choices) {
        const option = node('option', text); option.value = value; select.append(option);
      }
      state.strategy = choices.has(current) ? current : ''; select.value = state.strategy;
    }

    function renderContext() {
      const snapshot = state.snapshot;
      if (!snapshot) return;
      const scope = snapshot.scope || {}, market = snapshot.market || {};
      const labels = { weak: '市场偏弱', strong: '市场走强', mixed: '市场分化' };
      const coverage = finite(scope.covered) && finite(scope.expected) ? number(scope.covered, 0) + '/' + number(scope.expected, 0) + '只覆盖' : '';
      const breadth = finite(market.breadth?.percent) ? '站上MA20占比 ' + percent(market.breadth.percent) : '';
      const tracking = snapshot.tracking || {};
      const samples = finite(tracking.observations) ? '累计观察' + number(tracking.observations, 0) + '条 · 观察后3日成熟' + number(tracking.matured3 || 0, 0) + '条 · B触发后3日成熟' + (finite(tracking.maturedTriggered3) ? number(tracking.maturedTriggered3, 0) + '条' : '待形成') : '';
      const triggeredReturn = finite(tracking.meanTriggeredReturn3Percent) ? 'B后3日平均 ' + percent(tracking.meanTriggeredReturn3Percent, true) : '';
      get('us-short-context').textContent = [scope.name, coverage, '数据日 ' + time(snapshot.asOf), labels[market.regime], breadth, samples, triggeredReturn].filter(Boolean).join(' · ');
      const valueScope = snapshot.fundamentals.scope, coverageCount = valueScope?.coverage;
      get('us-value-context').textContent = [
        valueScope?.name || 'SEC公开财报研究',
        coverageCount ? 'SEC 匹配 ' + number(coverageCount.matched, 0) + ' 只／行情名册 ' + number(valueScope.listingCount, 0) + ' 只' : '',
        coverageCount ? '本批核验 ' + number(coverageCount.companyCount, 0) + ' 家独立公司' : '',
        valueScope?.expansionFailure ? '扩池待更新：' + valueScope.expansionFailure : '',
        '财报期以个股披露为准'
      ].filter(Boolean).join(' · ');
      get('us-dca-context').textContent = '宽基ETF、红利ETF与个股分别评价；费用与持仓按各自官方日期展示。';
    }

    function renderSource() {
      const parts = [], snapshot = state.snapshot;
      if (snapshot) {
        const source = snapshot.source || {};
        if (source.name || source.id) parts.push(source.name || source.id);
        parts.push(sourceTimeLabel(source) + ' ' + time(source.sourceTime));
        parts.push('本站读取 ' + time(source.fetchedAt));
        parts.push('计算／发布 ' + time(snapshot.generatedAt));
        if (source.stale === true || snapshot.status === 'stale') parts.push('保留上次成功批次');
      }
      parts.push(...taskParts(state.progress));
      if (state.progress?.lastSuccess) parts.push('最近成功 ' + time(state.progress.lastSuccess.asOf) + ' · ' + time(state.progress.lastSuccess.generatedAt));
      if (state.error) parts.push(state.error + (snapshot ? '；保留当前已完成结果' : ''));
      if (state.readAt) parts.push('页面读取 ' + time(state.readAt));
      get('us-selection-source').textContent = parts.join(' · ') || '正在读取已完成批次；本页不会逐股扫描。';
    }

    function renderResults() {
      const mode = state.mode, target = get('us-' + mode + '-results');
      target.className = 'us-selection-results' + (mode === 'short' ? '' : ' us-selection-ledger');
      get('us-value-status').value = state.valueStatus;
      get('us-dca-status').value = state.dcaStatus;
      get('us-short-access').hidden = state.snapshot?.short.requiresAuth !== true;
      if (mode === 'value') renderSectors();
      if (!state.snapshot) {
        empty(target, state.phase === 'loading' ? '正在读取已完成结果' : '结果暂未取得', state.error || '页面直接读取服务器批次，不在浏览器逐股扫描。');
        get('us-selection-count').textContent = state.phase === 'loading' ? '读取批次中' : '尚未取得可显示的批次';
        get('us-selection-pages').hidden = true;
        return;
      }
      if (mode === 'short' && state.snapshot.short.requiresAuth === true) {
        empty(target, '短线数据限定本人研究', '登录后可查看当前候选与日K；公开财报和长期ETF研究可直接切换查看。');
        get('us-selection-count').textContent = '本人研究需要登录';
        get('us-selection-pages').hidden = true;
        return;
      }
      const rows = filterRows(state.snapshot, state), page = paginate(rows, state.pageSize, state.page);
      state.page = page.page;
      const group = mode === 'short' ? state.snapshot.short : mode === 'value' ? state.snapshot.fundamentals : state.snapshot.dca;
      if (mode !== 'short') {
        target.replaceChildren(); renderReview(target, page);
      } else if (!rows.length) {
        const message = group.reason || group.message || (mode === 'short' ? '当前条件下没有可观察的入场机会；可调整条件查看本批其他记录。' : '当前条件下没有研究记录；可调整条件，缺失指标仍明确留空。');
        empty(target, group.status === 'source_pending' || group.status === 'unavailable' ? '等待可用数据批次' : '当前条件下没有结果', message);
      } else target.replaceChildren(...page.rows.map(mode === 'short' ? shortCard : mode === 'value' ? valueCard : dcaCard));
      get('us-selection-count').textContent = number(rows.length, 0) + '只符合本页条件 · 本批' + number(modeRows(state.snapshot, mode).length, 0) + '条记录';
      get('us-selection-pages').hidden = state.pageSize === 'all' || page.pages <= 1;
      get('us-selection-page').textContent = page.page + ' / ' + page.pages;
      get('us-selection-prev').disabled = page.page <= 1;
      get('us-selection-next').disabled = page.page >= page.pages;
    }

    function render() {
      for (const mode of MODES) {
        const tab = get('us-tab-' + mode), selected = state.mode === mode;
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
        get('us-panel-' + mode).hidden = !selected;
      }
      get('us-selection-refresh').disabled = state.phase === 'loading';
      get('us-selection-refresh').textContent = state.phase === 'loading' ? '读取中…' : '更新结果';
      get('us-selection-search').value = state.search;
      renderStrategies(); renderContext(); renderResults(); renderSource();
    }

    async function load() {
      const requestId = ++state.requestId;
      state.phase = 'loading'; state.error = ''; render();
      const controller = new AbortController(), deadline = env.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await env.fetch('/api/us-selection/snapshot', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
        if (response.status === 401) {
          state.snapshot = { schema: SCHEMA, short: { requiresAuth: true, rows: [] }, fundamentals: { rows: [] }, dca: { rows: [] } };
        } else {
          if (!response.ok) throw Error('选股结果读取失败（HTTP ' + response.status + '）');
          const snapshot = validateSnapshot(await response.json());
          if (requestId !== state.requestId) return;
          if (!state.snapshot && snapshot.fundamentals.sectors?.candidateCounts?.confirmedRelative > 0) state.valueStatus = 'relative_discount';
          state.snapshot = snapshot;
          if (snapshot.task) state.progress = snapshot.task;
        }
        state.chartErrors = {}; state.phase = 'ready'; state.readAt = new Date().toISOString();
      } catch (error) {
        if (requestId !== state.requestId) return;
        state.error = error.name === 'AbortError' ? '选股结果读取超时，请更新结果重试' : error.message;
        state.phase = 'error';
      } finally {
        env.clearTimeout(deadline);
        if (requestId === state.requestId) render();
      }
      try {
        const response = await env.fetch('/api/us-selection/state', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (response.ok && requestId === state.requestId) { state.progress = await response.json(); renderSource(); }
      } catch { /* The completed snapshot stays usable when the progress endpoint is unavailable. */ }
    }

    host.addEventListener('click', event => {
      const status = event.target.closest('[data-us-review-status]');
      if (status && Object.hasOwn(status.dataset, 'usReviewStatus')) {
        if (status.dataset.usReviewMode === 'value') state.valueStatus = status.dataset.usReviewStatus;
        else state.dcaStatus = status.dataset.usReviewStatus;
        state.page = 1; renderResults(); return;
      }
      const sector = event.target.closest('[data-us-sector]');
      if (state.mode === 'value' && sector?.dataset.usSector) {
        state.strategy = sector.dataset.usSector; state.valueStatus = ''; state.search = ''; state.page = 1;
        render(); get('us-selection-strategy').focus(); return;
      }
      const tab = event.target.closest('[data-us-tab]');
      if (!tab) return;
      state.mode = tab.dataset.usTab; state.search = ''; state.strategy = ''; state.page = 1; render();
    });
    host.addEventListener('keydown', event => {
      const tab = event.target.closest('[data-us-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = MODES.indexOf(state.mode);
      state.mode = event.key === 'Home' ? MODES[0] : event.key === 'End' ? MODES.at(-1) : MODES[(index + (event.key === 'ArrowRight' ? 1 : 2)) % MODES.length];
      state.search = ''; state.strategy = ''; state.page = 1; render(); get('us-tab-' + state.mode).focus();
    });
    get('us-selection-search').addEventListener('input', event => { state.search = event.target.value; state.page = 1; renderResults(); });
    get('us-selection-strategy').addEventListener('change', event => { state.strategy = event.target.value; state.page = 1; renderResults(); });
    get('us-selection-page-size').addEventListener('change', event => { state.pageSize = event.target.value; state.page = 1; renderResults(); });
    const filters = {
      'us-min-price': 'minPrice', 'us-min-turnover': 'minTurnover', 'us-min-strength': 'minStrength', 'us-short-status': 'shortStatus',
      'us-value-pe': 'valuePe', 'us-value-fcf': 'valueFcf', 'us-value-debt': 'valueDebt', 'us-value-status': 'valueStatus',
      'us-dca-fee': 'dcaFee', 'us-dca-years': 'dcaYears', 'us-dca-status': 'dcaStatus'
    };
    for (const [id, property] of Object.entries(filters)) {
      const update = event => {
        const input = event.target;
        if (input.type === 'number' && (!input.validity.valid || input.value === '')) return;
        const value = input.type === 'number' ? Number(input.value) : input.value;
        if (state[property] === value) return;
        state[property] = value;
        state.page = 1; renderResults();
      };
      get(id).addEventListener('input', update);
      get(id).addEventListener('change', update);
    }
    for (const id of ['us-value-status', 'us-dca-status']) {
      const option = node('option', '未通过记录'); option.value = 'excluded'; get(id).append(option);
    }
    host.addEventListener('change', event => {
      if (!event.target.dataset.usChartWindow) return;
      state.chartWindows[event.target.dataset.usChartWindow] = Number(event.target.value); renderResults();
    });
    get('us-selection-prev').addEventListener('click', () => { state.page--; renderResults(); });
    get('us-selection-next').addEventListener('click', () => { state.page++; renderResults(); });
    get('us-selection-refresh').addEventListener('click', load);
    const ready = load();
    return { state, ready, refresh: load };
  }

  return { initialState, validateSnapshot, filterRows, reviewCounts, paginate, shortStatus, chartUrl, sourceUrl, taskParts, etfLabel, valueLabel, sourceTimeLabel, number, percent, money, time, mount };
});
