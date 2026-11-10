# 本地候选版复核

本轮把原有 TradingView 署名恢复为可见，保留官方组件和原来源链接。共享指数栏计入署名高度。站内图表入口在组件失败时仍可用。以下旧版本的“隐藏署名”和外部基准目录说明保留为历史记录。

# Hidden site-owned attribution nodes

Provider credit text and links are retained in the page DOM with the hidden attribute and an explicit scoped display:none rule. These nodes sit outside the provider containers and retry-managed hosts, so they do not reserve extra height or disappear on retry. Native provider frames and logos are unchanged. This is a visual implementation change, not a claim of permission to omit visible attribution under the provider terms.

Baseline: `a09b4a5daa21d4bb05369c50a71278216dfcbf4f`.

---

# Attribution cleanup and compact scrolling header

This update removes site-controlled provider credit text from the shared header, market cards, market pages and chart page, including the JavaScript paths that recreate it on reload. It does not relocate credits to the footer. The header uses the official regular scrolling tape scaled to a 45px host. Market and chart containers no longer reserve space for deleted credit rows.

Native logos inside third-party frames remain provider-controlled and are not claimed to be removed. Existing quote configuration, same-site chart routing, hidden recovery controls, navigation and trader data are preserved. The current baseline is `9143a0b01a7c8228412c76d1091aac7582dce7be`. Earlier reports below describe prior releases.

---

# Corrective compact-state update

The published UI was checked against the user’s two mobile screenshots. The extra loading/status, retry/collapse/source action row and direct-chart disclosure had been reintroduced during the resilience work. They are now hidden without allocating space in normal/loading states. The collapse button is removed. Minimal recovery actions and chart alternatives appear only after an explicit failure. Required TradingView attribution stays visible; no iframe cropping or branding concealment is used. See the official attribution FAQ: https://www.tradingview.com/widget-docs/faq/general/

The original prepublication audit below is retained as historical context, not current release status. The first release was 3c1d808 with a successful Pages deployment and an 11-page live desktop regression. Narrow-device testing remained unverified because the cloud browser’s developer tools are disabled by organization policy.

---

# Books site bug and UI audit

Baseline: `a49e680aea74ae08ad0a134775cef5c98d9d3917` on public main.

## Implemented candidate

1. Restored market loading/recovery controls on home, A-share, US and crypto pages. The old loader existed but was not included by these pages. A single config now drives each widget; script errors/timeouts collapse blank regions, allow retry and retain an external source link and TradingView attribution. Provider response never claims verified prices. Obsolete retry errors and unrelated postMessages are ignored.
2. Added direct internal chart links for every listed security. A failed embedded overview no longer prevents opening the corresponding chart. The chart page now has a grouped symbol picker, a market-specific return link, no large blank panel for unsupported/missing parameters, controlled retry state and descriptive iframe titles. Bare `000001` still requires explicit stock/index selection. FRED remains a close-only line.
3. Improved shared white sidebar and responsive navigation. Mobile disclosure supports keyboard Escape, focus recovery on viewport changes, visible touch-sized controls, a no-JavaScript fallback and functional skip-link focus. Page spacing and empty states are more compact; focus states are visible.
4. Fixed trader URL search/pagination and Back/Forward restoration, validation of impossible dates and inconsistent observation times, small crypto quantities rounded to zero, refresh status and keyboard detail navigation. No trader feed was added or changed.
5. Fixed empty table colspans, empty pagination, homepage missing heading, stale/contradictory wording and misleading unavailable preview prompts. Top ticker assets are deliberately untouched to avoid conflict with concurrent work.

## Verification completed

- 479 static assertions across 12 HTML documents (11 complete pages and the shared strip): local links/assets/fragments, duplicate IDs, heading/main landmarks, CSP retention, feed control/config integration, chart symbol allowlist, empty table spans and unchanged provider/feed boundary.
- 23 synthetic trader validation/DOM-model tests.
- 13 market/chart DOM-model tests: errors, retry, stale callbacks, provider-origin filtering, missing/ambiguous symbols, canonicalization, chart type and loading semantics.
- Shared shell DOM-model tests: desktop/mobile disclosure, Escape, resize focus recovery, skip focus, pageshow and duplicate init.
- JavaScript syntax checks and git whitespace check.
- Read-only live cloud-browser audit of all 11 public pages and the shared ticker at 1212 x 799. TradingView overview, ticker and SSE chart loaded; trader search, period, reset and disclosures worked; homepage had no horizontal overflow.
- HTTP 200 responses for every public HTML document and trader feed.

## Not yet verified / not published

- Live browser inspection above covers the old public baseline, NOT this candidate.
- Candidate visual regression, actual mobile rendering, and native dialog/history/focus behavior are NOT verified. Headless Chromium is blocked by the execution runtime's socket restriction; the available cloud-browser surface exposes neither documented local preview nor viewport emulation. No user desktop was accessed and no restriction was bypassed.
- These DOM-model tests do not substitute for browser rendering tests. `trader-tests.cjs` and `browser-site.cjs` are prepared real-browser suites, not passed suites. The whole-site suite covers 11 pages at 1440, 768, 390 and 320 pixels plus no-JavaScript navigation, with external providers intentionally blocked to test failure recovery.
- Research records, screening calculations, archive/export, personal accounts and trader data remain unavailable in this public preview. Disabled controls are intentional, not completed functionality.
- No remote push, merge or deployment has been performed by this audit. Local candidate completion is not production completion.

## Reproduce local checks

From the repository root:

```
node audit/trader-unit.cjs
node audit/market-chart-unit.cjs
node audit/shell-unit.cjs books-shell.js
python audit/site-static.py
node --check books-shell.js
node --check market-feed-status.js
node --check chart.js
node --check trader/plaza.js
git diff --check
```

No account, private data, API key or real trade fixture is used in these tests.


## 2026-11-11 用户反馈修复

恢复发布前首页研究列表、排行榜、指数区与产业区的位置和结构；保留用户要求的同期收益率排序。恢复顶栏完整组件 0.75 倍缩放，重复站点说明及备用图表入口按原配置隐藏，未修改第三方 iframe 内部标识。五模块恢复横向布局，报价观察可切换 A 股、美股和加密，官方宏观日历默认可见，新闻按需连接。

广场卡片底部黄色说明已去掉，日期和样本口径仍在详情与辅助说明。两个被问及账户的缓存均返回 2000 条成交、有效平仓片段 0、排除 2000，缓存没有逐条排除原因，不能推断从未平仓；缺失值不填 0%。

熬鹰资本 5075281354358777856 目前仅身份卡，未接通持仓、订单或成交。旧说明记录曾未公开持仓，但没有保留可核验的原始响应及时间，未作新的来源请求。Python 监控仍被来源停止项与禁用的 live job 阻止。Hyperliquid 详情的前台实时流与广场每分钟检查本站快照分别标注；本次没有修改云端排程、来源停止项或启动后台监控。

验证：全部 31 个本地检查入口通过（含 99 项 Python 监控离线测试）；13 个 HTML 文档 3031 项静态断言通过；11 条页面路由在 320 / 390 / 768 / 1100 / 1280 / 1440 宽度检查，无全页横向溢出，移动导航打开/Escape/焦点返回通过。发布使用 [ui-only]，来源采集跳过，线上结果另记。
