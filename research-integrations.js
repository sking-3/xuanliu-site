'use strict';

(() => {
  const root = document.querySelector('[data-research-integrations]');
  if (!root) return;

  const sources = [
    {
      id: 'tigeropen', name: 'TigerOpen', category: '交易适配', license: '文档/SDK', status: 'private',
      summary: '券商账户、行情与交易 API 的账户配置和调用契约。',
      capabilities: ['行情接口', '账户接口', '订单接口'],
      decision: '只做本机私有适配器，密钥不能进公开站，实盘路由保持关闭。',
      surface: '本机适配器',
      href: 'https://github.com/tigerfintech/tigeropen-skill/blob/main/skills/tigeropen-java/references/quickstart.md'
    },
    {
      id: 'issaclv2', name: 'IssacLv2', category: 'A股数据', license: '未声明', status: 'reference',
      summary: 'A 股 Level-2 研究项目，作为接口形态和数据字段的参考。',
      capabilities: ['盘口字段', '逐笔研究', '数据结构参考'],
      decision: '未确认许可证和数据再分发边界，只保留研究参考，不复制代码。',
      surface: '字段映射设计',
      href: 'https://github.com/zhaoyu162/IssacLv2'
    },
    {
      id: 'abu', name: 'ABU', category: '回测引擎', license: 'GPL-3.0', status: 'reference',
      summary: '量化回测、择时和策略研究框架。',
      capabilities: ['回测流程', '择时研究', '策略实验'],
      decision: '借鉴回测流程和研究方法，不把 GPL 代码直接嵌入公开站。',
      surface: '规则与回放',
      href: 'https://github.com/bbfamily/abu'
    },
    {
      id: 'vnpy', name: 'VeighNa / vn.py', category: '策略与交易框架', license: 'MIT', status: 'adapt',
      summary: '事件驱动策略、因子、回测和模拟交易的开源框架。',
      capabilities: ['事件驱动', '因子工程', '回测与模拟'],
      decision: '提取事件、策略和回测抽象，保留 MIT 署名；生产订单网关不启用。',
      surface: '模拟研究内核',
      href: 'https://github.com/vnpy/vnpy'
    },
    {
      id: 'qbot', name: 'Qbot', category: '策略与通知', license: 'MIT', status: 'adapt',
      summary: '数据、策略、回测、模拟和通知的模块化组合。',
      capabilities: ['指标策略', '回测', '模拟通知'],
      decision: '只迁移数据—策略—回测—通知的接口思路，默认 paper-only。',
      surface: '策略实验室',
      href: 'https://github.com/UFund-Me/Qbot'
    },
    {
      id: 'tick-stock-panel', name: 'tick-stock-panel', category: 'A股研究工作台', license: 'MIT', status: 'adapt',
      summary: '本地数据源、统一 enriched 数据、策略、回测、监控和事件流。',
      capabilities: ['能力路由', '统一数据口径', '异动雷达', '本地缓存'],
      decision: '把能力矩阵、时间戳、来源健康和事件状态接入本站快照契约。',
      surface: 'A股选股与雷达',
      href: 'https://github.com/shy3130/tick-stock-panel'
    },
    {
      id: 'uzi-skill', name: 'UZI-Skill', category: '研究分析', license: 'MIT', status: 'adapt',
      summary: '多维评审、DCF、风险陷阱、资金和宏观事件的规则化研究层。',
      capabilities: ['多空审查', '估值与质量', '风险陷阱', '证据缺口'],
      decision: '把证据链和弃权规则内置为五层报告，不把抓取正文或提示词原样转载。',
      surface: '五代理研究台',
      href: 'https://github.com/wbh604/UZI-Skill'
    },
    {
      id: 'adata', name: 'adata', category: 'A股数据', license: 'Apache-2.0', status: 'adapt',
      summary: '多源 A 股行情、基本面、资金和榜单的本机采集库。',
      capabilities: ['全市场目录', '日线与分时', '资金与龙虎榜', '多源回退'],
      decision: '作为 Mac 本地采集器候选，生成带来源和时点的脱敏快照，不把原始接口放到浏览器。',
      surface: '本机数据层',
      href: 'https://github.com/1nchaos/adata'
    }
  ];

  const statusLabels = { adapt: '可提取能力', private: '私有适配', reference: '仅作参考' };
  const statusClasses = { adapt: 'is-adapt', private: 'is-private', reference: 'is-reference' };
  const filter = root.querySelector('[data-integrations-filter]');
  const count = root.querySelector('[data-integrations-count]');
  const grid = root.querySelector('[data-integrations-grid]');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function render() {
    const selected = filter?.value || 'all';
    const visible = sources.filter(source => selected === 'all' || source.status === selected || source.category === selected);
    if (count) count.textContent = `${visible.length}/${sources.length} 个来源`;
    if (!grid) return;
    grid.innerHTML = visible.map(source => `
      <article class="integration-card ${statusClasses[source.status]}">
        <header class="integration-card-head">
          <div><span class="integration-category">${esc(source.category)}</span><h3>${esc(source.name)}</h3></div>
          <span class="integration-status">${esc(statusLabels[source.status])}</span>
        </header>
        <p class="integration-summary">${esc(source.summary)}</p>
        <div class="integration-tags">${source.capabilities.map(tag => `<span>${esc(tag)}</span>`).join('')}</div>
        <dl class="integration-meta"><div><dt>许可证</dt><dd>${esc(source.license)}</dd></div><div><dt>落点</dt><dd>${esc(source.surface)}</dd></div></dl>
        <p class="integration-decision">${esc(source.decision)}</p>
        <a href="${esc(source.href)}" target="_blank" rel="noopener noreferrer">查看原项目 ↗</a>
      </article>`).join('');
  }

  filter?.addEventListener('change', render);
  render();
  root.dataset.ready = 'true';
  window.BooksResearchIntegrations = { sources: sources.map(source => ({ ...source })) };
})();
